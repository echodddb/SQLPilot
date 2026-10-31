<template>
  <div class="cv-root">
    <div class="cv-toolbar">
      <select v-model="cm.filter.customerId" class="cv-sel" title="按客户筛选（客户与机房是两个独立维度）" @change="onCustomerChange">
        <option value="">全部客户</option>
        <option value="__none__">未归属客户</option>
        <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <select v-model="cm.filter.idcId" class="cv-sel" title="按机房筛选">
        <option value="">全部机房</option>
        <option value="__none__">未指定机房</option>
        <option v-for="d in idcs" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <select v-model="typeFilter" class="cv-sel" title="按资产类型筛选">
        <option value="">全部类型</option>
        <option v-for="t in ASSET_TYPES" :key="t.id" :value="t.id">{{ t.glyph }} {{ t.name }}</option>
      </select>
      <input v-model="qInput" class="cv-search" placeholder="搜名称 / IP / 序列号 / 标签" />
      <button v-if="qInput" class="cm-mini" title="清空搜索" @click="clearSearch">✕</button>

      <span class="cv-stats">
        资产 <b>{{ stats?.assets || 0 }}</b>
        <span class="cv-sep">·</span>关系 <b>{{ stats?.relations || 0 }}</b>
        <span v-if="stats?.orphans" class="cv-sep">·</span>
        <span v-if="stats?.orphans" class="cv-warn" title="没有任何关系的资产，通常是漏录了上联/承载">孤岛 {{ stats?.orphans }}</span>
      </span>

      <span class="spacer"></span>

      <button v-if="cm.linking" class="cm-mini on" title="连线模式：在图上从一个节点拖到另一个节点即可建立关系" @click="cm.linking = false">
        连线中 · 关闭
      </button>

      <div class="cv-seg" role="group" aria-label="视图">
        <button :class="{ on: cm.mode === 'room' }" title="机房 3D：拖拽搭机房、装机、接线" @click="setMode('room')">机房 3D</button>
        <button :class="{ on: cm.mode === 'table' }" title="台账表格（快捷键 1）" @click="setMode('table')">台账</button>
        <button :class="{ on: cm.mode === '2d' }" title="正俯视拓扑（快捷键 2）" @click="setMode('2d')">2D</button>
        <button :class="{ on: cm.mode === '3d' }" title="3D 关系拓扑（快捷键 3）" @click="setMode('3d')">拓扑</button>
        <button :class="{ on: cm.mode === 'rack' }" title="机柜 U 位正视图" @click="setMode('rack')">机柜</button>
      </div>

      <button class="cm-mini" title="显示/隐藏节点名称" :class="{ on: cm.showLabels }" @click="cm.showLabels = !cm.showLabels">标签</button>
      <button class="btn primary" style="padding: 3px 10px; font-size: 12px" @click="newAsset()">＋ 资产</button>
      <button class="cm-mini" title="纳管服务器/云平台、导入导出、备份" @click="syncOpen = true">纳管</button>
      <button class="cm-mini" title="管理客户 / 机房 / 机柜" @click="orgTab = 'customer'">组织</button>
    </div>

    <div v-if="cm.loading" class="cv-loading"><span class="spinner"></span>读取台账…</div>

    <div class="cv-body">
      <CmdbTree @org="(t) => (orgTab = t)" @trash="trashOpen = true" />

      <div class="cv-main">
        <CmdbTable
          v-if="cm.mode === 'table'"
          @edit="editAsset"
          @menu="openMenu"
          @export-all="exportAll"
        />
        <CmdbRoom3D
          v-else-if="cm.mode === 'room'"
          :hint="roomHint"
          @edit="editAsset"
          @menu="openMenu"
          @org="(t) => (orgTab = t)"
          @rack="openRack"
          @cable="onCable"
        />
        <CmdbGraph3D
          v-else-if="cm.mode === '3d' || cm.mode === '2d'"
          @edit="editAsset"
          @link="onLink"
          @menu="openMenu"
          @edge="onEdge"
        />
        <CmdbRackView
          v-else
          @org="(t) => (orgTab = t)"
          @new="newAssetInRack"
          @edit="editAsset"
        />
      </div>

      <CmdbAssetDrawer v-if="cm.selected" @edit="editAsset" />
    </div>

    <!-- 右键菜单 -->
    <div v-if="menu" class="cv-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
      <button @click="menuAct('edit')">编辑资产</button>
      <button @click="menuAct('link')">从这里连线…</button>
      <button @click="menuAct('locate')">只看它的机房</button>
      <button @click="menuAct('focus')">在图里定位</button>
      <div class="cv-menu-sep"></div>
      <button class="danger" @click="menuAct('delete')">移入回收站</button>
    </div>
    <div v-if="menu" class="cv-menu-mask" @click="menu = null" @contextmenu.prevent="menu = null"></div>

    <!-- 拖拽连线后的关系确认 -->
    <div v-if="linkDraft" class="cm-mask" @click.self="linkDraft = null">
      <div class="cm-dlg" style="width: 420px">
        <div class="cm-dlg-head">建立关系<button class="cm-close" @click="linkDraft = null">✕</button></div>
        <div class="cm-dlg-body">
          <div class="cv-link-ends">
            <b>{{ nameOf(linkDraft.from) }}</b>
            <span>→</span>
            <b>{{ nameOf(linkDraft.to) }}</b>
          </div>
          <div class="cm-field">
            <span class="cm-label">关系类型</span>
            <div class="cv-kinds">
              <button
                v-for="k in RELATION_KINDS"
                :key="k.id"
                class="cv-kind"
                :class="{ on: linkDraft.kind === k.id }"
                :title="k.hint"
                @click="linkDraft.kind = k.id"
              >
                <i :style="{ background: relColor(k.id, dark) }"></i>{{ k.name }}
              </button>
            </div>
          </div>
          <div class="cm-field">
            <span class="cm-label">标签（可选，常用值可直接点）</span>
            <input v-model="linkDraft.label" class="cm-input" :placeholder="RELATION_KINDS.find((k) => k.id === linkDraft.kind)?.hint" />
            <div class="cv-labels">
              <button v-for="l in labelOptions" :key="l" class="cm-mini" @click="linkDraft.label = l">{{ l }}</button>
            </div>
          </div>
          <label class="cv-check">
            <input v-model="linkDraft.reverse" type="checkbox" />
            反向（把 {{ nameOf(linkDraft.to) }} 当作起点）
          </label>
        </div>
        <div class="cm-dlg-foot">
          <span class="spacer"></span>
          <button class="btn ghost" @click="linkDraft = null">取消</button>
          <button class="btn primary" @click="confirmLink">建立关系</button>
        </div>
      </div>
    </div>

    <CmdbAssetForm v-if="formOpen" :asset="formAsset" :preset="formPreset" @close="formOpen = false" @saved="onSaved" />
    <CmdbCableDialog v-if="cableDraft" :from-id="cableDraft.from" :to-id="cableDraft.to" @close="cableDraft = null" />
    <CmdbOrgModal v-if="orgTab" :tab="orgTab" :item-id="orgItemId" @close="closeOrg" />
    <CmdbSyncModal v-if="syncOpen" @close="syncOpen = false" />
    <CmdbTrash v-if="trashOpen" @close="trashOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import '../../cmdb/ui.css'
