<template>
  <div class="chat-wrap">
    <div class="chat-scroll" ref="scrollEl" @click="onChatClick">
      <div class="chat-inner">
        <div v-if="runningTasks.length" class="subtask-bar">
          <span style="font-size:11.5px; color:var(--text-dim); margin-right:4px">后台子代理</span>
          <div v-for="t in runningTasks" :key="t.id" class="subtask-chip">
            <span class="spinner" style="width:9px; height:9px; margin-right:5px"></span>
            <b>{{ t.agentType }}</b> · {{ t.description }}
            <span style="color:var(--text-faint); font-size:11px">{{ taskDur(t.startedAt) }}s</span>
            <button class="x" title="停止该任务" @click="stopTask(t.id)">✕</button>
          </div>
        </div>
        <div v-if="!curSession().msgs.length" class="empty-state">
          <div class="big">◆</div>
          <b>SQLPilot</b> — 数据库操作、巡检与变更助手
          <div class="step" v-if="!store.cfg?.providers?.length">
            <b>第 1 步</b>　点击左下角 <b>⚙ 设置</b> 选择厂商和模型（DeepSeek / GLM / Kimi / Claude…）
          </div>
          <div class="step" v-if="!store.cfg?.connections?.length">
            <b>可选</b>　需要操作数据库时，左侧「数据库连接」标题行的 <b>＋</b> 添加连接（Oracle、OceanBase MySQL/Oracle 租户、MySQL）；纯文件/技能任务无需连接
          </div>
          <div class="step">
            <b>示例</b>　查看某个库的表结构 · 多库巡检 · 复杂变更先切<b>计划模式</b>出方案再执行
          </div>
        </div>

        <div v-for="(m, idx) in curSession().msgs" :key="m.id" class="msg" :class="m.role">
          <template v-if="m.role === 'user'">
            <div class="bubble">{{ m.text }}</div>
          </template>
          <template v-else-if="m.role === 'reasoning'">
            <div v-if="m.collapsed">
              <button class="reasoning-toggle show" title="展开思考过程" @click="toggleReasoning(m)">
                <span class="chev">▸</span>思考过程（{{ m.text.length }} 字）<span class="op">展开</span>
              </button>
            </div>
            <template v-else>
              <div v-if="answerStarted(idx) || m.settled">
                <button class="reasoning-toggle" title="收起思考过程" @click="toggleReasoning(m)">
                  <span class="chev">▾</span>思考过程<span class="op">收起</span>
                </button>
              </div>
              <div class="content" v-if="m.text">{{ m.text }}</div>
            </template>
          </template>
          <template v-else-if="m.role === 'error'">
            <div class="content">⚠ {{ m.text }}</div>
          </template>
          <template v-else>
            <div class="content" v-html="mdLite(m.text)"></div>
            <ToolCard v-for="(t, i) in m.tools" :key="i" :tool="t" />
            <!-- WorkBuddy 式「任务产物」：本条消息产出的结果在右侧栏预览 -->
            <ArtifactChips v-if="msgArtifacts[m.id]?.length" :items="msgArtifacts[m.id]" />
            <div v-if="isPlanTarget(idx)" class="plan-actions">
              <button class="btn primary" @click="approvePlan">✓ 批准并执行此计划</button>
              <span class="hint">批准后开始执行；权限模式恢复为计划前的设置（无记录则为确认执行）</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="chat-input-wrap">
      <div class="chat-input">
        <!-- 导航入口统一收顶栏与侧栏：composer 只保留与"发送"直接相关的控件，回收纵向空间 -->
        <textarea
          v-model="store.drafts[store.currentId]"
          placeholder="描述任务，如：看下 t_order 表最近一周的慢查询，给出执行计划"
          @keydown.enter.exact.prevent="onEnterKey"
          rows="2"
        ></textarea>
        <div class="row">
          <span class="hint">
            <select
              class="effort-select mode-select"
              :class="modeClass"
              :value="curSession().meta.mode"
              title="当前会话的权限模式（各会话独立）：计划=只读探索出方案 · 只读=仅查询 · 确认执行=写操作逐次确认 · 会话放开=普通写自动高危仍确认 · 完全放开=全部自动"
              @change="onModeChange"
            >
              <option v-for="m in MODES" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
            <span
              v-if="curSession().ctx"
              class="ctx-badge"
              :class="ctxLevel"
              :title="ctxTitle"
            >{{ fmtTok(curSession().ctx!.est) }}/{{ curSession().ctx!.windowK }}K · {{ ctxPct }}%</span>
            <select
              class="effort-select"
              :value="curSession().meta.effort ?? ''"
              title="思考级别（本会话独立设置，随对话即时生效）"
              @change="onEffortChange"
            >
              <option value="">思考 · 默认</option>
              <option value="off">思考 · 关</option>
              <option value="low">思考 · 低</option>
              <option value="medium">思考 · 中</option>
              <option value="high">思考 · 深</option>
            </select>
            Enter 发送 · Shift+Enter 换行
            <template v-if="curSession().running">　·　<span class="spinner"></span> 执行中…</template>
          </span>
          <span>
            <button v-if="curSession().running" class="btn danger" style="margin-right:6px" @click="stop">■ 停止</button>
            <button class="btn ghost" style="margin-right:6px" @click="onArchiveClick" :disabled="curSession().running || !!store.archiveProgress" :title="store.archiveProgress ? store.archiveProgress.note : '总结当前对话归档到项目（该项目其他会话可读）后清空本会话'">
              <template v-if="store.archiveProgress">归档中…</template>
              <template v-else>归档对话</template>
            </button>
            <button class="btn primary" @click="send" :disabled="curSession().running || !store.drafts[store.currentId]?.trim()">发送</button>
          </span>
        </div>
      </div>
    </div>
  </div>
  <SubagentRunModal v-if="store.subRun" :run-id="store.subRun.runId" :title="store.subRun.title" />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { store, curSession, sendMessage, newChat, stop, approvePlan, setSessionEffort, setSessionMode, MODES, archiveAndClear } from '../store'
