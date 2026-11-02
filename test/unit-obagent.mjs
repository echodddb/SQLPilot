/**
 * OB 故障排查 Agent · 纯逻辑单测
 *
 * 这里锁的是两件「错了会出事」的事：
 *   1. 命令分档 —— 放行错一条等于把 rm -rf / 交给了模型；拦太狠又让 agent 没法干活；
 *   2. 提示词里的现场证据 —— 少写一项，模型就会凭印象编数字。
 *
 * 不测需要模型/SSH 的部分（那要真集群，走人工验证）。
 * 运行：node test/unit-obagent.mjs
 */
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

async function bundle(entry, out) {
  await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: path.join(ROOT, out),
    logLevel: 'error'
  })
  return import('file://' + path.join(ROOT, out).replace(/\\/g, '/') + `?t=${Date.now()}`)
}

const P = await bundle('src/main/obagent/policy.ts', 'output/.unit-obagent-policy.mjs')
const T = await bundle('src/main/obagent/prompt.ts', 'output/.unit-obagent-prompt.mjs')

let n = 0
const ok = (cond, msg) => {
  assert.ok(cond, msg)
  n++
}

const risk = (cmd) => P.classifyCommand(cmd).risk

// ---------- 只读白名单：DBA 排障真会敲的命令必须能自动跑 ----------
const SAFE = [
  'df -h',
  'free -m',
  'uptime',
  'ps -ef | grep [o]bserver',
  'top -bn1 | head -20',
  'tail -n 200 observer.log',
  'grep -c "errcode=-4009" observer.log',
  'cat /proc/meminfo',
  'ls -lh /home/admin/oceanbase/log',
  'du -sh /home/admin/oceanbase/log',
  'ss -lntp | grep 2881',
  'find /home/admin/oceanbase/log -name "observer.log*" -mmin -30',
  'awk "/WARN/ {print \$0}" observer.log | head -5',
  'date',
  'date "+%Y-%m-%d %H:%M:%S"',
  'systemctl status oceanbase',
  'ip addr show',
  'obd cluster display obtest',
  'obclient -h127.0.0.1 -P2881 -uroot@sys -e "show parameters like \'%memstore%\'"',
  'mysql -uroot -e "select count(*) from v$ob_units"',
  'ps -ef 2>/dev/null | grep [o]bserver',
  'dmesg | tail -50',
  'timedatectl',
  'journalctl -u oceanbase --since "10 min ago" | tail -50',
  'obclient -h127.0.0.1 -uroot@sys -e "explain select 1 from dual"',
  'grep -n "errcode=-4076" observer.log | head -3'
]
for (const c of SAFE) {
  const v = P.classifyCommand(c)
  ok(v.risk === 'safe', `应判为只读但判成 ${v.risk}：${c}（${v.rule} ${v.reason}）`)
}

// ---------- 高危：一条都不许放 ----------
const DENY = [
  'rm -rf /home/admin/oceanbase/log/*',
  'rm observer.log',
  'mv observer.log /tmp/x',
  'echo "" > observer.log',
  'echo 1 >> /etc/sysctl.conf',
  'sed -i "s/a/b/" observer.conf',
  'find / -name "observer.log" -delete',
  'kill -9 12345',
  'pkill -f observer',
  'systemctl restart oceanbase',
  'systemctl stop oceanbase',
  'service oceanbase stop',
  'reboot',
  'shutdown -h now',
  'sudo -u admin ls',
  'su - admin',
  'chmod -R 777 /home/admin',
  'chown admin:admin observer.log',
  'crontab -r',
  'dd if=/dev/zero of=/dev/sda',
  'mkfs.ext4 /dev/sdb1',
  'iptables -F',
  'sysctl -w vm.swappiness=0',
  'mount /dev/sdb1 /data',
  'bash -c "rm -rf /tmp/x"',
  'sh -c ls',
  'python3 -c "import os;os.remove(\'a\')"',
  'curl -o /tmp/x http://example.com/a',
  'obclient -h127.0.0.1 -uroot@sys -e "drop table t1"',
  'obclient -h127.0.0.1 -uroot@sys -e "delete from t1"',
  'obclient -h127.0.0.1 -uroot@sys -e "alter system major freeze"',
  'obclient -h127.0.0.1 -uroot@sys',
  'obd cluster restart obtest',
  'obd cluster destroy obtest',
  'cat /etc/shadow',
  'cat ~/.ssh/id_rsa',
  'ls $(pwd)',
  'ls `pwd`',
  'df -h; rm -rf /tmp/x',
  'ps -ef && reboot',
  'date -s "2026-01-01 00:00:00"',
  'ip link set eth0 down',
  'vi observer.log',
  'less observer.log',
  // 藏在「只读命令」里的写动作：这几个最容易漏
  'journalctl --vacuum-time=1d',
  'journalctl --rotate',
  'timedatectl set-time "2026-01-01 00:00:00"',
  'hostnamectl set-hostname ob165',
  'fallocate -l 1G /data/big',
  'unlink observer.log',
  'echo x | tee /home/admin/oceanbase/log/observer.log',
  'printf "a" | tee -a server.conf'
]
for (const c of DENY) {
  const v = P.classifyCommand(c)
  ok(v.risk === 'deny', `应被拦截但判成 ${v.risk}：${c}（${v.rule}）`)
  ok(!!v.reason, `拦截必须给出原因：${c}`)
}

