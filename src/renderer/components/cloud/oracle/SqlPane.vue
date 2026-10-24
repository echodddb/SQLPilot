<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-card" data-src="orSqlTop" :data-ai="oraPickKey('sql','top')" data-ai-compact data-ai-name="TopSQL">
      <div class="oc-card-h">
        <span>TopSQL · 共享池</span><span class="cnt">{{ d.rows.length }}</span><span class="sp"></span>
        <span class="oc-note">gv$sql：点一行看全文与执行计划</span>
      </div>
      <div class="oc-tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="oc-tab"
          :class="{ on: ora.sqlBy === t.key }"
          @click="switchBy(t.key)"
        >{{ t.label }}</button>
      </div>
      <OraTable :columns="cols" :rows="d.rows" row-key="sqlId" searchable search-placeholder="SQL_ID / 用户 / 模块…" @row="open" />
    </div>

    <div v-if="ora.sqlDetail" class="oc-card" data-src="orSqlDetail" :data-ai="oraPickKey('sql','plan')" data-ai-compact data-ai-name="执行计划">
      <div class="oc-card-h">
        <span>SQL 详情</span><span class="cnt">{{ ora.sqlDetail.sqlId }}</span><span class="sp"></span>
        <button class="oc-btn" @click="close">收起</button>
      </div>
      <div v-if="ora.sqlDetailLoading" class="oc-loading">读取中…</div>
      <template v-else>
        <div class="oc-sql-text">{{ ora.sqlDetail.text || '（共享池里已刷出该游标，或没有权限读 v$sqltext）' }}</div>
        <div v-if="ora.sqlDetail.plan.length" class="oc-plan">
          <div class="oc-plan-row" style="color: var(--text-faint)">
            <span>ID</span><span style="flex: 1">执行计划</span><span>COST</span><span>CARD</span>
          </div>
          <div v-for="p in ora.sqlDetail.plan" :key="p.id + '-' + p.operation" class="oc-plan-row">
            <span>{{ p.id }}</span>
            <span style="flex: 1">{{ '  '.repeat(p.depth) }}{{ p.operation }}{{ p.options ? ' ' + p.options : '' }}{{ p.objectName ? ' · ' + p.objectName : '' }}</span>
            <span>{{ p.cost }}</span>
            <span>{{ p.cardinality }}</span>
          </div>
        </div>
        <div v-else class="oc-note">没有读到执行计划（可能需要 SELECT_CATALOG_ROLE，或游标已刷出）</div>
      </template>
    </div>

    <div class="oc-card" data-src="orSqlAwr" :data-ai="oraPickKey('sql','awr')" data-ai-compact data-ai-name="AWR 历史 TOP">
      <div class="oc-card-h">
        <span>AWR 历史 TopSQL</span><span class="cnt">{{ d.awr.length }}</span><span class="sp"></span>
        <span class="oc-note">{{ d.awrRange || '最近 12 个快照' }} · 需要 Diagnostics Pack 授权</span>
      </div>
      <OraTable :columns="awrCols" :rows="d.awr" empty="没有 AWR 数据（未生成快照或未授权）" default-sort="elapsedS" />
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { ora, oraData, loadOra, loadSqlDetail } from '../../../cloud/oracle'

const d = computed(() => oraData('sql'))

const TABS = [
  { key: 'elapsed' as const, label: '按 DB Time' },
  { key: 'cpu' as const, label: '按 CPU' },
  { key: 'gets' as const, label: '按逻辑读' },
  { key: 'disk' as const, label: '按物理读' }
]

function switchBy(k: 'elapsed' | 'cpu' | 'gets' | 'disk'): void {
  if (ora.sqlBy === k) return
  ora.sqlBy = k
  void loadOra('sql', true, { by: k })
}

function open(row: any): void {
  void loadSqlDetail(String(row.sqlId))
}

function close(): void {
  ora.sqlDetail = null
}

const cols: OraCol[] = (() => {
  const base: OraCol[] = [
    { key: 'sqlId', label: 'SQL_ID', type: 'mono' },
    { key: 'executions', label: '执行次数', type: 'num' },
    { key: 'elapsedS', label: '总耗时(s)', type: 'num' },
    { key: 'cpuS', label: 'CPU(s)', type: 'num' },
    { key: 'avgMs', label: '单次(ms)', type: 'num' },
    { key: 'bufferGets', label: '逻辑读', type: 'num' },
    { key: 'diskReads', label: '物理读', type: 'num' },
    { key: 'rowsProcessed', label: '返回行', type: 'num' },
    { key: 'schema', label: '解析用户' },
    { key: 'module', label: '模块' },
    { key: 'lastActive', label: '最近活跃', type: 'time' }
  ]
  return base
})()

const awrCols: OraCol[] = [
  { key: 'sqlId', label: 'SQL_ID', type: 'mono' },
  { key: 'executions', label: '执行次数', type: 'num' },
  { key: 'elapsedS', label: '总耗时(s)', type: 'num' },
  { key: 'cpuS', label: 'CPU(s)', type: 'num' },
  { key: 'gets', label: '逻辑读', type: 'num' },
  { key: 'reads', label: '物理读', type: 'num' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
.oc-tabs { display: flex; gap: 4px; }
.oc-tab {
  height: 24px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); font-size: 11px; font-family: inherit; cursor: pointer;
}
.oc-tab:hover { color: var(--text); }
.oc-tab.on { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
</style>
