import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './types'
import { setPassword, getPassword, secretsAvailable } from './secrets'
import { writeFileAtomic } from './atomic'

const DEFAULT: AppConfig = {
  connections: [],
  providers: [],
  activeProviderId: null,
  mode: 'readonly',
  projects: [],
  skillsEnabled: {}
}

// API Key 不落明文盘：config.json 里置空，真实值经 DPAPI(safeStorage) 加密存 secrets.json
const providerKey = (id: string) => `provider:${id}`

export function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): AppConfig {
  let cfg: AppConfig
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    cfg = { ...DEFAULT, ...JSON.parse(raw) }
  } catch {
    cfg = { ...DEFAULT }
  }
  if (!Array.isArray(cfg.projects)) cfg.projects = []
  if (!cfg.skillsEnabled || typeof cfg.skillsEnabled !== 'object') cfg.skillsEnabled = {}
  for (const p of cfg.providers) {
    if (!p.apiKey) p.apiKey = getPassword(providerKey(p.id))
  }
  return cfg
}

export function saveConfig(cfg: AppConfig): void {
  const encrypted = secretsAvailable()
  const onDisk: AppConfig = encrypted
    ? { ...cfg, providers: cfg.providers.map((p) => ({ ...p, apiKey: '' })) }
    : cfg
  writeFileAtomic(configPath(), JSON.stringify(onDisk, null, 2))
  if (encrypted) {
    for (const p of cfg.providers) {
      if (p.apiKey) setPassword(providerKey(p.id), p.apiKey)
    }
  }
}
