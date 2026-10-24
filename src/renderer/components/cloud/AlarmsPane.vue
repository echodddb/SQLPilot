<template>
  <div class="tp-pane" style="padding:0">
    <!-- 一级 tab：告警事件 / 告警规则 -->
    <div class="ap-head">
      <div class="subtabs">
        <button class="subtab" :class="{ on: cloud.alarmSubTab === 'event' }" @click="setAlarmSubTab('event')">告警事件</button>
        <button class="subtab" :class="{ on: cloud.alarmSubTab === 'rule' }" @click="setAlarmSubTab('rule')">告警规则</button>
      </div>
      <span class="sp"></span>
      <span v-if="cloud.updatedAt" class="tp-note">最近刷新 {{ relTime(new Date(cloud.updatedAt).toISOString()) }}</span>
      <button v-if="cloud.alarmSubTab === 'event'" class="tp-btn" :disabled="!rows.length" title="把当前筛选结果导出为 CSV" @click="exportRows">导出 CSV</button>
      <button class="tp-btn" :disabled="cloud.loading" @click="refresh">{{ cloud.loading ? '读取中…' : '刷新' }}</button>
    </div>

    <AlarmRules v-if="cloud.alarmSubTab === 'rule'" data-ai="alarms.rules" />

    <template v-else>
      <!-- 分级统计 + 近 24h 趋势 -->
      <div class="ap-stats">
        <div class="stat" :class="{ bad: cloud.alarmLevel === 1 }" data-ai="alarms.levels:1" data-ai-name="严重告警" @click="toggleLevel(1)">
          <span>严重</span><b>{{ levelCount(1) }}</b>
        </div>
        <div class="stat" :class="{ warn: cloud.alarmLevel === 2 }" data-ai="alarms.levels:2" data-ai-name="警告告警" @click="toggleLevel(2)">
          <span>警告</span><b>{{ levelCount(2) }}</b>
        </div>
        <div class="stat" :class="{ info: cloud.alarmLevel === 3 }" data-ai="alarms.levels:3" data-ai-name="注意告警" @click="toggleLevel(3)">
          <span>注意</span><b>{{ levelCount(3) }}</b>
        </div>
        <div class="stat total" :class="{ on: cloud.alarmLevel === 0 }" data-ai="alarms.levels:0" data-ai-name="活跃合计" @click="toggleLevel(0)">
          <span>活跃合计</span><b>{{ levelCount(0) }}</b>
        </div>

        <div
          class="trend"
          data-ai="alarms.trend"
          data-src="alarmTrend"
          :data-detail="trendDetail"
          :title="`近 ${cloud.alarmTrendHours} 小时已恢复告警 ${trend?.total ?? 0} 条`"
        >
          <div class="tr-head">
            <span>近 {{ cloud.alarmTrendHours }} 小时已恢复告警</span>
            <b class="mono">{{ trend?.total ?? '—' }}</b>
            <span v-if="trend?.truncated" class="tp-note">（仅统计最近 {{ trend.scanned }} 条）</span>
          </div>
          <div class="tr-bars">
            <i
              v-for="(b, i) in trend?.buckets || []"
              :key="i"
              class="bar"
              :style="{ height: barHeight(b.total) }"
              :class="{ lv1: b.levels['1'], lv2: !b.levels['1'] && b.levels['2'] }"
              :title="`${hourLabel(b.at)} · ${b.total} 条（严重 ${b.levels['1']} / 警告 ${b.levels['2']} / 注意 ${b.levels['3']}）`"
            />
          </div>
        </div>
      </div>

      <!-- 筛选 -->
      <div class="tp-bar">
        <select class="tp-select" :value="cloud.alarmAppType" @change="onAppType">
          <option value="">全部应用</option>
          <option v-for="a in appTypes" :key="a" :value="a">{{ a }}</option>
        </select>
        <select class="tp-select" :value="cloud.alarmScope" @change="onScope">
          <option value="">全部对象类型</option>
          <option v-for="s in scopeOptions" :key="s" :value="s">{{ alarmScope(s) }}</option>
        </select>
        <select class="tp-select" :value="cloud.alarmHistory.hours" @change="onHours">
          <option :value="0">不限时间</option>
          <option :value="1">近 1 小时</option>
          <option :value="6">近 6 小时</option>
          <option :value="24">近 24 小时</option>
          <option :value="72">近 3 天</option>
          <option :value="168">近 7 天</option>
          <option :value="720">近 30 天</option>
        </select>
        <input
          :value="cloud.alarmKeyword"
          class="tp-input tp-search"
          placeholder="关键词：告警名 / 对象 / 规则标识，回车搜索"
          spellcheck="false"
          @input="kwDraft = ($event.target as HTMLInputElement).value"
          @keyup.enter="applyKeyword"
        />
        <span v-if="cloud.alarmType" class="tp-chip on">
          规则：{{ cloud.alarmType }}
          <button class="chip-x" title="清除类型筛选" @click="clearType">✕</button>
        </span>
        <button class="tp-btn ghost" @click="resetAlarmFilters">重置</button>
        <span class="sp"></span>
      </div>

      <!-- 活跃 / 历史 -->
      <div class="subtabs" style="padding-left:2px">
        <button class="subtab" :class="{ on: cloud.alarmTab === 'active' }" @click="setAlarmTab('active')">
          活跃告警 <span class="cnt">{{ cloud.alarmTotal }}</span>
        </button>
        <button class="subtab" :class="{ on: cloud.alarmTab === 'history' }" @click="setAlarmTab('history')">
          历史告警 <span class="cnt">{{ cloud.alarmHistory.total }}</span>
        </button>
      </div>

      <div v-if="cloud.error" class="tp-err">{{ cloud.error }}</div>

      <div
        class="tp-tbl-wrap tp-scroll-y"
        data-ai="alarms.active"
        data-src="alarmList"
        :data-detail="`${cloud.alarmTab === 'active' ? '活跃' : '历史'}告警 ${rows.length} 条（总计 ${cloud.alarmTab === 'active' ? cloud.alarmTotal : cloud.alarmHistory.total}）|级别：${levelLabel(cloud.alarmLevel)} · 对象：${cloud.alarmScope ? alarmScope(cloud.alarmScope) : '全部'} · 应用：${cloud.alarmAppType || '全部'}`"
      >
        <table class="tp-tbl">
          <thead>
            <tr>
              <th>告警说明</th>
              <th class="sortable" @click="toggleSort('time')">产生时间<span class="sort">{{ sortIcon('time') }}</span></th>
              <th class="sortable" @click="toggleSort('type')">分类<span class="sort">{{ sortIcon('type') }}</span></th>
              <th class="sortable" @click="toggleSort('level')">等级<span class="sort">{{ sortIcon('level') }}</span></th>
              <th>告警状态</th>
              <th>消息推送</th>
              <th class="r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in sortedRows" :key="a.id" class="clickable" @click="openAlarm(a)">
              <td>
                <div class="alm-name" data-src="alarmHead" :data-detail="`${a.name}|ID ${a.id} · ${alarmScope(a.scope)}：${a.targetInfo.names.join('、') || '—'}`">{{ a.name }}</div>
                <div class="alm-sub">
                  ID: {{ a.id }}
                  <template v-if="a.targetInfo.names.length"> · {{ alarmScope(a.scope) }}: {{ a.targetInfo.names.join('、') }}</template>
                  <template v-else-if="a.scope"> · {{ alarmScope(a.scope) }}</template>
                  <template v-if="a.targetInfo.clusterName || a.obCluster"> · 集群 {{ a.obCluster || a.targetInfo.clusterName }}</template>
                </div>
              </td>
              <td class="tp-dim">{{ fmtTime(a.activeAt) }}</td>
              <td class="tp-dim">
                <button v-if="a.alarmType" class="link-cell" :title="`只看规则 ${a.alarmType}`" @click.stop="drillType(a.alarmType)">
                  {{ (a.groups || []).join(' / ') || '—' }}
                </button>
                <span v-else>—</span>
              </td>
              <td><span class="lv" :class="alarmLevel(a.level).tone">{{ alarmLevel(a.level).label }}</span></td>
              <td>
                <span class="alm-st" :class="cloud.alarmTab === 'active' ? 'on' : 'off'">
                  <i class="dot"></i>{{ cloud.alarmTab === 'active' ? `告警中 · ${duration(a.activeAt)}` : `已恢复 · 持续 ${duration(a.activeAt, a.resolvedAt || a.updatedAt)}` }}
                </span>
              </td>
              <td class="tp-dim" :class="{ warn: a.push.configured && a.push.noSuccessCount > 0 }">
                {{ !a.push.configured ? '未配置推送' : a.push.noSuccessCount ? `失败 ${a.push.noSuccessCount} / 成功 ${a.push.successCount}` : `已推送 ${a.push.successCount}` }}
              </td>
              <td class="r" @click.stop>
                <button class="tp-btn sm" @click="openAlarm(a)">详情</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="7" class="tp-empty">
                {{ cloud.loading ? '读取中…' : cloud.alarmTab === 'active' ? '当前筛选下没有活跃告警' : '当前筛选下没有历史告警' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="cloud.alarmTab === 'history'" class="pager">
        <span class="tp-note">共 {{ cloud.alarmHistory.total }} 条</span>
        <span class="sp"></span>
        <button class="tp-btn sm" :disabled="cloud.alarmHistory.page <= 1 || cloud.loading" @click="setAlarmPage(cloud.alarmHistory.page - 1)">上一页</button>
        <span class="tp-mono tp-dim" style="font-size:11px">{{ cloud.alarmHistory.page }} / {{ maxPage }}</span>
        <button class="tp-btn sm" :disabled="cloud.alarmHistory.page >= maxPage || cloud.loading" @click="setAlarmPage(cloud.alarmHistory.page + 1)">下一页</button>
      </div>

      <AlarmDetail v-if="cloud.alarmDetail" />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 告警中心（对标 OCP「告警中心 / 告警事件」）：
 * 一级 tab = 告警事件 / 告警规则；事件页有分级统计 + 近 24h 趋势、应用/对象类型/等级/关键词/时间筛选、
 * 排序、CSV 导出、详情抽屉（对象跳转 + 指标 + 标签 + 同类型统计）。
 * 数据：GET /alarm/alarms/actived|history、/alarm/alarms/{id}、/alarm/overview/active、/alarm/rules。
 */
import { computed, onMounted, ref } from 'vue'
import {
  cloud, load, ensureRefData, setAlarmTab, setAlarmLevel, setAlarmScope, setAlarmKeyword, setAlarmPage,
  setAlarmHours, setAlarmAppType, setAlarmType, resetAlarmFilters, setAlarmSubTab, openAlarm, exportCsv
} from '../../cloud/state'
import { alarmLevel, alarmScope, duration, fmtTime, relTime } from '../../cloud/parts'
import { pushNotice } from '../../store'
import AlarmDetail from './alarm/AlarmDetail.vue'
import AlarmRules from './alarm/AlarmRules.vue'

const LEVEL_TABS = [
  { level: 0, label: '全部', tone: 'idle' },
  { level: 1, label: '严重', tone: 'bad' },
  { level: 2, label: '警告', tone: 'warn' },
  { level: 3, label: '注意', tone: 'info' }
]

const kwDraft = ref(cloud.alarmKeyword)
const sortKey = ref<'time' | 'level' | 'type'>('time')
const sortAsc = ref(false)

const rows = computed(() => (cloud.alarmTab === 'active' ? cloud.alarms : cloud.alarmHistory.items))
const maxPage = computed(() => Math.max(1, Math.ceil(cloud.alarmHistory.total / Math.max(1, cloud.alarmHistory.size))))
const trend = computed(() => cloud.alarmTrend)

const sortedRows = computed(() => {
  const out = [...rows.value]
  const dir = sortAsc.value ? 1 : -1
  if (sortKey.value === 'time') out.sort((a, b) => dir * a.activeAt.localeCompare(b.activeAt))
  else if (sortKey.value === 'level') out.sort((a, b) => dir * (a.level - b.level) || b.activeAt.localeCompare(a.activeAt))
  else out.sort((a, b) => dir * (a.groups.join('')).localeCompare(b.groups.join('')) || b.activeAt.localeCompare(a.activeAt))
  return out
})

const appTypes = computed(() => {
  const set = new Set<string>()
  for (const a of cloud.alarms) if (a.appType) set.add(a.appType)
  for (const x of trend.value?.appTypes || []) if (x.key) set.add(x.key)
  return [...set]
})
const scopeOptions = computed(() => {
  const set = new Set(['Host', 'Cluster', 'Tenant', 'Service', 'OBProxyCluster', 'OCP'])
  for (const x of trend.value?.scopes || []) if (x.key) set.add(x.key)
  for (const a of cloud.alarms) if (a.scope) set.add(a.scope)
  return [...set]
})

const trendDetail = computed(() => {
  const t = trend.value
  if (!t) return '趋势数据未加载'
  const top = t.types.slice(0, 3).map((x) => `${x.name} ${x.count} 条`).join('；')
  return [
    `近 ${t.hours} 小时已恢复 ${t.total} 条（统计 ${t.scanned} 条${t.truncated ? '，已截断' : ''}）`,
    `严重 ${t.levels['1']} / 警告 ${t.levels['2']} / 注意 ${t.levels['3']}`,
    `对象类型：${t.scopes.map((s) => alarmScope(s.key) + s.count).join('、')}`,
    top ? `Top 告警：${top}` : ''
  ].filter(Boolean).join('|')
})

const maxBar = computed(() => Math.max(1, ...(trend.value?.buckets || []).map((b) => b.total)))

function barHeight(n: number): string {
  const pct = Math.round((n / maxBar.value) * 100)
  return `${Math.max(n ? 6 : 2, pct)}%`
}
function hourLabel(at: string): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`
}

function levelCount(level: number): number {
  if (level === 0) return cloud.alarmLevelCounts.reduce((s, x) => s + x.count, 0) || cloud.alarmTotal
  const hit = cloud.alarmLevelCounts.find((x) => x.level === level)
  return hit ? hit.count : cloud.alarms.filter((a) => a.level === level).length
}
/** 点已选中的等级卡片 = 取消该筛选（回到全部） */
function toggleLevel(level: number): void {
  void setAlarmLevel(cloud.alarmLevel === level && level !== 0 ? 0 : level)
}
function levelLabel(level: number): string {
  return LEVEL_TABS.find((t) => t.level === level)?.label || '全部'
}

function onAppType(e: Event): void {
  void setAlarmAppType((e.target as HTMLSelectElement).value)
}
function onScope(e: Event): void {
  void setAlarmScope((e.target as HTMLSelectElement).value)
}
function onHours(e: Event): void {
  void setAlarmHours(Number((e.target as HTMLSelectElement).value) || 0)
}
function applyKeyword(): void {
  void setAlarmKeyword(kwDraft.value)
}
function clearType(): void {
  void setAlarmType('')
}
function drillType(t: string): void {
  if (cloud.alarmType === t) return
  void setAlarmType(t)
}
function refresh(): void {
  void load()
}
function toggleSort(k: 'time' | 'level' | 'type'): void {
  if (sortKey.value === k) sortAsc.value = !sortAsc.value
  else { sortKey.value = k; sortAsc.value = false }
}
function sortIcon(k: string): string {
  if (sortKey.value !== k) return '⇅'
  return sortAsc.value ? '↑' : '↓'
}

/** 导出当前筛选结果（与列表同序），列文案对齐 OCP 的「导出告警事件」 */
async function exportRows(): Promise<void> {
  const cols = ['告警ID', '告警说明', '告警等级', '对象类型', '告警对象', '关联集群', '告警分类', '产生时间', '恢复时间', '状态', '规则标识']
  const data = sortedRows.value.map((a) => [
    a.id,
    a.name,
    alarmLevel(a.level).label,
    alarmScope(a.scope),
    a.targetInfo.names.join('、'),
    a.obCluster || a.targetInfo.clusterName,
    (a.groups || []).join(' / '),
    a.activeAt,
    a.resolvedAt || a.updatedAt,
    a.status === 'Active' ? '告警中' : '已恢复',
    a.alarmType
  ])
  const r = await exportCsv(cloud.alarmTab === 'active' ? '活跃告警' : '历史告警', cols, data)
  if (r.ok) pushNotice(`已导出 ${data.length} 条告警：${r.path}`)
  else if (!r.canceled) pushNotice(r.error || '导出失败')
}

onMounted(() => {
  // 详情抽屉的「定位对象」需要集群/租户/主机列表，进告警页时补一次
  void ensureRefData()
})
</script>

<style scoped>
.ap-head { display: flex; align-items: center; gap: 8px; }
.ap-head .sp { flex: 1; }
.subtabs { display: flex; gap: 2px; }
.subtab {
  display: inline-flex; align-items: center; gap: 6px; border: none; background: none; color: var(--text-faint);
  font-family: inherit; font-size: 12.5px; padding: 4px 9px; border-radius: 7px; cursor: pointer;
}
.subtab:hover { color: var(--text); }
.subtab.on { background: var(--accent-dim); color: var(--accent); }
.subtab .cnt {
  font-family: var(--mono); font-size: 10px; padding: 0 5px; border-radius: 99px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
}
.subtab.on .cnt { color: var(--accent); border-color: var(--accent); }

.ap-stats { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
.stat {
  min-width: 96px; border: 1px solid var(--border); border-radius: 9px; padding: 7px 11px;
  background: var(--bg-input); cursor: pointer; display: flex; flex-direction: column; gap: 2px;
}
.stat span { font-size: 10.5px; color: var(--text-faint); }
.stat b { font-size: 19px; font-family: var(--mono); font-weight: 500; line-height: 1.1; }
.stat.bad b { color: var(--red); }
.stat.warn b { color: var(--yellow); }
.stat.info b { color: var(--accent); }
.stat:hover { border-color: var(--border-strong); }
.stat.bad { border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.stat.warn { border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.stat.info { border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-dim); }
.stat.total.on { border-color: var(--accent); }

.trend {
  flex: 1; min-width: 260px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-input);
  padding: 6px 10px 4px; display: flex; flex-direction: column; gap: 4px;
}
.tr-head { display: flex; align-items: baseline; gap: 6px; font-size: 10.5px; color: var(--text-faint); }
.tr-head b { font-size: 13px; color: var(--text); }
.tr-bars { display: flex; align-items: flex-end; gap: 2px; height: 34px; }
.tr-bars .bar {
  flex: 1; min-width: 2px; border-radius: 2px 2px 0 0; background: var(--accent); opacity: 0.55;
  transition: opacity 0.12s ease;
}
.tr-bars .bar:hover { opacity: 1; }
.tr-bars .bar.lv1 { background: var(--red); opacity: 0.8; }
.tr-bars .bar.lv2 { background: var(--yellow); opacity: 0.75; }

.lv-chips { display: flex; gap: 4px; }
.lv-chip {
  display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text-dim); border-radius: 99px; padding: 2px 9px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.lv-chip .n { font-family: var(--mono); font-size: 10px; opacity: 0.8; }
.lv-chip:hover { color: var(--text); }
.lv-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.lv-chip.bad.on { color: var(--red); border-color: var(--red); background: var(--red-dim); }
.lv-chip.warn.on { color: var(--yellow); border-color: var(--yellow); background: var(--yellow-dim); }

.alm-name { font-size: 12.5px; font-weight: 550; color: var(--accent); }
.alm-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; font-family: var(--mono); }
.alm-st { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.alm-st .dot { width: 6px; height: 6px; border-radius: 50%; }
.alm-st.on { color: var(--yellow); }
.alm-st.on .dot { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.alm-st.off { color: var(--text-faint); }
.alm-st.off .dot { background: var(--text-faint); }

.lv { font-size: 10.5px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); }
.lv.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.lv.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); background: var(--yellow-dim); }
.lv.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.lv.idle { color: var(--text-dim); }

th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
th.sortable:hover { color: var(--text); }
.sort { margin-left: 4px; font-size: 9px; opacity: 0.6; }
.link-cell { background: none; border: none; padding: 0; font: inherit; color: var(--text-dim); cursor: pointer; }
.link-cell:hover { color: var(--accent); text-decoration: underline; }
.chip-x { background: none; border: none; color: inherit; cursor: pointer; font-size: 9px; padding: 0 0 0 2px; opacity: 0.75; }
.chip-x:hover { opacity: 1; }
.tp-chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.pager { display: flex; align-items: center; gap: 7px; }
.pager .sp { flex: 1; }
</style>
