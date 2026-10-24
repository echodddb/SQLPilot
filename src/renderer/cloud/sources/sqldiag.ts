/**
 * SQL 诊断页（TopSQL / 慢 SQL）的采集来源。
 * 数据链路：OCP-Agent 采集 sql_audit → OCP 监控库聚合 → /topSql 接口按时间窗返回；
 * 业务库 GV$OB_SQL_AUDIT 是等价口径（可用来核对 OCP 算出来的数）。
 */
import { MONITOR_CLUSTER, MONITOR_DB, MONITOR_TENANT, OB_DB, SYS_TENANT, type SourceInfo } from './types'

export const SD_SOURCES: Record<string, SourceInfo> = {
  sqlTopSql: {
    title: 'TopSQL 列表',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/topSql?startTime=&endTime=&limit=&sqlText=',
    scope: '时间窗内该租户（或整个集群）的语句聚合，一行 = sqlId × OBServer',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_SQL_AUDIT', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（等价口径，samples 为执行记录数）：\nSELECT TENANT_ID, TENANT_NAME, SQL_ID, SUBSTR(QUERY_SQL, 1, 50) AS query_sample,\n       COUNT(*) AS execs,\n       ROUND(AVG(ELAPSED_TIME)) AS avg_us,\n       MAX(ELAPSED_TIME) AS max_us,\n       SUM(ELAPSED_TIME) AS sum_us,\n       SUM(CASE WHEN RET_CODE <> 0 THEN 1 ELSE 0 END) AS fails,\n       ROUND(100 * SUM(CASE WHEN IS_HIT_PLAN = 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS miss_plan_pct,\n       SUM(CASE WHEN TABLE_SCAN = 1 THEN 1 ELSE 0 END) AS table_scan_cnt\nFROM oceanbase.GV$OB_SQL_AUDIT\nWHERE REQUEST_TIME > DATE_SUB(NOW(), INTERVAL 1 HOUR)\nGROUP BY TENANT_ID, TENANT_NAME, SQL_ID, SUBSTR(QUERY_SQL, 1, 50)\nORDER BY sum_us DESC\nLIMIT 10;`,
    note: 'OCP 侧数据不是现算业务库，而是从监控库的 sql_audit 聚合表按时间窗取（已按 sqlId × server 滚好）。接口坑：时间参数必须是 OffsetDateTime（2026-10-21T02:00:00+00:00），毫秒时间戳会被拒；条数参数是 limit（size / page 都无效）；只有 sqlText 是服务端过滤，dbName / userName 要前端过滤；排序也不支持，页面上的排序是本地做的。列表里的 SQL 文本默认为截断版，加 sqlTextLength 参数可放宽（本页用 1000），完整语句要单独取 /sqls/{sqlId}/text（展开行时才请求）'
  },
  sqlStats: {
    title: 'SQL 概况',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/performance/sql/statistics',
    scope: '该集群全部租户的 新 SQL / 慢 SQL / 异常 SQL / 高风险 SQL 计数（时间窗内）',
    origin: {
      tenant: MONITOR_TENANT,
      db: MONITOR_DB,
      table: 'ob_hist_sql_audit_stat_0',
      cluster: MONITOR_CLUSTER,
      placeholder: true
    },
    sql: `-- 等价口径（慢 SQL 计数）在该集群的 sys 租户执行：\nSELECT TENANT_ID, COUNT(*) AS slow_cnt\nFROM oceanbase.GV$OB_SQL_AUDIT\nWHERE REQUEST_TIME > DATE_SUB(NOW(), INTERVAL 1 HOUR)\n  AND ELAPSED_TIME > 100000\nGROUP BY TENANT_ID;`,
    note: 'tenantId 参数不生效，接口固定返回该集群全部租户。「新 SQL」= 时间窗内首次出现的 sqlId，「慢 SQL」按 OCP 的耗时阈值判定（不是固定 100ms），「异常 SQL」= 有错误码，「高风险」= 无索引全表扫描等规则命中；判定口径由 OCP 侧规则决定，SQL 只是量级参考'
  }
}
