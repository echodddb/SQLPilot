import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import type { ConnProfile, PermissionMode, SshServer } from '../types'
import { resolveConnection, getAdapter } from '../db/manager'
import { classifySql } from '../db/guard'
import { appendAudit } from '../audit'
import { cached, metaDropConn, metaKeys } from '../meta'
import { readSkill } from '../skills'
import { appendMemory } from '../memory'
import * as ssh from '../ssh'

export interface ToolDef {
  name: string
  description: string
  parameters: any
}

export interface ApprovalRequest {
  tool: string
  conn: string
  sql: string
  kind: string
  risk: number
}

export type ApprovalDecision = 'once' | 'session' | 'deny'

export interface ToolContext {
  connections: ConnProfile[]
  globalClientDir?: string
  mode: PermissionMode
  sessionApproved: Set<string>
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalDecision>
  /** 当前会话绑定的项目（未绑定为 undefined，fs 工具不可用） */
  project?: { id: string; name: string; rootPath: string }
  /** 项目挂载的 SSH 服务器（server_* 工具用） */
  servers?: SshServer[]
}

const MAX_ROWS = 500
const QUERY_TIMEOUT_MS = 60_000
/** 返回给模型/界面的行数预览上限，防止撑爆上下文 */
const PREVIEW_ROWS = 30

