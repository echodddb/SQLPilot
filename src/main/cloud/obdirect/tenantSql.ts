/**
 * 直连模式的租户生命周期 SQL 构造（纯函数，无 IO）。
 *
 * 单独成文件的原因：
 *   1) 便于单测——不引入 mysql2，Node 原生类型剥离可直接 import；
 *   2) 与 OCP 的租户创建彻底分开：OCP 走 REST + 任务框架（可回滚、有子任务进度），
 *      直连只有一串 DDL，**没有任务编排、没有回滚**，两者不可复用同一套代码。
 *
 * 语法基线（OceanBase 4.x）：
 *   CREATE RESOURCE UNIT   <name> MAX_CPU, MIN_MEMORY / MAX_MEMORY, LOG_DISK_SIZE, MAX_IOPS / MIN_IOPS
 *   CREATE RESOURCE POOL   <name> UNIT='<unit>', UNIT_NUM=<n>, ZONE_LIST=('z1','z2')
 *   CREATE TENANT          <name> RESOURCE_POOL_LIST=('<pool>'), LOCALITY, PRIMARY_ZONE, CHARSET, COLLATE, COMMENT
 *   ALTER TENANT           <name> SET VARIABLES ob_tcp_invited_nodes='...'
 *   ALTER TENANT           <name> LOCK | UNLOCK
 *   DROP TENANT            <name>
 */

/** 标识符白名单：库名 / 租户名 / Unit 名只放行字母数字下划线 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 租户名规则与 OCP 向导保持一致：字母开头，2~64 位 */
const TENANT_NAME = /^[A-Za-z][A-Za-z0-9_]{1,63}$/

/** 主 Zone：RANDOM，或 zone1 或 zone1;zone2;zone3（按优先级） */
const PRIMARY_ZONE = /^(RANDOM|[A-Za-z0-9_]+(;[A-Za-z0-9_]+)*)$/i

// ---------------------------------------------------------------- 字符集

export interface CharsetPreset {
  /** 与下发的 charset 值一致 */
  collations: string[]
  defaultCollation: string
}

/**
 * 各兼容模式支持的字符集与默认排序规则。
 *
 * MySQL 模式：OB 支持 utf8mb4 / utf8 / gbk / binary / latin1 / gb18030，
 *   默认 utf8mb4 + utf8mb4_general_ci（与 OCP 新建向导的默认值一致）。
 * Oracle 模式：**只支持 utf8mb4，排序规则固定 utf8mb4_bin**，建租户时不应带
 *   CHARSET/COLLATE 子句（带了会被 OB 拒绝），这里列出来只是为了让界面如实展示。
 */
