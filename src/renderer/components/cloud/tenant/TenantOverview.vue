<template>
  <div class="tp-pane">
    <div v-if="err" class="tp-err">{{ err }}</div>

    <h4 class="tp-h">基本信息</h4>
    <div class="tp-kv-grid">
      <div class="tp-kv" data-src="tnBasic" :data-tenant="t.name"><span>字符集 / 排序规则</span><b class="tp-mono">{{ d.charset || '—' }} / {{ d.collation || '—' }}</b></div>
      <div class="tp-kv"><span>OB 版本</span><b class="tp-mono">{{ t.version || '—' }}</b></div>
      <div class="tp-kv"><span>负载类型</span><b>{{ t.loadType || '—' }}</b></div>
      <div class="tp-kv"><span>租户角色</span><b>{{ t.role || 'PRIMARY' }}{{ t.syncStatus ? ' · ' + t.syncStatus : '' }}</b></div>
      <div class="tp-kv"><span>集群类型</span><b>{{ t.clusterType || '—' }}</b></div>
      <div class="tp-kv"><span>副本类型 / 副本数</span><b>{{ replicaTypes || '—' }} · {{ d.zones.length }}</b></div>
      <div class="tp-kv"><span>主 Zone</span><b class="tp-mono">{{ t.primaryZone || '—' }}</b></div>
      <div class="tp-kv"><span>Zone 列表</span><b class="tp-mono">{{ (d.zoneList && d.zoneList.length ? d.zoneList.join(', ') : zoneNamesFromReplica) || '—' }}</b></div>
      <div class="tp-kv"><span>死锁检测</span><b>{{ d.deadLockDetection ? '已开启' : '关闭' }}</b></div>
      <div class="tp-kv"><span>日志备份</span><b>{{ d.logBackupRunning ? '进行中' : '未运行' }}</b></div>
      <div class="tp-kv"><span>创建时间</span><b>{{ fmtTime(t.createTime) }}</b></div>
      <div class="tp-kv"><span>OB 租户 ID</span><b class="tp-mono">{{ t.obTenantId }}</b></div>
      <div class="tp-kv wide" data-src="tnWhitelist" :data-tenant="t.name"><span>访问白名单</span><b class="tp-mono" :title="d.whitelist">{{ d.whitelist || '—' }}</b></div>
      <div v-if="d.description" class="tp-kv wide"><span>描述</span><b :title="d.description">{{ d.description }}</b></div>
      <div class="tp-kv wide"><span>Locality</span><b class="tp-mono" data-src="tnReplica" :data-tenant="t.name">{{ t.locality || '—' }}</b></div>
    </div>

    <h4 class="tp-h">资源配额 <span class="cnt">{{ quota.units }} Unit</span></h4>
    <div class="tp-cards">
      <div class="tp-card">
        <div class="tp-bar"><span class="tp-dim" style="font-size:11px">CPU 配额</span></div>
        <div style="font-size:19px;font-weight:600">{{ quota.cpu }} <span class="tp-dim" style="font-size:11px">核</span></div>
        <div class="tp-note">按副本 Unit 规格累加（{{ d.zones.length }} 个副本 × 各 Zone Unit 数）</div>
      </div>
      <div class="tp-card">
        <div class="tp-bar"><span class="tp-dim" style="font-size:11px">内存配额</span></div>
        <div style="font-size:19px;font-weight:600">{{ fmtBytes(quota.memory) }}</div>
        <div class="tp-note">Unit 内存规格累加；实际可用受 OBServer 剩余资源限制</div>
      </div>
      <div class="tp-card">
        <div class="tp-bar"><span class="tp-dim" style="font-size:11px">数据量</span></div>
        <div style="font-size:19px;font-weight:600">{{ fmtBytes(dataSize) }}</div>
        <div class="tp-note">各库 requiredSize 合计（{{ dbCount }} 个库），按副本数放大后才是物理占用</div>
      </div>
      <div class="tp-card">
        <div class="tp-bar"><span class="tp-dim" style="font-size:11px">会话</span></div>
        <div style="font-size:19px;font-weight:600">{{ stats ? stats.active : '—' }} <span class="tp-dim" style="font-size:11px">活跃 / {{ stats ? stats.total : '—' }} 总</span></div>
        <div class="tp-note">{{ stats ? `最长活跃 ${stats.maxActiveTime}s` : '未能读取会话统计' }}</div>
      </div>
    </div>

    <h4 class="tp-h">副本分布 <span class="cnt">{{ d.zones.length }}</span></h4>
    <div class="tp-tbl-wrap">
      <table class="tp-tbl">
        <thead data-src="tnReplica"><tr><th>Zone</th><th>副本类型</th><th>资源池</th><th class="r">Unit 数</th><th class="r">单 Unit CPU</th><th class="r">单 Unit 内存</th><th>Unit 分布</th></tr></thead>
        <tbody>
          <tr v-for="z in d.zones" :key="z.name">
            <td class="tp-mono">{{ z.name }}</td>
            <td><span class="tp-chip">{{ z.replicaType }}</span></td>
            <td class="tp-mono tp-dim">{{ z.poolName || '—' }}</td>
            <td class="r tp-mono">{{ z.unitCount }}</td>
            <td class="r tp-mono">{{ z.unitCpu }}</td>
            <td class="r tp-mono">{{ fmtBytes(z.unitMemory) }}</td>
            <td>
              <span v-for="u in z.units" :key="u.id" class="tp-chip" style="margin-right:4px">
                <i class="tp-dot" :class="u.status === 'ACTIVE' ? '' : 'warn'"></i>{{ u.ip }}
              </span>
            </td>
          </tr>
          <tr v-if="!d.zones.length"><td colspan="7" class="tp-empty">无副本信息</td></tr>
        </tbody>
      </table>
    </div>

    <template v-if="conns.length">
      <h4 class="tp-h">连接串</h4>
      <div class="tp-card">
        <div v-for="(c, i) in conns" :key="i" class="tp-conn">
          <span class="tp-chip">{{ c.type }}</span>
          <code class="tp-mono">{{ c.url }}</code>
          <button class="tp-btn sm" @click="copy(c.url)">复制</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/** 租户概览：基本信息 + 资源配额 + 副本分布 + 可用连接串 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud, refreshTenant } from '../../../cloud/state'
import { fmtBytes, fmtTime } from '../../../cloud/parts'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)
const t = computed(() => d.value.tenant)

const err = ref('')
const stats = ref<CloudTenantSessionStats | null>(null)
const dbs = ref<CloudTenantDatabase[]>([])
const conns = ref<{ type: string; url: string }[]>([])

const quota = computed(() => {
  let cpu = 0
  let memory = 0
  let units = 0
  for (const z of d.value.zones) {
    const n = Math.max(0, Number(z.unitCount) || 0)
    cpu += (Number(z.unitCpu) || 0) * n
    memory += (Number(z.unitMemory) || 0) * n
    units += n
  }
  return { cpu, memory, units }
})

const dataSize = computed(() => dbs.value.reduce((s, x) => s + (Number(x.requiredSize) || 0), 0))
const dbCount = computed(() => dbs.value.length)
const zoneNamesFromReplica = computed(() => d.value.zones.map((z) => z.name).join(', '))
const replicaTypes = computed(() => [...new Set(d.value.zones.map((z) => z.replicaType).filter(Boolean))].join(' / '))

async function copy(text: string): Promise<void> {
  await window.sqlpilot.writeClipboard(text)
  pushNotice('已复制连接串')
}

async function load(): Promise<void> {
  err.value = ''
  const cid = t.value.clusterId
  const tid = t.value.id
  const plat = cloud.activeId
  const [s, ds, us] = await Promise.all([
    window.sqlpilot.cloudTenantSessionStats(plat, cid, tid),
    window.sqlpilot.cloudTenantDbs(plat, cid, tid),
    window.sqlpilot.cloudTenantUsers(plat, cid, tid)
  ])
  stats.value = s.ok ? s.data || null : null
  dbs.value = ds.ok ? ds.data || [] : []
  if (!ds.ok && ds.error) err.value = `库列表读取失败：${ds.error}`
  // 连接串优先取 root 用户（各版本 OCP 都返回 OBPROXY + DIRECT 两种）
  const users = us.ok ? us.data || [] : []
  const root = users.find((u) => u.username === 'root') || users[0]
  conns.value = root?.connections || []
}

onMounted(load)
watch(() => props.reloadToken, async () => {
  await refreshTenant().catch(() => {})
  await load()
})
</script>

<style scoped>
.tp-conn { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
.tp-conn code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
</style>
