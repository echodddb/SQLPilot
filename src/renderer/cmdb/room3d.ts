/**
 * 机房 3D 场景（three.js）
 * ────────────────────────
 * 为什么换掉原来的 Canvas 2D 画家算法：
 * 平面着色永远"像积木"——没有真实光照、没有高光、没有阴影落地，烤不出金属和玻璃。
 * 参考了 GitHub 上几个同类项目（3d-datacenter / thingraph-server-room / Rackula）的做法，
 * 它们的观感来自四件事，这里逐条对齐：
 *   1. **PBR 材质**：金属机柜（metalness/roughness）、玻璃门（physical + 透明）、哑光设备；
 *   2. **环境光 + 方向光阴影**：RoomEnvironment 生成环境贴图（不用外部 HDR 资源），
 *      方向光打 PCFSoft 阴影，物体才"踩"在地上；
 *   3. **设备前面板用贴图**：按 portsOf()/portSlots() 的归一化坐标在 canvas 上画真实面板
 *      （盘位、电口、光口、电源、通风孔、品牌条、状态灯），1024px 宽，
 *      拉多近都清晰——这比用代码画小方块强一个量级；
 *   4. **ACES 色调映射 + sRGB 输出**：暗部不死黑、亮部不过曝。
 *
 * 相机仍用项目自己的 yaw/pitch/dist + 目标点（`cmdb/camera.ts`），
 * 只是把算出来的 eye 塞给 three 的 PerspectiveCamera —— 这样视图态持久化格式不用改，
 * 轨道/缩放的手感也和在拓扑视图里一致。
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RACK_BASE_CM, U_CM, portSlots, type RoomDevice, type RoomModel, type RoomPlacement } from '../../main/cmdb-room'
import { archOf, specOf } from '../../main/cmdb-model'
import type { Camera } from './camera'

export interface StageState {
  dark: boolean
  selected: string
  hover: string
  related: Set<string>
  relatedRacks: Set<string>
  hiddenNets: string[]
  used: Map<string, string>
  drop: { rackId?: string; u?: number; ok: boolean; col?: number; row?: number; label: string } | null
}

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
  depth: number
}

export interface StageLabel {
  id: string
  text: string
  x: number
  y: number
  strong: boolean
  kind: 'rack' | 'device'
}

const FOV = (50 * Math.PI) / 180

// ---------------------------------------------------------------- 调色板

interface Pal {
  bg: number
  tileA: number
  tileB: number
  grout: number
  slab: number
  rackFrame: number
  rackPanel: number
  rackInner: number
  device: number
  glass: number
  accent: number
  hemiSky: number
  hemiGround: number
  hemiInt: number
  dirInt: number
  envInt: number
}

function palette(dark: boolean): Pal {
  return dark
    ? {
        bg: 0x080b12, tileA: 0x181e29, tileB: 0x1c2330, grout: 0x0a0e15, slab: 0x111620,
        rackFrame: 0x39434f, rackPanel: 0x232a35, rackInner: 0x0d1119, device: 0x353d49,
        glass: 0x9dc0ea, accent: 0x38bdf8,
        hemiSky: 0xb9d4ff, hemiGround: 0x0a0d13, hemiInt: 0.85, dirInt: 1.7, envInt: 0.4
      }
    : {
        bg: 0xe9edf4, tileA: 0xd3d9e2, tileB: 0xdbe0e8, grout: 0xb4bdc9, slab: 0xc4cbd6,
        rackFrame: 0x77808f, rackPanel: 0x99a3b2, rackInner: 0x4a525e, device: 0x8892a1,
        glass: 0x9fc0e8, accent: 0x0284c7,
        hemiSky: 0xffffff, hemiGround: 0xa8b2c0, hemiInt: 0.7, dirInt: 1.25, envInt: 0.5
      }
}

// ---------------------------------------------------------------- 前面板贴图

const frontCache = new Map<string, THREE.Texture>()

/** 把一台设备的前面板画成贴图：盘位在左、网口/光口/管理口右侧分带、电源贴右缘，
 *  坐标直接用 cmdb-room 的 portSlots()，所以贴图和"端口锚点"永远对得上。 */
