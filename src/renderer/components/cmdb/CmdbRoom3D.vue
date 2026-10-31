<template>
  <div ref="host" class="cr-host" @contextmenu.prevent>
    <canvas
      ref="cv"
      class="cr-canvas"
      :class="{ 'is-link': cm.linking }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="onLeave"
      @wheel.prevent="onWheel"
      @dblclick="onDblClick"
      @contextmenu.prevent="onCtx"
      @dragover.prevent="onDragOver"
      @drop.prevent="onDrop"
    />

    <!-- 标签层：机柜编号常显，设备名只给选中/悬停（几百台全标名字没法看） -->
    <div class="cr-labels">
      <span
        v-for="l in labels"
        :key="l.id + l.kind"
        class="cr-label"
        :class="[l.kind, { strong: l.strong }]"
        :style="{ left: `${l.x}px`, top: `${l.y}px` }"
      >{{ l.text }}</span>
    </div>

    <!-- 顶部左：机房切换 + 统计 -->
    <div class="cr-head">
      <select v-if="idcs.length" v-model="roomId" class="cr-sel" title="切换机房">
        <option v-for="d in idcs" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <button v-else class="cm-mini" @click="emit('org', 'idc')">＋ 建机房</button>
      <span v-if="model" class="cr-stats">
        {{ roomStats(model).racks }} 柜 · {{ roomStats(model).devices }} 台 ·
        U 位 {{ roomStats(model).usedU }}/{{ roomStats(model).totalU }} ·
        {{ model.cables.length }} 根线
        <span v-if="model.outside" class="cr-warn" title="有设备没有可显示的位置（未指定机房 / 未上架）">
          · 另有 {{ model.outside }} 台未上架
        </span>
      </span>
    </div>

    <!-- 左侧设备面板：拖到地板上就装 -->
    <div class="cr-palette">
      <div class="cr-pal-title">拖到房间里</div>
      <button
        class="cr-pal-item rack"
        draggable="true"
        title="机柜：拖到地板格上安放（占 1×2 格）"
        @dragstart="dragSpec($event, '__rack__')"
        @click="addRackCenter"
      >
        <span class="cr-pal-ico">▯</span>
        <span class="cr-pal-name">机柜</span>
        <span class="cr-pal-sub">42U · 600×1200</span>
      </button>
      <div class="cr-pal-sep"></div>
      <div v-for="grp in paletteGroups" :key="grp.name" class="cr-pal-grp">
        <div class="cr-pal-grp-name">{{ grp.name }}</div>
        <button
          v-for="sp in grp.list"
          :key="sp.id"
          class="cr-pal-item"
          draggable="true"
          :title="`${sp.name}${sp.note ? ' · ' + sp.note : ''}｜拖到机柜前面板对应 U 位`"
          @dragstart="dragSpec($event, sp.id)"
          @click="addSpecCenter(sp.id)"
        >
          <span class="cr-pal-ico" :style="{ color: roleColor(sp.role, dark) }">{{ sp.type === 'switch' ? '⇉' : sp.type === 'ups' ? '⚡' : sp.type === 'pdu' ? '⌁' : sp.type === 'firewall' ? '⛨' : '▤' }}</span>
          <span class="cr-pal-name">{{ sp.name }}</span>
          <span class="cr-pal-sub">{{ sp.u ? `${sp.u}U` : '落地' }} · {{ Math.round(sp.depthMm / 10) }}cm 深</span>
        </button>
      </div>
    </div>

    <!-- 右下：网络图例（点一下隐藏该类线） -->
    <div class="cr-legend">
      <div class="cr-lg-title">网络</div>
      <button
        v-for="n in NETWORKS"
        :key="n.id"
        class="cr-lg"
        :class="{ off: hiddenNets.includes(n.id) }"
        :title="n.hint"
        @click="toggleNet(n.id)"
      >
        <svg width="22" height="8" viewBox="0 0 22 8">
          <line x1="1" y1="4" x2="21" y2="4" :stroke="dark ? n.colorDark : n.color" stroke-width="2.2" />
        </svg>
        <span>{{ n.name }}</span>
      </button>
    </div>

    <!-- 选中设备：它连了谁 -->
    <div v-if="cm.selected && relatedDevices.length" class="cr-related">
      <div class="cr-rel-title">
        关联设备 <b>{{ relatedDevices.length }}</b>
        <span class="cr-rel-hint">已在高亮</span>
      </div>
      <button v-for="r in relatedDevices" :key="r.id" class="cr-rel" @click="pick(r.id)">
        <i :style="{ background: r.color }"></i>
        <span class="cr-rel-name">{{ r.name }}</span>
        <span class="cr-rel-sub">{{ r.why }}</span>
      </button>
    </div>

    <!-- 底部提示 -->
    <div v-if="hint" class="cr-hint" v-html="hint"></div>

    <div v-if="!model" class="cr-empty">
      <div class="big">⛁</div>
      <b>还没有机房</b>
      <p>先建一个机房（可设格子数），再把机柜拖到地板上</p>
      <button class="btn primary" style="margin-top: 6px" @click="emit('org', 'idc')">＋ 新建机房</button>
    </div>

    <div v-else-if="!model.racks.length" class="cr-empty soft">
      <b>机房是空的</b>
      <p>从左侧把「机柜」拖到地板的方格上，再把服务器拖到机柜前面板的 U 位</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cm, idcs, persistView, relatedOf, toast } from '../../cmdb/state'
