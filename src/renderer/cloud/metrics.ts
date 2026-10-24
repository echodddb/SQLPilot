/**
 * 资源监控的指标集（逆向自 OCP 的 /api/v2/monitor/metricGroups，只挑常用项）。
 * OCP 的指标 key 已在 4.4.1 上逐个验证可取到数据。
 */

export interface MetricDef {
  key: string
  label: string
  unit: string
}

export const METRIC_SETS: Record<'CLUSTER' | 'TENANT' | 'HOST', MetricDef[]> = {
  CLUSTER: [
    { key: 'sql_all_count', label: 'QPS', unit: '次/秒' },
    { key: 'tps', label: 'TPS', unit: '次/秒' },
    { key: 'active_session', label: '活跃会话', unit: '个' },
    { key: 'cpu_percent', label: 'CPU 使用率', unit: '%' },
    { key: 'memory_percent', label: '内存使用率', unit: '%' },
    { key: 'memstore_percent', label: 'MemStore 使用率', unit: '%' },
    { key: 'sql_all_rt', label: 'SQL 平均耗时', unit: 'μs' },
    { key: 'ob_tenant_thread_percent', label: '租户线程使用率', unit: '%' }
  ],
  TENANT: [
    { key: 'sql_all_count', label: 'QPS', unit: '次/秒' },
    { key: 'tps', label: 'TPS', unit: '次/秒' },
    { key: 'active_session', label: '活跃会话', unit: '个' },
    { key: 'memstore_percent', label: 'MemStore 使用率', unit: '%' },
    { key: 'sql_all_rt', label: 'SQL 平均耗时', unit: 'μs' },
    { key: 'block_cache_hit_ratio', label: '缓存命中率', unit: '%' }
  ],
  HOST: [
    { key: 'cpu_percent', label: 'CPU 使用率', unit: '%' },
    { key: 'memory_percent', label: '内存使用率', unit: '%' },
    { key: 'load1', label: '负载 load1', unit: '' },
    { key: 'io_read', label: '磁盘读 IOPS', unit: '次/秒' },
    { key: 'io_write', label: '磁盘写 IOPS', unit: '次/秒' }
  ]
}

export const RANGES = [
  { key: '30m', label: '30 分钟', seconds: 1800 },
  { key: '1h', label: '1 小时', seconds: 3600 },
  { key: '6h', label: '6 小时', seconds: 21600 },
  { key: '24h', label: '24 小时', seconds: 86400 }
] as const

export type MonitorScope = keyof typeof METRIC_SETS

/** 图表上的数值格式：按量级自动收（μs → ms、大数加千分位） */
export function fmtMetric(v: number | null, unit: string): string {
  if (v === null || !Number.isFinite(v)) return '—'
  if (unit === 'μs') {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + ' s'
    if (v >= 1000) return (v / 1000).toFixed(2) + ' ms'
    return Math.round(v) + ' μs'
  }
  const abs = Math.abs(v)
  const txt = abs >= 1000 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2)
  return unit === '%' ? `${txt}%` : unit ? `${txt} ${unit}` : txt
}
