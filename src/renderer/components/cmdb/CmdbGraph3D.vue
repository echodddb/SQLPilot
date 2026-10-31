<template>
  <div ref="host" class="cg-host" @contextmenu.prevent>
    <canvas
      ref="cv"
      class="cg-canvas"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="onLeave"
      @wheel.prevent="onWheel"
      @dblclick="onDblClick"
      @contextmenu.prevent="onCtx"
    />

    <!-- 左上角：当前作用域 + 计数，回答"我现在看的是什么" -->
    <div class="cg-scope">
      <b>{{ scopeLabel }}</b>
      <span>{{ graph.nodes.length }} 节点 · {{ graph.edges.length }} 关系</span>
      <span v-if="graph.hidden" class="cg-hidden">筛选外还有 {{ graph.hidden }} 项</span>
    </div>

    <!-- 右下图例：三类关系用线型区分，颜色之外还有一层编码 -->
    <div class="cg-legend">
      <div v-for="k in RELATION_KINDS" :key="k.id" class="cg-lg" @click="toggleKind(k.id)">
        <svg width="26" height="8" viewBox="0 0 26 8">
          <line x1="1" y1="4" x2="25" y2="4" :stroke="relColor(k.id, dark)" stroke-width="1.6" :stroke-dasharray="dashOf(k.id)" />
        </svg>
        <span :class="{ off: cm.view.hiddenKinds.includes(k.id) }">{{ k.name }}</span>
      </div>
    </div>

    <!-- 左下角：操作提示，只在第一次进来显示几秒 -->
    <div v-if="hintVisible" class="cg-hint">
      拖空白旋转 · 滚轮缩放 · 右键平移 · <b>Alt 从节点拖出连线</b> · 双击聚焦
    </div>

    <div v-if="!graph.nodes.length" class="cg-empty">
      <div class="big">⛁</div>
      <b>当前筛选下没有资产</b>
      <p>{{ emptyHint }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cm, graph, idcs, racks, toast, persistView, saveRelation, setMode } from '../../cmdb/state'
import {
  basisOf, computeLayout, flyTo, orbit, pan, projectWith, unprojectOnPlane, zoom,
  type Camera, type Vec3
} from '../../cmdb/camera'
import { drawScene, hitEdge, hitTest, invalidateSprites, type ClusterRing, type SceneEdge, type SceneNode, type ScreenNode } from '../../cmdb/render'
import { RELATION_KINDS, relColor, relDash } from '../../cmdb/dict'
import { isDarkTheme, readPalette } from '../../cmdb/theme'

const emit = defineEmits<{
  (e: 'edit', id: string): void
  (e: 'delete', id: string): void
  (e: 'edge', id: string): void
  (e: 'link', payload: { from: string; to: string; sx: number; sy: number }): void
  (e: 'menu', payload: { id: string; sx: number; sy: number }): void
}>()

const host = ref<HTMLDivElement | null>(null)
const cv = ref<HTMLCanvasElement | null>(null)

/** 场景数据放在非响应式变量里：拖动时每帧改坐标，不能让它触发 Vue 的依赖收集 */
let sceneN: SceneNode[] = []
let sceneE: SceneEdge[] = []
let clusters: ClusterRing[] = []
let screenMap: Map<string, ScreenNode> = new Map()
let medianR = 6

const dark = ref(isDarkTheme())
const hintVisible = ref(true)
/** 调色板缓存：getComputedStyle 每帧调一次会引起样式重算，主题只在切换时变 */
let palette = readPalette()

const scopeLabel = computed(() => {
  if (cm.mode === '2d') return '2D 拓扑（正俯视）'
  return '3D 关系拓扑'
})
const emptyHint = computed(() =>
  cm.filter.q || cm.filter.idcId || cm.filter.types.length
    ? '放宽筛选条件，或在「台账」里新增资产'
    : '点右上角「＋ 资产」开始录入，或从服务器/云平台一键纳管'
)
function dashOf(kind: string): string {
  const d = relDash(kind)
  return d.length ? d.join(' ') : 'none'
}

