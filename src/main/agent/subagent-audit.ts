// 子代理运行审计与报告 artifact 的文件层（独立模块：tools 与 subagent 共用，避免循环依赖）
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** 单条审计记录里结果内容的截断长度 */
export const AUDIT_RESULT_HEAD = 2000

function runsDir(): string {
  return path.join(app.getPath('userData'), 'subagent-runs')
}

export function safeRunId(subId: string): string {
  const s = subId.replace(/[^A-Za-z0-9_-]/g, '_')
  return (s.length > 80 ? s.slice(0, 80) : s) || 'unknown'
}

function auditRunFile(subId: string): string {
  return path.join(runsDir(), `${safeRunId(subId)}.jsonl`)
}

/** 单个运行审计文件上限：超过后轮转为 .1（保留一代历史），防高频运行无限增长 */
const MAX_RUN_FILE_BYTES = 10 * 1024 * 1024

function rotateIfNeeded(file: string): void {
  try {
    const st = fs.statSync(file)
    if (st.size < MAX_RUN_FILE_BYTES) return
    try { fs.rmSync(file + '.1') } catch { /* 无旧档 */ }
    fs.renameSync(file, file + '.1')
  } catch { /* 文件不存在（首次写入）或其他失败：照常追加 */ }
}

/** 追加一行 JSONL 审计（失败静默——审计不能阻断任务） */
export function logRunLine(subId: string, entry: Record<string, any>): void {
  try {
    fs.mkdirSync(runsDir(), { recursive: true })
    const file = auditRunFile(subId)
    rotateIfNeeded(file)
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch { /* 磁盘满/权限问题不阻断子代理 */ }
}

/** 读取某次运行的审计记录（渲染层"查看完整过程"用；供人查看/单条检索，不整读回模型上下文） */
export function readRunAudit(subId: string, maxEntries = 500): { entries: any[]; file: string } {
  const file = auditRunFile(subId)
  let lines: string[] = []
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch { /* 无文件返回空 */ }
  const entries = lines.slice(-maxEntries).map((l) => {
    try { return JSON.parse(l) } catch { return { t: 'corrupt', raw: l.slice(0, 200) } }
  })
  return { entries, file }
}

/** 报告 artifact：写入项目 output/subagent-runs/<id>.md（DBA 巡检报告归档），返回项目内相对路径 */
export function writeReportArtifact(subId: string, project: { rootPath: string } | undefined, header: string, report: string): string | undefined {
  if (!project) return undefined
  try {
    const dir = path.join(project.rootPath, 'output', 'subagent-runs')
    fs.mkdirSync(dir, { recursive: true })
    const rel = `output/subagent-runs/${safeRunId(subId)}.md`
    fs.writeFileSync(path.join(project.rootPath, rel), `${header}\n\n---\n\n${report}\n`, 'utf8')
    return rel
  } catch {
    return undefined
  }
}
