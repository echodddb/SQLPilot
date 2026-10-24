/**
 * 租户页（跨集群列表 + 租户抽屉）各数据块的采集来源。
 */
import { META_CLUSTER, META_DB, META_TENANT, OB_DB, SYS_TENANT, type SourceInfo } from './types'

export const TN_SOURCES: Record<string, SourceInfo> = {
  tnList: {
    title: '租户台账',
    api: 'GET /api/v2/ob/tenants（跨集群一次性拉取）',
    scope: '全部集群的业务租户：模式、状态、角色、主 Zone、副本分布',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ob_tenant',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT t.id, t.name, t.ob_tenant_id, t.mode, t.status, t.role,\n       t.primary_zone, t.locality, t.is_locked, t.is_read_only, t.create_time,\n       c.name AS cluster_name\nFROM ocp.ob_tenant t\nJOIN ocp.ob_cluster c ON c.id = t.cluster_id;`,
    note: 'OCP 从每个集群的 DBA_OB_TENANTS 同步落库；「只读」看 is_read_only=1、「已锁定」看 is_locked=1，角色 PRIMARY/STANDBY 来自 tenant_role。mode=ORACLE 的租户走 Oracle 兼容模式'
  },
  tnReplica: {
    title: '副本与资源池',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}（副本 + units）',
    scope: '该租户每个 Zone 的副本类型、资源池、Unit 数量与规格、Unit 落在哪台 OBServer',
    origin: {
      tenant: SYS_TENANT,
      db: OB_DB,
      table: 'DBA_OB_RESOURCE_POOLS / GV$OB_UNITS',
      perCluster: false
    },
    sql: `-- 在该集群的 sys 租户执行（TENANT_ID 换成租户的 OB 租户 ID，如 1004）：\n-- 资源池与副本类型\nSELECT NAME, UNIT_COUNT, ZONE_LIST, REPLICA_TYPE, UNIT_CONFIG_ID, TENANT_ID\nFROM oceanbase.DBA_OB_RESOURCE_POOLS WHERE TENANT_ID = 1004;\n-- Unit 落点\nSELECT TENANT_ID, ZONE, SVR_IP, SVR_PORT, UNIT_ID, MAX_CPU, MIN_CPU, MEMORY_SIZE, STATUS\nFROM oceanbase.GV$OB_UNITS WHERE TENANT_ID = 1004;`,
    note: '每个 Zone 一条资源池，REPLICA_TYPE=FULL / READONLY / LOGONLY；Unit 是 Zone 内的资源切片。改副本走 modifyReplica（整份副本列表提交），加/删副本走 addReplica / deleteReplica'
  },
  tnParams: {
    title: '租户参数',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/parameters',
    scope: '该租户在每台 OBServer 上的参数当前值',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_PARAMETERS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（TENANT_ID 换成租户的 OB 租户 ID）：\nSELECT TENANT_ID, SVR_IP, NAME, VALUE, SECTION, EDIT_LEVEL\nFROM oceanbase.GV$OB_PARAMETERS\nWHERE TENANT_ID = 1004\nORDER BY SECTION, NAME;`,
    note: '修改参数是 PUT .../parameters，body 为 [{name,value}]；默认值与是否只读等元数据来自 MetaDB ob_tenant_parameter_info。改 VALUE 后需注意 EDIT_LEVEL 与是否需重启'
  },
  tnSessions: {
    title: '租户会话',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/sessions',
    scope: '该租户当前所有会话（含 OBProxy 接入的会话）',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_PROCESSLIST', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（TENANT 列写租户名）：\nSELECT ID, USER, HOST, DB, TENANT, COMMAND, TIME, STATE, INFO\nFROM oceanbase.GV$OB_PROCESSLIST\nWHERE TENANT = 'obmysql';`,
    note: 'sys 租户的 GV$OB_PROCESSLIST 能看到全集群会话，用 TENANT 列区分租户；结束会话等价于 KILL，OCP 走 POST .../sessions/close {sessionIds}'
  },
  tnWhitelist: {
    title: '访问白名单',
    api: 'POST /api/v2/ob/clusters/{cid}/tenants/{tid}/modifyWhitelist',
    scope: '该租户允许连接的来源地址（IP / CIDR，% 表示不限制）',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ob_whitelist_group',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT g.tenant_id, g.name, g.ip_list, t.name AS tenant_name\nFROM ocp.ob_whitelist_group g\nLEFT JOIN ocp.ob_tenant t ON t.id = g.tenant_id\nWHERE g.tenant_id IS NOT NULL;`,
    note: 'OCP 把白名单按租户存在 ob_whitelist_group.ip_list，下发到租户的系统变量 ob_tcp_invited_nodes；在租户内可用 SHOW VARIABLES LIKE 复核。built_in=1 的是 OCP 自带的内置组（如 ocp-server）'
  },

  // ---- 租户详情工作台（2026-10-21 新增，对齐 OCP 租户详情各 tab） ----

  tnBasic: {
    title: '租户基本信息',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}（含 charset / collation / role / zoneList）',
    scope: '该租户的兼容模式、租户角色、主 Zone、Locality、状态、锁定与只读标记',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'DBA_OB_TENANTS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（TENANT_ID 换成租户的 OB 租户 ID，如 1004）：\nSELECT TENANT_ID, TENANT_NAME, TENANT_TYPE, COMPATIBILITY_MODE,\n       STATUS, LOCKED, TENANT_ROLE, SWITCHOVER_STATUS,\n       PRIMARY_ZONE, LOCALITY, UNIT_NUM, LOG_MODE, CREATE_TIME\nFROM oceanbase.DBA_OB_TENANTS\nWHERE TENANT_ID = 1004;`,
    note: '兼容模式看 COMPATIBILITY_MODE（MYSQL / ORACLE，决定 SQL 语法与系统视图）；租户角色看 TENANT_ROLE（PRIMARY / STANDBY），没有 ROLE 列；字符集与排序规则在 OCP 元数据库里，不在该视图'
  },
  tnDatabases: {
    title: '租户内数据库',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/databases',
    scope: '该租户内所有库、字符集、数据量、连接串（直连与 OBProxy 两种）',
    origin: { tenant: '#TENANT# 租户本身', db: 'information_schema 库', table: 'SCHEMATA', perCluster: false },
    sql: `-- 直连该租户执行（root@租户名#集群名，如 root@obmysql#obc）：\nSELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME\nFROM information_schema.SCHEMATA\nORDER BY SCHEMA_NAME;`,
    note: 'OCP 额外返回每个库的 requiredSize（逻辑数据量）与 connectionUrls；连接串由 OBProxy 地址或 OBServer 直连地址拼出，跟库本身无关'
  },
  tnTables: {
    title: '库内表清单',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/database/{dbName}',
    scope: '指定库下的表、分区数、行数、数据量、宏块利用率',
    origin: { tenant: '#TENANT# 租户本身', db: 'information_schema 库', table: 'TABLES + oceanbase.CDB_OB_TABLE_LOCATIONS', perCluster: false },
    sql: `-- 直连该租户执行（分区数信息在 sys 租户的 CDB_OB_TABLE_LOCATIONS）：\nSELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = '你的库名'\nORDER BY DATA_LENGTH DESC;\n\n-- 分区数（在该集群的 sys 租户执行，TENANT_ID=租户的 OB 租户 ID）：\nSELECT TABLE_NAME, COUNT(*) AS partitions\nFROM oceanbase.CDB_OB_TABLE_LOCATIONS\nWHERE TENANT_ID = 1004 AND DATABASE_NAME = '你的库名'\nGROUP BY TABLE_NAME;`,
    note: 'information_schema.TABLES 没有 PARTITION_COUNT 列（实测），分区数要按 CDB_OB_TABLE_LOCATIONS 统计；TABLE_ROWS 是统计值，可能滞后于真实行数'
  },
  tnSessionStats: {
    title: '会话分布统计',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/sessions/stats',
    scope: '该租户的会话总数 / 活跃数，按用户、库、客户端 IP 三向聚合',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_PROCESSLIST', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（COMMAND='Sleep' 视为空闲会话）：\nSELECT USER, DB, HOST, COUNT(*) AS total,\n       SUM(COMMAND <> 'Sleep') AS active\nFROM oceanbase.GV$OB_PROCESSLIST\nWHERE TENANT = 'obmysql'\nGROUP BY USER, DB, HOST WITH ROLLUP;`,
    note: 'OCP 的 totalCount / activeCount / maxActiveTime 都由该视图聚合；maxActiveTime 取 MAX(TIME)'
  },
  tnTxns: {
    title: '活动事务',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/transactions',
    scope: '该租户内持续时间超过阈值的事务（threshold 由界面选择，默认不限）',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_TRANSACTION_SCHEDULERS / GV$OB_TRANSACTION_PARTICIPANTS', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行：\n-- 事务调度器（每个事务一行，含隔离级别与状态）\nSELECT TENANT_ID, SVR_IP, SESSION_ID, TX_ID, STATE, ISOLATION_LEVEL, ACCESS_MODE\nFROM oceanbase.GV$OB_TRANSACTION_SCHEDULERS\nWHERE TENANT_ID = 1004;\n\n-- 参与者（分区级明细，看事务落在哪些日志流）\nSELECT TENANT_ID, SVR_IP, SESSION_ID, TX_ID, LS_ID, STATE, CTX_CREATE_TIME\nFROM oceanbase.GV$OB_TRANSACTION_PARTICIPANTS\nWHERE TENANT_ID = 1004;`,
    note: 'OB 没有 V$OB_TRANSACTIONS 视图（实测不存在）；判断长事务用 CTX_CREATE_TIME 与当前时间差。结束事务走 OCP 的 transactions/batchClose，body 是 {transSessionList:[{sessionId, transId}]}'
  },
  tnSql: {
    title: 'SQL 诊断（TopSQL / 慢 SQL / 新增 / 高危 / 并行）',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/topSql、/slowSql、/newSql、/highRiskSql、/parallelSql',
    scope: '该租户在所选时间窗内的 SQL 聚合指标（执行次数、耗时、CPU 占比、失败次数）',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'GV$OB_SQL_AUDIT', perCluster: false },
    sql: `-- 在该集群的 sys 租户执行（TENANT_ID=租户的 OB 租户 ID，近 1 小时）：\nSELECT SQL_ID, LEFT(QUERY_SQL, 200) AS sql_text, COUNT(*) AS executions,\n       SUM(ELAPSED_TIME) AS sum_us, AVG(ELAPSED_TIME) AS avg_us, MAX(ELAPSED_TIME) AS max_us,\n       SUM(CASE WHEN RET_CODE <> 0 THEN 1 ELSE 0 END) AS fail_count\nFROM oceanbase.GV$OB_SQL_AUDIT\nWHERE TENANT_ID = 1004\n  AND REQUEST_TIME > DATE_SUB(NOW(), INTERVAL 1 HOUR)\nGROUP BY SQL_ID, LEFT(QUERY_SQL, 200)\nORDER BY sum_us DESC\nLIMIT 50;`,
    note: 'GV$OB_SQL_AUDIT 没有 EXECUTIONS 列，执行次数用 COUNT(*) 代替；OCP 返回的耗时字段全是微秒（含名字带 Ms 的字段）。parallelSql 服务端限制时间窗 ≤ 24h'
  },
  tnCompaction: {
    title: '合并状态与历史',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/compaction、/compactionSettings、/recentCompactions、/miniCompactions',
    scope: '该租户当前合并状态、每日合并设置、主合并与转储历史',
    origin: { tenant: SYS_TENANT, db: OB_DB, table: 'CDB_OB_MAJOR_COMPACTION / GV$OB_MEMSTORE', perCluster: false },
    sql: `-- 主合并（在该集群的 sys 租户执行）：\nSELECT TENANT_ID, STATUS, IS_ERROR, IS_SUSPENDED, START_TIME, LAST_FINISH_TIME,\n       FROZEN_SCN, GLOBAL_BROADCAST_SCN, INFO\nFROM oceanbase.CDB_OB_MAJOR_COMPACTION\nWHERE TENANT_ID = 1004;\n\n-- 冻结与转储水位\nSELECT TENANT_ID, SVR_IP, FROZEN_SCN, FREEZE_CNT, ACTIVE_MEMSTORE_USED, TOTAL_MEMSTORE_USED\nFROM oceanbase.GV$OB_MEMSTORE\nWHERE TENANT_ID = 1004;`,
    note: '合并设置（freezeTriggerPercentage / majorFreezeDutyTime）是租户级系统参数，OCP 存在自己库里并按需下发；IS_SUSPENDED=1 即挂起。每日合并时间点对应租户参数 major_freeze_duty_time'
  },
  tnGather: {
    title: '统计信息收集情况',
    api: 'GET /api/v2/stats/gather/overview/{tid}、/table/{tid}、/auto/{tid}、/prefs/{tid}',
    scope: '该租户各表的统计信息收集时间与过期状态、自动收集窗口、收集策略参数',
    origin: { tenant: '#TENANT# 租户本身', db: OB_DB, table: 'DBA_TAB_STATISTICS', perCluster: false },
    sql: `-- 直连该租户执行（本租户的统计信息在租户内视图）：\nSELECT OWNER, TABLE_NAME, NUM_ROWS, LAST_ANALYZED, STALE_STATS\nFROM oceanbase.DBA_TAB_STATISTICS\nORDER BY LAST_ANALYZED DESC\nLIMIT 100;\n\n-- 列级统计\nSELECT OWNER, TABLE_NAME, COLUMN_NAME, NUM_DISTINCT, NUM_NULLS, LAST_ANALYZED\nFROM oceanbase.DBA_TAB_COL_STATISTICS\nLIMIT 50;`,
    note: 'STALE_STATS=YES 表示统计信息过期；自动收集窗口来自租户的维护窗口（MONDAY_WINDOW…SUNDAY_WINDOW）。手动收集走 DBMS_STATS.GATHER_TABLE_STATS，OCP 的 manual 接口需要 owner 参数'
  },
  tnUsers: {
    title: '租户内数据库用户',
    api: 'GET /api/v2/ob/clusters/{cid}/tenants/{tid}/users',
    scope: '租户内各用户、可访问库、全局权限、库级权限、连接串',
    origin: { tenant: '#TENANT# 租户本身', db: 'mysql 库', table: 'user + db 表（MySQL 模式）', perCluster: false },
    sql: `-- 直连该租户执行（MySQL 模式）：\nSELECT user, host, account_locked, super_priv, grant_priv, create_priv\nFROM mysql.user;\n\n-- 库级权限\nSELECT user, host, db, select_priv, insert_priv, update_priv, delete_priv, create_priv, drop_priv\nFROM mysql.db;`,
    note: 'MySQL 模式的锁标记列叫 account_locked（没有 IS_LOCKED 列，实测）；密码在 authentication_string。Oracle 模式租户的用户与角色在 DBA_USERS / DBA_ROLES，且 OCP 的 roles 接口对 MySQL 租户直接返回「不支持该操作」'
  },
  tnUnitSpec: {
    title: 'Unit 资源规格',
    api: 'GET /api/v2/ob/unitSpecs（POST 新建 / PUT、DELETE /{specId}）',
    scope: 'OCP 全局的 Unit 规格定义（内置 SYSTEM + 自定义 CUSTOM），创建租户与扩缩容时引用',
    origin: { tenant: META_TENANT, db: META_DB, table: 'ob_unit_spec', cluster: META_CLUSTER, placeholder: true },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（库名为示意，按实际环境替换）：\n-- 注意：表里 max_memory / min_memory 存的是字节，REST 接口返回的是 GiB\nSELECT id, name, type, min_cpu, max_cpu,\n       min_memory / 1024 / 1024 / 1024 AS min_mem_gib,\n       max_memory / 1024 / 1024 / 1024 AS max_mem_gib,\n       log_disk_size, min_iops, max_iops, iops_weight, \`group\`, creator, update_time\nFROM ocp.ob_unit_spec\nORDER BY id;`,
    note: 'type 有三类：SYSTEM（OCP 内置，不可改删）、CUSTOM（界面新建的）、另有 group=basic 等分组。REST 把内存换算成 GiB 返回；MetaDB 里是字节。规格被租户资源池引用时删除会被拒绝'
  }
}
