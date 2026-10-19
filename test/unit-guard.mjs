// SQL 守门器单元测试：直接导入真实 guard.ts（Node 24 原生 TS 剥离），杜绝"镜像实现"漂移。
// 覆盖：读语句放行 / 字符串与引号标识符免疫 / 注释处理（含 MySQL 可执行注释）/
//       多语句与写子句拦截 / WITH FUNCTION 载荷 / 各类别首词分类。
// 注：注释定界符用 Unicode 转义拼装（\u002f\u002a = "/*"），避免测试源码本身的边界组合干扰解析。
import assert from 'node:assert/strict'
import { classifySql } from '../src/main/db/guard.ts'

const OC = '\u002f\u002a'   // 块注释开
const CC = '\u002a\u002f'   // 块注释闭
const EC = `\u002f\u002a!`  // MySQL 可执行注释开

let passed = 0
function allow(sql) {
  const v = classifySql(sql)
  assert.equal(v.ok, true, `应放行: ${sql} => ${JSON.stringify(v)}`)
  assert.equal(v.kind, 'read', `应为 read: ${sql} => ${JSON.stringify(v)}`)
  passed++
}
function reject(sql, kind, why) {
  const v = classifySql(sql)
  assert.equal(v.ok, false, `应拒绝: ${sql} => ${JSON.stringify(v)}`)
  if (kind) assert.equal(v.kind, kind, `应为 ${kind}: ${sql} => ${JSON.stringify(v)}`)
  if (why) assert.ok(v.reason?.includes(why), `reason 应含「${why}」: ${JSON.stringify(v)}`)
  passed++
}

// ---------- 正常读语句放行 ----------
allow('SELECT * FROM t')
allow('select 1')
allow('SELECT a, b FROM t WHERE a = 1 ORDER BY b')
allow("SELECT 'it''s ok' FROM t")                     // '' 转义
allow("SELECT q'[a;b]' FROM t")                       // q 定界 + 分号在串内
allow("SELECT q'#x#y#' FROM t")                       // q 单字符定界
allow("SELECT q'{p}' FROM dual")
allow('SELECT "odd;col" FROM t')                      // ANSI 引号标识符含分号
allow('SELECT "say ""hi""" FROM t')                   // "" 转义
allow('SELECT `odd;name` FROM t')                     // MySQL 反引号含分号
allow('SELECT `a``b` FROM t')                         // `` 转义
allow('WITH x AS (SELECT 1) SELECT * FROM x')
allow('EXPLAIN SELECT 1')
allow('EXPLAIN PLAN FOR SELECT 1')
allow('SHOW TABLES')
allow('DESC t')
allow('DESCRIBE t')
allow(`${OC}+ full(t) ${CC} SELECT 1 FROM t`)         // Oracle hint
allow(`${OC} header ${CC} SELECT 1 -- tail`)          // 前后注释
allow('SELECT 1 # mysql 行注释')
allow(`SELECT 'a${OC}b${CC}c' FROM t`)                // 注释符在字符串内
allow("SELECT 'a--b' FROM t")
allow("SELECT 'a#b' FROM t")
allow('SELECT 1;')                                    // 单条尾分号
allow('SELECT 1 \n FROM t \n -- c')                   // 多行 + 尾注释

// ---------- P0 回归：字符串边界 / 可执行注释 ----------
reject(`SELECT 'a${OC}'; DROP TABLE x ${OC}b${CC}`, 'multi')          // P0-1 注释剥离跨字符串边界
reject(`SELECT ${OC}'${CC}; DROP TABLE x`, 'multi')          // 变体：注释含引号且闭合，藏多语句
reject(`SELECT 'x' INTO ${EC} OUTFILE ${CC} '/tmp/x'`, 'dml', '写文件') // P0-2 MySQL 可执行注释
reject(`${EC}50003 DROP TABLE x ${CC}`, 'ddl')                        // 版本形式，内容按代码保留
reject(`SELECT 1 ${EC}; DROP TABLE t ${CC}`, 'multi')                 // 可执行注释藏多语句
{
  // 可执行注释内容保留进"纯语句"但不改变首词：仍是读，放行
  const v = classifySql(`SELECT 'a' ${EC} password ${CC} FROM u`)
  assert.equal(v.ok, true)
  passed++
}

// ---------- 多语句 ----------
reject('SELECT 1; SELECT 2', 'multi', '2 条')
reject('SELECT 1; DELETE FROM t', 'multi')
reject(`SELECT 1 ${OC};${CC} ; UPDATE t SET a=1`, 'multi')
reject('BEGIN NULL; END', 'multi')                    // PL/SQL 块含分号 → multi 先拦
reject('DECLARE v NUMBER; BEGIN NULL; END', 'multi')

