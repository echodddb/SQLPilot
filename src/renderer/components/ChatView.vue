<template>
  <div class="chat-wrap">
    <div class="chat-scroll" ref="scrollEl" @click="onChatClick">
      <div class="chat-inner">
        <div v-if="!curSession().msgs.length" class="empty-state">
          <div class="big">◆</div>
          <b>SQLPilot 就绪</b> — 资深 DBA 助手，直接操作您配置的数据库
          <div class="step" v-if="!store.cfg?.providers?.length">
            <b>第 1 步</b>　点击右上角 <b>⚙ 设置</b> 选择厂商和模型（DeepSeek / GLM / Kimi / Claude…）
          </div>
          <div class="step" v-if="!store.cfg?.connections?.length">
            <b>可选</b>　需要操作数据库时，左侧 <b>＋</b> 添加连接（Oracle 11g/19c、OB MySQL 租户、MySQL）；纯文件/技能任务无需连接
          </div>
          <div class="step">
            <b>试试</b>　"帮我在项目里写一份周巡检报告模板" · "看看这个库有哪些业务表" · 切到<b>计划模式</b>让它先出方案再动手
          </div>
        </div>

        <div v-for="(m, idx) in curSession().msgs" :key="m.id" class="msg" :class="m.role">
          <template v-if="m.role === 'user'">
            <div class="bubble">{{ m.text }}</div>
          </template>
          <template v-else-if="m.role === 'reasoning'">
            <div class="content" v-if="m.text">💭 {{ m.text }}</div>
          </template>
          <template v-else-if="m.role === 'error'">
            <div class="content">⚠ {{ m.text }}</div>
          </template>
          <template v-else>
            <div class="content" v-html="mdLite(m.text)"></div>
            <ToolCard v-for="(t, i) in m.tools" :key="i" :tool="t" />
            <div v-if="isPlanTarget(idx)" class="plan-actions">
              <button class="btn primary" @click="approvePlan">✓ 批准并执行此计划</button>
              <span class="hint">批准后本会话切换为"确认执行"模式开始执行</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="chat-input-wrap">
      <div class="chat-input">
        <textarea
          v-model="store.drafts[store.currentId]"
          placeholder="描述任务，如：查一下 LIS 库里最近一周的检验申请量，按天汇总"
          @keydown.enter.exact.prevent="onEnterKey"
          rows="2"
        ></textarea>
        <div class="row">
          <span class="hint">
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
            <button class="btn ghost" style="margin-right:6px" @click="newChat" :disabled="curSession().running">清空对话</button>
            <button class="btn primary" @click="send" :disabled="curSession().running || !store.drafts[store.currentId]?.trim()">发送</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { store, curSession, sendMessage, newChat, stop, approvePlan, setSessionEffort } from '../store'
import ToolCard from './ToolCard.vue'

const scrollEl = ref<HTMLElement | null>(null)

async function onEffortChange(e: Event) {
  await setSessionEffort((e.target as HTMLSelectElement).value)
}

// 计划模式：最后一条有内容的助手消息 = 待批准的计划
function isPlanTarget(idx: number): boolean {
  const s = curSession()
  if (!s || s.meta.mode !== 'plan' || s.running) return false
  if (idx !== s.msgs.length - 1) return false
  const m = s.msgs[idx]
  return m.role === 'assistant' && !!m.text.trim() && m.tools.length === 0
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

async function send() {
  const text = (store.drafts[store.currentId] || '').trim()
  if (!text || curSession().running) return
  store.drafts[store.currentId] = ''
  await sendMessage(text)
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
</style>
