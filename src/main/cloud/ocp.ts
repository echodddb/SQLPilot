/**
 * OceanBase 云平台（OCP）客户端与数据聚合。
 *
 * 逆向来源：OCP 4.4.1 前端 bundle（umi SPA）中的请求封装——
 *   1) GET  /api/v2/sensitiveDataKey  → data.publicKey（裸 base64 DER，SPKI）
 *   2) POST /api/v2/iam/login         → form-urlencoded { username, password }
 *      其中 password = RSA/PKCS#1 v1.5 加密后的 base64（前端用 JSEncrypt，Node 侧等价实现）
 *   3) 登录成功后服务端下发 SESSION Cookie，后续请求靠 Cookie 鉴权；
 *      写操作需要把 XSRF-TOKEN Cookie 原样放进 X-XSRF-TOKEN 头。
 *   4) 统一响应包 { successful, status, data, error:{message} }，401 视为会话失效。
 *
 * 本文件刻意不依赖 electron：平台配置与密码由 ipc 层传入，方便脱离应用单独编译联调。
 */

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'

// ---------------------------------------------------------------- 类型

export interface OcpPlatform {
  id: string
  name: string
  type: 'ocp'
  baseUrl: string
  username: string
  /** 自签证书（内网 https）时跳过证书校验 */
  insecure?: boolean
}

export interface OcpInfo {
  version: string
  edition: string
  buildTime: string
}

export interface CapacityStat {
  used: number
  total: number
  pct: number
}

export interface AlarmLevelCount {
  level: number
  count: number
}

export interface CloudCluster {
  id: number
  name: string
  status: string
  type: string
  obClusterId: number
  version: string
  clusterMode: string
  origin: string
  createTime: string
  creator: string
  regionCount: number
  serverCount: number
  tenantCount: number
  rootServer: string
  cpu: CapacityStat
  memory: CapacityStat
  disk: CapacityStat
  alarms: { total: number; levels: AlarmLevelCount[] }
}

export interface CloudHostService {
  name: string
  type: string
  version: string
}

export interface CloudHost {
  id: number
  ip: string
  alias: string
  name: string
  status: string
  agentStatus: string
  agentVersion: string
  typeName: string
  kind: string
  region: string
  idc: string
  os: string
  sshPort: number
  createTime: string
  services: CloudHostService[]
  clusters: string[]
  obproxies: string[]
}

export interface CloudTenant {
  id: number
  name: string
  clusterId: number
  clusterName: string
  clusterStatus: string
  mode: string
  status: string
  obTenantId: number
  locality: string
  primaryZone: string
  zoneList: string
  version: string
  createTime: string
  loadType?: string
  role?: string
  /** 备租户同步状态（PRIMARY 租户为空） */
  syncStatus?: string
  /** 所属集群类型：PRIMARY / STANDBY */
  clusterType?: string
  locked?: boolean
  readonly?: boolean
  description?: string
}

/** 告警推送状态（OCP 列表页「消息推送」列的原始数据） */
export interface AlarmPushState {
  configured: boolean
  successCount: number
  noSuccessCount: number
}

/** 告警对象：从 alarmTarget.includeTargets 解析出的可读对象 */
export interface AlarmTargetInfo {
  scope: string
  /** 对象名（主机 IP / 租户名 / 集群名 / 应用标识），已去重 */
  names: string[]
  clusterName: string
  obClusterId: number | null
  tenantName: string
}

export interface CloudAlarm {
  id: number
  level: number
  name: string
  description: string
  status: string
  appType: string
  /** 告警对象类型：Host / Cluster / Tenant / Service / OCP … */
  scope: string
  target: string
  /** 告警规则标识（如 ob_host_load1_per_cpu_over_threshold），可用来归类 */
  alarmType: string
  /** 一句话摘要（OCP 详情页首行） */
  summary: string
  /** 指标标签（键值，含阈值与实测值；含 zh_tw / en_us 重复项，展示层要过滤） */
  labels: Record<string, string>
  groups: string[]
  /** 是否由 OCP 自动恢复 */
  autoResolved: boolean
  activeAt: string
  /** 恢复时间（历史告警才有意义） */
  updatedAt: string
  /** 规则模板 ID（0 表示内置在代码里的规则） */
  templateId: number
  push: AlarmPushState
  /** 恢复时间（仅历史告警返回） */
  resolvedAt: string
  targetInfo: AlarmTargetInfo
  /** 以下字段只有单条告警详情接口才返回 */
  metricGroup: AlarmMetricGroup | null
  /** 告警关联的业务集群名（OCP 详情页顶部「集群」） */
  obCluster: string
  /** 详情页推荐展示的标签（键值，比 labels 少很多） */
  targetLabels: Record<string, string>
}

/** 告警关联的指标分组（详情接口 metricGroup） */
export interface AlarmMetricGroup {
  key: string
  name: string
  description: string
  metrics: { key: string; name: string; unit: string; description: string; groupBy: string; labels: string }[]
}

export interface CloudSubtask {
  id: number
  name: string
  description: string
  status: string
  operation: string
  nodeType: string
  executor: string
  createTime: string
  startTime: string
  finishTime: string
  /** 执行耗时（秒） */
  runTime: number
  /** 超时（秒） */
  timeout: number
  parallelIdx: number
  upstreams: number[]
  downstreams: number[]
}

export interface CloudTask {
  id: number
  name: string
  status: string
  operation: string
  creator: string
  clusterId: number | null
  clusterName: string
  /** OB 集群 ID（OCP 任务页「操作对象」显示成 集群:obClusterId / 租户） */
  clusterObId: number | null
  /** 操作对象里的租户名 */
  tenant: string
  /** 操作对象类型：OB_TENANT / OB_CLUSTER / HOST / OB_SERVER …（来自 tags[0].objectType） */
  objType: string
  /** 操作对象名（租户名 / 集群名 / 主机 IP） */
  objName: string
  /** 任务触发方式（MANUAL / AUTO），不是对象类型 */
  type: string
  startTime: string
  finishTime: string
  subtasks: { id: number; name: string; status: string; operation: string; finishTime: string }[]
}

/** 任务详情：OCP /tasks/instances/{id} 比列表多出执行器、依赖、每步耗时 */
export interface CloudTaskDetail extends CloudTask {
  createTime: string
  executor: string
  remote: boolean
  prohibitRollback: boolean
  prohibitSkip: boolean
  taskDefinitionId: number
  /** 详情里的子任务带时间与依赖，替换列表里的精简版 */
  subtasks: CloudSubtask[]
  /** 进度汇总（按子任务状态计数） */
  progress: { done: number; failed: number; running: number; pending: number; total: number; pct: number }
  /** 总耗时（毫秒，未结束则到当前时刻） */
  durationMs: number
}

export interface CloudOverview {
  info: OcpInfo
  kpis: { clusters: number; clustersRunning: number; hosts: number; hostsOnline: number; tenants: number; alarms: number; alarmsCritical: number; cpuUsed: number; cpuTotal: number }
  hosts: { total: number; online: number; offline: number; agentAbnormal: number }
  clusters: CloudCluster[]
  alarms: CloudAlarm[]
  tasks: CloudTask[]
  warnings: string[]
}

export interface CloudClusterDetail {
  cluster: CloudCluster
  attributes: { key: string; label: string }[]
  zones: { name: string; idc: string; region: string; status: string; serverCount: number; rootServer: string }[]
  servers: { id: number; ip: string; zone: string; status: string; hostStatus: string; withRootserver: boolean; version: string; startTime: string }[]
  tenants: CloudTenant[]
  startupParameters: { key: string; value: string }[]
  /** Unit 规格（创建租户时选） */
  unitSpecs: { name: string; cpu: number; memory: number; type: string }[]
}

export interface CloudTenantDetail {
  tenant: CloudTenant
  charset: string
  collation: string
  whitelist: string
  /** 租户描述（OCP 详情页可编辑） */
  description: string
  /** 是否开启死锁检测 */
  deadLockDetection: boolean
  /** ZONE 列表（OCP 详情页顶部摘要用） */
  zoneList: string[]
  /** 日志备份是否在跑（概要信息） */
  logBackupRunning: boolean
  /** 备租户简要信息（主租户才有） */
  standbyTenants: { id: number; name: string; clusterName: string; syncStatus: string }[]
  zones: {
    name: string
    replicaType: string
    poolName: string
    unitCount: number
    unitCpu: number
    unitMemory: number
    units: { id: number; ip: string; port: number; status: string }[]
  }[]
}

// ---------------------------------------------------------------- HTTP 基础

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
}

function joinUrl(base: string, p: string): string {
  const b = String(base || '').trim().replace(/\/+$/, '')
  return b + (p.startsWith('/') ? p : '/' + p)
}

/** OCP 前端的 SPA 路由（用户常把浏览器地址栏整条粘过来，如 .../login） */
const SPA_ROUTES = new Set([
  'login', 'pre_login_loading', 'overview', 'cluster', 'tenant', 'host', 'hosts',
  'alarm', 'task', 'backup', 'monitor', 'diagnosis', 'auth', 'system', 'verify', 'error', 'dashboard'
])

/**
 * 归一化 OCP 地址：补协议、去掉尾斜杠 / 查询串 / 前端路由，只保留 origin + context path。
 * 例：http://h:8080/login → http://h:8080；h:8080/#/overview → http://h:8080；
 *     http://h:8080/ocp/login → http://h:8080/ocp
 */
