import { reactive } from 'vue'
import type { SshServer as SshServerCfg } from '../../main/types'
import { store } from '../store'
import { applyProgress, type ProgressEvent, type TransferItem } from './transfer'

/**
 * 服务器模块状态。
 *
 * 只有「跨组件要共享的」才放这里：标签页、当前会话、每台机器的目录记忆、传输队列。
 * xterm 实例、SFTP 列表这类纯组件内部状态不放全局——xterm 对象进 reactive 会被 Proxy
 * 包一层，内部大量 this 判定失效（终端白屏的老坑）。
 */

export interface TermTabState {
  /** termId，同时是主进程 shell 的键 */
  id: string
  serverId: string
  /** 标签标题（同名服务器可开多个） */
  title: string
  status: 'connecting' | 'open' | 'closed' | 'error'
  error?: string
  /** 标签级字号覆盖（Ctrl+滚轮），不改全局偏好 */
  fontSize?: number
}

export type { TransferItem } from './transfer'
export { transferPercent, runningCount } from './transfer'

export interface PathMemory {
  remote: string
  local: string
}

export const srv = reactive({
  /** 模块是否已挂载（首次进入后保活，避免来回切模块丢终端） */
  mounted: false,
  /** 已打开的终端标签 */
  tabs: [] as TermTabState[],
  activeId: '',
  /** 会话列表过滤词 */
  filter: '',
  /** 分组折叠状态 */
  collapsed: {} as Record<string, boolean>,
  /** 每台机器的目录记忆（SFTP 双栏） */
  paths: {} as Record<string, PathMemory>,
  /** SFTP 面板是否展开（默认收起：只连终端时它白占一半宽度，需要时点标签栏的 SFTP 按钮） */
  sftpOpen: false,
  /** SFTP 面板宽度（双栏各占一半；放在终端左侧，太宽会挤掉终端，见 ServerView 的 max-width 兜底） */
  sftpW: 420,
  /** 传输队列（跨会话共享，切走再回来还能看到进度） */
  transfers: [] as TransferItem[],
  /** 自增计数器：终端区拖拽上传后通知 SFTP 面板刷新远程列表 */
  remoteRefresh: 0,
  /** 会话编辑弹窗：null=关闭；{}=新建 */
  editing: null as (Partial<SshServerCfg> & { id: string }) | null,
  /** 是否为新建（决定标题与密码必填） */
  editingNew: false,
  /** ~/.ssh/config 导入弹窗 */
  importOpen: false,
  /** 终端偏好弹窗 */
  prefsOpen: false,
  /** 底部提示 */
  toast: '',
  /** 状态栏临时消息 */
  status: ''
})

let toastTimer: any = null

export function flash(text: string): void {
  srv.toast = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { srv.toast = '' }, 3200)
}

export function servers(): SshServerCfg[] {
  return (store.cfg?.servers || []) as SshServerCfg[]
}

export function findServer(id: string): SshServerCfg | undefined {
  return servers().find((s) => s.id === id)
}

/** 兜底桶的显示名：没有分组的会话全挂这里，不是用户建的文件夹 */
export const UNGROUPED = '未分组'

/**
 * 分组文件夹清单：配置里登记的（保持用户排序）在前，只在会话 group 上出现的补在后面。
 * 空文件夹靠配置里这条清单活着——不能只从服务器 group 字段推导。
 */
export function serverGroups(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: unknown) => {
    const n = String(raw ?? '').trim()
    if (!n || n === UNGROUPED || seen.has(n)) return
    seen.add(n)
    out.push(n)
  }
  for (const g of (store.cfg as any)?.serverGroups || []) push(g?.name)
  for (const s of servers()) push(s.group)
  return out
}

export function newTermId(): string {
  return `term_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 同一台服务器开多个标签时标题加序号，避免标签栏一片同名 */
export function tabTitleFor(server: SshServerCfg): string {
  const base = server.name || server.host
  const n = srv.tabs.filter((t) => t.serverId === server.id).length
  return n ? `${base} (${n + 1})` : base
}

export function openTabState(server: SshServerCfg): TermTabState {
  const tab: TermTabState = {
    id: newTermId(),
    serverId: server.id,
    title: tabTitleFor(server),
    status: 'connecting'
  }
  srv.tabs.push(tab)
  srv.activeId = tab.id
  return tab
}

export function closeTabState(id: string): void {
  const idx = srv.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  srv.tabs.splice(idx, 1)
  if (srv.activeId === id) {
    const next = srv.tabs[Math.min(idx, srv.tabs.length - 1)]
    srv.activeId = next ? next.id : ''
  }
}

export function activeTab(): TermTabState | undefined {
  return srv.tabs.find((t) => t.id === srv.activeId)
}

export function activeServer(): SshServerCfg | undefined {
  const t = activeTab()
  return t ? findServer(t.serverId) : undefined
}

export function pathFor(serverId: string): PathMemory {
  if (!srv.paths[serverId]) srv.paths[serverId] = { remote: '', local: '' }
  return srv.paths[serverId]
}

/** 进度事件并入队列（纯逻辑在 transfer.ts，这里只负责接到全局状态上） */
export function upsertTransfer(p: ProgressEvent): TransferItem {
  return applyProgress(srv.transfers, p)
}

export function clearFinishedTransfers(): void {
  srv.transfers = srv.transfers.filter((t) => t.status === 'running')
}
