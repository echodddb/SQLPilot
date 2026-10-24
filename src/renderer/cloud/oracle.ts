/**
 * Oracle 云平台模块状态（模块级 reactive store）。
 *
 * 布局对齐 OCP：左侧只放「整体」内容（多套环境），单个库/实例的深度内容
 * 全部收进「库详情」全屏抽屉（类似 OCP 的租户详情 13 个 tab）。
 *
 * 缓存分两层：
 *   - envs：环境列表的轻量概要（每套环境 7 条 SQL，列表页一次拉完）
 *   - data/meta：打开某套环境的详情后，按 `${envId}:${section}` 缓存各 tab
 */

import { reactive } from 'vue'
import { cloud } from './state'

export type OraPaneKey = CloudOraSectionKey
/** 左侧导航只有两页整体视图：环境列表 / 全局面板 */
export type OraView = 'env' | 'fleet'

export interface OraPaneMeta {
  loading: boolean
  ms: number
  at: string
  warnings: string[]
  error: string
}

/** 一套环境（= 一条 Oracle 平台配置）在列表页的呈现 */
export interface OraEnvItem {
  id: string
  name: string
  host: string
  port: number
  serviceName: string
  username: string
  role?: string
  loading: boolean
  /** 连接失败时的错误；成功为空 */
  error: string
  summary: CloudOraSections['env'] | null
  warnings: string[]
  at: string
}

/** 左侧导航：只放跨环境的整体内容 + 接入管理 */
export const ORA_NAV: { title: string; items: { key: OraView | 'settings'; label: string; icon: string; desc: string }[] }[] = [
  {
    title: 'Oracle',
    items: [
      { key: 'env', label: '环境列表', icon: '▤', desc: '已接入的所有 Oracle 环境：版本 / 角色 / 实例 / 会话 / 水位 / 阻塞，点卡片进入库详情' },
      { key: 'fleet', label: '全局面板', icon: '◎', desc: '跨环境汇总：可用性、待处理问题、表空间水位榜、会话与阻塞榜' }
    ]
  },
  {
    title: '管理',
    items: [{ key: 'settings', label: '接入管理', icon: '⚙', desc: '新增 / 编辑 / 删除 Oracle 环境（主机、账号、身份）' }]
  }
]

/** 库详情抽屉的 tab（单个库/实例的全部深度内容） */
export const ORA_DETAIL_TABS: { key: OraPaneKey; label: string; icon: string; desc: string; src: string }[] = [
  { key: 'overview', label: '总览', icon: '◎', desc: '库状态 / 拓扑 / 会话 / 表空间水位 / 待处理问题', src: 'orOverview' },
  { key: 'rac', label: 'RAC 集群', icon: '⛓', desc: '实例与节点、服务分布、私网互通、启动时间', src: 'orRac' },
  { key: 'instances', label: '实例', icon: '▦', desc: '实例明细：SGA/PGA、资源限制、OS、缓冲池命中', src: 'orInstances' },
  { key: 'pdb', label: '容器与 PDB', icon: '❐', desc: 'CDB/PDB 打开状态与数据文件占用', src: 'orPdb' },
  { key: 'storage', label: '存储', icon: '⛁', desc: '表空间 / 临时 / UNDO / 数据文件 / ASM / FRA / 归档 / 在线日志', src: 'orStorage' },
  { key: 'sessions', label: '会话与锁', icon: '⇄', desc: '会话明细、阻塞链、长操作进度', src: 'orSessions' },
  { key: 'sql', label: 'SQL 诊断', icon: '⌁', desc: 'TopSQL（耗时/CPU/逻辑读/物理读）+ AWR 历史 + 执行计划', src: 'orSql' },
  { key: 'perf', label: '性能与等待', icon: '∿', desc: 'sysmetric / 系统等待 / ASH / SGA / PGA / OS', src: 'orPerf' },
  { key: 'alerts', label: '告警日志', icon: '⚠', desc: '告警聚类（去数字模板）+ 按小时分布 + ORA 错误', src: 'orAlerts' },
  { key: 'backup', label: '备份恢复', icon: '⛃', desc: 'RMAN 作业与备份集、归档量、FRA 水位', src: 'orBackup' },
  { key: 'dg', label: 'Data Guard', icon: '⇋', desc: '应用延迟、归档目标、MRP 进程状态', src: 'orDg' },
  { key: 'jobs', label: '作业调度', icon: '⟳', desc: 'Scheduler / DBMS_JOB 与最近运行结果', src: 'orJobs' },
  { key: 'params', label: '参数', icon: '⚙', desc: '非默认参数与关键参数（含是否可动态修改）', src: 'orParams' },
  { key: 'users', label: '用户与对象', icon: '⚿', desc: '账号状态与过期、SYSDBA、失效对象、大对象 TOP', src: 'orUsers' }
]