/** 零宽 / 方向控制 / BOM：从聊天窗口或文档复制链接时经常带进来，肉眼看不见但会把主机名弄坏 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g
/** 常见包裹符号（中英文引号、书名号、尖括号）：粘贴 <http://…> 或 “http://…” 时去掉 */
const WRAP = /^[「『“”"'《〈<]+|[」』“”"'》〉>]+$/g

export function normalizeBase(raw: string): string {
  // NFKC：把全角冒号/斜杠/点/数字（中文输入法常见）归一成 ASCII，再清掉零宽字符与夹杂空白
  let b = String(raw || '').normalize('NFKC').replace(INVISIBLE, '').trim()
  b = b.replace(WRAP, '').replace(WRAP, '').replace(/\s+/g, '')
  if (!b) throw new Error('OCP 地址为空')
  if (!/^https?:\/\//i.test(b)) b = 'http://' + b
  let u: URL
  try { u = new URL(b) } catch { throw new Error(`OCP 地址格式不正确：${raw}（示例 http://192.168.1.130:8080）`) }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error(`OCP 地址缺少主机名：${raw}（示例 http://192.168.1.130:8080）`)
  // 主机名合法性：非法字符（引号/零宽/中文）会让 DNS 直接查不到，不如在这里说清楚
  const isV6 = host.includes(':')
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').every((n) => Number(n) <= 255)
  const isName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(host)
  if (!isV6 && !isName) {
    throw new Error(`OCP 地址不合法：主机名「${host}」含非法字符（粘贴时带入的引号或零宽字符很常见），请重新输入，例如 http://192.168.1.130:8080`)
  }
  if (!isV6 && !isV4 && /^[\d.]+$/.test(host)) {
    throw new Error(`OCP 地址不合法：${host} 不是有效 IP，请检查点号与端口，例如 http://192.168.1.130:8080`)
  }
  const segs = u.pathname.split('/').filter(Boolean)
  while (segs.length && SPA_ROUTES.has(segs[segs.length - 1].toLowerCase())) segs.pop()
  const path = segs.length ? '/' + segs.join('/') : ''
  return `${u.protocol}//${u.host}${path}`
}

function requestRaw(
  baseUrl: string,
  p: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; insecure?: boolean; timeoutMs?: number } = {}
): Promise<RawResponse> {
  const url = new URL(joinUrl(baseUrl, p))
  const isHttps = url.protocol === 'https:'
  const mod = isHttps ? https : http
  const body = opts.body
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method || 'GET',
        headers: {
          // 不声明 Accept-Encoding：服务端返回明文 JSON，省掉解压依赖
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'SQLPilot-CloudConsole/0.1',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(opts.headers || {})
        },
        rejectUnauthorized: opts.insecure ? false : true
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.setTimeout(opts.timeoutMs ?? 20000, () => req.destroy(new Error(`连接 ${url.host} 超时（20s）：检查网络、VPN 或端口`)))
    req.on('error', (e: any) => {
      const host = url.host
      const msg = e?.code === 'ECONNREFUSED' ? `无法连接 ${host}：端口被拒绝（OCP 服务未启动或端口不对）`
        : e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN' ? `无法解析主机名「${url.hostname}」：本机 DNS 查不到它。内网请直接填 IP（如 http://192.168.1.130:8080），或确认该主机名在 hosts/DNS 中`
          : e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH' ? `无法路由到 ${host}：检查网段 / VPN`
            : e?.code === 'ETIMEDOUT' ? `连接 ${host} 超时：检查防火墙与端口`
              : e?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || /self signed|certificate/i.test(String(e?.message)) ? 'OCP 证书校验失败：可在平台配置中勾选「跳过证书校验」'
                : e?.message || String(e)
      reject(new Error(msg))
    })
    if (body) req.write(body)
    req.end()
  })
}

/** 极简 Cookie 容器：OCP 只用到 SESSION + XSRF-TOKEN 两个键 */
class CookieJar {
  private m = new Map<string, string>()
  absorb(res: RawResponse): void {
    const raw = res.headers['set-cookie']
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const line of list) {
      const head = String(line).split(';')[0]
      const i = head.indexOf('=')
      if (i <= 0) continue
      this.m.set(head.slice(0, i).trim(), head.slice(i + 1).trim())
    }
  }
  get(k: string): string { return this.m.get(k) || '' }
  header(): string { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
}

function wrapPem(raw: string): string {
  if (!raw) throw new Error('OCP 未返回公钥（sensitiveDataKey 为空）')
  if (raw.includes('BEGIN')) return raw
  return `-----BEGIN PUBLIC KEY-----\n${raw.replace(/(.{64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----`
}

export class OcpError extends Error {}

// ---------------------------------------------------------------- 客户端

export class OcpClient {
  readonly platform: OcpPlatform
  private password: string
  private jar = new CookieJar()
  private info: OcpInfo | null = null
  /**
   * 登录去重：首屏（尤其租户抽屉的 13 个面板）会并发拉多个接口，
   * 若各请求各自触发登录、又各自清共享 Cookie，会把别人刚建立的会话打断。
   * 这里保证：① 同一时刻只有一次登录在飞；② 登录在私有 jar 上完成，成功后原子替换。
   */
  private loginPromise: Promise<OcpInfo> | null = null

  constructor(platform: OcpPlatform, password: string) {
    this.platform = { ...platform, baseUrl: normalizeBase(platform.baseUrl) }
    this.password = password
  }

  get baseUrl(): string { return this.platform.baseUrl }

  /**
   * 发原始请求。jar 可显式传入：登录流程在私有 jar 上跑，结束前不影响共享 jar。
   */
  private async raw(p: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}, jar: CookieJar = this.jar): Promise<RawResponse> {
    const headers: Record<string, string> = { ...(opts.headers || {}), Cookie: jar.header() }
    const xsrf = jar.get('XSRF-TOKEN')
    if (xsrf && (opts.method || 'GET') !== 'GET') headers['X-XSRF-TOKEN'] = xsrf
    const res = await requestRaw(this.baseUrl, p, { ...opts, headers, insecure: this.platform.insecure })
    jar.absorb(res)
    return res
  }

  private parse(res: RawResponse): any {
    const text = (res.text || '').trim()
    if (!text) return null
    if (text.startsWith('<')) return null // 被重定向到登录页/SPA 首页
    try { return JSON.parse(text) } catch { return null }
  }

  /** RSA/PKCS#1 v1.5 加密登录密码（等价前端 JSEncrypt.encrypt） */
  private encryptPassword(publicKey: string, plain: string): string {
    return crypto.publicEncrypt(
      { key: wrapPem(publicKey), padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(plain, 'utf8')
    ).toString('base64')
  }

  /** 在指定 jar 上完成登录握手（不触碰共享 jar，失败也不会污染现有会话） */
  private async loginInto(jar: CookieJar): Promise<OcpInfo> {
    const keyRes = await this.raw('/api/v2/sensitiveDataKey', {}, jar)
    const keyJson = this.parse(keyRes)
    if (keyRes.status !== 200) {
      // 302/404 + HTML 基本都是地址填成了网页路由（用户常粘浏览器地址栏的 /login）
      if ([301, 302, 303, 307, 308, 404].includes(keyRes.status)) {
        throw new OcpError(`访问 OCP 接口失败（HTTP ${keyRes.status}）：当前地址 ${this.baseUrl} 可能带了网页路径或不是 OCP 服务，请只填到端口，例如 http://192.168.1.130:8080`)
      }
      throw new OcpError(`获取 OCP 公钥失败（HTTP ${keyRes.status}）`)
    }
    const publicKey = keyJson?.data?.publicKey
    if (!publicKey) throw new OcpError(`获取 OCP 公钥失败：响应缺少 publicKey（请确认 ${this.baseUrl} 是 OCP 服务且版本 ≥ 4.0）`)

    const body = new URLSearchParams({
      username: this.platform.username,
      password: this.encryptPassword(publicKey, this.password)
    }).toString()
    const res = await this.raw('/api/v2/iam/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }, jar)
    const json = this.parse(res)
    if (!json?.successful) {
      const msg = json?.error?.message || `登录 OCP 失败（HTTP ${res.status}）`
      throw new OcpError(/Incorrect username or password/i.test(msg) ? 'OCP 用户名或密码不正确' : msg)
    }
    if (!jar.get('SESSION')) throw new OcpError('OCP 登录未返回会话 Cookie，请确认账号可用')

    const infoRes = await this.raw('/api/v2/info', {}, jar)
    const infoJson = this.parse(infoRes)
    return {
      version: String(infoJson?.buildVersion || '').replace(/-\d{14}$/, ''),
      edition: String(infoJson?.edition || ''),
      buildTime: String(infoJson?.buildTime || '')
    }
  }

  /** 强制重新登录：成功后原子替换共享 jar 与信息 */
  async login(): Promise<OcpInfo> {
    const jar = new CookieJar()
    const info = await this.loginInto(jar)
    this.jar = jar
    this.info = info
    return info
  }

  /**
   * 取一个新会话。stale 是调用方发请求时用的会话标识：
   * 若共享 jar 里的会话已经变了（别的并发请求刚重登成功），直接复用，不再重复登录。
   */
  private session(stale = ''): Promise<OcpInfo> {
    const cur = this.jar.get('SESSION')
    if (this.info && cur && cur !== stale) return Promise.resolve(this.info)
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => { this.loginPromise = null })
    }
    return this.loginPromise
  }

  /** 建立会话（并发调用共享同一次登录） */
  async ensureLogin(): Promise<OcpInfo> {
    if (this.jar.get('SESSION') && this.info) return this.info
    return this.session()
  }

  /** 统一调用：会话失效（401 / 拿到 HTML）时自动重登一次 */
  async call<T = any>(p: string, opts: { method?: string; query?: Record<string, any>; body?: any } = {}, retried = false): Promise<T> {
    await this.ensureLogin()
    // 记下本次请求用的会话；重登时用它判断"别人是否已经换过新会话"
    const stale = this.jar.get('SESSION')
    const url = buildQuery(p, opts.query)
    const body = opts.body === undefined ? undefined
      : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const res = await this.raw(url, {
      method: opts.method || 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body
    })
    const json = this.parse(res)
    if (res.status === 401 || (!json && !retried)) {
      if (retried) throw new OcpError(res.status === 401 ? 'OCP 会话已失效，且重新登录失败' : 'OCP 返回了非 JSON 响应（可能被重定向到登录页）')
      // 注意：这里不清共享 jar。清掉会把并发请求刚建立的会话一起作废，
      // 由 session(stale) 统一决定"复用已有新会话"还是"发起一次重登"。
      await this.session(stale)
      return this.call<T>(p, opts, true)
    }
    if (!json) throw new OcpError(`OCP 响应无法解析（HTTP ${res.status}）`)
    if (json.successful === false) throw new OcpError(json?.error?.message || `OCP 请求失败（HTTP ${res.status}）`)
    return json.data as T
  }

  /** RSA 加密敏感字段（密码类）：OCP 前端对所有密码输入框都先 RSA 加密再提交（与登录同款公钥） */
  async encryptSensitive(plain: string): Promise<string> {
    const keyRes = await this.call<any>('/api/v2/sensitiveDataKey')
    const publicKey = keyRes?.publicKey
    if (!publicKey) throw new OcpError('获取 OCP 公钥失败，无法加密密码')
    return this.encryptPassword(publicKey, plain)
  }

  get infoCache(): OcpInfo | null { return this.info }
}

function buildQuery(p: string, query?: Record<string, any>): string {
  if (!query) return p
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    usp.append(k, String(v))
  }
  const qs = usp.toString()
  if (!qs) return p
  return p + (p.includes('?') ? '&' : '?') + qs
}

// ---------------------------------------------------------------- 归一化

/** OCP 列表接口统一返回 { contents: [...], page: {...} }，少数直接返回数组 */
function contentsOf(data: any): any[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.contents)) return data.contents
  return []
}

const num = (v: any): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const pct = (used: number, total: number): number => (total > 0 ? Math.min(100, Math.round((used / total) * 1000) / 10) : 0)
const str = (v: any): string => (v === undefined || v === null ? '' : String(v))

