<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">事务 <span class="cnt">{{ rows.length }}</span></h4>
      <select v-model.number="threshold" class="tp-select" @change="load">
        <option :value="0">不限时长</option>
        <option :value="1000">持续 ≥ 1s</option>
        <option :value="5000">持续 ≥ 5s</option>
        <option :value="30000">持续 ≥ 30s</option>
        <option :value="60000">持续 ≥ 60s</option>
      </select>
      <input v-model="q" class="tp-input tp-search" placeholder="过滤：用户 / 主机 / SQL" spellcheck="false" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
      <button class="tp-btn danger" :disabled="loading || !sel.length" @click="closeSel">结束选中（{{ sel.length }}）</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="msg" class="tp-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

    <div class="tp-tbl-wrap tp-scroll-y" data-src="tnTxns" :data-tenant="d.tenant.name">
      <table class="tp-tbl">
        <thead>
          <tr>
            <th style="width:26px"><input type="checkbox" :checked="allSel" @change="toggleAll" /></th>
            <th>事务 ID</th><th>会话</th><th>用户</th><th>客户端</th><th class="r">已耗时</th><th>状态</th><th>当前语句</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(t, i) in filtered" :key="`${t.id}-${t.sessionId}-${i}`" :class="{ on: sel.includes(key(t, i)) }">
            <td><input type="checkbox" :checked="sel.includes(key(t, i))" @change="toggle(key(t, i))" /></td>
            <td class="tp-mono">{{ t.id || '—' }}</td>
            <td class="tp-mono">{{ t.sessionId || '—' }}</td>
            <td>{{ t.user || '—' }}</td>
            <td class="tp-mono tp-dim">{{ t.host || '—' }}</td>
            <td class="r tp-mono">{{ fmtElapsed(t) }}</td>
            <td><span class="tp-chip">{{ t.state || '—' }}</span></td>
            <td class="ell tp-dim" :title="t.info">{{ t.info || '—' }}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="8" class="tp-empty">{{ loading ? '读取中…' : '当前没有符合条件的活动事务' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="tp-note">
      数据来自 OCP 的 transactions 接口（依赖 OB 的 transaction 视图，需要租户开启事务审计）。
      结束事务会回滚该事务并断开对应会话，生产环境请先确认不是大事务或批量作业。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 事务管理：按持续时长过滤活动事务，支持批量结束（batchClose） */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const rows = ref<CloudTenantTxn[]>([])
const loading = ref(false)
const err = ref('')
const msg = ref('')
const msgOk = ref(true)
const threshold = ref(0)
const q = ref('')
const sel = ref<string[]>([])

/** 行可能没有唯一 id，用「id|sessionId|下标」做选择键 */
const key = (t: CloudTenantTxn, i: number): string => `${t.id}|${t.sessionId}|${i}`

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return rows.value
  return rows.value.filter((t) => [t.user, t.host, t.info, t.state, t.id].some((v) => String(v || '').toLowerCase().includes(k)))
})
const allSel = computed(() => filtered.value.length > 0 && filtered.value.every((t, i) => sel.value.includes(key(t, i))))

function toggle(k: string): void {
  const i = sel.value.indexOf(k)
  if (i >= 0) sel.value.splice(i, 1)
  else sel.value.push(k)
}
function toggleAll(): void {
  sel.value = allSel.value ? [] : filtered.value.map((t, i) => key(t, i))
}

function fmtElapsed(t: CloudTenantTxn): string {
  if (t.elapsedMs) return t.elapsedMs >= 1000 ? `${(t.elapsedMs / 1000).toFixed(1)}s` : `${t.elapsedMs}ms`
  if (t.duration) return `${t.duration}s`
  return '—'
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantTxns(cloud.activeId, t.clusterId, t.id, threshold.value)
    if (!r.ok) { err.value = r.error || '读取事务失败'; return }
    rows.value = r.data || []
    sel.value = []
  } finally {
    loading.value = false
  }
}

async function closeSel(): Promise<void> {
  const picked = filtered.value.filter((t, i) => sel.value.includes(key(t, i)))
  if (!picked.length) return
  const ok = await window.sqlpilot.uiConfirm(`结束 ${picked.length} 个事务？`, '事务会回滚，对应会话可能被断开。', true)
  if (!ok) return
  loading.value = true
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantCloseTxns(
      cloud.activeId, t.clusterId, t.id,
      picked.map((x) => ({ sessionId: x.sessionId, ...(x.id ? { transId: x.id } : {}) }))
    )
    if (!r.ok) { msg.value = r.error || '结束事务失败'; msgOk.value = false; return }
    pushNotice(`已提交结束 ${picked.length} 个事务`)
    msg.value = `已提交结束 ${picked.length} 个事务`
    msgOk.value = true
    await load()
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>
