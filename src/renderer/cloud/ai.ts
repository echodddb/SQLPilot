/**
 * 云管 AI 助手状态（模块级 reactive store）。
 *
 * 与云管其它状态一样放模块级：切到别的一级模块再回来，浮窗里的对话与勾选都还在。
 * 真正的会话（历史对话）由主进程持久化在 userData/cloud-ai.json，这里只缓存当前打开的会话与流式文本。
 * 读取范围精确到「子模块」（CloudAiSectionKey），勾选面板按模块分组、可整组勾选。
 */

import { reactive } from 'vue'
import { activePlatform, cloud } from './state'
import { coveredSections, MODULE_LABEL, SCOPE_DEFAULT, sectionsOfModule } from './aiSections'

export const ai = reactive({
  /** 浮窗是否打开 */
  open: false,
  /** pick = 页面上勾选读取范围（不再弹浮窗）；chat = 对话 */
  mode: 'pick' as 'pick' | 'chat',
  /** 正在原有界面上勾选「AI 读取范围」：页面各子模块右上角出现勾选框 */
  picking: false,
  /** 这次勾选是「调整已有会话」而不是新建（决定按钮文案与取消后是否回对话） */
  pickingEdit: false,
  /** 当前会话的读取范围（子模块级） */
  sections: [...SCOPE_DEFAULT] as CloudAiSectionKey[],
  /** 勾选面板里的临时勾选（点「开始对话 / 应用」才写回 sections） */
  draft: [...SCOPE_DEFAULT] as CloudAiSectionKey[],
  /** 本次对话启用的技能（默认不勾；只影响这一个浮窗，不进会话记录） */
  skills: [] as string[],

  /** 当前会话（null = 还没开始，第一条消息时由主进程创建） */
  sessionId: null as string | null,
  sessionMeta: null as CloudAiSessionMeta | null,
  messages: [] as CloudAiMessage[],

  /** 历史会话列表（当前平台） */
  history: [] as CloudAiSessionMeta[],
  historyOpen: false,
  historyLoading: false,

  /** 主进程正在读取所选子模块的数据快照 */
  building: false,
  /** 正在生成回答 */
  streaming: false,
  /** 流式正文（单独存放，避免每帧重建消息列表） */
  streamText: '',
  /** 思考流累计字数（提示「思考中」，避免看起来卡住） */
  reasoning: 0,
  error: '',

  /** 浮窗位置：null 表示默认停在右下角 */
  x: null as number | null,
  y: null as number | null,
  /** 浮窗尺寸：null 表示用默认宽度 / 贴合窗口高度（设置「调整大小」后才有值） */
  w: null as number | null,
  h: null as number | null,
  /** 最小化到标题栏 */
  collapsed: false
})

const POS_KEY = 'sqlpilot.cloud.ai.pos'

let inited = false

/** 组件挂载时调一次：注册主进程的流式事件 */
export function initAi(): void {
  if (inited) return
  inited = true
  restorePos()
  window.sqlpilot.onCloudAiEvent(onEvent)
}

function restorePos(): void {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return
    const p = JSON.parse(raw) as { x: number; y: number; w?: number; h?: number }
    if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) {
      ai.x = Math.max(0, Math.min(window.innerWidth - 120, p.x))
      ai.y = Math.max(0, Math.min(window.innerHeight - 80, p.y))
    }
    // 尺寸只在「调整大小」过之后才有，且要在当前窗口内收一次，避免上次拖得过大
    if (Number.isFinite(p?.w)) ai.w = Math.round(clampSize(p.w as number, AI_MIN_W, window.innerWidth - 8))
    if (Number.isFinite(p?.h)) ai.h = Math.round(clampSize(p.h as number, AI_MIN_H, window.innerHeight - 8))
  } catch {
    /* 位置只是体验项，损坏就回默认 */
  }
}

/** 浮窗最小尺寸：比默认 440×680 小一圈，再小对话与勾选树就没法看了 */
export const AI_MIN_W = 340
export const AI_MIN_H = 300

export function clampSize(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), v))
}

export function savePos(): void {
  try {
    if (ai.x === null || ai.y === null) localStorage.removeItem(POS_KEY)
    else localStorage.setItem(POS_KEY, JSON.stringify({ x: ai.x, y: ai.y, w: ai.w, h: ai.h }))
  } catch {
    /* 忽略 */
  }
}

/** 恢复默认尺寸（双击标题栏 / 窗口变窄时兜底） */
export function resetSize(): void {
  ai.w = null
  ai.h = null
  savePos()
}

/** 浮窗可用：必须已接入 OCP 平台 */
export function aiReady(): boolean {
  return !!activePlatform() && !!cloud.platforms.length
}

export function openAi(): void {
  // 还没有会话：直接进入「在原有界面上勾选」的模式，勾完才进对话
  if (!ai.sessionId) {
    startPick(false)
    return
  }
  ai.open = true
  ai.collapsed = false
  ai.mode = 'chat'
  void loadHistory()
}