function toCluster(raw: any, alarms: Map<number, AlarmLevelCount[]>): CloudCluster {
  const rs = raw.resourceStats || {}
  const cpuTotal = num(rs.cpuTotal)
  const cpuUsed = num(rs.cpuAssigned)
  const memTotal = num(rs.memoryTotalByte)
  const memUsed = num(rs.memoryAssignedByte)
  const diskTotal = num(rs.dataDiskTotalByte)
  const diskUsed = num(rs.dataDiskUsedByte)
  const levels = alarms.get(num(raw.id)) || []
  return {
    id: num(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    type: str(raw.type),
    obClusterId: num(raw.obClusterId),
    version: str(raw.obVersion),
    clusterMode: str(raw.clusterMode),
    origin: str(raw.origin),
    createTime: str(raw.createTime),
    creator: str(raw.creator),
    regionCount: num(raw.regionCount),
    serverCount: num(raw.serverCount),
    tenantCount: num(raw.tenantCount),
    rootServer: str(raw.rootServers?.[0]?.address),
    cpu: { used: cpuUsed, total: cpuTotal, pct: pct(cpuUsed, cpuTotal) },
    memory: { used: memUsed, total: memTotal, pct: pct(memUsed, memTotal) },
    disk: { used: diskUsed, total: diskTotal, pct: pct(diskUsed, diskTotal) },
    alarms: { total: levels.reduce((s, x) => s + x.count, 0), levels }
  }
}

function toTenant(raw: any): CloudTenant {
  return {
    id: num(raw.id),
    name: str(raw.name),
    clusterId: num(raw.clusterId),
    clusterName: str(raw.clusterName),
    clusterStatus: str(raw.clusterStatus),
    mode: str(raw.mode),
    status: str(raw.status),
    obTenantId: num(raw.obTenantId),
    locality: str(raw.locality),
    primaryZone: str(raw.primaryZone),
    zoneList: str(raw.zoneList),
    version: str(raw.obVersion),
    createTime: str(raw.createTime),
    loadType: str(raw.loadType) || undefined,
    role: str(raw.role) || undefined,
    syncStatus: str(raw.syncStatus) || undefined,
    clusterType: str(raw.clusterType) || undefined,
    locked: !!raw.locked,
    readonly: !!raw.readonly,
    description: str(raw.description)
  }
}

function toHost(raw: any): CloudHost {
  const services: CloudHostService[] = Array.isArray(raw.services)
    ? raw.services.map((s: any) => ({ name: str(s.name), type: str(s.type), version: str(s.version) }))
    : []
  const clusters = new Set<string>()
  const obproxies = new Set<string>()
  for (const t of Array.isArray(raw.hostTags) ? raw.hostTags : []) {
    if (t?.type === 'OB_CLUSTER' && t.clusterName) clusters.add(str(t.clusterName))
    if (t?.type === 'OB_PROXY' && t.obproxyClusterName) obproxies.add(str(t.obproxyClusterName))
  }
  for (const s of services) {
    if (s.type === 'OB_CLUSTER' && s.name) clusters.add(s.name.split(':')[0])
    if (s.type === 'OB_PROXY' && s.name) obproxies.add(s.name)
  }
  return {
    id: num(raw.id),
    ip: str(raw.innerIpAddress),
    alias: str(raw.alias),
    name: str(raw.name),
    status: str(raw.status),
    agentStatus: str(raw.hostAgentStatus),
    agentVersion: str(raw.hostAgentVersion),
    typeName: str(raw.typeName),
    kind: str(raw.kind),
    region: str(raw.regionName),
    idc: str(raw.idcName),
    os: str(raw.operatingSystem) || str(raw.operatingSystemVersion),
    sshPort: num(raw.sshPort),
    createTime: str(raw.createTime),
    services,
    clusters: [...clusters],
    obproxies: [...obproxies]
  }
}

/** alarmTarget.includeTargets 里混着 hosts / tenants / cluster 几种形态，这里统一摊平成可读对象名 */
function toAlarmTargetInfo(raw: any, scope: string): AlarmTargetInfo {
  const inc = Array.isArray(raw?.alarmTarget?.includeTargets) ? raw.alarmTarget.includeTargets : []
  const names = new Set<string>()
  let clusterName = ''
  let obClusterId: number | null = null
  let tenantName = ''
  for (const item of inc) {
    if (!item || typeof item !== 'object') continue
    for (const h of Array.isArray(item.hosts) ? item.hosts : []) {
      const n = str(h?.hostIp) || str(h?.name)
      if (n) names.add(n)
    }
    for (const c of Array.isArray(item.clusters) ? item.clusters : []) {
      const n = str(c?.name)
      if (n) names.add(n)
    }
    if (item.cluster && typeof item.cluster === 'object') {
      if (!clusterName) clusterName = str(item.cluster.name)
      if (obClusterId === null && item.cluster.obClusterId) obClusterId = num(item.cluster.obClusterId)
    }
    for (const t of Array.isArray(item.tenants) ? item.tenants : []) {
      const n = str(t?.name)
      if (n) { names.add(n); if (!tenantName) tenantName = n }
    }
  }
  // 兜底：includeTargets 为空时（如 OCP 自身告警）从 target 串尾取对象
  if (!names.size) {
    const tail = str(raw?.target).split(':').pop() || ''
    const eq = tail.indexOf('=')
    const v = (eq >= 0 ? tail.slice(eq + 1) : tail).trim()
    if (v) names.add(v)
  }
  return { scope, names: [...names], clusterName, obClusterId, tenantName }
}

function toAlarm(raw: any): CloudAlarm {
  const labels: Record<string, string> = {}
  if (raw?.labels && typeof raw.labels === 'object') {
    for (const [k, v] of Object.entries(raw.labels)) labels[k] = str(v)
  }
  const scope = str(raw.scope)
  const push = raw?.messagePush && typeof raw.messagePush === 'object' ? raw.messagePush : {}
  return {
    id: num(raw.id),
    level: num(raw.level),
    name: str(raw.name) || str(raw.labels?.alarm_name_zh_cn),
    description: str(raw.description),
    status: str(raw.status),
    appType: str(raw.appType),
    scope,
    target: str(raw.target),
    alarmType: str(raw.alarmType),
    summary: str(raw.summary),
    labels,
    groups: Array.isArray(raw.alarmGroups) ? raw.alarmGroups.map(str) : [],
    autoResolved: !!raw.autoResolved,
    activeAt: str(raw.activeAt) || str(raw.gmtCreate),
    updatedAt: str(raw.statusUpdatedAt) || str(raw.gmtModified),
    templateId: num(raw.alarmTemplateId),
    push: {
      configured: !!push.configured,
      successCount: num(push.successCount),
      noSuccessCount: num(push.noSuccessCount)
    },
    resolvedAt: str(raw.resolvedAt),
    targetInfo: toAlarmTargetInfo(raw, scope),
    metricGroup: toAlarmMetricGroup(raw?.metricGroup),
    obCluster: toAlarmClusterName(raw?.obCluster),
    targetLabels: toFlatLabels(raw?.targetLabels)
  }
}

function toAlarmMetricGroup(raw: any): AlarmMetricGroup | null {
  if (!raw || typeof raw !== 'object') return null
  const metrics = (Array.isArray(raw.metrics) ? raw.metrics : []).map((m: any) => ({
    key: str(m.key) || str(m.name),
    name: str(m.name),
    unit: str(m.unit),
    description: str(m.description),
    groupBy: str(m.groupBy),
    labels: str(m.labels)
  }))
  return {
    key: str(raw.key) || str(raw.name),
    name: str(raw.name) || str(raw.key),
    description: str(raw.description),
    metrics
  }
}

/** obCluster 是 {includeTargets:[{cluster:{name}}]} 结构，只取集群名 */
function toAlarmClusterName(raw: any): string {
  const inc = Array.isArray(raw?.includeTargets) ? raw.includeTargets : []
  for (const item of inc) {
    const n = str(item?.cluster?.name)
    if (n) return n
  }
  return ''
}

function toFlatLabels(raw: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) out[k] = str(v)
  }
  return out
}

function toSubtask(raw: any): CloudSubtask {
  return {
    id: num(raw?.id),
    name: str(raw?.name),
    description: str(raw?.description),
    status: str(raw?.status),
    operation: str(raw?.operation),
    nodeType: str(raw?.nodeType),
    executor: str(raw?.executor),
    createTime: str(raw?.createTime),
    startTime: str(raw?.startTime),
    finishTime: str(raw?.finishTime),
    runTime: num(raw?.runTime),
    timeout: num(raw?.timeout),
    parallelIdx: num(raw?.parallelIdx),
    upstreams: (Array.isArray(raw?.upstreams) ? raw.upstreams : []).map(num),
    downstreams: (Array.isArray(raw?.downstreams) ? raw.downstreams : []).map(num)
  }
}

