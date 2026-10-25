/**
 * 审计/日志落盘前的 SQL 脱敏。
 *
 * 为什么单独成文件：audit.ts 依赖 electron（app.getPath），纯函数放在这里才能被
 * `node test/unit-redact.mjs` 直接导入测试。
 *
 * 只处理"口令"这一类：DBA 在控制台执行 `ALTER USER app IDENTIFIED BY "P@ssw0rd"`
 * 或 `SET PASSWORD = '...'` 时，整条语句会进审计 JSONL（还会轮转保留），
 * 而设置页的审计查看器又会原样读出来展示。
 */
export function redactSql(sql: string): string {
  return String(sql || '')
    .replace(/(\bidentified\s+(?:by|with)\s+)('(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/gi, '$1***')
    // MySQL：SET PASSWORD [FOR user] = 'pwd' —— 必须先把 FOR user 一起吃掉，否则会被当成口令抹成 ***
    .replace(/(\bset\s+password\b(?:\s+for\s+[^\s=]+)?\s*=\s*)('(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/gi, '$1***')
    .replace(/(\bpassword\s*=\s*)('(?:[^']|'')*'|"(?:[^"]|"")*"|\S+)/gi, '$1***')
}