import { toPlain } from '../../store'
import { NETWORKS, RELATION_KINDS, SPECS, netColor, roleColor, specOf } from '../../cmdb/dict'
import { orbit, pan, zoom, type Camera } from '../../cmdb/camera'
import {
  firstFreeU, rackFootprint, rackOverlap, roomOf, roomStats,
  type RoomModel
} from '../../../main/cmdb-room'
import { RoomStage, type ScreenRect, type StageLabel } from '../../cmdb/room3d'
import { isDarkTheme } from '../../cmdb/theme'

defineProps<{ hint: string }>()
const emit = defineEmits<{
  (e: 'edit', id: string): void
  (e: 'menu', p: { id: string; sx: number; sy: number }): void
  (e: 'org', tab: 'customer' | 'idc' | 'rack'): void
  (e: 'rack', id: string): void
  (e: 'cable', p: { from: string; to: string }): void
}>()

const host = ref<HTMLDivElement | null>(null)
const cv = ref<HTMLCanvasElement | null>(null)

let stage: RoomStage | null = null
/** 场景几何放非响应式变量：拖拽时每帧改坐标，不能让 Vue 的依赖收集跟着抖 */
let scene: RoomModel | null = null

const dark = ref(isDarkTheme())
const hiddenNets = ref<string[]>([])
const labels = ref<StageLabel[]>([])
const drop = ref<{ rackId?: string; u?: number; ok: boolean; col?: number; row?: number; label: string } | null>(null)
const cableDrag = ref<{ fromId: string; sx: number; sy: number; snapId: string } | null>(null)
const dragging = ref('')

const roomId = computed({
  // 工具栏的"机房"筛选优先：用户在顶上选了 B 机房，3D 里还停在 A 会让人以为筛选坏了
  get: () => cm.filter.idcId || cm.view.roomId || idcs.value[0]?.id || '',
  set: (v: string) => {
    cm.view.roomId = v
    cm.filter.idcId = ''
    persistView()
  }
})

const model = computed<RoomModel | null>(() => (cm.doc ? roomOf(cm.doc, roomId.value, { hideRetired: cm.filter.hideRetired }) : null))

const paletteGroups = computed(() => {
  const order: { name: string; types: string[] }[] = [
    { name: '服务器 / 存储', types: ['server', 'storage'] },
    { name: '网络设备', types: ['switch', 'firewall', 'loadbalancer'] },
    { name: '供电 / 其他', types: ['ups', 'pdu', 'other-hw'] }
  ]
  return order.map((g) => ({ name: g.name, list: SPECS.filter((s) => g.types.includes(s.type)) }))
})

/** 选中设备的高亮集合：关系边 + 网线 + 同架构组 */
const rel = computed(() => (cm.selected ? relatedOf(cm.selected) : { devices: new Set<string>(), racks: new Set<string>() }))

const relatedDevices = computed(() => {
  if (!cm.doc || !cm.selected) return []
  const self = cm.doc.assets.find((x) => x.id === cm.selected)
  const lines: { id: string; name: string; why: string; color: string }[] = []
  for (const did of rel.value.devices) {
    const a = cm.doc.assets.find((x) => x.id === did)
    if (!a) continue
    const cable = cm.doc.cables.find((c) => (c.fromId === cm.selected && c.toId === did) || (c.toId === cm.selected && c.fromId === did))
    const relation = cm.doc.relations.find((r) => (r.fromId === cm.selected && r.toId === did) || (r.toId === cm.selected && r.fromId === did))
    const netName = cable ? (NETWORKS.find((n) => n.id === cable.net) || NETWORKS[0]).name : ''
    const sameArch = !!self?.arch && self.arch === a.arch && self.archGroup === a.archGroup
    const why = netName || (relation ? RELATION_KINDS.find((k) => k.id === relation.kind)?.name || '关系' : sameArch ? '同架构' : '关联')
    lines.push({
      id: a.id,
      name: a.name,
      why,
      color: cable ? netColor(cable.net, dark.value) : roleColor(a.role, dark.value)
    })
  }
  return lines.slice(0, 14)
})

// ---------------------------------------------------------------- 渲染

let raf = 0
let dirty = true
let w = 800
let h = 600
let anim: { from: Camera; to: Camera; t0: number; dur: number } | null = null
let needsFit = false

function requestDraw(): void {
  if (raf) return
  dirty = true
  raf = requestAnimationFrame(frame)
}

function frame(): void {
  raf = 0
  if (!dirty) return
  dirty = false
  render()
  if (anim) requestDraw()
}