import ToolCard from './ToolCard.vue'
import SubagentRunModal from './SubagentRunModal.vue'
import ArtifactChips from './artifacts/ArtifactChips.vue'
import { collectArtifacts, type Artifact } from '../artifacts'

const scrollEl = ref<HTMLElement | null>(null)

/** 按消息归组的产物（消息一变就重算；纯推导，工具结果到达后自动出现） */
const msgArtifacts = computed<Record<number, Artifact[]>>(() => {
  const out: Record<number, Artifact[]> = {}
  for (const a of collectArtifacts(curSession()?.msgs as any)) {
    ;(out[a.msgId] ||= []).push(a)
  }
  return out
})

async function onArchiveClick() {
  await archiveAndClear()
}

async function onEffortChange(e: Event) {
  await setSessionEffort((e.target as HTMLSelectElement).value)
}

async function onModeChange(e: Event) {
  const sel = e.target as HTMLSelectElement
  // 切会话放开/完全放开的确认弹窗被取消时回退显示，避免下拉框显示与实际模式不一致
  if (!(await setSessionMode(sel.value))) sel.value = curSession().meta.mode
}

// 权限模式下拉的配色（沿用模式按钮时代的语义色：计划紫/只读绿/会话放开黄/完全放开红）
const modeClass = computed(() => {
  const m = curSession().meta.mode
  return m === 'readonly' ? 'mode-ok' : m === 'plan' ? 'mode-plan' : m === 'session' ? 'mode-warn' : m === 'yolo' ? 'mode-danger' : ''
})

// 计划模式：最后一条有内容的助手消息 = 待批准的计划
function isPlanTarget(idx: number): boolean {
  const s = curSession()
  if (!s || s.meta.mode !== 'plan' || s.running) return false
  if (idx !== s.msgs.length - 1) return false
  const m = s.msgs[idx]
  return m.role === 'assistant' && !!m.text.trim() && m.tools.length === 0
}

// 思考过程折叠：手动切换过的不参与后续自动折叠
function toggleReasoning(m: { collapsed?: boolean; manualToggle?: boolean }): void {
  m.collapsed = !m.collapsed
  m.manualToggle = true
}

// 该条思考之后是否已有助手正文（决定展开态是否显示"收起"入口）
function answerStarted(idx: number): boolean {
  const msgs = curSession()?.msgs || []
  for (let i = idx + 1; i < msgs.length; i++) {
    if (msgs[i].role === 'assistant' && msgs[i].text) return true
  }
  return false
}

