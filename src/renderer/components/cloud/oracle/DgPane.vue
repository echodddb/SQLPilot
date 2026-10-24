<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-kvs" data-src="orDgSummary" :data-ai="oraPickKey('dg','overview')" data-ai-compact data-ai-name="角色与保护模式">
      <div class="oc-kv"><span>本库角色</span><b>{{ d.role || '—' }}</b></div>
      <div class="oc-kv"><span>保护模式</span><b>{{ d.protectionMode || '—' }}</b></div>
      <div class="oc-kv"><span>应用延迟统计</span><b :style="d.available ? '' : 'color: var(--warn, #d9a441)'">{{ d.available ? '可读' : '无数据' }}</b></div>
      <div class="oc-kv"><span>MRP 进程</span><b>{{ d.processes.length ? d.processes.map((p) => p.process).join(' / ') : '无' }}</b></div>
    </div>

    <div v-if="!d.available" class="oc-warn">
      <span>ℹ</span>
      <div>
        <b>v$dataguard_stats 没有数据</b>
        <div class="oc-note">
          常见原因：本库是主库且备库没连上、备库未开启日志应用、或没有 Data Guard 配置。
          下面「归档目标」里 DEST_ID=2 且 DESTINATION 有值才说明配了远程归档。
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orDgStats" :data-ai="oraPickKey('dg','stats')" data-ai-compact data-ai-name="应用与传输延迟">
      <div class="oc-card-h"><span>应用/传输延迟</span><span class="cnt">{{ d.stats.length }}</span></div>
      <OraTable :columns="statCols" :rows="d.stats" empty="没有延迟统计（需要备库或未授权）" />
    </div>

    <div class="oc-card" data-src="orDgDests" :data-ai="oraPickKey('dg','dests')" data-ai-compact data-ai-name="归档目标">
      <div class="oc-card-h"><span>归档目标</span><span class="cnt">{{ d.dests.length }}</span><span class="sp"></span>
        <span class="oc-note">ERROR 非空 / GAP 有值 表示日志没传过去</span>
      </div>
      <OraTable :columns="destCols" :rows="d.dests" default-sort="destId" default-dir="1" />
    </div>

    <div class="oc-card" data-src="orDgProcs" :data-ai="oraPickKey('dg','processes')" data-ai-compact data-ai-name="DG 进程">
      <div class="oc-card-h"><span>Data Guard 进程</span><span class="cnt">{{ d.processes.length }}</span></div>
      <OraTable :columns="procCols" :rows="d.processes" empty="没有 MRP/LNS 进程（未配置备库）" />
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { oraData } from '../../../cloud/oracle'

const d = computed(() => oraData('dg'))

const statCols: OraCol[] = [
  { key: 'name', label: '指标' },
  { key: 'value', label: '值', type: 'mono' },
  { key: 'unit', label: '单位' },
  { key: 'timeComputed', label: '计算时间', type: 'mono' }
]

const destCols: OraCol[] = [
  { key: 'destId', label: 'DEST', type: 'num', width: '56px' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'type', label: '类型' },
  { key: 'dbMode', label: '库模式' },
  { key: 'recoveryMode', label: '恢复模式' },
  { key: 'protectionMode', label: '保护模式' },
  { key: 'dbUnique', label: 'DB Unique', type: 'mono' },
  { key: 'destination', label: '目标', type: 'mono' },
  { key: 'archivedSeq', label: '已归档序', type: 'num' },
  { key: 'appliedSeq', label: '已应用序', type: 'num' },
  { key: 'gapStatus', label: 'GAP' },
  { key: 'synchronized', label: '同步' },
  { key: 'error', label: '错误' }
]

const procCols: OraCol[] = [
  { key: 'process', label: '进程' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'thread', label: '线程', type: 'num' },
  { key: 'sequence', label: '序列', type: 'num' },
  { key: 'block', label: 'BLOCK#', type: 'num' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
