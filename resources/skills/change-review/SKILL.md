---
name: 变更评审
description: DDL/DML 上线前的风险检查清单——锁表时长、执行窗口、回滚方案、主从延迟、影响行数，按「能不能现在做」给结论
---

# 变更评审

## 什么时候用
用户要执行 `ALTER TABLE`、加索引、批量 `UPDATE/DELETE`、改字段类型，或问「这个变更能不能直接上」。

## 必答的六项（缺一项就不能给「可以执行」）
1. **对象规模**：表多少行、多大（`information_schema.tables` 的 `table_rows`/`data_length`，Oracle 用 `dba_tables.num_rows` + `dba_segments.bytes`）。`table_rows` 是估算值，要说明。
2. **锁与阻塞**：DDL 会拿什么锁、要多久。MySQL 8 加索引默认 `ALGORITHM=INPLACE`（可并发 DML），但改列类型、改字符集是 `COPY`，会长时间锁写；Oracle 加带默认值的列在 11g 会更新全表。
3. **执行窗口**：预计耗时 > 5 分钟或会锁写 → 必须走低峰窗口，给出建议时间。
4. **影响行数**：批量 DML 先 `SELECT COUNT(*)` 同条件，报出确切数量；不报数量的批量更新一律拦回。
5. **回滚方案**：DDL 能否回滚（多数不能）；DML 是否已备份受影响行。没有回滚方案时明确写「不可回滚，需先备份」。
6. **后续影响**：主从延迟、统计信息是否需要重收集、应用端是否需要同步改。

## 常见变更的安全做法
- **加索引**：MySQL 8 用 `ALTER TABLE ... ADD INDEX ..., ALGORITHM=INPLACE, LOCK=NONE`；Oracle 用 `ONLINE` 关键字。大表建议先在低峰期建，或用在线变更工具。
- **加列**：只加可空列，不带 `DEFAULT`（MySQL 8.0.12+ 加默认值走 INSTANT，但仍要确认版本）。Oracle 11g 加 `DEFAULT` 非空列会重写全表。
- **改列类型/长度**：MySQL `VARCHAR` 加长在部分版本可 INPLACE，缩短一定 COPY；跨类型（`INT`→`BIGINT`）必须 COPY。提前评估磁盘余量。
- **批量 DML**：分批（每批 1000–5000 行）+ 每批提交，避免大事务撑爆 undo/redo。Oracle 还要注意 undo 表空间。
- **删索引**：先确认没人在用（MySQL `performance_schema.table_io_waits_summary_by_index_usage`；Oracle `v$object_usage` 需要先 `ALTER INDEX ... MONITORING USAGE`）。

## 输出格式
```
结论：可以执行 / 建议低峰执行 / 不建议执行
对象：<schema.table>（约 N 行，X MB）
锁与耗时：<锁类型>，预计 <时长>
回滚：<有/无，怎么做>
执行前必做：<备份、确认、通知>
SQL：
<可直接执行的语句>
```
最后一定附一句「执行前请确认窗口与备份」——写操作走 SQLPilot 的审批流程，不要代替用户点确认。

## 红线
- 不主动执行任何 `DROP` / `TRUNCATE` / 无 `WHERE` 的 `UPDATE|DELETE`。
- 不给出「先删了再看」这类不可回滚的建议。
- 表在 1 亿行以上且变更需要 COPY 时，直接说明在线工具（gh-ost / pt-osc / OGG）的必要性，不要硬上。