function render(): void {
  if (!stage) return
  if (anim) {
    const t = Math.min(1, (performance.now() - anim.t0) / anim.dur)
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    cm.view.camera = lerpCam(anim.from, anim.to, k)
    if (t >= 1) anim = null
  }
  stage.setState({
    dark: dark.value,
    selected: cm.selected,
    hover: cm.hover,
    related: rel.value.devices,
    relatedRacks: rel.value.racks,
    hiddenNets: hiddenNets.value,
    drop: drop.value
  })
  stage.dragging = dragging.value
  stage.setCamera(cm.view.camera)
  stage.render()
  labels.value = stage.labels()
  publishDebug()
}

/** 自检脚本用的只读钩子：把当前场景与投影矩形挂到宿主元素上 */
function publishDebug(): void {
  if (!host.value || !scene || !stage) return
  const rackFace = new Map<string, ScreenRect>()
  const device = new Map<string, ScreenRect>()
  for (const r of scene.racks) {
    const f = stage.rackFace(r.id)
    if (f) rackFace.set(r.id, f)
  }
  for (const d of scene.devices) {
    const f = stage.deviceFace(d.id)
    if (f) device.set(d.id, f)
  }
  const first = scene.racks[0]
  const face = first ? rackFace.get(first.id) : null
  const scale = first && face ? face.h / Math.max(1, first.h - 9) : 1
  ;(host.value as any).__room = { scene, stage, camera: cm.view.camera, out: { rackFace, device, scale } }
}

function lerpCam(a: Camera, b: Camera, k: number): Camera {
  return {
    yaw: a.yaw + (b.yaw - a.yaw) * k,
    pitch: a.pitch + (b.pitch - a.pitch) * k,
    dist: a.dist + (b.dist - a.dist) * k,
    tx: a.tx + (b.tx - a.tx) * k,
    ty: a.ty + (b.ty - a.ty) * k,
    tz: a.tz + (b.tz - a.tz) * k
  }
}

function rebuild(fit = false): void {
  scene = model.value
  if (!stage) return
  if (scene) {
    stage.setModel(scene, {
      dark: dark.value,
      selected: cm.selected,
      hover: cm.hover,
      related: rel.value.devices,
      relatedRacks: rel.value.racks,
      hiddenNets: hiddenNets.value,
      used: new Map(),
      drop: drop.value
    })
  }
  requestDraw()
  if (fit) {
    needsFit = true
    fitRoom()
  }
}

function resize(): void {
  const el = host.value
  const c = cv.value
  if (!el || !c) return
  const rect = el.getBoundingClientRect()
  w = Math.max(1, Math.round(rect.width))
  h = Math.max(1, Math.round(rect.height))
  c.style.width = `${w}px`
  c.style.height = `${h}px`
  stage?.resize(w, h, Math.min(2, window.devicePixelRatio || 1))
  if (needsFit && w > 80 && h > 80 && !anim) fitRoom()
  requestDraw()
}

/** 取景：聚焦"实际用到的区域"（机柜包围盒 + 余量）。初始距离由内容尺寸推出，
 *  不接上一次相机的 dist —— 从拓扑视图（dist 2600）切回来时接着算会收敛到错误位置。 */
function fitRoom(): void {
  if (!scene) return
  if (w < 80 || h < 80) return
  let cx = 0
  let cz = 0
  let spanX = scene.widthCm
  let spanZ = scene.depthCm
  let topY = 210
  if (scene.racks.length) {
    let x0 = Infinity
    let x1 = -Infinity
    let z0 = Infinity
    let z1 = -Infinity
    let hh = 120
    for (const r of scene.racks) {
      x0 = Math.min(x0, r.x - r.w / 2)
      x1 = Math.max(x1, r.x + r.w / 2)
      z0 = Math.min(z0, r.z - r.d / 2)
      z1 = Math.max(z1, r.z + r.d / 2)
      hh = Math.max(hh, r.h)
    }
    cx = (x0 + x1) / 2
    cz = (z0 + z1) / 2
    spanX = x1 - x0 + Math.max(260, (x1 - x0) * 0.75)
    spanZ = z1 - z0 + Math.max(300, (z1 - z0) * 0.95)
    topY = hh
  }
  const dist0 = Math.max(320, Math.max(spanX, spanZ) * 1.05)
  const cam: Camera = {
    ...cm.view.camera,
    tx: cx,
    ty: topY * 0.42,
    tz: cz,
    pitch: 0.42,
    dist: dist0
  }
  needsFit = false
  anim = { from: { ...cm.view.camera }, to: cam, t0: performance.now(), dur: 420 }
  requestDraw()
}

// ---------------------------------------------------------------- 交互

type Mode = 'none' | 'orbit' | 'pan' | 'rack' | 'device' | 'cable'
let mode: Mode = 'none'
let startX = 0
let startY = 0
let lastX = 0
let lastY = 0
let moved = false
let dragId = ''
let pendingSelect = ''
let dropOk = true