function frontTexture(specId: string, role: string, status: string, dark: boolean): THREE.Texture {
  const key = `${specId}|${role}|${status}|${dark ? 'd' : 'l'}`
  const hit = frontCache.get(key)
  if (hit) return hit

  const spec = specOf(specId)
  const uH = Math.max(1, spec?.u || 1)
  const W = 1024
  const H = Math.max(96, uH * 112)
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!

  const bezel = dark ? '#414b59' : '#a3adbb'
  const bezelLo = dark ? '#303845' : '#8b95a4'
  const hole = dark ? '#04060a' : '#2a323d'
  const holeEdge = dark ? '#5c6a7d' : '#6d7787'
  const silk = dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.85)'

  // 面板底：上亮下暗的竖向渐变 + 细噪点，模拟拉丝金属
  const grd = g.createLinearGradient(0, 0, 0, H)
  grd.addColorStop(0, bezel)
  grd.addColorStop(0.55, bezelLo)
  grd.addColorStop(1, bezel)
  g.fillStyle = grd
  g.fillRect(0, 0, W, H)

  // 顶部/底部的高光与阴影线
  g.fillStyle = dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)'
  g.fillRect(0, 1, W, 2)
  g.fillStyle = dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.18)'
  g.fillRect(0, H - 3, W, 3)

  // 通风孔：右侧一片小圆点阵（真机上就是这种网孔）
  g.fillStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(60,70,85,0.28)'
  const dotR = Math.max(1.2, H * 0.012)
  for (let x = W * 0.05; x < W * 0.95; x += dotR * 4.2) {
    for (let y = H * 0.72; y < H * 0.94; y += dotR * 4.2) {
      g.beginPath()
      g.arc(x, y, dotR, 0, Math.PI * 2)
      g.fill()
    }
  }

  // 用途色条：左侧竖条 + 顶部细线（远处也能分辨数据库/应用/网络）
  const roleColor = roleFill(role, dark)
  g.fillStyle = roleColor
  g.fillRect(0, 0, Math.max(4, W * 0.006), H)
  g.fillRect(0, 0, W, Math.max(2, H * 0.02))

  // 挂耳（左右两侧的安装耳，带螺丝）
  g.fillStyle = dark ? '#4c586a' : '#aab3c0'
  g.fillRect(0, H * 0.12, W * 0.035, H * 0.76)
  g.fillRect(W * 0.965, H * 0.12, W * 0.035, H * 0.76)
  for (const ex of [W * 0.012, W * 0.982]) {
    for (const ey of [H * 0.22, H * 0.78]) {
      g.beginPath()
      g.arc(ex, ey, Math.max(1.6, H * 0.03), 0, Math.PI * 2)
      g.fillStyle = dark ? '#0d1117' : '#6d7787'
      g.fill()
    }
  }

  const slots = portSlots({ spec: specId })
  for (const s of slots) {
    const x = s.u * W
    const y = s.v * H
    const w = Math.max(2.5, s.w * W)
    const h = Math.max(2.5, s.h * H)
    if (s.group === 'disk') {
      // 盘位：托架 + 把手 + 指示灯
      g.fillStyle = dark ? '#3d4653' : '#c3cad6'
      g.fillRect(x, y, w, h)
      g.strokeStyle = dark ? 'rgba(0,0,0,0.6)' : 'rgba(70,80,95,0.45)'
      g.lineWidth = 1
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      g.fillStyle = dark ? '#2a313c' : '#aeb6c3'
      g.fillRect(x + w * 0.06, y + h * 0.36, w * 0.88, h * 0.26)
      g.fillStyle = dark ? '#22c55e' : '#16a34a'
      g.fillRect(x + w * 0.78, y + h * 0.12, Math.max(1.6, w * 0.08), Math.max(1.6, h * 0.1))
      continue
    }
    // 网口/光口/管理口/Console：凹槽 + 口子
    g.fillStyle = holeEdge
    g.fillRect(x, y, w, h)
    g.fillStyle = hole
    g.fillRect(x + 0.8, y + 0.8, Math.max(1, w - 1.6), Math.max(1, h - 1.6))
    if (s.group === 'sfp') {
      // 光口笼子：里面有金属弹片
      g.fillStyle = dark ? 'rgba(200,215,235,0.35)' : 'rgba(90,100,115,0.5)'
      g.fillRect(x + w * 0.2, y + h * 0.42, w * 0.6, Math.max(1, h * 0.16))
    } else if (s.group === 'nic') {
      // RJ45：上沿卡扣
      g.fillStyle = dark ? 'rgba(180,200,225,0.28)' : 'rgba(80,90,105,0.45)'
      g.fillRect(x + w * 0.18, y + h * 0.1, w * 0.64, Math.max(1, h * 0.14))
    }
    if (s.group === 'power') {
      // 电源插座：三个孔
      g.fillStyle = dark ? '#5a5040' : '#7a705c'
      g.fillRect(x + w * 0.15, y + h * 0.2, w * 0.7, h * 0.6)
      g.fillStyle = '#0b0f16'
      for (const dx of [0.3, 0.5, 0.7]) g.fillRect(x + w * dx - 1, y + h * 0.42, 2, Math.max(2, h * 0.2))
    }
  }

  // 状态灯（右上角）+ 电源灯（左下）
  const ledColor = statusFill(status)
  const ledR = Math.max(3, H * 0.05)
  g.beginPath()
  g.arc(W * 0.955 - ledR, H * 0.13, ledR, 0, Math.PI * 2)
  g.fillStyle = ledColor
  g.shadowColor = ledColor
  g.shadowBlur = ledR * 2
  g.fill()
  g.shadowBlur = 0
  g.beginPath()
  g.arc(W * 0.055, H * 0.86, ledR * 0.7, 0, Math.PI * 2)
  g.fillStyle = dark ? '#22c55e' : '#16a34a'
  g.fill()

  // 品牌条 / 型号丝印
  g.fillStyle = silk
  g.font = `500 ${Math.max(9, H * 0.1)}px system-ui, "Microsoft YaHei", sans-serif`
  g.textBaseline = 'middle'
  const label = (spec?.name || '').replace(/（.*?）/g, '').slice(0, 18)
  if (label) g.fillText(label, W * 0.06, H * 0.28)

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  if (frontCache.size > 80) frontCache.clear()
  frontCache.set(key, tex)
  return tex
}


function roleFill(role: string, dark: boolean): string {
  const map: Record<string, [string, string]> = {
    db: ['#dc2626', '#f87171'],
    app: ['#2563eb', '#60a5fa'],
    web: ['#0891b2', '#22d3ee'],
    storage: ['#059669', '#34d399'],
    backup: ['#7c3aed', '#a78bfa'],
    network: ['#ea580c', '#fb923c'],
    virt: ['#c026d3', '#e879f9'],
    other: ['#64748b', '#94a3b8']
  }
  const hit = map[role || 'other'] || map.other
  return dark ? hit[1] : hit[0]
}

