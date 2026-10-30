/**
 * 直连模式可授权的权限 / 角色清单（界面勾选用）。
 *
 * 必须与主进程 `main/cloud/obdirect/tenantIn.ts` 的 MYSQL_PRIVILEGES / ORACLE_PRIVILEGES
 * 保持一致：主进程按白名单逐项校验，两边不一致会出现"界面能勾、执行被拒"。
 * 单测 test/unit-obdirect-tenant.mjs 里有一条断言比较两份清单。
 *
 * 之所以不直接 import 主进程常量：那两个模块依赖 mysql2，不能进渲染层 bundle。
 */

export const MYSQL_PRIVS = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'EXECUTE',
  'CREATE VIEW',
  'SHOW VIEW',
  'TRIGGER',
  'REFERENCES',
  'ALL PRIVILEGES'
] as const

export const ORACLE_PRIVS = [
  'CONNECT',
  'RESOURCE',
  'DBA',
  'CREATE SESSION',
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE PROCEDURE',
  'CREATE SEQUENCE',
  'SELECT ANY TABLE',
  'INSERT ANY TABLE',
  'UPDATE ANY TABLE',
  'DELETE ANY TABLE',
  'UNLIMITED TABLESPACE'
] as const

/** 按兼容模式取可选权限 */
export function privOptionsOf(mode: 'MYSQL' | 'ORACLE'): string[] {
  return mode === 'ORACLE' ? [...ORACLE_PRIVS] : [...MYSQL_PRIVS]
}

/** 打开授权面板时的默认勾选：MySQL 给最常用的读写，Oracle 给 CONNECT */
export function defaultPrivs(mode: 'MYSQL' | 'ORACLE'): string[] {
  return mode === 'ORACLE' ? ['CONNECT'] : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
}
