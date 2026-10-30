/**
 * 云管主机的 SSH 凭据（渲染层公共逻辑）。
 *
 * 凭据复用「服务器」存储：id 固定 cloudssh:<平台id>:<ip>，于是 host key 校验、
 * DPAPI 口令、终端编码全部沿用既有 SSH 栈，不需要另写一套连接逻辑。
 * 主机列表、主机详情、分窗终端三处都走这里，保证"在一处录入，处处可用"。
 */
import { cloud } from './state'

export interface HostSshStatus {
  serverId: string
  user: string
  port: number
  auth: 'password' | 'key'
  keyPath: string
  hasPassword: boolean
}

export interface HostSshForm {
  user: string
  port: number
  auth: 'password' | 'key'
  password?: string
  keyPath?: string
  keyPassphrase?: string
}

export const hostSshId = (platformId: string, ip: string): string => `cloudssh:${platformId}:${ip}`

/** 某平台下已录入的主机凭据（ip → 账号信息，不含口令） */
export async function loadHostSshMap(platformId: string): Promise<Record<string, HostSshStatus>> {
  if (!platformId) return {}
  const r = await window.sqlpilot.cloudHostSshStatus(platformId)
  return r.ok && r.data ? r.data : {}
}

/**
 * 保存前先试连：连不上不落盘。
 * 这一步很重要——否则界面显示"已录入"，实际每次开终端都失败。
 */
export async function saveHostSsh(
  platformId: string,
  ip: string,
  clusterName: string,
  form: HostSshForm
): Promise<{ ok: boolean; error?: string }> {
  const server = {
    id: hostSshId(platformId, ip),
    // 名称要全局唯一（服务器模块按名称寻址），带上集群名避免多集群同 IP 冲突
    name: `${clusterName || '云管主机'} · ${ip}`,
    host: ip,
    port: Number(form.port) || 22,
    user: String(form.user || '').trim(),
    auth: form.auth,
    keyPath: form.auth === 'key' ? form.keyPath : undefined,
    group: '云管主机',
    tag: '云管'
  }
  if (!server.user) return { ok: false, error: '请填写用户名' }
  if (server.auth === 'key' && !server.keyPath) return { ok: false, error: '请选择私钥文件' }

  const test = await window.sqlpilot.testServer(server, form.password || undefined, form.keyPassphrase || undefined)
  if (!test.ok) return { ok: false, error: test.error || '连接失败' }
  const saved = await window.sqlpilot.saveServer(server, form.password || undefined, form.keyPassphrase || undefined)
  return saved.ok ? { ok: true } : { ok: false, error: saved.error || '保存失败' }
}

export async function forgetHostSsh(platformId: string, ip: string): Promise<void> {
  await window.sqlpilot.cloudHostSshForget(platformId, ip)
}

/**
 * 打开（或切到）某台主机的 SSH 会话。
 *
 * 同一 IP 只保留一个会话：重复打开只是把它切到前台并展开分窗，
 * 不会新起一条 shell（否则同一个 IP 会堆出多个终端，任务栏也没法看）。
 */
export function openHostSsh(platformId: string, ip: string, clusterName: string, port = 22): void {
  const id = hostSshId(platformId, ip)
  const hit = cloud.hostSshSessions.find((s) => s.id === id)
  if (!hit) {
    cloud.hostSshSessions = [...cloud.hostSshSessions, { id, platformId, ip, clusterName, port }]
  }
  cloud.hostSshActive = id
  cloud.hostSshMin = false
}

/** 关闭某个会话（组件随列表移除而卸载，主进程里的 shell 也会被关掉） */
export function closeHostSsh(id: string): void {
  const rest = cloud.hostSshSessions.filter((s) => s.id !== id)
  cloud.hostSshSessions = rest
  if (cloud.hostSshActive === id) cloud.hostSshActive = rest[rest.length - 1]?.id || ''
  if (!rest.length) cloud.hostSshMin = false
}

/** 切到某个会话并展开 */
export function selectHostSsh(id: string): void {
  cloud.hostSshActive = id
  cloud.hostSshMin = false
}
