import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import extract from 'extract-zip'

// 技能 = 目录（SKILL.md 指令文件 + 可选附属资源），存 userData/skills/<id>/。
// 启用的技能名称+描述注入系统提示词，模型按需通过 read_skill 工具读取 SKILL.md 全文，
// SKILL.md 引用的资源文件（如 db/admin/backup-recovery.md）用 read_skill 的 path 参数读取。

export interface SkillMeta {
  id: string
  name: string
  description: string
  /** 技能目录内文件总数（含 SKILL.md；>1 说明是带资源的技能包） */
  files?: number
}

export interface SkillPackResult {
  imported: SkillMeta[]
  updated: SkillMeta[]
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

function countFiles(dir: string): number {
  let n = 0
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      const st = fs.lstatSync(full)
      if (st.isDirectory()) visit(full)
      else if (st.isFile()) n++
    }
  }
  visit(dir)
  return n
}

export function listSkills(): SkillMeta[] {
  try {
    const out: SkillMeta[] = []
    for (const entry of fs.readdirSync(skillsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const dir = skillDir(entry.name)
        const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
        const fm = parseFrontmatter(raw)
        out.push({ id: entry.name, name: fm.name || entry.name, description: fm.description || '', files: countFiles(dir) })
      } catch { /* 跳过坏目录 */ }
    }
    return out
  } catch {
    return []
  }
}

/** 资源文件白名单：技能包里的文本类参考文件才能被 read_skill 读取（防误读二进制） */
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.sql', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.js', '.mjs', '.ts', '.py', '.sh', '.bat', '.ps1', '.conf', '.ini', '.cfg', '.csv', '.log', '.toml', '.rst', '.properties', '.env'])
const MAX_RESOURCE_BYTES = 512 * 1024

/** 技能内相对路径解析：防穿越 + 文本类型限制，返回绝对路径 */
function resolveSkillResource(dir: string, rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm || norm.startsWith('/') || norm.startsWith('..') || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`非法的资源路径: ${rel}`)
  }
  const full = path.resolve(dir, ...norm.split('/'))
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`资源路径越出技能目录: ${rel}`)
  }
  if (!TEXT_EXTS.has(path.extname(full).toLowerCase())) {
    throw new Error(`不支持的资源类型: ${path.extname(full) || '(无扩展名)'}（仅文本类文件）`)
  }
  const st = fs.statSync(full)
  if (st.size > MAX_RESOURCE_BYTES) throw new Error(`资源文件过大（${Math.round(st.size / 1024)} KB，上限 512 KB）`)
  return full
}

export function readSkill(idOrName: string, relPath?: string): { id: string; path: string; content: string } {
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
  const dir = skillDir(target.id)
  if (!relPath) {
    return { id: target.id, path: 'SKILL.md', content: fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8') }
  }
  const rel = String(relPath)
  // 防呆：SKILL.md 里引用常带技能名前缀（如 db/admin/x.md），未命中时剥掉首段按 admin/x.md 重试
  const tryRead = (r: string): string | null => {
    try {
      const full = resolveSkillResource(dir, r)
      return fs.readFileSync(full, 'utf8')
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null
      throw e
    }
  }
  const direct = tryRead(rel)
  if (direct !== null) return { id: target.id, path: rel, content: direct }
  const stripped = rel.split('/').slice(1).join('/')
  if (stripped) {
    const alt = tryRead(stripped)
    if (alt !== null) return { id: target.id, path: stripped, content: alt }
  }
  const sample = fs.readdirSync(dir).slice(0, 15).join(', ')
  throw new Error(`技能 "${target.name}" 内未找到资源 "${rel}"。技能根目录内容: ${sample}…`)
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
  return { id: safeId, name: n, description: d, files: 1 }
}

export function deleteSkill(id: string): void {
  fs.rmSync(skillDir(id), { recursive: true, force: true })
}

/** 从用户选择的 .md 文件或技能目录导入（单技能，旧入口） */
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

// ---------- 技能包导入（zip / 目录，可含多个技能与附属资源） ----------

const PACK_MAX_FILES = 5000
const PACK_MAX_BYTES = 200 * 1024 * 1024

/** 技能名 → 安全目录 ID（小写、非法字符转连字符） */
function slugify(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return s || `skill_${Date.now()}`
}

/** 找出技能根（含 SKILL.md 的目录）：根目录本身就是技能时返回它，否则深度优先收集所有技能目录 */
function findSkillRoots(root: string): string[] {
  if (fs.existsSync(path.join(root, 'SKILL.md'))) return [root]
  const out: string[] = []
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const sub = path.join(dir, e.name)
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) out.push(sub)
      else visit(sub)
    }
  }
  visit(root)
  return out
}

/** 拷贝技能目录：跳过符号链接（zip 内可能藏 symlink 指向外部），限制文件数与总大小 */
function copySkillDir(src: string, dest: string): number {
  let count = 0
  let bytes = 0
  fs.mkdirSync(dest, { recursive: true })
  const visit = (s: string, d: string) => {
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const ss = path.join(s, e.name)
      const dd = path.join(d, e.name)
      const st = fs.lstatSync(ss)
      if (st.isDirectory()) visit(ss, dd)
      else if (st.isFile()) {
        if (++count > PACK_MAX_FILES) throw new Error(`技能包文件数超限（${PACK_MAX_FILES}）`)
        bytes += st.size
        if (bytes > PACK_MAX_BYTES) throw new Error(`技能包总大小超限（200 MB）`)
        fs.mkdirSync(path.dirname(dd), { recursive: true })
        fs.copyFileSync(ss, dd)
      }
      // 符号链接等其他类型直接跳过，不拷出技能目录
    }
  }
  visit(src, dest)
  return count
}

