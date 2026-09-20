import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { callLlm } from './llm'
import { TOOLS, executeTool } from '../tools'
import type { ApprovalDecision, ApprovalRequest, ToolContext } from '../tools'
import type { ChatMsg, ConnProfile, PermissionMode, ProjectConfig, ProviderConfig, ThinkingEffort } from '../types'
import { appendAudit } from '../audit'
import { listSkills } from '../skills'
import { loadConfig } from '../config'
import { writeFileAtomic } from '../atomic'

export type AgentEvent =
  | { type: 'text'; sessionId: string; text: string }
  | { type: 'reasoning'; sessionId: string; text: string }
  | { type: 'tool-start'; sessionId: string; tool: string; args: string }
  | { type: 'tool-end'; sessionId: string; tool: string; ok: boolean; result: string }
  | { type: 'session-updated'; sessionId: string; meta: SessionMeta }
  | { type: 'done'; sessionId: string; note?: string }
  | { type: 'error'; sessionId: string; error: string }

export interface RunDeps {
  emit: (ev: AgentEvent) => void
  /** sessionId 用于把写操作确认归属到具体会话（多会话并发时互不影响） */
  requestApproval: (req: ApprovalRequest, sessionId: string) => Promise<ApprovalDecision>
}

export interface SessionMeta {
  id: string
  title: string
  mode: PermissionMode
  providerId: string | null
  projectId: string | null
  /** 会话级思考级别（null = 沿用提供商默认） */
  effort: ThinkingEffort | null
}

interface SessionState extends SessionMeta {
  messages: ChatMsg[]
  running: boolean
  sessionApproved: Set<string>
  cancelRequested: boolean
  abortCtrl: AbortController | null
}

const sessions = new Map<string, SessionState>()
let sessionSeq = 0

// ---------- 会话持久化（userData/sessions.json） ----------

function sessionsFile(): string {
  return path.join(app.getPath('userData'), 'sessions.json')
}

/** 应用启动时恢复磁盘上的会话（含每会话的权限模式/模型/项目绑定） */
export function loadPersistedSessions(): void {
  try {
    const raw = fs.readFileSync(sessionsFile(), 'utf8')
    const data = JSON.parse(raw) as Record<string, Partial<SessionState> & { messages?: ChatMsg[] }>
    for (const [id, s] of Object.entries(data)) {
      if (!sessions.has(id)) {
        sessions.set(id, {
          id,
          title: s.title || '会话',
          mode: (s.mode as PermissionMode) || 'readonly',
          providerId: s.providerId ?? null,
          projectId: s.projectId ?? null,
          effort: (s.effort as ThinkingEffort) ?? null,
          messages: Array.isArray(s.messages) ? trimHistory(s.messages) : [],
          running: false,
          sessionApproved: new Set(),
          cancelRequested: false,
          abortCtrl: null
        })
      }
    }
  } catch { /* 无历史文件或损坏时静默跳过 */ }
}

export function persistSessions(): void {
  try {
    const data: Record<string, any> = {}
    for (const s of sessions.values()) {
      data[s.id] = {
        title: s.title,
        mode: s.mode,
        providerId: s.providerId,
        projectId: s.projectId,
        effort: s.effort,
        messages: s.messages
      }
    }
    writeFileAtomic(sessionsFile(), JSON.stringify(data))
  } catch { /* 持久化失败不阻断对话 */ }
}

export function getSession(id: string): SessionState {
  let s = sessions.get(id)
  if (!s) {
    s = {
      id,
      title: '新会话',
      mode: loadConfig().mode,
      providerId: null,
      projectId: null,
      effort: null,
      messages: [],
      running: false,
      sessionApproved: new Set(),
      cancelRequested: false,
      abortCtrl: null
    }
    sessions.set(id, s)
  }
  return s
}

function metaOf(s: SessionState): SessionMeta {
  return { id: s.id, title: s.title, mode: s.mode, providerId: s.providerId, projectId: s.projectId, effort: s.effort }
}

/** 会话元信息（渲染层列表用） */
export function listSessions(): SessionMeta[] {
  return [...sessions.values()].map(metaOf)
}

export function newSession(): SessionMeta {
  const s = getSession(`s_${Date.now()}_${++sessionSeq}`)
  s.title = '新会话'
  persistSessions()
  return metaOf(s)
}

