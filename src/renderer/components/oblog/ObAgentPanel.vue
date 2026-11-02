<template>
  <div ref="rootEl" class="oa" :class="{ resizing }" :style="winStyle" @keydown.esc.stop="close">
    <!-- 顶栏：拖动移位、双击恢复默认 -->
    <header class="oa-h" title="拖动可移动浮窗，双击恢复默认位置与大小" @mousedown="startDrag" @dblclick="onHeadDblClick">
      <span class="oa-logo">✦</span>
      <div class="oa-title">
        <b>故障排查 Agent</b>
        <em>{{ where }}</em>
      </div>
      <span class="sp"></span>
      <div class="oa-mode" :title="modeTip">
        <button :class="{ on: obAgent.mode === 'auto' }" @click.stop="setObAgentMode('auto')">只读自动</button>
        <button :class="{ on: obAgent.mode === 'confirm' }" @click.stop="setObAgentMode('confirm')">逐条确认</button>
      </div>
      <button class="oa-hb icon" title="新对话（清空当前记录）" :disabled="obAgent.busy || !obAgent.items.length" @click.stop="clearObAgent">＋</button>
      <button class="oa-hb icon" title="关闭 (Esc)" @click.stop="close">✕</button>
    </header>

    <!-- 安全边界常驻一行：让人随时知道这个 agent 能干什么、不能干什么 -->
    <div class="oa-guard">
      <span class="oa-tag">只读</span>
      <span class="oa-guard-t">
        命令先过安全策略：改数据 / 重启 / 改配置 / 提权 / 写文件一律拦下，执行记录进审计。
      </span>
    </div>

    <div ref="bodyEl" class="oa-body">
      <div v-if="!obAgent.items.length" class="oa-empty">
        <p>基于上面的日志结论，我可以连到目标主机上跑只读命令，把根因查出来。</p>
        <div class="oa-quick">
          <button v-for="q in quickPrompts()" :key="q" @click="askObAgent(q)">{{ q }}</button>
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
            <span class="oa-risk" :title="it.cmd.reason">{{ RISK[it.cmd.risk] }}</span>
            <code class="oa-cmd-t" :title="it.cmd.command">{{ it.cmd.command }}</code>
            <!-- 拦截时风险徽标已经写了「已拦截」，右边不再重复一遍 -->
            <span v-if="it.cmd.status !== 'blocked'" class="oa-st">{{ STATUS[it.cmd.status] }}</span>
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

          <div class="oa-cmd-f">
            <button class="lnk" :disabled="!it.cmd.output" @click="toggleCmdOutput(it.cmdId)">
              {{ it.cmd.open ? '收起输出' : '查看输出' }}
            </button>
            <span class="sp"></span>
            <span v-if="it.cmd.ms != null" class="oa-meta">{{ it.cmd.ms }}ms</span>
            <span v-if="it.cmd.note" class="oa-meta warn">{{ it.cmd.note }}</span>
            <button class="lnk" title="复制这条命令" @click="copyText(it.cmd.command)">复制</button>
          </div>

          <pre v-if="it.cmd.open && it.cmd.output" class="oa-out">{{ it.cmd.output }}</pre>
        </div>
      </template>

      <div v-if="obAgent.busy && !streaming" class="oa-wait">
        排查中…<i v-if="obAgent.reasoningChars">已思考 {{ obAgent.reasoningChars }} 字</i>
      </div>
      <div v-if="obAgent.error" class="oa-err">{{ obAgent.error }}</div>
    </div>

    <footer class="oa-f">
      <textarea
        ref="inputEl"
        v-model="obAgent.draft"
        class="oa-input"
        :placeholder="placeholder"
        spellcheck="false"
        @keydown="onInputKey"
      ></textarea>
      <div class="oa-row">
        <span class="oa-tip">{{ obAgent.busy ? '排查中，随时可停' : 'Enter 发送 · Shift+Enter 换行' }}</span>
        <span class="sp"></span>
        <button v-if="obAgent.busy" class="oa-btn stop" @click="stopObAgent">停止</button>
        <button class="oa-btn primary" :disabled="!obAgent.draft.trim() || obAgent.busy" @click="askObAgent()">发送</button>
      </div>
    </footer>

    <span class="oa-rs" title="拖动调整大小（双击标题栏恢复默认）" @mousedown.stop.prevent="startResize"></span>
    <span v-if="resizing" class="oa-size">{{ Math.round(winW) }} × {{ Math.round(winH) }}</span>
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
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MdMessage from '../common/MdMessage.vue'
import {
  approveCmd,
  askObAgent,
  bindObAgentEvents,
  clearObAgent,
  closeObAgent,
  copyText,
  obAgent,
  quickPrompts,
  resetObAgentLayout,
  saveObAgentLayout,
  setObAgentMode,
  stopObAgent,
  toggleCmdOutput,
  type ObAgentCmd,
  type ObRisk
} from '../../oblog/agent'

const rootEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const resizing = ref(false)

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

const winStyle = computed<Record<string, string>>(() => {
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

function onHeadDblClick(e: MouseEvent): void {
  if ((e.target as HTMLElement)?.closest('button, input, textarea')) return
  resetObAgentLayout()
}

function startDrag(e: MouseEvent): void {
  if ((e.target as HTMLElement)?.closest('button, input, textarea, .oa-rs')) return
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  obAgent.x = Math.round(r.left)
  obAgent.y = Math.round(r.top)
  if (obAgent.w === null) obAgent.w = Math.round(r.width)
  if (obAgent.h === null) obAgent.h = Math.round(r.height)
  dragFrom = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }
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
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
  saveObAgentLayout()
}

let resizeFrom: { sx: number; sy: number; w: number; h: number } | null = null

function startResize(e: MouseEvent): void {
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  obAgent.x = Math.round(r.left)
  obAgent.y = Math.round(r.top)
  obAgent.w = Math.round(r.width)
  obAgent.h = Math.round(r.height)
  resizeFrom = { sx: e.clientX, sy: e.clientY, w: r.width, h: r.height }
  resizing.value = true
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', endResize)
}

function onResize(e: MouseEvent): void {
  const s = resizeFrom
  if (!s) return
  const maxW = window.innerWidth - EDGE * 2
  const maxH = window.innerHeight - EDGE * 2
  obAgent.w = Math.round(Math.max(MIN_W, Math.min(maxW, s.w + (e.clientX - s.sx))))
  obAgent.h = Math.round(Math.max(MIN_H, Math.min(maxH, s.h + (e.clientY - s.sy))))
}

function endResize(): void {
  resizeFrom = null
  resizing.value = false
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', endResize)
  saveObAgentLayout()
}

// ---------------------------------------------------------------- 交互

function close(): void {
  closeObAgent()
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

function toBottom(): void {
  const el = bodyEl.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => [obAgent.items.length, obAgent.busy, obAgent.error, obAgent.reasoningChars], () => nextTick(toBottom))
watch(
  () => obAgent.items.map((x) => (x.kind === 'text' ? x.text.length : 0)).join(','),
  () => nextTick(toBottom)
)

function onWinKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.isComposing) {
    e.stopPropagation()
    close()
  }
}

