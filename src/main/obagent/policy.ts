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
 * 拆不开的（命令替换、重定向、heredoc、进程替换、变量展开）直接 deny —— 判不准就不跑。
 *
 * 三条硬约束（改这个文件前先读）：
 *   1. 判不准 → deny。`unknown` 也是 deny，宁可让模型换个查法，也不给一次点击的机会。
 *   2. 包装器（env / time / nice / timeout / xargs / sudo …）一律 deny。
 *      它们的 argv[0] 是包装器本身，真正的命令藏在参数里，递归解析必漏。
 *   3. 白名单只管「命令名」，参数级危险动作要单独拦：sed 的 e/w、awk 的 system()、
 *      sort -o、uniq 的第二位置参数、ifconfig eth0 down 都属于「命令只读但参数能写」。
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

/** 只读白名单：命令本身不会改变主机状态（参数级危险动作另有机检查） */
const SAFE_CMDS = new Set([
  // 文件查看
  'ls', 'cat', 'tac', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'zgrep',
  'cut', 'paste', 'wc', 'tr', 'nl', 'column',
  'fold', 'rev', 'comm', 'join', 'diff', 'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'cksum',
  'stat', 'file', 'find', 'locate', 'which', 'whereis', 'type', 'readlink', 'realpath',
  'dirname', 'basename', 'strings', 'od',
  // 系统与进程
  'ps', 'pstree', 'pgrep', 'free', 'pidstat',
  'uptime', 'w', 'who', 'whoami', 'id', 'groups', 'last', 'lastb', 'nproc', 'lscpu', 'lsblk',
  'lsmod', 'lspci', 'lsusb', 'blkid', 'netstat', 'lsof', 'ss',
  'uname', 'arch', 'date', 'cal', 'echo', 'printf',
  'printenv', 'ulimit', 'umask', 'df', 'du',
  // OB 侧只读工具（参数级再检）
  'obclient', 'mysql', 'obd', 'obdiag'
])

/**
 * 命令包装器：argv[0] 是它，真正的命令在参数里。
 * 不递归解析（`env -i A=1 cmd` 这类变体太多，递归必漏），直接拒。
 */
const WRAPPER_CMDS = new Set([
  'env', 'time', 'nice', 'nohup', 'timeout', 'stdbuf', 'ionice', 'chroot',
  'setsid', 'command', 'builtin', 'xargs', 'sudo', 'su', 'doas', 'parallel',
  'watch', 'script', 'unshare', 'nsenter'
])

/** 一票否决：写文件、改权限、重启、提权、装包、解释执行、交互式编辑器 */
const DENY_CMDS = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'ln', 'touch', 'mkdir', 'install', 'dd', 'mkfs', 'mke2fs',
  'shred', 'truncate', 'fallocate', 'unlink', 'chmod', 'chown', 'chgrp', 'chattr', 'setfacl',
  'setcap', 'tee', 'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'telinit', 'crontab', 'at', 'batch', 'useradd', 'userdel', 'usermod', 'groupadd',
  'groupdel', 'passwd', 'chpasswd', 'chage', 'mount', 'umount', 'swapon', 'swapoff',
  'fdisk', 'sfdisk', 'parted', 'lvcreate', 'lvremove', 'lvextend', 'lvreduce', 'vgcreate',
  'vgremove', 'pvcreate', 'pvremove', 'dmsetup', 'mdadm', 'iptables', 'ip6tables', 'nft',
  'firewall-cmd', 'ufw', 'setenforce', 'sysctl', 'modprobe', 'insmod', 'rmmod',
  'apt', 'apt-get', 'yum', 'dnf', 'rpm', 'dpkg', 'pip', 'pip3', 'npm', 'yarn',
  'docker', 'podman', 'kubectl', 'git', 'ssh', 'scp', 'sftp', 'rsync', 'wget',
  'nc', 'ncat', 'socat', 'bash', 'sh', 'zsh', 'ksh', 'dash', 'csh', 'tcsh',
  'eval', 'exec', 'source', '.', 'vi', 'vim', 'nvim', 'nano',
  'emacs', 'less', 'more', 'ob_admin', 'ob_error', 'python', 'python3', 'perl',
  'ruby', 'node', 'php', 'curl', 'hostnamectl', 'systemd-run', 'logrotate'
])

