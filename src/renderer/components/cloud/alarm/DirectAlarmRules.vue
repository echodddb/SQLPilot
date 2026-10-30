<template>
  <div class="tp-pane" style="padding:0">
    <div class="tp-bar">
      <label class="lbl">集群</label>
      <select v-model="selPid" class="tp-select" :disabled="platforms.length <= 1">
        <option v-for="p in platforms" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <span class="sp"></span>
      <span class="tp-note">共 {{ rules.length }} 条内置规则 · 阈值为本机配置，仅影响 SQLPilot 的判定</span>
      <button class="tp-btn" :disabled="loading" @click="reload">刷新</button>
      <button class="tp-btn primary" :disabled="!dirty || busy" @click="save">{{ busy ? '保存中…' : '保存阈值' }}</button>
    </div>

    <div class="tp-warn">
      直连模式没有 OCP 的告警中心：这些规则由 SQLPilot 在每次刷新时按系统视图现算，
      <b>只反映「当前状态」，不保留历史事件</b>。条件不再满足时告警自动消失。
    </div>

    <div v-if="msg" class="tp-msg" :class="ok ? 'ok' : 'err'">{{ msg }}</div>

    <div class="tp-tbl-wrap">
      <table class="tp-tbl">
        <thead>
          <tr>
            <th>规则</th><th>级别</th><th>判定口径</th><th>数据来源</th><th>阈值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.key">
            <td>
              <div class="r-name">{{ r.name }}</div>
              <div class="r-sub tp-mono">{{ r.key }} · {{ r.scope }}</div>
              <div class="r-desc">{{ r.desc }}</div>
            </td>
            <td><span class="lv" :class="tone(r.level)">{{ levelLabel(r.level) }}</span></td>
            <td class="tp-dim wrap">{{ r.detect }}</td>
            <td class="tp-mono tp-dim">{{ r.source }}</td>
            <td>
              <div v-if="!r.thresholds.length" class="tp-faint">固定判定，无阈值</div>
              <div v-else class="thr">
                <label v-for="t in r.thresholds" :key="t.key" class="thr-item">
                  <span>{{ t.label }}</span>
                  <input
                    v-model.number="draft[t.key]"
                    class="tp-input num"
                    type="number"
                    :min="t.min"
                    :max="t.max"
                  />
                  <em>{{ t.unit }}</em>
                  <em class="range">{{ t.min }}~{{ t.max }}</em>
                </label>
              </div>
            </td>
          </tr>
          <tr v-if="!rules.length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : '没有可展示的规则' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="tp-note">
      改完点「保存阈值」写入本机 config.json，下一次刷新（或重新打开页面）即按新阈值判定。
      恢复默认值：把数值改回下表默认值后保存即可——
      <span class="tp-mono">{{ defaults }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 直连告警规则（可配阈值）。
 *
 * 与 OCP 的 AlarmRules 是两套东西：
 *   OCP  —— 规则存在 MetaDB，由 OCP 定时评估，SQLPilot 只读展示；
 *   直连 —— 规则内置在 SQLPilot，阈值存本机配置，每次刷新按系统视图现算。
 * 因此这里允许改阈值（不影响服务端），OCP 那边仍然只读。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { activePlatform, cloud } from '../../../cloud/state'
import { directAlarmRules, saveDirectAlarmThresholds } from '../../../cloud/directTenant'

const platforms = computed(() => cloud.platforms.filter((p) => p.type === 'obdirect'))
const selPid = ref('')
const pid = computed(() => {
  if (selPid.value) return selPid.value
  const a = activePlatform()
  if (a && a.type === 'obdirect') return a.id
  return platforms.value[0]?.id || ''
})

const rules = ref<CloudDirectAlarmRule[]>([])
const defs = ref<Record<string, number>>({})
const draft = reactive<Record<string, number>>({})
const loading = ref(false)
const busy = ref(false)
const msg = ref('')
const ok = ref(true)

/** 有改动才允许保存，避免用户误点把默认值写进配置 */
const dirty = computed(() => Object.keys(draft).some((k) => Number(draft[k]) !== Number(defs.value[k])))

/** 默认值提示：直接列出来，方便手工改回 */
const defaults = computed(() =>
  Object.entries(defs.value)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ')
)

const levelLabel = (lv: number): string => (lv === 1 ? '严重' : lv === 2 ? '警告' : '注意')
const tone = (lv: number): string => (lv === 1 ? 'bad' : lv === 2 ? 'warn' : 'info')

async function reload(): Promise<void> {
  if (!pid.value) return
  loading.value = true
  msg.value = ''
  try {
    const r = await directAlarmRules(pid.value)
    rules.value = r.rules
    // 阈值快照：既当初始值，也当「默认值」基准（后端返回的已是合并后的生效值）
    defs.value = { ...r.thresholds }
    for (const k of Object.keys(draft)) delete draft[k]
    Object.assign(draft, r.thresholds)
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!pid.value) return
  busy.value = true
  msg.value = ''
  try {
    const patch: Record<string, number> = {}
    for (const k of Object.keys(draft)) patch[k] = Number(draft[k])
    const r = await saveDirectAlarmThresholds(pid.value, patch)
    if (r.ok) {
      ok.value = true
      msg.value = '阈值已保存，下次刷新告警时生效'
      defs.value = { ...r.thresholds }
      Object.assign(draft, r.thresholds)
    } else {
      ok.value = false
      msg.value = r.error || '保存失败'
    }
  } finally {
    busy.value = false
  }
}

onMounted(() => { void reload() })
watch(pid, () => { void reload() })
</script>

<style scoped>
.lbl { font-size: 10.5px; color: var(--text-faint); }
.r-name { font-size: 12px; font-weight: 600; }
.r-sub { font-size: 10px; color: var(--text-faint); margin-top: 1px; }
.r-desc { font-size: 10.5px; color: var(--text-dim); margin-top: 3px; max-width: 360px; line-height: 1.55; white-space: normal; }
.lv { font-size: 10.5px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); }
.lv.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.lv.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); background: var(--yellow-dim); }
.lv.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.thr { display: flex; flex-direction: column; gap: 4px; }
.thr-item { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--text-dim); }
.thr-item em { font-style: normal; color: var(--text-faint); }
.thr-item .range { font-family: var(--mono); font-size: 9.5px; }
.num { width: 74px; padding: 3px 6px; font-family: var(--mono); font-size: 11px; }
.wrap { white-space: normal; max-width: 300px; line-height: 1.5; }
</style>
