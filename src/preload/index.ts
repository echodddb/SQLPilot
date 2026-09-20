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
  getSchemas: (connId: string) => ipcRenderer.invoke('conn:schemas', { id: connId }),
  getTables: (connId: string, schema: string) => ipcRenderer.invoke('conn:tables', { id: connId, schema }),
  // 会话（模式/模型/项目均为会话级）
  listSessions: () => ipcRenderer.invoke('session:list'),
  newSession: () => ipcRenderer.invoke('session:new'),
  deleteSession: (id: string) => ipcRenderer.invoke('session:delete', { id }),
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
  // SQL 控制台
  sqlRun: (connId: string, sql: string) => ipcRenderer.invoke('sql:run', { connId, sql }),
  // 数据库信息面板（Navicat 式概览）
  connInfo: (id: string) => ipcRenderer.invoke('conn:info', { id }),
  // Oracle 活跃会话（列可选）
  activeSessions: (id: string, columns?: string[]) =>
    ipcRenderer.invoke('conn:activeSessions', plain({ id, columns: columns || undefined })),
  // 对象浏览器（数据/结构/DDL）
  objData: (p: { connId: string; schema: string; table: string; page?: number; pageSize?: number; where?: string; orderBy?: string; orderDir?: string }) =>
    ipcRenderer.invoke('obj:data', plain(p)),
  objDescribe: (connId: string, schema: string, table: string) =>
    ipcRenderer.invoke('obj:describe', { connId, schema, table }),
  objDdl: (connId: string, schema: string, table: string) =>
    ipcRenderer.invoke('obj:ddl', { connId, schema, table }),
  // 技能
  listSkills: () => ipcRenderer.invoke('skill:list'),
  saveSkill: (p: { id?: string; name: string; description: string; content: string }) => ipcRenderer.invoke('skill:save', plain(p)),
  deleteSkill: (id: string) => ipcRenderer.invoke('skill:delete', { id }),
  readSkillFull: (id: string) => ipcRenderer.invoke('skill:read', { id }),
  toggleSkill: (id: string, enabled: boolean) => ipcRenderer.invoke('skill:toggle', { id, enabled }),
  importSkill: () => ipcRenderer.invoke('skill:import'),
  // 模型提供商
  testProvider: (provider: any, apiKey?: string) => ipcRenderer.invoke('provider:test', { provider: plain(provider), apiKey }),
  // 剪贴板与外链
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', { text }),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', { url }),
  openFolder: (p: string) => ipcRenderer.invoke('shell:openFolder', { p }),
  // 权限确认
  replyConfirm: (requestId: string, decision: string) => ipcRenderer.invoke('confirm:reply', { requestId, decision }),
  // 其他
  getAudit: () => ipcRenderer.invoke('audit:list'),
  appInfo: () => ipcRenderer.invoke('app:info'),
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
