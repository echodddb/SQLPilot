<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-card" data-src="orJbSched" :data-ai="oraPickKey('jobs','scheduler')" data-ai-compact data-ai-name="Scheduler 作业">
      <div class="oc-card-h"><span>Scheduler 作业</span><span class="cnt">{{ d.scheduler.length }}</span><span class="sp"></span>
        <span class="oc-note">FAILURE_COUNT &gt; 0 的会在「作业历史」里留下失败记录</span>
      </div>
      <OraTable :columns="schedCols" :rows="d.scheduler" searchable search-placeholder="owner / 作业名…" page-size="60" default-sort="failureCount" />
    </div>

    <div class="oc-card" data-src="orJbDbms" :data-ai="oraPickKey('jobs','dbms')" data-ai-compact data-ai-name="DBMS_JOB">
      <div class="oc-card-h"><span>DBMS_JOB 作业</span><span class="cnt">{{ d.dbms.length }}</span><span class="sp"></span>
        <span class="oc-note">BROKEN=Y 表示连续失败被自动禁用</span>
      </div>
      <OraTable :columns="dbmsCols" :rows="d.dbms" empty="没有 DBMS_JOB 作业" default-sort="job" default-dir="1" />
    </div>

    <div class="oc-card" data-src="orJbRuns" :data-ai="oraPickKey('jobs','runs')" data-ai-compact data-ai-name="最近运行">
      <div class="oc-card-h"><span>作业运行历史</span><span class="cnt">{{ d.runs.length }}</span><span class="sp"></span>
        <span class="oc-note">最近 80 条</span>
      </div>
      <OraTable :columns="runCols" :rows="d.runs" searchable search-placeholder="作业名 / 状态…" page-size="60" />
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

const d = computed(() => oraData('jobs'))

const schedCols: OraCol[] = [
  { key: 'owner', label: 'OWNER', type: 'mono' },
  { key: 'jobName', label: '作业名', type: 'mono' },
  { key: 'enabled', label: '启用', type: 'state' },
  { key: 'state', label: '状态', type: 'state' },
  { key: 'runCount', label: '运行次数', type: 'num' },
  { key: 'failureCount', label: '失败次数', type: 'num' },
  { key: 'lastStart', label: '上次运行', type: 'time' },
  { key: 'nextRun', label: '下次运行', type: 'time' }
]

const dbmsCols: OraCol[] = [
  { key: 'job', label: 'JOB', type: 'num', width: '64px' },
  { key: 'logUser', label: 'LOG_USER', type: 'mono' },
  { key: 'broken', label: 'BROKEN', type: 'state' },
  { key: 'failures', label: '失败次数', type: 'num' },
  { key: 'lastDate', label: '上次', type: 'time' },
  { key: 'nextDate', label: '下次', type: 'time' },
  { key: 'what', label: '执行内容', type: 'mono' }
]

const runCols: OraCol[] = [
  { key: 'startTime', label: '开始', type: 'time' },
  { key: 'owner', label: 'OWNER', type: 'mono' },
  { key: 'jobName', label: '作业名', type: 'mono' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'durationS', label: '耗时(s)', type: 'num' },
  { key: 'info', label: '附加信息' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
