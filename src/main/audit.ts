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

/** 单文件大小上限：超过则轮转一份 .1（再超覆盖旧 .1），避免只增不减 */
const MAX_AUDIT_BYTES = 4 * 1024 * 1024

function rotateIfNeeded(): void {
  try {
    const st = fs.statSync(auditPath())
    if (st.size < MAX_AUDIT_BYTES) return
    const bak = `${auditPath()}.1`
    try { fs.rmSync(bak, { force: true }) } catch { /* 忽略 */ }
    fs.renameSync(auditPath(), bak)
  } catch { /* 文件不存在或轮转失败都不阻断记录 */ }
}

export function appendAudit(e: AuditEntry): void {
  try {
    rotateIfNeeded()
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true })
    fs.appendFileSync(auditPath(), JSON.stringify({ ...e, ts: new Date().toISOString() }) + '\n', 'utf8')
  } catch {
    /* 审计失败不阻断主流程 */
  }
}

export function readAudit(max = 200): AuditEntry[] {
  const parse = (l: string): AuditEntry | null => {
    try {
      return JSON.parse(l) as AuditEntry
    } catch {
      return null
    }
  }
  try {
    let lines = fs.readFileSync(auditPath(), 'utf8').split('\n').filter(Boolean)
    // 当前文件行数不足时向轮转文件补齐（更早的记录在 .1 里）
    if (lines.length < max) {
      try {
        lines = fs.readFileSync(`${auditPath()}.1`, 'utf8').split('\n').filter(Boolean).concat(lines)
      } catch { /* 无轮转文件 */ }
    }
    return lines
      .slice(-max)
      .map(parse)
      .filter((x): x is AuditEntry => x !== null)
  } catch {
    return []
  }
}
