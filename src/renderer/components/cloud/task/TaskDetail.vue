<template>
  <div class="td-mask" @click.self="closeTask">
    <aside class="td-drawer" @click.stop>
      <header class="td-head">
        <div>
          <div class="td-title">
            <b>{{ t.name }}</b>
            <span class="tk-st" :class="st.tone"><i class="dot"></i>{{ st.label }}</span>
            <span class="tp-chip">{{ t.type === 'AUTO' ? '自动任务' : '手动任务' }}</span>
          </div>
          <div class="td-sub mono">任务 ID {{ t.id }} · {{ t.operation }}<template v-if="t.taskDefinitionId > 0"> · 定义 #{{ t.taskDefinitionId }}</template></div>
        </div>
        <button class="x" title="关闭（Esc）" @click="closeTask">✕</button>
      </header>

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
          <span class="tp-note" style="margin-left:auto">条形长度＝该步耗时占比</span>
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
              <span class="nm-s mono">{{ s.nodeType || '—' }} · {{ s.operation }}<template v-if="s.timeout"> · 超时 {{ s.timeout }}s</template></span>
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
          </div>
          <div v-if="!t.subtasks.length" class="tp-empty">该任务没有子任务记录</div>
        </div>

        <div v-if="failedSteps.length" class="tp-warn">
          失败步骤：{{ failedSteps.map((s) => s.name).join('、') }}。OCP 的任务详情接口不返回错误原因，可到 OCP 任务页查看对应子任务的日志。
        </div>

        <div class="tp-note">
          数据来源：GET /api/v2/tasks/instances/{{ t.id }}（子任务含 startTime / finishTime / runTime / upstreams / downstreams）。
          重试 / 回滚 / 跳过属于写操作，SqlPilot 暂未开放。
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * 任务详情抽屉：进度、执行上下文（发起者/执行器/集群/租户）、子任务时间轴与依赖。
 * 对齐 OCP「任务详情」页，但把 OCP 的流程图简化成按耗时占比的甘特条（数据全部来自 detail 接口）。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { cloud, closeTask } from '../../../cloud/state'
import { fmtTime, taskStatus } from '../../../cloud/parts'

const t = computed(() => cloud.taskDetail as CloudTaskDetail)
const st = computed(() => taskStatus(t.value.status))

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

const failedSteps = computed(() => t.value.subtasks.filter((s) => s.status === 'FAILED'))
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

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeTask()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.td-mask { position: fixed; inset: 0; z-index: 300; background: rgba(6, 8, 14, 0.42); display: flex; justify-content: flex-end; }
.td-drawer {
  width: 760px; max-width: 96vw; height: 100%; background: var(--bg-card); border-left: 1px solid var(--border-strong);
  display: flex; flex-direction: column; animation: slide 0.16s ease;
}
@keyframes slide { from { transform: translateX(18px); opacity: 0.6; } to { transform: none; opacity: 1; } }
.td-head { display: flex; align-items: flex-start; gap: 10px; padding: 13px 16px 11px; border-bottom: 1px solid var(--border); }
.td-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.td-title b { font-size: 14px; }
.td-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 5px; }
.td-head .x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.td-head .x:hover { color: var(--red); border-color: var(--red); }
.td-body { flex: 1; overflow-y: auto; padding: 12px 16px 22px; display: flex; flex-direction: column; gap: 10px; }
.td-body > * { flex: none; }

.td-progress { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border: 1px solid var(--border); background: var(--bg-input); border-radius: 9px; padding: 8px 11px; }
.pg-line { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 220px; }
.pg-line b { font-size: 12px; }
.pg-side { display: flex; gap: 5px; flex-wrap: wrap; }

.td-flow { display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--border); border-radius: 9px; padding: 7px 9px; background: var(--bg-input); }
.flow-row {
  display: grid; grid-template-columns: 18px minmax(150px, 1.5fr) minmax(90px, 1.2fr) 118px 48px 62px 42px;
  align-items: center; gap: 7px; padding: 3px 2px; border-radius: 6px;
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
.st { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; }
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
