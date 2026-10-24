<template>
  <div v-if="d" class="oc-wrap">
    <InfoKpis :kpis="d.kpis" :ai-key="(k) => oraPickKey('overview', k.src ? 'kpi.' + k.src : 'kpi')" />

    <div v-if="d.issues.length" class="oc-card" data-src="orOvIssues" :data-ai="oraPickKey('overview','issues')" data-ai-compact data-ai-name="需要关注">
      <div class="oc-card-h">
        <span>需要关注</span>
        <span class="cnt">{{ d.issues.length }}</span>
        <span class="sp"></span>
        <span class="oc-note">按本地规则从实时数据推导，不依赖任何平台告警服务</span>
      </div>
      <div class="oc-issues">
        <div v-for="(i, k) in d.issues" :key="k" class="oc-issue" :class="i.level">
          <span>{{ i.level === 'bad' ? '●' : i.level === 'warn' ? '▲' : 'ℹ' }}</span>
          <div>
            <b>{{ i.title }}</b>
            <p>{{ i.detail }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orOvInfo" :data-ai="oraPickKey('overview','info')" data-ai-compact data-ai-name="数据库信息">
        <div class="oc-card-h">
          <span>数据库</span>
          <span class="sp"></span>
          <span class="oc-note">{{ d.info.mode }} 模式</span>
        </div>
        <div class="oc-kvs">
          <div class="oc-kv"><span>DB Name</span><b>{{ d.info.dbName }}</b></div>
          <div class="oc-kv"><span>DB Unique</span><b>{{ d.info.dbUniqueName }}</b></div>
          <div class="oc-kv"><span>角色 / 打开模式</span><b>{{ d.info.databaseRole }} · {{ d.info.openMode }}</b></div>
          <div class="oc-kv"><span>日志模式</span><b>{{ d.info.logMode }}</b></div>
          <div class="oc-kv"><span>保护模式</span><b>{{ d.info.protectionMode }}</b></div>
          <div class="oc-kv"><span>版本</span><b :title="d.info.version">{{ d.info.version.replace('Oracle Database ', '') }}</b></div>
          <div class="oc-kv"><span>拓扑</span><b>{{ d.info.isRac ? 'RAC 集群' : '单实例' }}{{ d.info.isCdb ? ' · CDB' : '' }}</b></div>
          <div class="oc-kv"><span>创建时间</span><b>{{ d.info.created }}</b></div>
        </div>
      </div>

      <div class="oc-card" data-src="orOvInstSess" :data-ai="oraPickKey('overview','instances')" data-ai-compact data-ai-name="实例与会话">
        <div class="oc-card-h"><span>实例</span><span class="sp"></span><span class="oc-note">会话 / 活跃</span></div>
        <div class="oc-bars">
          <div v-for="i in d.instances" :key="i.name" class="oc-bar-row">
            <span :title="i.host">{{ i.name }} <em style="font-style: normal; color: var(--text-faint)">{{ i.host }}</em></span>
            <i><b :style="{ width: pct(i.sessions, maxSess) + '%' }"></b></i>
            <em>{{ i.sessions }} / {{ i.active }}</em>
          </div>
        </div>
        <div class="oc-note">每行：实例名 · 主机 · 用户会话数 / 活跃会话数</div>
      </div>
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orOvTs" :data-ai="oraPickKey('overview','ts')" data-ai-compact data-ai-name="表空间水位">
        <div class="oc-card-h"><span>表空间水位</span><span class="sp"></span><span class="oc-note">≥85% 黄色 · ≥90% 红色</span></div>
        <div v-if="!d.tablespaces.length" class="oc-note">没有可用数据</div>
        <div v-else class="oc-bars">
          <div v-for="t in d.tablespaces.slice(0, 10)" :key="t.name" class="oc-bar-row">
            <span :title="t.name">{{ t.name }}</span>
            <i><b :class="t.usedPct >= 90 ? 'bad' : t.usedPct >= 85 ? 'warn' : ''" :style="{ width: Math.min(100, t.usedPct) + '%' }"></b></i>
            <em>{{ t.usedPct.toFixed(1) }}%</em>
          </div>
        </div>
      </div>

      <div class="oc-card" data-src="orOvWait" :data-ai="oraPickKey('overview','waits')" data-ai-compact data-ai-name="累计等待 TOP">
        <div class="oc-card-h"><span>累计等待 TOP</span><span class="sp"></span><span class="oc-note">实例启动以来</span></div>
        <div v-if="!d.waits.length" class="oc-note">没有非空闲等待</div>
        <div v-else class="oc-bars">
          <div v-for="w in d.waits" :key="w.event" class="oc-bar-row">
            <span :title="w.event">{{ w.event }}</span>
            <i><b :style="{ width: pct(w.timeS, maxWait) + '%' }"></b></i>
            <em>{{ fmtSec(w.timeS) }}</em>
          </div>
        </div>
      </div>

      <div class="oc-card" data-src="orOvAlertHour" :data-ai="oraPickKey('overview','alerts')" data-ai-compact data-ai-name="近 12 小时告警条目">
        <div class="oc-card-h"><span>近 12 小时告警条目</span><span class="sp"></span><span class="oc-note">v$diag_alert_ext</span></div>
        <div v-if="!d.alertHours.length" class="oc-note">这段时间没有告警日志</div>
        <template v-else>
          <div class="oc-spark">
            <i v-for="(h, k) in d.alertHours" :key="k" :style="{ height: pct(h.count, maxAlert) + '%' }" :title="`${h.hour} · ${h.count} 条`"></i>
          </div>
          <div class="oc-note">
            {{ d.alertHours[0]?.hour }} → {{ d.alertHours[d.alertHours.length - 1]?.hour }}，共
            {{ d.alertHours.reduce((a, b) => a + b.count, 0) }} 条；告警日志动辄上万条，到「告警日志」看聚类与 ORA 错误
          </div>
        </template>
      </div>
    </div>

    <div class="oc-card" data-src="orOvMetrics" :data-ai="oraPickKey('overview','metrics')" data-ai-compact data-ai-name="实时指标">
      <div class="oc-card-h"><span>实时指标</span><span class="sp"></span><span class="oc-note">v$sysmetric 60 秒</span></div>
      <div class="oc-kvs">
        <div v-for="m in d.metrics" :key="m.name" class="oc-kv">
          <span>{{ m.name }}</span>
          <b>{{ m.value.toFixed(2) }} <em style="font-style: normal; color: var(--text-faint)">{{ m.unit }}</em></b>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import InfoKpis from '../../db/InfoKpis.vue'
import { oraData } from '../../../cloud/oracle'

const d = computed(() => oraData('overview'))
const maxSess = computed(() => Math.max(1, ...(d.value?.instances.map((i) => i.sessions) || [1])))
const maxWait = computed(() => Math.max(1, ...(d.value?.waits.map((w) => w.timeS) || [1])))
const maxAlert = computed(() => Math.max(1, ...(d.value?.alertHours.map((h) => h.count) || [1])))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

function fmtSec(s: number): string {
  if (s >= 3600) return `${(s / 3600).toFixed(1)}h`
  if (s >= 60) return `${(s / 60).toFixed(0)}m`
  return `${s.toFixed(0)}s`
}
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
