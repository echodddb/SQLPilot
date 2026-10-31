<template>
  <aside v-if="asset" class="cd-root">
    <div class="cd-head">
      <span class="cd-glyph" :class="`k-${kind}`">{{ typeGlyph(asset.type) }}</span>
      <div class="cd-title">
        <div class="cd-name" :title="asset.name">{{ asset.name }}</div>
        <div class="cd-sub">{{ typeName(asset.type) }} · <span :class="`st-${asset.status}`">{{ statusName(asset.status) }}</span></div>
      </div>
      <button class="cm-close" title="关闭详情" @click="cm.selected = ''">✕</button>
    </div>

    <div class="cd-body">
      <section class="cd-sec">
        <div class="cd-kv"><span>客户</span><b>{{ customerName }}</b></div>
        <div class="cd-kv"><span>机房</span><b>{{ idcName }}</b></div>
        <div class="cd-kv"><span>机柜 / U</span><b>{{ rackLabel }}</b></div>
        <div class="cd-kv"><span>IP</span><b class="mono">{{ asset.ips.join(', ') || '—' }}</b></div>
        <div v-if="asset.hostname" class="cd-kv"><span>主机名</span><b class="mono">{{ asset.hostname }}</b></div>
        <div v-if="asset.os" class="cd-kv"><span>OS</span><b>{{ asset.os }}</b></div>
        <div v-if="asset.vendor || asset.model" class="cd-kv"><span>厂商型号</span><b>{{ [asset.vendor, asset.model].filter(Boolean).join(' ') }}</b></div>
        <div v-if="asset.sn" class="cd-kv"><span>序列号</span><b class="mono">{{ asset.sn }}</b></div>
        <div v-if="specName" class="cd-kv"><span>规格</span><b>{{ specName }}</b></div>
        <div v-if="roleName" class="cd-kv"><span>用途</span><b>{{ roleName }}</b></div>
        <div v-if="archName" class="cd-kv">
          <span>架构</span>
          <b>
            <i class="cd-arch-dot" :style="{ background: archColor }"></i>{{ archName }}<template v-if="asset.archGroup"> · {{ asset.archGroup }}</template>
          </b>
        </div>
        <div v-if="asset.owner" class="cd-kv"><span>负责人</span><b>{{ asset.owner }}</b></div>
        <div v-if="asset.tags.length" class="cd-kv">
          <span>标签</span>
          <b><span v-for="t in asset.tags" :key="t" class="cm-chip" style="margin-right: 4px">{{ t }}</span></b>
        </div>
        <div v-if="asset.note" class="cd-note">{{ asset.note }}</div>
      </section>

      <section v-if="portGroups.length" class="cd-sec">
        <div class="cd-sec-head">
          <span>硬件端口</span>
          <button class="cm-mini" title="按住 Alt 在 3D 里从这台设备拖到另一台即可接线" @click="startCable">＋ 接线</button>
        </div>
        <div v-for="g in portGroups" :key="g.group" class="cd-port-grp">
          <span class="cd-port-name">{{ g.name }}</span>
          <span class="cd-port-cells">
            <i
              v-for="p in g.ports"
              :key="p.id"
              class="cd-port"
              :class="{ used: !!p.net }"
              :style="p.net ? { background: netColor(p.net, dark), borderColor: netColor(p.net, dark) } : {}"
              :title="`${p.label}${p.net ? ' · ' + netName(p.net) : ' · 空闲'}`"
            ></i>
          </span>
        </div>
      </section>

      <section v-if="cables.length" class="cd-sec">
        <div class="cd-sec-head"><span>网线 {{ cables.length }}</span></div>
        <div v-for="c in cables" :key="c.id" class="cd-rel" @click="jump(c.toId === asset.id ? c.fromId : c.toId)">
          <i :style="{ background: netColor(c.net, dark) }"></i>
          <span class="cd-rel-kind" :style="{ color: netColor(c.net, dark) }">{{ netName(c.net) }}</span>
          <span class="cd-rel-dir">{{ c.dir === 'out' ? '→' : '←' }}</span>
          <span class="cd-rel-name">{{ c.toName }}<span class="cd-port-tag">{{ c.dir === 'out' ? c.fromPort : c.toPort }} → {{ c.dir === 'out' ? c.toPort : c.fromPort }}</span></span>
          <button class="cd-x" title="拔掉这根线" @click.stop="unplug(c.id)">✕</button>
        </div>
      </section>

      <section class="cd-sec">
        <div class="cd-sec-head">
          <span>关系 {{ rels.length }}</span>
          <button class="cm-mini" title="在图谱里选中它，然后按住 Alt 从节点拖到目标即可连线" @click="startLink">＋ 连线</button>
        </div>
        <div v-if="!rels.length" class="cd-empty">还没有关系。在 3D 视图里按住 Alt 从这个节点拖到目标节点。</div>
        <div v-for="r in rels" :key="r.id" class="cd-rel" @click="jump(r.otherId)">
          <i :style="{ background: relColor(r.kind, dark) }"></i>
          <span class="cd-rel-kind" :style="{ color: relColor(r.kind, dark) }">{{ relKindName(r.kind) }}</span>
          <span class="cd-rel-dir">{{ r.dir === 'out' ? '→' : '←' }}</span>
          <span class="cd-rel-name">{{ r.otherName }}</span>
          <span class="cd-rel-label">{{ r.label }}</span>
          <button class="cd-x" title="断开这条关系" @click.stop="drop(r.id)">✕</button>
        </div>
      </section>

      <section class="cd-sec">
        <div class="cd-sec-head"><span>操作</span></div>
        <div class="cd-acts">
          <button class="cm-mini" @click="emit('edit', asset.id)">编辑</button>
          <button v-if="asset.linkServerId" class="cm-mini" @click="openTerm">打开终端</button>
          <button v-if="asset.linkConnId" class="cm-mini" @click="openConsole">SQL 控制台</button>
          <button class="cm-mini" title="把资产与关系整理成上下文，填进当前 AI 会话的输入框" @click="askAi">问 AI</button>
          <button v-if="asset.idcId" class="cm-mini" @click="focusInGraph">图里定位</button>
          <button class="cm-mini danger" @click="remove">移入回收站</button>
        </div>
        <div v-if="!asset.linkServerId" class="cm-hint" style="margin-top: 6px">
          在「编辑」里关联 SSH 服务器 / 数据库连接后，这里会直接出现「打开终端」「SQL 控制台」。
        </div>
      </section>

      <section v-if="logs.length" class="cd-sec">
        <div class="cd-sec-head"><span>变更历史</span></div>
        <div v-for="l in logs.slice(0, 8)" :key="l.ts + l.action" class="cd-log">
          <span class="cd-log-t">{{ fmtTs(l.ts) }}</span>
          <span class="cd-log-d">{{ l.detail }}</span>
        </div>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { cm, persistView, customers, deleteAsset, deleteCable, deleteRelation, idcs, racks, relationsOf, toast } from '../../cmdb/state'
