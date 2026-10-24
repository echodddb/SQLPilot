/**
 * Oracle 云平台取数层的单测：不打数据库，用一个假 conn 返回"按真实别名"构造的行，
 * 验证 sections.ts 里的字段映射与降级逻辑。
 *
 * 为什么需要它：`thread#` / `serial#` 这类列名在 SQL 里必须起别名，而 tsc 查不出
 * 映射函数里写错 key（都是 any）——这里用真实别名跑一遍，能挡住 A 类低级错误。
 * 运行：node test/unit-oracle.mjs（构建脚本见 package.json 的 test:oracle）
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(import.meta.dirname, '.sections.mjs')

await build({
  entryPoints: [path.join(root, 'src/main/cloud/oracle/sections.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
  external: ['oracledb'],
  logLevel: 'warning'
})

const S = await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`)

// conn.ts 单独打一份：验证"选了 SYSDBA 但账号没授权"的自动降级
const connOut = path.join(import.meta.dirname, '.conn.mjs')
await build({
  entryPoints: [path.join(root, 'src/main/cloud/oracle/conn.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: connOut,
  alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
  external: ['oracledb'],
  logLevel: 'warning'
})
const C = await import(`file://${connOut.replace(/\\/g, '/')}?t=${Date.now()}`)
const oracledb = (await import('oracledb')).default

/** 按 SQL 特征返回构造好的行（key 一律小写，模拟 oraQuery 的处理） */
function fakeConn(routes) {
  return {
    execute: async (sql, binds, opts) => {
      const low = String(sql).toLowerCase()
      for (const [needle, rows] of routes) {
        if (low.includes(needle)) return { rows }
      }
      // 默认：空结果（等价于"这个视图没数据"）
      return { rows: [] }
    }
  }
}

const cases = []

// ---------------- 环境概要：多环境列表用的 7 条 SQL 与字段映射 ----------------
cases.push(async () => {
  const conn = {
    execute: async (sql, binds, opts) => {
      const low = String(sql).toLowerCase()
      if (low.includes('from v$database')) {
        return { rows: [{ ver: 'Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production', name: 'PRODDB', db_unique_name: 'trade_db', database_role: 'PRIMARY', open_mode: 'READ WRITE', log_mode: 'ARCHIVELOG' }] }
      }
      if (low.includes('from gv$instance')) {
        return { rows: [
          { inst_id: 1, status: 'OPEN', first_start: '2026-10-22 07:52', last_start: '2026-10-22 07:52' },
          { inst_id: 2, status: 'OPEN', first_start: '2026-10-22 07:52', last_start: '2026-10-22 07:52' }
        ] }
      }
      if (low.includes('from gv$session where type')) return { rows: [{ status: 'ACTIVE', c: 3 }, { status: 'INACTIVE', c: 25 }] }
      if (low.includes('used_pct desc')) return { rows: [{ name: 'SYSTEM', used_pct: 99.48 }] }
      if (low.includes('from gv$lock')) return { rows: [[2]] }
      if (low.includes('from dba_objects')) return { rows: [[5]] }
      if (low.includes('from gv$session_longops')) return { rows: [[1]] }
      if (low.includes('from v$parameter')) return { rows: [['TRUE']] }
      // v$pdbs 探测：11g 抛错 → isCdb=false
      if (low.includes('from v$pdbs')) throw new Error('ORA-00942: table or view does not exist')
      return { rows: [] }
    }
  }
  const r = await S.fetchEnvSummary({ conn, mode: 'thin' }, () => {})
  assert.ok(r.version.startsWith('Oracle Database 11g'), 'version 应来自子查询别名 ver')
  assert.equal(r.dbName, 'PRODDB')
  assert.equal(r.logMode, 'ARCHIVELOG')
  assert.equal(r.instances, 2)
  assert.equal(r.instancesOpen, 2)
  assert.equal(r.isRac, true, 'cluster_database=TRUE 或多实例即判为 RAC')
  assert.equal(r.isCdb, false, 'v$pdbs 不存在应判为非 CDB')
  assert.equal(r.startupTime, '2026-10-22 07:52', '两个节点启动时间相同时只显示一个')
  assert.equal(r.sessions, 28)
  assert.equal(r.activeSessions, 3)
  assert.equal(r.tsWorst.name, 'SYSTEM')
  assert.equal(r.tsWorst.usedPct, 99.48)
  assert.equal(r.blocking, 2)
  assert.equal(r.invalid, 5)
})

