/**
 * Oracle 云平台 · AI 助手（渲染层状态）
 *
 * 与 OCP 的 `ai.ts` 同构（同一套浮窗组件、同一套「页面上勾选」的交互），
 * 区别是读取范围 = 「环境 × 单元」：
 *   key = `ora:<环境 id>:<unit>`，unit 取 summary / overview / rac / … / users
 * 因此同一段对话可以同时读生产库的存储和备库的 Data Guard。
 *
 * 粒度对齐 OCP 侧：库详情里每一张卡片 / 每个 KPI 磁贴都能单独勾
 * （`ora:<env>:storage:fra`、`ora:<env>:overview:kpi.orKpiInst`），
 * 整块 key（`ora:<env>:storage`）表示这个 tab 全部，二者可以混用（整块优先）。
 * 默认一个都不勾；勾选入口在环境卡、库详情 tab 左边的方框、以及页面上的每张卡片。
 */

import { reactive } from 'vue'
import { cloud } from './state'
import { AI_MIN_H, AI_MIN_W, clampSize, type AiWindowCatalog } from './aiCatalog'
import { ora, ORA_DETAIL_TABS } from './oracle'

/** 可读取的单元：概要 + 14 个 tab（与主进程 ORA_AI_UNITS 一一对应） */
export const ORA_AI_UNITS: { key: string; label: string; desc: string }[] = [
  { key: 'summary', label: '环境概要', desc: '版本 / 角色 / 实例 / 会话 / 水位 / 阻塞 / 失效对象（每套环境 7 条 SQL）' },
  ...ORA_DETAIL_TABS.map((t) => ({ key: t.key as string, label: t.label, desc: t.desc }))
]

export const oraAiKey = (envId: string, unit: string): string => `ora:${envId}:${unit}`

/** 细分块 key：`ora:<envId>:<unit>:<part>`（part 形如 `fra` / `kpi.orKpiSess` / `sga.trade_db`） */
export const oraAiPartKey = (envId: string, unit: string, part: string): string =>
  part ? `ora:${envId}:${unit}:${part}` : oraAiKey(envId, unit)

/** `ora:<envId>:<unit>[:<part>]` → {envId, unit, part} */
export function parseOraAiKey(key: string): { envId: string; unit: string; part: string } | null {
  const m = /^ora:([^:]+):([a-z]+)(?::([A-Za-z0-9_.-]+))?$/.exec(String(key || ''))
  return m ? { envId: m[1], unit: m[2], part: m[3] || '' } : null
}

/** 拆细分块：`kpi.orKpiSess` → { base: 'kpi', arg: 'orKpiSess' } */
export function splitOraPart(part: string): { base: string; arg: string } {
  const i = String(part || '').indexOf('.')
  return i < 0 ? { base: String(part || ''), arg: '' } : { base: String(part).slice(0, i), arg: String(part).slice(i + 1) }
}

export function oraUnitLabel(unit: string): string {
  return oraAi.catalog.find((u) => u.unit === unit)?.label || ORA_AI_UNITS.find((u) => u.key === unit)?.label || unit
}

/** 细分块中文名：`storage` + `fra` → 「FRA 闪回区」；带参数时拼参数名 */
export function oraPartLabel(unit: string, part: string): string {
  const { base, arg } = splitOraPart(part)
  const def = oraAi.catalog.find((u) => u.unit === unit)?.parts.find((p) => p.key === base)
  const label = def?.label || base
  if (!arg) return label
  return `${label} · ${def?.args.find((a) => a.key === arg)?.label || arg}`
}

/** 细分块说明（勾选框悬停提示） */
export function oraPartDesc(unit: string, part: string): string {
  const { base } = splitOraPart(part)
  return oraAi.catalog.find((u) => u.unit === unit)?.parts.find((p) => p.key === base)?.desc || ''
}

/** 任意 key 的中文名：整块给「存储」，细分给「存储 · FRA 闪回区」 */
export function oraKeyLabel(key: string): string {
  const p = parseOraAiKey(key)
  if (!p) return key
  const unitLabel = oraUnitLabel(p.unit)
  return p.part ? `${unitLabel} · ${oraPartLabel(p.unit, p.part)}` : unitLabel
}

/**
 * 模板里挂 data-ai 用：当前打开的那套库（抽屉里）的某个细分块 key。
 * `oraPickKey('storage', 'fra')` → `ora:cl_xxx:storage:fra`
 */
export function oraPickKey(unit: string, part?: string): string {
  return part ? oraAiPartKey(ora.envId, unit, part) : oraAiKey(ora.envId, unit)
}

