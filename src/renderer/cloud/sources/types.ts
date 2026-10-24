/**
 * 「采集来源」目录的公共类型与位置常量。
 *
 * 采集链路：SQLPilot 调 OCP REST 接口 → OCP 从各集群的 sys 租户（oceanbase 库系统视图）/
 * 自身元数据库（MetaDB）/ OCP-Agent 取数。origin 描述数据最终落在哪：哪个租户、哪个库、哪张表；
 * sql 是可在该位置直接执行的等价查询（全部在 OCP 4.4 + OB 4.3 真机逐条实测过）。
 */

export interface SourceOrigin {
  /** 查询所在租户（OB 系统视图都在 sys 租户；OCP 元数据在 MetaDB 的 meta 租户） */
  tenant?: string
  /** 查询所在库（schema） */
  db?: string
  /** 查询的表/视图 */
  table?: string
  /** 是否每个集群各查一份（配合明细行的集群名） */
  perCluster?: boolean
  /** 查询所在的集群标签（默认「各集群/目标集群」；元数据库类数据指定为 MetaDB 集群） */
  cluster?: string
  /** 该位置是否是示意值（MetaDB 租户/库名可自定义，需按实际环境替换） */
  placeholder?: boolean
}

export interface SourceInfo {
  title: string
  /** SQLPilot 的采集方式（OCP 接口） */
  api: string
  /** 采集范围 */
  scope?: string
  /** 查询位置：租户 → 库 → 表（非 OB 表的数据不填，用 note 说明） */
  origin?: SourceOrigin
  /** 等价参考 SQL（必须在 origin 指定的位置实测可执行） */
  sql?: string
  /** 补充说明（字段含义、枚举值、注意事项） */
  note?: string
}

/** OB 系统视图位置：固定为 sys 租户的 oceanbase 库，任何集群都一样，可直接写死 */
export const SYS_TENANT = 'sys 租户'
export const OB_DB = 'oceanbase 库'

/** OCP 自身元数据库（MetaDB）：租户名/库名/集群名随部署自定义，一律标 placeholder */
export const META_CLUSTER = 'MetaDB 集群'
export const META_TENANT = 'meta 租户（示意）'
export const META_DB = 'ocp 库（示意）'

/** OCP 监控数据（与 MetaDB 同集群的另一个租户/库） */
export const MONITOR_CLUSTER = 'MetaDB 集群'
export const MONITOR_TENANT = 'monitor 租户（示意）'
export const MONITOR_DB = 'ocp_monitor 库（示意）'
