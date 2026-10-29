/**
 * 直连模式的租户生命周期（建 / 删 / 锁定）。
 *
 * 与 OCP 托管的本质差别（刻意不复用 ocp.ts 的任何代码）：
 *   OCP：一次 REST 提交 → 任务框架编排 → 可回滚、有子任务进度、失败自动清理；
 *   直连：在 **sys 租户** 里依次执行若干条 DDL → **没有任务、没有回滚**。
 * 因此这里必须：
 *   1) 严格执行 sys 租户校验（CREATE TENANT / ALTER TENANT 只能由 sys 发起）；
 *   2) 每一步都留痕，失败时明确告诉用户「已经创建了哪些对象」，便于手工收尾；
 *   3) 名称、Zone、规格全部走白名单校验，DDL 无法参数化。
 */

import { execWrite, q, q1, execAsTenant, type ObDirectPlatform } from './conn'
import {
  assertIdent,
  assertSysTenantUsername,
  buildCreateResourcePoolSql,
  buildCreateTenantSql,
  buildCreateUnitConfigSql,
  buildDropTenantSql,
  buildDropResourcePoolSql,
  buildLockTenantSql,
  buildSetRootPasswordSql,
  buildWhitelistSql,
  buildConnectionStrings,
  formatBytes,
  parseZoneList,
  tenantOfUser,
  validateTenantName,
  type CreateUnitSpec
} from './tenantSql'

const str = (v: any): string => (v === undefined || v === null ? '' : String(v))
const num = (v: any): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 用户名里的租户后缀：root@sys → sys（实现放在 tenantSql，便于单测） */
export { tenantOfUser }

/** 租户管理必须由 sys 租户发起 */
export function assertSysTenant(p: ObDirectPlatform): void {
  assertSysTenantUsername(p.username)
}

/**
 * 判定实例认哪一种 Unit 内存写法。
 *
 * 实测：OB 4.0 及更早只认 `MEMORY_SIZE`，写 `MIN_MEMORY` 会直接报
 * "syntax error ... near 'MIN_MEMORY ...'"。这里按系统视图里有没有 MIN_MEMORY 列来判断，
 * 比按版本号猜更可靠（同版本不同发行版也可能不一致）。
 */
export async function unitMemoryStyleOf(p: ObDirectPlatform, password: string): Promise<'minmax' | 'size'> {
  try {
    await q(p, password, 'SELECT MIN_MEMORY FROM oceanbase.DBA_OB_UNIT_CONFIGS LIMIT 0')
    return 'minmax'
  } catch {
    return 'size'
  }
}

/**
 * 建 Unit 规格，带自动纠错与结果核对。
 *
 * 两种写法按顺序尝试（语法错误才换下一种，其它错误直接抛）：
 *   1) 探测到的写法 + LOG_DISK_SIZE
 *   2) 另一种内存写法 + LOG_DISK_SIZE
 *   3) MEMORY_SIZE 且不带 LOG_DISK_SIZE（最老版本兜底）
 * 这正是现场两条报错的兜底路径：MIN_MEMORY 语法错、日志盘被默认值顶掉。
 */
async function execCreateUnit(
  p: ObDirectPlatform,
  password: string,
  spec: CreateUnitSpec
): Promise<{ sql: string; warning?: string }> {
  const first = await unitMemoryStyleOf(p, password)
  const variants: { memoryStyle: 'minmax' | 'size'; includeLogDisk: boolean }[] = [
    { memoryStyle: first, includeLogDisk: true },
    { memoryStyle: first === 'minmax' ? 'size' : 'minmax', includeLogDisk: true },
    { memoryStyle: 'size', includeLogDisk: false }
  ]

  let lastErr: any = null
  let usedSql = ''
  let usedWithoutLog = false
  for (const v of variants) {
    const sql = buildCreateUnitConfigSql(spec, v)
    try {
      await execWrite(p, password, sql)
      usedSql = sql
      usedWithoutLog = !v.includeLogDisk
      lastErr = null
      break
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message ?? e)
      // 只有语法错才值得换写法；权限、资源不足之类的换写法也没用
      if (!/syntax|1064/i.test(msg)) throw e
    }
  }
  if (lastErr) throw lastErr

  const warnings: string[] = []
  if (usedWithoutLog && Number(spec.logDiskSize) > 0) {
    warnings.push('该版本不接受 LOG_DISK_SIZE，日志盘由实例按默认规则分配')
  }
  const mismatch = await unitLogDiskMismatch(p, password, spec.name, Number(spec.logDiskSize) || 0)
  if (mismatch) warnings.push(mismatch)
  return { sql: usedSql, warning: warnings.length ? warnings.join('；') : undefined }
}