export function deleteSession(id: string): void {
  sessions.delete(id)
  persistSessions()
}

/** 更新会话元数据（模式/模型/项目/思考级别/标题） */
export function updateSession(id: string, patch: Partial<Pick<SessionState, 'title' | 'mode' | 'providerId' | 'projectId' | 'effort'>>): SessionMeta {
  const s = getSession(id)
  if (patch.title !== undefined) s.title = patch.title
  if (patch.mode !== undefined) s.mode = patch.mode
  if (patch.providerId !== undefined) s.providerId = patch.providerId
  if (patch.projectId !== undefined) s.projectId = patch.projectId
  if (patch.effort !== undefined) s.effort = patch.effort
  persistSessions()
  return metaOf(s)
}

export function resetSession(id: string): void {
  const s = getSession(id)
  s.messages = []
  s.sessionApproved.clear()
  persistSessions()
}

/** 用户点击"停止"：中断进行中的 LLM 流式调用，并在最近的检查点结束本回合 */
export function cancelSession(id: string): void {
  const s = getSession(id)
  if (!s.running) return
  s.cancelRequested = true
  s.abortCtrl?.abort()
}

const MAX_ITERATIONS = 24
/** 会话历史条数上限：超出时从最近的 user 边界截断，防止上下文与 sessions.json 无限膨胀 */
const MAX_MESSAGES = 200

/** 截断历史：截断点必须是 user 消息——Anthropic 协议要求首条消息为 user，且避免孤儿 tool 消息 */
function trimHistory(msgs: ChatMsg[]): ChatMsg[] {
  if (msgs.length <= MAX_MESSAGES) return msgs
  const start = msgs.length - MAX_MESSAGES
  for (let i = start; i < msgs.length; i++) {
    if (msgs[i].role === 'user') return msgs.slice(i)
  }
  // 窗口内没有 user 边界时向前找最近的一条（略超上限也可接受）
  for (let i = start - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs.slice(i)
  }
  return msgs.slice(start)
}

const TYPE_LABELS: Record<string, string> = {
  oracle: 'Oracle',
  mysql: 'MySQL',
  'ob-mysql': 'OceanBase 4.x（MySQL 租户）',
  'ob-oracle': 'OceanBase（Oracle 租户，暂未接入）'
}

const MODE_LINES: Record<PermissionMode, string> = {
  plan: `计划模式：只允许只读探索（查询/看结构/读项目文件），任何写操作都会被拒绝。
探索完成后调用 exit_plan_mode 提交计划，最终输出结构化执行计划：
## 执行计划
**目标**：一句话
**步骤**：编号列表，每步写明将执行的操作（含关键 SQL/文件写入，写全内容）
**影响与风险**：涉及的表/行数量级、可逆性、回滚方法
输出计划后结束回合，等待用户批准。批准后你将获得执行权限。`,
  readonly: '只读模式：只能执行只读查询，写操作一律拒绝',
  confirm: '确认执行模式：写操作会弹出确认框，请务必在执行前说明 SQL 的目的和影响范围。复杂任务应先调用 enter_plan_mode 规划',
  session: '会话放开模式：普通写操作本会话已获授权，高危操作（DROP/TRUNCATE 等）仍需逐次确认。复杂任务应先调用 enter_plan_mode 规划',
  yolo: '完全放开模式：所有操作自动执行——执行写操作前仍须先说明影响，谨慎行事。复杂任务仍建议先调用 enter_plan_mode 规划'
}

function fmtConnLine(c: ConnProfile, tag?: string): string {
  const target = c.type === 'oracle' ? `service=${c.serviceName}` : `db=${c.database || '(未指定)'}`
  return `- ${tag ? `[${tag}] ` : ''}${c.name}: ${TYPE_LABELS[c.type]} ${target} [${c.role === 'readonly' ? '只读账号' : '管理账号'}]`
}