type OraDataMap = { [K in OraPaneKey]?: CloudOraSections[K] }

export const ora = reactive({
  /** 环境列表（每套环境一项） */
  envs: [] as OraEnvItem[],
  envsLoading: false,
  envsAt: 0,
  /** 左侧整体视图 */
  view: 'env' as OraView,
  /** 库详情抽屉 */
  drawerOpen: false,
  drawerTab: 'overview' as OraPaneKey,
  /** 当前打开详情的那套环境（抽屉关闭后仍保留，切回时直接复现上次的 tab） */
  envId: '',
  /** 各 tab 数据，key = envId */
  data: {} as Record<string, OraDataMap>,
  meta: {} as Record<string, OraPaneMeta>,
  /** SQL 诊断的排序维度 */
  sqlBy: 'elapsed' as 'elapsed' | 'cpu' | 'gets' | 'disk',
  /** 告警日志窗口（小时） */
  alertHours: 24,
  /** SQL 详情（点开时单独拉） */
  sqlDetail: null as { sqlId: string; text: string; plan: any[] } | null,
  sqlDetailLoading: false
})

const dkey = (envId: string, section: string) => `${envId}:${section}`

export function envOf(id: string): OraEnvItem | undefined {
  return ora.envs.find((e) => e.id === id)
}

export function currentEnv(): OraEnvItem | undefined {
  return ora.envId ? envOf(ora.envId) : undefined
}

function metaOf(envId: string, section: string): OraPaneMeta {
  const k = dkey(envId, section)
  if (!ora.meta[k]) ora.meta[k] = { loading: false, ms: 0, at: '', warnings: [], error: '' }
  return ora.meta[k]
}

/** 左侧整体视图的元信息 */
export function viewMeta(): OraPaneMeta {
  return {
    loading: ora.envsLoading,
    ms: 0,
    at: ora.envsAt ? new Date(ora.envsAt).toISOString() : '',
    warnings: [],
    error: ''
  }
}

/** 库详情当前 tab 的元信息（取数耗时 / 降级提示 / 错误） */
export function drawerMeta(): OraPaneMeta {
  return metaOf(ora.envId, ora.drawerTab)
}

export function oraData<K extends OraPaneKey>(key: K): CloudOraSections[K] | null {
  const bag = ora.data[ora.envId]
  return (bag?.[key] as CloudOraSections[K]) ?? null
}

