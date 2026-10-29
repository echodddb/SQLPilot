// 直连模式租户 SQL 构造单测。
// 只测纯函数层（tenantSql.ts）：不连数据库、不引入 mysql2，验证的是「拼出来的 DDL 是否正确、
// 该拒的输入是否被拒」——直连没有回滚，拼错一条就是现场事故。
import assert from 'node:assert/strict'
import {
  assertSysTenantUsername,
  buildConnectionStrings,
  buildCreateResourcePoolSql,
  buildCreateTenantSql,
  buildCreateUnitConfigSql,
  buildDropTenantSql,
  buildDropResourcePoolSql,
  buildLockTenantSql,
  buildSetRootPasswordSql,
  buildWhitelistSql,
  charsetsOf,
  collationsOf,
  formatBytes,
  localityOf,
  normalizeCharset,
  normalizePrimaryZone,
  parseSize,
  parseZoneList,
  poolNameOf,
  sqlString,
  tenantOfUser,
  unitNameOf,
  validateTenantName
} from '../src/main/cloud/obdirect/tenantSql.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}
const throws = (fn, pattern, why) => {
  assert.throws(fn, pattern, why)
  passed++
}

// ---------- 租户名校验 ----------
eq(validateTenantName('app_order'), '', '合法租户名通过')
eq(validateTenantName('t1'), '', '两位、字母开头通过')
ok(validateTenantName('') !== '', '空名被拒')
ok(validateTenantName('1abc') !== '', '数字开头被拒')
ok(validateTenantName('app-order') !== '', '连字符被拒')
ok(validateTenantName('a'.repeat(65)) !== '', '超 64 位被拒')
ok(validateTenantName("app'; DROP TENANT sys; --") !== '', '注入串被名规则挡住')

// ---------- 字面量转义 ----------
eq(sqlString("O'Brien"), "'O''Brien'", '单引号成对转义')
eq(sqlString('a\\b'), "'a\\\\b'", '反斜杠转义')
eq(sqlString("'; DROP TENANT x; --"), "'''; DROP TENANT x; --'", '注入串退化为普通字符串')

// ---------- 容量换算 ----------
eq(formatBytes(4 * 1024 ** 3), '4G', '4GiB → 4G')
eq(formatBytes(1536 * 1024 ** 2), '1.5G', '1.5GiB → 1.5G')
eq(formatBytes(512 * 1024 ** 2), '512M', '512MiB → 512M')
eq(parseSize('4G'), 4 * 1024 ** 3, '4G 解析')
eq(parseSize('512m'), 512 * 1024 ** 2, '小写单位也认')
eq(parseSize(' nonsense '), 0, '无法解析返回 0')

// ---------- Locality ----------
eq(localityOf(['zone1', 'zone2']), 'FULL{1}@zone1, FULL{1}@zone2', '默认每 Zone 一份 FULL 副本')
eq(localityOf(['zone1'], 3), 'FULL{3}@zone1', 'Unit 数写进副本数')
throws(() => localityOf(['zone 1']), /Zone 名非法/, '带空格的 Zone 被拒')

// ---------- Unit 规格 DDL ----------
const unitSql = buildCreateUnitConfigSql({
  name: 'unit_app',
  maxCpu: 2,
  minMemory: 4 * 1024 ** 3,
  maxMemory: 8 * 1024 ** 3,
  logDiskSize: 10 * 1024 ** 3
})
eq(
  unitSql,
  "CREATE RESOURCE UNIT unit_app MAX_CPU 2, MIN_MEMORY '4G', MAX_MEMORY '8G', LOG_DISK_SIZE '10G'",
  'Unit 规格 DDL 全字段'
)
ok(!unitSql.includes('MAX_IOPS'), '未给 IOPS 时不拼该子句')
ok(
  buildCreateUnitConfigSql({ name: 'u', maxCpu: 1, minMemory: 1024 ** 3, maxMemory: 1024 ** 3, logDiskSize: 0 }).includes(
    'LOG_DISK_SIZE'
  ) === false,
  '日志盘为 0 时省略子句'
)
throws(
  () => buildCreateUnitConfigSql({ name: 'u', maxCpu: 0, minMemory: 1024 ** 3, maxMemory: 1024 ** 3, logDiskSize: 0 }),
  /CPU 必须大于 0/,
  'CPU 为 0 被拒'
)
throws(
  () => buildCreateUnitConfigSql({ name: 'u', maxCpu: 1, minMemory: 8e9, maxMemory: 4e9, logDiskSize: 0 }),
  /最小内存不能大于最大内存/,
  'min > max 被拒'
)

