/**
 * 机房三维几何（纯函数，无 electron / DOM 依赖）
 * ─────────────────────────────────────────────────────
 * 世界单位统一用 **厘米**：1U = 4.445cm、标准地砖 60cm、机柜 60×120cm。
 * 这套比例不是随便定的——整屏缩放后 42U 机柜就是 2 米高，跟人站旁边一个量级，
 * 所以"机柜看起来像机柜、服务器像服务器"这件事是靠真实尺寸换来的。
 *
 * 这里只算几何：机房尺寸、机柜落位、设备在 U 位上的包围盒、前面板端口归一化坐标、
 * 网线两端的世界坐标。绘制在 renderer/cmdb/room.ts，交互在 CmdbRoom3D.vue。
 * 单测直接 bundle 这个文件就能验证（不需要起 Electron）。
 */
import {
  specOf, portsOf,
  type CmdbAsset, type CmdbDoc, type CmdbCable, type CmdbNetKind, type CmdbPortGroup
} from './cmdb-model'

/** 1U = 44.45mm（19 英寸标准） */
export const U_CM = 4.445
/** 机柜底座（脚轮 + 底板）与顶部框架 */
export const RACK_BASE_CM = 9
export const RACK_TOP_CM = 7
/** 设备面板左右各留的安装缝 */
export const DEVICE_MARGIN_CM = 1.2
/** 默认地砖（架空地板 600×600） */
export const TILE_MM_DEFAULT = 600

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface PortSlot {
  id: string
  group: CmdbPortGroup
  index: number
  label: string
  /** 面板归一化坐标：u 从左到右、v 从上到下，均在 0..1 */
  u: number
  v: number
  /** 端口自身尺寸（归一化） */
  w: number
  h: number
}

/**
 * 前面板端口布局：盘位摆左侧（真实服务器就是左侧一排盘位），
 * 电口/光口/管理口/Console 在右侧竖着分带，电源口贴最右。
 * 24/48 口交换机挤在 1U 里会变成一排小方块 —— 这正是真机远看的样子，不必放大。
 */
export function portSlots(asset: Partial<CmdbAsset>): PortSlot[] {
  const ports = portsOf(asset)
  if (!ports.length) return []
  const byGroup = new Map<CmdbPortGroup, typeof ports>()
  for (const p of ports) {
    const arr = byGroup.get(p.group) || []
    arr.push(p)
    byGroup.set(p.group, arr)
  }

  const out: PortSlot[] = []
  const disks = byGroup.get('disk') || []
  if (disks.length) {
    const cols = disks.length <= 8 ? 4 : 6
    const rows = Math.ceil(disks.length / cols)
    const x0 = 0.03
    const x1 = 0.4
    const y0 = 0.16
    const y1 = 0.86
    const cw = (x1 - x0) / cols
    const ch = (y1 - y0) / rows
    disks.forEach((p, i) => {
      const c = i % cols
      const r = Math.floor(i / cols)
      out.push({
        id: p.id, group: p.group, index: p.index, label: p.label,
        u: x0 + c * cw + cw * 0.12, v: y0 + r * ch + ch * 0.16,
        w: cw * 0.76, h: ch * 0.68
      })
    })
  }

  const pw = byGroup.get('power') || []
  const bands: CmdbPortGroup[] = ['nic', 'sfp', 'mgmt', 'console']
  const present = bands.filter((g) => (byGroup.get(g) || []).length)
  const bx0 = disks.length ? 0.45 : 0.05
  const bx1 = pw.length ? 0.9 : 0.96
  const bandGap = 0.05
  const totalH = 0.84 - 0.14
  const bandH = present.length ? (totalH - bandGap * (present.length - 1)) / present.length : totalH
  present.forEach((g, bi) => {
    const list = byGroup.get(g) || []
    const y = 0.14 + bi * (bandH + bandGap)
    const cellW = (bx1 - bx0) / Math.max(1, list.length)
    const w = Math.min(cellW * 0.72, bandH * 0.62)
    list.forEach((p, i) => {
      out.push({
        id: p.id, group: p.group, index: p.index, label: p.label,
        u: bx0 + i * cellW + (cellW - w) / 2,
        v: y + bandH * 0.18,
        w,
        h: bandH * 0.64
      })
    })
  })

  // 电源口：最右侧竖排（真机就是两个竖向 IEC 插座）
  const ph = Math.min(0.34, 0.7 / Math.max(1, pw.length))
  pw.forEach((p, i) => {
    out.push({
      id: p.id, group: p.group, index: p.index, label: p.label,
      u: 0.925, v: 0.15 + i * (ph + 0.04),
      w: 0.06, h: ph
    })
  })
  return out
}

