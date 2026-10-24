<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-kvs" data-src="orBkSummary" :data-ai="oraPickKey('backup','overview')" data-ai-compact data-ai-name="备份概况">
      <div class="oc-kv"><span>最近一次全库备份</span><b>{{ d.lastFull || '没有全库备份记录' }}</b></div>
      <div class="oc-kv"><span>最近一次结果</span><b :style="d.lastStatus === 'COMPLETED' ? '' : 'color: var(--red)'">{{ d.lastStatus || '—' }}</b></div>
      <div class="oc-kv"><span>近 24h 归档</span><b>{{ d.archive.count24h }} 个 · {{ d.archive.gb24h }} GB</b></div>
      <div class="oc-kv"><span>FRA 水位</span><b>{{ d.fra ? `${d.fra.usedPct.toFixed(1)}% (${d.fra.usedGb}/${d.fra.limitGb} GB)` : '未配置' }}</b></div>
    </div>

    <div v-if="d.jobs.length && d.lastStatus !== 'COMPLETED'" class="oc-warn">
      <span>⚠</span>
      <div>
        <b>最近一次 RMAN 作业状态为 {{ d.lastStatus || '未知' }}</b>
        <div class="oc-note">到下面的作业表看失败原因（COMMAND_ID 对应 RMAN 的 command id，可在 RMAN 日志里检索）。</div>
      </div>
    </div>

    <div class="oc-card" data-src="orBkJobs" :data-ai="oraPickKey('backup','jobs')" data-ai-compact data-ai-name="RMAN 作业">
      <div class="oc-card-h"><span>RMAN 作业</span><span class="cnt">{{ d.jobs.length }}</span><span class="sp"></span>
        <span class="oc-note">v$rman_backup_job_details，最多 40 条</span>
      </div>
      <OraTable :columns="jobCols" :rows="d.jobs" empty="没有 RMAN 作业记录（可能从未做过备份）" />
    </div>

    <div class="oc-card" data-src="orBkSets" :data-ai="oraPickKey('backup','sets')" data-ai-compact data-ai-name="备份集">
      <div class="oc-card-h"><span>备份集</span><span class="cnt">{{ d.sets.length }}</span><span class="sp"></span>
        <span class="oc-note">incr 为空表示全量；0=0 级增量</span>
      </div>
      <OraTable :columns="setCols" :rows="d.sets" empty="没有备份集（控制文件里没有记录）" />
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

const d = computed(() => oraData('backup'))

const jobCols: OraCol[] = [
  { key: 'sessionKey', label: 'SESSION', type: 'num', width: '80px' },
  { key: 'commandId', label: 'COMMAND_ID', type: 'mono' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'inputType', label: '类型' },
  { key: 'startTime', label: '开始', type: 'time' },
  { key: 'endTime', label: '结束', type: 'mono' },
  { key: 'elapsedS', label: '耗时(s)', type: 'num' },
  { key: 'outputGb', label: '输出(GB)', type: 'num' },
  { key: 'device', label: '设备' }
]

const setCols: OraCol[] = [
  { key: 'recid', label: 'RECID', type: 'num', width: '70px' },
  { key: 'backupType', label: '类型' },
  { key: 'incremental', label: '增量级别' },
  { key: 'done', label: '完成时间', type: 'time' },
  { key: 'gb', label: '大小(GB)', type: 'num' },
  { key: 'pieces', label: '分片', type: 'num' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
