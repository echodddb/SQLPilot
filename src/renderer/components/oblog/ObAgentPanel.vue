<template>
  <div
    ref="rootEl"
    class="oa"
    :class="{ detached, resizing, dragging }"
    :style="winStyle"
    @keydown.esc.stop="close"
  >
    <!-- 顶栏：拖动移位（独立窗口时交给系统拖拽区），双击恢复默认 -->
    <header
      class="oa-h"
      :class="{ grab: !detached }"
      :title="headTip"
      @mousedown="startDrag"
      @dblclick="onHeadDblClick"
    >
      <span class="oa-logo">✦</span>
      <div class="oa-title">
        <b>故障排查</b>
        <em :title="where">{{ where }}</em>
      </div>
      <span class="sp"></span>

      <div class="oa-seg" :title="modeTip">
        <button :class="{ on: obAgent.mode === 'auto' }" @click.stop="setObAgentMode('auto')">自动</button>
        <button :class="{ on: obAgent.mode === 'confirm' }" @click.stop="setObAgentMode('confirm')">逐条</button>
      </div>

      <button
        v-if="detached"
        class="oa-ic"
        :class="{ on: obAgent.pinned }"
        :title="obAgent.pinned ? '取消置顶' : '窗口置顶（不被其他窗口盖住）'"
        @click.stop="togglePin"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10.4 2.4 13.6 5.6 9.9 6.7 6.7 9.9 5.6 13.6 2.4 10.4 6.1 9.3 9.3 6.1z" />
        </svg>
      </button>
      <button
        class="oa-ic"
        :title="detached ? '停靠回主窗口' : '脱离为独立窗口（可拖到桌面任意位置，不受主窗口限制）'"
        @click.stop="toggleDetach"
      >
        <svg v-if="!detached" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M9.5 2H14v4.5M14 2 9 7M6.5 14H2V9.5M2 14l5-5" />
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 9.5V14h-4.5M14 14 9 9M2 6.5V2h4.5M2 2l5 5" />
        </svg>
      </button>
      <button
        class="oa-ic"
        title="新对话（清空当前记录）"
        :disabled="obAgent.busy || !obAgent.items.length"
        @click.stop="clearObAgent"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
      </button>
      <button class="oa-ic close" title="关闭 (Esc)" @click.stop="close">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <!-- 安全边界常驻一行：让人随时知道这个 agent 能干什么、不能干什么 -->
    <div class="oa-guard" title="命令分级见 main/obagent/policy.ts：safe 只读 / confirm 需确认 / deny 直接拦截">
      <span class="oa-tag">只读</span>
      <span class="oa-guard-t">
        改数据 · 重启 · 改配置 · 提权 · 写文件 一律拦下，执行记录进审计
      </span>
    </div>

    <div ref="bodyEl" class="oa-body" :class="{ empty: !obAgent.items.length }" @scroll.passive="onBodyScroll">
      <div v-if="!obAgent.items.length" class="oa-empty">
        <p>基于上面的日志结论，我可以连到目标主机上跑只读命令，把根因查出来。</p>
        <div class="oa-quick">
          <button v-for="q in quickPrompts()" :key="q" @click="askObAgent(q)">
            <span class="oa-q-dot"></span>{{ q }}
          </button>
        </div>
        <p class="oa-empty-note">会先列出要跑的命令，危险命令直接拦下。</p>
      </div>

      <template v-for="it in obAgent.items" :key="it.key">
        <div v-if="it.kind === 'text'" class="oa-msg" :class="it.role">
          <span class="oa-avatar">{{ it.role === 'user' ? '我' : '✦' }}</span>
          <div class="oa-bubble">
            <MdMessage
              v-if="it.role === 'assistant'"
              :text="it.text"
              role="assistant"
              :streaming="!!it.live"
              @link="openLink"
            />
            <template v-else>{{ it.text }}</template>
          </div>
        </div>

        <div v-else-if="it.kind === 'cmd'" class="oa-cmd" :class="[it.cmd.risk, it.cmd.status]">
          <div class="oa-cmd-h">
            <span class="oa-risk" :title="it.cmd.reason || it.cmd.rule">{{ RISK[it.cmd.risk] }}</span>
            <code
              class="oa-cmd-t"
              :class="{ full: expanded[it.cmdId] }"
              :title="it.cmd.command + (it.cmd.command.length > 46 ? '（点击展开/收起）' : '')"
              @click="toggleExpand(it.cmdId)"
            >{{ it.cmd.command }}</code>
            <!-- 拦截时风险徽标已经写了「已拦截」，右边不再重复一遍 -->
            <span v-if="it.cmd.status !== 'blocked'" class="oa-st">
              <i v-if="it.cmd.status === 'running'" class="oa-spin"></i>{{ STATUS[it.cmd.status] }}
            </span>
          </div>
          <p v-if="it.cmd.why" class="oa-why">{{ it.cmd.why }}</p>
          <p v-if="it.cmd.risk !== 'safe' && it.cmd.reason" class="oa-reason">{{ it.cmd.reason }}</p>

          <div v-if="it.cmd.status === 'waiting'" class="oa-actions">
            <button class="oa-btn primary" @click="approveCmd(it.cmdId, 'run')">执行</button>
            <button class="oa-btn" title="本次对话内，同一类命令不再逐条确认（只影响 confirm 级，deny 永远拦）" @click="approveCmd(it.cmdId, 'always')">
              以后同类都执行
            </button>
            <button class="oa-btn" @click="approveCmd(it.cmdId, 'skip')">跳过</button>
          </div>

          <div v-else-if="it.cmd.status === 'running'" class="oa-progress"><i></i></div>

          <div class="oa-cmd-f">
            <button class="lnk" :disabled="!it.cmd.output" @click="toggleCmdOutput(it.cmdId)">
              {{ it.cmd.open ? '收起输出' : '查看输出' }}
            </button>
            <span class="sp"></span>
            <span v-if="it.cmd.ms != null" class="oa-meta">{{ it.cmd.ms }}ms</span>
            <span v-if="it.cmd.note" class="oa-meta warn">{{ it.cmd.note }}</span>
            <button v-if="it.cmd.output" class="lnk" title="复制这条命令的输出" @click="copyWith(it.cmd.output || '', 'out:' + it.cmdId)">
              {{ copied === 'out:' + it.cmdId ? '已复制' : '复制输出' }}
            </button>
            <button class="lnk" title="复制这条命令" @click="copyWith(it.cmd.command, 'cmd:' + it.cmdId)">
              {{ copied === 'cmd:' + it.cmdId ? '已复制' : '复制命令' }}
            </button>
          </div>

          <pre v-if="it.cmd.open && it.cmd.output" class="oa-out">{{ it.cmd.output }}</pre>
        </div>
      </template>

      <div v-if="obAgent.busy && !streaming" class="oa-wait">
        <span class="oa-dots"><i></i><i></i><i></i></span>排查中
        <em v-if="obAgent.reasoningChars">已思考 {{ obAgent.reasoningChars }} 字</em>
      </div>
      <div v-if="obAgent.error" class="oa-err">{{ obAgent.error }}</div>
    </div>

    <!-- 往回翻的时候别被流式输出拽回底部 -->
    <button v-if="!atBottom" class="oa-jump" :style="{ bottom: footH + 10 + 'px' }" title="回到最新" @click="toBottom(true)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M4 8.5l4 4 4-4" /></svg>
    </button>

    <footer ref="footEl" class="oa-f">
      <textarea
        ref="inputEl"
        v-model="obAgent.draft"
        class="oa-input"
        :placeholder="placeholder"
        spellcheck="false"
        @input="autoGrow"
        @keydown="onInputKey"
      ></textarea>
      <div class="oa-row">
        <span class="oa-tip">{{ obAgent.busy ? '排查中，随时可停' : 'Enter 发送 · Shift+Enter 换行' }}</span>
        <span class="sp"></span>
        <button v-if="obAgent.busy" class="oa-btn stop" @click="stopObAgent">停止</button>
        <button class="oa-send" :disabled="!obAgent.draft.trim() || obAgent.busy" title="发送" @click="askObAgent()">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.5M4 7l4-3.5L12 7" /></svg>
        </button>
      </div>
    </footer>

    <span
      class="oa-rs"
      :title="detached ? '拖动调整窗口大小' : '拖动调整大小（双击标题栏恢复默认）'"
      @pointerdown.stop.prevent="startResize"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 9 9 14M14 12.5 12.5 14" /></svg>
    </span>
    <span v-if="resizing && !detached" class="oa-size">{{ sizeText }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * OB 故障排查 Agent 浮窗。
 *
 * 三条约束写在界面上，也写在主进程里：
 *  1. 每条命令都是一张卡片，命令原文不折叠（排障时人要看清楚跑的是什么）；
 *  2. 待确认的卡片才有按钮，跑完的只留结论与输出；
 *  3. 被拦的命令用红色卡片显示原因，没有「仍然执行」这种按钮。
 *
 * `detached` = 这份界面跑在独立窗口里（main/obagent/panel.ts 开的那个）：
 * 拖拽移位交给系统拖拽区，缩放按增量改窗口 bounds，其余完全一致。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import MdMessage from '../common/MdMessage.vue'
import {
  approveCmd,
  askObAgent,
  bindObAgentEvents,
  bindObAgentUi,
  clearObAgent,
  closeObAgent,
  copyText,
  detachObAgent,
  dockObAgent,
  hydrateObAgent,
  obAgent,
  quickPrompts,
  resetObAgentLayout,
  saveObAgentLayout,
  setObAgentMode,
  setObAgentPinned,
  stopObAgent,
  toggleCmdOutput,
  type ObAgentCmd,
  type ObRisk
} from '../../oblog/agent'

const props = defineProps<{ detached?: boolean }>()
const detached = computed(() => !!props.detached)

const rootEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const footEl = ref<HTMLElement | null>(null)
const footH = ref(96)
const resizing = ref(false)
const dragging = ref(false)
const atBottom = ref(true)
/** 命令原文单行截断，点一下看全（排障时常要看清管道和参数） */
const expanded = reactive<Record<string, boolean>>({})
/** 刚复制的目标（1.2s 后复位），点一下就有反馈，比 toast 轻 */
const copied = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const RISK: Record<ObRisk, string> = { safe: '只读', confirm: '需确认', deny: '已拦截' }
const STATUS: Record<ObAgentCmd['status'], string> = {
  waiting: '待确认',
  running: '执行中',
  done: '完成',
  failed: '失败',
  blocked: '已拦截',
  skipped: '已跳过'
}

const streaming = computed(() => obAgent.items.some((x) => x.kind === 'text' && x.live))
const where = computed(() => {
  const s = [obAgent.serverName, obAgent.host].filter(Boolean).join(' / ')
  const extra = obAgent.context?.logDir ? ` · ${obAgent.context.logDir}` : ''
  return (s || '未选服务器') + extra
})
const modeTip = computed(() =>
  obAgent.mode === 'auto'
    ? '只读命令自动执行；需要确认或危险命令仍会停下来'
    : '每条命令都要点一次「执行」'
)
const headTip = computed(() =>
  detached.value ? '拖动标题栏可移到桌面任意位置' : '拖动可移动浮窗，双击恢复默认位置与大小；也可点右上角脱离成独立窗口'
)
const placeholder = computed(() =>
  obAgent.mode === 'auto' ? '要查什么？例如：为什么这个时间点开始刷屏' : '要查什么？（每条命令都会等你确认）'
)

// ---------------------------------------------------------------- 位置 / 尺寸

const EDGE = 14
const DEFAULT_W = 520
const DEFAULT_H = 620
const MIN_W = 380
const MIN_H = 340

const winW = computed(() => obAgent.w ?? DEFAULT_W)
const winH = computed(() => obAgent.h ?? DEFAULT_H)
const sizeText = computed(() => `${Math.round(winW.value)} × ${Math.round(winH.value)}`)

const winStyle = computed<Record<string, string>>(() => {
  // 独立窗口里由外层容器撑满，位置/尺寸归操作系统管
  if (detached.value) return {}
  const st: Record<string, string> = {
    width: `${winW.value}px`,
    height: `${Math.min(winH.value, window.innerHeight - EDGE * 2)}px`
  }
  if (obAgent.x === null) {
    st.right = '22px'
    st.left = 'auto'
  } else {
    st.left = `${obAgent.x}px`
    st.right = 'auto'
  }
  if (obAgent.y === null) {
    st.top = '76px'
    st.bottom = 'auto'
  } else {
    st.top = `${obAgent.y}px`
    st.bottom = 'auto'
  }
  return st
})

let dragFrom: { x: number; y: number; left: number; top: number } | null = null
let footRo: ResizeObserver | null = null

function onHeadDblClick(e: MouseEvent): void {
  if (detached.value) return
  if ((e.target as HTMLElement)?.closest('button, input, textarea')) return
  resetObAgentLayout()
}

function startDrag(e: MouseEvent): void {
  if (detached.value) return // 独立窗口交给 -webkit-app-region: drag
  if (e.button !== 0) return
  if ((e.target as HTMLElement)?.closest('button, input, textarea, .oa-rs')) return
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  obAgent.x = Math.round(r.left)
  obAgent.y = Math.round(r.top)
  if (obAgent.w === null) obAgent.w = Math.round(r.width)
  if (obAgent.h === null) obAgent.h = Math.round(r.height)
  dragFrom = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }
  dragging.value = true
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', endDrag)
}

