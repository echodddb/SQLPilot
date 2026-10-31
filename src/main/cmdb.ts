/**
 * CMDB 持久化层（electron 侧）
 * ─────────────────────────────
 * 三个文件分开存，理由各不相同：
 *  · cmdb.json       台账本体。写操作低频（录资产/改关系），整份原子写没问题。
 *  · cmdb-view.json  视图态（节点坐标 + 相机）。3D 拖拽是高频写，必须与台账分离，
 *                    否则拖一下就把整份台账重写一遍（写放大 + 一次坏写全丢）。
 *  · cmdb-log.jsonl  变更历史。只追加，超过行数上限就截断最老的。
 *
 * 不塞进 config.json：那份文件是全量读写的热路径（config:get 每个 IPC 都走），
 * 台账上千节点混进去会互相拖累，而且坏一次连数据库连接都一起丢。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic'
import {
  SPECS, emptyDoc, emptyView, normalizeDoc, normalizeView,
  type CmdbDoc, type CmdbViewDoc, type CmdbLogEntry
} from './cmdb-model'

function cmdbDir(): string {
  return path.join(app.getPath('userData'), 'cmdb')
}
export function docPath(): string {
  return path.join(cmdbDir(), 'cmdb.json')
}
export function viewPath(): string {
  return path.join(cmdbDir(), 'cmdb-view.json')
}
export function logPath(): string {
  return path.join(cmdbDir(), 'cmdb-log.jsonl')
}

let cachedDoc: CmdbDoc | null = null
let cachedView: CmdbViewDoc | null = null

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e: any) {
    // 只有"文件不存在"才当首次启动；坏文件先改名保留，别让用户看到资产全空后
    // 随手保存一次就把原件永久覆盖（与 config.ts 同一处理原则）
    if (e?.code !== 'ENOENT') {
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* 不可读也无从保留 */ }
    }
    return null
  }
}

export function loadDoc(): CmdbDoc {
  if (cachedDoc) return cachedDoc
  cachedDoc = normalizeDoc(readJson(docPath()))
  return cachedDoc
}

export function loadView(): CmdbViewDoc {
  if (cachedView) return cachedView
  cachedView = normalizeView(readJson(viewPath()))
  return cachedView
}

export function saveDoc(doc: CmdbDoc): void {
  writeFileAtomic(docPath(), JSON.stringify(doc, null, 1))
  cachedDoc = doc
}

export function saveView(view: CmdbViewDoc): void {
  writeFileAtomic(viewPath(), JSON.stringify(view))
  cachedView = view
}

/** 变更历史：只追加，超上限先截断（不做轮转文件，台账的变更没到需要归档的量级） */
const LOG_MAX_LINES = 2000

export function appendLog(e: Omit<CmdbLogEntry, 'ts'>): void {
  try {
    const line = JSON.stringify({ ...e, ts: new Date().toISOString() })
    const file = logPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let lines: string[] = []
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { /* 首次写入 */ }
    lines.push(line)
    if (lines.length > LOG_MAX_LINES) lines = lines.slice(-LOG_MAX_LINES)
    writeFileAtomic(file, lines.join('\n') + '\n')
  } catch {
    /* 历史写失败不阻断主流程 */
  }
}

export function readLog(assetId?: string, limit = 200): CmdbLogEntry[] {
  let lines: string[] = []
  try { lines = fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean) } catch { return [] }
  const out: CmdbLogEntry[] = []
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]) as CmdbLogEntry
      if (assetId && e.assetId !== assetId) continue
      out.push(e)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 改台账的统一入口：读完 → 改 → 落盘 → 记一条历史。
 *  调用方拿到返回的 doc 就是"改完之后"的权威状态，渲染层直接替换本地副本。 */
export function mutate<T>(
  fn: (doc: CmdbDoc) => { value: T; log?: Omit<CmdbLogEntry, 'ts'>; dirty?: boolean; error?: string }
): { ok: boolean; doc?: CmdbDoc; value?: T; error?: string } {
  const doc = loadDoc()
  const r = fn(doc)
  if (r.error) return { ok: false, error: r.error, doc }
  if (r.dirty !== false) {
    saveDoc(doc)
    if (r.log) appendLog(r.log)
  }
  return { ok: true, doc, value: r.value }
}

/** 首次进入：给一份可以直接上手的骨架。
 *  空白台账最劝退——用户不知道"客户和机房是两个维度"、也不知道 3D 里怎么摆，
 *  给一套**装满设备的机柜**（含 RAC 双节点、接入/核心交换机、配线架、UPS、PDU，
 *  以及带颜色的业务网/心跳网/管理网/存储网连线）比写十条说明管用。 */
