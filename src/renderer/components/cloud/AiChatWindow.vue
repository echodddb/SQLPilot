<template>
  <Teleport to="body">
    <div v-if="ai.open" class="cai" :class="{ collapsed: ai.collapsed }" :style="winStyle">
      <!-- 顶栏：标题 + 历史对话 + 新建（重新开始）；双击空白处恢复默认大小 -->
      <header class="cai-head" title="拖动可移动浮窗，双击恢复默认大小" @mousedown="startDrag" @dblclick.self="resetSize">
        <span class="cai-logo">✦</span>
        <div class="cai-title">
          <b>{{ catalog.appName }}</b>
          <span>{{ headSub }}</span>
        </div>
        <span class="sp"></span>
        <button
          class="cai-hb"
          :class="{ on: ai.skills.length > 0 }"
          :title="skillTip"
          @click.stop="skillsOpen = !skillsOpen"
        >
          技能<i v-if="ai.skills.length" class="badge">{{ ai.skills.length }}</i>
        </button>
        <button
          class="cai-hb"
          :class="{ on: ai.historyOpen }"
          title="历史 AI 对话：点开可切回之前的对话，或在顶部「＋ 新建」重新开始"
          @click.stop="toggleHistory"
        >
          历史<i v-if="ai.history.length" class="badge">{{ ai.history.length }}</i>
        </button>
        <button class="cai-hb" title="新建对话：重新勾选子模块，开一段新的对话" @click.stop="newChat">＋ 新建</button>
        <button class="cai-hb icon" :title="ai.collapsed ? '展开' : '收起'" @click.stop="ai.collapsed = !ai.collapsed">
          {{ ai.collapsed ? '▢' : '—' }}
        </button>
        <button class="cai-hb icon" title="关闭（对话已保存，可在历史里找回）" @click.stop="closeAi">✕</button>
      </header>

      <!-- 技能选择：勾上后技能正文作为「回答规范」随问题发送 -->
      <SkillPicker
        v-if="skillsOpen"
        :selected="ai.skills"
        @update:selected="ai.skills = $event"
        @close="skillsOpen = false"
      />

      <!-- 历史对话浮层 -->
      <div v-if="ai.historyOpen" class="cai-hist">
        <div class="hist-head">
          <b>历史对话</b>
          <span class="hist-hint">{{ catalog.title() }}</span>
          <button class="tp-btn sm ghost" @click="newChat">＋ 新对话</button>
        </div>
        <div v-if="ai.historyLoading" class="hist-empty">读取中…</div>
        <div v-else-if="!ai.history.length" class="hist-empty">还没有历史对话</div>
        <div v-else class="hist-list">
          <div
            v-for="h in ai.history"
            :key="h.id"
            class="hist-item"
            :class="{ on: h.id === ai.sessionId }"
            @click="openSession(h.id)"
          >
            <div class="hi-main">
              <div class="hi-title">{{ h.title }}</div>
              <div class="hi-sub">
                <span>{{ rel(h.updatedAt) }}</span>
                <span>·</span>
                <span>{{ h.messageCount }} 条</span>
                <span>·</span>
                <span class="hi-scope" :title="catalog.sectionNames(h.sections)">{{ catalog.scopeSummary(h.sections) }}</span>
              </div>
            </div>
            <button class="hi-del" title="删除这段对话" @click.stop="removeSession(h.id)">✕</button>
          </div>
        </div>
      </div>

      <template v-if="!ai.collapsed">
        <!-- 范围条：按模块汇总已勾子模块 + 数据快照时间 -->
        <div class="cai-scope">
          <span class="sk">范围</span>
          <span v-if="!catalog.scopeGroups(ai.sections).length" class="tp-chip scope-chip">未选择</span>
          <span
            v-for="g in catalog.scopeGroups(ai.sections)"
            :key="g.label"
            class="tp-chip scope-chip"
            :title="catalog.groupNames(ai.sections, g.label)"
          >
            {{ g.label }}<em v-if="g.count < g.total">{{ g.count }}/{{ g.total }}</em>
          </span>
          <span class="sp"></span>
          <button class="cai-lk" :disabled="ai.streaming || ai.building" @click="editScope">调整</button>
          <button class="cai-lk" :disabled="ai.streaming || ai.building || !ai.sessionId" :title="snapshotTitle" @click="refreshData">
            刷新数据{{ snapshotAt ? ' · ' + snapshotAt : '' }}
          </button>
        </div>

        <!-- 对话区 -->
        <div ref="bodyEl" class="cai-body">
          <div v-if="!ai.messages.length && !ai.streaming" class="cai-empty">
            <div class="ce-ico">✦</div>
            <b>{{ catalog.title() }} · AI 助手</b>
            <p>已读取：{{ catalog.scopeSummary(ai.sections) }}。直接问，回答只依据这份数据快照。</p>
            <div class="ce-asks">
              <button v-for="q in quickAsks" :key="q" class="ce-ask" @click="sendAi(q)">{{ q }}</button>
            </div>
          </div>

          <div v-for="m in ai.messages" :key="m.id" class="msg" :class="m.role">
            <MdMessage :text="m.text" :role="m.role" @link="openLink" />
          </div>

          <div v-if="ai.building" class="cai-wait">
            <span class="spinner"></span>
            正在从 {{ catalog.sourceName }} 读取「{{ catalog.scopeSummary(ai.sections) }}」…
          </div>

          <div v-if="ai.streaming" class="msg assistant">
            <MdMessage v-if="ai.streamText" :text="ai.streamText" role="assistant" streaming @link="openLink" />
            <div v-else class="cai-wait">
              <span class="spinner"></span>
              {{ ai.reasoning ? `模型思考中（已 ${ai.reasoning} 字）…` : '正在生成回答…' }}
            </div>
          </div>

          <div v-if="ai.error" class="cai-err">! {{ ai.error }}</div>
        </div>

        <!-- 输入 -->
        <div class="cai-foot">
          <textarea
            v-model="draft"
            class="cai-input"
            rows="2"
            :placeholder="ai.sessionId ? '追问，如：这 3 条告警的排查顺序是什么？' : catalog.askPlaceholder"
            @keydown.enter.exact.prevent="onSend"
            @keydown.esc="ai.historyOpen = false"
          ></textarea>
          <div class="foot-row">
            <span class="foot-hint">Enter 发送 · Shift+Enter 换行</span>
            <span class="sp"></span>
            <button v-if="ai.streaming" class="tp-btn danger" @click="stopAi">■ 停止</button>
            <button class="tp-btn primary" :disabled="!draft.trim() || ai.streaming || ai.building" @click="onSend">发送</button>
          </div>
        </div>
      </template>

      <!-- 八向缩放手柄：四边 + 四角 -->
      <template v-if="!ai.collapsed">
        <span
          v-for="d in RESIZE_DIRS"
          :key="d"
          class="cai-rs"
          :class="`rs-${d}`"
          :title="d === 'se' ? '拖动调整大小（双击标题栏恢复默认）' : ''"
          @mousedown.stop.prevent="startResize($event, d)"
        ></span>
        <span v-if="resizing" class="cai-size">{{ Math.round(winW) }} × {{ Math.round(winH) }}</span>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * AI 助手浮窗（OCP / Oracle 共用）
 *
 * 交互：顶栏 AI 按钮 → 在页面上勾选要读取的块 → 基于这些数据的数据快照开一段对话；
 * 浮窗顶部的「历史 / 新建」可以切回旧对话或重新开始。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import MdMessage from '../common/MdMessage.vue'
