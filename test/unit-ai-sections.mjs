/**
 * 云管 AI 快照的「细分粒度」单测：不打 OCP，用假 Fetcher 直接调 renderSection，
 * 验证 `base:arg` 这种 key 只渲染指定的那一项（一个 KPI 磁贴 / 一个集群 / 一台主机…）。
 *
 * 为什么需要它：细分参数是字符串拼出来的（`clusters.capacity:${c.name}`），
 * 拼错或忘了过滤就会把整块数据都塞进快照里 —— tsc 查不出来，只能靠断言。
 * 运行：node test/unit-ai-sections.mjs
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(import.meta.dirname, '.ai.mjs')

await build({
  entryPoints: [path.join(root, 'src/main/cloud/ai.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { electron: path.join(import.meta.dirname, 'stub-electron.mjs') },
  external: ['oracledb'],
  logLevel: 'warning'
})

const A = await import(`file://${out.replace(/\\/g, '/')}?t=${Date.now()}`)

// ---------------------------------------------------------------- 假数据

const cap = (used, total, pct) => ({ used, total, pct })
const C1 = {
  id: 1, name: 'obcluster-prod', status: 'RUNNING', type: 'PRIMARY', obClusterId: 1001, version: '4.2.1.8',
  clusterMode: 'NORMAL', origin: 'CREATE', createTime: '2025-03-12T10:00:00Z', creator: 'admin',
  regionCount: 1, serverCount: 3, tenantCount: 4, rootServer: '10.0.0.11',
  cpu: cap(20, 48, 41.7), memory: cap(64, 128, 50), disk: cap(320, 1024, 31.2),
  alarms: { total: 2, levels: [{ level: 1, count: 1 }, { level: 2, count: 1 }, { level: 3, count: 0 }] }
}
const C2 = {
  id: 2, name: 'obcluster-test', status: 'RUNNING', type: 'PRIMARY', obClusterId: 1002, version: '4.2.1.8',
  clusterMode: 'NORMAL', origin: 'CREATE', createTime: '2025-06-01T10:00:00Z', creator: 'admin',
  regionCount: 2, serverCount: 3, tenantCount: 3, rootServer: '10.0.1.11',
  cpu: cap(8, 16, 50), memory: cap(32, 64, 50), disk: cap(120, 512, 23.4),
  alarms: { total: 1, levels: [{ level: 3, count: 1 }] }
}
const OVERVIEW = {
  info: { version: '4.3.5', edition: 'ENTERPRISE', buildTime: '2025-01-01' },
  kpis: { clusters: 2, clustersRunning: 2, hosts: 6, hostsOnline: 5, tenants: 7, alarms: 3, alarmsCritical: 1, cpuUsed: 28, cpuTotal: 64 },
  hosts: { total: 6, online: 5, offline: 1, agentAbnormal: 1 },
  clusters: [C1, C2], alarms: [], tasks: [], warnings: []
}
const TENANTS = [
  { id: 11, name: 'obtenant01', clusterName: 'obcluster-prod', mode: 'MYSQL', status: 'NORMAL', locality: 'FULL{1}@zone1', primaryZone: 'zone1', locked: false, role: 'PRIMARY' },
  { id: 12, name: 'obtenant02', clusterName: 'obcluster-test', mode: 'ORACLE', status: 'NORMAL', locality: 'FULL{1}@zone1', primaryZone: 'zone1', locked: true, role: 'PRIMARY' }
]
const HOSTS = [
  { id: 1, ip: '10.0.0.11', alias: 'obsrv01', name: 'obsrv01', status: 'ONLINE', agentStatus: 'AVAILABLE', typeName: 'ECS', os: 'Linux', region: 'hz', idc: 'idc1', sshPort: 22 },
  { id: 2, ip: '10.0.0.12', alias: 'obsrv02', name: 'obsrv02', status: 'OFFLINE', agentStatus: 'UNAVAILABLE', typeName: 'ECS', os: 'Linux', region: 'hz', idc: 'idc1', sshPort: 22 }
]
const DETAIL = (id) => ({
  cluster: id === 1 ? C1 : C2,
  attributes: [], zones: [{ name: 'zone1', idc: 'idc1', region: 'hz', status: 'ACTIVE', serverCount: 3, rootServer: '10.0.0.11' }],
  servers: [{ id: 1, ip: '10.0.0.11', zone: 'zone1', status: 'RUNNING', hostStatus: 'ONLINE', withRootserver: true, version: '4.2.1.8', startTime: '2025-03-12T10:00:00Z' }],
  tenants: [{ id: 11, name: 'obtenant01' }],
  startupParameters: [{ key: 'memory_limit', value: '32G' }], unitSpecs: []
})
const BACKUP = {
  overview: { totalClusterNum: 2, hasBackupStrategyClusterNum: 1, weekDataSuccessPct: 97.5, logBackupObjectNum: 3, samplingSuccess: 2, samplingTotal: 2 },
  objects: [], tasks: [], services: [], storages: [], warnings: []
}

const ok = (data) => Promise.resolve({ ok: true, data })
const get = {
  overview: () => ok(OVERVIEW),
  clusters: () => ok([C1, C2]),
  tenants: () => ok(TENANTS),
  hosts: () => ok(HOSTS),
  detail: (_ctx, id) => ok(DETAIL(id)),
  backup: () => ok(BACKUP),
  levels: () => ok([{ level: 1, count: 1 }, { level: 2, count: 2 }, { level: 3, count: 3 }]),
  alarms: () => ok({ items: [], total: 0 })
}
/** 真实的 Ctx 只是按 key 缓存 Promise，单测不需要缓存 */
const ctx = { once: (_key, fn) => fn() }
const render = (key) => A.renderSection(key, get, ctx, 'p-test')