// ---------- Markdown 渲染（标题/列表/引用/表格/代码块带复制） ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(t: string): string {
  return t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    // href 中的双引号会逃出属性（esc 不转义引号），这里显式转义防属性注入
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, txt: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${txt}</a>`)
}

const isTableRow = (l: string) => /^\s*\|.*\|/.test(l)
const isSepRow = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-')
function splitRow(l: string): string[] {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitRow(lines[start])
  const rows: string[][] = []
  let j = start + 2
  while (j < lines.length && isTableRow(lines[j])) {
    rows.push(splitRow(lines[j]))
    j++
  }
  const html =
    '<div class="md-table-wrap"><table><thead><tr>' +
    header.map((c) => `<th>${inline(c)}</th>`).join('') +
    '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
    '</tbody></table></div>'
  return { html, next: j }
}

function renderTextSegment(seg: string): string {
  const lines = seg.split('\n')
  let html = ''
  let i = 0
  let listMode: 'ul' | 'ol' | null = null
  const closeList = () => {
    if (listMode) {
      html += `</${listMode}>`
      listMode = null
    }
  }
  while (i < lines.length) {
    const line = lines[i]

    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      closeList()
      const t = renderTable(lines, i)
      html += t.html
      i = t.next
      continue
    }
    if (!line.trim()) {
      closeList()
      i++
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList()
      html += '<hr>'
      i++
      continue
    }
    const h = line.match(/^#{1,6}\s+(.*)$/)
    if (h) {
      closeList()
      const level = Math.min(h[0].match(/^#+/)![0].length + 2, 5)
      html += `<h${level}>${inline(h[1])}</h${level}>`
      i++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      closeList()
      html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`
      i++
      continue
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) {
      if (listMode !== 'ul') {
        closeList()
        html += '<ul>'
        listMode = 'ul'
      }
      html += `<li>${inline(ul[1])}</li>`
      i++
      continue
    }
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/)
    if (ol) {
      if (listMode !== 'ol') {
        closeList()
        html += '<ol>'
        listMode = 'ol'
      }
      html += `<li>${inline(ol[1])}</li>`
      i++
      continue
    }
    closeList()
    html += `<p>${inline(line)}</p>`
    i++
  }
  closeList()
  return html
}

