<template>
  <div class="ol">
    <div class="ol-head">
      <div class="ol-headline">
        <span class="ol-title">OB 日志中心</span>
        <span class="ol-sub">远端聚合 · 不整文件回传</span>
      </div>
      <div class="ol-ctrl">
        <select v-model="serverId" class="ol-inp ol-srv" title="选择 OBServer 所在的服务器">
          <option value="">选择服务器…</option>
          <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}（{{ s.user }}@{{ s.host }}）</option>
        </select>
        <div class="ol-seg">
          <button v-for="w in windows" :key="w.v" :class="{ on: since === w.v }" @click="since = w.v">{{ w.t }}</button>
        </div>
        <select v-model="scope" class="ol-inp ol-scope" title="日志类型">
          <option v-for="s in scopes" :key="s.v" :value="s.v">{{ s.t }}</option>
        </select>
        <button class="ol-agent" :disabled="!serverId" title="开一个浮窗，让 AI 连到这台机器上跑只读命令查根因" @click="openAgent()">
          ✦ AI 排查
        </button>
        <button class="ol-run" :disabled="!serverId || busy" @click="run">{{ busy ? '分析中…' : '分析' }}</button>
      </div>
    </div>

    <div v-if="err" class="ol-err">{{ err }}</div>

    <div v-if="!res && !err" class="ol-empty">
      <p class="ol-empty-t">选一台装了 OBServer 的服务器，点「分析」</p>
      <p class="ol-empty-d">
        会在远端一趟扫描出：日志级别分布 / 刷屏热点（按代码位置归并）/ 错误码计数，只回传几十 KB 统计结果。
        observer.log 在繁忙集群上 20 分钟就能写满 256MB，整文件拉回来既慢又会被截断，所以这里不做。
      </p>
    </div>

    <div v-if="res" class="ol-body">
      <div class="ol-cards">
        <div class="ol-card ol-kv">
          <span class="ol-k">时间窗</span>
          <span class="ol-v">{{ short(res.windowStart) }} → {{ short(res.windowEnd) }}</span>
        </div>
        <div class="ol-card ol-kv">
          <span class="ol-k">窗口内行数</span>
          <span class="ol-v">{{ num(res.total) }}<i class="ol-u">≈ {{ num(res.linesPerHour) }} 行/小时</i></span>
        </div>
        <div class="ol-card ol-kv">
          <span class="ol-k">扫描</span>
          <span class="ol-v">{{ res.filesScanned }} 个文件<i class="ol-u">{{ bytes(res.bytesScanned) }}{{ res.truncated ? ' · 已达上限截断' : '' }}</i></span>
        </div>
        <div class="ol-card ol-kv" :class="{ warn: diskWarn }">
          <span class="ol-k">日志盘</span>
          <span class="ol-v">{{ diskText }}</span>
        </div>
      </div>

      <div class="ol-path" :title="res.logDir">
        <span class="ol-path-l">{{ res.logDir }}</span>
        <span class="ol-path-tag">{{ res.scope }}.log</span>
      </div>

      <div v-if="diskWarn" class="ol-hint danger">
        日志盘已用 {{ probe?.disk?.usePct }}%（可用 {{ bytes(probe?.disk?.avail || 0) }}）。OB 日志轮转不受
        max_syslog_file_count 限制时会一直涨，建议先清理历史文件 —— 日志盘写满会直接导致集群停写。
      </div>

      <div v-if="res.summary" class="ol-sum" :class="res.summary.level">
        <div class="ol-sum-top">
          <span class="ol-badge">{{ verdictLabel }}</span>
          <span class="ol-sum-head">{{ res.summary.headline }}</span>
        </div>
        <ul class="ol-sum-list">
          <li v-for="(p, i) in res.summary.points" :key="i">{{ p }}</li>
        </ul>
      </div>

      <details class="ol-how">
        <summary>看不懂日志？先看这里 —— 一行 OB 日志怎么读</summary>
        <div class="ol-fields">
          <div v-for="f in LOG_FIELDS" :key="f.tok" class="ol-field">
            <code>{{ f.tok }}</code>
            <span>{{ f.desc }}</span>
          </div>
        </div>
        <p class="ol-how-tip">
          排障顺序：先看级别（WARN 以上才是告警）→ 再看 errcode（判断要不要管）→ 再看函数名（判断在干什么）。
          源码行号只在查内核 bug 时才用，版本升级后会变。
        </p>
      </details>

      <div class="ol-card ol-levels">
        <div class="ol-card-h">级别分布</div>
        <div class="ol-bar">
          <span
            v-for="l in res.levels"
            :key="l.key"
            class="ol-bar-seg"
            :style="{ width: pct(l.count) + '%', background: levelColor(l.key) }"
            :title="`${l.key} ${num(l.count)}`"
          ></span>
        </div>
        <div class="ol-levels-row">
          <span v-for="l in res.levels" :key="l.key" class="ol-chip">
            <i class="ol-dot" :style="{ background: levelColor(l.key) }"></i>{{ l.key }}
            <b>{{ num(l.count) }}</b>
            <em>{{ pct(l.count).toFixed(1) }}%</em>
          </span>
          <span v-if="!res.levels.length" class="ol-none">窗口内无可解析日志</span>
        </div>
      </div>

      <div class="ol-grid">
        <section class="ol-card">
          <div class="ol-card-h">
            刷屏热点
            <span class="ol-card-d">按「文件:行」归并 —— 日志膨胀基本都是几个固定点刷出来的</span>
          </div>
          <div class="ol-th ol-th-hot"><span>位置</span><span>次数</span><span>占比</span></div>
          <div class="ol-rows">
            <template v-for="(h, i) in res.hotSpots" :key="h.key">
              <div
                class="ol-row ol-row-hot"
                :class="{ open: openHot === i }"
                @click="openHot = openHot === i ? -1 : i"
              >
                <span class="ol-site" :title="h.key">
                  <i class="ol-vd" :class="h.verdict" :title="verdictLabelOf(h.verdict)"></i>{{ h.key }}
                </span>
                <span class="ol-n">{{ num(h.count) }}</span>
                <span class="ol-p">{{ pct(h.count).toFixed(1) }}%</span>
              </div>
              <div v-if="openHot === i" class="ol-detail">
                <p v-if="h.what" class="ol-what">{{ h.what }}</p>
                <p v-if="h.advice" class="ol-advice">→ {{ h.advice }}</p>
                <pre v-if="h.sample" class="ol-sample">{{ h.sample }}</pre>
                <button class="ol-ask" @click="askAboutHot(h)">✦ 让 AI 到机器上查这条</button>
              </div>
            </template>
            <div v-if="!res.hotSpots.length" class="ol-none">无</div>
          </div>
        </section>

        <section class="ol-card">
          <div class="ol-card-h">
            错误码
            <span class="ol-card-d">含 WDIAG 级别的 errcode，健康集群 WARN 也可能为 0</span>
          </div>
          <div class="ol-th ol-th-err"><span>码</span><span>次数</span><span>说明</span></div>
          <div class="ol-rows">
            <template v-for="(e, i) in res.errCodes" :key="e.key">
              <div
                class="ol-row ol-row-err"
                :class="{ open: openErr === i }"
                @click="openErr = openErr === i ? -1 : i"
              >
                <span class="ol-code"><i class="ol-vd" :class="e.verdict" :title="verdictLabelOf(e.verdict)"></i>{{ e.key }}</span>
                <span class="ol-n">{{ num(e.count) }}</span>
                <span class="ol-msg" :title="e.msg || e.sample || ''">{{ e.msg || '—' }}</span>
              </div>
              <div v-if="openErr === i" class="ol-detail">
                <p v-if="e.what" class="ol-what">{{ e.what }}</p>
                <p v-if="e.advice" class="ol-advice">→ {{ e.advice }}</p>
                <pre v-if="e.sample" class="ol-sample">{{ e.sample }}
{{ e.first }} → {{ e.last }}</pre>
                <button class="ol-ask" @click="askAboutErr(e)">✦ 让 AI 到机器上查这条</button>
              </div>
            </template>
            <div v-if="!res.errCodes.length" class="ol-none">无 errcode 记录</div>
          </div>
        </section>
      </div>
    </div>

    <ObAgentPanel v-if="obAgent.open" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store } from '../../store'
