<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">主备关系</h4>
      <span class="sp"></span>
      <button class="tp-btn" title="以当前租户为主租户，在另一个集群创建只读备租户" @click="standbyOpen = true">＋ 创建备租户</button>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <template v-if="topo">
      <!-- 主租户（当前是备租户时才显示） -->
      <div v-if="topo.primary" class="topo-row">
        <div class="node primary">
          <div class="node-head"><b>{{ topo.primary.name }}</b><span class="tp-chip">主租户</span></div>
          <div class="node-sub">{{ topo.primary.clusterName }} · {{ topo.primary.status }} · {{ topo.primary.locality }}</div>
        </div>
        <div class="arrow"><span class="line"></span><span class="label">同步</span></div>
        <div class="node current">
          <div class="node-head"><b>{{ cur.name }}</b><span class="tp-chip" style="color:var(--accent);border-color:var(--accent)">当前</span><span class="tp-chip">备租户</span></div>
          <div class="node-sub">{{ cur.syncStatus || '同步状态未知' }}</div>
        </div>
      </div>

      <!-- 当前租户是主：扇出到备租户 -->
      <div v-else class="topo-col">
        <div class="node current">
          <div class="node-head">
            <b>{{ cur.name }}</b>
            <span class="tp-chip" style="color:var(--accent);border-color:var(--accent)">当前</span>
            <span class="tp-chip">主租户</span>
          </div>
          <div class="node-sub">{{ cur.clusterName }} · {{ cur.locality || '—' }} · OB 租户 ID {{ d.tenant.obTenantId }}</div>
        </div>
        <div v-if="topo.standbys.length" class="fan">
          <div v-for="s in topo.standbys" :key="s.id" class="node standby">
            <div class="node-head"><b>{{ s.name }}</b><span class="tp-chip">备租户</span></div>
            <div class="node-sub">{{ s.clusterName }} · {{ s.syncStatus || s.status }}</div>
          </div>
        </div>
        <div v-else class="tp-note" style="text-align:center">
          该租户未配置备租户。OCP 的「创建备租户 / 主备切换」需要先配置日志传输，SqlPilot 暂未开放写入口。
        </div>
      </div>

      <h4 class="tp-h">关系明细 <span class="cnt">{{ relationRows.length }}</span></h4>
      <div class="tp-tbl-wrap">
        <table class="tp-tbl">
          <thead><tr><th>租户</th><th>集群</th><th>角色</th><th>状态</th><th>同步状态</th><th>Locality</th><th>创建时间</th></tr></thead>
          <tbody>
            <tr v-for="r in relationRows" :key="`${r.clusterId}-${r.id}`">
              <td style="font-weight:550">{{ r.name }}<span v-if="r.id === d.tenant.id" class="tp-chip" style="margin-left:6px">当前</span></td>
              <td class="tp-dim">{{ r.clusterName }}</td>
              <td><span class="tp-chip" :style="/PRIMARY/i.test(r.role) ? 'color:var(--accent);border-color:var(--accent)' : ''">{{ r.role || '—' }}</span></td>
              <td>{{ r.status || '—' }}</td>
              <td class="tp-dim">{{ r.syncStatus || '—' }}</td>
              <td class="tp-mono tp-dim">{{ r.locality || '—' }}</td>
              <td class="tp-dim">{{ fmtTime(r.createTime) }}</td>
            </tr>
            <tr v-if="!relationRows.length"><td colspan="7" class="tp-empty">无主备关系</td></tr>
          </tbody>
        </table>
      </div>

      <h4 class="tp-h">同集群其他租户 <span class="cnt">{{ topo.siblings.length }}</span></h4>
      <div class="tp-bar" style="flex-wrap:wrap">
        <span v-for="s in topo.siblings" :key="s.id" class="tp-chip">
          <i class="tp-dot" :class="s.status === 'NORMAL' ? '' : 'warn'"></i>{{ s.name }} · {{ s.role || '—' }}
        </span>
        <span v-if="!topo.siblings.length" class="tp-note">无</span>
      </div>
    </template>
    <div v-else-if="!loading" class="tp-empty">未读取到主备关系</div>
  </div>
  <StandbyCreate v-if="standbyOpen" @close="onStandbyClosed" />
</template>

<script setup lang="ts">
/** 主备关系拓扑：standbyRelationTopo + listRelationTenants + siblingTenants */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtTime } from '../../../cloud/parts'
import StandbyCreate from './StandbyCreate.vue'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const topo = ref<CloudTenantTopo | null>(null)
const loading = ref(false)
const err = ref('')
/** 创建备租户弹窗 */
const standbyOpen = ref(false)

function onStandbyClosed(): void {
  standbyOpen.value = false
  load()
}

const cur = computed<CloudTenantRelationNode>(() => topo.value?.current || {
  id: d.value.tenant.id,
  name: d.value.tenant.name,
  clusterId: d.value.tenant.clusterId,
  clusterName: d.value.tenant.clusterName,
  role: d.value.tenant.role || 'PRIMARY',
  status: d.value.tenant.status,
  locality: d.value.tenant.locality,
  createTime: d.value.tenant.createTime,
  syncStatus: d.value.tenant.syncStatus || ''
})

const relationRows = computed(() => {
  const t = topo.value
  if (!t) return []
  const list = [t.current, t.primary, ...t.standbys].filter(Boolean) as CloudTenantRelationNode[]
  const seen = new Set<string>()
  return list.filter((r) => {
    const k = `${r.clusterId}-${r.id}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
})

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantTopo(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { err.value = r.error || '读取主备关系失败'; return }
    topo.value = r.data || null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.topo-col { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 8px 0 4px; }
.topo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; padding: 8px 0 4px; }
.node {
  min-width: 230px; border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px;
  background: var(--bg-input); display: flex; flex-direction: column; gap: 5px;
}
.node.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim) inset; }
.node.primary { border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.node-head { display: flex; align-items: center; gap: 7px; font-size: 12.5px; }
.node-sub { font-size: 10.5px; color: var(--text-dim); }
.fan { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; position: relative; padding-top: 12px; }
.fan::before { content: ''; position: absolute; top: 0; left: 50%; width: 1px; height: 12px; background: var(--border-strong); }
.arrow { display: flex; flex-direction: column; align-items: center; gap: 2px; color: var(--text-faint); }
.arrow .line { width: 46px; height: 1px; background: var(--border-strong); position: relative; }
.arrow .line::after {
  content: ''; position: absolute; right: 0; top: -3px; border-left: 6px solid var(--border-strong);
  border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;
}
.arrow .label { font-size: 10px; }
</style>
