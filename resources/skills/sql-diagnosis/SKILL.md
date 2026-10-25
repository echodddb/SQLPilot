---
name: SQL 性能诊断
description: 慢 SQL 定因的固定套路——先拿执行计划与实际耗时，再判断是全表扫描、索引失效、统计信息过期还是等锁，最后给可验证的改法
---

# SQL 性能诊断

## 什么时候用
用户贴了一条慢 SQL、说「某个页面卡」「这个查询为什么慢」，或让你评估某条 SQL 会不会拖库。

## 诊断顺序（不要跳步）
1. **确认口径**：问清楚是「偶发慢」还是「一直慢」；偶发优先怀疑锁/统计信息/参数嗅探，一直慢优先怀疑执行计划与索引。
2. **拿执行计划**（必须实际执行，不要凭 SQL 猜）：
   - MySQL：`EXPLAIN` 看 `type` / `key` / `rows` / `Extra`；需要真实行数时用 `EXPLAIN ANALYZE`（8.0.18+）
   - Oracle：`EXPLAIN PLAN FOR <sql>` 后查 `DBMS_XPLAN.DISPLAY`，重点看 `TABLE ACCESS FULL`、`INDEX RANGE SCAN`、`cost`、`cardinality`
3. **对账**：把执行计划估算行数与 `SELECT COUNT(*)` 的实际量级比一比，差一个数量级以上 → 统计信息过期或谓词不可估算。
4. **定位热点**：MySQL 查 `performance_schema.events_statements_summary_by_digest` 看同类语句的平均耗时；Oracle 查 `v$sql`（按 `elapsed_time/executions` 排序），注意列要起别名。
5. **给结论**：一句话说清瓶颈是什么（类型 + 证据），再给 1–3 条改法，每条都要能验证。

## 常见病因对照
| 现象 | 大概率原因 | 验证方式 |
|---|---|---|
| `type=ALL` / Oracle 全表扫 | 缺索引、谓词对列做了函数运算、隐式类型转换 | 看 `key` 是否为空；检查 `WHERE` 两侧类型 |
| 走了索引但很慢 | 回表太多、选择性差 | 对比 `rows` 与返回行数；看是否覆盖索引可解 |
| 行数估算离谱 | 统计信息过期 | `ANALYZE TABLE` / `DBMS_STATS.GATHER_TABLE_STATS` 后重跑 |
| 偶发慢、计划没变 | 锁等待、IO 抖动 | MySQL `information_schema.innodb_trx` + `performance_schema.data_lock_waits`；Oracle `v$session.blocking_session` |
| 深分页慢 | `LIMIT` 偏移过大 | 改游标分页（`WHERE id > 上次最大 id`） |

## 输出格式
1. **结论**：瓶颈一句话（含证据，如「估算 12 行实际 180 万行」）
2. **证据**：贴执行计划关键行 / 统计信息，不要整段贴
3. **改法**：按收益排序，每条写清「改什么 + 预期收益 + 怎么验证」
4. 涉及 DDL 的（加索引、改列类型）**不要自己执行**，交变更评审流程

## 红线
- 不要在业务库上执行 `EXPLAIN ANALYZE` 跑全量写语句（会真的执行）。
- 不要建议直接 `FLUSH` / 重启 / 杀会话；先确认影响面，杀会话必须经用户确认。
- 给不出证据时直说「需要看执行计划」，不要编一个原因。
