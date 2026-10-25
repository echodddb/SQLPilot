import type { SshServer } from '../../main/types'

/**
 * 会话标识色。
 *
 * 和「终端配色方案」是两回事：配色方案改的是终端里的文字/背景（Monokai、Solarized…），
 * 标识色只用来在标签栏和会话列表上做一眼区分（生产红、测试黄、开发绿…）。
 * 两者不合并的原因：生产机器也可能想用浅色主题，但标识色必须是红的。
 *
 * 颜色值直接存 hex（`server.color`），存 id 的话改色板会让老配置失配。
 */

export interface ColorSwatch {
  value: string
  name: string
}

export const SERVER_COLORS: ColorSwatch[] = [
  { value: '#f85149', name: '红 · 生产' },
  { value: '#f0883e', name: '橙' },
  { value: '#d29922', name: '黄 · 测试' },
  { value: '#3fb950', name: '绿 · 开发' },
  { value: '#39c5cf', name: '青' },
  { value: '#1f6feb', name: '蓝' },
  { value: '#a371f7', name: '紫' },
  { value: '#db61a2', name: '粉' },
  { value: '#8b949e', name: '灰' }
]

/** 标签默认映射：没显式设颜色时按 tag 自动上色，符合"DBA 一眼认出生产"的习惯 */
const TAG_FALLBACK: Record<string, string> = {
  生产: '#f85149',
  测试: '#d29922',
  开发: '#3fb950'
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v.trim())
}

/** 会话生效的标识色；未设置且没有 tag 时返回空串（不画色条，保持界面安静） */
export function colorOf(server?: Pick<SshServer, 'color' | 'tag'> | null): string {
  if (!server) return ''
  if (isHexColor(server.color)) return server.color.trim()
  const tag = (server.tag || '').trim()
  return TAG_FALLBACK[tag] || ''
}

/** 用于标签 hover 提示：颜色来源（手选 / 按标签推断） */
export function colorSource(server?: Pick<SshServer, 'color' | 'tag'> | null): string {
  if (!server) return ''
  if (isHexColor(server.color)) return '自定义'
  const tag = (server.tag || '').trim()
  return TAG_FALLBACK[tag] ? `按标签「${tag}」` : ''
}
