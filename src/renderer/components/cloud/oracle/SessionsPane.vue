<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-cards">
      <div class="oc-card" data-src="orSeSummary" :data-ai="oraPickKey('sessions','dist')" data-ai-compact data-ai-name="会话分布">
        <div class="oc-card-h"><span>会话状态</span></div>
        <div class="oc-bars">
          <div v-for="s in d.summary" :key="s.type + s.status" class="oc-bar-row">
            <span>{{ s.type }} · {{ s.status }}</span>
            <i><b :style="{ width: pct(s.count, total) + '%' }"></b></i>
            <em>{{ s.count }}</em>
          </div>
        </div>
      </div>
      <div class="oc-card" data-src="orSeWaitClass" :data-ai="oraPickKey('sessions','waitclass')" data-ai-compact data-ai-name="等待分类">
        <div class="oc-card-h"><span>用户会话等待分类</span><span class="sp"></span><span class="oc-note">CPU 表示正在跑</span></div>
        <div class="oc-bars">
          <div v-for="w in d.waitClass" :key="w.waitClass" class="oc-bar-row">
            <span>{{ w.waitClass }}</span>
            <i><b :class="w.waitClass === 'CPU' ? '' : 'warn'" :style="{ width: pct(w.count, userTotal) + '%' }"></b></i>
            <em>{{ w.count }}</em>
          </div>
        </div>
      </div>
    </div>

    <div v-if="d.blocking.length" class="oc-card" data-src="orSeBlocking" :data-ai="oraPickKey('sessions','blocking')" data-ai-compact data-ai-name="阻塞链">
      <div class="oc-card-h">
        <span style="color: var(--red)">阻塞链</span><span class="cnt">{{ d.blocking.length }}</span><span class="sp"></span>
        <span class="oc-note">BLOCKER_SID 是持锁者；到「SQL 诊断」用 blocker_sql 查它的执行计划</span>
      </div>
      <OraTable :columns="blockCols" :rows="d.blocking" default-sort="ctime" />
    </div>

    <div class="oc-card" data-src="orSeLong" :data-ai="oraPickKey('sessions','longops')" data-ai-compact data-ai-name="长操作">
      <div class="oc-card-h"><span>长操作进度</span><span class="cnt">{{ d.longops.length }}</span><span class="sp"></span>
        <span class="oc-note">v$session_longops 剩余时间 &gt; 0</span>
      </div>
      <OraTable :columns="longCols" :rows="d.longops" empty="当前没有长操作" default-sort="timeRemaining" />
    </div>

    <div class="oc-card" data-src="orSeList" :data-ai="oraPickKey('sessions','list')" data-ai-compact data-ai-name="会话明细">
      <div class="oc-card-h">
        <span>用户会话</span><span class="cnt">{{ d.list.length }}</span><span class="sp"></span>
        <span class="oc-note">按「活跃优先 + 空闲时长」排序</span>
      </div>
      <OraTable :columns="sessCols" :rows="d.list" searchable search-placeholder="用户名 / 机器 / SQL_ID / 事件…" page-size="60" />
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

const d = computed(() => oraData('sessions'))
const total = computed(() => Math.max(1, ...(d.value?.summary.map((s) => s.count) || [1])))
const userTotal = computed(() => Math.max(1, ...(d.value?.waitClass.map((w) => w.count) || [1])))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

const blockCols: OraCol[] = [
  { key: 'instId', label: 'INST', type: 'num', width: '52px' },
  { key: 'sid', label: '被阻塞 SID', type: 'num' },
  { key: 'username', label: '被阻塞用户' },
  { key: 'event', label: '等待事件' },
  { key: 'type', label: '锁类型' },
  { key: 'lmode', label: '持有' },
  { key: 'request', label: '申请' },
  { key: 'ctime', label: '等待秒数', type: 'num' },
  { key: 'blockerSid', label: '阻塞者 SID', type: 'num' },
  { key: 'blockerUser', label: '阻塞者' },
  { key: 'blockerSql', label: '阻塞者 SQL_ID', type: 'mono' },
  { key: 'sqlId', label: '等待者 SQL_ID', type: 'mono' }
]

const longCols: OraCol[] = [
  { key: 'instId', label: 'INST', type: 'num', width: '52px' },
  { key: 'sid', label: 'SID', type: 'num' },
  { key: 'opname', label: '操作' },
  { key: 'target', label: '对象', type: 'mono' },
  { key: 'pct', label: '进度', type: 'bar', width: '140px' },
  { key: 'timeRemaining', label: '剩余(s)', type: 'num' },
  { key: 'elapsed', label: '已耗时(s)', type: 'num' },
  { key: 'sqlId', label: 'SQL_ID', type: 'mono' }
]

const sessCols: OraCol[] = [
  { key: 'instId', label: 'INST', type: 'num', width: '52px' },
  { key: 'sid', label: 'SID', type: 'num', width: '58px' },
  { key: 'serial', label: 'SERIAL#', type: 'num', width: '70px' },
  { key: 'username', label: '用户' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'machine', label: '机器', type: 'mono' },
  { key: 'program', label: '程序', type: 'mono' },
  { key: 'sqlId', label: 'SQL_ID', type: 'mono' },
  { key: 'event', label: '等待事件' },
  { key: 'waitClass', label: '等待类' },
  { key: 'secondsInWait', label: '等待(s)', type: 'num' },
  { key: 'lastCallEt', label: '空闲(s)', type: 'num' },
  { key: 'blockingSession', label: '被谁阻塞', type: 'num' },
  { key: 'spid', label: 'OS PID', type: 'mono' },
  { key: 'logonTime', label: '登录时间', type: 'time' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
