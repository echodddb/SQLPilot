/**
 * CMDB 相机与投影（纯函数，无 DOM 依赖，单测可直接跑）
 * ────────────────────────────────────────────────────
 * 为什么自己写而不上 three.js：
 *  · 项目现有图表全是手写 SVG，不引图表库；three 打包多 500KB，且画布不吃 CSS 变量，
 *    亮/暗主题切换还得自己桥接一层贴图；
 *  · 这里真正需要的只有「透视投影 + 轨道旋转 + 屏幕反投影」，矩阵库是杀鸡牛刀；
 *  · 拖拽连线的命中测试与吸附，自研比套 three 的射线拾取更直接。
 *
 * 坐标约定：Y 轴向上（3D 里"层级"用 Y 表达），相机用「眼睛 + 看向目标」的显式基向量，
 * 比先 yaw 再 pitch 的欧拉链更好推、也更容易写断言。
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Camera {
  /** 绕 Y 轴方位角（弧度） */
  yaw: number
  /** 仰角：正数 = 眼睛在上方俯视（0 = 平视，+1.45 ≈ 正俯视） */
  pitch: number
  /** 眼睛到目标距离（世界单位） */
  dist: number
  tx: number
  ty: number
  tz: number
}

export interface Projected {
  x: number
  y: number
  /** 沿视线方向的深度（>0 在眼前） */
  depth: number
  /** 透视缩放系数（屏幕 px / 世界单位） */
  scale: number
  visible: boolean
}

/** 垂直视场角。小一点透视更"平"，大一点纵深更强；50° 对拓扑图刚好 */
export const FOV = (50 * Math.PI) / 180

/** 俯仰角上限：贴到正上方时 up 向量与视线共线，cross 退化，留一点余量 */
export const PITCH_LIMIT = 1.45

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export interface Basis {
  eye: Vec3
  right: Vec3
  up: Vec3
  forward: Vec3
  focal: number
  cx: number
  cy: number
}

/** 由相机参数算出眼睛位置与正交基。每帧算一次，所有节点复用同一份基。 */
export function basisOf(cam: Camera, w: number, h: number, fov = FOV): Basis {
  const pitch = clamp(cam.pitch, -PITCH_LIMIT, PITCH_LIMIT)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const eye: Vec3 = {
    x: cam.tx + cam.dist * cp * Math.sin(cam.yaw),
    y: cam.ty + cam.dist * sp,
    z: cam.tz + cam.dist * cp * Math.cos(cam.yaw)
  }
  const forward = norm(sub({ x: cam.tx, y: cam.ty, z: cam.tz }, eye))
  const right = norm(cross(forward, { x: 0, y: 1, z: 0 }))
  const up = cross(right, forward)
  return {
    eye,
    right,
    up,
    forward,
    focal: h / 2 / Math.tan(fov / 2),
    cx: w / 2,
    cy: h / 2
  }
}

export function projectWith(b: Basis, p: Vec3): Projected {
  const d = sub(p, b.eye)
  const depth = dot(d, b.forward)
  if (depth <= 1) return { x: 0, y: 0, depth, scale: 0, visible: false }
  const scale = b.focal / depth
  return {
    x: b.cx + dot(d, b.right) * scale,
    y: b.cy - dot(d, b.up) * scale,
    depth,
    scale,
    visible: true
  }
}

export function project(p: Vec3, cam: Camera, w: number, h: number, fov = FOV): Projected {
  return projectWith(basisOf(cam, w, h, fov), p)
}

/** 屏幕坐标 → 与视线垂直、过参考点的那个平面上的世界坐标。
 *  拖拽节点时用它：屏幕怎么拖，节点就在"面朝相机"的平面上怎么动，不会被拉进屏幕里。 */
export function unprojectOnPlane(b: Basis, sx: number, sy: number, worldRef: Vec3): Vec3 {
  const depth = Math.max(1, dot(sub(worldRef, b.eye), b.forward))
  const scale = b.focal / depth
  const x = (sx - b.cx) / scale
  const y = (b.cy - sy) / scale
  return {
    x: b.eye.x + b.right.x * x + b.up.x * y + b.forward.x * depth,
    y: b.eye.y + b.right.y * x + b.up.y * y + b.forward.y * depth,
    z: b.eye.z + b.right.z * x + b.up.z * y + b.forward.z * depth
  }
}

