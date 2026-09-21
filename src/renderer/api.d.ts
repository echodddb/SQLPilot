/** 技能包导入结果（zip / URL 导入，可能含多个技能） */
declare type SkillPackResult = {
  imported: { id: string; name: string; description: string; files?: number }[]
  updated: { id: string; name: string; description: string; files?: number }[]
}

declare global {
  interface Window {
    sqlpilot: {
      getConfig(): Promise<any>
      setConfig(cfg: any): Promise<{ ok: boolean }>
      saveConn(profile: any, password?: string): Promise<{ ok: boolean; error?: string }>
      deleteConn(id: string): Promise<{ ok: boolean }>
      testConn(profile: any, password?: string): Promise<{ ok: boolean; label?: string; error?: string }>
      getSchemas(connId: string, refresh?: boolean): Promise<{ ok: boolean; schemas?: string[]; error?: string }>
      getTables(connId: string, schema: string, refresh?: boolean): Promise<{ ok: boolean; tables?: { name: string; type: string }[]; error?: string }>
      listSessions(): Promise<{ id: string; title: string; mode: string; providerId: string | null; projectId: string | null; effort: string | null }[]>
      newSession(): Promise<{ id: string; title: string; mode: string; providerId: string | null; projectId: string | null; effort: string | null }>
      deleteSession(id: string): Promise<{ ok: boolean }>
      archiveSession(id: string, remove: boolean): Promise<{ ok: boolean; archived?: boolean; note?: string; preview?: string; error?: string }>
      getProjectArchive(projectId: string): Promise<{ ok: boolean; project?: string; content?: string; error?: string }>
      onArchiveProgress(cb: (p: { id: string; stage: 'summary' | 'save' | 'done' | 'error'; note: string }) => void): () => void
      updateSession(id: string, patch: any): Promise<{ ok: boolean; session?: any }>
      sendChat(sessionId: string, text: string): Promise<{ ok: boolean }>
      resetChat(sessionId: string): Promise<{ ok: boolean }>
      getHistory(sessionId: string): Promise<{ ok: boolean; messages: any[] }>
      stopChat(sessionId: string): Promise<{ ok: boolean }>
      pickFolder(): Promise<{ ok: boolean; path?: string }>
      saveProject(project: any, serverPasswords?: Record<string, string>): Promise<{ ok: boolean; error?: string }>
      deleteProject(id: string): Promise<{ ok: boolean }>
      testServer(server: any, password?: string): Promise<{ ok: boolean; label?: string; error?: string }>
      termOpen(termId: string, serverId: string): Promise<{ ok: boolean; error?: string }>
      termInput(termId: string, data: string): Promise<{ ok: boolean }>
      termResize(termId: string, cols: number, rows: number): Promise<{ ok: boolean }>
      termClose(termId: string): Promise<{ ok: boolean }>
      onTermData(cb: (p: { termId: string; data: string }) => void): () => void
      onTermExit(cb: (p: { termId: string }) => void): () => void
      sftpList(serverId: string, p: string): Promise<{ ok: boolean; entries?: { name: string; isDir: boolean; size: number; mtime: number }[]; error?: string }>
      sftpDownload(serverId: string, remotePath: string, localDir: string): Promise<{ ok: boolean; local?: string; error?: string }>
      sftpUpload(serverId: string, remoteDir: string): Promise<{ ok: boolean; canceled?: boolean; count?: number; error?: string }>
      showInFolder(p: string): Promise<{ ok: boolean }>
      sqlRun(connId: string, sql: string, sessionKey?: string): Promise<{ ok: boolean; result?: any; error?: string }>
      sqlCloseSession(connId: string, sessionKey: string): Promise<{ ok: boolean }>
      connInfo(id: string): Promise<{ ok: boolean; sections?: { title: string; rows: { k: string; v: string }[] }[]; tables?: { title: string; columns: string[]; rows: any[][] }[]; error?: string }>
      activeSessions(id: string, columns?: string[]): Promise<{ ok: boolean; available?: string[]; columns?: string[]; rows?: any[][]; ms?: number; note?: string; error?: string }>
      objData(p: { connId: string; schema: string; table: string; page?: number; pageSize?: number; where?: string; orderBy?: string; orderDir?: string }): Promise<{ ok: boolean; columns?: string[]; rows?: any[][]; total?: number; ms?: number; rids?: string[]; error?: string }>
      objDescribe(connId: string, schema: string, table: string, refresh?: boolean): Promise<{ ok: boolean; info?: { columns: { name: string; type: string; nullable: string }[]; approxRows?: number }; error?: string }>
      objDdl(connId: string, schema: string, table: string): Promise<{ ok: boolean; ddl?: string; error?: string }>
      objEditInfo(connId: string, schema: string, table: string): Promise<{ ok: boolean; editable?: boolean; reason?: string; keyMode?: 'rowid' | 'cols'; keyCols?: string[]; readonlyCols?: string[]; error?: string }>
      objSaveEdits(p: { connId: string; sessionKey: string; schema: string; table: string; keyMode: 'rowid' | 'cols'; keyCols: string[]; edits: { rid?: string; keys?: any[]; col: string; value: string | null }[] }): Promise<{ ok: boolean; applied?: number; conflicts?: number[]; uncommitted?: boolean; error?: string }>
      exportResult(p: { connId: string; sessionKey: string; sql: string; columns: string[] }): Promise<{ ok: boolean; path?: string; rows?: number; truncated?: boolean; canceled?: boolean; error?: string }>
      listSkills(): Promise<{ id: string; name: string; description: string; enabled: boolean; files?: number }[]>
      saveSkill(p: { id?: string; name: string; description: string; content: string }): Promise<{ ok: boolean }>
      deleteSkill(id: string): Promise<{ ok: boolean }>
      readSkillFull(id: string, resourcePath?: string): Promise<{ ok: boolean; content: string; error?: string }>
      toggleSkill(id: string, enabled: boolean): Promise<{ ok: boolean }>
      importSkill(): Promise<{ ok: boolean; skill?: any; pack?: SkillPackResult; error?: string }>
      importSkillUrl(url: string): Promise<{ ok: boolean; pack?: SkillPackResult; error?: string }>
      testProvider(provider: any, apiKey?: string): Promise<{ ok: boolean; label?: string; error?: string }>
      writeClipboard(text: string): Promise<{ ok: boolean }>
      openExternal(url: string): Promise<{ ok: boolean }>
      openFolder(p: string): Promise<{ ok: boolean }>
      replyConfirm(requestId: string, decision: string): Promise<{ ok: boolean }>
      replyLlmPreview(requestId: string, ok: boolean): Promise<{ ok: boolean }>
      onLlmPreview(cb: (p: { requestId: string; sessionId?: string; url: string; body: any }) => void): () => void
      onLlmPreviewExpired(cb: (p: { requestId: string }) => void): () => void
      getAudit(): Promise<any[]>
      appInfo(): Promise<{ secretsAvailable: boolean; version: string }>
      onAgentEvent(cb: (ev: any) => void): () => void
      onConfirm(cb: (req: any) => void): () => void
      onConfirmExpired(cb: (payload: any) => void): () => void
    }
  }
}

export {}
