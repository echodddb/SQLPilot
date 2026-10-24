<template>
  <div class="tp-pane" style="padding:0">
    <!-- 状态胶囊 + 刷新/导出 -->
    <div class="tp-bar">
      <div class="st-tabs" data-ai="tasks.stats">
        <button
          v-for="t in statusTabs"
          :key="t.key"
          class="st-tab"
          :class="{ on: cloud.tasks.status === t.key }"
          @click="setTaskStatus(t.key)"
        >
          {{ t.label }}<span class="n">{{ t.count }}</span>
        </button>
      </div>
      <span class="sp"></span>
      <span v-if="cloud.taskUpdatedAt" class="tp-note">最近刷新 {{ relTime(new Date(cloud.taskUpdatedAt).toISOString()) }}</span>
      <button class="tp-btn" :disabled="!rows.length" title="导出当前筛选结果" @click="exportRows">导出 CSV</button>
      <button class="tp-btn" :disabled="cloud.loading" @click="refresh">{{ cloud.loading ? '读取中…' : '刷新' }}</button>
    </div>

    <!-- 筛选：集群/租户走服务端，发起者/对象类型/触发方式/时间由主进程过滤 -->
    <div class="tp-bar">
      <select class="tp-select" :value="cloud.taskFilter.clusterId" @change="onCluster">
        <option :value="0">全部集群</option>
        <option v-for="c in cloud.clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <select class="tp-select" :value="cloud.taskFilter.creator" @change="onCreator">
        <option value="">全部发起者</option>
        <option v-for="c in cloud.taskCreators" :key="c" :value="c">{{ c }}</option>
      </select>
      <select class="tp-select" :value="cloud.taskFilter.objType" @change="onObjType">
        <option value="">全部对象类型</option>
        <option v-for="o in OBJ_TYPES" :key="o.key" :value="o.key">{{ o.label }}</option>
      </select>
      <select class="tp-select" :value="cloud.taskFilter.type" @change="onTaskType">
        <option value="">全部触发方式</option>
        <option v-for="k in TASK_KINDS" :key="k.key" :value="k.key">{{ k.label }}</option>
      </select>
      <select class="tp-select" :value="cloud.taskFilter.hours" @change="onHours">
        <option :value="0">不限时间</option>
        <option :value="1">近 1 小时</option>
        <option :value="24">近 24 小时</option>
        <option :value="72">近 3 天</option>
        <option :value="168">近 7 天</option>
      </select>
      <input
        :value="cloud.tasks.name"
        class="tp-input tp-search"
        placeholder="搜索任务名 / 操作对象，回车"
        spellcheck="false"
        @input="nameDraft = ($event.target as HTMLInputElement).value"
        @keyup.enter="applyName"
      />
      <button class="tp-btn ghost" @click="resetTaskFilters">重置</button>
      <span v-if="hasLocalFilter" class="tp-note" :class="{ warn: cloud.taskTruncated }">
        {{ cloud.taskTruncated ? `候选集已截断，仅在前 ${cloud.taskScanned} 条内筛选` : `在 ${cloud.taskScanned} 条任务内筛选` }}
      </span>
    </div>

    <div v-if="cloud.error" class="tp-err">{{ cloud.error }}</div>

    <div
      class="tp-tbl-wrap tp-scroll-y"
      data-ai="tasks.list"
      data-src="taskList"
      :data-detail="`共 ${cloud.tasks.total} 个任务（扫描 ${cloud.taskScanned} 条）|筛选：${statusLabel(cloud.tasks.status)}${cloud.taskFilter.clusterId ? ' · 集群 ' + clusterName : ''}${cloud.taskFilter.creator ? ' · 发起者 ' + cloud.taskFilter.creator : ''}${cloud.tasks.name ? ' · 关键词 ' + cloud.tasks.name : ''}`"
    >
      <table class="tp-tbl">
        <thead>
          <tr>
            <th>任务名</th><th>操作对象</th><th>状态</th><th class="r">执行进度</th>
            <th>发起者</th>
            <th class="sortable" @click="toggleSort">开始时间<span class="sort">{{ cloud.taskFilter.sort === 'start_asc' ? '↑' : cloud.taskFilter.sort === 'duration_desc' ? '⇅' : '↓' }}</span></th>
            <th>结束时间</th>
            <th class="r sortable" @click="toggleDuration">耗时<span class="sort">{{ cloud.taskFilter.sort === 'duration_desc' ? '↓' : '⇅' }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in cloud.tasks.items" :key="t.id" class="clickable" @click="openTask(t.id)">
            <td>
              <div class="tk-name">{{ t.name }}</div>
              <div class="tk-sub mono">ID: {{ t.id }} · {{ t.operation }} · {{ kindLabel(t.type) }}</div>
            </td>
            <td>
              <div class="tk-obj mono">{{ objLine(t) }}</div>
              <div class="tk-sub">{{ typeLabel(t) }}</div>
            </td>
            <td>
              <span class="tk-st" :class="taskStatus(t.status).tone">
                <i class="dot"></i>{{ taskStatus(t.status).label }}
              </span>
            </td>
            <td class="r">
              <div class="prog-cell">
                <span class="tp-bar-meter"><i :class="{ bad: hasFailed(t), warn: t.status === 'RUNNING' || isRunning(t) }" :style="{ width: progressPct(t) + '%' }" /></span>
                <span class="mono">{{ progress(t) }}</span>
              </div>
            </td>
            <td class="tp-dim">{{ t.creator || '—' }}</td>
            <td class="tp-dim">{{ t.startTime ? fmtTimeShort(t.startTime) : '—' }}</td>
            <td class="tp-dim">{{ t.finishTime ? fmtTimeShort(t.finishTime) : '—' }}</td>
            <td class="r tp-mono tp-dim">{{ t.startTime ? duration(t.startTime, t.finishTime) : '—' }}</td>
          </tr>
          <tr v-if="!cloud.tasks.items.length">
            <td colspan="8" class="tp-empty">{{ cloud.loading ? '读取中…' : '没有符合条件的任务' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="tp-note">共 {{ cloud.tasks.total }} 条 · 每页 {{ cloud.tasks.size }}</span>
      <span class="sp"></span>
      <select class="tp-select" :value="cloud.tasks.size" @change="onSize">
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
      <button class="tp-btn sm" :disabled="cloud.tasks.page <= 1 || cloud.loading" @click="setTaskPage(cloud.tasks.page - 1)">上一页</button>
      <span class="tp-mono tp-dim" style="font-size:11px">{{ cloud.tasks.page }} / {{ maxPage }}</span>
      <button class="tp-btn sm" :disabled="cloud.tasks.page >= maxPage || cloud.loading" @click="setTaskPage(cloud.tasks.page + 1)">下一页</button>
    </div>

    <TaskDetail v-if="cloud.taskDetail" />
  </div>
</template>

<script setup lang="ts">
/**
 * 任务中心（对标 OCP「任务」页）：状态计数、集群/发起者/对象类型/触发方式/时间筛选、
 * 搜索、耗时排序、进度条、CSV 导出、任务详情抽屉（子任务时间轴）。
 * 服务端只认 status / name / clusterId / tenantId；其余条件由主进程在候选集里过滤，见 ocpTasks。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  cloud, load, ensureClusters, openTask, setTaskPage, setTaskStatus, setTaskName, setTaskFilter, resetTaskFilters, exportCsv
} from '../../cloud/state'
import { duration, fmtTimeShort, relTime, taskStatus } from '../../cloud/parts'
import { pushNotice } from '../../store'
import TaskDetail from './task/TaskDetail.vue'

const TASK_KINDS = [
  { key: 'MANUAL', label: '手动任务' },
  { key: 'SCHEDULED', label: '定时任务' },
  { key: 'SYS_SCHEDULED', label: '系统定时' },
  { key: 'SYS_ONCE', label: '系统单次' }
]

const OBJ_TYPES = [
  { key: 'OB_TENANT', label: 'OceanBase 租户' },
  { key: 'OB_CLUSTER', label: 'OceanBase 集群' },
  { key: 'OB_SERVER', label: 'OBServer' },
  { key: 'HOST', label: '主机' },
  { key: 'OBPROXY', label: 'OBProxy' },
  { key: 'OCP_AGENT', label: 'OCP Agent' }
]

const nameDraft = ref(cloud.tasks.name)
const rows = computed(() => cloud.tasks.items)
const maxPage = computed(() => Math.max(1, Math.ceil(cloud.tasks.total / Math.max(1, cloud.tasks.size))))
const clusterName = computed(() => cloud.clusters.find((c) => c.id === cloud.taskFilter.clusterId)?.name || '')
const hasLocalFilter = computed(() => !!(cloud.taskFilter.creator || cloud.taskFilter.objType || cloud.taskFilter.type || cloud.taskFilter.hours))

/** 状态 tab 的计数来自 state-statistics-batch（只有实际存在的状态），执行中把 PENDING/EXECUTING 合并 */
const statusTabs = computed(() => {
  const sum = (m: RegExp) => cloud.taskStats.filter((x) => m.test(x.status)).reduce((s, x) => s + x.count, 0)
  const base = [
    { key: '', label: '全部', count: cloud.taskStats.reduce((s, x) => s + x.count, 0) },
    { key: 'SUCCESSFUL', label: '已完成', count: sum(/^SUCCESSFUL$/) },
    { key: 'RUNNING', label: '执行中', count: sum(/RUNNING|PENDING|EXECUTING/) },
    { key: 'FAILED', label: '失败', count: sum(/^FAILED$/) }
  ]
  const paused = sum(/PAUSED|CANCELED|CANCELLED/)
  if (paused) base.push({ key: 'PAUSED', label: '暂停中', count: paused })
  return base
})

function statusLabel(key: string): string {
  return statusTabs.value.find((t) => t.key === key)?.label || '全部'
}

function progress(t: CloudTask): string {
  const total = t.subtasks.length
  if (!total) return '—'
  const done = t.subtasks.filter((s) => s.status === 'SUCCESSFUL').length
  return `${done}/${total}`
}
function progressPct(t: CloudTask): number {
  const total = t.subtasks.length
  if (!total) return 0
  const done = t.subtasks.filter((s) => s.status === 'SUCCESSFUL' || s.status === 'FAILED').length
  return Math.round((done / total) * 100)
}
function hasFailed(t: CloudTask): boolean {
  return t.status === 'FAILED' || t.subtasks.some((s) => s.status === 'FAILED')
}
function isRunning(t: CloudTask): boolean {
  return /RUNNING|PENDING|EXECUTING/.test(t.status)
}

function objLine(t: CloudTask): string {
  const parts: string[] = []
  if (t.clusterName) parts.push(t.clusterObId ? `${t.clusterName}:${t.clusterObId}` : t.clusterName)
  const name = t.objName || t.tenant
  if (name) parts.push(name)
  return parts.join(' / ') || '—'
}
function typeLabel(t: CloudTask): string {
  return OBJ_TYPES.find((o) => o.key === t.objType)?.label || t.objType || '—'
}
function kindLabel(type: string): string {
  return TASK_KINDS.find((k) => k.key === type)?.label || type || '—'
}

function onCluster(e: Event): void {
  void setTaskFilter({ clusterId: Number((e.target as HTMLSelectElement).value) || 0 })
}
function onCreator(e: Event): void {
  void setTaskFilter({ creator: (e.target as HTMLSelectElement).value })
}
function onObjType(e: Event): void {
  void setTaskFilter({ objType: (e.target as HTMLSelectElement).value })
}
function onTaskType(e: Event): void {
  void setTaskFilter({ type: (e.target as HTMLSelectElement).value as '' | 'MANUAL' | 'AUTO' })
}
function onHours(e: Event): void {
  void setTaskFilter({ hours: Number((e.target as HTMLSelectElement).value) || 0 })
}
function onSize(e: Event): void {
  cloud.tasks.size = Number((e.target as HTMLSelectElement).value) || 20
  void setTaskPage(1)
}
function applyName(): void {
  void setTaskName(nameDraft.value)
}
function toggleSort(): void {
  void setTaskFilter({ sort: cloud.taskFilter.sort === 'start_asc' ? 'start_desc' : 'start_asc' })
}
function toggleDuration(): void {
  void setTaskFilter({ sort: cloud.taskFilter.sort === 'duration_desc' ? 'start_desc' : 'duration_desc' })
}
function refresh(): void {
  void load()
}

async function exportRows(): Promise<void> {
  const cols = ['任务ID', '任务名', '操作', '触发方式', '状态', '进度', '操作对象', '对象类型', '发起者', '开始时间', '结束时间', '耗时']
  const data = rows.value.map((t) => [
    t.id,
    t.name,
    t.operation,
    kindLabel(t.type),
    taskStatus(t.status).label,
    progress(t),
    objLine(t),
    typeLabel(t),
    t.creator,
    t.startTime,
    t.finishTime,
    t.startTime ? duration(t.startTime, t.finishTime) : ''
  ])
  const r = await exportCsv('运维任务', cols, data)
  if (r.ok) pushNotice(`已导出 ${data.length} 条任务：${r.path}`)
  else if (!r.canceled) pushNotice(r.error || '导出失败')
}

/** 有任务在跑时 20s 自动刷新（与 OCP 的「最近刷新时间」体验一致） */
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void ensureClusters()
  void load()
  if (timer) return
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (cloud.loading || cloud.view !== 'tasks') return
    if (cloud.tasks.items.some((t) => /RUNNING|PENDING|EXECUTING/i.test(t.status))) void load()
  }, 20000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  timer = null
})
</script>