import SkillPicker from '../common/SkillPicker.vue'
import { cloud } from '../../cloud/state'
import { AI_MIN_H, AI_MIN_W, clampSize, type AiWindowCatalog, type AiWindowStore } from '../../cloud/aiCatalog'

/**
 * AI 助手浮窗（通用）：OCP 与 Oracle 两个助手共用。
 * 差异通过 `store`（状态 + IPC）与 `catalog`（文案 / 范围统计 / 示例问题）注入。
 */
const props = withDefaults(
  defineProps<{
    store: AiWindowStore
    catalog: AiWindowCatalog
    /** 切平台时是否清空当前会话（OCP 的会话绑在具体平台；Oracle 一段对话可跨环境，不重置） */
    resetOnPlatformChange?: boolean
  }>(),
  { resetOnPlatformChange: false }
)

/** 直接引用注入的 store：模板里的 ai.xxx 与原来完全一致 */
const ai = props.store
const catalog = props.catalog
const {
  closeAi,
  editScope,
  initAi,
  loadHistory,
  newChat,
  openSession,
  refreshData,
  removeSession,
  resetSize,
  savePos,
  sendAi,
  stopAi
} = ai

const bodyEl = ref<HTMLElement | null>(null)
const draft = ref('')
/** 技能选择面板（关闭浮窗 / 切换会话时自动收起） */
const skillsOpen = ref(false)

