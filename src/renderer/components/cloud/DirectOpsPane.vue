<template>
  <div class="tp-pane dp">
    <!-- 作用说明：这页与「操作日志」是两件事，页面里必须写清楚，否则只剩一个名字 -->
    <div class="dp-head">
      <div class="dp-title">
        <h2>
          实例运维
          <span v-if="cap" class="tp-chip">{{ cap.clusterName }} · OB v{{ shortVersion(cap.version) }}</span>
          <span v-else-if="pid" class="tp-chip idle">未读取到集群信息</span>
        </h2>
        <p class="dp-sub">
          直连模式没有 OCP 代理层，这一页<b>直接连 OBServer 的 SQL 端口</b>做两件事：
        </p>
        <ul class="dp-list">
          <li><b>只读诊断</b>：系统参数（GV$OB_PARAMETERS）、TopSQL（GV$OB_SQL_AUDIT）、运维事件（DBA_OB_ROOTSERVICE_EVENT_HISTORY）。</li>
          <li><b>写操作</b>：触发 / 挂起 / 恢复合并、终止会话、改参数——直接执行 ALTER SYSTEM / KILL，<b>没有任务编排、不可回滚</b>，每次都会记进「操作日志」。</li>
        </ul>
        <p class="dp-sub dim">要按时间回溯做过什么、执行到哪一步，请到左侧「操作日志」；这里只负责“现在做什么”。</p>
      </div>
      <div class="dp-tools">
        <label class="dp-lbl">目标集群</label>
        <select v-model="selPid" class="tp-select" :disabled="directPlatforms.length <= 1" title="每个直连平台对应一套集群连接">
          <option v-for="p in directPlatforms" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <button class="tp-btn" :disabled="!pid || busy" @click="reloadAll">刷新</button>
      </div>
    </div>

    <div v-if="!pid" class="dp-note">还没有接入任何 OceanBase 直连集群。请先到右上角「平台设置」里新增一条直连接入。</div>

    <template v-else>
      <div v-if="err" class="tp-msg err">{{ err }}</div>
      <div v-if="notice" class="tp-msg ok">{{ notice }}</div>

      <nav class="subtabs">
        <button v-for="t in TABS" :key="t.key" class="subtab" :class="{ on: tab === t.key }" @click="switchTab(t.key)">
          {{ t.label }}
        </button>
      </nav>

      <!-- 系统参数 -->
      <template v-if="tab === 'params'">
        <div class="tp-bar">
          <input v-model="paramKw" class="tp-input tp-search" placeholder="按参数名或说明过滤（回车查询）" spellcheck="false" @keyup.enter="loadParams" />
          <button class="tp-btn" :disabled="busy" @click="loadParams">查询</button>
          <span class="sp"></span>
          <span class="tp-note">已加载 {{ params.length }} 项 · 每台 OBServer 各一份，改集群级参数会下发到全部节点</span>
        </div>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead>
              <tr><th>参数</th><th>当前值</th><th>默认值</th><th>生效级别</th><th>说明</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in params" :key="p.name">
                <td class="tp-mono">{{ p.name }}</td>
                <td class="tp-mono">{{ p.value }}</td>
                <td class="tp-mono tp-dim">{{ p.defaultValue }}</td>
                <td class="tp-dim">{{ p.editLevel }}</td>
                <td class="tp-dim wrap">{{ p.info }}</td>
                <td><button class="tp-btn sm" @click="openParamEdit(p)">修改</button></td>
              </tr>
              <tr v-if="!params.length && !busy"><td colspan="6" class="tp-empty">没有匹配的参数</td></tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- TopSQL -->
      <template v-else-if="tab === 'topsql'">
        <div class="tp-bar">
          <select v-model.number="sqlHours" class="tp-select" @change="loadTopSql">
            <option :value="1">近 1 小时</option>
            <option :value="6">近 6 小时</option>
            <option :value="24">近 24 小时</option>
            <option :value="72">近 3 天</option>
            <option :value="168">近 7 天</option>
          </select>
          <button class="tp-btn" :disabled="busy" @click="loadTopSql">刷新</button>
          <span class="sp"></span>
          <span class="tp-note">来自 GV$OB_SQL_AUDIT，按平均耗时倒序取前 {{ topSqlLimit }} 条；点一行看完整 SQL</span>
        </div>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead>
              <tr><th>SQL_ID</th><th class="r">次数</th><th class="r">平均耗时</th><th class="r">最大耗时</th><th class="r">平均 CPU</th><th class="r">返回行</th><th>SQL</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in topSql" :key="r.sqlId" class="clickable" :class="{ on: sqlPick && sqlPick.sqlId === r.sqlId }" @click="pickSql(r)">
                <td class="tp-mono">{{ r.sqlId.slice(0, 12) }}…</td>
                <td class="r tp-mono">{{ r.executions }}</td>
                <td class="r tp-mono">{{ fmtMs(r.avgElapsedMs) }}</td>
                <td class="r tp-mono">{{ fmtMs(r.maxElapsedMs) }}</td>
                <td class="r tp-mono tp-dim">{{ fmtMs(r.avgCpuMs) }}</td>
                <td class="r tp-dim">{{ r.rowsExamined }}</td>
                <td class="tp-dim ell">{{ r.sqlText }}</td>
              </tr>
              <tr v-if="!topSql.length && !busy"><td colspan="7" class="tp-empty">该时间窗内没有审计记录（可能未开启 SQL 审计）</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="sqlPick" class="tp-card">
          <div class="tp-bar">
            <span class="tp-mono">{{ sqlPick.sqlId }}</span>
            <span class="sp"></span>
            <button class="tp-btn sm" @click="sqlPick = null">收起</button>
          </div>
          <pre class="sqltext">{{ sqlFull || sqlPick.sqlText }}</pre>
        </div>
      </template>

      <!-- 运维事件 -->
      <template v-else-if="tab === 'events'">
        <div class="tp-bar">
          <input v-model="eventKw" class="tp-input tp-search" placeholder="按事件名过滤（回车查询）" spellcheck="false" @keyup.enter="loadEvents" />
          <select v-model.number="eventHours" class="tp-select" @change="loadEvents">
            <option :value="24">近 24 小时</option>
            <option :value="72">近 3 天</option>
            <option :value="168">近 7 天</option>
            <option :value="720">近 30 天</option>
          </select>
          <button class="tp-btn" :disabled="busy" @click="loadEvents">查询</button>
          <span class="sp"></span>
          <span class="tp-note">来自 DBA_OB_ROOTSERVICE_EVENT_HISTORY（只读），记录集群自身发生过的运维动作</span>
        </div>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead>
              <tr><th>时间</th><th>模块</th><th>事件</th><th>明细</th><th>RS</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in events" :key="i">
                <td class="tp-mono tp-dim">{{ e.timestamp }}</td>
                <td>{{ e.module }}</td>
                <td class="tp-mono">{{ e.event }}</td>
                <td class="tp-dim wrap">{{ detailOf(e) }}</td>
                <td class="tp-mono tp-dim">{{ e.rsSvrIp }}</td>
              </tr>
              <tr v-if="!events.length && !busy"><td colspan="5" class="tp-empty">该时间窗内没有事件</td></tr>
            </tbody>
          </table>
        </div>
      </template>

      <!-- 写操作 -->
      <template v-else>
        <div class="tp-warn">
          <b>这里执行的都是写操作</b>，直接对实例下发 ALTER SYSTEM / KILL，没有 OCP 的任务编排与回滚。
          每次执行都会写入本地「操作日志」，可用于事后追溯。
        </div>

        <h4 class="tp-h">合并控制 <span class="cnt">3 个动作</span></h4>
        <div class="opcards">
          <div class="tp-card opcard">
            <div class="op-t">触发合并</div>
            <div class="op-d">ALTER SYSTEM MAJOR FREEZE —— 立即发起一次大合并，用于回收多版本数据、释放磁盘。</div>
            <button class="tp-btn danger sm" :disabled="busy" @click="confirmOp('freeze')">执行</button>
          </div>
          <div class="tp-card opcard">
            <div class="op-t">挂起合并</div>
            <div class="op-d">ALTER SYSTEM SUSPEND MERGE —— 大促 / 大批量导入期间临时挂起，避免合并抢占 IO。</div>
            <button class="tp-btn danger sm" :disabled="busy" @click="confirmOp('suspend')">执行</button>
          </div>
          <div class="tp-card opcard">
            <div class="op-t">恢复合并</div>
            <div class="op-d">ALTER SYSTEM RESUME MERGE —— 解除挂起，恢复到正常合并节奏。</div>
            <button class="tp-btn sm" :disabled="busy" @click="confirmOp('resume')">执行</button>
          </div>
        </div>

        <h4 class="tp-h">
          未提交事务 <span class="cnt">{{ txns.length }}</span>
          <button class="tp-btn sm ghost" :disabled="busy" @click="loadTxns">刷新</button>
        </h4>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead>
              <tr><th>会话 ID</th><th>租户</th><th>用户</th><th>来源</th><th class="r">持续</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="t in txns" :key="t.sessionId">
                <td class="tp-mono">{{ t.sessionId }}</td>
                <td>{{ t.tenant }}</td>
                <td>{{ t.user }}</td>
                <td class="tp-mono tp-dim">{{ t.host }}</td>
                <td class="r tp-mono">{{ t.seconds }}s</td>
                <td class="tp-dim">{{ t.state }}</td>
                <td class="r"><button class="tp-btn sm danger" :disabled="busy" @click="confirmOp('kill', t.sessionId)">终止</button></td>
              </tr>
              <tr v-if="!txns.length && !busy"><td colspan="7" class="tp-empty">当前没有未提交事务</td></tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>

    <!-- 参数修改弹层 -->
    <div v-if="edit" class="mask" @click.self="edit = null">
      <div class="dlg">
        <h4>修改参数</h4>
        <div class="drow"><label>参数</label><span class="tp-mono">{{ edit.name }}</span></div>
        <div class="drow"><label>当前值</label><span class="tp-mono tp-dim">{{ edit.value }}</span></div>
        <div class="drow">
          <label>新值</label>
          <input v-model="editValue" class="tp-input" spellcheck="false" placeholder="如 8G / 1024 / True" />
        </div>
        <div class="drow">
          <label>作用域</label>
          <select v-model="editTenant" class="tp-select">
            <option value="">集群级（ALTER SYSTEM SET）</option>
            <option v-for="t in tenantNames" :key="t" :value="t">租户 {{ t }}（ALTER TENANT）</option>
          </select>
        </div>
        <div class="tp-note">参数名与作用域会做白名单校验；值按数字 / 布尔 / 字符串自动转义。</div>
        <div class="dact">
          <button class="tp-btn sm" @click="edit = null">取消</button>
          <button class="tp-btn sm danger" :disabled="busy || !editValue.trim()" @click="submitParam">确认修改</button>
        </div>
      </div>
    </div>

    <!-- 写操作确认弹层 -->
    <div v-if="pending" class="mask" @click.self="pending = null">
      <div class="dlg">
        <h4>{{ pending.title }}</h4>
        <div class="tp-note">{{ pending.desc }}</div>
        <div class="dact">
          <button class="tp-btn sm" @click="pending = null">取消</button>
          <button class="tp-btn sm danger" :disabled="busy" @click="runPending">确认执行</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 实例运维（直连模式）：不走 OCP，直接在 OBServer 上做诊断与写操作。
 *
 * 与「操作日志」的分工：
 *   本页 —— 动作入口（看当前参数 / TopSQL / 事件，发出冻结、挂起、Kill、改参数）；
 *   操作日志 —— 动作留痕（每次写操作一条记录，含 SQL 与结果）。
 * 两个页面在左侧同一「运维」分组下，名称与说明都按这个分工来写。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { activePlatform, cloud } from '../../cloud/state'

