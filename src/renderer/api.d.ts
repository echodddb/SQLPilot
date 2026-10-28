/** 技能包导入结果（zip / URL 导入，可能含多个技能） */
declare type SkillPackResult = {
  imported: { id: string; name: string; description: string; files?: number }[]
  updated: { id: string; name: string; description: string; files?: number }[]
}

declare global {
// ---------------- SSH 服务器模块（类型单一来源：主进程定义） ----------------
declare type SshServerCfg = import('../main/types').SshServer
declare type TermPrefsCfg = import('../main/types').TermPrefs
declare type TermEncodingCfg = import('../main/types').TermEncoding
declare type TermSchemeCfg = import('../main/types').TermScheme
declare type SftpEntryView = import('../main/sftp').SftpEntry
declare type SftpStatView = import('../main/sftp').SftpEntry & { exists: boolean }
declare type LocalEntryView = { name: string; path: string; isDir: boolean; hidden: boolean; size: number; mtime: number }
declare type SshConfigEntryView = import('../main/ssh-config').SshConfigEntry & { duplicate: boolean }
declare type SftpProgress = {
  jobId: string
  /** 上传还是下载（渲染层队列被清空后也能正确归类） */
  kind?: 'upload' | 'download'
  phase: 'start' | 'progress' | 'done' | 'error' | 'canceled'
  /** 当前第几个文件（0 基） */
  index?: number
  /** 本批总文件数 */
  fileCount?: number
  name?: string
  /** 当前文件已传字节数 */
  transferred?: number
  /** 当前文件总字节数 */
  total?: number
  file?: string
  files?: number
  bytes?: number
  error?: string
}

// ---------------- 云管平台（OceanBase OCP） ----------------
declare type CloudPlatformView = import('../main/cloud/service').CloudPlatformView

declare type CloudOcpInfo = import('../main/cloud/ocp').OcpInfo
declare type CloudCapacity = import('../main/cloud/ocp').CapacityStat
declare type CloudApi<T> = { ok: boolean; data?: T; error?: string }

declare type CloudCluster = import('../main/cloud/ocp').CloudCluster

declare type CloudHost = import('../main/cloud/ocp').CloudHost

declare type CloudTenant = import('../main/cloud/ocp').CloudTenant

declare type CloudAlarm = import('../main/cloud/ocp').CloudAlarm
declare type CloudAlarmListResult = import('../main/cloud/ocp').AlarmListResult
declare type CloudAlarmRule = import('../main/cloud/ocp').AlarmRule
declare type CloudAlarmTrend = import('../main/cloud/ocp').AlarmTrend
declare type CloudAlarmTrendBucket = import('../main/cloud/ocp').AlarmTrendBucket

declare type CloudTask = import('../main/cloud/ocp').CloudTask
declare type CloudTaskDetail = import('../main/cloud/ocp').CloudTaskDetail
declare type CloudTaskListResult = import('../main/cloud/ocp').TaskListResult
declare type CloudSubtask = import('../main/cloud/ocp').CloudSubtask

declare type CloudAlarmHistoryResult = import('../main/cloud/ocp').AlarmHistoryResult

declare type CloudOverview = import('../main/cloud/ocp').CloudOverview

declare type CloudClusterDetail = import('../main/cloud/ocp').CloudClusterDetail

declare type CloudMetricQuery = import('../main/cloud/ocp').MetricQuery

// 备份恢复 / OBProxy / 巡检 / 平台管理（类型单一来源：主进程定义，渲染层只加别名）
declare type CloudBackupOverview = import('../main/cloud/backup').BackupOverview
declare type CloudBackupBundle = import('../main/cloud/backup').BackupBundle
declare type CloudBackupObjRow = import('../main/cloud/backup').BackupObjRow
declare type CloudBackupTaskKind = import('../main/cloud/backup').BackupTaskKind
declare type CloudBackupTaskRow = import('../main/cloud/backup').BackupTaskRow
declare type CloudBackupStorageRow = import('../main/cloud/backup').BackupStorageRow
declare type CloudBackupServiceRow = import('../main/cloud/backup').BackupServiceRow
declare type CloudBackupAlarmRow = import('../main/cloud/backup').BackupAlarmRow

declare type CloudObproxyCluster = import('../main/cloud/obproxy').ObproxyCluster
declare type CloudObproxyInstance = import('../main/cloud/obproxy').ObproxyInstance
declare type CloudObproxyLink = import('../main/cloud/obproxy').ObproxyLink
declare type CloudObproxyParam = import('../main/cloud/obproxy').ObproxyParam

declare type CloudInspectionBundle = import('../main/cloud/inspection').InspectionBundle
declare type CloudInspectionReport = import('../main/cloud/inspection').InspectionReport
declare type CloudInspectionReportRef = import('../main/cloud/inspection').InspectionReportRef
declare type CloudInspectionOverviewRow = import('../main/cloud/inspection').InspectionOverviewRow
declare type CloudInspectionObjectType = import('../main/cloud/inspection').InspectionObjectType
declare type CloudInspectionItemResult = import('../main/cloud/inspection').InspectionItemResult

// ---- Oracle 直连云平台 ----
declare type CloudOraclePlatformConfig = import('../main/cloud/oracle/types').CloudOraclePlatform
declare type CloudOraSectionKey = import('../main/cloud/oracle/types').OraSectionKey
declare type CloudOraSectionResult<T = unknown> = import('../main/cloud/oracle/types').OraSectionResult<T>
declare type CloudOraSections = import('../main/cloud/oracle/types').OraSections
declare type CloudOraInfo = import('../main/cloud/oracle/types').OraInfo
declare type CloudOraOverview = import('../main/cloud/oracle/types').OraOverview
declare type CloudOraKpi = import('../main/cloud/oracle/types').OraKpi
declare type CloudOraRac = import('../main/cloud/oracle/types').OraRac
declare type CloudOraInstanceDetail = import('../main/cloud/oracle/types').OraInstanceDetail
declare type CloudOraPdbSection = import('../main/cloud/oracle/types').OraPdbSection
declare type CloudOraStorage = import('../main/cloud/oracle/types').OraStorage
declare type CloudOraSessions = import('../main/cloud/oracle/types').OraSessions
declare type CloudOraSqlSection = import('../main/cloud/oracle/types').OraSqlSection
declare type CloudOraPerf = import('../main/cloud/oracle/types').OraPerf
declare type CloudOraAlerts = import('../main/cloud/oracle/types').OraAlerts
declare type CloudOraBackup = import('../main/cloud/oracle/types').OraBackup
declare type CloudOraDg = import('../main/cloud/oracle/types').OraDg
declare type CloudOraJobs = import('../main/cloud/oracle/types').OraJobs
declare type CloudOraParams = import('../main/cloud/oracle/types').OraParams
declare type CloudOraUsers = import('../main/cloud/oracle/types').OraUsers

declare type CloudPlatformBundle = import('../main/cloud/platform').PlatformBundle
declare type CloudPlatformUser = import('../main/cloud/platform').PlatformUser
declare type CloudPlatformRole = import('../main/cloud/platform').PlatformRole
declare type CloudPlatformProperty = import('../main/cloud/platform').PlatformProperty
declare type CloudPlatformLoginRecord = import('../main/cloud/platform').PlatformLoginRecord
declare type CloudPlatformSystemInfo = import('../main/cloud/platform').PlatformSystemInfo

declare type CloudMetricSeries = import('../main/cloud/ocp').MetricSeries

declare type CloudClusterCreateInput = import('../main/cloud/ocp').ClusterCreateInput

declare type CloudParamRow = import('../main/cloud/ocp').ParamRow

/** TopSQL 行（OCP /topSql 返回，耗时字段单位微秒） */
declare type CloudTopSqlRow = import('../main/cloud/ocp').TopSqlRow

/** 集群内单个租户的 SQL 概况 */
declare type CloudTenantSqlStat = import('../main/cloud/ocp').TenantSqlStat

/** 单条 SQL 的完整文本与解析结果 */
declare type CloudSqlTextInfo = import('../main/cloud/ocp').SqlTextInfo

declare type CloudCreateTenantInput = import('../main/cloud/ocp').CreateTenantInput

declare type CloudTenantSession = import('../main/cloud/ocp').CloudTenantSession

declare type CloudTenantDetail = import('../main/cloud/ocp').CloudTenantDetail

declare type CloudTenantDatabase = import('../main/cloud/tenant').TenantDatabase

declare type CloudTenantTableList = import('../main/cloud/tenant').TenantTableList

declare type CloudTenantTableSchema = import('../main/cloud/tenant').TenantTableSchema

declare type CloudTenantRelationNode = import('../main/cloud/tenant').TenantRelationNode

declare type CloudTenantTopo = import('../main/cloud/tenant').TenantStandbyTopo

declare type CloudTenantSessionStats = import('../main/cloud/tenant').TenantSessionStats

declare type CloudTenantRowLock = import('../main/cloud/tenant').TenantRowLock

declare type CloudTenantTxn = import('../main/cloud/tenant').TenantTransaction

declare type CloudTenantOutline = import('../main/cloud/tenant').TenantOutline

declare type CloudTenantSqlDiagnosis = import('../main/cloud/tenant').TenantSqlDiagnosis

declare type CloudTenantCompaction = import('../main/cloud/tenant').TenantCompaction

declare type CloudTenantCompactionSettings = import('../main/cloud/tenant').TenantCompactionSettings

declare type CloudTenantCompactionBundle = import('../main/cloud/service').TenantCompactionBundle

declare type CloudTenantGatherBundle = import('../main/cloud/service').TenantGatherBundle

declare type CloudTenantBackupAbility = import('../main/cloud/tenant').TenantBackupAbility

declare type CloudTenantBackupBundle = import('../main/cloud/service').TenantBackupBundle

declare type CloudTenantUser = import('../main/cloud/tenant').TenantUser

declare type CloudTenantTde = import('../main/cloud/tenant').TenantTde

declare type CloudUnitSpec = import('../main/cloud/tenant').UnitSpecRow

declare type CloudUnitSpecInput = import('../main/cloud/tenant').UnitSpecInput

declare type CloudPreCheckResult = import('../main/cloud/tenant').TenantPreCheckResult

declare type CloudTenantCloneInput = import('../main/cloud/tenant').TenantCloneInput

declare type CloudPrimaryTenantInfo = import('../main/cloud/tenant').PrimaryTenantInfo

declare type CloudStandbyTenantInput = import('../main/cloud/tenant').StandbyTenantInput

// 云管 AI 助手：会话（历史对话）与子模块数据快照
declare type CloudAiModuleKey = import('../main/cloud/ai').CloudAiModuleKey
declare type CloudAiSectionKey = import('../main/cloud/ai').CloudAiSectionKey
declare type CloudAiMessage = import('../main/cloud/ai').CloudAiMessage
declare type CloudAiSessionMeta = import('../main/cloud/ai').CloudAiSessionMeta
declare type CloudAiSession = import('../main/cloud/ai').CloudAiSession
declare type CloudOraAiSessionMeta = import('../main/cloud/oracle/ai').OraAiSessionMeta
declare type CloudOraAiCatalogUnit = import('../main/cloud/oracle/ai').OraAiCatalogUnit
declare type EditorAiEvent = import('../main/editor-ai').EditorAiEvent
declare type EditorAiFileEntry = import('../main/editor').AiFileEntry
declare type EditorAiSessionMeta = import('../main/editor-ai').EditorAiSessionMeta
declare type EditorAiSessionDetail = import('../main/editor-ai').EditorAiSessionDetail
declare type CloudOraAiCatalogPart = import('../main/cloud/oracle/ai').OraAiCatalogPart
declare type CloudOraAiSession = import('../main/cloud/oracle/ai').OraAiSession
declare type CloudOraAiEvent = import('../main/cloud/oracle/ai').OraAiEvent
declare type CloudOraAiUnit = import('../main/cloud/oracle/ai').OraAiUnit
declare type CloudAiEvent = import('../main/cloud/ai').CloudAiEvent

  interface Window {
    sqlpilot: {
      winMinimize(): Promise<void>
      winMaxToggle(): Promise<boolean>
      winClose(): Promise<void>
      winIsMaximized(): Promise<boolean>
      onWinMaxState(cb: (maxed: boolean) => void): () => void
      getConfig(): Promise<any>
      setConfig(cfg: any): Promise<{ ok: boolean; error?: string }>
      maskDefaults(): Promise<any>
      maskPickFile(fileType: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; fileName?: string; size?: number; content?: string; error?: string }>
      maskText(fileType: string, content: string): Promise<{ ok: boolean; content?: string; stats?: { ruleId: string; name: string; count: number }[]; edits?: { ruleId: string; category: string; original: string; replacement: string; originalStart: number; originalEnd: number; outputStart: number; outputEnd: number }[]; mappings?: { category: string; label: string; original: string; replacement: string; count: number }[]; error?: string }>
      maskSave(fileName: string, content: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
      saveConn(profile: any, password?: string): Promise<{ ok: boolean; error?: string }>
      deleteConn(id: string): Promise<{ ok: boolean }>
      testConn(profile: any, password?: string): Promise<{ ok: boolean; label?: string; error?: string }>
      getSchemas(connId: string, refresh?: boolean): Promise<{ ok: boolean; schemas?: string[]; error?: string }>
      getTables(connId: string, schema: string, refresh?: boolean): Promise<{ ok: boolean; tables?: { name: string; type: string }[]; error?: string }>
      listSessions(): Promise<{ id: string; title: string; mode: string; providerId: string | null; projectId: string | null; effort: string | null }[]>
      newSession(): Promise<{ id: string; title: string; mode: string; providerId: string | null; projectId: string | null; effort: string | null }>
      deleteSession(id: string): Promise<{ ok: boolean }>
      archiveSession(id: string, remove: boolean): Promise<{ ok: boolean; archived?: boolean; note?: string; preview?: string; instant?: boolean; error?: string }>
      unarchiveSession(id: string): Promise<{ ok: boolean; session?: any; error?: string }>
      getProjectArchive(projectId: string): Promise<{ ok: boolean; project?: string; content?: string; error?: string }>
      listArchive(projectId: string): Promise<{ ok: boolean; entries?: { sessionId: string | null; ts: string; title: string; summary: string; summarizing?: boolean; messageCount?: number; legacy?: boolean; raw?: string }[]; error?: string }>
      deleteArchiveEntry(projectId: string, opts: { sessionId?: string | null; reverseIndex?: number; rawCheck?: string; ts?: string; title?: string }): Promise<{ ok: boolean; error?: string }>
      clearArchive(projectId: string): Promise<{ ok: boolean; error?: string }>
      onArchiveProgress(cb: (p: { id: string; stage: 'summary' | 'save' | 'done' | 'error'; note: string }) => void): () => void
      onArchiveUpdated(cb: (p: { projectId: string }) => void): () => void
      updateSession(id: string, patch: any): Promise<{ ok: boolean; session?: any }>
      sendChat(sessionId: string, text: string): Promise<{ ok: boolean }>
      resetChat(sessionId: string): Promise<{ ok: boolean }>
      getHistory(sessionId: string): Promise<{ ok: boolean; messages: any[] }>
      stopChat(sessionId: string): Promise<{ ok: boolean }>
      pickFolder(): Promise<{ ok: boolean; path?: string }>
      saveProject(project: any): Promise<{ ok: boolean; error?: string }>
      deleteProject(id: string): Promise<{ ok: boolean }>
      testServer(server: any, password?: string, keyPassphrase?: string): Promise<{ ok: boolean; label?: string; locale?: string; viaJump?: string; error?: string }>
      saveServer(server: any, password?: string, keyPassphrase?: string): Promise<{ ok: boolean; id?: string; error?: string }>
      deleteServer(id: string): Promise<{ ok: boolean }>
      saveServerGroup(name: string, oldName?: string): Promise<{ ok: boolean; name?: string; moved?: number; error?: string }>
      deleteServerGroup(name: string, moveTo?: string): Promise<{ ok: boolean; moved?: number; error?: string }>
      moveServersToGroup(ids: string[], group: string): Promise<{ ok: boolean; moved?: number; error?: string }>
      forgetHostKey(host: string, port: number): Promise<{ ok: boolean; removed: boolean }>
      importSshConfig(): Promise<{ ok: boolean; error?: string; path: string; entries: SshConfigEntryView[] }>
      termOpen(termId: string, serverId: string, opts?: { cols?: number; rows?: number; encoding?: string; cwd?: string; term?: string }): Promise<{ ok: boolean; error?: string }>
      termInput(termId: string, data: string): Promise<{ ok: boolean }>
      termResize(termId: string, cols: number, rows: number): Promise<{ ok: boolean }>
      termClose(termId: string): Promise<{ ok: boolean }>
      onTermData(cb: (p: { termId: string; data: string }) => void): () => void
      onTermExit(cb: (p: { termId: string; code?: number | null }) => void): () => void
      sftpList(serverId: string, p: string): Promise<{ ok: boolean; entries?: { name: string; isDir: boolean; size: number; mtime: number }[]; error?: string }>
      sftpDownload(serverId: string, remotePath: string, localDir: string): Promise<{ ok: boolean; local?: string; error?: string }>
      sftpUpload(serverId: string, remoteDir: string): Promise<{ ok: boolean; canceled?: boolean; count?: number; error?: string }>
      // ---- SFTP 完整面板（服务器模块） ----
      sftpLs(serverId: string, path: string): Promise<{ ok: boolean; path?: string; entries?: SftpEntryView[]; error?: string }>
      sftpStat(serverId: string, path: string): Promise<{ ok: boolean; stat?: SftpStatView; error?: string }>
      sftpHome(serverId: string): Promise<{ ok: boolean; path?: string; error?: string }>
      sftpMkdir(serverId: string, path: string): Promise<{ ok: boolean; error?: string }>
      sftpRename(serverId: string, from: string, to: string): Promise<{ ok: boolean; error?: string }>
      sftpRemove(serverId: string, path: string, recursive?: boolean): Promise<{ ok: boolean; removed?: number; error?: string }>
      sftpChmod(serverId: string, path: string, mode: number): Promise<{ ok: boolean; error?: string }>
      sftpRead(serverId: string, path: string, maxBytes?: number, encoding?: string): Promise<{ ok: boolean; content?: string; size?: number; truncated?: boolean; error?: string }>
      sftpWrite(serverId: string, path: string, content: string, encoding?: string): Promise<{ ok: boolean; bytes?: number; error?: string }>
      sftpPick(mode: 'files' | 'folder'): Promise<{ ok: boolean; canceled?: boolean; paths?: string[] }>
      sftpUploadPaths(serverId: string, localPaths: string[], remoteDir: string, jobId: string): Promise<{ ok: boolean; files?: number; bytes?: number; error?: string }>
      sftpDownloadPaths(serverId: string, remotePaths: string[], localDir: string, jobId: string): Promise<{ ok: boolean; files?: number; bytes?: number; dir?: string; error?: string }>
      sftpCancel(jobId: string): Promise<{ ok: boolean; found: boolean }>
      onSftpProgress(cb: (p: SftpProgress) => void): () => void
      localRoots(): Promise<{ ok: boolean; roots: { name: string; path: string }[]; home: string; quick: { name: string; path: string }[] }>
      localLs(dir: string): Promise<{ ok: boolean; dir?: string; parent?: string; truncated?: boolean; entries?: LocalEntryView[]; error?: string }>
      localOpen(p: string): Promise<{ ok: boolean; error?: string }>
      localSaveText(content: string, suggested?: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
      pickFile(title?: string, filters?: { name: string; extensions: string[] }[]): Promise<{ ok: boolean; canceled?: boolean; path?: string }>
      showInFolder(p: string): Promise<{ ok: boolean }>
      // ---- 文本编辑器 ----
      editorOpenDialog(): Promise<{ ok: boolean; canceled?: boolean; docs?: any[]; errors?: string[] }>
      editorOpenPath(p: string): Promise<{ ok: boolean; doc?: any; error?: string }>
      editorOpenFolder(): Promise<{ ok: boolean; canceled?: boolean; dir?: string }>
      editorListDir(dir: string): Promise<{ ok: boolean; entries?: { name: string; path: string; isDir: boolean; hidden: boolean }[]; error?: string }>
      editorStatPath(p: string): Promise<{ ok: boolean; isDir?: boolean; isFile?: boolean; error?: string }>
      editorNew(name?: string, encoding?: string, eol?: string): Promise<any>
      editorWindow(id: string, start: number, count: number): Promise<{ ok: boolean; start?: number; lines?: string[]; total?: number; error?: string }>
      editorLoadFull(id: string): Promise<{ ok: boolean; text?: string; error?: string }>
      editorSave(p: { id: string; text: string; path?: string | null; encoding?: string; eol?: string; markRecentLine?: { line: number; col: number } }): Promise<{ ok: boolean; doc?: any; error?: string }>
      editorSaveAs(id: string, suggested?: string): Promise<{ ok: boolean; canceled?: boolean; path?: string }>
      editorReopen(id: string, encoding?: string): Promise<{ ok: boolean; doc?: any; error?: string }>
      editorClose(id: string): Promise<{ ok: boolean }>
      editorStat(ids: string[]): Promise<Record<string, { mtimeMs: number; size: number; exists: boolean }>>
      editorFind(id: string, query: string, opts: any): Promise<{ ok: boolean; hits?: { line: number; start: number; end: number; text: string }[]; total?: number; error?: string }>
      editorFindInFiles(p: any): Promise<{ ok: boolean; hits?: { file: string; rel: string; line: number; col: number; text: string }[]; files?: number; truncated?: boolean; error?: string }>
      editorRecents(): Promise<{ path: string; name: string; at: number; line?: number; col?: number }[]>
      editorClearRecents(): Promise<{ ok: boolean }>
      editorClipboardRead(): Promise<string>
      editorPendingOpens(): Promise<string[]>
      // ---- 编辑器 AI：选中文本问答（流式） ----
      editorAiAsk(input: { id: string; selection: string; question: string; file?: string; lang?: string; lines?: { start: number; end: number }; truncated?: boolean; wholeFile?: boolean; files?: string[]; skills?: string[]; sessionId?: string | null; history?: { role: string; text: string }[] }): Promise<{ ok: boolean; sessionId?: string; error?: string }>
      editorReadTextForAi(path: string, maxChars?: number): Promise<{ ok: boolean; text?: string; name?: string; lineCount?: number; truncated?: boolean; error?: string }>
      editorListFilesForAi(dir: string): Promise<{ ok: boolean; root?: string; files?: EditorAiFileEntry[]; truncated?: boolean; error?: string }>
      editorAiSessions(): Promise<EditorAiSessionMeta[]>
      editorAiSession(id: string): Promise<EditorAiSessionDetail | null>
      editorAiDelete(id: string): Promise<{ ok: boolean }>
      editorAiStop(id: string): Promise<{ ok: boolean }>
      onEditorAiEvent(cb: (ev: EditorAiEvent) => void): () => void
      editorPendingWorkspace(): Promise<string>
      getPathForFile(file: File): string
      onEditorOpenRequest(cb: (p: { paths: string[]; folder?: string }) => void): () => void
      sqlRun(connId: string, sql: string, sessionKey?: string): Promise<{ ok: boolean; result?: any; error?: string }>
      sqlCloseSession(connId: string, sessionKey: string): Promise<{ ok: boolean }>
      connInfo(id: string): Promise<{
        ok: boolean
        /** group：同一主题的图表与明细共用一个分组，渲染时放在同一张卡片里 */
        sections?: { title: string; group?: string; rows: { k: string; v: string }[] }[]
        tables?: { title: string; group?: string; columns: string[]; rows: any[][] }[]
        /** 图形化看板：KPI 磁贴 + 图表（gauge/donut/bars/stack） */
        kpis?: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad' }[]
        charts?: {
          id: string
          title: string
          kind: 'gauge' | 'donut' | 'bars' | 'stack'
          unit?: string
          value?: number
          total?: number
          caption?: string
          note?: string
          group?: string
          items: { label: string; value: number; hint?: string }[]
        }[]
        error?: string
      }>
      activeSessions(id: string, columns?: string[]): Promise<{ ok: boolean; available?: string[]; columns?: string[]; rows?: any[][]; ms?: number; note?: string; error?: string }>
      objData(p: { connId: string; schema: string; table: string; page?: number; pageSize?: number; where?: string; orderBy?: string; orderDir?: string }): Promise<{ ok: boolean; columns?: string[]; rows?: any[][]; total?: number; ms?: number; rids?: string[]; error?: string }>
      objDescribe(connId: string, schema: string, table: string, refresh?: boolean): Promise<{ ok: boolean; info?: { columns: { name: string; type: string; nullable: string }[]; approxRows?: number }; error?: string }>
      objDdl(connId: string, schema: string, table: string): Promise<{ ok: boolean; ddl?: string; error?: string }>
      objEditInfo(connId: string, schema: string, table: string): Promise<{ ok: boolean; editable?: boolean; reason?: string; keyMode?: 'rowid' | 'cols'; keyCols?: string[]; readonlyCols?: string[]; error?: string }>
      objSaveEdits(p: { connId: string; sessionKey: string; schema: string; table: string; keyMode: 'rowid' | 'cols'; keyCols: string[]; edits: { rid?: string; keys?: any[]; col: string; value: string | null }[] }): Promise<{ ok: boolean; applied?: number; conflicts?: number[]; uncommitted?: boolean; error?: string }>
      exportResult(p: { connId: string; sessionKey: string; sql: string; columns: string[] }): Promise<{ ok: boolean; path?: string; rows?: number; truncated?: boolean; canceled?: boolean; error?: string }>
      getArtifact(id: string): Promise<{ ok: boolean; data?: { kind: 'table'; columns: string[]; rows: unknown[][]; rowCount: number; ms?: number; truncated?: boolean; conn?: string; sql?: string; at: number }; error?: string }>
      artifactImageDataUrl(p: string): Promise<{ ok: boolean; url?: string; size?: number; error?: string }>
      exportArtifactCsv(p: { columns: string[]; rows: unknown[][]; name?: string }): Promise<{ ok: boolean; path?: string; rows?: number; canceled?: boolean; error?: string }>
      listSkills(): Promise<{ id: string; name: string; description: string; enabled: boolean; files?: number }[]>
      saveSkill(p: { id?: string; name: string; description: string; content: string }): Promise<{ ok: boolean }>
      deleteSkill(id: string): Promise<{ ok: boolean }>
      readSkillFull(id: string, resourcePath?: string): Promise<{ ok: boolean; content: string; error?: string }>
      toggleSkill(id: string, enabled: boolean): Promise<{ ok: boolean }>
      importSkill(): Promise<{ ok: boolean; skill?: any; pack?: SkillPackResult; error?: string }>
      importSkillUrl(url: string): Promise<{ ok: boolean; pack?: SkillPackResult; error?: string }>
      testProvider(provider: any, apiKey?: string): Promise<{ ok: boolean; label?: string; error?: string }>
      listProviderModels(provider: any, apiKey?: string): Promise<{ ok: boolean; models?: string[]; error?: string }>
      /** WorkBuddy 受管桥：状态 / 启停 / 登录控制台 / 模型目录（含倍率与上下文窗口） */
      wbStatus(): Promise<{ running: boolean; starting: boolean; port: number; baseUrl: string; error?: string; root?: string }>
      wbStart(): Promise<{ running: boolean; starting: boolean; port: number; baseUrl: string; error?: string; root?: string }>
      wbStop(): Promise<{ running: boolean; starting: boolean; port: number; baseUrl: string; error?: string; root?: string }>
      wbLogin(): Promise<{ ok: boolean; url?: string; error?: string }>
      wbModels(): Promise<{ ok: boolean; models?: any[]; error?: string }>
      writeClipboard(text: string): Promise<{ ok: boolean }>
      // ---- 云管平台（OceanBase OCP） ----
      cloudPlatforms(): Promise<CloudPlatformView[]>
      cloudSave(platform: Partial<CloudPlatformView>, password?: string): Promise<{ ok: boolean; error?: string; platform?: CloudPlatformView; warning?: string }>
      cloudDelete(id: string): Promise<{ ok: boolean; error?: string }>
      cloudTest(platform: Partial<CloudPlatformView>, password?: string): Promise<{
        ok: boolean
        info?: CloudOcpInfo
        error?: string
        baseUrl?: string
        version?: string
        mode?: string
        /** Oracle：选了 SYSDBA 但账号无此特权，已按普通身份连通 */
        downgraded?: boolean
        note?: string
        privileges?: { dba: boolean; sysdba: boolean; sysoper: boolean }
      }>
      cloudStatus(id: string): Promise<{ ok: boolean; info?: CloudOcpInfo; error?: string; oracle?: { version?: string; mode?: string } }>
      // ---- Oracle 直连云平台（直接查 v$ / dba_ 视图） ----
      cloudOraSection<K extends CloudOraSectionKey>(id: string, section: K, opts?: Record<string, any>, force?: boolean): Promise<CloudOraSectionResult<CloudOraSections[K]>>
      cloudOraSqlDetail(id: string, sqlId: string): Promise<{ ok: boolean; text?: string; plan?: { id: number; depth: number; operation: string; options: string; objectName: string; cost: number; cardinality: number; bytes: number }[]; error?: string }>
      cloudOverview(id: string): Promise<CloudApi<CloudOverview>>
      cloudClusters(id: string): Promise<CloudApi<CloudCluster[]>>
      cloudCluster(id: string, clusterId: number): Promise<CloudApi<CloudClusterDetail>>
      cloudTenants(id: string): Promise<CloudApi<CloudTenant[]>>
      cloudTenant(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantDetail>>
      cloudHosts(id: string): Promise<CloudApi<CloudHost[]>>
      cloudAlarms(id: string, opts?: { level?: number; scope?: string; keyword?: string; alarmType?: string; appType?: string; hours?: number; page?: number; size?: number }): Promise<CloudApi<CloudAlarmListResult>>
      cloudAlarmHistory(id: string, opts?: { page?: number; size?: number; hours?: number; level?: number; scope?: string; keyword?: string; alarmType?: string; appType?: string }): Promise<CloudApi<CloudAlarmHistoryResult>>
      cloudAlarmDetail(id: string, alarmId: number): Promise<CloudApi<CloudAlarm>>
      cloudAlarmRules(id: string, opts?: { page?: number; size?: number; level?: number; scope?: string; appType?: string; keyword?: string; enabled?: boolean }): Promise<CloudApi<{ items: CloudAlarmRule[]; total: number; page: number; size: number }>>
      cloudAlarmTrend(id: string, hours?: number): Promise<CloudApi<CloudAlarmTrend>>
      cloudAlarmLevelCounts(id: string): Promise<CloudApi<{ level: number; count: number }[]>>
      cloudTasks(id: string, opts?: { page?: number; size?: number; status?: string; statusIn?: string[]; name?: string; clusterId?: number; tenantId?: number; creator?: string; objType?: string; type?: string; hours?: number; sort?: string }): Promise<CloudApi<CloudTaskListResult>>
      cloudTaskDetail(id: string, taskId: number): Promise<CloudApi<CloudTaskDetail>>
      cloudTaskStats(id: string): Promise<CloudApi<{ status: string; count: number }[]>>
      cloudTaskCreators(id: string): Promise<CloudApi<string[]>>
      cloudExportCsv(fileName: string, columns: string[], rows: unknown[][]): Promise<{ ok: boolean; path?: string; count?: number; error?: string; canceled?: boolean }>
      cloudMetrics(id: string, query: CloudMetricQuery): Promise<CloudApi<{ series: CloudMetricSeries[]; warnings: string[]; step: number }>>
      cloudClusterAction(id: string, clusterId: number, action: string): Promise<CloudApi<{ taskId?: number; message?: string }>>
      cloudCreateTenant(id: string, clusterId: number, input: CloudCreateTenantInput): Promise<CloudApi<{ taskId?: number }>>
      cloudDeleteTenant(id: string, clusterId: number, tenantId: number): Promise<CloudApi<{ taskId?: number }>>
      cloudPackages(id: string): Promise<CloudApi<{ id: number; name: string; version: string; architecture: string }[]>>
      cloudClusterPreCheck(id: string, input: CloudClusterCreateInput): Promise<CloudApi<{ checkId?: string; items: { key: string; name: string; status: string; message?: string }[] }>>
      cloudClusterCreate(id: string, input: CloudClusterCreateInput, checkId?: string): Promise<CloudApi<{ taskId?: number }>>
      cloudClusterParams(id: string, clusterId: number): Promise<CloudApi<CloudParamRow[]>>
      cloudClusterUpdateParams(id: string, clusterId: number, items: { name: string; value: string }[]): Promise<CloudApi<void>>
      cloudTenantParams(id: string, clusterId: number, tenantId: number): Promise<CloudApi<{ name: string; value: string; def: string; type: string; description: string }[]>>
      cloudTenantUpdateParams(id: string, clusterId: number, tenantId: number, items: { name: string; value: string }[]): Promise<CloudApi<void>>
      cloudTenantChangePassword(id: string, clusterId: number, tenantId: number, newPassword: string): Promise<CloudApi<void>>
      cloudTenantModifyWhitelist(id: string, clusterId: number, tenantId: number, whitelist: string): Promise<CloudApi<void>>
      cloudTenantModifyReplica(id: string, clusterId: number, tenantId: number, replicas: { zoneName: string; replicaType: string; unitSpecName: string; unitCount: number }[]): Promise<CloudApi<{ taskId?: number }>>
      cloudTenantAddReplica(id: string, clusterId: number, tenantId: number, replicas: { zoneName: string; replicaType: string; unitSpecName: string; unitCount: number }[]): Promise<CloudApi<{ taskId?: number }>>
      cloudTenantDeleteReplica(id: string, clusterId: number, tenantId: number, zones: string[]): Promise<CloudApi<{ taskId?: number }>>
      cloudTenantSetLocked(id: string, clusterId: number, tenantId: number, locked: boolean): Promise<CloudApi<void>>
      cloudTenantSessions(id: string, clusterId: number, tenantId: number, page?: number, size?: number): Promise<CloudApi<{ items: CloudTenantSession[]; total: number }>>
      cloudTenantCloseSessions(id: string, clusterId: number, tenantId: number, sessionIds: number[]): Promise<CloudApi<void>>
      cloudTopSql(
        id: string,
        clusterId: number,
        tenantId: number,
        opts: { from: number; to: number; sqlText?: string; limit?: number }
      ): Promise<CloudApi<CloudTopSqlRow[]>>
      cloudSlowSql(id: string, clusterId: number, tenantId: number, opts: { from: number; to: number }): Promise<CloudApi<CloudTopSqlRow[]>>
      cloudSqlText(
        id: string,
        clusterId: number,
        tenantId: number,
        sqlId: string,
        opts: { from: number; to: number }
      ): Promise<CloudApi<CloudSqlTextInfo>>
      cloudTenantSqlStats(id: string, clusterId: number, from: number, to: number): Promise<CloudApi<CloudTenantSqlStat[]>>
      // 租户详情页（对齐 OCP 各 tab）
      cloudTenantDbs(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantDatabase[]>>
      cloudTenantTables(id: string, clusterId: number, tenantId: number, db: string): Promise<CloudApi<CloudTenantTableList>>
      cloudTenantTableSchema(id: string, clusterId: number, tenantId: number, db: string, table: string): Promise<CloudApi<CloudTenantTableSchema>>
      cloudTenantTopo(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantTopo>>
      cloudTenantSessionStats(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantSessionStats>>
      cloudTenantCloseQuery(id: string, clusterId: number, tenantId: number, sessionIds: number[]): Promise<CloudApi<void>>
      cloudTenantRowLocks(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantRowLock[]>>
      cloudTenantTxns(id: string, clusterId: number, tenantId: number, thresholdMs?: number): Promise<CloudApi<CloudTenantTxn[]>>
      cloudTenantCloseTxns(id: string, clusterId: number, tenantId: number, list: { sessionId: number; transId?: string }[]): Promise<CloudApi<void>>
      cloudTenantNewSql(id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number): Promise<CloudApi<CloudTopSqlRow[]>>
      cloudTenantHighRiskSql(id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number): Promise<CloudApi<CloudTopSqlRow[]>>
      cloudTenantParallelSql(id: string, clusterId: number, tenantId: number, from: number, to: number, limit?: number): Promise<CloudApi<CloudTopSqlRow[]>>
      cloudTenantOutlines(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantOutline[]>>
      cloudTenantSqlDiagnosis(id: string, clusterId: number, tenantId: number, sqlId: string, from: number, to: number): Promise<CloudApi<CloudTenantSqlDiagnosis>>
      cloudTenantCompaction(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantCompactionBundle>>
      cloudTenantCompactionAction(id: string, clusterId: number, tenantId: number, action: string): Promise<CloudApi<void>>
      cloudTenantUpdateCompactionSettings(id: string, clusterId: number, tenantId: number, patch: Partial<CloudTenantCompactionSettings>): Promise<CloudApi<void>>
      cloudTenantGather(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantGatherBundle>>
      cloudTenantBackup(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantBackupBundle>>
      cloudTenantUsers(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantUser[]>>
      cloudTenantTde(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudTenantTde | null>>
      // Unit 规格 / 克隆租户 / 创建备租户
      cloudUnitSpecs(id: string): Promise<CloudApi<CloudUnitSpec[]>>
      cloudUnitSpecCreate(id: string, input: CloudUnitSpecInput): Promise<CloudApi<void>>
      cloudUnitSpecUpdate(id: string, specId: number, input: CloudUnitSpecInput): Promise<CloudApi<void>>
      cloudUnitSpecDelete(id: string, specId: number): Promise<CloudApi<void>>
      cloudTenantClonePreCheck(id: string, clusterId: number, tenantId: number): Promise<CloudApi<CloudPreCheckResult>>
      cloudTenantClone(id: string, clusterId: number, tenantId: number, input: CloudTenantCloneInput): Promise<CloudApi<{ taskId?: number; tenantId?: number }>>
      cloudPrimaryTenantInfo(id: string, clusterId: number, primaryTenantId: number): Promise<CloudApi<CloudPrimaryTenantInfo>>
      cloudCreateStandbyTenant(id: string, clusterId: number, input: CloudStandbyTenantInput): Promise<CloudApi<{ taskId?: number; tenantId?: number }>>
      // ---- 备份恢复 / OBProxy / 巡检 / 平台管理 ----
      cloudBackupBundle(id: string): Promise<CloudApi<CloudBackupBundle>>
      cloudBackupTasks(id: string, kind: CloudBackupTaskKind, size?: number): Promise<CloudApi<CloudBackupTaskRow[]>>
      cloudObproxyBundle(id: string): Promise<CloudApi<{ clusters: CloudObproxyCluster[]; updatedAt: number }>>
      cloudObproxyDetail(id: string, clusterId: number): Promise<CloudApi<CloudObproxyCluster>>
      cloudObproxyParams(id: string, clusterId: number): Promise<CloudApi<CloudObproxyParam[]>>
      cloudInspectionBundle(id: string): Promise<CloudApi<CloudInspectionBundle>>
      cloudInspectionReport(id: string, reportId: number): Promise<CloudApi<CloudInspectionReport>>
      cloudInspectionTasks(id: string, page?: number, size?: number): Promise<CloudApi<{ items: CloudInspectionReportRef[]; total: number }>>
      cloudPlatformBundle(id: string): Promise<CloudApi<CloudPlatformBundle>>
      cloudPlatformProperties(id: string, page?: number, size?: number): Promise<CloudApi<{ items: CloudPlatformProperty[]; total: number }>>
      cloudPlatformLogins(id: string, page?: number, size?: number): Promise<CloudApi<{ items: CloudPlatformLoginRecord[]; total: number }>>
      // ---- 云管 AI 助手（子模块数据快照 + 历史对话） ----
      cloudAiSessions(platformId?: string): Promise<CloudAiSessionMeta[]>
      cloudAiSession(id: string): Promise<CloudAiSession | null>
      cloudAiAsk(input: { sessionId?: string | null; platformId: string; platformName?: string; sections?: CloudAiSectionKey[]; skills?: string[]; text: string }): Promise<{ ok: boolean; sessionId?: string; error?: string }>
      cloudAiStop(id: string): Promise<{ ok: boolean }>
      cloudAiDelete(id: string): Promise<{ ok: boolean }>
      cloudAiRefresh(id: string): Promise<{ ok: boolean; contextAt?: number; contextChars?: number; error?: string }>
      cloudAiSetSections(id: string, sections: CloudAiSectionKey[]): Promise<{ ok: boolean; error?: string }>
      // ---- Oracle AI 助手（多环境 × 单元级读取范围） ----
      cloudOraAiCatalog(): Promise<CloudOraAiCatalogUnit[]>
      cloudOraAiSessions(): Promise<CloudOraAiSessionMeta[]>
      cloudOraAiSession(id: string): Promise<CloudOraAiSession | null>
      cloudOraAiAsk(input: { sessionId?: string | null; sections?: string[]; skills?: string[]; text: string }): Promise<{ ok: boolean; sessionId?: string; error?: string }>
      cloudOraAiStop(id: string): Promise<{ ok: boolean }>
      cloudOraAiDelete(id: string): Promise<{ ok: boolean }>
      cloudOraAiRefresh(id: string): Promise<{ ok: boolean; contextAt?: number; contextChars?: number; error?: string }>
      cloudOraAiSetSections(id: string, sections: string[]): Promise<{ ok: boolean; error?: string }>
      onCloudOraAiEvent(cb: (ev: CloudOraAiEvent) => void): () => void
      onCloudAiEvent(cb: (ev: CloudAiEvent) => void): () => void
      sysResources(): Promise<{
        cpu: { model: string; cores: number; usagePct: number | null; perCore: number[] }
        mem: { totalBytes: number; freeBytes: number; usedPct: number }
        disks: { drive: string; totalBytes: number; freeBytes: number; usedPct: number }[]
        app: { rssBytes: number; cpuPct: number | null }
        sys: { hostname: string; platform: string; uptimeSec: number }
      }>
      openExternal(url: string): Promise<{ ok: boolean }>
      openFolder(p: string): Promise<{ ok: boolean }>
      replyConfirm(requestId: string, decision: string, reason?: string): Promise<{ ok: boolean }>
      uiConfirm(message: string, detail?: string, danger?: boolean): Promise<boolean>
      uiAlert(message: string, detail?: string): Promise<boolean>
      replyLlmPreview(requestId: string, ok: boolean): Promise<{ ok: boolean }>
      onLlmPreview(cb: (p: { requestId: string; sessionId?: string; url: string; body: any }) => void): () => void
      onLlmPreviewExpired(cb: (p: { requestId: string }) => void): () => void
      getAudit(): Promise<any[]>
      auditQuery(q: { kinds?: string[]; actors?: string[]; conns?: string[]; sessionId?: string; runId?: string; q?: string; fromMs?: number; toMs?: number; approvedOnly?: boolean; errorsOnly?: boolean; limit?: number; offset?: number }): Promise<{ entries: any[]; total: number; hasMore: boolean }>
      appInfo(): Promise<{ secretsAvailable: boolean; version: string }>
      subagentTasks(sessionId?: string): Promise<{ id: string; sessionId: string; agentType: string; description: string; status: string; startedAt: number; endedAt?: number; summary?: string; runFile?: string }[]>
      subagentStopTask(id: string): Promise<{ ok: boolean }>
      subagentAudit(runId: string): Promise<{ ok: boolean; entries: any[]; file: string }>
      onSubtasks(cb: (p: { sessionId: string; tasks: any[] }) => void): () => void
      onAgentEvent(cb: (ev: any) => void): () => void
      onConfirm(cb: (req: any) => void): () => void
      onConfirmExpired(cb: (payload: any) => void): () => void
    }
  }
}

export {}
