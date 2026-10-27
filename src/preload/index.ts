import { contextBridge, ipcRenderer, webUtils } from 'electron'

// Vue reactive Proxy 无法通过 Electron IPC 结构化克隆（"An object could not be cloned"），
// 所有跨进程对象参数先深转换为纯对象
const deepPlain = (v: any, seen: WeakSet<object> = new WeakSet()): any => {
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : v
  // 循环引用会让递归无终止；Date/Map/Set 交给结构化克隆前先还原成可克隆形态
  if (v instanceof Date) return new Date(v.getTime())
  if (seen.has(v)) return undefined
  seen.add(v)
  if (Array.isArray(v)) return v.map((x) => deepPlain(x, seen))
  const o: any = {}
  for (const k of Object.keys(v)) {
    const val = (v as any)[k]
    if (typeof val !== 'function') o[k] = deepPlain(val, seen)
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
  // 窗口控制（自绘 - □ × 按钮，见 renderer/components/WindowControls.vue）
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaxToggle: () => ipcRenderer.invoke('win:maxToggle'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onWinMaxState: (cb: (maxed: boolean) => void): (() => void) => {
    const l = (_e: unknown, v: boolean): void => cb(v)
    ipcRenderer.on('win:maxstate', l)
    return () => { ipcRenderer.removeListener('win:maxstate', l as any) }
  },
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg: any) => ipcRenderer.invoke('config:set', plain(cfg)),
  // 文件脱敏
  maskDefaults: () => ipcRenderer.invoke('mask:defaults'),
  maskPickFile: (fileType: string) => ipcRenderer.invoke('mask:pickFile', { fileType }),
  maskText: (fileType: string, content: string) => ipcRenderer.invoke('mask:text', { fileType, content }),
  maskSave: (fileName: string, content: string) => ipcRenderer.invoke('mask:save', { fileName, content }),
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
  unarchiveSession: (id: string) => ipcRenderer.invoke('session:unarchive', { id }),
  getProjectArchive: (projectId: string) => ipcRenderer.invoke('archive:get', { projectId }),
  listArchive: (projectId: string) => ipcRenderer.invoke('archive:list', { projectId }),
  deleteArchiveEntry: (projectId: string, opts: { sessionId?: string | null; reverseIndex?: number; rawCheck?: string; ts?: string; title?: string }) =>
    ipcRenderer.invoke('archive:deleteEntry', { projectId, ...opts }),
  clearArchive: (projectId: string) => ipcRenderer.invoke('archive:clear', { projectId }),
  onArchiveProgress: (cb: (p: any) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('archive:progress', l)
    return () => ipcRenderer.removeListener('archive:progress', l)
  },
  // LLM 增强总结后台完成 → 归档区实时刷新
  onArchiveUpdated: (cb: (p: { projectId: string }) => void) => {
    const l = (_e: any, p: { projectId: string }) => cb(p)
    ipcRenderer.on('archive:updated', l)
    return () => ipcRenderer.removeListener('archive:updated', l)
  },
  updateSession: (id: string, patch: any) => ipcRenderer.invoke('session:update', { id, patch: plain(patch) }),
  // 对话
  sendChat: (sessionId: string, text: string) => ipcRenderer.invoke('chat:send', { sessionId, text }),
  resetChat: (sessionId: string) => ipcRenderer.invoke('chat:reset', { sessionId }),
  getHistory: (sessionId: string) => ipcRenderer.invoke('chat:history', { sessionId }),
  stopChat: (sessionId: string) => ipcRenderer.invoke('chat:stop', { sessionId }),
  // 项目
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  saveProject: (project: any) => ipcRenderer.invoke('project:save', { project: plain(project) }),
  deleteProject: (id: string) => ipcRenderer.invoke('project:delete', { id }),
  // SSH 服务器
  testServer: (server: any, password?: string, keyPassphrase?: string) => ipcRenderer.invoke('server:test', { server: plain(server), password, keyPassphrase }),
  saveServer: (server: any, password?: string, keyPassphrase?: string) => ipcRenderer.invoke('server:save', { server: plain(server), password, keyPassphrase }),
  deleteServer: (id: string) => ipcRenderer.invoke('server:delete', { id }),
  forgetHostKey: (host: string, port: number) => ipcRenderer.invoke('server:forgetHostKey', { host, port }),
  importSshConfig: () => ipcRenderer.invoke('server:importSshConfig'),
  // 交互式 SSH 终端
  termOpen: (termId: string, serverId: string, opts?: { cols?: number; rows?: number; encoding?: string; cwd?: string; term?: string }) =>
    ipcRenderer.invoke('term:open', { termId, serverId, ...(opts ? plain(opts) : {}) }),
  termInput: (termId: string, data: string) => ipcRenderer.invoke('term:input', { termId, data }),
  termResize: (termId: string, cols: number, rows: number) => ipcRenderer.invoke('term:resize', { termId, cols, rows }),
  termClose: (termId: string) => ipcRenderer.invoke('term:close', { termId }),
  onTermData: (cb: (p: { termId: string; data: string }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('term:data', l)
    return () => ipcRenderer.removeListener('term:data', l)
  },
  onTermExit: (cb: (p: { termId: string; code?: number | null }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('term:exit', l)
    return () => ipcRenderer.removeListener('term:exit', l)
  },
  // SFTP 文件浏览器（旧接口，兼容底部工作台）
  sftpList: (serverId: string, p: string) => ipcRenderer.invoke('sftp:list', { serverId, path: p }),
  sftpDownload: (serverId: string, remotePath: string, localDir: string) => ipcRenderer.invoke('sftp:download', { serverId, remotePath, localDir }),
  sftpUpload: (serverId: string, remoteDir: string) => ipcRenderer.invoke('sftp:upload', { serverId, remoteDir }),
  // SFTP 完整面板
  sftpLs: (serverId: string, path: string) => ipcRenderer.invoke('sftp:ls', { serverId, path }),
  sftpStat: (serverId: string, path: string) => ipcRenderer.invoke('sftp:stat', { serverId, path }),
  sftpHome: (serverId: string) => ipcRenderer.invoke('sftp:home', { serverId }),
  sftpMkdir: (serverId: string, path: string) => ipcRenderer.invoke('sftp:mkdir', { serverId, path }),
  sftpRename: (serverId: string, from: string, to: string) => ipcRenderer.invoke('sftp:rename', { serverId, from, to }),
  sftpRemove: (serverId: string, path: string, recursive?: boolean) => ipcRenderer.invoke('sftp:remove', { serverId, path, recursive }),
  sftpChmod: (serverId: string, path: string, mode: number) => ipcRenderer.invoke('sftp:chmod', { serverId, path, mode }),
  sftpRead: (serverId: string, path: string, maxBytes?: number, encoding?: string) => ipcRenderer.invoke('sftp:read', { serverId, path, maxBytes, encoding }),
  sftpWrite: (serverId: string, path: string, content: string, encoding?: string) => ipcRenderer.invoke('sftp:write', { serverId, path, content, encoding }),
  sftpPick: (mode: 'files' | 'folder') => ipcRenderer.invoke('sftp:pick', { mode }),
  sftpUploadPaths: (serverId: string, localPaths: string[], remoteDir: string, jobId: string) =>
    ipcRenderer.invoke('sftp:uploadPaths', { serverId, localPaths: plain(localPaths), remoteDir, jobId }),
  sftpDownloadPaths: (serverId: string, remotePaths: string[], localDir: string, jobId: string) =>
    ipcRenderer.invoke('sftp:downloadPaths', { serverId, remotePaths: plain(remotePaths), localDir, jobId }),
  sftpCancel: (jobId: string) => ipcRenderer.invoke('sftp:cancel', { jobId }),
  onSftpProgress: (cb: (p: any) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('sftp:progress', l)
    return () => ipcRenderer.removeListener('sftp:progress', l)
  },
  // 本地目录（SFTP 双栏本地侧）
  localRoots: () => ipcRenderer.invoke('local:roots'),
  localLs: (dir: string) => ipcRenderer.invoke('local:ls', { dir }),
  localOpen: (p: string) => ipcRenderer.invoke('local:open', { p }),
  localSaveText: (content: string, suggested?: string) => ipcRenderer.invoke('local:saveText', { content, suggested }),
  pickFile: (title?: string, filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('dialog:pickFile', { title, filters: filters ? plain(filters) : undefined }),
  showInFolder: (p: string) => ipcRenderer.invoke('shell:showInFolder', { p }),
  // ---------- 文本编辑器（Notepad++ 式多标签） ----------
  editorOpenDialog: () => ipcRenderer.invoke('editor:openDialog'),
  editorOpenPath: (p: string) => ipcRenderer.invoke('editor:openPath', { p }),
  editorOpenFolder: () => ipcRenderer.invoke('editor:openFolder'),
  editorListDir: (dir: string) => ipcRenderer.invoke('editor:listDir', { dir }),
  editorStatPath: (p: string) => ipcRenderer.invoke('editor:statPath', { p }),
  editorNew: (name?: string, encoding?: string, eol?: string) => ipcRenderer.invoke('editor:new', { name, encoding, eol }),
  editorWindow: (id: string, start: number, count: number) => ipcRenderer.invoke('editor:window', { id, start, count }),
  editorLoadFull: (id: string) => ipcRenderer.invoke('editor:loadFull', { id }),
  editorSave: (p: any) => ipcRenderer.invoke('editor:save', plain(p)),
  editorSaveAs: (id: string, suggested?: string) => ipcRenderer.invoke('editor:saveAs', { id, suggested }),
  editorReopen: (id: string, encoding?: string) => ipcRenderer.invoke('editor:reopen', { id, encoding }),
  editorClose: (id: string) => ipcRenderer.invoke('editor:close', { id }),
  editorStat: (ids: string[]) => ipcRenderer.invoke('editor:stat', { ids }),
  editorFind: (id: string, query: string, opts: any) => ipcRenderer.invoke('editor:find', { id, query, opts: plain(opts) }),
  editorFindInFiles: (p: any) => ipcRenderer.invoke('editor:findInFiles', plain(p)),
  editorRecents: () => ipcRenderer.invoke('editor:recents'),
  editorClearRecents: () => ipcRenderer.invoke('editor:clearRecents'),
  editorClipboardRead: () => ipcRenderer.invoke('editor:clipboardRead'),
  /** 拖拽进来的 File → 本地路径（Electron 32+ 官方方式） */
  getPathForFile: (file: File) => {
    try { return webUtils.getPathForFile(file) || (file as any).path || '' } catch { return (file as any)?.path || '' }
  },
  // 编辑器 AI（选中文本问答）：正文走 editor:ai:event 流式
  editorAiAsk: (input: { id: string; selection: string; question: string; file?: string; lang?: string; lines?: { start: number; end: number }; truncated?: boolean; wholeFile?: boolean; files?: string[]; skills?: string[]; sessionId?: string | null; history?: { role: string; text: string }[] }) =>
    ipcRenderer.invoke('editor:aiAsk', plain({ ...input, history: [...(input.history || [])] })),
  editorAiStop: (id: string) => ipcRenderer.invoke('editor:aiStop', { id }),
  editorReadTextForAi: (p: string, maxChars?: number) => ipcRenderer.invoke('editor:readTextForAi', { path: p, maxChars }),
  editorListFilesForAi: (dir: string) => ipcRenderer.invoke('editor:listFilesForAi', { dir }),
  editorAiSessions: () => ipcRenderer.invoke('editor:aiSessions'),
  editorAiSession: (id: string) => ipcRenderer.invoke('editor:aiSession', { id }),
  editorAiDelete: (id: string) => ipcRenderer.invoke('editor:aiDelete', { id }),
  onEditorAiEvent: (cb: (ev: any) => void) => {
    const l = (_e: any, ev: any) => cb(ev)
    ipcRenderer.on('editor:ai:event', l)
    return () => ipcRenderer.removeListener('editor:ai:event', l)
  },
  editorPendingOpens: () => ipcRenderer.invoke('editor:pendingOpens'),
  editorPendingWorkspace: () => ipcRenderer.invoke('editor:pendingWorkspace'),
  onEditorOpenRequest: (cb: (p: { paths: string[]; folder?: string }) => void) => {
    const l = (_e: any, p: any) => cb(p)
    ipcRenderer.on('editor:open-request', l)
    return () => ipcRenderer.removeListener('editor:open-request', l)
  },
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
  // 会话产物（右侧结果预览）：完整结果按 id 取、面板内导出 CSV
  getArtifact: (id: string) => ipcRenderer.invoke('artifact:get', { id: String(id || '') }),
  artifactImageDataUrl: (p: string) => ipcRenderer.invoke('artifact:imageDataUrl', { path: String(p || '') }),
  exportArtifactCsv: (p: { columns: string[]; rows: unknown[][]; name?: string }) =>
    ipcRenderer.invoke('artifact:exportCsv', { columns: p.columns, rows: p.rows, name: p.name }),
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
  listProviderModels: (provider: any, apiKey?: string) => ipcRenderer.invoke('provider:listModels', { provider: plain(provider), apiKey }),
  // WorkBuddy 受管桥（模型通道）：令牌留在主进程，渲染层只拿状态
  wbStatus: () => ipcRenderer.invoke('wb:status'),
  wbStart: () => ipcRenderer.invoke('wb:start'),
  wbStop: () => ipcRenderer.invoke('wb:stop'),
  wbLogin: () => ipcRenderer.invoke('wb:login'),
  wbModels: () => ipcRenderer.invoke('wb:models'),
  // ---------- 云管平台（OceanBase OCP） ----------
  cloudPlatforms: () => ipcRenderer.invoke('cloud:list'),
  cloudSave: (platform: any, password?: string) => ipcRenderer.invoke('cloud:save', { platform: plain(platform), password }),
  cloudDelete: (id: string) => ipcRenderer.invoke('cloud:delete', { id }),
  cloudTest: (platform: any, password?: string) => ipcRenderer.invoke('cloud:test', { platform: plain(platform), password }),
  cloudStatus: (id: string) => ipcRenderer.invoke('cloud:status', { id }),
  // Oracle 直连云平台：一个通用分区入口（section = overview/rac/storage/...）
  cloudOraSection: (id: string, section: string, opts?: any, force?: boolean) =>
    ipcRenderer.invoke('cloud:oraSection', { id, section, opts: plain(opts || {}), force: !!force }),
  cloudOraSqlDetail: (id: string, sqlId: string) => ipcRenderer.invoke('cloud:oraSqlDetail', { id, sqlId }),
  cloudOverview: (id: string) => ipcRenderer.invoke('cloud:overview', { id }),
  cloudClusters: (id: string) => ipcRenderer.invoke('cloud:clusters', { id }),
  cloudCluster: (id: string, clusterId: number) => ipcRenderer.invoke('cloud:cluster', { id, clusterId }),
  cloudTenants: (id: string) => ipcRenderer.invoke('cloud:tenants', { id }),
  cloudTenant: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenant', { id, clusterId, tenantId }),
  cloudHosts: (id: string) => ipcRenderer.invoke('cloud:hosts', { id }),
  cloudAlarms: (id: string, opts?: { level?: number; scope?: string; keyword?: string; alarmType?: string; appType?: string; hours?: number; page?: number; size?: number }) =>
    ipcRenderer.invoke('cloud:alarms', { id, opts: plain(opts || {}) }),
  cloudAlarmHistory: (id: string, opts?: { page?: number; size?: number; hours?: number; level?: number; scope?: string; keyword?: string; alarmType?: string; appType?: string }) =>
    ipcRenderer.invoke('cloud:alarmHistory', { id, opts: plain(opts || {}) }),
  cloudAlarmDetail: (id: string, alarmId: number) => ipcRenderer.invoke('cloud:alarmDetail', { id, alarmId }),
  cloudAlarmRules: (id: string, opts?: { page?: number; size?: number; level?: number; scope?: string; appType?: string; keyword?: string; enabled?: boolean }) =>
    ipcRenderer.invoke('cloud:alarmRules', { id, opts: plain(opts || {}) }),
  cloudAlarmTrend: (id: string, hours?: number) => ipcRenderer.invoke('cloud:alarmTrend', { id, hours }),
  cloudAlarmLevelCounts: (id: string) => ipcRenderer.invoke('cloud:alarmLevelCounts', { id }),
  cloudTasks: (id: string, opts?: { page?: number; size?: number; status?: string; statusIn?: string[]; name?: string; clusterId?: number; tenantId?: number; creator?: string; objType?: string; type?: string; hours?: number; sort?: string }) =>
    ipcRenderer.invoke('cloud:tasks', { id, opts: plain(opts || {}) }),
  cloudTaskDetail: (id: string, taskId: number) => ipcRenderer.invoke('cloud:taskDetail', { id, taskId }),
  cloudTaskStats: (id: string) => ipcRenderer.invoke('cloud:taskStats', { id }),
  cloudTaskCreators: (id: string) => ipcRenderer.invoke('cloud:taskCreators', { id }),
  cloudExportCsv: (fileName: string, columns: string[], rows: unknown[][]) =>
    ipcRenderer.invoke('cloud:exportCsv', { fileName, columns, rows }),
  cloudMetrics: (id: string, query: any) => ipcRenderer.invoke('cloud:metrics', { id, query: plain(query) }),
  cloudClusterAction: (id: string, clusterId: number, action: string) => ipcRenderer.invoke('cloud:clusterAction', { id, clusterId, action }),
  cloudCreateTenant: (id: string, clusterId: number, input: any) => ipcRenderer.invoke('cloud:createTenant', { id, clusterId, input: plain(input) }),
  cloudDeleteTenant: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:deleteTenant', { id, clusterId, tenantId }),
  cloudPackages: (id: string) => ipcRenderer.invoke('cloud:packages', { id }),
  cloudClusterPreCheck: (id: string, input: any) => ipcRenderer.invoke('cloud:clusterPreCheck', { id, input: plain(input) }),
  cloudClusterCreate: (id: string, input: any, checkId?: string) => ipcRenderer.invoke('cloud:clusterCreate', { id, input: plain(input), checkId }),
  cloudClusterParams: (id: string, clusterId: number) => ipcRenderer.invoke('cloud:clusterParams', { id, clusterId }),
  cloudClusterUpdateParams: (id: string, clusterId: number, items: { name: string; value: string }[]) =>
    ipcRenderer.invoke('cloud:clusterUpdateParams', { id, clusterId, items: plain(items) }),
  cloudTenantParams: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantParams', { id, clusterId, tenantId }),
  cloudTenantUpdateParams: (id: string, clusterId: number, tenantId: number, items: { name: string; value: string }[]) =>
    ipcRenderer.invoke('cloud:tenantUpdateParams', { id, clusterId, tenantId, items: plain(items) }),
  cloudTenantChangePassword: (id: string, clusterId: number, tenantId: number, newPassword: string) =>
    ipcRenderer.invoke('cloud:tenantChangePassword', { id, clusterId, tenantId, newPassword }),
  cloudTenantModifyWhitelist: (id: string, clusterId: number, tenantId: number, whitelist: string) =>
    ipcRenderer.invoke('cloud:tenantModifyWhitelist', { id, clusterId, tenantId, whitelist }),
  cloudTenantModifyReplica: (id: string, clusterId: number, tenantId: number, replicas: any[]) =>
    ipcRenderer.invoke('cloud:tenantModifyReplica', { id, clusterId, tenantId, replicas: plain(replicas) }),
  cloudTenantAddReplica: (id: string, clusterId: number, tenantId: number, replicas: any[]) =>
    ipcRenderer.invoke('cloud:tenantAddReplica', { id, clusterId, tenantId, replicas: plain(replicas) }),
  cloudTenantDeleteReplica: (id: string, clusterId: number, tenantId: number, zones: string[]) =>
    ipcRenderer.invoke('cloud:tenantDeleteReplica', { id, clusterId, tenantId, zones }),
  cloudTenantSetLocked: (id: string, clusterId: number, tenantId: number, locked: boolean) =>
    ipcRenderer.invoke('cloud:tenantSetLocked', { id, clusterId, tenantId, locked }),
  cloudTenantSessions: (id: string, clusterId: number, tenantId: number, page?: number, size?: number) =>
    ipcRenderer.invoke('cloud:tenantSessions', { id, clusterId, tenantId, page, size }),
  cloudTenantCloseSessions: (id: string, clusterId: number, tenantId: number, sessionIds: number[]) =>
    ipcRenderer.invoke('cloud:tenantCloseSessions', { id, clusterId, tenantId, sessionIds }),
  cloudTopSql: (id: string, clusterId: number, tenantId: number, opts: { from: number; to: number; sqlText?: string; limit?: number }) =>
    ipcRenderer.invoke('cloud:topSql', { id, clusterId, tenantId, opts: plain(opts) }),
  cloudSlowSql: (id: string, clusterId: number, tenantId: number, opts: { from: number; to: number }) =>
    ipcRenderer.invoke('cloud:slowSql', { id, clusterId, tenantId, opts: plain(opts) }),
  cloudSqlText: (id: string, clusterId: number, tenantId: number, sqlId: string, opts: { from: number; to: number }) =>
    ipcRenderer.invoke('cloud:sqlText', { id, clusterId, tenantId, sqlId, opts: plain(opts) }),
  cloudTenantSqlStats: (id: string, clusterId: number, from: number, to: number) =>
    ipcRenderer.invoke('cloud:tenantSqlStats', { id, clusterId, from, to }),
  // 租户详情页（对齐 OCP 各 tab）
  cloudTenantDbs: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantDbs', { id, clusterId, tenantId }),
  cloudTenantTables: (id: string, clusterId: number, tenantId: number, db: string) => ipcRenderer.invoke('cloud:tenantTables', { id, clusterId, tenantId, db }),
  cloudTenantTableSchema: (id: string, clusterId: number, tenantId: number, db: string, table: string) =>
    ipcRenderer.invoke('cloud:tenantTableSchema', { id, clusterId, tenantId, db, table }),
  cloudTenantTopo: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantTopo', { id, clusterId, tenantId }),
  cloudTenantSessionStats: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantSessionStats', { id, clusterId, tenantId }),
  cloudTenantCloseQuery: (id: string, clusterId: number, tenantId: number, sessionIds: number[]) =>
    ipcRenderer.invoke('cloud:tenantCloseQuery', { id, clusterId, tenantId, sessionIds }),
  cloudTenantRowLocks: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantRowLocks', { id, clusterId, tenantId }),
  cloudTenantTxns: (id: string, clusterId: number, tenantId: number, thresholdMs?: number) =>
    ipcRenderer.invoke('cloud:tenantTxns', { id, clusterId, tenantId, thresholdMs }),
  cloudTenantCloseTxns: (id: string, clusterId: number, tenantId: number, list: { sessionId: number; transId?: string }[]) =>
    ipcRenderer.invoke('cloud:tenantCloseTxns', { id, clusterId, tenantId, list: plain(list) }),
  cloudTenantNewSql: (id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number) =>
    ipcRenderer.invoke('cloud:tenantNewSql', { id, clusterId, tenantId, from, to, limit }),
  cloudTenantHighRiskSql: (id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number) =>
    ipcRenderer.invoke('cloud:tenantHighRiskSql', { id, clusterId, tenantId, from, to, limit }),
  cloudTenantParallelSql: (id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number) =>
    ipcRenderer.invoke('cloud:tenantParallelSql', { id, clusterId, tenantId, from, to, limit }),
  cloudTenantOutlines: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantOutlines', { id, clusterId, tenantId }),
  cloudTenantSqlDiagnosis: (id: string, clusterId: number, tenantId: number, sqlId: string, from: number, to: number) =>
    ipcRenderer.invoke('cloud:tenantSqlDiagnosis', { id, clusterId, tenantId, sqlId, from, to }),
  cloudTenantCompaction: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantCompaction', { id, clusterId, tenantId }),
  cloudTenantCompactionAction: (id: string, clusterId: number, tenantId: number, action: string) =>
    ipcRenderer.invoke('cloud:tenantCompactionAction', { id, clusterId, tenantId, action }),
  cloudTenantUpdateCompactionSettings: (id: string, clusterId: number, tenantId: number, patch: any) =>
    ipcRenderer.invoke('cloud:tenantUpdateCompactionSettings', { id, clusterId, tenantId, patch: plain(patch) }),
  cloudTenantGather: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantGather', { id, clusterId, tenantId }),
  cloudTenantBackup: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantBackup', { id, clusterId, tenantId }),
  cloudTenantUsers: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantUsers', { id, clusterId, tenantId }),
  cloudTenantTde: (id: string, clusterId: number, tenantId: number) => ipcRenderer.invoke('cloud:tenantTde', { id, clusterId, tenantId }),
  // Unit 规格 / 克隆租户 / 创建备租户
  cloudUnitSpecs: (id: string) => ipcRenderer.invoke('cloud:unitSpecs', { id }),
  cloudUnitSpecCreate: (id: string, input: any) => ipcRenderer.invoke('cloud:unitSpecCreate', { id, input: plain(input) }),
  cloudUnitSpecUpdate: (id: string, specId: number, input: any) => ipcRenderer.invoke('cloud:unitSpecUpdate', { id, specId, input: plain(input) }),
  cloudUnitSpecDelete: (id: string, specId: number) => ipcRenderer.invoke('cloud:unitSpecDelete', { id, specId }),
  cloudTenantClonePreCheck: (id: string, clusterId: number, tenantId: number) =>
    ipcRenderer.invoke('cloud:tenantClonePreCheck', { id, clusterId, tenantId }),
  cloudTenantClone: (id: string, clusterId: number, tenantId: number, input: any) =>
    ipcRenderer.invoke('cloud:tenantClone', { id, clusterId, tenantId, input: plain(input) }),
  cloudPrimaryTenantInfo: (id: string, clusterId: number, primaryTenantId: number) =>
    ipcRenderer.invoke('cloud:primaryTenantInfo', { id, clusterId, primaryTenantId }),
  cloudCreateStandbyTenant: (id: string, clusterId: number, input: any) =>
    ipcRenderer.invoke('cloud:createStandbyTenant', { id, clusterId, input: plain(input) }),
  // 备份恢复 / OBProxy / 巡检 / 平台管理（对齐 OCP 官方导航补齐的四个模块）
  cloudBackupBundle: (id: string) => ipcRenderer.invoke('cloud:backupBundle', { id }),
  cloudBackupTasks: (id: string, kind: string, size?: number) => ipcRenderer.invoke('cloud:backupTasks', { id, kind, size }),
  cloudObproxyBundle: (id: string) => ipcRenderer.invoke('cloud:obproxyBundle', { id }),
  cloudObproxyDetail: (id: string, clusterId: number) => ipcRenderer.invoke('cloud:obproxyDetail', { id, clusterId }),
  cloudObproxyParams: (id: string, clusterId: number) => ipcRenderer.invoke('cloud:obproxyParams', { id, clusterId }),
  cloudInspectionBundle: (id: string) => ipcRenderer.invoke('cloud:inspectionBundle', { id }),
  cloudInspectionReport: (id: string, reportId: number) => ipcRenderer.invoke('cloud:inspectionReport', { id, reportId }),
  cloudInspectionTasks: (id: string, page?: number, size?: number) => ipcRenderer.invoke('cloud:inspectionTasks', { id, page, size }),
  cloudPlatformBundle: (id: string) => ipcRenderer.invoke('cloud:platformBundle', { id }),
  cloudPlatformProperties: (id: string, page?: number, size?: number) =>
    ipcRenderer.invoke('cloud:platformProperties', { id, page, size }),
  cloudPlatformLogins: (id: string, page?: number, size?: number) => ipcRenderer.invoke('cloud:platformLogins', { id, page, size }),
  // 云管 AI 助手：会话历史 + 按所选子模块的数据快照问答（正文走 cloud:ai:event 流式回传）
  cloudAiSessions: (platformId?: string) => ipcRenderer.invoke('cloud:aiSessions', { platformId }),
  cloudAiSession: (id: string) => ipcRenderer.invoke('cloud:aiSession', { id }),
  cloudAiAsk: (input: { sessionId?: string | null; platformId: string; platformName?: string; sections?: string[]; skills?: string[]; text: string }) =>
    ipcRenderer.invoke('cloud:aiAsk', plain({ ...input, sections: [...(input.sections || [])], skills: [...(input.skills || [])] })),
  cloudAiStop: (id: string) => ipcRenderer.invoke('cloud:aiStop', { id }),
  cloudAiDelete: (id: string) => ipcRenderer.invoke('cloud:aiDelete', { id }),
  cloudAiRefresh: (id: string) => ipcRenderer.invoke('cloud:aiRefresh', { id }),
  cloudAiSetSections: (id: string, sections: string[]) => ipcRenderer.invoke('cloud:aiSetSections', { id, sections: [...(sections || [])] }),
  onCloudAiEvent: (cb: (ev: any) => void) => {
    const l = (_e: any, ev: any) => cb(ev)
    ipcRenderer.on('cloud:ai:event', l)
    return () => ipcRenderer.removeListener('cloud:ai:event', l)
  },
  // Oracle AI 助手：读取范围是「环境 × 单元（概要 / 14 个 tab）」，正文走 cloud:oraAi:event
  cloudOraAiCatalog: () => ipcRenderer.invoke('cloud:oraAiCatalog'),
  cloudOraAiSessions: () => ipcRenderer.invoke('cloud:oraAiSessions'),
  cloudOraAiSession: (id: string) => ipcRenderer.invoke('cloud:oraAiSession', { id }),
  cloudOraAiAsk: (input: { sessionId?: string | null; sections?: string[]; skills?: string[]; text: string }) =>
    ipcRenderer.invoke('cloud:oraAiAsk', plain({ ...input, sections: [...(input.sections || [])], skills: [...(input.skills || [])] })),
  cloudOraAiStop: (id: string) => ipcRenderer.invoke('cloud:oraAiStop', { id }),
  cloudOraAiDelete: (id: string) => ipcRenderer.invoke('cloud:oraAiDelete', { id }),
  cloudOraAiRefresh: (id: string) => ipcRenderer.invoke('cloud:oraAiRefresh', { id }),
  cloudOraAiSetSections: (id: string, sections: string[]) =>
    ipcRenderer.invoke('cloud:oraAiSetSections', { id, sections: [...(sections || [])] }),
  onCloudOraAiEvent: (cb: (ev: any) => void) => {
    const l = (_e: any, ev: any) => cb(ev)
    ipcRenderer.on('cloud:oraAi:event', l)
    return () => ipcRenderer.removeListener('cloud:oraAi:event', l)
  },
  // 剪贴板与外链
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', { text }),
  // 本机资源（资源面板轮询）
  sysResources: () => ipcRenderer.invoke('sys:resources'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', { url }),
  openFolder: (p: string) => ipcRenderer.invoke('shell:openFolder', { p }),
  // 权限确认（reason = 拒绝时附带的用户反馈，回传给模型调整方案）
  replyConfirm: (requestId: string, decision: string, reason?: string) => ipcRenderer.invoke('confirm:reply', { requestId, decision, reason }),
  // 应用级确认/提示（替代 window.confirm/alert 的主进程对话框，不会模态锁死窗口）
  uiConfirm: (message: string, detail?: string, danger?: boolean) => ipcRenderer.invoke('ui:confirm', { message, detail, danger }),
  uiAlert: (message: string, detail?: string) => ipcRenderer.invoke('ui:alert', { message, detail }),
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