const skillTip = computed(() =>
  ai.skills.length
    ? `本次对话已启用 ${ai.skills.length} 个技能：回答会按它们的步骤与口径来`
    : '技能：勾上后把技能正文作为回答规范（不执行技能里的工具）'
)

initAi()

watch(
  () => [ai.open, ai.sessionId, ai.historyOpen],
  () => {
    if (!ai.open || ai.historyOpen) skillsOpen.value = false
  }
)

const headSub = computed(() => {
  if (ai.building) return '读取数据快照…'
  if (ai.streaming) return '生成中…'
  return ai.sessionMeta?.title || catalog.scopeSummary(ai.sections)
})

const snapshotAt = computed(() => {
  const t = ai.sessionMeta?.contextAt
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
})

const snapshotTitle = computed(() =>
  ai.sessionMeta?.contextAt
    ? `快照时间 ${new Date(ai.sessionMeta.contextAt).toLocaleString()} · ${ai.sessionMeta.contextChars} 字`
    : '还没有数据快照（发出第一条消息时会自动读取）'
)

const quickAsks = computed(() => catalog.quickAsks(ai.sections))

function rel(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}



// ---------------------------------------------------------------- 位置、尺寸与拖拽

/** 八个方向的缩放手柄（n/s/e/w + 四角） */
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
type ResizeDir = (typeof RESIZE_DIRS)[number]

const DEF_W = 440
const DEF_H = 680
/** 与窗口边缘留的缝，拖到贴边也不至于粘死 */
const EDGE = 4

const resizing = ref(false)

/** 当前实际宽高（未手动调整过时按默认规则算） */
const winW = computed(() => ai.w ?? DEF_W)
const winH = computed(() => (ai.collapsed ? 46 : (ai.h ?? Math.min(DEF_H, window.innerHeight - 40))))

const winStyle = computed<Record<string, string>>(() => {
  const st: Record<string, string> = {}
  if (ai.w) st.width = `${ai.w}px`
  // 收起时高度由内容决定，别让内联高度把它撑开
  if (ai.h && !ai.collapsed) st.height = `${ai.h}px`
  if (ai.x === null || ai.y === null) {
    st.right = '18px'
    st.bottom = '18px'
  } else {
    st.left = `${ai.x}px`
    st.top = `${ai.y}px`
    st.right = 'auto'
    st.bottom = 'auto'
  }
  return st
})

let dragFrom: { x: number; y: number; left: number; top: number } | null = null
function startDrag(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('button, input, label')) return
  const el = (e.currentTarget as HTMLElement).parentElement
  if (!el) return
  const r = el.getBoundingClientRect()
  dragFrom = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', endDrag)
}
function onDrag(e: MouseEvent): void {
  if (!dragFrom) return
  const w = Math.min(winW.value, window.innerWidth - EDGE * 2)
  const h = Math.min(winH.value, window.innerHeight - EDGE * 2)
  ai.x = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, dragFrom.left + e.clientX - dragFrom.x))
  ai.y = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, dragFrom.top + e.clientY - dragFrom.y))
}
function endDrag(): void {
  dragFrom = null
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
  savePos()
}

