<template>
  <div class="dp">
    <div class="dp-head">
      <h2>
        直连运维
        <span class="count">{{ cap ? `v${cap.version} · ${cap.clusterName}` : '—' }}</span>
      </h2>
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" :class="{ active: tab === t.key }" @click="switchTab(t.key)">
          {{ t.label }}
        </button>
      </div>
    </div>

    <div v-if="!pid" class="note">请先在「平台设置」里选择或新建一个 OceanBase 直连平台。</div>

    <template v-else>
      <div v-if="err" class="msg err">{{ err }}</div>
      <div v-if="notice" class="msg ok">{{ notice }}</div>

      <!-- 系统参数 -->
      <div v-if="tab === 'params'">
        <div class="filters">
          <input v-model="paramKw" class="search" placeholder="按参数名或说明过滤（回车查询）" spellcheck="false" @keyup.enter="loadParams" />
          <button class="mini" :disabled="busy" @click="loadParams">查询</button>
          <span class="hint">已加载 {{ params.length }} 项 · 每台 OBServer 取一份</span>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr><th>参数</th><th>当前值</th><th>默认值</th><th>生效级别</th><th>说明</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in params" :key="p.name">
                <td class="mono">{{ p.name }}</td>
                <td class="mono">{{ p.value }}</td>
                <td class="mono dim">{{ p.defaultValue }}</td>
                <td class="dim">{{ p.editLevel }}</td>
                <td class="dim wrap">{{ p.info }}</td>
                <td><button class="mini" @click="openParamEdit(p)">修改</button></td>
              </tr>
              <tr v-if="!params.length && !busy"><td colspan="6" class="dim empty">没有匹配的参数</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- TopSQL -->
      <div v-else-if="tab === 'topsql'">
        <div class="filters">
          <select v-model.number="sqlHours" @change="loadTopSql">
            <option :value="1">近 1 小时</option>
            <option :value="6">近 6 小时</option>
            <option :value="24">近 24 小时</option>
            <option :value="72">近 3 天</option>
            <option :value="168">近 7 天</option>
          </select>
          <button class="mini" :disabled="busy" @click="loadTopSql">刷新</button>
          <span class="hint">按平均耗时倒序 · 取前 {{ topSqlLimit }} 条</span>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr><th>SQL_ID</th><th>次数</th><th>平均耗时</th><th>最大耗时</th><th>平均 CPU</th><th>返回行</th><th>SQL</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in topSql" :key="r.sqlId" :class="{ sel: sqlPick && sqlPick.sqlId === r.sqlId }" @click="pickSql(r)">
                <td class="mono">{{ r.sqlId.slice(0, 12) }}…</td>
                <td>{{ r.executions }}</td>
                <td class="mono">{{ fmtMs(r.avgElapsedMs) }}</td>
                <td class="mono">{{ fmtMs(r.maxElapsedMs) }}</td>
                <td class="mono dim">{{ fmtMs(r.avgCpuMs) }}</td>
                <td class="dim">{{ r.rowsExamined }}</td>
                <td class="dim wrap one-line">{{ r.sqlText }}</td>
              </tr>
              <tr v-if="!topSql.length && !busy"><td colspan="7" class="dim empty">该时间窗内没有审计记录</td></tr>
            </tbody>
          </table>
        </div>
        <div v-if="sqlPick" class="sqlbox">
          <div class="sqlbox-head">
            <span class="mono">{{ sqlPick.sqlId }}</span>
            <button class="mini" @click="sqlPick = null">收起</button>
          </div>
          <pre class="sqltext">{{ sqlFull || sqlPick.sqlText }}</pre>
        </div>
      </div>

      <!-- 运维事件 -->
      <div v-else-if="tab === 'events'">
        <div class="filters">
          <input v-model="eventKw" class="search" placeholder="按事件名过滤（回车查询）" spellcheck="false" @keyup.enter="loadEvents" />
          <select v-model.number="eventHours" @change="loadEvents">
            <option :value="24">近 24 小时</option>
            <option :value="72">近 3 天</option>
            <option :value="168">近 7 天</option>
            <option :value="720">近 30 天</option>
          </select>
          <button class="mini" :disabled="busy" @click="loadEvents">查询</button>
          <span class="hint">来自 DBA_OB_ROOTSERVICE_EVENT_HISTORY（只读）</span>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr><th>时间</th><th>模块</th><th>事件</th><th>明细</th><th>RS</th></tr>
            </thead>
            <tbody>
              <tr v-for="(e, i) in events" :key="i">
                <td class="mono dim">{{ e.timestamp }}</td>
                <td>{{ e.module }}</td>
                <td class="mono">{{ e.event }}</td>
                <td class="dim wrap">{{ detailOf(e) }}</td>
                <td class="mono dim">{{ e.rsSvrIp }}</td>
              </tr>
              <tr v-if="!events.length && !busy"><td colspan="5" class="dim empty">该时间窗内没有事件</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 写操作 -->
      <div v-else>
        <div class="warnbar">
          <b>这些操作直接对实例执行 SQL，没有 OCP 的任务编排与回滚。</b>
          执行前请确认目标实例，所有操作会写入本地审计日志。
        </div>

        <div class="ops">
          <div class="op">
            <div class="op-t">触发合并</div>
            <div class="op-d">ALTER SYSTEM MAJOR FREEZE —— 发起一次大合并</div>
            <button class="mini danger" :disabled="busy" @click="confirmOp('freeze')">执行</button>
          </div>
          <div class="op">
            <div class="op-t">挂起合并</div>
            <div class="op-d">ALTER SYSTEM SUSPEND MERGE —— 大促等场景临时挂起</div>
            <button class="mini danger" :disabled="busy" @click="confirmOp('suspend')">执行</button>
          </div>
          <div class="op">
            <div class="op-t">恢复合并</div>
            <div class="op-d">ALTER SYSTEM RESUME MERGE —— 解除挂起</div>
            <button class="mini" :disabled="busy" @click="confirmOp('resume')">执行</button>
          </div>
        </div>

        <h3 class="sec">未提交事务</h3>
        <div class="filters">
          <button class="mini" :disabled="busy" @click="loadTxns">刷新</button>
          <span class="hint">来自 GV$OB_PROCESSLIST 的 TRANS_STATE，可按会话终止</span>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr><th>会话 ID</th><th>租户</th><th>用户</th><th>来源</th><th>持续</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="t in txns" :key="t.sessionId">
                <td class="mono">{{ t.sessionId }}</td>
                <td>{{ t.tenant }}</td>
                <td>{{ t.user }}</td>
                <td class="mono dim">{{ t.host }}</td>
                <td class="mono">{{ t.seconds }}s</td>
                <td class="dim">{{ t.state }}</td>
                <td><button class="mini danger" :disabled="busy" @click="confirmOp('kill', t.sessionId)">终止</button></td>
              </tr>
              <tr v-if="!txns.length && !busy"><td colspan="7" class="dim empty">当前没有未提交事务</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- 参数修改弹层 -->
    <div v-if="edit" class="mask" @click.self="edit = null">
      <div class="dlg">
        <h4>修改参数</h4>
        <div class="drow"><label>参数</label><span class="mono">{{ edit.name }}</span></div>
        <div class="drow"><label>当前值</label><span class="mono dim">{{ edit.value }}</span></div>
        <div class="drow">
          <label>新值</label>
          <input v-model="editValue" spellcheck="false" placeholder="如 8G / 1024 / True" />
        </div>
        <div class="drow">
          <label>作用域</label>
          <select v-model="editTenant">
            <option value="">集群级（ALTER SYSTEM SET）</option>
            <option v-for="t in tenantNames" :key="t" :value="t">租户 {{ t }}（ALTER TENANT）</option>
          </select>
        </div>
        <div class="dnote">参数名与作用域会做白名单校验；值按数字/布尔/字符串自动转义。</div>
        <div class="dact">
          <button class="mini" @click="edit = null">取消</button>
          <button class="mini danger" :disabled="busy || !editValue.trim()" @click="submitParam">确认修改</button>
        </div>
      </div>
    </div>

    <!-- 写操作确认弹层 -->
    <div v-if="pending" class="mask" @click.self="pending = null">
      <div class="dlg">
        <h4>{{ pending.title }}</h4>
        <div class="dnote">{{ pending.desc }}</div>
        <div class="dact">
          <button class="mini" @click="pending = null">取消</button>
          <button class="mini danger" :disabled="busy" @click="runPending">确认执行</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { activePlatform } from '../../cloud/state'

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