// ---------- Unit 内存写法：老版本只认 MEMORY_SIZE ----------
// 现场报错①：syntax error near 'MIN_MEMORY '2G', MAX_MEMORY '2G', LOG_DISK_SIZE '10G''
// 现场报错②：日志盘填 4096MB 却建成 6G —— 因为把 LOG_DISK_SIZE 一起省掉了，OB 按默认规则补值
const legacySpec = { name: 'unit_legacy', maxCpu: 2, minMemory: 2 * 1024 ** 3, maxMemory: 2 * 1024 ** 3, logDiskSize: 10 * 1024 ** 3 }
const legacyUnit = buildCreateUnitConfigSql(legacySpec, { memoryStyle: 'size' })
eq(
  legacyUnit,
  "CREATE RESOURCE UNIT unit_legacy MAX_CPU 2, MEMORY_SIZE '2G', LOG_DISK_SIZE '10G'",
  '老版本内存写法，但日志盘仍然下发'
)
ok(!legacyUnit.includes('MIN_MEMORY'), '老版本写法不出现 MIN_MEMORY')
ok(legacyUnit.includes("LOG_DISK_SIZE '10G'"), '老版本写法保留 LOG_DISK_SIZE（否则会被默认值顶掉）')
eq(
  buildCreateUnitConfigSql(legacySpec, { memoryStyle: 'size', includeLogDisk: false }),
  "CREATE RESOURCE UNIT unit_legacy MAX_CPU 2, MEMORY_SIZE '2G'",
  '仅当版本不认该子句时才省掉 LOG_DISK_SIZE'
)
ok(
  buildCreateUnitConfigSql(
    { name: 'unit_new', maxCpu: 2, minMemory: 2 * 1024 ** 3, maxMemory: 4 * 1024 ** 3, logDiskSize: 10 * 1024 ** 3 },
    { memoryStyle: 'minmax' }
  ).includes("MIN_MEMORY '2G', MAX_MEMORY '4G', LOG_DISK_SIZE '10G'"),
  '新版本写法保留 MIN/MAX/LOG_DISK'
)
eq(
  formatBytes(4096 * 1024 ** 2),
  '4G',
  '4096MB 应换算为 4G（现场被建成 6G 属于未下发日志盘，不是换算问题）'
)

// ---------- 字符集：按兼容模式分档 ----------
eq(charsetsOf('MYSQL'), ['utf8mb4', 'utf8', 'gbk', 'binary', 'latin1', 'gb18030'], 'MySQL 模式支持的字符集')
eq(charsetsOf('ORACLE'), ['utf8mb4'], 'Oracle 模式只支持 utf8mb4')
eq(collationsOf('ORACLE', 'utf8mb4'), ['utf8mb4_bin'], 'Oracle 模式排序规则固定 utf8mb4_bin')
eq(collationsOf('MYSQL', 'utf8mb4')[0], 'utf8mb4_general_ci', 'MySQL 默认排序规则 utf8mb4_general_ci')
eq(normalizeCharset('MYSQL'), { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }, 'MySQL 缺省字符集')
eq(normalizeCharset('MYSQL', 'gbk', 'gbk_bin'), { charset: 'gbk', collation: 'gbk_bin' }, 'MySQL 指定 gbk 生效')
eq(normalizeCharset('ORACLE', 'gbk', 'gbk_bin'), { charset: 'utf8mb4', collation: 'utf8mb4_bin' }, 'Oracle 模式强制 utf8mb4/bin')
throws(() => normalizeCharset('MYSQL', 'utf8mb4', 'gbk_bin'), /不匹配/, '排序规则与字符集不匹配被拒')
throws(() => normalizeCharset('MYSQL', 'sjis'), /不支持字符集/, '不支持的字符集被拒')

// ---------- 资源池 ZONE_LIST 解析（建租户改为复用现有池，Zone 由池决定） ----------
eq(parseZoneList('zone1;zone2;zone3'), ['zone1', 'zone2', 'zone3'], '分号分隔')
eq(parseZoneList('zone1, zone2'), ['zone1', 'zone2'], '逗号+空格分隔')
eq(parseZoneList("'zone1','zone2'"), ['zone1', 'zone2'], '带引号的形态')
eq(parseZoneList(''), [], '空串返回空数组')
eq(parseZoneList(' zone1 ;; zone2 '), ['zone1', 'zone2'], '忽略空段与首尾空白')

// ---------- 主 Zone：只接受 RANDOM 或已选 Zone ----------
eq(normalizePrimaryZone(undefined, ['z1']), 'RANDOM', '缺省 RANDOM')
eq(normalizePrimaryZone('random', ['z1']), 'RANDOM', '大小写不敏感')
eq(normalizePrimaryZone('z1', ['z1', 'z2']), 'z1', '单 Zone 生效')
eq(normalizePrimaryZone('z2;z1', ['z1', 'z2']), 'z2;z1', '优先级串生效')
throws(() => normalizePrimaryZone('z1;z9', ['z1']), /必须是已选 Zone/, '含未选 Zone 被拒')
throws(() => normalizePrimaryZone("z1'; --", ['z1']), /主 Zone 非法/, '注入串被拒')