/** 屏幕坐标 → 地板平面（y = 常数）上的世界点。
 *  机柜/落地设备"贴地拖动"必须用这个：用上面那个"面朝相机的平面"会把柜子拖到半空中。
 *  视线与地面平行时（pitch 接近 0）没有交点，返回 null 让调用方忽略这一次移动。 */
export function unprojectOnFloor(b: Basis, sx: number, sy: number, y = 0): Vec3 | null {
  // 相机基下，屏幕点的方向 = right*(sx-cx)/focal + up*(cy-sy)/focal + forward
  const rx = (sx - b.cx) / b.focal
  const ry = (b.cy - sy) / b.focal
  const dir = {
    x: b.right.x * rx + b.up.x * ry + b.forward.x,
    y: b.right.y * rx + b.up.y * ry + b.forward.y,
    z: b.right.z * rx + b.up.z * ry + b.forward.z
  }
  if (Math.abs(dir.y) < 1e-4) return null
  const t = (y - b.eye.y) / dir.y
  if (t <= 0 || t > 100000) return null
  return { x: b.eye.x + dir.x * t, y, z: b.eye.z + dir.z * t }
}

/** 轨道旋转：拖拽画布空白处。x 轴改方位角，y 轴改仰角（夹在 ±LIMIT）。 */
export function orbit(cam: Camera, dxPx: number, dyPx: number): Camera {
  return {
    ...cam,
    yaw: cam.yaw - dxPx * 0.006,
    pitch: clamp(cam.pitch + dyPx * 0.005, -PITCH_LIMIT, PITCH_LIMIT)
  }
}

/** 缩放：滚轮。按比例缩放而不是线性，手感在近处和远处一致。 */
export function zoom(cam: Camera, deltaY: number): Camera {
  const k = Math.exp(deltaY * 0.0011)
  return { ...cam, dist: clamp(cam.dist * k, 300, 16000) }
}

/** 平移：右键拖拽 / 中键。沿相机的右向量与上向量移动目标点。 */
export function pan(cam: Camera, dxPx: number, dyPx: number, w: number, h: number): Camera {
  const b = basisOf(cam, w, h)
  const k = cam.dist / b.focal
  return {
    ...cam,
    tx: cam.tx - (b.right.x * dxPx + b.up.x * dyPx) * k,
    ty: cam.ty - (b.right.y * dxPx + b.up.y * dyPx) * k,
    tz: cam.tz - (b.right.z * dxPx + b.up.z * dyPx) * k
  }
}

/** 相机飞向某点（双击聚焦）：只给目标返回值，插值交给调用方的动画循环 */
export function flyTo(cam: Camera, target: Vec3, dist?: number): Camera {
  return { ...cam, tx: target.x, ty: target.y, tz: target.z, dist: clamp(dist ?? cam.dist * 0.55, 300, 16000) }
}

// ---------------------------------------------------------------- 布局

export interface ClusterInfo {
  id: string
  name: string
  center: Vec3
  radius: number
  count: number
}

export interface LayoutResult {
  positions: Map<string, Vec3>
  clusters: ClusterInfo[]
  /** 自由区（未指定机房的资产）中心，画布上给一个淡标签 */
  freeCenter: Vec3 | null
}

/**
 * 布局策略：**确定性簇布局**，不做全局力导向。
 *
 * 理由不是偷懒：纯力导向在"客户/机房/机柜/资产"这种四级归属上会得到一团毛线——
 * 同一机柜的机器被斥力推开，跨机房的线又把人拉回来，收敛慢且每次打开都不一样。
 * 这里让空间直接编码归属：
 *   · 机房 = 一个圆盘簇，在 XZ 平面上按网格排开，簇之间天然留出跨机房链路的空间；
 *   · 机柜 = 簇内的环，半径随机柜数增长；
 *   · 资产 = 机柜上方向下堆叠的柱（Y 轴表达"层"），同柜的机器永远挨在一起；
 *   · 未上架 / 未指定机房的落到对应环或自由区。
 * 结果稳定、可预期、无需迭代，1000 节点也是 O(n) 一次算完。
 * 人工拖动过的坐标从 view.positions 覆盖，布局算法不跟用户抢位置。
 */