// ---------------------------------------------------------------- 缩放

let resizeFrom:
  | { dir: ResizeDir; sx: number; sy: number; left: number; top: number; w: number; h: number }
  | null = null

function startResize(e: MouseEvent, dir: ResizeDir): void {
  const el = ((e.currentTarget as HTMLElement).closest('.cai') || (e.currentTarget as HTMLElement)) as HTMLElement
  const r = el.getBoundingClientRect()
  // 默认停在右下角（x/y 为 null）时先固化成绝对坐标，否则一拖就跳
  ai.x = Math.round(r.left)
  ai.y = Math.round(r.top)
  ai.w = Math.round(r.width)
  ai.h = Math.round(r.height)
  resizeFrom = { dir, sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, w: r.width, h: r.height }
  resizing.value = true
  window.addEventListener('mousemove', onResize)
  window.addEventListener('mouseup', endResize)
}

function onResize(e: MouseEvent): void {
  const s = resizeFrom
  if (!s) return
  const maxW = Math.max(AI_MIN_W, window.innerWidth - EDGE * 2)
  const maxH = Math.max(AI_MIN_H, window.innerHeight - EDGE * 2)
  const dx = e.clientX - s.sx
  const dy = e.clientY - s.sy
  let w = s.w
  let h = s.h
  if (s.dir.includes('e')) w = s.w + dx
  if (s.dir.includes('w')) w = s.w - dx
  if (s.dir.includes('s')) h = s.h + dy
  if (s.dir.includes('n')) h = s.h - dy
  w = clampSize(w, AI_MIN_W, maxW)
  h = clampSize(h, AI_MIN_H, maxH)
  // 从左边 / 上边拉时，宽高变了要同步挪 left / top，视觉上才是「那条边在动」
  let left = s.dir.includes('w') ? s.left + (s.w - w) : s.left
  let top = s.dir.includes('n') ? s.top + (s.h - h) : s.top
  left = Math.max(EDGE, Math.min(window.innerWidth - w - EDGE, left))
  top = Math.max(EDGE, Math.min(window.innerHeight - h - EDGE, top))
  ai.w = Math.round(w)
  ai.h = Math.round(h)
  ai.x = Math.round(left)
  ai.y = Math.round(top)
}

function endResize(): void {
  resizeFrom = null
  resizing.value = false
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', endResize)
  savePos()
}

/** 窗口变小（或改分辨率）时把浮窗收回来，避免拖出去找不回来 */
function onWinResize(): void {
  if (ai.w) ai.w = Math.round(clampSize(ai.w, AI_MIN_W, Math.max(AI_MIN_W, window.innerWidth - EDGE * 2)))
  if (ai.h) ai.h = Math.round(clampSize(ai.h, AI_MIN_H, Math.max(AI_MIN_H, window.innerHeight - EDGE * 2)))
  if (ai.x !== null) ai.x = Math.max(EDGE, Math.min(Math.max(EDGE, window.innerWidth - winW.value - EDGE), ai.x))
  if (ai.y !== null) ai.y = Math.max(EDGE, Math.min(Math.max(EDGE, window.innerHeight - winH.value - EDGE), ai.y))
}
window.addEventListener('resize', onWinResize)

// ---------------------------------------------------------------- 交互

function toggleHistory(): void {
  ai.historyOpen = !ai.historyOpen
}

// 中文输入法回车只确认候选
function onSend(e?: KeyboardEvent): void {
  if (e && (e.isComposing || e.keyCode === 229)) return
  const t = draft.value.trim()
  if (!t || ai.streaming || ai.building) return
  draft.value = ''
  void sendAi(t)
}

