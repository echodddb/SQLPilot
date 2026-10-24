/**
 * 集群页（列表 + 详情）各数据块的采集来源。
 * 集群台账、容量水位、Zone/OBServer/租户、参数、启动参数分别来自不同位置，分开登记。
 */
import { META_CLUSTER, META_DB, META_TENANT, OB_DB, SYS_TENANT, type SourceInfo } from './types'

export const CL_SOURCES: Record<string, SourceInfo> = {
  clList: {
    title: 'OB 集群台账',
    api: 'GET /api/v2/ob/clustersView（集群列表）+ /api/v2/ob/clusters/alarmSummaries（告警数）',
    scope: 'OCP 纳管的全部 OB 集群（含承载 MetaDB 的集群）',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ob_cluster / ob_server',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT c.id, c.name, c.ob_cluster_id, c.status, c.ob_version, c.cluster_mode,\n       c.create_time, COUNT(s.id) AS server_cnt\nFROM ocp.ob_cluster c\nLEFT JOIN ocp.ob_server s ON s.cluster_id = c.id\nGROUP BY c.id, c.name, c.ob_cluster_id, c.status, c.ob_version, c.cluster_mode, c.create_time;`,
    note: '集群台账由 OCP 巡检同步落库；status=RUNNING 表示集群可用，rootserver 取 ob_server.is_with_rootserver=1。表里的 CPU/内存/盘是容量水位，来自各集群 GV$OB_SERVERS（见「集群容量」）'
  },
  clMeta: {
    title: '集群属性',
    api: 'GET /api/v2/ob/clusters/{id}（含 attributes / 区域数）',
    scope: '该集群的身份信息：OBClusterID、版本、模式、来源、创建人、创建时间',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ob_cluster.attributes_json',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT id, name, ob_cluster_id, ob_version, cluster_mode, origin, creator, create_time, attributes_json\nFROM ocp.ob_cluster\nWHERE name = 'obc';`,
    note: 'OBClusterID 是 OB 内部集群 ID（创建后不变），OCP 侧的 id 是平台主键；origin=CREATED 表示 OCP 创建、TAKE_OVER 表示接管；「区域数」来自 OCP 机房台账 ob_cluster_idc_info'
  },
  clTopology: {
    title: '拓扑与副本分布',
    api: 'GET /api/v2/ob/clusters/{id}/{zones,servers,tenants}（三份数据合成）',
    scope: 'Zone 归属、OBServer 落点、每个租户在各 Zone 的副本类型',
    origin: {
      tenant: SYS_TENANT,
      db: OB_DB,
      table: 'DBA_OB_ZONES / DBA_OB_SERVERS / DBA_OB_TENANTS.LOCALITY',
      perCluster: false
    },
    sql: `-- 在该集群的 sys 租户执行：\n-- Zone 与 OBServer 落点\nSELECT z.ZONE, z.STATUS, z.IDC, z.REGION, s.SVR_IP, s.STATUS AS SVR_STATUS\nFROM oceanbase.DBA_OB_ZONES z\nLEFT JOIN oceanbase.DBA_OB_SERVERS s ON s.ZONE = z.ZONE;\n-- 每个租户的副本分布\nSELECT TENANT_ID, TENANT_NAME, PRIMARY_ZONE, LOCALITY\nFROM oceanbase.DBA_OB_TENANTS WHERE TENANT_TYPE <> 'SYS';`,
    note: 'LOCALITY 形如 FULL{1}@zone1,READONLY{1}@zone2，矩阵就是按 Zone 拆开它；副本数少于 Zone 数说明该租户在部分 Zone 没有副本（容灾覆盖不全，数字标黄）。META$ 开头的是内部 meta 子租户，不参与矩阵'
  },
  clZones: {
    title: 'Zone 列表',
    api: 'GET /api/v2/ob/clusters/{id}/zones',
    scope: '该集群全部 Zone 的状态、机房与 Region',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'DBA_OB_ZONES', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行：\nSELECT ZONE, STATUS, IDC, REGION, TYPE\nFROM oceanbase.DBA_OB_ZONES;`,
    note: 'Zone 状态 STATUS=ACTIVE 表示可用；IDC / REGION 是 Zone 建立时写入的机房信息。OCP 侧缓存在 MetaDB ob_zone，rootserver 所在 Zone 另由 ob_server.is_with_rootserver 标出'
  },
  clServers: {
    title: 'OBServer 进程',
    api: 'GET /api/v2/ob/clusters/{id}/servers',
    scope: '该集群全部 OBServer 的 IP、Zone、进程状态、版本、启动时间',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'DBA_OB_SERVERS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行：\nSELECT SVR_IP, SVR_PORT, ZONE, STATUS, WITH_ROOTSERVER, BUILD_VERSION, START_SERVICE_TIME\nFROM oceanbase.DBA_OB_SERVERS;`,
    note: '「进程状态」取 DBA_OB_SERVERS.STATUS（ACTIVE / INACTIVE）；「主机状态」不是 OB 字段，来自 MetaDB compute_host.status（用 ob_server.host_id 关联）'
  },
  clTenants: {
    title: '集群内租户',
    api: 'GET /api/v2/ob/clusters/{id}/tenants',
    scope: '该集群下的业务租户（sys 内部租户不列出）',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'DBA_OB_TENANTS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行：\nSELECT TENANT_ID, TENANT_NAME, TENANT_TYPE, COMPATIBILITY_MODE, STATUS,\n       TENANT_ROLE, PRIMARY_ZONE, LOCALITY, LOCKED\nFROM oceanbase.DBA_OB_TENANTS\nWHERE TENANT_TYPE <> 'SYS';`,
    note: 'TENANT_TYPE=SYS 是内部租户（ocp 另算可见性）；TENANT_ROLE=PRIMARY / STANDBY 区分主备租户；LOCALITY 即副本分布（FULL{1}@zone1,…）'
  },
  clParams: {
    title: '集群参数',
    api: 'GET /api/v2/ob/clusters/{id}/parameters',
    scope: '参数 × 租户 × 服务器 的展开值（每台 OBServer 各一份）',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_PARAMETERS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（TENANT_ID=1 即集群级参数）：\nSELECT TENANT_ID, SVR_IP, NAME, VALUE, SECTION, EDIT_LEVEL\nFROM oceanbase.GV$OB_PARAMETERS\nWHERE TENANT_ID = 1\nORDER BY SECTION, NAME;`,
    note: 'OCP 实时从各 OBServer 读取参数值，不落库；参数元数据（默认值、是否只读、是否需重启）来自 MetaDB ob_cluster_parameter_info。EDIT_LEVEL 表示可改级别'
  },
  clAlarm: {
    title: '集群告警数',
    api: 'GET /api/v2/ob/clusters/alarmSummaries（按集群聚合）',
    scope: '该集群当前未恢复的告警数，按级别拆分',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ocp2_alarm_event / ocp2_alarm_overview',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT app_type, scope, alarm_type, level, COUNT(*) AS cnt\nFROM ocp.ocp2_alarm_event\nWHERE status = 'Active'\nGROUP BY app_type, scope, alarm_type, level;`,
    note: '集群告警是 OCP 按 target / 对象归属把事件归到集群后聚合的；level 1=严重 2=警告 3=注意，界面按最严重的一级给数字着色'
  },
  clStartup: {
    title: '集群启动参数',
    api: 'GET /api/v2/ob/clusters/{id}（startupParameters）',
    scope: '创建集群时写入的 OBServer 启动参数',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ob_cluster.startup_parameters',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT id, name, startup_parameters\nFROM ocp.ob_cluster;`,
    note: 'startup_parameters 是 key=value$key=value 形式的一整串（如 cpu_count=6$memory_limit=12G$datafile_size=20G），OCP 在 OBServer 启动时按此下发；它和「集群参数」不是一回事'
  }
}