export function computeLayout(
  assets: { id: string; idcId?: string; rackId?: string; customerId?: string }[],
  idcs: { id: string; name: string }[],
  racks: { id: string; idcId: string; code: string }[],
  override?: Record<string, Vec3>
): LayoutResult {
  const positions = new Map<string, Vec3>()
  const byIdc = new Map<string, string[]>()
  for (const a of assets) {
    const key = a.idcId || '__noidc'
    const arr = byIdc.get(key) || []
    arr.push(a.id)
    byIdc.set(key, arr)
  }

  const usedIdc = idcs.filter((d) => byIdc.has(d.id))
  const hasFree = byIdc.has('__noidc')
  const clusterCount = usedIdc.length + (hasFree ? 1 : 0)
  const cols = Math.max(1, Math.ceil(Math.sqrt(clusterCount)))
  const rows = Math.max(1, Math.ceil(clusterCount / cols))
  const SPACING = 1500

  const clusters: ClusterInfo[] = []
  let freeCenter: Vec3 | null = null

  const placeCluster = (slot: number): Vec3 => {
    const col = slot % cols
    const row = Math.floor(slot / cols)
    return {
      x: (col - (cols - 1) / 2) * SPACING,
      y: 0,
      z: (row - (rows - 1) / 2) * SPACING
    }
  }

  const assetById = new Map(assets.map((a) => [a.id, a]))

  usedIdc.forEach((idc, i) => {
    const center = placeCluster(i)
    const ids = byIdc.get(idc.id) || []
    const idcRacks = racks.filter((r) => r.idcId === idc.id)
    const ringR = Math.max(240, Math.min(900, 120 + idcRacks.length * 46))
    const rackPos = new Map<string, Vec3>()

    // 机柜：沿圆环均匀分布
    idcRacks.forEach((r, k) => {
      const ang = (k / Math.max(1, idcRacks.length)) * Math.PI * 2 - Math.PI / 2
      rackPos.set(r.id, {
        x: center.x + Math.cos(ang) * ringR,
        y: 0,
        z: center.z + Math.sin(ang) * ringR
      })
    })

    const loose: string[] = []
    for (const id of ids) {
      const a = assetById.get(id)
      if (!a) continue
      if (a.rackId && rackPos.has(a.rackId)) continue
      loose.push(id)
    }

    // 资产：机柜上方按层堆叠（同柜内 index 决定高度，形成一根"柱"）
    const stackIndex = new Map<string, number>()
    for (const id of ids) {
      const a = assetById.get(id)
      if (!a || !a.rackId) continue
      const base = rackPos.get(a.rackId)
      if (!base) continue
      const i2 = stackIndex.get(a.rackId) || 0
      stackIndex.set(a.rackId, i2 + 1)
      positions.set(id, {
        x: base.x + Math.cos(i2 * 2.399) * 44,
        y: 52 + i2 * 64,
        z: base.z + Math.sin(i2 * 2.399) * 44
      })
    }

    // 未上架：绕簇外圈一圈（仍在同一机房内，视觉上"贴着机房"，不像自由区那么远）
    loose.forEach((id, k) => {
      const ang = (k / Math.max(1, loose.length)) * Math.PI * 2
      const r = ringR + 170
      positions.set(id, {
        x: center.x + Math.cos(ang) * r,
        y: 44 + (k % 3) * 42,
        z: center.z + Math.sin(ang) * r
      })
    })

    clusters.push({ id: idc.id, name: idc.name, center, radius: ringR + 130, count: ids.length })
  })

  if (hasFree) {
    const center = placeCluster(usedIdc.length)
    freeCenter = center
    const ids = byIdc.get('__noidc') || []
    const perRow = 10
    ids.forEach((id, k) => {
      const col = k % perRow
      const row = Math.floor(k / perRow)
      positions.set(id, {
        x: center.x + (col - perRow / 2) * 120,
        y: 40 + (k % 2) * 24,
        z: center.z + row * 120
      })
    })
    clusters.push({ id: '__noidc', name: '未指定机房', center, radius: 400, count: ids.length })
  }

  // 人工拖动过的坐标优先（布局算法不跟用户抢位置）
  if (override) {
    for (const [id, p] of Object.entries(override)) {
      const old = positions.get(id)
      if (!old) continue
      positions.set(id, { x: p.x, y: p.y, z: p.z })
    }
  }

  return { positions, clusters, freeCenter }
}
