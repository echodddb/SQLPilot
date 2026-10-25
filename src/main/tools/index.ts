import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { shell } from 'electron'
import type { ConnProfile, PermissionMode, SshServer } from '../types'
import { resolveConnection, getAdapter } from '../db/manager'
import { classifySql, dialectOf } from '../db/guard'
import { appendAudit } from '../audit'
import type { AuditEntry } from '../audit'
import { cached, metaDropConn, metaKeys } from '../meta'
import { readSkill } from '../skills'
import { appendMemory } from '../memory'
import { putTable } from '../artifacts'
import * as ssh from '../ssh'
import { readRunAudit } from '../agent/subagent-audit'
import { listSubagentTasks, stopSubagentTask, waitSubagentTask } from '../agent/subtask-registry'

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
  /** 会话放行的收敛范围：文件类为具体路径，缺省时按工具+类别+连接收敛 */
  target?: string
  /** 发起者标注（如"子代理 explore"）：确认弹窗展示来源，主代理直接执行时为空 */
  origin?: string
}

/** 用户在确认弹窗可选的决定：once 仅此次 / session 本会话同类放行 / yolo 提权到完全放开 / deny 拒绝 */
export type ApprovalDecision = 'once' | 'session' | 'yolo' | 'deny'

/** 归一化后的审批结果：decision 已脱离弹窗选项语义；reason = 用户拒绝时附带的反馈（回传模型调整方案） */
export interface ApprovalOutcome {
  decision: 'approved' | 'denied' | 'session' | 'yolo'
  reason?: string
}

export interface ToolContext {
  connections: ConnProfile[]
  globalClientDir?: string
  mode: PermissionMode
  /** 实时读取当前模式：审批可能等待几分钟，期间用户/父会话可能把模式降级，ctx.mode 只是入口快照 */
  getMode?: () => PermissionMode
  sessionApproved: Set<string>
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalOutcome>
  /** 当前会话绑定的项目（未绑定为 undefined，fs 工具不可用） */
  project?: { id: string; name: string; rootPath: string }
  /** 项目挂载的 SSH 服务器（server_* 工具用） */
  servers?: SshServer[]
  /** 子代理执行标记（如 "sub:explore"）：写操作审计打标归属 */
  origin?: string
  /** 发起会话 id（审计结构化字段） */
  sessionId?: string
  /** 子代理运行 id（审计结构化字段，关联 subagent-runs/<runId>.jsonl） */
  runId?: string
  /** 会话停止信号：长耗时工具（命令/查询/传输）监听它实现可中断 */
  signal?: AbortSignal
}

/** 工具侧审计公共字段：发起者/会话/子代理运行 id/权限模式/工具名（见 audit.ts 格式规范） */
function auditBase(ctx: ToolContext, tool: string): { actor: string; sessionId?: string; runId?: string; mode: string; tool: string } {
  return {
    actor: ctx.origin || 'agent',
    sessionId: ctx.sessionId,
    runId: ctx.runId,
    mode: ctx.mode,
    tool
  }
}

/**
 * 可中止等待：signal 触发时立即返回 undefined（调用方按"用户中止"处理），
 * 原 Promise 的结果/异常仍由 Promise.race 正常订阅，不产生未处理拒绝。
 * 语义提醒：数据库/SFTP 侧操作无法真正回滚，中止只保证 agent 循环不再等待。
 */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return p
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) }
    )
  })
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
        text: { type: 'string', description: '要记住的一条事实（一句话写全上下文，如"trade_db 为生产库，XX 表约 2 亿行，禁全表扫描"）' },
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
    name: 'agent_spawn',
    description: '派生子代理执行独立子任务。子代理拥有独立上下文（看不到本会话历史），只返回最终报告——中间的工具结果不占用本会话上下文。类型清单与适用场景见系统提示词"可用子代理"。prompt 必须自包含：写明目标、连接名、期望输出格式。并行扇出仅用于只读采集（如多连接巡检时一次派多个 explore）；写操作留在本会话执行。预计耗时长的采集任务可传 run_in_background=true 后台执行（立即返回任务 id，完成时会收到系统通知，用 task_output 取结果）。',
    parameters: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', description: '子代理类型（见系统提示词"可用子代理"清单，如 explore / general）' },
        description: { type: 'string', description: '3-5 词任务短标签（界面展示用）' },
        prompt: { type: 'string', description: '自包含的任务书：目标、连接名、范围、期望输出格式' },
        run_in_background: { type: 'boolean', description: 'true = 后台执行，立即返回任务 id（默认前台；前台超过 2 分钟也会自动转后台）' }
      },
      required: ['agent_type', 'description', 'prompt']
    }
  },
  {
    name: 'task_output',
    description: '查询后台子代理任务的进度或结果（task_id 来自 agent_spawn 后台返回或系统通知）。block=true 时等待任务完成（默认），block=false 立即返回当前状态。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id' },
        block: { type: 'boolean', description: '是否等待完成，默认 true' },
        timeoutMs: { type: 'number', description: '等待超时毫秒数，默认 10000，最大 120000' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'task_stop',
    description: '停止一个运行中的后台子代理任务。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id' }
      },
      required: ['task_id']
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