/**
 * 回读日志盘大小，与请求值核对。
 * 现场问题：填 4096MB(4G) 却建成 6G——因为子句没下发，OB 按默认规则补了值。
 * 与其让用户自己去列表里发现，不如建完就比对一次并在提示里说明。
 */
async function unitLogDiskMismatch(
  p: ObDirectPlatform,
  password: string,
  unitName: string,
  wantBytes: number
): Promise<string> {
  if (!wantBytes) return ''
  try {
    const rows = await q<any>(
      p, password,
      'SELECT LOG_DISK_SIZE FROM oceanbase.DBA_OB_UNIT_CONFIGS WHERE NAME = ? LIMIT 1',
      [unitName]
    )
    const got = num(rows[0]?.LOG_DISK_SIZE)
    if (!got) return ''
    if (Math.abs(got - wantBytes) <= 1024 * 1024) return ''
    return `日志盘请求 ${formatBytes(wantBytes)}，实例实际为 ${formatBytes(got)}（可能被实例按默认规则调整）`
  } catch {
    return ''
  }
}

export interface ObUnitConfigRow {
  /** UNIT_CONFIG_ID，资源池通过它引用规格 */
  id: number
  name: string
  maxCpu: number
  minCpu: number
  /** 字节 */
  maxMemory: number
  minMemory: number
  logDiskSize: number
  maxIops: number
  minIops: number
  /** SYS 租户自带的规格（不可用于业务租户） */
  system: boolean
}

/** Unit 规格清单（DBA_OB_UNIT_CONFIGS）；视图缺失时返回空数组而不是抛错 */
export async function unitConfigsOf(p: ObDirectPlatform, password: string): Promise<ObUnitConfigRow[]> {
  try {
    const rows = await q<any>(p, password, 'SELECT * FROM oceanbase.DBA_OB_UNIT_CONFIGS ORDER BY UNIT_CONFIG_ID')
    return rows.map((r) => {
      const name = str(r.NAME)
      return {
        id: num(r.UNIT_CONFIG_ID),
        name,
        maxCpu: num(r.MAX_CPU),
        minCpu: num(r.MIN_CPU),
        maxMemory: num(r.MAX_MEMORY) || num(r.MEMORY_SIZE),
        minMemory: num(r.MIN_MEMORY) || num(r.MEMORY_SIZE),
        logDiskSize: num(r.LOG_DISK_SIZE),
        maxIops: num(r.MAX_IOPS),
        minIops: num(r.MIN_IOPS),
        system: /^sys_/i.test(name)
      }
    })
  } catch {
    return []
  }
}

export interface ObResourcePoolRow {
  id: number
  name: string
  tenantId: number
  /** 绑定的租户名；空表示已解绑（租户删除后资源池会留下来） */
  tenantName: string
  unitCount: number
  unitConfigId: number
  /** 引用的 Unit 规格名，便于和规格页对账 */
  unitConfigName: string
  zoneList: string
  status: string
}

/**
 * 资源池清单。
 *
 * 带上租户名与规格名，是因为「删 Unit 规格失败」的根因通常就在这里：
 * DROP TENANT **不会**自动回收资源池，池会残留并继续引用规格（TENANT_ID 变空）。
 * 联表之后界面能直接看出「哪个池还在占着这个规格」。
 */
