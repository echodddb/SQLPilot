declare global {
  interface Window {
    sqlpilot: {
      getConfig(): Promise<any>
      setConfig(cfg: any): Promise<{ ok: boolean }>
      saveConn(profile: any, password?: string): Promise<{ ok: boolean; error?: string }>
      deleteConn(id: string): Promise<{ ok: boolean }>
      testConn(profile: any, password?: string): Promise<{ ok: boolean; label?: string; error?: string }>
      getSchemas(connId: string): Promise<{ ok: boolean; schemas?: string[]; error?: string }>
      getTables(connId: string, schema: string): Promise<{ ok: boolean; tables?: { name: string; type: string }[]; error?: string }>
      listSessions(): Promise<{ id: string; title: string; mode: string; providerId: string | null; projectId: string | null; effort: string | null }[]>
      newSession(): Promise<{ id: string; title: string; mode: string; providerId: string | null; projectId: string | null; effort: string | null }>
      deleteSession(id: string): Promise<{ ok: boolean }>
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
      objData(p: { connId: string; schema: string; table: string; page?: number; pageSize?: number; where?: string; orderBy?: string; orderDir?: string }): Promise<{ ok: boolean; columns?: string[]; rows?: any[][]; total?: number; ms?: number; error?: string }>
      objDescribe(connId: string, schema: string, table: string): Promise<{ ok: boolean; info?: { columns: { name: string; type: string; nullable: string }[]; approxRows?: number }; error?: string }>
      objDdl(connId: string, schema: string, table: string): Promise<{ ok: boolean; ddl?: string; error?: string }>
      listSkills(): Promise<{ id: string; name: string; description: string; enabled: boolean }[]>
      saveSkill(p: { id?: string; name: string; description: string; content: string }): Promise<{ ok: boolean }>
      deleteSkill(id: string): Promise<{ ok: boolean }>
      readSkillFull(id: string): Promise<{ ok: boolean; content: string; error?: string }>
      toggleSkill(id: string, enabled: boolean): Promise<{ ok: boolean }>
      importSkill(): Promise<{ ok: boolean; skill?: any; error?: string }>
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
