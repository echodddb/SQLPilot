<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">会话 <span class="cnt">{{ sessions.length }}</span></h4>
      <input v-model="q" class="tp-input tp-search" placeholder="过滤：用户 / 库 / 主机 / SQL" spellcheck="false" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="loadAll">{{ loading ? '读取中…' : '刷新' }}</button>
      <button class="tp-btn" :disabled="loading || !sel.length" @click="closeSessions(sel, 'close')">结束选中（{{ sel.length }}）</button>
      <button class="tp-btn" :disabled="loading || !sel.length" @click="closeSessions(sel, 'query')">仅结束查询</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <!-- 统计 -->
    <div v-if="stats" class="tp-cards">
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">总会话 / 活跃</span>
        <div style="font-size:18px;font-weight:600">{{ stats.active }} <span class="tp-dim" style="font-size:11px">/ {{ stats.total }}</span></div>
        <span class="tp-note">最长活跃 {{ stats.maxActiveTime }}s</span>
      </div>
      <div class="tp-card" data-src="tnSessionStats" :data-tenant="d.tenant.name">
        <span class="tp-dim" style="font-size:11px">按用户</span>
        <div class="mini-list">
          <span v-for="u in stats.byUser.slice(0, 5)" :key="u.name">{{ u.name }} <b>{{ u.active }}</b>/{{ u.total }}</span>
          <span v-if="!stats.byUser.length" class="tp-note">—</span>
        </div>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">按数据库</span>
        <div class="mini-list">
          <span v-for="x in stats.byDb.slice(0, 5)" :key="x.name">{{ x.name }} <b>{{ x.active }}</b>/{{ x.total }}</span>
          <span v-if="!stats.byDb.length" class="tp-note">—</span>
        </div>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">按客户端</span>
        <div class="mini-list">
          <span v-for="x in stats.byClient.slice(0, 5)" :key="x.name">{{ x.name }} <b>{{ x.active }}</b>/{{ x.total }}</span>
          <span v-if="!stats.byClient.length" class="tp-note">—</span>
        </div>
      </div>
    </div>

    <div class="tp-tbl-wrap tp-scroll-y" data-src="tnSessions" :data-tenant="d.tenant.name" :data-detail="`已加载 ${sessions.length} 条会话|活跃 ${stats?.active ?? '—'} / 总 ${stats?.total ?? '—'}`">
      <table class="tp-tbl">
        <thead>
          <tr>
            <th style="width:26px"><input type="checkbox" :checked="allSel" @change="toggleAll" /></th>
            <th>会话 ID</th><th>用户</th><th>库</th><th>状态</th><th class="r">耗时</th><th>来源</th><th>当前语句</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in filtered" :key="s.id" :class="{ on: sel.includes(s.id) }">
            <td><input type="checkbox" :checked="sel.includes(s.id)" @change="toggle(s.id)" /></td>
            <td class="tp-mono">{{ s.id }}</td>
            <td>{{ s.user }}</td>
            <td class="tp-dim">{{ s.db || '—' }}</td>
            <td><span class="tp-chip">{{ s.state || s.command || '—' }}</span></td>
            <td class="r tp-mono">{{ s.time }}s</td>
            <td class="tp-mono tp-dim" style="font-size:10.5px">{{ s.host || '—' }}</td>
            <td class="ell tp-dim" :title="s.info">{{ s.info || '—' }}</td>
            <td>
              <button class="tp-btn sm" @click="closeSessions([s.id], 'query')">结束查询</button>
              <button class="tp-btn sm danger" @click="closeSessions([s.id], 'close')">结束会话</button>
            </td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="9" class="tp-empty">{{ loading ? '读取中…' : '没有会话' }}</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 行锁 -->
    <div class="tp-bar">
      <h4 class="tp-h">行锁等待 <span class="cnt">{{ locks.length }}</span></h4>
      <span class="sp"></span>
      <button class="tp-btn sm" :disabled="lockLoading" @click="loadLocks">{{ lockLoading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="lockErr" class="tp-err">{{ lockErr }}</div>
    <div class="tp-tbl-wrap">
      <table class="tp-tbl">
        <thead><tr><th>会话 ID</th><th>用户</th><th>客户端</th><th>表</th><th>锁模式</th><th>类型</th><th class="r">时长</th><th>SQL</th></tr></thead>
        <tbody>
          <tr v-for="(l, i) in locks" :key="i">
            <td class="tp-mono">{{ l.sessionId }}</td>
            <td>{{ l.user || '—' }}</td>
            <td class="tp-mono tp-dim">{{ l.host || '—' }}</td>
            <td class="tp-mono">{{ l.table || '—' }}</td>
            <td>{{ l.lockMode || '—' }}</td>
            <td class="tp-dim">{{ l.lockType || '—' }}</td>
            <td class="r tp-mono">{{ l.time }}s</td>
            <td class="ell tp-dim" :title="l.info">{{ l.info || '—' }}</td>
          </tr>
          <tr v-if="!locks.length"><td colspan="8" class="tp-empty">{{ lockLoading ? '读取中…' : '当前没有行锁等待' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tp-note">
      「结束会话」走 OCP 的 sessions/close（KILL CONNECTION），「仅结束查询」走 sessions/closeQuery（KILL QUERY，连接保留）。
      对业务影响更小的是后者；两者都建议先确认不是关键事务。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 会话管理：列表（GV$OB_PROCESSLIST）+ 三向统计 + 行锁等待 + 两级 kill */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud, tenantCloseSessions, tenantSessions } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const sessions = ref<CloudTenantSession[]>([])
const loading = ref(false)
const err = ref('')
const q = ref('')
const sel = ref<number[]>([])

const stats = ref<CloudTenantSessionStats | null>(null)
const locks = ref<CloudTenantRowLock[]>([])
const lockLoading = ref(false)
const lockErr = ref('')

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return sessions.value
  return sessions.value.filter((s) =>
    [s.user, s.db, s.host, s.command, s.info, s.state, String(s.id)].some((v) => String(v || '').toLowerCase().includes(k))
  )
})
const allSel = computed(() => filtered.value.length > 0 && filtered.value.every((s) => sel.value.includes(s.id)))

function toggle(id: number): void {
  const i = sel.value.indexOf(id)
  if (i >= 0) sel.value.splice(i, 1)
  else sel.value.push(id)
}
function toggleAll(): void {
  if (allSel.value) sel.value = []
  else sel.value = filtered.value.map((s) => s.id)
}

async function loadAll(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const [r, s] = await Promise.all([
      tenantSessions(t.clusterId, t.id),
      window.sqlpilot.cloudTenantSessionStats(cloud.activeId, t.clusterId, t.id)
    ])
    if (!r.ok) { err.value = r.error || '读取会话失败'; return }
    sessions.value = r.data?.items || []
    sel.value = []
    stats.value = s.ok ? s.data || null : null
  } finally {
    loading.value = false
  }
}