/**
 * 导入技能包：zip 文件或本地目录。
 * 自动识别包内所有含 SKILL.md 的技能目录（如 oracle-skills 的 apex/db/fusion/graal/oci），
 * 整目录拷入技能库（保留附属资源）。同名技能视为更新（沿用原 ID，保留启用开关）。
 */
export async function importSkillPack(srcPath: string): Promise<SkillPackResult> {
  const stat = fs.statSync(srcPath)
  let root = srcPath
  let tmpDir: string | null = null
  if (stat.isFile()) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlpilot-skill-'))
    await extract(srcPath, { dir: tmpDir })
    root = tmpDir
  }
  try {
    const roots = findSkillRoots(root)
    if (!roots.length) {
      throw new Error('未在包中找到任何技能（需有含 SKILL.md 的目录；GitHub 仓库通常为 <仓库主目录>/<技能名>/SKILL.md）')
    }
    const existing = listSkills()
    const result: SkillPackResult = { imported: [], updated: [] }
    for (const skillRoot of roots) {
      const raw = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')
      const fm = parseFrontmatter(raw)
      const name = oneLine(fm.name) || path.basename(skillRoot)
      const old = existing.find((s) => s.name === name)
      let id: string
      if (old) {
        // 同名更新：沿用原 ID（启用开关保留），目录重建
        deleteSkill(old.id)
        id = old.id
      } else {
        id = slugify(name)
        let n = 2
        while (fs.existsSync(skillDir(id))) id = `${slugify(name)}-${n++}`
      }
      const files = copySkillDir(skillRoot, skillDir(id))
      const meta: SkillMeta = { id, name, description: oneLine(fm.description) || '导入的技能', files }
      ;(old ? result.updated : result.imported).push(meta)
    }
    return result
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------- 从 URL 下载技能包 ----------

const DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024

/** URL 归一化：GitHub 仓库页/归档链接 → codeload zip 直链；其余 zip 直链原样返回 */
export function normalizeSkillUrl(raw: string): { url: string; fallbackUrl?: string } {
  const u = new URL(raw.trim())
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('仅支持 http/https 链接')
  }
  const gh = u.hostname.replace(/^www\./, '')
  if (gh === 'github.com') {
    // https://github.com/<owner>/<repo>(/tree/<branch>) → codeload zip（默认 main，404 时回退 master）
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+))?\/?$/)
    if (m) {
      const branch = m[3] || 'main'
      const base = `https://codeload.github.com/${m[1]}/${m[2]}/zip/refs/heads/`
      return branch === 'main'
        ? { url: base + 'main', fallbackUrl: base + 'master' }
        : { url: base + branch }
    }
    // https://github.com/<owner>/<repo>/archive/refs/heads/main.zip → codeload 等价
    const am = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/archive\/(.+)\.zip\/?$/)
    if (am) {
      const ref = am[3].startsWith('refs/') ? am[3] : `refs/heads/${am[3]}`
      return { url: `https://codeload.github.com/${am[1]}/${am[2]}/zip/${ref}` }
    }
  }
  if (gh === 'gitlab.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/-\/tree\/([^/]+))?\/?$/)
    if (m) return { url: `https://gitlab.com/${m[1]}/${m[2]}/-/archive/${m[3] || 'main'}/${m[2]}-${m[3] || 'main'}.zip` }
  }
  return { url: u.toString() }
}

async function downloadZip(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180_000)
  let res: Response
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const err = new Error(`下载失败：HTTP ${res.status} ← ${url}`)
    ;(err as any).status = res.status
    throw err
  }
  const tmp = path.join(os.tmpdir(), `sqlpilot-skill-${Date.now()}.zip`)
  const out = fs.createWriteStream(tmp)
  let bytes = 0
  try {
    const reader = res.body!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > DOWNLOAD_MAX_BYTES) throw new Error('下载内容超过 200 MB 上限')
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()))
    }
    await new Promise<void>((r) => out.end(r))
  } catch (e) {
    out.destroy()
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return tmp
}

/** 从 URL 导入技能包：GitHub 仓库链接自动转 zip 下载，下载后走 importSkillPack */
export async function importSkillPackFromUrl(rawUrl: string): Promise<SkillPackResult> {
  if (!String(rawUrl || '').trim()) throw new Error('请填写技能包 URL')
  const { url, fallbackUrl } = normalizeSkillUrl(rawUrl)
  let tmp: string
  try {
    tmp = await downloadZip(url)
  } catch (e: any) {
    // GitHub 默认分支可能是 master：404 时自动重试
    if (e?.status === 404 && fallbackUrl) {
      tmp = await downloadZip(fallbackUrl)
    } else {
      throw e
    }
  }
  try {
    return await importSkillPack(tmp)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
