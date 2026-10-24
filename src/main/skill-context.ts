/**
 * 技能正文注入（云管助手 / 编辑器助手用）
 *
 * 这两个通道故意不挂工具（不给 read_skill、不给 sql_query），
 * 所以技能不能用「目录 + 按需读取」那套，只能把 SKILL.md 正文直接拼进系统提示，
 * 当成「回答规范」约束模型；与主 AI 会话的技能机制互不影响。
 */

import { listSkills, readSkill } from './skills'

/** 单个技能正文上限：技能包常见 2-6KB，留一点余量 */
const MAX_ONE = 4200
/** 全部技能合计上限：再多就把数据快照挤掉了 */
const MAX_ALL = 9000
/** 一次最多带几个技能（避免勾一堆互相打架） */
const MAX_SKILLS = 4

export interface SkillText {
  id: string
  name: string
  description: string
  /** SKILL.md 原文（可带 frontmatter） */
  content: string
}

/** 去掉 frontmatter：名字与描述已经单独给了，正文里再出现一遍是噪音 */
export function stripFrontmatter(text: string): string {
  return String(text || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .trim()
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（技能内容过长，已截断）`
}

/** 把若干技能正文拼成系统提示里的一段（纯组装，便于单测） */
export function composeSkillBlock(items: SkillText[]): string {
  const parts: string[] = []
  let budget = MAX_ALL
  for (const it of items.slice(0, MAX_SKILLS)) {
    if (budget < 500) break
    const body = stripFrontmatter(it.content)
    if (!body) continue
    const text = clip(body, Math.min(MAX_ONE, budget))
    budget -= text.length
    const head = it.description ? `### ${it.name}：${it.description}` : `### ${it.name}`
    parts.push(`${head}\n${text}`)
  }
  if (!parts.length) return ''
  return [
    '## 参考技能（用户已启用）',
    '以下技能是本次回答**必须遵循的规范**：优先按它给的步骤、检查项、判断阈值与输出格式作答。',
    '技能里提到的具体对象（集群 / 租户 / 库 / 实例 / 表）以本次数据快照为准，快照里没有的不要假设。',
    '技能若引用了附属资源文件，你读不到那些文件；需要时请直接说明缺哪份资料，不要凭空补内容。',
    '',
    ...parts
  ].join('\n')
}

/**
 * 按 id 读取并组装。读不到的技能静默跳过（技能可能刚被删掉）。
 * 返回空串表示本次没有可用技能，调用方直接不拼这一段。
 */
export function skillBlockFor(ids: string[] | undefined | null): string {
  const wanted = [...new Set((ids || []).filter((x): x is string => typeof x === 'string' && !!x))].slice(0, MAX_SKILLS)
  if (!wanted.length) return ''
  const all = listSkills()
  const items: SkillText[] = []
  for (const id of wanted) {
    const meta = all.find((s) => s.id === id)
    try {
      const r = readSkill(id)
      items.push({ id, name: meta?.name || id, description: meta?.description || '', content: r.content })
    } catch {
      /* 技能不存在或文件坏了：跳过 */
    }
  }
  return composeSkillBlock(items)
}