export const CHARSET_PRESETS: Record<'MYSQL' | 'ORACLE', Record<string, CharsetPreset>> = {
  MYSQL: {
    utf8mb4: {
      collations: ['utf8mb4_general_ci', 'utf8mb4_bin', 'utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
      defaultCollation: 'utf8mb4_general_ci'
    },
    utf8: { collations: ['utf8_general_ci', 'utf8_bin', 'utf8_unicode_ci'], defaultCollation: 'utf8_general_ci' },
    gbk: { collations: ['gbk_chinese_ci', 'gbk_bin'], defaultCollation: 'gbk_chinese_ci' },
    binary: { collations: ['binary'], defaultCollation: 'binary' },
    latin1: { collations: ['latin1_swedish_ci', 'latin1_bin', 'latin1_general_ci'], defaultCollation: 'latin1_swedish_ci' },
    gb18030: { collations: ['gb18030_chinese_ci', 'gb18030_bin'], defaultCollation: 'gb18030_chinese_ci' }
  },
  ORACLE: {
    utf8mb4: { collations: ['utf8mb4_bin'], defaultCollation: 'utf8mb4_bin' }
  }
}

export const DEFAULT_MODE_CHARSET = { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }

/** 某兼容模式下可选字符集 */
export function charsetsOf(mode: 'MYSQL' | 'ORACLE'): string[] {
  return Object.keys(CHARSET_PRESETS[mode === 'ORACLE' ? 'ORACLE' : 'MYSQL'])
}

/** 某字符集在该模式下可选的排序规则 */
export function collationsOf(mode: 'MYSQL' | 'ORACLE', charset: string): string[] {
  const table = CHARSET_PRESETS[mode === 'ORACLE' ? 'ORACLE' : 'MYSQL']
  return table[String(charset || '')]?.collations ?? []
}

/**
 * 归一化 charset / collation：
 *   Oracle 模式强制 utf8mb4 + utf8mb4_bin（无论传什么）；
 *   MySQL 模式校验字符集受支持、排序规则与字符集匹配，缺省补默认值。
 * 不合法直接抛错——建租户是不可回滚的 DDL，宁可拦住也不能拼错。
 */
export function normalizeCharset(
  mode: 'MYSQL' | 'ORACLE',
  charset?: string,
  collation?: string
): { charset: string; collation: string } {
  if (mode === 'ORACLE') return { charset: 'utf8mb4', collation: 'utf8mb4_bin' }

  const cs = String(charset || 'utf8mb4').trim()
  const table = CHARSET_PRESETS.MYSQL
  const preset = table[cs]
  if (!preset) throw new Error(`MySQL 模式不支持字符集 ${charset}（可选：${Object.keys(table).join(' / ')}）`)

  const col = String(collation || '').trim()
  if (!col) return { charset: cs, collation: preset.defaultCollation }
  if (!preset.collations.includes(col)) {
    throw new Error(`排序规则 ${col} 与字符集 ${cs} 不匹配（可选：${preset.collations.join(' / ')}）`)
  }
  return { charset: cs, collation: col }
}

/**
 * 归一化主 Zone：留空或 RANDOM → RANDOM；否则必须是已选 Zone 的逗号优先级串。
 * 对应 OCP 向导里「主 Zone」下拉的语义，不再接受自由文本。
 */
export function normalizePrimaryZone(input: string | undefined, zones: string[]): string {
  const raw = String(input ?? '').trim()
  if (!raw) return 'RANDOM'
  if (/^random$/i.test(raw)) return 'RANDOM'
  if (!PRIMARY_ZONE.test(raw)) throw new Error(`主 Zone 非法：${raw}`)
  const parts = raw.split(';')
  const unknown = parts.filter((p) => !zones.includes(p))
  if (unknown.length) throw new Error(`主 Zone 必须是已选 Zone 之一：${unknown.join(', ')}`)
  return parts.join(';')
}

export interface CreateUnitSpec {
  name: string
  maxCpu: number
  /** 字节数 */
  minMemory: number
  /** 字节数 */
  maxMemory: number
  /** 字节数 */
  logDiskSize: number
  maxIops?: number
  minIops?: number
}

export interface CreateTenantSpec {
  name: string
  /** 已存在的 Unit 规格名，或新建规格时用的名字 */
  unitConfigName: string
  /** 每个 Zone 的 Unit 数 */
  unitCount: number
  /** 参与副本的 Zone 列表 */
  zoneList: string[]
  primaryZone?: string
  mode: 'MYSQL' | 'ORACLE'
  charset: string
  collation?: string
  comment?: string
  /** 资源池名，不传由租户名推导 */
  poolName?: string
}

/** 用户名里的租户后缀：root@sys → sys */
export function tenantOfUser(username: string): string {
  const at = String(username ?? '').indexOf('@')
  return at >= 0 ? String(username).slice(at + 1) : ''
}

/**
 * 租户管理必须由 sys 租户发起。
 * 不做「root@xx 自动改成 root@sys」的猜测：不同租户 root 密码不同，
 * 静默换租户只会得到一串 Access denied。
 */
export function assertSysTenantUsername(username: string): void {
  const t = tenantOfUser(username)
  if (t.toLowerCase() !== 'sys') {
    throw new Error(
      `租户管理需以 sys 租户连接（当前用户 ${username || '未填写'}）。` +
        '请在云管平台设置中把该直连平台的用户名改为形如 root@sys 后再试。'
    )
  }
}

export function assertIdent(name: string, what: string): string {
  const v = String(name ?? '').trim()
  if (!IDENT.test(v)) throw new Error(`${what}非法：${name}`)
  return v
}

/** 校验租户名，返回错误文案；通过时返回空串 */
export function validateTenantName(name: string): string {
  const v = String(name ?? '').trim()
  if (!v) return '租户名不能为空'
  if (!TENANT_NAME.test(v)) return '租户名需字母开头，仅含字母 / 数字 / 下划线，2~64 位'
  return ''
}

/** 单引号字符串字面量：内部单引号成对转义，反斜杠按 OB 默认行为保留字面 */
export function sqlString(value: string): string {
  return `'${String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** 字节数 → '4G' / '512M' 这类 OB 认的写法（整数 GB/MB 才省略小数） */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, Math.floor(Number(bytes) || 0))
  const gb = n / 1024 ** 3
  if (gb >= 1) return `${trimNum(gb)}G`
  const mb = n / 1024 ** 2
  if (mb >= 1) return `${trimNum(mb)}M`
  const kb = n / 1024
  if (kb >= 1) return `${trimNum(kb)}K`
  return `${n}`
}

const trimNum = (v: number): string => {
  const s = (Math.round(v * 1000) / 1000).toString()
  return s
}

/** '4G' / '512M' / '1024' → 字节数；无法解析返回 0 */
export function parseSize(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGTP]?)B?\s*$/i.exec(String(text ?? ''))
  if (!m) return 0
  const n = Number(m[1])
  const unit = (m[2] || '').toUpperCase()
  const mul: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }
  return Math.round(n * (mul[unit] ?? 1))
}

/** 由 Zone 列表推导 Locality：每 Zone 一份 FULL 副本 */
export function localityOf(zoneList: string[], unitCount = 1): string {
  const n = Math.max(1, Math.trunc(Number(unitCount) || 1))
  return zoneList.map((z) => `FULL{${n}}@${assertIdent(z, 'Zone 名')}`).join(', ')
}

/**
 * 解析资源池的 ZONE_LIST。
 *
 * 不同版本 / 不同视图返回的形态不一致：`zone1;zone2`、`zone1, zone2`、
 * `'zone1','zone2'` 都出现过。统一拆成去引号、去空白的数组。
 */
export function parseZoneList(raw: string): string[] {
  return String(raw ?? '')
    .split(/[;,]/)
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, '').trim())
    .filter(Boolean)
}

/** 租户名 → 默认资源池名 / Unit 名（OB 标识符上限 64/128，这里截断到安全长度） */export function poolNameOf(tenant: string): string {
  const base = assertIdent(tenant, '租户名')
  return `pool_${base}`.slice(0, 64)
}

export function unitNameOf(tenant: string): string {
  const base = assertIdent(tenant, '租户名')
  return `unit_${base}`.slice(0, 128)
}

/**
 * 新建 Unit 规格。
 *
 * memoryStyle 由调用方按实例能力决定（见 tenant.ts 的 execCreateUnit）：
 *   minmax = OB 4.1+ 写法：MIN_MEMORY / MAX_MEMORY
 *   size   = 老版本写法：MEMORY_SIZE（单值）
 * 实测 4.0 及更早对 MIN_MEMORY 会直接报语法错误，不能一律按新写法拼。
 *
 * LOG_DISK_SIZE 与内存写法是**两件独立的事**：老版本也支持该子句。
 * 早先把它跟 MEMORY_SIZE 绑在一起省掉，导致用户填 4096MB(4G) 最终被 OB
 * 按默认规则（内存的 3 倍）算成 6G——所以这里用 includeLogDisk 单独控制。
 */
export interface UnitDdlOptions {
  memoryStyle?: 'minmax' | 'size'
  /** 是否带 LOG_DISK_SIZE；个别版本不认该子句时才关掉 */
  includeLogDisk?: boolean
}

export function buildCreateUnitConfigSql(spec: CreateUnitSpec, opts: UnitDdlOptions = {}): string {
  const memoryStyle = opts.memoryStyle ?? 'minmax'
  const includeLogDisk = opts.includeLogDisk ?? true
  const name = assertIdent(spec.name, 'Unit 规格名')
  const cpu = Number(spec.maxCpu)
  if (!Number.isFinite(cpu) || cpu <= 0) throw new Error('CPU 必须大于 0')

  const maxMem = Math.max(0, Math.trunc(Number(spec.maxMemory) || 0))
  const minMem = Math.max(0, Math.trunc(Number(spec.minMemory) || maxMem))
  if (maxMem <= 0) throw new Error('内存必须大于 0')
  if (minMem > maxMem) throw new Error('最小内存不能大于最大内存')

  const parts = [`MAX_CPU ${cpu}`]
  const logDisk = Math.trunc(Number(spec.logDiskSize) || 0)

  if (memoryStyle === 'size') {
    // 老版本（OB 4.0 及更早 / 3.x）只认单个 MEMORY_SIZE，
    // 写 MIN_MEMORY / MAX_MEMORY 会直接报 "syntax error near 'MIN_MEMORY ...'"
    parts.push(`MEMORY_SIZE ${sqlString(formatBytes(maxMem))}`)
  } else {
    parts.push(
      `MIN_MEMORY ${sqlString(formatBytes(minMem))}`,
      `MAX_MEMORY ${sqlString(formatBytes(maxMem))}`
    )
  }
  // 日志盘与内存写法无关，默认都要带上——不带就等于把选择权交回给 OB 的默认值
  if (includeLogDisk && logDisk > 0) parts.push(`LOG_DISK_SIZE ${sqlString(formatBytes(logDisk))}`)

  const maxIops = Math.trunc(Number(spec.maxIops) || 0)
  const minIops = Math.trunc(Number(spec.minIops) || maxIops)
  if (maxIops > 0) parts.push(`MAX_IOPS ${maxIops}`, `MIN_IOPS ${Math.min(minIops, maxIops)}`)

  return `CREATE RESOURCE UNIT ${name} ${parts.join(', ')}`
}

/** 新建资源池 */
export function buildCreateResourcePoolSql(
  poolName: string,
  unitConfigName: string,
  unitCount: number,
  zoneList: string[]
): string {
  const pool = assertIdent(poolName, '资源池名')
  const unit = assertIdent(unitConfigName, 'Unit 规格名')
  const n = Math.trunc(Number(unitCount) || 0)
  if (n <= 0) throw new Error('每个 Zone 的 Unit 数必须大于 0')
  const zones = (zoneList || []).map((z) => assertIdent(z, 'Zone 名'))
  if (!zones.length) throw new Error('至少选择一个 Zone')
  return `CREATE RESOURCE POOL ${pool} UNIT=${sqlString(unit)}, UNIT_NUM=${n}, ZONE_LIST=(${zones
    .map((z) => sqlString(z))
    .join(', ')})`
}

/**
 * 新建租户：资源池、Locality、主 Zone、字符集一次给全，避免建完再 ALTER。
 *
 * 兼容模式**必须显式下发**：OB 的 CREATE TENANT 在不指定 ob_compatibility_mode 时
 * 一律建成 MySQL 租户，而且建成后无法 ALTER 修改。之前漏了这条 SET 子句，
 * 界面选 Oracle、实例里却是 MySQL，只能删了重建。
 */
export function buildCreateTenantSql(spec: CreateTenantSpec): string {
  const err = validateTenantName(spec.name)
  if (err) throw new Error(err)
  const name = String(spec.name).trim()
  const pool = assertIdent(spec.poolName || poolNameOf(name), '资源池名')
  const zones = (spec.zoneList || []).map((z) => assertIdent(z, 'Zone 名'))
  if (!zones.length) throw new Error('至少选择一个 Zone')

  // 字符集按兼容模式归一化：Oracle 模式固定 utf8mb4 + utf8mb4_bin，
  // MySQL 模式校验字符集受支持、排序规则与字符集匹配
  const { charset, collation } = normalizeCharset(spec.mode, spec.charset, spec.collation)
  const primary = normalizePrimaryZone(spec.primaryZone, zones)

  const parts = [
    `RESOURCE_POOL_LIST=(${sqlString(pool)})`,
    `LOCALITY=${sqlString(localityOf(zones, spec.unitCount))}`,
    `PRIMARY_ZONE=${sqlString(primary)}`
  ]
  // Oracle 模式的字符集由系统固定，DDL 里带 CHARSET / COLLATE 会被 OB 拒绝
  if (spec.mode !== 'ORACLE') {
    parts.push(`CHARSET=${sqlString(charset)}`)
    if (collation) parts.push(`COLLATE=${sqlString(collation)}`)
  }
  const comment = String(spec.comment || '').trim()
  if (comment) parts.push(`COMMENT=${sqlString(comment.slice(0, 512))}`)

  // 兼容模式是"创建时唯一一次可指定"的属性，Oracle 必须显式 SET。
  // MySQL 不下发（实例默认即 mysql），避免个别老版本对该变量报语法错。
  const setClause = spec.mode === 'ORACLE' ? ` SET ob_compatibility_mode=${sqlString('oracle')}` : ''

  return `CREATE TENANT ${name} ${parts.join(', ')}${setClause}`
}

/** 租户白名单（ob_tcp_invited_nodes），由 sys 租户代设 */
export function buildWhitelistSql(tenant: string, whitelist: string): string {
  const name = assertIdent(tenant, '租户名')
  const v = String(whitelist || '%').trim() || '%'
  return `ALTER TENANT ${name} SET VARIABLES ob_tcp_invited_nodes=${sqlString(v)}`
}

export function buildDropTenantSql(tenant: string): string {
  return `DROP TENANT ${assertIdent(tenant, '租户名')}`
}

/** 删资源池：租户删除后池会残留，需要显式回收，否则一直占着 Unit 规格 */
export function buildDropResourcePoolSql(poolName: string): string {
  return `DROP RESOURCE POOL ${assertIdent(poolName, '资源池名')}`
}

export function buildLockTenantSql(tenant: string, locked: boolean): string {
  return `ALTER TENANT ${assertIdent(tenant, '租户名')} ${locked ? 'LOCK' : 'UNLOCK'}`
}

// ---------------------------------------------------------------- 连接串

export interface ConnectInfo {
  /** OBProxy 或集群对外地址（obclient -h） */
  host: string
  /** OBProxy 端口，默认 2883 */
  proxyPort?: number
  /** OBServer 直连端口，默认 2881 */
  sqlPort?: number
  /** 一台 OBServer 的 IP，用于直连串；缺省回落到 host */
  observerIp?: string
  /** 集群名：拼在 -u 后面的 # 后缀 */
  cluster: string
  /** 租户名 */
  tenant: string
  /** MYSQL | ORACLE，决定默认账号与附加参数 */
  mode: 'MYSQL' | 'ORACLE'
  /** 明文密码；空则用占位符 */
  password?: string
}

export interface ConnCommand {
  label: string
  command: string
}

/**
 * 生成 obclient 连接串（三种形态，按租户类型区分参数）。
 *
 * 依据现场约定：
 *   Oracle 模式：obclient -h<host> -P2883 -usys@<租户>#<集群> -p'<pw>' -A
 *   MySQL 模式 ：obclient -h<host> -P2883 -uroot@<租户>#<集群> -p'<pw>' -c -A -D oceanbase
 *   OBProxy 管理：obclient -h<host> -P2883 -uroot@proxysys -p'<pw>' -c -A -D oceanbase
 *
 * 注意两点：
 *   1) Oracle 模式的管理员是 SYS（不是 root），且不带 -c / -D oceanbase（那是 MySQL 语义）；
 *   2) 经 OBProxy 时账号要带 `#集群名`，直连 OBServer 时不能带。
 */
export function buildConnectionStrings(info: ConnectInfo): ConnCommand[] {
  const host = String(info.host || '').trim()
  const cluster = String(info.cluster || '').trim()
  const tenant = String(info.tenant || '').trim()
  const mode = info.mode === 'ORACLE' ? 'ORACLE' : 'MYSQL'
  const user = mode === 'ORACLE' ? 'sys' : 'root'
  const pw = String(info.password || '')
  const pwArg = pw ? `-p'${pw.replace(/'/g, "'\\''")}'` : `-p'<密码>'`
  const mysqlTail = '-c -A -D oceanbase'
  const tail = mode === 'MYSQL' ? mysqlTail : '-A'

  const proxyPort = Number(info.proxyPort) || 2883
  const sqlPort = Number(info.sqlPort) || 2881
  const observer = String(info.observerIp || host).trim()

  const out: ConnCommand[] = []
  if (!host || !tenant) return out

  // 1) 经 OBProxy：账号带 #集群名，业务最常用
  out.push({
    label: `经 OBProxy（${proxyPort}）· ${mode === 'ORACLE' ? 'Oracle' : 'MySQL'} 模式`,
    command: `obclient -h${host} -P${proxyPort} -u${user}@${tenant}${cluster ? `#${cluster}` : ''} ${pwArg} ${tail}`
  })

  // 2) 直连 OBServer：不带 #集群名
  out.push({
    label: `直连 OBServer（${sqlPort}）· ${mode === 'ORACLE' ? 'Oracle' : 'MySQL'} 模式`,
    command: `obclient -h${observer} -P${sqlPort} -u${user}@${tenant} ${pwArg} ${tail}`
  })

  // 3) OBProxy 管理口：密码是 proxy 自己的，与租户密码无关，用占位符避免误用
  out.push({
    label: 'OBProxy 管理连接',
    command: `obclient -h${host} -P${proxyPort} -uroot@proxysys -p'<OBProxy 管理密码>' ${mysqlTail}`
  })

  return out
}

/** 改 root 密码：必须在租户内执行，调用方需连到该租户 */export function buildSetRootPasswordSql(password: string): string {
  const pw = String(password ?? '')
  if (!pw) throw new Error('密码不能为空')
  return `ALTER USER root IDENTIFIED BY ${sqlString(pw)}`
}
