<template>
  <div ref="rootEl" class="eai" :class="{ busy: edAi.streaming, resizing }" :style="winStyle" @keydown.esc.stop="close">
    <!-- 顶栏：拖动移动、双击恢复默认大小 -->
    <header class="eai-h" title="拖动可移动浮窗，双击恢复默认位置与大小" @mousedown="startDrag" @dblclick="onHeadDblClick">
      <span class="eai-logo">✦</span>
      <div class="eai-title">
        <b>{{ isMulti ? '多文件提问' : '选中文本提问' }}</b>
        <em>{{ metaLine }}</em>
      </div>
      <span class="sp"></span>
      <button class="eai-hb" :class="{ on: edAi.skills.length > 0 }" :title="skillTip" @click.stop="skillOpen = !skillOpen">
        技能<i v-if="edAi.skills.length" class="badge">{{ edAi.skills.length }}</i>
      </button>
      <button class="eai-hb" :title="pickTip" @click.stop="pickFiles">
        文件<i v-if="fileCount > 1" class="badge">{{ fileCount }}</i>
      </button>
      <button class="eai-hb" :class="{ on: edAi.historyOpen }" title="历史会话：点开可回到之前的问答" @click.stop="toggleEditorAiHistory">
        历史<i v-if="edAi.history.length" class="badge">{{ edAi.history.length }}</i>
      </button>
      <button class="eai-hb icon" title="新对话：清空当前问答（历史里仍有记录）" :disabled="edAi.streaming || !edAi.messages.length" @click.stop="clearEditorAi">＋</button>
      <button class="eai-hb icon" title="关闭 (Esc)" @click.stop="close">✕</button>
    </header>

    <!-- 技能选择：勾上后技能正文作为「回答规范」随问题发送 -->
    <SkillPicker
      v-if="skillOpen"
      :selected="edAi.skills"
      @update:selected="edAi.skills = $event"
      @close="skillOpen = false"
    />

    <!-- 选中的原文：默认收起几行，展开可看全文（只读，改不了文件） -->
    <div class="eai-sel" :class="{ open: selOpen }">
      <button class="eai-sel-h" @click="selOpen = !selOpen">
        <span class="tag">{{ scopeTag }}</span>
        <span class="n">{{ edAi.selection.length }} 字符</span>
        <span class="sp"></span>
        <span class="tg">{{ selOpen ? '收起' : '展开' }}</span>
      </button>
      <pre class="eai-sel-t">{{ preview }}</pre>
    </div>

    <!-- 历史会话列表（占用正文区） -->
    <div v-if="edAi.historyOpen" class="eai-body eai-hist">
      <div class="hist-h">
        <b>历史会话</b>
        <span class="n">{{ edAi.history.length }} 条</span>
        <span class="sp"></span>
        <button class="hist-pick" title="选择文件作为上下文（可多选）" @click="pickFiles">＋ 选择文件</button>
        <span class="note">点一条回到那次问答，可继续追问</span>
      </div>
      <div v-if="edAi.historyLoading" class="hist-empty">读取中…</div>
      <div v-else-if="!edAi.history.length" class="hist-empty">
        还没有历史会话（回答完第一条问题才会记录，存在本机）
      </div>
      <button
        v-for="h in edAi.history"
        :key="h.id"
        class="hist-item"
        :class="{ on: h.id === edAi.sessionId }"
        :title="`${h.title}\n${histWhere(h)}\n${h.selectionChars} 字符${h.truncated ? '（已截断）' : ''}`"
        @click="openEditorAiSession(h.id)"
      >
        <span class="hi-main">
          <b>{{ h.title }}</b>
          <em>{{ rel(h.updatedAt) }} · {{ h.messageCount }} 条 · {{ h.file || '未命名' }}</em>
        </span>
        <span class="hi-del" title="删除这条记录" @click.stop="removeEditorAiSession(h.id)">✕</span>
      </button>
    </div>

    <!-- 问答正文 -->
    <div v-else ref="bodyEl" class="eai-body">
      <div v-if="!edAi.messages.length && !edAi.streaming" class="eai-empty">
        <p>{{ isMulti ? '针对这 ' + fileCount + ' 个文件提问，例如：' : '针对这段文本提问，例如：' }}</p>
        <div class="eai-quick">
          <button v-for="q in quick" :key="q" @click="askEditorAi(q)">{{ q }}</button>
        </div>
      </div>

      <MdMessage v-for="m in edAi.messages" :key="m.id" :text="m.text" :role="m.role" @link="openLink">
        <template #avatar>{{ m.role === 'user' ? '我' : '✦' }}</template>
      </MdMessage>

      <template v-if="edAi.streaming">
        <MdMessage v-if="edAi.streamText" :text="edAi.streamText" role="assistant" streaming @link="openLink">
          <template #avatar>✦</template>
        </MdMessage>
        <div v-else class="wait">
          思考中…<i v-if="edAi.reasoning">已思考 {{ edAi.reasoning }} 字</i>
        </div>
      </template>

      <div v-if="edAi.error" class="eai-err">{{ edAi.error }}</div>
    </div>

    <footer class="eai-f">
      <textarea
        ref="inputEl"
        v-model="edAi.input"
        class="eai-input"
        :placeholder="askPlaceholder"
        spellcheck="false"
        @keydown="onInputKey"
      ></textarea>
      <div class="eai-row">
        <span class="eai-tip">{{ isMulti ? `只读这 ${fileCount} 个文件，不会改动任何文件` : '只读选中内容，不会改动文件' }}</span>
        <span class="sp"></span>
        <button v-if="edAi.streaming" class="eai-btn stop" @click="stopEditorAi">停止</button>
        <button class="eai-btn primary" :disabled="!edAi.input.trim() || edAi.streaming" @click="askEditorAi()">发送</button>
      </div>
    </footer>

    <!-- 八向缩放手柄 -->
    <span
      v-for="d in RESIZE_DIRS"
      :key="d"
      class="eai-rs"
      :class="`rs-${d}`"
      :title="d === 'se' ? '拖动调整大小（双击标题栏恢复默认）' : ''"
      @mousedown.stop.prevent="startResize($event, d)"
    ></span>
    <span v-if="resizing" class="eai-size">{{ Math.round(winW) }} × {{ Math.round(winH) }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * 文本编辑器 · 选中文本 AI 浮窗。
 *
 * 交互：顶栏可拖动 / 双击重置、八向缩放、历史会话可回看并继续追问。
 * 只把「选中的那段文本 + 这一串问答」交给模型，不改文档、不写进项目目录。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  EAI_MIN_H,
  EAI_MIN_W,
  askEditorAi,
  clampEdAiToViewport,
  clampSize,
  clearEditorAi,
  closeEditorAi,
  edAi,
  openEditorAiPicker,
  openEditorAiSession,
  rel,
  removeEditorAiSession,
  resetEdAiSize,
  saveEdAiPos,
  selSummary,
  stopEditorAi,
  toggleEditorAiHistory
} from '../../editor/ai'
import MdMessage from '../common/MdMessage.vue'
import SkillPicker from '../common/SkillPicker.vue'

const rootEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const selOpen = ref(false)
const resizing = ref(false)
/** 技能选择面板 */
const skillOpen = ref(false)

const skillTip = computed(() =>
  edAi.skills.length
    ? `本次对话已启用 ${edAi.skills.length} 个技能：回答会按它们的步骤与口径来`
    : '技能：勾上后把技能正文作为回答规范（不执行技能里的工具）'
)

const EDGE = 14
const DEFAULT_W = 430
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
type ResizeDir = (typeof RESIZE_DIRS)[number]

// ---------------------------------------------------------------- 位置 / 尺寸

const winW = computed(() => edAi.w ?? DEFAULT_W)
const winH = computed(() => edAi.h ?? 520)

/**
 * 位置默认贴右下角（x/y 为 null）：
 * 用 right/bottom 而不是 left/top，窗口缩放时不会跑到外面去。
 */
const winStyle = computed<Record<string, string>>(() => {
  const st: Record<string, string> = {}
  st.width = edAi.w === null ? `${DEFAULT_W}px` : `${edAi.w}px`
  st.height = edAi.h === null ? 'min(560px, calc(100vh - 120px))' : `${edAi.h}px`
  if (edAi.x === null) {
    st.right = '20px'
    st.left = 'auto'
  } else {
    st.left = `${edAi.x}px`
    st.right = 'auto'
  }
  if (edAi.y === null) {
    st.bottom = '48px'
    st.top = 'auto'
  } else {
    st.top = `${edAi.y}px`
    st.bottom = 'auto'
  }
  return st
})

