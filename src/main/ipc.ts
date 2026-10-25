import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { loadConfig, saveConfig } from './config'
import { setPassword, deletePassword, getPassword, secretsAvailable } from './secrets'
import { readAudit, appendAudit, queryAudit } from './audit'
import { getAdapter, dropAdapter, closeAll } from './db/manager'
import { testServer, probeServer, openShell, shellInput, shellResize, closeShell, closeAll as sshCloseAll, dropServer, forgetHostKey, sftpList, sftpDownload, sftpUpload } from './ssh'
import * as sftpOps from './sftp'
import { readSshConfig } from './ssh-config'
import { classifySql, dialectOf } from './db/guard'
import { OracleAdapter } from './db/oracle'
import { ObOracleAdapter } from './db/ob-oracle'
import { MYSQL_SYSTEM_SCHEMAS, MySqlAdapter } from './db/mysql'
import { normalizeConnectionProfile, validateConnectionProfile } from './db/connection-profile'
import {
  runTurn, resetSession, cancelSession, loadPersistedSessions, persistSessions,
  getSession, listSessions, listArchivedSessions, newSession, deleteSession, updateSession, summarizeDropped,
  archiveSessionMark, archiveSummaryDone, unarchiveSession,
  type AgentEvent
} from './agent/loop'
import { callLlm } from './agent/llm'
import { bridgeStatus, startBridge, stopBridge, openLoginDashboard, listBridgeModels, resolveProvider as resolveWbProvider } from './workbuddy'
import { appendArchive, readProjectArchiveFull, listProjectArchiveEntries, deleteProjectArchiveEntry, clearProjectArchive, updateArchiveEntry, deleteArchiveEntryByHead } from './memory'
import { listSkills, saveSkill, deleteSkill, importSkill, importSkillPack, importSkillPackFromUrl, readSkill } from './skills'
import { cached, metaDropConn, metaGet, metaKeys, metaSet } from './meta'
import { buildCsv } from './csv'
import { getArtifact } from './artifacts'
import { defaultMaskingConfig, maskText, normalizeMaskingConfig, validateMaskingConfig, type MaskingConfig, type MaskingFileType } from './masking'
import type { AppConfig, ConnProfile, EditSupport, ProjectConfig } from './types'
import type { ApprovalOutcome, ApprovalDecision, ApprovalRequest } from './tools'
import { listSubagentTasks, onSubtaskChange, stopSubagentTask, stopSubtasksOfSession } from './agent/subtask-registry'
import { readRunAudit } from './agent/subagent-audit'
import { getSysResources } from './sysinfo'
import { writeFileAtomic } from './atomic'
import {
  listPlatforms,
  savePlatform,
  deletePlatform,
  testPlatform,
  loginStatus,
  overview as cloudOverview,
  clusters as cloudClusters,
  clusterDetail as cloudClusterDetail,
  tenants as cloudTenants,
  tenantDetail as cloudTenantDetail,
  hosts as cloudHosts,
  alarms as cloudAlarms,
  alarmHistory as cloudAlarmHistory,
  alarmDetail as cloudAlarmDetail,
  alarmRules as cloudAlarmRules,
  alarmTrend as cloudAlarmTrend,
  alarmLevelCounts as cloudAlarmLevelCounts,
  tasks as cloudTasks,
  taskDetail as cloudTaskDetail,
  taskStats as cloudTaskStats,
  taskCreators as cloudTaskCreators,
  metrics as cloudMetrics,
  clusterAction as cloudClusterAction,
  createTenant as cloudCreateTenant,
  deleteTenant as cloudDeleteTenant,
  packages as cloudPackages,
  clusterPreCheck as cloudClusterPreCheck,
  clusterCreate as cloudClusterCreate,
  clusterParams as cloudClusterParams,
  clusterUpdateParams as cloudClusterUpdateParams,
  tenantParams as cloudTenantParams,
  tenantUpdateParams as cloudTenantUpdateParams,
  tenantChangePassword as cloudTenantChangePassword,
  tenantModifyWhitelist as cloudTenantModifyWhitelist,
  tenantModifyReplica as cloudTenantModifyReplica,
  tenantAddReplica as cloudTenantAddReplica,
  tenantDeleteReplica as cloudTenantDeleteReplica,
  tenantSetLocked as cloudTenantSetLocked,
  tenantSessions as cloudTenantSessions,
  tenantCloseSessions as cloudTenantCloseSessions,
  topSql as cloudTopSql,
  slowSql as cloudSlowSql,
  sqlText as cloudSqlText,
  tenantSqlStats as cloudTenantSqlStats,
  tenantDbs as cloudTenantDbs,
  tenantTables as cloudTenantTables,
  tenantTableSchema as cloudTenantTableSchema,
  tenantTopo as cloudTenantTopo,
  tenantSessionStats as cloudTenantSessionStats,
  tenantCloseQuery as cloudTenantCloseQuery,
  tenantRowLocks as cloudTenantRowLocks,
  tenantTxns as cloudTenantTxns,
  tenantCloseTxns as cloudTenantCloseTxns,
  tenantNewSql as cloudTenantNewSql,
  tenantHighRiskSql as cloudTenantHighRiskSql,
  tenantParallelSql as cloudTenantParallelSql,
  tenantOutlines as cloudTenantOutlines,
  tenantSqlDiagnosis as cloudTenantSqlDiagnosis,
  tenantCompactionAll as cloudTenantCompactionAll,
  tenantUpdateCompactionSettings as cloudTenantUpdateCompactionSettings,
  tenantCompactionAction as cloudTenantCompactionAction,
  tenantGatherAll as cloudTenantGatherAll,
  tenantBackupAll as cloudTenantBackupAll,
  tenantUsers as cloudTenantUsers,
  tenantTde as cloudTenantTde,
  unitSpecs as cloudUnitSpecs,
  unitSpecCreate as cloudUnitSpecCreate,
  unitSpecUpdate as cloudUnitSpecUpdate,
  unitSpecDelete as cloudUnitSpecDelete,
  tenantClonePreCheck as cloudTenantClonePreCheck,
  tenantClone as cloudTenantClone,
  primaryTenantInfo as cloudPrimaryTenantInfo,
  createStandbyTenant as cloudCreateStandbyTenant,
  // 备份恢复 / OBProxy / 巡检 / 平台管理
  backupBundle as cloudBackupBundle,
  backupTasks as cloudBackupTasks,
  obproxyBundle as cloudObproxyBundle,
  obproxyDetail as cloudObproxyDetail,
  obproxyParams as cloudObproxyParams,
  inspectionBundle as cloudInspectionBundle,
  inspectionReport as cloudInspectionReport,
  inspectionTasks as cloudInspectionTasks,
  platformBundle as cloudPlatformBundle,
  platformProperties as cloudPlatformProperties,
  platformLogins as cloudPlatformLogins,
  // Oracle 直连云平台（查 v$ / dba_ 视图，不走平台接口）
  cloudOracleSection,
  cloudOracleSqlDetail
} from './cloud/service'
import {
  askOraAi,
  bindOraAiEmitter,
  deleteOraAiSession,
  getOraAiSession,
  listOraAiSessions,
  refreshOraAiContext,
  oraAiCatalog,
  setOraAiSections,
  stopOraAi
} from './cloud/oracle/ai'
import { askEditorAi, bindEditorAiEmitter, deleteEditorAiSession, getEditorAiSession, listEditorAiSessions, stopEditorAi } from './editor-ai'
import {
  askCloudAi,
  bindCloudAiEmitter,
  deleteCloudAiSession,
  getCloudAiSession,
  listCloudAiSessions,
  refreshCloudAiContext,
  setCloudAiSections,
  stopCloudAi,
  type CloudAiAskInput,
  type CloudAiEvent,
  type CloudAiSectionKey
} from './cloud/ai'
import {
  setPendingOpens as editorSetPendingOpens,
  takePendingOpens as editorTakePendingOpens,
  takePendingWorkspace as editorTakePendingWorkspace,
  openDialog as editorOpenDialog,
  openPath as editorOpenPath,
  openFolderDialog as editorOpenFolderDialog,
  listFilesForAi,
  newDoc as editorNewDoc,
  readTextForAi,
  getWindow as editorGetWindow,
  loadFull as editorLoadFull,
  saveDoc as editorSaveDoc,
  saveAsDialog as editorSaveAsDialog,
  reopen as editorReopen,
  closeDoc as editorCloseDoc,
  statDocs as editorStatDocs,
  findInDoc as editorFindInDoc,
  findInFiles as editorFindInFiles,
  listDir as editorListDir,
  statPath as editorStatPath,
  listRecents as editorListRecents,
  clearRecents as editorClearRecents
} from './editor'

let win: BrowserWindow | null = null
const pendingApprovals = new Map<string, { resolve: (o: ApprovalOutcome) => void; sessionId: string }>()
let approvalSeq = 0
// LLM 发送前预览（按会话归属，停止/退出时兜底取消）
const pendingPreviews = new Map<string, { resolve: (ok: boolean) => void; sessionId: string }>()
let previewSeq = 0

const isOracleProtocol = (profile: ConnProfile): boolean =>
  profile.type === 'oracle' || profile.type === 'ob-oracle'

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

