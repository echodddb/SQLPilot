/**
 * 主机页各列的采集来源。
 */
import { META_CLUSTER, META_DB, META_TENANT, type SourceInfo } from './types'

export const HT_SOURCES: Record<string, SourceInfo> = {
  htList: {
    title: '主机台账',
    api: 'GET /api/v2/compute/hosts（含 agent / 承载服务）',
    scope: 'OCP 纳管的全部主机（物理机 / 容器 / OBProxy 主机）',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'compute_host',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT id, name, alias, inner_ip_address, ssh_port, status,\n       operating_system, architecture, kind, create_time\nFROM ocp.compute_host;`,
    note: '主机由 OCP 在纳管时录入并由 Agent 上报心跳；status=ONLINE 在线 / OFFLINE 离线 / AGENT_RESTARTING Agent 重启中；kind 区分物理机、容器等机型类别。MetaDB 租户/库名随部署而定'
  },
  htAgent: {
    title: 'OCP-Agent 状态',
    api: 'GET /api/v2/compute/hosts（agent 字段）',
    scope: '每台主机上 OCP-Agent 的心跳与版本',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'compute_host_agent',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT host_id, version, status, last_available_time, monitor_port\nFROM ocp.compute_host_agent;`,
    note: 'status=AVAILABLE 表示心跳正常，另有 OFFLINE / RESTARTING；last_available_time 长期不更新会被判为异常。OBServer 的启停、参数下发都依赖 Agent，所以主机在线但 Agent 异常时运维动作会失败'
  },
  htService: {
    title: '承载服务',
    api: 'GET /api/v2/compute/hosts（services）',
    scope: '该主机上运行的 OBServer / OBProxy 实例',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'compute_host_service',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT h.inner_ip_address, s.type, s.name, s.version\nFROM ocp.compute_host h\nJOIN ocp.compute_host_service s ON s.host_id = h.id;`,
    note: 'type=OB_CLUSTER 是 OBServer，OB_PROXY 是 OBProxy；name 形如「集群名:ob_cluster_id」，界面只显示冒号前的集群名'
  },
  htHost: {
    title: '主机属性',
    api: 'GET /api/v2/compute/hosts',
    scope: '机型、区域 / IDC、操作系统、SSH 端口',
    note: '这些是 OS 层与机房台账信息，由 OCP-Agent 上报 + 人工维护，OB 数据库里没有等价表，所以不查库。操作系统串取 uname，区域/IDC 来自 OCP 的机房配置（idc / maz_azone）'
  }
}