export const TOOLS: ToolDef[] = [
  {
    name: 'db_list_schemas',
    description: '列出指定数据库连接下可见的 schema/数据库名列表',
    parameters: {
      type: 'object',
      properties: { conn: { type: 'string', description: '连接名称' } },
      required: ['conn']
    }
  },
  {
    name: 'db_list_tables',
    description: '列出指定 schema 下的表和视图。写 SQL 前不确定表名/找不到表时先用它定位，禁止凭猜测或记忆拼表名。',
    parameters: {
      type: 'object',
      properties: {
        conn: { type: 'string', description: '连接名称' },
        schema: { type: 'string', description: 'schema/数据库名' }
      },
      required: ['conn', 'schema']
    }
  },
  {
    name: 'db_describe_table',
    description: '查看表结构：列名、类型、是否可空，以及近似行数。写 SQL 涉及某张表前先调用它确认列名与类型，禁止凭猜测写列名；结果有缓存，重复调用代价很小。',
    parameters: {
      type: 'object',
      properties: {
        conn: { type: 'string', description: '连接名称' },
        schema: { type: 'string', description: 'schema/数据库名' },
        table: { type: 'string', description: '表名' }
      },
      required: ['conn', 'schema', 'table']
    }
  },
  {
    name: 'db_get_ddl',
    description: '获取表/视图的建表 DDL 语句。需要精确列定义、约束、索引、分区信息时用它，比 describe_table 更完整；改表结构前列出当前 DDL 作为依据。',
    parameters: {
      type: 'object',
      properties: {
        conn: { type: 'string', description: '连接名称' },
        schema: { type: 'string', description: 'schema/数据库名' },
        table: { type: 'string', description: '表名' }
      },
      required: ['conn', 'schema', 'table']
    }
  },
  {
    name: 'db_query',
    description: '执行只读 SQL 查询（SELECT/EXPLAIN/SHOW 等，最多返回 500 行）。写操作会被拦截，请改用 db_write。',
    parameters: {
      type: 'object',
      properties: {
        conn: { type: 'string', description: '连接名称' },
        sql: { type: 'string', description: '单条只读 SQL' }
      },
      required: ['conn', 'sql']
    }
  },
  {
    name: 'db_write',
    description: '执行写操作（INSERT/UPDATE/DELETE/DDL 等），需要用户批准（计划/只读模式下不可用）。Oracle 下成功后会自动 COMMIT。',
    parameters: {
      type: 'object',
      properties: {
        conn: { type: 'string', description: '连接名称' },
        sql: { type: 'string', description: '单条写 SQL' }
      },
      required: ['conn', 'sql']
    }
  },
  {
    name: 'fs_list',
    description: '列出当前会话绑定项目根目录下的文件（递归两层，最多 300 项）。需要会话绑定了项目。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'fs_read',
    description: '读取项目内文件内容（路径相对项目根目录，禁止越界）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对项目根的路径' } },
      required: ['path']
    }
  },
  {
    name: 'fs_write',
    description: '写入项目内文件（新建或覆盖，需要用户批准；计划/只读模式下不可用）。适合生成报告、SQL 脚本等产出物。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径' },
        content: { type: 'string', description: '文件全文内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'read_skill',
    description: '读取技能的指令内容。当任务匹配某技能描述时，先读取其 SKILL.md 再严格遵循执行。技能可能附带资源文件（SKILL.md 中引用的相对路径，如 admin/backup-recovery.md）：需要时用 path 参数读取，路径相对技能根目录（引用中的技能名前缀可省略），仅支持文本类文件。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称' },
        path: { type: 'string', description: '技能内资源文件的相对路径（省略 = 读 SKILL.md 本身）' }
      },
      required: ['name']
    }
  },
  {
    name: 'memory_append',
    description: '追加一条跨会话记忆，避免后续会话重复探索。三个归属维度：全局（默认，跨项目通用事实）、某个数据库连接（conn 参数，该库的环境/规模/约定）、当前项目（project=true，仅本会话绑定项目可见的专属事实）。计划模式不可用；无需批准。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的一条事实（一句话写全上下文，如"cesdb 为生产库，XX 表约 2 亿行，禁全表扫描"）' },
        conn: { type: 'string', description: '连接名称（归属该连接的记忆）；与 project 互斥' },
        project: { type: 'boolean', description: 'true = 归属当前会话绑定的项目（项目专属事实，如"本项目的变更都先在测试连接验证"）；与 conn 互斥' }
      },
      required: ['text']
    }
  },
  {
    name: 'run_command',
    description: '在本机执行系统命令（cmd），可用于运行脚本、安装软件（winget/choco）、查看系统状态等。计划/只读模式不可用；确认/会话模式下每条命令需用户批准；工作目录为当前项目根（未绑定项目时为用户目录）。输出（stdout/stderr，最多 8000 字符）与退出码会返回。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（单条）' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 120000，最大 600000' }
      },
      required: ['command']
    }
  },
  {
    name: 'fs_delete',
    description: '删除项目内的文件或目录（目录递归删除），需要用户批准；计划/只读模式不可用。仅限项目根目录内。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对项目根的路径' } },
      required: ['path']
    }
  },
  {
    name: 'open_url',
    description: '用系统默认浏览器打开一个网页（仅 http/https）。任何权限模式下可用。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http/https 网址' } },
      required: ['url']
    }
  },
  {
    name: 'enter_plan_mode',
    description: '进入计划模式（只读探索 + 制定执行计划，等待用户批准）。当任务涉及写操作、DDL 变更、多步骤执行或影响面较大时，即使当前模式允许写操作，也应先调用本工具规划。简单只读查询无需调用。',
    parameters: {
      type: 'object',
      properties: { goal: { type: 'string', description: '一句话说明本次要规划的目标' } },
      required: []
    }
  },
  {
    name: 'exit_plan_mode',
    description: '提交执行计划并请求用户批准（仅在计划模式下可用）。调用后应输出最终计划总结并结束本回合，等待用户批准。',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: '计划要点摘要' } },
      required: ['summary']
    }
  },
  {
    name: 'server_list',
    description: '列出当前会话所属项目挂载的 SSH 远程服务器（含标签与注意事项）。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'server_run',
    description: '在项目挂载的远程服务器上执行 shell 命令（查磁盘/进程/日志、重启服务等）。计划/只读模式不可用；确认与会话模式下每条命令需用户批准。返回 stdout/stderr 与退出码。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名称' },
        command: { type: 'string', description: '要执行的 shell 命令（单条）' },
        timeoutMs: { type: 'number', description: '超时毫秒数，默认 60000，最大 300000' }
      },
      required: ['server', 'command']
    }
  },
  {
    name: 'server_read_file',
    description: '读取远程服务器上的文件内容（路径为服务器绝对路径，限 2MB）。只读模式可用。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名称' },
        path: { type: 'string', description: '远程绝对路径' }
      },
      required: ['server', 'path']
    }
  },
  {
    name: 'server_tail',
    description: '查看远程文件末尾 N 行（默认 200，常用于日志排查）。只读模式可用。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名称' },
        path: { type: 'string', description: '远程文件绝对路径' },
        lines: { type: 'number', description: '行数，默认 200，最大 2000' }
      },
      required: ['server', 'path']
    }
  },
  {
    name: 'server_write_file',
    description: '写入远程服务器文件（新建或覆盖，需用户批准；计划/只读模式不可用）。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名称' },
        path: { type: 'string', description: '远程绝对路径' },
        content: { type: 'string', description: '文件全文内容' }
      },
      required: ['server', 'path', 'content']
    }
  },
  {
    name: 'server_get_file',
    description: '把远程服务器上的文件下载到当前项目目录内（只读操作）。返回保存后的项目相对路径。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务器名称' },
        remotePath: { type: 'string', description: '远程绝对路径' },
        localPath: { type: 'string', description: '项目内相对路径' }
      },
      required: ['server', 'remotePath', 'localPath']
    }
  }
]

