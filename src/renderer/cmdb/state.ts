/** CMDB 渲染层状态与动作。数据权威在主进程，写操作一律「提交 → 用返回的 doc 整体替换」，
 *  不做本地乐观更新：台账规模小，一次往返换来的是永不出现"界面与磁盘不一致"。 */
import { computed, reactive } from 'vue'
import { toPlain } from '../store'
import { emptyView, graphOf, statsOf, treeOf, type CmdbDoc, type CmdbLogEntry, type CmdbViewDoc, type CmdbViewMode, type CmdbRelationKind } from '../../main/cmdb-model'

export interface CmdbFilterState {
  customerId: string
  idcId: string
  types: string[]
  q: string
  hideRetired: boolean
}

interface CmdbState {
  loaded: boolean
  loading: boolean
  doc: CmdbDoc | null
  view: CmdbViewDoc
  log: CmdbLogEntry[]
  file: string
  mode: CmdbViewMode
  filter: CmdbFilterState
  selected: string
  selectedEdge: string
  hover: string
  /** 机柜视图当前选中的机柜 */
  rackId: string
  showLabels: boolean
  linking: boolean
  busy: string
  toast: { text: string; tone: 'ok' | 'bad' } | null
}

export const cm = reactive<CmdbState>({
  loaded: false,
  loading: false,
  doc: null,
  view: emptyView(),
  log: [],
  file: '',
  mode: '3d',
  filter: { customerId: '', idcId: '', types: [], q: '', hideRetired: true },
  selected: '',
  selectedEdge: '',
  hover: '',
  rackId: '',
  showLabels: true,
  linking: false,
  busy: '',
  toast: null
})

let toastTimer = 0
export function toast(text: string, tone: 'ok' | 'bad' = 'ok'): void {
  cm.toast = { text, tone }
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (cm.toast = null), 3200)
}

// ---------------------------------------------------------------- 派生数据

export const customers = computed(() => cm.doc?.customers || [])
export const idcs = computed(() => cm.doc?.idcs || [])
export const racks = computed(() => cm.doc?.racks || [])

export const liveAssets = computed(() => (cm.doc?.assets || []).filter((a) => !a.deletedAt))
export const deletedAssets = computed(() => (cm.doc?.assets || []).filter((a) => !!a.deletedAt).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)))

export const stats = computed(() => (cm.doc ? statsOf(cm.doc) : null))
export const tree = computed(() => (cm.doc ? treeOf(cm.doc) : []))
export const trashTree = computed(() => (cm.doc ? treeOf({ ...cm.doc, assets: cm.doc.assets }, true) : []))

export const graph = computed(() => {
  if (!cm.doc) return { nodes: [], edges: [], hidden: 0 }
  return graphOf(cm.doc, {
    customerId: cm.filter.customerId || undefined,
    idcId: cm.filter.idcId || undefined,
    types: cm.filter.types,
    q: cm.filter.q,
    hideRetired: cm.filter.hideRetired
  })
})

export const selectedAsset = computed(() => cm.doc?.assets.find((a) => a.id === cm.selected) || null)

export function relationsOf(id: string): { id: string; kind: CmdbRelationKind; label: string; dir: 'out' | 'in'; otherId: string; otherName: string; otherType: string }[] {
  const doc = cm.doc
  if (!doc || !id) return []
  const out: any[] = []
  for (const r of doc.relations) {
    if (r.fromId !== id && r.toId !== id) continue
    const otherId = r.fromId === id ? r.toId : r.fromId
    const other = doc.assets.find((a) => a.id === otherId)
    if (!other) continue
    out.push({
      id: r.id,
      kind: r.kind,
      label: r.label || '',
      dir: r.fromId === id ? 'out' : 'in',
      otherId,
      otherName: other.name,
      otherType: other.type
    })
  }
  return out
}

export function assetById(id: string) {
  return cm.doc?.assets.find((a) => a.id === id)
}

/** 机柜里按 U 位排序的资产（机柜正视图用） */
export function assetsOfRack(rackId: string) {
  return liveAssets.value
    .filter((a) => a.rackId === rackId)
    .sort((a, b) => (a.u || 99) - (b.u || 99))
}

// ---------------------------------------------------------------- 视图持久化

let viewTimer = 0
/** 坐标/相机落盘：3D 拖拽是高频动作，必须防抖，且只写 cmdb-view.json（不碰台账） */
export function persistView(immediate = false): void {
  const push = (): void => {
    // 注意 toPlain：cm.view 是 reactive，嵌套的 Vec3/数组都是 Proxy，
    // 直接扔给 contextBridge 会抛 "An object could not be cloned"（踩过）
    void window.sqlpilot.cmdbSaveView(toPlain({
      version: 1,
      positions: { ...cm.view.positions },
      camera: { ...cm.view.camera },
      mode: cm.mode,
      hiddenKinds: [...cm.view.hiddenKinds],
      roomId: cm.view.roomId || ''
    }))
  }
  window.clearTimeout(viewTimer)
  if (immediate) push()
  else viewTimer = window.setTimeout(push, 700)
}

export function setMode(mode: CmdbViewMode): void {
  cm.mode = mode
  persistView()
}

// ---------------------------------------------------------------- 数据加载与写操作