function onDrag(e: MouseEvent): void {
  if (!dragFrom) return
  const w = Math.min(winW.value, window.innerWidth - EDGE * 2)
  const h = Math.min(winH.value, window.innerHeight - EDGE * 2)
  obAgent.x = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, dragFrom.left + e.clientX - dragFrom.x))
  obAgent.y = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, dragFrom.top + e.clientY - dragFrom.y))
}

function endDrag(): void {
  dragFrom = null
  dragging.value = false
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
  saveObAgentLayout()
}

let resizeFrom: { sx: number; sy: number; w: number; h: number; lx: number; ly: number } | null = null

/**
 * 缩放：
 *  · 窗口内浮窗 —— 直接改 CSS 宽高；
 *  · 独立窗口 —— 用 screenX/screenY 的增量去改窗口 bounds。
 *    这里必须用屏幕坐标：窗口一边变宽，clientX 会跟着漂，用它算增量会卡住。
 */
function startResize(e: PointerEvent): void {
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  resizeFrom = {
    sx: e.clientX,
    sy: e.clientY,
    w: r.width,
    h: r.height,
    lx: e.screenX,
    ly: e.screenY
  }
  if (!detached.value) {
    obAgent.x = Math.round(r.left)
    obAgent.y = Math.round(r.top)
    obAgent.w = Math.round(r.width)
    obAgent.h = Math.round(r.height)
  }
  resizing.value = true
  document.body.style.userSelect = 'none'
  // 指针捕获：拖到窗口外面也继续收 move，缩放不会半路断掉
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 老内核不支持 */ }
  window.addEventListener('pointermove', onResize)
  window.addEventListener('pointerup', endResize)
}

