import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig, ProjectConfig } from './types'
import { setPassword, getPassword, secretsAvailable } from './secrets'
import { writeFileAtomic } from './atomic'

const DEFAULT: AppConfig = {
  connections: [],
  providers: [],
  activeProviderId: null,
  mode: 'readonly',
  projects: [],
  servers: [],
  skillsEnabled: {}
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
  } catch {
    cfg = { ...DEFAULT }
  }
  if (!Array.isArray(cfg.projects)) cfg.projects = []
  if (!Array.isArray(cfg.servers)) cfg.servers = []
  if (!cfg.skillsEnabled || typeof cfg.skillsEnabled !== 'object') cfg.skillsEnabled = {}
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
  const encrypted = secretsAvailable()
  const onDisk: AppConfig = encrypted
    ? { ...cfg, providers: cfg.providers.map((p) => ({ ...p, apiKey: '' })) }
    : cfg
  writeFileAtomic(configPath(), JSON.stringify(onDisk, null, 2))
  cachedConfig = cfg
  if (encrypted) {
    for (const p of cfg.providers) {
      if (p.apiKey) setPassword(providerKey(p.id), p.apiKey)
    }
  }
}