import { obAgent, openObAgent, askObAgent, clearObAgent } from '../../oblog/agent'
import ObAgentPanel from './ObAgentPanel.vue'

/** 与 main/oblog.ts 的返回结构对齐（渲染层不跨进程 import 主进程模块） */
interface ObLogRowView {
  key: string
  count: number
  msg?: string
  sample?: string
  first?: string
  last?: string
  func?: string
  what?: string
  verdict?: 'normal' | 'watch' | 'bad'
  advice?: string
  rule?: string
}
interface ObLogSummaryView {
  level: 'ok' | 'watch' | 'bad'
  headline: string
  points: string[]
  normalPct: number
  badCount: number
  watchCount: number
}
interface ObLogProbeView {
  ok: boolean
  error?: string
  logDir?: string
  detectedBy?: string
  totalBytes?: number
  disk?: { mount: string; size: number; used: number; avail: number; usePct: number } | null
}
interface ObLogResultView {
  ok: boolean
  error?: string
  logDir: string
  scope: string
  windowStart: string
  windowEnd: string
  filesScanned: number
  bytesScanned: number
  truncated: boolean
  total: number
  continuations: number
  linesPerHour: number
  levels: ObLogRowView[]
  hotSpots: ObLogRowView[]
  errCodes: ObLogRowView[]
  summary?: ObLogSummaryView
}

