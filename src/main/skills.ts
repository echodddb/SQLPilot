import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// 技能 = Markdown 指令文件（带 frontmatter 的名称/描述），存 userData/skills/<id>/SKILL.md。
// 启用的技能名称+描述注入系统提示词，模型按需通过 read_skill 工具读取全文。

export interface SkillMeta {
  id: string
  name: string
  description: string
}

export function skillsDir(): string {
  return path.join(app.getPath('userData'), 'skills')
}

function skillDir(id: string): string {
  // 防路径穿越：ID 只允许字母/数字/下划线/连字符
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`非法的技能标识: ${id}`)
  }
  return path.join(skillsDir(), id)
}

function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  let name = ''
  let description = ''
  let body = text
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m) {
    body = m[2]
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+)\s*:\s*(.*)$/)
      if (!kv) continue
      if (kv[1] === 'name') name = kv[2].trim()
      else if (kv[1] === 'description') description = kv[2].trim()
    }
  }
  return { name, description, body }
}

export function listSkills(): SkillMeta[] {
  try {
    const out: SkillMeta[] = []
    for (const entry of fs.readdirSync(skillsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(skillDir(entry.name), 'SKILL.md')
      try {
        const raw = fs.readFileSync(file, 'utf8')
        const fm = parseFrontmatter(raw)
        out.push({ id: entry.name, name: fm.name || entry.name, description: fm.description || '' })
      } catch { /* 跳过坏目录 */ }
    }
    return out
  } catch {
    return []
  }
}

export function readSkill(idOrName: string): { id: string; content: string } {
  const all = listSkills()
  let target = all.find((s) => s.id === idOrName)
  if (!target) {
    const matches = all.filter((s) => s.name === idOrName)
    if (matches.length > 1) {
      throw new Error(`技能名 "${idOrName}" 不唯一（${matches.length} 个同名技能），请先重命名`)
    }
    target = matches[0]
  }
  if (!target) {
    throw new Error(`技能 "${idOrName}" 不存在。可用技能: ${all.map((s) => s.name).join(', ') || '(无)'}`)
  }
  const content = fs.readFileSync(path.join(skillDir(target.id), 'SKILL.md'), 'utf8')
  return { id: target.id, content }
}

/** frontmatter 单行化：名称/描述里的换行会逃逸出元数据区混进正文 */
const oneLine = (s: string) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim()

export function saveSkill(id: string, name: string, description: string, content: string): SkillMeta {
  const safeId = id || `skill_${Date.now()}`
  const dir = skillDir(safeId)
  const n = oneLine(name)
  const d = oneLine(description)
  fs.mkdirSync(dir, { recursive: true })
  const fm = `---\nname: ${n}\ndescription: ${d}\n---\n\n${content.trim()}\n`
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm, 'utf8')
  return { id: safeId, name: n, description: d }
}

export function deleteSkill(id: string): void {
  fs.rmSync(skillDir(id), { recursive: true, force: true })
}

/** 从用户选择的 .md 文件或技能目录导入 */
export function importSkill(srcPath: string): SkillMeta {
  const stat = fs.statSync(srcPath)
  let raw = ''
  if (stat.isDirectory()) {
    raw = fs.readFileSync(path.join(srcPath, 'SKILL.md'), 'utf8')
  } else {
    raw = fs.readFileSync(srcPath, 'utf8')
  }
  const fm = parseFrontmatter(raw)
  const id = `skill_${Date.now()}`
  const name = fm.name || path.basename(srcPath, '.md')
  return saveSkill(id, name, fm.description || '导入的技能', fm.body || raw)
}