let dragFrom: { x: number; y: number; left: number; top: number } | null = null

/** 双击标题栏（不含按钮）恢复默认位置与大小 */
function onHeadDblClick(e: MouseEvent): void {
  if ((e.target as HTMLElement)?.closest('button, input, textarea')) return
  resetEdAiSize()
}

function startDrag(e: MouseEvent): void {
  if ((e.target as HTMLElement)?.closest('button, input, textarea, .eai-rs')) return
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // 默认停在右下角时先固化成绝对坐标，否则一拖就跳
  edAi.x = Math.round(r.left)
  edAi.y = Math.round(r.top)
  if (edAi.w === null) edAi.w = Math.round(r.width)
  if (edAi.h === null) edAi.h = Math.round(r.height)
  dragFrom = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', endDrag)
}

function onDrag(e: MouseEvent): void {
  if (!dragFrom) return
  const w = Math.min(winW.value, window.innerWidth - EDGE * 2)
  const h = Math.min(winH.value, window.innerHeight - EDGE * 2)
  edAi.x = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, dragFrom.left + e.clientX - dragFrom.x))
  edAi.y = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, dragFrom.top + e.clientY - dragFrom.y))
}

function endDrag(): void {
  dragFrom = null
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
  saveEdAiPos()
}

let resizeFrom: { dir: ResizeDir; sx: number; sy: number; left: number; top: number; w: number; h: number } | null = null

function startResize(e: MouseEvent, dir: ResizeDir): void {
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  edAi.x = Math.round(r.left)
  edAi.y = Math.round(r.top)
  edAi.w = Math.round(r.width)
  edAi.h = Math.round(r.height)
  resizeFrom = { dir, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height }
  resizing.value = true
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', endResize)
}

function onResize(e: MouseEvent): void {
  const s = resizeFrom
  if (!s) return
  const maxW = Math.max(EAI_MIN_W, window.innerWidth - EDGE * 2)
  const maxH = Math.max(EAI_MIN_H, window.innerHeight - EDGE * 2)
  const dx = e.clientX - s.sx
  const dy = e.clientY - s.sy
  let w = s.w
  let h = s.h
  if (s.dir.includes('e')) w = s.w + dx
  if (s.dir.includes('w')) w = s.w - dx
  if (s.dir.includes('s')) h = s.h + dy
  if (s.dir.includes('n')) h = s.h - dy
  w = clampSize(w, EAI_MIN_W, maxW)
  h = clampSize(h, EAI_MIN_H, maxH)
  // 从左边 / 上边拉时，宽高变了要同步挪 left / top，视觉上才是「那条边在动」
  let left = s.dir.includes('w') ? s.left + (s.w - w) : s.left
  let top = s.dir.includes('n') ? s.top + (s.h - h) : s.top
  left = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, left))
  top = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, top))
  edAi.w = Math.round(w)
  edAi.h = Math.round(h)
  edAi.x = Math.round(left)
  edAi.y = Math.round(top)
}