/** 单行/单元格字节上限：大 CLOB/BLOB 不能撑爆模型上下文与主进程内存 */
const CELL_MAX = 8_000

function clipMiddle(s: string, max = 8_000): string {
  if (s.length <= max) return s
  const half = Math.floor((max - 24) / 2)
  return `${s.slice(0, half)}\n…（中间省略 ${s.length - half * 2} 字符）…\n${s.slice(-half)}`
}

function fmtCell(v: any): any {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19)
  if (Buffer.isBuffer(v)) {
    return `[binary ${v.length} bytes] ${v.subarray(0, 64).toString('hex')}${v.length > 64 ? '…' : ''}`
  }
  if (typeof v === 'object') {
    let s: string
    try { s = JSON.stringify(v) } catch { s = String(v) }
    return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s
  }
  if (typeof v === 'string' && v.length > CELL_MAX) return `${v.slice(0, CELL_MAX)}…`
  return v
}

function fmtQueryResult(r: { columns: string[]; rows: any[][]; rowCount: number; ms: number; truncated?: boolean }): any {
  const preview = r.rows.slice(0, PREVIEW_ROWS).map((row) => row.map(fmtCell))
  return {
    columns: r.columns,
    rows: preview,
    rowCount: r.rowCount,
    returned: r.rows.length,
    truncated: !!r.truncated || r.rows.length > PREVIEW_ROWS,
    ms: r.ms
  }
}

/** 远程凭据类路径：读取需显式确认（防"读私钥→外链外传"链） */
const SENSITIVE_REMOTE_PATH = /(^|[\\/])(\.ssh|\.aws|\.kube|\.gnupg|\.config\/gcloud)([\\/]|$)|id_rsa|id_ed25519|authorized_keys|known_hosts|\.pgpass|\.my\.cnf|(^|[\\/])\.env(\.|$)|(^|[\\/])(shadow|gshadow)$/i

/** 灾难性命令硬阻断：即便完全放开模式也不自动执行——误触发代价不可逆，必须人工操作 */
const CATASTROPHIC_CMD = /(?:^|[\s;&|])rm\s+-[a-z]*[rf][a-z]*\s+(?:\/|~|\$HOME)(?:\s|$)|\bmkfs(?:\.[a-z0-9]+)?\b|\bdd\s+if=[^\s]*\s+of=\/dev\/|\bformat\s+[a-z]:|\bdel\s+\/[a-z]*[sf][a-z]*\b[^\n]*[a-z]:\\|\bshutdown\s+[-\/]|\breg\s+delete\s+hklm/i

/** Windows 保留设备名：CON/NUL/COM1 等经 API 归一化后可能落到意外设备 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** 解析真实路径：目标不存在时解析其父目录（防止"目录是符号链接、文件尚不存在"的越界写） */
function realpathLoose(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p))
    } catch {
      return p
    }
  }
}

/** 项目内路径安全解析：禁止越出项目根。
 * 词法前缀之外还要做 realpath 归一（符号链接/junction 可把读写删带到项目外），
 * 并拒绝 Windows 保留名、备用数据流（`file.txt:stream`）与尾随点/空格。 */
function safeProjectPath(root: string, rel: string, allowRoot = false): string {
  const raw = String(rel ?? '').trim()
  if (!raw) {
    if (allowRoot) return root
    throw new Error('路径不能为空：不允许把项目根目录当作操作目标')
  }
  const p = path.resolve(root, raw)
  const rootReal = realpathLoose(root)
  const pReal = realpathLoose(p)
  const relToRoot = path.relative(rootReal, pReal)
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`路径越界（只能访问项目目录内）: ${rel}`)
  }
  if (!allowRoot && relToRoot === '') {
    throw new Error('不允许把项目根目录当作操作目标（请指定具体文件）')
  }
  const base = path.basename(p)
  if (process.platform === 'win32') {
    if (WINDOWS_RESERVED.test(base)) throw new Error(`Windows 保留设备名不可用: ${base}`)
    if (base.includes(':')) throw new Error(`不允许备用数据流路径: ${base}`)
    if (/[. ]$/.test(base)) throw new Error(`路径不能以点或空格结尾: ${base}`)
  }
  return p
}