// ---------------------------------------------------------------- 在原有界面上勾选范围

/**
 * 进入勾选模式：不弹浮窗，改为在当前页面各子模块右上角显示勾选框（见 AiPickOverlay）。
 * 关闭浮窗是因为要在页面上点选，浮窗会挡住内容。
 */
export function startPick(edit = false): void {
  if (ai.streaming || ai.building) return
  ai.pickingEdit = edit
  ai.picking = true
  ai.open = false
  ai.historyOpen = false
  ai.collapsed = false
  ai.mode = 'pick'
  // 新建对话默认一个都不勾（SCOPE_DEFAULT 为空）；只有「调整已有会话」才带出它当前的范围
  ai.draft = edit ? ai.sections.slice() : [...SCOPE_DEFAULT]
  void loadHistory()
}

/** 取消勾选：编辑模式下回到原对话，新建模式下什么都不发生（历史对话不受影响） */
export function cancelPick(): void {
  if (!ai.picking) return
  // 编辑模式一律回浮窗：新对话在第一句话之前还没有 sessionId，但窗口要回来
  const back = ai.pickingEdit
  ai.picking = false
  ai.pickingEdit = false
  ai.draft = ai.sections.slice()
  ai.mode = 'chat'
  if (back) ai.open = true
}

/** 勾完开始对话（或应用新范围并重建快照） */
export async function finishPick(): Promise<void> {
  if (!ai.picking) return
  if (!ai.draft.length) return
  ai.picking = false
  ai.pickingEdit = false
  ai.open = true
  ai.collapsed = false
  ai.mode = 'chat'
  await applyDraft()
}

export function closeAi(): void {
  ai.open = false
  ai.historyOpen = false
}

export function toggleAi(): void {
  if (ai.picking) {
    cancelPick()
    return
  }
  if (ai.open) closeAi()
  else openAi()
}

// ---------------------------------------------------------------- 子模块勾选

export function toggleDraft(key: CloudAiSectionKey): void {
  ai.draft = ai.draft.includes(key) ? ai.draft.filter((k) => k !== key) : [...ai.draft, key]
}

export function clearDraft(): void {
  ai.draft = []
}

/** 当前（已生效）范围，按模块分组的摘要 */
export function scopeGroups(sections: CloudAiSectionKey[]): { label: string; count: number; total: number }[] {
  // 细分 key（如 overview.kpi:hosts）只算它所属的整块：范围条仍是「总览 3/4」这种口径
  const covered = new Set(coveredSections(sections))
  return (Object.keys(MODULE_LABEL) as CloudAiModuleKey[])
    .map((m) => {
      const keys = sectionsOfModule(m)
      const count = keys.filter((k) => covered.has(k)).length
      return { label: MODULE_LABEL[m], count, total: keys.length }
    })
    .filter((g) => g.count > 0)
}

// ---------------------------------------------------------------- 会话

/** 新建一段对话：回到页面勾选（历史对话不受影响） */
export function newChat(): void {
  ai.sessionId = null
  ai.sessionMeta = null
  ai.messages = []
  ai.streamText = ''
  ai.reasoning = 0
  ai.error = ''
  ai.streaming = false
  ai.building = false
  // 新对话不继承上一段的读取范围：勾选从零开始
  ai.sections = []
  ai.draft = []
  ai.historyOpen = false
  startPick(false)
}

/** 打开「调整范围」（已有会话时改子模块：保留对话，重建快照） */
export function editScope(): void {
  startPick(true)
}

/** 确认勾选：新会话 → 直接对话；已有会话 → 通知主进程重建快照 */
export async function applyDraft(): Promise<void> {
  // 没有勾任何项就不该走到这里（按钮是禁用的）；兜底成空，绝不偷偷塞一个默认范围
  const picked = [...ai.draft]
  if (!picked.length) return
  ai.error = ''
  if (ai.sessionId) {
    ai.sections = picked
    ai.mode = 'chat'
    ai.building = true
    const r = await window.sqlpilot.cloudAiSetSections(ai.sessionId, picked)
    ai.building = false
    if (!r.ok) {
      ai.error = r.error || '切换子模块失败'
      return
    }
    await reloadSession()
    await loadHistory()
    return
  }
  ai.sections = picked
  ai.mode = 'chat'
}

export async function loadHistory(): Promise<void> {
  const p = activePlatform()
  ai.historyLoading = true
  try {
    const list = await window.sqlpilot.cloudAiSessions(p?.id)
    ai.history = list || []
  } catch {
    ai.history = []
  } finally {
    ai.historyLoading = false
  }
}

