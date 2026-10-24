<template>
  <div class="cs-mask" @click.self="close" @keydown.esc="close">
    <div class="cs-panel">
      <div class="cs-input-row">
        <span class="cs-ico">⌕</span>
        <input
          ref="inputEl"
          v-model="q"
          class="cs-input"
          placeholder="搜索集群 / 租户 / 主机（IP、别名、模式…）"
          spellcheck="false"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="pick(active)"
          @keydown.esc.prevent="close"
        />
        <span class="cs-hint">{{ hits.length }} 条 · ↑↓ 选择 · Enter 打开</span>
      </div>

      <div v-if="loading" class="cs-state"><span class="spinner"></span>正在读取集群 / 租户 / 主机清单…</div>
      <div v-else-if="!hits.length" class="cs-state">{{ q ? '没有匹配的集群、租户或主机' : '输入关键字开始搜索' }}</div>
      <div v-else class="cs-list">
        <template v-for="(g, gi) in groups" :key="g.kind">
          <div class="cs-group">{{ g.label }}<span class="cs-count">{{ g.items.length }}</span></div>
          <button
            v-for="h in g.items"
            :key="`${h.kind}-${h.id}`"
            class="cs-item"
            :class="{ active: flat.indexOf(h) === active }"
            @mouseenter="active = flat.indexOf(h)"
            @click="pick(flat.indexOf(h))"
          >
            <span class="cs-kind" :class="h.kind">{{ kindLabel(h.kind) }}</span>
            <span class="cs-title">{{ h.title }}</span>
            <span class="cs-sub">{{ h.sub }}</span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 云管全局搜索（Ctrl+K）：跨集群 / 租户 / 主机模糊匹配，回车直接跳到对应详情。
 * 三个清单按需拉取并复用 store 缓存，不额外打扰当前视图的加载状态。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud, openCluster, openHost, openTenant, setView } from '../../cloud/state'
import { tenantStatus } from '../../cloud/parts'

interface Hit {
  kind: 'cluster' | 'tenant' | 'host'
  id: number
  clusterId?: number
  title: string
  sub: string
  host?: CloudHost
}

const q = ref('')
const active = ref(0)
const loading = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

const kindLabel = (k: Hit['kind']): string => (k === 'cluster' ? '集群' : k === 'tenant' ? '租户' : '主机')

/** 搜索需要三份清单都在，缺哪个补哪个 */
async function ensureData(): Promise<void> {
  const jobs: Promise<void>[] = []
  if (!cloud.clusters.length) {
    jobs.push(window.sqlpilot.cloudClusters(cloud.activeId).then((r) => { if (r.ok && r.data) cloud.clusters = r.data }))
  }
  if (!cloud.tenants.length) {
    jobs.push(window.sqlpilot.cloudTenants(cloud.activeId).then((r) => { if (r.ok && r.data) cloud.tenants = r.data }))
  }
  if (!cloud.hosts.length) {
    jobs.push(window.sqlpilot.cloudHosts(cloud.activeId).then((r) => { if (r.ok && r.data) cloud.hosts = r.data }))
  }
  if (!jobs.length) return
  loading.value = true
  try { await Promise.all(jobs) } finally { loading.value = false }
}

const hits = computed<Hit[]>(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return []
  const out: Hit[] = []
  for (const c of cloud.clusters) {
    const hay = `${c.name} ${c.obClusterId} ${c.version} ${c.rootServer}`.toLowerCase()
    if (hay.includes(k)) out.push({ kind: 'cluster', id: c.id, title: c.name, sub: `v${c.version} · ${c.serverCount} 节点 · ${c.tenantCount} 租户` })
  }
  for (const t of cloud.tenants) {
    const hay = `${t.name} ${t.clusterName} ${t.mode} ${t.primaryZone} ${t.locality}`.toLowerCase()
    if (hay.includes(k)) out.push({ kind: 'tenant', id: t.id, clusterId: t.clusterId, title: t.name, sub: `${t.clusterName} · ${t.mode} · ${tenantStatus(t.status).label}` })
  }
  for (const h of cloud.hosts) {
    const hay = `${h.ip} ${h.name} ${h.alias} ${h.os} ${h.clusters.join(' ')} ${h.obproxies.join(' ')}`.toLowerCase()
    if (hay.includes(k)) out.push({ kind: 'host', id: h.id, title: h.alias || h.name, sub: `${h.ip} · ${h.os || '—'}`, host: h })
  }
  return out.slice(0, 40)
})