export async function resourcePoolsOf(p: ObDirectPlatform, password: string): Promise<ObResourcePoolRow[]> {
  try {
    const rows = await q<any>(
      p, password,
      `SELECT p.*, t.TENANT_NAME, u.NAME AS UNIT_CONFIG_NAME
         FROM oceanbase.DBA_OB_RESOURCE_POOLS p
         LEFT JOIN oceanbase.DBA_OB_TENANTS t ON p.TENANT_ID = t.TENANT_ID
         LEFT JOIN oceanbase.DBA_OB_UNIT_CONFIGS u ON p.UNIT_CONFIG_ID = u.UNIT_CONFIG_ID
        ORDER BY p.RESOURCE_POOL_ID`
    )
    return rows.map((r) => ({
      id: num(r.RESOURCE_POOL_ID),
      name: str(r.NAME),
      tenantId: num(r.TENANT_ID),
      tenantName: str(r.TENANT_NAME),
      unitCount: num(r.UNIT_COUNT),
      unitConfigId: num(r.UNIT_CONFIG_ID),
      unitConfigName: str(r.UNIT_CONFIG_NAME),
      zoneList: str(r.ZONE_LIST),
      status: str(r.STATUS)
    }))
  } catch {
    // 联表失败（老版本视图列差异）时退回单表查询，至少保证界面有数据
    try {
      const rows = await q<any>(p, password, 'SELECT * FROM oceanbase.DBA_OB_RESOURCE_POOLS ORDER BY RESOURCE_POOL_ID')
      return rows.map((r) => ({
        id: num(r.RESOURCE_POOL_ID),
        name: str(r.NAME),
        tenantId: num(r.TENANT_ID),
        tenantName: '',
        unitCount: num(r.UNIT_COUNT),
        unitConfigId: num(r.UNIT_CONFIG_ID),
        unitConfigName: '',
        zoneList: str(r.ZONE_LIST),
        status: str(r.STATUS)
      }))
    } catch {
      return []
    }
  }
}

export interface DirectCreateTenantInput {
  name: string
  mode: 'MYSQL' | 'ORACLE'
  charset: string
  collation?: string
  comment?: string
  primaryZone?: string
  /**
   * 必填：复用**已存在**的资源池。
   * 直连模式不再替用户"用 Unit 现建一个池"——池的规格、Unit 数、Zone 都由池本身决定，
   * 建租户只是把租户挂到既有池上（与 OCP 选资源池的模型一致）。
   */
  resourcePoolName: string
  rootPassword?: string
  whitelist?: string
}

export interface DirectTenantResult {
  ok: boolean
  message: string
  /** 已执行的语句，按顺序（便于界面上逐条展示 / 事后追溯） */
  steps: string[]
  /** 未按预期完成但不影响主流程的提示（如密码没设成功） */
  warning?: string
  /** 建租户成功后的连接串（按租户类型区分 oracle / mysql / obproxy） */
  connections?: { label: string; command: string }[]
}

/** 建租户的进度事件：主进程逐条推给渲染层，界面据此打执行日志 */
export interface DirectStepEvent {
  at: number
  /** 阶段标识 */
  phase: 'prepare' | 'tenant' | 'whitelist' | 'password' | 'done'
  status: 'start' | 'ok' | 'warn' | 'fail'
  title: string
  sql?: string
  message?: string
}

export type DirectStepListener = (e: DirectStepEvent) => void

/**
 * 建租户：只在**已选资源池**上创建租户 →（可选）白名单 →（可选）root 密码。
 *
 * 与 OCP 的差别：OCP 提交后进任务框架，进度由任务子系统推；直连没有任务，
 * 所以这里通过 onStep 把每一步实时回传，渲染层落成执行日志。
 * 任何一步失败都不会回滚，已执行的语句照旧带回。
 */