// ---------- 资源池 DDL ----------
eq(
  buildCreateResourcePoolSql('pool_app', 'unit_app', 2, ['zone1', 'zone3']),
  "CREATE RESOURCE POOL pool_app UNIT='unit_app', UNIT_NUM=2, ZONE_LIST=('zone1', 'zone3')",
  '资源池 DDL'
)
throws(() => buildCreateResourcePoolSql('p', 'u', 0, ['z1']), /Unit 数必须大于 0/, 'Unit 数为 0 被拒')
throws(() => buildCreateResourcePoolSql('p', 'u', 1, []), /至少选择一个 Zone/, '空 Zone 被拒')

// ---------- 租户 DDL ----------
const tenantSql = buildCreateTenantSql({
  name: 'app_order',
  unitConfigName: 'unit_app',
  unitCount: 1,
  zoneList: ['zone1', 'zone2', 'zone3'],
  mode: 'MYSQL',
  charset: 'utf8mb4',
  collation: 'utf8mb4_general_ci',
  comment: '订单库'
})
eq(
  tenantSql,
  "CREATE TENANT app_order RESOURCE_POOL_LIST=('pool_app_order'), " +
    "LOCALITY='FULL{1}@zone1, FULL{1}@zone2, FULL{1}@zone3', " +
    "PRIMARY_ZONE='RANDOM', CHARSET='utf8mb4', COLLATE='utf8mb4_general_ci', COMMENT='订单库'",
  '建租户 DDL 全字段（主 Zone 缺省 RANDOM，与 OCP 向导一致）'
)
ok(
  buildCreateTenantSql({
    name: 't2', unitConfigName: 'u', unitCount: 1, zoneList: ['z1'], mode: 'ORACLE', charset: 'utf8mb4'
  }).includes('COLLATE') === false,
  '不给排序规则时不拼 COLLATE'
)
const oracleSql = buildCreateTenantSql({
  name: 't5', unitConfigName: 'u', unitCount: 1, zoneList: ['z1'], mode: 'ORACLE', charset: 'utf8mb4', collation: 'utf8mb4_bin'
})
ok(!oracleSql.includes('CHARSET'), 'Oracle 模式不拼 CHARSET（由系统固定）')
ok(!oracleSql.includes('COLLATE'), 'Oracle 模式不拼 COLLATE')
ok(oracleSql.includes("RESOURCE_POOL_LIST=('pool_t5')"), 'Oracle 模式仍带资源池')
// 回归防护：CREATE TENANT 不指定 ob_compatibility_mode 时 OB 一律建成 MySQL，
// 这条断言就是防止"界面选 Oracle、实例里是 MySQL"再次发生。
ok(oracleSql.includes("SET ob_compatibility_mode='oracle'"), 'Oracle 模式必须显式下发 ob_compatibility_mode')
ok(!tenantSql.includes('ob_compatibility_mode'), 'MySQL 模式不下发兼容模式变量（走实例缺省）')
eq(
  buildCreateTenantSql({
    name: 't3', unitConfigName: 'u', unitCount: 1, zoneList: ['z1', 'z2'], mode: 'MYSQL', charset: 'utf8mb4', primaryZone: 'z1;z2'
  }).includes("PRIMARY_ZONE='z1;z2'"),
  true,
  '显式主 Zone 优先级生效'
)
throws(
  () => buildCreateTenantSql({ name: 't6', unitConfigName: 'u', unitCount: 1, zoneList: ['z1'], mode: 'MYSQL', charset: 'utf8mb4', primaryZone: 'z9' }),
  /主 Zone 必须是已选 Zone 之一/,
  '主 Zone 超出已选 Zone 被拒'
)
throws(
  () => buildCreateTenantSql({ name: 'bad-name', unitConfigName: 'u', unitCount: 1, zoneList: ['z1'], mode: 'MYSQL', charset: 'utf8mb4' }),
  /租户名需字母开头/,
  '非法租户名被拒'
)
throws(
  () => buildCreateTenantSql({ name: 't4', unitConfigName: 'u', unitCount: 1, zoneList: ['z1'], mode: 'MYSQL', charset: "utf8mb4'; DROP TENANT sys; --" }),
  /不支持字符集/,
  '字符集注入被拒'
)
throws(
  () => buildCreateTenantSql({ name: 't7', unitConfigName: 'u', unitCount: 1, zoneList: ['z1'], mode: 'MYSQL', charset: 'gbk', collation: 'utf8mb4_bin' }),
  /与字符集 gbk 不匹配/,
  '排序规则与字符集不匹配被拒'
)