/**
 * 读这些文件等于拿口令/私钥，不给读。
 * 注意：匹配前路径会被 normPath() 折叠（`/etc/./shadow`、`/etc//shadow` 都要命中）。
 */
const SECRET_PATH = /(\/etc\/(security\/)?(shadow|gshadow|opasswd|sudoers)\b|id_(rsa|dsa|ecdsa|ed25519)\b|ssh_host_\w+_key|\.pem\b|\.p12\b|\.jks\b|\.kdbx?\b|\.my\.cnf\b|\.obclient\b|\/proc\/\d+\/environ\b|\/proc\/\d+\/cmdline\b)/i

/** SQL 里出现这些词就不是「看一眼」了 */
const SQL_WRITE = /\b(drop|truncate|alter|delete|update|insert|create|grant|revoke|replace|load|call|flush|kill|rename|purge|lock|unlock|analyze|optimize|repair|begin|commit|rollback)\b/i
const SQL_READ = /^\s*(select|show|desc|describe|explain|help|use|set\s+session|begin\s+read\s+only)\b/i

/** 命令替换 / 反引号：静态判不准，直接拒 */
const SUBSTITUTION = /(`|\$\()/

/** 进程替换：`cat <(rm -rf /)` 里 rm 是 bash 子进程，只看 argv[0] 会漏 */
const PROC_SUB = /[<>]\(/

/**
 * 这些规则键永远不允许被「以后同类都执行」记住。
 * 它们的共同点是「一条规则覆盖一类命令」，记住一次等于给整类开后门。
 */
export const AUTO_MEMO_DENY: ReadonlySet<string> = new Set([
  'too-many', 'follow', 'journal-follow', 'sql-other', 'obdiag',
  'top-interactive', 'interval-missing', 'awk-io', 'sed-maybe-exec'
])

/** 规则键是否允许被记忆为「以后同类都执行」 */
export function autoMemoAllowed(rule: string): boolean {
  if (!rule) return false
  if (AUTO_MEMO_DENY.has(rule)) return false
  // unknown / deny / 语法级拦截：记住它们要么没意义，要么覆盖一整类畸形命令
  return !/^(unknown|cmd|wrapper|redirect|heredoc|proc-sub|var-expand|substitution):?/.test(rule)
}

/**
 * 摘掉无害重定向：`2>&1` / `2>/dev/null` / `&>/dev/null`。
 *
 * 必须在 splitCommands 之前做 —— 否则 `2>&1` 里的 `&` 会被当成分隔符，
 * 段尾剩一个 `2>`，被 `>` 检查误判成写文件。DBA 排障时这是肌肉记忆，
 * 误杀会让模型反复重试、白烧配额。
 */
export function stripHarmlessRedirect(cmd: string): string {
  return cmd
    .replace(/&>>?\s*\/dev\/null/g, ' ')
    .replace(/\d?>>?\s*\/dev\/null/g, ' ')
    .replace(/[12]>&[12]/g, ' ')
}

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

/** 折叠 `//`、`/./`、`..`，让 `cat /etc/./shadow` 也按 `/etc/shadow` 匹配 */
function normPath(s: string): string {
  const p = String(s || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return '/' + out.join('/')
}

/**
 * 去掉引号内的内容，只留 shell 真正会解释的部分。
 * `awk '$3 > 100'` 里的 `>` 是 awk 的比较运算符，不是重定向；引号内的
 * `>` `<(` 都是纯文本，判 shell 语法前必须先剔掉。
 */
function stripQuoted(s: string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '\\') { i++; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    out += ch
  }
  return out
}

/** 单引号之外的 `$`：`$IFS`、`${x}`、`$a`、`$'...'` 展开后才是真正的命令，静态看不出来 */
function hasVarOutsideSingleQuote(s: string): boolean {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      // 双引号内 `$` 照样展开，继续查；只需处理转义
      if (ch === '\\') { i++; continue }
      if (ch === '"') { quote = ''; continue }
      if (ch === '$') {
        // `awk "... {print $0}"` 里的 $0/$1/$NF 是字段引用，展开成 shell 位置参数
        // 也不会变成命令；真正危险的是 $IFS / ${x} / $a 这类变量名
        const nx = s[i + 1] || ''
        if (/[0-9@#?$*!]/.test(nx)) { i++; continue }
        return true
      }
      continue
    }
    if (ch === '\\') { i++; continue }
    if (ch === "'") { quote = "'"; continue }
    if (ch === '"') { quote = '"'; continue }
    if (ch === '$') return true
  }
  return false
}

/** 收集 sed 的脚本：`-e` 的值 + 第一个非选项参数（没有 -e/-f 时它就是脚本） */
function sedScripts(args: string[]): string[] {
  const out: string[] = []
  let hasEFlag = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-e' || a === '--expression') { out.push(args[i + 1] || ''); hasEFlag = true; i++; continue }
    if (a.startsWith('--expression=')) { out.push(a.slice('--expression='.length)); hasEFlag = true }
  }
  if (!hasEFlag) {
    const first = args.find((a) => !a.startsWith('-'))
    if (first) out.push(first)
  }
  return out
}