async function loadLocks(): Promise<void> {
  lockLoading.value = true
  lockErr.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantRowLocks(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { lockErr.value = r.error || '读取行锁失败'; return }
    locks.value = r.data || []
  } finally {
    lockLoading.value = false
  }
}

async function closeSessions(ids: number[], mode: 'close' | 'query'): Promise<void> {
  if (!ids.length) return
  const t = d.value.tenant
  const ok = await window.sqlpilot.uiConfirm(
    mode === 'close' ? `结束 ${ids.length} 个会话？` : `结束 ${ids.length} 个会话的当前查询？`,
    mode === 'close'
      ? '连接会被断开（KILL CONNECTION），事务回滚，请确认不属于关键业务。'
      : '只终止正在执行的语句（KILL QUERY），连接与事务保留。',
    true
  )
  if (!ok) return
  loading.value = true
  try {
    const r = mode === 'close'
      ? await tenantCloseSessions(t.clusterId, t.id, ids)
      : await window.sqlpilot.cloudTenantCloseQuery(cloud.activeId, t.clusterId, t.id, ids)
    if (!r.ok) { err.value = r.error || '操作失败'; return }
    pushNotice(mode === 'close' ? `已结束 ${ids.length} 个会话` : `已结束 ${ids.length} 个查询`)
    await loadAll()
    await loadLocks()
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadAll()
  await loadLocks()
})
watch(() => props.reloadToken, async () => {
  await loadAll()
  await loadLocks()
})
</script>

<style scoped>
.mini-list { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: var(--text-dim); }
.mini-list b { color: var(--text); font-weight: 600; }
</style>
