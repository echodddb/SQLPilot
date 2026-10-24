/**
 * 平台接入相关的来源说明（不查数据库，说明配置与凭据落在哪）。
 */
import { type SourceInfo } from './types'

export const PF_SOURCES: Record<string, SourceInfo> = {
  cfgOcp: {
    title: 'OCP 接入配置',
    api: '本地配置 AppConfig.cloudPlatforms + Windows DPAPI 加密口令',
    scope: 'OCP 地址、账号、平台名称；口令不落明文',
    note: '地址/账号存在 SQLPilot 配置文件里，口令用 DPAPI 按「cloud:<平台 id>」单独加密存盘。连接时先 GET /api/v2/sensitiveDataKey 取公钥，再用 RSA（PKCS#1 v1.5）加密口令 POST /api/v2/iam/login，拿到 SESSION Cookie；写操作另需 X-XSRF-TOKEN 头'
  }
}