function requestApproval(req: ApprovalRequest, sessionId: string): Promise<ApprovalOutcome> {
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
        p.resolve({ decision: 'denied', reason: '确认超时（5 分钟未响应），已按拒绝处理' })
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
  // 云管 AI 的流式事件与 agent 事件共用同一个窗口通道，但走独立的频道名
  bindCloudAiEmitter((ev: CloudAiEvent) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('cloud:ai:event', ev) } catch { /* 窗口关闭中 */ }
    }
  })
  // Oracle 的 AI 助手走独立频道（会话与快照来源都不同，互不干扰）
  bindOraAiEmitter((ev) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('cloud:oraAi:event', ev) } catch { /* 窗口关闭中 */ }
    }
  })
  // 文本编辑器「针对选中文本提问」的流式事件（与前两个助手互不干扰）
  bindEditorAiEmitter((ev) => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('editor:ai:event', ev) } catch { /* 窗口关闭中 */ }
    }
  })

  // ---------- 配置 ----------
  // API Key 不下发渲染层：真实值仅留在主进程内存，界面凭 hasKey 判断是否已保存
  ipcMain.handle('config:get', () => {
    const cfg = loadConfig()
    return { ...cfg, providers: cfg.providers.map((p) => ({ ...p, apiKey: '', hasKey: !!p.apiKey })) }
  })
  ipcMain.handle('config:set', (_e, cfg: AppConfig) => {
    const maskError = validateMaskingConfig(normalizeMaskingConfig(cfg.masking))
    if (maskError) return { ok: false, error: maskError }
    // 渲染层拿到的是掩码 Key：空值回填主进程已存 Key，避免整份配置回存时误清
    // （DPAPI 不可用、明文回退落盘的场景下尤其重要）
    const cur = loadConfig()
    for (const p of cfg.providers) {
      if (!p.apiKey) {
        const old = cur.providers.find((x) => x.id === p.id)
        if (old?.apiKey) p.apiKey = old.apiKey
      }
    }
    // 云管平台清单由主进程独立维护（cloud:* ），渲染层的配置副本可能是模块接入前的旧快照；
    // 整份回存时以主进程为准，避免切主题之类的操作把平台配置抹掉
    cfg.cloudPlatforms = cur.cloudPlatforms
    // 终端偏好同理：渲染层的旧副本可能还没有 termPrefs，缺省保留主进程已存值
    if (!cfg.termPrefs) cfg.termPrefs = cur.termPrefs
    saveConfig(cfg)
    return { ok: true }
  })

  // ---------- 连接管理 ----------
  ipcMain.handle('conn:save', (_e, { profile: rawProfile, password }: { profile: ConnProfile; password?: string }) => {
    const profile = normalizeConnectionProfile(rawProfile)
    const validationError = validateConnectionProfile(profile, true)
    if (validationError) return { ok: false, error: validationError }
    // DPAPI 的键就是连接 id，而密钥表是全项目共用的一张平表（server:/server-key:/cloud:/provider: 也在这里）。
    // id 里带 ':' 就能写到别的命名空间上，进而借 conn:test 把别处的口令引出来 —— 只允许安全字符。
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(profile.id || ''))) {
      return { ok: false, error: '连接 id 只能包含字母、数字、下划线和短横线（≤64 字符）' }
    }
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
    const normalized = normalizeConnectionProfile(profile)
    const validationError = validateConnectionProfile(normalized, false)
    if (validationError) return { ok: false, error: validationError }
    profile = normalized
    const usingSavedPwd = password === undefined || password === ''
    if (usingSavedPwd) {
      // 用已保存密码测试时不允许换目标：否则可借主进程把密文用于攻击者控制的伪服务端
      const saved = loadConfig().connections.find((c) => c.id === profile.id)
      const sameTarget = saved && saved.host === profile.host && Number(saved.port) === Number(profile.port) &&
        saved.user === profile.user && saved.type === profile.type
      if (!sameTarget) {
        return { ok: false, error: '使用已保存密码时不能修改主机/端口/用户名/类型；测试新目标请先填写密码。' }
      }
    }
    const pw = usingSavedPwd ? getPassword(profile.id) : password
    try {
      const adapter =
        profile.type === 'oracle'
          ? new OracleAdapter(profile, loadConfig().instantClientDir, pw)
          : profile.type === 'ob-oracle'
            ? new ObOracleAdapter(profile, pw)
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
    const s = isOracleProtocol(profile) ? schema.toUpperCase() : schema
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
  // ZCode time_archived 式瞬时归档：打标记 + 本地抽取摘要（毫秒级）立即返回，
  // 消息保留（可恢复）；LLM 增强总结后台生成，完成后更新归档条目并广播刷新。
  // remove 参数保留兼容但不再删除——归档语义就是"收起可恢复"，彻底删除走归档区 ✕
  ipcMain.handle('session:archive', (_e, { id, remove }: { id: string; remove?: boolean }) => {
    try {
      const cfg = loadConfig()
      const sess = getSession(id)
      if (sess.running) {
        return { ok: false, error: '会话正在执行任务，请先停止（或等它结束）再归档' }
      }
      // 空会话 / 未绑定项目：没有可归档的内容——不报错拦截（否则用户"归档不了"），
      // 按调用方意图处理（remove=从列表删除；否则重置），说明性 note 随行返回
      const project0 = sess.projectId ? cfg.projects.find((p) => p.id === sess.projectId) : undefined
      if (!sess.messages.length || !project0) {
        if (remove) deleteSession(id)
        else resetSession(id)
        return { ok: true, archived: false, note: !sess.messages.length ? '会话为空，未生成归档' : '会话未绑定项目，内容未归档', instant: true }
      }
      const project = project0!
      // 1) 瞬时完成：本地抽取摘要（纯同步毫秒级）+ 打标记 + 写归档背景
      const summary0 = summarizeDropped(undefined, sess.messages)
      const ts = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const tsLabel = ts.getFullYear() + '-' + pad(ts.getMonth() + 1) + '-' + pad(ts.getDate()) + ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes())
      archiveSessionMark(id, summary0)
      appendArchive(project.name, sess.title, summary0)
      win?.webContents.send('archive:progress', { id, stage: 'done', note: '已归档到「' + project.name + '」（智能总结后台生成中）' })

      // 2) 后台 LLM 增强总结：不阻塞归档；完成/失败都不影响已归档状态
      const provider = resolveProvider(cfg, id)
      if (provider) {
        void (async () => {
          try {
            const res = await callLlm(provider, ARCHIVE_SUMMARY_SYSTEM, sess.messages, [], {})
            const better = (res.content || '').trim()
            if (better && sess.archivedAt) {
              archiveSummaryDone(id, better)
              updateArchiveEntry(project.name, tsLabel, sess.title, better)
              win?.webContents.send('archive:updated', { projectId: project.id })
            }
          } catch {
            archiveSummaryDone(id, summary0) // 保持本地抽取版
          }
        })()
      } else {
        archiveSummaryDone(id, summary0)
      }
      return { ok: true, archived: true, note: '已归档', preview: summary0.slice(0, 160), instant: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) }
    }
  })

  // 恢复归档会话（ZCode resurrection）：消息保留在 sessions.json，去标记即回活跃列表
  ipcMain.handle('session:unarchive', (_e, { id }: { id: string }) => {
    const meta = unarchiveSession(id)
    return meta ? { ok: true, session: meta } : { ok: false, error: '归档会话不存在' }
  })

  ipcMain.handle('archive:get', (_e, { projectId }: { projectId: string }) => {
    const cfg = loadConfig()
    const project = cfg.projects.find((p) => p.id === projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    return { ok: true, project: project.name, content: readProjectArchiveFull(project.name) || '' }
  })

  // 归档条目化（侧栏项目树内嵌归档区）：列表/单条删除（内容校验防并发错删）/清空
  ipcMain.handle('archive:list', (_e, { projectId }: { projectId: string }) => {
    const project = loadConfig().projects.find((p) => p.id === projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    // 主数据源：归档会话（sessions.json，消息保留可恢复）
    const archived = listArchivedSessions(projectId).map((s) => {
      const d = new Date(s.archivedAt)
      const pad = (n: number) => String(n).padStart(2, '0')
      return {
        sessionId: s.id,
        ts: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
        title: s.title,
        summary: s.archiveSummary || '',
        summarizing: s.summarizing,
        messageCount: s.messageCount
      }
    })
    // 兼容：md 里有、但对应会话已不存在的历史条目（旧版归档删会话的产物）
    const heads = new Set(archived.map((a) => a.ts + '|' + a.title))
    const legacy = listProjectArchiveEntries(project.name)
      .filter((e) => !heads.has(e.ts + '|' + e.title))
      .map((e) => ({ sessionId: null as string | null, ts: e.ts, title: e.title, summary: e.summary, summarizing: false, messageCount: 0, legacy: true, raw: e.raw }))
    return { ok: true, entries: [...archived, ...legacy] }
  })
  ipcMain.handle('archive:deleteEntry', (_e, { projectId, sessionId, reverseIndex, rawCheck, ts, title }: { projectId: string; sessionId?: string | null; reverseIndex?: number; rawCheck?: string; ts?: string; title?: string }) => {
    const project = loadConfig().projects.find((p) => p.id === projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    // 会话型：删除归档会话（级联停子任务）+ best-effort 清理 md 背景条目
    if (sessionId) {
      deleteSession(sessionId)
      if (ts && title) deleteArchiveEntryByHead(project.name, ts, title)
      return { ok: true }
    }
    // legacy 型（仅 md）：优先按 ts+title 定位——列表下标含会话型条目，直接复用会错删；
    // 找不到再回退 下标+内容校验（兼容旧调用）
    if (ts && title) {
      const entries = listProjectArchiveEntries(project.name)
      const i = entries.findIndex((e) => e.ts === ts && e.title === title)
      if (i < 0) return { ok: false, error: '该归档刚被修改，请刷新后重试' }
      return deleteProjectArchiveEntry(project.name, i, entries[i].raw)
        ? { ok: true }
        : { ok: false, error: '该归档刚被修改，请刷新后重试' }
    }
    return deleteProjectArchiveEntry(project.name, Number(reverseIndex) || 0, String(rawCheck || '')) ? { ok: true } : { ok: false, error: '该归档刚被修改，请刷新后重试' }
  })
  ipcMain.handle('archive:clear', (_e, { projectId }: { projectId: string }) => {
    const project = loadConfig().projects.find((p) => p.id === projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    for (const s of listArchivedSessions(projectId)) deleteSession(s.id)
    clearProjectArchive(project.name)
    return { ok: true }
  })
  ipcMain.handle('session:update', (_e, { id, patch }: { id: string; patch: any }) => {
    // 渲染层可控字段白名单：只透传会话元数据，防异常渲染层把任意字段注入会话状态
    const p: Record<string, unknown> = {}
    if (typeof patch?.title === 'string') p.title = patch.title
    if (typeof patch?.mode === 'string' && ['plan', 'readonly', 'confirm', 'session', 'yolo'].includes(patch.mode)) p.mode = patch.mode
    if (patch?.providerId === null || typeof patch?.providerId === 'string') p.providerId = patch.providerId
    if (patch?.projectId === null || typeof patch?.projectId === 'string') p.projectId = patch.projectId
    if (patch?.effort === null || typeof patch?.effort === 'string') p.effort = patch.effort
    try {
      updateSession(id, p)
      return { ok: true, session: listSessions().find((s) => s.id === id) }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
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
      p.resolve({ decision: 'denied', reason: '用户已停止任务' })
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

  // ---------- 文件脱敏 ----------
  ipcMain.handle('mask:defaults', () => defaultMaskingConfig())

  ipcMain.handle('mask:pickFile', async (_e, { fileType }: { fileType: MaskingFileType }) => {
    if (fileType !== 'oracle_awr') return { ok: false, error: '该文件类型暂未开放，当前请选择 Oracle AWR 报告' }
    const filters = [
      { name: 'Oracle AWR 报告', extensions: ['awr', 'txt', 'html', 'htm', 'log'] },
      { name: '所有文件', extensions: ['*'] }
    ]
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters }) : await dialog.showOpenDialog({ properties: ['openFile'], filters })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    const p = r.filePaths[0]
    try {
      const st = await fs.stat(p)
      if (!st.isFile()) return { ok: false, error: '请选择文件而不是目录' }
      if (st.size > 20 * 1024 * 1024) return { ok: false, error: '文件超过 20MB，请先拆分后再脱敏' }
      const content = await fs.readFile(p, 'utf8')
      return { ok: true, path: p, fileName: path.basename(p), size: st.size, content }
    } catch (e: any) {
      return { ok: false, error: `读取文件失败：${e?.message || e}` }
    }
  })

  ipcMain.handle('mask:text', (_e, { fileType, content }: { fileType: MaskingFileType; content: string }) => {
    if (fileType !== 'oracle_awr') return { ok: false, error: '该文件类型暂未开放，当前支持 Oracle AWR 报告' }
    if (typeof content !== 'string') return { ok: false, error: '文件内容无效' }
    if (content.length > 20 * 1024 * 1024) return { ok: false, error: '文件超过 20MB，请先拆分后再脱敏' }
    try {
      const cfg = loadConfig()
      const r = maskText(content, fileType, cfg.masking as MaskingConfig)
      return { ok: true, ...r }
    } catch (e: any) {
      return { ok: false, error: `脱敏失败：${e?.message || e}` }
    }
  })

  ipcMain.handle('mask:save', async (_e, { fileName, content }: { fileName: string; content: string }) => {
    if (typeof content !== 'string') return { ok: false, error: '脱敏内容无效' }
    const ext = path.extname(fileName || '').toLowerCase()
    const outExt = ext === '.html' || ext === '.htm' ? '.masked.html' : '.masked.txt'
    const base = path.basename(fileName || 'awr-report', ext)
    const defaultPath = `${base}${outExt}`
    const filters = outExt === '.masked.html'
      ? [{ name: '已脱敏 AWR HTML', extensions: ['html', 'htm'] }]
      : [{ name: '已脱敏 AWR 文本', extensions: ['txt', 'awr', 'log'] }]
    const r = win ? await dialog.showSaveDialog(win, { defaultPath, filters }) : await dialog.showSaveDialog({ defaultPath, filters })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      writeFileAtomic(r.filePath, content)
      return { ok: true, path: r.filePath }
    } catch (e: any) {
      return { ok: false, error: `保存失败：${e?.message || e}` }
    }
  })
  ipcMain.handle('project:save', (_e, { project }: { project: ProjectConfig }) => {
    const cfg = loadConfig()
    // 服务器全局注册后项目只存引用：剔除旧渲染层可能回传的内联定义，以 serverIds 为准
    const clean: ProjectConfig = { ...project }
    delete clean.servers
    const idx = cfg.projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) cfg.projects[idx] = clean
    else cfg.projects.push(clean)
    saveConfig(cfg)
    return { ok: true }
  })

  ipcMain.handle('project:delete', (_e, { id }: { id: string }) => {
    const cfg = loadConfig()
    cfg.projects = cfg.projects.filter((p) => p.id !== id)
    // 服务器是全局资产：删项目只解除引用，不删服务器与密码
    saveConfig(cfg)
    // 该项目的会话：先停运行中回合与后台子代理（防写权限任务在归属消失后继续跑），再解绑
    for (const s of listSessions()) {
      if (s.projectId === id) {
        cancelSession(s.id)
        stopSubtasksOfSession(s.id)
        updateSession(s.id, { projectId: null })
      }
    }
    return { ok: true }
  })

  // ---------- SSH 服务器（全局注册表：侧栏管理，项目经 serverIds 引用） ----------
  const TERM_ENCODINGS = ['utf-8', 'gbk', 'gb18030', 'big5', 'latin1']
  /** 白名单清洗：渲染层传来的对象不能原样落盘（可能带 UI 临时字段） */
  const cleanServer = (raw: any) => {
    const auth = raw?.auth === 'key' ? 'key' : 'password'
    const s: any = {
      id: String(raw.id),
      name: String(raw.name || '').trim(),
      host: String(raw.host || '').trim(),
      port: Number(raw.port) || 22,
      user: String(raw.user || '').trim(),
      auth
    }
    for (const k of ['tag', 'note', 'group', 'cwd'] as const) {
      const v = String(raw?.[k] ?? '').trim()
      if (v) s[k] = v
    }
    if (auth === 'key') s.keyPath = String(raw.keyPath || '').trim()
    if (raw.jumpId) s.jumpId = String(raw.jumpId)
    if (raw.scheme) s.scheme = String(raw.scheme)
    // 标签标识色：只收 #rrggbb，避免渲染层传入任意 CSS 值
    if (/^#[0-9a-fA-F]{6}$/.test(String(raw.color || ''))) s.color = String(raw.color).toLowerCase()
    if (Number(raw.fontSize) >= 8 && Number(raw.fontSize) <= 32) s.fontSize = Number(raw.fontSize)
    if (TERM_ENCODINGS.includes(raw.encoding)) s.encoding = raw.encoding
    if (TERM_ENCODINGS.includes(raw.fileEncoding)) s.fileEncoding = raw.fileEncoding
    return s
  }

  ipcMain.handle('server:save', (_e, { server, password, keyPassphrase }: { server: any; password?: string; keyPassphrase?: string }) => {
    const clean = cleanServer(server)
    const name = clean.name
    if (!name || !clean.host || !clean.user) return { ok: false, error: '名称、主机、用户名必填' }
    const cfg = loadConfig()
    // 全局名称唯一：agent 按名称寻址，重名跨项目也会产生歧义
    if (cfg.servers.some((s) => s.name === name && s.id !== clean.id)) {
      return { ok: false, error: `服务器名「${name}」已存在（agent 按名称寻址，全局不能重名）` }
    }
    if (clean.auth === 'key') {
      if (!clean.keyPath) return { ok: false, error: '认证方式为私钥时必须选择私钥文件' }
      if (!fsSync.existsSync(clean.keyPath)) return { ok: false, error: `私钥文件不存在：${clean.keyPath}` }
    }
    // 跳板合法性：不能指向自己，且不能形成环（A→B→A），否则建连会无限递归
    if (clean.jumpId) {
      if (clean.jumpId === clean.id) return { ok: false, error: '跳板机不能是服务器自身' }
      const seen = new Set<string>([clean.id])
      let cur: string | undefined = clean.jumpId
      while (cur) {
        if (seen.has(cur)) return { ok: false, error: '跳板机链路存在循环引用' }
        seen.add(cur)
        const next = cfg.servers.find((s) => s.id === cur)
        if (!next) return { ok: false, error: '所选跳板机不存在' }
        cur = next.jumpId
      }
    }

    const idx = cfg.servers.findIndex((s) => s.id === clean.id)
    const prev = idx >= 0 ? cfg.servers[idx] : null
    if (idx >= 0) cfg.servers[idx] = clean
    else cfg.servers.push(clean)
    saveConfig(cfg)
    // 口令单独走 DPAPI；空值 = 保持已存（编辑备注时不该逼用户重填密码）
    if (password) setPassword(`server:${clean.id}`, password)
    if (keyPassphrase) setPassword(`server-key:${clean.id}`, keyPassphrase)
    // 只有影响握手的字段变化才断开池化连接——改备注/分组/字体不应杀掉用户开着的终端
    const handshakeChanged =
      !prev ||
      prev.host !== clean.host ||
      prev.port !== clean.port ||
      prev.user !== clean.user ||
      (prev.auth || 'password') !== clean.auth ||
      (prev.keyPath || '') !== (clean.keyPath || '') ||
      (prev.jumpId || '') !== (clean.jumpId || '')
    if (handshakeChanged) dropServer(clean.id)
    return { ok: true, id: clean.id }
  })

  ipcMain.handle('server:delete', (_e, { id }: { id: string }) => {
    const cfg = loadConfig()
    if (!cfg.servers.some((s) => s.id === id)) return { ok: true }
    cfg.servers = cfg.servers.filter((s) => s.id !== id)
    // 引用清理：项目关联 + 其它服务器把它当跳板
    for (const p of cfg.projects) {
      if (Array.isArray(p.serverIds)) p.serverIds = p.serverIds.filter((x) => x !== id)
    }
    for (const s of cfg.servers) {
      if (s.jumpId === id) delete s.jumpId
    }
    saveConfig(cfg)
    deletePassword(`server:${id}`)
    deletePassword(`server-key:${id}`)
    dropServer(id)
    return { ok: true }
  })

  ipcMain.handle('server:test', async (_e, { server, password, keyPassphrase }: { server: any; password?: string; keyPassphrase?: string }) => {
    try {
      const target = cleanServer(server) as any
      const usingSaved = !password && !keyPassphrase
      if (usingSaved && target?.id) {
        // 用已保存的密码/私钥口令测试时不允许换目标：否则渲染层传一个别的 host，
        // 主进程就把该服务器 DPAPI 里的凭据发给了攻击者主机（同 conn:test 的防护）
        const saved = loadConfig().servers.find((s: any) => s.id === target.id)
        if (!saved) return { ok: false, error: '会话不存在，请重新填写密码或私钥口令后测试' }
        const sameTarget =
          saved.host === target.host &&
          (Number(saved.port) || 22) === (Number(target.port) || 22) &&
          saved.user === target.user &&
          (saved.auth || 'password') === (target.auth || 'password') &&
          (saved.keyPath || '') === (target.keyPath || '') &&
          (saved.jumpId || '') === (target.jumpId || '')
        if (!sameTarget) {
          return { ok: false, error: '使用已保存凭据时不能修改主机/端口/用户/认证方式/跳板；测试新目标请重新填写密码。' }
        }
      }
      const probe = await probeServer(target, password || undefined, keyPassphrase || undefined)
      return { ok: true, label: probe.label, locale: probe.locale, viaJump: probe.viaJump }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('server:forgetHostKey', (_e, { host, port }: { host: string; port: number }) => {
    return { ok: true, removed: forgetHostKey(host, port) }
  })

  /** 从 ~/.ssh/config 导入候选（只解析，不落盘；由渲染层勾选后走 server:save） */
  ipcMain.handle('server:importSshConfig', () => {
    const r = readSshConfig()
    const cfg = loadConfig()
    const existing = new Set(cfg.servers.map((s) => `${s.host}:${s.port}:${s.user}`))
    return {
      ok: !r.error,
      error: r.error,
      path: r.path,
      entries: r.entries.map((e) => ({
        ...e,
        duplicate: existing.has(`${e.host}:${e.port}:${e.user || ''}`)
      }))
    }
  })

  // ---------- 交互式 SSH 终端 ----------

  ipcMain.handle('term:open', async (_e, { termId, serverId, cols, rows, encoding, cwd, term }: {
    termId: string; serverId: string; cols?: number; rows?: number; encoding?: string; cwd?: string; term?: string
  }) => {
    // 全局注册表查找：终端不限于当前项目引用的服务器（侧栏可直达任意全局服务器）
    const server = loadConfig().servers.find((s) => s.id === serverId)
    if (!server) return { ok: false, error: '服务器不存在（可能已删除）' }
    try {
      await openShell(
        termId,
        server,
        (d) => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('term:data', { termId, data: d }) } catch { /* 忽略 */ }
          }
        },
        (info) => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('term:exit', { termId, code: info?.code ?? null }) } catch { /* 忽略 */ }
          }
        },
        {
          cols,
          rows,
          // 会话级编码优先；未指定则用服务器配置（再兜底 utf-8）
          encoding: (TERM_ENCODINGS.includes(String(encoding)) ? encoding : server.encoding) as any,
          cwd: cwd ?? server.cwd,
          term
        }
      )
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('term:input', (_e, { termId, data }: { termId: string; data: string }) => {
    // 渲染层可控输入钳制：termId/长度限制，防异常渲染层写超长数据到 shell
    shellInput(String(termId ?? ''), String(data ?? '').slice(0, 8192))
    return { ok: true }
  })

  ipcMain.handle('term:resize', (_e, { termId, cols, rows }: { termId: string; cols: number; rows: number }) => {
    const c = Math.min(Math.max(Number(cols) || 80, 2), 500)
    const r = Math.min(Math.max(Number(rows) || 24, 2), 300)
    shellResize(String(termId ?? ''), c, r)
    return { ok: true }
  })
  ipcMain.handle('term:close', (_e, { termId }: { termId: string }) => {
    closeShell(termId)
    return { ok: true }
  })

  // ---------- SFTP 文件浏览器 ----------
  // 服务器全局注册后按全局清单查找（终端/SFTP 不要求项目引用，侧栏直达的服务器也要能用）
  const findServer = (serverId: string) => loadConfig().servers.find((x) => x.id === serverId) || null

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

  // ---------- SFTP 完整面板（服务器模块：双栏浏览 / 编辑 / 传输队列） ----------
  // 与上面的 sftp:* 兼容接口并存：旧接口没有进度、没有错误分类，新面板一律走这里。
  /** 传输任务：jobId → 取消控制器。渲染层关标签/取消按钮都通过 sftp:cancel 中止 */
  const transfers = new Map<string, AbortController>()

  const sendProgress = (jobId: string, p: Record<string, any>) => {
    if (!jobId || !win || win.isDestroyed()) return
    try { win.webContents.send('sftp:progress', { jobId, ...p }) } catch { /* 窗口已关 */ }
  }

  const requireServer = (serverId: string) => {
    const s = findServer(serverId)
    if (!s) throw new Error('服务器不存在（可能已删除）')
    return s
  }

  /** 统一包一层：所有 SFTP handler 都返回 { ok, error }，渲染层不用 try/catch 满天飞 */
  const wrap = <T>(fn: () => Promise<T>) => fn().then((r) => ({ ok: true as const, ...(r as any) })).catch((e: any) => ({ ok: false as const, error: String(e?.message || e) }))

  ipcMain.handle('sftp:ls', (_e, { serverId, path: p }: { serverId: string; path: string }) =>
    wrap(async () => ({ path: p, entries: await sftpOps.listDir(requireServer(serverId), p || '.') })))

  ipcMain.handle('sftp:stat', (_e, { serverId, path: p }: { serverId: string; path: string }) =>
    wrap(async () => ({ stat: await sftpOps.statPath(requireServer(serverId), p) })))

  ipcMain.handle('sftp:home', (_e, { serverId }: { serverId: string }) =>
    wrap(async () => ({ path: await sftpOps.homeDir(requireServer(serverId)) })))

  ipcMain.handle('sftp:mkdir', (_e, { serverId, path: p }: { serverId: string; path: string }) =>
    wrap(async () => {
      const s = requireServer(serverId)
      await sftpOps.mkdir(s, p)
      appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: p, detail: 'sftp 新建目录' })
      return {}
    }))

  ipcMain.handle('sftp:rename', (_e, { serverId, from, to }: { serverId: string; from: string; to: string }) =>
    wrap(async () => {
      const s = requireServer(serverId)
      if (!from || !to) throw new Error('路径不能为空')
      await sftpOps.rename(s, from, to)
      appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: `${from} → ${to}`, detail: 'sftp 重命名' })
      return {}
    }))

  ipcMain.handle('sftp:remove', (_e, { serverId, path: p, recursive }: { serverId: string; path: string; recursive?: boolean }) =>
    wrap(async () => {
      const s = requireServer(serverId)
      const n = await sftpOps.removePath(s, p, recursive !== false)
      appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: p, detail: `sftp 删除（${n} 项）` })
      return { removed: n }
    }))

  ipcMain.handle('sftp:chmod', (_e, { serverId, path: p, mode }: { serverId: string; path: string; mode: number }) =>
    wrap(async () => {
      const s = requireServer(serverId)
      await sftpOps.chmod(s, p, Number(mode))
      appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: p, detail: `sftp chmod ${(Number(mode) || 0).toString(8)}` })
      return {}
    }))

  ipcMain.handle('sftp:read', (_e, { serverId, path: p, maxBytes, encoding }: { serverId: string; path: string; maxBytes?: number; encoding?: string }) =>
    wrap(async () => sftpOps.readText(requireServer(serverId), p, Math.min(Number(maxBytes) || 2 * 1024 * 1024, 8 * 1024 * 1024), encoding || 'utf-8')))

  ipcMain.handle('sftp:write', (_e, { serverId, path: p, content, encoding }: { serverId: string; path: string; content: string; encoding?: string }) =>
    wrap(async () => {
      const s = requireServer(serverId)
      const bytes = await sftpOps.writeText(s, p, String(content ?? ''), encoding || 'utf-8')
      appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: p, detail: `sftp 保存（${bytes} 字节）` })
      return { bytes }
    }))

  /** 本地文件/目录选择：上传前选源，或下载前选目标目录 */
  ipcMain.handle('sftp:pick', async (_e, { mode }: { mode: 'files' | 'folder' }) => {
    if (!win) return { ok: false, canceled: true }
    const r = await dialog.showOpenDialog(win, {
      properties: mode === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile', 'multiSelections']
    })
    return r.canceled ? { ok: false, canceled: true } : { ok: true, paths: r.filePaths }
  })

  ipcMain.handle('sftp:uploadPaths', async (_e, { serverId, localPaths, remoteDir, jobId }: {
    serverId: string; localPaths: string[]; remoteDir: string; jobId: string
  }) => {
    const ctrl = new AbortController()
    transfers.set(jobId, ctrl)
    // 进度统一带 kind：渲染层重载后队列是空的，也还能判断这条是上传还是下载
    const emit = (p: Record<string, any>) => sendProgress(jobId, { kind: 'upload', ...p })
    try {
      const s = requireServer(serverId)
      let files = 0
      let bytes = 0
      const list = (localPaths || []).filter(Boolean)
      for (let i = 0; i < list.length; i++) {
        if (ctrl.signal.aborted) throw new Error('已取消')
        const lp = list[i]
        emit({ phase: 'start', index: i, fileCount: list.length, name: path.basename(lp) })
        const r = await sftpOps.upload(
          s,
          lp,
          remoteDir || '.',
          // p.total 是当前文件的字节数，不能覆盖成文件数：文件数走 fileCount
          (p) => emit({ ...p, phase: 'progress', index: i, fileCount: list.length }),
          ctrl.signal
        )
        files += r.files
        bytes += r.bytes
        appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: `${lp} → ${remoteDir}`, detail: 'sftp 上传' })
      }
      emit({ phase: 'done', files, bytes })
      return { ok: true, files, bytes }
    } catch (e: any) {
      const msg = String(e?.message || e)
      emit({ phase: msg.includes('取消') ? 'canceled' : 'error', error: msg })
      return { ok: false, error: msg }
    } finally {
      transfers.delete(jobId)
    }
  })

  ipcMain.handle('sftp:downloadPaths', async (_e, { serverId, remotePaths, localDir, jobId }: {
    serverId: string; remotePaths: string[]; localDir: string; jobId: string
  }) => {
    const ctrl = new AbortController()
    transfers.set(jobId, ctrl)
    // 进度统一带 kind：渲染层重载后队列是空的，也还能判断这条是上传还是下载
    const emit = (p: Record<string, any>) => sendProgress(jobId, { kind: 'download', ...p })
    try {
      const s = requireServer(serverId)
      // 本地目标必须是绝对路径，否则一律落到 userData/downloads，避免写进应用目录
      let dir = String(localDir || '')
      if (!/^[a-zA-Z]:[\\/]/.test(dir) && !dir.startsWith('\\\\')) {
        dir = path.join(app.getPath('userData'), 'downloads')
      }
      fsSync.mkdirSync(dir, { recursive: true })
      let files = 0
      let bytes = 0
      const list = (remotePaths || []).filter(Boolean)
      for (let i = 0; i < list.length; i++) {
        if (ctrl.signal.aborted) throw new Error('已取消')
        const rp = list[i]
        emit({ phase: 'start', index: i, fileCount: list.length, name: path.posix.basename(rp) })
        const r = await sftpOps.download(
          s,
          rp,
          dir,
          (p) => emit({ ...p, phase: 'progress', index: i, fileCount: list.length }),
          ctrl.signal
        )
        files += r.files
        bytes += r.bytes
        appendAudit({ kind: 'tool', actor: 'human', conn: s.name, target: `${rp} → ${dir}`, detail: 'sftp 下载' })
      }
      emit({ phase: 'done', files, bytes })
      return { ok: true, files, bytes, dir }
    } catch (e: any) {
      const msg = String(e?.message || e)
      emit({ phase: msg.includes('取消') ? 'canceled' : 'error', error: msg })
      return { ok: false, error: msg }
    } finally {
      transfers.delete(jobId)
    }
  })

  ipcMain.handle('sftp:cancel', (_e, { jobId }: { jobId: string }) => {
    const c = transfers.get(jobId)
    if (c) c.abort()
    return { ok: true, found: !!c }
  })

  // ---------- 本地目录（SFTP 双栏的本地侧） ----------
  // 不复用 editor:listDir：那是编辑器工作区语义（限制在打开的根目录内），
  // 而这里要能自由浏览整机磁盘，两者权限模型不同，混用迟早出事。
  ipcMain.handle('local:roots', async () => {
    const roots: { name: string; path: string }[] = []
    for (let c = 67; c <= 90; c++) {
      const p = `${String.fromCharCode(c)}:\\`
      try {
        await fs.access(p)
        roots.push({ name: `${String.fromCharCode(c)}:`, path: p })
      } catch { /* 盘符不存在 */ }
    }
    const home = app.getPath('home')
    const quick = [
      { name: '桌面', path: app.getPath('desktop') },
      { name: '下载', path: app.getPath('downloads') },
      { name: '文档', path: app.getPath('documents') }
    ]
    return { ok: true, roots, home, quick }
  })

  ipcMain.handle('local:ls', async (_e, { dir }: { dir: string }) => {
    try {
      const d = path.resolve(String(dir || '.'))
      const items = await fs.readdir(d, { withFileTypes: true })
      const capped = items.slice(0, 5000)
      const entries = await Promise.all(
        capped.map(async (it) => {
          let size = 0
          let mtime = 0
          try {
            const st = await fs.stat(path.join(d, it.name))
            size = st.size
            mtime = st.mtimeMs
          } catch { /* 权限不足/符号链接失效：仍列出，只是没有大小 */ }
          return {
            name: it.name,
            path: path.join(d, it.name),
            isDir: it.isDirectory(),
            hidden: it.name.startsWith('.'),
            size,
            mtime
          }
        })
      )
      entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.isDir ? -1 : 1))
      return { ok: true, dir: d, parent: path.dirname(d), entries, truncated: items.length > capped.length }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  ipcMain.handle('local:open', async (_e, { p }: { p: string }) => {
    const err = await shell.openPath(String(p))
    return err ? { ok: false, error: err } : { ok: true }
  })

  /** 通用单选文件对话框（私钥文件选择等）；文件 filters 由调用方给 */
  ipcMain.handle('dialog:pickFile', async (_e, { title, filters }: { title?: string; filters?: { name: string; extensions: string[] }[] }) => {
    if (!win) return { ok: false, canceled: true }
    const r = await dialog.showOpenDialog(win, {
      title: title || '选择文件',
      properties: ['openFile'],
      filters: filters && filters.length ? filters : undefined
    })
    return r.canceled || !r.filePaths.length ? { ok: false, canceled: true } : { ok: true, path: r.filePaths[0] }
  })

  /** 保存文本到本地（终端「保存输出日志」用）：走系统保存对话框，用户自己选位置 */
  ipcMain.handle('local:saveText', async (_e, { content, suggested }: { content: string; suggested?: string }) => {
    if (!win) return { ok: false, canceled: true }
    const r = await dialog.showSaveDialog(win, {
      defaultPath: suggested || 'terminal.log',
      filters: [{ name: '日志', extensions: ['log', 'txt'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    await fs.writeFile(r.filePath, String(content ?? ''), 'utf8')
    return { ok: true, path: r.filePath }
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
    const v = classifySql(sql, dialectOf(profile.type))
    if (!v.ok && profile.role === 'readonly') {
      appendAudit({
        kind: 'sql.write', actor: 'human', conn: profile.name, target: '(查询窗口)',
        detail: '只读连接拒绝写语句', sql, mode: 'human', approved: false,
        error: `语句类别: ${v.kind}`
      })
      return { ok: false, error: `连接「${profile.name}」标记为只读账号，禁止执行 ${v.kind.toUpperCase()} 语句。如确需变更，请使用管理账号连接。` }
    }
    const isOracle = isOracleProtocol(profile)
    // 按数据库特性处理事务：Oracle 本身无自动提交——控制台 DML 保持事务打开，
    // 由用户显式 COMMIT/ROLLBACK（DDL 在 Oracle 内部隐式提交，属数据库自身行为）；
    // MySQL/OB 连接为原生 autocommit，无需额外提交
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir, sessionKey)
      const head = (sql.trim().replace(/^(--[^\n]*\r?\n|\/\*[\s\S]*?\*\/|\s)+/, '').match(/^[a-zA-Z]+/)?.[0] || '').toUpperCase()
      // COMMIT/ROLLBACK 绝不能走 query()：query 内部的 ensure() 在探活失败时会静默换一条新连接，
      // 新连接上没有事务，COMMIT 会"成功"，而原事务已被服务端按断连回滚 —— 界面报"已提交"、数据全丢。
      // 走适配器自己的 commit()/rollback()，它们能在连接被重置时返回 false。
      if ((head === 'COMMIT' || head === 'ROLLBACK') && adapter.commit) {
        const done = head === 'COMMIT' ? await adapter.commit() : (adapter.rollback ? await adapter.rollback() : false)
        if (!done) {
          const msg = '事务已因连接重置（查询超时或网络断开）在服务端回滚，没有可提交的内容。请刷新数据后重做。'
          appendAudit({ kind: 'sql.write', actor: 'human', conn: profile.name, target: '(查询窗口)', detail: '事务控制', sql, mode: 'human', approved: false, error: msg })
          return { ok: false, error: msg }
        }
        appendAudit({ kind: 'sql.write', actor: 'human', conn: profile.name, target: '(查询窗口)', detail: '事务控制', sql, mode: 'human', approved: true })
        return {
          ok: true,
          result: { columns: [], rows: [], rowCount: 0, truncated: false, ms: 0, kind: v.kind, message: head === 'COMMIT' ? '已提交(COMMIT)' : '已回滚(ROLLBACK)' }
        }
      }
      const r = await adapter.query(sql, 500, 60_000)
      appendAudit({ kind: v.ok ? 'sql.read' : 'sql.write', actor: 'human', conn: profile.name, target: '(查询窗口)', detail: '查询窗口执行', sql, rows: r.rowCount, ms: r.ms, mode: 'human', approved: v.ok ? undefined : true })
      // 控制台执行了 DDL：该连接的元数据缓存全部失效（表/列结构可能已变）
      if (v.kind === 'ddl') metaDropConn(connId)
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
      const isOracle = isOracleProtocol(profile)
      const s = isOracle ? schema.toUpperCase() : schema
      const t = isOracle ? table.toUpperCase() : table
      const ident = `${quoteIdent(isOracle, s)}.${quoteIdent(isOracle, t)}`
      const cond = String(where || '').trim().replace(/^where\s+/i, '')
      const whereSql = cond ? ` WHERE ${cond}` : ''
      // where 是渲染层可控的自由文本：必须过守门器（按只读 SELECT 分类），
      // 防多语句 / INTO OUTFILE / 写子句借道本通道绕过门控（此前为裸拼，属旁路）
      if (cond) {
        // 只交给方言化的分类器判断：它在剥注释/识别字符串字面量上是对的，
        // 外层的 `#|--` 正则会把 Oracle 合法标识符 COL# 和含 `--` 的普通字符串一起误杀
        const verdict = classifySql(`SELECT 1 WHERE ${cond}`, dialectOf(profile.type))
        if (!verdict.ok || verdict.kind !== "read") {
          appendAudit({ kind: "sql.read", actor: "human", conn: profile.name, target: `${s}.${t}`, detail: "obj:data 筛选条件被守门器拒绝", sql: cond.slice(0, 2000), error: `拦截: ${verdict.reason || verdict.kind}` })
          return { ok: false, error: `筛选条件被安全策略拒绝：${verdict.reason || "仅允许只读筛选条件"}` }
        }
      }
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
    if (profile.role === 'readonly') {
      return { ok: true, editable: false, reason: '只读账号连接不可网格编辑', keyMode: 'cols', keyCols: [], readonlyCols: [] }
    }
    const s = isOracleProtocol(profile) ? schema.toUpperCase() : schema
    const t = isOracleProtocol(profile) ? table.toUpperCase() : table
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
    const s = isOracleProtocol(profile) ? schema.toUpperCase() : schema
    const t = isOracleProtocol(profile) ? table.toUpperCase() : table
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
    if (edits.length > 500) return { ok: false, error: '单次最多保存 500 处修改，请分批提交' }
    if (profile.role === 'readonly') {
      appendAudit({
        kind: 'sql.write', actor: 'human', conn: profile.name, target: `${schema}.${table}`,
        detail: '只读连接拒绝网格编辑', mode: 'human', approved: false, error: 'readonly connection'
      })
      return { ok: false, error: `连接「${profile.name}」标记为只读账号，禁止网格编辑。` }
    }
    const isOracle = isOracleProtocol(profile)
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
    // 行标识必须以服务端 editSupport 为准：渲染层传的 keyCols 只用于核对，
    // 若采用它，过时/被篡改的键会让 WHERE 只覆盖唯一键子集，一次编辑改多行
    if (!isOracle) {
      const serverKeys = (es?.keyCols || []).map((k) => String(k))
      const reqKeys = Array.isArray(keyCols) ? keyCols.map((k) => String(k)) : []
      if (!serverKeys.length) return { ok: false, error: '该表没有可用于定位行的主键/唯一键，请刷新后重试' }
      if (reqKeys.length !== serverKeys.length || reqKeys.some((k, i) => k !== serverKeys[i])) {
        return { ok: false, error: '行键与当前表结构不一致（可能已被修改），请刷新数据后重试' }
      }
      keyCols = serverKeys
    }
    // 每 tab 独立数据库会话：Oracle 的未提交事务与其他窗口/agent 互不可见
    const adapter = getAdapter(profile, cfg.instantClientDir, sessionKey)
    const conflicts: number[] = []
    let applied = 0
    try {
      if (!isOracle) await adapter.query('START TRANSACTION', 1, 10_000)
      // Oracle 没有语句级回滚：先打保存点，中途失败时把本批已执行的 UPDATE 撤回，
      // 否则它们会留在事务里，等用户下一次成功保存/提交时被一起落库（而界面报的是"保存失败"）
      else await adapter.query('SAVEPOINT sqlpilot_grid', 1, 10_000)
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
          else if (r.rowCount > 1) throw new Error(`rowid 定位命中 ${r.rowCount} 行，数据异常，本批已全部撤销`)
          else applied++
        } else {
          if (!Array.isArray(e.keys) || e.keys.length !== keyCols.length) throw new Error('行键值缺失，请刷新后重试')
          const where = keyCols.map((k) => `${quoteIdent(false, k)} = ?`).join(' AND ')
          const r = await adapter.query(
            `UPDATE ${ident} SET ${quoteIdent(false, String(e.col))} = ? WHERE ${where}`,
            1, 30_000, [e.value, ...e.keys]
          )
          if (r.rowCount === 0) conflicts.push(i)
          // >1 说明唯一键已失效（应用外改过索引）或键值失真：宁可整批失败，也不能批量误改
          else if (r.rowCount > 1) throw new Error(`行键命中 ${r.rowCount} 行（唯一键可能已变更），本批已全部撤销，请刷新后重试`)
          else applied++
        }
      }
      // MySQL 侧整批原子：有冲突全部回滚；Oracle 保持事务打开，由工具栏 ✓/↩ 决定
      let rolledBack = false
      if (!isOracle) {
        rolledBack = conflicts.length > 0
        await adapter.query(rolledBack ? 'ROLLBACK' : 'COMMIT', 1, 10_000)
        // 回滚后本次修改全部未生效：不能把 applied 报成"已保存"
        if (rolledBack) applied = 0
      }
      appendAudit({
        kind: 'sql.write', actor: 'human', conn: profile.name, target: `${s}.${t}`,
        detail: `网格编辑：${applied} 处修改${conflicts.length ? `，${conflicts.length} 处冲突` : ''}${rolledBack ? '（已全部回滚）' : ''}${isOracle ? '（未提交）' : ''}`,
        rows: applied, mode: 'human', approved: !rolledBack
      })
      return { ok: true, applied, conflicts, rolledBack, uncommitted: isOracle }
    } catch (e: any) {
      if (!isOracle) {
        try { await adapter.query('ROLLBACK', 1, 10_000) } catch { /* 忽略 */ }
      } else if (applied > 0) {
        // 撤回到保存点：本批已执行的 UPDATE 全部撤销，避免"保存失败但改了一半"
        try { await adapter.query('ROLLBACK TO SAVEPOINT sqlpilot_grid', 1, 10_000) } catch { /* 忽略 */ }
      }
      appendAudit({ kind: 'sql.write', actor: 'human', conn: profile.name, target: `${s}.${t}`, detail: `网格编辑保存失败（已撤销 ${applied} 处已应用的修改）`, mode: 'human', approved: false, error: String(e?.message || e).slice(0, 200) })
      return { ok: false, error: String(e?.message || e), applied: 0, rolledBack: true }
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
    const v = classifySql(sql, dialectOf(profile.type))
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

  // ---------- 会话产物（右侧「产物」面板） ----------
  // 完整结果集只在面板打开时按 id 取；不进对话上下文
  ipcMain.handle('artifact:get', (_e, { id }: { id: string }) => getArtifact(String(id || '')))

  // 图片预览：读成 data URL 交给渲染层（dev 下页面是 http://localhost，直接引用 file:// 会被拦）
  ipcMain.handle('artifact:imageDataUrl', async (_e, { path: p }: { path: string }) => {
    const IMG = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'])
    try {
      const abs = path.resolve(String(p || ''))
      const ext = path.extname(abs).toLowerCase()
      if (!IMG.has(ext)) return { ok: false, error: `不支持的图片类型：${ext || '(无扩展名)'}` }
      const st = await fs.stat(abs)
      if (!st.isFile()) return { ok: false, error: '不是文件' }
      if (st.size > 16 * 1024 * 1024) return { ok: false, error: `图片过大（${(st.size / 1048576).toFixed(1)} MB，上限 16 MB）` }
      const buf = await fs.readFile(abs)
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`
      return { ok: true, url: `data:${mime};base64,${buf.toString('base64')}`, size: st.size }
    } catch (e: any) {
      return { ok: false, error: e?.code === 'ENOENT' ? '文件不存在（可能已被移动或删除）' : String(e?.message || e) }
    }
  })

  // 面板里导出 CSV：数据已在内存（面板拿到的行），不再回库重跑一遍
  ipcMain.handle('artifact:exportCsv', async (_e, { columns, rows, name }: { columns: string[]; rows: any[][]; name?: string }) => {
    if (!Array.isArray(columns) || !columns.length) return { ok: false, error: '没有可导出的列' }
    if (!Array.isArray(rows)) return { ok: false, error: '没有可导出的行' }
    const ts = new Date()
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`
    // 文件名来自产物标题（可能含 SQL 片段）：去掉 Windows 非法字符并限长
    const base = String(name || '查询结果').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60) || '查询结果'
    const opts = { title: '导出为 CSV', defaultPath: `${base}_${stamp}.csv`, filters: [{ name: 'CSV（Excel 可直接打开）', extensions: ['csv'] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      const csv = buildCsv(columns, rows, columns)
      await fs.writeFile(r.filePath, csv, 'utf8')
      appendAudit({ kind: 'tool', actor: 'human', conn: '产物面板', target: r.filePath, detail: `导出产物 ${rows.length} 行 × ${columns.length} 列`, rows: rows.length })
      return { ok: true, path: r.filePath, rows: rows.length }
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e) }
    }
  })

  // ---------- 数据库信息面板（Navicat 式概览，逐项容错：无权限的项自动略过） ----------
  interface InfoSection { title: string; rows: { k: string; v: string }[]; group?: string }
  interface InfoTable { title: string; columns: string[]; rows: any[][]; group?: string }
  /** 顶部 KPI 磁贴：给 DBA 一眼看到状态，数值型指标同时以图表呈现 */
  interface InfoKpi { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }
  interface InfoChartItem { label: string; value: number; hint?: string }
  /** 图形化指标：gauge=单值占比环 / donut=分类占比环 / bars=横向条形 / stack=单条堆叠
   *  group：与同组 sections/tables 在同一张卡片里展示（图表与明细必须挨在一起，不单独成区） */
  interface InfoChart {
    id: string
    title: string
    kind: 'gauge' | 'donut' | 'bars' | 'stack'
    unit?: string
    /** gauge 用：value / total（渲染层据此算百分比，不再回传 pct 字符串） */
    value?: number
    total?: number
    caption?: string
    items: InfoChartItem[]
    note?: string
    group?: string
  }
  interface InfoData { sections: InfoSection[]; tables: InfoTable[]; charts: InfoChart[]; kpis: InfoKpi[] }
  const businessSchemaFilter = `table_schema NOT IN (${[...MYSQL_SYSTEM_SCHEMAS].map((s) => `'${s}'`).join(', ')})`

  // 图表取数辅助：数据库驱动返回的可能是字符串/Decimal，统一转数字，异常值归零
  const toNum = (v: any): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  const fmtCap = (mb: number): string =>
    mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb.toFixed(0)} MB`
  /** 时间值归一：驱动可能给 Date，也可能给字符串；KPI 副标题里统一成 YYYY-MM-DD HH:mm */
  const fmtTime = (v: any): string => {
    if (v instanceof Date) {
      const p = (n: number) => String(n).padStart(2, '0')
      return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`
    }
    const s = String(v ?? '')
    return s.length >= 16 ? s.slice(0, 16) : s
  }
  const toneOf = (pct: number): 'ok' | 'warn' | 'bad' => (pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : 'ok')
  /** 分类项过多时合并尾部为「其他」，避免环图碎片化 */
  const foldItems = (items: InfoChartItem[], keep = 6): InfoChartItem[] => {
    const sorted = [...items].sort((a, b) => b.value - a.value)
    if (sorted.length <= keep + 1) return sorted
    const rest = sorted.slice(keep)
    return [...sorted.slice(0, keep), { label: '其他', value: rest.reduce((s, r) => s + r.value, 0) }]
  }

  async function tryQuery(adapter: any, sql: string): Promise<any[][] | null> {
    try {
      const r = await adapter.query(sql, 500, 30_000)
      return r.rows as any[][]
    } catch {
      return null
    }
  }

  async function tryQueryResult(adapter: any, sql: string): Promise<{ columns: string[]; rows: any[][] } | null> {
    try {
      const r = await adapter.query(sql, 500, 30_000)
      return { columns: r.columns, rows: r.rows as any[][] }
    } catch {
      return null
    }
  }

  const columnIndex = (columns: string[], names: string[]): number =>
    columns.findIndex((column) => names.includes(column.toLowerCase()))

  const columnValue = (columns: string[], row: any[], names: string[]): any => {
    const index = columnIndex(columns, names)
    return index >= 0 ? row[index] : undefined
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

  async function oracleInfo(adapter: any, profile: ConnProfile): Promise<InfoData> {
    const sections: InfoSection[] = []
    const tables: InfoTable[] = []
    const charts: InfoChart[] = []
    const kpis: InfoKpi[] = []

    const isObOracle = profile.type === 'ob-oracle'
    const banner = isObOracle
      ? await tryQuery(adapter, `SELECT banner FROM v$version WHERE ROWNUM <= 2`)
      : await tryQuery(adapter, `SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'`)
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
    if (isObOracle) {
      const tenant = profile.obTenant || profile.user.split('@')[1]?.split('#')[0]
      const cluster = profile.obCluster || profile.user.split('#')[1]
      rows.push(
        { k: 'OceanBase 租户', v: tenant || '（未识别）' },
        { k: 'OceanBase 集群', v: cluster || '（未配置）' },
        { k: '连接入口', v: `${profile.obConnectMode === 'observer' ? 'Observer' : 'OBProxy'} · ${profile.host}:${profile.port}` }
      )
    }
    if (rows.length) sections.push({ title: '服务器', rows })

    if (isObOracle) {
      const zones = await tryQuery(adapter, `SELECT zone, status, info FROM SYS.DBA_OB_ZONES ORDER BY zone`)
      if (zones) tables.push({ title: 'OB Zone 状态', columns: ['Zone', '状态', '说明'], rows: zones })

      const servers = await tryQuery(adapter, `SELECT zone, svr_ip, status FROM SYS.GV$OB_SERVERS ORDER BY zone`)
      if (servers) tables.push({ title: 'OB 节点', columns: ['Zone', '服务器', '状态'], rows: servers })

      const compaction = await tryQuery(adapter, `SELECT status, frozen_scn, last_scn, TO_CHAR(last_finish_time, 'YYYY-MM-DD HH24:MI:SS') FROM SYS.DBA_OB_MAJOR_COMPACTION`)
      if (compaction) tables.push({ title: '合并状态（Major Compaction）', columns: ['状态', 'Frozen SCN', 'Last SCN', '完成时间'], rows: compaction })
    }

    const sess = await tryQuery(adapter, `SELECT COUNT(*), COUNT(CASE WHEN wait_class <> 'Idle' AND username IS NOT NULL THEN 1 END) FROM v$session`)
    if (sess) {
      sections.push({
        title: '会话',
        group: 'sessions',
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
    if (ts) tables.push({ title: '表空间使用（需 DBA 视图权限）', group: 'ts', columns: ['表空间', '总量 MB', '空闲 MB', '已用 %'], rows: ts })

    const objs = await tryQuery(adapter, `SELECT object_type, COUNT(*) FROM user_objects GROUP BY object_type ORDER BY 1`)
    if (objs) tables.push({ title: '当前用户对象统计', group: 'objects', columns: ['对象类型', '数量'], rows: objs })

    const sga = await tryQuery(adapter, `SELECT name, value FROM v$sgainfo WHERE name IN ('Buffer Cache Size','Shared Pool Size','Large Pool Size','Java Pool Size','Maximum SGA Size')`)
    if (sga) {
      sections.push({ title: '内存（SGA）', group: 'sga', rows: sga.map((r) => ({ k: String(r[0]), v: fmtMB(r[1]) })) })
    }

    // ---------- 图形化看板（与上面表格同源，只是把关键指标算成图） ----------
    if (inst?.length) {
      const st = String(inst[0][2] || '').toUpperCase()
      kpis.push({ label: '实例状态', value: st || '—', sub: String(inst[0][0] || ''), tone: st === 'OPEN' ? 'ok' : 'warn' })
    }
    if (db?.length) {
      const arch = String(db[0][2] || '').toUpperCase()
      kpis.push({ label: '归档模式', value: arch || '—', sub: String(db[0][3] || ''), tone: arch === 'ARCHIVELOG' ? 'ok' : 'warn' })
    }
    if (sess?.length) {
      const totalSession = toNum(sess[0][0])
      const activeSession = toNum(sess[0][1])
      kpis.push({
        label: '会话', value: `${activeSession} / ${totalSession}`, sub: '活跃 / 总数',
        tone: totalSession > 0 && activeSession / totalSession >= 0.6 ? 'warn' : 'ok'
      })
      charts.push({
        id: 'sessions', title: '会话构成', kind: 'donut', unit: '个', group: 'sessions',
        items: [{ label: '活跃', value: activeSession }, { label: '空闲/非活跃', value: Math.max(0, totalSession - activeSession) }]
      })
    }
    if (ts?.length) {
      const tsRows = ts.map((r) => ({
        name: String(r[0]),
        total: toNum(r[1]),
        used: Math.max(0, toNum(r[1]) - toNum(r[2])),
        pct: toNum(r[3])
      })).filter((r) => r.total > 0)
      const totalMb = tsRows.reduce((s, r) => s + r.total, 0)
      const usedMb = tsRows.reduce((s, r) => s + r.used, 0)
      const overall = totalMb > 0 ? (usedMb / totalMb) * 100 : 0
      kpis.push({
        label: '表空间使用率', value: `${overall.toFixed(1)}%`,
        sub: `${fmtCap(usedMb)} / ${fmtCap(totalMb)}`, tone: toneOf(overall)
      })
      if (totalMb > 0) {
        charts.push({
          id: 'ts-total', title: '表空间总体使用', kind: 'gauge', unit: '%', group: 'ts',
          value: usedMb, total: totalMb,
          caption: `${fmtCap(usedMb)} 已用 · ${fmtCap(Math.max(0, totalMb - usedMb))} 空闲`,
          items: []
        })
      }
      charts.push({
        id: 'ts-top', title: '表空间使用率 TOP 8', kind: 'bars', unit: '%', group: 'ts',
        items: tsRows.sort((a, b) => b.pct - a.pct).slice(0, 8)
          .map((r) => ({ label: r.name, value: Number(r.pct.toFixed(1)), hint: `${fmtCap(r.used)} / ${fmtCap(r.total)}` }))
      })
    }
    if (sga?.length) {
      const parts = sga
        .map((r) => ({ label: String(r[0]).replace(/\s*Size$/, ''), value: Math.round(toNum(r[1]) / 1048576) }))
        .filter((p) => p.value > 0 && p.label !== 'Maximum SGA')
      if (parts.length) charts.push({ id: 'sga', title: 'SGA 内存组成', kind: 'stack', unit: 'MB', group: 'sga', items: parts })
    }
    if (objs?.length) {
      charts.push({
        id: 'objects', title: '对象类型分布（当前用户）', kind: 'donut', unit: '个', group: 'objects',
        items: foldItems(objs.map((r) => ({ label: String(r[0]), value: toNum(r[1]) })))
      })
    }
    return { sections, tables, charts, kpis }
  }

  async function obOracleInfo(adapter: any, profile: ConnProfile): Promise<InfoData> {
    const sections: InfoSection[] = []
    const tables: InfoTable[] = []
    const charts: InfoChart[] = []
    const kpis: InfoKpi[] = []
    const diagnostics: string[] = []

    const version = await tryQuery(adapter, 'SELECT banner FROM v$version WHERE ROWNUM <= 2')
    const tenant = await tryQuery(adapter, `
      SELECT tenant_id, tenant_name, tenant_type, primary_zone, locality, compatibility_mode,
             status, tenant_role, switchover_status, log_mode, unit_num, compatible
      FROM SYS.DBA_OB_TENANTS`)
    const nls = await tryQuery(adapter, `
      SELECT parameter, value FROM NLS_DATABASE_PARAMETERS
      WHERE parameter IN ('NLS_LANGUAGE','NLS_CHARACTERSET','NLS_NCHAR_CHARACTERSET','NLS_DATE_FORMAT')`)
    const sessions = await tryQuery(adapter, `
      SELECT COUNT(*), COUNT(CASE WHEN command <> 'Sleep' THEN 1 END)
      FROM SYS.GV$OB_PROCESSLIST`)

    const serverRows: { k: string; v: string }[] = []
    if (version?.length) serverRows.push({ k: '数据库产品', v: String(version[0][0]) })
    if (tenant?.length) {
      serverRows.push(
        { k: '租户', v: `${tenant[0][1]}（ID ${tenant[0][0]}，${tenant[0][2]}）` },
        { k: 'Primary Zone', v: String(tenant[0][3]) },
        { k: 'Locality', v: String(tenant[0][4]) },
        { k: '兼容模式', v: String(tenant[0][5]) },
        { k: '租户状态', v: String(tenant[0][6]) },
        { k: '租户角色', v: String(tenant[0][7]) },
        { k: 'Switchover', v: String(tenant[0][8]) },
        { k: '日志模式', v: String(tenant[0][9]) },
        { k: 'Unit 数', v: String(tenant[0][10]) },
        { k: '兼容版本', v: String(tenant[0][11]) }
      )
    }
    serverRows.push(
      { k: '连接入口', v: `${profile.obConnectMode === 'observer' ? 'Observer' : 'OBProxy'} · ${profile.host}:${profile.port}` },
      { k: '配置租户', v: profile.obTenant || '（未识别）' },
      { k: '配置集群', v: profile.obCluster || '（未配置）' }
    )
    if (nls?.length) sections.push({ title: 'NLS / 字符集', rows: nls.map((row) => ({ k: String(row[0]), v: String(row[1]) })) })
    if (sessions?.length) {
      sections.push({
        title: '会话',
        group: 'sessions',
        rows: [
          { k: '会话总数', v: String(sessions[0][0]) },
          { k: '活跃会话', v: `${sessions[0][1]}（GV$OB_PROCESSLIST，详见下方列表）` }
        ]
      })
    }
    sections.push({ title: '服务器 / 租户', rows: serverRows })

    const databases = await tryQuery(adapter, `
      SELECT database_name, in_recyclebin, collation, read_only, comment
      FROM SYS.DBA_OB_DATABASES ORDER BY database_name`)
    if (databases) tables.push({
      title: '数据库 / Schema',
      columns: ['数据库', '回收站', '字符序', '只读', '说明'],
      rows: databases
    })

    const objects = await tryQuery(adapter, `
      SELECT object_type, COUNT(*) FROM user_objects GROUP BY object_type ORDER BY 1`)
    if (objects) tables.push({ title: '当前用户对象统计', group: 'objects', columns: ['对象类型', '数量'], rows: objects })

    const logStreams = await tryQuery(adapter, `
      SELECT ls_id, status, primary_zone, unit_group_id, ls_group_id, sync_scn, readable_scn
      FROM SYS.DBA_OB_LS ORDER BY ls_id`)
    if (logStreams) tables.push({
      title: 'LogStream',
      columns: ['LS', '状态', 'Primary Zone', 'Unit Group', 'LS Group', 'Sync SCN', 'Readable SCN'],
      rows: logStreams
    })

    const lsLocations = await tryQuery(adapter, `
      SELECT ls_id, zone, svr_ip, svr_port, role, replica_type, paxos_replica_number, member_list
      FROM SYS.DBA_OB_LS_LOCATIONS ORDER BY ls_id, zone, svr_ip`)
    if (lsLocations) tables.push({
      title: 'LogStream 副本分布',
      columns: ['LS', 'Zone', '服务器', 'RPC 端口', '角色', '副本类型', 'Paxos 副本数', '成员列表'],
      rows: lsLocations
    })

    const replicaDistribution = await tryQuery(adapter, `
      SELECT zone, role, COUNT(*)
      FROM SYS.DBA_OB_TABLE_LOCATIONS GROUP BY zone, role ORDER BY zone, role`)
    if (replicaDistribution) tables.push({
      title: '表副本分布（按 Zone/角色）',
      group: 'replica',
      columns: ['Zone', '角色', '副本记录数'],
      rows: replicaDistribution
    })

    const tabletStorage = await tryQuery(adapter, `
      SELECT svr_ip, COUNT(*), ROUND(SUM(data_size) / 1048576, 1), ROUND(SUM(required_size) / 1048576, 1)
      FROM SYS.DBA_OB_TABLET_REPLICAS GROUP BY svr_ip ORDER BY svr_ip`)
    if (tabletStorage) tables.push({
      title: 'Tablet 存储分布',
      group: 'storage',
      columns: ['服务器', 'Tablet 副本数', '数据量 MB', '占用 MB'],
      rows: tabletStorage
    })

    const compaction = await tryQuery(adapter, `
      SELECT frozen_scn, global_broadcast_scn, last_scn,
             last_finish_time, start_time, status, is_error, is_suspended
      FROM SYS.DBA_OB_MAJOR_COMPACTION`)
    if (compaction) tables.push({
      title: '合并状态（Major Compaction）',
      columns: ['Frozen SCN', 'Broadcast SCN', 'Last SCN', 'Last Finish SCN', 'Start SCN', '状态', '错误', '暂停'],
      rows: compaction
    })

    const activeSessions = await tryQuery(adapter, `
      SELECT svr_ip, id, "USER", host, db, command, time, total_time, state,
             sql_id, trans_id, user_client_ip, in_bytes, out_bytes
      FROM SYS.GV$OB_PROCESSLIST
      WHERE command <> 'Sleep' ORDER BY total_time DESC`)
    if (activeSessions) tables.push({
      title: '活跃会话',
      columns: ['服务器', '连接 ID', '用户', '客户端', '数据库', '命令', '秒', '累计毫秒', '状态', 'SQL ID', '事务 ID', '用户 IP', '入站', '出站'],
      rows: activeSessions
    })

    const deadlocks = await tryQuery(adapter, `
      SELECT event_id, svr_ip, svr_port, TO_CHAR(report_time, 'YYYY-MM-DD HH24:MI:SS'),
             cycle_idx, cycle_size, role, priority, module, visitor, object
      FROM SYS.DBA_OB_DEADLOCK_EVENT_HISTORY ORDER BY report_time DESC`)
    if (deadlocks) tables.push({
      title: '死锁历史',
      columns: ['事件', '服务器', '端口', '报告时间', '环序号', '环大小', '角色', '优先级', '模块', '访问者', '对象'],
      rows: deadlocks
    })

    const concurrentLimits = await tryQuery(adapter, `
      SELECT database_name, outline_name, concurrent_num, limit_target, visible_signature, sql_text
      FROM SYS.DBA_OB_CONCURRENT_LIMIT_SQL ORDER BY database_name, outline_name`)
    if (concurrentLimits) tables.push({
      title: '并发限制',
      columns: ['数据库', '规则名', '并发数', '限制目标', '签名', 'SQL'],
      rows: concurrentLimits
    })

    const parameters = await tryQuery(adapter, `
      SELECT name, value FROM SYS.DBA_OB_SYS_VARIABLES
      WHERE name IN (
        'autocommit','sql_mode','max_connections','ob_query_timeout','ob_trx_timeout',
        'ob_max_read_concurrent_sessions','net_read_timeout','net_write_timeout',
        'query_cache_size','max_allowed_packet','tx_isolation'
      ) ORDER BY name`)
    if (parameters) sections.push({ title: '关键参数', rows: parameters.map((row) => ({ k: String(row[0]), v: String(row[1]) })) })

    const unavailableViews = [
      ['Zone / 节点拓扑', 'SYS.DBA_OB_ZONES / SYS.GV$OB_SERVERS'],
      ['租户 Unit / 资源池', 'SYS.DBA_OB_UNITS / SYS.DBA_OB_RESOURCE_POOLS'],
      ['MemStore 转储压力', 'SYS.GV$OB_MEMSTORE']
    ]
    for (const [label, view] of unavailableViews) {
      diagnostics.push(`${label}：当前 Oracle 租户账号不可见 ${view}；请使用 sys 租户或集群级监控查看。`)
    }
    sections.push({ title: '采集诊断', rows: diagnostics.map((message) => ({ k: '提示', v: message })) })

    // ---------- 图形化看板 ----------
    if (tenant?.length) {
      const st = String(tenant[0][6] || '').toUpperCase()
      kpis.push({ label: '租户状态', value: st || '—', sub: String(tenant[0][1] || ''), tone: st === 'NORMAL' ? 'ok' : 'warn' })
      const tenantType = String(tenant[0][2] || '').toUpperCase()
      const typeLabel = tenantType === 'SYS' ? '系统租户' : tenantType === 'USER' ? '用户租户' : tenantType
      kpis.push({ label: 'Unit 数', value: String(tenant[0][10] ?? '—'), sub: typeLabel || '租户规格' })
    }
    if (sessions?.length) {
      const totalSession = toNum(sessions[0][0])
      const activeSession = toNum(sessions[0][1])
      kpis.push({
        label: '会话', value: `${activeSession} / ${totalSession}`, sub: '活跃 / 总数',
        tone: totalSession > 0 && activeSession / totalSession >= 0.6 ? 'warn' : 'ok'
      })
      charts.push({
        id: 'sessions', title: '会话构成', kind: 'donut', unit: '个', group: 'sessions',
        items: [{ label: '活跃', value: activeSession }, { label: '空闲/非活跃', value: Math.max(0, totalSession - activeSession) }]
      })
    }
    if (compaction?.length) {
      const st = String(compaction[0][5] || '').toUpperCase()
      // last_finish_time 各版本可能给 Date、字符串或 SCN 数字——数字时不要假装成时间
      const finish = compaction[0][3]
      const finishText = finish instanceof Date || /^\d{4}-\d\d-\d\d/.test(String(finish ?? ''))
        ? `完成 ${fmtTime(finish)}`
        : finish != null ? `Last Finish SCN ${finish}` : 'Major Compaction'
      kpis.push({
        label: '合并状态', value: st || '—', sub: finishText,
        tone: st === 'IDLE' || st === 'FINISH' ? 'ok' : 'warn'
      })
    }
    if (tabletStorage?.length) {
      charts.push({
        id: 'tablet', title: 'Tablet 占用分布', kind: 'bars', unit: 'MB', group: 'storage',
        items: tabletStorage
          .map((r) => ({ label: String(r[0]), value: Math.round(toNum(r[3])), hint: `${toNum(r[1])} 个副本` }))
          .sort((a, b) => b.value - a.value)
      })
    }
    if (replicaDistribution?.length) {
      const byZone = new Map<string, number>()
      for (const r of replicaDistribution) {
        const zone = String(r[0])
        byZone.set(zone, (byZone.get(zone) || 0) + toNum(r[2]))
      }
      charts.push({
        id: 'replica-zone', title: '表副本分布（按 Zone）', kind: 'donut', unit: '条', group: 'replica',
        items: foldItems([...byZone].map(([label, value]) => ({ label, value })))
      })
    }
    if (objects?.length) {
      charts.push({
        id: 'objects', title: '对象类型分布（当前用户）', kind: 'donut', unit: '个', group: 'objects',
        items: foldItems(objects.map((r) => ({ label: String(r[0]), value: toNum(r[1]) })))
      })
    }
    return { sections, tables, charts, kpis }
  }

  async function mysqlInfo(adapter: any, profile: ConnProfile): Promise<InfoData> {
    const sections: InfoSection[] = []
    const tables: InfoTable[] = []
    const charts: InfoChart[] = []
    const kpis: InfoKpi[] = []
    const isOb = profile.type === 'ob-mysql'
    const diagnostics: string[] = []
    /** OB 块内采集到的事务 / 锁等待 / 活跃会话 / 合并状态（KPI 与图表统一在末尾输出） */
    let trxCount = -1
    let lockWaitCount = -1
    let obActive: any[][] | null = null
    let compactionRow: any[] | null = null

    const ver = await tryQuery(adapter, `SELECT VERSION()`)
    const rows: { k: string; v: string }[] = []
    if (ver?.length) rows.push({ k: '数据库版本', v: String(ver[0][0]) })
    if (isOb) {
      const legacyUser = profile.user.split('@')
      const legacyTenant = legacyUser[1]?.split('#')[0]
      const legacyCluster = profile.user.split('#')[1]
      rows.push(
        { k: '连接入口', v: `${profile.obConnectMode === 'observer' ? 'Observer' : 'OBProxy'} · ${profile.host}:${profile.port}` },
        { k: '配置租户', v: profile.obTenant || legacyTenant || '（未识别）' },
        { k: '配置集群', v: profile.obCluster || legacyCluster || '（未配置）' },
        { k: '默认数据库', v: profile.database || '（未配置）' }
      )
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

    const st = await tryQuery(adapter, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Max_used_connections','Questions','Slow_queries','Aborted_connects','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads')`)
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
      WHERE ${businessSchemaFilter}
      GROUP BY table_schema ORDER BY SUM(data_length + index_length) DESC LIMIT 15`)
    if (size) tables.push({ title: '库容量 TOP 15', group: 'capacity', columns: ['数据库', '表数', '数据量 MB'], rows: size })

    if (isOb) {
      const tenant = await tryQuery(adapter, `
        SELECT tenant_name, primary_zone, compatibility_mode, status, unit_num
        FROM oceanbase.DBA_OB_TENANTS
        WHERE tenant_id = (SELECT effective_tenant_id())`)
      if (tenant) {
        sections.push({
          title: 'OceanBase 租户',
          rows: [
            { k: '租户名', v: String(tenant[0][0]) },
            { k: 'Primary Zone', v: String(tenant[0][1]) },
            { k: '兼容模式', v: String(tenant[0][2]) },
            { k: '状态', v: String(tenant[0][3]) },
            { k: 'Unit 数', v: String(tenant[0][4]) }
          ]
        })
      }

      const poolResult = await tryQueryResult(adapter, `
        SELECT * FROM oceanbase.DBA_OB_RESOURCE_POOLS
        WHERE tenant_id = (SELECT effective_tenant_id())`)
      if (!poolResult) {
        diagnostics.push('租户资源池采集失败：可能缺少 DBA_OB_RESOURCE_POOLS 权限，或当前 OB 版本不提供该视图。')
      } else {
        const configResult = await tryQueryResult(adapter, `SELECT * FROM oceanbase.DBA_OB_UNIT_CONFIGS`)
        if (!configResult) diagnostics.push('Unit 规格采集失败：可能缺少 DBA_OB_UNIT_CONFIGS 权限，或当前 OB 版本不提供该视图。')
        const configIdIndex = columnIndex(configResult?.columns || [], ['unit_config_id'])
        const configById = new Map<string, any[]>()
        for (const row of configResult?.rows || []) {
          const id = configIdIndex >= 0 ? String(row[configIdIndex]) : ''
          if (id) configById.set(id, row)
        }
        const poolConfigIdIndex = columnIndex(poolResult.columns, ['unit_config_id'])
        const resourceRows = poolResult.rows.map((poolRow) => {
          const configRow = poolConfigIdIndex >= 0 ? configById.get(String(poolRow[poolConfigIdIndex])) : undefined
          const memory = columnValue(configResult?.columns || [], configRow || [], ['max_memory', 'memory_size'])
          const disk = columnValue(configResult?.columns || [], configRow || [], ['max_disk_size', 'log_disk_size'])
          return [
            columnValue(poolResult.columns, poolRow, ['resource_pool_name', 'name']),
            columnValue(poolResult.columns, poolRow, ['unit_count']),
            columnValue(configResult?.columns || [], configRow || [], ['name']),
            columnValue(configResult?.columns || [], configRow || [], ['max_cpu']),
            memory === undefined || memory === null ? '—' : fmtMB(memory),
            disk === undefined || disk === null ? '—' : fmtMB(disk),
            columnValue(configResult?.columns || [], configRow || [], ['max_session_num'])
          ]
        })
        tables.push({
          title: '租户资源池 / Unit 规格',
          columns: ['资源池', 'Unit 数', '规格名', 'Max CPU', 'Max Memory', 'Max/Log Disk', 'Max Session'],
          rows: resourceRows
        })
      }

      const units = await tryQuery(adapter, `
        SELECT unit_id, unit_group_id, zone, svr_ip, svr_port, status
        FROM oceanbase.DBA_OB_UNITS ORDER BY zone, svr_ip, unit_id`)
      if (units) tables.push({
        title: 'Unit 分布',
        columns: ['Unit', 'Unit Group', 'Zone', '服务器', 'SQL 端口', '状态'],
        rows: units
      })

      const zones = await tryQuery(adapter, `SELECT zone, status, info FROM oceanbase.DBA_OB_ZONES ORDER BY zone`)
      if (zones) tables.push({ title: 'Zone 状态', columns: ['Zone', '状态', '说明'], rows: zones })

      const servers = await tryQuery(adapter, `SELECT zone, svr_ip, status FROM oceanbase.GV$OB_SERVERS ORDER BY zone`)
      if (servers) tables.push({ title: 'OB 节点', columns: ['Zone', '服务器', '状态'], rows: servers })

      const memstore = await tryQuery(adapter, `
        SELECT svr_ip, active, hold, freeze_cnt,
               ROUND(active / NULLIF(hold, 0) * 100, 1)
        FROM oceanbase.GV$OB_MEMSTORE
        WHERE tenant_id = (SELECT effective_tenant_id()) ORDER BY svr_ip`)
      if (memstore) tables.push({
        title: 'MemStore / 转储压力',
        group: 'memstore',
        columns: ['服务器', 'Active', 'Hold', 'Freeze 次数', '使用率 %'],
        rows: memstore
      })
      if (memstore?.length) {
        charts.push({
          id: 'memstore', title: 'MemStore 使用率', kind: 'bars', unit: '%', group: 'memstore',
          items: memstore
            .map((r) => ({ label: String(r[0]), value: toNum(r[4]), hint: `Freeze ${toNum(r[3])} 次` }))
            .sort((a, b) => b.value - a.value)
        })
      }

      const compaction = await tryQuery(adapter, `
        SELECT status, frozen_scn, last_scn, last_finish_time
        FROM oceanbase.DBA_OB_MAJOR_COMPACTION`)
      if (compaction) tables.push({
        title: '合并状态（Major Compaction）',
        columns: ['状态', 'Frozen SCN', 'Last SCN', '完成时间'],
        rows: compaction
      })
      compactionRow = compaction?.length ? compaction[0] : null

      const activeSessions = await tryQuery(adapter, `
        SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE
        FROM information_schema.PROCESSLIST
        WHERE COMMAND <> 'Sleep' ORDER BY TIME DESC LIMIT 50`)
      if (activeSessions) tables.push({
        title: '活跃会话 TOP 50',
        group: 'active',
        columns: ['连接 ID', '用户', '客户端', '数据库', '命令', '持续秒', '状态'],
        rows: activeSessions
      })
      obActive = activeSessions

      const trx = await tryQuery(adapter, `
        SELECT trx_id, trx_state, trx_started, trx_mysql_thread_id, trx_query
        FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 50`)
      if (trx) tables.push({
        title: '当前事务（需视图权限）',
        columns: ['事务 ID', '状态', '开始时间', '连接 ID', 'SQL'],
        rows: trx
      })
      trxCount = trx ? trx.length : -1

      const lockWaits = await tryQuery(adapter, `
        SELECT requesting_trx_id, requested_lock_id, blocking_trx_id, blocking_lock_id
        FROM information_schema.INNODB_LOCK_WAITS LIMIT 50`)
      if (lockWaits) tables.push({
        title: '锁等待（需视图权限）',
        columns: ['等待事务', '请求锁', '阻塞事务', '阻塞锁'],
        rows: lockWaits
      })
      lockWaitCount = lockWaits ? lockWaits.length : -1

      const params = await tryQuery(adapter, `
        SHOW VARIABLES WHERE Variable_name IN (
          'autocommit','tx_isolation','sql_mode','max_connections',
          'ob_query_timeout','ob_trx_timeout','ob_max_read_concurrent_sessions',
          'net_read_timeout','net_write_timeout'
        )`)
      if (params) sections.push({ title: 'OceanBase 关键参数', rows: params.map((r) => ({ k: String(r[0]), v: String(r[1]) })) })
      if (diagnostics.length) sections.push({ title: '采集诊断', rows: diagnostics.map((message) => ({ k: '提示', v: message })) })
    }

    // ---------- 图形化看板 ----------
    const varMap = new Map<string, any>((vc || []).map((r: any[]) => [String(r[0]), r[1]]))
    const statusMap = new Map<string, any>((st || []).map((r: any[]) => [String(r[0]), r[1]]))
    const connected = toNum(statusMap.get('Threads_connected'))
    const running = toNum(statusMap.get('Threads_running'))
    const maxConn = toNum(varMap.get('max_connections'))
    const uptime = toNum(statusMap.get('Uptime'))
    const questions = toNum(statusMap.get('Questions'))

    if (uptime > 0) kpis.push({ label: '运行时长', value: fmtUptime(uptime) })
    // OceanBase 的 max_connections 是巨型占位值（2147483647），此时"连接使用率"没有意义，
    // 改看「活跃连接占比」——多少连接真正在干活，对 DBA 更有信息量
    const saneMax = maxConn > 0 && maxConn < 1_000_000
    if (saneMax) {
      const usage = (connected / maxConn) * 100
      kpis.push({ label: '连接数', value: `${connected} / ${maxConn}`, sub: `${running} 个活跃`, tone: toneOf(usage) })
      charts.push({
        id: 'conn-usage', title: '连接使用率', kind: 'gauge', unit: '%',
        value: connected, total: maxConn,
        caption: `${connected} / ${maxConn} · 活跃 ${running}`,
        items: []
      })
    } else if (connected > 0) {
      // OB 的 max_connections 不可用：改看连接池里有多少连接正在干活（0 活跃时也是完整的一环，不会出现空环）
      kpis.push({ label: '连接数', value: String(connected), sub: `${running} 个活跃` })
      charts.push({
        id: 'conn-state', title: '连接状态', kind: 'donut', unit: '个',
        note: `${running} 活跃 / ${connected} 已连接`,
        items: [
          { label: '活跃', value: running },
          { label: '空闲', value: Math.max(0, connected - running) }
        ]
      })
    }
    // 缓冲池命中率：低于 95% 就要怀疑缓冲池偏小或全表扫描（OB 无此状态变量时自动跳过）
    const bpReq = toNum(statusMap.get('Innodb_buffer_pool_read_requests'))
    const bpReads = toNum(statusMap.get('Innodb_buffer_pool_reads'))
    if (bpReq > 0) {
      const hit = Math.max(0, Math.min(100, (1 - bpReads / bpReq) * 100))
      kpis.push({ label: '缓冲池命中率', value: `${hit.toFixed(2)}%`, sub: `物理读 ${bpReads}`, tone: hit >= 99 ? 'ok' : hit >= 95 ? 'warn' : 'bad' })
      charts.push({
        id: 'bp-hit', title: 'InnoDB 缓冲池命中率', kind: 'gauge', unit: '%',
        value: hit, total: 100,
        caption: `请求 ${bpReq.toLocaleString('en-US')} · 物理读 ${bpReads.toLocaleString('en-US')}`,
        items: []
      })
    }
    if (questions > 0 && uptime > 0) {
      const qps = questions / uptime
      kpis.push({ label: '平均 QPS', value: qps >= 100 ? qps.toFixed(0) : qps.toFixed(1), sub: '自启动以来均值' })
    }
    if (statusMap.has('Slow_queries')) {
      const slow = toNum(statusMap.get('Slow_queries'))
      kpis.push({ label: '慢查询', value: String(slow), sub: `累计查询 ${questions.toLocaleString('en-US')}`, tone: slow > 0 ? 'warn' : 'ok' })
    }
    if (trxCount >= 0) kpis.push({ label: '当前事务', value: String(trxCount), sub: '未提交事务数', tone: trxCount > 20 ? 'warn' : 'ok' })
    if (lockWaitCount >= 0) kpis.push({ label: '锁等待', value: String(lockWaitCount), sub: '行锁阻塞', tone: lockWaitCount > 0 ? 'bad' : 'ok' })
    if (compactionRow) {
      const st = String(compactionRow[0] || '').toUpperCase()
      kpis.push({
        label: '合并状态', value: st || '—',
        sub: compactionRow[3] ? `完成 ${fmtTime(compactionRow[3])}` : 'Major Compaction',
        tone: st === 'IDLE' || st === 'FINISH' ? 'ok' : 'warn'
      })
    }
    // 活跃会话按用户分布：谁在压库一眼可见（OB 的 PROCESSLIST 列：ID, USER, HOST, DB, ...）
    if (obActive?.length) {
      const byUser = new Map<string, number>()
      for (const row of obActive) {
        const user = String(row[1] ?? '未知')
        byUser.set(user, (byUser.get(user) || 0) + 1)
      }
      charts.push({
        id: 'sessions-user', title: '活跃会话按用户', kind: 'donut', unit: '个', group: 'active',
        note: `共 ${obActive.length} 个非 Sleep 会话`,
        items: foldItems([...byUser].map(([label, value]) => ({ label, value })))
      })
    }

    // 库容量与表数量：OB 租户里 data_length 可能为 0，容量图会空——此时退回按表数量排行
    const schemaRows = (size || []).map((r) => ({
      label: String(r[0]),
      mb: toNum(r[2]),
      tables: toNum(r[1])
    }))
    const capacity = schemaRows.filter((r) => r.mb > 0)
    if (capacity.length) {
      const totalMb = capacity.reduce((s, r) => s + r.mb, 0)
      charts.push({
        id: 'schema-capacity', title: '库容量 TOP 10', kind: 'bars', unit: 'MB', group: 'capacity',
        note: `合计 ${fmtCap(totalMb)}（不含系统库）`,
        items: capacity.slice(0, 10).map((r) => ({ label: r.label, value: Math.round(r.mb), hint: `${r.tables} 张表` }))
      })
    }
    const tableRows = schemaRows.filter((r) => r.tables > 0)
    if (tableRows.length) {
      charts.push({
        id: 'schema-tables',
        title: capacity.length ? '各库表数量分布' : '各库表数量 TOP 8',
        kind: capacity.length ? 'donut' : 'bars',
        unit: '张',
        group: 'capacity',
        items: capacity.length
          ? foldItems(tableRows.map((r) => ({ label: r.label, value: r.tables })))
          : tableRows.slice(0, 8).map((r) => ({ label: r.label, value: r.tables }))
      })
    }

    return { sections, tables, charts, kpis }
  }

  ipcMain.handle('conn:info', async (_e, { id }: { id: string }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === id)
    if (!profile) return { ok: false, error: '连接不存在' }
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir)
      // 先显式建连：账号/网络错误直接透出，而不是显示成"未采集到信息"
      await adapter.connect()
      const data = profile.type === 'ob-oracle'
        ? await obOracleInfo(adapter, profile)
        : isOracleProtocol(profile)
        ? await oracleInfo(adapter, profile)
        : await mysqlInfo(adapter, profile)
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
  const OB_ORACLE_ACTIVE_SESSION_DEFAULT_COLS = [
    'SVR_IP', 'ID', 'USER', 'HOST', 'DB', 'COMMAND', 'TIME', 'TOTAL_TIME',
    'STATE', 'SQL_ID', 'TRANS_ID', 'USER_CLIENT_IP', 'IN_BYTES', 'OUT_BYTES'
  ]

  ipcMain.handle('conn:activeSessions', async (_e, { id, columns }: { id: string; columns?: string[] }) => {
    const cfg = loadConfig()
    const profile = cfg.connections.find((c) => c.id === id)
    if (!profile) return { ok: false, error: '连接不存在' }
    if (!isOracleProtocol(profile)) return { ok: false, error: '仅 Oracle 协议连接支持活跃会话查询' }
    try {
      const adapter = getAdapter(profile, cfg.instantClientDir)
      await adapter.connect()
      if (profile.type === 'ob-oracle') {
        const probe = await adapter.query('SELECT * FROM SYS.GV$OB_PROCESSLIST WHERE ROWNUM <= 1', 1, 30_000)
        const available = (probe.columns || []).map((column: string) => String(column).toUpperCase())
        const defaults = OB_ORACLE_ACTIVE_SESSION_DEFAULT_COLS
        const wanted = (columns?.length ? columns : defaults).map((column) => String(column).toUpperCase())
        const use = [...new Set(wanted)].filter((column) => available.includes(column))
        if (!use.length) return { ok: false, error: `所选列在 GV$OB_PROCESSLIST 中均不存在。可用列: ${available.join(', ')}` }
        const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
        const sql = `
          SELECT ${use.map(quote).join(', ')} FROM (
            SELECT ${use.map(quote).join(', ')}
            FROM SYS.GV$OB_PROCESSLIST
            WHERE command <> 'Sleep'
            ORDER BY total_time DESC, time DESC
          ) WHERE ROWNUM <= 500`
        const result = await adapter.query(sql, 500, 60_000)
        const skipped = wanted.filter((column) => !use.includes(column))
        return {
          ok: true,
          available,
          columns: use,
          rows: result.rows,
          ms: result.ms,
          note: skipped.length ? `本版本无这些列，已忽略: ${skipped.join(', ')}` : undefined
        }
      }
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
    const typed = apiKey && apiKey.trim()
    // 用已保存的 Key 测试时，目标地址/协议/模型必须取自主进程配置：
    // 否则渲染层只要传已有 id + 攻击者 baseUrl，就能把真实 Key 发到任意主机
    const saved = loadConfig().providers.find((p) => p.id === provider?.id)
    // WorkBuddy 的凭据不在表单里（由受管桥现场注入），未保存时也必须能测
    let target = typed || provider?.vendor === 'workbuddy' ? provider : saved
    if (!target) return { ok: false, error: '请先填写一次 API Key，或先保存该提供商' }
    let key = typed || getPassword(`provider:${target.id}`)
    // WorkBuddy：端点与令牌由受管桥给（配置里不需要明文 Key）
    if (target.vendor === 'workbuddy') {
      try {
        const r = await resolveWbProvider({ ...target, apiKey: typed || '' })
        target = r
        key = r.apiKey
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    }
    if (!key) return { ok: false, error: '没有可用的 API Key（未填写且无历史存储）' }
    const base = String(target.baseUrl || '').replace(/\/+$/, '')
    const url = target.protocol === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`
    const body: any =
      target.protocol === 'anthropic'
        ? { model: target.model, max_tokens: 4, messages: [{ role: 'user', content: 'ping' }] }
        : { model: target.model, max_tokens: 4, stream: false, messages: [{ role: 'user', content: 'ping' }] }
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

  // ---------- 拉取模型列表（OpenAI 兼容端点，本地桥/中转站都用得上） ----------
  // 与 provider:test 同样的凭据规则：填了新 Key 才允许用表单里的地址；否则地址与 Key 都取自主进程配置
  ipcMain.handle('provider:listModels', async (_e, { provider, apiKey }: { provider: any; apiKey?: string }) => {
    const typed = apiKey && apiKey.trim()
    const saved = loadConfig().providers.find((p) => p.id === provider?.id)
    let target = typed || provider?.vendor === 'workbuddy' ? provider : saved
    if (!target) return { ok: false, error: '先填写一次 API Key 再拉取（未保存的提供商无法复用历史 Key）' }
    let key = typed || getPassword(`provider:${target.id}`)
    if (target.vendor === 'workbuddy') {
      try {
        const r = await resolveWbProvider({ ...target, apiKey: typed || '' })
        target = r
        key = r.apiKey
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e) }
      }
    }
    const base = String(target.baseUrl || '').replace(/\/+$/, '')
    if (!base) return { ok: false, error: 'Base URL 为空' }
    if (target.protocol === 'anthropic') return { ok: false, error: 'Anthropic 协议没有 /models 列表接口，请手填型号' }
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 20_000)
      let res: any
      try {
        res = await fetch(`${base}/models`, {
          headers: key ? { Authorization: `Bearer ${key}`, Accept: 'application/json' } : { Accept: 'application/json' },
          signal: ctrl.signal
        })
      } finally {
        clearTimeout(timer)
      }
      const text = await res.text()
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ← ${text.slice(0, 300)}` }
      let models: string[] = []
      try {
        const j = JSON.parse(text)
        const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : []
        models = arr.map((m: any) => String(m?.id || m?.name || '')).filter(Boolean)
      } catch {
        return { ok: false, error: '返回的不是 JSON（可能不是 OpenAI 兼容端点）' }
      }
      if (!models.length) return { ok: false, error: '模型列表为空（端点可能不是 OpenAI 兼容，或令牌没有权限）' }
      appendAudit({ kind: 'tool', actor: 'human', detail: `拉取模型列表：${base}（${models.length} 个）` })
      return { ok: true, models: models.slice(0, 500) }
    } catch (e: any) {
      return { ok: false, error: `请求失败：${e?.message || e}` }
    }
  })

  // ---------- WorkBuddy 受管桥（模型通道） ----------
  // 桥是随包分发的子进程：这里只暴露启停与状态，令牌不经过渲染层
  ipcMain.handle('wb:status', () => bridgeStatus())
  ipcMain.handle('wb:start', () => startBridge())
  ipcMain.handle('wb:stop', () => stopBridge())
  ipcMain.handle('wb:login', () => openLoginDashboard())
  ipcMain.handle('wb:models', () => listBridgeModels())

  // ---------- 云管平台（目前对接 OceanBase OCP） ----------
  // 平台配置与密码分离：配置走 config.json，密码走 DPAPI；所有业务接口统一返回 { ok, data?, error? }
  ipcMain.handle('cloud:list', () => listPlatforms())
  ipcMain.handle('cloud:save', (_e, { platform, password }: { platform: any; password?: string }) => savePlatform(platform, password))
  ipcMain.handle('cloud:delete', (_e, { id }: { id: string }) => deletePlatform(String(id || '')))
  ipcMain.handle('cloud:test', (_e, { platform, password }: { platform: any; password?: string }) => testPlatform(platform, password))
  ipcMain.handle('cloud:status', (_e, { id }: { id: string }) => loginStatus(String(id || '')))
  // ---- Oracle 直连云平台 ----
  // 一个通用分区入口：section 决定查哪些视图，避免为每个页面单开一个 IPC
  ipcMain.handle('cloud:oraSection', (_e, { id, section, opts, force }: { id: string; section: any; opts?: any; force?: boolean }) =>
    cloudOracleSection(String(id || ''), section, opts || {}, !!force))
  ipcMain.handle('cloud:oraSqlDetail', (_e, { id, sqlId }: { id: string; sqlId: string }) =>
    cloudOracleSqlDetail(String(id || ''), String(sqlId || '')))
  ipcMain.handle('cloud:overview', (_e, { id }: { id: string }) => cloudOverview(String(id || '')))
  ipcMain.handle('cloud:clusters', (_e, { id }: { id: string }) => cloudClusters(String(id || '')))
  ipcMain.handle('cloud:cluster', (_e, { id, clusterId }: { id: string; clusterId: number }) => cloudClusterDetail(String(id || ''), Number(clusterId)))
  ipcMain.handle('cloud:tenants', (_e, { id }: { id: string }) => cloudTenants(String(id || '')))
  ipcMain.handle('cloud:tenant', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantDetail(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:hosts', (_e, { id }: { id: string }) => cloudHosts(String(id || '')))
  ipcMain.handle('cloud:alarms', (_e, { id, opts }: { id: string; opts?: any }) =>
    cloudAlarms(String(id || ''), opts || {}))
  ipcMain.handle('cloud:alarmHistory', (_e, { id, opts }: { id: string; opts?: any }) =>
    cloudAlarmHistory(String(id || ''), opts || {}))
  ipcMain.handle('cloud:alarmDetail', (_e, { id, alarmId }: { id: string; alarmId: number }) =>
    cloudAlarmDetail(String(id || ''), Number(alarmId)))
  ipcMain.handle('cloud:alarmRules', (_e, { id, opts }: { id: string; opts?: any }) =>
    cloudAlarmRules(String(id || ''), opts || {}))
  ipcMain.handle('cloud:alarmTrend', (_e, { id, hours }: { id: string; hours?: number }) =>
    cloudAlarmTrend(String(id || ''), Number(hours) || 24))
  ipcMain.handle('cloud:alarmLevelCounts', (_e, { id }: { id: string }) => cloudAlarmLevelCounts(String(id || '')))
  ipcMain.handle('cloud:tasks', (_e, { id, opts }: { id: string; opts?: any }) =>
    cloudTasks(String(id || ''), opts || {}))
  ipcMain.handle('cloud:taskDetail', (_e, { id, taskId }: { id: string; taskId: number }) =>
    cloudTaskDetail(String(id || ''), Number(taskId)))
  ipcMain.handle('cloud:taskStats', (_e, { id }: { id: string }) => cloudTaskStats(String(id || '')))
  ipcMain.handle('cloud:taskCreators', (_e, { id }: { id: string }) => cloudTaskCreators(String(id || '')))
  // 告警事件 / 任务列表导出 CSV：渲染层给列定义与行数据，主进程落盘
  ipcMain.handle('cloud:exportCsv', async (_e, { fileName, columns, rows }: { fileName: string; columns: string[]; rows: any[][] }) => {
    if (!Array.isArray(columns) || !Array.isArray(rows)) return { ok: false, error: '导出数据无效' }
    const safe = String(fileName || '导出').replace(/[\\/:*?"<>|]/g, '_')
    const defaultPath = `${safe}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`
    const filters = [{ name: 'CSV（Excel 可直接打开）', extensions: ['csv'] }]
    const r = win ? await dialog.showSaveDialog(win, { defaultPath, filters }) : await dialog.showSaveDialog({ defaultPath, filters })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      writeFileAtomic(r.filePath, buildCsv(columns, rows, columns))
      return { ok: true, path: r.filePath, count: rows.length }
    } catch (e: any) {
      return { ok: false, error: `写出失败：${e?.message || e}` }
    }
  })
  ipcMain.handle('cloud:metrics', (_e, { id, query }: { id: string; query: any }) => cloudMetrics(String(id || ''), query))
  ipcMain.handle('cloud:clusterAction', (_e, { id, clusterId, action }: { id: string; clusterId: number; action: string }) =>
    cloudClusterAction(String(id || ''), Number(clusterId), String(action)))
  ipcMain.handle('cloud:createTenant', (_e, { id, clusterId, input }: { id: string; clusterId: number; input: any }) =>
    cloudCreateTenant(String(id || ''), Number(clusterId), input))
  ipcMain.handle('cloud:deleteTenant', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudDeleteTenant(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:packages', (_e, { id }: { id: string }) => cloudPackages(String(id || '')))
  ipcMain.handle('cloud:clusterPreCheck', (_e, { id, input }: { id: string; input: any }) => cloudClusterPreCheck(String(id || ''), input))
  ipcMain.handle('cloud:clusterCreate', (_e, { id, input, checkId }: { id: string; input: any; checkId?: string }) =>
    cloudClusterCreate(String(id || ''), input, checkId))
  ipcMain.handle('cloud:clusterParams', (_e, { id, clusterId }: { id: string; clusterId: number }) => cloudClusterParams(String(id || ''), Number(clusterId)))
  ipcMain.handle('cloud:clusterUpdateParams', (_e, { id, clusterId, items }: { id: string; clusterId: number; items: { name: string; value: string }[] }) =>
    cloudClusterUpdateParams(String(id || ''), Number(clusterId), Array.isArray(items) ? items : []))
  ipcMain.handle('cloud:tenantParams', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantParams(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantUpdateParams', (_e, { id, clusterId, tenantId, items }: { id: string; clusterId: number; tenantId: number; items: { name: string; value: string }[] }) =>
    cloudTenantUpdateParams(String(id || ''), Number(clusterId), Number(tenantId), Array.isArray(items) ? items : []))
  ipcMain.handle('cloud:tenantChangePassword', (_e, { id, clusterId, tenantId, newPassword }: { id: string; clusterId: number; tenantId: number; newPassword: string }) =>
    cloudTenantChangePassword(String(id || ''), Number(clusterId), Number(tenantId), String(newPassword || '')))
  ipcMain.handle('cloud:tenantModifyWhitelist', (_e, { id, clusterId, tenantId, whitelist }: { id: string; clusterId: number; tenantId: number; whitelist: string }) =>
    cloudTenantModifyWhitelist(String(id || ''), Number(clusterId), Number(tenantId), String(whitelist || '')))
  ipcMain.handle('cloud:tenantModifyReplica', (_e, { id, clusterId, tenantId, replicas }: { id: string; clusterId: number; tenantId: number; replicas: any[] }) =>
    cloudTenantModifyReplica(String(id || ''), Number(clusterId), Number(tenantId), Array.isArray(replicas) ? replicas : []))
  ipcMain.handle('cloud:tenantAddReplica', (_e, { id, clusterId, tenantId, replicas }: { id: string; clusterId: number; tenantId: number; replicas: any[] }) =>
    cloudTenantAddReplica(String(id || ''), Number(clusterId), Number(tenantId), Array.isArray(replicas) ? replicas : []))
  ipcMain.handle('cloud:tenantDeleteReplica', (_e, { id, clusterId, tenantId, zones }: { id: string; clusterId: number; tenantId: number; zones: string[] }) =>
    cloudTenantDeleteReplica(String(id || ''), Number(clusterId), Number(tenantId), Array.isArray(zones) ? zones.map(String) : []))
  ipcMain.handle('cloud:tenantSetLocked', (_e, { id, clusterId, tenantId, locked }: { id: string; clusterId: number; tenantId: number; locked: boolean }) =>
    cloudTenantSetLocked(String(id || ''), Number(clusterId), Number(tenantId), !!locked))
  ipcMain.handle('cloud:tenantSessions', (_e, { id, clusterId, tenantId, page, size }: { id: string; clusterId: number; tenantId: number; page?: number; size?: number }) =>
    cloudTenantSessions(String(id || ''), Number(clusterId), Number(tenantId), Number(page) || 1, Number(size) || 200))
  ipcMain.handle('cloud:tenantCloseSessions', (_e, { id, clusterId, tenantId, sessionIds }: { id: string; clusterId: number; tenantId: number; sessionIds: number[] }) =>
    cloudTenantCloseSessions(String(id || ''), Number(clusterId), Number(tenantId), Array.isArray(sessionIds) ? sessionIds.map(Number) : []))

  // ---------- SQL 诊断 ----------
  ipcMain.handle('cloud:topSql', (_e, { id, clusterId, tenantId, opts }: { id: string; clusterId: number; tenantId: number; opts: { from: number; to: number; sqlText?: string; limit?: number } }) =>
    cloudTopSql(String(id || ''), Number(clusterId), Number(tenantId), opts))
  ipcMain.handle('cloud:slowSql', (_e, { id, clusterId, tenantId, opts }: { id: string; clusterId: number; tenantId: number; opts: { from: number; to: number } }) =>
    cloudSlowSql(String(id || ''), Number(clusterId), Number(tenantId), opts))
  ipcMain.handle('cloud:sqlText', (_e, { id, clusterId, tenantId, sqlId, opts }: { id: string; clusterId: number; tenantId: number; sqlId: string; opts: { from: number; to: number } }) =>
    cloudSqlText(String(id || ''), Number(clusterId), Number(tenantId), String(sqlId || ''), opts))
  ipcMain.handle('cloud:tenantSqlStats', (_e, { id, clusterId, from, to }: { id: string; clusterId: number; from: number; to: number }) =>
    cloudTenantSqlStats(String(id || ''), Number(clusterId), Number(from), Number(to)))

  // ---------- 租户详情页（对齐 OCP 各 tab） ----------
  ipcMain.handle('cloud:tenantDbs', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantDbs(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantTables', (_e, { id, clusterId, tenantId, db }: { id: string; clusterId: number; tenantId: number; db: string }) =>
    cloudTenantTables(String(id || ''), Number(clusterId), Number(tenantId), String(db || '')))
  ipcMain.handle('cloud:tenantTableSchema', (_e, { id, clusterId, tenantId, db, table }: { id: string; clusterId: number; tenantId: number; db: string; table: string }) =>
    cloudTenantTableSchema(String(id || ''), Number(clusterId), Number(tenantId), String(db || ''), String(table || '')))
  ipcMain.handle('cloud:tenantTopo', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantTopo(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantSessionStats', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantSessionStats(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantCloseQuery', (_e, { id, clusterId, tenantId, sessionIds }: { id: string; clusterId: number; tenantId: number; sessionIds: number[] }) =>
    cloudTenantCloseQuery(String(id || ''), Number(clusterId), Number(tenantId), (sessionIds || []).map(Number)))
  ipcMain.handle('cloud:tenantRowLocks', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantRowLocks(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantTxns', (_e, { id, clusterId, tenantId, thresholdMs }: { id: string; clusterId: number; tenantId: number; thresholdMs?: number }) =>
    cloudTenantTxns(String(id || ''), Number(clusterId), Number(tenantId), Number(thresholdMs) || 0))
  ipcMain.handle('cloud:tenantCloseTxns', (_e, { id, clusterId, tenantId, list }: { id: string; clusterId: number; tenantId: number; list: { sessionId: number; transId?: string }[] }) =>
    cloudTenantCloseTxns(String(id || ''), Number(clusterId), Number(tenantId), list || []))
  ipcMain.handle('cloud:tenantNewSql', (_e, { id, clusterId, tenantId, from, to, limit }: { id: string; clusterId: number; tenantId: number; from: number; to: number; limit?: number }) =>
    cloudTenantNewSql(String(id || ''), Number(clusterId), Number(tenantId), Number(from), Number(to), limit ? Number(limit) : undefined))
  ipcMain.handle('cloud:tenantHighRiskSql', (_e, { id, clusterId, tenantId, from, to, limit }: { id: string; clusterId: number; tenantId: number; from: number; to: number; limit?: number }) =>
    cloudTenantHighRiskSql(String(id || ''), Number(clusterId), Number(tenantId), Number(from), Number(to), limit ? Number(limit) : undefined))
  ipcMain.handle('cloud:tenantParallelSql', (_e, { id, clusterId, tenantId, from, to, limit }: { id: string; clusterId: number; tenantId: number; from: number; to: number; limit?: number }) =>
    cloudTenantParallelSql(String(id || ''), Number(clusterId), Number(tenantId), Number(from), Number(to), limit ? Number(limit) : undefined))
  ipcMain.handle('cloud:tenantOutlines', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantOutlines(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantSqlDiagnosis', (_e, { id, clusterId, tenantId, sqlId, from, to }: { id: string; clusterId: number; tenantId: number; sqlId: string; from: number; to: number }) =>
    cloudTenantSqlDiagnosis(String(id || ''), Number(clusterId), Number(tenantId), String(sqlId || ''), Number(from), Number(to)))
  ipcMain.handle('cloud:tenantCompaction', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantCompactionAll(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantCompactionAction', (_e, { id, clusterId, tenantId, action }: { id: string; clusterId: number; tenantId: number; action: 'trigger' | 'suspend' | 'resume' | 'clearError' }) =>
    cloudTenantCompactionAction(String(id || ''), Number(clusterId), Number(tenantId), action))
  ipcMain.handle('cloud:tenantUpdateCompactionSettings', (_e, { id, clusterId, tenantId, patch }: { id: string; clusterId: number; tenantId: number; patch: any }) =>
    cloudTenantUpdateCompactionSettings(String(id || ''), Number(clusterId), Number(tenantId), patch || {}))
  ipcMain.handle('cloud:tenantGather', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantGatherAll(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantBackup', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantBackupAll(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantUsers', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantUsers(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantTde', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantTde(String(id || ''), Number(clusterId), Number(tenantId)))

  // ---------- Unit 规格 / 克隆租户 / 创建备租户 ----------
  ipcMain.handle('cloud:unitSpecs', (_e, { id }: { id: string }) => cloudUnitSpecs(String(id || '')))
  ipcMain.handle('cloud:unitSpecCreate', (_e, { id, input }: { id: string; input: any }) =>
    cloudUnitSpecCreate(String(id || ''), input || {}))
  ipcMain.handle('cloud:unitSpecUpdate', (_e, { id, specId, input }: { id: string; specId: number; input: any }) =>
    cloudUnitSpecUpdate(String(id || ''), Number(specId), input || {}))
  ipcMain.handle('cloud:unitSpecDelete', (_e, { id, specId }: { id: string; specId: number }) =>
    cloudUnitSpecDelete(String(id || ''), Number(specId)))
  ipcMain.handle('cloud:tenantClonePreCheck', (_e, { id, clusterId, tenantId }: { id: string; clusterId: number; tenantId: number }) =>
    cloudTenantClonePreCheck(String(id || ''), Number(clusterId), Number(tenantId)))
  ipcMain.handle('cloud:tenantClone', (_e, { id, clusterId, tenantId, input }: { id: string; clusterId: number; tenantId: number; input: any }) =>
    cloudTenantClone(String(id || ''), Number(clusterId), Number(tenantId), input || {}))
  ipcMain.handle('cloud:primaryTenantInfo', (_e, { id, clusterId, primaryTenantId }: { id: string; clusterId: number; primaryTenantId: number }) =>
    cloudPrimaryTenantInfo(String(id || ''), Number(clusterId), Number(primaryTenantId)))
  ipcMain.handle('cloud:createStandbyTenant', (_e, { id, clusterId, input }: { id: string; clusterId: number; input: any }) =>
    cloudCreateStandbyTenant(String(id || ''), Number(clusterId), input || {}))

  // ---------- 备份恢复 / OBProxy / 巡检 / 平台管理 ----------
  ipcMain.handle('cloud:backupBundle', (_e, { id }: { id: string }) => cloudBackupBundle(String(id || '')))
  ipcMain.handle('cloud:backupTasks', (_e, { id, kind, size }: { id: string; kind: string; size?: number }) =>
    cloudBackupTasks(String(id || ''), String(kind || 'data') as 'data' | 'log' | 'restore' | 'clean', Number(size) || 50))
  ipcMain.handle('cloud:obproxyBundle', (_e, { id }: { id: string }) => cloudObproxyBundle(String(id || '')))
  ipcMain.handle('cloud:obproxyDetail', (_e, { id, clusterId }: { id: string; clusterId: number }) =>
    cloudObproxyDetail(String(id || ''), Number(clusterId)))
  ipcMain.handle('cloud:obproxyParams', (_e, { id, clusterId }: { id: string; clusterId: number }) =>
    cloudObproxyParams(String(id || ''), Number(clusterId)))
  ipcMain.handle('cloud:inspectionBundle', (_e, { id }: { id: string }) => cloudInspectionBundle(String(id || '')))
  ipcMain.handle('cloud:inspectionReport', (_e, { id, reportId }: { id: string; reportId: number }) =>
    cloudInspectionReport(String(id || ''), Number(reportId)))
  ipcMain.handle('cloud:inspectionTasks', (_e, { id, page, size }: { id: string; page?: number; size?: number }) =>
    cloudInspectionTasks(String(id || ''), Number(page) || 1, Number(size) || 20))
  ipcMain.handle('cloud:platformBundle', (_e, { id }: { id: string }) => cloudPlatformBundle(String(id || '')))
  ipcMain.handle('cloud:platformProperties', (_e, { id, page, size }: { id: string; page?: number; size?: number }) =>
    cloudPlatformProperties(String(id || ''), Number(page) || 1, Number(size) || 100))
  ipcMain.handle('cloud:platformLogins', (_e, { id, page, size }: { id: string; page?: number; size?: number }) =>
    cloudPlatformLogins(String(id || ''), Number(page) || 1, Number(size) || 50))

  // ---------- 云管 AI 助手（子模块数据快照 + 会话历史） ----------
  ipcMain.handle('cloud:aiSessions', (_e, { platformId }: { platformId?: string }) =>
    listCloudAiSessions(platformId ? String(platformId) : undefined))
  ipcMain.handle('cloud:aiSession', (_e, { id }: { id: string }) => getCloudAiSession(String(id || '')))
  ipcMain.handle('cloud:aiAsk', (_e, input: any) =>
    askCloudAi({
      sessionId: input?.sessionId ? String(input.sessionId) : null,
      platformId: String(input?.platformId || ''),
      platformName: input?.platformName ? String(input.platformName) : undefined,
      sections: Array.isArray(input?.sections) ? (input.sections.map(String) as CloudAiSectionKey[]) : undefined,
      skills: Array.isArray(input?.skills) ? input.skills.map(String) : undefined,
      text: String(input?.text || '')
    } as CloudAiAskInput))
  ipcMain.handle('cloud:aiStop', (_e, { id }: { id: string }) => stopCloudAi(String(id || '')))
  ipcMain.handle('cloud:aiDelete', (_e, { id }: { id: string }) => deleteCloudAiSession(String(id || '')))
  ipcMain.handle('cloud:aiRefresh', (_e, { id }: { id: string }) => refreshCloudAiContext(String(id || '')))
  ipcMain.handle('cloud:aiSetSections', (_e, { id, sections }: { id: string; sections: string[] }) =>
    setCloudAiSections(String(id || ''), (sections || []).map(String) as CloudAiSectionKey[]))

  // ---------- Oracle AI 助手（读 v$ / dba_ 的分区快照 + 会话历史） ----------
  ipcMain.handle('cloud:oraAiCatalog', () => oraAiCatalog())
  ipcMain.handle('cloud:oraAiSessions', () => listOraAiSessions())
  ipcMain.handle('cloud:oraAiSession', (_e, { id }: { id: string }) => getOraAiSession(String(id || '')))
  ipcMain.handle('cloud:oraAiAsk', (_e, input: any) =>
    askOraAi({
      sessionId: input?.sessionId ? String(input.sessionId) : null,
      sections: Array.isArray(input?.sections) ? input.sections.map(String) : undefined,
      skills: Array.isArray(input?.skills) ? input.skills.map(String) : undefined,
      text: String(input?.text || '')
    }))
  ipcMain.handle('cloud:oraAiStop', (_e, { id }: { id: string }) => stopOraAi(String(id || '')))
  ipcMain.handle('cloud:oraAiDelete', (_e, { id }: { id: string }) => deleteOraAiSession(String(id || '')))
  ipcMain.handle('cloud:oraAiRefresh', (_e, { id }: { id: string }) => refreshOraAiContext(String(id || '')))
  ipcMain.handle('cloud:oraAiSetSections', (_e, { id, sections }: { id: string; sections: string[] }) =>
    setOraAiSections(String(id || ''), (sections || []).map(String)))

  // ---------- 剪贴板 / 外部链接 ----------  // 本机资源（资源面板 2s 轮询；CPU 占用为两次请求的差分，首次返回 null）
  ipcMain.handle('sys:resources', () => getSysResources())

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

  // ---------- 文本编辑器（Notepad++ 式多标签编辑） ----------
  ipcMain.handle('editor:openDialog', () => editorOpenDialog())
  ipcMain.handle('editor:openPath', (_e, { p }: { p: string }) => editorOpenPath(String(p)))
  ipcMain.handle('editor:openFolder', () => editorOpenFolderDialog())
  ipcMain.handle('editor:listDir', (_e, { dir }: { dir: string }) => editorListDir(String(dir || '')))
  ipcMain.handle('editor:statPath', (_e, { p }: { p: string }) => editorStatPath(String(p || '')))
  ipcMain.handle('editor:new', (_e, { name, encoding, eol }: { name?: string; encoding?: any; eol?: any }) =>
    editorNewDoc(name || '未命名', encoding, eol))
  ipcMain.handle('editor:window', (_e, { id, start, count }: { id: string; start: number; count: number }) =>
    editorGetWindow(id, start, count))
  ipcMain.handle('editor:loadFull', (_e, { id }: { id: string }) => editorLoadFull(id))
  ipcMain.handle('editor:save', (_e, p: any) => editorSaveDoc(p))
  ipcMain.handle('editor:saveAs', (_e, { id, suggested }: { id: string; suggested?: string }) => editorSaveAsDialog(id, suggested))
  ipcMain.handle('editor:reopen', (_e, { id, encoding }: { id: string; encoding?: any }) => editorReopen(id, encoding))
  ipcMain.handle('editor:close', (_e, { id }: { id: string }) => editorCloseDoc(id))
  ipcMain.handle('editor:stat', (_e, { ids }: { ids: string[] }) => editorStatDocs(ids || []))
  ipcMain.handle('editor:find', (_e, { id, query, opts }: any) => editorFindInDoc(id, query, opts))
  ipcMain.handle('editor:findInFiles', (_e, p: any) => editorFindInFiles(p))
  ipcMain.handle('editor:recents', () => editorListRecents())
  ipcMain.handle('editor:clearRecents', () => { editorClearRecents(); return { ok: true } })
  ipcMain.handle('editor:clipboardRead', () => clipboard.readText())
  ipcMain.handle('editor:pendingOpens', () => editorTakePendingOpens())
  ipcMain.handle('editor:pendingWorkspace', () => editorTakePendingWorkspace())
  // 编辑器 AI：选中文本问答（流式；不落盘、不改文档）
  ipcMain.handle('editor:aiAsk', (_e, input: any) => askEditorAi({
    id: String(input?.id || ''),
    selection: String(input?.selection || ''),
    question: String(input?.question || ''),
    file: input?.file ? String(input.file) : undefined,
    lang: input?.lang ? String(input.lang) : undefined,
    lines: input?.lines && Number(input.lines.start) ? { start: Number(input.lines.start), end: Number(input.lines.end) || Number(input.lines.start) } : undefined,
    truncated: !!input?.truncated,
    wholeFile: !!input?.wholeFile,
    files: Array.isArray(input?.files) ? input.files.filter((x: any) => typeof x === 'string') : [],
    skills: Array.isArray(input?.skills) ? input.skills.map(String) : [],
    sessionId: input?.sessionId ? String(input.sessionId) : null,
    history: Array.isArray(input?.history) ? input.history.map((m: any) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', text: String(m?.text || '') })) : []
  }))
  ipcMain.handle('editor:aiStop', (_e, { id }: { id: string }) => stopEditorAi(String(id || '')))
  ipcMain.handle('editor:readTextForAi', (_e, { path: p, maxChars }: { path: string; maxChars?: number }) =>
    readTextForAi(String(p || ''), Number(maxChars) > 0 ? Math.min(40000, Number(maxChars)) : undefined)
  )
  // 选择文件问 AI：列工作区文件（只读目录，不读内容）
  ipcMain.handle('editor:listFilesForAi', (_e, { dir }: { dir: string }) => listFilesForAi(String(dir || '')))
  ipcMain.handle('editor:aiSessions', () => listEditorAiSessions())
  ipcMain.handle('editor:aiSession', (_e, { id }: { id: string }) => getEditorAiSession(String(id || '')))
  ipcMain.handle('editor:aiDelete', (_e, { id }: { id: string }) => deleteEditorAiSession(String(id || '')))

  ipcMain.handle('confirm:reply', (_e, { requestId, decision, reason }: { requestId: string; decision: ApprovalDecision; reason?: string }) => {
    const p = pendingApprovals.get(requestId)
    if (!p) return { ok: true }
    pendingApprovals.delete(requestId)
    // 归一化并 fail-closed：未知决定按拒绝兜底
    let outcome: ApprovalOutcome
    if (decision === 'once') {
      outcome = { decision: 'approved' }
    } else if (decision === 'session') {
      outcome = { decision: 'session' }
    } else if (decision === 'yolo') {
      // 一键提权（ZCode fullAccess 选项的等价物）：本次放行 + 本会话切换完全放开。
      // 弹窗里点击即显式确认，不再二次询问；审计留痕并广播给所有已渲染的会话
      const meta = updateSession(p.sessionId, { mode: 'yolo' })
      emit({ type: 'session-updated', sessionId: p.sessionId, meta })
      appendAudit({ kind: 'tool', actor: 'human', sessionId: p.sessionId, mode: 'yolo', detail: '审批弹窗一键提权：本会话切换为完全放开模式' })
      outcome = { decision: 'yolo' }
    } else {
      outcome = { decision: 'denied', reason: reason?.trim() || undefined }
    }
    p.resolve(outcome)
    return { ok: true }
  })

  // ---------- 应用级确认/提示 ----------
  // 替代渲染层 window.confirm/alert：原生同步对话框会模态锁死整个窗口，
  // 弹出瞬间若窗口失焦（如切到别的程序），小对话框被压在后面"看不见却锁死输入"。
  // showMessageBox 带 parent：模态且强制浮在主窗口上方，异步不阻塞渲染线程。
  ipcMain.handle('ui:confirm', (_e, { message, detail, danger }: { message: string; detail?: string; danger?: boolean }) => {
    const opts = {
      type: (danger ? 'warning' : 'question') as 'warning' | 'question',
      buttons: ['取消', '确定'],
      defaultId: 0, // 危险确认默认聚焦"取消"，防回车误触
      cancelId: 0,
      noLink: true,
      message: String(message || '确认？'),
      detail: detail ? String(detail) : undefined
    }
    if (win && !win.isDestroyed()) return dialog.showMessageBox(win, opts).then((r) => r.response === 1)
    return dialog.showMessageBox(opts).then((r) => r.response === 1)
  })

  ipcMain.handle('ui:alert', (_e, { message, detail }: { message: string; detail?: string }) => {
    const opts = { type: 'warning' as const, buttons: ['确定'], message: String(message || ''), detail: detail ? String(detail) : undefined }
    if (win && !win.isDestroyed()) return dialog.showMessageBox(win, opts).then(() => true)
    return dialog.showMessageBox(opts).then(() => true)
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
    p.resolve({ decision: 'denied' })
    pendingApprovals.delete(id)
  }
  for (const [id, p] of pendingPreviews) {
    p.resolve(false)
    pendingPreviews.delete(id)
  }
  persistSessions()
  // WorkBuddy 桥：连同子进程树一起收掉，别在后台留一个监听 879x 的进程
  try { stopBridge() } catch { /* 已退出 */ }
  await closeAll()
  await sshCloseAll()
}