export interface RoomPlacement {
  id: string
  code: string
  uTotal: number
  /** 网格落位与占地（格子数） */
  col: number
  row: number
  cols: number
  rows: number
  /** 世界包围盒（中心 x/z，尺寸 w/d/h，底面 y0） */
  x: number
  z: number
  w: number
  d: number
  h: number
  y0: number
}

export interface RoomDevice {
  id: string
  asset: CmdbAsset
  rackId: string
  u: number
  uHeight: number
  /** 世界包围盒（中心点） */
  x: number
  y: number
  z: number
  w: number
  h: number
  d: number
  slots: PortSlot[]
}

export interface RoomCable {
  id: string
  fromId: string
  toId: string
  fromPort: string
  toPort: string
  net: CmdbNetKind
  label: string
  a: Vec3
  b: Vec3
}

export interface RoomModel {
  idcId: string
  name: string
  /** 地板格数与单格边长（cm） */
  cols: number
  rows: number
  tile: number
  widthCm: number
  depthCm: number
  racks: RoomPlacement[]
  devices: RoomDevice[]
  cables: RoomCable[]
  /** 有资产但没法画进这个房间的数量（未指定机房 / 未上架） */
  outside: number
}

function tileCm(idc: { tileMm?: number }): number {
  const mm = idc.tileMm && idc.tileMm > 0 ? idc.tileMm : TILE_MM_DEFAULT
  return Math.max(20, Math.min(200, mm / 10))
}

export function rackFootprint(rack: { widthMm?: number; depthMm?: number }, tile: number): { cols: number; rows: number } {
  const w = rack.widthMm && rack.widthMm > 0 ? rack.widthMm : 600
  const d = rack.depthMm && rack.depthMm > 0 ? rack.depthMm : 1200
  return {
    cols: Math.max(1, Math.ceil(w / 10 / tile - 0.001)),
    rows: Math.max(1, Math.ceil(d / 10 / tile - 0.001))
  }
}

/** 机柜落位：有 gridCol/gridRow 用人工位置，否则按"每排 3 格（2 格柜 + 1 格通道）"自动排 */
function autoPlace(idx: number, fp: { cols: number; rows: number }, cols: number, rows: number): { col: number; row: number } {
  const perRow = Math.max(1, Math.floor(cols / fp.cols))
  const band = fp.rows + 1 // 一排机柜 + 一条 600 通道
  const col = (idx % perRow) * fp.cols
  const row = Math.floor(idx / perRow) * band
  return { col: Math.min(Math.max(0, col), Math.max(0, cols - fp.cols)), row: Math.min(Math.max(0, row), Math.max(0, rows - fp.rows)) }
}

