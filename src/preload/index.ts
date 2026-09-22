import { contextBridge, ipcRenderer } from 'electron'

// Vue reactive Proxy 无法通过 Electron IPC 结构化克隆（"An object could not be cloned"），
// 所有跨进程对象参数先深转换为纯对象
const deepPlain = (v: any): any => {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(deepPlain)
  const o: any = {}
  for (const k of Object.keys(v)) {
    const val = (v as any)[k]
    if (typeof val !== 'function') o[k] = deepPlain(val)
  }
  return o
}

const plain = (v: any): any => {
  if (v === undefined || v === null || typeof v !== 'object') return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return deepPlain(v)
  }
}

const api = {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg: any) => ipcRenderer.invoke('config:set', plain(cfg)),
  // 连接管理
  saveConn: (profile: any, password?: string) => ipcRenderer.invoke('conn:save', { profile: plain(profile), password }),
  deleteConn: (id: string) => ipcRenderer.invoke('conn:delete', { id }),
  testConn: (profile: any, password?: string) => ipcRenderer.invoke('conn:test', { profile, password }),
  getSchemas: (connId: string, refresh?: boolean) => ipcRenderer.invoke('conn:schemas', { id: connId, refresh }),
  getTables: (connId: string, schema: string, refresh?: boolean) => ipcRenderer.invoke('conn:tables', { id: connId, schema, refresh }),
  // 会话（模式/模型/项目均为会话级）
  listSessions: () => ipcRenderer.invoke('session:list'),
  newSession: () => ipcRenderer.invoke('session:new'),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', { id }),
  archiveSession: (id: string, remove: boolean) => ipcRenderer.invoke('session:archive', { id, remove }),
  getProjectArchive: (projectId: string) => ipcRenderer.invoke('archive:get', { projectId }),
  onArchiveProgress: (cb: (p: any) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('archive:progress', l)
    return () => ipcRenderer.removeListener('archive:progress', l)
  },
  updateSession: (id: string, patch: any) => ipcRenderer.invoke('session:update', { id, patch: plain(patch) }),
  // 对话
  sendChat: (sessionId: string, text: string) => ipcRenderer.invoke('chat:send', { sessionId, text }),
  resetChat: (sessionId: string) => ipcRenderer.invoke('chat:reset', { sessionId }),
  getHistory: (sessionId: string) => ipcRenderer.invoke('chat:history', { sessionId }),
  stopChat: (sessionId: string) => ipcRenderer.invoke('chat:stop', { sessionId }),
  // 项目
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  saveProject: (project: any, serverPasswords?: Record<string, string>) =>
    ipcRenderer.invoke('project:save', { project: plain(project), serverPasswords: plain(serverPasswords || {}) }),
  deleteProject: (id: string) => ipcRenderer.invoke('project:delete', { id }),
  // SSH 服务器
  testServer: (server: any, password?: string) => ipcRenderer.invoke('server:test', { server: plain(server), password }),
  // 交互式 SSH 终端
  termOpen: (termId: string, serverId: string) => ipcRenderer.invoke('term:open', { termId, serverId }),
  termInput: (termId: string, data: string) => ipcRenderer.invoke('term:input', { termId, data }),
  termResize: (termId: string, cols: number, rows: number) => ipcRenderer.invoke('term:resize', { termId, cols, rows }),
  termClose: (termId: string) => ipcRenderer.invoke('term:close', { termId }),
  onTermData: (cb: (p: { termId: string; data: string }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('term:data', l)
    return () => ipcRenderer.removeListener('term:data', l)
  },
  onTermExit: (cb: (p: { termId: string }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('term:exit', l)
    return () => ipcRenderer.removeListener('term:exit', l)
  },
  // SFTP 文件浏览器
  sftpList: (serverId: string, p: string) => ipcRenderer.invoke('sftp:list', { serverId, path: p }),
  sftpDownload: (serverId: string, remotePath: string, localDir: string) => ipcRenderer.invoke('sftp:download', { serverId, remotePath, localDir }),
  sftpUpload: (serverId: string, remoteDir: string) => ipcRenderer.invoke('sftp:upload', { serverId, remoteDir }),
  showInFolder: (p: string) => ipcRenderer.invoke('shell:showInFolder', { p }),
  // SQL 控制台（sessionKey = 查询窗口 id，每窗口独立数据库会话）
  sqlRun: (connId: string, sql: string, sessionKey?: string) => ipcRenderer.invoke('sql:run', { connId, sql, sessionKey }),
  sqlCloseSession: (connId: string, sessionKey: string) => ipcRenderer.invoke('sql:closeSession', { connId, sessionKey }),
  // 数据库信息面板（Navicat 式概览）
  connInfo: (id: string) => ipcRenderer.invoke('conn:info', { id }),
  // Oracle 活跃会话（列可选）
  activeSessions: (id: string, columns?: string[]) =>
    ipcRenderer.invoke('conn:activeSessions', plain({ id, columns: columns || undefined })),
  // 对象浏览器（数据/结构/DDL）
  objData: (p: { connId: string; schema: string; table: string; page?: number; pageSize?: number; where?: string; orderBy?: string; orderDir?: string }) =>
    ipcRenderer.invoke('obj:data', plain(p)),
  objDescribe: (connId: string, schema: string, table: string, refresh?: boolean) =>
    ipcRenderer.invoke('obj:describe', { connId, schema, table, refresh }),
  objDdl: (connId: string, schema: string, table: string) =>
    ipcRenderer.invoke('obj:ddl', { connId, schema, table }),
  // 结果网格编辑（对象浏览器数据页）
  objEditInfo: (connId: string, schema: string, table: string) =>
    ipcRenderer.invoke('obj:editInfo', { connId, schema, table }),
  objSaveEdits: (p: { connId: string; sessionKey: string; schema: string; table: string; keyMode: 'rowid' | 'cols'; keyCols: string[]; edits: { rid?: string; keys?: any[]; col: string; value: string | null }[] }) =>
    ipcRenderer.invoke('obj:saveEdits', plain(p)),
  // 查询结果导出（弹保存对话框，CSV 全量导出）
  exportResult: (p: { connId: string; sessionKey: string; sql: string; columns: string[] }) =>
    ipcRenderer.invoke('export:result', plain(p)),
  // 技能
  listSkills: () => ipcRenderer.invoke('skill:list'),
  saveSkill: (p: { id?: string; name: string; description: string; content: string }) => ipcRenderer.invoke('skill:save', plain(p)),
  deleteSkill: (id: string) => ipcRenderer.invoke('skill:delete', { id }),
  readSkillFull: (id: string, resourcePath?: string) => ipcRenderer.invoke('skill:read', { id, resourcePath }),
  toggleSkill: (id: string, enabled: boolean) => ipcRenderer.invoke('skill:toggle', { id, enabled }),
  importSkill: () => ipcRenderer.invoke('skill:import'),
  importSkillUrl: (url: string) => ipcRenderer.invoke('skill:importUrl', { url }),
  // 模型提供商
  testProvider: (provider: any, apiKey?: string) => ipcRenderer.invoke('provider:test', { provider: plain(provider), apiKey }),
  // 剪贴板与外链
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', { text }),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', { url }),
  openFolder: (p: string) => ipcRenderer.invoke('shell:openFolder', { p }),
  // 权限确认
  replyConfirm: (requestId: string, decision: string) => ipcRenderer.invoke('confirm:reply', { requestId, decision }),
  // LLM 发送前预览
  replyLlmPreview: (requestId: string, ok: boolean) => ipcRenderer.invoke('llm:preview:reply', { requestId, ok }),
  onLlmPreview: (cb: (p: any) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('llm:preview', l)
    return () => ipcRenderer.removeListener('llm:preview', l)
  },
  onLlmPreviewExpired: (cb: (p: { requestId: string }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('llm:preview:expired', l)
    return () => ipcRenderer.removeListener('llm:preview:expired', l)
  },
  // 其他
  getAudit: () => ipcRenderer.invoke('audit:list'),
  auditQuery: (q: any) => ipcRenderer.invoke('audit:query', q),
  appInfo: () => ipcRenderer.invoke('app:info'),
  // 子代理任务面板
  subagentTasks: (sessionId?: string) => ipcRenderer.invoke('subagent:tasks', { sessionId }),
  subagentStopTask: (id: string) => ipcRenderer.invoke('subagent:stopTask', { id }),
  subagentAudit: (runId: string) => ipcRenderer.invoke('subagent:audit', { runId }),
  onSubtasks: (cb: (p: { sessionId: string; tasks: any[] }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('subagent:tasks', l)
    return () => ipcRenderer.removeListener('subagent:tasks', l)
  },
  // 事件订阅
  onAgentEvent: (cb: (ev: any) => void) => {
    const l = (_e: any, ev: any) => cb(ev)
    ipcRenderer.on('agent:event', l)
    return () => ipcRenderer.removeListener('agent:event', l)
  },
  onConfirm: (cb: (req: any) => void) => {
    const l = (_e: any, req: any) => cb(req)
    ipcRenderer.on('agent:confirm', l)
    return () => ipcRenderer.removeListener('agent:confirm', l)
  },
  onConfirmExpired: (cb: (payload: any) => void) => {
    const l = (_e: any, payload: any) => cb(payload)
    ipcRenderer.on('agent:confirm:expired', l)
    return () => ipcRenderer.removeListener('agent:confirm:expired', l)
  }
}

contextBridge.exposeInMainWorld('sqlpilot', api)
export type Api = typeof api