// ---------------- 会话：serial# 必须映射到 serial ----------------
cases.push(async () => {
  const conn = fakeConn([
    ['from gv$session group by status, type', [{ status: 'ACTIVE', type: 'USER', c: 7 }]],
    ['nvl(wait_class', [{ wc: 'CPU', c: 7 }]],
    ['s.serial# serial_no', [{
      inst_id: 1, sid: 136, serial_no: 9, username: 'ECHODD', status: 'ACTIVE',
      machine: 'mgr01', program: 'sqlplus', sql_id: 'abc123', event: 'db file seq', wait_class: 'User I/O',
      seconds_in_wait: 3, blocking_session: null, last_call_et: 12, logon_time: '10-22 07:00', spid: '1234'
    }]],
    ['l.block in (1,2)', []],
    ['from gv$session_longops', []]
  ])
  const r = await S.fetchSessions({ conn, mode: 'thin' }, () => {})
  assert.equal(r.list.length, 1)
  const s = r.list[0]
  assert.equal(s.serial, 9, 'serial# 应映射为 serial')
  assert.equal(s.sid, 136)
  assert.equal(s.blockingSession, null, 'blocking_session 为 null 时应保持 null')
  assert.equal(s.username, 'ECHODD')
  assert.equal(r.waitClass[0].waitClass, 'CPU')
})

// ---------------- 存储：v$log 的 grp/thr/seq、归档目标的 sync 字段 ----------------
cases.push(async () => {
  const conn = fakeConn([
    ['from dba_tablespaces t', [{
      name: 'SYSTEM', contents: 'PERMANENT', status: 'ONLINE', bigfile: 'NO', logging: 'LOGGING',
      size_mb: 750, free_mb: 3.88, used_pct: 99.48, max_mb: 32768, files: 1, autoext: 1
    }]],
    ['from v$temp_space_header h', [{ name: 'TEMP', used_mb: 29, free_mb: 0, total_mb: 29 }]],
    ['from dba_rollback_segs', [{ status: 'ONLINE', c: 11 }]],
    ['from v$undostat', [{ begin_ts: '10-22 08:00', end_ts: '08:10', undoblks: 4, txncount: 9, maxquerylen: 0, ssolderrcnt: 0, nospaceerrcnt: 0 }]],
    ['from dba_data_files order by tablespace_name', [{ file_id: 1, file_name: '/oradata/system01.dbf', tablespace_name: 'SYSTEM', size_mb: 750, autoextensible: 'YES', max_mb: 32768, inc_mb: 64, status: 'AVAILABLE', online_status: 'ONLINE' }]],
    ['from v$asm_diskgroup g', []],
    ['from v$archive_dest_status where dest_id <= 10', [{
      dest_id: 1, status: 'VALID', destination: '/arch', synchronization_status: 'PARALLEL',
      synchronized: 'YES', error: '', db_unique_name: 'trade_db', gap_status: 'NO GAP',
      archived_seq: 72, applied_seq: 72
    }]],
    ['from v$archived_log', [{ cnt: 12, gb: 1.5 }]],
    ['from v$recovery_file_dest', [{ name: '/fra', limit_gb: 8, used_gb: 2, reclaim_gb: 0, files: 3 }]],
    ['from v$flash_recovery_area_usage', [{ file_type: 'ARCHIVED LOG', percent_space_used: 5, percent_space_reclaimable: 0, number_of_files: 2 }]],
    ['from v$log order by group#', [{ grp: 1, thr: 1, seq: 73, mb: 1024, members: 1, status: 'CURRENT', archived: 'NO', first_time: '10-22 07:53' }]]
  ])
  const r = await S.fetchStorage({ conn, mode: 'thin' }, () => {})
  assert.equal(r.tablespaces[0].usedPct, 99.48)
  assert.equal(r.tablespaces[0].usedMb, 750 - 3.88)
  assert.equal(r.temp[0].usedPct, 100)
  assert.equal(r.redo[0].group, 1)
  assert.equal(r.redo[0].thread, 1, 'thread# 应别名成 thr 后映射')
  assert.equal(r.redo[0].sequence, 73)
  assert.equal(r.archive.dests[0].syncStatus, 'PARALLEL')
  assert.equal(r.archive.dests[0].archivedSeq, 72)
  assert.equal(r.fra.usedGb, 2)
  assert.equal(r.undo.segments[0].count, 11)
})