const flat = computed(() => hits.value)

const groups = computed(() => {
  const order: Hit['kind'][] = ['cluster', 'tenant', 'host']
  const labels: Record<Hit['kind'], string> = { cluster: '集群', tenant: '租户', host: '主机' }
  return order
    .map((kind) => ({ kind, label: labels[kind], items: hits.value.filter((h) => h.kind === kind) }))
    .filter((g) => g.items.length)
})

function move(delta: number): void {
  if (!hits.value.length) return
  active.value = (active.value + delta + hits.value.length) % hits.value.length
}

/** 关键字一变，高亮回到第一条 */
watch(q, () => { active.value = 0 })

async function pick(index: number): Promise<void> {
  const h = hits.value[index]
  if (!h) return
  close()
  if (h.kind === 'cluster') {
    cloud.view = 'clusters'
    await openCluster(h.id)
  } else if (h.kind === 'tenant') {
    setView('tenants')
    await openTenant(h.clusterId as number, h.id)
  } else {
    const host = h.host as CloudHost
    setView('hosts')
    openHost(host)
  }
}

function close(): void {
  cloud.searchOpen = false
}

onMounted(() => {
  void ensureData()
  inputEl.value?.focus()
})
</script>

<style scoped>
.cs-mask {
  position: fixed; inset: 0; z-index: 950; background: rgba(0, 0, 0, 0.42);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh;
  backdrop-filter: blur(1px);
}
.cs-panel {
  width: 620px; max-width: 92vw; max-height: 62vh; background: var(--bg-side);
  border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column; overflow: hidden;
}
.cs-input-row { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-bottom: 1px solid var(--border); }
.cs-ico { color: var(--text-faint); font-size: 14px; }
.cs-input {
  flex: 1; background: none; border: none; outline: none; color: var(--text);
  font-family: inherit; font-size: 13.5px;
}
.cs-hint { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; }
.cs-state { padding: 24px; text-align: center; color: var(--text-faint); font-size: 12px; display: flex; align-items: center; justify-content: center; gap: 8px; }
.cs-list { overflow: auto; padding: 4px 0 8px; }
.cs-group {
  display: flex; align-items: center; gap: 6px; padding: 8px 13px 4px;
  font-size: 10px; letter-spacing: 0.8px; color: var(--text-faint); text-transform: uppercase;
}
.cs-count { font-family: var(--mono); font-size: 9.5px; border: 1px solid var(--border); border-radius: 99px; padding: 0 5px; }
.cs-item {
  width: 100%; display: flex; align-items: center; gap: 9px; padding: 7px 13px;
  background: none; border: none; border-left: 2px solid transparent; color: inherit;
  font-family: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.cs-item:hover, .cs-item.active { background: var(--bg-card-hover); border-left-color: var(--accent); }
.cs-kind {
  flex-shrink: 0; font-size: 9.5px; padding: 0 5px; border-radius: 3px;
  border: 1px solid var(--border); color: var(--text-faint);
}
.cs-kind.cluster { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.cs-kind.tenant { color: var(--green); border-color: color-mix(in srgb, var(--green) 35%, transparent); }
.cs-kind.host { color: var(--text-dim); }
.cs-title { flex-shrink: 0; color: var(--text); font-weight: 550; }
.cs-sub { color: var(--text-faint); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spinner { width: 12px; height: 12px; border: 2px solid var(--accent-dim); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