function endResize(): void {
  resizeFrom = null
  resizing.value = false
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', endResize)
  saveEdAiPos()
}

// ---------------------------------------------------------------- 文案

const fileCount = computed(() => edAi.meta?.files?.length || 0)
const isMulti = computed(() => fileCount.value > 1)
const scopeTag = computed(() => (isMulti.value ? '上下文' : '选中'))
const pickTip = computed(() =>
  isMulti.value ? `当前读了 ${fileCount.value} 个文件，点这里换 / 加文件` : '选择文件作为上下文（可多选）'
)
const askPlaceholder = computed(() =>
  isMulti.value
    ? '针对这些文件提问（可以让我对比、找问题），Enter 发送 / Shift+Enter 换行'
    : '针对选中的文本提问，Enter 发送 / Shift+Enter 换行'
)

const metaLine = computed(() => {
  const m = edAi.meta
  // 多文件时文件名已经写在「a.sql 等 3 个文件」里，这里不再重复，只给语言
  const where = m ? (isMulti.value ? m.lang || '多文件' : `${m.file || '未命名'} · ${m.lang || '纯文本'}`) : ''
  const cut = m?.truncated ? '（内容过长，只读了一部分）' : ''
  return [where, selSummary(m, edAi.selection.length) + cut].filter(Boolean).join(' · ')
})

/** 收起时：单段选区给前 4 行；多文件只列文件分隔头（一眼看出读了哪几个文件） */
const preview = computed(() => {
  const t = edAi.selection
  if (selOpen.value) return t.length > 6000 ? `${t.slice(0, 6000)}\n…（过长，只显示前 6000 字符）` : t
  if (isMulti.value) {
    const names = t
      .split('\n')
      .filter((l) => l.startsWith('===== 文件：'))
      .map((l) => l.replace(/^=====\s*文件：\s*/, '').replace(/\s*=====$/, ''))
    return `${names.map((n) => `· ${n}`).join('\n')}\n…（共 ${edAi.selection.length} 字符，展开可看全文）`
  }
  const lines = t.split('\n')
  const head = lines.slice(0, 4).join('\n')
  return lines.length > 4 ? `${head}\n…` : head
})

/** 快捷问题按语言给几组（少而准，避免堆一排按钮） */
const quick = computed(() => {
  if (isMulti.value) {
    return ['这几个文件之间有什么对不上的地方？', '按这些文件梳理一遍关键逻辑', '哪里有风险或缺失？']
  }
  const lang = (edAi.meta?.lang || '').toLowerCase()
  if (lang.includes('sql')) return ['这段 SQL 有什么性能隐患？', '解释一下这段 SQL 在做什么', '帮我改写成等价的更优 SQL']
  if (lang.includes('markdown')) return ['这段内容有什么表达问题？', '帮我压缩成更短的版本', '按这段内容提炼要点']
  if (lang) return ['解释一下这段代码', '这段代码有什么问题或风险？', '帮我改写得更清晰', '补上必要的注释']
  return ['总结这段内容', '有没有事实或逻辑错误？', '帮我改写得更清楚']
})

/** 历史条目的上下文说明：整篇 / 第几到第几行 */
function histWhere(h: EditorAiSessionMeta): string {
  if (h.files && h.files.length > 1) {
    return `${h.files.length} 个文件：${h.files.slice(0, 3).join('、')}${h.files.length > 3 ? ' 等' : ''} · ${h.lang || '多语言'}`
  }
  const scope = h.wholeFile
    ? `整篇 ${h.lines.end} 行`
    : h.lines.start === h.lines.end
      ? `第 ${h.lines.start} 行`
      : `第 ${h.lines.start}-${h.lines.end} 行`
  return `${h.file || '未命名'} · ${h.lang || '纯文本'} · ${scope}`
}

