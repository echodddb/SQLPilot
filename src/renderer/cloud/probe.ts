/**
 * 直连集群的探测状态机（纯逻辑，不依赖 vue / window，便于单测）。
 *
 * 背景：直连模式下配置里的每套集群是一条独立连接。旧实现把所有集群塞进一个
 * Promise.all 里等齐，只要有一台连不上，就要一直等到它超时（甚至挂住），
 * 健康集群的数据也跟着出不来。
 *
 * 现在每套集群各自探、谁先回来谁先上屏；探不通的**不再反复探**——
 * 否则每进一个模块都要再等它一次。要不要再探收敛成这个状态机：
 *
 *   idle ──探测──▶ ok ────自动刷新还会再探──▶ ok
 *     │            │
 *     │            ├─超时/连不上─▶ fail ──用户确认──▶ skipped
 *     │            │                 │                 │
 *     └────────────┴─────────────────┴──── 手动重试 ───┴──▶ idle
 *
 * 关键点：`probing` 是独立开关，不覆盖上一次结论——否则每次刷新状态灯都会闪成
 * 「连接中」，整体可用性判断也会一瞬间变成「全部不可用」。
 */

/** 最近一次探测的结论；idle = 本次会话还没探过 */
export type ProbeState = 'idle' | 'ok' | 'fail' | 'skipped'

export interface ProbeRecord {
  state: ProbeState
  /** 有探测在飞（不覆盖 state，刷新时状态灯不会闪） */
  probing: boolean
  /** 失败原因：超时 / 连接被拒 / 认证失败……成功时清空 */
  error: string
  /** 最近一次探测的时间戳（毫秒） */
  at: number
  /** 连续失败次数：界面可写「已连续 N 次」，重新连上即清零 */
  fails: number
}

export type ProbeBook = Record<string, ProbeRecord>

/**
 * 单个集群等多久算「没探到」。
 *
 * 连接超时是 8s（obdirect/conn.ts 的 connectTimeout），连不上的机器会在那一步
 * 直接报错，走不到这个上限；这里只是兜住「连上了但系统视图查不动」的慢实例，
 * 再给几秒余量，别让真慢的集群被误判成挂了。
 */
export const PROBE_DEADLINE_MS = 15_000

export const idleProbe = (): ProbeRecord => ({ state: 'idle', probing: false, error: '', at: 0, fails: 0 })

/** 取某套集群的探测记录（没有就返回一条 idle，调用方不用判空） */
export function probeOf(book: ProbeBook, id: string): ProbeRecord {
  return book[id] || idleProbe()
}

/**
 * 这一轮要不要探它。
 * - 手动（用户点刷新 / 重试）：一律放行；
 * - 自动（切页面、60s 静默刷新）：只探没探过的和上次成功的，
 *   失败与被跳过的都不碰——这正是「别的模块不再采集它」的落点。
 *
 * 注意：**不因「正在探」就跳过**。切页面时上一页的请求往往还在飞，
 * 一跳过，新页面就是一张空表格（实测踩过）；多查一次的代价远小于空数据。
 */
export function shouldProbe(rec: ProbeRecord, manual: boolean): boolean {
  if (manual) return true
  return rec.state === 'idle' || rec.state === 'ok'
}

/** 当前算不算「不可用」：失败（含超时）与用户确认跳过 */
export const isOffline = (rec: ProbeRecord): boolean => rec.state === 'fail' || rec.state === 'skipped'

/** 界面上的一句话状态 */
export function probeLabel(rec: ProbeRecord): string {
  if (rec.probing && rec.state === 'idle') return '探测中'
  if (rec.state === 'idle') return '未探测'
  if (rec.state === 'ok') return '正常'
  if (rec.state === 'skipped') return '已跳过'
  return '不可用'
}

export function markProbing(book: ProbeBook, id: string, at: number): void {
  book[id] = { ...probeOf(book, id), probing: true, at }
}

export function markOk(book: ProbeBook, id: string, at: number): void {
  book[id] = { state: 'ok', probing: false, error: '', at, fails: 0 }
}

/** 记一次失败：连续失败次数累加，供提示文案使用 */
export function markFail(book: ProbeBook, id: string, error: string, at: number): void {
  const prev = probeOf(book, id)
  book[id] = {
    state: 'fail',
    probing: false,
    error: error || '连接失败',
    at,
    fails: (prev.fails || 0) + 1
  }
}

/**
 * 用户点「知道了，暂不探测」：本轮会话里不再自动探它。
 * 只对已经判失败的生效——健康的集群不需要跳过，误点也不会把它关掉。
 */
