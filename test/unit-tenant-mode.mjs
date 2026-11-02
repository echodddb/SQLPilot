// 租户模式能力表单测：tenantMode.ts 是「Oracle 与 MySQL 界面差异」的唯一来源，
// 组件里所有 if(mode) 都应该改问它，所以把能力表与 tab 清单的来源锁死。
// 数据依据：OCP 4.3 实测（/roles 对 MySQL 400、/databases 对 Oracle 400、管理用户 SYS/root）。
import assert from 'node:assert/strict'
import { tenantModeOf, tenantCaps, tabsFor, TENANT_TABS } from '../src/renderer/cloud/tenantMode.ts'
import {
  MYSQL_GLOBAL_PRIVILEGES,
  MYSQL_DB_PRIVILEGES,
  ORACLE_SYSTEM_PRIVILEGES,
  ORACLE_OBJECT_TYPES,
  ORACLE_BUILTIN_ROLES
} from '../src/renderer/cloud/tenantPrivileges.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => { assert.ok(cond, why); passed++ }

// ---------- 模式归一 ----------
eq(tenantModeOf('ORACLE'), 'ORACLE', 'ORACLE 原样')
eq(tenantModeOf('oracle'), 'ORACLE', '小写也认')
eq(tenantModeOf(' Oracle '), 'ORACLE', '前后空格要去掉')
eq(tenantModeOf('MYSQL'), 'MYSQL', 'MYSQL 原样')
eq(tenantModeOf(''), 'MYSQL', '空值兜底 MySQL（老数据没有 mode）')
eq(tenantModeOf(undefined), 'MYSQL', 'undefined 兜底 MySQL')

// ---------- 能力表 ----------
const my = tenantCaps('MYSQL')
const ora = tenantCaps('ORACLE')
eq(my.adminUser, 'root', 'MySQL 管理用户是 root')
eq(ora.adminUser, 'SYS', 'Oracle 管理用户是 SYS')
eq(my.dbWord, '数据库', 'MySQL 叫数据库')
eq(ora.dbWord, 'Schema', 'Oracle 叫 Schema')
eq([my.dbManagement, ora.dbManagement], [true, false], 'Oracle 不支持库表管理')
eq([my.roles, ora.roles], [false, true], '只有 Oracle 有角色')
eq([my.dbPrivileges, ora.dbPrivileges], [true, false], '只有 MySQL 有库级权限')
eq([my.objectPrivileges, ora.objectPrivileges], [false, true], '只有 Oracle 有对象权限')

// ---------- 锁定规则（SYS 不可锁，大小写/空格不敏感） ----------
eq(ora.canLock('SYS'), false, 'Oracle 的 SYS 不可锁定')
eq(ora.canLock('sys'), false, '小写 sys 也不可锁定')
eq(ora.canLock(' SYS '), false, '带空格同样识别')
eq(ora.canLock('APP_USER'), true, '普通 Oracle 用户可锁定')
eq(my.canLock('root'), true, 'MySQL 的 root 可锁定（OCP 未禁止）')
eq(my.canLock(''), true, '空用户名不阻断渲染')

// ---------- 标识符规整 ----------
eq(ora.normUser('app_user'), 'APP_USER', 'Oracle 用户名统一大写（接口大写敏感）')
eq(ora.normUser('  App_User '), 'APP_USER', 'Oracle 规整要 trim')
eq(my.normUser(' App_User '), 'App_User', 'MySQL 只 trim 不改大小写')
eq(ora.normUser(''), '', '空串不炸')

// ---------- tab 清单 ----------
const myTabs = tabsFor('MYSQL').map((t) => t.key)
const oraTabs = tabsFor('ORACLE').map((t) => t.key)
ok(myTabs.includes('database'), 'MySQL 有库表 tab')
ok(oraTabs.includes('database'), 'Oracle 保留库表 tab（渲染空态，与官方一致）')
ok(oraTabs.includes('users') && myTabs.includes('users'), '两种模式都有用户 tab')
ok(oraTabs.includes('rsrc') && oraTabs.includes('monitor') && oraTabs.includes('usage'), '补齐 资源/监控/资源管理 三个 tab')
eq(new Set(myTabs).size, myTabs.length, 'tab key 不重复')
eq(new Set(oraTabs).size, oraTabs.length, 'Oracle tab key 不重复')
eq(myTabs[0], 'overview', '首 tab 是概览（与官方一致）')
ok(myTabs.indexOf('monitor') < myTabs.indexOf('backup'), '监控在备份之前（官方顺序）')
ok(myTabs.indexOf('backup') < myTabs.indexOf('users'), '备份在用户之前（官方顺序）')
ok(myTabs.indexOf('users') < myTabs.indexOf('rsrc'), '用户在资源管理之前（官方顺序）')
eq(TENANT_TABS.length, myTabs.length, '两种模式都不裁剪 tab（目前没有只属于一种模式的能力）')

// ---------- 权限词表 ----------
eq(ORACLE_SYSTEM_PRIVILEGES.length, 77, 'Oracle 系统权限 77 项（官方常量表原样）')
ok(ORACLE_SYSTEM_PRIVILEGES.includes('CREATE_SESSION'), '必须含 CREATE_SESSION')
ok(!ORACLE_SYSTEM_PRIVILEGES.includes('SELECT'), 'Oracle 系统权限不含 MySQL 的 SELECT（传了会 500）')
ok(MYSQL_GLOBAL_PRIVILEGES.some((p) => p.value === 'GRANT_OPTION'), 'MySQL 全局权限含 GRANT_OPTION')
eq(MYSQL_DB_PRIVILEGES.length, 10, 'MySQL 库级权限 10 项')
eq(ORACLE_OBJECT_TYPES.map((t) => t.value), ['TABLE', 'VIEW', 'STORED_PROCEDURE'], 'Oracle 对象类型三种')
eq(ORACLE_BUILTIN_ROLES, ['CONNECT', 'RESOURCE', 'DBA', 'SYS', 'PUBLIC'], 'Oracle 内置角色清单')

console.log(`tenant-mode 单测：${passed} 组断言全部通过`)