export function ensureSeed(): CmdbDoc {
  const doc = loadDoc()
  if (doc.customers.length || doc.idcs.length || doc.assets.length) return doc
  const now = Date.now()
  doc.customers.push({ id: 'cu_demo', name: '示例客户', code: 'DEMO', color: '#38bdf8', createdAt: now, updatedAt: now })
  doc.idcs.push({
    id: 'idc_demo', name: '示例机房 A', region: '本地', cols: 10, rows: 8, tileMm: 600,
    createdAt: now, updatedAt: now
  })
  doc.racks.push(
    { id: 'rk_demo_1', idcId: 'idc_demo', code: 'A-01', uTotal: 42, widthMm: 600, depthMm: 1200, gridCol: 3, gridRow: 2, powerKw: 8, createdAt: now, updatedAt: now },
    { id: 'rk_demo_2', idcId: 'idc_demo', code: 'A-02', uTotal: 42, widthMm: 600, depthMm: 1200, gridCol: 5, gridRow: 2, powerKw: 8, createdAt: now, updatedAt: now }
  )

  interface Row {
    name: string
    type: string
    rack: string
    u: number
    spec: string
    role?: string
    arch?: string
    group?: string
    ip?: string
    os?: string
  }
  // U 位按真实习惯排：交换机/配线架在顶，数据库在中部，UPS/PDU 在最底
  const rows: Row[] = [
    { name: 'core-sw-01', type: 'switch', rack: 'rk_demo_1', u: 42, spec: 'sw-1u-48', role: 'network', ip: '10.0.0.1' },
    { name: 'mgmt-sw-01', type: 'switch', rack: 'rk_demo_1', u: 41, spec: 'sw-1u-24', role: 'network', ip: '10.0.0.11' },
    { name: 'patch-01', type: 'other-hw', rack: 'rk_demo_1', u: 40, spec: 'patch-1u' },
    { name: 'ora-rac-node1', type: 'server', rack: 'rk_demo_1', u: 36, spec: 'srv-2u', role: 'db', arch: 'oracle-rac', group: 'rac-prod', ip: '10.1.1.11', os: 'Oracle Linux 8.9' },
    { name: 'app-srv-01', type: 'server', rack: 'rk_demo_1', u: 34, spec: 'srv-1u', role: 'app', ip: '10.2.1.21', os: 'CentOS 7.9' },
    { name: 'app-srv-02', type: 'server', rack: 'rk_demo_1', u: 32, spec: 'srv-1u', role: 'app', ip: '10.2.1.22', os: 'CentOS 7.9' },
    { name: 'backup-srv-01', type: 'server', rack: 'rk_demo_1', u: 28, spec: 'srv-2u', role: 'backup', ip: '10.3.1.31', os: 'CentOS 7.9' },
    { name: 'ups-01', type: 'ups', rack: 'rk_demo_1', u: 8, spec: 'ups-rack-3u' },
    { name: 'pdu-01', type: 'pdu', rack: 'rk_demo_1', u: 1, spec: 'pdu-1u' },

    { name: 'core-sw-02', type: 'switch', rack: 'rk_demo_2', u: 42, spec: 'sw-1u-48', role: 'network', ip: '10.0.0.2' },
    { name: 'mgmt-sw-02', type: 'switch', rack: 'rk_demo_2', u: 41, spec: 'sw-1u-24', role: 'network', ip: '10.0.0.12' },
    { name: 'patch-02', type: 'other-hw', rack: 'rk_demo_2', u: 40, spec: 'patch-1u' },
    { name: 'ora-rac-node2', type: 'server', rack: 'rk_demo_2', u: 36, spec: 'srv-2u', role: 'db', arch: 'oracle-rac', group: 'rac-prod', ip: '10.1.1.12', os: 'Oracle Linux 8.9' },
    { name: 'ora-dg-node1', type: 'server', rack: 'rk_demo_2', u: 32, spec: 'srv-2u', role: 'db', arch: 'oracle-dg', group: 'dg-prod', ip: '10.1.2.13', os: 'Oracle Linux 8.9' },
    { name: 'app-srv-03', type: 'server', rack: 'rk_demo_2', u: 29, spec: 'srv-1u', role: 'app', ip: '10.2.1.23', os: 'CentOS 7.9' },
    { name: 'stor-01', type: 'storage', rack: 'rk_demo_2', u: 24, spec: 'storage-2u', role: 'storage', ip: '10.4.1.41' },
    { name: 'ups-02', type: 'ups', rack: 'rk_demo_2', u: 8, spec: 'ups-rack-3u' },
    { name: 'pdu-02', type: 'pdu', rack: 'rk_demo_2', u: 1, spec: 'pdu-1u' }
  ]

  const idOf = (name: string): string => `as_${name}`
  for (const r of rows) {
    const spec = SPECS.find((s) => s.id === r.spec)
    doc.assets.push({
      id: idOf(r.name),
      customerId: 'cu_demo',
      idcId: 'idc_demo',
      rackId: r.rack,
      u: r.u,
      uHeight: Math.max(1, spec?.u || 1),
      spec: r.spec,
      type: r.type,
      name: r.name,
      hostname: r.name,
      ips: r.ip ? [r.ip] : [],
      os: r.os,
      status: 'running',
      role: r.role,
      arch: r.arch,
      archGroup: r.group,
      tags: [],
      meta: {},
      createdAt: now,
      updatedAt: now
    })
  }

  // 网线：接入/心跳/管理/存储四类，颜色一眼可辨
  const wire = (a: string, ap: string, b: string, bp: string, net: any, label?: string) => {
    doc.cables.push({ id: `cb_${doc.cables.length + 1}`, fromId: idOf(a), fromPort: ap, toId: idOf(b), toPort: bp, net, label, createdAt: now })
  }
  wire('ora-rac-node1', 'nic-1', 'core-sw-01', 'nic-1', 'biz')
  wire('ora-rac-node1', 'nic-2', 'core-sw-01', 'nic-2', 'biz')
  wire('ora-rac-node2', 'nic-1', 'core-sw-02', 'nic-1', 'biz')
  wire('ora-rac-node2', 'nic-2', 'core-sw-02', 'nic-2', 'biz')
  wire('app-srv-01', 'nic-1', 'core-sw-01', 'nic-5', 'biz')
  wire('app-srv-02', 'nic-1', 'core-sw-01', 'nic-6', 'biz')
  wire('app-srv-03', 'nic-1', 'core-sw-02', 'nic-5', 'biz')
  wire('ora-dg-node1', 'nic-1', 'core-sw-02', 'nic-6', 'biz')
  // RAC 私网心跳：两节点直连
  wire('ora-rac-node1', 'sfp-1', 'ora-rac-node2', 'sfp-1', 'heartbeat', 'RAC 私网')
  // DataGuard 日志传输：走核心交换机
  wire('ora-rac-node1', 'sfp-2', 'core-sw-01', 'sfp-1', 'private', 'DG 日志传输')
  wire('ora-dg-node1', 'sfp-1', 'core-sw-02', 'sfp-1', 'private')
  // 存储网：两节点到磁盘阵列
  wire('ora-rac-node1', 'sfp-3', 'stor-01', 'sfp-1', 'storage')
  wire('ora-rac-node2', 'sfp-3', 'stor-01', 'sfp-2', 'storage')
  // 备份网：备份服务器到存储
  wire('backup-srv-01', 'sfp-1', 'stor-01', 'sfp-3', 'backup')
  // 管理网：带外口到管理交换机
  wire('ora-rac-node1', 'mgmt-1', 'mgmt-sw-01', 'nic-1', 'mgmt')
  wire('ora-rac-node2', 'mgmt-1', 'mgmt-sw-02', 'nic-1', 'mgmt')
  wire('app-srv-01', 'mgmt-1', 'mgmt-sw-01', 'nic-2', 'mgmt')
  wire('backup-srv-01', 'mgmt-1', 'mgmt-sw-01', 'nic-3', 'mgmt')
  // 核心互联
  wire('core-sw-01', 'sfp-3', 'core-sw-02', 'sfp-3', 'biz', '堆叠')

  doc.relations.push(
    { id: 'rl_1', fromId: idOf('ora-rac-node1'), toId: idOf('core-sw-01'), kind: 'physical', label: '上联', directed: true, createdAt: now },
    { id: 'rl_2', fromId: idOf('ora-rac-node2'), toId: idOf('core-sw-02'), kind: 'physical', label: '上联', directed: true, createdAt: now },
    { id: 'rl_3', fromId: idOf('app-srv-01'), toId: idOf('ora-rac-node1'), kind: 'dependency', label: '依赖', directed: true, createdAt: now },
    { id: 'rl_4', fromId: idOf('ora-dg-node1'), toId: idOf('stor-01'), kind: 'dependency', label: '备份到', directed: true, createdAt: now }
  )
  saveDoc(doc)
  appendLog({ action: 'seed', target: '示例台账', detail: `首次进入 CMDB，已生成示例机房（2 柜 / ${rows.length} 台设备 / ${doc.cables.length} 根网线）` })
  return doc
}

/** 一次性导入（JSON 备份恢复）：整体替换，调用方负责先确认 */
export function replaceDoc(raw: any): CmdbDoc {
  const doc = normalizeDoc(raw)
  saveDoc(doc)
  appendLog({
    action: 'import',
    target: '台账',
    detail: `导入备份：${doc.customers.length} 客户 / ${doc.idcs.length} 机房 / ${doc.assets.length} 资产 / ${doc.relations.length} 关系`
  })
  return doc
}

export function resetCache(): void {
  cachedDoc = null
  cachedView = null
}

export { emptyDoc, emptyView }