// ---------------------------------------------------------------- 用例
const cases = []
const t = (name, fn) => cases.push([name, fn])

t('key 解析：base 与 arg', async () => {
  assert.deepEqual(A.splitSectionKey('overview.kpi:hosts'), { base: 'overview.kpi', arg: 'hosts' })
  assert.deepEqual(A.splitSectionKey('clusters.params:obc'), { base: 'clusters.params', arg: 'obc' })
  assert.deepEqual(A.splitSectionKey('clusters.params'), { base: 'clusters.params', arg: '' })
  assert.equal(A.moduleOfSection('clusters.params:obc'), 'clusters')
  assert.equal(A.moduleOfSection('overview.kpi:hosts'), 'overview')
  // 目录里只放整块 key，别把带冒号的写进目录
  assert.ok(A.CLOUD_AI_SECTIONS.every((s) => !s.key.includes(':')), '目录 key 不应带参数')
  // 整块枚举（模块级选择）仍然是整块
  assert.ok(A.sectionsOfModules(['overview']).every((k) => !k.includes(':')), '按模块展开应为整块 key')
})

t('核心指标：每个磁贴单独渲染', async () => {
  const hosts = await render('overview.kpi:hosts')
  assert.match(hosts, /主机 6 台/)
  assert.ok(!hosts.includes('租户 7'), '只应包含主机这一项')
  const tenants = await render('overview.kpi:tenants')
  assert.match(tenants, /租户 7 个/)
  assert.ok(!tenants.includes('主机'), '只应包含租户这一项')
  const cpu = await render('overview.kpi:cpu')
  assert.match(cpu, /28\/64 核/)
  const ocp = await render('overview.kpi:ocp')
  assert.match(ocp, /4\.3\.5/)
  // 不带参数 = 整块（6 行）
  const all = await render('overview.kpi')
  assert.match(all, /集群 2 个/)
  assert.match(all, /租户 7 个/)
  assert.match(all, /主机 6 台/)
  assert.match(all, /活跃告警 3 条/)
  // 不认识的参数要显式提示，而不是静默输出整块
  assert.match(await render('overview.kpi:nope'), /未知/)
})

t('集群容量：点某个集群只读那一个', async () => {
  const one = await render('overview.clusters:obcluster-prod')
  assert.match(one, /obcluster-prod/)
  assert.match(one, /20\/48 核/)
  assert.ok(!one.includes('obcluster-test'), '不该把另一个集群也带上')
  assert.match(await render('overview.clusters:nope'), /没有找到集群/)
  // 整块仍然是两个集群的表格
  const all = await render('overview.clusters')
  assert.match(all, /obcluster-prod/)
  assert.match(all, /obcluster-test/)
})

t('集群清单 / 容量 / 告警 / 拓扑 / 参数：按集群筛', async () => {
  const list = await render('clusters.list:obcluster-test')
  assert.match(list, /obcluster-test/)
  assert.ok(!list.includes('obcluster-prod'), '清单只保留指定集群')

  const capOne = await render('clusters.capacity:obcluster-prod')
  assert.match(capOne, /obcluster-prod/)
  assert.ok(!capOne.includes('obcluster-test'))

  const alarms = await render('clusters.alarms:obcluster-test')
  assert.match(alarms, /obcluster-test/)
  assert.ok(!alarms.includes('obcluster-prod'))

  const topo = await render('clusters.topology:obcluster-prod')
  assert.match(topo, /zone1/)
  assert.ok(!topo.includes('**obcluster-test**'), '拓扑只包含指定集群')
  assert.ok(!topo.includes('仅包含前'), '单集群不该出现「前 N 个集群」的说明')

  const params = await render('clusters.params:obcluster-prod')
  assert.match(params, /memory_limit=32G/)
})

t('租户 / 主机：按行筛', async () => {
  const ten = await render('tenants.list:obtenant02')
  assert.match(ten, /obtenant02/)
  assert.ok(!ten.includes('obtenant01'), '只保留指定租户')
  assert.match(await render('tenants.list:nope'), /没有找到租户/)

  const host = await render('hosts.list:10.0.0.12')
  assert.match(host, /10\.0\.0\.12/)
  assert.ok(!host.includes('10.0.0.11'), '只保留指定主机')
  assert.match(await render('hosts.list:1.1.1.1'), /没有找到主机/)
})

t('备份指标 / 告警级别：按磁贴与级别拆', async () => {
  const success = await render('backup.overview:success')
  assert.match(success, /97\.5%/)
  assert.ok(!success.includes('抽检'), '只应包含成功率这一项')
  const rehearsal = await render('backup.overview:rehearsal')
  assert.match(rehearsal, /2\/2/)
  assert.match(await render('backup.overview:nope'), /未知/)

  assert.match(await render('alarms.levels:1'), /严重.*1 条/)
  assert.match(await render('alarms.levels:3'), /注意.*3 条/)
  assert.match(await render('alarms.levels:0'), /合计 6 条/)
})

let pass = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message || e}`)
    process.exitCode = 1
  }
}
console.log(`unit-ai-sections: ${pass}/${cases.length} 组断言通过`)
