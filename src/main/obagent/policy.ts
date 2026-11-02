/**
 * OB 故障排查 Agent · 命令安全策略
 *
 * 这个模块只有一件事：把 Agent 提出的一条 shell 命令判成三档
 *   safe    只读查询，可以自动跑
 *   confirm 只读但可能重/可能慢/可能涉及敏感信息，必须人点一下
 *   deny    改数据、改配置、重启、提权、解释执行……一律不给机会
 *
 * 为什么不用「黑名单正则」一把梭：黑名单永远漏（`find / -delete`、`sed -i`、
 * `systemctl restart`、`obclient -e "drop table"` 各是各的形态）。这里做的是
 * 先按 shell 语法拆成子命令，再对每个子命令按 argv[0] 归类，最后叠加参数级检查。
 * 拆不开的（命令替换、重定向、heredoc）直接 deny —— 判不准就不跑。
 *
 * 纯函数、不 import electron，可被单测直接导入。
 */

export type ObCmdRisk = 'safe' | 'confirm' | 'deny'

export interface ObCmdVerdict {
  risk: ObCmdRisk
  /** 命中的规则键（稳定、不翻译，便于审计与自检） */
  rule: string
  /** 给用户看的一句话 */
  reason: string
  /** 拆出来的子命令（`;` / `&&` / `||` / `|` / 换行 分隔） */
  segments: string[]
}

/** 只读白名单：命令本身不会改变主机状态 */
const SAFE_CMDS = new Set([
  // 文件查看
  'ls', 'll', 'la', 'dir', 'cat', 'tac', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'zgrep',
  'awk', 'gawk', 'mawk', 'sed', 'cut', 'paste', 'sort', 'uniq', 'wc', 'tr', 'nl', 'column',
  'fold', 'rev', 'comm', 'join', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'cksum',
  'stat', 'file', 'find', 'locate', 'which', 'whereis', 'type', 'readlink', 'realpath',
  'dirname', 'basename', 'strings', 'xxd', 'od',
  // 系统与进程
  'ps', 'pstree', 'pgrep', 'top', 'free', 'vmstat', 'iostat', 'mpstat', 'pidstat', 'sar',
  'uptime', 'w', 'who', 'whoami', 'id', 'groups', 'last', 'lastb', 'nproc', 'lscpu', 'lsblk',
  'lsmod', 'lspci', 'lsusb', 'blkid', 'dmesg', 'journalctl', 'ss', 'netstat', 'lsof',
  'ifconfig', 'ip', 'arp', 'route', 'ping', 'ping6', 'traceroute', 'tracepath', 'dig',
  'nslookup', 'host', 'getent', 'hostname', 'uname', 'arch', 'date', 'cal', 'echo', 'printf',
  'env', 'printenv', 'ulimit', 'umask', 'df', 'du', 'systemctl', 'service', 'journal',
  // OB 侧只读工具（参数级再检）
  'obclient', 'mysql', 'obd', 'obdiag'
])

/** 一票否决：写文件、改权限、重启、提权、装包、解释执行、交互式编辑器 */
const DENY_CMDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'touch', 'mkdir', 'install', 'dd', 'mkfs', 'mke2fs',
  'shred', 'truncate', 'fallocate', 'unlink', 'chmod', 'chown', 'chgrp', 'chattr', 'setfacl',
  'setcap', 'tee', 'kill', 'pkill', 'killall', 'xargs', 'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'telinit', 'crontab', 'at', 'batch', 'useradd', 'userdel', 'usermod', 'groupadd',
  'groupdel', 'passwd', 'chpasswd', 'chage', 'mount', 'umount', 'swapon', 'swapoff',
  'fdisk', 'sfdisk', 'parted', 'lvcreate', 'lvremove', 'lvextend', 'lvreduce', 'vgcreate',
  'vgremove', 'pvcreate', 'pvremove', 'dmsetup', 'mdadm', 'iptables', 'ip6tables', 'nft',
  'firewall-cmd', 'ufw', 'setenforce', 'sysctl', 'modprobe', 'insmod', 'rmmod',
  'apt', 'apt-get', 'yum', 'dnf', 'rpm', 'dpkg', 'pip', 'pip3', 'npm', 'yarn',
  'docker', 'podman', 'kubectl', 'git', 'ssh', 'scp', 'sftp', 'rsync', 'wget',
  'nc', 'ncat', 'socat', 'bash', 'sh', 'zsh', 'ksh', 'dash', 'csh', 'tcsh',
  'eval', 'exec', 'source', '.', 'sudo', 'su', 'doas', 'vi', 'vim', 'nvim', 'nano',
  'emacs', 'less', 'more', 'watch', 'ob_admin', 'ob_error', 'python', 'python3', 'perl',
  'ruby', 'node', 'php', 'curl', 'hostnamectl', 'systemd-run', 'logrotate'
])