/** 某个单元有多少个可勾的细分块（范围摘要的分母） */
export function oraPartCount(unit: string): number {
  const n = oraAi.catalog.find((u) => u.unit === unit)?.parts.length
  return n || (unit === 'summary' ? 3 : 0) || 1
}

/** 环境名（快照 / 范围 chip 用） */
export function envName(envId: string): string {
  return cloud.platforms.find((p) => p.id === envId)?.name || envId
}

/** 新对话默认不勾选（用户自己挑要读哪套库的哪一块） */
export const ORA_SCOPE_DEFAULT: string[] = []

export const oraAi = reactive({
  open: false,
  collapsed: false,
  /** 正在页面上勾选读取范围 */
  picking: false,
  /** 勾选是为了调整已有会话（而不是新建） */
  pickingEdit: false,
  /** 当前会话生效的读取范围 */
  sections: [...ORA_SCOPE_DEFAULT] as string[],
  /** 本次对话启用的技能（默认不勾；正文由主进程拼进系统提示） */
  skills: [] as string[],
  /** 勾选中的临时范围 */
  draft: [...ORA_SCOPE_DEFAULT] as string[],
  sessionId: null as string | null,
  sessionMeta: null as { title?: string; contextAt?: number; contextChars?: number } | null,
  messages: [] as { id: string; role: 'user' | 'assistant'; text: string; at: number }[],
  history: [] as { id: string; title: string; sections: string[]; messageCount: number; updatedAt: number }[],
  historyOpen: false,
  historyLoading: false,
  building: false,
  streaming: false,
  streamText: '',
  reasoning: 0,
  error: '',
  /** 主进程给的目录（单元 + 细分块的中文名），勾选框与范围摘要都查它 */
  catalog: [] as CloudOraAiCatalogUnit[],
  x: null as number | null,
  y: null as number | null,
  w: null as number | null,
  h: null as number | null
})

const POS_KEY = 'sqlpilot.cloud.oraAi.pos'
let inited = false

export function initOraAi(): void {
  if (inited) return
  inited = true
  restorePos()
  window.sqlpilot.onCloudOraAiEvent(onEvent)
  void loadOraCatalog()
}

/** 目录只拉一次：勾选框名字、范围摘要、历史会话的范围都要用 */
export async function loadOraCatalog(): Promise<void> {
  if (oraAi.catalog.length) return
  try {
    oraAi.catalog = (await window.sqlpilot.cloudOraAiCatalog()) || []
  } catch {
    oraAi.catalog = []
  }
}

function restorePos(): void {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return
    const p = JSON.parse(raw) as { x: number; y: number; w?: number; h?: number }
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
      oraAi.x = Math.max(0, Math.min(window.innerWidth - 120, p.x))
      oraAi.y = Math.max(0, Math.min(window.innerHeight - 80, p.y))
    }
    if (Number.isFinite(p?.w)) oraAi.w = Math.round(clampSize(p.w as number, AI_MIN_W, window.innerWidth - 8))
    if (Number.isFinite(p?.h)) oraAi.h = Math.round(clampSize(p.h as number, AI_MIN_H, window.innerHeight - 8))
  } catch {
    /* 位置只是体验项 */
  }
}

export function saveOraAiPos(): void {
  try {
    if (oraAi.x === null || oraAi.y === null) localStorage.removeItem(POS_KEY)
    else localStorage.setItem(POS_KEY, JSON.stringify({ x: oraAi.x, y: oraAi.y, w: oraAi.w, h: oraAi.h }))
  } catch {
    /* 忽略 */
  }
}

export function resetOraAiSize(): void {
  oraAi.w = null
  oraAi.h = null
  saveOraAiPos()
}

/** 进入/切回助手：没有会话就先在页面上勾选 */
export function openOraAi(): void {
  if (!oraAi.sessionId) {
    startOraPick(false)
    return
  }
  oraAi.open = true
  oraAi.collapsed = false
  void loadOraHistory()
}

export function closeOraAi(): void {
  oraAi.open = false
  oraAi.historyOpen = false
}

export function toggleOraAi(): void {
  if (oraAi.picking) {
    cancelOraPick()
    return
  }
  if (oraAi.open) closeOraAi()
  else openOraAi()
}

// ---------------------------------------------------------------- 在页面上勾选

export function startOraPick(edit = false): void {
  if (oraAi.streaming || oraAi.building) return
  oraAi.pickingEdit = edit
  oraAi.picking = true
  oraAi.open = false
  oraAi.historyOpen = false
  oraAi.collapsed = false
  // 新建从零勾；调整已有会话时带出它当前的范围
  oraAi.draft = edit ? oraAi.sections.slice() : []
  void loadOraHistory()
}