/** 一行 OB 日志各字段的含义 —— 纯 UI 说明文案 */
const LOG_FIELDS = [
  { tok: '[2026-11-02 15:29:10.664057]', desc: '时间戳，精确到微秒' },
  { tok: 'INFO', desc: '级别。注意 WDIAG 是"诊断信息"，比 INFO 重、比 WARN 轻，不是告警' },
  { tok: '[STORAGE]', desc: '子系统：STORAGE 存储 / PALF 日志同步 / SQL / RPC.OBMYSQL 客户端连接…' },
  { tok: 'get_kept_multi_version_start', desc: '函数名 —— 判断"这行在干什么"最有效的锚点' },
  { tok: '(ob_tablet.cpp:3960)', desc: '源码位置。版本一升级行号就变，别拿它当唯一依据' },
  { tok: '[38465] [T1_SSTableGC]', desc: '线程 ID + 线程名 —— 一眼看出是哪个后台任务在跑' },
  { tok: '[T1] [YB42C0A80AA5-…]', desc: '租户 ID + trace_id。trace_id 能把一次请求散在各处的日志串起来' },
  { tok: '[lt=19]', desc: '本行打印耗时（微秒），数值大说明当时在卡' },
  { tok: '[errcode=-4009]', desc: '错误码 —— 判断"要不要管"最可靠的依据' }
]

const servers = computed<any[]>(() => (store.cfg?.servers || []) as any[])
const serverId = ref<string>('')
const since = ref(10)
const scope = ref('observer')
const busy = ref(false)
const err = ref('')
const res = ref<ObLogResultView | null>(null)
const probe = ref<ObLogProbeView | null>(null)
const openHot = ref(-1)
const openErr = ref(-1)
/** 在途请求的序号：切服务器/重复点分析后，旧请求的结果直接丢弃 */
let runSeq = 0

const windows = [
  { v: 10, t: '10 分' },
  { v: 30, t: '30 分' },
  { v: 60, t: '1 小时' },
  { v: 180, t: '3 小时' },
  { v: 720, t: '12 小时' }
]
const scopes = [
  { v: 'observer', t: 'observer.log' },
  { v: 'rootservice', t: 'rootservice.log' },
  { v: 'election', t: 'election.log' },
  { v: 'trace', t: 'trace.log' }
]

