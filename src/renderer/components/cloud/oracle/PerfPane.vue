<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-card" data-src="orPfMetric" :data-ai="oraPickKey('perf','metrics')" data-ai-compact data-ai-name="实时指标">
      <div class="oc-card-h"><span>实时指标</span><span class="sp"></span><span class="oc-note">v$sysmetric · 60 秒粒度</span></div>
      <div class="oc-kvs">
        <div v-for="m in d.metrics" :key="m.name" class="oc-kv">
          <span>{{ m.name }}</span>
          <b>{{ m.value.toFixed(2) }} <em style="font-style: normal; color: var(--text-faint)">{{ m.unit }}</em></b>
        </div>
      </div>
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orPfWait" :data-ai="oraPickKey('perf','events')" data-ai-compact data-ai-name="系统等待 TOP">
        <div class="oc-card-h"><span>累计等待 TOP</span><span class="sp"></span><span class="oc-note">占 DB 时间越长越值得优化</span></div>
        <div class="oc-bars">
          <div v-for="e in d.systemEvent.slice(0, 12)" :key="e.event" class="oc-bar-row">
            <span :title="e.event">{{ e.event }}</span>
            <i><b :class="e.waitClass === 'User I/O' ? 'warn' : ''" :style="{ width: pct(e.timeS, maxWait) + '%' }"></b></i>
            <em>{{ fmtSec(e.timeS) }}</em>
          </div>
        </div>
      </div>
      <div class="oc-card" data-src="orPfAsh" :data-ai="oraPickKey('perf','ash')" data-ai-compact data-ai-name="ASH 采样">
        <div class="oc-card-h"><span>ASH 采样</span><span class="sp"></span><span class="oc-note">{{ d.ashWindow }}</span></div>
        <OraTable :columns="ashCols" :rows="d.ash" empty="这段时间没有采样（库很闲）" default-sort="samples" />
      </div>
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orPfSga" :data-ai="oraPickKey('perf','sga')" data-ai-compact data-ai-name="SGA">
        <div class="oc-card-h"><span>SGA</span><span class="sp"></span><span class="oc-note">合计 {{ fmtSize(sgaTotal) }}</span></div>
        <div class="oc-bars">
          <div v-for="s in d.sga" :key="s.name" class="oc-bar-row">
            <span>{{ s.name }}</span>
            <i><b :style="{ width: pct(s.mb, sgaTotal) + '%' }"></b></i>
            <em>{{ fmtSize(s.mb) }}</em>
          </div>
        </div>
      </div>
      <div class="oc-card" data-src="orPfPga" :data-ai="oraPickKey('perf','pga')" data-ai-compact data-ai-name="PGA">
        <div class="oc-card-h"><span>PGA</span></div>
        <div class="oc-bars">
          <div v-for="p in d.pga" :key="p.name" class="oc-bar-row">
            <span>{{ p.name }}</span>
            <i><b :style="{ width: pct(p.mb, maxPga) + '%' }"></b></i>
            <em>{{ fmtSize(p.mb) }}</em>
          </div>
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orPfSysstat" :data-ai="oraPickKey('perf','sysstat')" data-ai-compact data-ai-name="系统统计">
      <div class="oc-card-h"><span>系统统计</span><span class="sp"></span><span class="oc-note">实例启动以来累计值</span></div>
      <div class="oc-kvs">
        <div v-for="s in d.sysstat" :key="s.name" class="oc-kv">
          <span>{{ s.name }}</span>
          <b>{{ s.name.includes('size') ? fmtSize(s.value / 1048576) : s.value.toLocaleString('zh-CN') }}</b>
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orPfOs" :data-ai="oraPickKey('perf','os')" data-ai-compact data-ai-name="OS 统计">
      <div class="oc-card-h"><span>OS 统计</span><span class="sp"></span><span class="oc-note">v$osstat</span></div>
      <div class="oc-kvs">
        <div v-for="o in d.osstat" :key="o.name" class="oc-kv">
          <span>{{ o.name }}</span>
          <b>{{ osValue(o.name, o.value) }}</b>
        </div>
      </div>
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

const d = computed(() => oraData('perf'))
const sgaTotal = computed(() => (d.value?.sga || []).reduce((a, b) => a + b.mb, 0))
const maxPga = computed(() => Math.max(1, ...(d.value?.pga.map((p) => p.mb) || [1])))
const maxWait = computed(() => Math.max(1, ...(d.value?.systemEvent.map((e) => e.timeS) || [1])))

const ashCols: OraCol[] = [
  { key: 'sqlId', label: 'SQL_ID', type: 'mono' },
  { key: 'event', label: '等待事件' },
  { key: 'state', label: '状态', type: 'state' },
  { key: 'samples', label: '采样数', type: 'num' }
]

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}
function fmtSize(mb: number): string {
  const n = Number(mb) || 0
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n.toFixed(0)} MB`
}
function fmtSec(s: number): string {
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`
  if (s >= 60) return `${(s / 60).toFixed(0)}m`
  return `${s.toFixed(0)}s`
}
function osValue(name: string, v: number): string {
  if (name === 'PHYSICAL_MEMORY_BYTES') return `${(v / 1073741824).toFixed(1)} GB`
  if (name === 'LOAD') return v.toFixed(2)
  if (name.endsWith('_TIME')) return `${(v / 100).toFixed(0)}%`
  return v.toLocaleString('zh-CN')
}
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