import CmdbTree from './CmdbTree.vue'
import CmdbTable from './CmdbTable.vue'
import CmdbGraph3D from './CmdbGraph3D.vue'
import CmdbRoom3D from './CmdbRoom3D.vue'
import CmdbCableDialog from './CmdbCableDialog.vue'
import CmdbRackView from './CmdbRackView.vue'
import CmdbAssetDrawer from './CmdbAssetDrawer.vue'
import CmdbAssetForm from './CmdbAssetForm.vue'
import CmdbOrgModal from './CmdbOrgModal.vue'
import CmdbSyncModal from './CmdbSyncModal.vue'
import CmdbTrash from './CmdbTrash.vue'
import { ASSET_TYPES, RELATION_KINDS, RELATION_LABELS, relColor } from '../../cmdb/dict'
import { cm, customers, idcs, load, saveRelation, selectAsset, setMode, stats, toast } from '../../cmdb/state'
import { isDarkTheme } from '../../cmdb/theme'

const dark = isDarkTheme()

const qInput = ref(cm.filter.q)
let qTimer = 0
function clearSearch(): void {
  qInput.value = ''
  cm.filter.q = ''
}

/** 机房视图底部的操作提示：一句能看懂的话，比六个图标有用 */
const roomHint = '<b>拖左侧设备到地板/机柜</b> · 拖机柜改位置 · 拖设备改 U 位 · <b>Alt 从设备拖出接线</b> · 右键平移 · 滚轮缩放 · F 复位视角'