const LAST = 'sqlpilot.oblog.server'
const saved = localStorage.getItem(LAST)
if (saved && servers.value.some((s) => s.id === saved)) serverId.value = saved
else if (servers.value.length === 1) serverId.value = servers.value[0].id

watch(serverId, (v) => {
  if (v) localStorage.setItem(LAST, v)
  runSeq++ // 作废在途请求，避免旧机器的结果写进新机器面板
  res.value = null
  probe.value = null
  err.value = ''
  busy.value = false
  // 换了服务器：浮窗不能还指着旧机器继续跑命令 —— 停掉、清空、跟着切到新目标
  if (obAgent.open && v !== obAgent.serverId) {
    clearObAgent()
    const s = servers.value.find((x) => x.id === v)
    obAgent.serverId = v
    obAgent.serverName = s?.name || ''
    obAgent.host = s ? `${s.user}@${s.host}` : ''
    obAgent.context = null
  }
})

async function run(): Promise<void> {
  if (!serverId.value || busy.value) return
  // 每次分析发一个序号：切服务器/切 scope 后，旧请求回来不能写进新机器的面板
  const token = ++runSeq
  busy.value = true
  err.value = ''
  res.value = null
  openHot.value = -1
  openErr.value = -1
  try {
    const sid = serverId.value
    const p = await window.sqlpilot.oblogProbe(sid)
    if (token !== runSeq) return
    probe.value = p
    if (!p.ok) {
      err.value = p.error || '探测日志目录失败'
      return
    }
    const r = await window.sqlpilot.oblogAnalyze(sid, { scope: scope.value, sinceMinutes: since.value })
    if (token !== runSeq) return
    // ok:true + error = 数据拿到了但不完整（部分文件没读到 / 输出被截断），
    // 必须把横幅显示出来，否则「统计不全」会被当成「集群干净」
    if (r.error) err.value = r.error
    if (!r.ok) {
      err.value = r.error || '分析失败'
      return
    }
    res.value = r
  } catch (e: any) {
    if (token === runSeq) err.value = String(e?.message || e)
  } finally {
    if (token === runSeq) busy.value = false
  }
}

const diskWarn = computed(() => (probe.value?.disk?.usePct || 0) >= 85)
const diskText = computed(() => {
  const d = probe.value?.disk
  if (!d) return '—'
  return `${d.usePct}%（可用 ${bytes(d.avail)} / ${bytes(d.size)}）`
})

// ---------------------------------------------------------------- AI 故障排查

const curServer = computed(() => servers.value.find((s) => s.id === serverId.value) || null)

/**
 * 交给 Agent 的现场证据：只带页面上已经看到的东西（结论 + TOP 热点/错误码 + 样例），
 * 不带整份日志，也不在主进程重扫一遍。
 */
function agentContext(): any {
  const r = res.value
  return {
    serverName: curServer.value?.name || '',
    host: curServer.value?.host || '',
    logDir: r?.logDir || probe.value?.logDir || '',
    scope: scope.value,
    windowStart: r?.windowStart || '',
    windowEnd: r?.windowEnd || '',
    total: r?.total,
    linesPerHour: r?.linesPerHour,
    filesScanned: r?.filesScanned,
    bytesScanned: r?.bytesScanned,
    truncated: r?.truncated,
    disk: probe.value?.disk
      ? { usePct: probe.value.disk.usePct, avail: probe.value.disk.avail, mount: probe.value.disk.mount }
      : null,
    levels: (r?.levels || []).map((l) => ({ key: l.key, count: l.count })),
    summary: r?.summary
      ? { level: r.summary.level, headline: r.summary.headline, points: r.summary.points }
      : undefined,
    hotSpots: (r?.hotSpots || []).slice(0, 8).map((h) => ({
      key: h.key,
      count: h.count,
      verdict: h.verdict,
      what: h.what,
      advice: h.advice,
      sample: h.sample
    })),
    errCodes: (r?.errCodes || []).slice(0, 8).map((e) => ({
      key: e.key,
      count: e.count,
      msg: e.msg,
      verdict: e.verdict,
      what: e.what,
      advice: e.advice,
      sample: e.sample
    }))
  }
}