type Tab = 'params' | 'topsql' | 'events' | 'ops'
const TABS: { key: Tab; label: string }[] = [
  { key: 'params', label: '系统参数' },
  { key: 'topsql', label: 'TopSQL' },
  { key: 'events', label: '运维事件' },
  { key: 'ops', label: '写操作' }
]

const tab = ref<Tab>('params')
const busy = ref(false)
const err = ref('')
const notice = ref('')

/** 可选的直连集群（一个直连平台 = 一套集群连接） */
const directPlatforms = computed(() => cloud.platforms.filter((p) => p.type === 'obdirect'))
const selPid = ref('')
/** 目标平台：优先用户选中的，否则跟随当前激活平台 / 第一个直连平台 */
const pid = computed(() => {
  if (selPid.value) return selPid.value
  const active = activePlatform()
  if (active && active.type === 'obdirect') return active.id
  return directPlatforms.value[0]?.id || ''
})

const cap = ref<{ version: string; clusterName: string; tenant: string } | null>(null)
const tenantNames = ref<string[]>([])

const params = ref<{ name: string; value: string; defaultValue: string; editLevel: string; info: string }[]>([])
const paramKw = ref('')

const topSql = ref<any[]>([])
const sqlHours = ref(24)
const topSqlLimit = 100
const sqlPick = ref<any | null>(null)
const sqlFull = ref('')