function onResize(e: PointerEvent): void {
  const s = resizeFrom
  if (!s) return
  if (detached.value) {
    const dx = e.screenX - s.lx
    const dy = e.screenY - s.ly
    if (!dx && !dy) return
    s.lx = e.screenX
    s.ly = e.screenY
    // 一帧一次：每个 pointermove 都发 IPC 会让窗口抖动
    pendingDx += dx
    pendingDy += dy
    if (!rafId) rafId = requestAnimationFrame(flushResize)
    return
  }
  const maxW = window.innerWidth - EDGE * 2
  const maxH = window.innerHeight - EDGE * 2
  obAgent.w = Math.round(Math.max(MIN_W, Math.min(maxW, s.w + (e.clientX - s.sx))))
  obAgent.h = Math.round(Math.max(MIN_H, Math.min(maxH, s.h + (e.clientY - s.sy))))
}

let pendingDx = 0
let pendingDy = 0
let rafId = 0

function flushResize(): void {
  rafId = 0
  const dx = pendingDx
  const dy = pendingDy
  pendingDx = 0
  pendingDy = 0
  if (!dx && !dy) return
  void window.sqlpilot.obagentPanelResize(dx, dy)
}

function endResize(): void {
  resizeFrom = null
  resizing.value = false
  document.body.style.userSelect = ''
  window.removeEventListener('pointermove', onResize)
  window.removeEventListener('pointerup', endResize)
  if (!detached.value) saveObAgentLayout()
}