import { ARCHS, NETWORKS, ROLES, assetTypeOf, netColor, relColor, relKindName, specOf, statusName, typeGlyph, typeName } from '../../cmdb/dict'
import { cablesOf, portsOf } from '../../../main/cmdb-model'
import { isDarkTheme } from '../../cmdb/theme'
import { store, openDbTask, openServerTask } from '../../store'

const emit = defineEmits<{ (e: 'edit', id: string): void }>()

const dark = isDarkTheme()
const asset = computed(() => cm.doc?.assets.find((a) => a.id === cm.selected) || null)

const rels = computed(() => (asset.value ? relationsOf(asset.value.id) : []))
const customerName = computed(() => customers.value.find((c) => c.id === asset.value?.customerId)?.name || '未归属')
const idcName = computed(() => idcs.value.find((d) => d.id === asset.value?.idcId)?.name || '未指定')
const rackLabel = computed(() => {
  const r = racks.value.find((x) => x.id === asset.value?.rackId)
  if (!r) return '未上架'
  return `${r.code}${asset.value?.u ? ` U${asset.value.u}` : ''}`
})
const kind = computed(() => assetTypeOf(asset.value?.type || '').kind)
const specName = computed(() => specOf(asset.value?.spec)?.name || '')
const roleName = computed(() => ROLES.find((r) => r.id === asset.value?.role)?.name || '')
const archName = computed(() => ARCHS.find((a) => a.id === asset.value?.arch)?.name || '')
const archColor = computed(() => {
  const a = ARCHS.find((x) => x.id === asset.value?.arch)
  return a ? (dark ? a.colorDark : a.color) : 'transparent'
})