// ---------------------------------------------------------------- 渲染循环

let dpr = Math.min(2, window.devicePixelRatio || 1)
let w = 800
let h = 600
let raf = 0
let dirty = true
let resizeOb: ResizeObserver | null = null

function requestDraw(): void {
  if (raf) return
  dirty = true
  raf = requestAnimationFrame(frame)
}

function frame(): void {
  raf = 0
  if (!dirty) return
  dirty = false
  draw()
  if (anim) requestDraw()
}

let anim: { from: Camera; to: Camera; t0: number; dur: number } | null = null

function draw(): void {
  const c = cv.value
  if (!c) return
  const ctx = c.getContext('2d')
  if (!ctx) return
  if (anim) {
    const t = Math.min(1, (performance.now() - anim.t0) / anim.dur)
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    cm.view.camera = lerpCam(anim.from, anim.to, k)
    if (t >= 1) anim = null
  }
  const out = drawScene(ctx, {
    nodes: sceneN,
    edges: sceneE,
    clusters,
    cam: cm.view.camera,
    w,
    h,
    dpr,
    palette,
    selected: cm.selected,
    hover: cm.hover,
    hiddenKinds: cm.view.hiddenKinds,
    link: linkDrag.value
      ? { fromId: linkDrag.value.fromId, sx: linkDrag.value.sx, sy: linkDrag.value.sy, snapId: linkDrag.value.snapId }
      : null,
    showLabels: cm.showLabels
  })
  screenMap = out.screen
  medianR = out.medianRadius
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

function rebuild(): void {
  const g = graph.value
  const l = computeLayout(
    g.nodes.map((n) => ({ id: n.id, idcId: n.idcId || undefined, rackId: n.rackId || undefined, customerId: n.customerId })),
    idcs.value,
    racks.value,
    cm.view.positions
  )
  sceneN = g.nodes.map((n) => ({
    id: n.id,
    pos: l.positions.get(n.id) || { x: 0, y: 0, z: 0 },
    type: n.type,
    kind: n.kind,
    status: n.status,
    name: n.name,
    degree: n.degree,
    alarm: n.alarmLevel || 0
  }))
  sceneE = g.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, label: e.label }))
  clusters = l.clusters.map((c) => ({ id: c.id, name: c.name, center: c.center, radius: c.radius }))
  requestDraw()
}

function resize(): void {
  const el = host.value
  const c = cv.value
  if (!el || !c) return
  const rect = el.getBoundingClientRect()
  w = Math.max(1, Math.round(rect.width))
  h = Math.max(1, Math.round(rect.height))
  dpr = Math.min(2, window.devicePixelRatio || 1)
  c.width = Math.round(w * dpr)
  c.height = Math.round(h * dpr)
  c.style.width = `${w}px`
  c.style.height = `${h}px`
  requestDraw()
}

// ---------------------------------------------------------------- 交互

interface LinkDrag {
  fromId: string
  sx: number
  sy: number
  snapId: string
}
const linkDrag = ref<LinkDrag | null>(null)

type Mode = 'none' | 'orbit' | 'pan' | 'node' | 'link'
let mode: Mode = 'none'
let startX = 0
let startY = 0
let lastX = 0
let lastY = 0
let dragId = ''
let dragStartPos: Vec3 | null = null
/** 按下时想选中的节点：等松手且确认没拖动再真选中，避免拖动过程中抽屉开合导致画布重排 */
let pendingSelect = ''
let moved = false

function localPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = cv.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onDown(e: PointerEvent): void {
  if (e.button !== 0 && e.button !== 2) return
  const p = localPos(e)
  startX = lastX = p.x
  startY = lastY = p.y
  moved = false
  cv.value?.setPointerCapture(e.pointerId)
  hintVisible.value = false

  if (e.button === 2) {
    mode = 'pan'
    return
  }

  const hit = hitTest(screenMap, p.x, p.y, Math.max(6, medianR * 0.8))
  const wantLink = e.altKey || cm.linking

  if (hit && wantLink) {
    mode = 'link'
    linkDrag.value = { fromId: hit, sx: p.x, sy: p.y, snapId: '' }
    // 注意：这里**不能**改 cm.selected —— 选中会打开右侧详情抽屉，画布跟着变窄，
    // 正在拖的连线端点会在光标底下跑掉（这个 bug 只有真拖一次才发现）
    pendingSelect = hit
    requestDraw()
    return
  }
  if (hit) {
    mode = 'node'
    dragId = hit
    const sn = sceneN.find((n) => n.id === hit)
    dragStartPos = sn ? { ...sn.pos } : null
    pendingSelect = hit
    cm.view.positions[hit] = { ...(dragStartPos || { x: 0, y: 0, z: 0 }) }
    requestDraw()
    return
  }
  // 空白处点到边上：选中关系（再点删除）
  const edgeId = hitEdge(screenMap, sceneE, p.x, p.y, 7)
  if (edgeId) {
    cm.selectedEdge = edgeId
    emit('edge', edgeId)
    return
  }
  mode = 'orbit'
  cm.selectedEdge = ''
}

