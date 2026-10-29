import { computed, ref } from 'vue'

/**
 * 学习 / 工作模式 —— 全局设置（不只云管平台）。
 *
 * 学习模式（默认）：界面是"可讲解的"，鼠标悬停元素会给出数据来源与查询路径，
 *   进出模块的动画完整播放，播完停住等你看清楚再点进入。
 * 工作模式：界面只用于干活——悬停讲解关闭，启动画面与各模块进场画面压到 1.5s，
 *   时间到自动进模块，不让人多点一次。
 *
 * 原来这套开关只活在云管平台里（localStorage: sqlpilot.cloudMode），
 * 现在提到全局后换键 sqlpilot.appMode，首次读取时把老键迁移过来，用户的选择不丢。
 */

export type AppMode = 'learn' | 'work'

/** 工作模式下所有进场序列的总时长（ms） */
export const WORK_INTRO_MS = 1500

const KEY = 'sqlpilot.appMode'
const LEGACY_KEY = 'sqlpilot.cloudMode'

function readMode(): AppMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'work' || v === 'learn') return v
    // 迁移：老版本只有云管的开关（值只可能是 learn / work）。
    // 读到就顺手写回新键，之后启动不用再走迁移；老键继续留着给回退到旧版本的情况。
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === 'work' || legacy === 'learn') {
      localStorage.setItem(KEY, legacy)
      return legacy
    }
  } catch { /* 读不到就当学习模式 */ }
  return 'learn'
}

export const appMode = ref<AppMode>(readMode())
export const isWorkMode = computed(() => appMode.value === 'work')

export function setAppMode(m: AppMode): void {
  appMode.value = m
  try {
    localStorage.setItem(KEY, m)
    // 老键一起写：万一回退到旧版本，云管那边的开关也对得上
    localStorage.setItem(LEGACY_KEY, m)
  } catch { /* 存不上就只当次会话生效 */ }
}

export function toggleAppMode(): void {
  setAppMode(appMode.value === 'work' ? 'learn' : 'work')
}

/**
 * 进场序列的时间缩放系数：学习模式 = 1（原节奏），工作模式压到 WORK_INTRO_MS 以内。
 * 各动画组件都用「原时点 × 系数」重排，免得每个组件各写一套缩短版时间表。
 */
export function introScale(fullMs: number): number {
  if (appMode.value !== 'work') return 1
  return fullMs > WORK_INTRO_MS ? WORK_INTRO_MS / fullMs : 1
}

/** 工作模式且这段动画被压缩了 → 到点自动进模块（学习模式仍停住等点击） */
export function autoAdvance(fullMs: number): boolean {
  return introScale(fullMs) < 1
}