/** 会话级放行键：工具+操作类别+目标 各自独立——批准"写文件"不等于批准"删文件"，
 * 批准 DML 不等于批准 DDL。文件类必须带具体路径，避免"批准一次 = 放行任意路径"；
 * origin 入键，子代理的批准不会扩散到父代理/兄弟子代理。 */
function approvalKey(req: ApprovalRequest): string {
  return `${req.tool}:${req.kind}:${req.conn}${req.target ? `:${req.target}` : ''}${req.origin ? `|${req.origin}` : ''}`
}

/** 读取当前权限模式：优先取实时值（审批期间模式可能已变），没有注入时退回入口快照 */
function currentMode(ctx: ToolContext): PermissionMode {
  return ctx.getMode ? ctx.getMode() : ctx.mode
}

/** 写操作统一门控：计划/只读拒绝；确认/会话/放开按级别放行。
 *  skipSuccessAudit = 批准成功时不记审计（调用方随后有带结果的成功审计时用，防同一次操作双条记录） */
async function gateWrite(
  ctx: ToolContext,
  req: ApprovalRequest,
  auditConn: string,
  detail: string,
  skipSuccessAudit = false
): Promise<string | null> {
  // 子代理发起的写操作在审计里带归属标记（如 [sub:explore]）
  const od = ctx.origin ? `[${ctx.origin}] ` : ''
  const base = auditBase(ctx, req.tool)
  const sqlField = req.tool === 'db_write' ? { sql: req.sql } : {}
  const modeAtEntry = currentMode(ctx)
  if (modeAtEntry === 'plan' || modeAtEntry === 'readonly') {
    const where = modeAtEntry === 'plan' ? '计划模式（请先输出计划并获得用户批准）' : '只读模式'
    appendAudit({ ...base, kind: 'sql.write', conn: auditConn, detail: od + detail.slice(0, 500), mode: modeAtEntry, approved: false, error: `${where}拒绝`, ...sqlField })
    return JSON.stringify({ error: `当前为${where}，写操作被拒绝。` })
  }
  const outcome = await requestApprovalIfNeeded(ctx, req)
  if (outcome.decision === 'denied') {
    const reason = outcome.reason?.trim()
    appendAudit({ ...base, kind: 'sql.write', conn: auditConn, detail: od + detail.slice(0, 500), mode: currentMode(ctx), approved: false, error: reason ? `用户拒绝：${reason.slice(0, 300)}` : '用户拒绝', ...sqlField })
    const feedback = reason
      ? `用户拒绝了该操作，反馈：${reason}。请根据反馈调整方案后再继续；未经用户明确要求，不要原样重试。`
      : '用户拒绝了该操作。请询问用户希望如何调整，不要原样重试。'
    return JSON.stringify({ error: feedback })
  }
  if (outcome.decision === 'session') ctx.sessionApproved.add(approvalKey(req))
  // 审批期间模式可能被降级（用户切只读 / 父会话降级）：执行前按实时模式再校验一次
  const modeNow = currentMode(ctx)
  if (modeNow === 'plan' || modeNow === 'readonly') {
    const where = modeNow === 'plan' ? '计划模式' : '只读模式'
    appendAudit({ ...base, kind: 'sql.write', conn: auditConn, detail: od + detail.slice(0, 500), mode: modeNow, approved: false, error: `审批期间切换为${where}，已拒绝`, ...sqlField })
    return JSON.stringify({ error: `当前已切换为${where}，写操作被拒绝。` })
  }
  // yolo：会话模式切换由审批应答方（ipc 层）完成，这里视同本次放行
  if (!skipSuccessAudit) {
    appendAudit({ ...base, kind: 'sql.write', conn: auditConn, detail: od + detail.slice(0, 500), mode: modeNow, approved: true, ...sqlField })
  }
  return null
}

