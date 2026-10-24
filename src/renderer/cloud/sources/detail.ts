/**
 * 悬浮卡「数据明细」的生成器：按 data-src 的 key + 元素上的 data-* 属性，
 * 从当前云端状态里拼出「这条数据具体来自哪些对象」。
 * 页面局部状态（如抽屉里刚加载的会话数）不在这里，由元素自己的 data-detail 兜底。
 */
import { cloud } from '../state'
import { ora, envOf, type OraEnvItem } from '../oracle'
import * as F from '../parts'

const one = (s: string): string => s.replace(/\s+/g, ' ').trim()
const gib = (n: number): string => (n / 2 ** 30).toFixed(1)

/** 汇总各处缓存里的集群，按名字去重（详情页只有一个，列表/总览有一批） */
function allClusters(): CloudCluster[] {
  const pool = [
    ...(cloud.overview?.clusters || []),
    ...cloud.clusters,
    ...(cloud.cluster?.cluster ? [cloud.cluster.cluster] : [])
  ]
  const map = new Map<string, CloudCluster>()
  for (const c of pool) if (c && !map.has(c.name)) map.set(c.name, c)
  return [...map.values()]
}

/** Oracle 当前这套环境的 overview 数据（没加载过返回 undefined，就不用补明细） */
function oraOv(): CloudOraOverview | undefined {
  return cur<CloudOraOverview>('overview')
}

function clusterOf(name: string): CloudCluster | undefined {
  const list = allClusters()
  if (name) return list.find((c) => c.name === name)
  return list[0]
}

function clusterLines(limit = 8): string[] {
  return allClusters()
    .slice(0, limit)
    .map((c) => one(`${c.name}：${F.clusterStatus(c.status).label} · v${c.version} · ${c.serverCount} 节点 · ${c.tenantCount} 租户`))
}

/** 把 OCP 告警 target（alarm_template_id=0:host=1.2.3.4:exporter=…）还原成「主机 1.2.3.4」 */
function prettyTarget(a: CloudAlarm): string {
  const scope = F.alarmScope(a.scope) || a.appType
  const raw = String(a.target || '').replace(/^alarm_template_id=\d+:/, '')
  const m = raw.match(/^(?:host|svr|tenant|cluster|obproxy)=([^:]+)/)
  if (m) return `${scope} ${m[1]}`
  return raw ? `${scope} ${raw}` : scope
}

function alarmLines(limit = 6): string[] {
  const rows = cloud.alarms.slice(0, limit).map((a) => one(`L${a.level} ${prettyTarget(a)}：${a.name}`))
  if (cloud.alarms.length > limit) rows.push(`…等共 ${cloud.alarms.length} 条活跃告警`)
  return rows.length ? rows : ['当前没有活跃告警']
}

function capLines(c: CloudCluster): string[] {
  return [
    one(`集群 ${c.name}（${F.clusterStatus(c.status).label}）· ${c.serverCount} 节点 · ${c.tenantCount} 个租户`),
    one(`rootserver：${c.rootServer || '—'}`),
    one(`CPU 已分配 ${c.cpu.used}/${c.cpu.total} 核（${c.cpu.pct}%）`),
    one(`内存已分配 ${gib(c.memory.used)}/${gib(c.memory.total)} GiB（${c.memory.pct}%）`),
    one(`数据盘已用 ${c.disk.pct}%${c.alarms.total ? ` · 活跃告警 ${c.alarms.total} 条` : ' · 无告警'}`)
  ]
}

