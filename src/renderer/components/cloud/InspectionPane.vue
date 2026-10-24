<template>
  <div class="tp-pane ip">
    <!-- 对象概览：按 OCP 的「集群 / 租户 / OBProxy」三类巡检对象分 -->
    <div class="tp-card" data-ai="inspection.overview">
      <div class="tp-bar">
        <div class="tp-h">巡检对象 <span class="cnt">{{ rows.length }}</span></div>
        <div class="seg">
          <button v-for="t in TYPES" :key="t.key" class="sg" :class="{ on: s.type === t.key }" @click="setInspectionType(t.key)">
            {{ t.label }} {{ (s.bundle?.overviews[t.key] || []).length }}
          </button>
        </div>
        <span class="sp"></span>
        <button class="tp-btn sm ghost" :disabled="cloud.loading" @click="refresh">刷新</button>
      </div>
      <div class="tp-tbl-wrap">
        <table class="tp-tbl">
          <thead>
            <tr><th>对象</th><th>最近巡检</th><th>风险</th><th class="r">巡检项</th><th>调度</th><th>最近报告</th><th class="r">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="`${r.object.type}-${r.object.objectId}`">
              <td>
                <div class="cell-main">{{ r.object.name || `#${r.object.objectId}` }}</div>
                <div class="cell-sub tp-mono">{{ typeLabel(r.object.type) }} · {{ r.object.objectId }}</div>
              </td>
              <td class="tp-mono tp-dim">{{ r.latest?.startTime ? fmtTime(r.latest.startTime) : '未巡检' }}</td>
              <td>
                <template v-if="r.latest">
                  <span class="tp-chip" :class="r.latest.high ? 'bad' : 'idle'" title="高风险">高 {{ r.latest.high }}</span>
                  <span class="tp-chip" :class="r.latest.medium ? 'warn' : 'idle'" title="中风险">中 {{ r.latest.medium }}</span>
                  <span class="tp-chip idle" title="低风险">低 {{ r.latest.low }}</span>
                </template>
                <span v-else class="tp-dim">—</span>
              </td>
              <td class="r tp-mono tp-dim">{{ r.latest ? `${r.latest.itemFinished}/${r.latest.itemTotal}` : '—' }}</td>
              <td>
                <span class="tp-chip" :class="r.scheduleState === 'ACTIVE' ? 'ok' : 'idle'">{{ scheduleLabel(r.scheduleState) }}</span>
              </td>
              <td class="tp-dim">{{ r.latest?.tag || '—' }}<span v-if="r.reportCount > 1" class="tp-faint"> · 共 {{ r.reportCount }} 份</span></td>
              <td class="r">
                <button v-if="r.latest" class="tp-btn sm" @click="openInspectionReport(r.latest.id)">查看报告</button>
                <span v-else class="tp-faint">暂无</span>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="7" class="tp-empty">该类对象还没有巡检记录</td></tr>
          </tbody>
        </table>
      </div>
      <div class="tp-note">
        巡检项由 OCP 内置「{{ (s.bundle?.tags || [])[0]?.name || '基础巡检' }}」等规则集提供；调度未启用时只能手动发起，SQLPilot 侧当前只读。
      </div>
    </div>

    <!-- 巡检历史 -->
    <div class="tp-card" data-ai="inspection.reports">
      <div class="tp-bar">
        <div class="tp-h">巡检历史 <span class="cnt">{{ tasks.length }}</span></div>
        <span class="sp"></span>
        <span class="tp-dim total">{{ s.bundle?.total || tasks.length }} 份报告</span>
      </div>
      <div class="tp-tbl-wrap scroll">
        <table class="tp-tbl">
          <thead>
            <tr><th>报告</th><th>对象</th><th>巡检集</th><th>开始</th><th>耗时</th><th class="r">巡检项</th><th>风险</th><th>状态</th><th class="r"></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.id">
              <td class="tp-mono">#{{ t.id }}</td>
              <td>
                <div class="cell-main">{{ t.object.name || '—' }}</div>
                <div class="cell-sub">{{ typeLabel(t.object.type) }}</div>
              </td>
              <td class="tp-dim">{{ t.tag || '—' }}</td>
              <td class="tp-mono tp-dim">{{ t.startTime ? fmtTime(t.startTime) : '—' }}</td>
              <td class="tp-mono tp-dim">{{ duration(t.startTime, t.endTime) }}</td>
              <td class="r tp-mono tp-dim">{{ t.itemFinished }}/{{ t.itemTotal }}</td>
              <td>
                <span class="tp-chip" :class="t.high ? 'bad' : 'idle'">高 {{ t.high }}</span>
                <span class="tp-chip" :class="t.medium ? 'warn' : 'idle'">中 {{ t.medium }}</span>
                <span class="tp-chip idle">低 {{ t.low }}</span>
              </td>
              <td><span class="tp-chip" :class="stateTone(t.state)">{{ stateLabel(t.state) }}</span></td>
              <td class="r"><button class="tp-btn sm" @click="openInspectionReport(t.id)">详情</button></td>
            </tr>
            <tr v-if="!tasks.length"><td colspan="9" class="tp-empty">还没有巡检报告</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="tp-err" v-if="s.error">{{ s.error }}</div>
    <InspectionReport v-if="s.reportOpen" />
  </div>
