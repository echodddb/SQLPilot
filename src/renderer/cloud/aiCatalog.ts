/**
 * AI 浮窗的「通用契约」：OCP 与 Oracle 两个助手共用同一套窗口组件，
 * 差异只在 store（会话状态 + IPC）与 catalog（文案 / 范围统计 / 示例问题）。
 */

import { AI_SECTIONS, coveredSections, MODULE_LABEL, scopeSummary, sectionLabel, SECTION_MODULE } from './aiSections'
import { activePlatform, cloud } from './state'

/** 浮窗最小尺寸：比默认 440×680 小一圈，再小对话就没法看了 */
export const AI_MIN_W = 340
export const AI_MIN_H = 300

export function clampSize(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), v))
}

export interface AiSessionLike {
  id: string
  title: string
  sections: string[]
  messageCount: number
  updatedAt: number
}

/**
 * 浮窗需要的会话状态与动作。
 * 两个 store 都是 reactive 对象，方法不依赖 this（内部闭包引用模块级状态），
 * 因此组件里可以安全地解构出来直接用在模板上。
 */
export interface AiWindowStore {
  open: boolean
  collapsed: boolean
  picking: boolean
  pickingEdit: boolean
  sections: string[]
  draft: string[]
  /** 本次对话启用的技能 id（正文由主进程拼进系统提示，不挂工具） */
  skills: string[]
  sessionId: string | null
  sessionMeta: { title?: string; contextAt?: number; contextChars?: number } | null
  messages: { id: string; role: 'user' | 'assistant'; text: string; at: number }[]
  history: AiSessionLike[]
  historyOpen: boolean
  historyLoading: boolean
  building: boolean
  streaming: boolean
  streamText: string
  reasoning: number
  error: string
  x: number | null
  y: number | null
  w: number | null
  h: number | null

  initAi(): void
  closeAi(): void
  newChat(): void
  openSession(id: string): Promise<void>
  removeSession(id: string): Promise<void>
  editScope(): void
  refreshData(): Promise<void>
  sendAi(text: string): Promise<void>
  stopAi(): void
  savePos(): void
  resetSize(): void
  loadHistory(): Promise<void>
}

/** 两个助手在文案与范围统计上的差异 */
export interface AiWindowCatalog {
  /** 顶栏标题（云管 AI / Oracle AI） */
  appName: string
  /** 顶栏 / 空态显示的平台名 */
  title(): string
  /** 「总览 2/4 · 告警 1/4」 */
  scopeSummary(sections: string[]): string
  /** 范围条上的 chip：{label, count, total} */
  scopeGroups(sections: string[]): { label: string; count: number; total: number }[]
  /** chip 的 tooltip：这个分组里具体勾了哪些 */
  groupNames(sections: string[], label: string): string
  /** 历史项 tooltip 的明细 */
  sectionNames(sections: string[]): string
  /** 空对话时的示例问题 */
  quickAsks(sections: string[]): string[]
  /** 「正在从 X 读取…」里的数据源称谓 */
  sourceName: string
  /** 输入框首问的占位提示（不同平台的问法不一样） */
  askPlaceholder: string

  // ---- 勾选态（页面上浮勾选框）需要的能力 ----
  /** 单个 key 的展示名（没有 data-ai-name 时兜底） */
  label(key: string): string
  /** 单个 key 的说明（胶囊 tooltip） */
  desc(key: string): string
  /** 勾选条上的范围摘要 */
  draftScopeText(draft: string[]): string
  /** 本页没画出块的子模块：用底部胶囊兜底 */
  missing(shown: string[]): { key: string; label: string; desc: string }[]
  /** 「全选本页」的候选（页面自己画了内联勾选框时用；OCP 靠浮动锚点，返回空） */
  pageKeys(): string[]
}

// ---------------------------------------------------------------- OCP（OceanBase 云平台）

