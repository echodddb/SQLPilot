/**
 * 传输队列进度计算单测（纯函数，无 Vue 依赖）。
 *
 * 为什么必须测：之前"上传队列里有一条一直 0%"的根因是两个同名字段互相覆盖
 * （文件数 vs 文件字节数都叫 total）。这类错误 tsc 查不出来，只能靠断言把
 * "进度必须单调递增、结束必须 100%"钉死。
 *
 * 运行：node test/unit-transfer.mjs
 */
import assert from 'node:assert/strict'
import { applyProgress, transferPercent, runningCount } from '../src/renderer/server/transfer.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

// ---------- 单文件：0 → 50% → 99% → 100% ----------
{
  const list = []
  const t0 = applyProgress(list, { jobId: 'j1', kind: 'upload', phase: 'start', index: 0, fileCount: 1, name: 'a.log' })
  eq(list.length, 1, '首次事件建条')
  eq(t0.kind, 'upload', 'kind 来自事件')
  eq(t0.fileCount, 1, '文件数取自 fileCount')
  eq(transferPercent(t0), 0, '起点 0%')

  applyProgress(list, { jobId: 'j1', phase: 'progress', index: 0, fileCount: 1, name: 'a.log', transferred: 50, total: 100 })
  eq(transferPercent(list[0]), 50, '传到一半 → 50%')

  applyProgress(list, { jobId: 'j1', phase: 'progress', index: 0, fileCount: 1, name: 'a.log', transferred: 100, total: 100 })
  eq(transferPercent(list[0]), 99, '未收到 done 前封顶 99%（避免"100% 但没结束"的错觉）')

  applyProgress(list, { jobId: 'j1', phase: 'done', files: 1, bytes: 100 })
  eq(transferPercent(list[0]), 100, 'done → 100%')
  eq(list[0].status, 'done', '状态 done')
  eq(list[0].fileSize, 100, 'done 后 fileSize 保留（进度条不会回退计算）')
}

// ---------- 多文件：跨文件进度必须单调不减 ----------
{
  const list = []
  const pct = []
  applyProgress(list, { jobId: 'j2', kind: 'upload', phase: 'start', index: 0, fileCount: 3, name: 'a' })
  pct.push(transferPercent(list[0]))
  applyProgress(list, { jobId: 'j2', phase: 'progress', index: 0, fileCount: 3, name: 'a', transferred: 500, total: 1000 })
  pct.push(transferPercent(list[0]))
  applyProgress(list, { jobId: 'j2', phase: 'start', index: 1, fileCount: 3, name: 'b' })
  eq(list[0].transferred, 0, '换文件时单文件进度归零')
  eq(list[0].fileSize, 0, '换文件时单文件大小归零（等新事件回填）')
  pct.push(transferPercent(list[0]))
  applyProgress(list, { jobId: 'j2', phase: 'progress', index: 1, fileCount: 3, name: 'b', transferred: 800, total: 800 })
  pct.push(transferPercent(list[0]))
  applyProgress(list, { jobId: 'j2', phase: 'start', index: 2, fileCount: 3, name: 'c' })
  pct.push(transferPercent(list[0]))
  applyProgress(list, { jobId: 'j2', phase: 'done', files: 3, bytes: 3000 })
  pct.push(transferPercent(list[0]))

  ok(pct.every((v, i) => i === 0 || v >= pct[i - 1]), `进度不倒退：${pct.join(' → ')}`)
  eq(pct[pct.length - 1], 100, '多文件结束 100%')
  eq(list[0].fileCount, 3, '文件数全程保持 3（不会被 total 覆盖）')
}

// ---------- 队列清空后靠 kind 重建 ----------
{
  const list = []
  const t = applyProgress(list, { jobId: 'j3', kind: 'download', phase: 'progress', index: 0, fileCount: 1, name: 'x', transferred: 1, total: 10 })
  eq(t.kind, 'download', '无 start 事件时按 kind 归类为下载')
  eq(transferPercent(t), 10, '缺 start 也能算出进度')
}

// ---------- 异常与取消 ----------
{
  const list = []
  applyProgress(list, { jobId: 'j4', kind: 'upload', phase: 'start', index: 0, fileCount: 1, name: 'e' })
  const err = applyProgress(list, { jobId: 'j4', phase: 'error', error: 'Permission denied' })
  eq(err.status, 'error', 'error 状态')
  eq(err.error, 'Permission denied', '错误信息保留')

  const list2 = []
  applyProgress(list2, { jobId: 'j5', kind: 'upload', phase: 'start', index: 0, fileCount: 2, name: 'c' })
  const canceled = applyProgress(list2, { jobId: 'j5', phase: 'canceled' })
  eq(canceled.status, 'canceled', 'canceled 状态')
  eq(runningCount(list2), 0, '取消后不算进行中')
}

// ---------- 缺字段兜底 ----------
{
  const list = []
  const t = applyProgress(list, { jobId: 'j6', phase: 'progress', transferred: 5 })
  eq(t.fileCount, 1, '缺 fileCount 兜底 1（不会出现除零）')
  eq(t.fileSize, 0, '缺 total 时 fileSize 为 0')
  ok(transferPercent(t) >= 0 && transferPercent(t) <= 99, '缺字段时进度仍在 0-99')
  ok(Number.isFinite(transferPercent(t)), '不会算出 NaN')
}

// ---------- 进行中计数 ----------
{
  const list = []
  applyProgress(list, { jobId: 'a', phase: 'start', index: 0, fileCount: 1 })
  applyProgress(list, { jobId: 'b', phase: 'start', index: 0, fileCount: 1 })
  eq(runningCount(list), 2, '两条进行中')
  applyProgress(list, { jobId: 'a', phase: 'done' })
  eq(runningCount(list), 1, '完成后剩一条')
}

// ---------- 队列上限：完成态条目不能无限堆积 ----------
{
  const big = []
  for (let i = 0; i < 80; i++) {
    applyProgress(big, { jobId: 'j' + i, phase: 'start', index: i, total: 1 })
    applyProgress(big, { jobId: 'j' + i, phase: 'done' })
  }
  ok(big.length <= 61, `已完成条目应被淘汰（实际 ${big.length}）`)
  applyProgress(big, { jobId: 'newest', phase: 'start', index: 0, total: 1 })
  ok(big.some((t) => t.id === 'newest'), '新任务仍然入队')
  ok(big.length <= 61, `新任务入队后仍受上限约束（实际 ${big.length}）`)
}

console.log(`\x1b[32m✓ unit-transfer: ${passed} 个断言通过\x1b[0m`)