function toTask(raw: any): CloudTask {
  // OCP 把操作对象放在 tags[0] 里：{objectType, objectName, obClusterId, clusterName, tenantName, svrIp}
  const tag = Array.isArray(raw?.tags) && raw.tags.length ? raw.tags[0] : null
  return {
    id: num(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    operation: str(raw.operation),
    creator: str(raw.creator?.name),
    clusterId: raw.cluster?.id ? num(raw.cluster.id) : (tag?.clusterId ? num(tag.clusterId) : null),
    clusterName: str(raw.cluster?.name) || str(tag?.clusterName),
    clusterObId: raw.cluster?.obClusterId ? num(raw.cluster.obClusterId) : (tag?.obClusterId ? num(tag.obClusterId) : null),
    tenant: str(raw.tenant?.name ?? raw.tenant) || str(tag?.tenantName),
    objType: str(tag?.objectType),
    objName: str(tag?.objectName) || str(tag?.svrIp),
    type: str(raw.type),
    startTime: str(raw.startTime),
    finishTime: str(raw.finishTime),
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks.map((s: any) => ({
        id: num(s.id),
        name: str(s.name),
        status: str(s.status),
        operation: str(s.operation),
        finishTime: str(s.finishTime)
      }))
      : []
  }
}

function toTaskDetail(raw: any): CloudTaskDetail {
  const base = toTask(raw)
  const subtasks = (Array.isArray(raw?.subtasks) ? raw.subtasks : []).map(toSubtask)
  const count = (st: string) => subtasks.filter((s: CloudSubtask) => s.status === st).length
  const done = count('SUCCESSFUL')
  const failed = count('FAILED')
  const running = count('RUNNING')
  const pending = subtasks.length - done - failed - running
  const startMs = base.startTime ? new Date(base.startTime).getTime() : 0
  const endMs = base.finishTime ? new Date(base.finishTime).getTime() : Date.now()
  return {
    ...base,
    subtasks,
    createTime: str(raw?.createTime),
    executor: str(raw?.executor),
    remote: !!raw?.isRemote,
    prohibitRollback: !!raw?.prohibitRollback,
    prohibitSkip: !!raw?.prohibitSkip,
    taskDefinitionId: num(raw?.taskDefinitionId),
    progress: {
      done,
      failed,
      running,
      pending: Math.max(0, pending),
      total: subtasks.length,
      pct: subtasks.length ? Math.round((done / subtasks.length) * 100) : 0
    },
    durationMs: startMs ? Math.max(0, endMs - startMs) : 0
  }
}

// ---------------------------------------------------------------- 聚合接口

export async function ocpTest(platform: OcpPlatform, password: string): Promise<{ ok: boolean; info?: OcpInfo; error?: string }> {
  try {
    const c = new OcpClient(platform, password)
    const info = await c.login()
    return { ok: true, info }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export async function ocpOverview(client: OcpClient): Promise<CloudOverview> {
  const warnings: string[] = []
  const settle = async <T>(p: Promise<T>, label: string, fallback: T): Promise<T> => {
    try { return await p } catch (e: any) { warnings.push(`${label}：${e?.message || e}`); return fallback }
  }

  // 先建立会话再并发取数：首屏 7 个请求共享同一次登录
  const info = await client.ensureLogin()

  const [clustersRaw, alarmSumsRaw, hostsRaw, activeRaw, alarmsRaw, tasksRaw] = await Promise.all([
    settle(client.call<any>('/api/v2/ob/clustersView'), '集群列表', { contents: [] }),
    settle(client.call<any>('/api/v2/ob/clusters/alarmSummaries'), '集群告警统计', { contents: [] }),
    settle(client.call<any>('/api/v2/compute/hosts'), '主机列表', { contents: [] }),
    settle(client.call<any>('/api/v2/alarm/overview/active'), '告警概况', { contents: [] }),
    settle(client.call<any>('/api/v2/alarm/alarms/actived', { query: { page: 1, size: 6 } }), '活跃告警', { contents: [] }),
    settle(client.call<any>('/api/v2/tasks/instances', { query: { page: 1, size: 6 } }), '最近任务', { contents: [] })
  ])

  const alarmMap = new Map<number, AlarmLevelCount[]>()
  for (const a of contentsOf(alarmSumsRaw)) {
    alarmMap.set(num(a.id), (a.alarmSummaries || []).map((x: any) => ({ level: num(x.level), count: num(x.count) })))
  }
  const clusters = contentsOf(clustersRaw).map((c) => toCluster(c, alarmMap))
  const hosts = contentsOf(hostsRaw).map(toHost)
  const alarms = contentsOf(alarmsRaw).map(toAlarm)
  const tasks = contentsOf(tasksRaw).map(toTask)

  const levelTotals = contentsOf(activeRaw)
  const tenants = clusters.reduce((s, c) => s + c.tenantCount, 0)
  const cpuUsed = clusters.reduce((s, c) => s + c.cpu.used, 0)
  const cpuTotal = clusters.reduce((s, c) => s + c.cpu.total, 0)

  return {
    info: { version: info.version, edition: info.edition, buildTime: info.buildTime },
    kpis: {
      clusters: clusters.length,
      clustersRunning: clusters.filter((c) => c.status === 'RUNNING').length,
      hosts: hosts.length,
      hostsOnline: hosts.filter((h) => h.status === 'ONLINE').length,
      tenants,
      alarms: levelTotals.reduce((s: number, x: any) => s + num(x.count), 0),
      alarmsCritical: num(levelTotals.find((x: any) => num(x.level) === 1)?.count),
      cpuUsed,
      cpuTotal
    },
    hosts: {
      total: hosts.length,
      online: hosts.filter((h) => h.status === 'ONLINE').length,
      offline: hosts.filter((h) => h.status !== 'ONLINE').length,
      agentAbnormal: hosts.filter((h) => h.agentStatus && h.agentStatus !== 'AVAILABLE').length
    },
    clusters,
    alarms,
    tasks,
    warnings
  }
}

export async function ocpClusters(client: OcpClient): Promise<CloudCluster[]> {
  const [clustersRaw, alarmSumsRaw] = await Promise.all([
    client.call<any>('/api/v2/ob/clustersView'),
    client.call<any>('/api/v2/ob/clusters/alarmSummaries').catch(() => ({ contents: [] }))
  ])
  const alarmMap = new Map<number, AlarmLevelCount[]>()
  for (const a of contentsOf(alarmSumsRaw)) {
    alarmMap.set(num(a.id), (a.alarmSummaries || []).map((x: any) => ({ level: num(x.level), count: num(x.count) })))
  }
  return contentsOf(clustersRaw).map((c) => toCluster(c, alarmMap))
}

export async function ocpClusterDetail(client: OcpClient, clusterId: number): Promise<CloudClusterDetail> {
  const [detail, zonesRaw, serversRaw, tenantsRaw, alarmSumsRaw, stats, unitSpecsRaw] = await Promise.all([
    client.call<any>(`/api/v2/ob/clusters/${clusterId}`),
    client.call<any>(`/api/v2/ob/clusters/${clusterId}/zones`).catch(() => ({ contents: [] })),
    client.call<any>(`/api/v2/ob/clusters/${clusterId}/servers`).catch(() => ({ contents: [] })),
    client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants`).catch(() => ({ contents: [] })),
    client.call<any>('/api/v2/ob/clusters/alarmSummaries').catch(() => ({ contents: [] })),
    ocpClusterStats(client, clusterId).catch(() => ({})),
    client.call<any>('/api/v2/ob/unitSpecs', { query: { page: 1, size: 200 } }).catch(() => ({ contents: [] }))
  ])
  const alarmMap = new Map<number, AlarmLevelCount[]>()
  for (const a of contentsOf(alarmSumsRaw)) {
    alarmMap.set(num(a.id), (a.alarmSummaries || []).map((x: any) => ({ level: num(x.level), count: num(x.count) })))
  }
  const attr = detail?.attributes || {}
  const attributes: { key: string; label: string }[] = [
    { key: '安装目录', label: str(attr.InstallPath) },
    { key: '运行目录', label: str(attr.RunPath) },
    { key: '数据盘', label: str(attr.DataDiskPath) },
    { key: '日志盘', label: str(attr.LogDiskPath) },
    { key: 'SQL 端口', label: str(attr.SqlPort) },
    { key: 'RPC 端口', label: str(attr.SvrPort) },
    { key: '系统用户', label: str(attr.OperatingSystemUser) },
    { key: '架构', label: str(detail?.architecture) },
    { key: 'OB 启动时间', label: str(detail?.obStartTime) },
    { key: '合并状态', label: str(detail?.compactionStatus) },
    { key: 'RootService', label: str(detail?.configUrl) }
  ].filter((x) => x.label)

  const params = Array.isArray(detail?.startupParameters)
    ? detail.startupParameters.map((p: any) => ({ key: str(p.name), value: str(p.value) }))
    : Array.isArray(detail?.startupParameters?.contents) ? detail.startupParameters.contents.map((p: any) => ({ key: str(p.name), value: str(p.value) })) : []

  return {
    cluster: toCluster({ ...detail, resourceStats: stats }, alarmMap),
    attributes,
    zones: (zonesRaw?.contents || []).map((z: any) => ({
      name: str(z.name),
      idc: str(z.idcName),
      region: str(z.regionName),
      status: str(z.innerStatus || z.status),
      serverCount: num(z.serverCount),
      rootServer: str(z.rootServer?.address)
    })),
    servers: (serversRaw?.contents || []).map((s: any) => ({
      id: num(s.id),
      ip: str(s.ip),
      zone: str(s.zoneName),
      status: str(s.status),
      hostStatus: str(s.hostStatus),
      withRootserver: !!s.withRootserver,
      version: str(s.version).split('(')[0],
      startTime: str(s.startTime)
    })),
    tenants: (tenantsRaw?.contents || []).map(toTenant),
    startupParameters: params,
    unitSpecs: (unitSpecsRaw?.contents || []).map((u: any) => ({
      name: str(u.name),
      cpu: num(u.maxCpuCoreCount ?? u.minCpuCoreCount),
      memory: num(u.maxMemoryByte ?? (u.maxMemorySize ? u.maxMemorySize * 1024 ** 3 : 0)),
      type: str(u.type)
    }))
  }
}

/** 单集群容量：/ob/clusters/stats 是全量列表，按 id 取一条 */
async function ocpClusterStats(client: OcpClient, clusterId: number): Promise<any> {
  const s = await client.call<any>('/api/v2/ob/clusters/stats', { query: { page: 1, size: 200 } }).catch(() => null)
  const list = s?.contents || []
  return list.find((x: any) => num(x.clusterId) === num(clusterId)) || {}
}

export async function ocpTenants(client: OcpClient): Promise<CloudTenant[]> {
  const data = await client.call<any>('/api/v2/ob/tenants', { query: { page: 1, size: 500 } })
  return (data?.contents || []).map(toTenant)
}

export async function ocpTenantDetail(client: OcpClient, clusterId: number, tenantId: number): Promise<CloudTenantDetail> {
  const d = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}`)
  return {
    tenant: toTenant(d),
    charset: str(d?.charset),
    collation: str(d?.collation),
    whitelist: str(d?.whitelist),
    description: str(d?.description),
    deadLockDetection: !!d?.deadLockDetectionEnabled,
    zoneList: String(str(d?.zoneList) || '').split(',').map((s) => s.trim()).filter(Boolean),
    logBackupRunning: !!d?.logBackupInfo?.runningLogBackup,
    standbyTenants: (Array.isArray(d?.basicStandbyTenantList) ? d.basicStandbyTenantList : []).map((o: any) => ({
      id: num(o?.id),
      name: str(o?.name),
      clusterName: str(o?.clusterName),
      syncStatus: str(o?.syncStatus)
    })),
    zones: (Array.isArray(d?.zones) ? d.zones : []).map((z: any) => {
      const uc = z?.resourcePool?.unitConfig || {}
      return {
        name: str(z.name),
        replicaType: str(z.replicaType),
        poolName: str(z?.resourcePool?.name),
        unitCount: num(z?.resourcePool?.unitCount),
        unitCpu: num(uc.maxCpuCoreCount ?? uc.minCpuCoreCount),
        unitMemory: num(uc.maxMemoryByte ?? uc.minMemoryByte),
        units: (Array.isArray(z?.units) ? z.units : []).map((u: any) => ({
          id: num(u.id),
          ip: str(u.serverIp),
          port: num(u.serverPort),
          status: str(u.status)
        }))
      }
    })
  }
}

export async function ocpHosts(client: OcpClient): Promise<CloudHost[]> {
  const data = await client.call<any>('/api/v2/compute/hosts', { query: { page: 1, size: 500 } })
  return (data?.contents || []).map(toHost)
}

export interface AlarmQuery {
  /** 级别：1 严重 / 2 警告 / 3 注意（0 或不传表示全部） */
  level?: number
  /** 对象类型：Host / Tenant / Cluster / Service … */
  scope?: string
  /** 关键词（告警名 / 描述 / 对象 / 规则标识） */
  keyword?: string
  /** 告警类型（规则标识），「同类型告警」下钻用 */
  alarmType?: string
  /** 应用：OCP / OceanBase … */
  appType?: string
  /** 只看最近 N 小时内产生的告警（走 activeAtStart，实测活跃告警接口也生效） */
  hours?: number
  page?: number
  size?: number
}

export interface AlarmListResult {
  items: CloudAlarm[]
  total: number
}

/**
 * 活跃告警：GET /api/v2/alarm/alarms/actived
 * 实测服务端支持 level / scope / keyword / alarmType / appType，page/size 也返回 page.totalElements。
 */
export async function ocpAlarms(client: OcpClient, opts: AlarmQuery = {}): Promise<AlarmListResult> {
  const query: Record<string, any> = { page: opts.page ?? 1, size: opts.size ?? 200 }
  if (opts.level) query.level = opts.level
  if (opts.scope) query.scope = opts.scope
  if (opts.keyword) query.keyword = opts.keyword
  if (opts.alarmType) query.alarmType = opts.alarmType
  if (opts.appType) query.appType = opts.appType
  if (opts.hours) query.activeAtStart = isoOffset(Date.now() - opts.hours * 3600e3)
  const data = await client.call<any>('/api/v2/alarm/alarms/actived', { query })
  return {
    items: (data?.contents || [])
      .map(toAlarm)
      .sort((a: CloudAlarm, b: CloudAlarm) => b.activeAt.localeCompare(a.activeAt)),
    total: num(data?.page?.totalElements) || (data?.contents || []).length
  }
}

export interface AlarmHistoryResult {
  items: CloudAlarm[]
  total: number
  page: number
  size: number
}

/**
 * 历史告警（已恢复）：GET /api/v2/alarm/alarms/history
 *
 * 实测坑：时间参数**不是** startTime/endTime（传了不生效，仍是全量 5473 条），
 * 而是 `activeAtStart` / `activeAtEnd`（OffsetDateTime）。level / scope / keyword / alarmType / appType 都支持服务端过滤。
 */
export async function ocpAlarmHistory(
  client: OcpClient,
  opts: { page?: number; size?: number; hours?: number; level?: number; scope?: string; keyword?: string; alarmType?: string; appType?: string } = {}
): Promise<AlarmHistoryResult> {
  const page = opts.page ?? 1
  const size = opts.size ?? 50
  const query: Record<string, any> = { page, size }
  if (opts.hours) {
    const to = Date.now()
    query.activeAtStart = isoOffset(to - opts.hours * 3600e3)
    query.activeAtEnd = isoOffset(to)
  }
  if (opts.level) query.level = opts.level
  if (opts.scope) query.scope = opts.scope
  if (opts.keyword) query.keyword = opts.keyword
  if (opts.alarmType) query.alarmType = opts.alarmType
  if (opts.appType) query.appType = opts.appType
  const data = await client.call<any>('/api/v2/alarm/alarms/history', { query })
  return {
    items: (data?.contents || []).map(toAlarm),
    total: num(data?.page?.totalElements),
    page: num(data?.page?.number) || page,
    size: num(data?.page?.size) || size
  }
}

/**
 * 单条告警详情：GET /api/v2/alarm/alarms/{id}
 * 比列表多出 metricGroup / obCluster / targetLabels（指标分组与推荐标签）。
 */
export async function ocpAlarmDetail(client: OcpClient, id: number): Promise<CloudAlarm> {
  const data = await client.call<any>(`/api/v2/alarm/alarms/${id}`)
  return toAlarm(data)
}

/** 活跃告警按级别人数：GET /api/v2/alarm/overview/active → [{level, count}] */
export async function ocpAlarmLevelCounts(client: OcpClient): Promise<{ level: number; count: number }[]> {
  const data = await client.call<any>('/api/v2/alarm/overview/active')
  return (data?.contents || []).map((o: any) => ({ level: num(o.level), count: num(o.count) }))
}

export interface AlarmRuleDetect {
  id: number
  /** 指标名（alarmMetric），例如 ob_tenant_session_kill_delay */
  metric: string
  expression: string
  expressionType: string
  level: number
  durationSeconds: number
  evaluationIntervalSeconds: number
  resolveTimeoutSeconds: number
  isDefault: boolean
}

export interface AlarmRuleTarget {
  scope: string
  appType: string
  includeCount: number
  excludeCount: number
}

export interface AlarmRule {
  id: number
  name: string
  alarmType: string
  appType: string
  scope: string
  level: number
  isEnabled: boolean
  isBuildIn: boolean
  autoResolved: boolean
  evaluationIntervalSeconds: number
  resolveTimeoutSeconds: number
  createdBy: string
  groups: string[]
  targetLabels: string[]
  detects: AlarmRuleDetect[]
  targets: AlarmRuleTarget[]
  descriptionTemplate: string
  summaryTemplate: string
}

export interface AlarmRuleQuery {
  page?: number
  size?: number
  level?: number
  scope?: string
  appType?: string
  /** 关键词（规则名 / 指标名） */
  keyword?: string
  /** 只看启用/停用 */
  enabled?: boolean
}

function toAlarmRule(raw: any): AlarmRule {
  const detects = (Array.isArray(raw?.alarmDetectRules) ? raw.alarmDetectRules : []).map((d: any) => ({
    id: num(d.id),
    metric: str(d.alarmMetric),
    expression: str(d.expression) || str(d?.alarmExpression?.children?.[0]?.expression),
    expressionType: str(d.expressionType),
    level: num(d.level),
    durationSeconds: num(d.durationSeconds),
    evaluationIntervalSeconds: num(d.evaluationIntervalSeconds),
    resolveTimeoutSeconds: num(d.resolveTimeoutSeconds),
    isDefault: !!d.isDefault
  }))
  const targets = (Array.isArray(raw?.alarmTargets) ? raw.alarmTargets : []).map((t: any) => ({
    scope: str(t.scope),
    appType: str(t.appType),
    includeCount: Array.isArray(t.includeTargets) && t.includeTargets.length ? t.includeTargets.length : 0,
    excludeCount: Array.isArray(t.excludeTargets) ? t.excludeTargets.length : 0
  }))
  return {
    id: num(raw?.id),
    name: str(raw?.name),
    alarmType: str(raw?.alarmType),
    appType: str(raw?.appType),
    scope: str(raw?.scope) || str(raw?.alarmTargets?.[0]?.scope),
    level: num(raw?.level),
    isEnabled: raw?.isEnabled !== false,
    isBuildIn: !!raw?.isBuildIn,
    autoResolved: !!raw?.autoResolved,
    evaluationIntervalSeconds: num(raw?.evaluationIntervalSeconds),
    resolveTimeoutSeconds: num(raw?.resolveTimeoutSeconds),
    createdBy: str(raw?.createdBy),
    groups: Array.isArray(raw?.alarmGroupNames) ? raw.alarmGroupNames.map(str) : [],
    targetLabels: Array.isArray(raw?.targetLabels) ? raw.targetLabels.map(str) : [],
    detects,
    targets,
    descriptionTemplate: str(raw?.descriptionTemplate),
    summaryTemplate: str(raw?.summaryTemplate)
  }
}

/**
 * 告警规则：GET /api/v2/alarm/rules（实测 294 条）
 * 支持 level / scope / appType / keyword / isEnabled 服务端过滤；name 参数无效。
 */
export async function ocpAlarmRules(client: OcpClient, opts: AlarmRuleQuery = {}): Promise<{ items: AlarmRule[]; total: number; page: number; size: number }> {
  const page = opts.page ?? 1
  const size = opts.size ?? 50
  const query: Record<string, any> = { page, size }
  if (opts.level) query.level = opts.level
  if (opts.scope) query.scope = opts.scope
  if (opts.appType) query.appType = opts.appType
  if (opts.keyword) query.keyword = opts.keyword
  if (opts.enabled !== undefined) query.isEnabled = opts.enabled
  const data = await client.call<any>('/api/v2/alarm/rules', { query })
  return {
    items: (data?.contents || []).map(toAlarmRule),
    total: num(data?.page?.totalElements),
    page: num(data?.page?.number) || page,
    size: num(data?.page?.size) || size
  }
}

export interface AlarmTrendBucket {
  /** 该小时起点的 ISO 时间（UTC），渲染层转本地展示 */
  at: string
  total: number
  levels: { 1: number; 2: number; 3: number }
}

export interface AlarmTrend {
  hours: number
  /** 时间窗内的告警总数（服务端 totalElements） */
  total: number
  /** 实际取回并参与统计的条数（上限 500） */
  scanned: number
  /** 是否因为超过 500 条而只统计了前 500 条 */
  truncated: boolean
  buckets: AlarmTrendBucket[]
  levels: { 1: number; 2: number; 3: number }
  scopes: { key: string; count: number }[]
  appTypes: { key: string; count: number }[]
  types: { key: string; name: string; count: number }[]
}

/**
 * 近 N 小时的告警分布（OCP 没有现成的趋势接口，用历史告警的时间窗 + 前端分桶实现）。
 * 只取一页 500 条：24h 实测 150 条，够用；超过 500 条时 truncated=true，界面要说明。
 */
export async function ocpAlarmTrend(client: OcpClient, hours = 24): Promise<AlarmTrend> {
  const cap = 500
  const end = Date.now()
  const start = end - hours * 3600e3
  const data = await client.call<any>('/api/v2/alarm/alarms/history', {
    query: { page: 1, size: cap, activeAtStart: isoOffset(start), activeAtEnd: isoOffset(end) }
  })
  const rows: CloudAlarm[] = (data?.contents || []).map(toAlarm)
  const total = num(data?.page?.totalElements)

  const hourMs = 3600e3
  const firstHour = new Date(start)
  firstHour.setMinutes(0, 0, 0)
  const baseMs = firstHour.getTime()
  const count = Math.floor((end - baseMs) / hourMs) + 1
  const buckets: AlarmTrendBucket[] = Array.from({ length: count }, (_, i) => ({
    at: new Date(baseMs + i * hourMs).toISOString(),
    total: 0,
    levels: { 1: 0, 2: 0, 3: 0 }
  }))
  const levels = { 1: 0, 2: 0, 3: 0 }
  const scopeMap = new Map<string, number>()
  const appMap = new Map<string, number>()
  const typeMap = new Map<string, { name: string; count: number }>()

  for (const a of rows) {
    const t = new Date(a.activeAt).getTime()
    const idx = Number.isFinite(t) ? Math.floor((t - baseMs) / hourMs) : -1
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].total++
      const lv = a.level === 1 ? 1 : a.level === 2 ? 2 : 3
      buckets[idx].levels[lv as 1 | 2 | 3]++
    }
    if (a.level === 1 || a.level === 2 || a.level === 3) levels[a.level as 1 | 2 | 3]++
    scopeMap.set(a.scope, (scopeMap.get(a.scope) || 0) + 1)
    appMap.set(a.appType, (appMap.get(a.appType) || 0) + 1)
    const hit = typeMap.get(a.alarmType)
    if (hit) hit.count++
    else typeMap.set(a.alarmType, { name: a.name, count: 1 })
  }

  const sortDesc = (m: Map<string, number>) => [...m.entries()]
    .filter(([k]) => !!k)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, count: value }))

  return {
    hours,
    total,
    scanned: rows.length,
    truncated: total > rows.length,
    buckets,
    levels,
    scopes: sortDesc(scopeMap),
    appTypes: sortDesc(appMap),
    types: [...typeMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([key, v]) => ({ key, name: v.name, count: v.count }))
  }
}