const cables = computed(() => (cm.doc && asset.value ? cablesOf(cm.doc, asset.value.id) : []))

/** 端口分组 + 每个口当前插的网线（颜色 = 网络类型），一眼看出哪几个口还没用 */
const portGroups = computed(() => {
  if (!asset.value) return []
  const list = portsOf(asset.value)
  const usedBy = new Map<string, string>()
  for (const c of cm.doc?.cables || []) {
    if (c.fromId === asset.value.id) usedBy.set(c.fromPort, c.net)
    if (c.toId === asset.value.id) usedBy.set(c.toPort, c.net)
  }
  const groups: { group: string; name: string; ports: { id: string; label: string; net?: string }[] }[] = []
  const nameOf: Record<string, string> = { nic: '电口', sfp: '光口', power: '电源', disk: '盘位', mgmt: '管理口', console: 'Console' }
  for (const p of list) {
    let g = groups.find((x) => x.group === p.group)
    if (!g) {
      g = { group: p.group, name: nameOf[p.group] || p.group, ports: [] }
      groups.push(g)
    }
    g.ports.push({ id: p.id, label: p.label, net: usedBy.get(p.id) })
  }
  return groups
})

function netName(id: string): string {
  return NETWORKS.find((n) => n.id === id)?.name || id
}

function startCable(): void {
  cm.linking = true
  cm.mode = 'room'
  toast('接线模式：在 3D 里按住 Alt 从这台设备拖到另一台设备')
}

async function unplug(id: string): Promise<void> {
  const ok = await window.sqlpilot.uiConfirm('拔掉这根网线？', '只断物理链路，设备本身不受影响。', false)
  if (!ok) return
  await deleteCable(id)
}
const logs = computed(() => cm.log.filter((l) => l.assetId === cm.selected))

function fmtTs(ts: string): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function jump(id: string): void {
  cm.selected = id
}

function startLink(): void {
  cm.linking = true
  cm.mode = 'room'
  toast('连线模式已开：在 3D 机房视图里从这个设备拖到目标设备')
}

function openTerm(): void {
  const s = (store.cfg?.servers || []).find((x: any) => x.id === asset.value?.linkServerId)
  if (!s) return toast('关联的服务器已被删除', 'bad')
  openServerTask(s)
}

function openConsole(): void {
  const c = (store.cfg?.connections || []).find((x: any) => x.id === asset.value?.linkConnId)
  if (!c) return toast('关联的数据库连接已被删除', 'bad')
  openDbTask(c)
}

async function askAi(): Promise<void> {
  if (!asset.value) return
  const r = await window.sqlpilot.cmdbAiContext(asset.value.id)
  if (!r?.ok || !r.text) return toast(r?.error || '生成上下文失败', 'bad')
  if (!store.currentId) return toast('先在「AI 助手」里打开一个会话', 'bad')
  const cur = store.drafts[store.currentId] || ''
  store.drafts[store.currentId] = `${cur}${cur ? '\n\n' : ''}${r.text}\n\n请基于以上资产与关系，给出运维风险点与排查建议。`
  store.module = 'agent'
  toast('资产上下文已填入 AI 输入框')
}

