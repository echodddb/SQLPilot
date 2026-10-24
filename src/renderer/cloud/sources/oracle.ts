/**
 * Oracle 云平台的「采集来源」目录。
 *
 * 与 OCP 那套最大的区别：这里不是调平台接口，而是**直连数据库**查 v$ / dba_ 视图。
 * 所以链路是「环境（主机:端口/服务名）→ 数据库实例 → SYS → 视图」，
 * sql 全是 SQLPilot 里实际执行的那条（已在 Oracle 11.2.0.4 上逐条跑通）。
 */
import type { SourceInfo } from './types'

/** 查询位置的三段固定描述：环境名由元素上的 data-cluster 动态带出 */
const DB = '数据库实例'
const USER = 'SYS'

/**
 * 卡片级（单个指标）来源：查询位置固定是「环境 → 数据库实例 → SYS → 视图」，
 * 只有视图清单、采集范围、SQL 不同，所以统一用这个工厂，避免每条都重复写四段路径。
 */
function m(title: string, table: string, scope: string, sql: string, note = ''): SourceInfo {
  return {
    title,
    api: `直连数据库：node-oracledb → SELECT ${table}`,
    scope,
    origin: { tenant: DB, db: USER, table },
    sql,
    note
  }
}

// 多条来源共用的 SQL（与 sections.ts 里实际执行的那条一致）
const Q_TS_WATER = `SELECT t.tablespace_name name, t.contents, t.status, t.bigfile, t.logging,
       NVL(d.total_mb,0) size_mb, NVL(f.free_mb,0) free_mb,
       CASE WHEN NVL(d.total_mb,0) > 0
            THEN ROUND((d.total_mb - NVL(f.free_mb,0)) * 100 / d.total_mb, 2) ELSE 0 END used_pct,
       NVL(a.max_mb,0) max_mb, NVL(d.files,0) files, NVL(d.autoext,0) autoext
  FROM dba_tablespaces t
  LEFT JOIN (SELECT tablespace_name, ROUND(SUM(bytes)/1048576,2) total_mb, COUNT(*) files,
                    SUM(CASE WHEN autoextensible = 'YES' THEN 1 ELSE 0 END) autoext
               FROM dba_data_files GROUP BY tablespace_name) d ON d.tablespace_name = t.tablespace_name
  LEFT JOIN (SELECT tablespace_name, ROUND(SUM(bytes)/1048576,2) free_mb
               FROM dba_free_space GROUP BY tablespace_name) f ON f.tablespace_name = t.tablespace_name
  LEFT JOIN (SELECT tablespace_name, ROUND(SUM(maxbytes)/1048576,2) max_mb
               FROM dba_data_files GROUP BY tablespace_name) a ON a.tablespace_name = t.tablespace_name
 ORDER BY used_pct DESC;`

const Q_SESS_BY_INST = `SELECT inst_id, status, COUNT(*) c
  FROM gv$session WHERE type = 'USER'
 GROUP BY inst_id, status;`

const Q_SGA = `SELECT name, ROUND(bytes/1048576, 2) mb FROM v$sgainfo WHERE bytes > 0;`

