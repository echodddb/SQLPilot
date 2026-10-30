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
          <tr>
            <th>主机</th><th>IP</th><th>状态</th>
            <th v-if="!isDirect">Agent</th>
            <th>{{ isDirect ? 'Zone' : '类型' }}</th>
            <th v-if="!isDirect">区域 / IDC</th>
            <th>操作系统</th><th>承载服务</th><th class="r">SSH</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="h in filtered"
            :key="h.id"
            class="clickable"
            :class="{ picked: isSessionOpen(h.ip) }"
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
            <!-- Agent 是 OCP 的概念，直连没有，整列不渲染 -->
            <td v-if="!isDirect" data-src="htAgent" :data-host="h.ip">
              <span class="agent" :class="h.agentStatus === 'AVAILABLE' ? 'ok' : 'warn'" :title="h.agentVersion || ''">
                <i class="dot"></i>{{ agentStatus(h.agentStatus).label }}
              </span>
            </td>
            <td class="dim">
              <template v-if="isDirect"><span class="mono">{{ h.zone || '—' }}</span></template>
              <template v-else>{{ h.typeName || hostKind(h.kind) }}</template>
            </td>
            <td v-if="!isDirect" class="dim" data-src="htHost" :data-host="h.ip">{{ h.region || '—' }}<span class="sep">/</span>{{ h.idc || '—' }}</td>
            <td class="mono dim ellipsis os-col" :title="osTitle(h)">
              <template v-if="osOf(h)">{{ osOf(h) }}</template>
              <button v-else-if="isDirect" class="os-miss" :disabled="!hasCred(h)" @click.stop="collectOs(h)">未采集</button>
              <template v-else>—</template>
            </td>
            <td class="svc-col" data-src="htService" :data-host="h.ip">
              <div class="svc-list">
                <span v-for="s in h.services" :key="s.name" class="svc" :class="s.type === 'OB_CLUSTER' ? 'ob' : 'proxy'" :title="`${s.name} ${s.version}`">
                  {{ serviceLabel(s.type) }}<em v-if="s.type === 'OB_CLUSTER'">{{ s.name.split(':')[0] }}</em>
                </span>
                <span v-if="!h.services.length" class="dim">—</span>
              </div>
            </td>
            <td class="r">
              <div class="ssh-cell" @click.stop>
                <span class="mono dim">{{ h.sshPort || 22 }}</span>
                <button
                  class="ssh-btn"
                  :class="{ on: isSessionOpen(h.ip) }"
                  :title="`在窗口底部打开 ${h.ip} 的 SSH 终端（可同时开多个）`"
                  @click="openSsh(h)"
                >终端</button>
              </div>
            </td>
          </tr>
          <tr v-if="!filtered.length"><td :colspan="isDirect ? 7 : 9" class="empty">没有匹配的主机</td></tr>
        </tbody>
      </table>
    </div>
  </div>
  <HostDrawer v-if="cloud.host" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import HostDrawer from './HostDrawer.vue'
import { activePlatform, cloud, openHost } from '../../cloud/state'
import { platformOfCluster } from '../../cloud/directTenant'
import { openHostSsh } from '../../cloud/hostSsh'
import { agentStatus, hostKind, hostStatus, serviceLabel } from '../../cloud/parts'

const q = ref('')
const st = ref('')

/** 直连模式：列结构不同（没有 Agent / 机型 / IDC，改看 Zone 与系统信息） */
const isDirect = computed(() => cloud.access === 'direct' || activePlatform()?.type === 'obdirect')

/** 已采集的系统信息（直连下 OS 只能从主机取，采到即有缓存） */
function osOf(h: CloudHost): string {
  const s = cloud.hostSys[h.ip]
  if (s) return s.osPretty || s.osName || ''
  return isDirect.value ? '' : h.os
}
function osTitle(h: CloudHost): string {
  const s = cloud.hostSys[h.ip]
  if (!s) return isDirect.value ? '未采集：打开主机详情或点这里，经 SSH 读取系统信息' : h.os || ''
  return [s.osPretty, s.kernel, s.cpuModel && `${s.cpuModel}`, s.cores && `${s.cores} 核`].filter(Boolean).join(' · ')
}

const sshMap = ref<Record<string, { user: string }>>({})
function hasCred(h: CloudHost): boolean {
  return !!sshMap.value[h.ip]
}

async function loadSshMap(): Promise<void> {
  const pid = activePlatform()?.type === 'obdirect' ? activePlatform()!.id : ''
  if (!pid) return
  const r = await window.sqlpilot.cloudHostSshStatus(pid)
  if (r.ok && r.data) sshMap.value = r.data
}

async function collectOs(h: CloudHost): Promise<void> {
  const pid = activePlatform()?.type === 'obdirect' ? activePlatform()!.id : ''
  if (!pid) return
  const r = await window.sqlpilot.cloudHostSysInfo(pid, h.ip)
  if (r.ok && r.data) cloud.hostSys = { ...cloud.hostSys, [h.ip]: r.data }
}

onMounted(() => { void loadSshMap() })

/**
 * 打开某台主机的 SSH：加入分窗会话列表（同一 IP 只保留一个），已存在则切到它。
 * 这里只负责定位"这台主机属于哪个直连平台"。
 */
function openSsh(h: CloudHost): void {
  const pid = platformOfCluster(h.clusters.length ? clusterIdOf(h) : 0) || activePlatform()?.id || ''
  openHostSsh(pid, h.ip, h.clusters[0] || '', h.sshPort || 22)
}

/** 该主机是否已有打开的终端会话（用于按钮/行高亮） */
function isSessionOpen(ip: string): boolean {
  return cloud.hostSshSessions.some((s) => s.ip === ip)
}

/** 主机上挂的集群名 → 集群 id（用于反查平台） */
function clusterIdOf(h: CloudHost): number {
  const name = h.clusters[0]
  return cloud.clusters.find((c) => c.name === name)?.id || 0
}

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

/* SSH 操作列 */
.ssh-cell { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
.ssh-btn {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 1px 8px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.ssh-btn:hover { color: var(--accent); border-color: var(--accent); }
.ssh-btn.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.tbl tbody tr.picked { background: var(--accent-dim); }
/* 未采集：可点的小按钮，没有凭据时置灰 */
.os-miss {
  border: 1px dashed var(--border); background: none; color: var(--text-faint);
  border-radius: 5px; padding: 0 6px; font-size: 10px; font-family: inherit; cursor: pointer;
}
.os-miss:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.os-miss:disabled { cursor: not-allowed; opacity: 0.6; }
</style>
