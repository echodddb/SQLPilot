<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">合并状态</h4>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
      <button class="tp-btn" :disabled="busy || !canTrigger" title="立即触发一次 major freeze" @click="act('trigger')">触发合并</button>
      <button class="tp-btn" :disabled="busy || !st || st.suspend" @click="act('suspend')">挂起</button>
      <button class="tp-btn" :disabled="busy || !st || !st.suspend" @click="act('resume')">恢复</button>
      <button class="tp-btn" :disabled="busy || !st?.error" @click="act('clearError')">清除错误</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-for="(e, i) in bundle?.errors || []" :key="i" class="tp-warn">{{ e }}</div>
    <div v-if="msg" class="tp-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

    <div class="tp-cards" data-src="tnCompaction" :data-tenant="d.tenant.name">
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">当前状态</span>
        <div style="font-size:18px;font-weight:600" :style="st?.error ? 'color:var(--red)' : ''">{{ st?.status || '—' }}</div>
        <span class="tp-note">
          {{ st?.suspend ? '已挂起（不会自动合并）' : st?.error ? '合并出错' : '按每日合并时间点自动执行' }}
        </span>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">上次完成</span>
        <div style="font-size:13px;font-weight:550">{{ st?.lastFinishTime ? fmtTime(st.lastFinishTime) : '—' }}</div>
        <span class="tp-note">本轮开始 {{ st?.startTime ? fmtTime(st.startTime) : '—' }}</span>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">冻结版本号</span>
        <div class="tp-mono" style="font-size:12px">{{ st?.frozenScn || '—' }}</div>
        <span class="tp-note">broadcast {{ st?.broadcastScn || '—' }}</span>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">每日合并时间</span>
        <div style="font-size:18px;font-weight:600">{{ settings?.majorFreezeDutyTime || '—' }}</div>
        <span class="tp-note">冻结触发阈值 {{ settings?.freezeTriggerPercentage ?? '—' }}%</span>
      </div>
    </div>
    <div v-if="st?.errorInfo" class="tp-err">合并错误：{{ st.errorInfo }}</div>

    <!-- 设置 -->
    <h4 class="tp-h">合并设置</h4>
    <div class="tp-card">
      <div class="grid">
        <label class="frow">每日合并时间（HH:mm）
          <input v-model="form.majorFreezeDutyTime" class="tp-input tp-mono" placeholder="02:00" />
        </label>
        <label class="frow">冻结触发阈值（%）
          <input v-model.number="form.freezeTriggerPercentage" type="number" min="0" max="100" class="tp-input" />
        </label>
        <label class="frow">转储触发（0=默认）
          <input v-model.number="form.minorCompactTrigger" type="number" min="0" class="tp-input" />
        </label>
        <label class="frow">合并触发（0=默认）
          <input v-model.number="form.majorCompactTrigger" type="number" min="0" class="tp-input" />
        </label>
      </div>
      <div class="tp-bar">
        <span class="tp-note">只提交改动过的字段（PATCH）；改完立即对租户生效，不需要重启。</span>
        <span class="sp"></span>
        <button class="tp-btn" :disabled="busy" @click="resetForm">还原</button>
        <button class="tp-btn primary" :disabled="busy || !dirty" @click="saveSettings">{{ dirty ? '保存设置' : '无改动' }}</button>
      </div>
    </div>

    <!-- 主合并历史 -->
    <h4 class="tp-h">合并历史 <span class="cnt">{{ bundle?.majors.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:32vh">
      <table class="tp-tbl">
        <thead><tr><th>开始</th><th>结束</th><th class="r">耗时</th><th>结果</th><th>触发原因</th><th>错误</th></tr></thead>
        <tbody>
          <tr v-for="(m, i) in bundle?.majors || []" :key="i">
            <td class="tp-dim">{{ fmtTime(m.startTime) }}</td>
            <td class="tp-dim">{{ fmtTime(m.endTime) }}</td>
            <td class="r tp-mono">{{ span(m.startTime, m.endTime) }}</td>
            <td><span class="tp-chip" :style="/SUCCESS/i.test(m.result) ? 'color:var(--green);border-color:var(--green)' : /FAIL/i.test(m.result) ? 'color:var(--red);border-color:var(--red)' : ''">{{ m.result || '—' }}</span></td>
            <td class="tp-dim">{{ m.reason || '—' }}</td>
            <td class="tp-dim ell" :title="m.errorInfo">{{ m.errorInfo || '—' }}</td>
          </tr>
          <tr v-if="!(bundle?.majors || []).length"><td colspan="6" class="tp-empty">{{ loading ? '读取中…' : '近 72 小时没有合并记录' }}</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 转储历史 -->
    <h4 class="tp-h">转储（Mini Compaction） <span class="cnt">{{ bundle?.minors.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:28vh">
      <table class="tp-tbl">
        <thead><tr><th>开始</th><th>结束</th><th class="r">行数</th><th class="r">数据量</th></tr></thead>
        <tbody>
          <tr v-for="(m, i) in bundle?.minors || []" :key="i">
            <td class="tp-dim">{{ fmtTime(m.startTime) }}</td>
            <td class="tp-dim">{{ fmtTime(m.endTime) }}</td>
            <td class="r tp-mono">{{ m.totalRows.toLocaleString() }}</td>
            <td class="r tp-mono">{{ fmtBytes(m.dataSize) }}</td>
          </tr>
          <tr v-if="!(bundle?.minors || []).length"><td colspan="4" class="tp-empty">{{ loading ? '读取中…' : '近 12 小时没有转储记录' }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 合并（Compaction）：状态 + 每日合并设置 + 主合并/转储历史 + 触发/挂起/恢复/清错。
 * 触发合并时若租户已在 COMPACTING，OCP 返回 500「不允许当前操作」，这里原样提示。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtBytes, fmtTime } from '../../../cloud/parts'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const bundle = ref<CloudTenantCompactionBundle | null>(null)
const loading = ref(false)
const busy = ref(false)
const err = ref('')
const msg = ref('')
const msgOk = ref(true)

const st = computed(() => bundle.value?.status || null)
const settings = computed(() => bundle.value?.settings || null)
const canTrigger = computed(() => !!st.value && !/COMPACTING/i.test(st.value.status))

const form = reactive<CloudTenantCompactionSettings>({
  freezeTriggerPercentage: 0,
  minorCompactTrigger: 0,
  majorCompactTrigger: 0,
  majorFreezeDutyTime: '',
  majorCompactionThreadScore: 0,
  miniCompactionThreadScore: 0
})

const dirty = computed(() => {
  const s = settings.value
  if (!s) return false
  return form.freezeTriggerPercentage !== s.freezeTriggerPercentage
    || form.minorCompactTrigger !== s.minorCompactTrigger
    || form.majorCompactTrigger !== s.majorCompactTrigger
    || form.majorFreezeDutyTime !== s.majorFreezeDutyTime
})

function resetForm(): void {
  const s = settings.value
  if (!s) return
  Object.assign(form, s)
}

function span(a: string, b: string): string {
  const t1 = Date.parse(a)
  const t2 = Date.parse(b)
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return '—'
  const ms = t2 - t1
  if (ms < 0) return '—'
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}min`
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantCompaction(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { err.value = r.error || '读取合并信息失败'; return }
    bundle.value = r.data || null
    resetForm()
  } finally {
    loading.value = false
  }
}

async function act(action: 'trigger' | 'suspend' | 'resume' | 'clearError'): Promise<void> {
  const t = d.value.tenant
  const label = { trigger: '触发合并', suspend: '挂起合并', resume: '恢复合并', clearError: '清除合并错误' }[action]
  if (action !== 'clearError') {
    const ok = await window.sqlpilot.uiConfirm(`${label}？`, action === 'trigger' ? '会立即冻结并开始一轮 major compaction，期间对写入有轻微影响。' : '该操作会改变租户的自动合并行为。')
    if (!ok) return
  }
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudTenantCompactionAction(cloud.activeId, t.clusterId, t.id, action)
    if (!r.ok) { msg.value = r.error || `${label}失败`; msgOk.value = false; return }
    pushNotice(`${label}成功`)
    msg.value = `${label}成功`
    msgOk.value = true
    await load()
  } finally {
    busy.value = false
  }
}

async function saveSettings(): Promise<void> {
  const s = settings.value
  if (!s) return
  const patch: Partial<CloudTenantCompactionSettings> = {}
  if (form.freezeTriggerPercentage !== s.freezeTriggerPercentage) patch.freezeTriggerPercentage = form.freezeTriggerPercentage
  if (form.minorCompactTrigger !== s.minorCompactTrigger) patch.minorCompactTrigger = form.minorCompactTrigger
  if (form.majorCompactTrigger !== s.majorCompactTrigger) patch.majorCompactTrigger = form.majorCompactTrigger
  if (form.majorFreezeDutyTime !== s.majorFreezeDutyTime) patch.majorFreezeDutyTime = form.majorFreezeDutyTime
  busy.value = true
  msg.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantUpdateCompactionSettings(cloud.activeId, t.clusterId, t.id, patch)
    if (!r.ok) { msg.value = r.error || '保存失败'; msgOk.value = false; return }
    pushNotice('合并设置已更新')
    msg.value = '合并设置已更新'
    msgOk.value = true
    await load()
  } finally {
    busy.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 9px; }
.frow { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-dim); }
</style>
