// 任务操作规则单测：taskOps / subtaskOps / taskStatus 是「哪些按钮能点」的唯一依据，
// 规则照 OCP 4.3 前端常量表（FAILED→重试/回滚；RUNNING→放弃；子任务 FAILED→重试/跳过、RUNNING→终止）。
// 这些是纯函数，直接导入 renderer 模块，不需要 electron。
import assert from 'node:assert/strict'
import { taskOps, subtaskOps, taskStatus } from '../src/renderer/cloud/parts.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}

// ---------- 任务级 ----------
eq(taskOps('FAILED').map((o) => o.key), ['retry', 'rollback'], '失败任务：重试 + 回滚')
eq(taskOps('FAILED').map((o) => o.label), ['重试', '回滚'], '失败任务按钮文案')
eq(taskOps('FAILED').filter((o) => o.danger).map((o) => o.key), ['rollback'], '回滚标红（危险操作）')
eq(taskOps('RUNNING').map((o) => o.key), ['abort'], '执行中：只能放弃')
eq(taskOps('PENDING').map((o) => o.key), ['abort'], '等待中：只能放弃')
eq(taskOps('READY').map((o) => o.key), ['abort'], '准备执行：只能放弃')
eq(taskOps('SUCCESSFUL'), [], '已完成：无任务级操作（只有下载日志）')
eq(taskOps('ABORTED'), [], '已放弃：无任务级操作（OCP 常量表同款）')
eq(taskOps('FAILED')[0].danger, false, '重试不是危险操作')

// ---------- 子任务级 ----------
eq(subtaskOps('FAILED'), ['retry', 'skip'], '失败子任务：重试 + 跳过')
eq(subtaskOps('RUNNING'), ['cancel'], '运行中子任务：终止')
eq(subtaskOps('SUCCESSFUL'), [], '成功子任务：无（只给日志）')
eq(subtaskOps('PENDING'), [], '未开始的子任务：无')
eq(subtaskOps('DISREGARDED'), [], '已跳过的子任务：无')

// ---------- 状态文案 ----------
eq(taskStatus('ABORTED').label, '已放弃', 'ABORTED 显示「已放弃」')
eq(taskStatus('DISREGARDED').label, '已跳过', 'DISREGARDED 显示「已跳过」')
eq(taskStatus('READY').label, '准备执行', 'READY 显示「准备执行」')
eq(taskStatus('').label, '未知', '空状态不显示空白')
eq(taskStatus('WHATEVER').label, 'WHATEVER', '未知状态原样透出，便于排查')

console.log(`task-ops 单测：${passed} 组断言全部通过`)
