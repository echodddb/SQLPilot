import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, saveConfig } from './config'
import { setPassword, deletePassword, getPassword, secretsAvailable } from './secrets'
import { readAudit, appendAudit, queryAudit } from './audit'
import { getAdapter, dropAdapter, closeAll } from './db/manager'
import { testServer, openShell, shellInput, shellResize, closeShell, closeAll as sshCloseAll, sftpList, sftpDownload, sftpUpload } from './ssh'
import { classifySql } from './db/guard'
import { OracleAdapter } from './db/oracle'
import { MySqlAdapter } from './db/mysql'
import {
  runTurn, resetSession, cancelSession, loadPersistedSessions, persistSessions,
  getSession, listSessions, newSession, deleteSession, updateSession, summarizeDropped,
  type AgentEvent
} from './agent/loop'
import { callLlm } from './agent/llm'
import { appendArchive, readProjectArchiveFull } from './memory'
import { listSkills, saveSkill, deleteSkill, importSkill, importSkillPack, importSkillPackFromUrl, readSkill } from './skills'
import { cached, metaDropConn, metaGet, metaKeys, metaSet } from './meta'
import { buildCsv } from './csv'
import type { AppConfig, ConnProfile, EditSupport, ProjectConfig } from './types'
import type { ApprovalDecision, ApprovalRequest } from './tools'
import { listSubagentTasks, onSubtaskChange, stopSubagentTask } from './agent/subtask-registry'
import { readRunAudit } from './agent/subagent-audit'

let win: BrowserWindow | null = null
const pendingApprovals = new Map<string, { resolve: (d: ApprovalDecision) => void; sessionId: string }>()
let approvalSeq = 0
// LLM 发送前预览（按会话归属，停止/退出时兜底取消）
const pendingPreviews = new Map<string, { resolve: (ok: boolean) => void; sessionId: string }>()
let previewSeq = 0

function previewLlmRequest(url: string, body: any, sessionId: string): Promise<boolean> {
  if (!loadConfig().previewLlm) return Promise.resolve(true)
  return new Promise((resolve) => {
    const requestId = `pv_${++previewSeq}`
    pendingPreviews.set(requestId, { resolve, sessionId })
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('llm:preview', { requestId, sessionId, url, body })
      } catch {
        pendingPreviews.delete(requestId)
        resolve(false)
        return
      }
    } else {
      pendingPreviews.delete(requestId)
      resolve(false)
      return
    }
    // 超时 5 分钟未响应视为取消
    setTimeout(() => {
      const p = pendingPreviews.get(requestId)
      if (p) {
        pendingPreviews.delete(requestId)
        p.resolve(false)
        try { win?.webContents.send('llm:preview:expired', { requestId }) } catch { /* 忽略 */ }
      }
    }, 5 * 60_000)
  })
}

export function bindWindow(w: BrowserWindow): void {
  win = w
}

function emit(ev: AgentEvent): void {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('agent:event', ev) } catch { /* 窗口可能正在关闭 */ }
  }
}

function requestApproval(req: ApprovalRequest, sessionId: string): Promise<ApprovalDecision> {
  const requestId = `apr_${++approvalSeq}`
  return new Promise((resolve) => {
    pendingApprovals.set(requestId, { resolve, sessionId })
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('agent:confirm', { requestId, sessionId, ...req })
      } catch { /* 忽略 */ }
    }
    // 超时 5 分钟未响应视为拒绝
    setTimeout(() => {
      const p = pendingApprovals.get(requestId)
      if (p) {
        pendingApprovals.delete(requestId)
        p.resolve('deny')
        win?.webContents.send('agent:confirm:expired', { requestId })
      }
    }, 5 * 60_000)
  })
}

function resolveProvider(cfg: AppConfig, sessionId: string) {
  const sess = getSession(sessionId)
  return (
    cfg.providers.find((p) => p.id === sess.providerId) ||
    cfg.providers.find((p) => p.id === cfg.activeProviderId) ||
    null
  )
}

/** 会话归档总结的系统提示词 */
const ARCHIVE_SUMMARY_SYSTEM = '你是会话归档器。把这段 DBA 助手与用户的对话总结为紧凑备忘，供同项目后续会话作背景参考。300 字以内，中文，直接输出正文（无开场白/客套），涵盖：做了什么、关键结论与数字、涉及的库和表、未完成事项、用户的约定或偏好。'