export async function createTenant(
  p: ObDirectPlatform,
  password: string,
  input: DirectCreateTenantInput,
  onStep?: DirectStepListener
): Promise<DirectTenantResult> {
  const steps: string[] = []
  const warnings: string[] = []
  const emit = (e: DirectStepEvent): void => {
    try {
      onStep?.(e)
    } catch {
      // 回调异常不能影响建租户主流程
    }
  }
  const now = (): number => Date.now()

  try {
    emit({ at: now(), phase: 'prepare', status: 'start', title: '校验连接与入参' })
    assertSysTenant(p)

    const nameErr = validateTenantName(input.name)
    if (nameErr) {
      emit({ at: now(), phase: 'prepare', status: 'fail', title: '校验连接与入参', message: nameErr })
      return { ok: false, message: nameErr, steps }
    }
    const name = String(input.name).trim()

    const exists = await q1<any>(
      p, password,
      'SELECT TENANT_ID FROM oceanbase.DBA_OB_TENANTS WHERE TENANT_NAME = ? LIMIT 1',
      [name]
    )
    if (exists) {
      const msg = `租户 ${name} 已存在`
      emit({ at: now(), phase: 'prepare', status: 'fail', title: '校验连接与入参', message: msg })
      return { ok: false, message: msg, steps }
    }

    // 资源池必须已存在且未绑定租户（绑定中的池不能复用）
    const poolName = String(input.resourcePoolName || '').trim()
    if (!poolName) {
      const msg = '请选择一个资源池'
      emit({ at: now(), phase: 'prepare', status: 'fail', title: '校验资源池', message: msg })
      return { ok: false, message: msg, steps }
    }
    const pools = await resourcePoolsOf(p, password)
    const pool = pools.find((x) => x.name === poolName)
    if (!pool) {
      const msg = `资源池 ${poolName} 不存在`
      emit({ at: now(), phase: 'prepare', status: 'fail', title: '校验资源池', message: msg })
      return { ok: false, message: msg, steps }
    }
    if (pool.tenantId > 0) {
      const msg = `资源池 ${poolName} 已绑定租户 ${pool.tenantName || pool.tenantId}，不能复用`
      emit({ at: now(), phase: 'prepare', status: 'fail', title: '校验资源池', message: msg })
      return { ok: false, message: msg, steps }
    }

    // Zone 与 Unit 数完全由资源池决定，不再接受界面传入
    const zones = parseZoneList(pool.zoneList)
    const unitCount = Math.max(1, pool.unitCount || 1)
    if (!zones.length) {
      const msg = `资源池 ${poolName} 的 Zone 列表为空，无法创建租户`
      emit({ at: now(), phase: 'prepare', status: 'fail', title: '校验资源池', message: msg })
      return { ok: false, message: msg, steps }
    }
    emit({
      at: now(),
      phase: 'prepare',
      status: 'ok',
      title: '校验连接与入参',
      message: `资源池 ${poolName}：规格 ${pool.unitConfigName || '—'}，每 Zone ${unitCount} 个 Unit，Zone ${zones.join(' / ')}`
    })

    // 1) 建租户
    const tenantSql = buildCreateTenantSql({
      name,
      unitConfigName: pool.unitConfigName,
      unitCount,
      zoneList: zones,
      primaryZone: input.primaryZone,
      mode: input.mode,
      charset: input.charset,
      collation: input.collation,
      comment: input.comment,
      poolName
    })
    emit({ at: now(), phase: 'tenant', status: 'start', title: '创建租户', sql: tenantSql })
    await execWrite(p, password, tenantSql)
    steps.push(tenantSql)
    emit({ at: now(), phase: 'tenant', status: 'ok', title: '创建租户' })

    // 2) 白名单（sys 代设，失败只提示不阻断）
    const whitelist = String(input.whitelist || '').trim()
    if (whitelist) {
      const wl = buildWhitelistSql(name, whitelist)
      emit({ at: now(), phase: 'whitelist', status: 'start', title: '设置连接白名单', sql: wl })
      try {
        await execWrite(p, password, wl)
        steps.push(wl)
        emit({ at: now(), phase: 'whitelist', status: 'ok', title: '设置连接白名单' })
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        warnings.push(`白名单未设置成功：${msg}`)
        emit({ at: now(), phase: 'whitelist', status: 'warn', title: '设置连接白名单', message: msg })
      }
    }

    // 3) root 密码：必须连到新租户执行，租户可能尚未就绪，失败只提示
    const rootPassword = String(input.rootPassword || '')
    if (rootPassword) {
      emit({
        at: now(),
        phase: 'password',
        status: 'start',
        title: '设置 root 密码',
        sql: `ALTER USER root IDENTIFIED BY '***'（在租户 ${name} 内执行）`
      })
      try {
        await execAsTenant(p, rootPassword, name, buildSetRootPasswordSql(rootPassword))
        steps.push(`ALTER USER root IDENTIFIED BY '***'（在租户 ${name} 内执行）`)
        emit({ at: now(), phase: 'password', status: 'ok', title: '设置 root 密码' })
      } catch (e: any) {
        const msg = `租户已创建，但 root 密码未能自动设置（${e?.message ?? e}）。` +
          `请用空密码登录 ${name} 后执行 ALTER USER root IDENTIFIED BY '<新密码>'。`
        warnings.push(msg)
        emit({ at: now(), phase: 'password', status: 'warn', title: '设置 root 密码', message: msg })
      }
    }

    // 4) 回读兼容模式：OB 默认建成 MySQL，且建成后不可修改。
    //    选 Oracle 却落成 MySQL 属于"建错"，不能静默成功，必须当场告知并给出清理语句。
    const actualMode = await compatibilityModeOf(p, password, name)
    if (actualMode && actualMode !== input.mode) {
      const wrong =
        `租户 ${name} 已创建，但兼容模式为 ${actualMode}，与请求的 ${input.mode} 不一致。` +
        'OceanBase 的兼容模式一旦创建不可修改，如需修正请删除后重建：' +
        `先锁定（ALTER TENANT ${name} LOCK），再删除（DROP TENANT ${name}）。`
      warnings.push(wrong)
      emit({ at: now(), phase: 'done', status: 'fail', title: '兼容模式核对', message: wrong })
      return { ok: false, message: wrong, steps, warning: wrong }
    }

    const ready = await tenantStatusOf(p, password, name)
    const message = ready ? `租户 ${name} 已创建（状态 ${ready}）` : `租户 ${name} 已创建`
    const connections = await connectionsOf(p, password, name, input.mode, rootPassword)
    emit({
      at: now(),
      phase: 'done',
      status: warnings.length ? 'warn' : 'ok',
      title: '完成',
      message: warnings.length ? warnings.join('；') : message
    })
    return { ok: true, message, steps, warning: warnings.length ? warnings.join('；') : undefined, connections }
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    emit({ at: now(), phase: 'done', status: 'fail', title: '执行中断', message: msg })
    return {
      ok: false,
      message: steps.length
        ? `${msg}（已执行 ${steps.length} 条语句，未回滚，请按需手工清理）`
        : msg,
      steps
    }
  }
}

