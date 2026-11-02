<template>
  <div class="td-mask" @click.self="closeTask">
    <aside class="td-drawer" @click.stop>
      <header class="td-head">
        <div class="td-head-main">
          <div class="td-title">
            <b>{{ t.name }}</b>
            <span class="tk-st" :class="st.tone"><i class="dot"></i>{{ st.label }}</span>
            <span class="tp-chip">{{ t.type === 'AUTO' ? '自动任务' : '手动任务' }}</span>
            <span v-if="t.operation" class="tp-chip mono">{{ opLabel(t.operation) }}</span>
          </div>
          <div class="td-sub mono">任务 ID {{ t.id }} · {{ t.operation }}<template v-if="t.taskDefinitionId > 0"> · 定义 #{{ t.taskDefinitionId }}</template></div>
        </div>
        <button class="x" title="关闭（Esc）" @click="closeTask">✕</button>
      </header>

      <!-- 操作条：与 OCP 任务详情一致（失败→重试/回滚，运行中→放弃，任意→日志/诊断包） -->
      <div class="td-ops">
        <template v-if="ops.length">
          <button
            v-for="op in ops"
            :key="op.key"
            class="tp-btn sm"
            :class="{ danger: op.danger }"
            :disabled="!!cloud.taskOpBusy || opBlocked(op.key)"
            :title="opBlocked(op.key) ? 'OCP 已标记该任务不允许回滚（prohibitRollback）' : op.desc"
            @click="askOp(op)"
          >
            {{ op.label }}
          </button>
        </template>
        <span v-else class="tp-note">该状态不支持重试 / 回滚 / 放弃</span>
        <span class="sp"></span>
        <button class="tp-btn sm" :disabled="!!cloud.taskOpBusy || logBusy" title="把所有子任务日志拼成一个 txt 保存" @click="saveLog">
          {{ logBusy ? '打包日志中…' : '下载日志' }}
        </button>
        <button class="tp-btn sm" :disabled="!!cloud.taskOpBusy || diagBusy" title="OCP 任务诊断包（zip）" @click="saveDiag">
          {{ diagBusy ? '下载中…' : '诊断包' }}
        </button>
        <button class="tp-btn sm" :disabled="cloud.taskDetailLoading" @click="reload">{{ cloud.taskDetailLoading ? '刷新中…' : '刷新' }}</button>
      </div>

      <div class="td-body">
        <!-- 进度 -->
        <div class="td-progress">
          <div class="pg-line">
            <span class="tp-bar-meter" style="flex:1">
              <i :class="{ bad: t.progress.failed, warn: t.progress.running && !t.progress.failed }" :style="{ width: t.progress.pct + '%' }" />
            </span>
            <b class="mono">{{ t.progress.done }}/{{ t.progress.total }}</b>
            <span class="tp-dim" style="font-size:11px">{{ t.progress.pct }}%</span>
          </div>
          <div class="pg-side">
            <span v-if="t.progress.failed" class="tp-chip bad">失败 {{ t.progress.failed }}</span>
            <span v-if="t.progress.running" class="tp-chip warn">执行中 {{ t.progress.running }}</span>
            <span v-if="t.progress.pending" class="tp-chip idle">未执行 {{ t.progress.pending }}</span>
            <span v-if="skipped" class="tp-chip warn">已跳过 {{ skipped }}</span>
            <span class="tp-chip">总耗时 {{ durText(t.durationMs) }}</span>
          </div>
        </div>

        <div class="tp-kv-grid" data-src="taskDetail" :data-detail="`任务 ${t.id} ${t.name}|${st.label} ${t.progress.done}/${t.progress.total} · 耗时 ${durText(t.durationMs)}`">
          <div class="tp-kv"><span>发起者</span><b>{{ t.creator || '—' }}</b></div>
          <div class="tp-kv"><span>执行器</span><b class="mono">{{ t.executor || '—' }}</b></div>
          <div class="tp-kv"><span>集群</span><b>{{ clusterLabel }}</b></div>
          <div class="tp-kv"><span>租户</span><b>{{ t.tenant || '—' }}</b></div>
          <div class="tp-kv"><span>操作对象</span><b>{{ objLabel }}</b></div>
          <div class="tp-kv"><span>对象类型</span><b>{{ typeLabel }}</b></div>
          <div class="tp-kv"><span>创建时间</span><b>{{ fmtTime(t.createTime) }}</b></div>
          <div class="tp-kv"><span>开始时间</span><b>{{ fmtTime(t.startTime) }}</b></div>
          <div class="tp-kv"><span>结束时间</span><b>{{ fmtTime(t.finishTime) }}</b></div>
          <div class="tp-kv"><span>回滚 / 跳过</span><b>{{ t.prohibitRollback ? '禁回滚' : '可回滚' }} · {{ t.prohibitSkip ? '禁跳过' : '可跳过' }}</b></div>
        </div>

        <!-- 子任务时间轴 -->
        <h4 class="tp-h">
          子任务时间轴 <span class="cnt">{{ t.subtasks.length }}</span>
          <span class="tp-note" style="margin-left:auto">条形长度＝该步耗时占比 · 行尾可直接操作</span>
        </h4>
        <div
          class="td-flow"
          data-src="taskSubtask"
          :data-detail="`子任务 ${t.progress.done}/${t.progress.total} 成功${t.progress.failed ? '、' + t.progress.failed + ' 失败' : ''}|并行度 series=${seriesCount} · 最长一步 ${longest.name || '—'}`"
        >
          <div v-for="(s, i) in t.subtasks" :key="s.id" class="flow-row" :class="subTone(s.status)">
            <span class="idx mono">{{ i + 1 }}</span>
            <span class="nm">
              <span class="nm-t">{{ s.name }}</span>
              <span class="nm-s mono">
                {{ s.nodeType || '—' }} · {{ opLabel(s.operation) }}<template v-if="s.timeout"> · 超时 {{ s.timeout }}s</template><template v-if="s.prohibitRollback"> · 禁回滚</template>
              </span>
            </span>
            <span class="spark">
              <i :style="barStyle(s)" />
            </span>
            <span class="tm mono">{{ s.startTime ? fmtClock(s.startTime) : '—' }} → {{ s.finishTime ? fmtClock(s.finishTime) : '—' }}</span>
            <span class="ttl mono">{{ s.runTime ? s.runTime + 's' : '—' }}</span>
            <span class="st">
              <i class="dot"></i>{{ taskStatus(s.status).label }}
            </span>
            <span class="dep mono" :title="depText(s)">{{ depShort(s) }}</span>
            <span class="ops">
              <button class="lnk" :disabled="logBusy" title="查看该步的服务器日志" @click="openLog(s)">日志</button>
              <button
                v-for="a in subtaskOps(s.status)"
                :key="a"
                class="lnk"
                :class="{ danger: a !== 'retry' }"
                :disabled="!!cloud.taskOpBusy || (a === 'skip' && t.prohibitSkip)"
                :title="a === 'skip' ? '跳过＝把该步置为成功，可能造成元信息与真实状态不一致' : a === 'cancel' ? '终止该步运行' : '重新执行该步'"
                @click="askSubOp(s, a)"
              >{{ SUB_LABEL[a] }}</button>
            </span>
          </div>
          <div v-if="!t.subtasks.length" class="tp-empty">该任务没有子任务记录</div>
        </div>

        <div v-if="failedSteps.length" class="tp-warn">
          失败步骤：{{ failedSteps.map((s) => s.name).join('、') }}。
          点行尾「日志」看该步的服务器日志；需要重跑用「重试」，确认可跳过用「跳过」。
        </div>

        <div class="tp-note">
          操作全部走 OCP 原生接口：POST /api/v2/tasks/instances/{{ t.id }}/{retry|rollback|abort}、
          /subtasks/{id}/{retry|skip|cancel}；日志 GET /subtasks/{id}/log；诊断包 POST /downloadDiagnosis。
          重试/回滚会生成新的任务实例，提交成功后本面板自动刷新。
        </div>
      </div>

      <TaskLogView v-if="logSub" :task-id="t.id" :sub="logSub!" @close="logSub = null" />
    </aside>

    <TaskAbortModal v-if="abortFor" :task="abortFor" @close="abortFor = null" />
  </div>