const typeFilter = computed({
  get: () => cm.filter.types[0] || '',
  set: (v: string) => {
    cm.filter.types = v ? [v] : []
  }
})

const orgTab = ref<'customer' | 'idc' | 'rack' | null>(null)
const orgItemId = ref('')
const syncOpen = ref(false)
const trashOpen = ref(false)
const formOpen = ref(false)
const formAsset = ref<any>(null)
const formPreset = ref<any>(null)

function newAsset(): void {
  formAsset.value = null
  formPreset.value = { customerId: cm.filter.customerId, idcId: cm.filter.idcId }
  formOpen.value = true
}
function newAssetInRack(rackId: string): void {
  formAsset.value = null
  const rack = cm.doc?.racks.find((r) => r.id === rackId)
  formPreset.value = { customerId: cm.filter.customerId, idcId: rack?.idcId, rackId }
  formOpen.value = true
}
function editAsset(id: string): void {
  formAsset.value = cm.doc?.assets.find((a) => a.id === id) || null
  formPreset.value = null
  formOpen.value = true
}
function openRack(id: string): void {
  orgItemId.value = id
  orgTab.value = 'rack'
}
function closeOrg(): void {
  orgTab.value = null
  orgItemId.value = ''
}

const cableDraft = ref<{ from: string; to: string } | null>(null)
function onCable(p: { from: string; to: string }): void {
  cableDraft.value = p
}

function onSaved(id: string): void {
  formOpen.value = false
  selectAsset(id)
}

function exportAll(): void {
  void window.sqlpilot.cmdbExportCsv()
}

// ---------------------------------------------------------------- 右键菜单

const menu = ref<{ id: string; x: number; y: number } | null>(null)
function openMenu(p: { id: string; sx: number; sy: number }): void {
  menu.value = { id: p.id, x: Math.min(p.sx, window.innerWidth - 180), y: Math.min(p.sy, window.innerHeight - 190) }
  selectAsset(p.id)
}

async function menuAct(act: string): Promise<void> {
  const id = menu.value?.id
  menu.value = null
  if (!id) return
  if (act === 'edit') return editAsset(id)
  if (act === 'link') {
    cm.linking = true
    cm.mode = '3d'
    toast('连线模式：从当前节点拖到目标节点')
    return
  }
  if (act === 'focus') {
    cm.mode = '3d'
    return
  }
  if (act === 'locate') {
    const a = cm.doc?.assets.find((x) => x.id === id)
    if (!a) return
    cm.filter.customerId = a.customerId || ''
    cm.filter.idcId = a.idcId || ''
    if (cm.mode === 'table') setMode('3d')
    return
  }
  if (act === 'delete') {
    const ok = await window.sqlpilot.uiConfirm('移入回收站？', '关系会保留，可从回收站恢复。', true)
    if (!ok) return
    const r = await window.sqlpilot.cmdbDeleteAsset(id)
    if (r?.doc) cm.doc = r.doc
    if (r?.ok) cm.selected = ''
  }
}

// ---------------------------------------------------------------- 连线

const linkDraft = ref<{ from: string; to: string; kind: any; label: string; reverse: boolean } | null>(null)

function onLink(p: { from: string; to: string }): void {
  linkDraft.value = { from: p.from, to: p.to, kind: 'physical', label: '', reverse: false }
  cm.linking = false
}

const labelOptions = computed(() => {
  const k = linkDraft.value?.kind || 'physical'
  return (RELATION_LABELS as any)[k] || []
})

