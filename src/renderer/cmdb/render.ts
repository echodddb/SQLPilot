/**
 * CMDB 3D 画布渲染
 * ────────────────
 * Canvas 2D + 透视投影，不做 WebGL。拓扑图节点量级（几百到三千）在这个方案下
 * 完全够用，而且能直接吃项目主题、随时改绘制细节，不用为了一张图背上渲染引擎。
 *
 * 性能三条护栏（不满足就会在千节点上掉到 10fps）：
 *  1. 节点贴图预渲染成离屏 sprite 并缓存 —— 每帧只 drawImage，不重复建渐变；
 *  2. 按深度排序后顺序绘制（画家算法），不做逐像素深度测试；
 *  3. 标签有预算（默认 240 个，按度数优先），缩得太小直接不画。
 */
import { basisOf, projectWith, type Basis, type Camera, type Vec3 } from './camera'
import { kindColor, relColor, relDash, statusColor, typeGlyph } from './dict'
import type { Palette } from './theme'

export interface SceneNode {
  id: string
  pos: Vec3
  type: string
  kind: string
  status: string
  name: string
  degree: number
  alarm: number
}

export interface SceneEdge {
  id: string
  from: string
  to: string
  kind: string
  label: string
}

export interface ClusterRing {
  id: string
  name: string
  center: Vec3
  radius: number
}

export interface ScreenNode {
  x: number
  y: number
  r: number
  depth: number
}

export interface SceneInput {
  nodes: SceneNode[]
  edges: SceneEdge[]
  clusters: ClusterRing[]
  cam: Camera
  w: number
  h: number
  dpr: number
  palette: Palette
  selected: string
  hover: string
  hiddenKinds: string[]
  /** 拖拽连线中：起点节点 + 光标屏幕坐标 + 吸附目标 */
  link: { fromId: string; sx: number; sy: number; snapId: string } | null
  showLabels: boolean
}

export interface SceneOutput {
  screen: Map<string, ScreenNode>
  /** 画完后的节点半径中位数，供交互层估算命中容差 */
  medianRadius: number
}

const FONT = '11px system-ui, "Microsoft YaHei", "Segoe UI", sans-serif'
const FONT_SM = '10px system-ui, "Microsoft YaHei", "Segoe UI", sans-serif'
const SPRITE = 96
const SPRITE_R = 32

