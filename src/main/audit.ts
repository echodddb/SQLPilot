import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface AuditEntry {
  /** 写入时自动填充 */
  ts?: string
  kind: 'sql.read' | 'sql.write' | 'tool' | 'llm.error' | 'conn' | 'ui.error'
  conn?: string
  detail: string
  mode?: string
  approved?: boolean
  error?: string
}

export function auditPath(): string {
  return path.join(app.getPath('userData'), 'audit.log')
}

export function appendAudit(e: AuditEntry): void {
  try {
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true })
    fs.appendFileSync(auditPath(), JSON.stringify({ ...e, ts: new Date().toISOString() }) + '\n', 'utf8')
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

export function readAudit(max = 200): AuditEntry[] {
  try {
    const lines = fs.readFileSync(auditPath(), 'utf8').trim().split('\n').filter(Boolean)
    return lines
      .slice(-max)
      .map((l) => {
        try {
          return JSON.parse(l) as AuditEntry
        } catch {
          return null
        }
      })
      .filter((x): x is AuditEntry => x !== null)
  } catch {
    return []
  }
}
