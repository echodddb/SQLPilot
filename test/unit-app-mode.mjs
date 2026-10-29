/**
 * 学习 / 工作模式（全局设置）单测：模式读写 + 进场时间缩放。
 *
 * 为什么值得测：模式决定「进场动画播多久、要不要自动进模块」，缩放系数算错就是
 * 要么白等好几秒、要么动画被切在半截。这里只测纯函数，不碰 UI。
 * 注意 Node 里没有 localStorage，模块内部的 try/catch 会退化成默认学习模式。
 *
 * 运行：node test/unit-app-mode.mjs
 */
import assert from 'node:assert/strict'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

const m = await import('../src/renderer/app-mode.ts')

// 默认（无 localStorage）：学习模式，原节奏、不自动跳
eq(m.appMode.value, 'learn', '默认学习模式')
eq(m.isWorkMode.value, false, 'isWorkMode 默认 false')
eq(m.introScale(2860), 1, '学习模式不缩放')
eq(m.autoAdvance(2860), false, '学习模式不自动跳')

// 工作模式：整段压到 WORK_INTRO_MS，且允许自动跳
m.setAppMode('work')
eq(m.appMode.value, 'work', '切到工作模式')
ok(m.isWorkMode.value, 'isWorkMode 跟随')
const k = m.introScale(2860)
ok(Math.abs(k - m.WORK_INTRO_MS / 2860) < 1e-9, `工作模式按 WORK_INTRO_MS 缩放（实得 ${k.toFixed(4)}）`)
ok(2860 * k <= m.WORK_INTRO_MS + 1, '缩放后总时长不超过 1.5s')
eq(m.autoAdvance(2860), true, '被压缩的序列到点自动进')
// 本来就比 1.5s 短的序列不放大，也不该多等
eq(m.introScale(600), 1, '短序列不放大')
eq(m.autoAdvance(600), false, '短序列不自动跳（本来就没等）')
// 边界：正好等于阈值的序列不算被压缩，保持原样、不自动跳
eq(m.introScale(m.WORK_INTRO_MS), 1, '正好等于 WORK_INTRO_MS 不缩放')
eq(m.autoAdvance(m.WORK_INTRO_MS), false, '正好等于 WORK_INTRO_MS 不自动跳')

// 切回学习模式
m.setAppMode('learn')
eq(m.introScale(2760), 1, '切回学习模式后恢复原节奏')
eq(m.autoAdvance(2760), false, '切回学习模式后不再自动跳')
m.toggleAppMode()
eq(m.appMode.value, 'work', 'toggleAppMode 学习→工作')
m.toggleAppMode()
eq(m.appMode.value, 'learn', 'toggleAppMode 工作→学习')

// ---------- 迁移与持久化 ----------
// 这是本模块唯一有分支的地方（新键命中 / 老键迁移 / 都没有），前面测的都是纯函数。
// Node 里没有 localStorage，先打桩再重新 import 一份，让 readMode() 真跑一遍。
const prevLS = globalThis.localStorage
const box = { 'sqlpilot.cloudMode': 'work' }
globalThis.localStorage = {
  getItem: (k) => (k in box ? box[k] : null),
  setItem: (k, v) => { box[k] = String(v) },
  removeItem: (k) => { delete box[k] }
}

const legacy = await import('../src/renderer/app-mode.ts?legacy')
eq(legacy.appMode.value, 'work', '老键 cloudMode=work 迁移为工作模式')
eq(box['sqlpilot.appMode'], 'work', '迁移时顺手写回新键，之后不必再依赖老键')

// 新键优先于老键：老键还留着 work，新键已经切回 learn
box['sqlpilot.appMode'] = 'learn'
const fresh = await import('../src/renderer/app-mode.ts?fresh')
eq(fresh.appMode.value, 'learn', '新键优先于老键')

fresh.setAppMode('work')
eq(box['sqlpilot.appMode'], 'work', 'setAppMode 写新键')
eq(box['sqlpilot.cloudMode'], 'work', 'setAppMode 同步写老键（回退旧版本也对得上）')

// 老键值非法（空串之类）不迁移，落回学习模式
delete box['sqlpilot.appMode']
box['sqlpilot.cloudMode'] = ''
const junk = await import('../src/renderer/app-mode.ts?junk')
eq(junk.appMode.value, 'learn', '老键值非法时落回学习模式')

globalThis.localStorage = prevLS

console.log(`\x1b[32m✓ unit-app-mode: ${passed} 个断言通过\x1b[0m`)
