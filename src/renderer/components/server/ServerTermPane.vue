<template>
  <div class="tp" :class="{ active }">
    <div class="tp-wrap">
      <div ref="hostEl" class="tp-host"></div>

      <!-- 查找栏 -->
      <div v-if="findOpen" class="tp-find" @keydown.esc="closeFind">
        <input
          ref="findInput"
          v-model="findText"
          placeholder="在终端中查找"
          @keyup.enter="findNext($event.shiftKey)"
          @input="findNext(false, true)"
        />
        <span class="tp-find-num">{{ findInfo }}</span>
        <button class="tp-fbtn" title="上一个（Shift+Enter）" @click="findNext(true)">↑</button>
        <button class="tp-fbtn" title="下一个（Enter）" @click="findNext(false)">↓</button>
        <button class="tp-fbtn" title="关闭（Esc）" @click="closeFind">✕</button>
      </div>

      <!-- 断开/错误浮层 -->
      <div v-if="tab.status === 'closed' || tab.status === 'error'" class="tp-mask">
        <div class="tp-mask-box">
          <div class="tp-mask-title">{{ tab.status === 'error' ? '连接失败' : '连接已断开' }}</div>
          <div class="tp-mask-msg">{{ tab.error || '远端关闭了会话（exit / 网络中断 / 超时）' }}</div>
          <div class="tp-mask-acts">
            <button class="tp-btn primary" @click="reconnect">重新连接</button>
            <button class="tp-btn" @click="clearScreen">清屏</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单（fixed 挂到 body 同级，避免被终端裁剪） -->
    <Teleport to="body">
      <div v-if="menu.open" class="ctx-mask" @mousedown.self="menu.open = false" @contextmenu.prevent="menu.open = false">
        <div class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
          <button class="ctx-item" :disabled="!hasSelection" @click="run(() => copySelection())">复制<span class="ctx-key">Ctrl+Shift+C</span></button>
          <button class="ctx-item" @click="run(() => paste())">粘贴<span class="ctx-key">Ctrl+Shift+V</span></button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="run(() => (findOpen = true, nextTick(() => findInput?.focus()), menu.open = false))">查找<span class="ctx-key">Ctrl+F</span></button>
          <button class="ctx-item" @click="run(() => zoom(1))">放大字号</button>
          <button class="ctx-item" @click="run(() => zoom(-1))">缩小字号</button>
          <button class="ctx-item" @click="run(() => zoom(0))">恢复默认字号</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="run(() => clearScreen())">清屏</button>
          <button class="ctx-item" @click="run(() => saveLog())">保存输出日志…</button>
          <button class="ctx-item" @click="run(() => selectAll())">全选</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="run(() => sendCtrlC())">发送 Ctrl+C</button>
          <button class="ctx-item" @click="run(() => reconnect())">重新连接</button>
          <button class="ctx-item danger" @click="run(() => emit('close'))">关闭标签</button>
        </div>
      </div>
    </Teleport>

    <!-- 多行粘贴确认 -->
    <Teleport to="body">
      <div v-if="pasteAsk" class="ctx-mask" @mousedown.self="pasteAsk = null">
        <div class="paste-box">
          <div class="paste-title">粘贴 {{ pasteAsk.lines }} 行内容？</div>
          <div class="paste-hint">多行文本会逐行送入 shell，含 <code>rm</code>/<code>reboot</code> 等命令时会立即执行。</div>
          <pre class="paste-pre">{{ pasteAsk.preview }}</pre>
          <div class="paste-acts">
            <label class="paste-chk"><input type="checkbox" v-model="pasteDontAsk" /> 本次会话不再提示</label>
            <span style="flex:1"></span>
            <button class="tp-btn" @click="pasteAsk = null">取消</button>
            <button class="tp-btn primary" @click="confirmPaste">粘贴</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { TermTabState } from '../../server/state'
import { findServer, srv } from '../../server/state'
import { effectivePrefs, termPrefs } from '../../server/prefs'
import { themeFor } from '../../server/schemes'

const props = defineProps<{ tab: TermTabState; active: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'status', v: TermTabState['status']): void }>()

const server = computed(() => findServer(props.tab.serverId))
const eff = computed(() => effectivePrefs(server.value))

const hostEl = ref<HTMLElement | null>(null)
const findOpen = ref(false)
const findText = ref('')
const findInput = ref<HTMLInputElement | null>(null)
const findInfo = ref('')
const hasSelection = ref(false)