/** 回答里的外链用系统浏览器打开（渲染层默认会拦掉页面跳转） */
function openLink(href: string): void {
  void window.sqlpilot.openExternal(href)
}

function close(): void {
  closeEditorAi()
}

/** 换 / 加文件：打开选择器，当前已读的文件预先勾上 */
function pickFiles(): void {
  openEditorAiPicker(edAi.files.map((f) => f.path))
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void askEditorAi()
  }
}

// ---------------------------------------------------------------- 滚动到底 / 生命周期

function toBottom(): void {
  const el = bodyEl.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => [edAi.messages.length, edAi.streamText], () => nextTick(toBottom))
// 从历史里切回来时正文变了，也要落到底部
watch(() => edAi.sessionId, () => {
  skillOpen.value = false
  nextTick(toBottom)
})
watch(() => edAi.historyOpen, (v) => {
  if (v) skillOpen.value = false
})

function onWinKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.isComposing) {
    e.stopPropagation()
    close()
  }
}

function onWinResize(): void {
  clampEdAiToViewport()
}

onMounted(() => {
  toBottom()
  nextTick(() => inputEl.value?.focus())
  window.addEventListener('keydown', onWinKey)
  window.addEventListener('resize', onWinResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWinKey)
  window.removeEventListener('resize', onWinResize)
  // 浮窗被外层销毁时（切模块/关标签）也要停掉流式请求
  if (edAi.streaming) void stopEditorAi()
})
</script>

<style scoped>
.eai {
  position: fixed;
  z-index: 320;
  max-width: calc(100vw - 28px);
  max-height: calc(100vh - 28px);
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: eai-pop 0.15s ease;
}
/* 拖动/缩放期间别选中文字 */
.eai.resizing { user-select: none; }
@keyframes eai-pop { from { transform: translateY(6px); opacity: 0.7; } to { transform: none; opacity: 1; } }

.eai-h {
  display: flex; align-items: center; gap: 8px; padding: 10px 11px 9px;
  border-bottom: 1px solid var(--border); cursor: move; user-select: none;
}
.eai-logo {
  width: 22px; height: 22px; flex-shrink: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent);
}
.eai-title { min-width: 0; }
.eai-title b { display: block; font-size: 12.5px; }
.eai-title em { display: block; font-style: normal; font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp { flex: 1; }
.eai-hb {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 3px 8px; font-size: 11px; font-family: inherit; cursor: pointer; flex-shrink: 0;
}
.eai-hb:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.eai-hb:disabled { opacity: 0.45; cursor: default; }
.eai-hb.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.eai-hb.icon { padding: 3px 7px; }
.eai-hb.icon:hover { color: var(--red); border-color: var(--red); }
.eai-hb .badge { font-style: normal; margin-left: 4px; font-family: var(--mono); font-size: 9.5px; padding: 0 4px; border-radius: 99px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-faint); }

/* 选中文本预览 */
.eai-sel { border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--accent) 4%, transparent); flex-shrink: 0; }
.eai-sel-h {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 10px;
  border: none; background: none; color: var(--text-dim); font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.eai-sel-h .tag { color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 4px; padding: 0 5px; }
.eai-sel-h .n { color: var(--text-faint); font-family: var(--mono); }
.eai-sel-h .tg { color: var(--text-faint); }
.eai-sel-t {
  margin: 0; padding: 0 10px 8px; font-family: var(--mono); font-size: 10.5px; line-height: 1.55;
  color: var(--text-dim); white-space: pre-wrap; word-break: break-all;
  max-height: 78px; overflow: hidden;
}
.eai-sel.open .eai-sel-t { max-height: 200px; overflow-y: auto; }

.eai-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 11px; display: flex; flex-direction: column; gap: 9px; }
.eai-empty { color: var(--text-faint); font-size: 11.5px; }
.eai-empty p { margin: 0 0 7px; }
.eai-quick { display: flex; flex-wrap: wrap; gap: 6px; }
.eai-quick button {
  border: 1px dashed var(--border-strong); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3px 9px; font-size: 11px; font-family: inherit; cursor: pointer; text-align: left;
}
.eai-quick button:hover { color: var(--accent); border-color: var(--accent); border-style: solid; }