export function skipProbe(book: ProbeBook, id: string, at: number): void {
  const prev = probeOf(book, id)
  if (prev.state !== 'fail' && !(prev.probing && prev.state === 'idle')) return
  book[id] = { state: 'skipped', probing: false, error: prev.error, at, fails: prev.fails }
}

/** 手动重试：清掉记录回到 idle，下一轮重新探 */
export function resetProbe(book: ProbeBook, id: string): void {
  delete book[id]
}

/** 平台清单变了（删了一条接入）：顺手清掉不存在的平台状态，免得越积越多 */
export function pruneProbes(book: ProbeBook, ids: string[]): void {
  const keep = new Set(ids)
  for (const id of Object.keys(book)) if (!keep.has(id)) delete book[id]
}

/**
 * 把驱动层的原始报错翻成人话。
 *
 * mysql2 抛的是 `connect ETIMEDOUT` / `ECONNREFUSED` 这种，DBA 能看懂但说不上"是什么毛病"；
 * 这里按错误码给出「是什么 + 往哪查」，原文仍留在 title 里供拷给同事。
 */
export function friendlyProbeError(msg: string): string {
  const m = String(msg || '').trim()
  if (!m) return '连接失败'
  const has = (re: RegExp): boolean => re.test(m)
  if (has(/未响应/)) return m // 已经是人话（超时兜底文案），别二次加工
  if (has(/尚未保存密码|请先在云管平台设置/)) return '这套接入还没保存密码，先在「设置」里补上'
  if (has(/ETIMEDOUT|timed out|timeout/i)) return '连接超时：网络不可达，或防火墙拦了 2881 端口'
  if (has(/ECONNREFUSED/i)) return '连接被拒绝：端口没监听（OBServer 没起，或端口填错）'
  if (has(/EHOSTUNREACH|ENETUNREACH/i)) return '网络不可达：检查 IP 与路由'
  if (has(/ENOTFOUND|EAI_AGAIN|getaddrinfo/i)) return '域名解析失败：主机名写错了，或 DNS 不通'
  if (has(/ER_ACCESS_DENIED|Access denied/i)) return '账号或密码不对，或该账号不允许从本机登录'
  if (has(/ER_DBACCESS_DENIED|denied to user/i)) return '权限不足：这个账号读不到系统视图'
  if (has(/ER_CON_COUNT_ERROR|Too many connections/i)) return '连接数已满：实例的 max_connections 到顶了'
  if (has(/ECONNRESET/i)) return '连接被对端重置：实例可能正在重启'
  return m
}

/** 一次采集的返回（与 service 层的 { ok, data, error } 同形） */
export interface Fetched<T> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * 每套集群一条独立通道：谁先回来谁先上屏，慢的不耽误快的。
 *
 * 到 deadlineMs 还没回来，先按「超时未响应」收尾（界面能出提示、能跳过），
 * 但请求本身不取消——之后真回来了，数据照旧补上（late=true）并转回正常。
 * 这正是「哪个集群先拿到数据就先显示」的落点。
 */
export async function fanOut<T, P extends { id: string }>(
  book: ProbeBook,
  list: P[],
  run: (p: P) => Promise<Fetched<T>>,
  onData: (p: P, data: T, late: boolean) => void,
  opts: { deadlineMs?: number; onSettle?: () => void } = {}
): Promise<void> {
  const deadline = opts.deadlineMs ?? PROBE_DEADLINE_MS
  const settle = opts.onSettle ?? ((): void => { /* 无副作用 */ })
  await Promise.all(
    list.map(
      (p) =>
        new Promise<void>((resolve) => {
          markProbing(book, p.id, Date.now())
          let done = false
          const timer = setTimeout(() => {
            if (done) return
            done = true
            markFail(book, p.id, `超过 ${Math.round(deadline / 1000)} 秒未响应`, Date.now())
            settle()
            resolve() // 本轮先结束，别让界面一直转圈
          }, deadline)
          run(p)
            .then((r) => {
              if (!r.ok || r.data == null) {
                if (!done) {
                  done = true
                  clearTimeout(timer)
                  markFail(book, p.id, r.error || '连接失败', Date.now())
                  settle()
                }
                resolve()
                return
              }
              const late = done // 超时之后才回来的：数据照收
              done = true
              clearTimeout(timer)
              markOk(book, p.id, Date.now())
              onData(p, r.data, late)
              settle()
              resolve()
            })
            .catch((e: any) => {
              if (!done) {
                done = true
                clearTimeout(timer)
                markFail(book, p.id, String(e?.message || e), Date.now())
                settle()
              }
              resolve()
            })
        })
    )
  )
}

