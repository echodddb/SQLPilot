import type { ConnProfile } from '../types'

export function profileObTenant(profile: ConnProfile): string {
  return profile.obTenant?.trim() || profile.user.split('@')[1]?.split('#')[0] || ''
}

export function profileObCluster(profile: ConnProfile): string {
  return profile.obCluster?.trim() || profile.user.split('#')[1] || ''
}

export function normalizeConnectionProfile(profile: ConnProfile): ConnProfile {
  const normalized: ConnProfile = { ...profile }
  const isOb = profile.type === 'ob-mysql' || profile.type === 'ob-oracle'
  const supportsSsl = profile.type === 'mysql' || profile.type === 'ob-mysql' || profile.type === 'ob-oracle'

  if (!isOb) {
    delete normalized.obConnectMode
    delete normalized.obTenant
    delete normalized.obCluster
  }
  if (!supportsSsl) {
    delete normalized.ssl
    delete normalized.sslCa
    delete normalized.sslVerifyServer
  }
  if (profile.type !== 'ob-mysql') delete normalized.database
  if (profile.type !== 'oracle') delete normalized.serviceName
  return normalized
}

export function validateConnectionProfile(profile: ConnProfile, forSave: boolean): string {
  if (forSave && !profile.name?.trim()) return '连接名称为必填'
  if (!profile.host?.trim() || !profile.user?.trim()) return '主机和用户名为必填'
  if (profile.type === 'oracle' && !profile.serviceName?.trim()) return 'Oracle 需要填写服务名'

  if (profile.type === 'ob-mysql' || profile.type === 'ob-oracle') {
    const explicitTenant = profile.obTenant?.trim() || ''
    const explicitCluster = profile.obCluster?.trim() || ''
    const fullIdentity = /[@#]/.test(profile.user)
    if (!profileObTenant(profile)) return 'OceanBase 连接需要填写租户'
    if (fullIdentity && (explicitTenant || explicitCluster)) return 'OceanBase 用户已包含租户/集群时，不要重复填写租户/集群字段'
    if (/[ @#]/.test(explicitTenant) || /[ @#]/.test(explicitCluster)) return 'OceanBase 租户和集群不能包含空格、@ 或 #'
    if (profile.obConnectMode === 'obproxy' && !profileObCluster(profile)) return '经 OBProxy 连接需要填写集群名'
    if (profile.type === 'ob-mysql' && !profile.database?.trim()) return 'OceanBase MySQL 租户需要显式指定业务数据库'
  }

  if ((profile.type === 'mysql' || profile.type === 'ob-mysql' || profile.type === 'ob-oracle') && profile.ssl && profile.sslVerifyServer && !profile.sslCa?.trim()) {
    return '校验服务器证书需要填写 SSL CA 证书路径'
  }
  return ''
}
