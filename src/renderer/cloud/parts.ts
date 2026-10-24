/** 云管平台的展示层格式化：只做"数据 → 文案/色标"，不掺业务判断（聚合在主进程） */

export function fmtBytes(n?: number): string {
  const v = Number(n) || 0
  if (v <= 0) return '0'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`
}

function parseTime(iso?: string): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // OCP 用 1970-01-01 表示"从未发生"（如未停止过）
  if (d.getFullYear() <= 1970) return null
  return d
}

export function fmtTime(iso?: string): string {
  const d = parseTime(iso)
  if (!d) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 列表用的紧凑时间：MM-DD HH:mm（跨年时补年份） */
export function fmtTimeShort(iso?: string): string {
  const d = parseTime(iso)
  if (!d) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}-`
  return `${y}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function relTime(iso?: string): string {
  const d = parseTime(iso)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return fmtTime(iso)
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const day = Math.floor(h / 24)
  if (day < 30) return `${day} 天前`
  return fmtTime(iso)
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info'

/** OCP 告警级别：1 严重 / 2 警告 / 3 注意 / 4-5 提示 */
export function alarmLevel(level: number): { label: string; tone: Tone } {
  if (level === 1) return { label: '严重', tone: 'bad' }
  if (level === 2) return { label: '警告', tone: 'warn' }
  if (level === 3) return { label: '注意', tone: 'info' }
  return { label: '提示', tone: 'idle' }
}

export function clusterStatus(s: string): { label: string; tone: Tone } {
  if (s === 'RUNNING') return { label: '运行中', tone: 'ok' }
  if (s === 'STOPPED') return { label: '已停止', tone: 'idle' }
  if (s === 'OPERATING') return { label: '运维中', tone: 'info' }
  if (s === 'UPDATING') return { label: '升级中', tone: 'info' }
  if (s === 'FAILED') return { label: '异常', tone: 'bad' }
  return { label: s || '未知', tone: 'idle' }
}

export function hostStatus(s: string): { label: string; tone: Tone } {
  if (s === 'ONLINE') return { label: '在线', tone: 'ok' }
  if (s === 'OFFLINE') return { label: '离线', tone: 'bad' }
  if (s === 'AGENT_RESTARTING') return { label: 'Agent 重启中', tone: 'warn' }
  if (s === 'AGENT_OFFLINE') return { label: 'Agent 离线', tone: 'bad' }
  return { label: s || '未知', tone: 'idle' }
}

export function agentStatus(s: string): { label: string; tone: Tone } {
  if (s === 'AVAILABLE') return { label: '可用', tone: 'ok' }
  if (s === 'RESTARTING') return { label: '重启中', tone: 'warn' }
  if (s === 'UNAVAILABLE' || s === 'OFFLINE') return { label: '不可用', tone: 'bad' }
  if (!s) return { label: '—', tone: 'idle' }
  return { label: s, tone: 'warn' }
}

/** 告警对象范围：Service / Host / OBCluster / OBTenant … */
export function alarmScope(s: string): string {
  const m: Record<string, string> = {
    Service: '服务',
    Host: '主机',
    Cluster: '集群',
    OBCluster: 'OB 集群',
    Tenant: '租户',
    OBTenant: '租户',
    OBProxy: 'OBProxy',
    OBProxyCluster: 'OBProxy 集群',
    OCP: 'OCP 自身',
    OceanBaseLog: '数据库日志',
    OceanBase: 'OceanBase'
  }
  return m[s] || s || '—'
}

/** 值本身就是 ISO 时间时按本地时间展示（OCP 的属性表里混着时间与普通值） */
export function maybeTime(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? fmtTime(v) : v
}

export function tenantStatus(s: string): { label: string; tone: Tone } {
  if (s === 'NORMAL') return { label: '正常', tone: 'ok' }
  if (s === 'OPERATING') return { label: '运维中', tone: 'info' }
  if (s === 'CREATING') return { label: '创建中', tone: 'info' }
  if (s === 'RESTORING') return { label: '恢复中', tone: 'info' }
  return { label: s || '未知', tone: 'idle' }
}

export function taskStatus(s: string): { label: string; tone: Tone } {
  if (s === 'SUCCESSFUL') return { label: '已完成', tone: 'ok' }
  if (s === 'FAILED') return { label: '失败', tone: 'bad' }
  if (s === 'RUNNING') return { label: '执行中', tone: 'info' }
  if (s === 'PENDING') return { label: '等待中', tone: 'idle' }
  if (s === 'CANCELED' || s === 'CANCELLED') return { label: '已取消', tone: 'idle' }
  return { label: s || '未知', tone: 'idle' }
}

export function clusterMode(m: string): string {
  if (m === 'DISTRIBUTED_SHARED_NOTHING') return '分布式'
  if (m === 'SHARED_STORAGE') return '共享存储'
  return m || '—'
}

export function originLabel(o: string): string {
  if (o === 'CREATED') return 'OCP 创建'
  if (o === 'TAKEN_OVER') return '接管'
  return o || '—'
}

export function hostKind(k: string): string {
  if (k === 'DEDICATED_PHYSICAL_MACHINE') return '物理机'
  if (k === 'DEDICATED_VM') return '虚拟机'
  if (k === 'DOCKER') return '容器'
  return k || '—'
}

export function serviceLabel(t: string): string {
  if (t === 'OB_CLUSTER') return 'OBServer'
  if (t === 'OB_PROXY') return 'OBProxy'
  if (t === 'OB_CONFIG_SERVER') return 'ConfigServer'
  if (t === 'OCP_AGENT') return 'OCP Agent'
  return t
}

/** 容量水位色标：70% 以下正常，90% 以上告警 */
export function capacityTone(pct: number): Tone {
  if (pct >= 90) return 'bad'
  if (pct >= 70) return 'warn'
  return 'ok'
}

export function duration(start?: string, end?: string): string {
  const a = parseTime(start)
  const b = parseTime(end)
  if (!a) return '—'
  const ms = (b ? b.getTime() : Date.now()) - a.getTime()
  if (ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}