export function sourceDetail(key: string, el: Element): string[] | undefined {
  const clusterName = el.getAttribute('data-cluster') || ''
  const hostIp = el.getAttribute('data-host') || ''
  const tenantName = el.getAttribute('data-tenant') || ''
  const ov = cloud.overview
  const cd = cloud.cluster
  const td = cloud.tenant

  switch (key) {
    // ---------------------------------------------------------------- 总览
    case 'clusters':
    case 'clList':
      return clusterLines()
    case 'tenants':
      return allClusters().map((c) => one(`${c.name}（${F.clusterStatus(c.status).label}）：${c.tenantCount} 个租户`))
    case 'hosts': {
      const online = cloud.hosts.filter((h) => h.status === 'ONLINE').length
      const agentBad = cloud.hosts.filter((h) => h.agentStatus !== 'AVAILABLE').length
      return [one(`纳管 ${cloud.hosts.length} 台 · 在线 ${online} · 离线 ${cloud.hosts.length - online} · Agent 异常 ${agentBad}`)]
    }
    case 'alarms':
    case 'alarmList':
    case 'alarmTarget':
      return alarmLines()
    case 'alarmHead': {
      const byLevel = new Map<number, number>()
      for (const a of cloud.alarms) byLevel.set(a.level, (byLevel.get(a.level) || 0) + 1)
      if (!byLevel.size) return ['当前没有活跃告警']
      return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([lv, n]) => one(`L${lv} ${F.alarmLevel(lv).label}：${n} 条`))
    }
    case 'cpu':
      return allClusters().map((c) =>
        one(`${c.name}：已分配 ${c.cpu.used}/${c.cpu.total} 核（${c.cpu.pct}%） · 内存 ${gib(c.memory.used)}/${gib(c.memory.total)} GiB`)
      )
    case 'clusterCap': {
      const c = clusterOf(cd?.cluster.name || clusterName)
      return c ? capLines(c) : []
    }
    case 'taskList':
      return cloud.tasks.items.slice(0, 5).map((t) => one(`${F.taskStatus(t.status).label} · ${t.name} · ${t.clusterName || '—'}`))

    // ---------------------------------------------------------------- 集群
    case 'clMeta': {
      const c = clusterOf(clusterName) || cd?.cluster
      if (!c) return []
      return [
        one(`集群 ${c.name} · OBClusterID ${c.obClusterId} · v${c.version}`),
        one(`${F.clusterMode(c.clusterMode)} · ${F.originLabel(c.origin)} · ${c.regionCount} 区域`),
        one(`创建于 ${F.fmtTime(c.createTime)}（${c.creator || '—'}）`)
      ]
    }
    case 'clZones': {
      if (!cd?.zones?.length) return []
      return cd.zones.map((z) => one(`${z.name}：${z.status} · ${z.region}/${z.idc} · ${z.serverCount} 台${z.rootServer ? ` · RS ${z.rootServer}` : ''}`))
    }
    case 'clServers': {
      if (!cd?.servers?.length) return []
      const rows = cd.servers.slice(0, 6).map((s) => one(`${s.ip} · ${s.zone} · ${s.status}${s.withRootserver ? ' · RootServer' : ''}`))
      if (cd.servers.length > 6) rows.push(`…共 ${cd.servers.length} 台 OBServer`)
      return rows
    }
    case 'clTenants': {
      if (!cd?.tenants?.length) return []
      const rows = cd.tenants.slice(0, 6).map((t) => one(`${t.name}：${t.mode} · ${F.tenantStatus(t.status).label} · ${t.primaryZone || '—'}`))
      if (cd.tenants.length > 6) rows.push(`…共 ${cd.tenants.length} 个租户`)
      return rows
    }
    case 'clAlarm': {
      const c = clusterOf(clusterName)
      if (!c) return []
      const lv = c.alarms.levels.filter((x) => x.count > 0)
      if (!lv.length) return [one(`集群 ${c.name}：当前没有活跃告警`)]
      return lv.map((x) => one(`集群 ${c.name} · L${x.level} ${F.alarmLevel(x.level).label}：${x.count} 条`))
    }
    case 'clStartup': {
      if (!cd?.startupParameters?.length) return []
      return cd.startupParameters.map((p) => one(`${p.key} = ${p.value}`))
    }

    // ---------------------------------------------------------------- 租户
    case 'tnList': {
      // 抽屉/表格里的 data-tenant 优先：只描述当前这一条，而不是整份租户清单
      const cur = tenantName
        ? td?.tenant.name === tenantName
          ? td.tenant
          : cloud.tenants.find((x) => x.name === tenantName)
        : undefined
      if (cur) {
        return [
          one(`${cur.clusterName}/${cur.name}：${cur.mode} · ${F.tenantStatus(cur.status).label}${cur.locked ? ' · 已锁定' : ''}${cur.readonly ? ' · 只读' : ''}`),
          one(`OB 租户 ID ${cur.obTenantId} · 角色 ${cur.role || '—'} · 主 Zone ${cur.primaryZone || '—'}`),
          one(`副本分布 ${cur.locality || '—'}`)
        ]
      }
      const rows = cloud.tenants.slice(0, 6).map((t) => one(`${t.clusterName}/${t.name}：${t.mode} · ${F.tenantStatus(t.status).label} · ${t.primaryZone || '—'}`))
      if (cloud.tenants.length > 6) rows.push(`…共 ${cloud.tenants.length} 个租户`)
      return rows
    }
    case 'tnReplica': {
      if (td) {
        return [
          one(`租户 ${td.tenant.name}（${td.tenant.clusterName}）· OB 租户 ID ${td.tenant.obTenantId}`),
          ...td.zones.map((z) => one(`${z.name}：${z.replicaType} · 池 ${z.poolName} · ${z.unitCount} 个 Unit · ${z.unitCpu} 核/${F.fmtBytes(z.unitMemory)}`))
        ]
      }
      const t = tenantName ? cloud.tenants.find((x) => x.name === tenantName) : undefined
      return t ? [one(`租户 ${t.name} · ${t.locality || '—'}`)] : []
    }
    case 'tnWhitelist':
      if (td) return [one(`租户 ${td.tenant.name}：${td.whitelist || '—'}`)]
      return undefined

    // ---------------------------------------------------------------- 主机
    case 'htList': {
      const rows = cloud.hosts.slice(0, 6).map((h) => one(`${h.ip}（${h.alias || h.name}）：${F.hostStatus(h.status).label} · ${h.os || '—'}`))
      if (cloud.hosts.length > 6) rows.push(`…共 ${cloud.hosts.length} 台主机`)
      return rows
    }
    case 'htAgent': {
      const bad = cloud.hosts.filter((h) => h.agentStatus !== 'AVAILABLE')
      if (!bad.length) return [one(`全部 ${cloud.hosts.length} 台主机 Agent 心跳正常（AVAILABLE）`)]
      return bad.slice(0, 6).map((h) => one(`${h.ip}：${F.agentStatus(h.agentStatus).label} · Agent ${h.agentVersion || '—'}`))
    }
    case 'htService': {
      const rows = cloud.hosts
        .filter((h) => h.services.length)
        .slice(0, 6)
        .map((h) => one(`${h.ip}：${h.services.map((s) => `${F.serviceLabel(s.type)} ${s.name}`).join(' / ')}`))
      return rows.length ? rows : ['没有主机上报承载服务']
    }
    case 'htHost': {
      const h = hostIp ? cloud.hosts.find((x) => x.ip === hostIp) : cloud.hosts[0]
      return h ? [one(`${h.ip}（${h.alias || h.name}）：${F.hostKind(h.kind)} · ${h.os || '—'}`), one(`区域 ${h.region || '—'} / ${h.idc || '—'} · SSH ${h.sshPort || '—'}`)] : []
    }

    // ---------------------------------------------------------------- 监控
    case 'moCluster':
    case 'moTenant':
    case 'moHost': {
      const rows = cloud.monitor.series
        .filter((s) => s.points.length)
        .map((s) => one(`${s.label}：${F.relTime(new Date(cloud.monitor.updatedAt || Date.now()).toISOString())} 最新 ${s.last ?? '—'} ${s.unit}`))
      return rows.length ? rows.slice(0, 6) : ['还没有取到采样点']
    }

    // ---------------------------------------------------------------- SQL 诊断
    case 'sqlTopSql': {
      const list = [...cloud.sqldiag.rows].sort((a, b) => b.cpuPercentage - a.cpuPercentage).slice(0, 5)
      if (!list.length) return ['当前时间窗内没有 SQL 记录']
      return list.map((r) =>
        one(`CPU ${r.cpuPercentage.toFixed(1)}% · ${r.tenantName || '—'}/${r.dbName || '—'} · 执行 ${r.executions} 次 · ${r.sqlId}`)
      )
    }
    case 'sqlStats': {
      const st = cloud.sqldiag.stats
      if (!st.length) return ['当前时间窗内没有 SQL 概况数据']
      return st.map((x) => one(`${x.tenantName}：新 SQL ${x.newSqlCount} · 慢 SQL ${x.slowSqlCount} · 异常 ${x.anomalySqlCount} · 高风险 ${x.highRiskSqlCount}`))
    }

    // ---------------------------------------------------------------- Oracle
    case 'orEnv':
    case 'orEnvState': {
      const id = el.getAttribute('data-env') || ''
      const e = (id ? envOf(id) : undefined) || (ora.envId ? envOf(ora.envId) : undefined)
      if (!e) return ['还没有接入 Oracle 环境']
      return oraEnvLines(e)
    }
    case 'orFleetKpi': {
      const ok = ora.envs.filter((e) => e.summary && !e.error)
      const blocking = ok.filter((e) => (e.summary?.blocking || 0) > 0).length
      const ts = ok.filter((e) => (e.summary?.tsWorst?.usedPct || 0) >= 85).length
      return [
        one(`环境 ${ora.envs.length} 套 · 可连 ${ok.length} 套${ora.envs.length - ok.length ? ` · 连不上 ${ora.envs.length - ok.length} 套` : ''}`),
        one(`会话合计 ${sum(ok, (e) => e.summary!.sessions)}（活跃 ${sum(ok, (e) => e.summary!.activeSessions)}）`),
        one(`有阻塞的环境 ${blocking} · 水位≥85% 的环境 ${ts} · 失效对象合计 ${sum(ok, (e) => e.summary!.invalid)}`)
      ]
    }
    case 'orFleetIssues': {
      const all = oracleIssues()
      if (!all.length) return ['所有环境的概要里都没有发现需要处理的问题']
      return all.slice(0, 6).map((i) => one(`${i.level === 'bad' ? '高' : i.level === 'warn' ? '中' : '低'} · ${i.env}：${i.title}`))
        .concat(all.length > 6 ? [`…等共 ${all.length} 条`] : [])
    }
    case 'orFleetCap': {
      const rows = ora.envs.filter((e) => e.summary?.tsWorst)
      if (!rows.length) return ['没有取到表空间水位']
      return rows.map((e) => one(`${e.name}：${e.summary!.tsWorst!.name} ${e.summary!.tsWorst!.usedPct.toFixed(1)}%`))
    }
    case 'orFleetLoad': {
      const rows = ora.envs.filter((e) => e.summary)
      if (!rows.length) return ['没有取到会话数据']
      return rows.map((e) => one(`${e.name}：${e.summary!.sessions} 会话（活跃 ${e.summary!.activeSessions}）${e.summary!.blocking ? ` · 阻塞 ${e.summary!.blocking}` : ''}`))
    }
    case 'orFleetTable':
      return [`共 ${ora.envs.length} 行（${ora.envs.filter((e) => e.summary && !e.error).length} 行可连）`, '一行 = 一套环境；点行进入该库详情']
    case 'orDbMeta': {
      const e = ora.envId ? envOf(ora.envId) : undefined
      if (!e) return ['还没有选中环境']
      const s = e.summary
      const base = [one(`${e.name} · ${e.host}:${e.port}${e.serviceName ? '/' + e.serviceName : ''} · ${e.username}`)]
      if (!s) return base.concat(e.error ? [`连接失败：${e.error.slice(0, 120)}`] : ['还没取到概要'])
      return base.concat([
        one(`${s.version.replace('Oracle Database ', '')}`),
        one(`${s.databaseRole} · ${s.openMode} · ${s.logMode} · ${s.isRac ? 'RAC' : '单实例'}${s.isCdb ? ' · CDB' : ''}`),
        one(`启动 ${s.startupTime || '—'}`)
      ])
    }
    case 'orOverview': {
      const o = cur<CloudOraOverview>('overview')
      if (!o) return ['这个 tab 还没加载']
      return o.kpis.slice(0, 4).map((k) => one(`${k.label}：${k.value}${k.sub ? `（${k.sub}）` : ''}`))
        .concat(o.issues.length ? [`需要关注 ${o.issues.length} 条（本页规则推导）`] : ['没有需要关注的问题'])
    }
    case 'orRac': {
      const r = cur<CloudOraRac>('rac')
      if (!r) return ['这个 tab 还没加载']
      return [
        one(`cluster_database = ${r.clusterDatabase} · 配置实例 ${r.configuredInstances || '—'}`),
        one(`在线节点 ${r.nodes.filter((n) => n.status === 'OPEN').length}/${r.nodes.length} · 服务 ${r.services.length} 个 · 私网 ${r.interconnects.length} 条`)
      ]
    }
    case 'orInstances': {
      const list = cur<CloudOraInstanceDetail[]>('instances')
      if (!list) return ['这个 tab 还没加载']
      return list.map((i) => one(`${i.instanceName}：SGA ${fmtMb(i.sgaMb)} / PGA ${fmtMb(i.pgaMb)} · ${i.osCpus} 核 load ${i.load.toFixed(2)}`))
    }
    case 'orPdb': {
      const p = cur<CloudOraPdbSection>('pdb')
      if (!p) return ['这个 tab 还没加载']
      if (!p.isCdb) return ['当前实例不是 CDB（v$pdbs 不存在）']
      return [one(`${p.pdbs.length} 个 PDB · 打开 ${p.pdbs.filter((x) => x.openMode.includes('READ WRITE')).length} 个`)]
    }
    case 'orStorage': {
      const st = cur<CloudOraStorage>('storage')
      if (!st) return ['这个 tab 还没加载']
      const worst = st.tablespaces[0]
      return [
        one(`表空间 ${st.tablespaces.length} 个${worst ? ` · 最高 ${worst.name} ${worst.usedPct.toFixed(1)}%` : ''}`),
        one(`数据文件 ${st.datafiles.length} 个 · 在线日志 ${st.redo.length} 组 · ASM ${st.asm.length} 个磁盘组`),
        one(st.fra ? `FRA ${st.fra.usedGb}/${st.fra.limitGb} GB · 归档 24h ${st.archive.last24h.count} 个` : `归档目标 ${st.archive.dests.length} 个`)
      ]
    }
    case 'orSessions': {
      const ss = cur<CloudOraSessions>('sessions')
      if (!ss) return ['这个 tab 还没加载']
      return [
        one(`用户会话 ${sum(ss.list, () => 1)} 行（列表上限 300）· 阻塞链 ${ss.blocking.length} 条`),
        one(`长操作 ${ss.longops.length} 个${ss.longops.length ? ` · 最短剩余 ${Math.min(...ss.longops.map((l) => l.timeRemaining))}s` : ''}`)
      ]
    }
    case 'orSql': {
      const q = cur<CloudOraSqlSection>('sql')
      if (!q) return ['这个 tab 还没加载']
      return [
        one(`排序：${q.by} · 共享池 TopSQL ${q.rows.length} 行`),
        one(`AWR 历史 ${q.awr.length} 行${q.awrRange ? `（${q.awrRange}）` : ''}`)
      ]
    }
    case 'orPerf': {
      const pf = cur<CloudOraPerf>('perf')
      if (!pf) return ['这个 tab 还没加载']
      const top = pf.systemEvent[0]
      return [
        one(`sysmetric ${pf.metrics.length} 项 · 系统等待 ${pf.systemEvent.length} 类 · ASH ${pf.ash.length} 组（${pf.ashWindow}）`),
        one(top ? `最耗时等待：${top.event} ${top.timeS.toFixed(0)}s` : '没有非空闲等待')
      ]
    }
    case 'orAlerts': {
      const al = cur<CloudOraAlerts>('alerts')
      if (!al) return ['这个 tab 还没加载']
      const top = al.groups[0]
      return [
        one(`窗口 ${al.hours}h · 日志 ${al.total.toLocaleString('zh-CN')} 条 · 含 ORA- ${al.errorCount} 条`),
        one(top ? `最多的一类：${top.count} 次「${top.pattern.slice(0, 40)}」` : '这段时间没有日志')
      ]
    }
    case 'orBackup': {
      const b = cur<CloudOraBackup>('backup')
      if (!b) return ['这个 tab 还没加载']
      return [
        one(`RMAN 作业 ${b.jobs.length} 条 · 最近全库备份 ${b.lastFull || '无'}（${b.lastStatus || '—'}）`),
        one(`备份集 ${b.sets.length} 个 · 归档 24h ${b.archive.count24h} 个 / ${b.archive.gb24h} GB`)
      ]
    }
    case 'orDg': {
      const g = cur<CloudOraDg>('dg')
      if (!g) return ['这个 tab 还没加载']
      return [
        one(`${g.role} · ${g.protectionMode}${g.available ? '' : ' · 无延迟统计'}`),
        one(`归档目标 ${g.dests.length} 个 · DG 进程 ${g.processes.length} 个`)
      ]
    }
    case 'orJobs': {
      const j = cur<CloudOraJobs>('jobs')
      if (!j) return ['这个 tab 还没加载']
      const failed = j.scheduler.filter((x) => x.failureCount > 0).length
      return [
        one(`Scheduler ${j.scheduler.length} 个（失败过 ${failed} 个）· DBMS_JOB ${j.dbms.length} 个`),
        one(`运行历史 ${j.runs.length} 条（最近 80 条）`)
      ]
    }
    case 'orParams': {
      const pa = cur<CloudOraParams>('params')
      if (!pa) return ['这个 tab 还没加载']
      return [one(`非默认参数 ${pa.changed.length} 个 · 关键参数 ${pa.key.length} 个`), 'ISSYS_MODIFIABLE=FALSE 的改动需要重启实例']
    }
    case 'orUsers': {
      const us = cur<CloudOraUsers>('users')
      if (!us) return ['这个 tab 还没加载']
      return [
        one(`账号 ${us.users.length} 个 · 锁定/过期 ${us.users.filter((u) => u.status !== 'OPEN').length} 个 · SYSDBA ${us.pwfile.filter((p) => p.sysdba === 'TRUE').length} 个`),
        one(`对象 ${us.totalObjects.toLocaleString('zh-CN')} 个 · 失效 ${us.invalid.reduce((a, b) => a + b.count, 0)} 个`)
      ]
    }

    // ---- 指标级：卡片 / KPI 磁贴只报这一个指标当前的值（没加载过就不用补）
    case 'orKpiInst': {
      const o = oraOv()
      if (!o) return undefined
      return o.instances.map((i) => one(`${i.name}（${i.host}）：${i.status} · ${i.sessions} 会话`))
    }
    case 'orKpiDb':
    case 'orOvInfo': {
      const o = oraOv()
      if (!o) return undefined
      return [
        one(`${o.info.dbName} / ${o.info.dbUniqueName}`),
        one(`${o.info.databaseRole} · ${o.info.openMode} · ${o.info.logMode} · ${o.info.isRac ? 'RAC' : '单实例'}`)
      ]
    }
    case 'orKpiSess':
    case 'orOvInstSess': {
      const o = oraOv()
      if (!o) return undefined
      return o.instances.map((i) => one(`${i.name}：${i.sessions} 会话（活跃 ${i.active}）`))
    }
    case 'orKpiTps':
    case 'orKpiCpu':
    case 'orOvMetrics':
    case 'orPfMetric': {
      const list = oraOv()?.metrics?.length ? oraOv()!.metrics : cur<CloudOraPerf>('perf')?.metrics
      if (!list?.length) return undefined
      return list.slice(0, 4).map((m) => one(`${m.name}：${Number(m.value).toFixed(2)} ${m.unit || ''}`))
    }
    case 'orKpiBlock':
    case 'orSeBlocking': {
      const ss = cur<CloudOraSessions>('sessions')
      if (!ss) return undefined
      if (!ss.blocking.length) return ['当前没有阻塞链']
      return ss.blocking.slice(0, 4).map((b) =>
        one(`${b.sid} 被 ${b.blockerSid} 挡住${b.blockerSql ? `（阻塞者 ${b.blockerSql}）` : ''}${b.event ? ` · ${b.event}` : ''} · ${b.ctime}s`)
      )
    }
    case 'orKpiTs':
    case 'orOvTs':
    case 'orStTs': {
      const st = cur<CloudOraStorage>('storage')
      const ts = st
        ? st.tablespaces.map((t) => ({ name: t.name, usedPct: t.usedPct }))
        : (oraOv()?.tablespaces || []).map((t) => ({ name: t.name, usedPct: t.usedPct }))
      if (!ts.length) return undefined
      return ts.slice(0, 3).map((t) => one(`${t.name} ${Number(t.usedPct).toFixed(1)}%`))
    }
    case 'orKpiInvalid': {
      const u = cur<CloudOraUsers>('users')
      if (!u) return undefined
      if (!u.invalid.length) return ['没有失效对象']
      return u.invalid.slice(0, 4).map((i) => one(`${i.owner} · ${i.objectType}：${i.count} 个`))
    }
    case 'orOvWait':
    case 'orPfWait': {
      const ev = cur<CloudOraPerf>('perf')?.systemEvent || []
      const waits = ev.length
        ? ev.map((e) => ({ event: e.event, timeS: e.timeS }))
        : (oraOv()?.waits || []).map((w) => ({ event: w.event, timeS: w.timeS }))
      if (!waits.length) return undefined
      return waits.slice(0, 3).map((w) => one(`${w.event}：${Number(w.timeS).toFixed(0)}s`))
    }
    case 'orOvAlertHour': {
      const o = oraOv()
      if (!o?.alertHours.length) return undefined
      const total = o.alertHours.reduce((a, b) => a + b.count, 0)
      const peak = Math.max(...o.alertHours.map((h) => h.count))
      return [one(`${o.alertHours[0].hour} → ${o.alertHours[o.alertHours.length - 1].hour} 共 ${total} 条`), one(`峰值 ${peak} 条/小时`)]
    }
    case 'orOvIssues': {
      const o = oraOv()
      if (!o) return undefined
      return o.issues.length ? o.issues.slice(0, 4).map((i) => one(`${i.level === 'bad' ? '高' : i.level === 'warn' ? '中' : '低'} · ${i.title}`)) : ['没有需要关注的问题']
    }
    case 'orStFra': {
      const f = cur<CloudOraStorage>('storage')?.fra
      if (!f) return undefined
      const pct = f.limitGb > 0 ? Math.round((f.usedGb * 1000) / f.limitGb) / 10 : 0
      return [one(`${f.usedGb}/${f.limitGb} GB（${pct}%）· 可回收 ${f.reclaimGb} GB`), ...f.usage.slice(0, 2).map((u) => one(`${u.type} ${u.usedPct.toFixed(1)}%`))]
    }
    case 'orStArch': {
      const a = cur<CloudOraStorage>('storage')?.archive
      if (!a) return undefined
      return [
        one(`近 24h ${a.last24h.count} 个 / ${a.last24h.gb} GB`),
        ...a.dests.filter((d) => d.error || d.gapStatus).slice(0, 2).map((d) => one(`DEST ${d.destId} ${d.status} ${d.error || d.gapStatus}`))
      ]
    }
    case 'orSeLong': {
      const ss = cur<CloudOraSessions>('sessions')
      if (!ss) return undefined
      if (!ss.longops.length) return ['当前没有长操作']
      return ss.longops.slice(0, 3).map((l) => one(`${l.opname} ${l.pct}% · 剩余 ${l.timeRemaining}s${l.sqlId ? ` · ${l.sqlId}` : ''}`))
    }
    case 'orAlGroups': {
      const al = cur<CloudOraAlerts>('alerts')
      if (!al) return undefined
      return al.groups.slice(0, 3).map((g) => one(`${g.count} 次 · ${g.pattern.slice(0, 50)}`))
    }
    case 'orStRedo': {
      const st = cur<CloudOraStorage>('storage')
      if (!st) return undefined
      return st.redo.slice(0, 4).map((r) => one(`#${r.group} · ${r.mb} MB · ${r.status}${r.archived ? ` / ${r.archived}` : ''}${r.firstTime ? ` · ${r.firstTime}` : ''}`))
    }
    case 'orStAsm': {
      const st = cur<CloudOraStorage>('storage')
      if (!st) return undefined
      if (!st.asm.length) return ['没有 ASM 磁盘组（文件系统存储或未授权）']
      return st.asm.slice(0, 3).map((a) => one(`${a.name} ${a.usedPct.toFixed(1)}% · 可用 ${a.usableMb} MB · ${a.disks} 块盘 · ${a.type}`))
    }
    case 'orStDf': {
      const st = cur<CloudOraStorage>('storage')
      if (!st) return undefined
      const manual = st.datafiles.filter((f) => f.autoextensible !== 'YES')
      return [one(`数据文件 ${st.datafiles.length} 个，其中 ${manual.length} 个未开自动扩展`), ...manual.slice(0, 2).map((f) => one(`${f.tablespace}: ${f.fileName.split('/').pop()} ${f.sizeMb} MB`))]
    }
    case 'orInstSga':
    case 'orPfSga': {
      const list = cur<CloudOraInstanceDetail[]>('instances')?.[0]?.sga || cur<CloudOraPerf>('perf')?.sga
      if (!list?.length) return undefined
      return list.slice(0, 4).map((s) => one(`${s.name}：${fmtMb(s.mb)}`))
    }
    case 'orInstPga':
    case 'orPfPga': {
      const list = cur<CloudOraInstanceDetail[]>('instances')?.[0]?.pga || cur<CloudOraPerf>('perf')?.pga
      if (!list?.length) return undefined
      return list.slice(0, 4).map((p) => one(`${p.name}：${fmtMb(p.mb)}`))
    }
    case 'orInstBuf': {
      const buf = cur<CloudOraInstanceDetail[]>('instances')?.[0]?.bufferHit
      if (!buf?.length) return undefined
      return buf.map((b) => one(`${b.name}：miss ${b.missPct.toFixed(2)}% · gets ${b.gets}`))
    }
    case 'orInstRes': {
      const res = cur<CloudOraInstanceDetail[]>('instances')?.[0]?.resource
      if (!res?.length) return undefined
      return res.map((r) => one(`${r.name}：${r.current} / ${r.max}${r.max > 0 ? `（${Math.round((r.current * 100) / r.max)}%）` : ''}`))
    }
    case 'orBkJobs': {
      const b = cur<CloudOraBackup>('backup')
      if (!b) return undefined
      return [one(`最近全库备份 ${b.lastFull || '无'}（${b.lastStatus || '—'}）`), ...b.jobs.slice(0, 2).map((j) => one(`${j.startTime} ${j.inputType} ${j.status} · ${j.outputGb} GB`))]
    }

    // ---------------------------------------------------------------- 平台
    case 'cfgOcp': {
      const p = cloud.platforms.find((x) => x.id === cloud.activeId)
      if (!p) return ['还没有接入 OCP 平台']
      return [one(`平台 ${p.name} · ${p.baseUrl}`), one(`账号 ${p.username || '—'} · 口令 DPAPI 加密存储`)]
    }

    default:
      return undefined
  }
}

