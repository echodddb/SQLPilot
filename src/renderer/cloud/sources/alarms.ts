/**
 * 告警页 / 任务页的采集来源。
 * 顶层的 alarmList / taskList 在 overview.ts 里登记（总览页也在用），这里补页面级细分。
 */
import { META_CLUSTER, META_DB, META_TENANT, type SourceInfo } from './types'

export const AL_SOURCES: Record<string, SourceInfo> = {
  alarmHead: {
    title: '告警计数',
    api: 'GET /api/v2/alarm/overview/active（按级别聚合）',
    scope: '当前活跃告警按级别（1 严重 / 2 警告 / 3 注意）分组计数',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ocp2_alarm_event',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT level, COUNT(*) AS cnt\nFROM ocp.ocp2_alarm_event\nWHERE status = 'Active'\nGROUP BY level;`,
    note: '计数口径 = status 为 Active 的告警事件；恢复后记录转存 ocp2_alarm_event_history。页面上的筛选按钮只影响列表展示，不改查询'
  },
  alarmTarget: {
    title: '告警对象',
    api: 'GET /api/v2/alarm/alarms/{id}（alarmTarget.includeTargets）',
    scope: '告警来自哪个对象（集群 / 租户 / 主机 / OBProxy）',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ocp2_alarm_event.target',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT id, level, status, scope, alarm_type, app_type, target, summary, active_at\nFROM ocp.ocp2_alarm_event\nWHERE status = 'Active'\nORDER BY level, active_at DESC;`,
    note: 'target 是采集端拼的定位串，形如 alarm_template_id=0:host=192.168.1.10；详情接口的 alarmTarget.includeTargets 才是结构化的对象（hosts[] / cluster + tenants[]），界面优先用后者；app_type 标明来源（OCP 自身 / OB 集群 / OBProxy）'
  },
  alarmTrend: {
    title: '告警趋势分布',
    api: 'GET /api/v2/alarm/alarms/history（activeAtStart/activeAtEnd 时间窗）+ 主进程按小时分桶',
    scope: '近 24 小时（跟随页面时间筛选）已恢复告警：每小时条数、对象类型分布、Top 告警类型',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ocp2_alarm_event_history',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT DATE_FORMAT(active_at, '%Y-%m-%d %H:00') AS hour_bucket, level, COUNT(*) AS cnt\nFROM ocp.ocp2_alarm_event_history\nWHERE active_at >= NOW() - INTERVAL 24 HOUR\nGROUP BY hour_bucket, level\nORDER BY hour_bucket;`,
    note: 'OCP 没有现成的趋势接口，因此取历史告警一页 500 条在本地分桶（24h 实测 150 条；超过 500 条时界面会标注「仅统计最近 500 条」）。活跃告警在 ocp2_alarm_event，已恢复的才进 _history'
  },
  alarmRules: {
    title: '告警规则',
    api: 'GET /api/v2/alarm/rules（服务端支持 level / scope / keyword / isEnabled）',
    scope: '规则清单、检测表达式、评估间隔、持续与恢复超时、生效对象',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'ocp2_alarm_rule + ocp_alarm_detect_rule',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT id, name1 AS name, alarm_type, app_type, scope, level, is_enabled, is_build_in,\n       duration_seconds, evaluation_interval_seconds, resolve_timeout_seconds\nFROM ocp.ocp2_alarm_rule\nORDER BY level, id;\n\n-- 单个规则的检测表达式（按 alarm_type 关联，不是 rule_id）\nSELECT id, alarm_type, alarm_metric, expression, level, duration_seconds\nFROM ocp.ocp_alarm_detect_rule\nWHERE alarm_type = 'ob_tenant_session_kill_delay';`,
    note: '规则名是 i18n 三列 name1/name2/name3（简/繁/英），接口只返回当前语言；检测规则表用 alarm_type 与规则关联。页面上规则为只读，新建/启停/改阈值未开放'
  }
}

export const TK_SOURCES: Record<string, SourceInfo> = {
  taskDetail: {
    title: '任务详情与子任务时间轴',
    api: 'GET /api/v2/tasks/instances/{id}',
    scope: '单个任务：执行器、创建/开始/结束时间、每步子任务的耗时与依赖（upstreams / downstreams）',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'task_instance + subtask_instance',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT t.id, t.name, t.state, t.creator, t.executor, t.start_time, t.end_time,\n       ts.name AS step, ts.state AS step_state, ts.operation, ts.node_type,\n       ts.start_time, ts.end_time, ts.run_time, ts.timeout, ts.parallel_idx\nFROM ocp.task_instance t\nLEFT JOIN ocp.subtask_instance ts ON ts.task_id = t.id\nWHERE t.id = 12002190\nORDER BY ts.id;`,
    note: '子任务按 task_id 关联；run_time 单位是秒，parallel_idx 相同的子任务属于同一并行分支（详情页的「并行」计数就来自它）。任务表 type 有 MANUAL / SCHEDULED / SYS_ONCE / SYS_SCHEDULED，OCP 任务页默认只列 MANUAL'
  },
  taskSubtask: {
    title: '子任务进度',
    api: 'GET /api/v2/tasks/instances（列表内嵌精简 subtasks）+ /{id}（含耗时与依赖）',
    scope: '任务执行进度：已完成子任务数 / 总子任务数',
    origin: {
      tenant: META_TENANT,
      db: META_DB,
      table: 'subtask_instance',
      cluster: META_CLUSTER,
      placeholder: true
    },
    sql: `-- 在 OCP MetaDB 的 meta 租户执行（租户/库名为示意，按实际环境替换）：\nSELECT state, COUNT(*) AS cnt\nFROM ocp.subtask_instance\nWHERE task_id = 12002190\nGROUP BY state;`,
    note: '进度口径 = state 为 SUCCESSFUL 的子任务数 / 子任务总数（与 OCP 列表的 6/6 一致）；失败的任务会把 FAILED 计入已结束，进度条标红'
  }
}