export function cancelOraPick(): void {
  if (!oraAi.picking) return
  const back = oraAi.pickingEdit
  oraAi.picking = false
  oraAi.pickingEdit = false
  oraAi.draft = oraAi.sections.slice()
  if (back) oraAi.open = true
}

export async function finishOraPick(): Promise<void> {
  if (!oraAi.picking) return
  if (!oraAi.draft.length) return
  oraAi.picking = false
  oraAi.pickingEdit = false
  oraAi.open = true
  oraAi.collapsed = false
  await applyOraDraft()
}

export function toggleOraDraft(key: string): void {
  oraAi.draft = oraAi.draft.includes(key) ? oraAi.draft.filter((k) => k !== key) : [...oraAi.draft, key]
}

export function clearOraDraft(): void {
  oraAi.draft = []
}

/** 当前范围的摘要：`PRODDB 生产 3/15 · PRODDB_STANDBY 备库 1/15` */
interface ScopeUnit {
  unit: string
  covered: number
  total: number
  full: boolean
}

/** 把读取范围折成「环境 → 单元 → 覆盖了几个细分块」 */
function groupScope(sections: string[]): { id: string; units: ScopeUnit[] }[] {
  const byEnv = new Map<string, Map<string, { parts: Set<string>; full: boolean }>>()
  for (const key of sections) {
    const p = parseOraAiKey(key)
    if (!p) continue
    const units = byEnv.get(p.envId) || new Map<string, { parts: Set<string>; full: boolean }>()
    byEnv.set(p.envId, units)
    if (!p.part) {
      units.set(p.unit, { parts: new Set(), full: true })
      continue
    }
    const cur = units.get(p.unit)
    if (cur?.full) continue
    const rec = cur || { parts: new Set<string>(), full: false }
    rec.parts.add(splitOraPart(p.part).base)
    units.set(p.unit, rec)
  }
  return [...byEnv.entries()].map(([id, units]) => ({
    id,
    units: [...units.entries()].map(([unit, rec]) => {
      const total = oraPartCount(unit)
      const covered = rec.full ? total : rec.parts.size
      return { unit, covered, total, full: rec.full || covered >= total }
    })
  }))
}

/** 当前范围的摘要：`PRODDB 生产（实例 2/6、存储 1/8）` */
export function oraScopeText(sections: string[]): string {
  const groups = groupScope(sections)
  if (!groups.length) return '未选择'
  return groups
    .map((g) => {
      const list = g.units
        .slice(0, 3)
        .map((u) => (u.full ? oraUnitLabel(u.unit) : `${oraUnitLabel(u.unit)} ${u.covered}/${u.total}`))
      const more = g.units.length > 3 ? ` 等 ${g.units.length} 块` : ''
      return `${envName(g.id)}（${list.join('、')}${more}）`
    })
    .join(' · ')
}

/** 范围胶囊：每个环境一条，显示覆盖了多少个细分块 */
export function oraScopeGroups(sections: string[]): { label: string; count: number; total: number }[] {
  return groupScope(sections).map((g) => ({
    label: envName(g.id),
    count: g.units.reduce((a, u) => a + u.covered, 0),
    total: g.units.reduce((a, u) => a + u.total, 0)
  }))
}

/** 某个环境勾了哪些块（范围胶囊的悬停提示） */
export function oraGroupNames(sections: string[], label: string): string {
  return sections
    .filter((k) => {
      const p = parseOraAiKey(k)
      return p && envName(p.envId) === label
    })
    .map((k) => oraKeyLabel(k))
    .join('、')
}

export function oraSectionNames(sections: string[]): string {
  return sections.map((k) => (parseOraAiKey(k) ? `${envName(parseOraAiKey(k)!.envId)} · ${oraKeyLabel(k)}` : k)).join('、')
}

// ---------------------------------------------------------------- 会话

export function newOraChat(): void {
  oraAi.sessionId = null
  oraAi.sessionMeta = null
  oraAi.messages = []
  oraAi.streamText = ''
  oraAi.reasoning = 0
  oraAi.error = ''
  oraAi.streaming = false
  oraAi.building = false
  oraAi.sections = []
  oraAi.draft = []
  oraAi.historyOpen = false
  startOraPick(false)
}

export function editOraScope(): void {
  startOraPick(true)
}

