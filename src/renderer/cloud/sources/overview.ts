/**
 * 总览页各指标的「采集来源」目录。
 * key 与 OverviewPane 里元素的 data-src 一一对应。
 */
import {
  OB_DB,
  META_CLUSTER,
  META_DB,
  META_TENANT,
  SYS_TENANT,
  type SourceInfo
} from './types'

export const OV_SOURCES: Record<string, SourceInfo> = {
  clusters: {
    title: 'OB 集群数',
    api: 'GET /api/v2/ob/clustersView（含资源统计）',
    scope: '当前 OCP 纳管的全部 OB 集群',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'DBA_OB_SERVERS', perCluster: true },
    sql: `-- 在每个集群的 sys 租户执行：\nSELECT SVR_IP, SVR_PORT, ZONE, STATUS, WITH_ROOTSERVER\nFROM oceanbase.DBA_OB_SERVERS;`,
    note: '「运行中」= OCP 返回的 status 为 RUNNING 的集群数；OB 无 DBA_OB_CLUSTERS 视图，集群身份由 rootserver（WITH_ROOTSERVER=YES）定位'
  },
  tenants: {
    title: '租户数',
    api: 'GET /api/v2/ob/clusters/{id}/tenants（逐集群汇总）',
    scope: '全部集群下的主租户（PRIMARY）与备租户',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'DBA_OB_TENANTS', perCluster: true },
    sql: `-- 在每个集群的 sys 租户执行：\nSELECT TENANT_ID, TENANT_NAME, TENANT_TYPE, STATUS, LOCALITY, TENANT_ROLE\nFROM oceanbase.DBA_OB_TENANTS;`,
    note: 'sys 内部租户不计入 KPI；每个集群的租户分布见下方明细'
  },
  hosts: {
    title: '主机数',
    api: 'GET /api/v2/compute/hosts',
    scope: 'OCP 纳管的全部主机',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'compute_host / compute_host_agent',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\n-- 主机列表与在线状态\nSELECT id, name, inner_ip_address, operating_system, status\nFROM ocp.compute_host;\n-- Agent 心跳（在线/可用）\nSELECT host_id, version, status, last_available_time\nFROM ocp.compute_host_agent;`,
    note: '主机在线/Agent 状态由 OCP-Agent 在 OS 层采集上报；status=ONLINE 表示主机在线，Agent 的 status=AVAILABLE 表示心跳正常。MetaDB 租户/库名随部署而定，非固定'
  },
  alarms: {
    title: '活跃告警',
    api: 'GET /api/v2/alarm/alarms/actived',
    scope: 'OCP 全部对象（集群/租户/主机/OBProxy）当前未恢复的告警',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ocp2_alarm_event / ocp2_alarm_event_history',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\n-- 当前活跃告警（未恢复）\nSELECT alarm_type, app_type, scope, level, status, target, summary\nFROM ocp.ocp2_alarm_event WHERE status = 'Active';`,
    note: '告警由 OCP 告警服务按 ocp2_alarm_rule 规则检测产生；status=Active 表示活跃、Resolved 表示已恢复（转 ocp2_alarm_event_history）；level 1=严重 2=警告 3=注意'
  },
  cpu: {
    title: 'CPU 已分配',
    api: 'GET /api/v2/ob/clustersView（resourceStats）',
    scope: '全部集群租户 Unit 的 CPU 分配量 / 主机可分配总量',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_UNITS / GV$OB_SERVERS', perCluster: true },
    sql: `-- 在每个集群的 sys 租户执行：\n-- Unit 分配（已分配）\nSELECT TENANT_ID, ZONE, SVR_IP, MAX_CPU, MIN_CPU FROM oceanbase.GV$OB_UNITS;\n-- 主机容量（可分配 / 已分配）\nSELECT SVR_IP, ZONE, CPU_CAPACITY, CPU_ASSIGNED, MEM_CAPACITY, MEM_ASSIGNED\nFROM oceanbase.GV$OB_SERVERS;`,
    note: '是「分配率」不是「使用率」：接近 100% 属正常，表示资源已规划满'
  },
  info: {
    title: 'OCP 版本',
    api: 'GET /api/v2/info',
    scope: 'OCP 平台自身',
    note: 'OCP 服务端直接返回 buildVersion / edition，不查数据库'
  },
  clusterCap: {
    title: '集群容量',
    api: 'GET /api/v2/ob/clusters/stats（按集群聚合）',
    scope: '该集群全部 OBServer 的 CPU / 内存 / 数据盘水位',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_SERVERS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行：\nSELECT SVR_IP, ZONE, CPU_CAPACITY, CPU_ASSIGNED,\n       MEM_CAPACITY, MEM_ASSIGNED,\n       DATA_DISK_CAPACITY, DATA_DISK_IN_USE\nFROM oceanbase.GV$OB_SERVERS;`,
    note: 'CPU/内存为 Unit 分配水位，数据盘为实际占用（≥90% 标红）；注意数据盘看 DATA_DISK_IN_USE，不是 LOG_DISK_*'
  },
  alarmList: {
    title: '活跃告警列表',
    api: 'GET /api/v2/alarm/alarms/actived',
    scope: '按告警级别（1 严重 / 2 警告 / 3 注意）排序',
    origin: { tenant: META_TENANT, db: META_DB, table: 'ocp2_alarm_event', cluster: META_CLUSTER, placeholder: true },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT alarm_type, app_type, scope, level, status, target, summary\nFROM ocp.ocp2_alarm_event WHERE status = 'Active'\nORDER BY level, active_at;`,
    note: '存 OCP 元数据库（MetaDB）；告警对象（app_type/scope/target）标明来自集群、租户还是主机'
  },
  taskList: {
    title: '最近任务',
    api: 'GET /api/v2/tasks/instances',
    scope: 'OCP 运维任务流水（创建/变更/合并等）',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'task_instance / subtask_instance',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\n-- 顶层任务流水\nSELECT id, name, operation, state, start_time, end_time\nFROM ocp.task_instance ORDER BY start_time DESC LIMIT 20;\n-- 子任务进度\nSELECT task_id, name, state, run_time, start_time, end_time\nFROM ocp.subtask_instance;`,
    note: '任务实例存 OCP 元数据库（MetaDB）：顶层任务在 task_instance（state=SUCCESSFUL/FAILED/RUNNING），子任务在 subtask_instance'
  }
}