function buildSystemPrompt(connections: ConnProfile[], mode: PermissionMode, project: ProjectConfig | undefined, skills: { name: string; description: string }[]): string {
  // 连接分两组：关联本项目的优先，其余全局连接仍可用
  const projConns = project ? connections.filter((c) => c.projectId === project.id) : []
  const otherConns = connections.filter((c) => !project || c.projectId !== project.id)
  const connLines = connections.length
    ? [
        ...projConns.map((c) => fmtConnLine(c, '本项目')),
        ...otherConns.map((c) => fmtConnLine(c, projConns.length ? '未关联' : undefined))
      ].join('\n')
    : '（当前未配置任何数据库连接：数据库类任务请提示用户先在左侧添加连接；文件读写（fs_*）与技能类任务可正常进行，无需数据库。）'

  const dialects: string[] = []
  if (connections.some((c) => c.type === 'oracle')) {
    dialects.push('- Oracle 11g 不支持 FETCH FIRST/LIMIT，分页用 ROWNUM；19c 两者都可用。动态 SQL 用绑定变量。v$ 视图无权限时给出替代方案并说明。')
  }
  if (connections.some((c) => c.type === 'ob-mysql' || c.type === 'mysql')) {
    dialects.push('- MySQL/OB MySQL 租户：用标准 MySQL 语法；OB 特有信息可查 oceanbase.GV$ 系统视图（如 GV$OB_SERVERS、CDB_OB_TENANTS 等，视权限而定）。')
  }

  const serverLines = project?.servers?.length
    ? '\n项目挂载的远程服务器（server_run/server_read_file/server_tail 操作；执行命令前先说明影响，注意 tag 标记）：\n' +
      project.servers.map((s) => `- ${s.name} [${s.tag || '未标记'}]: ${s.user}@${s.host}:${s.port}${s.note ? `（${s.note}）` : ''}`).join('\n') + '\n'
    : ''

  const projectBlock = project
    ? `\n当前绑定项目：${project.name}（根目录 ${project.rootPath}）。可用 fs_list/fs_read/fs_write 操作项目内文件（路径相对项目根），产出的报告/脚本等文件默认写入项目目录。${project.description ? `\n项目说明：${project.description}` : ''}\n`
    : ''

  const skillLines = skills.length
    ? '\n可用技能（任务匹配时先用 read_skill 读取全文，然后严格遵循其步骤执行）：\n' + skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') + '\n'
    : ''
  return `你是 SQLPilot，一名资深数据库管理员（DBA）AI 助手，运行在用户的 Windows 工作站上，直接操作用户配置的数据库。

当前可用数据库连接：
${connLines}
${projectBlock}${serverLines}${skillLines}
工作规则：
1. 所有数据库操作必须通过工具完成，并明确传 conn 参数（连接名，与上面列表一致）。
2. 不确定表结构时，先用 db_list_tables / db_describe_table / db_get_ddl 探索，再写 SQL，禁止凭猜测写表名列名。
3. 查询尽量加 WHERE 条件和行数限制，工具最多返回 500 行、预览 30 行。
4. SQL 报错时读取错误信息修正后重试（最多 2 次），仍失败则向用户说明原因和修复建议。
5. 当前权限模式：${MODE_LINES[mode]}
6. 自动规划：当任务涉及写操作、DDL 变更、多步骤执行或影响面较大时，即使当前模式允许写操作，也应先调用 enter_plan_mode 进入计划模式（用户也可手动切换模式，以更严格的为准）。
7. 本机操作：可通过 run_command 在用户电脑上执行系统命令（运行脚本、安装软件、查看状态等）、fs_delete 删除项目内文件、open_url 打开网页。执行有影响的操作（安装/修改系统/删除）前，必须先向用户说明将做什么、有什么影响；命令输出和退出码会返回给你，据此继续或修正。
${dialects.length ? '\n方言要点：\n' + dialects.join('\n') : ''}

回答要求：用中文；先给结论和关键数字，再给依据；展示 SQL 时用代码块。`
}