export async function reloadSession(): Promise<void> {
  if (!ai.sessionId) return
  const s = await window.sqlpilot.cloudAiSession(ai.sessionId).catch(() => null)
  if (!s) return
  ai.sessionMeta = {
    id: s.id,
    title: s.title,
    platformId: s.platformId,
    platformName: s.platformName,
    sections: s.sections,
    modules: s.modules,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
    contextAt: s.contextAt,
    contextChars: s.contextChars
  }
  ai.messages = s.messages
  ai.sections = s.sections
  ai.draft = s.sections.slice()
}

export async function openSession(id: string): Promise<void> {
  if (ai.streaming) return
  const s = await window.sqlpilot.cloudAiSession(id).catch(() => null)
  if (!s) return
  // 从任意入口（浮窗历史 / 勾选态的历史）打开都落到同一个会话上
  ai.picking = false
  ai.pickingEdit = false
  ai.open = true
  ai.collapsed = false
  ai.sessionId = s.id
  ai.mode = 'chat'
  await reloadSession()
  ai.historyOpen = false
  ai.error = ''
  ai.streamText = ''
}

export async function removeSession(id: string): Promise<void> {
  await window.sqlpilot.cloudAiDelete(id).catch(() => null)
  if (ai.sessionId === id) newChat()
  await loadHistory()
}

/** 重建数据快照（不改对话框里的历史） */
export async function refreshData(): Promise<void> {
  if (!ai.sessionId || ai.streaming || ai.building) return
  ai.error = ''
  ai.building = true
  const r = await window.sqlpilot.cloudAiRefresh(ai.sessionId).catch((e: any) => ({ ok: false, error: e?.message || String(e) }))
  ai.building = false
  if (!r.ok) ai.error = r.error || '刷新数据失败'
  else await reloadSession()
}

export async function stopAi(): Promise<void> {
  if (!ai.sessionId) return
  await window.sqlpilot.cloudAiStop(ai.sessionId).catch(() => null)
}

// ---------------------------------------------------------------- 发送

export async function sendAi(text: string): Promise<void> {
  const t = text.trim()
  if (!t || ai.streaming || ai.building) return
  const p = activePlatform()
  if (!p) {
    ai.error = '还没有接入 OCP 平台'
    return
  }
  ai.error = ''
  ai.streamText = ''
  ai.reasoning = 0
  ai.mode = 'chat'
  // 先把用户消息落到界面（主进程 done 时会带回完整会话，届时以回读为准）
  ai.messages.push({ id: `local_${Date.now().toString(36)}`, role: 'user', text: t, at: Date.now() })
  ai.streaming = true
  let r: { ok: boolean; sessionId?: string; error?: string }
  try {
    // sections 必须传普通数组：reactive 的 Proxy 无法结构化克隆，IPC 会直接抛错
    r = await window.sqlpilot.cloudAiAsk({
      sessionId: ai.sessionId,
      platformId: p.id,
      platformName: p.name,
      sections: [...ai.sections],
      skills: [...ai.skills],
      text: t
    })
  } catch (e: any) {
    r = { ok: false, error: e?.message || String(e) }
  }
  if (!r.ok) {
    ai.streaming = false
    ai.messages.pop()
    ai.error = r.error || '发送失败'
    return
  }
  if (r.sessionId) ai.sessionId = r.sessionId
  void loadHistory()
}

// ---------------------------------------------------------------- 主进程事件

function onEvent(ev: CloudAiEvent): void {
  if (!ev || ev.sessionId !== ai.sessionId) return
  if (ev.type === 'building') {
    ai.building = true
    return
  }
  if (ev.type === 'context') {
    ai.building = false
    if (ai.sessionMeta) {
      ai.sessionMeta.contextAt = ev.contextAt
      ai.sessionMeta.contextChars = ev.contextChars
    }
    return
  }
  if (ev.type === 'start') {
    ai.building = false
    ai.streaming = true
    ai.streamText = ''
    ai.reasoning = 0
    return
  }
  if (ev.type === 'reasoning') {
    ai.reasoning = ev.chars
    return
  }
  if (ev.type === 'delta') {
    ai.streamText += ev.text
    return
  }
  if (ev.type === 'done') {
    ai.streaming = false
    ai.streamText = ''
    ai.reasoning = 0
    ai.messages.push(ev.message)
    ai.sessionMeta = ev.meta
    ai.sections = ev.meta.sections
    void loadHistory()
    return
  }
  // error：主进程可能已存下半截回答，回读一次让界面与磁盘一致
  ai.streaming = false
  ai.streamText = ''
  ai.reasoning = 0
  ai.error = ev.error
  void reloadSession()
  void loadHistory()
}

// 通用浮窗（AiChatWindow）通过 store 取动作：把这些函数挂到状态对象上，
// 组件里就能直接解构使用，OCP / Oracle 两个 store 的调用方式保持一致。
Object.assign(ai, {
  initAi,
  closeAi,
  newChat,
  openSession,
  removeSession,
  editScope,
  refreshData,
  sendAi,
  stopAi,
  savePos,
  resetSize,
  loadHistory
})
