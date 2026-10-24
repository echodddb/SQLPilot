/**
 * Oracle 看板的取数实现：每个分区一个 fetch 函数，只查它自己需要的视图。
 *
 * SQL 全部在 Oracle 11.2.0.4 / 19c 上实测过（11.2 的差异点写在注释里）：
 * - 11.2 没有 banner_full、v$pdbs、v$containers、v$cluster、v$asm_instance
 * - 11.2 不支持 fetch first N rows only，统一用 rownum
 * - v$undostat 在 11.2 的列名是 ACTIVEBLKS/UNEXPIREDBLKS（不是 NACTIVEBL/NACTIVETXN）
 * - v$archive_dest_status 没有 AFFIRM / DELAY_MINS
 * 任何一项缺权限都不影响其它分区：断言失败只记一条 warnings。
 */

import { oraQuery, oraScalar } from './conn'
import type {
  OraAlerts,
  OraEnvSummary,
  OraBackup,
  OraDg,
  OraInfo,
  OraInstanceDetail,
  OraInstanceRow,
  OraJobs,
  OraOverview,
  OraParams,
  OraPdbSection,
  OraPerf,
  OraRac,
  OraSessions,
  OraSqlSection,
  OraStorage,
  OraUsers
} from './types'

type Ctx = { conn: any; mode: 'thin' | 'thick' }
type Warn = (msg: string) => void

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function firstLine(e: any): string {
  return String(e?.message || e || '').split('\n')[0].slice(0, 160)
}

/** 单项查询容错：失败记一条 warnings，返回兜底值 */
async function safe<T>(label: string, fn: () => Promise<T>, warn: Warn, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e: any) {
    warn(`${label}：${firstLine(e)}`)
    return fallback
  }
}

// ---------------------------------------------------------------- 基础信息

export async function fetchInfo(ctx: Ctx, warn: Warn): Promise<OraInfo> {
  const version = await safe('版本', async () => String((await oraScalar(ctx.conn, 'select banner from v$version where rownum = 1')) || ''), warn, '')
  const db = await oraQuery(ctx.conn, `select name, db_unique_name, database_role, open_mode, protection_mode,
      log_mode, flashback_on, force_logging, platform_name, to_char(created,'YYYY-MM-DD') created
    from v$database`, { maxRows: 1 })
  const d = db[0] || ({} as any)

  const inst = await safe('实例', async () => oraQuery<OraInstanceRow>(ctx.conn, `select inst_id, instance_number, instance_name, host_name, version, status,
        instance_role, active_state, database_status, to_char(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time
      from gv$instance order by inst_id`), warn, [])

  const clusterDatabase = await safe('RAC 参数', async () =>
    String((await oraScalar(ctx.conn, `select value from v$parameter where name = 'cluster_database'`)) || 'FALSE'), warn, 'FALSE')

  // 12c+ 才有 v$pdbs；11g 上这条一定报 ORA-00942，所以用 try 探测而不是让它进 warnings
  let isCdb = false
  try {
    await ctx.conn.execute('select 1 from v$pdbs where rownum = 1')
    isCdb = true
  } catch { /* 11g 或非 CDB */ }

  return {
    dbName: String(d.name || ''),
    dbUniqueName: String(d.db_unique_name || ''),
    databaseRole: String(d.database_role || ''),
    openMode: String(d.open_mode || ''),
    protectionMode: String(d.protection_mode || ''),
    logMode: String(d.log_mode || ''),
    flashbackOn: String(d.flashback_on || ''),
    forceLogging: String(d.force_logging || ''),
    platformName: String(d.platform_name || ''),
    created: String(d.created || ''),
    dbid: num(await safe('DBID', async () => oraScalar(ctx.conn, 'select dbid from v$database'), warn, 0)),
    version,
    edition: version.includes('Enterprise') ? 'Enterprise' : version.includes('Standard') ? 'Standard' : '—',
    isRac: String(clusterDatabase).toUpperCase() === 'TRUE' || inst.length > 1,
    isCdb,
    instances: inst.map((i) => ({ ...i, instId: num(i.instId), instanceNumber: num(i.instanceNumber) })),
    mode: ctx.mode,
    collectedAt: new Date().toISOString(),
    warnings: []
  }
}

// ---------------------------------------------------------------- 环境概要（列表页用）

/**
 * 一套环境一行，只用 7 条 SQL：列表页要同时显示多套环境，不能每套都跑一遍总览的十几个查询。
 * 连接失败由外层 cloudOraSection 抛成 { ok:false, error }，这里只负责把成功的那部分拼出来。
 */
