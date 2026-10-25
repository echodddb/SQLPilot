// 审计脱敏单测：口令不能以明文进 audit.jsonl（DBA 改口令的语句天天有）
import assert from 'node:assert/strict'
import { redactSql } from '../src/main/redact.ts'

let passed = 0
function eq(actual, expected, why) {
  assert.equal(actual, expected, `${why}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  passed++
}
function ok(cond, why) {
  assert.ok(cond, why)
  passed++
}

eq(
  redactSql('ALTER USER APP IDENTIFIED BY "P@ssw0rd"'),
  'ALTER USER APP IDENTIFIED BY ***',
  'IDENTIFIED BY 双引号口令被抹掉'
)
eq(
  redactSql("CREATE USER u IDENTIFIED BY 'x;y'"),
  'CREATE USER u IDENTIFIED BY ***',
  '单引号口令（含分号）被抹掉'
)
eq(
  redactSql('alter profile default limit password_life_time 90'),
  'alter profile default limit password_life_time 90',
  '不含口令赋值的语句不动'
)
eq(redactSql("SET PASSWORD = 'abc123'"), 'SET PASSWORD = ***', 'SET PASSWORD 被抹掉')
eq(redactSql("set password for u = 'abc'"), 'set password for u = ***', 'MySQL SET PASSWORD FOR 只抹口令')
eq(redactSql('UPDATE t SET password = \'p\' WHERE id=1'), 'UPDATE t SET password = *** WHERE id=1', 'PASSWORD = 赋值被抹掉')
ok(!redactSql('ALTER USER APP IDENTIFIED BY "P@ssw0rd"').includes('P@ssw0rd'), '明文口令不残留')
ok(redactSql('SELECT * FROM t WHERE note = \'a--b\'').includes("'a--b'"), '普通字符串不受影响')

console.log(`\x1b[32m✓ unit-redact: ${passed} 个断言通过\x1b[0m`)
