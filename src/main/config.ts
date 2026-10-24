import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, ConnProfile, ProjectConfig, TermPrefs } from './types'
import { setPassword, getPassword, deletePassword, secretsAvailable } from './secrets'
import { writeFileAtomic } from './atomic'
import { defaultMaskingConfig, normalizeMaskingConfig } from './masking'

/** 终端外观默认值：与渲染层 server/prefs.ts 的兜底保持一致（配置缺项时两边都不会崩） */
export function defaultTermPrefs(): TermPrefs {
  return {
    fontSize: 13,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    lineHeight: 1.2,
    cursorStyle: 'block',
    cursorBlink: true,
    scheme: 'follow',
    scrollback: 5000,
    copyOnSelect: false,
    rightClickPaste: false,
    confirmMultilinePaste: true,
    encoding: 'utf-8'
  }
}

/** 缺失/非法字段逐个回填，避免旧配置里半套 termPrefs 让 xterm 拿到 undefined */
function normalizeTermPrefs(v: any): TermPrefs {
  const d = defaultTermPrefs()
  if (!v || typeof v !== 'object') return d
  const num = (x: any, min: number, max: number, fb: number) => {
    const n = Number(x)
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fb
  }
  return {
    fontSize: num(v.fontSize, 8, 32, d.fontSize),
    fontFamily: String(v.fontFamily || d.fontFamily),
    lineHeight: num(v.lineHeight, 1, 2, d.lineHeight),
    cursorStyle: ['block', 'bar', 'underline'].includes(v.cursorStyle) ? v.cursorStyle : d.cursorStyle,
    cursorBlink: typeof v.cursorBlink === 'boolean' ? v.cursorBlink : d.cursorBlink,
    scheme: ['follow', 'github', 'mobaxterm', 'solarized-light', 'monokai', 'dracula'].includes(v.scheme) ? v.scheme : d.scheme,
    scrollback: num(v.scrollback, 200, 200_000, d.scrollback),
    copyOnSelect: typeof v.copyOnSelect === 'boolean' ? v.copyOnSelect : d.copyOnSelect,
    rightClickPaste: typeof v.rightClickPaste === 'boolean' ? v.rightClickPaste : d.rightClickPaste,
    confirmMultilinePaste: typeof v.confirmMultilinePaste === 'boolean' ? v.confirmMultilinePaste : d.confirmMultilinePaste,
    encoding: ['utf-8', 'gbk', 'gb18030', 'big5', 'latin1'].includes(v.encoding) ? v.encoding : d.encoding
  }
}

const DEFAULT: AppConfig = {
  connections: [],
  providers: [],
  activeProviderId: null,
  mode: 'readonly',
  projects: [],
  servers: [],
  skillsEnabled: {},
  masking: defaultMaskingConfig(),
  cloudPlatforms: [],
  lockIdleMin: 3,
  termPrefs: defaultTermPrefs()
}

// API Key 不落明文盘：config.json 里置空，真实值经 DPAPI(safeStorage) 加密存 secrets.json
const providerKey = (id: string) => `provider:${id}`

export function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

/**
 * 内存缓存：loadConfig 是几乎每个 IPC handler 的热路径，此前每次同步读盘 +
 * 逐 provider DPAPI 解密。saveConfig 时同步刷新；调用方持有同一引用做
 * load→mutate→save 的惯用法不受影响（save 前缓存与磁盘可能短暂不一致，与原行为等价）。
 */