function onMove(e: PointerEvent): void {
  const p = localPos(e)
  const dx = p.x - lastX
  const dy = p.y - lastY
  lastX = p.x
  lastY = p.y
  if (Math.abs(p.x - startX) + Math.abs(p.y - startY) > 3) moved = true

  if (mode === 'none') {
    // hover 只做命中测试，不重算整帧（重绘由节点/边变化驱动）
    const hit = hitTest(screenMap, p.x, p.y, Math.max(6, medianR * 0.8))
    if (hit !== cm.hover) {
      cm.hover = hit
      cv.value!.style.cursor = hit ? 'pointer' : 'grab'
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
  if (mode === 'node') {
    const sn = sceneN.find((n) => n.id === dragId)
    if (!sn) return
    const b = basisOf(cm.view.camera, w, h)
    // 反投影到"面朝相机、过节点当前深度"的平面上：屏幕怎么拖，节点就怎么走
    sn.pos = unprojectOnPlane(b, p.x, p.y, sn.pos)
    requestDraw()
    return
  }
  if (mode === 'link') {
    const t = hitTest(screenMap, p.x, p.y, Math.max(8, medianR))
    const ld = linkDrag.value
    if (ld) {
      linkDrag.value = { fromId: ld.fromId, sx: p.x, sy: p.y, snapId: t && t !== ld.fromId ? t : '' }
    }
    requestDraw()
  }
}

function onUp(e: PointerEvent): void {
  try { cv.value?.releasePointerCapture(e.pointerId) } catch { /* 指针已释放 */ }
  const ld = linkDrag.value
  if (mode === 'link' && ld) {
    linkDrag.value = null
    if (ld.snapId && ld.snapId !== ld.fromId) {
      emit('link', { from: ld.fromId, to: ld.snapId, sx: ld.sx, sy: ld.sy })
    } else if (!ld.snapId) {
      toast('没有落在目标节点上，关系未建立', 'bad')
    }
    mode = 'none'
    requestDraw()
    return
  }
  if (mode === 'node' && !moved && dragStartPos) {
    // 只是点了一下：不用把"没动过的坐标"写进视图（否则布局算法以后再也挪不动它）
    delete cm.view.positions[dragId]
  }
  // 点到就选中（拖动 / 连线时不选中，避免抽屉开合把画布挤出重排）
  if (!moved && pendingSelect && (mode === 'node' || mode === 'none')) cm.selected = pendingSelect
  pendingSelect = ''
  if (mode === 'link') pendingSelect = ''
  if (mode === 'node' || mode === 'orbit' || mode === 'pan') persistView()
  mode = 'none'
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
  cm.view.camera = zoom(cm.view.camera, e.deltaY)
  persistView()
  requestDraw()
}

function onDblClick(e: MouseEvent): void {
  const p = localPos(e)
  const hit = hitTest(screenMap, p.x, p.y, Math.max(6, medianR))
  if (!hit) {
    fitView()
    return
  }
  const sn = sceneN.find((n) => n.id === hit)
  if (!sn) return
  anim = { from: { ...cm.view.camera }, to: flyTo(cm.view.camera, sn.pos), t0: performance.now(), dur: 380 }
  requestDraw()
}

/** 把当前内容框进视口。
 *  做法是「先居中、再缩放」迭代 3 次：透视投影下平移与缩放不是线性可叠加的，
 *  一次反推会把远端簇推出边界（踩过），迭代两三次就稳定了。 */
function computeFit(): Camera | null {
  if (!sceneN.length) return null
  let cam = { ...cm.view.camera }
  let placed = 0
  for (let iter = 0; iter < 3; iter++) {
    const b = basisOf(cam, w, h)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    // 机房地面圈也算进包围盒：只框节点会让圈和挂在圈外的机房名被切掉
    const extras: Vec3[] = []
    for (const c of clusters) {
      extras.push(
        { x: c.center.x - c.radius, y: 0, z: c.center.z },
        { x: c.center.x + c.radius, y: 0, z: c.center.z },
        { x: c.center.x, y: 0, z: c.center.z - c.radius },
        { x: c.center.x, y: 0, z: c.center.z + c.radius }
      )
    }
    for (const node of [...sceneN.map((n) => n.pos), ...extras]) {
      const p = projectWith(b, node)
      if (!p.visible) continue
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
      placed++
    }
    if (!Number.isFinite(minX)) return null
    placed = 0
    // 包围盒按"节点中心"算会把贴边的节点和它的标签切掉，外扩一圈
    const PAD = 52
    minX -= PAD
    maxX += PAD
    minY -= PAD * 0.6
    maxY += PAD

    // ① 把包围盒中心挪到屏幕中心（屏幕偏移按当前深度换算回世界位移）
    const k = cam.dist / b.focal
    const dx = ((minX + maxX) / 2 - w / 2) * k
    const dy = ((minY + maxY) / 2 - h / 2) * k
    cam = {
      ...cam,
      tx: cam.tx + b.right.x * dx - b.up.x * dy,
      ty: cam.ty + b.right.y * dx - b.up.y * dy,
      tz: cam.tz + b.right.z * dx - b.up.z * dy
    }

    // ② 按包围盒占屏比例缩距离（留 18% / 22% 边距给标签）
    const bw = Math.max(1, maxX - minX)
    const bh = Math.max(1, maxY - minY)
    const factor = Math.max(0.55, Math.min(1.8, Math.max(bw / (w * 0.82), bh / (h * 0.78))))
    cam.dist = Math.max(420, Math.min(9000, cam.dist * factor))
  }
  return cam
}

function fitView(animate = true): void {
  const cam = computeFit()
  if (!cam) return
  if (animate) anim = { from: { ...cm.view.camera }, to: cam, t0: performance.now(), dur: 420 }
  else cm.view.camera = cam
  requestDraw()
}

function toggleKind(kind: string): void {
  const list = cm.view.hiddenKinds
  const i = list.indexOf(kind)
  if (i >= 0) list.splice(i, 1)
  else list.push(kind)
  persistView()
  requestDraw()
}

function onKey(e: KeyboardEvent): void {
  if (!host.value) return
  const tag = (document.activeElement?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  if (e.key === '1') setMode('table')
  else if (e.key === '2') setMode('2d')
  else if (e.key === '3') setMode('3d')
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // 方向键做扇形微调：把选中节点推向屏幕方向（键盘也能整理拓扑）
    if (!cm.selected) return
    const sn = sceneN.find((n) => n.id === cm.selected)
    if (!sn) return
    const step = e.shiftKey ? 120 : 30
    const b = basisOf(cm.view.camera, w, h)
    const k = cm.view.camera.dist / b.focal
    const vx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    const vy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    sn.pos = {
      x: sn.pos.x + (b.right.x * vx + b.up.x * vy) * k,
      y: sn.pos.y + (b.right.y * vx + b.up.y * vy) * k,
      z: sn.pos.z + (b.right.z * vx + b.up.z * vy) * k
    }
    cm.view.positions[cm.selected] = { ...sn.pos }
    persistView()
    requestDraw()
    e.preventDefault()
  }
}

function onThemeChange(): void {
  dark.value = isDarkTheme()
  palette = readPalette()
  invalidateSprites()
  requestDraw()
}

function onCtx(e: MouseEvent): void {
  const p = localPos(e)
  const hit = hitTest(screenMap, p.x, p.y, Math.max(6, medianR))
  if (!hit) return
  cm.selected = hit
  // 菜单用页面坐标定位（父组件的浮层是 fixed），所以这里直接给 clientX/Y
  emit('menu', { id: hit, sx: e.clientX, sy: e.clientY })
}

onMounted(() => {
  resizeOb = new ResizeObserver(() => resize())
  if (host.value) resizeOb.observe(host.value)
  resize()
  rebuild()
  // 先算出"框住全部内容"的相机，再从一个更远的机位推进去。
  // （先播动画再适配是不行的：动画每帧覆盖 cm.view.camera，适配结果会被抹掉）
  const fitted = computeFit()
  if (fitted) {
    const far = { ...fitted, dist: Math.min(9000, fitted.dist * 1.9) }
    cm.view.camera = far
    anim = { from: far, to: fitted, t0: performance.now(), dur: 660 }
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('sqlpilot:theme', onThemeChange)
  const obs = new MutationObserver(onThemeChange)
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  ;(host.value as any).__themeObs = obs
  window.setTimeout(() => (hintVisible.value = false), 6000)
  requestDraw()
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  resizeOb?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('sqlpilot:theme', onThemeChange)
  ;((host.value as any)?.__themeObs as MutationObserver | undefined)?.disconnect()
})

// 台账/筛选变化 → 重建场景（rebuild 内部会请求一帧）；节点集合变了顺手重新框一下视口
let lastCount = -1
watch(() => graph.value, () => {
  rebuild()
  if (graph.value.nodes.length !== lastCount) {
    lastCount = graph.value.nodes.length
    window.setTimeout(() => fitView(), 30)
  }
}, { flush: 'post' })
watch(() => [cm.selected, cm.hover, cm.showLabels], () => requestDraw(), { flush: 'post' })
watch(() => cm.mode, () => {
  // 2D 模式：正俯视 + 拉远 + 缩小视场，接近正交投影，看上去就是一张平面拓扑
  if (cm.mode === '2d') {
    cm.view.camera = { ...cm.view.camera, pitch: 1.44, yaw: 0, dist: Math.max(4200, cm.view.camera.dist) }
  } else if (cm.mode === '3d') {
    cm.view.camera = { ...cm.view.camera, pitch: 0.52, dist: Math.min(2600, cm.view.camera.dist) }
  }
  persistView()
  requestDraw()
})
</script>

<style scoped>
.cg-host {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--bg);
}
.cg-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}
.cg-scope {
  position: absolute;
  left: 12px;
  top: 10px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
  color: var(--text-faint);
  pointer-events: none;
}
.cg-scope b {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-dim);
}
.cg-hidden {
  color: var(--yellow);
}
.cg-legend {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--bg-card) 86%, transparent);
  backdrop-filter: blur(6px);
}
.cg-lg {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.cg-lg:hover { color: var(--text); }
.cg-lg span.off {
  color: var(--text-faint);
  text-decoration: line-through;
  opacity: 0.65;
}
.cg-hint {
  position: absolute;
  left: 12px;
  bottom: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--bg-card) 88%, transparent);
  border: 1px solid var(--border);
  pointer-events: none;
}
.cg-hint b { color: var(--accent); font-weight: 500; }
.cg-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-dim);
  pointer-events: none;
}
.cg-empty .big {
  font-size: 34px;
  opacity: 0.35;
}
.cg-empty b { font-weight: 500; }
.cg-empty p {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