</template>

<script setup lang="ts">
/**
 * 任务详情抽屉：进度、执行上下文（发起者/执行器/集群/租户）、子任务时间轴与依赖，
 * 以及与 OCP 一致的操作入口：
 *   任务级 retry / rollback / abort + 下载整任务日志 + 诊断包
 *   子任务级 日志 / retry / skip / cancel（按状态出现，规则见 parts.ts 的 subtaskOps）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cloud, closeTask, openTask, runTaskAction, runSubtaskAction, downloadTaskLog, downloadTaskDiagnosis } from '../../../cloud/state'
import { fmtTime, taskStatus, taskOps, subtaskOps, type TaskOpDef, type SubtaskOp, type TaskOp } from '../../../cloud/parts'
import { pushNotice } from '../../../store'
import TaskLogView from './TaskLogView.vue'
import TaskAbortModal from './TaskAbortModal.vue'

const SUB_LABEL: Record<SubtaskOp, string> = { retry: '重试', skip: '跳过', cancel: '终止' }

const t = computed(() => cloud.taskDetail as CloudTaskDetail)
const st = computed(() => taskStatus(t.value.status))
const ops = computed<TaskOpDef[]>(() => taskOps(t.value.status))

const clusterLabel = computed(() => {
  const c = t.value
  if (!c.clusterName) return '—'
  return c.clusterObId ? `${c.clusterName}:${c.clusterObId}` : c.clusterName
})
const objLabel = computed(() => [t.value.objName, t.value.tenant].filter(Boolean).join(' / ') || '—')

const TYPE_MAP: Record<string, string> = {
  OB_TENANT: 'OceanBase 租户',
  OB_CLUSTER: 'OceanBase 集群',
  OB_SERVER: 'OBServer',
  HOST: '主机',
  OBPROXY: 'OBProxy',
  OCP_AGENT: 'OCP Agent',
  SERVICE: '服务'
}
const typeLabel = computed(() => TYPE_MAP[t.value.objType] || t.value.objType || '—')

/** OCP 的 operation 枚举（EXECUTE / ROLLBACK / ROLLBACK_RETRY / ABORT / SKIP / CANCEL …） */
const OP_MAP: Record<string, string> = {
  EXECUTE: '执行',
  RETRY: '重试',
  ROLLBACK: '回滚',
  ROLLBACK_RETRY: '回滚',
  ABORT: '放弃',
  SKIP: '已跳过',
  CANCEL: '已终止',
  ROLLBACK_SKIP: '已跳过',
  ROLLBACK_CANCEL: '已终止'
}
function opLabel(op: string): string {
  return OP_MAP[op] || op || '—'
}