function renderCodeBlock(seg: string): string {
  const nl = seg.indexOf('\n')
  const first = nl >= 0 ? seg.slice(0, nl).trim() : ''
  const isLang = /^[a-zA-Z0-9+#._-]{0,20}$/.test(first)
  const lang = isLang && first ? first : ''
  const code = isLang ? (nl >= 0 ? seg.slice(nl + 1) : '') : seg
  return (
    `<div class="code-block"><div class="code-head"><span>${lang || 'text'}</span>` +
    `<button class="copy-btn" data-code="${encodeURIComponent(code)}">复制</button></div>` +
    `<pre><code>${code}</code></pre></div>`
  )
}

function mdLite(text: string): string {
  if (!text) return ''
  const parts = esc(text).split(/```/)
  let html = ''
  for (let i = 0; i < parts.length; i++) {
    html += i % 2 === 1 ? renderCodeBlock(parts[i]) : renderTextSegment(parts[i])
  }
  return html
}

// 事件委托：复制按钮 / 安全外链
async function onChatClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (t.classList?.contains('copy-btn')) {
    await window.sqlpilot.writeClipboard(decodeURIComponent(t.dataset.code || ''))
    t.textContent = '已复制 ✓'
    setTimeout(() => { t.textContent = '复制' }, 1500)
    return
  }
  if (t.tagName === 'A') {
    e.preventDefault()
    const href = t.getAttribute('href') || ''
    if (/^https?:\/\//.test(href)) await window.sqlpilot.openExternal(href)
  }
}

// 中文输入法组词时的 Enter 只确认候选，不发送（isComposing / 229 为候选确认键）
function onEnterKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  send()
}

// ---------- 上下文占用徽标 ----------
function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
}
const ctxPct = computed(() => {
  const c = curSession().ctx
  if (!c) return 0
  return Math.min(100, Math.round((c.est / (c.windowK * 1000)) * 100))
})
const ctxLevel = computed(() => {
  const p = ctxPct.value
  return p >= 80 ? 'danger' : p >= 60 ? 'warn' : 'ok'
})
const ctxTitle = computed(() => {
  const c = curSession().ctx
  if (!c) return ''
  const lines = [
    `下次请求估算：≈${fmtTok(c.est)} tokens（系统提示词 + 全部对话历史）`,
    `模型上下文窗口：${c.windowK}K · 已用 ${ctxPct.value}%`
  ]
  const u = c.usage
  if (u) {
    const io: string[] = []
    if (u.input > 0) io.push(`输入 ${u.input.toLocaleString()} tok`)
    if (u.output > 0) io.push(`输出 ${u.output.toLocaleString()} tok`)
    lines.push(`最近请求（真实计量）：${io.join(' · ') || '无数据'}${u.input > 0 ? '' : `（厂商未回传输入量，输入按估算 ≈${fmtTok(c.est)}）`}`)
    if (u.cacheRead || u.cacheWrite) {
      lines.push(`缓存：命中 ${u.cacheRead.toLocaleString()} tok · 写入 ${u.cacheWrite.toLocaleString()} tok${u.cacheRead ? `（命中率 ${Math.round((u.cacheRead / Math.max(1, u.input + u.cacheRead)) * 100)}%）` : ''}`)
    } else {
      lines.push('缓存：本厂商未返回缓存命中数据')
    }
  } else {
    lines.push('最近请求：该厂商流式响应未返回用量数据，仅显示估算值')
  }
  return lines.join('\n')
})

async function send() {
  const text = (store.drafts[store.currentId] || '').trim()
  if (!text || curSession().running) return
  store.drafts[store.currentId] = ''
  await sendMessage(text)
}

const runningTasks = computed(() => (curSession()?.subTasks || []).filter((t: any) => t.status === 'running'))
const taskTick = ref(0)
const taskTimer = setInterval(() => { taskTick.value++ }, 5000)
onBeforeUnmount(() => { if (taskTimer) clearInterval(taskTimer) })
async function stopTask(id: string): Promise<void> {
  await window.sqlpilot.subagentStopTask(id)
}
// 引用 taskTick：让模板里的耗时随周期重算
function taskDur(startedAt: number): number {
  void taskTick.value
  return Math.round((Date.now() - startedAt) / 1000)
}

const msgSignature = computed(() => store.currentId + ':' + store.sessionOrder.join(',') + ':' + (curSession()?.msgs.map((m) => m.text.length + m.tools.length).join(',') || '') + ':' + (curSession()?.msgs.length || 0))

let lastSessionId = ''
watch(msgSignature, async () => {
  await nextTick()
  const el = scrollEl.value
  if (!el) return
  const switched = store.currentId !== lastSessionId
  lastSessionId = store.currentId
  // 切换会话时始终定位到最新消息；流式输出时贴近底部才跟随
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 320
  if (switched || nearBottom) el.scrollTo({ top: el.scrollHeight })
}, { immediate: true })
</script>

<style scoped>
.effort-select {
  padding: 2px 8px;
  font-size: 11.5px;
  border-radius: 7px;
  background: var(--bg-input);
  color: var(--text-dim);
  cursor: pointer;
}
/* 权限模式下拉：当前模式的语义色（选中项文字着色，一眼可辨危险程度） */
.mode-select.mode-ok { color: var(--green); }
.mode-select.mode-plan { color: var(--purple); }
.mode-select.mode-warn { color: var(--yellow); }
.mode-select.mode-danger { color: var(--red); font-weight: 700; }
.plan-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px dashed var(--purple);
  border-radius: 10px;
  background: var(--bg-card);
}
.plan-actions .hint { font-size: 11.5px; color: var(--text-dim); }
.ctx-badge {
  font-size: 11px; padding: 2px 8px; border-radius: 99px; cursor: default;
  font-family: var(--mono); white-space: nowrap;
}
.ctx-badge.ok { background: var(--accent-dim); color: var(--accent); }
.ctx-badge.warn { background: var(--yellow-dim, rgba(200, 160, 40, 0.15)); color: var(--yellow); }
.ctx-badge.danger { background: var(--red-dim); color: var(--red); font-weight: 700; }
/* 输入框上方快捷按钮（终端/SQL/对象）：小号、轻量 */
.subtask-bar {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  border: 1px dashed var(--border); border-radius: 8px; padding: 6px 10px; margin-bottom: 10px;
  background: var(--bg-card);
}
.subtask-chip {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 12px; padding: 2px 10px; font-size: 12px;
}
.subtask-chip .x {
  border: none; background: none; color: var(--text-faint); cursor: pointer; font-size: 11px; padding: 0 2px;
}
.subtask-chip .x:hover { color: var(--red); }
</style>