const events = ref<any[]>([])
const eventKw = ref('')
const eventHours = ref(72)

const txns = ref<any[]>([])

const edit = ref<any | null>(null)
const editValue = ref('')
const editTenant = ref('')

const pending = ref<{ title: string; desc: string; kind: 'freeze' | 'suspend' | 'resume' | 'kill'; sid?: number } | null>(null)

const fmtMs = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}ms`)
/** 5.7.25-OceanBase-v4.3.5.2 → 4.3.5.2（页面上只展示 OB 自己的版本号） */
const shortVersion = (v: string): string => {
  const m = /OceanBase[^\d]*(\d[\d.]*)/i.exec(String(v || ''))
  return m ? m[1].replace(/\.$/, '') : String(v || '')
}

const detailOf = (e: any): string => {
  const parts: string[] = []
  if (e.name1) parts.push(`${e.name1}=${e.value1}`)
  if (e.name2) parts.push(`${e.name2}=${e.value2}`)
  return parts.join('  ') || '—'
}

async function ensureCap(): Promise<void> {
  if (!pid.value || cap.value) return
  const r = await window.sqlpilot.cloudDirectCapability(pid.value)
  if (r.ok && r.data) {
    cap.value = { version: r.data.version, clusterName: r.data.clusterName, tenant: r.data.tenant }
  }
}

/** 参数作用域下拉：取该集群下的业务租户名（此前这个下拉一直是空的） */
function ensureTenants(): void {
  if (!pid.value) return
  tenantNames.value = cloud.tenants
    .filter((t) => cloud.directOf[t.clusterId] === pid.value && !t.isMeta && !t.isSys)
    .map((t) => t.name)
}

async function loadParams(): Promise<void> {
  if (!pid.value) return
  busy.value = true; err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectParameters(pid.value, { keyword: paramKw.value, limit: 300 })
    if (!r.ok) err.value = r.error || '读取参数失败'
    else params.value = r.data || []
  } finally { busy.value = false }
}

async function loadTopSql(): Promise<void> {
  if (!pid.value) return
  busy.value = true; err.value = ''
  sqlPick.value = null; sqlFull.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectTopSql(pid.value, { hours: sqlHours.value, limit: topSqlLimit })
    if (!r.ok) err.value = r.error || '读取 TopSQL 失败'
    else topSql.value = r.data || []
  } finally { busy.value = false }
}

async function pickSql(row: any): Promise<void> {
  sqlPick.value = row
  sqlFull.value = ''
  if (!pid.value) return
  const r = await window.sqlpilot.cloudDirectSqlText(pid.value, row.sqlId)
  if (r.ok && r.data) sqlFull.value = r.data
}

async function loadEvents(): Promise<void> {
  if (!pid.value) return
  busy.value = true; err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectEvents(pid.value, { hours: eventHours.value, keyword: eventKw.value, limit: 200 })
    if (!r.ok) err.value = r.error || '读取事件失败'
    else events.value = r.data || []
  } finally { busy.value = false }
}

async function loadTxns(): Promise<void> {
  if (!pid.value) return
  busy.value = true; err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectOpenTxns(pid.value)
    if (!r.ok) err.value = r.error || '读取事务失败'
    else txns.value = r.data || []
  } finally { busy.value = false }
}

function switchTab(t: Tab): void {
  tab.value = t
  err.value = ''
  notice.value = ''
  if (t === 'params' && !params.value.length) void loadParams()
  if (t === 'topsql' && !topSql.value.length) void loadTopSql()
  if (t === 'events' && !events.value.length) void loadEvents()
  if (t === 'ops' && !txns.value.length) void loadTxns()
}

function reloadAll(): void {
  cap.value = null
  notice.value = ''
  void ensureCap()
  void switchTab(tab.value)
}

function openParamEdit(p: any): void {
  edit.value = p
  editValue.value = p.value
  editTenant.value = ''
  void ensureTenants()
}

async function submitParam(): Promise<void> {
  if (!pid.value || !edit.value) return
  busy.value = true; err.value = ''; notice.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectSetParameter(pid.value, edit.value.name, editValue.value.trim(), editTenant.value || undefined)
    if (!r.ok) err.value = r.error || '修改失败'
    else {
      notice.value = r.data?.message || '修改成功'
      edit.value = null
      await loadParams()
    }
  } finally { busy.value = false }
}

function confirmOp(kind: 'freeze' | 'suspend' | 'resume' | 'kill', sid?: number): void {
  const map = {
    freeze: { title: '触发合并', desc: '将对当前实例执行 ALTER SYSTEM MAJOR FREEZE，发起一次大合并。合并期间 IO 与 CPU 会有明显波动。' },
    suspend: { title: '挂起合并', desc: '将执行 ALTER SYSTEM SUSPEND MERGE，合并会一直挂起直到手动恢复——忘记恢复会导致多版本数据无法回收。' },
    resume: { title: '恢复合并', desc: '将执行 ALTER SYSTEM RESUME MERGE，恢复被挂起的合并。' },
    kill: { title: `终止会话 ${sid}`, desc: `将执行 KILL ${sid}，该会话上的未提交事务会回滚，业务侧会立刻感知。` }
  } as const
  pending.value = { ...map[kind], kind, sid }
}

async function runPending(): Promise<void> {
  if (!pid.value || !pending.value) return
  const { kind, sid } = pending.value
  busy.value = true; err.value = ''; notice.value = ''
  try {
    const api = window.sqlpilot
    const r = kind === 'freeze' ? await api.cloudDirectMajorFreeze(pid.value)
      : kind === 'kill' ? await api.cloudDirectKillSession(pid.value, sid || 0)
      : await api.cloudDirectMergeSuspend(pid.value, kind === 'suspend')
    if (!r.ok) err.value = r.error || '执行失败'
    else {
      notice.value = r.data?.message || '执行成功'
      pending.value = null
      if (kind === 'kill') await loadTxns()
    }
  } finally { busy.value = false }
}

onMounted(() => {
  void ensureCap()
  void loadParams()
})

watch(pid, () => {
  cap.value = null
  params.value = []; topSql.value = []; events.value = []; txns.value = []
  tenantNames.value = []
  if (pid.value) { void ensureCap(); void loadParams() }
})
</script>

<style scoped>
.dp { gap: 11px; }
.dp-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.dp-title { flex: 1; min-width: 320px; }
.dp-title h2 { margin: 0; font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dp-sub { font-size: 11px; color: var(--text-dim); line-height: 1.6; margin: 6px 0 0; }
.dp-sub.dim { color: var(--text-faint); margin-top: 4px; }
.dp-list { margin: 5px 0 0; padding-left: 18px; font-size: 11px; color: var(--text-dim); line-height: 1.75; }
.dp-list b { color: var(--text); font-weight: 600; }
.dp-tools { display: flex; align-items: center; gap: 7px; flex-shrink: 0; padding-top: 2px; }
.dp-lbl { font-size: 10.5px; color: var(--text-faint); }
.dp-note {
  padding: 14px; border: 1px dashed var(--border); border-radius: 10px;
  font-size: 12px; color: var(--text-dim);
}
/* 页内 tab：与租户 / 告警页保持一致的下划线式 */
.subtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.subtab {
  border: none; background: none; color: var(--text-faint); font-family: inherit; font-size: 12.5px;
  padding: 6px 10px 7px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.subtab:hover { color: var(--text); }
.subtab.on { color: var(--accent); border-bottom-color: var(--accent); }
.opcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.opcard { align-items: flex-start; gap: 6px; }
.op-t { font-size: 12.5px; font-weight: 600; }
.op-d { font-size: 11px; color: var(--text-faint); line-height: 1.6; }
.sqltext {
  margin: 0; padding: 10px 12px; font-family: var(--mono); font-size: 11.5px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
}
.dp :deep(.wrap) { white-space: pre-wrap; word-break: break-word; max-width: 420px; }
.dp :deep(.ell) { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mask { position: fixed; inset: 0; background: rgba(4, 6, 10, 0.5); display: grid; place-items: center; z-index: 60; }
.dlg {
  width: min(480px, 92vw); background: var(--bg-side); border: 1px solid var(--border-strong);
  border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
}
.dlg h4 { margin: 0; font-size: 13.5px; font-weight: 600; }
.drow { display: flex; align-items: center; gap: 10px; }
.drow > label { flex: 0 0 62px; font-size: 11px; color: var(--text-faint); }
.drow > .tp-input, .drow > .tp-select { flex: 1; min-width: 0; }
.dact { display: flex; justify-content: flex-end; gap: 8px; }
</style>