// ---------------- Data Guard：archived_seq / thr / seq / blk ----------------
cases.push(async () => {
  const conn = fakeConn([
    ['from v$database', [{ database_role: 'PRIMARY', protection_mode: 'MAXIMUM PERFORMANCE' }]],
    ['from v$dataguard_stats', [{ name: 'transport lag', value: '+00 00:00:00', unit: '', time_computed: '10-22 08:00' }]],
    ['from v$archive_dest_status where dest_id <= 10 order by dest_id', [{
      dest_id: 2, status: 'VALID', type: 'PHYSICAL', database_mode: 'OPEN_READ-ONLY',
      recovery_mode: 'MANAGED REAL TIME APPLY', protection_mode: 'MAXIMUM PERFORMANCE',
      destination: 'cesdg', error: '', db_unique_name: 'cesdg', synchronized: 'YES',
      gap_status: 'NO GAP', archived_seq: 71, applied_seq: 71
    }]],
    ['from v$managed_standby', [{ process: 'MRP0', status: 'APPLYING_LOG', thr: 1, seq: 71, blk: 1234, blocks: 0 }]]
  ])
  const r = await S.fetchDg({ conn, mode: 'thin' }, () => {})
  assert.equal(r.available, true)
  assert.equal(r.dests[0].dbMode, 'OPEN_READ-ONLY')
  assert.equal(r.dests[0].appliedSeq, 71)
  assert.equal(r.processes[0].thread, 1)
  assert.equal(r.processes[0].block, 1234)
})

// ---------------- 备份：GB 字段与失败状态 ----------------
cases.push(async () => {
  const conn = fakeConn([
    ['from v$rman_backup_job_details', [
      { session_key: 53, command_id: 'x1', status: 'COMPLETED', st: '09-03 23:14', et: '23:15', elapsed_seconds: 66, input_type: 'DB FULL', output_device_type: 'DISK', output_gb: 1.24 },
      { session_key: 49, command_id: 'x0', status: 'FAILED', st: '09-03 23:12', et: '23:13', elapsed_seconds: 2, input_type: 'DATAFILE FULL', output_device_type: 'DISK', output_gb: 0.01 }
    ]],
    ['from v$backup_set', [{ recid: 9, backup_type: 'D', incremental_level: '', done: '09-03 23:14', gb: 1.2, pieces: 1 }]],
    ['from v$archived_log where first_time', [{ cnt: 30, gb: 4.2 }]],
    ['from v$recovery_file_dest', [{ limit_gb: 8, used_gb: 2.5 }]]
  ])
  const r = await S.fetchBackup({ conn, mode: 'thin' }, () => {})
  assert.equal(r.jobs.length, 2)
  assert.equal(r.lastFull, '09-03 23:14')
  assert.equal(r.lastStatus, 'COMPLETED', '应取第一条（最近的）DB FULL')
  assert.equal(r.fra.usedPct, 31.25)
  assert.equal(r.archive.count24h, 30)
})

// ---------------- 降级：视图无权限时不抛异常，只记 warnings ----------------
cases.push(async () => {
  const conn = {
    execute: async (sql) => {
      const low = String(sql).toLowerCase()
      if (low.includes('v$asm_diskgroup')) throw new Error('ORA-00942: table or view does not exist')
      return { rows: [] }
    }
  }
  const warnings = []
  const r = await S.fetchStorage({ conn, mode: 'thin' }, (m) => warnings.push(m))
  assert.equal(r.asm.length, 0)
  assert.ok(warnings.some((w) => w.includes('ASM')), 'ASM 视图不可用时应留下 warnings')
})