const failedSteps = computed(() => t.value.subtasks.filter((s) => s.status === 'FAILED'))
const skipped = computed(() => t.value.subtasks.filter((s) => s.status === 'DISREGARDED').length)
const seriesCount = computed(() => new Set(t.value.subtasks.map((s) => s.parallelIdx).filter((v) => v >= 0)).size)

const longest = computed(() => t.value.subtasks.reduce((best, s) => (s.runTime > (best.runTime || 0) ? s : best), { name: '', runTime: 0 } as CloudSubtask))

/** 时间轴：以任务开始为 0 点，跨度取任务总耗时（未结束则取最晚一步） */
const span = computed(() => {
  const start = t.value.startTime ? new Date(t.value.startTime).getTime() : 0
  if (!start) return 1
  const end = Math.max(
    t.value.finishTime ? new Date(t.value.finishTime).getTime() : Date.now(),
    ...t.value.subtasks.map((s) => (s.finishTime ? new Date(s.finishTime).getTime() : 0))
  )
  return Math.max(1000, end - start)
})

function barStyle(s: CloudSubtask): Record<string, string> {
  const base = t.value.startTime ? new Date(t.value.startTime).getTime() : 0
  const st0 = s.startTime ? new Date(s.startTime).getTime() : base
  const en = s.finishTime ? new Date(s.finishTime).getTime() : (s.status === 'RUNNING' ? Date.now() : st0)
  const left = Math.max(0, ((st0 - base) / span.value) * 100)
  const width = Math.max(1.2, ((en - st0) / span.value) * 100)
  return { marginLeft: `${Math.min(99, left)}%`, width: `${Math.min(100 - Math.min(99, left), width)}%` }
}

