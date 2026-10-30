// 直连模式「租户分类 / 版本号 / 告警阈值」单测。
//
// 覆盖最近三处行为变更的纯函数部分：
//   1) META$ 内部租户的识别与业务租户判定（租户列表默认隐藏 meta、集群租户数只算业务租户）；
//   2) SELECT VERSION() 的 5.7.25-OceanBase-v4.3.5.2 → 4.3.5.2（顶部状态栏不再显示成 OCP 版本）；
//   3) 告警阈值合并的边界夹取（界面改阈值只允许落在白名单与区间内）。
//
// 只 import 两个**零依赖**模块（tenancy / alarmRules）：Node 解析不了源码里
// 无扩展名的相对导入，凡是要连 mysql2 的模块（collect / alarm）都不在这里引用。
import assert from 'node:assert/strict'
import { isMetaTenant, isSysTenant, isUserTenant, obVersionOf } from '../src/main/cloud/obdirect/tenancy.ts'
import {
  ALARM_RULE_DEFS,
  ALARM_THRESHOLDS,
  ALARM_THRESHOLD_BOUNDS,
  mergeThresholds
} from '../src/main/cloud/obdirect/alarmRules.ts'

let passed = 0
const eq = (actual, expected, why) => {
  assert.deepEqual(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
const ok = (cond, why) => {
  assert.ok(cond, why)
  passed++
}

// ---------------------------------------------------------------- 版本号
eq(obVersionOf('5.7.25-OceanBase-v4.3.5.2'), '4.3.5.2', 'MySQL 兼容前缀要剥掉，只留 OB 版本')
eq(obVersionOf('5.7.25-OceanBase_CE-v4.2.1.0'), '4.2.1.0', '社区版串同样能取出版本')
eq(obVersionOf('4.3.5.2'), '4.3.5.2', '已经是纯版本号时原样返回')
eq(obVersionOf(''), '', '空串不报错')
ok(!obVersionOf('5.7.25-OceanBase-v4.3.5.2').startsWith('5.7.25'), '不能把 MySQL 5.7 前缀当成 OB 版本')

// ---------------------------------------------------------------- 租户分类
ok(isMetaTenant('META$1002'), 'META$ 前缀是 meta 租户')
ok(isMetaTenant('whatever', 'META'), 'TENANT_TYPE=META 也认')
ok(!isMetaTenant('app_order'), '业务租户不是 meta')
ok(isSysTenant('sys'), 'sys 是系统租户')
ok(isSysTenant('SYS', 'SYS'), '大写 SYS 也认')
ok(isUserTenant({ TENANT_NAME: 'app_order', TENANT_TYPE: 'USER' }), '业务租户算 user tenant')
ok(!isUserTenant({ TENANT_NAME: 'META$1002', TENANT_TYPE: 'META' }), 'meta 不算业务租户')
ok(!isUserTenant({ TENANT_NAME: 'sys', TENANT_TYPE: 'SYS' }), 'sys 不算业务租户')
ok(!isUserTenant({ TENANT_NAME: 'sys' }), '只给名字也能识别 sys')
ok(isUserTenant({ name: 'app_pay' }), '已映射对象（name 字段）也能判断')

// ---------------------------------------------------------------- 告警阈值
eq(mergeThresholds(undefined), ALARM_THRESHOLDS, '不传配置时等于默认值')
eq(mergeThresholds({ dataDiskWarn: 70 }).dataDiskWarn, 70, '合法阈值生效')
eq(mergeThresholds({ dataDiskWarn: 10 }).dataDiskWarn, 50, '低于下界夹到 50')
eq(mergeThresholds({ dataDiskCrit: 200 }).dataDiskCrit, 100, '高于上界夹到 100')
eq(mergeThresholds({ longTxnSec: 600 }).longTxnSec, 600, '长事务阈值可调')
eq(mergeThresholds({ longTxnSec: 1 }).longTxnSec, 30, '长事务下界 30 秒')
eq(mergeThresholds({ compactionStalledHours: 999 }).compactionStalledHours, 168, '合并卡住上界 168 小时')
eq(mergeThresholds({ notAKey: 1 }).dataDiskWarn, ALARM_THRESHOLDS.dataDiskWarn, '未知键被忽略')
eq(mergeThresholds({ dataDiskWarn: NaN }).dataDiskWarn, ALARM_THRESHOLDS.dataDiskWarn, '非数字回落默认值')

for (const k of Object.keys(ALARM_THRESHOLDS)) {
  const [min, max] = ALARM_THRESHOLD_BOUNDS[k]
  ok(min < max, `${k} 的区间必须合法`)
  ok(ALARM_THRESHOLDS[k] >= min && ALARM_THRESHOLDS[k] <= max, `${k} 的默认值必须落在区间内`)
}

ok(ALARM_RULE_DEFS.length >= 6, '内置常规规则不少于 6 条')
for (const r of ALARM_RULE_DEFS) {
  ok(!!r.key && !!r.name && !!r.source, `规则 ${r.key} 必须有 key / name / source`)
  for (const t of r.thresholds) {
    ok(t.key in ALARM_THRESHOLDS, `规则 ${r.key} 的阈值键 ${t.key} 必须存在于 ALARM_THRESHOLDS`)
    ok(t.min < t.max, `规则 ${r.key} 的 ${t.key} 区间必须合法`)
  }
}
const keys = ALARM_RULE_DEFS.map((r) => r.key)
eq(new Set(keys).size, keys.length, '规则标识不能重复')

console.log(`✓ unit-obdirect-direct-rules: ${passed} 个断言通过`)