const spriteCache = new Map<string, HTMLCanvasElement>()
const SPRITE_CACHE_MAX = 160

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '')
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16)
    const g = parseInt(h[1] + h[1], 16)
    const b = parseInt(h[2] + h[2], 16)
    return `rgba(${r},${g},${b},${a})`
  }
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${a})`
  }
  return `rgba(120,120,120,${a})`
}

function shapePath(g: CanvasRenderingContext2D, kind: string, cx: number, cy: number, r: number): void {
  g.beginPath()
  if (kind === 'hardware') {
    const s = r * 0.86
    const rad = r * 0.26
    const x = cx - s
    const y = cy - s
    const w = s * 2
    g.moveTo(x + rad, y)
    g.lineTo(x + w - rad, y)
    g.quadraticCurveTo(x + w, y, x + w, y + rad)
    g.lineTo(x + w, y + w - rad)
    g.quadraticCurveTo(x + w, y + w, x + w - rad, y + w)
    g.lineTo(x + rad, y + w)
    g.quadraticCurveTo(x, y + w, x, y + w - rad)
    g.lineTo(x, y + rad)
    g.quadraticCurveTo(x, y, x + rad, y)
    g.closePath()
    return
  }
  if (kind === 'logical') {
    const s = r * 1.02
    g.moveTo(cx, cy - s)
    g.lineTo(cx + s, cy)
    g.lineTo(cx, cy + s)
    g.lineTo(cx - s, cy)
    g.closePath()
    return
  }
  g.arc(cx, cy, r * 0.94, 0, Math.PI * 2)
}

/** 节点贴图：外发光 + 形状本体 + 状态描边。缓存键含配色，主题切换自然失效。 */
function sprite(kind: string, status: string, dark: boolean, active: boolean, alarm: number): HTMLCanvasElement {
  const key = `${kind}|${status}|${dark ? 'd' : 'l'}|${active ? 'a' : 'n'}|${alarm}`
  const hit = spriteCache.get(key)
  if (hit) return hit

  const c = document.createElement('canvas')
  c.width = SPRITE
  c.height = SPRITE
  const g = c.getContext('2d')!
  const cx = SPRITE / 2
  const cy = SPRITE / 2
  const fill = kindColor(kind, dark)
  const ring = alarm >= 3 ? '#ef4444' : alarm === 2 ? '#f59e0b' : statusColor(status, dark)

  const grad = g.createRadialGradient(cx, cy, SPRITE_R * 0.35, cx, cy, SPRITE_R * 1.45)
  grad.addColorStop(0, rgba(fill, active ? 0.42 : 0.28))
  grad.addColorStop(0.6, rgba(fill, 0.1))
  grad.addColorStop(1, rgba(fill, 0))
  g.fillStyle = grad
  g.fillRect(0, 0, SPRITE, SPRITE)

  g.fillStyle = dark ? rgba(fill, 0.92) : rgba(fill, 0.88)
  g.strokeStyle = ring
  g.lineWidth = active ? 7 : 5
  shapePath(g, kind, cx, cy, SPRITE_R)
  g.fill()
  g.stroke()

  // 内部的浅色芯，让节点在小尺寸下也有"亮点"，不至于糊成一个色块
  g.beginPath()
  g.arc(cx, cy, SPRITE_R * 0.3, 0, Math.PI * 2)
  g.fillStyle = rgba('#ffffff', active ? 0.92 : 0.72)
  g.fill()

  if (spriteCache.size > SPRITE_CACHE_MAX) spriteCache.clear()
  spriteCache.set(key, c)
  return c
}

function clearSpriteCache(): void {
  spriteCache.clear()
}

/** 主题切换后必须调一次：贴图里烘焙了配色 */
export function invalidateSprites(): void {
  clearSpriteCache()
}

export function drawScene(ctx: CanvasRenderingContext2D, input: SceneInput): SceneOutput {
  const { w, h, dpr, cam, palette } = input
  const b: Basis = basisOf(cam, w, h)
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, w, h)

  const screen = new Map<string, ScreenNode>()
  type Item = { n: SceneNode; p: ScreenNode }
  const items: Item[] = []
  for (const n of input.nodes) {
    const p = projectWith(b, n.pos)
    if (!p.visible) continue
    const base = 34 + 6.2 * Math.sqrt(n.degree)
    const r = Math.min(44, Math.max(3.2, base * p.scale))
    const s: ScreenNode = { x: p.x, y: p.y, r, depth: p.depth }
    screen.set(n.id, s)
    items.push({ n, p: s })
  }
  const radii = items.map((i) => i.p.r).sort((x, y) => x - y)
  const medianRadius = radii.length ? radii[Math.floor(radii.length / 2)] : 6

  // ---- 机房地面圈（先画，压在最底层） ----
  const clusterLabels: { x: number; y: number; name: string }[] = []
  ctx.save()
  ctx.lineWidth = 1
  ctx.setLineDash([5, 6])
  for (const c of input.clusters) {
    const pts: { x: number; y: number }[] = []
    let visibleCount = 0
    const SEG = 56
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2
      const p = projectWith(b, {
        x: c.center.x + Math.cos(a) * c.radius,
        y: 0,
        z: c.center.z + Math.sin(a) * c.radius
      })
      if (p.visible) visibleCount++
      pts.push({ x: p.x, y: p.y })
    }
    if (visibleCount < SEG * 0.5) continue
    ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
    ctx.fillStyle = palette.dark ? 'rgba(255,255,255,0.022)' : 'rgba(2,30,60,0.022)'
    ctx.fill()
    ctx.strokeStyle = palette.grid
    ctx.stroke()

    // 机房名挂在圆环**近端下方**（+Z 侧）：资产都是往上堆的，环上方一定是节点，
    // 挂下面那圈空白里反而永远不打架
    const lab = projectWith(b, { x: c.center.x, y: 0, z: c.center.z + c.radius })
    const cp = lab.visible ? lab : projectWith(b, c.center)
    if (cp.visible) clusterLabels.push({ x: cp.x, y: cp.y + 34, name: c.name })
  }
  ctx.restore()

  // ---- 关系边 ----
  const hidden = new Set(input.hiddenKinds)
  type EdgeItem = { e: SceneEdge; a: ScreenNode; b2: ScreenNode; depth: number }
  const edges: EdgeItem[] = []
  for (const e of input.edges) {
    if (hidden.has(e.kind)) continue
    const a = screen.get(e.from)
    const b2 = screen.get(e.to)
    if (!a || !b2) continue
    edges.push({ e, a, b2, depth: (a.depth + b2.depth) / 2 })
  }
  edges.sort((x, y) => y.depth - x.depth)

  let minD = Infinity
  let maxD = -Infinity
  for (const it of edges) {
    if (it.depth < minD) minD = it.depth
    if (it.depth > maxD) maxD = it.depth
  }
  const span = Math.max(1, maxD - minD)
  const selected = input.selected
  const hover = input.hover
  const focusMode = !!selected || !!hover

  for (const it of edges) {
    const t = 1 - (it.depth - minD) / span
    const touches = selected && (it.e.from === selected || it.e.to === selected)
    const touchesHover = hover && (it.e.from === hover || it.e.to === hover)
    let alpha = 0.16 + 0.5 * t
    if (touches || touchesHover) alpha = 0.95
    else if (focusMode) alpha *= 0.32
    ctx.globalAlpha = alpha
    ctx.strokeStyle = relColor(it.e.kind, palette.dark)
    ctx.lineWidth = (it.e.kind === 'hosting' ? 1.5 : 1.1) * (touches || touchesHover ? 1.9 : 1)
    ctx.setLineDash(relDash(it.e.kind))
    ctx.beginPath()
    ctx.moveTo(it.a.x, it.a.y)
    ctx.lineTo(it.b2.x, it.b2.y)
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  // ---- 节点（远 → 近） ----
  items.sort((x, y) => y.p.depth - x.p.depth)
  for (const it of items) {
    const isSel = it.n.id === selected
    const isHover = it.n.id === hover
    const linked = !focusMode || !selected || edges.some(
      (e) => (e.e.from === selected && e.e.to === it.n.id) || (e.e.to === selected && e.e.from === it.n.id)
    ) || isSel
    const dim = focusMode && !linked && !isHover
    ctx.globalAlpha = dim ? 0.24 : 1
    const sp = sprite(it.n.kind, it.n.status, palette.dark, isSel || isHover, it.n.alarm)
    const r = it.p.r * (isSel ? 1.22 : isHover ? 1.12 : 1)
    const drawR = r * 1.5
    ctx.drawImage(sp, it.p.x - drawR, it.p.y - drawR, drawR * 2, drawR * 2)

    if (isSel) {
      ctx.beginPath()
      ctx.arc(it.p.x, it.p.y, r * 1.85, 0, Math.PI * 2)
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
    if (input.link && it.n.id === input.link.snapId) {
      ctx.beginPath()
      ctx.arc(it.p.x, it.p.y, r * 1.7, 0, Math.PI * 2)
      ctx.strokeStyle = rgba('#22c55e', 0.95)
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1

  // ---- 标签（有预算：按度数优先，缩得太小干脆不画） ----
  if (input.showLabels) {
    const budget = 220
    const cand = items
      .filter((it) => it.p.r >= 3.2)
      .sort((x, y) => y.n.degree - x.n.degree || x.p.depth - y.p.depth)
    // 标签占位表：节点密的时候光靠"度数优先"还是会叠字，直接做矩形避让
    const occupied: { x1: number; y1: number; x2: number; y2: number }[] = []
    const clash = (r: { x1: number; y1: number; x2: number; y2: number }): boolean =>
      occupied.some((o) => !(r.x2 < o.x1 || r.x1 > o.x2 || r.y2 < o.y1 || r.y1 > o.y2))
    let drawn = 0
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const it of cand) {
      const must = it.n.id === selected || it.n.id === hover || it.n.degree >= 4
      if (!must && drawn >= budget) continue
      if (!must && it.p.r < medianRadius * 0.85) continue
      const label = it.n.name.length > 18 ? `${it.n.name.slice(0, 17)}…` : it.n.name
      const tw = ctx.measureText(label).width
      const rectAt = (y: number) => ({ x1: it.p.x - tw / 2, y1: y, x2: it.p.x + tw / 2, y2: y + 12 })
      let y = it.p.y + it.p.r * 1.5 + 5
      let rect = rectAt(y)
      if (!must && clash(rect)) {
        // 下方被占了就翻到上方；还占就放弃这个标签（宁可少个字，不要糊成一片）
        y = it.p.y - it.p.r * 1.5 - 18
        rect = rectAt(y)
        if (clash(rect)) continue
      }
      occupied.push(rect)
      const dim = focusMode && !must && selected ? true : false
      ctx.globalAlpha = dim ? 0.28 : 0.92
      ctx.fillStyle = palette.text
      ctx.fillText(label, it.p.x, y)
      drawn++
    }
    ctx.globalAlpha = 1
  }

  // ---- 机房名（最后画，带底片：即使落在节点上也不糊） ----
  if (clusterLabels.length) {
    ctx.font = FONT_SM
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const cl of clusterLabels) {
      const tw = ctx.measureText(cl.name).width
      ctx.globalAlpha = 0.92
      ctx.fillStyle = palette.bg
      const pad = 4
      ctx.beginPath()
      const rx = cl.x - tw / 2 - pad
      const ry = cl.y - 12
      const rw = tw + pad * 2
      const rh = 14
      ctx.roundRect ? ctx.roundRect(rx, ry, rw, rh, 3) : ctx.rect(rx, ry, rw, rh)
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.fillStyle = palette.faint
      ctx.fillText(cl.name, cl.x, cl.y)
    }
  }

  // ---- 连线中的预览 ----
  if (input.link) {
    const from = screen.get(input.link.fromId)
    if (from) {
      ctx.setLineDash([6, 5])
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      const mx = (from.x + input.link.sx) / 2
      const my = Math.min(from.y, input.link.sy) - Math.abs(from.x - input.link.sx) * 0.18 - 30
      ctx.quadraticCurveTo(mx, my, input.link.sx, input.link.sy)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(input.link.sx, input.link.sy, 4, 0, Math.PI * 2)
      ctx.fillStyle = palette.accent
      ctx.fill()
    }
  }

  ctx.restore()
  return { screen, medianRadius }
}

/** 命中测试：屏幕点最近的节点（含容差），同距离取近处那个 */
export function hitTest(screen: Map<string, ScreenNode>, sx: number, sy: number, slack = 8): string {
  let best = ''
  let bestScore = Infinity
  let bestDepth = Infinity
  for (const [id, p] of screen) {
    const d = Math.hypot(p.x - sx, p.y - sy)
    const tol = p.r + slack
    if (d > tol) continue
    const score = d / tol
    if (score < bestScore - 0.02 || (Math.abs(score - bestScore) <= 0.02 && p.depth < bestDepth)) {
      best = id
      bestScore = score
      bestDepth = p.depth
    }
  }
  return best
}

/** 关系边的命中测试：点到线段距离（3D 里点细线很难，容差放宽到 6px） */
export function hitEdge(
  screen: Map<string, ScreenNode>,
  edges: SceneEdge[],
  sx: number,
  sy: number,
  slack = 6
): string {
  let best = ''
  let bestD = slack
  for (const e of edges) {
    const a = screen.get(e.from)
    const c = screen.get(e.to)
    if (!a || !c) continue
    const d = distToSegment(sx, sy, a.x, a.y, c.x, c.y)
    if (d < bestD) {
      bestD = d
      best = e.id
    }
  }
  return best
}

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export { typeGlyph }