export type TaskSort = 'start_desc' | 'start_asc' | 'duration_desc'

export interface TaskQuery {
  page?: number
  size?: number
  /** SUCCESSFUL / FAILED / RUNNING / PENDING …（服务端过滤，实测有效；不支持逗号多值） */
  status?: string
  /** 多个状态（服务端不支持多值，命中时改由本地过滤，例如「执行中」= RUNNING+PENDING+EXECUTING） */
  statusIn?: string[]
  /** 任务名或操作对象关键词（服务端模糊匹配，实测有效；keyword 与 name 等价） */
  name?: string
  /** 集群 / 租户（服务端过滤，实测有效） */
  clusterId?: number
  tenantId?: number
  /** 以下条件服务端不支持，由主进程在抓取的候选集里过滤（最多扫描 1000 条） */
  creator?: string
  objType?: string
  /** MANUAL / AUTO */
  type?: string
  /** 只看最近 N 小时内开始的任务 */
  hours?: number
  sort?: TaskSort
}

export interface TaskListResult {
  items: CloudTask[]
  total: number
  page: number
  size: number
  /** 实际扫描的条数（客户端过滤时才有意义） */
  scanned: number
  /** 候选集被 1000 条上限截断（筛选结果可能不全） */
  truncated: boolean
}

const TASK_PAGE_CAP = 200
const TASK_SCAN_CAP = 1000