export async function runTurn(
  sessionId: string,
  text: string,
  provider: ProviderConfig,
  globalClientDir: string | undefined,
  deps: RunDeps
): Promise<void> {
  const sess = getSession(sessionId)
  if (sess.running) {
    deps.emit({ type: 'error', sessionId, error: '上一个任务仍在执行中，请等待完成或点击停止' })
    return
  }
  // 会话标题：首条用户消息截断
  if (!sess.messages.length || sess.title === '新会话') {
    sess.title = text.slice(0, 24) || '会话'
  }
  sess.running = true
  sess.cancelRequested = false
  sess.abortCtrl = new AbortController()
  try {
    sess.messages.push({ role: 'user', content: text })
    sess.messages = trimHistory(sess.messages)

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const cfg = loadConfig()
      const project = sess.projectId ? cfg.projects.find((p) => p.id === sess.projectId) : undefined
      const skills = listSkills().filter((s) => cfg.skillsEnabled[s.id] !== false)
      const system = buildSystemPrompt(cfg.connections, sess.mode, project, skills)
      const res = await callLlm(provider, system, sess.messages, TOOLS, {
        onText: (t) => deps.emit({ type: 'text', sessionId, text: t }),
        onReasoning: (t) => deps.emit({ type: 'reasoning', sessionId, text: t })
      }, { signal: sess.abortCtrl.signal, effort: sess.effort ?? undefined })
      sess.messages.push({ role: 'assistant', content: res.content || null, toolCalls: res.toolCalls, thinking: res.thinking, thinkingSig: res.thinkingSig })

      if (!res.toolCalls.length) {
        deps.emit({ type: 'done', sessionId })
        return
      }

      const cfg2 = loadConfig()
      const project2 = sess.projectId ? cfg2.projects.find((p) => p.id === sess.projectId) : undefined
      for (const tc of res.toolCalls) {
        if (sess.cancelRequested) break
        deps.emit({ type: 'tool-start', sessionId, tool: tc.name, args: tc.args })

        // 规划控制工具由会话层拦截处理（agent 自主进入/退出计划模式）
        if (tc.name === 'enter_plan_mode' || tc.name === 'exit_plan_mode') {
          let pr: { ok: boolean; result: string }
          if (tc.name === 'enter_plan_mode') {
            if (sess.mode === 'plan') {
              pr = { ok: false, result: JSON.stringify({ error: '已在计划模式中，继续探索并最终用 exit_plan_mode 提交计划' }) }
            } else {
              sess.mode = 'plan'
              persistSessions()
              deps.emit({ type: 'session-updated', sessionId, meta: metaOf(sess) })
              pr = { ok: true, result: JSON.stringify({ note: '已进入计划模式。接下来只读探索，完成后调用 exit_plan_mode 提交计划。' }) }
            }
          } else {
            if (sess.mode !== 'plan') {
              pr = { ok: false, result: JSON.stringify({ error: '当前不在计划模式，无需提交计划' }) }
            } else {
              pr = { ok: true, result: JSON.stringify({ note: '计划已呈现给用户。请输出完整的最终计划（若尚未输出），然后结束本回合等待批准。不要继续调用工具。' }) }
            }
          }
          deps.emit({ type: 'tool-end', sessionId, tool: tc.name, ok: pr.ok, result: pr.result })
          sess.messages.push({ role: 'tool', content: pr.result, toolCallId: tc.id, toolName: tc.name })
          continue
        }

        const ctx: ToolContext = {
          connections: cfg2.connections,
          globalClientDir,
          mode: sess.mode,
          sessionApproved: sess.sessionApproved,
          requestApproval: (req) => deps.requestApproval(req, sessionId),
          project: project2 ? { id: project2.id, name: project2.name, rootPath: project2.rootPath } : undefined,
          servers: project2?.servers || []
        }
        const r = await executeTool(tc.name, tc.args, ctx)
        deps.emit({ type: 'tool-end', sessionId, tool: tc.name, ok: r.ok, result: r.result })
        sess.messages.push({ role: 'tool', content: r.result, toolCallId: tc.id, toolName: tc.name })
      }
      if (sess.cancelRequested) break
    }
    if (sess.cancelRequested) {
      deps.emit({ type: 'done', sessionId, note: '已停止（当前任务被手动中断）' })
    } else {
      deps.emit({ type: 'done', sessionId, note: `已达最大迭代次数（${MAX_ITERATIONS}），任务暂停` })
    }
  } catch (e: any) {
    if (sess.cancelRequested) {
      deps.emit({ type: 'done', sessionId, note: '已停止（当前任务被手动中断）' })
    } else {
      const msg = String(e?.message || e)
      appendAudit({ kind: 'llm.error', detail: msg.slice(0, 500) })
      deps.emit({ type: 'error', sessionId, error: msg })
    }
  } finally {
    sess.running = false
    sess.abortCtrl = null
    persistSessions()
  }
}