function openAgent(preset?: string): void {
  const s = curServer.value
  if (!s) {
    err.value = '先选一台服务器，再让 AI 连过去排查'
    return
  }
  openObAgent({
    serverId: s.id,
    serverName: s.name,
    host: `${s.user}@${s.host}`,
    context: agentContext(),
    preset
  })
}

function askAboutHot(h: ObLogRowView): void {
  openAgent(
    `「${h.key}」在窗口内出现了 ${h.count} 次，到机器上查清它在做什么、为什么会反复打印，再给处理建议。`
  )
  // 已经打开浮窗时 openObAgent 只填草稿，这里直接发出去省一次点击
  void askObAgent()
}

function askAboutErr(e: ObLogRowView): void {
  openAgent(
    `错误码 ${e.key}（${e.msg || '含义未知'}）在窗口内出现 ${e.count} 次，到机器上确认它是不是在持续发生、影响什么，再给处理建议。`
  )
  void askObAgent()
}

/** 结论档位的标签：不用「正常/异常」，用 DBA 的话 */
const VERDICT_LABEL = { ok: '健康', watch: '需留意', bad: '有问题' } as const
const VERDICT_ROW = { normal: '正常', watch: '注意', bad: '要处理' } as const
const verdictLabel = computed(() => (res.value?.summary ? VERDICT_LABEL[res.value.summary.level] : ''))
function verdictLabelOf(v?: 'normal' | 'watch' | 'bad'): string {
  return v ? VERDICT_ROW[v] : ''
}

function pct(n: number): number {
  const t = res.value?.total || 0
  return t > 0 ? (n / t) * 100 : 0
}

function num(n: number): string {
  return (Number(n) || 0).toLocaleString('en-US')
}

function bytes(n: number): string {
  const v = Number(n) || 0
  if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(1) + ' GB'
  if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB'
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB'
  return v + ' B'
}

/** 只留时分秒：时间窗两端日期通常相同 */
function short(s: string): string {
  return s ? s.slice(11, 19) || s : '—'
}

function levelColor(lv: string): string {
  if (lv === 'ERROR' || lv === 'EDIAG') return 'var(--red)'
  if (lv === 'WARN' || lv === 'WDIAG') return 'var(--yellow)'
  if (lv === 'TRACE' || lv === 'DEBUG') return 'var(--text-faint)'
  return 'var(--accent)'
}
</script>

<style scoped>
.ol { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); }

.ol-head {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--bg-card);
  flex-shrink: 0;
}
.ol-headline { display: flex; align-items: baseline; gap: 10px; }
.ol-title { font-size: 15px; font-weight: 500; color: var(--text); }
.ol-sub { font-size: 12px; color: var(--text-faint); }
.ol-ctrl { display: flex; align-items: center; gap: 10px; margin-left: auto; flex-wrap: wrap; }

.ol-inp {
  height: 28px; padding: 0 8px; border-radius: 6px; font-size: 12px;
  background: var(--bg-input); color: var(--text); border: 1px solid var(--border);
  outline: none; max-width: 260px;
}
.ol-inp:focus { border-color: var(--border-strong); }
.ol-scope { width: 130px; }

