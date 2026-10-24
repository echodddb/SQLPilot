<template>
  <div class="cp">
    <!-- 列表 -->
    <template v-if="!cloud.clusterId">
      <div class="cp-head">
        <h2>OB 集群 <span class="count">{{ cloud.clusters.length }}</span></h2>
        <span class="hint">点击任意集群查看 Zone / OBServer / 租户明细</span>
        <span style="flex:1"></span>
        <button class="mini primary" title="在 OCP 中新建主集群" @click="createOpen = true">＋ 创建集群</button>
      </div>
      <div class="table-wrap" data-ai="clusters.list">
        <table class="tbl">
          <thead>
            <tr>
              <th>集群</th><th>状态</th><th>版本</th><th>模式</th>
              <th class="r">节点</th><th class="r">租户</th>
              <th>CPU 分配</th><th>内存分配</th><th>数据盘</th><th>告警</th><th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="c in cloud.clusters"
              :key="c.id"
              class="clickable"
              :data-ai="`clusters.list:${c.name}`"
              :data-ai-name="c.name"
              @click="openCluster(c.id)"
            >
              <td data-src="clList" :data-cluster="c.name">
                <div class="cell-main">{{ c.name }}</div>
                <div class="cell-sub mono">{{ c.rootServer || '—' }}</div>
              </td>
              <td><span class="pill" :class="clusterStatus(c.status).tone">{{ clusterStatus(c.status).label }}</span></td>
              <td class="mono">{{ c.version }}</td>
              <td>{{ clusterMode(c.clusterMode) }}</td>
              <td class="r mono">{{ c.serverCount }}</td>
              <td class="r mono">{{ c.tenantCount }}</td>
              <td data-src="clusterCap" :data-cluster="c.name"><span class="mono">{{ c.cpu.used }}/{{ c.cpu.total }}</span><span class="pct">{{ c.cpu.pct }}%</span></td>
              <td data-src="clusterCap" :data-cluster="c.name"><span class="mono">{{ fmtBytes(c.memory.used) }}</span><span class="pct">{{ c.memory.pct }}%</span></td>
              <td data-src="clusterCap" :data-cluster="c.name"><span class="mono">{{ fmtBytes(c.disk.used) }}</span><span class="pct" :class="capacityTone(c.disk.pct)">{{ c.disk.pct }}%</span></td>
              <td data-src="clAlarm" :data-cluster="c.name">
                <span v-if="c.alarms.total" class="pill" :class="worstTone(c)">{{ c.alarms.total }}</span>
                <span v-else class="pill ok">0</span>
              </td>
              <td class="dim">{{ fmtTime(c.createTime) }}</td>
            </tr>
            <tr v-if="!cloud.clusters.length">
              <td colspan="11" class="empty">尚未发现 OB 集群</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- 详情 -->
    <template v-else-if="d">
      <div class="dt-head">
        <button class="back" title="返回集群列表" @click="closeCluster">←</button>
        <div class="dt-title">
          <div class="dt-name">
            <span class="dot" :class="clusterStatus(d.cluster.status).tone"></span>
            <b>{{ d.cluster.name }}</b>
            <span class="pill" :class="clusterStatus(d.cluster.status).tone">{{ clusterStatus(d.cluster.status).label }}</span>
            <span class="pill gray">v{{ d.cluster.version }}</span>
          </div>
          <div class="dt-meta" data-src="clMeta" :data-cluster="d.cluster.name">
            <span>OBClusterID <b class="mono">{{ d.cluster.obClusterId }}</b></span>
            <span>{{ clusterMode(d.cluster.clusterMode) }}</span>
            <span>{{ originLabel(d.cluster.origin) }}</span>
            <span>{{ d.cluster.serverCount }} 节点 · {{ d.cluster.tenantCount }} 租户 · {{ d.cluster.regionCount }} 区域</span>
            <span>创建于 {{ fmtTime(d.cluster.createTime) }}（{{ d.cluster.creator || '—' }}）</span>
          </div>
        </div>
        <div class="dt-tools">
          <button class="mini primary" title="在本集群创建租户" @click="tenantCreate = true">＋ 创建租户</button>
          <ClusterOps :cluster="d.cluster" />
        </div>
      </div>
      <div class="dt-caps" :data-ai="`clusters.capacity:${d.cluster.name}`" data-src="clusterCap" :data-cluster="d.cluster.name">
        <CapacityBar label="CPU" :used="d.cluster.cpu.used" :total="d.cluster.cpu.total" :percent="d.cluster.cpu.pct" unit="count" tone="info" />
        <CapacityBar label="内存" :used="d.cluster.memory.used" :total="d.cluster.memory.total" :percent="d.cluster.memory.pct" tone="info" />
        <CapacityBar label="数据盘" :used="d.cluster.disk.used" :total="d.cluster.disk.total" :percent="d.cluster.disk.pct" />
      </div>

      <div v-if="d.attributes.length" class="attr-grid">
        <div v-for="a in d.attributes" :key="a.key" class="attr">
          <span class="attr-k">{{ a.key }}</span>
          <span class="attr-v mono" :title="a.label">{{ maybeTime(a.label) }}</span>
        </div>
      </div>

      <section class="dt-section" :data-ai="`clusters.topology:${d.cluster.name}`">
        <h3 data-src="clTopology">拓扑与副本分布 <span class="count">{{ d.zones.length }} Zone · {{ d.tenants.length }} 租户</span></h3>
        <ClusterTopology :zones="d.zones" :servers="d.servers" :tenants="d.tenants" />
      </section>

      <section class="dt-section">
        <h3 data-src="clZones">Zone <span class="count">{{ d.zones.length }}</span></h3>
        <div class="zone-grid">
          <div v-for="z in d.zones" :key="z.name" class="zone">
            <div class="zone-top">
              <span class="dot" :class="z.status === 'ACTIVE' ? 'ok' : 'warn'"></span>
              <b>{{ z.name }}</b>
              <span class="zone-idc">{{ z.region }} / {{ z.idc }}</span>
            </div>
            <div class="zone-meta">
              <span>{{ z.serverCount }} 台 OBServer</span>
              <span v-if="z.rootServer" class="mono">RS {{ z.rootServer }}</span>
            </div>
          </div>
          <div v-if="!d.zones.length" class="empty-box">无 Zone 数据</div>
        </div>
      </section>

      <section class="dt-section">
        <h3>OBServer <span class="count">{{ d.servers.length }}</span></h3>
        <div class="table-wrap">
          <table class="tbl compact">
            <thead data-src="clServers"><tr><th>IP</th><th>Zone</th><th>进程状态</th><th>主机状态</th><th>RootServer</th><th>版本</th><th>启动时间</th></tr></thead>
            <tbody>
              <tr v-for="s in d.servers" :key="s.id">
                <td class="mono">{{ s.ip }}</td>
                <td>{{ s.zone }}</td>
                <td><span class="pill" :class="s.status === 'RUNNING' ? 'ok' : 'warn'">{{ s.status }}</span></td>
                <td><span class="pill" :class="s.hostStatus === 'ONLINE' ? 'ok' : 'bad'">{{ s.hostStatus }}</span></td>
                <td><span v-if="s.withRootserver" class="ro flag">是</span><span v-else class="dim">—</span></td>
                <td class="mono dim" :title="s.version">{{ s.version.slice(0, 24) }}</td>
                <td class="dim">{{ fmtTime(s.startTime) }}</td>
              </tr>
              <tr v-if="!d.servers.length"><td colspan="7" class="empty">无 OBServer</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="dt-section">
        <h3>租户 <span class="count">{{ d.tenants.length }}</span></h3>
        <div class="table-wrap">
          <table class="tbl compact">
            <thead data-src="clTenants"><tr><th>租户</th><th>模式</th><th>状态</th><th>主 Zone</th><th>副本分布</th><th>OB 租户 ID</th><th>创建时间</th></tr></thead>
            <tbody>
              <tr v-for="t in d.tenants" :key="t.id" class="clickable" @click="openTenant(t.clusterId, t.id)">
                <td class="cell-main">{{ t.name }}</td>
                <td><span class="pill" :class="t.mode === 'ORACLE' ? 'info' : 'gray'">{{ t.mode }}</span></td>
                <td><span class="pill" :class="tenantStatus(t.status).tone">{{ tenantStatus(t.status).label }}</span></td>
                <td class="mono dim">{{ t.primaryZone || '—' }}</td>
                <td class="dim ellipsis" :title="t.locality">{{ t.locality || '—' }}</td>
                <td class="mono dim">{{ t.obTenantId }}</td>
                <td class="dim">{{ fmtTime(t.createTime) }}</td>
              </tr>
              <tr v-if="!d.tenants.length"><td colspan="7" class="empty">无租户</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="dt-section">
        <h3 data-src="clParams">参数 <span class="count">全部租户 × 服务器 · 可修改</span></h3>
        <ClusterParams :cluster-id="d.cluster.id" />
      </section>

      <section v-if="d.startupParameters.length" class="dt-section" :data-ai="`clusters.params:${d.cluster.name}`">
        <h3 data-src="clStartup">启动参数 <span class="count">{{ d.startupParameters.length }}</span></h3>
        <div class="params">
          <div v-for="p in d.startupParameters" :key="p.key" class="param">
            <span class="param-k mono">{{ p.key }}</span>
            <span class="param-v mono">{{ p.value }}</span>
          </div>
        </div>
      </section>
    </template>

    <TenantCreate v-if="tenantCreate" @close="tenantCreate = false" />
    <ClusterCreate v-if="createOpen" @close="createOpen = false" />
    <div v-if="!d && cloud.clusterId" class="loading"><span class="spinner"></span>正在读取集群详情…</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import CapacityBar from './CapacityBar.vue'
