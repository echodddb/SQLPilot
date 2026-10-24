<template>
  <div class="topo">
    <!-- 左：Zone → OBServer 拓扑 -->
    <div class="zones">
      <div v-for="z in zones" :key="z.name" class="zcol">
        <div class="zhead">
          <span class="dot" :class="zoneOk(z.status) ? 'ok' : 'warn'"></span>
          <b>{{ z.name }}</b>
          <span class="zidc" :title="`${z.region} / ${z.idc}`">{{ z.region || '—' }} / {{ z.idc || '—' }}</span>
        </div>
        <div class="znodes">
          <div v-for="s in serversIn(z.name)" :key="s.id" class="node" :class="{ bad: !zoneOk(s.status), warn: s.hostStatus !== 'ONLINE' }">
            <div class="n-top">
              <span class="n-ip mono">{{ s.ip }}</span>
              <span v-if="s.withRootserver" class="rs" title="RootServer 所在节点">RS</span>
            </div>
            <div class="n-meta">
              <span class="n-st">{{ s.status }}</span>
              <span v-if="s.hostStatus !== 'ONLINE'" class="n-host">主机 {{ s.hostStatus }}</span>
            </div>
          </div>
          <div v-if="!serversIn(z.name).length" class="node none">无 OBServer</div>
        </div>
      </div>
      <div v-if="!zones.length" class="empty">无 Zone 数据</div>
    </div>

    <!-- 右：租户副本矩阵 -->
    <div class="matrix">
      <div class="mx-head">
        <b>租户副本分布</b>
        <span class="mx-legend">
          <i class="lg full"></i>FULL
          <i class="lg ro"></i>READONLY
          <i class="lg log"></i>LOGONLY
          <i class="lg miss"></i>该 Zone 无副本
        </span>
      </div>
      <div class="mx-body">
        <table class="mtbl">
          <thead>
            <tr>
              <th class="c-name">租户</th>
              <th v-for="z in zones" :key="z.name" class="c-zone">{{ z.name }}</th>
              <th class="c-cnt">副本</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in businessTenants" :key="t.id">
              <td class="c-name">
                <span class="tname">{{ t.name }}</span>
                <span class="tmode" :class="t.mode === 'ORACLE' ? 'oracle' : ''">{{ t.mode }}</span>
                <span v-if="t.status !== 'NORMAL'" class="tbad">{{ tenantLabel(t.status) }}</span>
              </td>
              <td v-for="z in zones" :key="z.name" class="c-zone">
                <span class="rep" :class="repTone(replicaOf(t.locality, z.name))">{{ replicaOf(t.locality, z.name) || '—' }}</span>
              </td>
              <td class="c-cnt mono" :class="{ short: replicaCount(t.locality) < zones.length }">{{ replicaCount(t.locality) }}</td>
            </tr>
            <tr v-if="!businessTenants.length">
              <td :colspan="zones.length + 2" class="empty">该集群还没有业务租户</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 集群拓扑：左边按 Zone 列出 OBServer（进程状态 / 主机状态 / RootServer），
 * 右边是租户 × Zone 的副本矩阵（FULL / READONLY / LOGONLY），一眼看出副本是否跨 Zone 齐全。
 * 数据全部来自集群详情接口，不额外请求。
 */
import { computed } from 'vue'
import { tenantStatus } from '../../cloud/parts'

const props = defineProps<{
  zones: { name: string; idc: string; region: string; status: string; serverCount: number; rootServer: string }[]
  servers: { id: number; ip: string; zone: string; status: string; hostStatus: string; withRootserver: boolean; version: string; startTime: string }[]
  tenants: CloudTenant[]
}>()

const tenantLabel = (s: string): string => tenantStatus(s).label

/** Zone 用 ACTIVE、OBServer 用 RUNNING，两种都算正常 */
function zoneOk(status: string): boolean {
  return status === 'ACTIVE' || status === 'RUNNING'
}

/** sys / 内部租户不参与业务副本矩阵 */
const businessTenants = computed(() =>
  props.tenants.filter((t) => t.name !== 'sys' && !t.name.startsWith('META$'))
)

function serversIn(zone: string) {
  return props.servers.filter((s) => s.zone === zone)
}

interface Replica {
  type: string
  zone: string
}

/** 解析 locality：FULL{1}@zone1,READONLY{1}@zone2（也兼容旧的 R{1}@zone 写法） */
function parseLocality(loc: string): Replica[] {
  if (!loc) return []
  const out: Replica[] = []
  for (const seg of loc.split(',')) {
    const m = seg.trim().match(/^([A-Za-z_]+)(?:\{\d+\})?@(.+)$/)
    if (!m) continue
    const raw = m[1].toUpperCase()
    const type = raw === 'R' ? 'FULL' : raw === 'RO' ? 'READONLY' : raw
    out.push({ type, zone: m[2].trim() })
  }
  return out
}