// ---------------- 告警：大日志量下仍然只返回聚类与截断明细 ----------------
cases.push(async () => {
  const conn = {
    execute: async (sql) => {
      const low = String(sql).toLowerCase()
      if (low.includes('group by regexp_replace')) {
        return { rows: [{ pat: 'Fatal NI connect error #', c: 55163, first_ts: '10-22 07:54', last_ts: '10-22 08:13', errs: 0 }] }
      }
      if (low.includes('from v$diag_alert_ext order by originating_timestamp desc')) {
        return { rows: [{ ts: '10-22 08:13:01', message_type: 1, message_level: 16, msg: 'x' }] }
      }
      if (low.includes('count(*)') && low.includes('v$diag_alert_ext')) return { rows: [[55244]] }
      return { rows: [] }
    }
  }
  const r = await S.fetchAlerts({ conn, mode: 'thin' }, () => {}, 24)
  assert.equal(r.total, 55244)
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].count, 55163)
  assert.equal(r.recent.length, 1)
})

// ---------------- SYSDBA：DBA 角色不等于 SYSDBA，连接失败要能解释 ----------------
cases.push(async () => {
  const err = new Error('ORA-01017: invalid username/password; logon denied')
  assert.equal(C.isAuthDenied(err), true)
  assert.equal(C.isAuthDenied(new Error('ORA-12541: TNS:no listener')), false)

  // 选了 SYSDBA 时的错误要带上"独立特权 / 怎么授权"的解释
  const explained = C.explainOraError(err, 'sysdba')
  assert.ok(explained.includes('ORA-01017'))
  assert.ok(explained.includes('独立特权'), '应说明 SYSDBA 是独立特权')
  assert.ok(explained.includes('GRANT'), '应给出授权语句提示')

  // 普通身份失败就事论事，不要讲一通 SYSDBA
  const plain = C.explainOraError(err, 'default')
  assert.equal(plain.includes('独立特权'), false)

  // 老版本 thin 不支持 → 引导配置 Instant Client
  const old = C.explainOraError(new Error('NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode'))
  assert.ok(old.includes('Instant Client'))
})

// ---------------- SYSDBA 降级：连不上 SYSDBA 但普通身份能通 → 自动降级并说明 ----------------
cases.push(async () => {
  const original = oracledb.getConnection
  const calls = []
  oracledb.getConnection = async (opts) => {
    calls.push(opts.privilege)
    if (opts.privilege !== undefined) {
      // 模拟：账号不在口令文件里
      throw new Error('ORA-01017: invalid username/password; logon denied')
    }
    return {
      callTimeout: 0,
      execute: async (sql) => {
        const low = String(sql).toLowerCase()
        if (low.includes('banner')) return { rows: [['Oracle Database 11g Enterprise Edition Release 11.2.0.4.0']] }
        if (low.includes('dba_role_privs')) return { rows: [{ DBA_CNT: 1, SYSDBA_CNT: 0, SYSOPER_CNT: 0 }] }
        return { rows: [] }
      },
      close: async () => {}
    }
  }
  try {
    const r = await C.oraTestConn(
      { id: 't1', name: 'T', type: 'oracle', host: 'h', port: 1521, serviceName: 's', username: 'ECHODD', role: 'sysdba' },
      'pwd'
    )
    assert.equal(r.ok, true, '普通身份可用时应判为连通')
    assert.equal(r.downgraded, true, '应标记为降级')
    assert.ok(r.note.includes('SYSDBA'), '降级说明里要点明 SYSDBA')
    assert.equal(r.privileges.dba, true)
    assert.equal(r.privileges.sysdba, false)
    assert.equal(calls.length, 2, '应先试 SYSDBA 再试普通身份')

    // 普通身份也通不了 → 返回带解释的错误
    oracledb.getConnection = async () => { throw new Error('ORA-01017: invalid username/password; logon denied') }
    const bad = await C.oraTestConn(
      { id: 't2', name: 'T2', type: 'oracle', host: 'h', port: 1521, serviceName: 's', username: 'X', role: 'sysdba' },
      'pwd'
    )
    assert.equal(bad.ok, false)
    assert.ok(bad.error.includes('独立特权'))
  } finally {
    oracledb.getConnection = original
  }
})

let pass = 0
for (const run of cases) {
  await run()
  pass++
}
console.log(`unit-oracle: ${pass} 组断言全部通过`)