const pid = computed(() => {
  const p = activePlatform()
  return p && p.type === 'obdirect' ? p.id : ''
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

function openParamEdit(p: any): void {
  edit.value = p
  editValue.value = p.value
  editTenant.value = ''
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
    freeze: { title: '触发合并', desc: '将对当前实例执行 ALTER SYSTEM MAJOR FREEZE，发起一次大合并。' },
    suspend: { title: '挂起合并', desc: '将执行 ALTER SYSTEM SUSPEND MERGE，合并会一直挂起直到手动恢复。' },
    resume: { title: '恢复合并', desc: '将执行 ALTER SYSTEM RESUME MERGE，恢复被挂起的合并。' },
    kill: { title: `终止会话 ${sid}`, desc: `将执行 KILL ${sid}，该会话上的未提交事务会回滚。` }
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
  // 租户下拉：复用总览已加载的租户清单（若有）
  const p = activePlatform()
  if (p) void ensureCap()
})

watch(pid, () => {
  cap.value = null
  params.value = []; topSql.value = []; events.value = []; txns.value = []
  if (pid.value) { void ensureCap(); void loadParams() }
})
</script>

<style scoped>
.dp { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.dp-head { display: flex; align-items: basic; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dp-head h2 { margin: 0; font-size: 16px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.count { font-size: 12px; color: var(--text-3, #8a8f98); font-weight: 400; }
.tabs { display: flex; gap: 6px; }
.tabs button { background: transparent; border: 1px solid var(--line, #2a2f3a); color: var(--text-2, #b6bcc6); padding: 5px 12px; border-radius: 7px; cursor: pointer; font-size: 12px; }
.tabs button.active { background: rgba(90, 160, 255, .12); border-color: rgba(90, 160, 255, .5); color: #cfe3ff; }
.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search { flex: 0 0 280px; }
.hint { font-size: 12px; color: var(--text-3, #8a8f98); }
.note { padding: 16px; border: 1px dashed var(--line, #2a2f3a); border-radius: 10px; font-size: 13px; color: var(--text-2, #b6bcc6); }
.msg { padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
.msg.err { background: rgba(226, 75, 74, .12); border: 1px solid rgba(226, 75, 74, .4); color: #f4a9a8; }
.msg.ok { background: rgba(29, 158, 117, .12); border: 1px solid rgba(29, 158, 117, .4); color: #8fd9bd; }
.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
.dim { color: var(--text-3, #8a8f98); }
.wrap { max-width: 420px; white-space: normal; line-height: 1.5; }
.one-line { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { text-align: center; padding: 18px 0; }
tr.sel td { background: rgba(90, 160, 255, .08); }
.tbl tbody tr { cursor: default; }
.sqlbox { border: 1px solid var(--line, #2a2f3a); border-radius: 10px; overflow: hidden; }
.sqlbox-head { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(255, 255, 255, .03); }
.sqltext { margin: 0; padding: 12px; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; max-height: 320px; overflow: auto; color: #cfe3ff; }
.warnbar { padding: 10px 14px; border-radius: 9px; background: rgba(239, 159, 39, .1); border: 1px solid rgba(239, 159, 39, .35); color: #f0c58a; font-size: 12.5px; line-height: 1.6; }
.ops { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.op { border: 1px solid var(--line, #2a2f3a); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.op-t { font-size: 13px; font-weight: 500; }
.op-d { font-size: 12px; color: var(--text-3, #8a8f98); line-height: 1.5; }
.op button { align-self: flex-start; }
.sec { font-size: 13px; font-weight: 500; margin: 6px 0 0; }
.mask { position: absolute; inset: 0; background: rgba(0, 0, 0, .5); display: grid; place-items: center; z-index: 20; }
.dlg { width: min(460px, 92%); background: #171b22; border: 1px solid #2a2f3a; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.dlg h4 { margin: 0; font-size: 14px; font-weight: 500; }
.drow { display: flex; align-items: center; gap: 10px; }
.drow label { flex: 0 0 64px; font-size: 12px; color: var(--text-3, #8a8f98); }
.drow input, .drow select { flex: 1; }
.dnote { font-size: 12px; color: var(--text-3, #8a8f98); line-height: 1.5; }
.dact { display: flex; justify-content: flex-end; gap: 8px; }
</style>