.ol-seg { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.ol-seg button {
  height: 26px; padding: 0 10px; font-size: 12px; background: transparent; color: var(--text-dim);
  border: none; border-right: 1px solid var(--border); cursor: pointer;
}
.ol-seg button:last-child { border-right: none; }
.ol-seg button:hover { color: var(--text); background: var(--bg-card-hover); }
.ol-seg button.on { color: var(--on-accent); background: var(--accent); }

.ol-run {
  height: 28px; padding: 0 16px; border-radius: 6px; font-size: 12px; font-weight: 500;
  background: var(--accent); color: var(--on-accent); border: none; cursor: pointer;
}
.ol-run:hover:not(:disabled) { background: var(--accent-dim); }
.ol-run:disabled { opacity: 0.45; cursor: default; }

/* AI 排查：不是主操作，用描边按钮，跟「分析」拉开层次 */
.ol-agent {
  height: 28px; padding: 0 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  background: transparent; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  font-family: inherit;
}
.ol-agent:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
.ol-agent:disabled { opacity: 0.45; cursor: default; }

/* 详情里「让 AI 查这条」：跟正文同一行流，不抢结论的注意力 */
.ol-ask {
  margin-top: 8px; padding: 3px 10px; border-radius: 6px; font-size: 11.5px; cursor: pointer;
  background: transparent; color: var(--accent); font-family: inherit;
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
}
.ol-ask:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); border-style: solid; }

.ol-err {
  margin: 14px 18px 0; padding: 10px 12px; border-radius: 8px; font-size: 12.5px;
  background: var(--red-dim); color: var(--red); border: 1px solid var(--red); flex-shrink: 0;
}

.ol-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px; }
.ol-empty-t { font-size: 14px; color: var(--text-dim); margin: 0; }
.ol-empty-d { font-size: 12.5px; color: var(--text-faint); max-width: 620px; line-height: 1.7; margin: 0; text-align: center; }

.ol-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 24px; display: flex; flex-direction: column; gap: 12px; }

.ol-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.ol-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; }
.ol-kv { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.ol-kv.warn { border-color: var(--red); }
.ol-k { font-size: 11.5px; color: var(--text-faint); }
.ol-v { font-size: 13px; color: var(--text); display: flex; flex-direction: column; gap: 2px; }
.ol-u { font-size: 11.5px; color: var(--text-dim); font-style: normal; }

.ol-path { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); }
.ol-path-l { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ol-path-tag {
  flex-shrink: 0; font-size: 11px; padding: 1px 6px; border-radius: 4px;
  background: var(--bg-code); color: var(--text-faint); font-family: var(--mono);
}

.ol-hint { padding: 9px 12px; border-radius: 8px; font-size: 12.5px; line-height: 1.6; border: 1px solid var(--border); }
.ol-hint.ok { background: var(--green-dim); color: var(--green); border-color: var(--green); }
.ol-hint.warn { background: var(--yellow-dim); color: var(--yellow); border-color: var(--yellow); }
.ol-hint.danger { background: var(--red-dim); color: var(--red); border-color: var(--red); }

/* 结论卡：整页最该先看的东西，放最上面且视觉最重 */
.ol-sum { border-radius: 8px; border: 1px solid var(--border); background: var(--bg-card); padding: 12px 14px; }
.ol-sum.ok { border-left: 3px solid var(--green); }
.ol-sum.watch { border-left: 3px solid var(--yellow); }
.ol-sum.bad { border-left: 3px solid var(--red); }
.ol-sum-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ol-badge {
  flex-shrink: 0; font-size: 11.5px; padding: 2px 8px; border-radius: 4px; font-weight: 500;
}
.ol-sum.ok .ol-badge { background: var(--green-dim); color: var(--green); }
.ol-sum.watch .ol-badge { background: var(--yellow-dim); color: var(--yellow); }
.ol-sum.bad .ol-badge { background: var(--red-dim); color: var(--red); }
.ol-sum-head { font-size: 13.5px; color: var(--text); font-weight: 500; line-height: 1.5; }
.ol-sum-list { margin: 8px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
.ol-sum-list li { font-size: 12.5px; color: var(--text-dim); line-height: 1.65; }

/* 「怎么读一行日志」：默认收起，不干扰看数据 */
.ol-how { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-card); padding: 0 12px; }
.ol-how > summary {
  cursor: pointer; padding: 10px 0; font-size: 12.5px; color: var(--text-dim);
  list-style: none; user-select: none;
}
.ol-how > summary::-webkit-details-marker { display: none; }
.ol-how > summary::before { content: '▸ '; color: var(--text-faint); }
.ol-how[open] > summary::before { content: '▾ '; }
.ol-how > summary:hover { color: var(--text); }
.ol-fields { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 10px; border-top: 1px solid var(--border); }
.ol-field { display: grid; grid-template-columns: 220px 1fr; gap: 10px; align-items: baseline; padding-top: 6px; }
.ol-field code {
  font-family: var(--mono); font-size: 11.5px; color: var(--accent);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ol-field span { font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.ol-how-tip { margin: 0 0 10px; font-size: 12px; color: var(--text-faint); line-height: 1.7; }

/* 行内「要不要管」标记 */
.ol-vd {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  margin-right: 6px; vertical-align: middle; flex-shrink: 0; background: var(--text-faint);
}
.ol-vd.normal { background: var(--green); }
.ol-vd.watch { background: var(--yellow); }
.ol-vd.bad { background: var(--red); }

.ol-detail { background: var(--bg-code); border-bottom: 1px solid var(--border); padding: 10px 12px; }
.ol-what { margin: 0; font-size: 12px; color: var(--text); line-height: 1.7; }
.ol-advice { margin: 4px 0 0; font-size: 12px; color: var(--accent); line-height: 1.7; }
.ol-detail .ol-sample { border-top: 1px solid var(--border); margin-top: 8px; padding-left: 0; padding-right: 0; background: transparent; }

.ol-levels { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ol-card-h { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; color: var(--text); font-weight: 500; padding: 10px 12px; }
.ol-levels .ol-card-h { padding: 0; }
.ol-card-d { font-size: 11.5px; color: var(--text-faint); font-weight: 400; }
.ol-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--bg-code); }
.ol-bar-seg { height: 100%; }
.ol-levels-row { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.ol-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-dim); }
.ol-chip b { color: var(--text); font-weight: 500; font-family: var(--mono); }
.ol-chip em { font-style: normal; color: var(--text-faint); font-size: 11px; }
.ol-dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }

.ol-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
@media (max-width: 1180px) { .ol-grid { grid-template-columns: 1fr; } }

.ol-th {
  display: grid; gap: 8px; padding: 6px 12px; font-size: 11.5px; color: var(--text-faint);
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg-side);
}
.ol-th-hot { grid-template-columns: 1fr 76px 56px; }
.ol-th-err { grid-template-columns: 72px 76px 1fr; }
.ol-th span:not(:first-child) { text-align: right; }
.ol-th-err span:last-child { text-align: left; }

.ol-rows { max-height: 340px; overflow: auto; }
.ol-row {
  display: grid; gap: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  border-bottom: 1px solid var(--border); align-items: center;
}
.ol-row:hover { background: var(--bg-card-hover); }
.ol-row.open { background: var(--bg-card-hover); }
.ol-row-hot { grid-template-columns: 1fr 76px 56px; }
.ol-row-err { grid-template-columns: 72px 76px 1fr; }
.ol-site { font-family: var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ol-code { font-family: var(--mono); color: var(--yellow); }
.ol-n { font-family: var(--mono); color: var(--text); text-align: right; }
.ol-p { font-family: var(--mono); color: var(--text-faint); text-align: right; font-size: 11.5px; }
.ol-msg { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }

.ol-sample {
  margin: 0; padding: 10px 12px; font-family: var(--mono); font-size: 11.5px; line-height: 1.6;
  color: var(--text-dim); background: var(--bg-code); white-space: pre-wrap; word-break: break-all;
  border-top: 1px solid var(--border); max-height: 220px; overflow: auto;
}

.ol-none { padding: 14px 12px; font-size: 12px; color: var(--text-faint); }
</style>