function statusFill(status: string): string {
  if (status === 'running') return '#22c55e'
  if (status === 'maintenance') return '#f59e0b'
  if (status === 'planned') return '#38bdf8'
  if (status === 'stopped') return '#94a3b8'
  return '#475569'
}

// ---------------------------------------------------------------- 地板 / 标尺贴图

let contactTexCache: THREE.Texture | null = null

/** 接触阴影贴片：一张径向渐变，铺在机柜/落地设备脚下。
 *  真阴影靠方向光（已经有了），但这层贴片能让物体在暗部也"贴住"地面。 */
function contactShadowTexture(): THREE.Texture {
  if (contactTexCache) return contactTexCache
  const S = 128
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')!
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.06, S / 2, S / 2, S * 0.5)
  grd.addColorStop(0, 'rgba(0,0,0,0.72)')
  grd.addColorStop(0.55, 'rgba(0,0,0,0.34)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, S, S)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  contactTexCache = tex
  return tex
}

let floorTexCache = new Map<string, THREE.Texture>()

function floorTexture(dark: boolean): THREE.Texture {
  const key = dark ? 'd' : 'l'
  const hit = floorTexCache.get(key)
  if (hit) return hit
  const pal = palette(dark)
  const S = 512 // 2×2 块地板
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')!
  const half = S / 2
  for (let r = 0; r < 2; r++) {
    for (let q = 0; q < 2; q++) {
      g.fillStyle = `#${((r + q) % 2 === 0 ? pal.tileA : pal.tileB).toString(16).padStart(6, '0')}`
      g.fillRect(q * half, r * half, half, half)
    }
  }
  // 缝（架空地板的分缝）+ 一点方向性反光
  g.fillStyle = `#${pal.grout.toString(16).padStart(6, '0')}`
  g.fillRect(0, 0, S, 3)
  g.fillRect(0, half - 1, S, 3)
  g.fillRect(0, 0, 3, S)
  g.fillRect(half - 1, 0, 3, S)
  const sh = g.createLinearGradient(0, 0, S, S)
  sh.addColorStop(0, dark ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.5)')
  sh.addColorStop(0.5, 'rgba(255,255,255,0)')
  sh.addColorStop(1, dark ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.06)')
  g.fillStyle = sh
  g.fillRect(0, 0, S, S)
  // 细微颗粒，避免大色块
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = dark ? `rgba(255,255,255,${Math.random() * 0.03})` : `rgba(0,0,0,${Math.random() * 0.035})`
    g.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  floorTexCache.set(key, tex)
  return tex
}