// ---------- 需确认：不在白名单、或只读但会挂住连接 ----------
const CONFIRM = [
  'top',
  'tail -f observer.log',
  'journalctl -u oceanbase -f',
  'obdiag check run',
  'somenewtool --inspect',
  'curl https://example.com/health'
]
for (const c of CONFIRM) {
  const v = P.classifyCommand(c)
  ok(v.risk === 'confirm', `应判为需确认但判成 ${v.risk}：${c}（${v.rule}）`)
  ok(!!v.reason, `确认级也要给原因：${c}`)
}

// ---------- 拆分与边界 ----------
{
  ok(P.splitCommands('grep "a;b" f').length === 1, '引号内的分号不该拆开')
  ok(P.splitCommands('a && b || c | d; e').length === 5, '与或/管道/分号都要拆')
  ok(P.classifyCommand('').risk === 'deny', '空命令应拒绝')
  ok(P.classifyCommand('   ').risk === 'deny', '纯空白应拒绝')
  ok(P.classifyCommand('x'.repeat(1300)).risk === 'deny', '超长命令应拒绝')
  const many = Array.from({ length: 9 }, () => 'ls').join('; ')
  ok(P.classifyCommand(many).risk === 'confirm', '子命令过多应收紧为确认')
  ok(P.classifyCommand('ls -l').segments.length === 1, 'segments 应回传拆分结果')
  ok(P.RISK_LABEL.deny === '已拦截', '分档标签供界面直接用')
}

// ---------- 提示词：现场证据不能漏 ----------
{
  const ctx = {
    serverName: 'ob-165',
    host: 'admin@192.168.10.165',
    logDir: '/home/admin/oceanbase/log',
    scope: 'observer',
    windowStart: '2026-11-02 15:19:00',
    windowEnd: '2026-11-02 15:29:00',
    total: 65231,
    linesPerHour: 391386,
    filesScanned: 3,
    bytesScanned: 268435456,
    truncated: true,
    disk: { usePct: 88, avail: 12 * 1024 * 1024 * 1024, mount: '/data' },
    levels: [{ key: 'INFO', count: 60000 }, { key: 'WDIAG', count: 5000 }],
    summary: { level: 'watch', headline: '日志量偏高，主要是 standby 时间戳服务在重试', points: ['-4076 持续出现'] },
    hotSpots: [{ key: 'ob_standby_timestamp_service.cpp:147', count: 4123, verdict: 'bad', what: '备库时间戳服务重试', sample: '[2026-11-02 15:29:00.029138] WDIAG ...' }],
    errCodes: [{ key: '-4076', count: 4123, msg: '需要等待（OB_NEED_WAIT）', verdict: 'watch', sample: '[errcode=-4076]' }]
  }
  const block = T.contextBlock(ctx)
  for (const must of ['ob-165', 'admin@192.168.10.165', '/home/admin/oceanbase/log', '2026-11-02 15:29:00', '65231', '391386', '88%', 'INFO 60000', '需留意', 'ob_standby_timestamp_service.cpp:147', '-4076', '达上限截断']) {
    ok(block.includes(must), `现场证据缺「${must}」`)
  }
  ok(!T.contextBlock(undefined).includes('目标主机'), '无上下文时不应编造主机信息')

  const sp = T.obAgentSystemPrompt(ctx, 'auto')
  for (const must of ['只读', '关键命令', '中文', '只读命令自动执行', '现场证据']) {
    ok(sp.includes(must), `系统提示缺「${must}」`)
  }
  const sp2 = T.obAgentSystemPrompt(ctx, 'confirm')
  ok(sp2.includes('每条命令都要用户点确认'), 'confirm 模式提示词应不同')
  ok(!sp2.includes('只读命令自动执行'), 'confirm 模式不应再声称自动执行')

  ok(T.obAgentUserMessage('  为什么刷屏  ').endsWith('为什么刷屏'), '问题应去首尾空白')
}

// ---------- 输出截断：头尾都要留（错误常在尾部） ----------
{
  const long = 'A'.repeat(4000) + '中间一堆' + 'Z'.repeat(4000)
  const r = T.clipMiddle(long, 1000)
  ok(r.cut === true, '超长应标记截断')
  ok(r.text.startsWith('A'), '应保留开头')
  ok(r.text.endsWith('Z'), '应保留结尾')
  ok(r.text.length < long.length, '截断后应更短')
  const s = T.clipMiddle('short', 1000)
  ok(s.cut === false && s.text === 'short', '不超长时原样返回')
}

console.log(`unit-obagent: ${n} 项通过`)