/** 读这些文件等于拿口令/私钥，不给读 */
const SECRET_PATH = /(\/etc\/(shadow|gshadow|opasswd)\b|id_rsa|id_ed25519|\.pem\b|\.p12\b|\.jks\b|\.kdbx?\b)/i

/** SQL 里出现这些词就不是「看一眼」了 */
const SQL_WRITE = /\b(drop|truncate|alter|delete|update|insert|create|grant|revoke|replace|load|call|flush|kill|rename|purge|lock|unlock|analyze|optimize|repair|begin|commit|rollback)\b/i
const SQL_READ = /^\s*(select|show|desc|describe|explain|help|use|set\s+session|begin\s+read\s+only)\b/i

/** 命令替换 / 反引号：静态判不准，直接拒 */
const SUBSTITUTION = /(`|\$\()/

/** 允许保留的无害重定向（丢到 /dev/null、合并 stderr） */
const HARMLESS_REDIRECT = /(\d?>>?\/dev\/null|&>\/dev\/null|[12]>&[12])/g

/** 按 shell 语法拆子命令（尊重引号与转义） */
export function splitCommands(cmd: string): string[] {
  const seps = ['&&', '||', ';', '|', '&', '\n']
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += ch + cmd[i + 1]
      i++
      continue
    }
    const hit = seps.find((s) => cmd.startsWith(s, i))
    if (hit) {
      out.push(cur)
      cur = ''
      i += hit.length - 1
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 去引号后的参数切分（`grep "a b" f` → ['grep', 'a b', 'f']） */
export function tokenize(seg: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  let started = false
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]
    if (quote) {
      if (ch === quote) quote = ''
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\' && i + 1 < seg.length) {
      cur += seg[i + 1]
      i++
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

function deny(rule: string, reason: string, segments: string[]): ObCmdVerdict {
  return { risk: 'deny', rule, reason, segments }
}

function confirm(rule: string, reason: string, segments: string[]): ObCmdVerdict {
  return { risk: 'confirm', rule, reason, segments }
}

/** 单个子命令的判定 */
function classifySegment(seg: string): { risk: ObCmdRisk; rule: string; reason: string } {
  // 重定向写文件：先摘掉丢 /dev/null 的那种，剩下的 `>` 一律拒
  const cleaned = seg.replace(HARMLESS_REDIRECT, ' ')
  if (/>>?/.test(cleaned)) {
    return { risk: 'deny', rule: 'redirect', reason: '带 `>` 重定向会写文件，排障不需要写任何文件' }
  }
  if (/<</.test(cleaned)) {
    return { risk: 'deny', rule: 'heredoc', reason: 'heredoc 无法静态判断内容，不执行' }
  }

  const toks = tokenize(cleaned)
  // 去掉前置的 VAR=value（`FOO=1 ps aux` 这种）
  let i = 0
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++
  const argv = toks.slice(i)
  if (!argv.length) return { risk: 'safe', rule: 'empty', reason: '' }

  const cmd = (argv[0].split('/').pop() || '').toLowerCase()
  const args = argv.slice(1)

  if (SECRET_PATH.test(cleaned)) {
    return { risk: 'deny', rule: 'secret', reason: '这条命令触及口令/私钥文件，不允许读取' }
  }
  // mkfs 带各种后缀（mkfs.ext4 / mkfs.xfs），按前缀认
  if (/^mkfs(\.|$)/.test(cmd)) {
    return { risk: 'deny', rule: 'cmd:mkfs', reason: '格式化文件系统会丢全部数据' }
  }
  if (DENY_CMDS.has(cmd)) {
    if (cmd === 'curl') {
      const write = args.some((a) => /^(-o|-O|--output|-T|--upload-file|-d|--data|--data-raw|-F|--form|-X|--request)$/.test(a))
      return {
        risk: write ? 'deny' : 'confirm',
        rule: write ? 'curl-write' : 'curl',
        reason: write ? 'curl 会写文件或发请求体，排障不需要' : 'curl 会发网络请求（可能带出数据），需确认'
      }
    }
    return { risk: 'deny', rule: `cmd:${cmd}`, reason: `\`${cmd}\` 属于写操作/提权/交互式命令，排查阶段一律不执行` }
  }

  // ---- 需要看参数的几个 ----
  if (cmd === 'systemctl') {
    const verb = args.find((a) => !a.startsWith('-')) || ''
    const ok = ['status', 'show', 'cat', 'list-units', 'list-unit-files', 'list-dependencies', 'is-active', 'is-enabled', 'is-failed', 'list-timers']
    if (ok.includes(verb)) return { risk: 'safe', rule: 'systemctl-read', reason: '' }
    return { risk: 'deny', rule: 'systemctl-write', reason: `systemctl ${verb || '（无子命令）'} 会改变服务状态，排查阶段不执行` }
  }
  if (cmd === 'service') {
    const verb = args[1] || ''
    if (verb === 'status') return { risk: 'safe', rule: 'service-status', reason: '' }
    return { risk: 'deny', rule: 'service-write', reason: 'service 除 status 以外都会改变服务状态' }
  }
  if (cmd === 'date') {
    if (args.some((a) => a === '-s' || a === '--set' || /^\-s.+/.test(a))) {
      return { risk: 'deny', rule: 'date-set', reason: '改系统时间会影响集群一致性，绝对不执行' }
    }
    return { risk: 'safe', rule: 'date', reason: '' }
  }
  if (cmd === 'sed') {
    if (args.some((a) => a === '-i' || a.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(a))) {
      return { risk: 'deny', rule: 'sed-inplace', reason: 'sed -i 会就地改文件' }
    }
    return { risk: 'safe', rule: 'sed', reason: '' }
  }
  if (cmd === 'find') {
    if (args.some((a) => /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/.test(a))) {
      return { risk: 'deny', rule: 'find-action', reason: 'find 带 -delete / -exec 会改动文件系统' }
    }
    return { risk: 'safe', rule: 'find', reason: '' }
  }
  if (cmd === 'tail' || cmd === 'head') {
    if (args.some((a) => /^(-f|-F|--follow.*)$/.test(a))) {
      return { risk: 'confirm', rule: 'follow', reason: '持续输出（-f）会一直占用连接，需确认' }
    }
    return { risk: 'safe', rule: 'tail', reason: '' }
  }
  if (cmd === 'journalctl' && args.some((a) => /^(-f|--follow)$/.test(a))) {
    return { risk: 'confirm', rule: 'journal-follow', reason: 'journalctl -f 会持续输出，需确认' }
  }
  // --vacuum-* 会真的删 journal 文件，--rotate/--flush 也会动盘：
  // 这几个动作藏在「只读系统日志」的命令里，最容易漏
  if (cmd === 'journalctl' && args.some((a) => /^--(vacuum|rotate|flush)/.test(a))) {
    return { risk: 'deny', rule: 'journal-vacuum', reason: 'journalctl 的 --vacuum/--rotate/--flush 会删除或移动日志文件' }
  }
  if (cmd === 'timedatectl') {
    if (args.some((a) => /^set-/.test(a))) {
      return { risk: 'deny', rule: 'timedatectl-set', reason: '改系统时间会影响集群一致性，不执行' }
    }
    return { risk: 'safe', rule: 'timedatectl', reason: '' }
  }
  if (cmd === 'top' && !args.some((a) => /^(-b|-n)/.test(a))) {
    return { risk: 'confirm', rule: 'top-interactive', reason: 'top 不加 -b 是交互式界面，会挂住连接；建议 `top -bn1`' }
  }
  if (cmd === 'ip') {
    // `ip link set eth0 down` 的动词在第二个参数，不能只看 args[0]
    const write = ['set', 'add', 'del', 'delete', 'flush', 'change', 'replace']
    if (args.some((a) => write.includes(a))) {
      return { risk: 'deny', rule: 'ip-write', reason: 'ip 的增删改会改网络配置，断网就再也连不上了' }
    }
    return { risk: 'safe', rule: 'ip-read', reason: '' }
  }
  if (cmd === 'obclient' || cmd === 'mysql') {
    const ei = args.findIndex((a) => a === '-e' || a === '--execute')
    if (ei < 0) return { risk: 'deny', rule: 'sql-interactive', reason: '交互式登录会挂住连接；请用 `-e "select ..."` 形式' }
    const sql = args[ei + 1] || ''
    if (SQL_WRITE.test(sql)) return { risk: 'deny', rule: 'sql-write', reason: '这条 SQL 会改数据/结构，排查阶段不执行' }
    if (!SQL_READ.test(sql)) return { risk: 'confirm', rule: 'sql-other', reason: '不是明确的查询语句，需确认' }
    return { risk: 'safe', rule: 'sql-read', reason: '' }
  }
  if (cmd === 'obd') {
    const sub = args.filter((a) => !a.startsWith('-')).join(' ')
    if (/^(cluster (display|list)|tool list|version|env|mirror list|config (show|list))/.test(sub)) {
      return { risk: 'safe', rule: 'obd-read', reason: '' }
    }
    return { risk: 'deny', rule: 'obd-write', reason: `obd ${sub || '（无子命令）'} 可能启停/改动集群，排查阶段不执行` }
  }
  if (cmd === 'obdiag') {
    return { risk: 'confirm', rule: 'obdiag', reason: 'obdiag 采集较重（会跑一段时间），需确认' }
  }

  if (SAFE_CMDS.has(cmd)) return { risk: 'safe', rule: `safe:${cmd}`, reason: '' }
  return { risk: 'confirm', rule: `unknown:${cmd}`, reason: `\`${cmd}\` 不在只读白名单里，需人工确认` }
}

/** 主入口：一条命令 → 分档结论 */
export function classifyCommand(raw: string): ObCmdVerdict {
  const cmd = String(raw || '').trim()
  if (!cmd) return deny('empty', '空命令', [])
  if (cmd.length > 1200) return deny('too-long', '命令过长（>1200 字符），无法可靠判断', [])
  if (SUBSTITUTION.test(cmd)) {
    return deny('substitution', '含命令替换（$() 或反引号），内容在运行时才确定，无法静态判断安全', [])
  }
  const segments = splitCommands(cmd)
  if (!segments.length) return deny('empty', '空命令', [])
  if (segments.length > 8) return confirm('too-many', `这条命令串了 ${segments.length} 段子命令，需人工确认`, segments)

  let worst: ObCmdVerdict | null = null
  for (const seg of segments) {
    const r = classifySegment(seg)
    const v: ObCmdVerdict = { ...r, segments }
    if (r.risk === 'deny') return v
    if (r.risk === 'confirm') worst = v
  }
  return worst || { risk: 'safe', rule: 'ok', reason: '', segments }
}

/** 给界面用的简短标签 */
export const RISK_LABEL: Record<ObCmdRisk, string> = {
  safe: '只读',
  confirm: '需确认',
  deny: '已拦截'
}