function replicaOf(loc: string, zone: string): string {
  return parseLocality(loc).find((r) => r.zone === zone)?.type || ''
}

function replicaCount(loc: string): number {
  return parseLocality(loc).length
}

function repTone(type: string): string {
  if (!type) return 'miss'
  if (type === 'FULL') return 'full'
  if (type === 'READONLY') return 'ro'
  return 'log'
}
</script>

<style scoped>
.topo { display: grid; grid-template-columns: minmax(300px, 0.85fr) minmax(340px, 1.15fr); gap: 10px; align-items: start; }
@media (max-width: 1100px) { .topo { grid-template-columns: 1fr; } }

/* Zone 列 */
.zones { display: flex; gap: 8px; align-items: stretch; }
.zcol {
  flex: 1; min-width: 0; background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.zhead { display: flex; align-items: center; gap: 6px; padding-bottom: 6px; border-bottom: 1px dashed var(--border); }
.zhead b { font-size: 12px; }
.zidc { margin-left: auto; font-size: 9.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px; }
.znodes { display: flex; flex-direction: column; gap: 5px; }
.node {
  background: var(--bg-input); border: 1px solid var(--border); border-left: 2px solid var(--green);
  border-radius: 6px; padding: 5px 7px;
}
.node.warn { border-left-color: var(--yellow); }
.node.bad { border-left-color: var(--red); }
.node.none { border-left-color: var(--border-strong); color: var(--text-faint); font-size: 10.5px; text-align: center; padding: 8px 4px; }
.n-top { display: flex; align-items: center; gap: 5px; }
.n-ip { font-size: 11px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs {
  margin-left: auto; font-size: 8.5px; font-weight: 700; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 3px; padding: 0 3px; flex-shrink: 0;
}
.n-meta { display: flex; gap: 5px; margin-top: 2px; font-size: 9.5px; color: var(--text-faint); }
.n-host { color: var(--yellow); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.dot.ok { background: var(--green); box-shadow: 0 0 0 2px var(--green-dim); }
.dot.warn { background: var(--yellow); box-shadow: 0 0 0 2px var(--yellow-dim); }

/* 副本矩阵 */
.matrix { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.mx-head { display: flex; align-items: center; gap: 10px; padding: 8px 11px 6px; border-bottom: 1px solid var(--border); }
.mx-head b { font-size: 12px; }
.mx-legend { margin-left: auto; display: flex; align-items: center; gap: 4px; font-size: 9.5px; color: var(--text-faint); }
.lg { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.lg.full { background: var(--green); }
.lg.ro { background: var(--accent); }
.lg.log { background: var(--yellow); }
.lg.miss { background: transparent; border: 1px dashed var(--border-strong); }
.mx-body { max-height: 260px; overflow: auto; }
.mtbl { width: 100%; border-collapse: collapse; font-size: 11px; }
.mtbl th {
  position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 500; font-size: 9.5px;
  color: var(--text-faint); background: var(--bg-input); border-bottom: 1px solid var(--border);
  padding: 5px 8px; white-space: nowrap;
}
.mtbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.mtbl tbody tr:last-child td { border-bottom: none; }
.mtbl tbody tr:hover { background: var(--bg-card-hover); }
.c-name { min-width: 120px; }
.tname { color: var(--text); }
.tmode { margin-left: 5px; font-size: 9px; color: var(--text-faint); }
.tmode.oracle { color: var(--accent); }
.tbad { margin-left: 5px; font-size: 9px; color: var(--yellow); }
.c-zone { text-align: center; }
.c-cnt { text-align: right; color: var(--text-dim); }
.c-cnt.short { color: var(--yellow); }
.rep {
  display: inline-block; font-size: 9.5px; font-family: var(--mono); border-radius: 3px;
  padding: 0 5px; border: 1px solid transparent;
}
.rep.full { color: var(--green); background: var(--green-dim); border-color: color-mix(in srgb, var(--green) 35%, transparent); }
.rep.ro { color: var(--accent); background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.rep.log { color: var(--yellow); background: var(--yellow-dim); border-color: color-mix(in srgb, var(--yellow) 35%, transparent); }
.rep.miss { color: var(--text-faint); border-style: dashed; border-color: var(--border-strong); background: transparent; }
.empty { text-align: center; color: var(--text-faint); font-size: 11px; padding: 14px; }
.mono { font-family: var(--mono); }
</style>
