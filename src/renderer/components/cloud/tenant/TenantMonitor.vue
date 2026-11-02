<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">租户监控 <span class="cnt">{{ d.tenant.name }}</span></h4>
      <span class="sp"></span>
      <div class="ranges">
        <button v-for="r in RANGES" :key="r.key" class="rng" :class="{ on: rangeSec === r.seconds }" @click="setRange(r.seconds)">{{ r.label }}</button>
      </div>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>

    <div class="tp-bar" style="flex-wrap:wrap">
      <span class="tp-note">指标</span>
      <button v-for="m in defs" :key="m.key" class="mchip" :class="{ on: metrics.includes(m.key) }" @click="toggle(m.key)">{{ m.label }}</button>
      <span v-if="updatedAt" class="tp-note" style="margin-left:auto">更新于 {{ updatedAt }}</span>
    </div>

    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="warnings.length" class="tp-warn">部分指标未取到：{{ warnings.join('；') }}</div>

    <div v-if="!series.length" class="tp-empty">{{ loading ? '读取中…' : '该时间窗内没有监控数据（OCP 的 metrics 需要至少一个采集周期）' }}</div>
    <div v-else class="grid">
      <LineChart v-for="s in series" :key="s.key" :series="s" :from="from" :to="to" />
    </div>

    <div class="tp-note">
      走 OCP 的 /api/v2/monitor/metricGroups 指标族，scope=TENANT、labels=<code class="tp-mono">tenant_name:{{ d.tenant.name }}</code>。
      与「监控」一级页的租户维度同源，这里固定成本租户，省得来回切。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 租户监控：固定 tenant_name 的指标曲线（QPS/TPS/会话/MemStore/RT/命中率） */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import LineChart from '../LineChart.vue'
import { cloud } from '../../../cloud/state'
import { METRIC_SETS, RANGES } from '../../../cloud/metrics'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const defs = computed(() => METRIC_SETS.TENANT)
const metrics = ref<string[]>(METRIC_SETS.TENANT.slice(0, 4).map((x) => x.key))
const rangeSec = ref(3600)
const series = ref<{ key: string; label: string; unit: string; points: { t: number; v: number | null }[]; min: number | null; max: number | null; avg: number | null; last: number | null }[]>([])
const warnings = ref<string[]>([])
const loading = ref(false)
const err = ref('')
const to = ref(Date.now())
const from = ref(Date.now() - 3600_000)
const updatedAt = ref('')

let seq = 0

async function load(): Promise<void> {
  const my = ++seq
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const list = METRIC_SETS.TENANT.filter((m) => metrics.value.includes(m.key))
    if (!list.length) { series.value = []; return }
    const now = Date.now()
    const r = await window.sqlpilot.cloudMetrics(cloud.activeId, {
      scope: 'TENANT',
      metrics: list,
      labels: `tenant_name:${t.name}`,
      groupBy: 'tenant_name',
      from: now - rangeSec.value * 1000,
      to: now,
      maxPoints: 120
    })
    if (my !== seq) return
    if (!r.ok || !r.data) { err.value = r.error || '获取监控数据失败'; series.value = []; return }
    series.value = r.data.series
    warnings.value = r.data.warnings || []
    to.value = now
    from.value = now - rangeSec.value * 1000
    updatedAt.value = new Date(now).toLocaleTimeString('zh-CN', { hour12: false })
  } finally {
    if (my === seq) loading.value = false
  }
}

function toggle(key: string): void {
  metrics.value = metrics.value.includes(key) ? metrics.value.filter((k) => k !== key) : [...metrics.value, key]
  void load()
}

function setRange(sec: number): void {
  rangeSec.value = sec
  void load()
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void load()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !loading.value) void load()
  }, 30000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.reloadToken, load)
</script>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 9px; }
.ranges { display: flex; gap: 3px; }
.rng { border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 99px; padding: 2px 9px; font-size: 11px; font-family: inherit; cursor: pointer; }
.rng.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.mchip { border: 1px solid var(--border); background: var(--bg-card); color: var(--text-faint); border-radius: 99px; padding: 2px 10px; font-size: 11px; font-family: inherit; cursor: pointer; }
.mchip:hover { color: var(--text); }
.mchip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
</style>