// ---------------------------------------------------------------- Oracle 小工具

function sum<T>(list: T[], pick: (x: T) => number): number {
  return list.reduce((a, b) => a + (Number(pick(b)) || 0), 0)
}

function fmtMb(mb: number): string {
  const n = Number(mb) || 0
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n.toFixed(0)} MB`
}

/** 取当前打开详情这套环境的某个 tab 数据（没加载过返回 undefined） */
function cur<T>(section: keyof CloudOraSections): T | undefined {
  if (!ora.envId) return undefined
  return (ora.data[ora.envId] as any)?.[section] as T | undefined
}

function oraEnvLines(e: OraEnvItem): string[] {
  const base = [one(`${e.name} · ${e.host}:${e.port}${e.serviceName ? '/' + e.serviceName : ''} · ${e.username}`)]
  if (e.loading) return base.concat('正在探测…')
  if (e.error) return base.concat([`连接失败：${e.error.slice(0, 140)}`])
  const s = e.summary
  if (!s) return base.concat('还没取到概要')
  return base.concat([
    one(`${s.version.replace('Oracle Database ', '').replace(' Release', '')}`),
    one(`${s.databaseRole} · ${s.openMode} · ${s.logMode} · ${s.isRac ? 'RAC' : '单实例'}${s.isCdb ? ' · CDB' : ''}`),
    one(`实例 ${s.instancesOpen}/${s.instances} · 会话 ${s.sessions}（活跃 ${s.activeSessions}）· 阻塞 ${s.blocking}`),
    one(`最高水位 ${s.tsWorst ? `${s.tsWorst.name} ${s.tsWorst.usedPct.toFixed(1)}%` : '—'} · 失效对象 ${s.invalid}`)
  ])
}

/** 与全局面板同一套规则，供悬浮卡里复用（不引组件，避免循环依赖） */
function oracleIssues(): { env: string; level: 'bad' | 'warn' | 'info'; title: string }[] {
  const out: { env: string; level: 'bad' | 'warn' | 'info'; title: string }[] = []
  for (const e of ora.envs) {
    if (e.error) { out.push({ env: e.name, level: 'bad', title: '连接失败' }); continue }
    const s = e.summary
    if (!s) continue
    if (!s.openMode.includes('READ WRITE')) out.push({ env: e.name, level: 'bad', title: `库状态 ${s.openMode}` })
    if (s.blocking > 0) out.push({ env: e.name, level: 'bad', title: `${s.blocking} 个会话被阻塞` })
    if (s.tsWorst && s.tsWorst.usedPct >= 85) {
      out.push({ env: e.name, level: s.tsWorst.usedPct >= 90 ? 'bad' : 'warn', title: `${s.tsWorst.name} 水位 ${s.tsWorst.usedPct.toFixed(1)}%` })
    }
    if (s.invalid > 0) out.push({ env: e.name, level: 'warn', title: `${s.invalid} 个对象失效` })
    if (s.longops > 0) out.push({ env: e.name, level: 'info', title: `${s.longops} 个长操作` })
  }
  const w = { bad: 0, warn: 1, info: 2 }
  return out.sort((a, b) => w[a.level] - w[b.level])
}
