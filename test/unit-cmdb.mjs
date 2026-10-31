/**
 * CMDB 单测：图模型（规范化 / 校验 / 软删 / 图投影 / 纳管去重 / CSV）+ 相机投影与布局。
 *
 * 重点覆盖"会让用户看见错数据"的路径，而不是覆盖率：
 *  · 关系重复、自环、指向已删节点的边 —— 图里多一条边比少一条更误导人；
 *  · 软删后恢复，关系必须回来；
 *  · 纳管不能覆盖人工录入的名称/型号；
 *  · 导入 CSV 缺客户时自动建，而不是整批失败；
 *  · 相机：目标点在屏幕正中、屏幕↔世界反投影往返一致（拖拽节点的正确性依赖它）。
 *
 * 运行：node test/unit-cmdb.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')

async function loadTs(entry, tag) {
  const out = path.join(import.meta.dirname, `.cmdb-${tag}.mjs`)
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent'
  })
  const mod = await import(`${pathToFileURL(out).href}?t=${Date.now()}`)
  fs.unlinkSync(out)
  return mod
}

const M = await loadTs('src/main/cmdb-model.ts', 'model')
const R = await loadTs('src/main/cmdb-room.ts', 'room')
const C = await loadTs('src/renderer/cmdb/camera.ts', 'cam')

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

const NOW = 1_700_000_000_000

function seedDoc() {
  const doc = M.emptyDoc()
  doc.customers.push({ id: 'cu1', name: '银行A', createdAt: NOW, updatedAt: NOW })
  doc.customers.push({ id: 'cu2', name: '银行B', createdAt: NOW, updatedAt: NOW })
  doc.idcs.push({ id: 'idc1', name: '上海IDC', createdAt: NOW, updatedAt: NOW })
  doc.idcs.push({ id: 'idc2', name: '北京IDC', createdAt: NOW, updatedAt: NOW })
  doc.racks.push({ id: 'rk1', idcId: 'idc1', code: 'A-12', uTotal: 42, createdAt: NOW, updatedAt: NOW })
  doc.racks.push({ id: 'rk2', idcId: 'idc2', code: 'B-01', uTotal: 42, createdAt: NOW, updatedAt: NOW })
  const mk = (id, extra = {}) => ({
    id, customerId: 'cu1', idcId: 'idc1', rackId: 'rk1', type: 'server', name: id,
    ips: [], tags: [], meta: {}, status: 'running', createdAt: NOW, updatedAt: NOW, ...extra
  })
  doc.assets.push(mk('a1', { ips: ['10.1.1.1'] }))
  doc.assets.push(mk('a2', { ips: ['10.1.1.2'], type: 'switch' }))
  doc.assets.push(mk('a3', { customerId: 'cu2', idcId: 'idc2', rackId: 'rk2', ips: ['10.2.1.1'] }))
  doc.relations.push({ id: 'r1', fromId: 'a1', toId: 'a2', kind: 'physical', createdAt: NOW })
  return doc
}

// ---------------------------------------------------------------- 规范化
{
  const raw = {
    customers: [{ id: 'c1', name: '甲' }, { id: 'c1', name: '重复' }, { name: '' }],
    idcs: [{ id: 'd1', name: '机房1', region: '华东' }],
    racks: [
      { id: 'k1', idcId: 'd1', code: 'A-01' },
      { id: 'k2', idcId: 'missing', code: 'B-01' }
    ],
    assets: [
      { id: 'x1', customerId: 'c1', idcId: 'd1', rackId: 'k1', name: 'srv', type: 'unknown', status: 'weird', ips: '10.0.0.1, 10.0.0.2' },
      { id: 'x2', customerId: 'c1', idcId: 'nope', rackId: 'k1', name: 'srv2', type: 'switch' },
      { id: 'x3', customerId: 'c1', name: '' }
    ],
    relations: [
      { id: 'r1', fromId: 'x1', toId: 'x2', kind: 'physical' },
      { id: 'r2', fromId: 'x1', toId: 'x2', kind: 'physical' },
      { id: 'r3', fromId: 'x1', toId: 'x1', kind: 'physical' },
      { id: 'r4', fromId: 'x1', toId: 'ghost', kind: 'physical' }
    ]
  }
  const doc = M.normalizeDoc(raw)
  eq(doc.customers.length, 1, '重复 id 的客户只留一个，空名的丢掉')
  eq(doc.racks.map((r) => r.id), ['k1'], '机房不存在的机柜被丢弃')
  eq(doc.assets.length, 2, '空名资产被丢弃')
  eq(doc.assets[0].type, 'other-hw', '未知类型收敛到 other-hw')
  eq(doc.assets[0].status, 'running', '非法状态收敛到 running')
  eq(doc.assets[0].ips, ['10.0.0.1', '10.0.0.2'], '字符串 IP 拆成数组')
  eq(doc.assets[1].idcId, undefined, '指向不存在机房的 idcId 被清空')
  eq(doc.assets[1].rackId, undefined, '机房没了机柜也就挂不住')
  eq(doc.relations.length, 1, '重复边/自环/悬空边全部剔除')
  eq(doc.racks[0].uTotal, 42, '机柜 U 数缺省补 42')
}

// ---------------------------------------------------------------- 校验与增删改
{
  const doc = seedDoc()
  eq(M.upsertAsset(doc, { name: 'x', customerId: 'cu1', type: 'server' }).ok, true, '合法资产可建')
  eq(M.upsertAsset(doc, { name: '', customerId: 'cu1', type: 'server' }).ok, false, '名称为空被拒')
  eq(M.upsertAsset(doc, { name: 'x', customerId: '', type: 'server' }).ok, false, '没有客户被拒')
  eq(M.upsertAsset(doc, { name: 'x', customerId: 'nobody', type: 'server' }).ok, false, '客户不存在被拒')
  eq(M.upsertAsset(doc, { name: 'x', customerId: 'cu1', type: 'server', idcId: 'idc2', rackId: 'rk1' }).ok, false, '机柜与机房不匹配被拒')
  eq(M.upsertCustomer(doc, { name: '银行A' }).ok, false, '同名客户被拒')
  eq(M.upsertRack(doc, { idcId: 'idc1', code: 'A-12' }).ok, false, '同机房重名机柜被拒')
  eq(M.upsertIdc(doc, { name: '上海IDC' }).ok, false, '同名机房被拒')
}

// ---------------------------------------------------------------- 软删 / 恢复 / 彻底删
{
  const doc = seedDoc()
  ok(M.softDeleteAsset(doc, 'a1'), '软删成功')
  eq(M.graphOf(doc).nodes.map((n) => n.id), ['a2', 'a3'], '软删的节点不进图')
  eq(M.graphOf(doc).edges.length, 0, '端点已删的边也不进图')
  ok(M.restoreAsset(doc, 'a1'), '恢复成功')
  eq(M.graphOf(doc).edges.length, 1, '恢复后关系自动回来')
  eq(M.purgeAsset(doc, 'a1'), 1, '彻底删除连带清理关系')
  eq(doc.relations.length, 0, '关系真的没了')
  eq(M.statsOf(doc).deleted, 0, '彻底删除后不再计入回收站')
}

// ---------------------------------------------------------------- 删客户 / 删机房
{
  const doc = seedDoc()
  eq(M.deleteCustomer(doc, 'cu1'), 2, '删客户：该客户下 2 台资产转为未归属')
  eq(doc.assets.filter((a) => !a.customerId).length, 2, '资产记录保留，只清归属')
  const doc2 = seedDoc()
  const r = M.deleteIdc(doc2, 'idc1')
  eq(r.racks, 1, '删机房连带删机柜')
  eq(r.assets, 2, '机房内资产位置被清空')
  eq(doc2.assets.find((a) => a.id === 'a1').idcId, undefined, 'idcId 清空')
  eq(doc2.assets.find((a) => a.id === 'a1').rackId, undefined, 'rackId 清空')
  eq(doc2.assets.find((a) => a.id === 'a3').idcId, 'idc2', '别的机房的资产不动')
}

// ---------------------------------------------------------------- 关系
{
  const doc = seedDoc()
  eq(M.upsertRelation(doc, { fromId: 'a1', toId: 'a1', kind: 'physical' }).ok, false, '自环被拒')
  eq(M.upsertRelation(doc, { fromId: 'a1', toId: 'ghost', kind: 'physical' }).ok, false, '悬空端点被拒')
  const again = M.upsertRelation(doc, { fromId: 'a1', toId: 'a2', kind: 'physical', label: '上联' })
  eq(again.ok, true, '重复连线不报错')
  eq(doc.relations.length, 1, '重复连线不新增边')
  eq(doc.relations[0].label, '上联', '重复连线更新标签')
  M.upsertRelation(doc, { fromId: 'a2', toId: 'a1', kind: 'physical' })
  eq(doc.relations.length, 2, '反向视为另一条边（主备关系需要）')
  M.softDeleteAsset(doc, 'a2')
  eq(M.upsertRelation(doc, { fromId: 'a3', toId: 'a2', kind: 'hosting' }).ok, false, '端点已软删不允许再连')
}

// ---------------------------------------------------------------- 图投影
{
  const doc = seedDoc()
  doc.assets.push({ id: 'a4', customerId: 'cu1', idcId: 'idc1', rackId: 'rk1', type: 'server', name: 'retired', status: 'retired', ips: [], tags: [], meta: {}, createdAt: NOW, updatedAt: NOW })
  eq(M.graphOf(doc).nodes.length, 3, '默认隐藏已下线资产')
  eq(M.graphOf(doc, { hideRetired: false }).nodes.length, 4, '可显式包含已下线')
  eq(M.graphOf(doc, { customerId: 'cu2' }).nodes.map((n) => n.id), ['a3'], '按客户筛')
  eq(M.graphOf(doc, { customerId: '__none__' }).nodes.length, 0, '__none__ 只匹配未归属')
  eq(M.graphOf(doc, { idcId: 'idc1' }).nodes.length, 2, '按机房筛（已下线的 a4 默认不进图，机房是跨客户的独立维度）')
  eq(M.graphOf(doc, { q: '10.2.1' }).nodes.map((n) => n.id), ['a3'], 'IP 搜索')
  eq(M.graphOf(doc, { q: 'SWITCH' }).nodes.map((n) => n.id), ['a2'], '搜索不区分大小写，也搜类型外的名称')
  const g = M.graphOf(doc)
  eq(g.nodes.find((n) => n.id === 'a1').degree, 1, '度数按可见边统计')
  const typeFiltered = M.graphOf(doc, { types: ['switch'] })
  eq(typeFiltered.nodes.length, 1, '按类型筛')
  eq(typeFiltered.edges.length, 0, '端点被筛掉的边不进图')
  eq(typeFiltered.hidden, 3, '记录被筛掉的数量（含默认隐藏的已下线），界面要提示')
}

// ---------------------------------------------------------------- 树与统计
{
  const doc = seedDoc()
  const t = M.treeOf(doc)
  eq(t.length, 2, '两个客户分组')
  eq(t[0].count, 2, '客户A 2 台')
  eq(t[0].children[0].id, 'idc1', '客户A 下的机房')
  eq(t[0].children[0].children[0].name, '机柜 A-12', '机柜桶')
  eq(t[0].children[0].children[0].count, 2, '机柜里 2 台')
  const s = M.statsOf(doc)
  eq(s.assets, 3, '资产数')
  eq(s.relations, 1, '关系数')
  eq(s.orphans, 1, 'a3 没有任何关系 → 孤岛 1')
  eq(s.byType.switch, 1, '类型统计')
}

// ---------------------------------------------------------------- 纳管计划
{
  const doc = seedDoc()
  const items = [
    { key: 'server:s1', name: '手工改过的名字', ip: '10.1.1.1', os: 'CentOS 8', linkServerId: 's1' },
    { key: 'ip:10.2.1.1', name: '另一台', ip: '10.2.1.1' },
    { key: 'cloud:p:9', name: '新机器', ip: '10.9.9.9', cloudRef: 'p:9' },
    { key: 'cloud:p:9', name: '重复出现', ip: '10.9.9.9', cloudRef: 'p:9' }
  ]
  const plan = M.planSync(doc, items, { customerId: 'cu1' })
  eq(plan.creates.length, 1, '只有一台是真新的')
  eq(plan.creates[0].name, '新机器', '新资产带名字')
  eq(plan.updates.length, 1, 'OS 变了 → 出一条更新')
  eq(plan.updates[0].patch.os, 'CentOS 8', '只补 OS')
  eq(plan.updates[0].patch.name, undefined, '绝不覆盖人工录入的名称')
  eq(plan.skipped, 2, '同 IP 命中 + 同 key 重复 → 跳过 2')
  eq(doc.assets.find((a) => a.id === 'a1').name, 'a1', '计划阶段不改动现有台账')
}

// ---------------------------------------------------------------- CSV
{
  const doc = seedDoc()
  const csv = M.buildAssetCsv(doc, doc.assets)
  ok(csv.split('\r\n')[0].startsWith('客户,机房'), '表头可读')
  ok(csv.includes('10.1.1.1'), '导出含 IP')
  const rows = M.parseCsv('a,b\r\n"含,逗号","带""引号"""\n末行')
  eq(rows[0], ['a', 'b'], '普通行')
  eq(rows[1], ['含,逗号', '带"引号"'], '引号内的逗号与转义引号')
  eq(rows[2], ['末行'], '末尾没有换行也能出最后一行')

  const target = M.emptyDoc()
  const res = M.importAssetCsv(
    target,
    '客户,机房,机柜,类型,名称,IP,状态\n新客户,新机房,C-01,服务器,srv-1,10.5.5.5,运行中\n新客户,新机房,C-01,交换机,sw-1,10.5.5.6,已停止\n,,,服务器,裸机,,\n'
  )
  eq(res.created, 3, '三行都导入成功')
  eq(target.customers.map((c) => c.name), ['新客户'], '客户不存在 → 自动建')
  eq(target.idcs.length, 1, '机房自动建')
  eq(target.racks.length, 1, '机柜自动建')
  eq(target.assets[1].type, 'switch', '中文类型名映射回 id')
  eq(target.assets[1].status, 'stopped', '中文状态映射回 id')
  eq(target.assets[2].customerId, target.customers[0].id, '客户留空时落到第一个客户，不整批失败')
}

// ---------------------------------------------------------------- 上下文文本
{
  const doc = seedDoc()
  const text = M.assetContextText(doc, 'a1')
  ok(text.includes('# 资产：a1'), '带标题')
  ok(text.includes('客户 银行A'), '带客户')
  ok(text.includes('机柜 A-12'), '带机柜')
  ok(text.includes('物理连接'), '带关系类型')
  ok(text.includes('a2'), '带对端资产')
  eq(M.assetContextText(doc, 'ghost'), '', '不存在的资产返回空串')
}

// ---------------------------------------------------------------- 相机
{
  const cam = { yaw: 0.7, pitch: 0.52, dist: 2600, tx: 0, ty: 0, tz: 0 }
  const W = 1000
  const H = 700
  const center = C.project({ x: 0, y: 0, z: 0 }, cam, W, H)
  ok(Math.abs(center.x - W / 2) < 0.001 && Math.abs(center.y - H / 2) < 0.001, '目标点落在屏幕正中')
  ok(center.depth > 0 && center.scale > 0, '深度与缩放为正')

  const near = C.project({ x: 0, y: 0, z: 600 }, cam, W, H)
  const far = C.project({ x: 0, y: 0, z: -600 }, cam, W, H)
  ok(near.scale > far.scale, '离相机近的缩放更大（透视正确）')

  const b = C.basisOf(cam, W, H)
  const wpt = { x: 120, y: -40, z: 300 }
  const sp = C.projectWith(b, wpt)
  const back = C.unprojectOnPlane(b, sp.x, sp.y, wpt)
  ok(Math.abs(back.x - wpt.x) < 0.01 && Math.abs(back.y - wpt.y) < 0.01 && Math.abs(back.z - wpt.z) < 0.01,
    '屏幕↔世界反投影往返一致（拖拽节点的正确性依赖它）')

  ok(C.orbit(cam, 0, 9999).pitch <= C.PITCH_LIMIT + 1e-9, '仰角被夹住，不会翻到顶导致基向量退化')
  eq(C.zoom(cam, -10000).dist, 300, '缩放下限')
  eq(C.zoom(cam, 10000).dist, 16000, '缩放上限')

  // 相机背后 = 沿视线反方向越过眼睛的位置：depth < 0，必须剔除（否则会画到屏幕上一个镜像点）
  const behindPt = {
    x: b.eye.x - b.forward.x * 1000,
    y: b.eye.y - b.forward.y * 1000,
    z: b.eye.z - b.forward.z * 1000
  }
  eq(C.projectWith(b, behindPt).visible, false, '相机背后的点不参与绘制')
}

// ---------------------------------------------------------------- 布局
{
  const assets = [
    { id: 'a1', idcId: 'idc1', rackId: 'rk1' },
    { id: 'a2', idcId: 'idc1', rackId: 'rk1' },
    { id: 'a3', idcId: 'idc2', rackId: 'rk2' },
    { id: 'a4' }
  ]
  const idcs = [{ id: 'idc1', name: '上海' }, { id: 'idc2', name: '北京' }]
  const racks = [{ id: 'rk1', idcId: 'idc1', code: 'A' }, { id: 'rk2', idcId: 'idc2', code: 'B' }]
  const l = C.computeLayout(assets, idcs, racks)
  eq(l.positions.size, 4, '每个资产都有坐标')
  eq(l.clusters.length, 3, '两个机房 + 一个自由区')
  const p1 = l.positions.get('a1')
  const p2 = l.positions.get('a2')
  // 同柜内是"一圈小抖动"（半径 44），跨机房簇之间是 500+，两者数量级差一个量级
  ok(Math.abs(p1.x - p2.x) < 100 && Math.abs(p1.z - p2.z) < 100, '同机柜的机器挨在一起（远小于跨簇距离）')
  ok(p1.y !== p2.y, '同机柜内按层堆叠（Y 轴表达层）')
  const p3 = l.positions.get('a3')
  ok(Math.hypot(p3.x - p1.x, p3.z - p1.z) > 500, '不同机房的簇在 XZ 平面上分开')
  const p4 = l.positions.get('a4')
  ok(p4 !== undefined, '没有机房的资产也有位置（自由区）')

  const moved = C.computeLayout(assets, idcs, racks, { a1: { x: 9999, y: 8888, z: 7777 } })
  eq(moved.positions.get('a1'), { x: 9999, y: 8888, z: 7777 }, '人工拖动过的坐标优先于布局算法')
  eq(moved.positions.get('a2'), l.positions.get('a2'), '没拖过的节点位置不受影响')

  const empty = C.computeLayout([], [], [])
  eq(empty.positions.size, 0, '空台账不炸')
}

// ---------------------------------------------------------------- 空文档
{
  const d = M.normalizeDoc(null)
  eq(d.assets.length, 0, 'null 也能收敛成空文档')
  ok(M.normalizeView(undefined).camera.dist > 0, '视图缺省相机可用')
  eq(M.normalizeView({ camera: { dist: 999999 } }).camera.dist, 20000, '相机距离有上限')
  eq(M.normalizeView({ positions: { a: { x: 1, y: 2 } } }).positions, {}, '坐标缺 z 的条目被丢弃')
}


// ---------------------------------------------------------------- 机房 3D：端口 / 网线 / 几何
{
  // 端口清单是确定性生成：同一个 spec 永远得到同一批端口 id（网线存的就是这些 id）
  const sw = { spec: 'sw-1u-24' }
  const ports = M.portsOf(sw)
  eq(ports.filter((p) => p.group === 'nic').length, 24, '24 口交换机有 24 个电口')
  eq(ports.filter((p) => p.group === 'sfp').length, 4, '另有 4 个光口')
  ok(ports.some((p) => p.id === 'nic-24'), '端口 id 是 nic-<序号>')
  eq(M.portsOf({ spec: 'sw-1u-24' }).length, ports.length, '同规格重复调用端口数一致')
  ok(M.portsOf({}).length >= 3, '没选规格也给一组兜底端口（不会画成空面板）')

  const slots = R.portSlots({ spec: 'srv-2u' })
  eq(slots.length, M.portsOf({ spec: 'srv-2u' }).length, '每个端口都有面板位置')
  const inRange = slots.every((s) => s.u >= 0 && s.v >= 0 && s.u + s.w <= 1.001 && s.v + s.h <= 1.001)
  ok(inRange, '端口面板坐标全在 0..1 内（否则会画到机器外面）')
  const disk = slots.filter((s) => s.group === 'disk')
  const nic = slots.filter((s) => s.group === 'nic')
  ok(disk.length === 12 && disk.every((d) => d.u < 0.45), '盘位在面板左侧（真机就是这样）')
  ok(nic.every((n) => n.u >= 0.44), '网口在盘位右边，不重叠')
}

{
  // 网线：端口唯一占用、反向重复只更新、自连拒绝
  const doc = M.emptyDoc()
  doc.customers.push({ id: 'cu1', name: 'A', createdAt: NOW, updatedAt: NOW })
  doc.idcs.push({ id: 'idc1', name: 'R1', createdAt: NOW, updatedAt: NOW })
  doc.assets.push(
    { id: 'sw1', customerId: 'cu1', idcId: 'idc1', type: 'switch', name: 'sw1', ips: [], status: 'running', tags: [], meta: {}, spec: 'sw-1u-24', createdAt: NOW, updatedAt: NOW },
    { id: 'sv1', customerId: 'cu1', idcId: 'idc1', type: 'server', name: 'sv1', ips: [], status: 'running', tags: [], meta: {}, spec: 'srv-1u', createdAt: NOW, updatedAt: NOW }
  )
  const c1 = M.upsertCable(doc, { fromId: 'sv1', fromPort: 'nic-1', toId: 'sw1', toPort: 'nic-1', net: 'biz' })
  ok(c1.ok, '正常接线成功')
  eq(doc.cables.length, 1, '台账里多了一根线')
  eq(doc.cables[0].net, 'biz', '网络类型写入')

  const rev = M.upsertCable(doc, { fromId: 'sw1', fromPort: 'nic-1', toId: 'sv1', toPort: 'nic-1', net: 'mgmt' })
  ok(rev.ok, '反向重复接线返回 ok')
  eq(doc.cables.length, 1, '反向重复不会多出一根线')
  eq(doc.cables[0].net, 'mgmt', '反向重复更新网络类型')

  M.upsertCable(doc, { fromId: 'sv1', fromPort: 'nic-1', toId: 'sw1', toPort: 'nic-2', net: 'backup' })
  eq(doc.cables.length, 1, '一个端口只能插一根线：旧线被顶掉')
  eq(doc.cables[0].toPort, 'nic-2', '新线占住了端口')

  const bad = M.upsertCable(doc, { fromId: 'sv1', fromPort: 'nic-1', toId: 'sv1', toPort: 'nic-2' })
  ok(!bad.ok, '不能连自己')

  eq(M.cablesOf(doc, 'sv1').length, 1, '按设备能查到自己参与的线')
  const del = M.deleteCable(doc, doc.cables[0].id)
  ok(del && doc.cables.length === 0, '拔线成功')

  // 规范化：悬空端点 / 重复 / 非法网络类型
  const nd = M.normalizeDoc({
    customers: [{ id: 'cu1', name: 'A' }],
    idcs: [{ id: 'idc1', name: 'R1' }],
    assets: [
      { id: 'a1', customerId: 'cu1', idcId: 'idc1', type: 'server', name: 'a1' },
      { id: 'a2', customerId: 'cu1', idcId: 'idc1', type: 'server', name: 'a2' }
    ],
    cables: [
      { fromId: 'a1', fromPort: 'nic-1', toId: 'a2', toPort: 'nic-1', net: 'biz' },
      { fromId: 'a1', fromPort: 'nic-1', toId: 'a2', toPort: 'nic-1', net: 'biz' },
      { fromId: 'a1', fromPort: 'nic-2', toId: 'ghost', toPort: 'nic-1' },
      { fromId: 'a1', fromPort: 'nic-3', toId: 'a2', toPort: 'nic-3', net: '不存在的网络' }
    ]
  })
  eq(nd.cables.length, 2, '重复连线去重、悬空端点丢弃')
  eq(nd.cables.find((c) => c.fromPort === 'nic-3').net, 'biz', '非法网络类型收敛成 biz')
}

{
  // 机房几何：格子、机柜占地、U 位高度、落地设备
  const doc = M.emptyDoc()
  doc.customers.push({ id: 'cu1', name: 'A', createdAt: NOW, updatedAt: NOW })
  doc.idcs.push({ id: 'idc1', name: 'R1', cols: 8, rows: 6, tileMm: 600, createdAt: NOW, updatedAt: NOW })
  doc.racks.push({ id: 'rk1', idcId: 'idc1', code: 'A-01', uTotal: 42, widthMm: 600, depthMm: 1200, createdAt: NOW, updatedAt: NOW })
  doc.racks.push({ id: 'rk2', idcId: 'idc1', code: 'A-02', uTotal: 42, widthMm: 600, depthMm: 1200, createdAt: NOW, updatedAt: NOW })
  doc.assets.push({
    id: 'sv1', customerId: 'cu1', idcId: 'idc1', rackId: 'rk1', u: 10, uHeight: 2, spec: 'srv-2u',
    type: 'server', name: 'sv1', ips: [], status: 'running', tags: [], meta: {}, createdAt: NOW, updatedAt: NOW
  })
  doc.assets.push({
    id: 'ups1', customerId: 'cu1', idcId: 'idc1', spec: 'ups-tower',
    type: 'ups', name: 'ups1', ips: [], status: 'running', tags: [], meta: {}, createdAt: NOW, updatedAt: NOW
  })

  const room = R.roomOf(doc, 'idc1')
  eq(room.cols, 8, '机房横向 8 格')
  eq(Math.round(room.widthCm), 480, '8 格 × 60cm = 480cm 宽')
  eq(room.racks.length, 2, '两个机柜都在房间里')
  eq(room.racks[0].cols + 'x' + room.racks[0].rows, '1x2', '600×1200 的机柜占 1 格宽 2 格深')
  const [r1, r2] = room.racks
  const overlap = !(r1.col + r1.cols <= r2.col || r2.col + r2.cols <= r1.col || r1.row + r1.rows <= r2.row || r2.row + r2.rows <= r1.row)
  ok(!overlap, '自动排列的机柜不会互相压住')
  ok(r1.x >= -240 && r1.x <= 240, '机柜落在地板范围内')

  const dev = room.devices.find((d) => d.id === 'sv1')
  eq(dev.u, 10, 'U 位按录入值')
  ok(Math.abs(dev.y - (R.RACK_BASE_CM + 9 * R.U_CM + dev.h / 2)) < 0.001, '设备高度 = 底座 + (U-1) + 半高')
  ok(Math.abs(dev.h - (2 * R.U_CM - 0.35)) < 0.001, '2U 设备高 ≈ 2×44.45mm')

  const ups = room.devices.find((d) => d.id === 'ups1')
  ok(ups && !ups.rackId, '塔式 UPS 落地摆放，不占 U 位')
  ok(ups.y > 0 && ups.y < 60, '落地设备贴着地面')

  eq(R.rackSlotFree(doc, 'rk1', 9, 1), true, 'U9 在 2U 设备（U10-11）下方，空闲')
  eq(R.rackSlotFree(doc, 'rk1', 11, 2), false, 'U11-12 与 U10-11 冲突')
  eq(R.rackSlotFree(doc, 'rk1', 12, 1), true, 'U12 空闲')
  eq(R.firstFreeU(doc, 'rk1', 1, 42), 1, '从下往上找第一个空位')
  eq(R.rackOverlap(room.racks, r2.col, r2.row, 1, 2, r2.id), '', '自己和自己不算重叠')
  eq(R.rackOverlap(room.racks, r1.col, r1.row, 1, 2, r2.id), r1.code, '压到别人身上要报出对方的编号')
}

console.log(`✓ unit-cmdb：${passed} 项断言通过`)