export const OR_SOURCES: Record<string, SourceInfo> = {
  // ---------------------------------------------------------------- 环境级
  orEnv: {
    title: 'Oracle 环境概要',
    api: '直连数据库：node-oracledb（thin / thick）→ SELECT v$database、gv$instance …',
    scope: '每个环境一条连接；列表页每套环境只查 7 条 SQL',
    origin: { tenant: DB, db: USER, table: 'V$DATABASE / GV$INSTANCE' },
    sql: `-- 在一个会话里一次取回库身份与版本
SELECT (SELECT banner FROM v$version WHERE rownum = 1) ver,
       name, db_unique_name, database_role, open_mode, log_mode
  FROM v$database;
-- 实例数与首末启动时间（RAC 各节点启动时间可能不同）
SELECT inst_id, status,
       TO_CHAR(MIN(startup_time) OVER (), 'YYYY-MM-DD HH24:MI') first_start,
       TO_CHAR(MAX(startup_time) OVER (), 'YYYY-MM-DD HH24:MI') last_start
  FROM gv$instance;`,
    note: '环境 = 一条平台配置（主机 / 端口 / 服务名 + 账号）。状态「连接失败」通常是监听未起（ORA-12541）或账号被锁，错误原文会显示在卡片上'
  },
  orFleetKpi: {
    title: '全局面板 KPI',
    api: '汇总各环境的概要（不再额外查库）',
    scope: '当前所有 Oracle 环境',
    origin: { tenant: DB, db: USER, table: 'GV$SESSION / GV$LOCK / DBA_OBJECTS', cluster: '各环境（逐个查询）' },
    sql: `-- 会话（按实例、状态）
SELECT inst_id, status, COUNT(*) c FROM gv$session WHERE type = 'USER' GROUP BY inst_id, status;
-- 阻塞会话数
SELECT COUNT(*) FROM gv$lock WHERE block IN (1,2);
-- 失效对象数
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';`,
    note: '环境总数与「可连」按每个环境的探测结果统计；会话/阻塞/失效对象都是各环境概要的合计值'
  },
  orFleetIssues: {
    title: '待处理问题',
    api: '本地规则推导（连接状态 + 概要里的阻塞/水位/失效对象）',
    scope: '跨全部环境，按严重度排序',
    origin: { tenant: DB, db: USER, table: 'V$INSTANCE / GV$LOCK / DBA_DATA_FILES', cluster: '各环境（逐个查询）' },
    sql: `-- 库是否可写
SELECT open_mode FROM v$database;
-- 阻塞会话
SELECT inst_id, sid, event, blocking_session FROM gv$session WHERE blocking_session IS NOT NULL;
-- 最高水位表空间
SELECT tablespace_name, ROUND(used_percent, 2) pct
  FROM dba_tablespace_usage_metrics ORDER BY used_percent DESC;`,
    note: '规则：不可写/连接失败/有阻塞/水位≥90% 记 high，≥85% 与失效对象记 warn，长操作记 info。点任意一条会直接跳到该库对应 tab'
  },
  orFleetCap: {
    title: '表空间水位榜',
    api: '各环境概要里的最高水位表空间',
    scope: '每套环境取水位最高的一个表空间',
    origin: { tenant: DB, db: USER, table: 'DBA_DATA_FILES / DBA_FREE_SPACE', cluster: '各环境（逐个查询）' },
    sql: `SELECT t.tablespace_name,
       ROUND(SUM(d.bytes)/1048576, 2) size_mb,
       ROUND((SUM(d.bytes) - NVL(SUM(f.bytes),0))/1048576, 2) used_mb,
       ROUND((SUM(d.bytes) - NVL(SUM(f.bytes),0)) * 100 / SUM(d.bytes), 2) used_pct
  FROM dba_tablespaces t
  JOIN dba_data_files d ON d.tablespace_name = t.tablespace_name
  LEFT JOIN dba_free_space f ON f.tablespace_name = t.tablespace_name
 WHERE t.contents <> 'TEMPORARY'
 GROUP BY t.tablespace_name ORDER BY used_pct DESC;`,
    note: '水位 ≥90% 红色：再涨就会 ORA-01653/01654；建议先看 DBA_DATA_FILES 是否已开 autoextend，再决定扩数据文件还是加空间'
  },
  orFleetLoad: {
    title: '会话与阻塞',
    api: '各环境概要里的会话统计',
    scope: '全部环境，按用户会话数排序',
    origin: { tenant: DB, db: USER, table: 'GV$SESSION', cluster: '各环境（逐个查询）' },
    sql: `SELECT inst_id, status, COUNT(*) c FROM gv$session WHERE type = 'USER' GROUP BY inst_id, status;
-- 阻塞链（谁挡住了谁）
SELECT l.inst_id, l.sid, l.type, l.lmode, l.request, l.ctime,
       b.sid blocker_sid, b.username blocker_user, b.sql_id blocker_sql,
       s.username, s.event
  FROM gv$lock l
  JOIN gv$session s ON s.sid = l.sid AND s.inst_id = l.inst_id
  LEFT JOIN gv$session b ON b.sid = l.id1 AND b.inst_id = l.inst_id
 WHERE l.block IN (1,2) AND l.type IN ('TX','TM');`,
    note: '条形长度 = 用户会话数（各环境间相对比较），右侧依次是「会话 / 活跃」；有阻塞时带 ⚠ 与条数'
  },
  orFleetTable: {
    title: '环境对比表',
    api: '各环境概要汇总',
    scope: '一行一套环境，按最高水位排序',
    origin: { tenant: DB, db: USER, table: 'V$DATABASE / GV$INSTANCE / DBA_TABLESPACE_USAGE_METRICS', cluster: '各环境（逐个查询）' },
    sql: `SELECT name, db_unique_name, database_role, open_mode FROM v$database;
-- 表空间水位（11g 可用 dba_tablespace_usage_metrics 一次算完）
SELECT tablespace_name, used_percent FROM dba_tablespace_usage_metrics ORDER BY used_percent DESC;`,
    note: '点任意一行进入该库详情；连不上的环境用占位符 — 表示没取到，不是 0'
  },

  // ---------------------------------------------------------------- 库详情
  orDbMeta: {
    title: '库身份与连接方式',
    api: '直连数据库（连接串：主机:端口/服务名）',
    scope: '当前打开详情的这套环境',
    origin: { tenant: DB, db: USER, table: 'V$DATABASE / V$INSTANCE / V$VERSION' },
    sql: `SELECT (SELECT banner FROM v$version WHERE rownum = 1) ver,
       name, db_unique_name, database_role, open_mode, protection_mode,
       log_mode, force_logging, flashback_on, platform_name,
       TO_CHAR(created,'YYYY-MM-DD') created
  FROM v$database;
SELECT instance_name, host_name, status, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time
  FROM gv$instance ORDER BY inst_id;`,
    note: '连接身份为 SYSDBA 时当前用户是 SYS（Oracle 语义）；看板只读视图，普通 DBA 账号即可'
  },
  orOverview: {
    title: '总览',
    api: '直连数据库：库身份 + 会话 + 表空间 + 等待 + sysmetric + 告警条数',
    scope: '当前库（所有实例合计）',
    origin: { tenant: DB, db: USER, table: 'V$DATABASE / GV$SESSION / DBA_DATA_FILES / V$SYSMETRIC' },
    sql: `-- 会话
SELECT inst_id, status, COUNT(*) c FROM gv$session WHERE type = 'USER' GROUP BY inst_id, status;
-- 累计非空闲等待 TOP
SELECT * FROM (SELECT event, wait_class, ROUND(time_waited_micro/1000000, 2) time_s
                 FROM v$system_event WHERE wait_class <> 'Idle'
                ORDER BY time_waited_micro DESC) WHERE rownum <= 8;
-- 实时指标（60 秒）
SELECT metric_name, value, metric_unit FROM v$sysmetric
 WHERE group_id = 2 AND metric_name IN ('User Transaction Per Sec','Database CPU Time Ratio');`,
    note: 'KPI 与「需要关注」由本页数据本地推导；告警条数取 v$diag_alert_ext 近 12 小时'
  },
  orRac: {
    title: 'RAC 集群',
    api: '直连数据库：gv$instance / gv$active_services / gv$cluster_interconnects',
    scope: '当前库的所有实例（单实例也会返回 1 行）',
    origin: { tenant: DB, db: USER, table: 'GV$INSTANCE / GV$ACTIVE_SERVICES / GV$CLUSTER_INTERCONNECTS' },
    sql: `SELECT value FROM v$parameter WHERE name = 'cluster_database';   -- RAC 判定
SELECT inst_id, instance_name, host_name, status, instance_role,
       active_state, database_status, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time
  FROM gv$instance ORDER BY inst_id;
SELECT inst_id, service_id, name, network_name FROM gv$active_services ORDER BY inst_id, name;
SELECT inst_id, name, ip_address, is_public, source FROM gv$cluster_interconnects;`,
    note: 'cluster_database=FALSE 且只有 1 个实例时页面会明确提示「不是 RAC」；11g 没有 v$cluster 视图，判定只看参数与 gv$instance'
  },
  orInstances: {
    title: '实例明细',
    api: '直连数据库：gv$instance / v$sgainfo / v$pgastat / v$osstat / v$resource_limit',
    scope: '当前库的每个实例',
    origin: { tenant: DB, db: USER, table: 'GV$INSTANCE / V$SGAINFO / V$PGASTAT / V$OSSTAT' },
    sql: `SELECT name, ROUND(bytes/1048576, 2) mb FROM v$sgainfo WHERE bytes > 0;
SELECT name, ROUND(value/1048576, 2) mb FROM v$pgastat
 WHERE name IN ('aggregate PGA target parameter','total PGA allocated','total PGA inuse');
SELECT stat_name, value FROM v$osstat WHERE stat_name IN ('NUM_CPUS','PHYSICAL_MEMORY_BYTES','LOAD');
SELECT resource_name, current_utilization, limit_value FROM v$resource_limit;`,
    note: '缓冲池 miss% = physical_reads / (db_block_gets + consistent_gets)；资源使用率 ≥90% 标红，等于逼近 processes/sessions 上限'
  },
  orPdb: {
    title: '容器与 PDB',
    api: '直连数据库：v$pdbs / v$containers / v$datafile（12c+）',
    scope: '当前 CDB 的全部容器',
    origin: { tenant: DB, db: USER, table: 'V$PDBS / V$CONTAINERS' },
    sql: `SELECT con_id, name, open_mode, restricted, TO_CHAR(open_time,'YYYY-MM-DD HH24:MI') open_time
  FROM v$pdbs ORDER BY con_id;
SELECT con_id, con_type FROM v$containers;
SELECT con_id, COUNT(*) files, ROUND(SUM(bytes)/1048576, 2) mb FROM v$datafile GROUP BY con_id;`,
    note: '11g 及更早没有多租户，v$pdbs 不存在 → 页面显示「当前实例不是 CDB」而不是报错（这条探测本身就是版本判断）'
  },
  orStorage: {
    title: '存储',
    api: '直连数据库：dba_tablespaces / dba_data_files / dba_free_space / v$asm_diskgroup / v$recovery_file_dest',
    scope: '当前库的表空间、数据文件、ASM、FRA、归档与在线日志',
    origin: { tenant: DB, db: USER, table: 'DBA_TABLESPACES / DBA_DATA_FILES / DBA_FREE_SPACE' },
    sql: `SELECT t.tablespace_name, t.contents, t.status, t.bigfile, t.logging,
       NVL(d.total_mb,0) size_mb, NVL(f.free_mb,0) free_mb,
       CASE WHEN NVL(d.total_mb,0) > 0
            THEN ROUND((d.total_mb - NVL(f.free_mb,0)) * 100 / d.total_mb, 2) ELSE 0 END used_pct,
       NVL(a.max_mb,0) max_mb, NVL(d.files,0) files, NVL(d.autoext,0) autoext
  FROM dba_tablespaces t
  LEFT JOIN (SELECT tablespace_name, ROUND(SUM(bytes)/1048576,2) total_mb, COUNT(*) files,
                    SUM(CASE WHEN autoextensible = 'YES' THEN 1 ELSE 0 END) autoext
               FROM dba_data_files GROUP BY tablespace_name) d ON d.tablespace_name = t.tablespace_name
  LEFT JOIN (SELECT tablespace_name, ROUND(SUM(bytes)/1048576,2) free_mb
               FROM dba_free_space GROUP BY tablespace_name) f ON f.tablespace_name = t.tablespace_name
  LEFT JOIN (SELECT tablespace_name, ROUND(SUM(maxbytes)/1048576,2) max_mb
               FROM dba_data_files GROUP BY tablespace_name) a ON a.tablespace_name = t.tablespace_name
 ORDER BY used_pct DESC;`,
    note: '「上限 32G」是未设 maxbytes 的 smallfile 默认值；ASM 为空说明不是 ASM 存储或没权限读 v$asm_diskgroup'
  },
  orSessions: {
    title: '会话与锁',
    api: '直连数据库：gv$session / gv$lock / gv$session_longops',
    scope: '当前库全部实例的用户会话（最多 300 行）',
    origin: { tenant: DB, db: USER, table: 'GV$SESSION / GV$LOCK / GV$SESSION_LONGOPS' },
    sql: `SELECT s.inst_id, s.sid, s.serial# serial_no, s.username, s.status, s.machine, s.program,
       s.sql_id, s.event, s.wait_class, s.seconds_in_wait, s.blocking_session, s.last_call_et, p.spid
  FROM gv$session s
  LEFT JOIN gv$process p ON p.addr = s.paddr AND p.inst_id = s.inst_id
 WHERE s.type = 'USER' AND s.username IS NOT NULL
 ORDER BY CASE WHEN s.status = 'ACTIVE' THEN 0 ELSE 1 END, s.last_call_et DESC;
-- 长操作
SELECT inst_id, sid, opname, target, ROUND(sofar*100/DECODE(totalwork,0,1,totalwork),1) pct,
       time_remaining, elapsed_seconds, sql_id
  FROM gv$session_longops WHERE time_remaining > 0;`,
    note: '阻塞链里 BLOCKER_SID 是持锁者，拿着它的 SQL_ID 去「SQL 诊断」查执行计划；杀会话需 ALTER SYSTEM KILL SESSION（看板只读，不提供该动作）'
  },
  orSql: {
    title: 'SQL 诊断',
    api: '直连数据库：gv$sql / gv$sqltext / gv$sql_plan + dba_hist_sqlstat（AWR）',
    scope: '共享池 TopSQL 40 条 + 最近 12 个 AWR 快照',
    origin: { tenant: DB, db: USER, table: 'GV$SQL / GV$SQLTEXT / GV$SQL_PLAN' },
    sql: `SELECT * FROM (
  SELECT sql_id, plan_hash_value, executions,
         ROUND(elapsed_time/1000000, 2) elapsed_s, ROUND(cpu_time/1000000, 2) cpu_s,
         ROUND(elapsed_time / DECODE(executions,0,1,executions) / 1000, 2) avg_ms,
         buffer_gets, disk_reads, rows_processed, parsing_schema_name, module
    FROM gv$sql WHERE executions > 0
   ORDER BY elapsed_time DESC) WHERE rownum <= 40;
-- 单条 SQL 的全文与执行计划
SELECT piece, sql_text FROM gv$sqltext WHERE sql_id = :id ORDER BY piece;
SELECT id, depth, operation, options, object_name, cost, cardinality
  FROM gv$sql_plan WHERE sql_id = :id ORDER BY id;`,
    note: 'AWR 两张 dba_hist_* 需要 Diagnostics Pack 授权；游标被刷出共享池后取不到全文与计划，属正常现象'
  },
  orPerf: {
    title: '性能与等待',
    api: '直连数据库：v$sysmetric / v$system_event / v$active_session_history / v$sgainfo',
    scope: '当前库（60 秒指标 + 实例启动以来累计等待 + 近 1 小时 ASH）',
    origin: { tenant: DB, db: USER, table: 'V$SYSMETRIC / V$SYSTEM_EVENT / V$ACTIVE_SESSION_HISTORY' },
    sql: `SELECT metric_name, value, metric_unit FROM v$sysmetric
 WHERE group_id = 2 AND metric_name IN ('User Transaction Per Sec','Database CPU Time Ratio',
       'Physical Reads Per Sec','Average Active Sessions');
SELECT event, wait_class, total_waits, ROUND(time_waited_micro/1000000, 2) time_s
  FROM v$system_event WHERE wait_class <> 'Idle' ORDER BY time_waited_micro DESC;
SELECT sql_id, event, session_state, COUNT(*) samples
  FROM v$active_session_history WHERE sample_time > SYSDATE - 1/24
 GROUP BY sql_id, event, session_state ORDER BY 4 DESC;`,
    note: 'v$system_event 是实例启动以来的累计值，看的是「谁最耗时」而不是当前；要看当下用 ASH 或 v$session_wait'
  },
  orAlerts: {
    title: '告警日志',
    api: '直连数据库：v$diag_alert_ext（ADR 里的 alert log）',
    scope: '按窗口（1h/24h/3d/7d）统计，明细最多 200 条',
    origin: { tenant: DB, db: USER, table: 'V$DIAG_ALERT_EXT' },
    sql: `-- 条数
SELECT COUNT(*) FROM v$diag_alert_ext WHERE originating_timestamp > SYSTIMESTAMP - 24/24;
-- 按「去掉数字后的模板」聚类：日志一天几万条时先看聚类
SELECT * FROM (
  SELECT REGEXP_REPLACE(SUBSTR(message_text, 1, 120), '[0-9]+', '#') pat,
         COUNT(*) c,
         TO_CHAR(MIN(originating_timestamp),'MM-DD HH24:MI') first_ts,
         TO_CHAR(MAX(originating_timestamp),'MM-DD HH24:MI') last_ts
    FROM v$diag_alert_ext WHERE originating_timestamp > SYSTIMESTAMP - 24/24
   GROUP BY REGEXP_REPLACE(SUBSTR(message_text, 1, 120), '[0-9]+', '#')
   ORDER BY 2 DESC) WHERE rownum <= 25;
-- ORA- 错误
SELECT * FROM (SELECT TO_CHAR(originating_timestamp,'MM-DD HH24:MI:SS') ts, SUBSTR(message_text,1,300) msg
                 FROM v$diag_alert_ext WHERE message_text LIKE '%ORA-%'
                ORDER BY originating_timestamp DESC) WHERE rownum <= 100;`,
    note: '连接失败（TNS/ORA-12541）之类的消息会刷满日志，所以先聚类再列明细；要读更早的日志请直接看 ADR 目录下的 alert_*.log'
  },
  orBackup: {
    title: '备份恢复',
    api: '直连数据库：v$rman_backup_job_details / v$backup_set / v$archived_log / v$recovery_file_dest',
    scope: '最近 40 次 RMAN 作业与 30 个备份集',
    origin: { tenant: DB, db: USER, table: 'V$RMAN_BACKUP_JOB_DETAILS / V$BACKUP_SET' },
    sql: `SELECT * FROM (
  SELECT session_key, command_id, status, input_type, output_device_type,
         TO_CHAR(start_time,'MM-DD HH24:MI') st, elapsed_seconds,
         ROUND(output_bytes/1073741824, 2) output_gb
    FROM v$rman_backup_job_details ORDER BY start_time DESC) WHERE rownum <= 40;
SELECT * FROM (
  SELECT recid, backup_type, incremental_level,
         TO_CHAR(completion_time,'MM-DD HH24:MI') done,
         ROUND(block_size * blocks/1073741824, 2) gb, pieces
    FROM v$backup_set ORDER BY completion_time DESC) WHERE rownum <= 30;`,
    note: '只读：不提供发起/停止备份。看板不判断 RPO，只把「最近一次全库备份的时间与状态」摆出来，是否达标按你们的策略判断'
  },
  orDg: {
    title: 'Data Guard',
    api: '直连数据库：v$dataguard_stats / v$archive_dest_status / v$managed_standby',
    scope: '当前库的归档目标与 MRP 进程',
    origin: { tenant: DB, db: USER, table: 'V$DATAGUARD_STATS / V$ARCHIVE_DEST_STATUS' },
    sql: `SELECT name, value, unit, time_computed FROM v$dataguard_stats;
SELECT dest_id, status, type, database_mode, recovery_mode, protection_mode,
       destination, error, db_unique_name, synchronization_status, synchronized, gap_status,
       archived_seq# archived_seq, applied_seq# applied_seq
  FROM v$archive_dest_status WHERE dest_id <= 10 ORDER BY dest_id;
SELECT process, status, thread# thr, sequence# seq, block# blk FROM v$managed_standby;`,
    note: 'v$dataguard_stats 为空常见于「备库没连上」或「本库是主库且未配置 DG」；ARCHIVED_SEQ 与 APPLIED_SEQ 的差值就是日志积压量'
  },
  orJobs: {
    title: '作业调度',
    api: '直连数据库：dba_scheduler_jobs / dba_scheduler_job_run_details / dba_jobs',
    scope: '全部 Scheduler 作业 + DBMS_JOB + 最近 80 条运行记录',
    origin: { tenant: DB, db: USER, table: 'DBA_SCHEDULER_JOBS / DBA_SCHEDULER_JOB_RUN_DETAILS' },
    sql: `SELECT owner, job_name, enabled, state, run_count, failure_count,
       TO_CHAR(last_start_date,'MM-DD HH24:MI') last_start,
       TO_CHAR(next_run_date,'MM-DD HH24:MI') next_run
  FROM dba_scheduler_jobs ORDER BY owner, job_name;
SELECT * FROM (
  SELECT owner, job_name, status, TO_CHAR(actual_start_date,'MM-DD HH24:MI') st,
         ROUND(run_duration) dur_s, SUBSTR(additional_info,1,200) info
    FROM dba_scheduler_job_run_details ORDER BY actual_start_date DESC) WHERE rownum <= 80;
SELECT job, log_user, broken, failures, TO_CHAR(next_date,'MM-DD HH24:MI') next_date
  FROM dba_jobs ORDER BY job;`,
    note: 'DBMS_JOB 的 WHAT 是作业体（PL/SQL 块），Scheduler 的失败详情在 additional_info 里；BROKEN=Y 表示连续失败被自动禁用'
  },
  orParams: {
    title: '参数',
    api: '直连数据库：v$parameter',
    scope: '非默认参数（isdefault=FALSE）+ 18 个关键参数',
    origin: { tenant: DB, db: USER, table: 'V$PARAMETER' },
    sql: `SELECT name, value, isdefault, issys_modifiable, SUBSTR(description, 1, 160) descr
  FROM v$parameter WHERE isdefault = 'FALSE' ORDER BY name;
SELECT name, value, isdefault, issys_modifiable FROM v$parameter
 WHERE name IN ('sga_target','pga_aggregate_target','processes','sessions','db_block_size',
                'optimizer_mode','compatible','cursor_sharing','open_cursors','undo_retention');`,
    note: 'ISSYS_MODIFIABLE：IMMEDIATE 可在线改，DEFERRED 新会话生效，FALSE 必须重启实例；范围参数（带 .序号）在 v$parameter 里只显示一级'
  },
  orUsers: {
    title: '用户与对象',
    api: '直连数据库：dba_users / v$pwfile_users / dba_objects / dba_segments',
    scope: '全部账号、特权账号、当前用户角色、失效对象、最大 25 个段',
    origin: { tenant: DB, db: USER, table: 'DBA_USERS / V$PWFILE_USERS / DBA_OBJECTS' },
    sql: `SELECT username, account_status, TO_CHAR(expiry_date,'YYYY-MM-DD') expiry,
       default_tablespace, temporary_tablespace, profile, authentication_type
  FROM dba_users ORDER BY username;
SELECT username, sysdba, sysoper, admin FROM v$pwfile_users;   -- 谁真的有 SYSDBA
SELECT owner, object_type, COUNT(*) c FROM dba_objects WHERE status = 'INVALID' GROUP BY owner, object_type;
SELECT * FROM (SELECT owner, segment_name, segment_type, tablespace_name,
                      ROUND(bytes/1048576, 2) mb FROM dba_segments
                ORDER BY bytes DESC) WHERE rownum <= 25;`,
    note: '「最大段 TOP」会对 dba_segments 做全表扫描（大库较慢），只在打开这个 tab 时才查；DBA 角色不等于 SYSDBA，后者只看 v$pwfile_users'
  },

  // ================================================================ 卡片 / 指标级
  // 悬浮到某个磁贴、某张卡片时只看「这一个指标」查的是什么，不再把整个 tab 的数据一起列出来。
  // 仍复用上面的 tab 级条目描述整页（悬停抽屉的 tab 标签时用）。

  // ---------------------------------------------------------------- 总览 KPI（每个磁贴一条）
  orKpiInst: m('实例数量', 'GV$INSTANCE', '当前库的所有实例（RAC 每节点一行）',
    `SELECT inst_id, instance_name, host_name, status, instance_role, active_state
  FROM gv$instance ORDER BY inst_id;`,
    'RAC 下每个节点一行；任何一行 STATUS 不是 OPEN，就说明有节点没起来'),
  orKpiDb: m('库状态', 'V$DATABASE', '当前库',
    `SELECT name, database_role, open_mode, log_mode, protection_mode
  FROM v$database;`,
    'OPEN_MODE 不是 READ WRITE 时业务写入会失败；主备看 DATABASE_ROLE'),
  orKpiSess: m('用户会话', 'GV$SESSION', 'type = USER 的会话，所有实例合计',
    Q_SESS_BY_INST,
    'ACTIVE 表示正在跑，INACTIVE 是连着但空闲（连接池常见）；两个数都要看'),
  orKpiTps: m('每秒事务', 'V$SYSMETRIC', '最近 60 秒的指标快照',
    `SELECT value, metric_unit FROM v$sysmetric
 WHERE group_id = 2 AND metric_name = 'User Transaction Per Sec';`,
    '60 秒一档的采样值，不是从实例启动累计的计数'),
  orKpiCpu: m('DB CPU 占比', 'V$SYSMETRIC', '最近 60 秒的指标快照',
    `SELECT value, metric_unit FROM v$sysmetric
 WHERE group_id = 2 AND metric_name = 'Database CPU Time Ratio';`,
    'DB CPU / DB Time：长期接近 100% 说明 CPU 成为瓶颈，等待占比自然就低'),
  orKpiBlock: m('阻塞会话', 'GV$LOCK / GV$SESSION', '所有实例，BLOCK in (1,2)',
    `SELECT COUNT(*) FROM gv$lock WHERE block IN (1,2);
-- 具体是谁挡住谁
SELECT l.inst_id, l.sid, b.sid blocker_sid, b.sql_id blocker_sql, s.username, s.event
  FROM gv$lock l
  JOIN gv$session s ON s.sid = l.sid AND s.inst_id = l.inst_id
  LEFT JOIN gv$session b ON b.sid = l.id1 AND b.inst_id = l.inst_id
 WHERE l.block IN (1,2) AND l.type IN ('TX','TM');`,
    'BLOCK=2 的在等锁，BLOCK=1 的是持锁者（源头）；到「会话与锁」看阻塞链'),
  orKpiTs: m('表空间告警', 'DBA_TABLESPACES / DBA_DATA_FILES / DBA_FREE_SPACE', '永久表空间（不含 TEMPORARY）',
    Q_TS_WATER,
    '≥85% 记 warn、≥90% 记 bad；FREE 还有但表空间仍满，多半是碎片而不是真的没空间'),
  orKpiInvalid: m('失效对象', 'DBA_OBJECTS', '全库 status = INVALID',
    `SELECT owner, object_type, COUNT(*) c
  FROM dba_objects WHERE status = 'INVALID'
 GROUP BY owner, object_type ORDER BY 3 DESC;`,
    '多为依赖对象变更导致，重编译即可；长期 INVALID 的包要查根源而不是反复编译'),

  // ---------------------------------------------------------------- 总览卡片
  orOvIssues: m('需要关注（规则推导）', 'V$DATABASE / GV$SESSION / DBA_DATA_FILES / V$ARCHIVE_DEST_STATUS', '本页已取到的实时数据，不再额外查库',
    `-- 规则输入：库是否可写、阻塞数、表空间水位、失效对象、长操作、归档目标错误
SELECT open_mode FROM v$database;
SELECT COUNT(*) FROM gv$lock WHERE block IN (1,2);
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';
SELECT COUNT(*) FROM gv$session_longops WHERE time_remaining > 0;
SELECT dest_id, status, error FROM v$archive_dest_status WHERE dest_id <= 2;`,
    '不依赖任何平台告警服务：规则写在渲染层，改判定阈值不用动 SQL'),
  orOvInfo: m('数据库身份', 'V$DATABASE / V$VERSION / V$PARAMETER', '当前库（单行）',
    `SELECT (SELECT banner FROM v$version WHERE rownum = 1) ver,
       name, db_unique_name, database_role, open_mode, protection_mode,
       log_mode, flashback_on, force_logging, platform_name, TO_CHAR(created,'YYYY-MM-DD') created
  FROM v$database;
SELECT value FROM v$parameter WHERE name = 'cluster_database';`,
    '「拓扑」由 cluster_database 与 gv$instance 行数共同判定；CDB 与否用 v$pdbs 探一下'),
  orOvInstSess: m('实例会话分布', 'GV$SESSION', '每实例的用户会话 / 活跃数',
    Q_SESS_BY_INST,
    '条形长度按最大实例归一化，只用于实例之间横向比较'),
  orOvTs: m('表空间水位（卡片）', 'DBA_TABLESPACES / DBA_DATA_FILES / DBA_FREE_SPACE', '永久表空间，按水位倒序取前 10',
    Q_TS_WATER,
    'MAX MB 为自动扩展上限，32G 是未设 maxbytes 的 smallfile 默认值'),
  orOvWait: m('累计等待 TOP', 'V$SYSTEM_EVENT', '实例启动以来累计，非空闲等待前 8 类',
    `SELECT * FROM (
  SELECT event, wait_class, ROUND(time_waited_micro/1000000, 2) time_s
    FROM v$system_event WHERE wait_class <> 'Idle'
   ORDER BY time_waited_micro DESC) WHERE rownum <= 8;`,
    '累计值：反映「历史上谁最耗时」，不代表此刻在等什么（当下看 ASH / v$session_wait）'),
  orOvAlertHour: m('近 12 小时告警条目', 'V$DIAG_ALERT_EXT', '按小时分桶，ORIGINATING_TIMESTAMP > SYSTIMESTAMP - 12/24',
    `SELECT TO_CHAR(originating_timestamp,'MM-DD HH24') hr, COUNT(*) c
  FROM v$diag_alert_ext
 WHERE originating_timestamp > SYSTIMESTAMP - 12/24
 GROUP BY TO_CHAR(originating_timestamp,'MM-DD HH24') ORDER BY 1;`,
    '连接失败、服务注册之类的消息会刷屏，柱状只给趋势；要点开「告警日志」看聚类'),
  orOvMetrics: m('实时指标（总览）', 'V$SYSMETRIC', 'group_id = 2（60 秒档）的 10 个关键指标',
    `SELECT metric_name name, value, metric_unit unit
  FROM v$sysmetric WHERE group_id = 2 AND metric_name IN (
    'User Transaction Per Sec','Executions Per Sec','Session Count','Active Session Count',
    'Database CPU Time Ratio','Database Wait Time Ratio','Physical Reads Per Sec','Redo Generated Per Sec',
    'Logical Reads Per Sec','Host CPU Utilization (%)');`,
    '指标名是 Oracle 固定的字符串，不同版本会略有增减，取不到就只是少一行'),

  // ---------------------------------------------------------------- RAC
  orRacCfg: m('集群配置', 'V$PARAMETER / V$ACTIVE_INSTANCES', '当前库的 RAC 相关参数与活跃实例',
    `SELECT name, value FROM v$parameter
 WHERE name IN ('cluster_database','cluster_database_instances','instance_type','remote_listener','local_listener');
SELECT inst_number, inst_name FROM v$active_instances ORDER BY 1;`,
    'cluster_database=FALSE 且只有 1 个实例就是单实例；11g 没有 v$cluster 视图，判定只看这两处'),
  orRacSess: m('节点会话分布', 'GV$SESSION', '每实例的用户会话 / 活跃数',
    Q_SESS_BY_INST,
    '会话严重倾斜说明连接没做负载均衡：检查 tnsnames 的 LOAD_BALANCE 与服务端 service 分布'),
  orRacNodes: m('实例与节点', 'GV$INSTANCE', '当前库每个实例一行',
    `SELECT inst_id, instance_name, host_name, status, instance_role, active_state,
       database_status, version, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time
  FROM gv$instance ORDER BY inst_id;`,
    'ACTIVE_STATE=NORMAL 才正常；RAC 下 INSTANCE_ROLE 都是 OPEN，主备看 v$database.database_role'),
  orRacSvc: m('服务分布', 'GV$ACTIVE_SERVICES', '各实例上注册的服务',
    `SELECT inst_id, service_id, name, network_name FROM gv$active_services ORDER BY inst_id, name;`,
    '业务连的是 service_name 而不是 SID；只在单个实例上注册的服务等于没有高可用'),
  orRacIc: m('私网 / 互联', 'GV$CLUSTER_INTERCONNECTS', '各实例的私网地址',
    `SELECT inst_id, name, ip_address, is_public, source FROM gv$cluster_interconnects ORDER BY inst_id;`,
    '为空一般是单实例或没配 RAC 私网；私网跑到公网网卡上会让 Cache Fusion 明显变慢'),

  // ---------------------------------------------------------------- 实例
  orInstMeta: m('实例基本信息', 'GV$INSTANCE / V$PARAMETER', '每个实例（卡片头部与键值区）',
    `SELECT inst_id, instance_name, host_name, status, instance_role, active_state,
       database_status, version, TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time
  FROM gv$instance ORDER BY inst_id;
SELECT name, value FROM v$parameter WHERE name IN (
  'processes','sessions','db_block_size','compatible','optimizer_mode','cursor_sharing',
  'open_cursors','undo_tablespace','db_recovery_file_dest','sga_target','pga_aggregate_target');`,
    '这里的 processes / sessions 是参数上限，实际用量看「资源使用」'),
  orInstSga: m('SGA 组成', 'V$SGAINFO', '当前实例（各内存池大小）',
    Q_SGA,
    'buffer cache 通常应占大头；shared pool 长期吃紧会表现为 ORA-04031'),
  orInstPga: m('PGA 使用', 'V$PGASTAT', '当前实例的 PGA 目标与实际占用',
    `SELECT name, ROUND(value/1048576, 2) mb FROM v$pgastat
 WHERE name IN ('aggregate PGA target parameter','aggregate PGA auto target',
                'total PGA allocated','total PGA inuse','total freeable PGA memory');`,
    'total PGA allocated 超过 target 说明 workarea 在抢内存：调大 pga_aggregate_target 或降并行度'),
  orInstBuf: m('缓冲池命中率', 'V$BUFFER_POOL_STATISTICS', '当前实例各缓冲池',
    `SELECT name, db_block_gets, consistent_gets, physical_reads,
       ROUND(physical_reads * 100 / DECODE(db_block_gets + consistent_gets, 0, 1,
             db_block_gets + consistent_gets), 2) miss_pct
  FROM v$buffer_pool_statistics;`,
    'miss% > 5% 多半是缓存不足或有全表扫；先看 TopSQL 的 BUFFER_GETS，别急着加内存'),
  orInstRes: m('资源使用', 'V$RESOURCE_LIMIT', 'processes / sessions / transactions / enqueue_locks',
    `SELECT resource_name, current_utilization, max_utilization, limit_value
  FROM v$resource_limit
 WHERE resource_name IN ('processes','sessions','transactions','enqueue_locks');`,
    'current_utilization 逼近 limit_value 时会出现 ORA-00018 / ORA-00020（进程或会话满）'),

  // ---------------------------------------------------------------- 容器与 PDB
  orPdbList: m('PDB 列表', 'V$PDBS / V$CONTAINERS', '当前 CDB 的全部容器',
    `SELECT con_id, name, open_mode, restricted, TO_CHAR(open_time,'YYYY-MM-DD HH24:MI') open_time
  FROM v$pdbs ORDER BY con_id;
SELECT con_id, con_type FROM v$containers;`,
    '11g 没有 v$pdbs（页面直接提示「不是 CDB」）；OPEN_MODE=MOUNTED 的 PDB 业务连不上'),
  orPdbFiles: m('PDB 数据文件占用', 'V$DATAFILE', '按 CON_ID 汇总的数据文件大小',
    `SELECT con_id, COUNT(*) files, ROUND(SUM(bytes)/1048576, 2) mb
  FROM v$datafile GROUP BY con_id;`,
    '这里是容器整体占用；要看 PDB 内部的表空间水位，需要切到该容器里查 dba_data_files'),

  // ---------------------------------------------------------------- 存储
  orStFra: m('FRA 快速恢复区', 'V$RECOVERY_FILE_DEST / V$FLASH_RECOVERY_AREA_USAGE', '当前库的 FRA 上限、已用与可回收',
    `SELECT name, ROUND(space_limit/1073741824, 2) limit_gb, ROUND(space_used/1073741824, 2) used_gb,
       ROUND(space_reclaimable/1073741824, 2) reclaim_gb, number_of_files
  FROM v$recovery_file_dest;
SELECT file_type, percent_space_used, percent_space_reclaimable, number_of_files
  FROM v$flash_recovery_area_usage;`,
    'FRA 满会导致归档写不进去、库被挂起；先 RMAN 备份后删过期归档，再考虑调大 db_recovery_file_dest_size'),
  orStArch: m('归档目标与归档量', 'V$ARCHIVE_DEST_STATUS / V$ARCHIVED_LOG', 'dest_id <= 10 的目标 + 近 24 小时归档量',
    `SELECT dest_id, status, destination, synchronization_status, synchronized, error,
       db_unique_name, gap_status, archived_seq# archived_seq, applied_seq# applied_seq
  FROM v$archive_dest_status WHERE dest_id <= 10 ORDER BY dest_id;
SELECT COUNT(*) cnt, ROUND(SUM(blocks * block_size)/1073741824, 2) gb
  FROM v$archived_log WHERE first_time > SYSDATE - 1 AND dest_id = 1;`,
    'ERROR 非空说明归档或传输失败；ARCHIVED_SEQ 与 APPLIED_SEQ 的差就是备库积压的日志量'),
  orStTs: m('表空间水位（存储）', 'DBA_TABLESPACES / DBA_DATA_FILES / DBA_FREE_SPACE', '所有表空间，含 AUTOEXT 与上限',
    Q_TS_WATER,
    'MAX MB 是自动扩展上限（32G = 未设 maxbytes 的 smallfile）；AUTOEXT 是已开自动扩展的文件数'),
  orStTemp: m('临时表空间', 'V$TEMP_SPACE_HEADER / DBA_TEMP_FILES', '各 TEMP 表空间已用 / 空闲',
    `SELECT h.tablespace_name,
       ROUND(SUM(h.bytes_used)/1048576, 2) used_mb, ROUND(SUM(h.bytes_free)/1048576, 2) free_mb,
       ROUND(SUM(NVL(f.bytes,0))/1048576, 2) total_mb
  FROM v$temp_space_header h
  LEFT JOIN (SELECT tablespace_name, SUM(bytes) bytes FROM dba_temp_files GROUP BY tablespace_name) f
    ON f.tablespace_name = h.tablespace_name
 GROUP BY h.tablespace_name;`,
    'TEMP 用满多来自大排序 / 并行查询：先查 TopSQL 与 PGA 命中率，再决定是否扩 TEMP'),
  orStUndo: m('UNDO', 'DBA_ROLLBACK_SEGS / V$UNDOSTAT', '回滚段状态 + 最近 12 个 UNDO 统计周期',
    `SELECT status, COUNT(*) c FROM dba_rollback_segs GROUP BY status;
SELECT * FROM (
  SELECT TO_CHAR(begin_time,'MM-DD HH24:MI') begin_ts, TO_CHAR(end_time,'HH24:MI') end_ts,
         undoblks, txncount, maxquerylen, ssolderrcnt, nospaceerrcnt
    FROM v$undostat ORDER BY begin_time DESC) WHERE rownum <= 12;`,
    'NOSPACEERRCNT > 0 说明 UNDO 曾经不够（ORA-01555 的源头）；MAXQUERYLEN 应小于 undo_retention'),
  orStRedo: m('在线日志', 'V$LOG', '当前实例的日志组与切换状态',
    `SELECT group# grp, thread# thr, sequence# seq, bytes/1048576 mb, members, status, archived,
       TO_CHAR(first_time,'YYYY-MM-DD HH24:MI') first_time
  FROM v$log ORDER BY group#;`,
    'CURRENT 只能有一个；ACTIVE 表示还没归档完；日志组太小会出现频繁 log switch 与 checkpoint'),
  orStAsm: m('ASM 磁盘组', 'V$ASM_DISKGROUP / V$ASM_DISK', '当前实例可见的 ASM 磁盘组',
    `SELECT g.name, g.state, g.type, g.total_mb, g.free_mb, g.usable_file_mb,
       ROUND((g.total_mb - g.free_mb) * 100 / DECODE(g.total_mb, 0, 1, g.total_mb), 2) used_pct,
       (SELECT COUNT(*) FROM v$asm_disk d WHERE d.group_number = g.group_number) disks
  FROM v$asm_diskgroup g ORDER BY g.name;`,
    '非 ASM 存储时为空（正常）；USABLE_FILE_MB 已扣冗余，它接近 0 就必须加盘'),
  orStDf: m('数据文件', 'DBA_DATA_FILES / V$PARAMETER', '全部数据文件（含自动扩展设置）',
    `SELECT file_id, file_name, tablespace_name, ROUND(bytes/1048576, 2) size_mb, autoextensible,
       ROUND(maxbytes/1048576, 2) max_mb,
       ROUND(increment_by * (SELECT value FROM v$parameter WHERE name = 'db_block_size')/1048576, 2) inc_mb,
       status, online_status
  FROM dba_data_files ORDER BY tablespace_name, file_id;`,
    'AUTOEXTENSIBLE=NO 且快满的文件只能人工扩；MAXBYTES=32G 说明没设上限'),

  // ---------------------------------------------------------------- 会话与锁
  orSeSummary: m('会话状态分布', 'GV$SESSION', '所有实例，按 type + status 分组',
    `SELECT status, type, COUNT(*) c
  FROM gv$session GROUP BY status, type ORDER BY type, status;`,
    'USER 是业务会话、BACKGROUND 是后台进程；ACTIVE/INACTIVE 的比例能看出连接池是否合理'),
  orSeWaitClass: m('用户会话等待分类', 'GV$SESSION', 'type = USER，按 WAIT_CLASS 分组',
    `SELECT NVL(wait_class, 'CPU') wc, COUNT(*) c
  FROM gv$session WHERE type = 'USER'
 GROUP BY NVL(wait_class, 'CPU') ORDER BY 2 DESC;`,
    'WAIT_CLASS 为空表示当前正在 CPU 上跑；Application / Concurrency 高要去追具体 SQL 与锁'),
  orSeBlocking: m('阻塞链', 'GV$LOCK / GV$SESSION', 'TX / TM 锁，BLOCK in (1,2)',
    `SELECT l.inst_id, l.sid, l.type, l.lmode, l.request, l.ctime,
       b.sid blocker_sid, b.username blocker_user, b.sql_id blocker_sql,
       s.username, s.sql_id, s.event
  FROM gv$lock l
  JOIN gv$session s ON s.sid = l.sid AND s.inst_id = l.inst_id
  LEFT JOIN gv$session b ON b.sid = l.id1 AND b.inst_id = l.inst_id
 WHERE l.block IN (1,2) AND l.type IN ('TX','TM')
 ORDER BY l.ctime DESC;`,
    'BLOCKER_SID 才是源头，拿 blocker_sql 去「SQL 诊断」看执行计划；直接 kill 业务会话常常会复发'),
  orSeLong: m('长操作进度', 'GV$SESSION_LONGOPS', 'TIME_REMAINING > 0，最多 50 条',
    `SELECT * FROM (
  SELECT inst_id, sid, opname, target,
         ROUND(sofar * 100 / DECODE(totalwork, 0, 1, totalwork), 1) pct,
         time_remaining, elapsed_seconds, sql_id
    FROM gv$session_longops WHERE time_remaining > 0
   ORDER BY time_remaining DESC) WHERE rownum <= 50;`,
    'TIME_REMAINING 是按已完成比例外推的估算值，大表扫描 / 建索引时会跳变'),
  orSeList: m('用户会话列表', 'GV$SESSION / GV$PROCESS', 'type = USER，最多 300 行，活跃优先',
    `SELECT * FROM (
  SELECT s.inst_id, s.sid, s.serial# serial_no, s.username, s.status, s.machine, s.program,
         s.sql_id, s.event, s.wait_class, s.seconds_in_wait, s.blocking_session,
         s.last_call_et, TO_CHAR(s.logon_time,'MM-DD HH24:MI') logon_time, p.spid
    FROM gv$session s
    LEFT JOIN gv$process p ON p.addr = s.paddr AND p.inst_id = s.inst_id
   WHERE s.type = 'USER' AND s.username IS NOT NULL
   ORDER BY CASE WHEN s.status = 'ACTIVE' THEN 0 ELSE 1 END, s.last_call_et DESC) WHERE rownum <= 300;`,
    "SPID 是 OS 进程号；杀会话用 ALTER SYSTEM KILL SESSION 'sid,serial#'，看板只读不提供该动作"),

  // ---------------------------------------------------------------- SQL 诊断
  orSqlTop: m('共享池 TopSQL', 'GV$SQL', 'executions > 0，按耗时 / CPU / 逻辑读 / 物理读取前 40',
    `SELECT * FROM (
  SELECT sql_id, plan_hash_value, executions, ROUND(elapsed_time/1000000, 2) elapsed_s,
         ROUND(cpu_time/1000000, 2) cpu_s,
         ROUND(elapsed_time / DECODE(executions, 0, 1, executions) / 1000, 2) avg_ms,
         buffer_gets, disk_reads,
         ROUND(buffer_gets / DECODE(executions, 0, 1, executions)) gets_per_exec,
         ROUND(disk_reads / DECODE(executions, 0, 1, executions)) reads_per_exec,
         rows_processed, parsing_schema_name, module,
         TO_CHAR(last_active_time,'MM-DD HH24:MI:SS') last_active
    FROM gv$sql WHERE executions > 0
   ORDER BY elapsed_time DESC) WHERE rownum <= 40;`,
    'AVG_MS 高但 EXECUTIONS 少的多半是偶发慢 SQL；GETS_PER_EXEC 大说明逻辑读重，先想索引'),
  orSqlDetail: m('SQL 详情（全文 + 执行计划）', 'GV$SQLTEXT / GV$SQL_PLAN', '按 SQL_ID 单条查询',
    `SELECT piece, sql_text FROM gv$sqltext WHERE sql_id = :id ORDER BY piece;
SELECT id, depth, operation, options, object_owner, object_name, cost, cardinality, bytes
  FROM gv$sql_plan
 WHERE sql_id = :id
   AND plan_hash_value = (SELECT MAX(plan_hash_value) FROM gv$sql WHERE sql_id = :id)
 ORDER BY id;`,
    '游标被刷出共享池后取不到全文与计划；没有 SELECT_CATALOG_ROLE 也读不到计划'),
  orSqlAwr: m('AWR 历史 TopSQL', 'DBA_HIST_SQLSTAT / DBA_HIST_SNAPSHOT', '最近 12 个 AWR 快照',
    `SELECT * FROM (
  SELECT s.sql_id, SUM(s.executions_delta) execs, ROUND(SUM(s.elapsed_time_delta)/1000000, 2) elapsed_s,
         ROUND(SUM(s.cpu_time_delta)/1000000, 2) cpu_s, SUM(s.buffer_gets_delta) gets,
         SUM(s.disk_reads_delta) reads
    FROM dba_hist_sqlstat s
   WHERE s.snap_id > (SELECT MAX(snap_id) - 12 FROM dba_hist_snapshot)
   GROUP BY s.sql_id ORDER BY 3 DESC) WHERE rownum <= 20;
SELECT * FROM (SELECT TO_CHAR(begin_interval_time,'MM-DD HH24:MI') bt, TO_CHAR(end_interval_time,'HH24:MI') et
                 FROM dba_hist_snapshot ORDER BY snap_id DESC) WHERE rownum <= 12;`,
    'AWR 需要 Diagnostics Pack 授权；没有快照或未授权时为空，属正常'),

  // ---------------------------------------------------------------- 性能与等待
  orPfMetric: m('实时指标（性能页）', 'V$SYSMETRIC', 'group_id = 2（60 秒档）的 12 个指标',
    `SELECT metric_name, value, metric_unit FROM v$sysmetric
 WHERE group_id = 2 AND metric_name IN (
   'User Transaction Per Sec','Executions Per Sec','Session Count','Active Session Count',
   'Database CPU Time Ratio','Database Wait Time Ratio','Physical Reads Per Sec','Redo Generated Per Sec',
   'Logical Reads Per Sec','Host CPU Utilization (%)','Average Active Sessions','SQL Service Response Time')
 ORDER BY metric_name;`,
    'group_id = 2 是 60 秒档，3 是 15 秒档；同一个指标名在不同版本里可能有细微差异'),
  orPfWait: m('累计等待 TOP', 'V$SYSTEM_EVENT', '实例启动以来累计，非空闲等待前 25 类',
    `SELECT * FROM (
  SELECT event, wait_class, total_waits, ROUND(time_waited_micro/1000000, 2) time_s,
         ROUND(average_wait * 10, 2) avg_ms
    FROM v$system_event WHERE wait_class <> 'Idle'
   ORDER BY time_waited_micro DESC) WHERE rownum <= 25;`,
    '累计值看「谁最耗时」；AVG_MS 小但次数多说明高频轻等待，优化收益有限'),
  orPfAsh: m('ASH 采样', 'V$ACTIVE_SESSION_HISTORY', '近 1 小时，按 SQL / 事件 / 状态分组前 20',
    `SELECT * FROM (
  SELECT sql_id, event, session_state, COUNT(*) samples
    FROM v$active_session_history WHERE sample_time > SYSDATE - 1/24
   GROUP BY sql_id, event, session_state ORDER BY 4 DESC) WHERE rownum <= 20;`,
    'ASH 需要 Diagnostics Pack；SAMPLES 就是这一小时内该组合被采到的秒数，可当「活跃会话秒」'),
  orPfSga: m('SGA 组成（性能页）', 'V$SGAINFO', '当前实例各内存池大小',
    Q_SGA,
    '和「实例」页同一份数据，只是这里按占比画条形，便于判断 buffer cache 是否偏小'),
  orPfPga: m('PGA 使用（性能页）', 'V$PGASTAT', '当前实例 PGA 目标、占用与命中率',
    `SELECT name, ROUND(value/1048576, 2) mb FROM v$pgastat
 WHERE name IN ('aggregate PGA target parameter','total PGA allocated','total PGA inuse',
                'total freeable PGA memory','cache hit percentage');`,
    'cache hit percentage 低于 90% 说明 workarea 不够：调大 pga_aggregate_target 比扩 TEMP 更有效'),
  orPfSysstat: m('系统统计', 'V$SYSSTAT', '实例启动以来累计的 13 个系统统计量',
    `SELECT name, value FROM v$sysstat WHERE name IN (
  'user commits','user rollbacks','execute count','parse count (total)','parse count (hard)',
  'session logical reads','physical reads','physical writes','redo size','sorts (memory)','sorts (disk)',
  'table scan rows gotten','index fast full scans (full)');`,
    'sorts (disk) 占比高说明排序落盘；parse count (hard) 持续增长说明没有用绑定变量'),
  orPfOs: m('OS 统计', 'V$OSSTAT', '当前实例所在主机的 CPU / 内存 / 负载',
    `SELECT stat_name, value FROM v$osstat
 WHERE stat_name IN ('NUM_CPUS','NUM_CPU_CORES','PHYSICAL_MEMORY_BYTES','LOAD',
                     'IDLE_TIME','BUSY_TIME','USER_TIME','SYS_TIME');`,
    'LOAD 是 1 分钟平均负载，要和 CPU 核数比；IDLE/BUSY_TIME 的单位是百分之一秒'),

  // ---------------------------------------------------------------- 告警日志
  orAlSummary: m('告警日志概览', 'V$DIAG_ALERT_EXT', '窗口内条数、ORA- 条数、按小时分布',
    `SELECT COUNT(*) total, SUM(CASE WHEN message_text LIKE '%ORA-%' THEN 1 ELSE 0 END) errs
  FROM v$diag_alert_ext WHERE originating_timestamp > SYSTIMESTAMP - 24/24;
SELECT TO_CHAR(originating_timestamp,'MM-DD HH24') hr, COUNT(*) c,
       SUM(CASE WHEN message_text LIKE '%ORA-%' THEN 1 ELSE 0 END) errs
  FROM v$diag_alert_ext WHERE originating_timestamp > SYSTIMESTAMP - 24/24
 GROUP BY TO_CHAR(originating_timestamp,'MM-DD HH24') ORDER BY 1;`,
    '窗口是 SYSTIMESTAMP - h/24，只影响查询范围，不改库；1h/24h/3d/7d 对应 1/24、1、3、7'),
  orAlGroups: m('告警聚类', 'V$DIAG_ALERT_EXT', '窗口内按「去掉数字后的模板」聚合，前 25 类',
    `SELECT * FROM (
  SELECT REGEXP_REPLACE(SUBSTR(message_text, 1, 120), '[0-9]+', '#') pat,
         COUNT(*) c, TO_CHAR(MIN(originating_timestamp),'MM-DD HH24:MI') first_ts,
         TO_CHAR(MAX(originating_timestamp),'MM-DD HH24:MI') last_ts,
         SUM(CASE WHEN message_text LIKE '%ORA-%' THEN 1 ELSE 0 END) errs
    FROM v$diag_alert_ext WHERE originating_timestamp > SYSTIMESTAMP - 24/24
   GROUP BY REGEXP_REPLACE(SUBSTR(message_text, 1, 120), '[0-9]+', '#')
   ORDER BY 2 DESC) WHERE rownum <= 25;`,
    '几万条日志会收敛成十几类；同类只占一行，先看「次数最多」和「最近还在出现」的'),
  orAlOra: m('ORA- 错误', 'V$DIAG_ALERT_EXT', "MESSAGE_TEXT LIKE '%ORA-%'，最近 100 条",
    `SELECT * FROM (
  SELECT TO_CHAR(originating_timestamp,'MM-DD HH24:MI:SS') ts, SUBSTR(message_text, 1, 300) msg
    FROM v$diag_alert_ext WHERE message_text LIKE '%ORA-%'
   ORDER BY originating_timestamp DESC) WHERE rownum <= 100;`,
    'ORA- 不一定都是故障（如 ORA-00028 会话被 kill），要结合发生时间与业务操作判断'),
  orAlRecent: m('最近日志明细', 'V$DIAG_ALERT_EXT', '全量日志按时间倒序，最多 200 条',
    `SELECT * FROM (
  SELECT TO_CHAR(originating_timestamp,'MM-DD HH24:MI:SS') ts, message_type, message_level,
         SUBSTR(message_text, 1, 300) msg
    FROM v$diag_alert_ext ORDER BY originating_timestamp DESC) WHERE rownum <= 200;`,
    'MESSAGE_LEVEL 是 ADR 内部级别（16 更严重），不是 Oracle 告警等级；读更早日志请直接看 ADR 目录的 alert_*.log'),

  // ---------------------------------------------------------------- 备份恢复
  orBkSummary: m('备份概览', 'V$RMAN_BACKUP_JOB_DETAILS / V$ARCHIVED_LOG / V$RECOVERY_FILE_DEST', '最近一次全库备份 + 近 24h 归档 + FRA 水位',
    `SELECT * FROM (
  SELECT session_key, status, input_type, TO_CHAR(start_time,'MM-DD HH24:MI') st
    FROM v$rman_backup_job_details WHERE input_type LIKE '%DB FULL%'
   ORDER BY start_time DESC) WHERE rownum <= 1;
SELECT COUNT(*) cnt, ROUND(SUM(blocks * block_size)/1073741824, 2) gb
  FROM v$archived_log WHERE first_time > SYSDATE - 1 AND dest_id = 1;
SELECT ROUND(space_limit/1073741824, 2) limit_gb, ROUND(space_used/1073741824, 2) used_gb
  FROM v$recovery_file_dest;`,
    '看板不判断 RPO 是否达标，只把最近一次全库备份的时间与结果摆出来，是否合规按你们的策略判断'),
  orBkJobs: m('RMAN 作业', 'V$RMAN_BACKUP_JOB_DETAILS', '最近 40 条作业',
    `SELECT * FROM (
  SELECT session_key, command_id, status, TO_CHAR(start_time,'MM-DD HH24:MI') st,
         TO_CHAR(end_time,'HH24:MI') et, elapsed_seconds, input_type, output_device_type,
         ROUND(output_bytes/1073741824, 2) output_gb
    FROM v$rman_backup_job_details ORDER BY start_time DESC) WHERE rownum <= 40;`,
    'COMMAND_ID 对应 RMAN 的 command id，可在 RMAN 日志里检索失败原因'),
  orBkSets: m('备份集', 'V$BACKUP_SET', '最近 30 个备份集',
    `SELECT * FROM (
  SELECT recid, backup_type, incremental_level, TO_CHAR(completion_time,'MM-DD HH24:MI') done,
         ROUND(block_size * blocks/1073741824, 2) gb, pieces
    FROM v$backup_set ORDER BY completion_time DESC) WHERE rownum <= 30;`,
    'incremental_level 为空表示全量，0 表示 0 级增量；只反映控制文件里的记录'),

  // ---------------------------------------------------------------- Data Guard
  orDgSummary: m('DG 概况', 'V$DATABASE / V$MANAGED_STANDBY', '本库角色、保护模式与 MRP 进程',
    `SELECT database_role, protection_mode, open_mode FROM v$database;
SELECT process, status FROM v$managed_standby ORDER BY process;`,
    '主库是 PRIMARY、物理备库是 PHYSICAL STANDBY；有 MRP0 在 APPLYING_LOG 才说明备库在追日志'),
  orDgStats: m('应用/传输延迟', 'V$DATAGUARD_STATS', '本库的 DG 统计项',
    `SELECT name, value, unit, time_computed FROM v$dataguard_stats;`,
    '为空常见于「主库未配备库」或「备库没连上」；apply lag / transport lag 是最该看的两个'),
  orDgDests: m('归档目标（DG）', 'V$ARCHIVE_DEST_STATUS', 'dest_id <= 10',
    `SELECT dest_id, status, type, database_mode, recovery_mode, protection_mode,
       destination, error, db_unique_name, synchronized, gap_status,
       archived_seq# archived_seq, applied_seq# applied_seq
  FROM v$archive_dest_status WHERE dest_id <= 10 ORDER BY dest_id;`,
    'ERROR 非空或 GAP_STATUS 有值说明日志没传过去；ARCHIVED_SEQ - APPLIED_SEQ 就是积压'),
  orDgProcs: m('Data Guard 进程', 'V$MANAGED_STANDBY', 'MRP / LNS / RFS 进程',
    `SELECT process, status, thread# thr, sequence# seq, block# blk, blocks
  FROM v$managed_standby ORDER BY process;`,
    '备库上应该有 MRP0；主库上会有 LNS 与多个 RFS（每个备库一条）'),

  // ---------------------------------------------------------------- 作业调度
  orJbSched: m('Scheduler 作业', 'DBA_SCHEDULER_JOBS', '全部 Scheduler 作业',
    `SELECT owner, job_name, enabled, state, run_count, failure_count,
       TO_CHAR(last_start_date,'MM-DD HH24:MI') last_start,
       TO_CHAR(next_run_date,'MM-DD HH24:MI') next_run
  FROM dba_scheduler_jobs ORDER BY owner, job_name;`,
    'FAILURE_COUNT > 0 的作业，失败原因去「作业历史」看 additional_info'),
  orJbDbms: m('DBMS_JOB 作业', 'DBA_JOBS', '老式 DBMS_JOB 作业',
    `SELECT job, log_user, broken, failures, TO_CHAR(last_date,'MM-DD HH24:MI') last_date,
       TO_CHAR(next_date,'MM-DD HH24:MI') next_date, SUBSTR(what, 1, 120) what
  FROM dba_jobs ORDER BY job;`,
    'BROKEN=Y 表示连续失败被自动禁用：修好作业体后要 DBMS_JOB.BROKEN(job, FALSE) 才会重新跑'),
  orJbRuns: m('作业运行历史', 'DBA_SCHEDULER_JOB_RUN_DETAILS', '最近 80 条运行记录',
    `SELECT * FROM (
  SELECT owner, job_name, status, TO_CHAR(actual_start_date,'MM-DD HH24:MI') st,
         ROUND(run_duration) dur_s, SUBSTR(additional_info, 1, 200) info
    FROM dba_scheduler_job_run_details ORDER BY actual_start_date DESC) WHERE rownum <= 80;`,
    'run_duration 的单位是「天 + 时分秒」格式转成的秒；失败详情在 additional_info'),

  // ---------------------------------------------------------------- 参数
  orPaKey: m('关键参数', 'V$PARAMETER', '18 个关键初始化参数',
    `SELECT name, value, isdefault, issys_modifiable FROM v$parameter
 WHERE name IN ('sga_target','sga_max_size','pga_aggregate_target','memory_target','processes','sessions',
   'db_block_size','optimizer_mode','compatible','cursor_sharing','open_cursors','db_files',
   'filesystemio_options','undo_retention','db_recovery_file_dest','log_archive_dest_1',
   'job_queue_processes','statistics_level') ORDER BY name;`,
    'ISSYS_MODIFIABLE=FALSE 的改动必须重启实例；compatible 只升不降（降要先做降级流程）'),
  orPaChanged: m('非默认参数', 'V$PARAMETER', 'isdefault = FALSE 的参数',
    `SELECT name, value, issys_modifiable, SUBSTR(description, 1, 160) descr
  FROM v$parameter WHERE isdefault = 'FALSE' ORDER BY name;`,
    '排查「为什么跟别的库表现不一样」先看这里；带 .序号 的范围参数在 v$parameter 里只显示一级'),

  // ---------------------------------------------------------------- 用户与对象
  orUsSummary: m('账号与对象概览', 'DBA_USERS / DBA_OBJECTS', '全库账号数、锁定/过期数、对象数与失效数',
    `SELECT COUNT(*) FROM dba_users;
SELECT COUNT(*) FROM dba_users WHERE account_status <> 'OPEN';
SELECT COUNT(*) FROM dba_objects;
SELECT COUNT(*) FROM dba_objects WHERE status = 'INVALID';`,
    '「已锁定/过期」= account_status 不是 OPEN；业务账号被锁会直接认证失败，和密码错是两回事'),
  orUsPwfile: m('特权账号', 'V$PWFILE_USERS', '口令文件里的 SYSDBA / SYSOPER / ADMIN',
    `SELECT username, sysdba, sysoper, admin FROM v$pwfile_users;`,
    'DBA 角色不等于 SYSDBA：后者只在这里体现，且需要 GRANT SYSDBA TO 用户 才生效'),
  orUsRoles: m('当前用户角色', 'DBA_ROLE_PRIVS', '当前连接账号直接授予的角色',
    `SELECT granted_role, admin_option, default_role FROM dba_role_privs WHERE grantee = USER;`,
    '这里是「当前连接账号」的角色；看别人的权限要按 GRANTEE 查 dba_role_privs / dba_sys_privs'),
  orUsUsers: m('数据库用户', 'DBA_USERS', '全部账号',
    `SELECT username, account_status, TO_CHAR(expiry_date,'YYYY-MM-DD') expiry,
       default_tablespace, temporary_tablespace, profile, TO_CHAR(created,'YYYY-MM-DD') created,
       authentication_type
  FROM dba_users ORDER BY username;`,
    'EXPIRED / LOCKED 的账号连上会直接认证失败；PROFILE 决定密码策略与资源限制'),
  orUsInvalid: m('失效对象', 'DBA_OBJECTS', 'status = INVALID，按 owner + 类型聚合',
    `SELECT owner, object_type, COUNT(*) c
  FROM dba_objects WHERE status = 'INVALID'
 GROUP BY owner, object_type ORDER BY 3 DESC;`,
    '重编译：ALTER PACKAGE/PROCEDURE ... COMPILE；编译不过说明依赖对象真的变了'),
  orUsTypes: m('对象类型分布', 'DBA_OBJECTS', '全库按 object_type 聚合',
    `SELECT object_type, COUNT(*) c FROM dba_objects GROUP BY object_type ORDER BY 2 DESC;`,
    'SYNONYM / TABLE 多说明业务库；PACKAGE 多说明 PL/SQL 重；这个数包含系统对象'),
  orUsSeg: m('最大段 TOP', 'DBA_SEGMENTS', '按字节数倒序前 25 个段',
    `SELECT * FROM (
  SELECT owner, segment_name, segment_type, tablespace_name, ROUND(bytes/1048576, 2) mb
    FROM dba_segments ORDER BY bytes DESC) WHERE rownum <= 25;`,
    'dba_segments 是全表扫描，大库较慢，所以只在打开这个 tab 时才查；建议先在业务低峰看')
}
