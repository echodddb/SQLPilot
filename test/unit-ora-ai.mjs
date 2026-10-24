/**
 * Oracle AI 助手 · 主进程单测
 *
 * 只测「单元渲染 + key 校验」这两块纯逻辑：
 * 真实取数已经在 unit-oracle.mjs 里验过字段映射，这里关心的是
 * 快照文本对每类数据是否都能正常生成（含空数组 / 缺字段不崩）。
 */
import { build } from 'esbuild'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(import.meta.dirname, '.ora-ai.mjs')

await build({
  entryPoints: [path.join(root, 'src/main/cloud/oracle/ai.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
  external: ['oracledb'],
  logLevel: 'warning'
})

const M = await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`)

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ---------------------------------------------------------------- key

test('key 解析：只认 ora:<envId>:<unit>', () => {
  assert.equal(M.isOraAiKey('ora:ora1:storage'), true)
  assert.equal(M.isOraAiKey('ora:ora1:summary'), true)
  assert.equal(M.isOraAiKey('ora:ora1:不存在'), false)
  assert.equal(M.isOraAiKey('overview.kpi'), false)
  assert.equal(M.isOraAiKey('ora:ora1'), false)
  assert.equal(M.isOraAiKey(null), false)
})

test('细分块 key：ora:<env>:<unit>:<part>，part 与 arg 都要在目录里', () => {
  assert.equal(M.isOraAiKey('ora:ora1:storage:fra'), true)
  assert.equal(M.isOraAiKey('ora:ora1:storage:asm'), true)
  // 未知块 / 未知 arg 一律拒绝，脏 key 不进 prompt
  assert.equal(M.isOraAiKey('ora:ora1:storage:nope'), false)
  assert.equal(M.isOraAiKey('ora:ora1:overview:kpi.orKpiSess'), true)
  assert.equal(M.isOraAiKey('ora:ora1:overview:kpi.nope'), false)
  // 实例名这类运行期参数（dynamicArgs）放行
  assert.equal(M.isOraAiKey('ora:ora1:instances:sga.trade_db'), true)
  assert.equal(M.isOraAiKey('ora:ora1:instances:sga.trade_db:extra'), false)
})

test('目录：每个单元都有可勾的细分块，中文名与说明齐全', () => {
  const cat = M.oraAiCatalog()
  assert.equal(cat.length, 15)
  const storage = cat.find((u) => u.unit === 'storage')
  assert.equal(storage.parts.length, 8)
  assert.deepEqual(storage.parts.map((p) => p.key), ['tablespaces', 'temp', 'undo', 'datafiles', 'asm', 'fra', 'archive', 'redo'])
  for (const u of cat) {
    assert.ok(u.parts.length > 0, `${u.unit} 应该有细分块`)
    for (const p of u.parts) {
      assert.ok(p.label && p.desc, `${u.unit}.${p.key} 缺文案`)
    }
  }
  // 实例块支持按实例名细分
  assert.equal(M.ORA_AI_PARTS.instances.every((p) => p.dynamicArgs), true)
})

test('单元目录：概要 + 14 个 tab，标签不重复', () => {
  assert.equal(M.ORA_AI_UNITS.length, 15)
  assert.equal(M.ORA_AI_UNITS[0].key, 'summary')
  const labels = M.ORA_AI_UNITS.map((u) => u.label)
  assert.equal(new Set(labels).size, labels.length)
  assert.ok(labels.includes('存储'))
  assert.ok(labels.includes('SQL 诊断'))
  assert.equal(M.oraAiUnitLabel('storage'), '存储')
})

// ---------------------------------------------------------------- 渲染

const FIX = {
  summary: {
    dbName: 'PRODDB', dbUniqueName: 'trade_db', databaseRole: 'PRIMARY', openMode: 'READ WRITE', logMode: 'ARCHIVELOG',
    version: 'Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production',
    isRac: false, isCdb: false, instances: 1, instancesOpen: 1, startupTime: '2026-10-22 07:52',
    sessions: 28, activeSessions: 3, tsWorst: { name: 'SYSTEM', usedPct: 99.48 }, blocking: 2, invalid: 5, longops: 1
  },
  overview: {
    info: { dbName: 'PRODDB' },
    kpis: [{ label: '用户会话', value: '28', sub: '活跃 3' }],
    instances: [{ name: 'trade_db', host: 'mgr01', status: 'OPEN', sessions: 28, active: 3 }],
    tablespaces: [{ name: 'SYSTEM', usedPct: 99.48, usedMb: 740, sizeMb: 750, autoext: 1 }],
    alertHours: [{ hour: '10', count: 3 }],
    waits: [{ event: 'db file sequential read', waitClass: 'User I/O', timeS: 12.5 }],
    metrics: [{ name: 'User Transaction Per Sec', value: 12.4, unit: '/s' }],
    issues: [{ level: 'bad', title: '表空间 SYSTEM 水位 99.5%', detail: '建议扩容' }]
  },
  rac: {
    clusterDatabase: 'FALSE', configuredInstances: 0,
    nodes: [{ instId: 1, instanceName: 'trade_db1', hostName: 'mgr01', status: 'OPEN', instanceRole: 'PRIMARY_INSTANCE', activeState: 'NORMAL', startupTime: '2026-10-22 07:52', version: '11.2.0.4.0', sessions: 28, active: 3 }],
    services: [{ instId: 1, serviceId: 1, name: 'trade_db', networkName: 'trade_db' }],
    interconnects: [], activeInstances: [{ instNumber: 1, instName: 'trade_db' }]
  },
  instances: [{
    instId: 1, instanceName: 'trade_db', hostName: 'mgr01', status: 'OPEN', startupTime: '2026-10-22 07:52',
    version: '11.2.0.4.0', instanceRole: 'PRIMARY_INSTANCE', activeState: 'NORMAL', dbStatus: 'ACTIVE',
    sgaMb: 2048, pgaMb: 512, processes: '300', sessions: '472', dbBlockSize: '8192', compat: '11.2.0.4.0',
    optimizerMode: 'ALL_ROWS', cursorSharing: 'EXACT', openCursors: '300', undoTablespace: 'UNDOTBS1', defaultTempTs: 'TEMP',
    osCpus: 8, osMemGb: 32, load: 1.2,
    resource: [{ name: 'processes', current: 30, max: 300 }],
    sga: [{ name: 'Buffer Cache', mb: 1536 }],
    pga: [{ name: 'total PGA allocated', mb: 320 }],
    bufferHit: [{ name: 'DEFAULT', missPct: 1.2, gets: 1000 }]
  }],
  pdb: { isCdb: false, note: 'v$pdbs 不存在', pdbs: [], files: [] },
  storage: {
    tablespaces: [{ name: 'SYSTEM', contents: 'PERMANENT', status: 'ONLINE', bigfile: 'NO', logging: 'LOGGING', sizeMb: 750, usedMb: 740, freeMb: 10, usedPct: 99.48, maxMb: 32768, files: 1, autoext: 1 }],
    temp: [{ name: 'TEMP', totalMb: 32, usedMb: 1, freeMb: 31, usedPct: 3.1 }],
    undo: { segments: [{ status: 'ONLINE', count: 10 }], recent: [{ begin: '10:00', end: '10:10', undoblks: 12, txnCount: 100, maxQueryLen: 30, ssolderrcnt: 0, nospaceerrcnt: 0 }] },
    datafiles: [{ fileId: 1, fileName: '/u01/system01.dbf', tablespace: 'SYSTEM', sizeMb: 750, autoextensible: 'YES', maxMb: 32768, incMb: 10, status: 'AVAILABLE', onlineStatus: 'ONLINE' }],
    asm: [{ name: 'DATA', state: 'MOUNTED', type: 'EXTERN', totalMb: 51200, freeMb: 10240, usableMb: 10240, usedPct: 80, disks: 1 }],
    archive: { dests: [{ destId: 1, status: 'VALID', destination: '/arch', syncStatus: 'CHECK CONFIGURATION', synchronized: 'YES', error: '', dbUnique: 'trade_db', gapStatus: '', archivedSeq: 100, appliedSeq: 100 }], last24h: { count: 12, gb: 2.4 } },
    fra: { name: '/fra', limitGb: 8, usedGb: 2.5, reclaimGb: 1.2, files: 12, usage: [{ type: 'ARCHIVED LOG', usedPct: 31.3, reclaimPct: 20, files: 12 }] },
    redo: [{ group: 1, thread: 1, sequence: 100, mb: 1024, members: 1, status: 'CURRENT', archived: 'NO', firstTime: '10:20' }]
  },
  sessions: {
    summary: [{ status: 'ACTIVE', type: 'USER', count: 3 }],
    waitClass: [{ waitClass: 'User I/O', count: 2 }],
    list: [{ instId: 1, sid: 140, serial: 5, username: 'APP', status: 'ACTIVE', machine: 'app01', program: 'jdbc', sqlId: 'c2p32r5mzv8hb', event: 'db file sequential read', waitClass: 'User I/O', secondsInWait: 2, blockingSession: null, lastCallEt: 3, spid: '1234', logonTime: '09:00' }],
    blocking: [{ instId: 1, sid: 140, type: 'TX', lmode: '6', request: '0', ctime: 42, blockerSid: 136, blockerUser: 'APP', blockerSql: 'c2p32r5mzv8hb', username: 'APP', sqlId: 'abc', event: 'enq: TX - row lock contention' }],
    longops: [{ instId: 1, sid: 140, opname: 'Table Scan', target: 'APP.T_ORDER', pct: 40, timeRemaining: 120, elapsed: 80, sqlId: 'abc' }]
  },
  sql: {
    by: 'elapsed',
    rows: [{ sqlId: 'c2p32r5mzv8hb', planHash: 1, executions: 10, elapsedS: 12.3, cpuS: 9.1, avgMs: 1230, bufferGets: 1000, diskReads: 20, getsPerExec: 100, readsPerExec: 2, rowsProcessed: 50, schema: 'APP', module: 'jdbc', lastActive: '10:20' }],
    awr: [{ sqlId: 'c2p32r5mzv8hb', executions: 100, elapsedS: 30, cpuS: 20, gets: 5000, reads: 100 }],
    awrRange: '10-22 09:00 ~ 10:00'
  },
  perf: {
    metrics: [{ name: 'User Transaction Per Sec', value: 12.4, unit: '/s' }],
    sysstat: [{ name: 'user commits', value: 1000 }],
    systemEvent: [{ event: 'db file sequential read', waitClass: 'User I/O', totalWaits: 100, timeS: 12.5, avgMs: 1.2 }],
    ash: [{ sqlId: 'abc', event: 'CPU', state: 'ON CPU', samples: 30 }],
    ashWindow: '最近 1 小时',
    osstat: [{ name: 'LOAD', value: 1.2 }],
    sga: [{ name: 'Buffer Cache', mb: 1536 }],
    pga: [{ name: 'total PGA allocated', mb: 320 }]
  },
  alerts: {
    hours: 24, total: 55244, errorCount: 3,
    groups: [{ pattern: 'Thread # advanced to log sequence #', count: 120, firstTs: '10-22 00:00', lastTs: '10-22 10:00', isError: false }],
    byHour: [{ hour: '10', count: 30, errors: 1 }],
    recent: [{ ts: '10-22 10:00:00', type: 1, level: 16, msg: 'error 1234 detected' }],
    ora: [{ ts: '10-22 09:00:00', msg: 'ORA-01555 snapshot too old' }]
  },
  backup: {
    jobs: [{ sessionKey: 1, commandId: '1', status: 'COMPLETED', startTime: '2026-10-21 23:00', endTime: '23:20', elapsedS: 1200, inputType: 'DB FULL', device: 'DISK', outputGb: 12.5 }],
    sets: [{ recid: 1, backupType: 'D', incremental: '', done: '2026-10-21 23:20', gb: 12.5, pieces: 1 }],
    archive: { count24h: 12, gb24h: 2.4 }, lastFull: '2026-10-21 23:00', lastStatus: 'COMPLETED',
    fra: { usedGb: 2.5, limitGb: 8, usedPct: 31.3 }
  },
  dg: {
    available: true,
    stats: [{ name: 'transport lag', value: '+00 00:00:02', unit: '', timeComputed: '10:20' }],
    dests: [{ destId: 2, status: 'VALID', type: 'PHYSICAL', dbMode: 'STANDBY', recoveryMode: 'MANAGED', protectionMode: 'MAXIMUM PERFORMANCE', destination: 'cesdg', error: '', dbUnique: 'cesdg', synchronized: 'YES', gapStatus: '', archivedSeq: 100, appliedSeq: 99 }],
    processes: [{ process: 'MRP0', status: 'APPLYING_LOG', thread: 1, sequence: 100, block: 2 }],
    role: 'PRIMARY', protectionMode: 'MAXIMUM PERFORMANCE'
  },
  jobs: {
    scheduler: [{ owner: 'APP', jobName: 'J_STAT', enabled: 'TRUE', state: 'SCHEDULED', runCount: 10, failureCount: 1, lastStart: '10:00', nextRun: '11:00' }],
    dbms: [{ job: 1, logUser: 'APP', broken: 'N', failures: 0, lastDate: '10:00', nextDate: '11:00', what: 'statspack.snap' }],
    runs: [{ owner: 'APP', jobName: 'J_STAT', status: 'SUCCEEDED', startTime: '10:00', durationS: 3, info: '' }]
  },
  params: {
    changed: [{ name: 'sga_target', value: '2G', modifiable: 'IMMEDIATE', desc: 'target SGA' }],
    key: [{ name: 'sga_target', value: '2G', isDefault: 'FALSE', modifiable: 'IMMEDIATE' }]
  },
  users: {
    users: [{ username: 'ECHODD', status: 'OPEN', expiry: '', defaultTs: 'USERS', tempTs: 'TEMP', profile: 'DEFAULT', created: '2025-01-01', authType: 'PASSWORD' }],
    pwfile: [{ username: 'SYS', sysdba: 'TRUE', sysoper: 'TRUE', admin: 'TRUE' }],
    roles: [{ role: 'DBA', adminOption: 'NO', defaultRole: 'YES' }],
    privs: [{ privilege: 'CREATE SESSION', adminOption: 'NO' }],
    invalid: [{ owner: 'APP', objectType: 'PROCEDURE', count: 5 }],
    objectTypes: [{ objectType: 'TABLE', count: 100 }],
    segments: [{ owner: 'APP', name: 'T_ORDER', type: 'TABLE', tablespace: 'USERS', mb: 512 }],
    totalObjects: 1204
  }
}

test('每个单元都能渲染出内容（含表格与关键字段）', () => {
  const expect = {
    summary: ['PRIMARY', 'READ WRITE', '99.5%'],
    overview: ['用户会话', 'SYSTEM', 'db file sequential read'],
    rac: ['cluster_database', 'trade_db1', '服务分布'],
    instances: ['SGA', 'Buffer Cache', 'processes'],
    pdb: ['非 CDB'],
    storage: ['SYSTEM', 'ASM', 'FRA', '归档目标'],
    sessions: ['阻塞链', 'Table Scan', 'APP'],
    sql: ['c2p32r5mzv8hb', 'AWR'],
    perf: ['db file sequential read', 'ASH', 'SGA'],
    alerts: ['55244', 'ORA-01555', 'Thread'],
    backup: ['COMPLETED', '12.5', 'FRA'],
    dg: ['PRIMARY', 'MRP0', 'cesdg'],
    jobs: ['J_STAT', 'DBMS_JOB', 'SUCCEEDED'],
    params: ['sga_target', '关键参数'],
    users: ['ECHODD', 'SYS(SYSDBA)', 'APP']
  }
  for (const [unit, words] of Object.entries(expect)) {
    const md = M.renderOraAiUnit(unit, FIX[unit])
    assert.ok(md && md.length > 10, `${unit} 应该有内容`)
    for (const w of words) assert.ok(md.includes(w), `${unit} 应包含「${w}」，实际：${md.slice(0, 120)}`)
  }
})

test('细分块渲染：只输出勾中的那一块', () => {
  const asm = M.renderOraAiPart('storage', 'asm', FIX.storage)
  assert.ok(asm.includes('ASM'), 'asm 块应含 ASM')
  assert.ok(!asm.includes('在线日志'), '勾 asm 不应该带出在线日志')
  assert.ok(!asm.includes('临时表空间'), '勾 asm 不应该带出临时表空间')

  const redo = M.renderOraAiPart('storage', 'redo', FIX.storage)
  assert.ok(redo.includes('在线日志'))
  assert.ok(!redo.includes('ASM 磁盘组'))

  // 整块 = 所有块拼起来（关键内容一个都不少）
  const whole = M.renderOraAiUnit('storage', FIX.storage)
  assert.ok(whole.includes('ASM') && whole.includes('在线日志') && whole.includes('归档目标'))
})

test('细分块渲染：磁贴级 arg 只输出那一项指标', () => {
  const ov = {
    ...FIX.overview,
    kpis: [
      { label: '实例数量', value: '1', sub: '单实例', src: 'orKpiInst' },
      { label: '用户会话', value: '28', sub: '活跃 3', src: 'orKpiSess' }
    ]
  }
  const one = M.renderOraAiPart('overview', 'kpi.orKpiInst', ov)
  assert.ok(one.includes('实例数量'))
  assert.ok(!one.includes('用户会话'), '只勾实例数不该带出用户会话')
  const all = M.renderOraAiPart('overview', 'kpi', ov)
  assert.ok(all.includes('实例数量') && all.includes('用户会话'))
})

test('细分块渲染：实例名 arg 只输出那一个实例', () => {
  const inst = [
    { ...FIX.instances[0], instanceName: 'trade_db1', sga: [{ name: 'Buffer Cache', mb: 1024 }] },
    { ...FIX.instances[0], instanceName: 'trade_db2', sga: [{ name: 'Buffer Cache', mb: 2048 }] }
  ]
  const only = M.renderOraAiPart('instances', 'sga.trade_db2', inst)
  assert.ok(only.includes('trade_db2'))
  assert.ok(!only.includes('trade_db1'), '只勾 trade_db2 的 SGA 不该带出 trade_db1')
  assert.equal(M.oraAiPartLabel('instances', 'sga.trade_db2'), 'SGA 组成 · trade_db2')
})

test('key 的中文名：整块与细分都能写清楚', () => {
  assert.equal(M.oraAiKeyLabel('ora:ora1:storage'), '存储')
  assert.equal(M.oraAiKeyLabel('ora:ora1:storage:fra'), '存储 · FRA 闪回区')
  assert.equal(M.oraAiKeyLabel('ora:ora1:overview:kpi.orKpiSess'), '总览 · 核心指标 · 用户会话')
})

test('空数据 / 缺字段不崩：给出「没有」之类的说明而不是抛错', () => {
  const empty = {
    summary: {},
    overview: { kpis: [], issues: [], tablespaces: [], waits: [], metrics: [], instances: [] },
    rac: { clusterDatabase: 'FALSE', configuredInstances: 0, nodes: [], services: [], interconnects: [] },
    instances: [],
    pdb: { isCdb: false, note: '', pdbs: [], files: [] },
    storage: { tablespaces: [], temp: [], undo: { recent: [], segments: [] }, datafiles: [], asm: [], archive: { dests: [], last24h: { count: 0, gb: 0 } }, fra: null, redo: [] },
    sessions: { summary: [], waitClass: [], list: [], blocking: [], longops: [] },
    sql: { by: 'elapsed', rows: [], awr: [], awrRange: '' },
    perf: { metrics: [], sysstat: [], systemEvent: [], ash: [], ashWindow: '', osstat: [], sga: [], pga: [] },
    alerts: { hours: 24, total: 0, errorCount: 0, groups: [], byHour: [], recent: [], ora: [] },
    backup: { jobs: [], sets: [], archive: { count24h: 0, gb24h: 0 }, lastFull: '', lastStatus: '', fra: null },
    dg: { available: false, stats: [], dests: [], processes: [], role: '', protectionMode: '' },
    jobs: { scheduler: [], dbms: [], runs: [] },
    params: { changed: [], key: [] },
    users: { users: [], pwfile: [], roles: [], privs: [], invalid: [], objectTypes: [], segments: [], totalObjects: 0 }
  }
  for (const unit of M.ORA_AI_UNITS.map((u) => u.key)) {
    const md = M.renderOraAiUnit(unit, empty[unit])
    assert.ok(typeof md === 'string' && md.length > 0, `${unit} 空数据也应有输出`)
    assert.ok(!md.includes('渲染失败'), `${unit} 空数据不应抛错：${md.slice(0, 100)}`)
  }
  // 未知单元 / 完全空对象
  assert.ok(M.renderOraAiUnit('nope', {}).includes('未知'))
  assert.ok(M.renderOraAiUnit('storage', null).length > 0)
})

// ---------------------------------------------------------------- 跑

let pass = 0
for (const c of cases) {
  try {
    await c.fn()
    pass++
  } catch (e) {
    console.error(`✗ ${c.name}\n`, e)
  }
}
console.log(`unit-ora-ai: ${pass}/${cases.length} 组断言${pass === cases.length ? '通过' : '失败'}`)
if (pass !== cases.length) process.exit(1)