<style scoped>
.st-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.st-tab {
  display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text-dim); border-radius: 99px; padding: 2px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.st-tab:hover { color: var(--text); }
.st-tab.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.st-tab .n { font-family: var(--mono); font-size: 10px; opacity: 0.85; }

.tk-name { font-size: 12.5px; font-weight: 550; }
.tk-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
.tk-obj { font-size: 11px; color: var(--text-dim); }

.tk-st { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.tk-st .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
.tk-st.ok { color: var(--green); }
.tk-st.ok .dot { background: var(--green); }
.tk-st.bad { color: var(--red); }
.tk-st.bad .dot { background: var(--red); }
.tk-st.warn { color: var(--yellow); }
.tk-st.warn .dot { background: var(--yellow); }
.tk-st.info { color: var(--accent); }
.tk-st.info .dot { background: var(--accent); }

.prog-cell { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.prog-cell .tp-bar-meter { width: 54px; }
.prog-cell .mono { font-size: 10.5px; color: var(--text-dim); min-width: 32px; text-align: right; }

th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
th.sortable:hover { color: var(--text); }
.sort { margin-left: 4px; font-size: 9px; opacity: 0.6; }
.tp-note.warn { color: var(--yellow); }
.pager { display: flex; align-items: center; gap: 7px; }
.pager .sp { flex: 1; }
</style>