export async function load(force = false): Promise<void> {
  if (cm.loaded && !force) return
  cm.loading = true
  try {
    const r = await window.sqlpilot.cmdbLoad()
    if (r?.ok) {
      cm.doc = r.doc
      cm.view = r.view
      cm.log = r.log || []
      cm.file = r.file || ''
      cm.mode = r.view.mode || '3d'
      cm.loaded = true
      // 刻意不默认选中第一个客户：3D 视图的用处是"一眼看全"，先给全景，
      // 想收窄再点左树。默认选中会把其他客户的资产藏起来，反而让人以为没数据。
    } else {
      toast('台账读取失败', 'bad')
    }
  } catch (e: any) {
    toast(`台账读取失败：${e?.message || e}`, 'bad')
  } finally {
    cm.loading = false
  }
}

type WriteResult = { ok: boolean; error?: string; doc?: CmdbDoc; value?: any }

/** 统一写入口：成功则整体替换 doc（权威状态来自主进程），失败弹提示 */
async function commit(p: Promise<WriteResult>, okMsg?: string): Promise<WriteResult | null> {
  try {
    const r = await p
    if (r?.doc) cm.doc = r.doc
    if (!r?.ok) {
      toast(r?.error || '操作失败', 'bad')
      return null
    }
    if (okMsg) toast(okMsg, 'ok')
    return r
  } catch (e: any) {
    toast(`操作失败：${e?.message || e}`, 'bad')
    return null
  }
}

export const saveCustomer = (customer: any, msg = '客户已保存') => commit(window.sqlpilot.cmdbSaveCustomer(toPlain(customer)), msg)
export const deleteCustomer = (id: string) => commit(window.sqlpilot.cmdbDeleteCustomer(id), '客户已删除')
export const saveIdc = (idc: any, msg = '机房已保存') => commit(window.sqlpilot.cmdbSaveIdc(toPlain(idc)), msg)
export const deleteIdc = (id: string) => commit(window.sqlpilot.cmdbDeleteIdc(id), '机房已删除')
export const saveRack = (rack: any, msg = '机柜已保存') => commit(window.sqlpilot.cmdbSaveRack(toPlain(rack)), msg)
export const deleteRack = (id: string) => commit(window.sqlpilot.cmdbDeleteRack(id), '机柜已删除')

export async function saveAsset(asset: any, msg = '资产已保存') {
  const r = await commit(window.sqlpilot.cmdbSaveAsset(toPlain(asset)), msg)
  if (r?.value?.id) cm.selected = r.value.id
  return r
}
export const deleteAsset = (id: string) => commit(window.sqlpilot.cmdbDeleteAsset(id), '已移入回收站')
export const restoreAsset = (id: string) => commit(window.sqlpilot.cmdbRestoreAsset(id), '已恢复')
export const purgeAsset = (id: string) => commit(window.sqlpilot.cmdbPurgeAsset(id), '已彻底删除')

export const saveRelation = (relation: any, msg = '关系已建立') => commit(window.sqlpilot.cmdbSaveRelation(toPlain(relation)), msg)
export const deleteRelation = (id: string) => commit(window.sqlpilot.cmdbDeleteRelation(id), '关系已断开')

/** 网线（物理链路）：端口到端口，和"关系"分开存 —— 关系是逻辑，网线是插在哪两个口上 */
export const saveCable = (cable: any, msg = '网线已连接') => commit(window.sqlpilot.cmdbSaveCable(toPlain(cable)), msg)
export const deleteCable = (id: string) => commit(window.sqlpilot.cmdbDeleteCable(id), '网线已拔除')

/** 某设备的相关设备集合：关系边 + 网线 + 同架构组（RAC / DG / MGR…）。
 *  3D 里点一台机器，要和它有关系的机器一起亮起来，靠的就是这个集合。 */
export function relatedOf(id: string): { devices: Set<string>; racks: Set<string> } {
  const devices = new Set<string>()
  const racks = new Set<string>()
  const doc = cm.doc
  if (!doc || !id) return { devices, racks }
  const self = doc.assets.find((a) => a.id === id)
  if (!self) return { devices, racks }
  for (const r of doc.relations) {
    if (r.fromId !== id && r.toId !== id) continue
    devices.add(r.fromId === id ? r.toId : r.fromId)
  }
  for (const c of doc.cables) {
    if (c.fromId !== id && c.toId !== id) continue
    devices.add(c.fromId === id ? c.toId : c.fromId)
  }
  if (self.arch && self.archGroup) {
    for (const a of doc.assets) {
      if (a.id === id || a.deletedAt) continue
      if (a.arch === self.arch && a.archGroup === self.archGroup) devices.add(a.id)
    }
  }
  devices.delete(id)
  if (self.rackId) racks.add(self.rackId)
  for (const did of devices) {
    const a = doc.assets.find((x) => x.id === did)
    if (a?.rackId) racks.add(a.rackId)
  }
  return { devices, racks }
}

export async function refreshLog(assetId?: string): Promise<void> {
  const r = await window.sqlpilot.cmdbLog(assetId, 200)
  if (r?.ok) cm.log = r.entries
}

export function selectAsset(id: string): void {
  cm.selected = id
  cm.selectedEdge = ''
  if (id) void refreshLog(id)
}

export function resetFilter(): void {
  cm.filter = { customerId: '', idcId: '', types: [], q: '', hideRetired: true }
}