export function roomOf(doc: CmdbDoc, idcId?: string, opts: { hideRetired?: boolean } = {}): RoomModel | null {
  const idc = idcId ? doc.idcs.find((d) => d.id === idcId) : doc.idcs[0]
  if (!idc) return null
  const tile = tileCm(idc)
  const cols = Math.max(4, Math.min(40, idc.cols || 8))
  const rows = Math.max(4, Math.min(40, idc.rows || 6))
  const widthCm = cols * tile
  const depthCm = rows * tile
  const originX = -widthCm / 2
  const originZ = -depthCm / 2

  const idcRacks = doc.racks.filter((r) => r.idcId === idc.id)
  const placements: RoomPlacement[] = []
  idcRacks.forEach((r, i) => {
    const fp = rackFootprint(r, tile)
    const manual = r.gridCol !== undefined && r.gridRow !== undefined
    const pos = manual ? { col: r.gridCol!, row: r.gridRow! } : autoPlace(i, fp, cols, rows)
    const col = Math.min(Math.max(0, pos.col), Math.max(0, cols - fp.cols))
    const row = Math.min(Math.max(0, pos.row), Math.max(0, rows - fp.rows))
    const uTotal = Math.max(1, Math.min(60, r.uTotal || 42))
    placements.push({
      id: r.id,
      code: r.code,
      uTotal,
      col, row,
      cols: fp.cols,
      rows: fp.rows,
      x: originX + (col + fp.cols / 2) * tile,
      z: originZ + (row + fp.rows / 2) * tile,
      w: Math.min(fp.cols * tile, (r.widthMm || 600) / 10) - 4,
      d: Math.min(fp.rows * tile, (r.depthMm || 1200) / 10) - 6,
      h: RACK_BASE_CM + uTotal * U_CM + RACK_TOP_CM,
      y0: 0
    })
  })
  const byRack = new Map(placements.map((p) => [p.id, p]))

  const hideRetired = opts.hideRetired !== false
  const live = doc.assets.filter((a) => !a.deletedAt && (!hideRetired || a.status !== 'retired'))
  const devices: RoomDevice[] = []
  let outside = 0
  const floorUsed = new Map<string, number>()

  for (const a of live) {
    if (a.idcId !== idc.id) { outside++; continue }
    const spec = specOf(a.spec)
    const uHeight = Math.max(1, Math.min(20, a.uHeight || spec?.u || 1))

    if (a.rackId && byRack.has(a.rackId)) {
      const rack = byRack.get(a.rackId)!
      const u = Math.max(1, Math.min(rack.uTotal - uHeight + 1, a.u || 1))
      const innerW = rack.w - DEVICE_MARGIN_CM * 2
      const d = Math.min(rack.d - 8, (spec?.depthMm || 600) / 10)
      const h = uHeight * U_CM - 0.35
      devices.push({
        id: a.id, asset: a, rackId: rack.id, u, uHeight,
        x: rack.x,
        y: RACK_BASE_CM + (u - 1) * U_CM + h / 2,
        // 设备**贴着前立柱**装（缩进 4cm）：真机架就是这样，机身前脸几乎与柜门齐平。
        // 居中摆放会让每台设备的顶面暴露出来，整柜看起来像"货架"而不是"服务器柜"（踩过）。
        z: rack.z + rack.d / 2 - d / 2 - 4,
        w: Math.min(innerW, (spec?.widthMm || 482) / 10),
        h,
        d,
        slots: portSlots({ ...a, spec: a.spec || spec?.id })
      })
      continue
    }

    // 落地设备（塔式 UPS 等）：按格子摆，没坐标的从最后一排往前排，避免挡住机柜正面。
    // 上架型设备（spec.u > 0）如果没机柜，算"未上架"，不往地上扔 —— 那样看起来像机房堆垃圾。
    const floorOnly = !a.rackId && (spec ? spec.u === 0 : a.type === 'ups')
    if (!floorOnly) { outside++; continue }
    let col = a.floorCol
    let row = a.floorRow
    if (col === undefined || row === undefined) {
      let n = floorUsed.get(`${idc.id}`) || 0
      // 从最后一排往前排，避免挡住机柜正面
      const per = Math.max(1, Math.floor(cols / 2))
      col = (n % per) * 2
      row = rows - 1 - Math.floor(n / per)
      floorUsed.set(`${idc.id}`, n + 1)
      col = Math.min(Math.max(0, col), cols - 1)
      row = Math.min(Math.max(0, row), rows - 1)
    }
    const w = Math.min(tile * 1.2, (spec?.widthMm || 480) / 10)
    const d = Math.min(tile * 1.6, (spec?.depthMm || 700) / 10)
    const h = spec && spec.u > 0 ? RACK_BASE_CM + spec.u * U_CM : 45
    devices.push({
      id: a.id, asset: a, rackId: '', u: 0, uHeight: spec?.u || 0,
      x: originX + (col + 0.5) * tile,
      y: h / 2,
      z: originZ + (row + 0.5) * tile,
      w, h, d,
      slots: portSlots({ ...a, spec: a.spec || spec?.id })
    })
  }

  // 网线端点：用端口在面板上的归一化位置换算出世界坐标，找不到端口就落到面板中心
  const devById = new Map(devices.map((d) => [d.id, d]))
  const cables: RoomCable[] = []
  for (const c of doc.cables) {
    const da = devById.get(c.fromId)
    const db = devById.get(c.toId)
    if (!da || !db) continue
    cables.push({
      id: c.id, fromId: c.fromId, toId: c.toId,
      fromPort: c.fromPort, toPort: c.toPort,
      net: c.net, label: c.label || '',
      a: portAnchor(da, c.fromPort),
      b: portAnchor(db, c.toPort)
    })
  }

  return { idcId: idc.id, name: idc.name, cols, rows, tile, widthCm, depthCm, racks: placements, devices, cables, outside }
}