function subTone(status: string): string {
  return taskStatus(status).tone
}
function fmtClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function durText(ms: number): string {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
function depShort(s: CloudSubtask): string {
  const up = s.upstreams.length
  const down = s.downstreams.length
  if (!up && !down) return ''
  return `↑${up} ↓${down}`
}
function depText(s: CloudSubtask): string {
  return `上游：${s.upstreams.join(', ') || '无'}\n下游：${s.downstreams.join(', ') || '无'}`
}

// ---------------------------------------------------------------- 操作

const logSub = ref<CloudSubtask | null>(null)
const abortFor = ref<{ id: number; name: string } | null>(null)
const logBusy = ref(false)
const diagBusy = ref(false)

/** prohibitRollback 的任务不允许回滚（OCP 详情接口给的硬标记） */
function opBlocked(op: TaskOp): boolean {
  return op === 'rollback' && !!t.value.prohibitRollback
}

async function askOp(op: TaskOpDef): Promise<void> {
  if (opBlocked(op.key)) return
  if (op.key === 'abort') {
    abortFor.value = { id: t.value.id, name: t.value.name }
    return
  }
  const ok = await window.sqlpilot.uiConfirm(`${op.label}任务「${t.value.name}」？`, op.desc, op.danger)
  if (!ok) return
  const r = await runTaskAction(t.value.id, op.key)
  if (!r.ok) pushNotice(r.error || '操作失败')
}

async function askSubOp(s: CloudSubtask, action: SubtaskOp): Promise<void> {
  const title = `${{ retry: '重试', skip: '跳过', cancel: '终止' }[action]}子任务「${s.name}」？`
  const detail = action === 'skip'
    ? '跳过会把该步直接置为成功，可能造成 OCP 元信息缺失或状态与真实状态不一致，请谨慎操作。'
    : action === 'cancel'
      ? '这将会终止当前节点正在运行的任务。'
      : '这将会重新执行当前节点的任务。'
  const ok = await window.sqlpilot.uiConfirm(title, detail, action !== 'retry')
  if (!ok) return
  const r = await runSubtaskAction(t.value.id, s.id, action)
  if (!r.ok) pushNotice(r.error || '操作失败')
}

function openLog(s: CloudSubtask): void {
  logSub.value = s
}

async function saveLog(): Promise<void> {
  if (logBusy.value) return
  logBusy.value = true
  const r = await downloadTaskLog(t.value.id, t.value.name)
  logBusy.value = false
  if (!r.ok && !r.canceled) pushNotice(r.error || '日志保存失败')
}

async function saveDiag(): Promise<void> {
  if (diagBusy.value) return
  diagBusy.value = true
  const r = await downloadTaskDiagnosis(t.value.id)
  diagBusy.value = false
  if (!r.ok && !r.canceled) pushNotice(r.error || '诊断包下载失败')
}

function reload(): void {
  void openTask(t.value.id)
}

// 详情抽屉是同一个组件实例复用的：换任务时把日志面板/确认框收掉，避免看到上一个任务的子任务日志
watch(() => t.value?.id, () => {
  logSub.value = null
  abortFor.value = null
})

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 日志面板优先关闭，避免一次 Esc 直接把整个抽屉关掉
  if (logSub.value) { logSub.value = null; return }
  if (abortFor.value) { abortFor.value = null; return }
  closeTask()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.td-mask { position: fixed; inset: 0; z-index: 300; background: rgba(6, 8, 14, 0.42); display: flex; justify-content: flex-end; padding-top: var(--titlebar-h); }
.td-drawer {
  width: 800px; max-width: 96vw; height: 100%; background: var(--bg-card); border-left: 1px solid var(--border-strong);
  display: flex; flex-direction: column; position: relative; animation: slide 0.16s ease;
}
@keyframes slide { from { transform: translateX(18px); opacity: 0.6; } to { transform: none; opacity: 1; } }
.td-head { display: flex; align-items: flex-start; gap: 10px; padding: 13px 16px 11px; border-bottom: 1px solid var(--border); }
.td-head-main { min-width: 0; flex: 1; }
.td-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.td-title b { font-size: 14px; }
.td-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 5px; }
.td-head .x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.td-head .x:hover { color: var(--red); border-color: var(--red); }