async function applyOraDraft(): Promise<void> {
  const picked = [...oraAi.draft]
  if (!picked.length) return
  oraAi.error = ''
  if (oraAi.sessionId) {
    oraAi.sections = picked
    oraAi.building = true
    const r = await window.sqlpilot.cloudOraAiSetSections(oraAi.sessionId, picked)
    oraAi.building = false
    if (!r.ok) {
      oraAi.error = r.error || '切换读取范围失败'
      return
    }
    await reloadOraSession()
    await loadOraHistory()
    return
  }
  oraAi.sections = picked
}

export async function loadOraHistory(): Promise<void> {
  oraAi.historyLoading = true
  try {
    oraAi.history = (await window.sqlpilot.cloudOraAiSessions()) || []
  } catch {
    oraAi.history = []
  } finally {
    oraAi.historyLoading = false
  }
}

async function reloadOraSession(): Promise<void> {
  if (!oraAi.sessionId) return
  const s = await window.sqlpilot.cloudOraAiSession(oraAi.sessionId).catch(() => null)
  if (!s) return
  oraAi.sessionMeta = {
    title: s.title,
    contextAt: s.contextAt,
    contextChars: s.contextChars
  }
  oraAi.messages = s.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, at: m.at }))
  oraAi.sections = s.sections
  oraAi.draft = s.sections.slice()
}

export async function openOraSession(id: string): Promise<void> {
  if (oraAi.streaming) return
  const s = await window.sqlpilot.cloudOraAiSession(id).catch(() => null)
  if (!s) return
  oraAi.picking = false
  oraAi.pickingEdit = false
  oraAi.open = true
  oraAi.collapsed = false
  oraAi.sessionId = s.id
  await reloadOraSession()
  oraAi.historyOpen = false
  oraAi.error = ''
  oraAi.streamText = ''
}

export async function removeOraSession(id: string): Promise<void> {
  await window.sqlpilot.cloudOraAiDelete(id).catch(() => null)
  if (oraAi.sessionId === id) newOraChat()
  await loadOraHistory()
}

export async function refreshOraData(): Promise<void> {
  if (!oraAi.sessionId || oraAi.streaming || oraAi.building) return
  oraAi.error = ''
  oraAi.building = true
  const r = await window.sqlpilot.cloudOraAiRefresh(oraAi.sessionId).catch((e: any) => ({ ok: false, error: e?.message || String(e) }))
  oraAi.building = false
  if (!r.ok) oraAi.error = r.error || '刷新数据失败'
  else await reloadOraSession()
}

export async function stopOraAi(): Promise<void> {
  if (!oraAi.sessionId) return
  await window.sqlpilot.cloudOraAiStop(oraAi.sessionId).catch(() => null)
}

export async function sendOraAi(text: string): Promise<void> {
  const t = text.trim()
  if (!t || oraAi.streaming || oraAi.building) return
  if (!oraAi.sections.length) {
    oraAi.error = '还没有勾选要读取的数据：先在环境卡或库详情的 tab 上勾选'
    return
  }
  oraAi.error = ''
  oraAi.streamText = ''
  oraAi.reasoning = 0
  oraAi.messages.push({ id: `local_${Date.now().toString(36)}`, role: 'user', text: t, at: Date.now() })
  oraAi.streaming = true
  let r: { ok: boolean; sessionId?: string; error?: string }
  try {
    // 同 OCP：必须传普通数组，reactive Proxy 过不了 IPC 的结构化克隆
    r = await window.sqlpilot.cloudOraAiAsk({ sessionId: oraAi.sessionId, sections: [...oraAi.sections], skills: [...oraAi.skills], text: t })
  } catch (e: any) {
    r = { ok: false, error: e?.message || String(e) }
  }
  if (!r.ok) {
    oraAi.streaming = false
    oraAi.messages.pop()
    oraAi.error = r.error || '发送失败'
    return
  }
  if (r.sessionId) oraAi.sessionId = r.sessionId
  void loadOraHistory()
}

function onEvent(ev: CloudOraAiEvent): void {
  if (!ev || ev.sessionId !== oraAi.sessionId) return
  if (ev.type === 'building') {
    oraAi.building = true
    return
  }
  if (ev.type === 'context') {
    oraAi.building = false
    if (oraAi.sessionMeta) {
      oraAi.sessionMeta.contextAt = ev.contextAt
      oraAi.sessionMeta.contextChars = ev.contextChars
    }
    return
  }
  if (ev.type === 'start') {
    oraAi.building = false
    oraAi.streaming = true
    oraAi.streamText = ''
    oraAi.reasoning = 0
    return
  }
  if (ev.type === 'reasoning') {
    oraAi.reasoning = ev.chars
    return
  }
  if (ev.type === 'delta') {
    oraAi.streamText += ev.text
    return
  }
  if (ev.type === 'done') {
    oraAi.streaming = false
    oraAi.streamText = ''
    oraAi.reasoning = 0
    oraAi.messages.push(ev.message)
    oraAi.sessionMeta = ev.meta
    oraAi.sections = ev.meta.sections
    void loadOraHistory()
    return
  }
  oraAi.streaming = false
  oraAi.streamText = ''
  oraAi.reasoning = 0
  oraAi.error = ev.error
  void reloadOraSession()
  void loadOraHistory()
}