const menu = ref({ open: false, x: 0, y: 0 })
const pasteAsk = ref<{ text: string; lines: number; preview: string } | null>(null)
const pasteDontAsk = ref(false)

let term: Terminal | null = null
let fit: FitAddon | null = null
let search: SearchAddon | null = null
let ro: ResizeObserver | null = null
let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let themeObs: MutationObserver | null = null
/** 新建 shell 前要先断开旧 shell（重连时） */
let connected = false
/** 组件是否已卸载：await 回来后再写状态 / 关 shell 都要看它 */
let disposed = false
/** 绑定原生事件的元素（卸载时按同一引用解绑） */
let boundEl: HTMLElement | null = null

function isLight(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'light'
}

function applyTheme(): void {
  if (!term) return
  term.options.theme = themeFor(eff.value.scheme, isLight())
  term.options.fontSize = props.tab.fontSize || eff.value.fontSize
}

function buildTerm(): Terminal {
  const p = eff.value
  const t = new Terminal({
    fontSize: props.tab.fontSize || p.fontSize,
    fontFamily: p.fontFamily,
    lineHeight: p.lineHeight,
    cursorStyle: p.cursorStyle,
    cursorBlink: p.cursorBlink,
    scrollback: p.scrollback,
    theme: themeFor(p.scheme, isLight()),
    allowProposedApi: true,
    // 右键菜单自己实现：xterm 内置的右键是浏览器菜单，交互与桌面终端不一致
    rightClickSelectsWord: false,
    macOptionIsMeta: true
  })
  const f = new FitAddon()
  const s = new SearchAddon()
  t.loadAddon(f)
  t.loadAddon(s)
  t.loadAddon(new WebLinksAddon((_e, uri) => { void window.sqlpilot.openExternal(uri) }))
  const uni = new Unicode11Addon()
  t.loadAddon(uni)
  try { t.unicode.activeVersion = '11' } catch { /* 老内核不支持则跳过 */ }
  fit = f
  search = s

  // 复制粘贴与字号：xterm 只接管键盘，其余交回浏览器默认
  t.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      void copySelection()
      return false
    }
    if (ctrl && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      void paste()
      return false
    }
    if (ctrl && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      findOpen.value = true
      void nextTick(() => findInput.value?.focus())
      return false
    }
    if (ctrl && (e.key === '=' || e.key === '+')) { zoom(1); return false }
    if (ctrl && e.key === '-') { zoom(-1); return false }
    if (ctrl && e.key === '0') { zoom(0); return false }
    return true
  })

  t.onSelectionChange(() => {
    hasSelection.value = !!t.getSelection()
    if (termPrefs().copyOnSelect && hasSelection.value) {
      const sel = t.getSelection()
      if (sel) void navigator.clipboard.writeText(sel).catch(() => { /* 无剪贴板权限 */ })
    }
  })

  t.onData((d) => { void window.sqlpilot.termInput(props.tab.id, d) })
  t.onBinary((d) => {
    // 二进制帧（鼠标上报等）：转成同长度字符串原样送出
    let s2 = ''
    for (let i = 0; i < d.length; i++) s2 += String.fromCharCode(d.charCodeAt(i) & 0xff)
    void window.sqlpilot.termInput(props.tab.id, s2)
  })

  const el = hostEl.value
  if (el) {
    t.open(el)
    try { f.fit() } catch { /* 容器尚未有尺寸 */ }
  }

  el?.addEventListener('contextmenu', onContextMenu)
  el?.addEventListener('wheel', onWheel, { passive: false })
  el?.addEventListener('mousedown', onMouseDown)
  boundEl = el || null

  return t
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (termPrefs().rightClickPaste) {
    void paste()
    return
  }
  menu.value = { open: true, x: Math.min(e.clientX, window.innerWidth - 210), y: Math.min(e.clientY, window.innerHeight - 330) }
}

/** Ctrl+滚轮调字号（MobaXterm / VSCode 一致）：只改本标签，不动全局偏好 */
function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey) return
  e.preventDefault()
  zoom(e.deltaY < 0 ? 1 : -1)
}

/** 中键粘贴：X11 习惯，很多 DBA 的手指记忆在这里 */
function onMouseDown(e: MouseEvent): void {
  if (e.button === 1) {
    e.preventDefault()
    void paste()
  }
}

function zoom(dir: number): void {
  if (!term) return
  const cur = props.tab.fontSize || eff.value.fontSize
  const next = dir === 0 ? eff.value.fontSize : Math.min(Math.max(cur + dir, 8), 32)
  props.tab.fontSize = dir === 0 ? undefined : next
  term.options.fontSize = next
  void nextTick(() => doFit())
}