function sortTasks(rows: CloudTask[], sort: TaskSort = 'start_desc'): CloudTask[] {
  const t = (s: string) => (s ? new Date(s).getTime() : 0)
  const dur = (x: CloudTask) => (x.startTime ? t(x.finishTime || '') || Date.now() - t(x.startTime) : 0)
  const out = [...rows]
  if (sort === 'start_asc') out.sort((a, b) => t(a.startTime) - t(b.startTime))
  else if (sort === 'duration_desc') out.sort((a, b) => dur(b) - dur(a))
  else out.sort((a, b) => t(b.startTime) - t(a.startTime))
  return out
}

/**
 * 任务列表：GET /api/v2/tasks/instances
 *
 * 服务端只认 status / name(keyword) / clusterId / tenantId / page / size。
 * 发起者、对象类型、触发方式、时间窗、排序都不支持（实测传了总数不变），
 * 所以命中这些条件时先按服务端条件抓最多 1000 条候选，再在本地过滤 + 排序 + 分页。
 */
export async function ocpTasks(client: OcpClient, opts: TaskQuery = {}): Promise<TaskListResult> {
  const page = opts.page ?? 1
  const size = opts.size ?? 20
  const server: Record<string, any> = { page, size }
  if (opts.status) server.status = opts.status
  if (opts.name) server.name = opts.name
  if (opts.clusterId) server.clusterId = opts.clusterId
  if (opts.tenantId) server.tenantId = opts.tenantId

  const localFilter = !!(opts.creator || opts.objType || opts.type || opts.hours || (opts.statusIn && opts.statusIn.length))
  const needSort = !!opts.sort && opts.sort !== 'start_desc'

  if (!localFilter && !needSort) {
    const data = await client.call<any>('/api/v2/tasks/instances', { query: server })
    const total = num(data?.page?.totalElements)
    return {
      items: (data?.contents || []).map(toTask),
      total,
      page: num(data?.page?.number) || page,
      size: num(data?.page?.size) || size,
      scanned: total,
      truncated: false
    }
  }

  // 抓候选：沿用服务端筛选条件，逐页取到 1000 条为止
  const all: CloudTask[] = []
  let total = 0
  for (let i = 1; i <= Math.ceil(TASK_SCAN_CAP / TASK_PAGE_CAP); i++) {
    const data = await client.call<any>('/api/v2/tasks/instances', { query: { ...server, page: i, size: TASK_PAGE_CAP } })
    const rows = (data?.contents || []).map(toTask)
    total = num(data?.page?.totalElements)
    all.push(...rows)
    if (rows.length < TASK_PAGE_CAP || all.length >= total) break
  }

  const from = opts.hours ? Date.now() - opts.hours * 3600e3 : 0
  const statusSet = opts.statusIn && opts.statusIn.length ? new Set(opts.statusIn) : null
  const filtered = all.filter((t) => {
    if (statusSet && !statusSet.has(t.status)) return false
    if (opts.creator && t.creator !== opts.creator) return false
    if (opts.objType && t.objType !== opts.objType) return false
    if (opts.type && t.type !== opts.type) return false
    if (from && (!t.startTime || new Date(t.startTime).getTime() < from)) return false
    return true
  })
  const sorted = sortTasks(filtered, opts.sort)
  const begin = (page - 1) * size
  return {
    items: sorted.slice(begin, begin + size),
    total: sorted.length,
    page,
    size,
    scanned: all.length,
    truncated: all.length < total
  }
}

/** 任务详情：GET /api/v2/tasks/instances/{id}（带每步耗时、依赖与执行器） */
export async function ocpTaskDetail(client: OcpClient, id: number): Promise<CloudTaskDetail> {
  const data = await client.call<any>(`/api/v2/tasks/instances/${id}`)
  return toTaskDetail(data)
}

/** 各状态任务数：GET /api/v2/tasks/instances/state-statistics-batch → [{status, count}] */
export async function ocpTaskStats(client: OcpClient): Promise<{ status: string; count: number }[]> {
  const data = await client.call<any>('/api/v2/tasks/instances/state-statistics-batch')
  return (data?.contents || []).map((o: any) => ({ status: str(o.status), count: num(o.count) }))
}

/** 任务发起者列表（筛选用）：GET /api/v2/tasks/instances/creators */
export async function ocpTaskCreators(client: OcpClient): Promise<string[]> {
  const data = await client.call<any>('/api/v2/tasks/instances/creators')
  return (data?.contents || []).map(str)
}

// ---------------------------------------------------------------- 监控指标
// 逆向自 OCP 前端：GET /api/v2/monitor/metric?scope=&metrics=&groupBy=&labels=&startTime=&endTime=&maxPoints=
// scope ∈ CLUSTER / TENANT / HOST；labels 形如 "ob_cluster_name:obc"（多标签用逗号）
// 返回 { contents: [{ <metricKey>: 12.3, timestamp: 秒 }] }

export type MetricScope = 'CLUSTER' | 'TENANT' | 'HOST'

export interface MetricDef { key: string; label: string; unit: string }

export interface MetricSeries {
  key: string
  label: string
  unit: string
  points: { t: number; v: number | null }[]
  min: number | null
  max: number | null
  avg: number | null
  last: number | null
}

export interface MetricQuery {
  scope: MetricScope
  metrics: MetricDef[]
  /** 实体过滤，如 ob_cluster_name:obc */
  labels?: string
  /** 分组维度，如 ob_cluster_id / tenant_name / svr_ip */
  groupBy: string
  from: number
  to: number
  maxPoints?: number
}

export async function ocpMetrics(client: OcpClient, q: MetricQuery): Promise<{ series: MetricSeries[]; warnings: string[]; step: number }> {
  const warnings: string[] = []
  const spanSec = Math.max(1, Math.round((q.to - q.from) / 1000))
  const step = Math.max(1, Math.round(spanSec / (q.maxPoints || 120)))
  // 每个指标单独请求：OCP 的 metrics 多值返回结构不稳定，单指标最可靠
  const results = await Promise.all(
    q.metrics.map(async (m) => {
      try {
        const data = await client.call<any>('/api/v2/monitor/metric', {
          query: {
            scope: q.scope,
            metrics: m.key,
            groupBy: q.groupBy,
            labels: q.labels || undefined,
            startTime: new Date(q.from).toISOString(),
            endTime: new Date(q.to).toISOString(),
            maxPoints: q.maxPoints || 120
          }
        })
        const rows = (data?.contents || []) as any[]
        const points = rows
          .map((r) => ({ t: num(r.timestamp) * 1000, v: r[m.key] === null || r[m.key] === undefined ? null : Number(r[m.key]) }))
          .filter((p) => Number.isFinite(p.t))
          .sort((a, b) => a.t - b.t)
        const vals = points.map((p) => p.v).filter((v): v is number => v !== null && Number.isFinite(v))
        return {
          key: m.key,
          label: m.label,
          unit: m.unit,
          points,
          min: vals.length ? Math.min(...vals) : null,
          max: vals.length ? Math.max(...vals) : null,
          avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null,
          last: vals.length ? vals[vals.length - 1] : null
        } as MetricSeries
      } catch (e: any) {
        warnings.push(`${m.label}：${e?.message || e}`)
        return { key: m.key, label: m.label, unit: m.unit, points: [], min: null, max: null, avg: null, last: null } as MetricSeries
      }
    })
  )
  return { series: results, warnings, step }
}

// ---------------------------------------------------------------- 运维动作

/** 集群动作：restart / start / stop / triggerCompaction / delete（delete 为 DELETE 方法） */
export async function ocpClusterAction(client: OcpClient, clusterId: number, action: string): Promise<{ taskId?: number; message?: string }> {
  const map: Record<string, { method?: string; path: string }> = {
    restart: { path: `/api/v2/ob/clusters/${clusterId}/restart` },
    start: { path: `/api/v2/ob/clusters/${clusterId}/start` },
    stop: { path: `/api/v2/ob/clusters/${clusterId}/stop` },
    triggerCompaction: { path: `/api/v2/ob/clusters/${clusterId}/triggerCompaction` },
    delete: { method: 'DELETE', path: `/api/v2/ob/clusters/${clusterId}` }
  }
  const a = map[action]
  if (!a) throw new OcpError(`不支持的操作：${action}`)
  const data = await client.call<any>(a.path, { method: a.method || 'POST', body: a.method === 'DELETE' ? undefined : {} })
  return { taskId: data?.taskId ? num(data.taskId) : undefined, message: str(data?.message) || undefined }
}