function focusInGraph(): void {
  if (asset.value?.idcId) cm.view.roomId = asset.value.idcId
  cm.mode = 'room'
  persistView()
}

async function drop(id: string): Promise<void> {
  const ok = await window.sqlpilot.uiConfirm('断开这条关系？', '资产本身不受影响，可随时重新连线。', false)
  if (!ok) return
  await deleteRelation(id)
}

async function remove(): Promise<void> {
  if (!asset.value) return
  const ok = await window.sqlpilot.uiConfirm(`把「${asset.value.name}」移入回收站？`, '关系会保留，从回收站恢复后自动回来。', true)
  if (!ok) return
  const r = await deleteAsset(asset.value.id)
  if (r?.ok) {
    cm.selected = ''
    cm.selectedEdge = ''
  }
}
</script>

<style scoped>
.cd-root {
  width: 320px;
  min-width: 320px;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-card);
  min-height: 0;
}
.cd-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.cd-glyph {
  width: 26px;
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 13px;
  border: 1px solid;
}
.cd-glyph.k-hardware { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: var(--accent-dim); }
.cd-glyph.k-software { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 50%, transparent); background: color-mix(in srgb, var(--purple) 12%, transparent); }
.cd-glyph.k-logical { color: var(--green); border-color: color-mix(in srgb, var(--green) 50%, transparent); background: var(--green-dim); }
.cd-title { flex: 1; min-width: 0; }
.cd-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-sub { font-size: 11px; color: var(--text-faint); }
.st-running { color: var(--green); }
.st-stopped, .st-retired { color: var(--text-faint); }
.st-maintenance { color: var(--yellow); }
.st-planned { color: var(--accent); }
.cd-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 20px;
}
.cd-sec { margin-bottom: 14px; }
.cd-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: 0.3px;
  margin-bottom: 6px;
}
.cd-kv {
  display: flex;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);
}
.cd-kv span { width: 72px; flex: none; color: var(--text-faint); font-size: 11.5px; }
.cd-kv b { flex: 1; min-width: 0; font-weight: 400; color: var(--text); word-break: break-all; }
.cd-note {
  margin-top: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  background: var(--bg-input);
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.6;
  white-space: pre-wrap;
}
.cd-empty { font-size: 11.5px; color: var(--text-faint); line-height: 1.6; padding: 4px 0; }
.cd-rel {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 5px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 11.5px;
}
.cd-rel:hover { background: var(--bg-card-hover); }
.cd-rel i { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.cd-rel-kind { flex: none; font-size: 11px; }
.cd-rel-dir { color: var(--text-faint); }
.cd-rel-name { color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd-rel-label { color: var(--text-faint); font-size: 10.5px; }
.cd-x {
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 10px;
  padding: 0 3px;
  opacity: 0;
}
.cd-rel:hover .cd-x { opacity: 1; }
.cd-x:hover { color: var(--red); }
.cd-acts { display: flex; flex-wrap: wrap; gap: 5px; }
.cd-log {
  display: flex;
  gap: 7px;
  font-size: 11px;
  color: var(--text-dim);
  padding: 2px 0;
  line-height: 1.5;
}
.cd-log-t { color: var(--text-faint); flex: none; font-variant-numeric: tabular-nums; }
.cd-log-d { flex: 1; min-width: 0; }
.mono { font-family: var(--mono); }
.cd-arch-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 5px;
  vertical-align: 1px;
}
.cd-port-grp {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 0;
}
.cd-port-name {
  width: 56px;
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  padding-top: 1px;
}
.cd-port-cells { display: flex; flex-wrap: wrap; gap: 3px; flex: 1; min-width: 0; }
.cd-port {
  width: 9px;
  height: 7px;
  border-radius: 1.5px;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
}
.cd-port.used { box-shadow: 0 0 4px currentColor; }
.cd-port-tag {
  margin-left: 5px;
  font-size: 9.5px;
  color: var(--text-faint);
  font-family: var(--mono);
}
</style>
