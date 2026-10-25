import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * ~/.ssh/config 解析（只读，不执行任何命令）。
 *
 * 目的：让用户从已有的 OpenSSH 配置一键导入会话，而不是逐台手填。只解析会话必需字段，
 * 其余（ProxyCommand / LocalForward / 各种算法选项）忽略——它们要么无法在 ssh2 里等价表达，
 * 要么会误导用户以为已生效。
 *
 * 通配符 Host（Host *、Host 10.0.*）不作为会话导入，但其中出现的默认值
 * （User/Port/IdentityFile）会作为后续具体主机的兜底，与 OpenSSH 行为一致。
 */

export interface SshConfigEntry {
  /** Host 后面的别名，作为会话名候选 */
  alias: string
  host: string
  user?: string
  port: number
  identityFile?: string
  proxyJump?: string
  /** 通配段提供的默认值来源说明（UI 提示用） */
  inherited?: string[]
}

export function sshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config')
}

interface Section {
  patterns: string[]
  opts: Record<string, string>
}

function isWildcard(p: string): boolean {
  return /[*?]/.test(p)
}

/** 展开 ~ 与 %d（OpenSSH 的 home 占位），其余保持原样 */
export function expandKeyPath(p: string): string {
  const raw = String(p || '').trim()
  if (!raw) return ''
  const home = os.homedir()
  let out = raw
  if (out.startsWith('~/') || out === '~') out = path.join(home, out.slice(1))
  out = out.replace(/%d/g, home).replace(/%h/g, '')
  return out
}

export function parseSshConfig(text: string): SshConfigEntry[] {
  const sections: Section[] = []
  let cur: Section | null = null

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // 支持 "Key Value" 与 "Key=Value" 两种写法
    const m = line.match(/^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (!val) continue
    if (key === 'host') {
      cur = { patterns: val.split(/\s+/).filter(Boolean), opts: {} }
      sections.push(cur)
      continue
    }
    if (!cur) continue
    // 多值项（IdentityFile 可出现多次）只取第一个，够用且不猜用户意图
    if (!(key in cur.opts)) cur.opts[key] = val
  }

  // 通配段作为默认值池：后出现的覆盖先出现的（OpenSSH 是"首次匹配生效"，
  // 但对默认值兜底而言后者覆盖前者更符合直觉，且只在缺失字段上生效）
  const defaults: Record<string, string> = {}
  for (const s of sections) {
    if (s.patterns.some(isWildcard)) Object.assign(defaults, s.opts)
  }

  const out: SshConfigEntry[] = []
  const seen = new Set<string>()
  for (const s of sections) {
    const concrete = s.patterns.filter((p) => !isWildcard(p))
    if (!concrete.length) continue
    const opt = { ...defaults, ...s.opts }
    const inherited = Object.keys(s.opts)
    for (const alias of concrete) {
      if (seen.has(alias)) continue
      seen.add(alias)
      out.push({
        alias,
        host: opt.hostname || alias,
        user: opt.user || undefined,
        port: Number(opt.port) || 22,
        identityFile: opt.identityfile ? expandKeyPath(opt.identityfile) : undefined,
        proxyJump: opt.proxyjump && opt.proxyjump !== 'none' ? opt.proxyjump : undefined,
        inherited
      })
    }
  }
  return out
}

/** 读取并解析本机 ~/.ssh/config；文件不存在返回空数组 */
export function readSshConfig(): { path: string; entries: SshConfigEntry[]; error?: string } {
  const p = sshConfigPath()
  try {
    const text = fs.readFileSync(p, 'utf8')
    return { path: p, entries: parseSshConfig(text) }
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { path: p, entries: [] }
    return { path: p, entries: [], error: `读取 ${p} 失败：${e?.message || e}` }
  }
}