// ---------- 其它语句 ----------
eq(buildWhitelistSql('app_order', '10.0.0.%'), "ALTER TENANT app_order SET VARIABLES ob_tcp_invited_nodes='10.0.0.%'", '白名单语句')
eq(buildWhitelistSql('app_order', ''), "ALTER TENANT app_order SET VARIABLES ob_tcp_invited_nodes='%'", '空白名单回落到 %')
eq(buildDropTenantSql('app_order'), 'DROP TENANT app_order', '删租户语句')
eq(buildDropResourcePoolSql('pool_app_order'), 'DROP RESOURCE POOL pool_app_order', '删资源池语句（删租户不会自动回收）')
throws(() => buildDropResourcePoolSql("p'; --"), /资源池名非法/, '资源池名注入被拒')
eq(buildLockTenantSql('app_order', true), 'ALTER TENANT app_order LOCK', '锁定语句')
eq(buildLockTenantSql('app_order', false), 'ALTER TENANT app_order UNLOCK', '解锁语句')
eq(buildSetRootPasswordSql("p'w"), "ALTER USER root IDENTIFIED BY 'p''w'", '改密语句转义')
throws(() => buildSetRootPasswordSql(''), /密码不能为空/, '空密码被拒')

// ---------- sys 租户守卫 ----------
eq(tenantOfUser('root@sys'), 'sys', '取租户后缀')
eq(tenantOfUser('root'), '', '无后缀返回空')
eq(tenantOfUser('root@tenantA'), 'tenantA', '普通租户后缀')
ok((() => { try { assertSysTenantUsername('root@sys'); return true } catch { return false } })(), 'root@sys 放行')
ok((() => { try { assertSysTenantUsername('ROOT@SYS'); return true } catch { return false } })(), '大小写不敏感')
throws(() => assertSysTenantUsername('root@app_order'), /需以 sys 租户连接/, '非 sys 租户被拦')
throws(() => assertSysTenantUsername('root'), /需以 sys 租户连接/, '无租户后缀被拦')

// ---------- 默认命名 ----------
eq(poolNameOf('app_order'), 'pool_app_order', '资源池默认名')
eq(unitNameOf('app_order'), 'unit_app_order', 'Unit 规格默认名')
throws(() => poolNameOf("a'; --"), /租户名非法/, '默认命名也走标识符校验')

// ---------- 连接串（按租户类型区分） ----------
const mysqlConns = buildConnectionStrings({
  host: '192.168.10.160',
  cluster: 'ob_cluster',
  tenant: 'obmysql',
  mode: 'MYSQL',
  password: '1qaz@WSX3edc'
})
eq(
  mysqlConns[0].command,
  "obclient -h192.168.10.160 -P2883 -uroot@obmysql#ob_cluster -p'1qaz@WSX3edc' -c -A -D oceanbase",
  'MySQL 模式：经 OBProxy 带 #集群名，附 -c -A -D oceanbase'
)
ok(mysqlConns[1].command.includes('-P2881'), '第二条是 OBServer 直连（2881）')
ok(!mysqlConns[1].command.includes('#'), '直连串不带 #集群名')
ok(mysqlConns[2].command.includes('-uroot@proxysys'), '第三条是 OBProxy 管理连接')
ok(mysqlConns[2].command.includes('<OBProxy 管理密码>'), 'OBProxy 管理串使用占位密码，避免误用租户密码')

const oraConns = buildConnectionStrings({
  host: '192.168.10.160',
  cluster: 'ob_cluster',
  tenant: 'oboracle',
  mode: 'ORACLE',
  password: '1qaz@WSX3edc'
})
eq(
  oraConns[0].command,
  "obclient -h192.168.10.160 -P2883 -usys@oboracle#ob_cluster -p'1qaz@WSX3edc' -A",
  'Oracle 模式：账号 sys、无 -c / -D 参数'
)
ok(!oraConns[0].command.includes('-D oceanbase'), 'Oracle 模式不带 -D oceanbase')

ok(
  buildConnectionStrings({ host: 'h', cluster: 'c', tenant: 't', mode: 'MYSQL' })[0].command.includes('<密码>'),
  '未提供密码时用占位符'
)
ok(
  buildConnectionStrings({ host: '1.2.3.4', observerIp: '5.6.7.8', cluster: 'c', tenant: 't', mode: 'MYSQL' })[1].command.includes(
    '-h5.6.7.8'
  ),
  '直连串优先用 OBServer IP'
)
eq(buildConnectionStrings({ host: '', cluster: 'c', tenant: 't', mode: 'MYSQL' }), [], '缺少主机时不出连接串')

console.log(`\x1b[32m✓ unit-obdirect-tenant: ${passed} 个断言通过\x1b[0m`)
