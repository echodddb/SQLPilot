<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-card" data-src="orAlSummary" :data-ai="oraPickKey('alerts','overview')" data-ai-compact data-ai-name="告警总量与分布">
      <div class="oc-card-h">
        <span>告警日志概览</span><span class="sp"></span>
        <div class="oc-tabs">
          <button v-for="h in WINDOWS" :key="h.v" class="oc-tab" :class="{ on: d.hours === h.v }" @click="setHours(h.v)">{{ h.label }}</button>
        </div>
      </div>
      <div class="oc-kvs">
        <div class="oc-kv"><span>日志条目</span><b>{{ d.total.toLocaleString('zh-CN') }}</b></div>
        <div class="oc-kv"><span>含 ORA- 错误</span><b :style="d.errorCount ? 'color: var(--red)' : ''">{{ d.errorCount.toLocaleString('zh-CN') }}</b></div>
        <div class="oc-kv"><span>聚类模板</span><b>{{ d.groups.length }}</b></div>
        <div class="oc-kv"><span>数据来源</span><b>v$diag_alert_ext</b></div>
      </div>
      <div v-if="d.byHour.length" class="oc-spark" style="height: 54px">
        <i
          v-for="(h, k) in d.byHour"
          :key="k"
          :class="{ bad: h.errors > 0 }"
          :style="{ height: pct(h.count, maxHour) + '%' }"
          :title="`${h.hour} · ${h.count} 条（${h.errors} 条 ORA）`"
        ></i>
      </div>
      <div class="oc-note">
        告警日志一天可能几万条（连接失败、服务更新会刷屏），直接列明细没有意义 —— 这里先按「去掉数字后的模板」聚类，
        同一类问题只占一行，再看它首次/最后一次出现的时间。
      </div>
    </div>

    <div class="oc-card" data-src="orAlGroups" :data-ai="oraPickKey('alerts','groups')" data-ai-compact data-ai-name="告警聚类">
      <div class="oc-card-h"><span>聚类 TOP</span><span class="cnt">{{ d.groups.length }}</span><span class="sp"></span>
        <span class="oc-note">右侧是出现次数 / 首末时间</span>
      </div>
      <OraTable :columns="groupCols" :rows="groups" empty="这段时间没有告警日志" default-sort="count" />
    </div>

    <div v-if="d.ora.length" class="oc-card" data-src="orAlOra" :data-ai="oraPickKey('alerts','ora')" data-ai-compact data-ai-name="ORA- 错误">
      <div class="oc-card-h"><span style="color: var(--red)">ORA- 错误</span><span class="cnt">{{ d.ora.length }}</span></div>
      <OraTable :columns="oraCols" :rows="d.ora" searchable search-placeholder="过滤错误文本…" />
    </div>

    <div class="oc-card" data-src="orAlRecent" :data-ai="oraPickKey('alerts','recent')" data-ai-compact data-ai-name="最近日志">
      <div class="oc-card-h"><span>最近日志明细</span><span class="cnt">{{ d.recent.length }}</span><span class="sp"></span>
        <span class="oc-note">最多 200 条，按时间倒序</span>
      </div>
      <OraTable :columns="recentCols" :rows="d.recent" searchable search-placeholder="关键字过滤…" page-size="80" />
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { ora, oraData, loadOra } from '../../../cloud/oracle'

const d = computed(() => oraData('alerts'))
const WINDOWS = [
  { v: 1, label: '1 小时' },
  { v: 24, label: '24 小时' },
  { v: 72, label: '3 天' },
  { v: 168, label: '7 天' }
]
/** 布尔列在表格里直出会显示 true/false，这里先转成中文 */
const groups = computed(() => (d.value?.groups || []).map((g) => ({ ...g, isErrorText: g.isError ? '是' : '否' })))
const maxHour = computed(() => Math.max(1, ...(d.value?.byHour.map((h) => h.count) || [1])))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

function setHours(h: number): void {
  if (ora.alertHours === h) return
  ora.alertHours = h
  void loadOra('alerts', true, { hours: h })
}

const groupCols: OraCol[] = [
  { key: 'count', label: '次数', type: 'num', width: '80px' },
  { key: 'pattern', label: '日志模板', type: 'text' },
  { key: 'isErrorText', label: '含错误', width: '70px' },
  { key: 'firstTs', label: '首次', type: 'time', width: '110px' },
  { key: 'lastTs', label: '最近', type: 'time', width: '110px' }
]

const oraCols: OraCol[] = [
  { key: 'ts', label: '时间', type: 'mono', width: '140px' },
  { key: 'msg', label: '错误文本' }
]

const recentCols: OraCol[] = [
  { key: 'ts', label: '时间', type: 'mono', width: '140px' },
  { key: 'level', label: '级别', type: 'num', width: '60px' },
  { key: 'msg', label: '内容' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
.oc-tabs { display: flex; gap: 4px; }
.oc-tab {
  height: 22px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.oc-tab.on { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
</style>