import ClusterTopology from './ClusterTopology.vue'
import ClusterOps from './ClusterOps.vue'
import ClusterCreate from './ClusterCreate.vue'
import ClusterParams from './ClusterParams.vue'
import TenantCreate from './TenantCreate.vue'
import { cloud, openCluster, closeCluster, openTenant } from '../../cloud/state'
import {
  capacityTone, clusterMode, clusterStatus, fmtBytes, fmtTime, maybeTime, originLabel, tenantStatus
} from '../../cloud/parts'

const d = computed(() => cloud.cluster as CloudClusterDetail)
const tenantCreate = ref(false)
const createOpen = ref(false)

function worstTone(c: CloudCluster): string {
  const levels = c.alarms.levels.filter((x) => x.count > 0).map((x) => x.level)
  if (!levels.length) return 'ok'
  const min = Math.min(...levels)
  return min === 1 ? 'bad' : min === 2 ? 'warn' : 'info'
}
</script>

<style scoped>
.cp { display: flex; flex-direction: column; gap: 12px; }
.cp-head { display: flex; align-items: baseline; gap: 10px; }
.cp-head h2, .dt-section h3 { font-size: 12.5px; font-weight: 600; }
.count {
  font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 99px; padding: 0 6px; margin-left: 3px;
}
.hint { font-size: 11px; color: var(--text-faint); }