export interface CreateTenantInput {
  name: string
  mode: 'MYSQL' | 'ORACLE'
  charset: string
  /** 排序规则：OCP 新建向导按字符集联动必填，不传时后端会用字符集默认值 */
  collation?: string
  rootPassword: string
  whitelist: string
  primaryZone: string
  /** 租户描述 */
  description?: string
  zones: { name: string; unitSpecName: string; unitCount: number; replicaType?: string }[]
}

export async function ocpCreateTenant(client: OcpClient, clusterId: number, input: CreateTenantInput): Promise<{ taskId?: number }> {
  // OCP 前端对 rootPassword 也做 RSA 加密后提交（不加密在真机创建时会校验失败）
  const encPassword = await client.encryptSensitive(input.rootPassword)
  const body: Record<string, any> = {
    name: input.name,
    type: 'PRIMARY',
    mode: input.mode,
    charset: input.charset,
    rootPassword: encPassword,
    whitelist: input.whitelist || '%',
    primaryZone: input.primaryZone || 'RANDOM',
    zones: input.zones.map((z) => ({
      name: z.name,
      replicaType: z.replicaType || 'FULL',
      unitSpecName: z.unitSpecName,
      unitCount: z.unitCount
    }))
  }
  // 可选字段：留空就不传，让 OCP 用默认（与前端向导行为一致）
  if (input.collation) body.collation = input.collation
  if (input.description) body.description = input.description
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/createTenant`, { method: 'POST', body })
  return { taskId: data?.taskId ? num(data.taskId) : undefined }
}

export async function ocpDeleteTenant(client: OcpClient, clusterId: number, tenantId: number): Promise<{ taskId?: number }> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}`, { method: 'DELETE' })
  return { taskId: data?.taskId ? num(data.taskId) : undefined }
}

/** 集群可用版本包（创建集群/升级用）：OCP 4.4 的软件包列表在 /api/v2/software-packages（连字符） */
export async function ocpPackages(client: OcpClient): Promise<{ name: string; version: string; architecture: string; id: number }[]> {
  const data = await client.call<any>('/api/v2/software-packages', { query: { page: 1, size: 200 } }).catch(() => null)
  return (data?.contents || [])
    .filter((p: any) => !p.type || p.type === 'OB_SERVER_INSTALL_PACKAGE')
    .map((p: any) => ({ id: num(p.id), name: str(p.fileName), version: str(p.version), architecture: str(p.architecture) }))
}


// ---------------------------------------------------------------- 创建集群 / 参数

export interface ClusterCreateInput {
  name: string
  fullVersion: string
  password: string
  rootSysPassword: string
  zones: { name: string; idcName: string; servers: number[]; rpmName: string; architecture: string }[]
  installPath: string
  dataDiskPath: string
  logDiskPath: string
  sqlPort: number
  svrPort: number
  cgroupEnabled: boolean
}

function createBody(input: ClusterCreateInput): any {
  return {
    type: 'PRIMARY',
    name: input.name,
    cgroupEnabled: input.cgroupEnabled,
    fullVersion: input.fullVersion,
    zones: input.zones.map((z) => ({
      rpmName: z.rpmName,
      name: z.name,
      idcName: z.idcName,
      servers: z.servers,
      architecture: z.architecture,
      rootServer: z.servers[0]
    })),
    password: input.password,
    rootSysPassword: input.rootSysPassword,
    installPath: input.installPath,
    dataDiskPath: input.dataDiskPath,
    logDiskPath: input.logDiskPath,
    sqlPort: input.sqlPort,
    svrPort: input.svrPort
  }
}

export interface PrecheckItem {
  key: string
  name: string
  status: string
  message?: string
}

/**
 * 创建集群前置检查：
 * 1) POST /ob/clusters/createPreCheck → 立即返回 checkId + syncCheckItems（同步项已出结果）+ asyncCheckItems（全 PENDING）
 * 2) 异步项轮询 GET /api/v2/precheck/{checkId}/item/result?itemKeys=a,b（OCP 4.4 前端同款端点）
 *    返回 {asyncCheckItems:[{itemKey,itemName,status,failedCauseList:[{cause,suggestion}]}]}
 * 这里代前端轮询到全部出结果（上限 ~45s），合并为一张列表。
 */
export async function ocpClusterCreatePreCheck(client: OcpClient, input: ClusterCreateInput): Promise<{ checkId?: string; items: PrecheckItem[] }> {
  const data = await client.call<any>('/api/v2/ob/clusters/createPreCheck', { method: 'POST', body: createBody(input) })
  const checkId = data?.checkId ? String(data.checkId) : undefined
  const byKey = new Map<string, PrecheckItem>()
  const put = (x: any, causes?: any[]): void => {
    if (!x?.itemKey) return
    const cause = (causes || []).map((f: any) => [str(f?.cause), str(f?.suggestion)].filter(Boolean).join(' 建议：')).filter(Boolean).join('；')
    byKey.set(String(x.itemKey), { key: String(x.itemKey), name: str(x.itemName) || String(x.itemKey), status: str(x.status) || 'PENDING', message: cause || undefined })
  }
  for (const x of data?.syncCheckItems || []) put(x, x?.failedCauseList)
  const asyncItems: any[] = data?.asyncCheckItems || []
  for (const x of asyncItems) put(x, x?.failedCauseList)
  if (checkId && asyncItems.length) {
    const keys = asyncItems.map((x) => x.itemKey).join(',')
    const t0 = Date.now()
    while (Date.now() - t0 < 45000) {
      await new Promise((r) => setTimeout(r, 2000))
      let res: any = null
      try {
        res = await client.call<any>(`/api/v2/precheck/${checkId}/item/result`, { query: { itemKeys: keys } })
      } catch {
        break // 轮询失败就返回首帧，不让预检查整体挂掉
      }
      for (const x of res?.asyncCheckItems || []) put(x, x?.failedCauseList)
      const pending = [...byKey.values()].filter((i) => /PENDING|RUNNING/i.test(i.status))
      if (!pending.length) break
    }
  }
  return { checkId, items: [...byKey.values()] }
}

/** 创建集群（checkId 来自预检查，OCP 会校验通过项） */
export async function ocpClusterCreate(client: OcpClient, input: ClusterCreateInput, checkId?: string): Promise<{ taskId?: number }> {
  const body = { ...createBody(input), ...(checkId ? { checkId } : {}) }
  const data = await client.call<any>('/api/v2/ob/clusters', { method: 'POST', body })
  return { taskId: data?.taskId ? num(data.taskId) : undefined }
}

export interface ParamRow {
  name: string
  value: string
  section: string
  tenant: string
  zone: string
  server: string
  editable: boolean
  info: string
}

/** 集群参数：OCP 返回按 参数 × 租户 × 服务器 展开的嵌套结构，这里拍平成表 */
export async function ocpClusterParameters(client: OcpClient, clusterId: number): Promise<ParamRow[]> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/parameters`, { query: { page: 1, size: 500 } })
  const rows: ParamRow[] = []
  for (const item of data?.contents || []) {
    for (const p of item?.currentValue?.obParameters || []) {
      rows.push({
        name: str(p.name),
        value: str(p.value),
        section: str(p.section),
        tenant: str(p.tenantName),
        zone: str(p.zone),
        server: `${str(p.svrIp)}:${num(p.svrPort)}`,
        editable: !p.readonly,
        info: str(p.info)
      })
    }
  }
  return rows
}

/** 租户参数（简单列表） */
export async function ocpTenantParameters(client: OcpClient, clusterId: number, tenantId: number): Promise<{ name: string; value: string; def: string; type: string; description: string }[]> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/parameters`, { query: { page: 1, size: 500 } })
  return (data?.contents || []).map((p: any) => ({
    name: str(p.name),
    value: str(p.currentValue),
    def: str(p.defaultValue),
    type: str(p.parameterType),
    description: str(p.description)
  }))
}

/** 修改集群参数：body 与租户参数同构（[{name, value}]），按参数名下发给该集群全部 OBServer */
export async function ocpClusterUpdateParameters(
  client: OcpClient, clusterId: number, items: { name: string; value: string }[]
): Promise<void> {
  if (!items.length) return
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/parameters`, { method: 'PUT', body: items.map((i) => ({ name: i.name, value: i.value })) })
}

/** 修改租户参数：body 是 [{name, value}] 数组（OCP 4.4 实测） */
export async function ocpTenantUpdateParameters(
  client: OcpClient, clusterId: number, tenantId: number, items: { name: string; value: string }[]
): Promise<void> {
  if (!items.length) return
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/parameters`, { method: 'PUT', body: items.map((i) => ({ name: i.name, value: i.value })) })
}

// ---------------------------------------------------------------- 租户管理（对齐 OCP 租户详情页）

/** 修改租户管理员密码（newPassword 会按 OCP 前端惯例先 RSA 加密再提交） */
export async function ocpTenantChangePassword(client: OcpClient, clusterId: number, tenantId: number, newPassword: string): Promise<void> {
  if (!newPassword) throw new OcpError('请填写新密码')
  const enc = await client.encryptSensitive(newPassword)
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/changePassword`, { method: 'POST', body: { newPassword: enc } })
}

/** 修改访问白名单（逗号分隔 IP/CIDR，% 表示全部放开） */
export async function ocpTenantModifyWhitelist(client: OcpClient, clusterId: number, tenantId: number, whitelist: string): Promise<void> {
  const w = String(whitelist || '').trim()
  if (!w) throw new OcpError('白名单不能为空（放开全部请填 %）')
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/modifyWhitelist`, { method: 'POST', body: { whitelist: w } })
}

export interface TenantReplicaInput {
  zoneName: string
  replicaType: string
  unitSpecName: string
  unitCount: number
}

/**
 * 修改副本（OCP「编辑租户副本」= 同一入口承担 Unit 扩缩容 / 改副本类型 / 改规格）：
 * body 是整份副本列表 [{zoneName, replicaType, resourcePool:{unitSpecName, unitCount}}]，返回任务号。
 */
export async function ocpTenantModifyReplica(client: OcpClient, clusterId: number, tenantId: number, replicas: TenantReplicaInput[]): Promise<{ taskId?: number }> {
  if (!replicas.length) throw new OcpError('副本列表不能为空')
  const body = replicas.map((r) => ({
    zoneName: r.zoneName,
    replicaType: r.replicaType || 'FULL',
    resourcePool: { unitSpecName: r.unitSpecName, unitCount: Math.max(1, Number(r.unitCount) || 1) }
  }))
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/modifyReplica`, { method: 'POST', body })
  return { taskId: data?.taskId ? num(data.taskId) : undefined }
}

/** 新增副本（新 Zone 上加副本）：条目形状与 modifyReplica 相同 */
export async function ocpTenantAddReplica(client: OcpClient, clusterId: number, tenantId: number, replicas: TenantReplicaInput[]): Promise<{ taskId?: number }> {
  if (!replicas.length) throw new OcpError('请至少填写一个要新增副本的 Zone')
  const body = replicas.map((r) => ({
    zoneName: r.zoneName,
    replicaType: r.replicaType || 'FULL',
    resourcePool: { unitSpecName: r.unitSpecName, unitCount: Math.max(1, Number(r.unitCount) || 1) }
  }))
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/addReplica`, { method: 'POST', body })
  return { taskId: data?.taskId ? num(data.taskId) : undefined }
}