function doFit(): void {
  if (!term || !fit) return
  try {
    fit.fit()
    void window.sqlpilot.termResize(props.tab.id, term.cols, term.rows)
  } catch { /* 隐藏中的标签尺寸为 0 */ }
}

async function connect(): Promise<void> {
  if (!term) return
  const s = server.value
  if (!s) {
    props.tab.status = 'error'
    props.tab.error = '服务器已被删除'
    emit('status', 'error')
    return
  }
  props.tab.status = 'connecting'
  props.tab.error = undefined
  emit('status', 'connecting')
  term.writeln(`\x1b[90m正在连接 ${s.user}@${s.host}:${s.port || 22} …\x1b[0m`)
  doFit()
  const r = await window.sqlpilot.termOpen(props.tab.id, s.id, {
    cols: term.cols,
    rows: term.rows,
    encoding: eff.value.encoding,
    cwd: s.cwd
  })
  // 握手期间用户可能已经把标签关掉：此时组件已卸载，connected 还是 false，卸载钩子不会发 termClose。
  // 这里补一刀，否则主进程里的 shell 没有任何引用能关掉
  if (disposed) {
    if (r.ok) void window.sqlpilot.termClose(props.tab.id)
    return
  }
  if (!r.ok) {
    connected = false
    props.tab.status = 'error'
    props.tab.error = r.error
    emit('status', 'error')
    return
  }
  connected = true
  props.tab.status = 'open'
  emit('status', 'open')
  term.focus()
}

function reconnect(): void {
  if (connected) void window.sqlpilot.termClose(props.tab.id)
  connected = false
  if (term) {
    term.reset()
    term.clear()
  }
  void connect()
}

function clearScreen(): void {
  term?.clear()
  menu.value.open = false
}

function selectAll(): void {
  term?.selectAll()
  menu.value.open = false
}

function sendCtrlC(): void {
  void window.sqlpilot.termInput(props.tab.id, '\x03')
  menu.value.open = false
}

async function copySelection(): Promise<void> {
  const sel = term?.getSelection()
  menu.value.open = false
  if (!sel) return
  try { await navigator.clipboard.writeText(sel) } catch { /* 忽略 */ }
}

async function paste(): Promise<void> {
  menu.value.open = false
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    await window.sqlpilot.uiAlert('无法读取剪贴板，请用 Ctrl+Shift+V 或右键菜单重试')
    return
  }
  if (!text) return
  const lines = text.split(/\r?\n/).length
  const needAsk = termPrefs().confirmMultilinePaste && lines > 1 && !pasteDontAsk.value
  if (needAsk) {
    pasteAsk.value = { text, lines, preview: text.length > 600 ? text.slice(0, 600) + '…' : text }
    return
  }
  doPaste(text)
}

function confirmPaste(): void {
  const p = pasteAsk.value
  pasteAsk.value = null
  if (p) doPaste(p.text)
}

function doPaste(text: string): void {
  // 粘贴内容里的 \n 要转成 \r：终端只认 CR 作为行结束，否则 bash 里多行命令会挤成一行
  void window.sqlpilot.termInput(props.tab.id, text.replace(/\r?\n/g, '\r'))
  term?.focus()
}

function findNext(back = false, incremental = false): void {
  if (!search || !findText.value) {
    findInfo.value = ''
    return
  }
  const opts = { caseSensitive: false, incremental, decorations: undefined }
  const found = back ? search.findPrevious(findText.value, opts) : search.findNext(findText.value, opts)
  findInfo.value = found ? '' : '无匹配'
}

function closeFind(): void {
  findOpen.value = false
  if (search) search.clearDecorations()
  term?.focus()
}

async function saveLog(): Promise<void> {
  menu.value.open = false
  if (!term) return
  const buf = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
  const s = server.value
  const name = `${(s?.name || 'terminal').replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`
  const r = await window.sqlpilot.localSaveText(lines.join('\r\n'), name)
  if (r.ok) srv.status = `日志已保存：${r.path}`
  else if (!r.canceled) void window.sqlpilot.uiAlert('保存失败：' + (r.error || '未知错误'))
}

function run(fn: () => void): void {
  fn()
}

