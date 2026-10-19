import assert from 'node:assert/strict'
import { defaultMaskingConfig, maskText, normalizeMaskingConfig } from '../src/main/masking.ts'

const cfg = defaultMaskingConfig()
let passed = 0

// 纯文本 AWR 头部：语义代称 + 版本号/普通业务数字不误伤
let r = maskText(`DB Name         PRODDB\nInstance Name   prod1\nHost Name       db-node01.internal\nRelease         19.0.0.0.0\nIP              192.168.1.21\nUsername        APPADMIN\nContact         dba@example.com\nPhone           13812345678\nOrder No        13812345678`, 'oracle_awr', cfg)
for (const v of ['PRODDB', 'prod1', 'db-node01.internal', '192.168.1.21', 'APPADMIN', 'dba@example.com', '13812345678']) {
  assert.ok(!r.content.includes(v), `应脱敏：${v}`)
}
assert.ok(r.content.includes('19.0.0.0.0'), '数据库版本号不应按 IP 误伤')
assert.ok(/db-tuoming\d/.test(r.content), '应生成数据库名语义代称')
assert.ok(/instance-tuoming\d/.test(r.content), '应生成实例名语义代称')
assert.ok(/ip-tuoming\d/.test(r.content), '应生成 IP 语义代称')
assert.ok(r.mappings.some(m => m.original === '192.168.1.21' && /ip-tuoming\d/.test(m.replacement)), '映射备注应包含前后值')
passed++

// HTML AWR 表格列、RAC headers 属性与 JDBC 组件
r = maskText(`<table><tr><th>DB Name</th><th>DB Id</th></tr><tr><td>PRODDB</td><td>1847265112</td></tr></table><table><tr><th colspan="2">RAC</th></tr><tr><td headers="Database Id">3715357933</td><td headers="Database Name">SSSYYCDB</td></tr></table><code>jdbc:oracle:thin:@//10.10.1.8:1521/prod</code>`, 'oracle_awr', cfg)
for (const v of ['PRODDB', '1847265112', '3715357933', 'SSSYYCDB', '10.10.1.8', '@//10.10.1.8:1521/prod']) {
  assert.ok(!r.content.includes(v), `HTML/RAC/JDBC 应脱敏：${v}`)
}
assert.ok(r.content.includes('<td>db-tuoming'), 'HTML 表格应保留标签并替换值')
assert.ok(r.content.includes('dbid-tuoming'), 'RAC headers 属性应识别 DBID')
assert.ok(r.content.includes('service-tuoming'), 'JDBC 服务名应替换')
passed++

// 前后对比定位：每条 edit 同时指向原始敏感片段与替换后的片段
const sample = 'Host Name prod-db.internal IP 10.0.0.8 Username appuser'
const located = maskText(sample, 'oracle_awr', cfg)
assert.equal(located.edits.length, located.stats.reduce((a, b) => a + b.count, 0), 'edit 数量应与命中总数一致')
for (const e of located.edits) {
  const before = sample.slice(e.originalStart, e.originalEnd)
  const after = located.content.slice(e.outputStart, e.outputEnd)
  assert.notEqual(before, after, '原始片段与替换片段不应相同')
  assert.match(after, /tuoming\d+$/, `替换片段应是语义代称：${after}`)
  assert.equal(before, e.original, 'edit 应携带原始值')
  assert.equal(after, e.replacement, 'edit 应携带替换值')
}
passed++

// SQL schema、user@host、ASM；同时覆盖 AWR 说明文字和格式参数的误报场景
r = maskText(`SELECT * FROM HR.EMPLOYEES\nModule: jdbc-thin-client@prod-db-02\n+DATA/orcl/datafile.dbf FORMAT='-PROJECTION +ALIAS'\n<table summary="top segments by table scans. Owner, tablespace name">`, 'oracle_awr', cfg)
assert.ok(!r.content.includes('HR.'), 'SQL schema 限定名应脱敏')
assert.ok(!r.content.includes('prod-db-02'), 'user@host 主机应脱敏')
assert.ok(!r.content.includes('+DATA/'), 'ASM 路径前缀应脱敏')
assert.ok(r.content.includes('+ALIAS'), '计划格式参数 +ALIAS 不应误判为 ASM')
assert.ok(r.content.includes('table scans. Owner'), 'AWR 表格说明文字不应误判 schema')
passed++

// 规则关闭与自定义规则
const cfg2 = normalizeMaskingConfig(JSON.parse(JSON.stringify(cfg)))
const networkRule = cfg2.oracle_awr.rules.find(x => x.builtinId === 'awr_network')
networkRule.enabled = false
cfg2.oracle_awr.rules.push({ id: 'x1', name: '订单号', kind: 'custom', pattern: 'order[_-]?no=(\\d+)', flags: 'i', replacement: 'order-tuoming{n}', enabled: true })
r = maskText('ip=172.16.2.3 order_no=987654321', 'oracle_awr', cfg2)
assert.ok(r.content.includes('172.16.2.3'), '关闭网络规则后不应替换')
assert.ok(!r.content.includes('987654321'), '自定义规则应脱敏')
assert.ok(/order-tuoming1/.test(r.content), '自定义规则支持序号模板')
passed++

console.log(`masking 单测：${passed} 组断言全部通过`)