/** 机柜内的 U 位标尺：每 5U 一个数字，贴在左右立柱内侧 */
function uRulerTexture(uTotal: number, dark: boolean): THREE.Texture {
  const key = `u${uTotal}|${dark ? 'd' : 'l'}`
  const hit = floorTexCache.get(key)
  if (hit) return hit
  const H = 2048
  const W = 128
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = dark ? '#1a2029' : '#b9c2cf'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = dark ? 'rgba(190,215,245,0.55)' : 'rgba(40,55,75,0.55)'
  g.fillStyle = dark ? 'rgba(205,225,250,0.8)' : 'rgba(25,40,60,0.8)'
  g.font = '500 26px system-ui, sans-serif'
  g.textAlign = 'right'
  g.textBaseline = 'middle'
  for (let u = 1; u <= uTotal; u++) {
    const y = H - (u / uTotal) * H
    const major = u % 5 === 0
    g.lineWidth = major ? 3 : 1.4
    g.beginPath()
    g.moveTo(W, y)
    g.lineTo(W - (major ? 56 : 28), y)
    g.stroke()
    if (major) g.fillText(String(u), W - 62, y)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  floorTexCache.set(key, tex)
  return tex
}

// ---------------------------------------------------------------- 场景

export class RoomStage {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private pmrem: THREE.PMREMGenerator | null = null
  private envRT: THREE.WebGLRenderTarget | null = null
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()

  /** 场景根节点：模型重建时整棵换掉 */
  private root: THREE.Group | null = null
  private model: RoomModel | null = null
  private state: StageState = {
    dark: true, selected: '', hover: '', related: new Set(), relatedRacks: new Set(),
    hiddenNets: [], used: new Map(), drop: null
  }

  private devMesh = new Map<string, THREE.Mesh>()
  private devEdges = new Map<string, THREE.LineSegments>()
  private rackGroup = new Map<string, THREE.Group>()
  private rackGlass = new Map<string, THREE.Mesh>()
  private rackPlacement = new Map<string, RoomPlacement>()
  private hintBox: THREE.Mesh | null = null
  private cableGroup: THREE.Group | null = null

  private w = 800
  private h = 600
  private cam: Camera = { yaw: 0.62, pitch: 0.5, dist: 800, tx: 0, ty: 90, tz: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(1)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera((FOV * 180) / Math.PI, 4 / 3, 1, 40000)
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    this.pmrem.compileEquirectangularShader()
  }

  /** 环境贴图（RoomEnvironment 是程序化的，不需要外部 HDR 文件） */
  private applyEnvironment(dark: boolean): void {
    if (!this.pmrem) return
    if (this.envRT) this.envRT.dispose()
    const env = new RoomEnvironment()
    this.envRT = this.pmrem.fromScene(env, 0.04)
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = palette(dark).envInt
    env.dispose?.()
  }

  private clearRoot(): void {
    if (!this.root) return
    this.scene.remove(this.root)
    this.root.traverse((o: any) => {
      if (o.geometry && !o.userData.shared) o.geometry.dispose?.()
      if (o.material && !o.userData.sharedMat) {
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) m.dispose?.()
      }
    })
    this.root = null
  }

  setModel(model: RoomModel, state: Partial<StageState>): void {
    this.state = { ...this.state, ...state }
    const themeChanged = this.state.dark !== (this.lastDark ?? !this.state.dark)
    this.model = model
    this.clearRoot()
    this.devMesh.clear()
    this.devEdges.clear()
    this.rackGroup.clear()
    this.rackGlass.clear()
    this.rackPlacement.clear()
    // 贴图缓存按 spec/主题做键，平时别清（清了旧纹理不释放会漏显存）；
    // 切主题时贴图里的配色已经过期，必须连同纹理一起释放再重建
    if (themeChanged) {
      for (const t of frontCache.values()) t.dispose()
      frontCache.clear()
      for (const t of floorTexCache.values()) t.dispose()
      floorTexCache.clear()
    }
    if (themeChanged || !this.scene.environment) this.applyEnvironment(this.state.dark)

    const pal = palette(this.state.dark)
    this.scene.background = new THREE.Color(pal.bg)
    this.renderer.toneMappingExposure = this.state.dark ? 1.02 : 1.0

    const root = new THREE.Group()
    this.root = root
    this.scene.add(root)

    this.buildLights(pal, model)
    this.buildFloor(pal, model)
    for (const rack of model.racks) this.buildRack(pal, rack)
    for (const dev of model.devices) this.buildDevice(pal, dev)
    this.buildCables(model)
    this.buildHintBox()
    this.applyHighlight()
    this.lastDark = this.state.dark
  }

  private lastDark: boolean | null = null

  // ---------------- 灯光 ----------------

  private lightGroup: THREE.Group | null = null

  private buildLights(pal: Pal, model: RoomModel): void {
    if (this.lightGroup) {
      this.scene.remove(this.lightGroup)
      this.lightGroup.traverse((o: any) => o.geometry?.dispose?.())
      this.lightGroup = null
    }
    const grp = new THREE.Group()
    this.lightGroup = grp
    this.scene.add(grp)

    const hemi = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiInt)
    grp.add(hemi)

    const dir = new THREE.DirectionalLight(0xffffff, pal.dirInt)
    dir.position.set(model.widthCm * 0.35, 520, model.depthCm * 0.55)
    dir.target.position.set(0, 0, 0)
    dir.castShadow = true
    dir.shadow.mapSize.set(2048, 2048)
    dir.shadow.camera.near = 80
    dir.shadow.camera.far = 2200
    const half = Math.max(model.widthCm, model.depthCm) * 0.75
    dir.shadow.camera.left = -half
    dir.shadow.camera.right = half
    dir.shadow.camera.top = half
    dir.shadow.camera.bottom = -half
    dir.shadow.bias = -0.0007
    dir.shadow.normalBias = 0.6
    dir.shadow.radius = 2.5
    grp.add(dir)
    grp.add(dir.target)

    // 反向补光：机柜背面不至于死黑（不投影，省一半开销）
    const fill = new THREE.DirectionalLight(this.state.dark ? 0x8fb6ff : 0xffffff, this.state.dark ? 0.45 : 0.5)
    fill.position.set(-model.widthCm * 0.5, 300, -model.depthCm * 0.6)
    grp.add(fill)

    // 正面低位补光：机柜门里的设备面板需要一点正面光才看得出端口
    const front = new THREE.DirectionalLight(this.state.dark ? 0xcfe2ff : 0xffffff, this.state.dark ? 0.75 : 0.6)
    front.position.set(model.widthCm * 0.2, 90, model.depthCm * 1.1)
    grp.add(front)
  }

  // ---------------- 地板 ----------------

  private buildFloor(pal: Pal, model: RoomModel): void {
    const root = this.root!
    const tex = floorTexture(this.state.dark)
    tex.repeat.set(model.cols / 2, model.rows / 2)
    tex.needsUpdate = true

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(model.widthCm, model.depthCm),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.05 })
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = 0.05
    floor.receiveShadow = true
    floor.userData.kind = 'floor'
    root.add(floor)

    // 地板厚度（架空地板板体）
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(model.widthCm + 8, 14, model.depthCm + 8),
      new THREE.MeshStandardMaterial({ color: pal.slab, roughness: 0.9, metalness: 0.02 })
    )
    slab.position.y = -7
    slab.receiveShadow = true
    root.add(slab)

    // 四周的踢脚线，让"房间"有边界
    const curbMat = new THREE.MeshStandardMaterial({ color: pal.rackFrame, roughness: 0.7, metalness: 0.2 })
    const curbH = 3
    const mkCurb = (w: number, d: number, x: number, z: number): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, curbH, d), curbMat)
      m.position.set(x, curbH / 2, z)
      m.castShadow = false
      m.receiveShadow = true
      root.add(m)
    }
    mkCurb(model.widthCm + 8, 3, 0, -model.depthCm / 2 - 2.5)
    mkCurb(model.widthCm + 8, 3, 0, model.depthCm / 2 + 2.5)
    mkCurb(3, model.depthCm + 8, -model.widthCm / 2 - 2.5, 0)
    mkCurb(3, model.depthCm + 8, model.widthCm / 2 + 2.5, 0)
  }

  // ---------------- 机柜 ----------------

  private buildRack(pal: Pal, rack: RoomPlacement): void {
    const root = this.root!
    const g = new THREE.Group()
    g.position.set(rack.x, 0, rack.z)
    this.rackGroup.set(rack.id, g)
    this.rackPlacement.set(rack.id, rack)
    root.add(g)

    const frameMat = new THREE.MeshStandardMaterial({ color: pal.rackFrame, metalness: 0.72, roughness: 0.34 })
    const panelMat = new THREE.MeshStandardMaterial({ color: pal.rackPanel, metalness: 0.35, roughness: 0.72 })
    const innerMat = new THREE.MeshStandardMaterial({ color: pal.rackInner, metalness: 0.2, roughness: 0.92 })

    const W = rack.w
    const D = rack.d
    const H = rack.h
    const base = RACK_BASE_CM
    const postW = 3.2

    // 立柱
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(postW, H, postW), frameMat)
        post.position.set(sx * (W / 2 - postW / 2), H / 2, sz * (D / 2 - postW / 2))
        post.castShadow = true
        post.receiveShadow = true
        post.userData = { kind: 'rack', id: rack.id }
        g.add(post)
      }
    }

    // 侧板（薄板，稍内缩）
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(1.6, H - base - 6, D - postW * 2 - 1), panelMat)
      side.position.set(sx * (W / 2 - 0.8), base + (H - base - 6) / 2, 0)
      side.castShadow = true
      side.receiveShadow = true
      side.userData = { kind: 'rack', id: rack.id }
      g.add(side)
    }

    // 背板 + 内壁（深色，设备才"站"得出来）
    const back = new THREE.Mesh(new THREE.BoxGeometry(W - postW * 2, H - base - 6, 1.6), innerMat)
    back.position.set(0, base + (H - base - 6) / 2, -D / 2 + postW + 0.8)
    back.receiveShadow = true
    back.userData = { kind: 'rack', id: rack.id }
    g.add(back)

    // 顶盖（带一点厚度，前面略出檐）
    const top = new THREE.Mesh(new THREE.BoxGeometry(W + 1.5, 4, D + 1.5), frameMat)
    top.position.set(0, H - 2, 0)
    top.castShadow = true
    top.receiveShadow = true
    top.userData = { kind: 'rack', id: rack.id }
    g.add(top)

    // 底座
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W, base, D), new THREE.MeshStandardMaterial({ color: pal.rackInner, metalness: 0.3, roughness: 0.9 }))
    plinth.position.set(0, base / 2, 0)
    plinth.castShadow = true
    plinth.receiveShadow = true
    plinth.userData = { kind: 'rack', id: rack.id }
    g.add(plinth)

    // 接地阴影（贴在地板上）
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 1.9, D * 1.5),
      new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, opacity: this.state.dark ? 0.85 : 0.42, depthWrite: false })
    )
    shadow.rotation.x = -Math.PI / 2
    shadow.position.set(0, 0.12, 0)
    shadow.renderOrder = 1
    g.add(shadow)

    // 柜内顶部灯带：真机柜开门后能看到顶灯，这条冷光让柜内不至于死黑
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(W - postW * 2 - 4, 0.8, 3),
      new THREE.MeshStandardMaterial({ color: 0xdbe8ff, emissive: 0x9fc4ff, emissiveIntensity: this.state.dark ? 0.75 : 0.3, roughness: 0.4 })
    )
    lamp.position.set(0, H - 7, D / 2 - 10)
    g.add(lamp)

    // 19" 安装立柱（左右两根带 U 位标尺的立条）
    const uH = rack.uTotal * U_CM
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.PlaneGeometry(6, uH),
        new THREE.MeshStandardMaterial({
          map: uRulerTexture(rack.uTotal, this.state.dark),
          roughness: 0.8,
          metalness: 0.1,
          side: THREE.DoubleSide
        })
      )
      rail.rotation.y = sx > 0 ? Math.PI : 0
      rail.position.set(sx * (W / 2 - 4.6), base + uH / 2, D / 2 - 4)
      g.add(rail)
    }

    // 玻璃前门（透明 + 反光，depthWrite=false 免得挡住柜内设备）
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(W - 4, H - base - 8),
      new THREE.MeshPhysicalMaterial({
        color: 0x243444,
        metalness: 0,
        roughness: 0.42,
        transparent: true,
        opacity: this.state.dark ? 0.03 : 0.09,
        envMapIntensity: 0.25,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    )
    glass.position.set(0, base + (H - base - 8) / 2, D / 2 - 0.6)
    glass.renderOrder = 20
    glass.userData = { kind: 'rack', id: rack.id, isGlass: true }
    g.add(glass)
    this.rackGlass.set(rack.id, glass)

    // 门框
    const doorFrameMat = new THREE.MeshStandardMaterial({ color: pal.rackFrame, metalness: 0.6, roughness: 0.4 })
    for (const [w2, h2, x2, y2] of [
      [W - 4, 1.6, 0, base + 0.8],
      [W - 4, 1.6, 0, H - 6],
      [1.6, H - base - 8, -(W - 4) / 2 + 0.8, base + (H - base - 8) / 2],
      [1.6, H - base - 8, (W - 4) / 2 - 0.8, base + (H - base - 8) / 2]
    ] as [number, number, number, number][]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, 1.2), doorFrameMat)
      bar.position.set(x2, y2, D / 2 - 0.6)
      g.add(bar)
    }
  }

  // ---------------- 设备 ----------------

  private buildDevice(pal: Pal, dev: RoomDevice): void {
    const root = this.root!
    const a = dev.asset
    const specId = a.spec || ''
    const tex = frontTexture(specId, a.role || 'other', a.status, this.state.dark)
    const bodyColor = new THREE.Color(pal.device)
    if (a.type === 'ups' || a.type === 'pdu') bodyColor.offsetHSL(0.06, 0.05, 0.02)

    const sideMat = new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.28, roughness: 0.8, envMapIntensity: 0.28 })
    const frontMat = new THREE.MeshStandardMaterial({
      map: tex,
      metalness: 0.16,
      roughness: 0.62,
      envMapIntensity: 0.3,
      // 不要把整张面板贴图当自发光：那样会被"洗白"，端口细节全糊
      emissive: new THREE.Color(0xffffff),
      emissiveMap: tex,
      emissiveIntensity: 0.03
    })
    const geo = new THREE.BoxGeometry(dev.w, dev.h, dev.d)
    // three 的面顺序：+X, -X, +Y, -Y, +Z, -Z
    const mats = [sideMat, sideMat, sideMat, sideMat, frontMat, sideMat]
    const mesh = new THREE.Mesh(geo, mats)
    mesh.position.set(dev.x, dev.y, dev.z)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData = { kind: 'device', id: dev.id }
    root.add(mesh)
    this.devMesh.set(dev.id, mesh)

    // 选中/关联描边（默认隐藏）
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.95, depthTest: false })
    )
    edges.position.copy(mesh.position)
    edges.visible = false
    edges.renderOrder = 30
    root.add(edges)
    this.devEdges.set(dev.id, edges)
  }

  // ---------------- 网线 ----------------

  private buildCables(model: RoomModel): void {
    const grp = new THREE.Group()
    this.cableGroup = grp
    this.root!.add(grp)
    for (const c of model.cables) {
      if (this.state.hiddenNets.includes(c.net)) continue
      const color = new THREE.Color(netHex(c.net, this.state.dark))
      // 走线：从端口出来先向机柜前方探出，再垂一点到对端（真机房里的线就是这样垂的）
      const mid = new THREE.Vector3((c.a.x + c.b.x) / 2, (c.a.y + c.b.y) / 2, (c.a.z + c.b.z) / 2)
      const span = Math.hypot(c.a.x - c.b.x, c.a.z - c.b.z) + Math.abs(c.a.y - c.b.y) * 0.4
      const sag = Math.min(70, 10 + span * 0.16)
      mid.y -= sag
      mid.z += Math.min(18, 6 + span * 0.05)
      const p0 = new THREE.Vector3(c.a.x, c.a.y, c.a.z)
      const p3 = new THREE.Vector3(c.b.x, c.b.y, c.b.z)
      const p1 = new THREE.Vector3(c.a.x, c.a.y - 2, c.a.z + 5)
      const p2 = new THREE.Vector3(c.b.x, c.b.y - 2, c.b.z + 5)
      const curve = new THREE.CatmullRomCurve3([p0, p1, mid, p2, p3], false, 'catmullrom', 0.35)
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 32, 0.2, 6, false),
        new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05, emissive: color, emissiveIntensity: 0.1 })
      )
      tube.castShadow = true
      tube.userData = { kind: 'cable', id: c.id }
      grp.add(tube)

      // 两端插头：一个 1cm 的小方块，颜色同线（近看就是"插上去的"）
      for (const p of [p0, p3]) {
        const plug = new THREE.Mesh(
          new THREE.BoxGeometry(0.9, 0.8, 1.8),
          new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3, emissive: color, emissiveIntensity: 0.35 })
        )
        plug.position.set(p.x, p.y, p.z - 1.4)
        plug.userData = { kind: 'cable', id: c.id }
        grp.add(plug)
      }
    }
  }

  // ---------------- 落位提示 ----------------

  private buildHintBox(): void {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.28, depthWrite: false })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.visible = false
    mesh.renderOrder = 25
    this.root!.add(mesh)
    this.hintBox = mesh
  }

  // ---------------- 状态 ----------------

  setState(patch: Partial<StageState>): void {
    const prevDark = this.state.dark
    this.state = { ...this.state, ...patch }
    if (patch.dark !== undefined && patch.dark !== prevDark && this.model) {
      // 主题变了：整场重建（贴图里烘焙了配色）
      this.setModel(this.model, this.state)
      return
    }
    if (patch.drop !== undefined) this.updateHint()
    if (patch.selected !== undefined || patch.hover !== undefined || patch.related !== undefined || patch.relatedRacks !== undefined) {
      this.applyHighlight()
    }
    if (patch.hiddenNets !== undefined && this.model) {
      // 只重建线缆，别整场重建
      if (this.cableGroup) {
        this.root!.remove(this.cableGroup)
        this.cableGroup.traverse((o: any) => {
          o.geometry?.dispose?.()
          o.material?.dispose?.()
        })
      }
      this.buildCables(this.model)
    }
  }

  private applyHighlight(): void {
    const { selected, hover, related, relatedRacks } = this.state
    const focus = !!selected || !!hover
    for (const [id, mesh] of this.devMesh) {
      const isSel = id === selected
      const isHover = id === hover
      const isRel = related.has(id)
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial
        const dim = focus && !isSel && !isHover && !isRel
        mat.transparent = dim
        mat.opacity = dim ? 0.28 : 1
        mat.depthWrite = !dim
        mat.emissiveIntensity = isSel || isHover ? 0.22 : isRel ? 0.12 : 0.06
      }
      const edge = this.devEdges.get(id)
      if (edge) {
        const show = isSel || isHover || isRel
        edge.visible = show
        const mat = edge.material as THREE.LineBasicMaterial
        const a = this.model?.devices.find((d) => d.id === id)?.asset
        const arch = a?.arch ? archOf(a.arch) : null
        const col = isSel ? palette(this.state.dark).accent : isRel && arch ? (this.state.dark ? arch.colorDark : arch.color) : palette(this.state.dark).accent
        mat.color = new THREE.Color(col)
        mat.opacity = isSel ? 1 : isRel ? 0.85 : 0.7
      }
    }
    // 柜门：选中关联机柜时门亮一点（像"打开看过"）
    for (const [id, glass] of this.rackGlass) {
      const mat = glass.material as THREE.MeshPhysicalMaterial
      const hot = relatedRacks.has(id)
      mat.opacity = hot ? (this.state.dark ? 0.2 : 0.26) : this.state.dark ? 0.13 : 0.18
      mat.color = new THREE.Color(hot ? palette(this.state.dark).accent : palette(this.state.dark).glass)
    }
  }

  private updateHint(): void {
    const hint = this.state.drop
    if (!this.hintBox) return
    if (!hint) {
      this.hintBox.visible = false
      return
    }
    const mat = this.hintBox.material as THREE.MeshBasicMaterial
    mat.color = new THREE.Color(hint.rackId ? (hint.ok ? 0x22c55e : 0xef4444) : hint.ok ? 0x38bdf8 : 0xef4444)
    if (hint.rackId && hint.u) {
      const rack = this.rackPlacement.get(hint.rackId)
      const dev = this.model?.devices.find((d) => d.id === this.dragging) || null
      if (!rack) return
      const h = Math.max(1, dev?.uHeight || 1) * U_CM
      this.hintBox.scale.set(rack.w - 6, h, 2)
      this.hintBox.position.set(rack.x, RACK_BASE_CM + (hint.u - 1) * U_CM + h / 2, rack.z + rack.d / 2 + 1)
    } else if (hint.col !== undefined && hint.row !== undefined && this.model) {
      const m = this.model
      const x = -m.widthCm / 2 + (hint.col + 0.5) * m.tile
      const z = -m.depthCm / 2 + (hint.row + 0.5) * m.tile
      this.hintBox.scale.set(m.tile - 6, 1, m.tile - 6)
      this.hintBox.position.set(x, 0.6, z)
    }
    this.hintBox.visible = true
  }

  /** 拖拽时设一下正在拖的设备 id，落位提示框才能拿到高度 */
  dragging = ''

  // ---------------- 相机 / 渲染 ----------------

  setCamera(cam: Camera): void {
    this.cam = cam
    const cp = Math.cos(cam.pitch)
    const eye = new THREE.Vector3(
      cam.tx + cam.dist * cp * Math.sin(cam.yaw),
      cam.ty + cam.dist * Math.sin(cam.pitch),
      cam.tz + cam.dist * cp * Math.cos(cam.yaw)
    )
    this.camera.position.copy(eye)
    this.camera.lookAt(cam.tx, cam.ty, cam.tz)
    this.camera.updateMatrixWorld()
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(1, w)
    this.h = Math.max(1, h)
    this.renderer.setPixelRatio(Math.min(2, dpr))
    this.renderer.setSize(this.w, this.h, false)
    this.camera.aspect = this.w / this.h
    this.camera.updateProjectionMatrix()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  // ---------------- 交互辅助 ----------------

  pick(px: number, py: number): { kind: 'device' | 'rack'; id: string } | null {
    this.pointer.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const targets: THREE.Object3D[] = []
    for (const m of this.devMesh.values()) targets.push(m)
    for (const g of this.rackGroup.values()) targets.push(...g.children)
    const hits = this.raycaster.intersectObjects(targets, false)
    for (const h of hits) {
      const d = h.object.userData as { kind?: string; id?: string; isGlass?: boolean }
      if (d?.kind === 'device' && d.id) return { kind: 'device', id: d.id }
      if (d?.kind === 'rack' && d.id && !d.isGlass) return { kind: 'rack', id: d.id }
    }
    const glassHit = hits.find((h) => (h.object.userData as any)?.isGlass)
    if (glassHit) return { kind: 'rack', id: (glassHit.object.userData as any).id }
    return null
  }

  /** 屏幕点 → 地板平面（y=0）世界坐标 */
  floorPoint(px: number, py: number): { x: number; z: number } | null {
    this.pointer.set((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const out = new THREE.Vector3()
    const hit = this.raycaster.ray.intersectPlane(plane, out)
    return hit ? { x: out.x, z: out.z } : null
  }

  /** 机柜前面板在屏幕上的矩形（拖拽算 U 位、拖放判定都用它） */
  rackFace(rackId: string): ScreenRect | null {
    const rack = this.rackPlacement.get(rackId)
    if (!rack) return null
    const z = rack.z + rack.d / 2
    const pts = [
      new THREE.Vector3(rack.x - rack.w / 2, RACK_BASE_CM, z),
      new THREE.Vector3(rack.x + rack.w / 2, RACK_BASE_CM, z),
      new THREE.Vector3(rack.x + rack.w / 2, rack.h, z),
      new THREE.Vector3(rack.x - rack.w / 2, rack.h, z)
    ]
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let depth = 0
    for (const p of pts) {
      const v = p.clone().project(this.camera)
      const sx = ((v.x + 1) / 2) * this.w
      const sy = ((1 - v.y) / 2) * this.h
      x0 = Math.min(x0, sx)
      x1 = Math.max(x1, sx)
      y0 = Math.min(y0, sy)
      y1 = Math.max(y1, sy)
      depth += v.z
    }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), depth: depth / 4 }
  }

  /** 设备前面板矩形（点选测试/自检脚本用） */
  deviceFace(id: string): ScreenRect | null {
    const dev = this.model?.devices.find((d) => d.id === id)
    if (!dev) return null
    const z = dev.z + dev.d / 2
    const pts = [
      new THREE.Vector3(dev.x - dev.w / 2, dev.y - dev.h / 2, z),
      new THREE.Vector3(dev.x + dev.w / 2, dev.y - dev.h / 2, z),
      new THREE.Vector3(dev.x + dev.w / 2, dev.y + dev.h / 2, z),
      new THREE.Vector3(dev.x - dev.w / 2, dev.y + dev.h / 2, z)
    ]
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let depth = 0
    for (const p of pts) {
      const v = p.clone().project(this.camera)
      x0 = Math.min(x0, ((v.x + 1) / 2) * this.w)
      x1 = Math.max(x1, ((v.x + 1) / 2) * this.w)
      y0 = Math.min(y0, ((1 - v.y) / 2) * this.h)
      y1 = Math.max(y1, ((1 - v.y) / 2) * this.h)
      depth += v.z
    }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), depth: depth / 4 }
  }

  /** 拖拽预览：把机柜整体挪到某格（不落盘，松手才提交） */
  moveRack(id: string, col: number, row: number): void {
    const g = this.rackGroup.get(id)
    const rack = this.rackPlacement.get(id)
    const m = this.model
    if (!g || !rack || !m) return
    rack.col = col
    rack.row = row
    rack.x = -m.widthCm / 2 + (col + rack.cols / 2) * m.tile
    rack.z = -m.depthCm / 2 + (row + rack.rows / 2) * m.tile
    g.position.set(rack.x, 0, rack.z)
  }

  /** 拖拽预览：把设备挪到某柜某 U（柜内设备与柜一起跟着动） */
  moveDevice(id: string, rackId: string, u: number): void {
    const mesh = this.devMesh.get(id)
    const edge = this.devEdges.get(id)
    const dev = this.model?.devices.find((d) => d.id === id)
    const rack = this.rackPlacement.get(rackId)
    if (!mesh || !dev || !rack) return
    dev.rackId = rackId
    dev.u = u
    dev.x = rack.x
    dev.z = rack.z
    dev.y = RACK_BASE_CM + (u - 1) * U_CM + dev.h / 2
    mesh.position.set(dev.x, dev.y, dev.z)
    if (edge) edge.position.copy(mesh.position)
  }

  /** 拖拽预览：落地设备（塔式 UPS）贴着地面挪 */
  moveLoose(id: string, x: number, z: number): void {
    const mesh = this.devMesh.get(id)
    const edge = this.devEdges.get(id)
    const dev = this.model?.devices.find((d) => d.id === id)
    if (!mesh || !dev) return
    dev.x = x
    dev.z = z
    dev.y = dev.h / 2
    mesh.position.set(dev.x, dev.y, dev.z)
    if (edge) edge.position.copy(mesh.position)
  }

  /** 标签：机柜编号永远显示，设备名只给选中/悬停（几百台机器全标名字没法看） */
  labels(): StageLabel[] {
    const out: StageLabel[] = []
    if (!this.model) return out
    for (const rack of this.model.racks) {
      const p = new THREE.Vector3(rack.x, 1, rack.z + rack.d / 2 + 8).project(this.camera)
      if (p.z > 1) continue
      out.push({
        id: rack.id,
        text: rack.code,
        x: ((p.x + 1) / 2) * this.w,
        y: ((1 - p.y) / 2) * this.h,
        strong: this.state.relatedRacks.has(rack.id),
        kind: 'rack'
      })
    }
    const hot = [this.state.selected, this.state.hover].filter((x): x is string => !!x)
    for (const id of hot) {
      const dev = this.model.devices.find((d) => d.id === id)
      const rect = this.deviceFace(id)
      if (!dev || !rect) continue
      out.push({
        id,
        text: dev.asset.name,
        x: rect.x + rect.w / 2,
        y: rect.y - 6,
        strong: true,
        kind: 'device'
      })
    }
    return out
  }

  dispose(): void {
    this.clearRoot()
    if (this.lightGroup) this.scene.remove(this.lightGroup)
    this.envRT?.dispose()
    this.pmrem?.dispose()
    this.renderer.dispose()
  }
}

function netHex(net: string, dark: boolean): string {
  const map: Record<string, [string, string]> = {
    biz: ['#0284c7', '#38bdf8'],
    backup: ['#7c3aed', '#a78bfa'],
    storage: ['#059669', '#34d399'],
    mgmt: ['#d97706', '#fbbf24'],
    private: ['#db2777', '#f472b6'],
    heartbeat: ['#dc2626', '#f87171'],
    other: ['#64748b', '#94a3b8']
  }
  const hit = map[net] || map.other
  return dark ? hit[1] : hit[0]
}