// ---------------------------------------------------------------- 交互

function close(): void {
  closeObAgent()
}

function toggleDetach(): void {
  if (detached.value) void dockObAgent()
  else void detachObAgent()
}

function togglePin(): void {
  void setObAgentPinned(!obAgent.pinned)
}

function copyWith(text: string, key: string): void {
  void copyText(text)
  copied.value = key
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = '' }, 1200)
}

function toggleExpand(cmdId: string): void {
  expanded[cmdId] = !expanded[cmdId]
}

function openLink(href: string): void {
  void window.sqlpilot.openExternal(href)
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void askObAgent()
  }
}

function autoGrow(): void {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(132, Math.max(54, el.scrollHeight))}px`
}

/** 主窗口变小/最大化切换时把浮窗拉回可视范围（否则会有一半跑到窗口外） */
function clampIntoView(): void {
  if (detached.value || obAgent.x === null || obAgent.y === null) return
  const w = Math.min(winW.value, window.innerWidth - EDGE * 2)
  const h = Math.min(winH.value, window.innerHeight - EDGE * 2)
  obAgent.x = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, obAgent.x))
  obAgent.y = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, obAgent.y))
}

function onBodyScroll(): void {
  const el = bodyEl.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

function toBottom(force = false): void {
  if (!force && !atBottom.value) return
  const el = bodyEl.value
  if (el) el.scrollTop = el.scrollHeight
  atBottom.value = true
}

watch(() => [obAgent.items.length, obAgent.busy, obAgent.error, obAgent.reasoningChars], () => nextTick(() => toBottom()))
watch(
  () => obAgent.items.map((x) => (x.kind === 'text' ? x.text.length : 0)).join(','),
  () => nextTick(() => toBottom())
)

function onWinKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.isComposing) {
    e.stopPropagation()
    close()
  }
}

onMounted(async () => {
  bindObAgentEvents()
  bindObAgentUi()
  // 底部工具条会随草稿行数变高：跟着量，回到底部按钮才不会被输入框压住
  if (footEl.value && typeof ResizeObserver !== 'undefined') {
    footRo = new ResizeObserver(() => { footH.value = footEl.value?.offsetHeight || 96 })
    footRo.observe(footEl.value)
    footH.value = footEl.value.offsetHeight || 96
  }
  // 独立窗口：状态由主窗口交过来（主进程保存了快照，加载完直接取）
  if (detached.value) {
    try {
      const r = await window.sqlpilot.obagentPanelHello()
      if (typeof r?.pin === 'boolean') obAgent.pinned = r.pin
      if (r?.snapshot) hydrateObAgent(r.snapshot)
    } catch { /* 主进程已经退出，浮窗自己空着 */ }
  }
  toBottom(true)
  nextTick(() => {
    inputEl.value?.focus()
    autoGrow()
  })
  window.addEventListener('keydown', onWinKey)
  window.addEventListener('resize', clampIntoView)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWinKey)
  window.removeEventListener('resize', clampIntoView)
  if (copiedTimer) clearTimeout(copiedTimer)
  footRo?.disconnect()
  footRo = null
  // 订阅不解（由 openObAgent/askObAgent 保证幂等挂上）：浮窗是 v-if 挂载的，
  // 这里解掉的话「点热点直接发问」的下一帧就没人收事件了。
  if (obAgent.busy) void stopObAgent()
})
</script>

<style scoped>
.oa {
  position: fixed;
  z-index: 320;
  max-width: calc(100vw - 28px);
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: oa-pop 0.16s cubic-bezier(0.2, 0.8, 0.3, 1);
}
.oa.dragging, .oa.resizing { user-select: none; transition: none; }
@keyframes oa-pop { from { transform: translateY(7px) scale(0.995); opacity: 0; } to { transform: none; opacity: 1; } }

/* 独立窗口：填满窗口，圆角/阴影由外层容器留白呈现 */
.oa.detached {
  position: relative;
  left: auto; right: auto; top: auto; bottom: auto;
  width: 100%; height: 100%; max-width: none;
  animation: none;
}

/* ---------------------------------------------------------------- 顶栏 */
.oa-h {
  display: flex; align-items: center; gap: 8px; padding: 9px 10px 8px;
  border-bottom: 1px solid var(--border); flex-shrink: 0; user-select: none;
  background: color-mix(in srgb, var(--bg-card) 92%, var(--bg-code));
}
.oa-h.grab { cursor: grab; }
.oa-h.grab:active { cursor: grabbing; }
.oa.detached .oa-h { -webkit-app-region: drag; }
.oa.detached .oa-h button,
.oa.detached .oa-h .oa-seg { -webkit-app-region: no-drag; }

.oa-logo {
  width: 24px; height: 24px; flex-shrink: 0; border-radius: 7px; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--accent); background: var(--accent-dim);
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: inset 0 0 10px color-mix(in srgb, var(--accent) 18%, transparent);
}
.oa-title { min-width: 0; line-height: 1.25; }
.oa-title b { display: block; font-size: 12.5px; letter-spacing: 0.2px; }
.oa-title em {
  display: block; font-style: normal; font-size: 10.5px; color: var(--text-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 210px;
}
.sp { flex: 1; }

.oa-seg {
  display: flex; flex-shrink: 0; padding: 2px; gap: 2px; border-radius: 7px;
  background: var(--bg-input); border: 1px solid var(--border);
}
.oa-seg button {
  height: 20px; padding: 0 8px; font-size: 10.5px; font-family: inherit; cursor: pointer;
  background: transparent; color: var(--text-dim); border: none; border-radius: 5px;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.oa-seg button:hover { color: var(--text); }
.oa-seg button.on { color: var(--on-accent); background: var(--accent); font-weight: 600; }

.oa-ic {
  flex-shrink: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-dim);
  cursor: pointer; padding: 0;
  transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.oa-ic svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.oa-ic:hover:not(:disabled) { color: var(--text); background: var(--bg-card-hover); border-color: var(--border); }
.oa-ic:active:not(:disabled) { transform: translateY(0.5px); }
.oa-ic:disabled { opacity: 0.35; cursor: default; }
.oa-ic.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-dim); }
.oa-ic.close:hover { color: var(--red); border-color: color-mix(in srgb, var(--red) 50%, transparent); background: var(--red-dim); }

/* ---------------------------------------------------------------- 只读提示 */
.oa-guard {
  display: flex; align-items: center; gap: 6px; padding: 4px 11px; flex-shrink: 0;
  font-size: 10.5px; color: var(--text-faint);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-bottom: 1px solid var(--border);
}
.oa-tag {
  flex-shrink: 0; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 4px; padding: 0 5px; font-family: var(--mono); font-size: 9.5px; line-height: 1.5;
}
.oa-guard-t { line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------------------------------------------------------------- 主体 */
.oa-body {
  flex: 1; min-height: 0; overflow-y: auto; padding: 11px; gap: 10px;
  display: flex; flex-direction: column;
  scrollbar-width: thin; scroll-behavior: auto;
}
.oa-body::-webkit-scrollbar { width: 9px; }
.oa-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 9px; border: 2px solid transparent; background-clip: padding-box; }
.oa-body::-webkit-scrollbar-thumb:hover { background: var(--border-strong); background-clip: padding-box; }

/* 空态贴着输入框（聊天式），不要顶在上边留一大片空白 */
.oa-body.empty { justify-content: flex-end; }

.oa-empty { color: var(--text-faint); font-size: 11.5px; line-height: 1.6; }
.oa-empty p { margin: 0 0 9px; }
.oa-empty-note { color: var(--text-faint); font-size: 10.5px; margin: 0; }
.oa-quick { display: flex; flex-direction: column; gap: 6px; margin-bottom: 9px; }
.oa-quick button {
  display: flex; align-items: center; gap: 7px; text-align: left;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 8px; padding: 7px 9px; font-size: 11.5px; font-family: inherit; cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease, background-color 0.14s ease;
}
.oa-quick button:hover { color: var(--text); border-color: var(--accent); background: var(--accent-dim); }
.oa-q-dot {
  width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%;
  background: var(--accent); opacity: 0.7;
}

/* 问答气泡 */
.oa-msg { display: flex; gap: 8px; align-items: flex-start; animation: oa-in 0.18s ease; }
.oa-msg.user { flex-direction: row-reverse; }
.oa-avatar {
  flex-shrink: 0; width: 21px; height: 21px; margin-top: 1px; border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border);
}
.oa-msg.assistant .oa-avatar {
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: var(--accent-dim);
}
.oa-bubble { min-width: 0; max-width: calc(100% - 31px); font-size: 12px; line-height: 1.72; color: var(--text); }
.oa-msg.user .oa-bubble {
  padding: 5px 10px; border-radius: 9px; border-top-right-radius: 3px; background: var(--accent-dim);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  white-space: pre-wrap; word-break: break-word;
}

/* 命令卡片 */
.oa-cmd {
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-input);
  padding: 8px 9px; display: flex; flex-direction: column; gap: 6px;
  animation: oa-in 0.18s ease;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}
@keyframes oa-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.oa-cmd.deny { border-color: color-mix(in srgb, var(--red) 55%, transparent); background: var(--red-dim); }
.oa-cmd.confirm { border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
.oa-cmd.failed { border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.oa-cmd.waiting { box-shadow: 0 0 0 1px color-mix(in srgb, var(--yellow) 35%, transparent); }

.oa-cmd-h { display: flex; align-items: center; gap: 7px; min-width: 0; }
.oa-risk {
  flex-shrink: 0; font-size: 9.5px; padding: 0 5px; border-radius: 4px; font-family: var(--mono);
  border: 1px solid var(--border); color: var(--text-faint); line-height: 1.6;
}
.oa-cmd.safe .oa-risk { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.oa-cmd.confirm .oa-risk { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
.oa-cmd.deny .oa-risk { color: var(--red); border-color: var(--red); }
.oa-cmd-t {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 11px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.oa-cmd-t.full { white-space: pre-wrap; word-break: break-all; }
.oa-st { flex-shrink: 0; font-size: 10px; color: var(--text-faint); display: inline-flex; align-items: center; gap: 4px; }
.oa-cmd.done .oa-st { color: var(--green); }
.oa-cmd.failed .oa-st, .oa-cmd.blocked .oa-st { color: var(--red); }
.oa-cmd.waiting .oa-st { color: var(--yellow); }
.oa-cmd.skipped .oa-st { color: var(--text-faint); }
.oa-spin {
  width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-top-color: var(--accent); animation: oa-spin 0.8s linear infinite;
}
@keyframes oa-spin { to { transform: rotate(360deg); } }

.oa-why { margin: 0; font-size: 11px; color: var(--text-dim); line-height: 1.6; }
.oa-reason { margin: 0; font-size: 10.5px; color: var(--yellow); line-height: 1.6; }
.oa-cmd.deny .oa-reason { color: var(--red); }

/* 执行中的顶部细进度条：比一行「执行中」更容易用余光看到 */
.oa-progress { height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--accent) 18%, transparent); overflow: hidden; }
.oa-progress i {
  display: block; width: 38%; height: 100%; border-radius: 2px; background: var(--accent);
  animation: oa-slide 1.1s ease-in-out infinite;
}
@keyframes oa-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }

.oa-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.oa-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 7px; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease, background-color 0.14s ease;
}
.oa-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); background: var(--bg-card-hover); }
.oa-btn:active:not(:disabled) { transform: translateY(0.5px); }
.oa-btn:disabled { opacity: 0.45; cursor: default; }
.oa-btn.primary {
  background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600;
}
.oa-btn.primary:hover:not(:disabled) { filter: brightness(1.08); color: var(--on-accent); }
.oa-btn.stop { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }

.oa-cmd-f { display: flex; align-items: center; gap: 8px; }
/* 右边几个操作连排时给条细分隔，别糊成一坨 */
.oa-cmd-f .lnk ~ .lnk { border-left: 1px solid var(--border); padding-left: 8px; }
.oa-meta { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }
.oa-meta.warn { color: var(--yellow); }
.lnk {
  border: none; background: none; padding: 0; font-family: inherit; font-size: 10.5px;
  color: var(--text-faint); cursor: pointer; transition: color 0.14s ease;
}
.lnk:hover:not(:disabled) { color: var(--accent); }
.lnk:disabled { opacity: 0.4; cursor: default; }

.oa-out {
  margin: 2px 0 0; padding: 8px 9px; border-radius: 7px; background: var(--bg-code);
  border: 1px solid var(--border); font-family: var(--mono); font-size: 10.5px; line-height: 1.55;
  color: var(--text-dim); white-space: pre-wrap; word-break: break-all;
  max-height: 220px; overflow: auto;
}

.oa-wait { font-size: 11px; color: var(--text-faint); display: flex; align-items: center; gap: 7px; }
.oa-wait em { font-style: normal; font-family: var(--mono); font-size: 10px; }
.oa-dots { display: inline-flex; gap: 3px; }
.oa-dots i {
  width: 4px; height: 4px; border-radius: 50%; background: var(--accent);
  animation: oa-bounce 1s ease-in-out infinite;
}
.oa-dots i:nth-child(2) { animation-delay: 0.15s; }
.oa-dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes oa-bounce { 0%, 60%, 100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }

.oa-err {
  font-size: 11px; color: var(--red); background: var(--red-dim);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); border-radius: 8px; padding: 6px 9px;
}

.oa-jump {
  position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%);
  width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-strong); background: var(--bg-card); color: var(--text-dim);
  cursor: pointer; box-shadow: var(--shadow-sm, 0 6px 16px rgba(0, 0, 0, 0.3));
  z-index: 4; animation: oa-in 0.16s ease;
}
.oa-jump:hover { color: var(--accent); border-color: var(--accent); }
.oa-jump svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }

/* ---------------------------------------------------------------- 输入区 */
.oa-f {
  border-top: 1px solid var(--border); padding: 8px 10px 9px;
  display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
  background: color-mix(in srgb, var(--bg-card) 96%, var(--bg-code));
}
.oa-input {
  width: 100%; box-sizing: border-box; resize: none; height: 54px; padding: 8px 11px;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-input); color: var(--text);
  font-family: inherit; font-size: 11.5px; line-height: 1.62; outline: none; overflow-y: auto;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.oa-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
}
.oa-row { display: flex; align-items: center; gap: 6px; }
.oa-tip { font-size: 10px; color: var(--text-faint); }

.oa-send {
  width: 27px; height: 27px; flex-shrink: 0; border-radius: 8px; padding: 0;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent);
  transition: filter 0.14s ease, opacity 0.14s ease;
}
.oa-send svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.oa-send:hover:not(:disabled) { filter: brightness(1.1); }
.oa-send:disabled { opacity: 0.3; cursor: default; }

/* ---------------------------------------------------------------- 缩放手柄 */
.oa-rs {
  position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; z-index: 3;
  cursor: nwse-resize; color: var(--text-faint); opacity: 0.55;
  display: flex; align-items: flex-end; justify-content: flex-end;
  transition: opacity 0.14s ease, color 0.14s ease;
  touch-action: none;
}
.oa-rs:hover { opacity: 1; color: var(--accent); }
.oa-rs svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }

.oa-size {
  position: absolute; right: 18px; bottom: 10px; z-index: 4; pointer-events: none;
  font-family: var(--mono); font-size: 10px; color: var(--text-faint);
  background: var(--bg-side); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
}
</style>