export async function fetchEnvSummary(ctx: Ctx, warn: Warn): Promise<OraEnvSummary> {
  // 版本 + 库信息合成一条，省一次往返
  const db = await oraQuery(ctx.conn, `select (select banner from v$version where rownum = 1) ver,
      name, db_unique_name, database_role, open_mode, log_mode
    from v$database`, { maxRows: 1 })
  const d = db[0] || ({} as any)

  const inst = await safe('实例', async () => oraQuery(ctx.conn, `select inst_id, status,
      to_char(min(startup_time) over (), 'YYYY-MM-DD HH24:MI') first_start,
      to_char(max(startup_time) over (), 'YYYY-MM-DD HH24:MI') last_start
    from gv$instance`), warn, [])

  const sess = await safe('会话', async () => oraQuery(ctx.conn, `select status, count(*) c
      from gv$session where type = 'USER' group by status`), warn, [])
  const totalSess = sess.reduce((a, b) => a + num(b.c), 0)
  const activeSess = sess.filter((x) => String(x.status) === 'ACTIVE').reduce((a, b) => a + num(b.c), 0)

  const ts = await safe('表空间水位', async () => oraQuery(ctx.conn, `select name, used_pct from (
      select t.tablespace_name name,
             case when nvl(d.total_mb,0) > 0 then round((d.total_mb - nvl(f.free_mb,0)) * 100 / d.total_mb, 2) else 0 end used_pct
        from dba_tablespaces t
        left join (select tablespace_name, round(sum(bytes)/1048576, 2) total_mb from dba_data_files group by tablespace_name) d
          on d.tablespace_name = t.tablespace_name
        left join (select tablespace_name, round(sum(bytes)/1048576, 2) free_mb from dba_free_space group by tablespace_name) f
          on f.tablespace_name = t.tablespace_name
       where t.contents <> 'TEMPORARY'
       order by used_pct desc) where rownum <= 1`), warn, [])

  const blocking = await safe('阻塞', async () => num(await oraScalar(ctx.conn, `select count(*) from gv$lock where block in (1,2)`)), warn, 0)
  const invalid = await safe('失效对象', async () => num(await oraScalar(ctx.conn, `select count(*) from dba_objects where status = 'INVALID'`)), warn, 0)
  const longops = await safe('长操作', async () => num(await oraScalar(ctx.conn, `select count(*) from gv$session_longops where time_remaining > 0`)), warn, 0)

  // 12c+ 才有 v$pdbs；11g 上探一下就知道是不是 CDB
  let isCdb = false
  try {
    await ctx.conn.execute('select 1 from v$pdbs where rownum = 1')
    isCdb = true
  } catch { /* 11g 或非 CDB */ }

  const clusterDatabase = await safe('RAC', async () =>
    String((await oraScalar(ctx.conn, `select value from v$parameter where name = 'cluster_database'`)) || 'FALSE'), warn, 'FALSE')

  const first = String(inst[0]?.first_start || '')
  const last = String(inst[0]?.last_start || '')

  return {
    dbName: String(d.name || ''),
    dbUniqueName: String(d.db_unique_name || ''),
    databaseRole: String(d.database_role || ''),
    openMode: String(d.open_mode || ''),
    logMode: String(d.log_mode || ''),
    version: String(d.ver || ''),
    isRac: String(clusterDatabase).toUpperCase() === 'TRUE' || inst.length > 1,
    isCdb,
    instances: inst.length,
    instancesOpen: inst.filter((i) => String(i.status) === 'OPEN').length,
    startupTime: first === last ? first : `${first} ~ ${last}`,
    sessions: totalSess,
    activeSessions: activeSess,
    tsWorst: ts.length ? { name: String(ts[0].name), usedPct: num(ts[0].used_pct) } : null,
    blocking,
    invalid,
    longops,
    collectedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------- 总览

export async function fetchOverview(ctx: Ctx, warn: Warn): Promise<OraOverview> {
  const info = await fetchInfo(ctx, warn)

  const sess = await safe('会话', async () => oraQuery(ctx.conn, `select inst_id, status, count(*) c
      from gv$session where type = 'USER' group by inst_id, status`), warn, [])
  const sessByInst = new Map<number, { total: number; active: number }>()
  for (const r of sess) {
    const k = num(r.inst_id)
    const cur = sessByInst.get(k) || { total: 0, active: 0 }
    cur.total += num(r.c)
    if (String(r.status) === 'ACTIVE') cur.active += num(r.c)
    sessByInst.set(k, cur)
  }

  const ts = await safe('表空间', async () => oraQuery(ctx.conn, `select t.tablespace_name name, nvl(d.total_mb,0) size_mb, nvl(f.free_mb,0) free_mb,
        case when nvl(d.total_mb,0) > 0 then round((d.total_mb - nvl(f.free_mb,0)) * 100 / d.total_mb, 2) else 0 end used_pct,
        nvl(d.autoext,0) autoext
      from dba_tablespaces t
      left join (select tablespace_name, round(sum(bytes)/1048576, 2) total_mb,
                        sum(case when autoextensible = 'YES' then 1 else 0 end) autoext
                   from dba_data_files group by tablespace_name) d on d.tablespace_name = t.tablespace_name
      left join (select tablespace_name, round(sum(bytes)/1048576, 2) free_mb
                   from dba_free_space group by tablespace_name) f on f.tablespace_name = t.tablespace_name
      where t.contents <> 'TEMPORARY'
      order by used_pct desc`), warn, [])

  const waits = await safe('等待事件', async () => oraQuery(ctx.conn, `select * from (
      select event, wait_class, round(time_waited_micro/1000000, 2) time_s
        from v$system_event where wait_class <> 'Idle' order by time_waited_micro desc) where rownum <= 8`), warn, [])

  const metrics = await safe('运行指标', async () => oraQuery(ctx.conn, `select metric_name name, value, metric_unit unit
      from v$sysmetric where group_id = 2 and metric_name in (
        'User Transaction Per Sec','Executions Per Sec','Session Count','Active Session Count',
        'Database CPU Time Ratio','Database Wait Time Ratio','Physical Reads Per Sec','Redo Generated Per Sec',
        'Logical Reads Per Sec','Host CPU Utilization (%)')`), warn, [])

  const hours = await safe('告警分布', async () => oraQuery(ctx.conn, `select to_char(originating_timestamp,'MM-DD HH24') hr, count(*) c
      from v$diag_alert_ext where originating_timestamp > systimestamp - 12/24
      group by to_char(originating_timestamp,'MM-DD HH24') order by 1`), warn, [])

  const invalid = await safe('失效对象', async () => num(await oraScalar(ctx.conn, `select count(*) from dba_objects where status = 'INVALID'`)), warn, 0)
  const blocking = await safe('阻塞会话', async () => num(await oraScalar(ctx.conn, `select count(*) from gv$lock where block in (1,2)`)), warn, 0)
  const longops = await safe('长事务', async () => num(await oraScalar(ctx.conn, `select count(*) from gv$session_longops where time_remaining > 0`)), warn, 0)
  const archived = await safe('归档', async () => oraQuery(ctx.conn, `select dest_id, status, error from v$archive_dest_status where dest_id <= 2`), warn, [])

  const totalSessions = [...sessByInst.values()].reduce((a, b) => a + b.total, 0)
  const activeSessions = [...sessByInst.values()].reduce((a, b) => a + b.active, 0)
  const metric = (n: string) => num(metrics.find((m) => String(m.name).startsWith(n))?.value)
  const tsBad = ts.filter((t) => num(t.used_pct) >= 90)
  const tsWarn = ts.filter((t) => num(t.used_pct) >= 85 && num(t.used_pct) < 90)
  const archErr = archived.filter((a) => String(a.error || '').trim() !== '')

  const kpis = [
    {
      label: '实例数量',
      value: `${info.instances.length}`,
      sub: info.isRac ? 'RAC 集群' : '单实例',
      tone: 'ok' as const,
      src: 'orKpiInst'
    },
    {
      label: '库状态',
      value: info.openMode.replace('READ WRITE', 'OPEN'),
      sub: `${info.databaseRole} · ${info.logMode}`,
      tone: info.openMode.includes('READ WRITE') ? ('ok' as const) : ('warn' as const),
      src: 'orKpiDb'
    },
    { label: '用户会话', value: `${totalSessions}`, sub: `活跃 ${activeSessions}`, src: 'orKpiSess' },
    { label: '每秒事务', value: metric('User Transaction').toFixed(1), sub: 'User Transaction/s', src: 'orKpiTps' },
    { label: 'DB CPU 占比', value: `${metric('Database CPU Time Ratio').toFixed(1)}%`, sub: '近 60 秒', src: 'orKpiCpu' },
    {
      label: '阻塞会话',
      value: `${blocking}`,
      sub: blocking > 0 ? '存在锁等待' : '无阻塞',
      tone: blocking > 0 ? ('bad' as const) : ('ok' as const),
      src: 'orKpiBlock'
    },
    {
      label: '表空间告警',
      value: `${tsBad.length + tsWarn.length}`,
      sub: tsBad.length ? `${tsBad.length} 个 ≥90%` : tsWarn.length ? `${tsWarn.length} 个 ≥85%` : '水位正常',
      tone: tsBad.length ? ('bad' as const) : tsWarn.length ? ('warn' as const) : ('ok' as const),
      src: 'orKpiTs'
    },
    {
      label: '失效对象',
      value: `${invalid}`,
      sub: invalid > 0 ? '需重编译' : '全部有效',
      tone: invalid > 0 ? ('warn' as const) : ('ok' as const),
      src: 'orKpiInvalid'
    }
  ]

  const issues: OraOverview['issues'] = []
  for (const t of tsBad) {
    issues.push({ level: 'bad', title: `表空间 ${t.name} 水位 ${num(t.used_pct).toFixed(1)}%`, detail: `已用 ${num(t.size_mb).toFixed(0)} MB / 剩余 ${num(t.free_mb).toFixed(0)} MB，需扩容或清理` })
  }
  for (const t of tsWarn) {
    issues.push({ level: 'warn', title: `表空间 ${t.name} 水位 ${num(t.used_pct).toFixed(1)}%`, detail: '建议提前规划扩容' })
  }
  if (blocking > 0) issues.push({ level: 'bad', title: `${blocking} 个会话被阻塞`, detail: '到「会话与锁」查看阻塞链与阻塞者 SQL' })
  if (longops > 0) issues.push({ level: 'info', title: `${longops} 个长操作在执行`, detail: '可在「会话与锁 · 长操作」查看剩余时间' })
  if (invalid > 0) issues.push({ level: 'warn', title: `${invalid} 个对象失效`, detail: '到「用户与对象」查看失效对象所属 schema' })
  for (const a of archErr) issues.push({ level: 'bad', title: `归档目标 ${a.dest_id} 报错`, detail: String(a.error).slice(0, 160) })
  if (info.openMode && !info.openMode.includes('READ WRITE')) issues.push({ level: 'warn', title: `数据库当前为 ${info.openMode}`, detail: '只读/挂载状态下业务写入会失败' })

  return {
    info,
    kpis,
    instances: info.instances.map((i) => {
      const c = sessByInst.get(i.instId) || { total: 0, active: 0 }
      return { name: i.instanceName, host: i.hostName, status: i.status, sessions: c.total, active: c.active }
    }),
    tablespaces: ts.map((t) => ({
      name: String(t.name),
      usedPct: num(t.used_pct),
      usedMb: num(t.size_mb) - num(t.free_mb),
      sizeMb: num(t.size_mb),
      autoext: num(t.autoext) > 0 ? 1 : 0
    })),
    alertHours: hours.map((h) => ({ hour: String(h.hr), count: num(h.c) })),
    waits: waits.map((w) => ({ event: String(w.event), waitClass: String(w.wait_class), timeS: num(w.time_s) })),
    metrics: metrics.map((m) => ({ name: String(m.name), value: num(m.value), unit: String(m.unit || '') })),
    issues
  }
}

// ---------------------------------------------------------------- RAC

export async function fetchRac(ctx: Ctx, warn: Warn): Promise<OraRac> {
  const clusterDatabase = await safe('cluster_database', async () =>
    String((await oraScalar(ctx.conn, `select value from v$parameter where name = 'cluster_database'`)) || 'FALSE'), warn, 'FALSE')
  const configured = await safe('集群实例数', async () =>
    num(await oraScalar(ctx.conn, `select value from v$parameter where name = 'cluster_database_instances'`)), warn, 0)

  const inst = await oraQuery(ctx.conn, `select inst_id, instance_name, host_name, status, instance_role, active_state,
      database_status, version, to_char(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time
    from gv$instance order by inst_id`)

  const sess = await safe('实例会话', async () => oraQuery(ctx.conn, `select inst_id, status, count(*) c
      from gv$session where type = 'USER' group by inst_id, status`), warn, [])
  const byInst = new Map<number, { total: number; active: number }>()
  for (const r of sess) {
    const k = num(r.inst_id)
    const cur = byInst.get(k) || { total: 0, active: 0 }
    cur.total += num(r.c)
    if (String(r.status) === 'ACTIVE') cur.active += num(r.c)
    byInst.set(k, cur)
  }

  const services = await safe('服务', async () => oraQuery(ctx.conn, `select inst_id, service_id, name, network_name
      from gv$active_services order by inst_id, name`), warn, [])
  const ic = await safe('私网', async () => oraQuery(ctx.conn, `select inst_id, name, ip_address, is_public, source
      from gv$cluster_interconnects order by inst_id`), warn, [])
  const active = await safe('活跃实例', async () => oraQuery(ctx.conn, `select inst_number, inst_name from v$active_instances order by 1`), warn, [])

  return {
    clusterDatabase,
    configuredInstances: configured,
    nodes: inst.map((i) => {
      const c = byInst.get(num(i.inst_id)) || { total: 0, active: 0 }
      return {
        instId: num(i.inst_id),
        instanceName: String(i.instance_name),
        hostName: String(i.host_name),
        status: String(i.status),
        instanceRole: String(i.instance_role),
        activeState: String(i.active_state),
        databaseStatus: String(i.database_status),
        startupTime: String(i.startup_time || ''),
        version: String(i.version || ''),
        sessions: c.total,
        active: c.active
      }
    }),
    services: services.map((s) => ({ instId: num(s.inst_id), serviceId: num(s.service_id), name: String(s.name), networkName: String(s.network_name || '') })),
    interconnects: ic.map((r) => ({ instId: num(r.inst_id), name: String(r.name || ''), ip: String(r.ip_address || ''), isPublic: String(r.is_public || ''), source: String(r.source || '') })),
    activeInstances: active.map((r) => ({ instNumber: num(r.inst_number), instName: String(r.inst_name) }))
  }
}

// ---------------------------------------------------------------- 实例

export async function fetchInstances(ctx: Ctx, warn: Warn): Promise<OraInstanceDetail[]> {
  const inst = await oraQuery(ctx.conn, `select inst_id, instance_name, host_name, status, instance_role, active_state,
      database_status, version, to_char(startup_time,'YYYY-MM-DD HH24:MI:SS') startup_time from gv$instance order by inst_id`)

  const param = await safe('参数', async () => oraQuery(ctx.conn, `select name, value from v$parameter where name in (
      'processes','sessions','db_block_size','compatible','optimizer_mode','cursor_sharing','open_cursors',
      'undo_tablespace','db_recovery_file_dest','sga_target','pga_aggregate_target')`), warn, [])
  const pv = new Map(param.map((p) => [String(p.name), String(p.value)]))

  const sga = await safe('SGA', async () => oraQuery(ctx.conn, `select name, round(bytes/1048576, 2) mb from v$sgainfo where bytes > 0`), warn, [])
  const pga = await safe('PGA', async () => oraQuery(ctx.conn, `select name, round(value/1048576, 2) mb from v$pgastat
      where name in ('aggregate PGA target parameter','aggregate PGA auto target','total PGA allocated','total PGA inuse','total freeable PGA memory')`), warn, [])
  const osstat = await safe('OS', async () => oraQuery(ctx.conn, `select stat_name, value from v$osstat
      where stat_name in ('NUM_CPUS','PHYSICAL_MEMORY_BYTES','LOAD')`), warn, [])
  const res = await safe('资源限制', async () => oraQuery(ctx.conn, `select resource_name, current_utilization, limit_value
      from v$resource_limit where resource_name in ('processes','sessions','transactions','enqueue_locks')`), warn, [])
  const buf = await safe('缓冲池', async () => oraQuery(ctx.conn, `select name, db_block_gets, consistent_gets, physical_reads
      from v$buffer_pool_statistics`), warn, [])
  const tmp = await safe('临时表空间', async () => oraQuery(ctx.conn, `select value from v$parameter where name = 'default_temp_tablespace'`), warn, [])

  const sgaTotal = sga.reduce((a, b) => a + num(b.mb), 0)
  const pgaTarget = num((pga.find((p) => String(p.name).toLowerCase().includes('target parameter')) || {}).mb)
  const os = new Map(osstat.map((o) => [String(o.stat_name), num(o.value)]))

  return inst.map((i) => ({
    instId: num(i.inst_id),
    instanceName: String(i.instance_name),
    hostName: String(i.host_name),
    status: String(i.status),
    startupTime: String(i.startup_time || ''),
    version: String(i.version || ''),
    instanceRole: String(i.instance_role),
    activeState: String(i.active_state),
    dbStatus: String(i.database_status),
    sgaMb: sgaTotal,
    pgaMb: pgaTarget,
    processes: pv.get('processes') || '',
    sessions: pv.get('sessions') || '',
    dbBlockSize: pv.get('db_block_size') || '',
    compat: pv.get('compatible') || '',
    optimizerMode: pv.get('optimizer_mode') || '',
    cursorSharing: pv.get('cursor_sharing') || '',
    openCursors: pv.get('open_cursors') || '',
    undoTablespace: pv.get('undo_tablespace') || '',
    defaultTempTs: String((tmp[0] as any)?.value || ''),
    osCpus: os.get('NUM_CPUS') || 0,
    osMemGb: Math.round((os.get('PHYSICAL_MEMORY_BYTES') || 0) / 1073741824 * 10) / 10,
    load: os.get('LOAD') || 0,
    resource: res.map((r) => ({ name: String(r.resource_name), current: num(r.current_utilization), max: num(r.limit_value) })),
    sga: sga.map((s) => ({ name: String(s.name), mb: num(s.mb) })),
    pga: pga.map((p) => ({ name: String(p.name), mb: num(p.mb) })),
    bufferHit: buf.map((b) => {
      const gets = num(b.db_block_gets) + num(b.consistent_gets)
      return { name: String(b.name), missPct: gets > 0 ? Math.round(num(b.physical_reads) * 10000 / gets) / 100 : 0, gets }
    })
  }))
}

// ---------------------------------------------------------------- PDB

export async function fetchPdb(ctx: Ctx, warn: Warn): Promise<OraPdbSection> {
  let pdbs: any[] = []
  let isCdb = true
  try {
    pdbs = await oraQuery(ctx.conn, `select con_id, name, open_mode, restricted, to_char(open_time,'YYYY-MM-DD HH24:MI') open_time
      from v$pdbs order by con_id`)
  } catch {
    isCdb = false
  }
  if (!isCdb) {
    return { isCdb: false, note: '当前实例不是 CDB（Oracle 11g 或未启用多租户），没有 PDB 概念。', pdbs: [], files: [] }
  }
  const conType = await safe('容器类型', async () => oraQuery(ctx.conn, `select con_id, con_type from v$containers`), warn, [])
  const typeMap = new Map(conType.map((c) => [num(c.con_id), String(c.con_type)]))
  const files = await safe('容器数据文件', async () => oraQuery(ctx.conn, `select con_id, count(*) files, round(sum(bytes)/1048576, 2) mb
      from v$datafile group by con_id`), warn, [])
  const nameOf = new Map(pdbs.map((p) => [num(p.con_id), String(p.name)]))

  return {
    isCdb: true,
    note: '',
    pdbs: pdbs.map((p) => ({
      conId: num(p.con_id),
      name: String(p.name),
      openMode: String(p.open_mode),
      restricted: String(p.restricted),
      openTime: String(p.open_time || ''),
      conType: typeMap.get(num(p.con_id)) || '—'
    })),
    files: files.map((f) => ({ conId: num(f.con_id), name: nameOf.get(num(f.con_id)) || `CON${f.con_id}`, sizeMb: num(f.mb) }))
  }
}

// ---------------------------------------------------------------- 存储

export async function fetchStorage(ctx: Ctx, warn: Warn): Promise<OraStorage> {
  const tablespaces = await safe('表空间', async () => oraQuery(ctx.conn, `select t.tablespace_name name, t.contents, t.status, t.bigfile, t.logging,
      nvl(d.total_mb,0) size_mb, nvl(f.free_mb,0) free_mb,
      case when nvl(d.total_mb,0) > 0 then round((d.total_mb - nvl(f.free_mb,0)) * 100 / d.total_mb, 2) else 0 end used_pct,
      nvl(a.max_mb,0) max_mb, nvl(d.files,0) files, nvl(d.autoext,0) autoext
    from dba_tablespaces t
    left join (select tablespace_name, round(sum(bytes)/1048576, 2) total_mb, count(*) files,
                      sum(case when autoextensible = 'YES' then 1 else 0 end) autoext
                 from dba_data_files group by tablespace_name) d on d.tablespace_name = t.tablespace_name
    left join (select tablespace_name, round(sum(bytes)/1048576, 2) free_mb
                 from dba_free_space group by tablespace_name) f on f.tablespace_name = t.tablespace_name
    left join (select tablespace_name, round(sum(maxbytes)/1048576, 2) max_mb
                 from dba_data_files group by tablespace_name) a on a.tablespace_name = t.tablespace_name
    order by used_pct desc`), warn, [])

  const temp = await safe('临时表空间', async () => oraQuery(ctx.conn, `select h.tablespace_name name,
      round(sum(h.bytes_used)/1048576, 2) used_mb, round(sum(h.bytes_free)/1048576, 2) free_mb,
      round(sum(nvl(f.bytes,0))/1048576, 2) total_mb
    from v$temp_space_header h
    left join (select tablespace_name, sum(bytes) bytes from dba_temp_files group by tablespace_name) f
      on f.tablespace_name = h.tablespace_name
    group by h.tablespace_name`), warn, [])

  const undo = await safe('UNDO', async () => {
    const segs = await oraQuery(ctx.conn, `select status, count(*) c from dba_rollback_segs group by status`)
    const rec = await oraQuery(ctx.conn, `select * from (
      select to_char(begin_time,'MM-DD HH24:MI') begin_ts, to_char(end_time,'HH24:MI') end_ts,
             undoblks, txncount, maxquerylen, ssolderrcnt, nospaceerrcnt
        from v$undostat order by begin_time desc) where rownum <= 12`)
    return {
      segments: segs.map((s) => ({ status: String(s.status), count: num(s.c) })),
      recent: rec.map((r) => ({
        begin: String(r.begin_ts),
        end: String(r.end_ts),
        undoblks: num(r.undoblks),
        txnCount: num(r.txncount),
        maxQueryLen: num(r.maxquerylen),
        ssolderrcnt: num(r.ssolderrcnt),
        nospaceerrcnt: num(r.nospaceerrcnt)
      }))
    }
  }, warn, { segments: [], recent: [] })

  const datafiles = await safe('数据文件', async () => oraQuery(ctx.conn, `select file_id, file_name, tablespace_name,
      round(bytes/1048576, 2) size_mb, autoextensible, round(maxbytes/1048576, 2) max_mb,
      round(increment_by * (select value from v$parameter where name='db_block_size')/1048576, 2) inc_mb,
      status, online_status
    from dba_data_files order by tablespace_name, file_id`), warn, [])

  const asm = await safe('ASM', async () => oraQuery(ctx.conn, `select g.name, g.state, g.type, g.total_mb, g.free_mb, g.usable_file_mb,
      round((g.total_mb - g.free_mb) * 100 / decode(g.total_mb, 0, 1, g.total_mb), 2) used_pct,
      (select count(*) from v$asm_disk d where d.group_number = g.group_number) disks
    from v$asm_diskgroup g order by g.name`), warn, [])

  const archive = await safe('归档', async () => {
    const dests = await oraQuery(ctx.conn, `select dest_id, status, destination, synchronization_status, synchronized, error,
        db_unique_name, gap_status, archived_seq# archived_seq, applied_seq# applied_seq from v$archive_dest_status where dest_id <= 10 order by dest_id`)
    const last = await oraQuery(ctx.conn, `select count(*) cnt, round(sum(blocks * block_size)/1073741824, 2) gb
      from v$archived_log where first_time > sysdate - 1 and dest_id = 1`)
    return {
      dests: dests.map((d) => ({
        destId: num(d.dest_id), status: String(d.status || ''), destination: String(d.destination || ''),
        syncStatus: String(d.synchronization_status || ''), synchronized: String(d.synchronized || ''), error: String(d.error || ''),
        dbUnique: String(d.db_unique_name || ''), gapStatus: String(d.gap_status || ''),
        archivedSeq: num(d.archived_seq), appliedSeq: num(d.applied_seq)
      })),
      last24h: { count: num(last[0]?.cnt), gb: num(last[0]?.gb) }
    }
  }, warn, { dests: [], last24h: { count: 0, gb: 0 } })

  const fra = await safe('FRA', async () => {
    const d = await oraQuery(ctx.conn, `select name, round(space_limit/1073741824, 2) limit_gb, round(space_used/1073741824, 2) used_gb,
        round(space_reclaimable/1073741824, 2) reclaim_gb, number_of_files files from v$recovery_file_dest`)
    if (!d.length) return null
    const u = await oraQuery(ctx.conn, `select file_type, percent_space_used, percent_space_reclaimable, number_of_files
      from v$flash_recovery_area_usage`)
    return {
      name: String(d[0].name || ''),
      limitGb: num(d[0].limit_gb),
      usedGb: num(d[0].used_gb),
      reclaimGb: num(d[0].reclaim_gb),
      files: num(d[0].files),
      usage: u.map((r) => ({ type: String(r.file_type), usedPct: num(r.percent_space_used), reclaimPct: num(r.percent_space_reclaimable), files: num(r.number_of_files) }))
    }
  }, warn, null)

  const redo = await safe('在线日志', async () => oraQuery(ctx.conn, `select group# grp, thread# thr, sequence# seq, bytes/1048576 mb, members, status, archived,
      to_char(first_time,'YYYY-MM-DD HH24:MI') first_time from v$log order by group#`), warn, [])

  return {
    tablespaces: tablespaces.map((t) => ({
      name: String(t.name), contents: String(t.contents || ''), status: String(t.status || ''),
      bigfile: String(t.bigfile || ''), logging: String(t.logging || ''),
      sizeMb: num(t.size_mb), usedMb: num(t.size_mb) - num(t.free_mb), freeMb: num(t.free_mb),
      usedPct: num(t.used_pct), maxMb: num(t.max_mb), files: num(t.files), autoext: num(t.autoext)
    })),
    temp: temp.map((t) => ({
      name: String(t.name), totalMb: num(t.total_mb), usedMb: num(t.used_mb), freeMb: num(t.free_mb),
      usedPct: num(t.total_mb) > 0 ? Math.round(num(t.used_mb) * 10000 / num(t.total_mb)) / 100 : 0
    })),
    undo,
    datafiles: datafiles.map((f) => ({
      fileId: num(f.file_id), fileName: String(f.file_name), tablespace: String(f.tablespace_name),
      sizeMb: num(f.size_mb), autoextensible: String(f.autoextensible || ''), maxMb: num(f.max_mb),
      incMb: num(f.inc_mb), status: String(f.status || ''), onlineStatus: String(f.online_status || '')
    })),
    asm: asm.map((a) => ({
      name: String(a.name), state: String(a.state || ''), type: String(a.type || ''),
      totalMb: num(a.total_mb), freeMb: num(a.free_mb), usableMb: num(a.usable_file_mb),
      usedPct: num(a.used_pct), disks: num(a.disks)
    })),
    archive,
    fra,
    redo: redo.map((r) => ({
      group: num(r.grp), thread: num(r.thr), sequence: num(r.seq), mb: num(r.mb),
      members: num(r.members), status: String(r.status || ''), archived: String(r.archived || ''), firstTime: String(r.first_time || '')
    }))
  }
}

// ---------------------------------------------------------------- 会话

export async function fetchSessions(ctx: Ctx, warn: Warn): Promise<OraSessions> {
  const summary = await safe('会话汇总', async () => oraQuery(ctx.conn, `select status, type, count(*) c
      from gv$session group by status, type order by type, status`), warn, [])
  const waitClass = await safe('等待分类', async () => oraQuery(ctx.conn, `select nvl(wait_class,'CPU') wc, count(*) c
      from gv$session where type = 'USER' group by nvl(wait_class,'CPU') order by 2 desc`), warn, [])
  const list = await safe('会话列表', async () => oraQuery(ctx.conn, `select * from (
      select s.inst_id, s.sid, s.serial# serial_no, s.username, s.status, s.machine, s.program, s.sql_id, s.event, s.wait_class,
             s.seconds_in_wait, s.blocking_session, s.last_call_et,
             to_char(s.logon_time,'MM-DD HH24:MI') logon_time, p.spid
        from gv$session s
        left join gv$process p on p.addr = s.paddr and p.inst_id = s.inst_id
       where s.type = 'USER' and s.username is not null
       order by case when s.status = 'ACTIVE' then 0 else 1 end, s.last_call_et desc) where rownum <= 300`), warn, [])
  const blocking = await safe('阻塞链', async () => oraQuery(ctx.conn, `select l.inst_id, l.sid, l.type, l.lmode, l.request, l.ctime,
        b.sid blocker_sid, b.username blocker_user, b.sql_id blocker_sql,
        s.username, s.sql_id, s.event
      from gv$lock l
      join gv$session s on s.sid = l.sid and s.inst_id = l.inst_id
      left join gv$session b on b.sid = l.id1 and b.inst_id = l.inst_id
     where l.block in (1,2) and l.type in ('TX','TM')
     order by l.ctime desc`), warn, [])
  const longops = await safe('长操作', async () => oraQuery(ctx.conn, `select * from (
      select inst_id, sid, opname, target, round(sofar * 100 / decode(totalwork,0,1,totalwork), 1) pct,
             time_remaining, elapsed_seconds, sql_id
        from gv$session_longops where time_remaining > 0
       order by time_remaining desc) where rownum <= 50`), warn, [])

  return {
    summary: summary.map((s) => ({ status: String(s.status), type: String(s.type), count: num(s.c) })),
    waitClass: waitClass.map((w) => ({ waitClass: String(w.wc), count: num(w.c) })),
    list: list.map((s) => ({
      instId: num(s.inst_id), sid: num(s.sid), serial: num(s.serial_no), username: String(s.username || ''),
      status: String(s.status || ''), machine: String(s.machine || ''), program: String(s.program || ''),
      sqlId: String(s.sql_id || ''), event: String(s.event || ''), waitClass: String(s.wait_class || ''),
      secondsInWait: num(s.seconds_in_wait), blockingSession: s.blocking_session === null ? null : num(s.blocking_session),
      lastCallEt: num(s.last_call_et), spid: String(s.spid || ''), logonTime: String(s.logon_time || '')
    })),
    blocking: blocking.map((b) => ({
      instId: num(b.inst_id), sid: num(b.sid), type: String(b.type), lmode: String(b.lmode), request: String(b.request),
      ctime: num(b.ctime), blockerSid: num(b.blocker_sid), blockerUser: String(b.blocker_user || ''),
      blockerSql: String(b.blocker_sql || ''), username: String(b.username || ''), sqlId: String(b.sql_id || ''),
      event: String(b.event || '')
    })),
    longops: longops.map((l) => ({
      instId: num(l.inst_id), sid: num(l.sid), opname: String(l.opname || ''), target: String(l.target || ''),
      pct: num(l.pct), timeRemaining: num(l.time_remaining), elapsed: num(l.elapsed_seconds), sqlId: String(l.sql_id || '')
    }))
  }
}

// ---------------------------------------------------------------- SQL

const SQL_ORDER: Record<string, string> = {
  elapsed: 'elapsed_time',
  cpu: 'cpu_time',
  gets: 'buffer_gets',
  disk: 'disk_reads'
}

export async function fetchSql(ctx: Ctx, warn: Warn, by = 'elapsed'): Promise<OraSqlSection> {
  const order = SQL_ORDER[by] || SQL_ORDER.elapsed
  const rows = await safe('TopSQL', async () => oraQuery(ctx.conn, `select * from (
      select sql_id, plan_hash_value, executions, round(elapsed_time/1000000, 2) elapsed_s,
             round(cpu_time/1000000, 2) cpu_s,
             round(elapsed_time / decode(executions, 0, 1, executions) / 1000, 2) avg_ms,
             buffer_gets, disk_reads,
             round(buffer_gets / decode(executions, 0, 1, executions)) gets_per_exec,
             round(disk_reads / decode(executions, 0, 1, executions)) reads_per_exec,
             rows_processed, parsing_schema_name, module,
             to_char(last_active_time,'MM-DD HH24:MI:SS') last_active
        from gv$sql where executions > 0
       order by ${order} desc) where rownum <= 40`), warn, [])

  const awr = await safe('AWR TopSQL', async () => oraQuery(ctx.conn, `select * from (
      select s.sql_id, sum(s.executions_delta) execs, round(sum(s.elapsed_time_delta)/1000000, 2) elapsed_s,
             round(sum(s.cpu_time_delta)/1000000, 2) cpu_s, sum(s.buffer_gets_delta) gets, sum(s.disk_reads_delta) reads
        from dba_hist_sqlstat s
       where s.snap_id > (select max(snap_id) - 12 from dba_hist_snapshot)
       group by s.sql_id order by 3 desc) where rownum <= 20`), warn, [])

  const range = await safe('AWR 区间', async () => {
    const r = await oraQuery(ctx.conn, `select * from (
      select to_char(begin_interval_time,'MM-DD HH24:MI') bt, to_char(end_interval_time,'HH24:MI') et
        from dba_hist_snapshot order by snap_id desc) where rownum <= 12`)
    return r.length ? `${r[r.length - 1].bt} ~ ${r[0].bt}${r[0].et}` : ''
  }, warn, '')

  return {
    by: by in SQL_ORDER ? by : 'elapsed',
    rows: rows.map((r) => ({
      sqlId: String(r.sql_id), planHash: num(r.plan_hash_value), executions: num(r.executions),
      elapsedS: num(r.elapsed_s), cpuS: num(r.cpu_s), avgMs: num(r.avg_ms), bufferGets: num(r.buffer_gets),
      diskReads: num(r.disk_reads), getsPerExec: num(r.gets_per_exec), readsPerExec: num(r.reads_per_exec),
      rowsProcessed: num(r.rows_processed), schema: String(r.parsing_schema_name || ''),
      module: String(r.module || ''), lastActive: String(r.last_active || '')
    })),
    awr: awr.map((a) => ({
      sqlId: String(a.sql_id), executions: num(a.execs), elapsedS: num(a.elapsed_s),
      cpuS: num(a.cpu_s), gets: num(a.gets), reads: num(a.reads)
    })),
    awrRange: String(range || '')
  }
}

/** 单条 SQL 的全文 + 执行计划（点击列表时单独取，避免每次刷新都拉） */
export async function fetchSqlDetail(ctx: Ctx, sqlId: string): Promise<{ text: string; plan: any[] }> {
  const textRows = await oraQuery(ctx.conn, `select piece, sql_text from gv$sqltext where sql_id = :id order by piece`, {
    binds: { id: sqlId },
    maxRows: 200
  })
  let plan: any[] = []
  try {
    plan = await oraQuery(ctx.conn, `select id, depth, operation, options, object_owner, object_name, cost, cardinality, bytes
      from gv$sql_plan where sql_id = :id and plan_hash_value = (
        select max(plan_hash_value) from gv$sql where sql_id = :id)
      order by id`, { binds: { id: sqlId }, maxRows: 200 })
  } catch { /* 计划可能已被刷出共享池 */ }
  return {
    text: textRows.map((r) => String(r.sql_text || '')).join('').trim(),
    plan: plan.map((p) => ({
      id: num(p.id), depth: num(p.depth), operation: String(p.operation || ''),
      options: String(p.options || ''), objectName: String(p.object_name || ''),
      cost: num(p.cost), cardinality: num(p.cardinality), bytes: num(p.bytes)
    }))
  }
}

// ---------------------------------------------------------------- 性能

export async function fetchPerf(ctx: Ctx, warn: Warn): Promise<OraPerf> {
  const metrics = await safe('sysmetric', async () => oraQuery(ctx.conn, `select metric_name, value, metric_unit
      from v$sysmetric where group_id = 2 and metric_name in (
        'User Transaction Per Sec','Executions Per Sec','Session Count','Active Session Count',
        'Database CPU Time Ratio','Database Wait Time Ratio','Physical Reads Per Sec','Redo Generated Per Sec',
        'Logical Reads Per Sec','Host CPU Utilization (%)','Average Active Sessions','SQL Service Response Time')
      order by metric_name`), warn, [])

  const sysstat = await safe('sysstat', async () => oraQuery(ctx.conn, `select name, value from v$sysstat where name in (
      'user commits','user rollbacks','execute count','parse count (total)','parse count (hard)',
      'session logical reads','physical reads','physical writes','redo size','sorts (memory)','sorts (disk)',
      'table scan rows gotten','index fast full scans (full)')`), warn, [])

  const systemEvent = await safe('系统等待', async () => oraQuery(ctx.conn, `select * from (
      select event, wait_class, total_waits, round(time_waited_micro/1000000, 2) time_s, round(average_wait*10, 2) avg_ms
        from v$system_event where wait_class <> 'Idle' order by time_waited_micro desc) where rownum <= 25`), warn, [])

  const ash = await safe('ASH', async () => oraQuery(ctx.conn, `select * from (
      select sql_id, event, session_state, count(*) samples
        from v$active_session_history where sample_time > sysdate - 1/24
       group by sql_id, event, session_state order by 4 desc) where rownum <= 20`), warn, [])

  const osstat = await safe('OS 统计', async () => oraQuery(ctx.conn, `select stat_name, value from v$osstat
      where stat_name in ('NUM_CPUS','NUM_CPU_CORES','PHYSICAL_MEMORY_BYTES','LOAD','IDLE_TIME','BUSY_TIME','USER_TIME','SYS_TIME')`), warn, [])

  const sga = await safe('SGA', async () => oraQuery(ctx.conn, `select name, round(bytes/1048576, 2) mb from v$sgainfo where bytes > 0`), warn, [])
  const pga = await safe('PGA', async () => oraQuery(ctx.conn, `select name, round(value/1048576, 2) mb from v$pgastat
      where name in ('aggregate PGA target parameter','total PGA allocated','total PGA inuse','total freeable PGA memory','cache hit percentage')`), warn, [])

  return {
    metrics: metrics.map((m) => ({ name: String(m.metric_name), value: num(m.value), unit: String(m.metric_unit || '') })),
    sysstat: sysstat.map((s) => ({ name: String(s.name), value: num(s.value) })),
    systemEvent: systemEvent.map((e) => ({
      event: String(e.event), waitClass: String(e.wait_class || ''), totalWaits: num(e.total_waits),
      timeS: num(e.time_s), avgMs: num(e.avg_ms)
    })),
    ash: ash.map((a) => ({ sqlId: String(a.sql_id || ''), event: String(a.event || ''), state: String(a.session_state || ''), samples: num(a.samples) })),
    ashWindow: '近 1 小时',
    osstat: osstat.map((o) => ({ name: String(o.stat_name), value: num(o.value) })),
    sga: sga.map((s) => ({ name: String(s.name), mb: num(s.mb) })),
    pga: pga.map((p) => ({ name: String(p.name), mb: num(p.mb) }))
  }
}

// ---------------------------------------------------------------- 告警日志

export async function fetchAlerts(ctx: Ctx, warn: Warn, hours = 24): Promise<OraAlerts> {
  const h = Math.max(1, Math.min(168, Number(hours) || 24))
  const total = await safe('告警总数', async () => num(await oraScalar(ctx.conn,
    `select count(*) from v$diag_alert_ext where originating_timestamp > systimestamp - ${h}/24`)), warn, 0)
  const errorCount = await safe('错误数', async () => num(await oraScalar(ctx.conn,
    `select count(*) from v$diag_alert_ext where originating_timestamp > systimestamp - ${h}/24 and message_text like '%ORA-%'`)), warn, 0)

  // 告警日志动辄几万条，直接列明细没法看：先按"去掉数字后的模板"聚类，再列最近的明细
  const groups = await safe('告警聚类', async () => oraQuery(ctx.conn, `select * from (
      select regexp_replace(substr(message_text, 1, 120), '[0-9]+', '#') pat,
             count(*) c, to_char(min(originating_timestamp),'MM-DD HH24:MI') first_ts,
             to_char(max(originating_timestamp),'MM-DD HH24:MI') last_ts,
             sum(case when message_text like '%ORA-%' then 1 else 0 end) errs
        from v$diag_alert_ext where originating_timestamp > systimestamp - ${h}/24
       group by regexp_replace(substr(message_text, 1, 120), '[0-9]+', '#')
       order by 2 desc) where rownum <= 25`), warn, [])

  const byHour = await safe('按小时', async () => oraQuery(ctx.conn, `select to_char(originating_timestamp,'MM-DD HH24') hr, count(*) c,
      sum(case when message_text like '%ORA-%' then 1 else 0 end) errs
      from v$diag_alert_ext where originating_timestamp > systimestamp - ${h}/24
      group by to_char(originating_timestamp,'MM-DD HH24') order by 1`), warn, [])

  const recent = await safe('最近告警', async () => oraQuery(ctx.conn, `select * from (
      select to_char(originating_timestamp,'MM-DD HH24:MI:SS') ts, message_type, message_level, substr(message_text, 1, 300) msg
        from v$diag_alert_ext order by originating_timestamp desc) where rownum <= 200`), warn, [])

  const ora = await safe('ORA 错误', async () => oraQuery(ctx.conn, `select * from (
      select to_char(originating_timestamp,'MM-DD HH24:MI:SS') ts, substr(message_text, 1, 300) msg
        from v$diag_alert_ext where message_text like '%ORA-%'
       order by originating_timestamp desc) where rownum <= 100`), warn, [])

  return {
    hours: h,
    total,
    errorCount,
    groups: groups.map((g) => ({
      pattern: String(g.pat), count: num(g.c), firstTs: String(g.first_ts || ''),
      lastTs: String(g.last_ts || ''), isError: num(g.errs) > 0
    })),
    byHour: byHour.map((r) => ({ hour: String(r.hr), count: num(r.c), errors: num(r.errs) })),
    recent: recent.map((r) => ({ ts: String(r.ts || ''), type: num(r.message_type), level: num(r.message_level), msg: String(r.msg || '') })),
    ora: ora.map((r) => ({ ts: String(r.ts || ''), msg: String(r.msg || '') }))
  }
}

// ---------------------------------------------------------------- 备份

export async function fetchBackup(ctx: Ctx, warn: Warn): Promise<OraBackup> {
  const jobs = await safe('RMAN 作业', async () => oraQuery(ctx.conn, `select * from (
      select session_key, command_id, status, to_char(start_time,'MM-DD HH24:MI') st, to_char(end_time,'HH24:MI') et,
             elapsed_seconds, input_type, output_device_type, round(output_bytes/1073741824, 2) output_gb
        from v$rman_backup_job_details order by start_time desc) where rownum <= 40`), warn, [])

  const sets = await safe('备份集', async () => oraQuery(ctx.conn, `select * from (
      select recid, backup_type, incremental_level, to_char(completion_time,'MM-DD HH24:MI') done,
             round(block_size * blocks/1073741824, 2) gb, pieces
        from v$backup_set order by completion_time desc) where rownum <= 30`), warn, [])

  const arch = await safe('归档量', async () => oraQuery(ctx.conn, `select count(*) cnt, round(sum(blocks * block_size)/1073741824, 2) gb
      from v$archived_log where first_time > sysdate - 1 and dest_id = 1`), warn, [])
  const fra = await safe('FRA', async () => oraQuery(ctx.conn, `select round(space_limit/1073741824, 2) limit_gb,
      round(space_used/1073741824, 2) used_gb from v$recovery_file_dest`), warn, [])

  const full = jobs.find((j) => String(j.input_type || '').includes('DB FULL'))
  const limitGb = num(fra[0]?.limit_gb)
  const usedGb = num(fra[0]?.used_gb)

  return {
    jobs: jobs.map((j) => ({
      sessionKey: num(j.session_key), commandId: String(j.command_id || ''), status: String(j.status || ''),
      startTime: String(j.st || ''), endTime: String(j.et || ''), elapsedS: num(j.elapsed_seconds),
      inputType: String(j.input_type || ''), device: String(j.output_device_type || ''), outputGb: num(j.output_gb)
    })),
    sets: sets.map((s) => ({
      recid: num(s.recid), backupType: String(s.backup_type || ''), incremental: String(s.incremental_level || ''),
      done: String(s.done || ''), gb: num(s.gb), pieces: num(s.pieces)
    })),
    archive: { count24h: num(arch[0]?.cnt), gb24h: num(arch[0]?.gb) },
    lastFull: full ? String(full.st || '') : '',
    lastStatus: full ? String(full.status || '') : '',
    fra: limitGb > 0 ? { usedGb, limitGb, usedPct: Math.round(usedGb * 10000 / limitGb) / 100 } : null
  }
}

// ---------------------------------------------------------------- Data Guard

export async function fetchDg(ctx: Ctx, warn: Warn): Promise<OraDg> {
  const db = await oraQuery(ctx.conn, `select database_role, protection_mode from v$database`, { maxRows: 1 })
  const stats = await safe('DG 统计', async () => oraQuery(ctx.conn, `select name, value, unit, time_computed from v$dataguard_stats`), warn, [])
  const dests = await safe('归档目标', async () => oraQuery(ctx.conn, `select dest_id, status, type, database_mode, recovery_mode,
      protection_mode, destination, error, db_unique_name, synchronized, gap_status,
      archived_seq# archived_seq, applied_seq# applied_seq
    from v$archive_dest_status where dest_id <= 10 order by dest_id`), warn, [])
  const procs = await safe('DG 进程', async () => oraQuery(ctx.conn, `select process, status, thread# thr, sequence# seq, block# blk, blocks
      from v$managed_standby order by process`), warn, [])

  return {
    available: stats.length > 0,
    stats: stats.map((s) => ({ name: String(s.name), value: String(s.value || ''), unit: String(s.unit || ''), timeComputed: String(s.time_computed || '') })),
    dests: dests.map((d) => ({
      destId: num(d.dest_id), status: String(d.status || ''), type: String(d.type || ''),
      dbMode: String(d.database_mode || ''), recoveryMode: String(d.recovery_mode || ''),
      protectionMode: String(d.protection_mode || ''), destination: String(d.destination || ''),
      error: String(d.error || ''), dbUnique: String(d.db_unique_name || ''),
      synchronized: String(d.synchronized || ''), gapStatus: String(d.gap_status || ''),
      archivedSeq: num(d.archived_seq), appliedSeq: num(d.applied_seq)
    })),
    processes: procs.map((p) => ({
      process: String(p.process || ''), status: String(p.status || ''), thread: num(p.thr),
      sequence: num(p.seq), block: num(p.blk)
    })),
    role: String(db[0]?.database_role || ''),
    protectionMode: String(db[0]?.protection_mode || '')
  }
}

// ---------------------------------------------------------------- 作业

export async function fetchJobs(ctx: Ctx, warn: Warn): Promise<OraJobs> {
  const scheduler = await safe('调度作业', async () => oraQuery(ctx.conn, `select owner, job_name, enabled, state, run_count, failure_count,
      to_char(last_start_date,'MM-DD HH24:MI') last_start, to_char(next_run_date,'MM-DD HH24:MI') next_run
    from dba_scheduler_jobs order by owner, job_name`), warn, [])
  const dbms = await safe('DBMS 作业', async () => oraQuery(ctx.conn, `select job, log_user, broken, failures,
      to_char(last_date,'MM-DD HH24:MI') last_date, to_char(next_date,'MM-DD HH24:MI') next_date, substr(what, 1, 120) what
    from dba_jobs order by job`), warn, [])
  const runs = await safe('作业历史', async () => oraQuery(ctx.conn, `select * from (
      select owner, job_name, status, to_char(actual_start_date,'MM-DD HH24:MI') st, round(run_duration) dur_s,
             substr(additional_info, 1, 200) info
        from dba_scheduler_job_run_details order by actual_start_date desc) where rownum <= 80`), warn, [])

  return {
    scheduler: scheduler.map((j) => ({
      owner: String(j.owner), jobName: String(j.job_name), enabled: String(j.enabled || ''),
      state: String(j.state || ''), runCount: num(j.run_count), failureCount: num(j.failure_count),
      lastStart: String(j.last_start || ''), nextRun: String(j.next_run || '')
    })),
    dbms: dbms.map((j) => ({
      job: num(j.job), logUser: String(j.log_user || ''), broken: String(j.broken || ''),
      failures: num(j.failures), lastDate: String(j.last_date || ''), nextDate: String(j.next_date || ''),
      what: String(j.what || '')
    })),
    runs: runs.map((r) => ({
      owner: String(r.owner || ''), jobName: String(r.job_name || ''), status: String(r.status || ''),
      startTime: String(r.st || ''), durationS: num(r.dur_s), info: String(r.info || '')
    }))
  }
}

// ---------------------------------------------------------------- 参数

export async function fetchParams(ctx: Ctx, warn: Warn): Promise<OraParams> {
  const changed = await safe('非默认参数', async () => oraQuery(ctx.conn, `select name, value, issys_modifiable, substr(description, 1, 160) descr
      from v$parameter where isdefault = 'FALSE' order by name`), warn, [])
  const key = await safe('关键参数', async () => oraQuery(ctx.conn, `select name, value, isdefault, issys_modifiable from v$parameter
      where name in ('sga_target','sga_max_size','pga_aggregate_target','memory_target','processes','sessions',
        'db_block_size','optimizer_mode','compatible','cursor_sharing','open_cursors','db_files','filesystemio_options',
        'undo_retention','db_recovery_file_dest','log_archive_dest_1','job_queue_processes','statistics_level') order by name`), warn, [])
  return {
    changed: changed.map((c) => ({ name: String(c.name), value: String(c.value || ''), modifiable: String(c.issys_modifiable || ''), desc: String(c.descr || '') })),
    key: key.map((k) => ({ name: String(k.name), value: String(k.value || ''), isDefault: String(k.isdefault || ''), modifiable: String(k.issys_modifiable || '') }))
  }
}

// ---------------------------------------------------------------- 用户与对象

export async function fetchUsers(ctx: Ctx, warn: Warn): Promise<OraUsers> {
  const users = await safe('用户', async () => oraQuery(ctx.conn, `select username, account_status, to_char(expiry_date,'YYYY-MM-DD') expiry,
      default_tablespace, temporary_tablespace, profile, to_char(created,'YYYY-MM-DD') created, authentication_type
    from dba_users order by username`), warn, [])
  const pwfile = await safe('口令文件用户', async () => oraQuery(ctx.conn, `select username, sysdba, sysoper, admin from v$pwfile_users`), warn, [])
  const roles = await safe('角色', async () => oraQuery(ctx.conn, `select granted_role, admin_option, default_role from dba_role_privs where grantee = user`), warn, [])
  const privs = await safe('权限', async () => oraQuery(ctx.conn, `select privilege, admin_option from user_sys_privs order by privilege`), warn, [])
  const invalid = await safe('失效对象', async () => oraQuery(ctx.conn, `select owner, object_type, count(*) c from dba_objects
      where status = 'INVALID' group by owner, object_type order by 3 desc`), warn, [])
  const types = await safe('对象统计', async () => oraQuery(ctx.conn, `select object_type, count(*) c from dba_objects group by object_type order by 2 desc`), warn, [])
  // dba_segments 全表扫，只在用户点开这个分区时执行（不进总览）
  const segments = await safe('大对象', async () => oraQuery(ctx.conn, `select * from (
      select owner, segment_name, segment_type, tablespace_name, round(bytes/1048576, 2) mb
        from dba_segments order by bytes desc) where rownum <= 25`), warn, [])
  const total = await safe('对象总数', async () => num(await oraScalar(ctx.conn, `select count(*) from dba_objects`)), warn, 0)

  return {
    users: users.map((u) => ({
      username: String(u.username), status: String(u.account_status || ''), expiry: String(u.expiry || ''),
      defaultTs: String(u.default_tablespace || ''), tempTs: String(u.temporary_tablespace || ''),
      profile: String(u.profile || ''), created: String(u.created || ''), authType: String(u.authentication_type || '')
    })),
    pwfile: pwfile.map((p) => ({ username: String(p.username), sysdba: String(p.sysdba || ''), sysoper: String(p.sysoper || ''), admin: String(p.admin || '') })),
    roles: roles.map((r) => ({ role: String(r.granted_role), adminOption: String(r.admin_option || ''), defaultRole: String(r.default_role || '') })),
    privs: privs.map((p) => ({ privilege: String(p.privilege), adminOption: String(p.admin_option || '') })),
    invalid: invalid.map((i) => ({ owner: String(i.owner), objectType: String(i.object_type), count: num(i.c) })),
    objectTypes: types.map((t) => ({ objectType: String(t.object_type), count: num(t.c) })),
    segments: segments.map((s) => ({ owner: String(s.owner), name: String(s.segment_name), type: String(s.segment_type), tablespace: String(s.tablespace_name || ''), mb: num(s.mb) })),
    totalObjects: total
  }
}