.td-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 7px 16px; border-bottom: 1px solid var(--border); background: var(--bg-input); }
.td-ops .sp { flex: 1; }
.td-ops .tp-btn.danger { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, var(--border)); }
.td-ops .tp-btn.danger:hover:not(:disabled) { color: var(--red); border-color: var(--red); }

.td-body { flex: 1; overflow-y: auto; padding: 12px 16px 22px; display: flex; flex-direction: column; gap: 10px; }
.td-body > * { flex: none; }

.td-progress { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border: 1px solid var(--border); background: var(--bg-input); border-radius: 9px; padding: 8px 11px; }
.pg-line { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px; }
.pg-line b { font-size: 12px; }
.pg-side { display: flex; gap: 5px; flex-wrap: wrap; }

.td-flow { display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--border); border-radius: 9px; padding: 7px 9px; background: var(--bg-input); }
.flow-row {
  display: grid; grid-template-columns: 18px minmax(126px, 1.5fr) minmax(64px, 1fr) 108px 40px 56px 34px 126px;
  align-items: center; gap: 6px; padding: 3px 2px; border-radius: 6px;
}
.flow-row:hover { background: var(--bg-card); }
.flow-row .idx { font-size: 10px; color: var(--text-faint); text-align: right; }
.nm { display: flex; flex-direction: column; min-width: 0; }
.nm-t { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm-s { font-size: 9.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spark { position: relative; height: 8px; background: var(--bg-card); border-radius: 99px; border: 1px solid var(--border); overflow: hidden; }
.spark > i { display: block; height: 100%; background: var(--green); opacity: 0.85; border-radius: 99px; }
.flow-row.bad .spark > i { background: var(--red); }
.flow-row.warn .spark > i { background: var(--yellow); }
.flow-row.info .spark > i { background: var(--accent); }
.flow-row.idle .spark > i { background: var(--text-faint); }
.tm { font-size: 9.5px; color: var(--text-faint); white-space: nowrap; }
.ttl { font-size: 10px; color: var(--text-dim); text-align: right; }
.st { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; white-space: nowrap; }
.st .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); }
.flow-row.ok .st { color: var(--green); }
.flow-row.ok .st .dot { background: var(--green); }
.flow-row.bad .st { color: var(--red); }
.flow-row.bad .st .dot { background: var(--red); }
.flow-row.warn .st { color: var(--yellow); }
.flow-row.warn .st .dot { background: var(--yellow); }
.flow-row.info .st { color: var(--accent); }
.flow-row.info .st .dot { background: var(--accent); }
.dep { font-size: 9.5px; color: var(--text-faint); white-space: nowrap; }

/* 行尾操作：默认就看得见（这是本面板的主功能），悬停整行再叠加背景 */
.ops { display: flex; align-items: center; gap: 7px; justify-content: flex-end; }
.ops .lnk { opacity: 0.9; }
.flow-row:hover .ops .lnk { opacity: 1; }
.lnk {
  border: 0; background: none; padding: 0; font: inherit; font-size: 10.5px; color: var(--accent);
  cursor: pointer; white-space: nowrap;
}
.lnk:hover:not(:disabled) { text-decoration: underline; }
.lnk.danger { color: var(--yellow); }
.lnk:disabled { color: var(--text-faint); cursor: not-allowed; opacity: 0.5; }

.tk-st { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
.tk-st .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
.tk-st.ok { color: var(--green); }
.tk-st.ok .dot { background: var(--green); }
.tk-st.bad { color: var(--red); }
.tk-st.bad .dot { background: var(--red); }
.tk-st.warn { color: var(--yellow); }
.tk-st.warn .dot { background: var(--yellow); }
.tk-st.info { color: var(--accent); }
.tk-st.info .dot { background: var(--accent); }
</style>