</template>

<script setup lang="ts">
/**
 * 巡检（对齐 OCP 官方「巡检」）：对象概览（集群/租户/OBProxy）+ 巡检历史 + 报告详情。
 * 数据来自 inspection/overview、inspection/task、inspection/report/{id}（均实测）。
 */
import { computed } from 'vue'
import InspectionReport from './InspectionReport.vue'
import { cloud, inspectionRows, load, openInspectionReport, setInspectionType } from '../../cloud/state'
import { duration, fmtTime } from '../../cloud/parts'

const s = cloud.inspection
const TYPES: { key: CloudInspectionObjectType; label: string }[] = [
  { key: 'OB_CLUSTER', label: '集群' },
  { key: 'OB_TENANT', label: '租户' },
  { key: 'OB_PROXY', label: 'OBProxy' }
]

const rows = computed(() => inspectionRows())
const tasks = computed(() => s.bundle?.tasks || [])

function typeLabel(t: string): string {
  if (t === 'OB_CLUSTER') return '集群'
  if (t === 'OB_TENANT') return '租户'
  if (t === 'OB_PROXY') return 'OBProxy'
  return t || '—'
}
function scheduleLabel(s2: string): string {
  if (!s2 || s2 === 'INACTIVE') return '未启用'
  if (s2 === 'ACTIVE') return '定时调度'
  if (s2 === 'EXPIRED') return '已过期'
  if (s2 === 'CLOSED') return '已关闭'
  return s2
}
function stateLabel(v: string): string {
  if (v === 'SUCCESSFUL') return '已完成'
  if (v === 'RUNNING' || v === 'EXECUTING') return '执行中'
  if (v === 'FAILED') return '失败'
  return v || '—'
}
function stateTone(v: string): string {
  if (v === 'SUCCESSFUL') return 'ok'
  if (v === 'RUNNING' || v === 'EXECUTING') return 'info'
  if (v === 'FAILED') return 'bad'
  return 'idle'
}
function refresh(): void {
  void load()
}
</script>

<style scoped>
.ip { display: flex; flex-direction: column; gap: 10px; }
.seg { display: flex; align-items: center; gap: 2px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
.sg {
  height: 22px; padding: 0 9px; border: none; border-radius: 6px; background: none; color: var(--text-dim);
  font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.sg:hover { color: var(--text); }
.sg.on { background: var(--accent-dim); color: var(--accent); }
.cell-main { font-size: 11.5px; }
.cell-sub { font-size: 9.5px; color: var(--text-faint); margin-top: 1px; }
.total { font-family: var(--mono); font-size: 10.5px; }
.scroll { max-height: 46vh; overflow-y: auto; }
</style>
