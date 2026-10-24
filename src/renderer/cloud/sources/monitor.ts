/**
 * 资源监控页的采集来源。
 * OCP 4.x 的监控数据不直接透传 OB 视图：Agent 采集 → 写 OCP 监控库 → /monitor/metric 接口按时序返回。
 * 因此 origin 指监控库，sql 给 OB 侧的等价口径（便于 DBA 自查数值是否合理）。
 */
import { MONITOR_CLUSTER, MONITOR_DB, MONITOR_TENANT, OB_DB, SYS_TENANT, type SourceInfo } from './types'

const MON_ORIGIN = {
  tenant: MONITOR_TENANT,
  db: MONITOR_DB,
  table: 'metric_data_second / ob_hist_sysstat',
  cluster: MONITOR_CLUSTER,
  placeholder: true
}

export const MO_SOURCES: Record<string, SourceInfo> = {
  moCluster: {
    title: '集群性能曲线',
    api: 'GET /api/v2/monitor/metric?scope=CLUSTER&metrics=…&startTime=&endTime=',
    scope: '所选集群在时间窗内的采样序列（30 分钟 / 1 / 6 / 24 小时）',
    origin: MON_ORIGIN,
    sql: `-- 等价口径在该集群的 sys 租户执行（QPS = 四次采样的 count 增量 / 秒）：\nSELECT CON_ID, SVR_IP, NAME, VALUE\nFROM oceanbase.GV$SYSSTAT\nWHERE NAME IN ('sql select count','sql insert count','sql update count','sql delete count','tps');`,
    note: 'OCP 把秒级采样压成二进制点阵存 metric_data_second（series_id + timestamp + data），series 定义在 ocp_metric_series_key_id；分钟/小时级分别落 metric_data_minute / metric_data_hour，按分钟聚合的历史在 ob_hist_sysstat（name / end_value_ps / end_interval_time）。「CPU 使用率」是 OS/进程级指标，不是 Unit 分配率'
  },
  moTenant: {
    title: '租户性能曲线',
    api: 'GET /api/v2/monitor/metric?scope=TENANT&metrics=…&groupBy=tenant',
    scope: '所选租户在时间窗内的 QPS / TPS / 活跃会话 / MemStore / 耗时 / 缓存命中率',
    origin: MON_ORIGIN,
    sql: `-- 等价口径在该集群的 sys 租户执行（CON_ID 即 OB 租户 ID，如 1004）：\nSELECT CON_ID, SVR_IP, NAME, VALUE\nFROM oceanbase.GV$SYSSTAT\nWHERE CON_ID = 1004\n  AND NAME IN ('sql select count','tps','db time');`,
    note: '租户维度靠 CON_ID 过滤（GV$SYSSTAT.CON_ID = DBA_OB_TENANTS.TENANT_ID）；「MemStore 使用率」「缓存命中率」类指标在 OCP 侧由 Agent 的监控插件计算后落库，OB 视图里没有同名项，需要到 ob_hist_* 系列表按租户查'
  },
  moHost: {
    title: '主机性能曲线',
    api: 'GET /api/v2/monitor/metric?scope=HOST&metrics=…&groupBy=host',
    scope: '所选主机的 CPU / 内存 / load1 / 磁盘读写 IOPS',
    origin: { ...MON_ORIGIN, table: 'metric_data_second（OS 指标）' },
    note: '主机指标不是 OB 的视图数据：由 OCP-Agent（monitor_port）在 OS 层采集 node_exporter 风格指标后写入监控库，所以没有等价的 SQL。要复核可登录主机看 top / vmstat / iostat，或查 OBAgent 的采集端口'
  }
}
