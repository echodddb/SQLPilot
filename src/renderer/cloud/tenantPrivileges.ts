/**
 * 租户用户 / 角色的权限词表（唯一来源）。
 *
 * 数据来自 OCP 4.3 前端分包 `p__Tenant__Detail.js` 里的常量表（不是凭记忆写的）：
 *   · MySQL 全局权限 + 库级权限：`getGlobalPrivileges` / `getDbPrivileges` 的 value 集合
 *   · Oracle 系统权限：81 项（CREATE_SESSION … SYSBACKUP）
 *   · Oracle 内置角色：CONNECT / RESOURCE / DBA / SYS / PUBLIC
 *   · Oracle 可授权对象类型：TABLE / VIEW / STORED_PROCEDURE
 *
 * 注意：Oracle 的权限名是下划线风格（`CREATE_SESSION`），传 MySQL 的 `SELECT` 到 Oracle 租户
 * 会 500「unrecognized system privilege」，所以两套词表不能混用。
 */

export interface PrivOption {
  value: string
  label: string
}

/** MySQL 全局权限（对应 OCP「新建用户」里的系统权限多选） */
export const MYSQL_GLOBAL_PRIVILEGES: PrivOption[] = [
  { value: 'SELECT', label: 'SELECT（查询）' },
  { value: 'INSERT', label: 'INSERT（插入）' },
  { value: 'UPDATE', label: 'UPDATE（更新）' },
  { value: 'DELETE', label: 'DELETE（删除）' },
  { value: 'CREATE', label: 'CREATE（建库建表）' },
  { value: 'DROP', label: 'DROP（删除对象）' },
  { value: 'ALTER', label: 'ALTER（改结构）' },
  { value: 'INDEX', label: 'INDEX（建索引）' },
  { value: 'CREATE_VIEW', label: 'CREATE VIEW（建视图）' },
  { value: 'SHOW_VIEW', label: 'SHOW VIEW（看视图定义）' },
  { value: 'CREATE_USER', label: 'CREATE USER（建用户）' },
  { value: 'PROCESS', label: 'PROCESS（看全部会话）' },
  { value: 'SUPER', label: 'SUPER（管理权限）' },
  { value: 'SHOW_DATABASES', label: 'SHOW DATABASES（看全部库）' },
  { value: 'GRANT_OPTION', label: 'GRANT OPTION（可转授权）' },
  { value: 'CREATE_ROUTINE', label: 'CREATE ROUTINE（建存储过程）' },
  { value: 'EXECUTE', label: 'EXECUTE（执行存储过程）' },
  { value: 'ALTER_ROUTINE', label: 'ALTER ROUTINE（改存储过程）' }
]

/** MySQL 库级权限（新建用户时的库授权） */
export const MYSQL_DB_PRIVILEGES: string[] = [
  'ALTER', 'CREATE', 'DELETE', 'DROP', 'INSERT', 'SELECT', 'UPDATE', 'INDEX', 'CREATE_VIEW', 'SHOW_VIEW'
]

/** MySQL 系统库（OCP 授权界面里置灰 / 不可选的库） */
export const MYSQL_RESERVED_SCHEMAS = ['oceanbase', 'mysql', 'sys', 'LBACSYS', 'ORAAUDITOR']

/** Oracle 系统权限（81 项，顺序与官方一致） */
export const ORACLE_SYSTEM_PRIVILEGES: string[] = [
  'CREATE_SESSION', 'CREATE_TABLE', 'CREATE_ANY_TABLE', 'ALTER_ANY_TABLE', 'BACKUP_ANY_TABLE',
  'DROP_ANY_TABLE', 'LOCK_ANY_TABLE', 'COMMENT_ANY_TABLE', 'SELECT_ANY_TABLE', 'INSERT_ANY_TABLE',
  'UPDATE_ANY_TABLE', 'DELETE_ANY_TABLE', 'FLASHBACK_ANY_TABLE', 'CREATE_ROLE', 'DROP_ANY_ROLE',
  'GRANT_ANY_ROLE', 'ALTER_ANY_ROLE', 'AUDIT_ANY', 'GRANT_ANY_PRIVILEGE', 'GRANT_ANY_OBJECT_PRIVILEGE',
  'CREATE_ANY_INDEX', 'ALTER_ANY_INDEX', 'DROP_ANY_INDEX', 'CREATE_ANY_VIEW', 'DROP_ANY_VIEW',
  'CREATE_VIEW', 'SELECT_ANY_DICTIONARY', 'CREATE_PROCEDURE', 'CREATE_ANY_PROCEDURE', 'ALTER_ANY_PROCEDURE',
  'DROP_ANY_PROCEDURE', 'EXECUTE_ANY_PROCEDURE', 'CREATE_SYNONYM', 'CREATE_ANY_SYNONYM', 'DROP_ANY_SYNONYM',
  'CREATE_PUBLIC_SYNONYM', 'DROP_PUBLIC_SYNONYM', 'CREATE_SEQUENCE', 'CREATE_ANY_SEQUENCE', 'ALTER_ANY_SEQUENCE',
  'DROP_ANY_SEQUENCE', 'SELECT_ANY_SEQUENCE', 'CREATE_TRIGGER', 'CREATE_ANY_TRIGGER', 'ALTER_ANY_TRIGGER',
  'DROP_ANY_TRIGGER', 'CREATE_PROFILE', 'ALTER_PROFILE', 'DROP_PROFILE', 'CREATE_USER', 'ALTER_USER',
  'DROP_USER', 'CREATE_TYPE', 'CREATE_ANY_TYPE', 'ALTER_ANY_TYPE', 'DROP_ANY_TYPE', 'EXECUTE_ANY_TYPE',
  'UNDER_ANY_TYPE', 'PURGE_DBA_RECYCLEBIN', 'CREATE_ANY_OUTLINE', 'ALTER_ANY_OUTLINE', 'DROP_ANY_OUTLINE',
  'SYSKM', 'CREATE_TABLESPACE', 'ALTER_TABLESPACE', 'DROP_TABLESPACE', 'SHOW_PROCESS', 'ALTER_SYSTEM',
  'CREATE_DATABASE_LINK', 'CREATE_PUBLIC_DATABASE_LINK', 'DROP_DATABASE_LINK', 'ALTER_SESSION',
  'ALTER_DATABASE', 'EXEMPT_REDACTION_POLICY', 'SYSDBA', 'SYSOPER', 'SYSBACKUP'
]

/** Oracle 内置角色（新建角色时可直接勾选的常用项；不是全部，只是官方 UI 的高亮项） */
export const ORACLE_BUILTIN_ROLES = ['CONNECT', 'RESOURCE', 'DBA', 'SYS', 'PUBLIC']

/** Oracle 可授权的对象类型 */
export const ORACLE_OBJECT_TYPES: PrivOption[] = [
  { value: 'TABLE', label: '表' },
  { value: 'VIEW', label: '视图' },
  { value: 'STORED_PROCEDURE', label: '存储过程' }
]

/** 该模式下的权限展示名（Oracle 用下划线原名，MySQL 也原名，仅用于列表统一取值） */
export function privilegeLabel(v: string): string {
  const hit = MYSQL_GLOBAL_PRIVILEGES.find((p) => p.value === v)
  return hit ? hit.label : v
}