/** 端口世界坐标：面板朝 +Z（相机默认从 +Z 侧看），线从面板前 6cm 引出 */
export function portAnchor(d: RoomDevice, portId: string): Vec3 {
  const s = d.slots.find((p) => p.id === portId)
  const u = s ? s.u + s.w / 2 : 0.5
  const v = s ? s.v + s.h / 2 : 0.5
  return {
    x: d.x - d.w / 2 + u * d.w,
    y: d.y + d.h / 2 - v * d.h,
    z: d.z + d.d / 2 + 3
  }
}

/** 某台设备在某机柜里从某个 U 位开始能不能放下（检查 U 位冲突） */
export function rackSlotFree(doc: CmdbDoc, rackId: string, u: number, uHeight: number, exceptId?: string): boolean {
  if (u < 1) return false
  const end = u + uHeight - 1
  for (const a of doc.assets) {
    if (a.deletedAt || a.rackId !== rackId || a.id === exceptId) continue
    const s = a.u || 1
    const e = s + Math.max(1, a.uHeight || 1) - 1
    if (u <= e && end >= s) return false
  }
  return true
}

/** 从下往上找第一段能放下 uHeight 的空 U 位（拖拽落柜时的兜底） */
export function firstFreeU(doc: CmdbDoc, rackId: string, uHeight: number, uTotal: number, exceptId?: string): number {
  for (let u = 1; u + uHeight - 1 <= uTotal; u++) {
    if (rackSlotFree(doc, rackId, u, uHeight, exceptId)) return u
  }
  return Math.max(1, uTotal - uHeight + 1)
}

/** 网格占用检查：机柜拖到别处时判断有没有压到别的机柜（压到就拒绝落位） */
export function rackOverlap(placements: RoomPlacement[], col: number, row: number, cols: number, rows: number, exceptId?: string): string {
  for (const p of placements) {
    if (p.id === exceptId) continue
    if (col < p.col + p.cols && col + cols > p.col && row < p.row + p.rows && row + rows > p.row) return p.code
  }
  return ''
}

/** 机柜 -> 它的设备（渲染时按柜分组，避免每帧线性扫全表） */
export function devicesByRack(model: RoomModel): Map<string, RoomDevice[]> {
  const m = new Map<string, RoomDevice[]>()
  for (const d of model.devices) {
    if (!d.rackId) continue
    const arr = m.get(d.rackId) || []
    arr.push(d)
    m.set(d.rackId, arr)
  }
  for (const arr of m.values()) arr.sort((a, b) => a.u - b.u)
  return m
}

/** 房间统计：给工具栏显示"几柜 / 几台 / 几根线 / 几 U 空闲" */
export function roomStats(model: RoomModel): { racks: number; devices: number; cables: number; usedU: number; totalU: number } {
  let usedU = 0
  let totalU = 0
  for (const r of model.racks) totalU += r.uTotal
  for (const d of model.devices) if (d.rackId) usedU += d.uHeight
  return { racks: model.racks.length, devices: model.devices.length, cables: model.cables.length, usedU, totalU }
}

export type { CmdbCable }