let cachedConfig: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig
  let cfg: AppConfig
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    cfg = { ...DEFAULT, ...JSON.parse(raw) }
  } catch (e: any) {
    // 只有"文件不存在"才是首次启动。JSON 损坏/权限错误一律先把原文件改名保留，
    // 否则用户看到连接全空、随手保存一次就把原配置永久覆盖。
    if (e?.code !== 'ENOENT') {
      try { fs.renameSync(configPath(), `${configPath()}.corrupt-${Date.now()}`) } catch { /* 文件不可读也无从保留 */ }
    }
    cfg = { ...DEFAULT }
  }
  if (!Array.isArray(cfg.projects)) cfg.projects = []
  if (!Array.isArray(cfg.servers)) cfg.servers = []
  if (!Array.isArray(cfg.connections)) cfg.connections = []
  if (!Array.isArray(cfg.providers)) cfg.providers = []
  if (!Array.isArray(cfg.cloudPlatforms)) cfg.cloudPlatforms = []
  if (!cfg.skillsEnabled || typeof cfg.skillsEnabled !== 'object') cfg.skillsEnabled = {}
  cfg.masking = normalizeMaskingConfig(cfg.masking)
  cfg.termPrefs = normalizeTermPrefs(cfg.termPrefs)
  // 一次性迁移：旧版服务器内联在项目里 → 折叠进全局注册表，项目改为 serverIds 引用。
  // 密码键本来就是全局的 server:<id>，迁移后原密码直接生效；迁移幂等，落盘一次后此分支不再进
  if (cfg.projects.some((p) => Array.isArray(p.servers) && p.servers.length)) {
    for (const p of cfg.projects) {
      for (const s of p.servers || []) {
        if (!cfg.servers.some((g) => g.id === s.id)) cfg.servers.push(s)
      }
      p.serverIds = (p.servers || []).map((s) => s.id)
      delete p.servers
    }
    saveConfig(cfg)
  }
  for (const p of cfg.providers) {
    if (!p.apiKey) p.apiKey = getPassword(providerKey(p.id))
  }
  cachedConfig = cfg
  return cfg
}

/**
 * 会话可见连接：本项目关联的 + 未关联任何项目的全局连接。
 * 与 projectServers 对称——"关联到项目"即授权边界，其他项目独占关联的连接对本会话的
 * AI 不可见（工具解析与系统提示词双收口）。人工工作台（对象树/查询窗口）不受此限：
 * 那是用户显式选择连接，不属于 AI 授权面。
 */
export function sessionConnections(cfg: AppConfig, project: ProjectConfig | undefined | null): ConnProfile[] {
  if (!project) return cfg.connections.filter((c) => !c.projectId)
  return cfg.connections.filter((c) => !c.projectId || c.projectId === project.id)
}

/** 项目的服务器解析：serverIds → 全局注册表；兜底兼容未迁移的内联定义（如外部手改配置） */
export function projectServers(cfg: AppConfig, project: ProjectConfig | undefined | null) {
  if (!project) return []
  if (Array.isArray(project.serverIds)) {
    const ids = new Set(project.serverIds)
    return cfg.servers.filter((s) => ids.has(s.id))
  }
  return project.servers || []
}

export function saveConfig(cfg: AppConfig): void {
  cfg.masking = normalizeMaskingConfig(cfg.masking)
  const encrypted = secretsAvailable()
  const hasKeys = cfg.providers.some((p) => !!p.apiKey)
  // 不允许静默降级为明文：加密不可用时拒绝保存密钥（连接/项目等非密钥配置仍可保存）
  if (!encrypted && hasKeys) {
    throw new Error('系统加密不可用（DPAPI/safeStorage），为避免 API Key 明文写入磁盘，本次保存已取消。请检查系统凭据服务后重试。')
  }
  // 先写 secrets 再写 config：config 里 apiKey 恒为空，密钥只存在于 DPAPI 密文中
  if (encrypted) {
    const keep = new Set(cfg.providers.map((p) => p.id))
    for (const p of cachedConfig?.providers || []) {
      if (!keep.has(p.id)) deletePassword(providerKey(p.id))
    }
    for (const p of cfg.providers) {
      // 用户把 Key 清空 → 同步删除旧密文，否则下次启动又被解密填回来
      if (p.apiKey) setPassword(providerKey(p.id), p.apiKey)
      else if (getPassword(providerKey(p.id))) deletePassword(providerKey(p.id))
    }
  }
  const onDisk: AppConfig = { ...cfg, providers: cfg.providers.map((p) => ({ ...p, apiKey: '' })) }
  writeFileAtomic(configPath(), JSON.stringify(onDisk, null, 2))
  cachedConfig = cfg
}