function localPos(e: PointerEvent | MouseEvent | DragEvent): { x: number; y: number } {
  const rect = cv.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function rackFaceAt(px: number, py: number): { id: string; rect: ScreenRect } | null {
  if (!stage || !scene) return null
  let best: { id: string; rect: ScreenRect } | null = null
  for (const r of scene.racks) {
    const rect = stage.rackFace(r.id)
    if (!rect) continue
    const pad = 8
    if (px < rect.x - pad || px > rect.x + rect.w + pad || py < rect.y - pad || py > rect.y + rect.h + pad) continue
    // 取"更靠前"（NDC 深度更小）的那个，避免后排机柜抢前置命中
    if (!best || rect.depth < best.rect.depth) best = { id: r.id, rect }
  }
  return best
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function gridAt(px: number, py: number): { col: number; row: number } | null {
  if (!scene || !stage) return null
  const p = stage.floorPoint(px, py)
  if (!p) return null
  const ox = -scene.widthCm / 2
  const oz = -scene.depthCm / 2
  if (p.x < ox - scene.tile || p.x > ox + scene.widthCm + scene.tile) return null
  if (p.z < oz - scene.tile || p.z > oz + scene.depthCm + scene.tile) return null
  return {
    col: clamp(Math.floor((p.x - ox) / scene.tile), 0, scene.cols - 1),
    row: clamp(Math.floor((p.z - oz) / scene.tile), 0, scene.rows - 1)
  }
}

/** 光标落在机柜前面板的第几 U（1 基，夹在可放范围内） */
function uAt(rect: ScreenRect, uTotal: number, uHeight: number, py: number): number {
  const t = (py - rect.y) / Math.max(1, rect.h)
  const u = Math.ceil((1 - t) * uTotal - 0.0001)
  return Math.max(1, Math.min(Math.max(1, uTotal - uHeight + 1), u))
}

function onDown(e: PointerEvent): void {
  if (e.button !== 0 && e.button !== 2) return
  const p = localPos(e)
  startX = lastX = p.x
  startY = lastY = p.y
  moved = false
  pendingSelect = ''
  drop.value = null
  try { cv.value?.setPointerCapture(e.pointerId) } catch { /* 合成事件没有真实指针 */ }

  if (e.button === 2) {
    mode = 'pan'
    return
  }

  const hit = stage?.pick(p.x, p.y) || null
  if (hit?.kind === 'device' && (e.altKey || cm.linking)) {
    mode = 'cable'
    cableDrag.value = { fromId: hit.id, sx: p.x, sy: p.y, snapId: '' }
    dragging.value = hit.id
    cm.linking = false
    requestDraw()
    return
  }
  if (hit?.kind === 'device') {
    mode = 'device'
    dragId = hit.id
    pendingSelect = hit.id
    return
  }
  if (hit?.kind === 'rack') {
    mode = 'rack'
    dragId = hit.id
    return
  }
  mode = 'orbit'
  if (cm.selected) cm.selected = ''
}

function onMove(e: PointerEvent): void {
  const p = localPos(e)
  const dx = p.x - lastX
  const dy = p.y - lastY
  lastX = p.x
  lastY = p.y
  if (Math.abs(p.x - startX) + Math.abs(p.y - startY) > 4) moved = true

  if (mode === 'none') {
    const hit = stage?.pick(p.x, p.y) || null
    const hoverId = hit?.kind === 'device' ? hit.id : ''
    if (hoverId !== cm.hover) {
      cm.hover = hoverId
      cv.value!.style.cursor = cm.linking ? 'crosshair' : hit ? 'pointer' : 'grab'
      requestDraw()
    }
    return
  }
  if (mode === 'orbit') {
    if (!moved) return
    cm.view.camera = orbit(cm.view.camera, dx, dy)
    cv.value!.style.cursor = 'grabbing'
    requestDraw()
    return
  }
  if (mode === 'pan') {
    cm.view.camera = pan(cm.view.camera, dx, dy, w, h)
    requestDraw()
    return
  }
  if (!moved || !scene || !stage) return

  if (mode === 'rack') {
    const rack = scene.racks.find((r) => r.id === dragId)
    const g = gridAt(p.x, p.y)
    if (!rack || !g) return
    const col = clamp(g.col, 0, Math.max(0, scene.cols - rack.cols))
    const row = clamp(g.row, 0, Math.max(0, scene.rows - rack.rows))
    if (col === rack.col && row === rack.row) return
    stage.moveRack(rack.id, col, row)
    const clash = rackOverlap(scene.racks, col, row, rack.cols, rack.rows, rack.id)
    dropOk = !clash
    drop.value = { ok: dropOk, label: clash ? `与机柜 ${clash} 重叠` : `落位 第${row + 1}排 第${col + 1}列` }
    stage.setState({ drop: drop.value })
    requestDraw()
    return
  }

  if (mode === 'device') {
    const dev = scene.devices.find((d) => d.id === dragId)
    if (!dev) return
    const face = rackFaceAt(p.x, p.y)
    if (face) {
      const rack = scene.racks.find((r) => r.id === face.id)
      if (!rack) return
      const u = uAt(face.rect, rack.uTotal, dev.uHeight, p.y)
      stage.moveDevice(dev.id, rack.id, u)
      const free = rackSlotFreeAt(rack.id, u, dev.uHeight, dev.id)
      dropOk = free
      drop.value = { rackId: rack.id, u, ok: free, label: free ? `U${u} · ${rack.code}` : `U${u} 已被占用` }
      stage.setState({ drop: drop.value })
      requestDraw()
      return
    }
    if (!dev.rackId) {
      // 落地设备：贴地拖，落在格心
      const g = gridAt(p.x, p.y)
      if (!g) return
      dev.x = -scene.widthCm / 2 + (g.col + 0.5) * scene.tile
      dev.z = -scene.depthCm / 2 + (g.row + 0.5) * scene.tile
      stage.moveLoose(dev.id, dev.x, dev.z)
      dropOk = true
      drop.value = { ok: true, col: g.col, row: g.row, label: `第${g.row + 1}排 第${g.col + 1}列` }
      stage.setState({ drop: drop.value })
      requestDraw()
    }
    return
  }

  if (mode === 'cable') {
    const hit = stage.pick(p.x, p.y)
    const cd = cableDrag.value
    if (cd) {
      const snap = hit?.kind === 'device' && hit.id !== cd.fromId ? hit.id : ''
      cableDrag.value = { fromId: cd.fromId, sx: p.x, sy: p.y, snapId: snap }
    }
    cv.value!.style.cursor = 'crosshair'
    requestDraw()
  }
}

async function onUp(e: PointerEvent): Promise<void> {
  try { cv.value?.releasePointerCapture(e.pointerId) } catch { /* 指针已释放 */ }

  if (mode === 'cable') {
    const cd = cableDrag.value
    cableDrag.value = null
    dragging.value = ''
    mode = 'none'
    requestDraw()
    if (cd?.snapId) emit('cable', { from: cd.fromId, to: cd.snapId })
    else if (moved) toast('没落在别的设备上，未接线', 'bad')
    return
  }

  if (mode === 'rack' && moved && scene) {
    const rack = scene.racks.find((r) => r.id === dragId)
    const src = cm.doc?.racks.find((r) => r.id === dragId)
    if (rack && src && dropOk) {
      // toPlain：src 来自 reactive 的 cm.doc，Proxy 过不了 contextBridge
      const r = await window.sqlpilot.cmdbSaveRack(toPlain({ ...src, gridCol: rack.col, gridRow: rack.row }))
      if (r?.doc) cm.doc = r.doc
      if (!r?.ok) {
        toast(r?.error || '机柜落位失败', 'bad')
        rebuild()
      }
    } else if (rack && src && !dropOk) {
      toast(drop.value?.label || '位置重叠，已还原', 'bad')
      rebuild()
    }
    drop.value = null
    stage?.setState({ drop: null })
    persistView()
  } else if (mode === 'device' && moved && scene) {
    const dev = scene.devices.find((d) => d.id === dragId)
    const src = cm.doc?.assets.find((a) => a.id === dragId)
    if (dev && src) {
      const patch: any = { ...src }
      if (dev.rackId) {
        patch.rackId = dev.rackId
        patch.u = dev.u
        patch.idcId = cm.doc?.racks.find((r) => r.id === dev.rackId)?.idcId || src.idcId
        patch.floorCol = undefined
        patch.floorRow = undefined
      } else {
        patch.rackId = undefined
        patch.u = undefined
        patch.idcId = scene.idcId
        const col = Math.round((dev.x + scene.widthCm / 2) / scene.tile - 0.5)
        const row = Math.round((dev.z + scene.depthCm / 2) / scene.tile - 0.5)
        patch.floorCol = clamp(col, 0, scene.cols - 1)
        patch.floorRow = clamp(row, 0, scene.rows - 1)
      }
      const r = await window.sqlpilot.cmdbSaveAsset(toPlain(patch))
      if (r?.doc) cm.doc = r.doc
      if (!r?.ok) {
        toast(r?.error || '保存失败', 'bad')
        rebuild()
      } else if (dev.rackId) {
        toast(`已装到 ${cm.doc?.racks.find((x) => x.id === dev.rackId)?.code || ''} U${dev.u}`)
      }
      drop.value = null
      stage?.setState({ drop: null })
    }
  }

  // 没拖动 = 点选（拖动过程中不选中，避免抽屉开合把画布挤窄）
  if (!moved && pendingSelect) {
    cm.selected = pendingSelect
    cm.rackId = scene?.devices.find((d) => d.id === pendingSelect)?.rackId || cm.rackId
  }
  if (!moved && mode === 'rack' && dragId) {
    cm.rackId = dragId
    cm.selected = ''
  }
  pendingSelect = ''
  if (mode === 'orbit' || mode === 'pan') persistView()
  mode = 'none'
  dragId = ''
  dragging.value = ''
  cv.value!.style.cursor = 'grab'
  requestDraw()
}

function onLeave(): void {
  if (cm.hover) {
    cm.hover = ''
    requestDraw()
  }
}

function onWheel(e: WheelEvent): void {
  const next = zoom(cm.view.camera, e.deltaY)
  cm.view.camera = { ...next, dist: clamp(next.dist, 120, 4000) }
  persistView()
  requestDraw()
}

function onDblClick(e: MouseEvent): void {
  const p = localPos(e)
  const hit = stage?.pick(p.x, p.y) || null
  if (!hit) return
  if (hit.kind === 'device') emit('edit', hit.id)
  else emit('rack', hit.id)
}

function onCtx(e: MouseEvent): void {
  const p = localPos(e)
  const hit = stage?.pick(p.x, p.y) || null
  if (!hit || hit.kind !== 'device') return
  cm.selected = hit.id
  emit('menu', { id: hit.id, sx: e.clientX, sy: e.clientY })
}

function pick(id: string): void {
  cm.selected = id
}

function toggleNet(id: string): void {
  const list = hiddenNets.value
  const i = list.indexOf(id)
  if (i >= 0) list.splice(i, 1)
  else list.push(id)
  requestDraw()
}

// ---------------------------------------------------------------- 新建（拖放）

function dragSpec(e: DragEvent, specId: string): void {
  e.dataTransfer?.setData('text/x-sqlpilot-spec', specId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
}

function onDragOver(e: DragEvent): void {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

function nextRackCode(): string {
  const used = new Set((cm.doc?.racks || []).filter((r) => r.idcId === scene?.idcId).map((r) => r.code))
  for (let i = 1; i < 100; i++) {
    const code = `R-${String(i).padStart(2, '0')}`
    if (!used.has(code)) return code
  }
  return `R-${Date.now().toString(36).slice(-3)}`
}

const NAME_PREFIX: Record<string, string> = {
  server: 'srv', switch: 'sw', firewall: 'fw', loadbalancer: 'lb',
  storage: 'stor', ups: 'ups', pdu: 'pdu', 'other-hw': 'dev'
}

function nextName(specId: string): string {
  const spec = specOf(specId)
  const prefix = NAME_PREFIX[spec?.type || 'other-hw'] || 'dev'
  const n = (cm.doc?.assets || []).filter((a) => a.name.startsWith(prefix)).length + 1
  return `${prefix}-${String(n).padStart(2, '0')}`
}

function rackSlotFreeAt(rackId: string, u: number, uHeight: number, exceptId?: string): boolean {
  if (!cm.doc) return true
  return !cm.doc.assets.some((a) => {
    if (a.deletedAt || a.rackId !== rackId || a.id === exceptId) return false
    const s = a.u || 1
    const e = s + Math.max(1, a.uHeight || 1) - 1
    return u <= e && u + uHeight - 1 >= s
  })
}

async function createRack(col: number, row: number): Promise<void> {
  if (!scene) return
  const r = await window.sqlpilot.cmdbSaveRack(toPlain({
    idcId: scene.idcId,
    code: nextRackCode(),
    uTotal: 42,
    widthMm: 600,
    depthMm: 1200,
    gridCol: col,
    gridRow: row
  }))
  if (r?.doc) cm.doc = r.doc
  if (r?.ok) toast(`机柜 ${r.value?.code} 已安放（双击可改信息）`)
  else toast(r?.error || '机柜创建失败', 'bad')
}

async function createDevice(specId: string, x: number, y: number): Promise<void> {
  if (!scene || !cm.doc) return
  const spec = specOf(specId)
  if (!spec) return
  const customerId = cm.filter.customerId || cm.doc.customers[0]?.id
  if (!customerId) {
    toast('还没有客户：先在「组织」里建一个客户，资产必须归属客户', 'bad')
    return
  }
  // 落地设备（塔式 UPS）永远放地上：落在机柜面板上也不该被"塞进 U 位"
  const onFloor = spec.u === 0
  const face = onFloor ? null : rackFaceAt(x, y)
  if (!face && !onFloor) {
    toast('上架设备要拖到机柜前面板上（左侧机柜面板的 U 位）', 'bad')
    return
  }

  let rackId: string | undefined
  let u: number | undefined
  let floorCol: number | undefined
  let floorRow: number | undefined
  if (face) {
    const rack = scene.racks.find((r) => r.id === face.id)
    if (rack) {
      rackId = rack.id
      u = uAt(face.rect, rack.uTotal, Math.max(1, spec.u), y)
      if (cm.doc && !rackSlotFreeAt(rack.id, u, Math.max(1, spec.u))) {
        u = firstFreeU(cm.doc, rack.id, Math.max(1, spec.u), rack.uTotal)
        toast(`U 位被占，改放到 U${u}`)
      }
    }
  } else {
    const g = gridAt(x, y)
    if (!g) return
    floorCol = g.col
    floorRow = g.row
  }

  const r = await window.sqlpilot.cmdbSaveAsset({
    customerId,
    idcId: scene.idcId,
    rackId,
    u,
    floorCol,
    floorRow,
    spec: spec.id,
    type: spec.type,
    uHeight: Math.max(1, spec.u),
    role: spec.role,
    name: nextName(spec.id),
    ips: [],
    tags: [],
    meta: {},
    status: 'running'
  })
  if (r?.doc) cm.doc = r.doc
  if (r?.ok) toast(`${r.value?.name} 已${rackId ? `装入机柜 U${u}` : '放到地板'}（双击填写详细信息）`)
  else toast(r?.error || '设备创建失败', 'bad')
}

function onDrop(e: DragEvent): void {
  const specId = e.dataTransfer?.getData('text/x-sqlpilot-spec')
  if (!specId || !scene) return
  const p = localPos(e)
  if (specId === '__rack__') {
    const g = gridAt(p.x, p.y)
    if (!g) { toast('请把机柜放到地板格上', 'bad'); return }
    const fp = rackFootprint({ widthMm: 600, depthMm: 1200 }, scene.tile)
    const col = clamp(g.col, 0, Math.max(0, scene.cols - fp.cols))
    const row = clamp(g.row, 0, Math.max(0, scene.rows - fp.rows))
    const clash = rackOverlap(scene.racks, col, row, fp.cols, fp.rows)
    if (clash) { toast(`这里已经有机柜 ${clash} 了`, 'bad'); return }
    void createRack(col, row)
    return
  }
  void createDevice(specId, p.x, p.y)
}

function addRackCenter(): void {
  if (!scene) return
  const fp = rackFootprint({ widthMm: 600, depthMm: 1200 }, scene.tile)
  for (let row = 0; row + fp.rows <= scene.rows; row += fp.rows + 1) {
    for (let col = 0; col + fp.cols <= scene.cols; col += fp.cols) {
      if (!rackOverlap(scene.racks, col, row, fp.cols, fp.rows)) {
        void createRack(col, row)
        return
      }
    }
  }
  toast('地板放满了，先扩机房或挪一挪机柜', 'bad')
}

/** 点面板里的规格：自动找一个空 U 位装进当前机柜（没机柜先提示） */
function addSpecCenter(specId: string): void {
  if (!scene || !cm.doc) return
  const spec = specOf(specId)
  if (!spec) return
  if (spec.u === 0) {
    void createDevice(specId, w * 0.5, h * 0.9)
    return
  }
  const rack = scene.racks.find((r) => r.id === cm.rackId) || scene.racks[0]
  if (!rack) {
    toast('先拖一个机柜到地板上', 'bad')
    return
  }
  cm.rackId = rack.id
  const u = firstFreeU(cm.doc, rack.id, Math.max(1, spec.u), rack.uTotal)
  const face = stage?.rackFace(rack.id)
  if (!face) return
  const yPx = face.y + face.h * (1 - (u + spec.u / 2) / rack.uTotal)
  void createDevice(specId, face.x + face.w / 2, yPx)
}

// ---------------------------------------------------------------- 主题 / 键盘

function onThemeChange(): void {
  const next = isDarkTheme()
  if (next === dark.value) return
  dark.value = next
  rebuild()
}

function onKey(e: KeyboardEvent): void {
  if (!host.value) return
  const tag = (document.activeElement?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return
  if ((e.key === 'Delete' || e.key === 'Backspace') && cm.selected && cm.doc) {
    const a = cm.doc.assets.find((x) => x.id === cm.selected)
    if (!a) return
    void (async () => {
      const ok = await window.sqlpilot.uiConfirm(`把「${a.name}」移入回收站？`, '网线会一并移除，可从回收站恢复。', true)
      if (!ok) return
      const r = await window.sqlpilot.cmdbDeleteAsset(a.id)
      if (r?.doc) cm.doc = r.doc
      if (r?.ok) cm.selected = ''
    })()
    e.preventDefault()
  }
  if (e.key === 'f' || e.key === 'F') fitRoom()
}

onMounted(() => {
  if (!cv.value) return
  try {
    stage = new RoomStage(cv.value)
  } catch (err: any) {
    toast(`3D 初始化失败：${err?.message || err}`, 'bad')
    return
  }
  const ro = new ResizeObserver(() => resize())
  if (host.value) ro.observe(host.value)
  resize()
  rebuild(true)
  window.addEventListener('keydown', onKey)
  window.addEventListener('sqlpilot:theme', onThemeChange)
  const obs = new MutationObserver(onThemeChange)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  ;(host.value as any).__themeObs = obs
  ;(host.value as any).__ro = ro
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  ;((host.value as any)?.__ro as ResizeObserver | undefined)?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('sqlpilot:theme', onThemeChange)
  ;((host.value as any)?.__themeObs as MutationObserver | undefined)?.disconnect()
  stage?.dispose()
  stage = null
})

// 台账/机房/筛选变化 → 重建场景。只在机房或机柜数变化时重新框视口，
// 拖一台设备不该把镜头甩走（这条踩过：写完就 fit，视角每拖一次跳一次）
let lastRoom = ''
let lastRacks = -1
watch(model, () => {
  const roomKey = `${model.value?.idcId}|${model.value?.cols}x${model.value?.rows}`
  const racks = model.value?.racks.length ?? -1
  const needFit = roomKey !== lastRoom || lastRacks < 0 || (racks === 1 && lastRacks === 0)
  lastRoom = roomKey
  lastRacks = racks
  rebuild(needFit)
}, { flush: 'post' })

watch(() => [cm.selected, cm.hover, cm.showLabels], () => requestDraw(), { flush: 'post' })
watch(() => cm.linking, () => {
  cv.value!.style.cursor = cm.linking ? 'crosshair' : 'grab'
  requestDraw()
})

/** 供父组件调用：从外部定位到某台设备 */
function focusAsset(id: string): void {
  const dev = scene?.devices.find((d) => d.id === id)
  if (!dev) return
  cm.selected = id
  const to: Camera = { ...cm.view.camera, tx: dev.x, ty: dev.y, tz: dev.z, dist: Math.min(cm.view.camera.dist, 520) }
  anim = { from: { ...cm.view.camera }, to, t0: performance.now(), dur: 420 }
  requestDraw()
}
defineExpose({ focusAsset, fitRoom })
</script>

<style scoped>
.cr-host {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
}
.cr-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}
.cr-canvas.is-link { cursor: crosshair; }

.cr-labels {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}
.cr-label {
  position: absolute;
  transform: translate(-50%, -100%);
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 1.4;
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
}
.cr-label.rack { font-size: 10px; color: var(--text-faint); }
.cr-label.strong {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: color-mix(in srgb, var(--accent-dim) 70%, var(--bg));
}

.cr-head {
  position: absolute;
  left: 12px;
  top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 260px);
}
.cr-sel {
  font-size: 12px;
  padding: 3px 6px;
  max-width: 170px;
}
.cr-stats {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cr-warn { color: var(--yellow); }

.cr-palette {
  position: absolute;
  left: 12px;
  top: 42px;
  width: 178px;
  max-height: calc(100% - 96px);
  overflow: auto;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-card) 88%, transparent);
  backdrop-filter: blur(7px);
}
.cr-pal-title {
  font-size: 10.5px;
  color: var(--text-faint);
  padding: 1px 2px 5px;
  letter-spacing: 0.04em;
}
.cr-pal-grp { margin-top: 4px; }
.cr-pal-grp-name {
  font-size: 10px;
  color: var(--text-faint);
  padding: 5px 2px 3px;
  opacity: 0.8;
}
.cr-pal-item {
  display: grid;
  grid-template-columns: 16px 1fr;
  grid-template-rows: auto auto;
  gap: 0 5px;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  padding: 4px 5px;
  border-radius: 6px;
  cursor: grab;
}
.cr-pal-item:hover {
  background: var(--bg-card-hover);
  border-color: var(--border);
  color: var(--text);
}
.cr-pal-item:active { cursor: grabbing; }
.cr-pal-item.rack { border-color: var(--border); background: var(--bg-input); }
.cr-pal-ico {
  grid-row: span 2;
  font-size: 13px;
  align-self: center;
  color: var(--accent);
}
.cr-pal-name {
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cr-pal-sub { font-size: 9.5px; color: var(--text-faint); }
.cr-pal-sep { height: 1px; background: var(--border); margin: 5px 2px; }

.cr-legend {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-card) 88%, transparent);
  backdrop-filter: blur(6px);
}
.cr-lg-title { font-size: 10px; color: var(--text-faint); padding-bottom: 2px; }
.cr-lg {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11px;
  padding: 1px 0;
  cursor: pointer;
  text-align: left;
}
.cr-lg:hover { color: var(--text); }
.cr-lg.off { opacity: 0.42; text-decoration: line-through; }

.cr-related {
  position: absolute;
  right: 12px;
  top: 10px;
  width: 208px;
  max-height: 46%;
  overflow: auto;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
  backdrop-filter: blur(7px);
}
.cr-rel-title {
  font-size: 10.5px;
  color: var(--text-faint);
  padding-bottom: 5px;
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.cr-rel-title b { color: var(--accent); font-weight: 500; }
.cr-rel-hint { margin-left: auto; font-size: 9.5px; opacity: 0.7; }
.cr-rel {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11.5px;
  padding: 3px 4px;
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
}
.cr-rel:hover { background: var(--bg-card-hover); color: var(--text); }
.cr-rel i { width: 3px; height: 13px; border-radius: 2px; flex: none; }
.cr-rel-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cr-rel-sub { font-size: 9.5px; color: var(--text-faint); }

.cr-hint {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 10px;
  padding: 5px 11px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--bg-card) 90%, transparent);
  border: 1px solid var(--border);
  pointer-events: none;
  white-space: nowrap;
}
.cr-hint :deep(b) { color: var(--accent); font-weight: 500; }
.cr-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-dim);
  pointer-events: none;
}
.cr-empty .big { font-size: 34px; opacity: 0.32; }
.cr-empty b { font-weight: 500; }
.cr-empty p {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
  max-width: 320px;
  text-align: center;
}
.cr-empty.soft { justify-content: flex-end; padding-bottom: 78px; }
.cr-empty button { pointer-events: auto; }
</style>
