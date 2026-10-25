---
name: 数据库巡检
description: 一次巡检出可交付报告——容量、连接、慢查询、锁、备份、复制延迟逐项取数，按「有问题的排前面」输出
---

# 数据库巡检

## 什么时候用
用户说「巡检一下」「出个体检报告」「这套库有没有隐患」。

## 取数清单（逐项实际查询，查不到就写「该版本无此视图/无权限」，不要编）
1. **实例概况**：版本、启动时长、字符集、时区。MySQL `SELECT VERSION(), @@character_set_server, @@time_zone`；Oracle `SELECT banner FROM v$version` + `v$instance`。
2. **容量**：库/表 TOP 10 大小。MySQL 用 `information_schema.tables` 聚合 `data_length+index_length`；Oracle 用 `dba_segments` 按 `segment_name` 聚合。
3. **连接数**：当前连接 / 上限 / 使用率。MySQL `SHOW STATUS LIKE 'Threads_connected'` 与 `max_connections`；Oracle `v$resource_limit` 里 `processes`/`sessions`。
4. **慢查询 TOP**：MySQL `performance_schema.events_statements_summary_by_digest`（按 `SUM_TIMER_WAIT` 排序，耗时单位是皮秒）；Oracle `v$sql` 按 `elapsed_time/executions`。
5. **锁与长事务**：MySQL `information_schema.innodb_trx`（`trx_started` 超过 60s 的列出来）；Oracle `v$transaction` + `v$session`。
6. **复制/主从**：MySQL `SHOW SLAVE STATUS`（8.0.22+ 用 `SHOW REPLICA STATUS`）看 `Seconds_Behind_Master`；Oracle 看 `v$dataguard_stats`。
7. **备份**：最近一次全备时间与大小（MySQL 看备份目录/xtrabackup 记录；Oracle 查 `v$rman_backup_job_details`）。

## 判定阈值（可作为默认，用户有规范时以用户为准）
| 项 | 关注 | 严重 |
|---|---|---|
| 连接使用率 | > 70% | > 85% |
| 表空间/磁盘剩余 | < 20% | < 10% |
| 主从延迟 | > 10s | > 60s |
| 长事务 | > 60s | > 600s |
| 全备间隔 | > 2 天 | > 7 天 |

## 输出格式（固定结构，便于横向对比多次巡检）
```
# 巡检报告 · <实例> · <时间>
## 结论（先看这里）
- 🔴 严重：…（1–3 条）
- 🟡 关注：…（1–5 条）
- 🟢 正常：容量、连接、备份…

## 明细
| 项 | 实测 | 阈值 | 判定 |
（每行都要有实测值，没有取到的写「未取到 + 原因」）

## 建议动作
1. …（按优先级，写清做什么、影响面、是否需要停机）
```
结论里只放真正需要动作的项；「正常」项一行带过。

## 红线
- 巡检是只读操作，不要执行 `KILL`、`FLUSH`、`ANALYZE` 等有副作用的语句。
- 取不到数据（无权限/版本不支持）要如实说明，不要用「一般」「通常」填空。
- 涉及具体主机/实例名时用用户的原始名称，不要自己编。
