<template>
  <div class="mp">
    <div class="mp-head">
      <div class="seg">
        <button v-for="s in scopes" :key="s.key" class="seg-btn" :class="{ active: cloud.monitor.scope === s.key }" @click="setMonitorScope(s.key)">
          {{ s.label }}
        </button>
      </div>
      <select class="ent" :value="cloud.monitor.entityKey" @change="onEntity">
        <option v-for="e in entities" :key="e.key" :value="e.key">{{ e.label }}（{{ e.sub }}）</option>
      </select>
      <span class="spacer"></span>
      <div class="ranges">
        <button v-for="r in RANGES" :key="r.key" class="rng" :class="{ active: cloud.monitor.rangeSec === r.seconds }" @click="setMonitorRange(r.seconds)">
          {{ r.label }}
        </button>
      </div>
      <button class="tb" :disabled="cloud.monitor.loading" @click="reloadMonitor">
        <span :class="{ spin: cloud.monitor.loading }">⟳</span> 刷新
      </button>
    </div>

    <div class="mp-metrics" :data-src="monitorSrc">
      <span class="mlabel">指标</span>
      <button
        v-for="m in metricDefs"
        :key="m.key"
        class="mchip"
        :class="{ active: cloud.monitor.metrics.includes(m.key) }"
        @click="toggleMonitorMetric(m.key)"
      >{{ m.label }}</button>
      <span v-if="cloud.monitor.updatedAt" class="upd">更新于 {{ relTime(new Date(cloud.monitor.updatedAt).toISOString()) }}</span>
    </div>

    <div v-if="cloud.monitor.error" class="mp-err">{{ cloud.monitor.error }}</div>
    <div v-if="cloud.monitor.warnings.length" class="mp-warn">
      <span>部分指标未取到：</span>{{ cloud.monitor.warnings.join('；') }}
    </div>

    <div v-if="!entities.length" class="mp-empty">
      当前维度下没有可选对象（{{ scopeLabel }}）；先到对应页面确认 OCP 里存在数据。
    </div>
    <div v-else class="mp-grid" :data-src="monitorSrc">
      <LineChart
        v-for="s in cloud.monitor.series"
        :key="s.key"
        :series="s"
        :from="rangeFrom"
        :to="rangeTo"
        :data-ai="`monitor.${String(cloud.monitor.scope).toLowerCase()}:${s.key}`"
        :data-ai-name="s.label"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/** 资源监控：维度切换（集群/租户/主机）+ 实体 + 时间范围 + 指标多选，图表为纯 SVG */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import LineChart from './LineChart.vue'
import {
  cloud,
  monitorEntities,
  reloadMonitor,
  setMonitorEntity,
  setMonitorRange,
  setMonitorScope,
  toggleMonitorMetric
} from '../../cloud/state'
import { METRIC_SETS, RANGES } from '../../cloud/metrics'
import { relTime } from '../../cloud/parts'

const scopes = [
  { key: 'CLUSTER', label: '集群' },
  { key: 'TENANT', label: '租户' },
  { key: 'HOST', label: '主机' }
] as const

const entities = computed(() => monitorEntities(cloud.monitor.scope))
const metricDefs = computed(() => METRIC_SETS[cloud.monitor.scope])
const scopeLabel = computed(() => scopes.find((s) => s.key === cloud.monitor.scope)?.label || '')
/** 指标区与图表区共用同一份来源说明，按当前维度切换 key */
const monitorSrc = computed(() =>
  cloud.monitor.scope === 'TENANT' ? 'moTenant' : cloud.monitor.scope === 'HOST' ? 'moHost' : 'moCluster'
)
const rangeTo = computed(() => cloud.monitor.updatedAt || Date.now())
const rangeFrom = computed(() => rangeTo.value - cloud.monitor.rangeSec * 1000)

function onEntity(e: Event): void {
  void setMonitorEntity((e.target as HTMLSelectElement).value)
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void reloadMonitor()
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !cloud.monitor.loading) void reloadMonitor()
  }, 30000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.mp { display: flex; flex-direction: column; gap: 10px; }
.mp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg { display: flex; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
.seg-btn {
  border: none; background: none; color: var(--text-dim); font-family: inherit; font-size: 11.5px;
  padding: 3px 11px; border-radius: 6px; cursor: pointer;
}
.seg-btn.active { background: var(--accent-dim); color: var(--accent); }
.ent {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  font-family: inherit; font-size: 12px; padding: 4px 8px; min-width: 210px; outline: none;
}
.spacer { flex: 1; }
.ranges { display: flex; gap: 3px; }
.rng {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 99px; padding: 2px 9px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.rng.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.tb {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.tb:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.spin { display: inline-block; animation: rot 1s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }

.mp-metrics { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.mlabel { font-size: 10.5px; color: var(--text-faint); margin-right: 2px; }
.mchip {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-faint);
  border-radius: 99px; padding: 2px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.mchip:hover { color: var(--text); border-color: var(--border-strong); }
.mchip.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.upd { margin-left: auto; font-size: 10.5px; color: var(--text-faint); }

.mp-err { font-size: 11.5px; color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); border-radius: 8px; padding: 7px 10px; }
.mp-warn { font-size: 11px; color: var(--yellow); background: var(--yellow-dim); border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent); border-radius: 8px; padding: 6px 10px; }
.mp-empty { padding: 40px; text-align: center; color: var(--text-faint); font-size: 12.5px; border: 1px dashed var(--border); border-radius: 11px; }
.mp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 9px; }
</style>