onMounted(async () => {
  term = buildTerm()
  offData = window.sqlpilot.onTermData(({ termId, data }) => {
    if (termId === props.tab.id) term?.write(data)
  })
  offExit = window.sqlpilot.onTermExit(({ termId, code }) => {
    if (termId !== props.tab.id) return
    connected = false
    if (props.tab.status !== 'error') {
      props.tab.status = 'closed'
      props.tab.error = code === 0 || code == null ? undefined : `远端进程退出，代码 ${code}`
      emit('status', 'closed')
    }
  })
  ro = new ResizeObserver(() => { if (props.active) doFit() })
  if (hostEl.value) ro.observe(hostEl.value)
  themeObs = new MutationObserver(() => applyTheme())
  themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  await nextTick()
  doFit()
  await connect()
})

onBeforeUnmount(() => {
  disposed = true
  offData?.()
  offExit?.()
  ro?.disconnect()
  themeObs?.disconnect()
  hostEl.value?.removeEventListener('contextmenu', onContextMenu)
  boundEl?.removeEventListener('contextmenu', onContextMenu)
  boundEl?.removeEventListener('wheel', onWheel)
  boundEl?.removeEventListener('mousedown', onMouseDown)
  boundEl = null
  // 无条件关：主进程找不到对应 shell 时是无害 no-op，但漏掉就会泄漏一条 SSH 会话
  void window.sqlpilot.termClose(props.tab.id)
  term?.dispose()
  term = null
})

/** 切到本标签时重排：隐藏期间容器高度为 0，fit 会算出 1 列 */
watch(() => props.active, (v) => {
  if (!v) return
  void nextTick(() => setTimeout(() => { doFit(); term?.focus() }, 30))
})

/** 全局偏好变化（字号/配色/间距）：实时生效，不用重连 */
watch(() => termPrefs(), () => {
  if (!term) return
  const p = termPrefs()
  term.options.fontFamily = p.fontFamily
  term.options.lineHeight = p.lineHeight
  term.options.cursorStyle = p.cursorStyle
  term.options.cursorBlink = p.cursorBlink
  term.options.scrollback = p.scrollback
  applyTheme()
  void nextTick(() => doFit())
}, { deep: true })
</script>

<style scoped>
.tp { position: absolute; inset: 0; display: none; }
.tp.active { display: block; }
.tp-wrap { position: relative; width: 100%; height: 100%; padding: 6px 8px; box-sizing: border-box; }
.tp-host { width: 100%; height: 100%; }
.tp-host :deep(.xterm) { height: 100%; }
.tp-host :deep(.xterm-viewport) { background: transparent !important; }

.tp-find {
  position: absolute; top: 8px; right: 18px; z-index: 5;
  display: flex; align-items: center; gap: 5px;
  background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 5px 7px; box-shadow: var(--shadow);
}
.tp-find input {
  width: 190px; font-size: 12px; padding: 3px 8px; border-radius: 6px;
  font-family: var(--mono);
}
.tp-find-num { font-size: 11px; color: var(--red); min-width: 34px; }
.tp-fbtn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 5px; width: 22px; height: 22px; cursor: pointer; font-size: 11px; line-height: 1;
  font-family: inherit;
}
.tp-fbtn:hover { color: var(--accent); border-color: var(--accent); }

.tp-mask {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(2px);
}
.tp-mask-box {
  max-width: 520px; padding: 18px 20px; border-radius: 12px;
  background: var(--bg-card); border: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
}
.tp-mask-title { font-size: 14px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.tp-mask-msg { font-size: 12.5px; color: var(--text-dim); line-height: 1.7; word-break: break-all; white-space: pre-wrap; max-height: 220px; overflow: auto; }
.tp-mask-acts { display: flex; gap: 8px; margin-top: 14px; }
.tp-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 7px; padding: 5px 14px; font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.tp-btn:hover { color: var(--text); border-color: var(--border-strong); }
.tp-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.tp-btn.primary:hover { filter: brightness(1.1); }
</style>

<style>
/* 右键菜单样式在 server/ui.css（跨组件共用），这里只保留粘贴确认框 */
.paste-box {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 560px; max-width: 92vw; padding: 18px 20px; border-radius: 12px;
  background: var(--bg-card); border: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
}
.paste-title { font-size: 14px; font-weight: 600; color: var(--text); }
.paste-hint { font-size: 12px; color: var(--text-dim); margin: 6px 0 10px; line-height: 1.6; }
.paste-pre {
  max-height: 220px; overflow: auto; font-family: var(--mono); font-size: 11.5px;
  background: var(--bg-code); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px; color: var(--text-dim); white-space: pre-wrap; word-break: break-all; margin: 0;
}
.paste-acts { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.paste-chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); cursor: pointer; }
</style>