// ---------------------------------------------------------------- 浮窗文案

export const ORA_AI_CATALOG: AiWindowCatalog = {
  appName: 'Oracle AI',
  title: () => 'Oracle 云平台',
  scopeSummary: (sections) => oraScopeText(sections),
  scopeGroups: (sections) => oraScopeGroups(sections),
  groupNames: (sections, label) => oraGroupNames(sections, label),
  sectionNames: (sections) => oraSectionNames(sections),
  quickAsks: (sections) => {
    const units = new Set(sections.map((k) => parseOraAiKey(k)?.unit).filter(Boolean) as string[])
    const has = (u: string): boolean => units.has(u)
    const list: string[] = []
    if (has('overview') || has('summary') || has('storage')) list.push('这套库现在有哪些需要马上处理的风险？按优先级排')
    if (has('sessions')) list.push('阻塞链是怎么形成的？该杀掉哪个会话、怎么确认')
    if (has('sql')) list.push('TopSQL 里最该优化的几条，分别给改写/索引建议')
    if (has('backup') || has('dg')) list.push('备份与 Data Guard 是否满足恢复目标？有哪些缺口')
    if (has('alerts')) list.push('告警日志里反复出现的问题是什么？给根治方案')
    if (!list.length) list.push('我勾选的这些数据里，最值得注意的是什么？')
    return list.slice(0, 3)
  },
  sourceName: '数据库',
  askPlaceholder: '问点什么，如：这套库现在有什么风险？表空间够用吗？',
  label: (key) => {
    const p = parseOraAiKey(key)
    return p ? `${envName(p.envId)} · ${oraKeyLabel(key)}` : key
  },
  desc: (key) => {
    const p = parseOraAiKey(key)
    if (!p) return ''
    if (p.part) return oraPartDesc(p.unit, p.part)
    return oraAi.catalog.find((u) => u.unit === p.unit)?.desc || ORA_AI_UNITS.find((u) => u.key === p.unit)?.desc || ''
  },
  draftScopeText: (draft) => oraScopeText(draft),
  /**
   * 本页没画出块的细分项用底部胶囊兜底：
   * 有条件的卡片（告警页的 ORA- 错误、SQL 页的执行计划）没数据/没点开时不会上屏，
   * 但目录里存在，给个胶囊保证「想勾也能勾」。
   */
  missing: (shown) => {
    if (!ora.drawerOpen || !ora.envId) return []
    const unit = ora.drawerTab
    const def = oraAi.catalog.find((u) => u.unit === unit)
    if (!def) return []
    const seen = new Set<string>()
    for (const k of shown) {
      const p = parseOraAiKey(k)
      if (p && p.unit === unit && p.part) seen.add(splitOraPart(p.part).base)
    }
    return def.parts
      .filter((p) => !p.dynamicArgs && !seen.has(p.key))
      .map((p) => ({ key: oraAiPartKey(ora.envId as string, unit, p.key), label: p.label, desc: p.desc }))
  },
  // 「全选本页」：环境页 = 所有环境的概要；库详情 = 当前库的 14 个 tab
  // 「全选本页」：抽屉里 = 当前这个 tab 整块；环境页 = 所有环境的概要
  pageKeys: () => {
    if (ora.drawerOpen && ora.envId) return [oraAiKey(ora.envId, ora.drawerTab)]
    return ora.envs.map((e) => oraAiKey(e.id, 'summary'))
  }
}

// 与 OCP 的 store 对齐方法名，通用浮窗 / 勾选条才能用同一套调用
Object.assign(oraAi, {
  initAi: initOraAi,
  closeAi: closeOraAi,
  newChat: newOraChat,
  openSession: openOraSession,
  removeSession: removeOraSession,
  editScope: editOraScope,
  refreshData: refreshOraData,
  sendAi: sendOraAi,
  stopAi: stopOraAi,
  savePos: saveOraAiPos,
  resetSize: resetOraAiSize,
  loadHistory: loadOraHistory
})
