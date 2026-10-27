<template>
  <div class="drawer-mask" @click.self="closeHost">
    <aside class="drawer">
      <header class="dw-head">
        <div class="dw-id">
          <div class="dw-title">
            <span class="dot" :class="hostStatus(h.status).tone"></span>
            <b>{{ h.alias || h.name }}</b>
            <span class="pill" :class="hostStatus(h.status).tone">{{ hostStatus(h.status).label }}</span>
            <span class="pill" :class="h.agentStatus === 'AVAILABLE' ? 'ok' : 'warn'">Agent {{ agentStatus(h.agentStatus).label }}</span>
          </div>
          <div class="dw-sub mono">{{ h.ip }}<span class="sep">·</span>{{ h.os || '—' }}</div>
        </div>
        <button class="x" @click="closeHost">✕</button>
      </header>

      <div class="dw-actions">
        <button class="act" @click="copyIp">复制 IP</button>
        <button class="act" @click="goMonitor">看该主机监控</button>
        <span class="sp"></span>
        <button class="act" :disabled="!h.clusters.length" @click="goCluster">所属集群</button>
      </div>

      <div class="dw-body">
        <h4>基本信息</h4>
        <div class="kv-grid">
          <div class="kv"><span>主机名</span><b class="mono">{{ h.name }}</b></div>
          <div class="kv"><span>别名</span><b>{{ h.alias || '—' }}</b></div>
          <div class="kv"><span>IP</span><b class="mono">{{ h.ip }}</b></div>
          <div class="kv"><span>SSH 端口</span><b class="mono">{{ h.sshPort || '—' }}</b></div>
          <div class="kv"><span>机型</span><b>{{ h.typeName || hostKind(h.kind) }}</b></div>
          <div class="kv"><span>区域 / IDC</span><b>{{ h.region || '—' }} / {{ h.idc || '—' }}</b></div>
          <div class="kv wide"><span>操作系统</span><b class="mono ellipsis" :title="h.os">{{ h.os || '—' }}</b></div>
          <div class="kv"><span>纳管时间</span><b>{{ fmtTime(h.createTime) }}</b></div>
        </div>

        <h4>OCP-Agent</h4>
        <div class="kv-grid">
          <div class="kv"><span>状态</span><b :class="h.agentStatus === 'AVAILABLE' ? 'ok-t' : 'warn-t'">{{ agentStatus(h.agentStatus).label }}</b></div>
          <div class="kv"><span>版本</span><b class="mono">{{ h.agentVersion || '—' }}</b></div>
        </div>
        <div v-if="h.agentStatus !== 'AVAILABLE'" class="hint-warn">
          Agent 心跳异常。OBServer 的启停、参数下发都依赖 Agent，此时对该主机的运维动作会失败。
        </div>

        <h4>承载服务 <span class="count">{{ h.services.length }}</span></h4>
        <div v-if="h.services.length" class="svc-list">
          <div v-for="s in h.services" :key="`${s.type}-${s.name}`" class="svc">
            <span class="svc-type" :class="s.type === 'OB_CLUSTER' ? 'ob' : 'proxy'">{{ serviceLabel(s.type) }}</span>
            <span class="svc-name mono">{{ s.name }}</span>
            <span class="svc-ver mono">{{ s.version }}</span>
          </div>
        </div>
        <div v-else class="empty">该主机上没有 OBServer / OBProxy 实例</div>

        <h4>关联集群</h4>
        <div class="chips">
          <span v-for="c in h.clusters" :key="c" class="chip" :class="{ link: clusterIdOf(c) }" @click="openClusterByName(c)">{{ c }}</span>
          <span v-for="p in h.obproxies" :key="p" class="chip proxy">{{ p }}</span>
          <span v-if="!h.clusters.length && !h.obproxies.length" class="dim">无</span>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * 主机详情抽屉：信息取自 hosts 列表（不额外请求 OCP），
 * 提供复制 IP、跳该主机监控、跳到所属集群详情。
 */
import { computed } from 'vue'
import { cloud, closeHost, openCluster, setView, setMonitorEntity, setMonitorScope } from '../../cloud/state'
import { agentStatus, fmtTime, hostKind, hostStatus, serviceLabel } from '../../cloud/parts'
import { pushNotice } from '../../store'