export const OCP_AI_CATALOG: AiWindowCatalog = {
  appName: '云管 AI',
  title: () => activePlatform()?.name || '云管平台',
  scopeSummary: (sections) => scopeSummary(sections as CloudAiSectionKey[]),
  scopeGroups: (sections) => {
    const covered = new Set(coveredSections(sections as CloudAiSectionKey[]))
    return (Object.keys(MODULE_LABEL) as CloudAiModuleKey[])
      .map((m) => {
        const keys = AI_SECTIONS[m]
        return { label: MODULE_LABEL[m], count: keys.filter((k) => covered.has(k.key)).length, total: keys.length }
      })
      .filter((g) => g.count > 0)
  },
  groupNames: (sections, label) => {
    const key = (Object.keys(MODULE_LABEL) as CloudAiModuleKey[]).find((m) => MODULE_LABEL[m] === label)
    if (!key) return ''
    return sections
      .filter((k) => SECTION_MODULE(k as CloudAiSectionKey) === key)
      .map((k) => sectionLabel(k as CloudAiSectionKey))
      .join('、')
  },
  sectionNames: (sections) => sections.map((k) => sectionLabel(k as CloudAiSectionKey)).join('、'),
  quickAsks: (sections) => {
    const s = sections as CloudAiSectionKey[]
    const has = (k: string): boolean => s.some((x) => x === k || x.startsWith(`${k}:`))
    const list: string[] = []
    if (has('overview.kpi') || has('overview.clusters')) list.push('用一句话总结当前平台健康状况，并列出最该处理的 3 个问题')
    if (has('alarms.active') || has('alarms.trend') || has('alarms.levels')) list.push('有哪些严重/警告告警要马上处理？给出排查顺序')
    if (has('monitor.cluster') || has('clusters.capacity')) list.push('容量和 MemStore 水位有风险吗？给治理建议')
    if (has('tasks.list')) list.push('最近失败或卡住的任务是哪些？可能原因是什么')
    if (has('sqldiag.top')) list.push('TopSQL 里最耗 CPU 的语句该从哪下手优化？')
    if (!list.length) list.push('我勾选的这些数据里，最值得注意的是什么？')
    return list.slice(0, 3)
  },
  sourceName: 'OCP',
  askPlaceholder: '问点什么，如：现在集群健康吗？有什么风险？',
  label: (key) => sectionLabel(key as CloudAiSectionKey),
  desc: (key) => {
    const base = key.split(':')[0]
    return AI_SECTIONS[SECTION_MODULE(key as CloudAiSectionKey)]?.find((x) => x.key === base)?.desc || ''
  },
  draftScopeText: (draft) => {
    const covered = new Set(coveredSections(draft as CloudAiSectionKey[]))
    const groups: string[] = []
    for (const m of Object.keys(AI_SECTIONS) as CloudAiModuleKey[]) {
      const list = AI_SECTIONS[m]
      const hit = list.filter((x) => covered.has(x.key)).length
      if (!hit) continue
      groups.push(hit === list.length ? MODULE_LABEL[m] : `${MODULE_LABEL[m]} ${hit}/${list.length}`)
    }
    return groups.slice(0, 2).join(' · ') + (groups.length > 2 ? ` 等 ${groups.length} 个模块` : '')
  },
  missing: (shown) => {
    const v = cloud.view as string
    if (!v || v === 'settings' || !(v in AI_SECTIONS)) return []
    const covered = new Set(shown.map((k) => k.split(':')[0]))
    return AI_SECTIONS[v as CloudAiModuleKey]
      .filter((x) => !covered.has(x.key))
      .map((x) => ({ key: x.key, label: x.label, desc: x.desc }))
  },
  pageKeys: () => []
  // 说明：OCP 侧还有一个「切平台即重新开始」的行为，由 CloudAi.vue 的包装层处理（见 resetOnPlatformChange）
}

/** OCP 是否已接入平台（AI 按钮可用性） */
export function ocpAiReady(): boolean {
  return !!activePlatform() && !!cloud.platforms.length
}