/** 拉所有环境的轻量概要（并行，但每套只有一个分区的 7 条 SQL） */
export async function loadEnvs(force = false): Promise<void> {
  const list = cloud.platforms.filter((p) => p.type === 'oracle')
  // 同步 envs 与平台清单：新增/删除平台后列表要跟着变
  const keep = new Map(ora.envs.map((e) => [e.id, e]))
  ora.envs = list.map((p) => {
    const old = keep.get(p.id)
    return {
      id: p.id,
      name: p.name,
      host: String(p.host || ''),
      port: Number(p.port) || 1521,
      serviceName: String(p.serviceName || ''),
      username: String(p.username || ''),
      role: p.role || 'default',
      loading: false,
      error: old?.error || '',
      summary: old?.summary || null,
      warnings: old?.warnings || [],
      at: old?.at || ''
    }
  })
  // 正在看的环境被删了 → 关掉抽屉，别停在空环境上
  if (ora.envId && !ora.envs.some((e) => e.id === ora.envId)) {
    ora.drawerOpen = false
    ora.envId = ''
  }
  if (!list.length) return
  // 已有数据且不强制刷新时直接复用（45 秒缓存由主进程再兜一层）
  const need = ora.envs.filter((e) => force || !e.summary || e.error)
  if (!need.length) return
  ora.envsLoading = true
  await Promise.all(
    need.map(async (e) => {
      e.loading = true
      try {
        const res = await window.sqlpilot.cloudOraSection(e.id, 'env', {}, force)
        if (res.ok && res.data) {
          e.summary = res.data
          e.error = ''
          e.warnings = res.warnings || []
          e.at = res.at || ''
        } else {
          e.error = res.error || '连接失败'
        }
      } catch (err: any) {
        e.error = String(err?.message || err)
      } finally {
        e.loading = false
      }
    })
  )
  ora.envsLoading = false
  ora.envsAt = Date.now()
}

/** 打开某套环境的库详情（默认停在总览；全局面板里点问题会直接跳到对应 tab） */
export async function openDrawer(id: string, tab: OraPaneKey = 'overview'): Promise<void> {
  const env = envOf(id)
  if (!env) return
  const same = ora.envId === id && ora.drawerOpen
  ora.envId = id
  ora.drawerOpen = true
  ora.drawerTab = tab
  if (!same) ora.sqlDetail = null
  await loadOra(tab)
}

export function closeDrawer(): void {
  ora.drawerOpen = false
  ora.sqlDetail = null
}

export function setDrawerTab(tab: OraPaneKey): void {
  if (ora.drawerTab === tab) return
  ora.drawerTab = tab
  void loadOra(tab)
}

/** 加载当前环境的某个 tab：force 绕过主进程 45 秒缓存 */
export async function loadOra<K extends OraPaneKey>(key: K, force = false, opts?: Record<string, unknown>): Promise<void> {
  if (!ora.envId) return
  const m = metaOf(ora.envId, key)
  if (m.loading) return
  m.loading = true
  m.error = ''
  try {
    const res = await window.sqlpilot.cloudOraSection(ora.envId, key, opts || {}, force)
    if (res.ok && res.data) {
      const bag = ora.data[ora.envId] || {}
      ;(bag as any)[key] = res.data
      ora.data[ora.envId] = bag
      m.warnings = res.warnings || []
      m.ms = res.ms || 0
      m.at = res.at || ''
    } else {
      m.error = res.error || '取数失败'
      m.warnings = res.warnings || []
    }
  } catch (e: any) {
    m.error = String(e?.message || e)
  } finally {
    m.loading = false
  }
}

/** 左侧视图或详情 tab 的刷新 */
export async function refreshOra(target: OraView | OraPaneKey = ora.view): Promise<void> {
  if (target === 'env' || target === 'fleet') {
    await loadEnvs(true)
    return
  }
  const opts = target === 'sql' ? { by: ora.sqlBy } : target === 'alerts' ? { hours: ora.alertHours } : undefined
  await loadOra(target as OraPaneKey, true, opts)
}

export async function loadSqlDetail(sqlId: string): Promise<void> {
  if (!ora.envId || !sqlId) return
  ora.sqlDetailLoading = true
  try {
    const r = await window.sqlpilot.cloudOraSqlDetail(ora.envId, sqlId)
    ora.sqlDetail = r.ok ? { sqlId, text: r.text || '', plan: r.plan || [] } : { sqlId, text: `读取失败：${r.error || ''}`, plan: [] }
  } catch (e: any) {
    ora.sqlDetail = { sqlId, text: `读取失败：${String(e?.message || e)}`, plan: [] }
  } finally {
    ora.sqlDetailLoading = false
  }
}
