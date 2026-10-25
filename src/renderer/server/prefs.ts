import { store } from '../store'
import type { SshServer as SshServerCfg, TermEncoding, TermPrefs, TermScheme } from '../../main/types'

/**
 * 终端外观偏好：全局默认值 + 单会话覆盖。
 *
 * 三层优先级：内置兜底 → 全局 termPrefs → 会话字段（scheme/fontSize/encoding）。
 * 会话层只允许覆盖"这台机器上确实会不同"的项：字号（高分屏）、配色（生产环境用红色警戒）、
 * 编码（GBK 老系统）。剪贴板行为、回滚行数这类习惯是人的偏好，不跟服务器走。
 */

export const FALLBACK_PREFS: TermPrefs = {
  fontSize: 13,
  fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
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

export function termPrefs(): TermPrefs {
  const p = (store.cfg?.termPrefs || {}) as Partial<TermPrefs>
  return { ...FALLBACK_PREFS, ...p }
}

/** 会话生效值：会话字段优先，未设则跟全局 */
export function effectivePrefs(server?: SshServerCfg | null): TermPrefs {
  const base = termPrefs()
  if (!server) return base
  return {
    ...base,
    scheme: (server.scheme as TermScheme) || base.scheme,
    fontSize: Number(server.fontSize) >= 8 ? Number(server.fontSize) : base.fontSize,
    encoding: (server.encoding as TermEncoding) || base.encoding
  }
}

/** 保存全局偏好（patch 合并后整份回存；主题等其它配置由主进程保持权威） */
export async function saveTermPrefs(patch: Partial<TermPrefs>): Promise<{ ok: boolean; error?: string }> {
  const cfg = await window.sqlpilot.getConfig()
  cfg.termPrefs = { ...termPrefs(), ...patch }
  const r = await window.sqlpilot.setConfig(cfg)
  if (r?.ok !== false) store.cfg = await window.sqlpilot.getConfig()
  return r || { ok: true }
}

/** 字体候选：都是等宽字体，最后兜底 generic monospace */
export const FONT_STACKS: { name: string; value: string }[] = [
  { name: 'Cascadia Code', value: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
  { name: 'JetBrains Mono', value: '"JetBrains Mono", Consolas, monospace' },
  { name: 'Consolas', value: 'Consolas, "Courier New", monospace' },
  { name: 'Sarasa / 更纱黑体', value: '"Sarasa Mono SC", "Sarasa Term SC", Consolas, monospace' },
  { name: '微软雅黑等宽', value: '"Microsoft YaHei Mono", "Microsoft YaHei", monospace' },
  { name: '系统等宽', value: 'monospace' }
]

export const ENCODINGS: { id: TermEncoding; name: string; hint: string }[] = [
  { id: 'utf-8', name: 'UTF-8', hint: '现代 Linux / 云主机默认' },
  { id: 'gbk', name: 'GBK', hint: '中文 Windows、老版 CentOS 常见' },
  { id: 'gb18030', name: 'GB18030', hint: 'GBK 超集，含生僻字' },
  { id: 'big5', name: 'BIG5', hint: '繁体中文系统' },
  { id: 'latin1', name: 'Latin-1', hint: '纯 ASCII 的老设备' }
]

export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24]

export function fmtBytes(n: number): string {
  const v = Number(n) || 0
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB'
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB'
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB'
  return v + ' B'
}

export function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