/**
 * 生成连接串所需的现场信息：集群名（拼 # 后缀）与一台 OBServer 的 IP。
 * 都是尽力而为——取不到就降级，不影响租户创建结果。
 */
/**
 * 生成连接串（对外）：详情页的「连接」tab 用。
 * 密码不回填——建租户时的密码只存在于当次会话，这里用占位符如实标注。
 */
export async function tenantConnectionsOf(
  p: ObDirectPlatform,
  password: string,
  tenant: string,
  mode: 'MYSQL' | 'ORACLE'
): Promise<{ label: string; command: string }[]> {
  return connectionsOf(p, password, tenant, mode, '')
}

async function connectionsOf(
  p: ObDirectPlatform,
  password: string,
  tenant: string,
  mode: 'MYSQL' | 'ORACLE',
  rootPassword: string
): Promise<{ label: string; command: string }[]> {  let cluster = ''
  try {
    const row = await q1<any>(
      p, password,
      "SELECT VALUE FROM oceanbase.GV$OB_PARAMETERS WHERE NAME = 'cluster' LIMIT 1"
    )
    cluster = str(row?.VALUE)
  } catch { /* 取不到就不带 #集群名 */ }

  let observerIp = ''
  try {
    const row = await q1<any>(
      p, password,
      "SELECT SVR_IP FROM oceanbase.DBA_OB_SERVERS WHERE WITH_ROOTSERVER = 'YES' LIMIT 1"
    )
    observerIp = str(row?.SVR_IP)
  } catch { /* 回落到平台地址 */ }

  return buildConnectionStrings({ host: p.host, observerIp, cluster, tenant, mode, password: rootPassword })
}

async function tenantStatusOf(p: ObDirectPlatform, password: string, name: string): Promise<string> {  try {    const row = await q1<any>(
      p, password,
      'SELECT STATUS FROM oceanbase.DBA_OB_TENANTS WHERE TENANT_NAME = ? LIMIT 1',
      [name]
    )
    return str(row?.STATUS)
  } catch {
    return ''
  }
}