/** 回答里的外链：交给系统浏览器（气泡组件负责拦默认跳转） */
async function openLink(href: string): Promise<void> {
  if (/^https?:\/\//.test(href)) await window.sqlpilot.openExternal(href)
}

// 消息或流式文本变化后贴底（用户手动往上翻时不打扰）
const sig = computed(() => `${ai.messages.length}|${ai.streamText.length}|${ai.building}`)
watch(sig, async () => {
  await nextTick()
  const el = bodyEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTo({ top: el.scrollHeight })
})

// 切换 OCP 平台：旧会话绑在旧平台上，直接回到「重新勾选」
watch(
  () => cloud.activeId,
  (now, before) => {
    if (!props.resetOnPlatformChange) return
    if (!before || now === before) return
    if (ai.sessionId) newChat()
    void loadHistory()
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', endDrag)
  window.removeEventListener('mousemove', onResize)
  window.removeEventListener('mouseup', endResize)
  window.removeEventListener('resize', onWinResize)
})
</script>

<style scoped>
.cai {
  /* 要浮在库详情 / 租户详情（z-index: 260）之上：从抽屉里点 AI 时窗口得看得见 */
  position: fixed; z-index: 400; width: 440px; height: min(680px, calc(100vh - 40px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px;
  box-shadow: var(--shadow-lg); font-size: 12px; color: var(--text);
}
.cai.collapsed { height: auto; }
.cai:not(.collapsed) { min-width: 340px; min-height: 300px; }

/* 八向缩放手柄：贴在面板内侧边缘，不撑出滚动条；顶栏抬高一层保护按钮不被角手柄抢点击 */
.cai-rs { position: absolute; z-index: 5; }
.rs-n { top: 0; left: 12px; right: 12px; height: 5px; cursor: ns-resize; }
.rs-s { bottom: 0; left: 12px; right: 12px; height: 5px; cursor: ns-resize; }
.rs-e { right: 0; top: 12px; bottom: 12px; width: 5px; cursor: ew-resize; }
.rs-w { left: 0; top: 12px; bottom: 12px; width: 5px; cursor: ew-resize; }
.rs-ne { top: 0; right: 0; width: 13px; height: 13px; cursor: nesw-resize; }
.rs-nw { top: 0; left: 0; width: 13px; height: 13px; cursor: nwse-resize; }
.rs-se { bottom: 0; right: 0; width: 13px; height: 13px; cursor: nwse-resize; }
.rs-sw { bottom: 0; left: 0; width: 13px; height: 13px; cursor: nesw-resize; }
.cai-rs:hover { background: color-mix(in srgb, var(--accent) 50%, transparent); }
/* 右下角给个常驻抓手，让人一眼知道这里能拉 */
.rs-se::after {
  content: ''; position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px;
  border-right: 1.5px solid var(--border-strong); border-bottom: 1.5px solid var(--border-strong); opacity: 0.8;
}
.rs-se:hover::after { border-color: var(--accent); opacity: 1; }
.cai-size {
  position: absolute; right: 9px; bottom: 9px; z-index: 6; pointer-events: none;
  font-family: var(--mono); font-size: 9.5px; padding: 2px 6px; border-radius: 5px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
}

.cai-head {
  position: relative; z-index: 6;
  display: flex; align-items: center; gap: 7px; height: 44px; min-height: 44px; padding: 0 8px 0 11px;
  border-bottom: 1px solid var(--border); cursor: move; user-select: none; background: var(--bg-side);
}
.cai-logo {
  width: 22px; height: 22px; border-radius: 7px; display: flex; align-items: center; justify-content: center;
  background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent); font-size: 11px; flex-shrink: 0;
}
.cai-title { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.cai-title b { font-size: 12.5px; letter-spacing: 0.2px; }
.cai-title span { font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.cai-head .sp { flex: 1; }
.cai-hb {
  position: relative; height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid transparent;
  background: none; color: var(--text-dim); font-family: inherit; font-size: 11px; cursor: pointer; flex-shrink: 0;
}
.cai-hb:hover { background: var(--bg-card-hover); color: var(--text); }
.cai-hb.on { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
.cai-hb.icon { width: 24px; padding: 0; font-size: 11px; }
.cai-hb .badge {
  margin-left: 4px; font-family: var(--mono); font-size: 9px; font-style: normal;
  padding: 0 4px; border-radius: 99px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
}

/* 历史对话浮层 */
.cai-hist {
  position: absolute; top: 46px; right: 8px; left: 8px; z-index: 2; max-height: 62%;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg-card); border: 1px solid var(--border-strong); border-radius: 11px; box-shadow: var(--shadow-lg);
}
.hist-head { display: flex; align-items: center; gap: 7px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.hist-head b { font-size: 11.5px; }
.hist-hint { font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.hist-empty { padding: 18px; text-align: center; color: var(--text-faint); font-size: 11.5px; }
.hist-list { overflow-y: auto; padding: 4px; }
.hist-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.hist-item:hover { background: var(--bg-card-hover); }
.hist-item.on { background: var(--accent-dim); }
.hi-main { flex: 1; min-width: 0; }
.hi-title { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-item.on .hi-title { color: var(--accent); }
.hi-sub { display: flex; gap: 5px; font-size: 9.5px; color: var(--text-faint); margin-top: 2px; }
.hi-scope { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hi-del {
  width: 20px; height: 20px; border: none; border-radius: 5px; background: none; color: var(--text-faint);
  font-size: 10px; cursor: pointer; flex-shrink: 0;
}
.hi-del:hover { background: var(--red-dim); color: var(--red); }

/* 范围条 */
.cai-scope {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap; padding: 6px 10px;
  border-bottom: 1px solid var(--border); background: var(--bg); font-size: 10.5px;
}
.cai-scope .sk { color: var(--text-faint); flex-shrink: 0; }
.cai-scope .sp { flex: 1; min-width: 0; }
/* 环境名可能很长：chip 允许收缩并省略，别把右侧「调整 / 刷新数据」挤出窗口 */
.scope-chip { cursor: default; flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cai-scope .cai-lk { flex-shrink: 0; }
.scope-chip em { font-style: normal; margin-left: 3px; color: var(--text-faint); font-family: var(--mono); font-size: 9.5px; }
.cai-lk {
  border: none; background: none; color: var(--accent); font-family: inherit; font-size: 10.5px;
  cursor: pointer; padding: 1px 4px; border-radius: 5px;
}
.cai-lk:hover:not(:disabled) { background: var(--accent-dim); }
.cai-lk:disabled { color: var(--text-faint); cursor: not-allowed; }

/* 对话 */
.cai-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 6px; display: flex; flex-direction: column; gap: 11px; }
.cai-empty { margin: auto 0; padding: 8px 4px; text-align: center; color: var(--text-dim); }
.ce-ico {
  width: 40px; height: 40px; margin: 0 auto 8px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
  background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent); font-size: 17px;
}
.cai-empty b { font-size: 12.5px; }
.cai-empty p { font-size: 10.5px; color: var(--text-faint); line-height: 1.7; margin: 5px 0 10px; }
.ce-asks { display: flex; flex-direction: column; gap: 6px; }
.ce-ask {
  text-align: left; font-family: inherit; font-size: 11px; line-height: 1.5; cursor: pointer; color: var(--text-dim);
  padding: 7px 9px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border);
}
.ce-ask:hover { border-color: var(--accent); color: var(--accent); }

.msg { display: block; min-width: 0; }
.cai-wait { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-dim); padding: 4px 0; }
.spinner { width: 11px; height: 11px; border: 2px solid var(--accent-dim); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
.caret { width: 6px; height: 12px; background: var(--accent); animation: blink 1s steps(2) infinite; margin-top: 2px; }
@keyframes blink { 50% { opacity: 0; } }
.cai-err { font-size: 11px; color: var(--red); background: var(--red-dim); border-radius: 7px; padding: 6px 9px; }

/* 输入区 */
.cai-foot { border-top: 1px solid var(--border); padding: 8px 10px 9px; background: var(--bg-side); }
.cai-input {
  width: 100%; resize: none; font-family: inherit; font-size: 11.5px; line-height: 1.6;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 9px;
  color: var(--text); padding: 7px 9px; outline: none;
}
.cai-input:focus { border-color: var(--accent); }
.foot-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.foot-row .sp { flex: 1; }
.foot-hint { font-size: 9.5px; color: var(--text-faint); }
</style>