// ---------- WITH 载荷 ----------
reject('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'dml', '写操作')
reject('WITH x AS (SELECT 1) UPDATE t SET a=1', 'dml')
// P0-3：WITH FUNCTION + 自治事务（有分号变体：multi 先拦）
reject(`WITH FUNCTION f RETURN NUMBER AS PRAGMA AUTONOMOUS_TRANSACTION; BEGIN EXECUTE IMMEDIATE 'DROP TABLE x'; RETURN 1; END; SELECT f() FROM dual`, 'multi')
// 无分号变体：FUNCTION/PRAGMA/EXECUTE IMMEDIATE 载荷拦截
reject(`WITH FUNCTION f RETURN NUMBER AS BEGIN EXECUTE IMMEDIATE 'DROP TABLE x' RETURN 1 END SELECT f() FROM dual`, 'plsql', 'PL/SQL')
reject('WITH PROCEDURE p AS BEGIN NULL END SELECT 1 FROM dual', 'plsql', 'PL/SQL')

// ---------- 读语句内的写语义 ----------
reject('SELECT * FROM t FOR UPDATE', 'dml', '锁定')
reject('SELECT * FROM t LOCK IN SHARE MODE', 'dml', '锁定')
reject("SELECT * INTO OUTFILE '/tmp/x' FROM t", 'dml', '写文件')
reject("SELECT * INTO DUMPFILE '/tmp/x' FROM t", 'dml', '写文件')
reject('SELECT * INTO new_table FROM t', 'ddl', 'SELECT INTO')
reject('EXPLAIN ANALYZE DELETE FROM t', 'dml', 'EXPLAIN')

// ---------- 各类别首词 ----------
reject('INSERT INTO t VALUES (1)', 'dml')
reject('UPDATE t SET a = 1', 'dml')
reject('DELETE FROM t', 'dml')
reject('MERGE INTO t USING s ON (1=1) WHEN matched THEN UPDATE SET t.a=s.a', 'dml')
reject('REPLACE INTO t VALUES (1)', 'dml')
reject('CREATE TABLE t (a INT)', 'ddl')
reject('ALTER TABLE t ADD (a INT)', 'ddl')
reject('DROP TABLE t', 'ddl')
assert.equal(classifySql('DROP TABLE t').risk, 3); passed++
reject('TRUNCATE TABLE t', 'ddl')
assert.equal(classifySql('TRUNCATE TABLE t').risk, 3); passed++
reject('GRANT ALL ON t TO u', 'ddl')
reject('REVOKE ALL ON t FROM u', 'ddl')
reject('FLASHBACK TABLE t TO BEFORE DROP', 'ddl')
reject('PURGE RECYCLEBIN', 'ddl')
reject('KILL 123', 'kill')
reject('SHUTDOWN', 'kill')
reject('STARTUP', 'kill')
reject('EXEC p', 'plsql')
reject('EXECUTE p', 'plsql')
reject('CALL p', 'plsql')
reject('SET TRANSACTION READ ONLY', 'plsql')

// ---------- 其他 ----------
reject('', 'unknown', '空')
reject('   ', 'unknown', '空')
reject(`-- 只有注释`, 'unknown', '空')
reject(`${OC} 只有注释 ${CC}`, 'unknown', '空')
reject('(SELECT 1)', 'unknown', '无法识别')
reject('LOAD DATA INFILE', 'dml')

// ---------- 方言化：MySQL / Oracle 的注释与转义规则不同 ----------
const my = (s) => classifySql(s, 'mysql')
const ora = (s) => classifySql(s, 'oracle')

// MySQL 的 `--` 必须跟空白才算注释：`0--1` 是算术表达式，不能把后面的子句截掉
let mv = my("SELECT 0--1 INTO OUTFILE '/tmp/x'")
assert.equal(mv.ok, false, `MySQL --1 不得绕过: ${JSON.stringify(mv)}`)
passed++
mv = my('SELECT * FROM t WHERE id = 1--1 FOR UPDATE')
assert.equal(mv.ok, false, `MySQL --1 不得隐藏 FOR UPDATE: ${JSON.stringify(mv)}`)
passed++
mv = my('SELECT 1 -- 正常注释')
assert.equal(mv.ok, true, `MySQL -- 后跟空白仍是注释: ${JSON.stringify(mv)}`)
passed++
mv = my('SELECT 1 # 行注释')
assert.equal(mv.ok, true, `MySQL # 是注释: ${JSON.stringify(mv)}`)
passed++

// MySQL 默认把 \ 当转义符：'a\'' 提前结束字符串，后续 INTO OUTFILE 必须暴露
mv = my("SELECT 'a\\'' INTO OUTFILE '/tmp/x'")
assert.equal(mv.ok, false, `MySQL \\' 不得绕过: ${JSON.stringify(mv)}`)
passed++
mv = my('SELECT "a\\"" INTO OUTFILE "/tmp/x"')
assert.equal(mv.ok, false, `MySQL 双引号 \\" 不得绕过: ${JSON.stringify(mv)}`)
passed++

// Oracle 的 # 是合法标识符字符，不能当行注释截断
let ov = ora('SELECT e.* FROM t e# WHERE 1=1 FOR UPDATE')
assert.equal(ov.ok, false, `Oracle # 不得截断 FOR UPDATE: ${JSON.stringify(ov)}`)
passed++
ov = ora('SELECT 1 -- 注释')
assert.equal(ov.ok, true, `Oracle -- 是注释: ${JSON.stringify(ov)}`)
passed++

// 高危 DDL/PLSQL 提到 risk 3（会话放行不得覆盖账号/权限变更）
assert.equal(ora('GRANT DBA TO x').risk, 3, 'GRANT 应为 risk 3')
passed++
assert.equal(ora('ALTER USER u IDENTIFIED BY p').risk, 3, 'ALTER USER 应为 risk 3')
passed++
assert.equal(ora('ALTER TABLE t ADD c NUMBER').risk, 2, '普通 ALTER TABLE 仍为 risk 2')
passed++
assert.equal(ora('CALL p()').risk, 3, 'CALL 应为 risk 3')
passed++

console.log(`guard 单测：${passed} 组断言全部通过`)