onMounted(() => {
  bindObAgentEvents()
  toBottom()
  nextTick(() => inputEl.value?.focus())
  window.addEventListener('keydown', onWinKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWinKey)
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
  animation: oa-pop 0.15s ease;
}
.oa.resizing { user-select: none; }
@keyframes oa-pop { from { transform: translateY(6px); opacity: 0.7; } to { transform: none; opacity: 1; } }

.oa-h {
  display: flex; align-items: center; gap: 8px; padding: 10px 11px 9px;
  border-bottom: 1px solid var(--border); cursor: move; user-select: none; flex-shrink: 0;
}
.oa-logo {
  width: 22px; height: 22px; flex-shrink: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent);
}
.oa-title { min-width: 0; }
.oa-title b { display: block; font-size: 12.5px; }
.oa-title em {
  display: block; font-style: normal; font-size: 10.5px; color: var(--text-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 230px;
}
.sp { flex: 1; }

.oa-mode { display: flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.oa-mode button {
  height: 22px; padding: 0 7px; font-size: 10.5px; font-family: inherit; cursor: pointer;
  background: transparent; color: var(--text-dim); border: none; border-right: 1px solid var(--border);
}
.oa-mode button:last-child { border-right: none; }
.oa-mode button:hover { color: var(--text); background: var(--bg-card-hover); }
.oa-mode button.on { color: var(--on-accent); background: var(--accent); }

.oa-hb {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 3px 8px; font-size: 11px; font-family: inherit; cursor: pointer; flex-shrink: 0;
}
.oa-hb:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.oa-hb:disabled { opacity: 0.45; cursor: default; }
.oa-hb.icon { padding: 3px 7px; }
.oa-hb.icon:hover:not(:disabled) { color: var(--red); border-color: var(--red); }

.oa-guard {
  display: flex; align-items: center; gap: 6px; padding: 5px 11px; flex-shrink: 0;
  font-size: 10.5px; color: var(--text-faint);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-bottom: 1px solid var(--border);
}
.oa-tag {
  flex-shrink: 0; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 4px; padding: 0 5px; font-family: var(--mono);
}
.oa-guard-t { line-height: 1.5; }

.oa-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 11px; display: flex; flex-direction: column; gap: 9px; }

.oa-empty { color: var(--text-faint); font-size: 11.5px; line-height: 1.6; }
.oa-empty p { margin: 0 0 8px; }
.oa-empty-note { color: var(--text-faint); font-size: 10.5px; }
.oa-quick { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.oa-quick button {
  text-align: left; border: 1px dashed var(--border-strong); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 5px 9px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.oa-quick button:hover { color: var(--accent); border-color: var(--accent); border-style: solid; }

/* 问答气泡 */
.oa-msg { display: flex; gap: 7px; align-items: flex-start; }
.oa-msg.user { flex-direction: row-reverse; }
.oa-avatar {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border);
}
.oa-msg.assistant .oa-avatar { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.oa-bubble { min-width: 0; max-width: calc(100% - 30px); font-size: 12px; line-height: 1.7; color: var(--text); }
.oa-msg.user .oa-bubble {
  padding: 5px 9px; border-radius: 8px; background: var(--accent-dim);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); white-space: pre-wrap; word-break: break-word;
}

/* 命令卡片 */
.oa-cmd {
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input);
  padding: 7px 9px; display: flex; flex-direction: column; gap: 5px;
}
.oa-cmd.deny { border-color: color-mix(in srgb, var(--red) 55%, transparent); background: var(--red-dim); }
.oa-cmd.confirm { border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
.oa-cmd.failed { border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.oa-cmd.waiting { box-shadow: 0 0 0 1px color-mix(in srgb, var(--yellow) 35%, transparent); }

.oa-cmd-h { display: flex; align-items: center; gap: 7px; min-width: 0; }
.oa-risk {
  flex-shrink: 0; font-size: 9.5px; padding: 0 5px; border-radius: 4px; font-family: var(--mono);
  border: 1px solid var(--border); color: var(--text-faint);
}
.oa-cmd.safe .oa-risk { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.oa-cmd.confirm .oa-risk { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
.oa-cmd.deny .oa-risk { color: var(--red); border-color: var(--red); }
.oa-cmd-t {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 11px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.oa-st { flex-shrink: 0; font-size: 10px; color: var(--text-faint); }
.oa-cmd.done .oa-st { color: var(--green); }
.oa-cmd.failed .oa-st, .oa-cmd.blocked .oa-st { color: var(--red); }
.oa-cmd.waiting .oa-st { color: var(--yellow); }
.oa-cmd.skipped .oa-st { color: var(--text-faint); }

.oa-why { margin: 0; font-size: 11px; color: var(--text-dim); line-height: 1.6; }
.oa-reason { margin: 0; font-size: 10.5px; color: var(--yellow); line-height: 1.6; }
.oa-cmd.deny .oa-reason { color: var(--red); }

.oa-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.oa-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; padding: 3px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.oa-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.oa-btn:disabled { opacity: 0.45; cursor: default; }
.oa-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
.oa-btn.stop { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }

.oa-cmd-f { display: flex; align-items: center; gap: 8px; }
.oa-meta { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }
.oa-meta.warn { color: var(--yellow); }
.lnk {
  border: none; background: none; padding: 0; font-family: inherit; font-size: 10.5px;
  color: var(--text-faint); cursor: pointer;
}
.lnk:hover:not(:disabled) { color: var(--accent); }
.lnk:disabled { opacity: 0.4; cursor: default; }

.oa-out {
  margin: 2px 0 0; padding: 7px 8px; border-radius: 6px; background: var(--bg-code);
  border: 1px solid var(--border); font-family: var(--mono); font-size: 10.5px; line-height: 1.55;
  color: var(--text-dim); white-space: pre-wrap; word-break: break-all;
  max-height: 210px; overflow: auto;
}

.oa-wait { font-size: 11px; color: var(--text-faint); }
.oa-wait i { font-style: normal; margin-left: 6px; font-family: var(--mono); }
.oa-err {
  font-size: 11px; color: var(--red); background: var(--red-dim);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); border-radius: 7px; padding: 5px 8px;
}

.oa-f {
  border-top: 1px solid var(--border); padding: 8px 10px 9px;
  display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
}
.oa-input {
  width: 100%; box-sizing: border-box; resize: none; height: 54px; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); color: var(--text);
  font-family: inherit; font-size: 11.5px; line-height: 1.6; outline: none;
}
.oa-input:focus { border-color: var(--accent); }
.oa-row { display: flex; align-items: center; gap: 6px; }
.oa-tip { font-size: 10px; color: var(--text-faint); }

.oa-rs {
  position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; z-index: 3;
  cursor: nwse-resize;
}
.oa-size {
  position: absolute; right: 12px; bottom: 10px; z-index: 4; pointer-events: none;
  font-family: var(--mono); font-size: 10px; color: var(--text-faint);
  background: var(--bg-side); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
}
</style>