function requestApprovalIfNeeded(ctx: ToolContext, req: ApprovalRequest): Promise<ApprovalOutcome> {
  // session 模式：同类写操作（同工具+同类别+同目标）首次确认后本会话放行；高危(risk3)每次都确认。yolo 全放行。
  const confirm = ctx.mode === 'yolo' ? false : ctx.mode === 'confirm' ? true : req.risk >= 3 ? true : !ctx.sessionApproved.has(approvalKey(req))
  if (!confirm) return Promise.resolve({ decision: 'approved' })
  // 等待期间会话可能被停止/重置：不能让工具一直挂在确认弹窗上（最长 5 分钟）
  return raceAbort(ctx.requestApproval(req), ctx.signal).then((o) => o ?? { decision: 'denied' as const, reason: '任务已停止' })
}

export async function executeTool(name: string, argsJson: string, ctx: ToolContext): Promise<{ ok: boolean; result: string }> {
  let args: any = {}
  try {
    args = JSON.parse(argsJson || '{}')
  } catch {
    return { ok: false, result: JSON.stringify({ error: `工具参数不是合法 JSON: ${argsJson.slice(0, 200)}` }) }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, result: JSON.stringify({ error: '工具参数必须是 JSON 对象' }) }
  }
  // 未知工具先报未知，再进连接解析：否则会误报"找不到连接"
  const def = TOOLS.find((t) => t.name === name)
  if (!def) return { ok: false, result: JSON.stringify({ error: `未知工具: ${name}` }) }
  // 必填参数校验：模型漏传时给出明确错误，避免 String(undefined) 拼出 "undefined" 去执行
  for (const key of (def.parameters?.required || []) as string[]) {
    if (args[key] === undefined || args[key] === null) {
      return { ok: false, result: JSON.stringify({ error: `缺少必填参数 "${key}"（工具 ${name}）` }) }
    }
  }

  // 工具侧统一审计入口：自动带发起者/会话/子代理运行 id/权限模式/工具名（格式见 audit.ts）
  const audit = (e: AuditEntry) => appendAudit({ ...auditBase(ctx, name), ...e })

  try {
    // ---------- 会话规划控制（由 agent loop 拦截处理，不落到这里） ----------
    if (name === 'enter_plan_mode' || name === 'exit_plan_mode') {
      return { ok: false, result: JSON.stringify({ error: '该工具由会话调度层处理，此处不应到达' }) }
    }
    // agent_spawn 同样由 loop 派发（并发扇出），executeTool 不处理
    if (name === 'agent_spawn') {
      return { ok: false, result: JSON.stringify({ error: '该工具由会话调度层处理，此处不应到达' }) }
    }

    // ---------- 后台子代理任务收割 ----------
    if (name === 'task_output' || name === 'task_stop') {
      const taskId = String(args.task_id ?? '')
      if (!taskId) return { ok: false, result: JSON.stringify({ error: 'task_id 不能为空' }) }
      if (name === 'task_stop') {
        const r = stopSubagentTask(taskId)
        if (!r.ok) return { ok: false, result: JSON.stringify({ error: `任务 ${taskId} 不存在（可能已结束并被清理）` }) }
        audit({ kind: 'tool', target: taskId, detail: `task_stop ${taskId}` })
        const t = listSubagentTasks().find((x) => x.id === taskId)
        return { ok: true, result: JSON.stringify({ stopped: true, status: t?.status || 'running', note: t?.status === 'running' ? '中止信号已发出，任务将在当前工具调用完成后停止' : undefined }) }
      }
      const block = args.block !== false
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10_000, 0), 120_000)
      let task = listSubagentTasks().find((x) => x.id === taskId)
      if (!task) {
        return { ok: false, result: JSON.stringify({ error: `任务 ${taskId} 不存在（可能是前台子代理或已清理的后台任务）` }) }
      }
      if (block && task.status === 'running') {
        await waitSubagentTask(taskId, timeoutMs)
        task = listSubagentTasks().find((x) => x.id === taskId) || task
      }
      audit({ kind: 'tool', target: taskId, detail: `task_output ${taskId} → ${task.status}` })
      return {
        ok: true,
        result: JSON.stringify({
          task: { id: task.id, agentType: task.agentType, description: task.description, status: task.status, summary: task.summary, runFile: task.runFile },
          report: task.status === 'running' ? undefined : task.report,
          retrieval_status: task.status === 'running' ? 'not_ready' : 'success',
          note: task.status === 'running' ? `仍在运行（已等待 ${timeoutMs}ms）。任务完成后会有系统通知送达，稍后再查或继续别的工作。` : undefined
        })
      }
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
        audit({ kind: 'tool', conn: ctx.project.name, target: '(项目根)', detail: `fs_list → ${entries.length} 项`, rows: entries.length })
        return { ok: true, result: JSON.stringify({ project: ctx.project.name, entries }) }
      }
      if (name === 'fs_read') {
        const p = safeProjectPath(ctx.project.rootPath, args.path)
        const stat = fs.statSync(p)
        if (stat.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，拒绝读取')
        const content = fs.readFileSync(p, 'utf8')
        audit({ kind: 'tool', conn: ctx.project.name, target: String(args.path), detail: `fs_read ${args.path}` })
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
          risk: 2,
          target: rel
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
      audit({ kind: 'tool', target: `${s.id}${rel ? ` :: ${s.path}` : ''}`, detail: `read_skill ${s.id}${rel ? ` :: ${s.path}` : ''}` })
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
        audit({ kind: 'tool', conn: `项目 ${ctx.project.name}`, target: `(项目记忆)`, detail: `memory_append: ${text.slice(0, 200)}` })
        return { ok: true, result: JSON.stringify({ saved: true, scope: `项目 ${ctx.project.name}`, file: r.file, totalEntries: r.entries }) }
      }
      const target = conn ? ctx.connections.find((c) => c.name === conn || c.id === conn) : null
      if (conn && !target) {
        return { ok: false, result: JSON.stringify({ error: `连接 "${conn}" 不存在`, available: ctx.connections.map((c) => c.name) }) }
      }
      const r = appendMemory(target ? { kind: 'conn', name: target.name } : { kind: 'global' }, text)
      audit({ kind: 'tool', conn: target?.name || '全局', target: target ? `(连接记忆)` : '(全局记忆)', detail: `memory_append: ${text.slice(0, 200)}` })
      return { ok: true, result: JSON.stringify({ saved: true, scope: target ? `连接 ${target.name}` : '全局', file: r.file, totalEntries: r.entries }) }
    }

    // ---------- 本机控制 ----------
    if (name === 'run_command') {
      const command = String(args.command ?? '').trim()
      if (!command) return { ok: false, result: JSON.stringify({ error: '空命令' }) }
      if (CATASTROPHIC_CMD.test(command)) {
        audit({ kind: 'tool', conn: '本机', detail: '灾难性命令被硬阻断', error: command.slice(0, 300) })
        return { ok: false, result: JSON.stringify({ error: '该命令被判定为灾难性操作（删除根目录/格式化/关机等），已阻断。请由用户手动执行，或改写成范围明确的命令。' }) }
      }
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
        let aborted = false
        const onAbort = () => {
          aborted = true
          if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
        }
        ctx.signal?.addEventListener('abort', onAbort, { once: true })
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
          ctx.signal?.removeEventListener('abort', onAbort)
          resolve({
            aborted,
            exitCode: code,
            timedOut,
            stdout: clipMiddle(out),
            stderr: err ? clipMiddle(err) : undefined,
            note: timedOut ? `命令超时（>${timeoutMs}ms）已终止` : undefined
          })
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          resolve({ exitCode: -1, error: String(e?.message || e) })
        })
      })
      return { ok: !result.error && result.exitCode === 0 && !result.timedOut && !result.aborted, result: JSON.stringify(result) }
    }

    if (name === 'fs_delete') {
      if (!ctx.project) {
        return { ok: false, result: JSON.stringify({ error: '当前会话未绑定项目，文件工具不可用。' }) }
      }
      const rel = String(args.path ?? '')
      // 空串/`.`/`..` 由 safeProjectPath 拒绝；这里再兜一层，绝不把项目根当删除目标
      const p = safeProjectPath(ctx.project.rootPath, rel)
      const gated = await gateWrite(
        ctx,
        { tool: 'fs_delete', conn: ctx.project.name, sql: rel, kind: 'file', risk: 2, target: rel },
        ctx.project.name,
        `fs_delete ${rel}`
      )
      if (gated) return { ok: false, result: gated }
      // 先 lstat：符号链接/junction 本身不删，避免"删链接指向的真实目录"
      const lst = fs.lstatSync(p)
      if (lst.isSymbolicLink()) throw new Error(`不允许删除符号链接：${rel}（请先确认指向，必要时直接删目标）`)
      const stat = fs.statSync(p)
      fs.rmSync(p, { recursive: stat.isDirectory(), force: false })
      return { ok: true, result: JSON.stringify({ path: rel, deleted: stat.isDirectory() ? 'dir' : 'file' }) }
    }

    if (name === 'open_url') {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, result: JSON.stringify({ error: '仅支持 http/https 网址' }) }
      }
      // 打开外链等于把 URL 交给系统浏览器发出去：这是唯一的数据出口，任何模式都要过门控。
      // 否则"读敏感文件 → 拼进 URL 打开"无需审批即可外泄（只读/计划模式由 gateWrite 直接拒绝）。
      const gated = await gateWrite(
        ctx,
        { tool: 'open_url', conn: '本机', sql: url, kind: 'net', risk: 2, target: url.slice(0, 200) },
        '本机',
        `open_url ${url.slice(0, 200)}`
      )
      if (gated) return { ok: false, result: gated }
      await shell.openExternal(url)
      audit({ kind: 'tool', target: url.slice(0, 200), detail: `open_url ${url.slice(0, 200)}` })
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
        audit({ kind: 'tool', detail: `server_list → ${servers.length} 台`, rows: servers.length })
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
        if (CATASTROPHIC_CMD.test(command)) {
          audit({ kind: 'tool', conn: server.name, detail: '灾难性远程命令被硬阻断', error: command.slice(0, 300) })
          return { ok: false, result: JSON.stringify({ error: '该远程命令被判定为灾难性操作（删根/格式化/关机等），已阻断。请由用户手动执行。' }) }
        }
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
        const r = await ssh.execCommand(server, command, timeoutMs, undefined, ctx.signal)
        return { ok: r.exitCode === 0 && !r.timedOut && !r.aborted, result: JSON.stringify(r) }
      }

      if (name === 'server_read_file') {
        const p = String(args.path ?? '')
        // 凭据类文件在只读模式也必须确认：否则"读私钥 → open_url 带出去"可全程无审批
        if (SENSITIVE_REMOTE_PATH.test(p)) {
          const gated = await gateWrite(
            ctx,
            { tool: 'server_read_file', conn: `${server.name} (${server.host})`, sql: p, kind: 'file', risk: 2, target: p },
            server.name,
            `server_read_file ${server.name}:${p}（敏感路径）`
          )
          if (gated) return { ok: false, result: gated }
        }
        const r = await raceAbort(ssh.readFile(server, p), ctx.signal)
        if (!r) return { ok: false, result: JSON.stringify({ error: '任务已被用户中止，文件读取未完成' }) }
        audit({ kind: 'tool', conn: server.name, target: `${server.name}:${args.path}`, detail: `server_read_file ${args.path}` })
        return { ok: true, result: JSON.stringify(r) }
      }

      if (name === 'server_tail') {
        const lines = Math.min(Math.max(Number(args.lines) || 200, 1), 2000)
        const p = String(args.path ?? '')
        // 路径进入 shell 前做 POSIX 单引号转义：双引号内 $(...)/反引号 仍会执行，
        // 而本工具在只读模式下无审批门控，必须完全字面化防注入
        const shq = `'${p.replace(/'/g, "'\\''")}'`
        if (SENSITIVE_REMOTE_PATH.test(p)) {
          const gated = await gateWrite(
            ctx,
            { tool: 'server_tail', conn: `${server.name} (${server.host})`, sql: p, kind: 'file', risk: 2, target: p },
            server.name,
            `server_tail ${server.name}:${p}（敏感路径）`
          )
          if (gated) return { ok: false, result: gated }
        }
        const r = await ssh.execCommand(server, `tail -n ${lines} ${shq}`, 60_000, undefined, ctx.signal)
        audit({ kind: 'tool', conn: server.name, target: `${server.name}:${p}`, detail: `server_tail ${p} -n ${lines}`, rows: lines })
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
          { tool: 'server_write_file', conn: `${server.name} (${server.host})`, sql: `${p}\n\n（内容 ${content.length} 字符，预览）\n${content.slice(0, 300)}`, kind: 'file', risk: 2, target: p },
          server.name,
          `server_write_file ${server.name}:${p} (${content.length} 字符)`
        )
        if (gated) return { ok: false, result: gated }
        const written = await raceAbort(ssh.writeFile(server, p, content), ctx.signal)
        if (written === undefined) return { ok: false, result: JSON.stringify({ error: '任务已被用户中止：远程写入结果未知，请确认后再决定是否重试' }) }
        return { ok: true, result: JSON.stringify({ path: p, written }) }
      }

      if (name === 'server_get_file') {
        if (!ctx.project) {
          return { ok: false, result: JSON.stringify({ error: '当前会话未绑定项目，无法保存下载文件。' }) }
        }
        const remotePath = String(args.remotePath ?? '')
        const localRel = String(args.localPath ?? '')
        const localAbs = safeProjectPath(ctx.project.rootPath, localRel)
        const got = await raceAbort(ssh.getFile(server, remotePath, localAbs), ctx.signal)
        if (!got) return { ok: false, result: JSON.stringify({ error: '任务已被用户中止，下载未完成（本地文件可能不完整）' }) }
        audit({ kind: 'tool', conn: server.name, target: `${remotePath} → ${localRel}`, detail: `server_get_file ${remotePath} → ${localRel}` })
        return { ok: true, result: JSON.stringify({ remotePath, savedTo: localRel }) }
      }
    }

    // ---------- 数据库工具 ----------
    const profile = resolveConnection(ctx.connections, String(args.conn ?? ''))
    const adapter = getAdapter(profile, ctx.globalClientDir)

    if (name === 'db_list_schemas') {
      // 元数据走持久化缓存：agent 循环内反复探索不再每次打库（对象树 ⟳ 或 DDL 会失效重读）
      const schemas = await cached(metaKeys.schemas(profile.id), false, () => adapter.listSchemas())
      audit({ kind: 'tool', conn: profile.name, detail: `db_list_schemas → ${schemas.length} 个 schema`, rows: schemas.length })
      return { ok: true, result: JSON.stringify({ schemas: schemas.slice(0, 200), total: schemas.length }) }
    }

    if (name === 'db_list_tables') {
      const s = profile.type === 'oracle' || profile.type === 'ob-oracle' ? String(args.schema).toUpperCase() : String(args.schema)
      const tables = await cached(metaKeys.tables(profile.id, s), false, () => adapter.listTables(s))
      audit({ kind: 'tool', conn: profile.name, target: String(args.schema), detail: `db_list_tables ${args.schema} → ${tables.length} 个对象`, rows: tables.length })
      return { ok: true, result: JSON.stringify({ schema: args.schema, tables: tables.slice(0, 300), total: tables.length }) }
    }

    if (name === 'db_describe_table') {
      const isOracleProtocol = profile.type === 'oracle' || profile.type === 'ob-oracle'
      const s = isOracleProtocol ? String(args.schema).toUpperCase() : String(args.schema)
      const t = isOracleProtocol ? String(args.table).toUpperCase() : String(args.table)
      const info = await cached(metaKeys.describe(profile.id, s, t), false, () => adapter.describeTable(s, t))
      audit({ kind: 'tool', conn: profile.name, target: `${args.schema}.${args.table}`, detail: `db_describe_table ${args.schema}.${args.table}`, rows: info.columns.length })
      return { ok: true, result: JSON.stringify(info) }
    }

    if (name === 'db_get_ddl') {
      const ddl = await adapter.getDdl(String(args.schema), String(args.table))
      audit({ kind: 'tool', conn: profile.name, target: `${args.schema}.${args.table}`, detail: `db_get_ddl ${args.schema}.${args.table}` })
      return { ok: true, result: JSON.stringify({ ddl }) }
    }

    if (name === 'db_query') {
      const sql = String(args.sql ?? '').trim()
      const v = classifySql(sql, dialectOf(profile.type))
      if (!v.ok) {
        audit({ kind: 'sql.read', conn: profile.name, detail: '只读通道拦截', sql, error: `拦截: ${v.reason || v.kind}` })
        return { ok: false, result: JSON.stringify({ error: `只读通道拦截该语句（${v.kind}）: ${v.reason || '仅允许 SELECT/EXPLAIN/SHOW 类语句'}。如确需执行写操作请使用 db_write 工具。` }) }
      }
      const r = await raceAbort(adapter.query(sql, MAX_ROWS, QUERY_TIMEOUT_MS), ctx.signal)
      if (!r) {
        audit({ kind: 'sql.read', conn: profile.name, detail: 'db_query 被用户中止', sql, error: '用户中止' })
        return { ok: false, result: JSON.stringify({ error: '任务已被用户中止，查询执行结果未知（语句可能仍在服务端执行至超时）' }) }
      }
      const out = fmtQueryResult(r)
      // 侧栏「产物」：完整结果落盘（对话里只保留前 30 行），工具返回值只带 id + 实际行数，
      // 模型不必看全量；用户在右侧面板打开时再按 id 取
      try {
        const art = putTable({ columns: r.columns, rows: r.rows, rowCount: r.rowCount, ms: r.ms, truncated: r.truncated, conn: profile.name, sql })
        out.artifactId = art.id
        out.artifactRows = art.rows
      } catch { /* 落盘失败不影响查询本身 */ }
      audit({ kind: 'sql.read', conn: profile.name, detail: 'db_query 执行', sql, rows: r.rowCount, ms: r.ms })
      return { ok: true, result: JSON.stringify(out) }
    }

    if (name === 'db_write') {
      const sql = String(args.sql ?? '').trim()
      // 事务/会话控制语句不能走 db_write：MySQL 上 SET autocommit=0 会让后续写"报成功但从未提交"，
      // USE/ALTER SESSION 还会污染共享连接的解析上下文。
      // 判首词前必须先剥注释：直接对原始串做正则会被 `/*x*/SET autocommit=0` 绕过
      const headWord = (sql.replace(/^(--[^\n]*\r?\n|\/\*[\s\S]*?\*\/|\s)+/, '').match(/^[a-zA-Z]+/)?.[0] || '').toLowerCase()
      if (/^(set|use|begin|commit|rollback|start)$/.test(headWord)) {
        return { ok: false, result: JSON.stringify({ error: '事务/会话控制语句（SET/USE/BEGIN/COMMIT/ROLLBACK）不允许通过 db_write 执行；写操作由工具自动提交，Oracle 可用工作台的提交/回滚按钮。' }) }
      }
      const v = classifySql(sql, dialectOf(profile.type))
      if (v.ok) {
        return { ok: false, result: JSON.stringify({ error: '这是只读语句，请使用 db_query 工具执行' }) }
      }
      if (profile.role === 'readonly') {
        audit({ kind: 'sql.write', conn: profile.name, detail: '只读连接拒绝 db_write', sql, mode: ctx.mode, approved: false, error: `语句类别: ${v.kind}` })
        return { ok: false, result: JSON.stringify({ error: `连接「${profile.name}」是只读账号，禁止执行写操作。请改用管理账号连接，或让用户先更新连接角色。` }) }
      }
      const gated = await gateWrite(ctx, { tool: 'db_write', conn: profile.name, sql, kind: v.kind, risk: v.risk }, profile.name, sql, true)
      if (gated) return { ok: false, result: gated }
      const isOracleProtocol = profile.type === 'oracle' || profile.type === 'ob-oracle'
      // 失败/中止必须把当前事务回滚掉：否则下一次任意 commit 会把这次"结果未知"的写一起提交
      const rollbackQuietly = async () => {
        if (!isOracleProtocol) return
        try { await adapter.query('ROLLBACK', 1, 10_000) } catch { /* 连接可能已断开 */ }
      }
      let r: any
      try {
        r = await raceAbort(adapter.query(sql, MAX_ROWS, QUERY_TIMEOUT_MS), ctx.signal)
      } catch (e) {
        await rollbackQuietly()
        throw e
      }
      if (!r) {
        await rollbackQuietly()
        audit({ kind: 'sql.write', conn: profile.name, detail: 'db_write 被用户中止（已回滚）', sql, error: '用户中止' })
        return { ok: false, result: JSON.stringify({ error: '任务已被用户中止，本次写操作已回滚（ROLLBACK），未持久化。如需继续请重新执行。' }) }
      }
      let committed = true
      try {
        committed = (await adapter.commit?.()) !== false
      } catch (e) {
        await rollbackQuietly()
        throw e
      }
      if (!committed) await rollbackQuietly()
      // agent 执行了 DDL：该连接的元数据缓存全部失效
      if (v.kind === 'ddl') metaDropConn(profile.id)
      audit({ kind: 'sql.write', conn: profile.name, detail: '执行完成', sql, rows: r.rowCount, ms: r.ms, approved: true, target: v.kind === 'ddl' ? '(DDL)' : undefined })
      return { ok: true, result: JSON.stringify({ affected: r.rowCount, ms: r.ms, note: isOracleProtocol ? (committed ? '已提交(COMMIT)' : '连接已被重置，事务已回滚，语句未持久化') : undefined }) }
    }

    return { ok: false, result: JSON.stringify({ error: `未知工具: ${name}` }) }
  } catch (e: any) {
    // 批准后的执行失败也要留痕（gateWrite 只在执行前记了 approved）
    audit({ kind: 'tool', detail: `${name} 执行失败`, error: String(e?.message || e).slice(0, 300) })
    return { ok: false, result: JSON.stringify({ error: String(e?.message || e).slice(0, 800) }) }
  }
}
