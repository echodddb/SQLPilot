<template>
  <div class="hp">
    <div class="hp-head">
      <h2>主机 <span class="count">{{ filtered.length }}</span></h2>
      <div class="filters">
        <input v-model="q" class="search" placeholder="搜索 IP / 主机名 / 集群" spellcheck="false" />
        <select v-model="st">
          <option value="">全部状态</option>
          <option value="ONLINE">在线</option>
          <option value="OFFLINE">离线</option>
          <option value="AGENT">Agent 异常</option>
        </select>
      </div>
    </div>

    <div class="table-wrap" data-ai="hosts.list">
      <table class="tbl">
        <thead data-src="htList">
          <tr><th>主机</th><th>IP</th><th>状态</th><th>Agent</th><th>类型</th><th>区域 / IDC</th><th>操作系统</th><th>承载服务</th><th class="r">SSH</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="h in filtered"
            :key="h.id"
            class="clickable"
            :data-ai="`hosts.list:${h.ip}`"
            :data-ai-name="h.ip"
            @click="openHost(h)"
          >
            <td data-src="htList" :data-host="h.ip">
              <div class="cell-main">{{ h.alias || h.name }}</div>
              <div class="cell-sub">{{ h.name }}</div>
            </td>
            <td class="mono">{{ h.ip }}</td>
            <td><span class="pill" :class="hostStatus(h.status).tone">{{ hostStatus(h.status).label }}</span></td>
            <td data-src="htAgent" :data-host="h.ip">
              <span class="agent" :class="h.agentStatus === 'AVAILABLE' ? 'ok' : 'warn'" :title="h.agentVersion || ''">
                <i class="dot"></i>{{ agentStatus(h.agentStatus).label }}
              </span>
            </td>
            <td class="dim">{{ h.typeName || hostKind(h.kind) }}</td>
            <td class="dim" data-src="htHost" :data-host="h.ip">{{ h.region || '—' }}<span class="sep">/</span>{{ h.idc || '—' }}</td>
            <td class="mono dim ellipsis os-col" :title="h.os">{{ h.os || '—' }}</td>
            <td class="svc-col" data-src="htService" :data-host="h.ip">
              <div class="svc-list">
                <span v-for="s in h.services" :key="s.name" class="svc" :class="s.type === 'OB_CLUSTER' ? 'ob' : 'proxy'" :title="`${s.name} ${s.version}`">
                  {{ serviceLabel(s.type) }}<em v-if="s.type === 'OB_CLUSTER'">{{ s.name.split(':')[0] }}</em>
                </span>
                <span v-if="!h.services.length" class="dim">—</span>
              </div>
            </td>
            <td class="r mono dim">{{ h.sshPort || '—' }}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="9" class="empty">没有匹配的主机</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <HostDrawer v-if="cloud.host" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import HostDrawer from './HostDrawer.vue'
import { cloud, openHost } from '../../cloud/state'
import { agentStatus, hostKind, hostStatus, serviceLabel } from '../../cloud/parts'

const q = ref('')
const st = ref('')

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  return cloud.hosts.filter((h) => {
    if (st.value === 'ONLINE' && h.status !== 'ONLINE') return false
    if (st.value === 'OFFLINE' && h.status === 'ONLINE') return false
    if (st.value === 'AGENT' && h.agentStatus === 'AVAILABLE') return false
    if (!k) return true
    return `${h.ip} ${h.name} ${h.alias} ${h.clusters.join(' ')} ${h.obproxies.join(' ')}`.toLowerCase().includes(k)
  })
})
</script>

<style scoped>
.hp { display: flex; flex-direction: column; gap: 10px; }
.hp-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.hp-head h2 { font-size: 12.5px; font-weight: 600; }
.count { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: 99px; padding: 0 6px; margin-left: 3px; }
.filters { margin-left: auto; display: flex; gap: 6px; }
.search { width: 200px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 9px; outline: none; }
.search:focus { border-color: var(--accent); }
select { background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 8px; outline: none; }
.table-wrap { border: 1px solid var(--border); border-radius: 11px; overflow: auto; background: var(--bg-card); }
.tbl { width: 100%; min-width: 1040px; border-collapse: collapse; font-size: 12px; }
.tbl th { text-align: left; font-weight: 500; font-size: 10.5px; color: var(--text-faint); letter-spacing: 0.4px; padding: 8px 10px; background: var(--bg-input); border-bottom: 1px solid var(--border); white-space: nowrap; position: sticky; top: 0; }
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl tbody tr:hover { background: var(--bg-card-hover); }
.tbl tbody tr.clickable { cursor: pointer; }
.tbl .r { text-align: right; }
.cell-main { font-weight: 550; }
.cell-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 1px; }
.mono { font-family: var(--mono); }
.dim { color: var(--text-dim); }
.ellipsis { max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
.os-col { max-width: 150px; }
.svc-col { min-width: 132px; white-space: normal !important; }
.sep { color: var(--text-faint); margin: 0 3px; }
.empty { text-align: center; color: var(--text-faint); padding: 20px !important; }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.pill.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.agent { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
.agent .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); }
.agent.warn { color: var(--yellow); }
.agent.warn .dot { background: var(--yellow); }
/* 承载服务：一列文字（窄列也不裁切），OB 服务用点色区分 */
.svc-list { display: flex; flex-direction: column; gap: 2px; }
.svc { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-dim); }
.svc::before { content: ''; width: 4px; height: 4px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.svc.ob { color: var(--accent); }
.svc.ob::before { background: var(--accent); }
.svc em { font-style: normal; font-family: var(--mono); color: var(--text-faint); }
</style>