const h = computed(() => cloud.host as CloudHost)

/** 承载服务名形如 obc:1781434603，冒号前是集群名 */
function clusterIdOf(svcName: string): number | null {
  const name = svcName.split(':')[0]
  return cloud.clusters.find((c) => c.name === name)?.id ?? null
}

function openClusterByName(svcName: string): void {
  const id = clusterIdOf(svcName)
  if (id === null) return
  closeHost()
  cloud.view = 'clusters'
  void openCluster(id)
}

async function copyIp(): Promise<void> {
  await window.sqlpilot.writeClipboard(h.value.ip)
  pushNotice(`已复制 ${h.value.ip}`)
}

async function goMonitor(): Promise<void> {
  const id = h.value.id
  closeHost()
  void setView('monitor')
  await setMonitorScope('HOST')
  await setMonitorEntity(`h${id}`)
}

function goCluster(): void {
  const svc = h.value.services.find((s) => s.type === 'OB_CLUSTER')
  if (svc) openClusterByName(svc.name)
}
</script>

<style scoped>
.drawer-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 800;
  display: flex; justify-content: flex-end; backdrop-filter: blur(1px);
  /* 面板从原生窗口按钮区（- □ ×）以下开始，头部 ✕ 才点得到 */
  padding-top: var(--titlebar-h);
}
.drawer {
  width: 560px; max-width: 94vw; height: 100%; background: var(--bg-side);
  border-left: 1px solid var(--border-strong); display: flex; flex-direction: column;
  box-shadow: var(--shadow-lg);
}
.dw-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--border); }
.dw-id { flex: 1; min-width: 0; }
.dw-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dw-title b { font-size: 15px; font-weight: 650; }
.dw-sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.sep { margin: 0 6px; color: var(--text-faint); }
.x { border: none; background: none; color: var(--text-faint); font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.x:hover { color: var(--text); background: var(--bg-input); }

.dw-actions { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
.act {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.act:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.act:disabled { opacity: 0.45; cursor: not-allowed; }
.sp { flex: 1; }

.dw-body { flex: 1; overflow: auto; padding: 12px 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.dw-body h4 { font-size: 12px; font-weight: 600; margin: 6px 0 2px; display: flex; align-items: center; gap: 6px; }
.count { font-family: var(--mono); font-size: 10px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: 99px; padding: 0 6px; }
.kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.kv {
  display: flex; flex-direction: column; gap: 1px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; min-width: 0;
}
.kv.wide { grid-column: 1 / -1; }
.kv span { font-size: 10px; color: var(--text-faint); }
.kv b { font-size: 11.5px; font-weight: 550; color: var(--text); }
.kv b.ok-t { color: var(--green); }
.kv b.warn-t { color: var(--yellow); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.hint-warn {
  font-size: 11px; color: var(--yellow); background: var(--yellow-dim);
  border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent); border-radius: 7px; padding: 6px 9px;
}

.svc-list { display: flex; flex-direction: column; gap: 3px; }
.svc {
  display: flex; align-items: center; gap: 8px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px; font-size: 11px;
}
.svc-type { font-size: 9.5px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border); color: var(--text-dim); }
.svc-type.ob { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-dim); }
.svc-type.proxy { color: var(--text-dim); }
.svc-name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc-ver { color: var(--text-faint); font-size: 10px; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 10.5px; padding: 1px 8px; border-radius: 99px; background: var(--bg-input);
  border: 1px solid var(--border); color: var(--text-dim); font-family: var(--mono);
}
.chip.link { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); cursor: pointer; }
.chip.link:hover { background: var(--accent-dim); }
.chip.proxy { color: var(--text-faint); }
.empty { font-size: 11.5px; color: var(--text-faint); padding: 8px 2px; }
.dim { color: var(--text-faint); font-size: 11px; }
.pill { display: inline-block; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.dot.ok { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.dot.warn { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.dot.bad { background: var(--red); box-shadow: 0 0 0 3px var(--red-dim); }
.mono { font-family: var(--mono); }
</style>