/* 历史会话 */
.eai-hist { gap: 4px; }
.hist-h { display: flex; align-items: baseline; gap: 7px; padding: 1px 2px 4px; }
.hist-h b { font-size: 11.5px; }
.hist-h .n { font-family: var(--mono); font-size: 10px; color: var(--text-faint); }
.hist-h .note { font-size: 10px; color: var(--text-faint); }
.hist-pick {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 2px 7px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.hist-pick:hover { color: var(--accent); border-color: var(--accent); }
.hist-empty { font-size: 10.5px; color: var(--text-faint); padding: 4px 2px; }
.hist-item {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 5px 8px; border-radius: 7px; border: 1px solid transparent;
  background: none; color: var(--text); font-family: inherit; cursor: pointer;
}
.hist-item:hover { background: var(--bg-card); border-color: var(--border); }
.hist-item.on { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.hist-item .hi-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.hist-item .hi-main b { font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-item .hi-main em { font-style: normal; font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-item .hi-del { flex-shrink: 0; width: 18px; height: 18px; border-radius: 5px; font-size: 10px; color: var(--text-faint); display: flex; align-items: center; justify-content: center; }
.hist-item .hi-del:hover { color: var(--red); background: var(--red-dim); }

.wait { color: var(--text-faint); font-size: 11px; }
.wait i { font-style: normal; margin-left: 6px; font-family: var(--mono); }
.eai-err {
  font-size: 11px; color: var(--red); background: var(--red-dim);
  border: 1px solid color-mix(in srgb, var(--red) 40%, transparent); border-radius: 7px; padding: 5px 8px;
}

.eai-f { border-top: 1px solid var(--border); padding: 8px 10px 9px; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.eai-input {
  width: 100%; box-sizing: border-box; resize: none; height: 58px; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); color: var(--text);
  font-family: inherit; font-size: 11.5px; line-height: 1.6; outline: none;
}
.eai-input:focus { border-color: var(--accent); }
.eai-row { display: flex; align-items: center; gap: 6px; }
.eai-tip { font-size: 10px; color: var(--text-faint); }
.eai-btn {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3.5px 11px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.eai-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.eai-btn:disabled { opacity: 0.45; cursor: default; }
.eai-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.eai-btn.primary:disabled { background: var(--accent); border-color: var(--accent); color: #fff; opacity: 0.4; }
.eai-btn.stop { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }

/* 八向缩放手柄 */
.eai-rs { position: absolute; z-index: 3; }
.rs-n { top: 0; left: 12px; right: 12px; height: 5px; cursor: ns-resize; }
.rs-s { bottom: 0; left: 12px; right: 12px; height: 5px; cursor: ns-resize; }
.rs-e { right: 0; top: 12px; bottom: 12px; width: 5px; cursor: ew-resize; }
.rs-w { left: 0; top: 12px; bottom: 12px; width: 5px; cursor: ew-resize; }
.rs-ne { top: 0; right: 0; width: 13px; height: 13px; cursor: nesw-resize; }
.rs-nw { top: 0; left: 0; width: 13px; height: 13px; cursor: nwse-resize; }
.rs-se { bottom: 0; right: 0; width: 13px; height: 13px; cursor: nwse-resize; }
.rs-sw { bottom: 0; left: 0; width: 13px; height: 13px; cursor: nesw-resize; }
.eai-size {
  position: absolute; right: 10px; bottom: 8px; z-index: 4; pointer-events: none;
  font-family: var(--mono); font-size: 10px; color: var(--text-faint);
  background: var(--bg-side); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px;
}
</style>