function nameOf(id: string): string {
  return cm.doc?.assets.find((a) => a.id === id)?.name || '?'
}

async function confirmLink(): Promise<void> {
  const d = linkDraft.value
  if (!d) return
  const from = d.reverse ? d.to : d.from
  const to = d.reverse ? d.from : d.to
  const r = await saveRelation({ fromId: from, toId: to, kind: d.kind, label: d.label.trim() || undefined, directed: true })
  if (r?.ok) linkDraft.value = null
}

async function onEdge(relationId: string): Promise<void> {
  const rel = cm.doc?.relations.find((r) => r.id === relationId)
  if (!rel) return
  const from = nameOf(rel.fromId)
  const to = nameOf(rel.toId)
  const ok = await window.sqlpilot.uiConfirm(`断开关系 ${from} → ${to}？`, '资产本身不受影响。', false)
  if (!ok) {
    cm.selectedEdge = ''
    return
  }
  const r = await window.sqlpilot.cmdbDeleteRelation(relationId)
  if (r?.doc) cm.doc = r.doc
  cm.selectedEdge = ''
  if (r?.ok) toast('关系已断开')
}

// ---------------------------------------------------------------- 生命周期

onMounted(() => {
  void load()
})

onBeforeUnmount(() => window.clearTimeout(qTimer))

// 搜索防抖：3D 视图每次筛选都要重建场景，别让每个按键都重建一次
watch(qInput, (v) => {
  window.clearTimeout(qTimer)
  qTimer = window.setTimeout(() => (cm.filter.q = v.trim()), 180)
})
/** 切客户时清掉机房筛选：原机房未必服务新客户，留着会让用户看到"空表"却不知道为什么。
 *  只能挂在用户的 select 上，不能用 watch —— 树里点机柜是先设 customerId 再设 idcId，
 *  watch 会晚一拍把刚设好的 idcId 清掉（这个坑踩过一次）。 */
function onCustomerChange(): void {
  cm.filter.idcId = ''
  cm.rackId = ''
}
</script>

<style scoped>
.cv-root {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.cv-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-side);
  flex-wrap: wrap;
}
.cv-sel {
  font-size: 12px;
  padding: 3px 6px;
  max-width: 150px;
}
.cv-search {
  font-size: 12px;
  padding: 4px 8px;
  width: 190px;
}
.cv-stats {
  font-size: 11px;
  color: var(--text-faint);
  margin-left: 4px;
  white-space: nowrap;
}
.cv-stats b { color: var(--text-dim); font-weight: 500; }
.cv-sep { margin: 0 4px; opacity: 0.5; }
.cv-warn { color: var(--yellow); }
.cv-toolbar .spacer { flex: 1; }
.cv-seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.cv-seg button {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-family: inherit;
  font-size: 11.5px;
  padding: 4px 9px;
  cursor: pointer;
}
.cv-seg button:hover { color: var(--text); background: var(--bg-card-hover); }
.cv-seg button.on { color: var(--accent); background: var(--accent-dim); }
.cv-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.cv-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.cv-loading {
  position: absolute;
  left: 50%;
  top: 46%;
  transform: translate(-50%, -50%);
  font-size: 12px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 8px;
}
.cv-menu {
  position: fixed;
  z-index: 80;
  min-width: 152px;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
}
.cv-menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12px;
  padding: 5px 9px;
  border-radius: 5px;
  cursor: pointer;
}
.cv-menu button:hover { background: var(--bg-card-hover); color: var(--text); }
.cv-menu button.danger:hover { color: var(--red); background: var(--red-dim); }
.cv-menu-sep { height: 1px; background: var(--border); margin: 4px 2px; }
.cv-menu-mask { position: fixed; inset: 0; z-index: 79; }
.cv-link-ends {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text);
}
.cv-link-ends span { color: var(--text-faint); }
.cv-kinds { display: flex; gap: 6px; }
.cv-kind {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.cv-kind i { width: 6px; height: 6px; border-radius: 50%; }
.cv-kind:hover { border-color: var(--border-strong); color: var(--text); }
.cv-kind.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-dim); }
.cv-labels { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.cv-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
}
</style>