.table-wrap { border: 1px solid var(--border); border-radius: 11px; overflow: auto; background: var(--bg-card); }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th {
  text-align: left; font-weight: 500; font-size: 10.5px; color: var(--text-faint); letter-spacing: 0.4px;
  padding: 8px 10px; background: var(--bg-input); border-bottom: 1px solid var(--border); white-space: nowrap;
  position: sticky; top: 0; z-index: 1;
}
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl .r { text-align: right; }
.tbl.compact td { padding: 7px 10px; }
.tbl tbody tr.clickable { cursor: pointer; }
.tbl tbody tr.clickable:hover { background: var(--bg-card-hover); }
.cell-main { color: var(--text); font-weight: 550; }
.cell-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 1px; }
.mono { font-family: var(--mono); }
.dim { color: var(--text-dim); }
.ellipsis { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--text-faint); padding: 18px !important; }
.empty-box { padding: 16px; color: var(--text-faint); font-size: 12px; border: 1px dashed var(--border); border-radius: 10px; }
.pct { font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); margin-left: 6px; }
.pct.warn { color: var(--yellow); }
.pct.bad { color: var(--red); }

.pill {
  display: inline-block; font-size: 10.5px; padding: 1px 7px; border-radius: 99px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
}
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.pill.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.pill.gray { color: var(--text-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-faint); }
.dot.ok { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.dot.warn { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.dot.bad { background: var(--red); box-shadow: 0 0 0 3px var(--red-dim); }
.dot.info { background: var(--accent); }
.ro.flag { color: var(--accent); font-size: 11px; }

.dt-head { display: flex; align-items: flex-start; gap: 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.back {
  width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-input);
  color: var(--text-dim); cursor: pointer; font-size: 14px; line-height: 1; flex-shrink: 0; margin-top: 2px;
}
.back:hover { color: var(--accent); border-color: var(--accent); }
.dt-title { flex: 1; min-width: 0; }
.dt-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dt-name b { font-size: 15px; font-weight: 650; }
.dt-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 5px; font-size: 11px; color: var(--text-dim); }
.dt-meta b { font-weight: 600; color: var(--text); }
.dt-tools { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.dt-caps {
  display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap: 8px 22px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 9px 14px;
}
.mini {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 7px;
  font-size: 11.5px; padding: 3px 9px; cursor: pointer; font-family: inherit;
}
.mini.primary { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.mini:hover { filter: brightness(1.1); }


.attr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 6px; }
.attr { display: flex; align-items: center; gap: 8px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; min-width: 0; }
.attr-k { font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
.attr-v { font-size: 11px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dt-section { display: flex; flex-direction: column; gap: 7px; }
.zone-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px; }
.zone { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 9px 11px; }
.zone-top { display: flex; align-items: center; gap: 7px; }
.zone-top b { font-size: 12.5px; }
.zone-idc { margin-left: auto; font-size: 10.5px; color: var(--text-faint); }
.zone-meta { display: flex; gap: 10px; margin-top: 4px; font-size: 11px; color: var(--text-dim); }

.params { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 4px; }
.param { display: flex; gap: 8px; font-size: 11px; padding: 3px 8px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; }
.param-k { color: var(--text-faint); }
.param-v { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.loading { display: flex; align-items: center; justify-content: center; gap: 9px; color: var(--text-dim); font-size: 12.5px; padding: 40px 0; }
.spinner { width: 13px; height: 13px; border: 2px solid var(--accent-dim); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
