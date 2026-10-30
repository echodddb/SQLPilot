/**
 * 租户分类与版本号归一化（纯函数，无 IO）。
 *
 * 单独成文件的原因：collect.ts 依赖 conn.ts（mysql2），Node 单测无法直接 import
 * （ESM 解析不了无扩展名的相对导入，也不该为跑一条断言起数据库驱动）。
 * 这里只放不碰连接、不碰 electron 的判断逻辑，单测可直接引用。
 */

/**
 * SELECT VERSION() 返回的是 5.7.25-OceanBase-v4.3.5.2 这种「MySQL 兼容前缀 + OB 版本」串。
 * 界面只需要 OB 自己的版本号：原样展示既长又容易被误读成 MySQL 5.7。
 */
export function obVersionOf(raw: string): string {
  const v = String(raw || '').trim()
  // OceanBase 后面可能跟 -v / _CE-v / _BP1-v 等后缀，统一跳过非数字部分再取版本号
  const m = /OceanBase[^\d]*(\d[\d.]*)/i.exec(v)
  return m ? m[1].replace(/\.$/, '') : v
}

/**
 * meta 租户：OB 为每个用户租户自动维护的内部租户，命名固定为 META$<租户ID>，
 * 4.x 的 TENANT_TYPE 也会直接给 META。日常运维不需要看到，界面上默认隐藏。
 */
export function isMetaTenant(name: string, type?: string): boolean {
  return String(type || '').toUpperCase() === 'META' || /^META\$/i.test(String(name || ''))
}

/** sys 系统租户：能看但不可删、不可当业务租户管理 */
export function isSysTenant(name: string, type?: string): boolean {
  return String(type || '').toUpperCase() === 'SYS' || /^sys$/i.test(String(name || ''))
}

/** DBA_OB_TENANTS 的原始行 → 是否业务租户（排除 sys 与 meta） */
export function isUserTenant(t: any): boolean {
  const name = String(t?.TENANT_NAME ?? t?.name ?? '')
  const type = String(t?.TENANT_TYPE ?? '')
  return !isMetaTenant(name, type) && !isSysTenant(name, type)
}