export function registerIpc(): void {
  loadPersistedSessions()

  // ---------- 配置 ----------
  // API Key 不下发渲染层：真实值仅留在主进程内存，界面凭 hasKey 判断是否已保存
  ipcMain.handle('config:get', () => {
    const cfg = loadConfig()
    return { ...cfg, providers: cfg.providers.map((p) => ({ ...p, apiKey: '', hasKey: !!p.apiKey })) }
  })
  ipcMain.handle('config:set', (_e, cfg: AppConfig) => {
    // 渲染层拿到的是掩码 Key：空值回填主进程已存 Key，避免整份配置回存时误清
    // （DPAPI 不可用、明文回退落盘的场景下尤其重要）
    const cur = loadConfig()
    for (const p of cfg.providers) {
      if (!p.apiKey) {
        const old = cur.providers.find((x) => x.id === p.id)
        if (old?.apiKey) p.apiKey = old.apiKey
      }
    }
    saveConfig(cfg)
    return { ok: true }
  })

  // ---------- 连接管理 ----------
  ipcMain.handle('conn:save', (_e, { profile, password }: { profile: ConnProfile; password?: string }) => {
    const cfg = loadConfig()
    // 连接名全局唯一：agent 按名称寻址，重名会产生歧义
    const dup = cfg.connections.find((c) => c.name === profile.name && c.id !== profile.id)
    if (dup) {
      return { ok: false, error: `连接名「${profile.name}」已被其他连接使用（agent 按名称寻址，需唯一）` }
    }
    const idx = cfg.connections.findIndex((c) => c.id === profile.id)
    if (idx >= 0) cfg.connections[idx] = profile
    else cfg.connections.push(profile)
    saveConfig(cfg)
    metaDropConn(profile.id) // 连接参数变了，元数据缓存全部作废
    if (password !== undefined) setPassword(profile.id, password)
    dropAdapter(profile.id)
    return { ok: true }
  })

  ipcMain.handle('conn:delete', (_e, { id }: { id: string }) => {
    const cfg = loadConfig()
    cfg.connections = cfg.connections.filter((c) => c.id !== id)
    saveConfig(cfg)
    deletePassword(id)
    dropAdapter(id)
    metaDropConn(id)
    return { ok: true }
  })

  ipcMain.handle('conn:test', async (_e, { profile, password }: { profile: ConnProfile; password?: string }) => {
    if (profile.type === 'ob-oracle') {
      return { ok: false, error: 'OB Oracle 租户将在 M2 阶段接入（pyobclient 驱动），当前请使用 OB MySQL 租户连接' }
    }
    const pw = password !== undefined && password !== '' ? password : getPassword(profile.id)
    try {
      const adapter =
        profile.type === 'oracle'
          ? new OracleAdapter(profile, loadConfig().instantClientDir, pw)
          : new MySqlAdapter(profile, pw)
      try {
        const label = await adapter.test()
        return { ok: true, label }
      } finally {
        await adapter.close()
      }
    } catch (e: any) {
      // 连接测试失败落审计：弹窗一关报错就没了，这里留底便于排查
      appendAudit({ kind: 'conn', actor: 'human', conn: profile.name, target: `${profile.host}:${profile.port}`, detail: `连接测试失败 ${profile.type} ${profile.host}:${profile.port}`, error: String(e?.message || e).slice(0, 300) })
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('conn:schemas', async (_e, { id, refresh }: { id: string; refresh?: boolean }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === id)
    if (!profile) return { ok: false, error: '连接不存在' }
    try {
      const schemas = await cached(metaKeys.schemas(profile.id), !!refresh, () =>
        getAdapter(profile, cfg.instantClientDir).listSchemas()
      )
      return { ok: true, schemas }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('conn:tables', async (_e, { id, schema, refresh }: { id: string; schema: string; refresh?: boolean }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === id)
    if (!profile) return { ok: false, error: '连接不存在' }
    // Oracle 元数据一律大写规范化，保证缓存 key 与实际查询一致
    const s = profile.type === 'oracle' ? schema.toUpperCase() : schema
    try {
      const tables = await cached(metaKeys.tables(profile.id, s), !!refresh, () =>
        getAdapter(profile, cfg.instantClientDir).listTables(s)
      )
      return { ok: true, tables }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 会话（模式/模型/项目均为会话级） ----------
  ipcMain.handle('session:list', () => listSessions())
  ipcMain.handle('session:new', () => newSession())
  ipcMain.handle('session:delete', (_e, { id }: { id: string }) => {
    deleteSession(id)
    return { ok: true }
  })
  // 归档会话：总结对话内容写入项目归档（该项目其他会话的提示词会注入），
  // remove=true 同时删除会话（原"删除会话"），false 只清空（原"清空对话"）。
  // 总结走 LLM 需要数秒：每阶段向渲染层发 archive:progress 事件做前台提示
  ipcMain.handle('session:archive', async (_e, { id, remove }: { id: string; remove: boolean }) => {
    try {
      const cfg = loadConfig()
      const sess = getSession(id)
      if (sess.running) {
        return { ok: false, error: '会话正在执行任务，请先停止（或等它结束）再归档' }
      }
      const project = sess.projectId ? cfg.projects.find((p) => p.id === sess.projectId) : undefined
      let summary = ''
      let note: string
      if (!sess.messages.length) {
        note = '会话为空，未生成归档'
      } else if (!project) {
        note = '会话未绑定项目，内容未归档'
      } else {
        // LLM 总结（同样走发送前预览）；失败/取消回退本地抽取式摘要
        const provider = resolveProvider(cfg, id)
        if (provider) {
          win?.webContents.send('archive:progress', { id, stage: 'summary', note: `正在用模型总结「${sess.title}」…` })
          try {
            const res = await callLlm(provider, ARCHIVE_SUMMARY_SYSTEM, sess.messages, [], {}, {
              preview: (url, body) => previewLlmRequest(url, body, id)
            })
            summary = (res.content || '').trim()
          } catch {
            /* 模型不可用/预览取消：走本地回退 */
          }
        }
        if (!summary) {
          win?.webContents.send('archive:progress', { id, stage: 'summary', note: '模型总结不可用（失败或已在预览中取消），改用本地抽取摘要…' })
          summary = summarizeDropped(undefined, sess.messages)
        }
        win?.webContents.send('archive:progress', { id, stage: 'save', note: `写入项目「${project.name}」归档…` })
        appendArchive(project.name, sess.title, summary)
        note = `已归档到项目「${project.name}」`
      }
      if (remove) deleteSession(id)
      else resetSession(id)
      win?.webContents.send('archive:progress', { id, stage: 'done', note })
      return { ok: true, archived: !!summary, note, preview: summary.slice(0, 160) }
    } catch (e: any) {
      win?.webContents.send('archive:progress', { id, stage: 'error', note: String(e?.message || e).slice(0, 200) })
      return { ok: false, error: String(e?.message || e).slice(0, 300) }
    }
  })
  ipcMain.handle('archive:get', (_e, { projectId }: { projectId: string }) => {
    const cfg = loadConfig()
    const project = cfg.projects.find((p) => p.id === projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    return { ok: true, project: project.name, content: readProjectArchiveFull(project.name) || '' }
  })
  ipcMain.handle('session:update', (_e, { id, patch }: { id: string; patch: any }) => {
    updateSession(id, patch)
    return { ok: true, session: listSessions().find((s) => s.id === id) }
  })

  ipcMain.handle('chat:send', async (_e, { sessionId, text }: { sessionId: string; text: string }) => {
    const cfg = loadConfig()
    const sess = getSession(sessionId)
    if (!sess.projectId || !cfg.projects.some((p) => p.id === sess.projectId)) {
      emit({ type: 'error', sessionId, error: '本会话未绑定项目：请点击顶栏项目徽章（或左侧项目区）选择一个项目后再开始' })
      return { ok: false }
    }
    const provider = resolveProvider(cfg, sessionId)
    if (!provider) {
      emit({ type: 'error', sessionId, error: '尚未配置大模型：请点击右上角"设置"选择厂商和模型，或在顶栏选择本会话要用的模型' })
      return { ok: false }
    }
    // 数据库连接是可选能力：无连接时仍可对话（文件工具/技能可用），涉及数据库时模型会提示
    runTurn(sessionId, text, provider, cfg.instantClientDir, {
      emit,
      requestApproval,
      previewLlm: (url, body) => previewLlmRequest(url, body, sessionId)
    })
    return { ok: true }
  })

  ipcMain.handle('chat:reset', (_e, { sessionId }: { sessionId: string }) => {
    resetSession(sessionId)
    return { ok: true }
  })

  ipcMain.handle('chat:history', (_e, { sessionId }: { sessionId: string }) => {
    return { ok: true, messages: getSession(sessionId).messages }
  })

  ipcMain.handle('chat:stop', (_e, { sessionId }: { sessionId: string }) => {
    cancelSession(sessionId)
    // 只拒绝本会话挂起的确认与预览，不影响其他并发会话
    for (const [requestId, p] of pendingApprovals) {
      if (p.sessionId !== sessionId) continue
      p.resolve('deny')
      pendingApprovals.delete(requestId)
      win?.webContents.send('agent:confirm:expired', { requestId })
    }
    for (const [requestId, p] of pendingPreviews) {
      if (p.sessionId !== sessionId) continue
      p.resolve(false)
      pendingPreviews.delete(requestId)
      win?.webContents.send('llm:preview:expired', { requestId })
    }
    return { ok: true }
  })

  // ---------- 项目 ----------
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { ok: false }
    return { ok: true, path: r.filePaths[0] }
  })

  ipcMain.handle('project:save', (_e, { project, serverPasswords }: { project: ProjectConfig; serverPasswords?: Record<string, string> }) => {
    // 同项目服务器名唯一（agent 按名称寻址）
    const names = (project.servers || []).map((s) => s.name.trim())
    if (new Set(names).size !== names.length) {
      return { ok: false, error: '同一项目内服务器名称不能重复（agent 按名称寻址）' }
    }
    const cfg = loadConfig()
    const idx = cfg.projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) cfg.projects[idx] = project
    else cfg.projects.push(project)
    saveConfig(cfg)
    // 服务器密码单独走 DPAPI 加密；空密码 = 保持已存
    for (const s of project.servers || []) {
      const pw = serverPasswords?.[s.id]
      if (pw) setPassword(`server:${s.id}`, pw)
    }
    return { ok: true }
  })

  ipcMain.handle('project:delete', (_e, { id }: { id: string }) => {
    const cfg = loadConfig()
    const proj = cfg.projects.find((p) => p.id === id)
    cfg.projects = cfg.projects.filter((p) => p.id !== id)
    saveConfig(cfg)
    for (const s of proj?.servers || []) {
      deletePassword(`server:${s.id}`)
    }
    // 解除会话上的绑定
    for (const s of listSessions()) {
      if (s.projectId === id) updateSession(s.id, { projectId: null })
    }
    return { ok: true }
  })

  // ---------- SSH 服务器 ----------
  ipcMain.handle('server:test', async (_e, { server, password }: { server: any; password?: string }) => {
    try {
      const label = await testServer(server, password || undefined)
      return { ok: true, label }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 交互式 SSH 终端 ----------
  const currentProject = () => {
    const cfg = loadConfig()
    return cfg.projects
  }

  ipcMain.handle('term:open', async (_e, { termId, serverId }: { termId: string; serverId: string }) => {
    const proj = currentProject().find((p) => p.servers?.some((s) => s.id === serverId))
    const server = proj?.servers?.find((s) => s.id === serverId)
    if (!server) return { ok: false, error: '服务器不存在（可能在其他项目或已删除）' }
    try {
      await openShell(
        termId,
        server,
        (d) => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('term:data', { termId, data: d }) } catch { /* 忽略 */ }
          }
        },
        () => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('term:exit', { termId }) } catch { /* 忽略 */ }
          }
        }
      )
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('term:input', (_e, { termId, data }: { termId: string; data: string }) => {
    shellInput(termId, data)
    return { ok: true }
  })

  ipcMain.handle('term:resize', (_e, { termId, cols, rows }: { termId: string; cols: number; rows: number }) => {
    shellResize(termId, cols, rows)
    return { ok: true }
  })

  ipcMain.handle('term:close', (_e, { termId }: { termId: string }) => {
    closeShell(termId)
    return { ok: true }
  })

  // ---------- SFTP 文件浏览器 ----------
  const findServer = (serverId: string) => {
    for (const p of loadConfig().projects) {
      const s = p.servers?.find((x) => x.id === serverId)
      if (s) return s
    }
    return null
  }

  ipcMain.handle('sftp:list', async (_e, { serverId, path: p }: { serverId: string; path: string }) => {
    const s = findServer(serverId)
    if (!s) return { ok: false, error: '服务器不存在' }
    try {
      return { ok: true, entries: await sftpList(s, p || '.') }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sftp:download', async (_e, { serverId, remotePath, localDir }: { serverId: string; remotePath: string; localDir: string }) => {
    const s = findServer(serverId)
    if (!s) return { ok: false, error: '服务器不存在' }
    try {
      // 本地目录必须为绝对路径；未绑定项目时落到 userData/downloads，避免误写应用目录
      let dir = String(localDir || '')
      if (!/^[a-zA-Z]:[\\/]/.test(dir) && !dir.startsWith('\\\\')) {
        dir = path.join(app.getPath('userData'), 'downloads')
      }
      let name = remotePath.split('/').pop() || 'file'
      name = name.replace(/[\\/:*?"<>|]/g, '_')
      if (name === '.' || name === '..' || !name) name = 'file'
      const local = path.join(dir, name)
      await sftpDownload(s, remotePath, local)
      appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: `${remotePath} → ${local}`, detail: `sftp 下载 ${remotePath} → ${local}` })
      return { ok: true, local }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('sftp:upload', async (_e, { serverId, remoteDir }: { serverId: string; remoteDir: string }) => {
    const s = findServer(serverId)
    if (!s) return { ok: false, error: '服务器不存在' }
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    try {
      for (const f of r.filePaths) {
        const name = f.split(/[\\/]/).pop() || 'file'
        await sftpUpload(s, f, remoteDir.replace(/\/+$/, '') + '/' + name)
        appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: `${f} → ${remoteDir}`, detail: `sftp 上传 ${f} → ${remoteDir}` })
      }
      return { ok: true, count: r.filePaths.length }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('shell:showInFolder', (_e, { p }: { p: string }) => {
    if (/^[a-zA-Z]:[\\/]/.test(String(p)) || String(p).startsWith('\\\\')) shell.showItemInFolder(String(p))
    return { ok: true }
  })

  // ---------- SQL 控制台（人工执行，走审计，不做 agent 门控） ----------
  // sessionKey = 查询窗口 id：每个窗口独立数据库会话，事务互不可见（Navicat 行为）
  ipcMain.handle('sql:run', async (_e, { connId, sql, sessionKey }: { connId: string; sql: string; sessionKey?: string }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    const v = classifySql(sql)
    const isOracle = profile.type === 'oracle'
    // 按数据库特性处理事务：Oracle 本身无自动提交——控制台 DML 保持事务打开，
    // 由用户显式 COMMIT/ROLLBACK（DDL 在 Oracle 内部隐式提交，属数据库自身行为）；
    // MySQL/OB 连接为原生 autocommit，无需额外提交
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir, sessionKey)
      const r = await adapter.query(sql, 500, 60_000)
      appendAudit({ kind: v.ok ? 'sql.read' : 'sql.write', actor: 'human', conn: profile.name, target: '(查询窗口)', detail: '查询窗口执行', sql, rows: r.rowCount, ms: r.ms, mode: 'human', approved: v.ok ? undefined : true })
      // 控制台执行了 DDL：该连接的元数据缓存全部失效（表/列结构可能已变）
      if (v.kind === 'ddl') metaDropConn(connId)
      const head = (sql.trim().replace(/^(--[^\n]*\r?\n|\/\*[\s\S]*?\*\/|\s)+/, '').match(/^[a-zA-Z]+/)?.[0] || '').toUpperCase()
      // 写语句没有结果网格，给一条明确的成功/事务状态消息
      let message: string | undefined
      if (head === 'COMMIT') {
        message = '已提交(COMMIT)'
      } else if (head === 'ROLLBACK') {
        message = '已回滚(ROLLBACK)'
      } else if (!v.ok) {
        if (v.kind === 'dml' || v.kind === 'multi') {
          message = isOracle
            ? `影响 ${r.rowCount} 行 · 事务未提交（COMMIT 生效 / ROLLBACK 回滚）`
            : `影响 ${r.rowCount} 行`
        } else {
          message = '执行成功'
        }
      }
      return {
        ok: true,
        result: { columns: r.columns, rows: r.rows.slice(0, 200), rowCount: r.rowCount, truncated: r.rows.length > 200, ms: r.ms, kind: v.kind, message }
      }
    } catch (e: any) {
      appendAudit({ kind: v.ok ? 'sql.read' : 'sql.write', actor: 'human', conn: profile.name, target: '(查询窗口)', detail: '查询窗口执行失败', sql, mode: 'human', approved: v.ok ? undefined : false, error: String(e?.message || e).slice(0, 200) })
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // 关闭查询窗口时释放其独立会话（未提交事务随断连由数据库回滚）
  ipcMain.handle('sql:closeSession', (_e, { connId, sessionKey }: { connId: string; sessionKey: string }) => {
    dropAdapter(connId, sessionKey)
    return { ok: true }
  })

  // ---------- 对象浏览器（Navicat 式只读浏览：数据分页/结构/DDL） ----------
  const quoteIdent = (isOracle: boolean, name: string): string =>
    isOracle ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``

  // 行数缓存：同表同条件 10 秒内翻页复用 COUNT，避免大表反复全表计数
  const objCountCache = new Map<string, { total: number; at: number }>()

  ipcMain.handle('obj:data', async (_e, { connId, schema, table, page, pageSize, where, orderBy, orderDir }: {
    connId: string; schema: string; table: string; page?: number; pageSize?: number; where?: string; orderBy?: string; orderDir?: string
  }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir)
      const isOracle = profile.type === 'oracle'
      const s = isOracle ? schema.toUpperCase() : schema
      const t = isOracle ? table.toUpperCase() : table
      const ident = `${quoteIdent(isOracle, s)}.${quoteIdent(isOracle, t)}`
      const cond = String(where || '').trim().replace(/^where\s+/i, '')
      const whereSql = cond ? ` WHERE ${cond}` : ''
      const orderSql = orderBy ? ` ORDER BY ${quoteIdent(isOracle, orderBy)} ${orderDir === 'desc' ? 'DESC' : 'ASC'}` : ''
      const p = Math.min(Math.max(Number(page) || 1, 1), 1_000_000)
      const size = Math.min(Math.max(Number(pageSize) || 50, 10), 500)
      const lo = (p - 1) * size
      const hi = lo + size
      // Oracle 11g 无 FETCH FIRST：三层嵌套 ROWNUM 分页（ORDER BY 必须在最内层）。
      // 最内层同时取 rowid 作为网格编辑的行标识（__RID 随后剥出，不进网格）
      const withRid = isOracle
        ? `SELECT * FROM (SELECT t.*, ROWNUM rn FROM (SELECT x.*, x.rowid AS "__RID" FROM ${ident} x${whereSql}${orderSql}) t WHERE ROWNUM <= ${hi}) WHERE rn > ${lo}`
        : ''
      const plain = isOracle
        ? `SELECT * FROM (SELECT t.*, ROWNUM rn FROM (SELECT * FROM ${ident}${whereSql}${orderSql}) t WHERE ROWNUM <= ${hi}) WHERE rn > ${lo}`
        : `SELECT * FROM ${ident}${whereSql}${orderSql} LIMIT ${lo}, ${size}`
      let data
      try {
        data = await adapter.query(withRid || plain, size, 60_000)
      } catch (e: any) {
        // 视图（尤其含 DISTINCT/GROUP BY/JOIN 的）不能选 rowid：降级为普通查询，本页不可编辑
        if (!isOracle || !/00904|01446|invalid identifier/i.test(String(e?.message ?? e))) throw e
        data = await adapter.query(plain, size, 60_000)
      }
      const cacheKey = `${connId}|${s}|${t}|${cond}`
      let total: number
      const cachedCnt = objCountCache.get(cacheKey)
      if (cachedCnt && Date.now() - cachedCnt.at < 10_000) {
        total = cachedCnt.total
      } else {
        const cnt = await adapter.query(`SELECT COUNT(*) AS CNT FROM ${ident}${whereSql}`, 1, 60_000)
        total = Number(cnt.rows[0]?.[0]) || 0
        if (objCountCache.size > 200) objCountCache.clear()
        objCountCache.set(cacheKey, { total, at: Date.now() })
      }
      let columns = data.columns
      let rows = data.rows
      let rids: string[] | undefined
      if (isOracle) {
        const ridIdx = columns.indexOf('__RID')
        if (ridIdx >= 0) {
          rids = rows.map((r) => (r[ridIdx] == null ? '' : String(r[ridIdx])))
          columns = columns.filter((_, i) => i !== ridIdx)
          rows = rows.map((r) => r.filter((_, i) => i !== ridIdx))
        }
      }
      if (isOracle && columns.length && columns[columns.length - 1] === 'RN') {
        columns = columns.slice(0, -1)
        rows = rows.map((r) => r.slice(0, -1))
      }
      return { ok: true, columns, rows, total, ms: data.ms, rids }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('obj:describe', async (_e, { connId, schema, table, refresh }: { connId: string; schema: string; table: string; refresh?: boolean }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    const s = profile.type === 'oracle' ? schema.toUpperCase() : schema
    const t = profile.type === 'oracle' ? table.toUpperCase() : table
    try {
      const info = await cached(metaKeys.describe(connId, s, t), !!refresh, () =>
        getAdapter(profile, cfg.instantClientDir).describeTable(s, t)
      )
      return { ok: true, info }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('obj:ddl', async (_e, { connId, schema, table }: { connId: string; schema: string; table: string }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    try {
      const ddl = await getAdapter(profile, cfg.instantClientDir).getDdl(schema, table)
      return { ok: true, ddl }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 结果网格编辑（对象浏览器数据页，人类通道：审计留痕，同 SQL 控制台） ----------

  ipcMain.handle('obj:editInfo', async (_e, { connId, schema, table, refresh }: { connId: string; schema: string; table: string; refresh?: boolean }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    const s = profile.type === 'oracle' ? schema.toUpperCase() : schema
    const t = profile.type === 'oracle' ? table.toUpperCase() : table
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir)
      if (!adapter.editSupport) {
        return { ok: true, editable: false, reason: '该数据库类型暂不支持网格编辑', keyMode: 'cols', keyCols: [], readonlyCols: [] }
      }
      const info = await cached(metaKeys.edit(connId, s, t), !!refresh, () => adapter.editSupport!(s, t))
      return { ok: true, ...info }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('obj:saveEdits', async (_e, { connId, sessionKey, schema, table, keyMode, keyCols, edits }: {
    connId: string
    sessionKey: string
    schema: string
    table: string
    keyMode: 'rowid' | 'cols'
    keyCols: string[]
    edits: { rid?: string; keys?: any[]; col: string; value: string | null }[]
  }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    if (!sessionKey) return { ok: false, error: '缺少会话标识' }
    if (!Array.isArray(edits) || !edits.length) return { ok: false, error: '没有要保存的修改' }
    const isOracle = profile.type === 'oracle'
    const s = isOracle ? schema.toUpperCase() : schema
    const t = isOracle ? table.toUpperCase() : table
    const ident = `${quoteIdent(isOracle, s)}.${quoteIdent(isOracle, t)}`
    // 列名校验：合法标识符 + 不在只读列清单（虚拟列/生成列）。值全部绑定变量，列名/表名全部引号转义
    // 缓存未命中时回查一次（只读列防线不能依赖渲染层是否已取过 editInfo）
    let es = metaGet<EditSupport>(metaKeys.edit(connId, s, t))
    if (!es) {
      const metaAdapter = getAdapter(profile, cfg.instantClientDir)
      if (metaAdapter.editSupport) {
        es = await metaAdapter.editSupport(s, t)
        metaSet(metaKeys.edit(connId, s, t), es)
      }
    }
    const ro = new Set((es?.readonlyCols || []).map((c) => (isOracle ? c.toUpperCase() : c)))
    const colOk = (name: string) => /^[A-Za-z_][\w$#]*$/.test(name) && !ro.has(isOracle ? name.toUpperCase() : name)
    // 每 tab 独立数据库会话：Oracle 的未提交事务与其他窗口/agent 互不可见
    const adapter = getAdapter(profile, cfg.instantClientDir, sessionKey)
    const conflicts: number[] = []
    let applied = 0
    try {
      if (!isOracle) await adapter.query('START TRANSACTION', 1, 10_000)
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i]
        if (!colOk(String(e.col))) throw new Error(`列 "${e.col}" 不可更新（只读列或非法标识符）`)
        if (isOracle) {
          if (!e.rid) throw new Error('本页数据没有行标识（rowid），请刷新后重试')
          const r = await adapter.query(
            `UPDATE ${ident} SET ${quoteIdent(true, String(e.col))} = :v WHERE rowid = :rid`,
            1, 30_000, { v: e.value, rid: e.rid }
          )
          if (r.rowCount === 0) conflicts.push(i)
          else applied++
        } else {
          if (!Array.isArray(e.keys) || e.keys.length !== keyCols.length) throw new Error('行键值缺失，请刷新后重试')
          const where = keyCols.map((k) => `${quoteIdent(false, k)} = ?`).join(' AND ')
          const r = await adapter.query(
            `UPDATE ${ident} SET ${quoteIdent(false, String(e.col))} = ? WHERE ${where}`,
            1, 30_000, [e.value, ...e.keys]
          )
          if (r.rowCount === 0) conflicts.push(i)
          else applied++
        }
      }
      // MySQL 侧整批原子：有冲突全部回滚；Oracle 保持事务打开，由工具栏 ✓/↩ 决定
      if (!isOracle) {
        await adapter.query(conflicts.length ? 'ROLLBACK' : 'COMMIT', 1, 10_000)
      }
      appendAudit({
        kind: 'sql.write', actor: 'human', conn: profile.name, target: `${s}.${t}`,
        detail: `网格编辑：${applied} 处修改${conflicts.length ? `，${conflicts.length} 处冲突` : ''}${isOracle ? '（未提交）' : ''}`,
        rows: applied, mode: 'human', approved: true
      })
      return { ok: true, applied, conflicts, uncommitted: isOracle }
    } catch (e: any) {
      if (!isOracle) {
        try { await adapter.query('ROLLBACK', 1, 10_000) } catch { /* 忽略 */ }
      }
      appendAudit({ kind: 'sql.write', actor: 'human', conn: profile.name, target: `${s}.${t}`, detail: '网格编辑保存失败', mode: 'human', approved: false, error: String(e?.message || e).slice(0, 200) })
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 查询结果导出（CSV，Excel 可直接打开；重新执行查询取全量，不限于界面显示的行数） ----------
  const EXPORT_MAX_ROWS = 100_000

  ipcMain.handle('export:result', async (_e, { connId, sessionKey, sql, columns }: {
    connId: string
    sessionKey: string
    sql: string
    columns: string[]
  }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === connId)
    if (!profile) return { ok: false, error: '连接不存在' }
    if (!sql?.trim()) return { ok: false, error: '当前窗口还没有执行过查询' }
    if (!Array.isArray(columns) || !columns.length) return { ok: false, error: '至少选择一列' }
    const v = classifySql(sql)
    if (!v.ok) return { ok: false, error: '只能导出查询语句（SELECT/SHOW 等）的结果' }
    try {
      const ts = new Date()
      const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
      const r = await dialog.showSaveDialog(win!, {
        title: '导出查询结果',
        defaultPath: `查询结果_${stamp}.csv`,
        filters: [{ name: 'CSV（Excel 可直接打开）', extensions: ['csv'] }]
      })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true }
      // 与显示同源（同一 sessionKey 会话）重新执行，取全量行（上限 10 万）
      const adapter = getAdapter(profile, cfg.instantClientDir, sessionKey)
      const res = await adapter.query(sql, EXPORT_MAX_ROWS, 120_000)
      const csv = buildCsv(res.columns, res.rows, columns)
      await fs.writeFile(r.filePath, csv, 'utf8')
      appendAudit({ kind: 'tool', actor: 'human', conn: profile.name, target: r.filePath, detail: `导出查询结果 ${res.rows.length} 行 × ${columns.length} 列`, rows: res.rows.length })
      return { ok: true, path: r.filePath, rows: res.rows.length, truncated: res.rows.length >= EXPORT_MAX_ROWS }
    } catch (e: any) {
      appendAudit({ kind: 'tool', actor: 'human', conn: profile.name, detail: '导出查询结果失败', sql: sql.slice(0, 500), error: String(e?.message || e).slice(0, 200) })
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 数据库信息面板（Navicat 式概览，逐项容错：无权限的项自动略过） ----------
  interface InfoSection { title: string; rows: { k: string; v: string }[] }
  interface InfoTable { title: string; columns: string[]; rows: any[][] }

  async function tryQuery(adapter: any, sql: string): Promise<any[][] | null> {
    try {
      const r = await adapter.query(sql, 500, 30_000)
      return r.rows as any[][]
    } catch {
      return null
    }
  }

  const fmtMB = (bytes: any): string => {
    const n = Number(bytes) || 0
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`
  }
  const fmtUptime = (sec: any): string => {
    const s = Number(sec) || 0
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    return d > 0 ? `${d} 天 ${h} 小时` : `${h} 小时 ${Math.floor((s % 3600) / 60)} 分`
  }

  async function oracleInfo(adapter: any): Promise<{ sections: InfoSection[]; tables: InfoTable[] }> {
    const sections: InfoSection[] = []
    const tables: InfoTable[] = []

    const banner = await tryQuery(adapter, `SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'`)
    const inst = await tryQuery(adapter, `SELECT instance_name, host_name, status, TO_CHAR(startup_time, 'YYYY-MM-DD HH24:MI') FROM v$instance`)
    const db = await tryQuery(adapter, `SELECT name, TO_CHAR(created, 'YYYY-MM-DD'), log_mode, open_mode FROM v$database`)
    const nls = await tryQuery(adapter, `SELECT parameter, value FROM nls_database_parameters WHERE parameter IN ('NLS_LANGUAGE','NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET')`)

    const rows: { k: string; v: string }[] = []
    if (banner?.length) rows.push({ k: '数据库产品', v: String(banner[0][0]) })
    if (db?.length) {
      rows.push({ k: '数据库名', v: String(db[0][0]) }, { k: '创建时间', v: String(db[0][1]) },
        { k: '归档模式', v: String(db[0][2]) }, { k: '打开模式', v: String(db[0][3]) })
    }
    if (inst?.length) {
      rows.push({ k: '实例', v: String(inst[0][0]) }, { k: '主机', v: String(inst[0][1]) },
        { k: '实例状态', v: String(inst[0][2]) }, { k: '启动时间', v: String(inst[0][3]) })
    }
    if (nls?.length) for (const r of nls) rows.push({ k: String(r[0]), v: String(r[1]) })
    if (rows.length) sections.push({ title: '服务器', rows })

    const sess = await tryQuery(adapter, `SELECT COUNT(*), COUNT(CASE WHEN wait_class <> 'Idle' AND username IS NOT NULL THEN 1 END) FROM v$session`)
    if (sess) {
      sections.push({
        title: '会话',
        rows: [
          { k: '会话总数', v: String(sess[0][0]) },
          { k: '活跃会话', v: `${sess[0][1]}（非 Idle 且有用户名，详见下方列表）` }
        ]
      })
    }

    const ts = await tryQuery(adapter, `
      SELECT df.tablespace_name,
             ROUND(df.mb, 1),
             ROUND(NVL(fr.mb, 0), 1),
             ROUND((df.mb - NVL(fr.mb, 0)) / df.mb * 100, 1)
      FROM (SELECT tablespace_name, SUM(bytes) / 1048576 mb FROM dba_data_files GROUP BY tablespace_name) df
      LEFT JOIN (SELECT tablespace_name, SUM(bytes) / 1048576 mb FROM dba_free_space GROUP BY tablespace_name) fr
        ON df.tablespace_name = fr.tablespace_name
      ORDER BY (df.mb - NVL(fr.mb, 0)) DESC`)
    if (ts) tables.push({ title: '表空间使用（需 DBA 视图权限）', columns: ['表空间', '总量 MB', '空闲 MB', '已用 %'], rows: ts })

    const objs = await tryQuery(adapter, `SELECT object_type, COUNT(*) FROM user_objects GROUP BY object_type ORDER BY 1`)
    if (objs) tables.push({ title: '当前用户对象统计', columns: ['对象类型', '数量'], rows: objs })

    const sga = await tryQuery(adapter, `SELECT name, value FROM v$sgainfo WHERE name IN ('Buffer Cache Size','Shared Pool Size','Large Pool Size','Java Pool Size','Maximum SGA Size')`)
    if (sga) {
      sections.push({ title: '内存（SGA）', rows: sga.map((r) => ({ k: String(r[0]), v: fmtMB(r[1]) })) })
    }
    return { sections, tables }
  }

  async function mysqlInfo(adapter: any, isOb: boolean): Promise<{ sections: InfoSection[]; tables: InfoTable[] }> {
    const sections: InfoSection[] = []
    const tables: InfoTable[] = []

    const ver = await tryQuery(adapter, `SELECT VERSION()`)
    const rows: { k: string; v: string }[] = []
    if (ver?.length) rows.push({ k: '数据库版本', v: String(ver[0][0]) })
    if (isOb) {
      const obv = await tryQuery(adapter, `SELECT ob_version()`)
      if (obv?.length) rows.push({ k: 'OceanBase 版本', v: String(obv[0][0]) })
      const tenant = await tryQuery(adapter, `SELECT tenant_name FROM oceanbase.DBA_OB_TENANTS WHERE tenant_id = (SELECT effective_tenant_id())`)
      if (tenant?.length) rows.push({ k: '当前租户', v: String(tenant[0][0]) })
    }
    const vc = await tryQuery(adapter, `SHOW VARIABLES WHERE Variable_name IN ('version_comment','character_set_server','collation_server','max_connections','innodb_buffer_pool_size','lower_case_table_names','read_only')`)
    if (vc) {
      const map = new Map(vc.map((r) => [String(r[0]), r[1]]))
      const label: Record<string, string> = {
        version_comment: '发行说明', character_set_server: '服务器字符集', collation_server: '排序规则',
        max_connections: '最大连接数', innodb_buffer_pool_size: 'InnoDB 缓冲池', lower_case_table_names: '大小写敏感', read_only: '只读模式'
      }
      for (const [k, cn] of Object.entries(label)) {
        if (map.has(k)) rows.push({ k: cn, v: k === 'innodb_buffer_pool_size' ? fmtMB(map.get(k)) : String(map.get(k)) })
      }
    }
    if (rows.length) sections.push({ title: '服务器', rows })

    const st = await tryQuery(adapter, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Questions','Slow_queries','Aborted_connects')`)
    if (st) {
      const map = new Map(st.map((r) => [String(r[0]), r[1]]))
      const label: [string, string, ((v: any) => string) | null][] = [
        ['Uptime', '已运行', fmtUptime], ['Threads_connected', '当前连接数', null], ['Threads_running', '活跃连接数', null],
        ['Max_used_connections', '历史峰值连接', null], ['Questions', '累计查询数', null], ['Slow_queries', '慢查询数', null], ['Aborted_connects', '中断连接数', null]
      ]
      const srows: { k: string; v: string }[] = []
      for (const [k, cn, f] of label) if (map.has(k)) srows.push({ k: cn, v: f ? f(map.get(k)) : String(map.get(k)) })
      if (srows.length) sections.push({ title: '运行状态', rows: srows })
    }

    const size = await tryQuery(adapter, `
      SELECT table_schema, COUNT(*), IFNULL(ROUND(SUM(data_length + index_length) / 1048576, 1), 0)
      FROM information_schema.tables
      WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys','oceanbase','SYS','LBACSYS','ORAAUDITOR','__public__')
      GROUP BY table_schema ORDER BY SUM(data_length + index_length) DESC LIMIT 15`)
    if (size) tables.push({ title: '库容量 TOP 15', columns: ['数据库', '表数', '数据量 MB'], rows: size })

    if (isOb) {
      const zones = await tryQuery(adapter, `SELECT zone, svr_ip, status FROM oceanbase.GV$OB_SERVERS ORDER BY zone`)
      if (zones) tables.push({ title: 'OB 节点（GV$OB_SERVERS）', columns: ['Zone', '服务器', '状态'], rows: zones })
    }
    return { sections, tables }
  }

  ipcMain.handle('conn:info', async (_e, { id }: { id: string }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === id)
    if (!profile) return { ok: false, error: '连接不存在' }
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir)
      // 先显式建连：账号/网络错误直接透出，而不是显示成"未采集到信息"
      await adapter.connect()
      const data = profile.type === 'oracle'
        ? await oracleInfo(adapter)
        : await mysqlInfo(adapter, profile.type === 'ob-mysql')
      return { ok: true, ...data }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- Oracle 活跃会话（交互块：列可选 + 可刷新） ----------
  // 默认列 = 用户指定的排障常用列；实际列集以当前库 GV$SESSION 的真实结构为准（各版本不同），
  // 先用 metaData 探测，再取 请求列∩实际列 构建："SELECT <cols> FROM gv$session
  //   WHERE wait_class <> 'Idle' AND username IS NOT NULL ORDER BY last_call_et"
  const ACTIVE_SESSION_DEFAULT_COLS = [
    'INST_ID', 'SID', 'SERIAL#', 'USERNAME', 'TADDR', 'SQL_ID', 'PREV_SQL_ID',
    'EVENT', 'PROGRAM', 'STATE', 'LAST_CALL_ET', 'LOGON_TIME', 'BLOCKING_SESSION', 'BLOCKING_INSTANCE'
  ]

  ipcMain.handle('conn:activeSessions', async (_e, { id, columns }: { id: string; columns?: string[] }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === id)
    if (!profile) return { ok: false, error: '连接不存在' }
    if (profile.type !== 'oracle') return { ok: false, error: '仅 Oracle 连接支持活跃会话查询' }
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir)
      await adapter.connect()
      // 探测真实列：SELECT * 取一行 metaData（无需 DESC，也避免 GV_$SESSION 命名差异）
      const probe = await adapter.query('SELECT * FROM gv$session WHERE ROWNUM <= 1', 1, 30_000)
      const available = (probe.columns || []).map((c: string) => String(c).toUpperCase())
      const wanted = (columns?.length ? columns : ACTIVE_SESSION_DEFAULT_COLS).map((c: string) => String(c).toUpperCase())
      const use = [...new Set(wanted)].filter((c) => available.includes(c))
      if (!use.length) {
        return { ok: false, error: `所选列在 gv$session 中均不存在。可用列: ${available.join(', ')}` }
      }
      const q = (name: string) => `"${name.replace(/"/g, '""')}"`
      const order = available.includes('LAST_CALL_ET') ? ' ORDER BY last_call_et' : ''
      const sql = `SELECT ${use.map(q).join(', ')} FROM gv$session WHERE wait_class <> 'Idle' AND username IS NOT NULL${order}`
      const r = await adapter.query(sql, 500, 60_000)
      const skipped = wanted.filter((c) => !use.includes(c))
      return {
        ok: true,
        available,
        columns: use,
        rows: r.rows,
        ms: r.ms,
        note: skipped.length ? `本版本无这些列，已忽略: ${skipped.join(', ')}` : undefined
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 技能 ----------
  ipcMain.handle('skill:list', () => {
    const cfg = loadConfig()
    return listSkills().map((s) => ({ ...s, enabled: cfg.skillsEnabled[s.id] !== false }))
  })

  ipcMain.handle('skill:save', (_e, { id, name, description, content }: { id?: string; name: string; description: string; content: string }) => {
    saveSkill(id || '', name, description, content)
    return { ok: true }
  })

  ipcMain.handle('skill:delete', (_e, { id }: { id: string }) => {
    deleteSkill(id)
    return { ok: true }
  })

  ipcMain.handle('skill:read', (_e, { id, resourcePath }: { id: string; resourcePath?: string }) => {
    try {
      const s = readSkill(id, resourcePath)
      return { ok: true, content: s.content }
    } catch (e: any) {
      return { ok: false, content: '', error: String(e?.message || e) }
    }
  })

  ipcMain.handle('skill:toggle', (_e, { id, enabled }: { id: string; enabled: boolean }) => {
    const cfg = loadConfig()
    cfg.skillsEnabled[id] = enabled
    saveConfig(cfg)
    return { ok: true }
  })

  ipcMain.handle('skill:import', async (_e) => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: '技能文件 / 技能包', extensions: ['md', 'zip'] }]
    })
    if (r.canceled || !r.filePaths.length) return { ok: false }
    const p = r.filePaths[0]
    try {
      const stat = await fs.stat(p)
      if (stat.isDirectory() || /\.zip$/i.test(p)) {
        const pack = await importSkillPack(p)
        appendAudit({ kind: 'tool', actor: 'human', detail: `导入技能包 ${path.basename(p)}：新增 ${pack.imported.length} 个，更新 ${pack.updated.length} 个` })
        return { ok: true, pack }
      }
      const s = importSkill(p)
      return { ok: true, skill: s }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // 从 URL 导入技能包：GitHub 仓库链接自动转 zip 下载（如 https://github.com/oracle/oracle-skills）
  ipcMain.handle('skill:importUrl', async (_e, { url }: { url: string }) => {
    try {
      const pack = await importSkillPackFromUrl(url)
      appendAudit({ kind: 'tool', actor: 'human', detail: `从 URL 导入技能包 ${String(url).slice(0, 200)}：新增 ${pack.imported.length} 个，更新 ${pack.updated.length} 个` })
      return { ok: true, pack }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 模型提供商测试 ----------
  ipcMain.handle('provider:test', async (_e, { provider, apiKey }: { provider: any; apiKey?: string }) => {
    const key = (apiKey && apiKey.trim()) || getPassword(`provider:${provider.id}`)
    if (!key) return { ok: false, error: '没有可用的 API Key（未填写且无历史存储）' }
    const base = String(provider.baseUrl || '').replace(/\/+$/, '')
    const url = provider.protocol === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`
    const body: any =
      provider.protocol === 'anthropic'
        ? { model: provider.model, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }
        : { model: provider.model, max_tokens: 4, stream: false, messages: [{ role: 'user', content: 'ping' }] }
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30_000)
      let res: any
      try {
        res = await fetch(url, {
          method: 'POST',
          headers:
            provider.protocol === 'anthropic'
              ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
              : { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ctrl.signal
        })
      } finally {
        clearTimeout(timer)
      }
      const text = await res.text()
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status} ← ${text.slice(0, 300)}` }
      }
      return { ok: true, label: `HTTP ${res.status}，模型 ${provider.model} 响应正常` }
    } catch (e: any) {
      return { ok: false, error: `请求失败：${e?.message || e}` }
    }
  })

  // ---------- 剪贴板 / 外部链接 ----------
  ipcMain.handle('clipboard:write', (_e, { text }: { text: string }) => {
    clipboard.writeText(String(text ?? ''))
    return { ok: true }
  })

  ipcMain.handle('shell:openExternal', (_e, { url }: { url: string }) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url))
    return { ok: true }
  })

  ipcMain.handle('shell:openFolder', (_e, { p }: { p: string }) => {
    if (/^[a-zA-Z]:[\\/]/.test(String(p)) || String(p).startsWith('\\\\')) shell.openPath(String(p))
    return { ok: true }
  })

  ipcMain.handle('confirm:reply', (_e, { requestId, decision }: { requestId: string; decision: ApprovalDecision }) => {
    const p = pendingApprovals.get(requestId)
    if (p) {
      pendingApprovals.delete(requestId)
      p.resolve(decision)
    }
    return { ok: true }
  })

  // ---------- LLM 发送前预览回复 ----------
  ipcMain.handle('llm:preview:reply', (_e, { requestId, ok }: { requestId: string; ok: boolean }) => {
    const p = pendingPreviews.get(requestId)
    if (p) {
      pendingPreviews.delete(requestId)
      p.resolve(!!ok)
    }
    return { ok: true }
  })

  ipcMain.handle('audit:list', () => readAudit(300))

  // 结构化审计查询（设置页审计查看器）：筛选条件见 audit.ts AuditQuery
  ipcMain.handle('audit:query', (_e, q: any) => {
    return queryAudit({
      kinds: Array.isArray(q?.kinds) ? q.kinds : undefined,
      actors: Array.isArray(q?.actors) ? q.actors : undefined,
      conns: Array.isArray(q?.conns) ? q.conns : undefined,
      sessionId: q?.sessionId || undefined,
      runId: q?.runId || undefined,
      q: q?.q || undefined,
      fromMs: typeof q?.fromMs === 'number' ? q.fromMs : undefined,
      toMs: typeof q?.toMs === 'number' ? q.toMs : undefined,
      approvedOnly: !!q?.approvedOnly,
      errorsOnly: !!q?.errorsOnly,
      limit: typeof q?.limit === 'number' ? q.limit : undefined,
      offset: typeof q?.offset === 'number' ? q.offset : undefined
    })
  })

  // ---------- 子代理任务面板（后台任务条 / 完整过程查看） ----------
  ipcMain.handle('subagent:tasks', (_e, { sessionId }: { sessionId?: string }) => {
    return listSubagentTasks(sessionId || undefined)
  })
  ipcMain.handle('subagent:stopTask', (_e, { id }: { id: string }) => {
    const r = stopSubagentTask(String(id || ''))
    return { ok: r.ok }
  })
  ipcMain.handle('subagent:audit', (_e, { runId }: { runId: string }) => {
    const r = readRunAudit(String(runId || ''))
    return { ok: true, entries: r.entries, file: r.file }
  })

  // 任务状态变化 → 渲染层任务条实时刷新
  onSubtaskChange(({ sessionId, tasks }) => {
    try {
      win?.webContents.send('subagent:tasks', { sessionId, tasks })
    } catch { /* 窗口可能正在关闭 */ }
  })

  ipcMain.handle('app:info', () => ({
    secretsAvailable: secretsAvailable(),
    version: '0.1.0'
  }))
}

export async function shutdown(): Promise<void> {
  for (const [id, p] of pendingApprovals) {
    p.resolve('deny')
    pendingApprovals.delete(id)
  }
  for (const [id, p] of pendingPreviews) {
    p.resolve(false)
    pendingPreviews.delete(id)
  }
  persistSessions()
  await closeAll()
  await sshCloseAll()
}