function fmtQueryResult(r: { columns: string[]; rows: any[][]; rowCount: number; ms: number; truncated?: boolean }): any {
  const preview = r.rows.slice(0, PREVIEW_ROWS).map((row) => row.map((v) => (v === null ? null : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : typeof v === 'object' ? JSON.stringify(v) : v)))
  return {
    columns: r.columns,
    rows: preview,
    rowCount: r.rowCount,
    returned: r.rows.length,
    truncated: !!r.truncated || r.rows.length > PREVIEW_ROWS,
    ms: r.ms
  }
}

/** 项目内路径安全解析：禁止越出项目根 */
function safeProjectPath(root: string, rel: string): string {
  const p = path.resolve(root, String(rel || '').trim())
  if (p !== root && !p.startsWith(root + path.sep)) {
    throw new Error(`路径越界（只能访问项目目录内）: ${rel}`)
  }
  return p
}

/** 会话级放行键：工具+操作类别+目标 各自独立——批准"写文件"不等于批准"删文件"，批准 DML 不等于批准 DDL */
function approvalKey(req: ApprovalRequest): string {
  return `${req.tool}:${req.kind}:${req.conn}`
}

/** 写操作统一门控：计划/只读拒绝；确认/会话/放开按级别放行 */
async function gateWrite(
  ctx: ToolContext,
  req: ApprovalRequest,
  auditConn: string,
  detail: string
): Promise<string | null> {
  if (ctx.mode === 'plan' || ctx.mode === 'readonly') {
    const where = ctx.mode === 'plan' ? '计划模式（请先输出计划并获得用户批准）' : '只读模式'
    appendAudit({ kind: 'sql.write', conn: auditConn, detail: detail.slice(0, 500), mode: ctx.mode, approved: false, error: `${where}拒绝` })
    return JSON.stringify({ error: `当前为${where}，写操作被拒绝。` })
  }
  const decision = await requestApprovalIfNeeded(ctx, req)
  if (decision === 'denied') {
    appendAudit({ kind: 'sql.write', conn: auditConn, detail: detail.slice(0, 500), mode: ctx.mode, approved: false, error: '用户拒绝' })
    return JSON.stringify({ error: '用户拒绝了该操作' })
  }
  if (decision === 'session') ctx.sessionApproved.add(approvalKey(req))
  appendAudit({ kind: 'sql.write', conn: auditConn, detail: detail.slice(0, 500), mode: ctx.mode, approved: true })
  return null
}

function requestApprovalIfNeeded(ctx: ToolContext, req: ApprovalRequest): Promise<'approved' | 'denied' | 'session'> {
  // session 模式：同类写操作（同工具+同类别+同目标）首次确认后本会话放行；高危(risk3)每次都确认。yolo 全放行。
  const confirm = ctx.mode === 'yolo' ? false : ctx.mode === 'confirm' ? true : req.risk >= 3 ? true : !ctx.sessionApproved.has(approvalKey(req))
  if (!confirm) return Promise.resolve('approved')
  return ctx.requestApproval(req).then((d) => (d === 'deny' ? 'denied' : d === 'session' ? 'session' : 'approved'))
}