/**
 * sed 脚本里能执行/能写文件的命令：
 *   `1e rm -rf /x`（GNU sed 的 e 直接执行）、`w /tmp/x`（写文件）、`r`（读任意文件）
 * 以及 `s///e`、`s///w` 这两个标志。
 */
function sedDangerousScript(src: string): boolean {
  if (!src) return false
  // 命令位置：行首 / ; 后 / } 后，可选地址（数字、$、/re/），然后是 e w W r R
  const cmdPos = /(^|[;{}\n])\s*(?:\d+|\$|\/(?:\\.|[^/\\])*\/)?\s*[eEwWrR](?=[\s;}\n]|$)/
  if (cmdPos.test(src)) return true
  // s///e 或 s///w
  const sFlag = /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[a-zA-Z]*[ewW]/
  if (sFlag.test(src)) return true
  return /\bsystem\s*\(|\bexec\s*\(/.test(src)
}

/**
 * awk 程序能执行命令（system）或读写文件（getline / print > file）。
 * `print $3 > 100` 在 awk 语法里本来就是重定向到文件 "100"，不是比较 —— 所以
 * 「print/printf 语句里出现 > 或 |」这个判据是准的，不会误伤 `$3 > 100`。
 */
function awkDangerousScript(src: string): boolean {
  if (!src) return false
  if (/\bsystem\s*\(|\bclose\s*\(|\bENVIRON\b/.test(src)) return true
  if (/\bgetline\b/.test(src)) return true
  if (/[|]/.test(src) && /\bgetline\b/.test(src)) return true
  if (/(print|printf)[^;\n]*[>|]/.test(src)) return true
  return false
}

/** 单个子命令的判定 */
function classifySegment(seg: string): { risk: ObCmdRisk; rule: string; reason: string } {
  // 重定向写文件：先摘掉丢 /dev/null 的那种，剩下的 `>` 一律拒
  const cleaned = stripHarmlessRedirect(seg)
  // shell 语法检查只看引号外的部分：引号里的 `>` 是数据，不是重定向
  const bare = stripQuoted(cleaned)
  if (PROC_SUB.test(bare)) {
    return { risk: 'deny', rule: 'proc-sub', reason: '含进程替换 `<(...)`，里面的命令会在子进程里执行，无法静态判断' }
  }
  if (/>>?/.test(bare)) {
    return { risk: 'deny', rule: 'redirect', reason: '带 `>` 重定向会写文件，排障不需要写任何文件' }
  }
  if (/<</.test(bare)) {
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
  // SQL 语句里的 `v$ob_units` / `$` 是标识符的一部分，不是 shell 变量
  const isSql = cmd === 'obclient' || cmd === 'mysql'

  for (const a of argv) {
    const p = normPath(a)
    if (SECRET_PATH.test(p) || SECRET_PATH.test(a)) {
      return { risk: 'deny', rule: 'secret', reason: '这条命令触及口令/私钥文件，不允许读取' }
    }
    // /etc/shado? / /etc/shado[w] 展开后就是 shadow，带 glob 的敏感路径一律拒
    if (/[?*[]/.test(a) && /^(etc|root\/\.ssh|home\/[^/]+\/\.ssh|proc)/.test(p.replace(/^\//, ''))) {
      return { risk: 'deny', rule: 'secret-glob', reason: '用通配符拼敏感路径（如 /etc/shado?）等于绕过路径检查，不执行' }
    }
  }
  if (!isSql && hasVarOutsideSingleQuote(cleaned)) {
    return { risk: 'deny', rule: 'var-expand', reason: '含 shell 变量展开（$IFS / ${x} / $a），真实命令在运行时才拼出来，无法静态判断' }
  }

  // 包装器：真正的命令藏在参数里，不递归解析，直接拒
  if (WRAPPER_CMDS.has(cmd)) {
    return { risk: 'deny', rule: `wrapper:${cmd}`, reason: `\`${cmd}\` 是命令包装器，参数里可以塞任意命令，排查阶段不执行` }
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
    if (args.some((a) => a === '-s' || a === '--set' || /^\-s.+/.test(a) || /^--set=/.test(a))) {
      return { risk: 'deny', rule: 'date-set', reason: '改系统时间会影响集群一致性，绝对不执行' }
    }
    return { risk: 'safe', rule: 'date', reason: '' }
  }
  if (cmd === 'sed') {
    if (args.some((a) => a === '-i' || a.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(a))) {
      return { risk: 'deny', rule: 'sed-inplace', reason: 'sed -i 会就地改文件' }
    }
    // -f 把脚本放到文件里，静态看不到内容
    if (args.some((a) => a === '-f' || a.startsWith('--file') || /^-[a-zA-Z]*f/.test(a))) {
      return { risk: 'deny', rule: 'sed-script-file', reason: 'sed -f 从文件读取脚本，无法判断脚本内容' }
    }
    for (const src of sedScripts(args)) {
      if (sedDangerousScript(src)) {
        return { risk: 'deny', rule: 'sed-exec', reason: 'sed 脚本里的 e/w/r 命令能执行命令或写文件（如 `1e rm -rf /x`），不执行' }
      }
    }
    return { risk: 'safe', rule: 'sed', reason: '' }
  }
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk' || cmd === 'nawk') {
    if (args.some((a) => a === '-f' || a.startsWith('--file'))) {
      return { risk: 'deny', rule: 'awk-script-file', reason: 'awk -f 从文件读取脚本，无法判断脚本内容' }
    }
    const prog = args.filter((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)).join(' ')
    if (awkDangerousScript(prog)) {
      return { risk: 'deny', rule: 'awk-exec', reason: 'awk 的 system()/getline/print 重定向能执行命令或写文件，不执行' }
    }
    return { risk: 'safe', rule: 'awk', reason: '' }
  }
  if (cmd === 'sort') {
    if (args.some((a) => /^(-o|--output|--compress-program)/.test(a))) {
      return { risk: 'deny', rule: 'sort-write', reason: 'sort -o 会就地覆盖文件，--compress-program 会执行外部程序' }
    }
    return { risk: 'safe', rule: 'sort', reason: '' }
  }
  if (cmd === 'uniq') {
    const pos = args.filter((a) => !a.startsWith('-'))
    if (pos.length >= 2) {
      return { risk: 'deny', rule: 'uniq-write', reason: 'uniq 的第二个位置参数是输出文件，会写文件' }
    }
    return { risk: 'safe', rule: 'uniq', reason: '' }
  }
  if (cmd === 'xxd') {
    if (args.some((a) => /^-[a-zA-Z]*r/.test(a))) {
      return { risk: 'deny', rule: 'xxd-revert', reason: 'xxd -r 会把十六进制还原成二进制写文件' }
    }
    return { risk: 'safe', rule: 'xxd', reason: '' }
  }
  if (cmd === 'ifconfig') {
    const pos = args.filter((a) => !a.startsWith('-'))
    const opt = args.filter((a) => a.startsWith('-'))
    const risky = pos.length > 1 || opt.some((a) => !/^-(a|s|v)$/.test(a))
    if (risky) {
      return { risk: 'deny', rule: 'ifconfig-write', reason: `ifconfig 带地址/掩码/up/down 参数会改网络配置（${args.join(' ')}），断网就再也连不上` }
    }
    return { risk: 'safe', rule: 'ifconfig-read', reason: '' }
  }
  if (cmd === 'route') {
    const words = args.filter((a) => !a.startsWith('-'))
    if (words.some((w) => /^(add|del|delete|flush)$/i.test(w))) {
      return { risk: 'deny', rule: 'route-write', reason: 'route add/del/flush 会改路由表，断网就再也连不上' }
    }
    return { risk: 'safe', rule: 'route-read', reason: '' }
  }
  if (cmd === 'arp') {
    if (args.some((a) => /^-(d|s|f)$/.test(a) || /^-[a-zA-Z]*[dsf]/.test(a))) {
      return { risk: 'deny', rule: 'arp-write', reason: 'arp -d/-s 会改 ARP 表' }
    }
    return { risk: 'safe', rule: 'arp-read', reason: '' }
  }
  if (cmd === 'hostname') {
    const pos = args.filter((a) => !a.startsWith('-'))
    if (pos.length || args.some((a) => /^(-F|--file|-b|--boot)$/.test(a))) {
      return { risk: 'deny', rule: 'hostname-set', reason: 'hostname 带参数是在改主机名，会影响集群识别' }
    }
    return { risk: 'safe', rule: 'hostname-read', reason: '' }
  }
  if (cmd === 'dmesg') {
    if (args.some((a) => /^(-c|-C|--clear|--read-clear|-n|--console-level)(=.*)?$/.test(a) || /^-[a-zA-Z]*[cCn]/.test(a))) {
      return { risk: 'deny', rule: 'dmesg-clear', reason: 'dmesg -c 会清空内核环形缓冲区，把排障现场一起销毁' }
    }
    if (args.some((a) => /^(-w|-W|--follow)$/.test(a))) {
      return { risk: 'confirm', rule: 'follow', reason: 'dmesg -w 会持续输出，需确认' }
    }
    return { risk: 'safe', rule: 'dmesg', reason: '' }
  }
  if (cmd === 'find') {
    if (args.some((a) => /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/.test(a))) {
      return { risk: 'deny', rule: 'find-action', reason: 'find 带 -delete / -exec 会改动文件系统' }
    }
    return { risk: 'safe', rule: 'find', reason: '' }
  }
  if (cmd === 'tail' || cmd === 'head') {
    // 合并短选项也要认：`tail -fn 10` / `journalctl -fu xxx`
    if (args.some((a) => /^-[a-zA-Z]*[fF]/.test(a) || /^--follow/.test(a))) {
      return { risk: 'confirm', rule: 'follow', reason: '持续输出（-f）会一直占用连接，需确认' }
    }
    return { risk: 'safe', rule: 'tail', reason: '' }
  }
  if (cmd === 'journalctl') {
    if (args.some((a) => /^-[a-zA-Z]*[fF]/.test(a) || /^--follow/.test(a))) {
      return { risk: 'confirm', rule: 'journal-follow', reason: 'journalctl -f 会持续输出，需确认' }
    }
    // --vacuum-* 会真的删 journal 文件，--rotate/--flush 也会动盘：
    // 这几个动作藏在「只读系统日志」的命令里，最容易漏
    if (args.some((a) => /^--(vacuum|rotate|flush)/.test(a))) {
      return { risk: 'deny', rule: 'journal-vacuum', reason: 'journalctl 的 --vacuum/--rotate/--flush 会删除或移动日志文件' }
    }
    return { risk: 'safe', rule: 'journalctl', reason: '' }
  }
  if (cmd === 'timedatectl') {
    if (args.some((a) => /^set-/.test(a))) {
      return { risk: 'deny', rule: 'timedatectl-set', reason: '改系统时间会影响集群一致性，不执行' }
    }
    return { risk: 'safe', rule: 'timedatectl', reason: '' }
  }
  if (cmd === 'top') {
    // -b 只是批处理模式，不给 -n 照样无限刷屏，必须两者都有
    if (!args.some((a) => /^-[a-zA-Z]*b/.test(a)) || !args.some((a) => /^-[a-zA-Z]*n/.test(a) || a === '-n')) {
      return { risk: 'confirm', rule: 'top-interactive', reason: 'top 需要 `-b` 并且给 `-n 次数`，否则会一直刷屏挂住连接；建议 `top -bn1`' }
    }
    return { risk: 'safe', rule: 'top', reason: '' }
  }
  if (cmd === 'ping' || cmd === 'ping6') {
    if (args.some((a) => /^-[a-zA-Z]*f/.test(a))) {
      return { risk: 'deny', rule: 'ping-flood', reason: 'ping -f 是 flood 模式，会给网络造成压力' }
    }
    if (!args.some((a) => /^(-c|--count)/.test(a))) {
      return { risk: 'confirm', rule: 'interval-missing', reason: 'ping 不带 -c 会一直发，需确认（建议 `ping -c 4`）' }
    }
    return { risk: 'safe', rule: 'ping', reason: '' }
  }
  if (cmd === 'vmstat' || cmd === 'iostat' || cmd === 'mpstat' || cmd === 'sar' || cmd === 'pidstat') {
    // 第一个位置参数是间隔，第二个是次数；只给间隔就是无限刷
    const nums = args.filter((a) => /^\d+$/.test(a))
    if (nums.length < 2) {
      return { risk: 'confirm', rule: 'interval-missing', reason: `${cmd} 需要同时给间隔和次数（如 \`${cmd} 1 3\`），否则会一直刷屏挂住连接` }
    }
    return { risk: 'safe', rule: cmd, reason: '' }
  }
  if (cmd === 'ip') {
    // `ip link set eth0 down` 的动词在第二个参数，不能只看 args[0]；
    // netns exec / -batch 能执行任意命令，必须单独拦
    if (args.some((a) => /^(exec|netns|batch|monitor|-batch)$/.test(a))) {
      return { risk: 'deny', rule: 'ip-exec', reason: 'ip netns exec / -batch 能执行任意命令，排查阶段不执行' }
    }
    const write = ['set', 'add', 'del', 'delete', 'flush', 'change', 'replace', 'attach', 'detach']
    if (args.some((a) => write.includes(a))) {
      return { risk: 'deny', rule: 'ip-write', reason: 'ip 的增删改会改网络配置，断网就再也连不上了' }
    }
    return { risk: 'safe', rule: 'ip-read', reason: '' }
  }
  if (cmd === 'obclient' || cmd === 'mysql') {
    // 收集所有 -e/--execute（含 --execute=...）：重复给时后者生效，必须每条都验
    const sqls: string[] = []
    for (let k = 0; k < args.length; k++) {
      const a = args[k]
      if (a === '-e' || a === '--execute') { sqls.push(args[k + 1] || ''); k++ }
      else if (a.startsWith('--execute=')) sqls.push(a.slice('--execute='.length))
      else if (/^-e./.test(a)) sqls.push(a.slice(2))
    }
    if (!sqls.length) return { risk: 'deny', rule: 'sql-interactive', reason: '交互式登录会挂住连接；请用 `-e "select ..."` 形式' }
    const sql = sqls[sqls.length - 1] || ''
    // 多语句：只看第一条会漏掉后面的写操作
    if (/;\s*\S/.test(sql.replace(/;\s*$/, ''))) {
      return { risk: 'deny', rule: 'sql-multi', reason: '`-e` 里带了多条语句，无法确认后续语句不会写数据' }
    }
    if (/\b(into\s+(outfile|dumpfile)|load_file|load\s+data|source\s+|handler\s+|prepare\s+|execute\s+immediate)\b/i.test(sql)) {
      return { risk: 'deny', rule: 'sql-file', reason: '这条 SQL 会在服务端读写文件，排查阶段不执行' }
    }
    // `show create table t` 是纯元数据查询，别被 create 误杀
    const bare = stripSqlNoise(sql).replace(/\bshow\s+(create|grants|index|table\s+status)\b/gi, 'show_meta')
    if (SQL_WRITE.test(bare)) {
      return { risk: 'deny', rule: 'sql-write', reason: '这条 SQL 会改数据/结构，排查阶段不执行' }
    }
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
  // 判不准 → deny。给模型一句可操作的话，比给它一次点击的机会安全得多。
  return {
    risk: 'deny',
    rule: `unknown:${cmd}`,
    reason: `\`${cmd || '（无法识别的命令）'}\` 不在只读白名单里，无法判断它会不会改主机状态；请改用 ps/df/top/ss/dmesg/日志 grep 这类只读命令`
  }
}

/** 剥掉 SQL 的注释与字符串字面量，避免 `show create table` 被 create 误杀、`-- drop` 被当真 */
function stripSqlNoise(sql: string): string {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:\\.|''|[^'])*'/g, "''")
    .replace(/"(?:\\.|""|[^"])*"/g, '""')
}

/** 主入口：一条命令 → 分档结论 */
export function classifyCommand(raw: string): ObCmdVerdict {
  const cmd = String(raw || '').trim()
  if (!cmd) return deny('empty', '空命令', [])
  if (cmd.length > 1200) return deny('too-long', '命令过长（>1200 字符），无法可靠判断', [])
  if (SUBSTITUTION.test(cmd)) {
    return deny('substitution', '含命令替换（$() 或反引号），内容在运行时才确定，无法静态判断安全', [])
  }
  const segments = splitCommands(stripHarmlessRedirect(cmd))
  if (!segments.length) return deny('empty', '空命令', [])

  // 先逐段判完再看段数：原来「段数 > 8 先 return confirm」会让第 9 段之后的
  // rm -rf 完全不参与判定，等于给长命令串开了个后门。
  let worst: ObCmdVerdict | null = null
  for (const seg of segments) {
    const r = classifySegment(seg)
    const v: ObCmdVerdict = { ...r, segments }
    if (r.risk === 'deny') return v
    if (r.risk === 'confirm') worst = v
  }
  if (segments.length > 8) {
    return confirm('too-many', `这条命令串了 ${segments.length} 段子命令，需逐段人工确认`, segments)
  }
  return worst || { risk: 'safe', rule: 'ok', reason: '', segments }
}

/** 给界面用的简短标签 */
export const RISK_LABEL: Record<ObCmdRisk, string> = {
  safe: '只读',
  confirm: '需确认',
  deny: '已拦截'
}