/** 删除副本：body 是 [{zoneName}] */
export async function ocpTenantDeleteReplica(client: OcpClient, clusterId: number, tenantId: number, zoneNames: string[]): Promise<{ taskId?: number }> {
  if (!zoneNames.length) throw new OcpError('请选择要删除副本的 Zone')
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/deleteReplica`, { method: 'POST', body: zoneNames.map((z) => ({ zoneName: z })) })
  return { taskId: data?.taskId ? num(data.taskId) : undefined }
}

/** 锁定 / 解锁租户（锁定后业务无法写入，sys/meta 租户 OCP 会直接拒绝） */
export async function ocpTenantSetLocked(client: OcpClient, clusterId: number, tenantId: number, locked: boolean): Promise<void> {
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/${locked ? 'lock' : 'unlock'}`, { method: 'POST', body: {} })
}

export interface CloudTenantSession {
  id: number
  user: string
  host: string
  db: string
  command: string
  time: number
  state: string
  info: string
  observer: string
  proxy: string
}

/** 租户会话列表（GV$OB_PROCESSLIST 聚合） */
export async function ocpTenantSessions(client: OcpClient, clusterId: number, tenantId: number, page = 1, size = 200): Promise<{ items: CloudTenantSession[]; total: number }> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/sessions`, { query: { page, size } })
  const items = (data?.contents || []).map((s: any) => ({
    id: num(s.id),
    user: str(s.dbUser || s.user),
    host: str(s.clientIp || s.userClientIp),
    db: str(s.dbName),
    command: str(s.command),
    time: num(s.time),
    state: str(s.state),
    info: str(s.info),
    observer: str(s.svrIp ? `${str(s.svrIp)}:${num(s.svrPort)}` : ''),
    proxy: str(s.proxyIp ? `${str(s.proxyIp)}:${num(s.proxyPort)}` : '')
  }))
  return { items, total: num(data?.page?.totalElements) || items.length }
}

/** 结束会话：body {sessionIds:[…]}（OCP 会话管理页同款端点） */
export async function ocpTenantCloseSessions(client: OcpClient, clusterId: number, tenantId: number, sessionIds: number[]): Promise<void> {
  if (!sessionIds.length) return
  await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/sessions/close`, { method: 'POST', body: { sessionIds } })
}

// ---------------------------------------------------------------- SQL 诊断（TopSQL / 慢 SQL）
// OCP 4.4 实测：GET /api/v2/ob/clusters/{cid}/tenants/{tid}/topSql
//   · 时间参数必须 OffsetDateTime（2026-10-21T02:33:56.895+00:00），毫秒时间戳会被拒；
//   · 条数参数是 limit（size / pageSize 都无效，page 也无效），不传则返回时间窗内全量；
//   · sqlText 是服务端过滤，dbName / userName 不生效（按它们过滤只能在前端做）；
//   · 集群级同款端点去掉 tenants/{tid} 段即可，返回跨租户汇总。

/** OffsetDateTime 格式（OCP 只认这个，不认毫秒时间戳） */
function isoOffset(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '+00:00')
}

export interface TopSqlRow {
  sqlId: string
  sqlTextShort: string
  sqlType: string
  tenantId: number
  tenantName: string
  userName: string
  dbName: string
  server: string
  serverIp: string
  executions: number
  execPs: number
  /** 以下耗时单位是微秒（μs） */
  avgCpuTime: number
  avgElapsedTime: number
  maxElapsedTime: number
  sumElapsedTime: number
  sumCpuTimeMs: number
  /** CPU 占比（%） */
  cpuPercentage: number
  failCount: number
  failPercentage: number
  lastFailCode: number
  waitEvent: string
  localPlanPercentage: number
  remotePlanPercentage: number
  distPlanPercentage: number
  missPlanPercentage: number
  tableScanPercentage: number
  strongConsistencyPercentage: number
  retryCount: number
  dynamicSql: boolean
  inner: boolean
  /** 常见错误码计数（4012 超时 / 4013 等锁 / 5001 等） */
  retCodes: Record<string, number>
}

export function toTopSql(o: any): TopSqlRow {
  return {
    sqlId: str(o?.sqlId),
    sqlTextShort: str(o?.sqlTextShort),
    sqlType: str(o?.sqlType),
    tenantId: num(o?.tenantId),
    tenantName: str(o?.tenantName),
    userName: str(o?.userName),
    dbName: str(o?.dbName),
    server: str(o?.server),
    serverIp: str(o?.serverIp),
    executions: num(o?.executions),
    execPs: num(o?.execPs),
    avgCpuTime: num(o?.avgCpuTime),
    avgElapsedTime: num(o?.avgElapsedTime),
    maxElapsedTime: num(o?.maxElapsedTime),
    sumElapsedTime: num(o?.sumElapsedTime),
    sumCpuTimeMs: num(o?.sumCpuTimeMs),
    cpuPercentage: num(o?.cpuPercentage),
    failCount: num(o?.failCount),
    failPercentage: num(o?.failPercentage),
    lastFailCode: num(o?.lastFailCode),
    waitEvent: str(o?.waitEvent),
    localPlanPercentage: num(o?.localPlanPercentage),
    remotePlanPercentage: num(o?.remotePlanPercentage),
    distPlanPercentage: num(o?.distPlanPercentage),
    missPlanPercentage: num(o?.missPlanPercentage),
    tableScanPercentage: num(o?.tableScanPercentage),
    strongConsistencyPercentage: num(o?.strongConsistencyPercentage),
    retryCount: num(o?.retryCount),
    dynamicSql: !!o?.dynamicSql,
    inner: !!o?.inner,
    retCodes: {
      '4012': num(o?.retCode4012Count),
      '4013': num(o?.retCode4013Count),
      '5001': num(o?.retCode5001Count),
      '5024': num(o?.retCode5024Count),
      '5167': num(o?.retCode5167Count),
      '5217': num(o?.retCode5217Count),
      '6002': num(o?.retCode6002Count)
    }
  }
}

export interface SqlQueryOpts {
  from: number
  to: number
  /** 服务端按 SQL 文本模糊过滤 */
  sqlText?: string
  /** 返回条数上限（默认 500，24 小时内通常几百条） */
  limit?: number
  /** 列表里 SQL 文本的截断长度（默认 4000；OCP 不传只给 50 字符，实测 4000 与 1000 耗时差别不大） */
  sqlTextLength?: number
}

/** 租户级 TopSQL；tenantId 传 0 时走集群级端点（跨租户） */
export async function ocpTopSql(client: OcpClient, clusterId: number, tenantId: number, opts: SqlQueryOpts): Promise<TopSqlRow[]> {
  const query: Record<string, any> = {
    startTime: isoOffset(opts.from),
    endTime: isoOffset(opts.to),
    limit: opts.limit ?? 500,
    // sqlTextLength 控制 sqlTextShort 的截断长度，不传只有 50 字符
    sqlTextLength: opts.sqlTextLength ?? 4000
  }
  if (opts.sqlText) query.sqlText = opts.sqlText
  const path = tenantId > 0
    ? `/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/topSql`
    : `/api/v2/ob/clusters/${clusterId}/topSql`
  const data = await client.call<any>(path, { query })
  return (data?.contents || []).map(toTopSql)
}

export interface SqlTextInfo {
  /** 完整 SQL（未截断） */
  fulltext: string
  /** 带原始字面量的语句（和 fulltext 通常一致） */
  statement: string
  sqlId: string
  sqlType: string
  dbName: string
  userName: string
  /** 该 SQL 涉及的表（OCP 解析出来的） */
  tables: string[]
  /** 是否支持绑定执行计划（outline） */
  supportOutline: boolean
}

/**
 * 取单条 SQL 的完整文本：GET /ob/clusters/{cid}/tenants/{tid}/sqls/{sqlId}/text
 * 必须带 startTime / endTime（OffsetDateTime），否则 OCP 返回 400。
 */
export async function ocpSqlText(
  client: OcpClient, clusterId: number, tenantId: number, sqlId: string, opts: { from: number; to: number }
): Promise<SqlTextInfo> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/sqls/${sqlId}/text`, {
    query: { startTime: isoOffset(opts.from), endTime: isoOffset(opts.to) }
  })
  const d = data?.data || {}
  return {
    fulltext: str(d.fulltext) || str(d.statement),
    statement: str(d.statement),
    sqlId: str(d.sqlId) || sqlId,
    sqlType: str(d.sqlType),
    dbName: str(d.dbName),
    userName: str(d.userName),
    tables: Array.isArray(d.tables) ? d.tables.map(str) : [],
    supportOutline: !!d.supportOutline
  }
}

/** 慢 SQL Top5（OCP 该端点固定返回少量最慢语句，字段与 TopSQL 同构） */
export async function ocpSlowSql(client: OcpClient, clusterId: number, tenantId: number, opts: { from: number; to: number }): Promise<TopSqlRow[]> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/${tenantId}/slowSql`, {
    query: { startTime: isoOffset(opts.from), endTime: isoOffset(opts.to) }
  })
  return (data?.contents || []).map(toTopSql)
}

export interface TenantSqlStat {
  tenantId: number
  tenantName: string
  newSqlCount: number
  slowSqlCount: number
  anomalySqlCount: number
  highRiskSqlCount: number
}

/** 集群内各租户的 SQL 概况（新 SQL / 慢 SQL / 异常 / 高风险计数）：tenantId 参数不生效，固定返回全租户 */
export async function ocpTenantSqlStats(client: OcpClient, clusterId: number, from: number, to: number): Promise<TenantSqlStat[]> {
  const data = await client.call<any>(`/api/v2/ob/clusters/${clusterId}/tenants/performance/sql/statistics`, {
    query: { startTime: isoOffset(from), endTime: isoOffset(to) }
  })
  return (data?.contents || []).map((o: any) => ({
    tenantId: num(o?.tenantId),
    tenantName: str(o?.tenantName),
    newSqlCount: num(o?.newSqlCount),
    slowSqlCount: num(o?.slowSqlCount),
    anomalySqlCount: num(o?.anomalySqlCount),
    highRiskSqlCount: num(o?.highRiskSqlCount)
  }))
}