export async function executeTool(name: string, argsJson: string, ctx: ToolContext): Promise<{ ok: boolean; result: string }> {
  let args: any = {}
  try {
    args = JSON.parse(argsJson || '{}')
  } catch {
    return { ok: false, result: JSON.stringify({ error: `工具参数不是合法 JSON: ${argsJson.slice(0, 200)}` }) }
  }

  try {
    // ---------- 会话规划控制（由 agent loop 拦截处理，不落到这里） ----------
    if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
      return { ok: false, result: JSON.stringify({ error: '该工具由会话调度层处理，此处不应到达' }) }
    }

    // ---------- 项目文件工具 ----------
    if (name === 'fs_list' || name === 'fs_read' || name === 'fs_write') {
      if (!ctx.project) {
        return { ok: false, result: JSON.stringify({ error: '当前会话未绑定项目，文件工具不可用。请让用户先在左侧创建/绑定项目。' }) }
      }
      if (name === 'fs_list') {
        const root = ctx.project.rootPath
        const entries: { path: string; type: string; size?: number }[] = []
        const walk = (dir: string, depth: number) => {
          if (entries.length >= 300 || depth > 2) return
          let items: fs.Dirent[]
          try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const it of items) {
            if (it.name.startsWith('.') || it.name === 'node_modules') continue
            const rel = path.relative(root, path.join(dir, it.name)).replace(/\\/g, '/')
            if (it.isDirectory()) {
              entries.push({ path: rel, type: 'dir' })
              walk(path.join(dir, it.name), depth + 1)
            } else {
              let size: number | undefined
              try { size = fs.statSync(path.join(dir, it.name)).size } catch { /* 忽略 */ }
              entries.push({ path: rel, type: 'file', size })
            }
            if (entries.length >= 300) return
          }
        }
        walk(root, 0)
        appendAudit({ kind: 'tool', conn: ctx.project.name, detail: `fs_list → ${entries.length} 项` })
        return { ok: true, result: JSON.stringify({ project: ctx.project.name, entries }) }
      }
      if (name === 'fs_read') {
        const p = safeProjectPath(ctx.project.rootPath, args.path)
        const stat = fs.statSync(p)
        if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，拒绝读取')
        const content = fs.readFileSync(p, 'utf8')
        appendAudit({ kind: 'tool', conn: ctx.project.name, detail: `fs_read ${args.path}` })
        return { ok: true, result: JSON.stringify({ path: String(args.path), size: stat.size, content: content.slice(0, 20000) }) }
      }
      if (name === 'fs_write') {
        const rel = String(args.path ?? '')
        const content = String(args.content ?? '')
        const p = safeProjectPath(ctx.project.rootPath, rel)
        const gated = await gateWrite(ctx, {
          tool: 'fs_write',
          conn: ctx.project.name,
          sql: `${rel}\n\n（内容 ${content.length} 字符，预览）\n${content.slice(0, 300)}`,
          kind: 'file',
          risk: 2
        }, ctx.project.name, `fs_write ${rel} (${content.length} 字符)`)
        if (gated) return { ok: false, result: gated }
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, content, 'utf8')
        return { ok: true, result: JSON.stringify({ path: rel, written: content.length }) }
      }
    }

    // ---------- 技能 ----------
    if (name === 'read_skill') {
      const rel = args.path ? String(args.path) : undefined
      const s = readSkill(String(args.name ?? ''), rel)
      appendAudit({ kind: 'tool', detail: `read_skill ${s.id}${rel ? ` :: ${s.path}` : ''}` })
      return { ok: true, result: JSON.stringify({ skill: s.id, path: s.path, content: s.content.slice(0, 30000) }) }
    }

    // ---------- 跨会话记忆 ----------
    if (name === 'memory_append') {
      if (ctx.mode === 'plan') {
        return { ok: false, result: JSON.stringify({ error: '计划模式为只读探索，memory_append 被拒绝。' }) }
      }
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, result: JSON.stringify({ error: 'text 不能为空' }) }
      const conn = args.conn ? String(args.conn) : null
      if (conn && args.project) {
        return { ok: false, result: JSON.stringify({ error: 'conn 与 project 不能同时指定：涉及具体数据库的事实记到连接，项目专属事实用 project。' }) }
      }
      // 归属校验并统一按名称寻址（记忆文件以名称命名，注入提示词时也按名称读取）
      if (args.project) {
        if (!ctx.project) {
          return { ok: false, result: JSON.stringify({ error: '当前会话未绑定项目，无法记录项目记忆；省略 project 参数可记入全局记忆。' }) }
        }
        const r = appendMemory({ kind: 'project', name: ctx.project.name }, text)
        appendAudit({ kind: 'tool', conn: `项目 ${ctx.project.name}`, detail: `memory_append: ${text.slice(0, 200)}` })
        return { ok: true, result: JSON.stringify({ saved: true, scope: `项目 ${ctx.project.name}`, file: r.file, totalEntries: r.entries }) }
      }
      const target = conn ? ctx.connections.find((c) => c.name === conn || c.id === conn) : null
      if (conn && !target) {
        return { ok: false, result: JSON.stringify({ error: `连接 "${conn}" 不存在`, available: ctx.connections.map((c) => c.name) }) }
      }
      const r = appendMemory(target ? { kind: 'conn', name: target.name } : { kind: 'global' }, text)
      appendAudit({ kind: 'tool', conn: target?.name || '全局', detail: `memory_append: ${text.slice(0, 200)}` })
      return { ok: true, result: JSON.stringify({ saved: true, scope: target ? `连接 ${target.name}` : '全局', file: r.file, totalEntries: r.entries }) }
    }

    // ---------- 本机控制 ----------
    if (name === 'run_command') {
      const command = String(args.command ?? '').trim()
      if (!command) return { ok: false, result: JSON.stringify({ error: '空命令' }) }
      if (ctx.mode === 'plan' || ctx.mode === 'readonly') {
        return { ok: false, result: JSON.stringify({ error: '当前为计划/只读模式，系统命令被拒绝。' }) }
      }
      const gated = await gateWrite(
        ctx,
        { tool: 'run_command', conn: '本机', sql: command, kind: 'shell', risk: 3 },
        '本机',
        `run_command: ${command.slice(0, 300)}`
      )
      if (gated) return { ok: false, result: gated }

      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 120_000, 5_000), 600_000)
      const result = await new Promise<any>((resolve) => {
        const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
          cwd: ctx.project?.rootPath || undefined,
          windowsHide: true,
          env: process.env
        })
        let out = ''
        let err = ''
        let timedOut = false
        const cap = (s: string, chunk: Buffer) => {
          const t = s + chunk.toString('utf8')
          return t.length > 64_000 ? t.slice(-64_000) : t
        }
        child.stdout.on('data', (d: Buffer) => { out = cap(out, d) })
        child.stderr.on('data', (d: Buffer) => { err = cap(err, d) })
        const timer = setTimeout(() => {
          timedOut = true
          // 杀整棵进程树
          if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
        }, timeoutMs)
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({
            exitCode: code,
            timedOut,
            stdout: out.slice(0, 8000),
            stderr: err.slice(0, 8000) || undefined,
            note: timedOut ? `命令超时（>${timeoutMs}ms）已终止` : undefined
          })
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          resolve({ exitCode: -1, error: String(e?.message || e) })
        })
      })
      return { ok: !result.error && result.exitCode === 0 && !result.timedOut, result: JSON.stringify(result) }
    }

    if (name === 'fs_delete') {
      if (!ctx.project) {
        return { ok: false, result: JSON.stringify({ error: '当前会话未绑定项目，文件工具不可用。' }) }
      }
      const rel = String(args.path ?? '')
      const p = safeProjectPath(ctx.project.rootPath, rel)
      const gated = await gateWrite(
        ctx,
        { tool: 'fs_delete', conn: ctx.project.name, sql: rel, kind: 'file', risk: 2 },
        ctx.project.name,
        `fs_delete ${rel}`
      )
      if (gated) return { ok: false, result: gated }
      const stat = fs.statSync(p)
      fs.rmSync(p, { recursive: stat.isDirectory(), force: false })
      return { ok: true, result: JSON.stringify({ path: rel, deleted: stat.isDirectory() ? 'dir' : 'file' }) }
    }

    if (name === 'open_url') {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, result: JSON.stringify({ error: '仅支持 http/https 网址' }) }
      }
      await shell.openExternal(url)
      appendAudit({ kind: 'tool', detail: `open_url ${url.slice(0, 200)}` })
      return { ok: true, result: JSON.stringify({ opened: url }) }
    }

    // ---------- 远程服务器（SSH） ----------
    if (name.startsWith('server_')) {
      const servers = ctx.servers || []
      const resolveServer = (ref: string): SshServer => {
        const s = servers.find((x) => x.id === ref || x.name === ref || x.name.toLowerCase() === String(ref).toLowerCase())
        if (!s) {
          throw new Error(`服务器 "${ref}" 不在本项目挂载列表中。可用: ${servers.map((x) => x.name).join(', ') || '(无，请让用户在项目属性里添加)'}`)
        }
        return s
      }

      if (name === 'server_list') {
        appendAudit({ kind: 'tool', detail: `server_list → ${servers.length} 台` })
        return {
          ok: true,
          result: JSON.stringify({
            servers: servers.map((s) => ({ name: s.name, host: `${s.user}@${s.host}:${s.port}`, tag: s.tag || undefined, note: s.note || undefined }))
          })
        }
      }

      const server = resolveServer(String(args.server ?? ''))

      if (name === 'server_run') {
        const command = String(args.command ?? '').trim()
        if (!command) return { ok: false, result: JSON.stringify({ error: '空命令' }) }
        if (ctx.mode === 'plan' || ctx.mode === 'readonly') {
          return { ok: false, result: JSON.stringify({ error: '当前为计划/只读模式，远程命令被拒绝。' }) }
        }
        const gated = await gateWrite(
          ctx,
          { tool: 'server_run', conn: `${server.name} (${server.host})`, sql: command, kind: 'ssh', risk: 3 },
          server.name,
          `ssh ${server.name}$ 命令: ${command.slice(0, 300)}`
        )
        if (gated) return { ok: false, result: gated }
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 60_000, 5_000), 300_000)
        const r = await ssh.execCommand(server, command, timeoutMs)
        return { ok: r.exitCode === 0 && !r.timedOut, result: JSON.stringify(r) }
      }

      if (name === 'server_read_file') {
        const r = await ssh.readFile(server, String(args.path ?? ''))
        appendAudit({ kind: 'tool', conn: server.name, detail: `server_read_file ${args.path}` })
        return { ok: true, result: JSON.stringify(r) }
      }

      if (name === 'server_tail') {
        const lines = Math.min(Math.max(Number(args.lines) || 200, 1), 2000)
        const p = String(args.path ?? '')
        // 路径进入 shell 前做 POSIX 单引号转义：双引号内 $(...)/反引号 仍会执行，
        // 而本工具在只读模式下无审批门控，必须完全字面化防注入
        const shq = `'${p.replace(/'/g, "'\\''")}'`
        const r = await ssh.execCommand(server, `tail -n ${lines} ${shq}`, 60_000)
        appendAudit({ kind: 'tool', conn: server.name, detail: `server_tail ${p} -n ${lines}` })
        return { ok: r.exitCode === 0, result: JSON.stringify({ path: p, lines, content: r.stdout.slice(0, 20000) || r.stderr.slice(0, 2000) }) }
      }

      if (name === 'server_write_file') {
        if (ctx.mode === 'plan' || ctx.mode === 'readonly') {
          return { ok: false, result: JSON.stringify({ error: '当前为计划/只读模式，远程写文件被拒绝。' }) }
        }
        const p = String(args.path ?? '')
        const content = String(args.content ?? '')
        const gated = await gateWrite(
          ctx,
          { tool: 'server_write_file', conn: `${server.name} (${server.host})`, sql: `${p}\n\n（内容 ${content.length} 字符，预览）\n${content.slice(0, 300)}`, kind: 'file', risk: 2 },
          server.name,
          `server_write_file ${server.name}:${p} (${content.length} 字符)`
        )
        if (gated) return { ok: false, result: gated }
        const written = await ssh.writeFile(server, p, content)
        return { ok: true, result: JSON.stringify({ path: p, written }) }
      }

      if (name === 'server_get_file') {
        if (!ctx.project) {
          return { ok: false, result: JSON.stringify({ error: '当前会话未绑定项目，无法保存下载文件。' }) }
        }
        const remotePath = String(args.remotePath ?? '')
        const localRel = String(args.localPath ?? '')
        const localAbs = safeProjectPath(ctx.project.rootPath, localRel)
        await ssh.getFile(server, remotePath, localAbs)
        appendAudit({ kind: 'tool', conn: server.name, detail: `server_get_file ${remotePath} → ${localRel}` })
        return { ok: true, result: JSON.stringify({ remotePath, savedTo: localRel }) }
      }
    }

    // ---------- 数据库工具 ----------
    const profile = resolveConnection(ctx.connections, String(args.conn ?? ''))
    const adapter = getAdapter(profile, ctx.globalClientDir)

    if (name === 'db_list_schemas') {
      // 元数据走持久化缓存：agent 循环内反复探索不再每次打库（对象树 ⟳ 或 DDL 会失效重读）
      const schemas = await cached(metaKeys.schemas(profile.id), false, () => adapter.listSchemas())
      appendAudit({ kind: 'tool', conn: profile.name, detail: `db_list_schemas → ${schemas.length} 个 schema` })
      return { ok: true, result: JSON.stringify({ schemas: schemas.slice(0, 200), total: schemas.length }) }
    }

    if (name === 'db_list_tables') {
      const s = profile.type === 'oracle' ? String(args.schema).toUpperCase() : String(args.schema)
      const tables = await cached(metaKeys.tables(profile.id, s), false, () => adapter.listTables(s))
      appendAudit({ kind: 'tool', conn: profile.name, detail: `db_list_tables ${args.schema} → ${tables.length} 个对象` })
      return { ok: true, result: JSON.stringify({ schema: args.schema, tables: tables.slice(0, 300), total: tables.length }) }
    }

    if (name === 'db_describe_table') {
      const s = profile.type === 'oracle' ? String(args.schema).toUpperCase() : String(args.schema)
      const t = profile.type === 'oracle' ? String(args.table).toUpperCase() : String(args.table)
      const info = await cached(metaKeys.describe(profile.id, s, t), false, () => adapter.describeTable(s, t))
      appendAudit({ kind: 'tool', conn: profile.name, detail: `db_describe_table ${args.schema}.${args.table}` })
      return { ok: true, result: JSON.stringify(info) }
    }

    if (name === 'db_get_ddl') {
      const ddl = await adapter.getDdl(String(args.schema), String(args.table))
      appendAudit({ kind: 'tool', conn: profile.name, detail: `db_get_ddl ${args.schema}.${args.table}` })
      return { ok: true, result: JSON.stringify({ ddl }) }
    }

    if (name === 'db_query') {
      const sql = String(args.sql ?? '').trim()
      const v = classifySql(sql)
      if (!v.ok) {
        appendAudit({ kind: 'sql.read', conn: profile.name, detail: sql.slice(0, 500), mode: ctx.mode, error: `拦截: ${v.reason || v.kind}` })
        return { ok: false, result: JSON.stringify({ error: `只读通道拦截该语句（${v.kind}）: ${v.reason || '仅允许 SELECT/EXPLAIN/SHOW 类语句'}。如确需执行写操作请使用 db_write 工具。` }) }
      }
      const r = await adapter.query(sql, MAX_ROWS, QUERY_TIMEOUT_MS)
      const out = fmtQueryResult(r)
      appendAudit({ kind: 'sql.read', conn: profile.name, detail: sql.slice(0, 500), mode: ctx.mode })
      return { ok: true, result: JSON.stringify(out) }
    }

    if (name === 'db_write') {
      const sql = String(args.sql ?? '').trim()
      const v = classifySql(sql)
      if (v.ok) {
        return { ok: false, result: JSON.stringify({ error: '这是只读语句，请使用 db_query 工具执行' }) }
      }
      const gated = await gateWrite(ctx, { tool: 'db_write', conn: profile.name, sql, kind: v.kind, risk: v.risk }, profile.name, sql)
      if (gated) return { ok: false, result: gated }
      const r = await adapter.query(sql, MAX_ROWS, QUERY_TIMEOUT_MS)
      const committed = (await adapter.commit?.()) !== false
      // agent 执行了 DDL：该连接的元数据缓存全部失效
      if (v.kind === 'ddl') metaDropConn(profile.id)
      appendAudit({ kind: 'sql.write', conn: profile.name, detail: `执行完成: ${sql.slice(0, 100)}`, mode: ctx.mode, approved: true })
      return { ok: true, result: JSON.stringify({ affected: r.rowCount, ms: r.ms, note: profile.type === 'oracle' ? (committed ? '已提交(COMMIT)' : '连接已被重置，事务未提交（语句可能未生效）') : undefined }) }
    }

    return { ok: false, result: JSON.stringify({ error: `未知工具: ${name}` }) }
  } catch (e: any) {
    // 批准后的执行失败也要留痕（gateWrite 只在执行前记了 approved）
    appendAudit({ kind: 'tool', detail: `${name} 执行失败: ${String(e?.message || e).slice(0, 300)}` })
    return { ok: false, result: JSON.stringify({ error: String(e?.message || e).slice(0, 800) }) }
  }
}