/**
 * 回读租户的兼容模式（DBA_OB_TENANTS.COMPATIBILITY_MODE）。
 * 视图不可用时返回空串，调用方据此跳过核对（不能让核对本身把建租户判失败）。
 */
async function compatibilityModeOf(p: ObDirectPlatform, password: string, name: string): Promise<string> {
  try {
    const row = await q1<any>(
      p, password,
      'SELECT COMPATIBILITY_MODE FROM oceanbase.DBA_OB_TENANTS WHERE TENANT_NAME = ? LIMIT 1',
      [name]
    )
    return str(row?.COMPATIBILITY_MODE).toUpperCase()
  } catch {
    return ''
  }
}

/** 删除租户。直连没有 OCP 的删除前检查，调用方必须二次确认 */
export async function dropTenant(
  p: ObDirectPlatform,
  password: string,
  tenantName: string
): Promise<DirectTenantResult> {
  try {
    assertSysTenant(p)
    const name = String(tenantName || '').trim()
    if (!name) return { ok: false, message: '租户名不能为空', steps: [] }
    if (name.toLowerCase() === 'sys') return { ok: false, message: '不能删除 sys 租户', steps: [] }

    // 删除前必须已锁定：这是刻意的双保险，防止误点直接把生产租户删掉
    const row = await q1<any>(
      p, password,
      'SELECT LOCKED FROM oceanbase.DBA_OB_TENANTS WHERE TENANT_NAME = ? LIMIT 1',
      [name]
    )
    if (!row) return { ok: false, message: `租户 ${name} 不存在`, steps: [] }
    if (str(row.LOCKED).toUpperCase() !== 'YES') {
      return {
        ok: false,
        message: `租户 ${name} 未锁定，不能直接删除。请先「锁定」该租户，确认业务已停止后再删除。`,
        steps: []
      }
    }

    const sql = buildDropTenantSql(name)
    await execWrite(p, password, sql)
    return { ok: true, message: `已删除租户 ${name}（资源池随后由系统回收）`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

/** 锁定 / 解锁租户（对应 OCP 租户页的「锁定」开关） */
export async function setTenantLocked(
  p: ObDirectPlatform,
  password: string,
  tenantName: string,
  locked: boolean
): Promise<DirectTenantResult> {
  try {
    assertSysTenant(p)
    const name = String(tenantName || '').trim()
    if (!name) return { ok: false, message: '租户名不能为空', steps: [] }
    const sql = buildLockTenantSql(name, locked)
    await execWrite(p, password, sql)
    return { ok: true, message: locked ? `已锁定租户 ${name}` : `已解锁租户 ${name}`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

// ---------- Unit 规格管理（按集群独立，创建租户时只能选用这里的现成规格） ----------

/** 新建 Unit 规格 */
export async function createUnitConfig(
  p: ObDirectPlatform,
  password: string,
  spec: CreateUnitSpec
): Promise<DirectTenantResult> {
  try {
    assertSysTenant(p)
    const used = new Set((await unitConfigsOf(p, password)).map((u) => u.name))
    if (used.has(String(spec.name || '').trim())) {
      return { ok: false, message: `Unit 规格 ${spec.name} 已存在`, steps: [] }
    }
    const unitRun = await execCreateUnit(p, password, spec)
    const msg = `Unit 规格 ${spec.name} 已创建` + (unitRun.warning ? `；${unitRun.warning}` : '')
    return { ok: true, message: msg, steps: [unitRun.sql], warning: unitRun.warning }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

/** 删除 Unit 规格：先做引用预检，把「谁在占着」说清楚，而不是抛 OB 的原始报错 */
export async function dropUnitConfig(
  p: ObDirectPlatform,
  password: string,
  name: string
): Promise<DirectTenantResult> {
  try {
    assertSysTenant(p)
    const n = assertIdent(name, 'Unit 规格名')
    if (/^sys_/i.test(n)) return { ok: false, message: '系统自带规格不可删除', steps: [] }

    const specs = await unitConfigsOf(p, password)
    const target = specs.find((u) => u.name === n)
    if (!target) return { ok: false, message: `Unit 规格 ${n} 不存在`, steps: [] }

    const pools = await resourcePoolsOf(p, password)
    const holders = pools.filter((x) => x.unitConfigId === target.id)
    if (holders.length) {
      const list = holders.map((x) => (x.tenantName ? `${x.name}（租户 ${x.tenantName}）` : `${x.name}（未绑定租户）`))
      return {
        ok: false,
        message:
          `该规格仍被 ${holders.length} 个资源池引用：${list.join('、')}。` +
          '请先到「资源池」页删除这些池（未绑定租户的池可直接删；仍绑着租户的要先删租户）。',
        steps: []
      }
    }

    const sql = `DROP RESOURCE UNIT ${n}`
    await execWrite(p, password, sql)
    return { ok: true, message: `Unit 规格 ${n} 已删除`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

export interface DirectCreatePoolInput {
  name: string
  unitConfigName: string
  unitCount: number
  zoneList: string[]
}

/**
 * 新建资源池。
 *
 * 池的生命周期独立于租户：建池只决定「规格 + 每 Zone Unit 数 + 承载 Zone」，
 * 建租户时再挑一个空闲池挂上去。这正是把两者拆开的意义——
 * 池可以先准备好，也可以给多个租户轮流复用。
 */
export async function createResourcePool(
  p: ObDirectPlatform,
  password: string,
  input: DirectCreatePoolInput
): Promise<DirectTenantResult> {
  try {
    assertSysTenant(p)
    const name = assertIdent(String(input?.name || '').trim(), '资源池名')
    const unit = assertIdent(String(input?.unitConfigName || '').trim(), 'Unit 规格名')
    const unitCount = Math.trunc(Number(input?.unitCount) || 0)
    if (unitCount <= 0) return { ok: false, message: '每个 Zone 的 Unit 数必须大于 0', steps: [] }
    const zones = (input?.zoneList || []).map((z) => String(z).trim()).filter(Boolean)
    if (!zones.length) return { ok: false, message: '至少选择一个 Zone', steps: [] }

    const specs = await unitConfigsOf(p, password)
    if (specs.length && !specs.some((u) => u.name === unit)) {
      return { ok: false, message: `Unit 规格 ${unit} 不存在`, steps: [] }
    }
    const pools = await resourcePoolsOf(p, password)
    if (pools.some((x) => x.name === name)) {
      return { ok: false, message: `资源池 ${name} 已存在`, steps: [] }
    }
    // Zone 必须真实存在，避免建出一个挂不上 OBServer 的池
    try {
      const known = await q<any>(p, password, 'SELECT ZONE FROM oceanbase.DBA_OB_ZONES')
      const set = new Set(known.map((r) => str(r.ZONE)))
      const missing = zones.filter((z) => set.size > 0 && !set.has(z))
      if (missing.length) return { ok: false, message: `集群中不存在这些 Zone：${missing.join(', ')}`, steps: [] }
    } catch { /* 视图取不到时跳过校验，交给 OB 报错 */ }

    const sql = buildCreateResourcePoolSql(name, unit, unitCount, zones)
    await execWrite(p, password, sql)
    return { ok: true, message: `资源池 ${name} 已创建`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}

/** 删除资源池：仍绑定租户的池不能删（OB 会拒绝，这里先拦一次并说明原因） */export async function dropResourcePool(
  p: ObDirectPlatform,
  password: string,
  poolName: string
): Promise<DirectTenantResult> {
  try {
    assertSysTenant(p)
    const n = assertIdent(poolName, '资源池名')

    const pools = await resourcePoolsOf(p, password)
    const pool = pools.find((x) => x.name === n)
    if (!pool) return { ok: false, message: `资源池 ${n} 不存在`, steps: [] }
    if (pool.tenantId > 0) {
      return {
        ok: false,
        message: `资源池 ${n} 仍绑定租户 ${pool.tenantName || pool.tenantId}，请先删除该租户再回收资源池。`,
        steps: []
      }
    }

    const sql = buildDropResourcePoolSql(n)
    await execWrite(p, password, sql)
    return { ok: true, message: `资源池 ${n} 已删除`, steps: [sql] }
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e), steps: [] }
  }
}
