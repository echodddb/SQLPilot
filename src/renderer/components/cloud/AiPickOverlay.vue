<template>
  <Teleport to="body">
    <template v-if="ai.picking">
      <!-- 每个子模块右上角：名称胶囊 + 勾选框（位置由 data-ai 元素实时算出来） -->
      <div
        v-for="a in anchors"
        :key="a.key"
        class="aip-anchor"
        :class="{ on: ai.draft.includes(a.key) }"
        :style="{ top: a.top + 'px', left: a.left + 22 + 'px' }"
        :title="`${a.label}${a.desc ? '：' + a.desc : ''}\n${ai.draft.includes(a.key) ? '已加入 AI 读取范围，点一下移除' : '点一下加入 AI 读取范围（点这块的任何地方都可以）'}`"
      >
        <span v-if="!a.compact" class="aip-name">{{ a.label }}</span>
        <button
          class="aip-box"
          :class="{ on: ai.draft.includes(a.key) }"
          :aria-pressed="ai.draft.includes(a.key)"
          @click.stop.prevent="toggle(a.key)"
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path d="M2.5 8.6 6 12l7.5-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- 底部操作条：选完再进对话 -->
      <div class="aip-bar">
        <span class="aip-logo">✦</span>
        <b>AI 读取范围</b>
        <span class="aip-cnt">
          <template v-if="ai.draft.length">已选 <b>{{ ai.draft.length }}</b> 项<template v-if="scopeText"> · {{ scopeText }}</template></template>
          <template v-else>还没有勾选任何项 · 勾选后才可开始对话</template>
        </span>
        <span class="aip-help" :title="HELP">?</span>
        <span class="aip-tip">点模块本身或右上角方框都能勾</span>
        <div class="aip-actions">
          <button class="aip-btn ghost" :class="{ on: historyOpen }" :title="HISTORY_TIP" @click="historyOpen = !historyOpen">
            历史会话<i v-if="ai.history.length" class="aip-badge">{{ ai.history.length }}</i>
          </button>
          <button class="aip-btn ghost" :disabled="!pagePickable.length" @click="pickPage">全选本页</button>
          <button class="aip-btn ghost" :disabled="!ai.draft.length" @click="clear">清空</button>
          <button class="aip-btn" @click="cancel">取消</button>
          <button
            class="aip-btn primary"
            :disabled="!ai.draft.length"
            :title="ai.draft.length ? '' : '先勾选至少一项：AI 只读取你勾中的内容'"
            @click="finish"
          >
            {{ ai.sessionId ? '应用并刷新快照' : '开始对话' }}
          </button>
        </div>

        <!-- 历史会话：选一条直接进入，不新开会话 -->
        <div v-if="historyOpen" class="aip-hist">
          <div class="aip-hist-h">
            <b>历史会话</b>
            <span class="aip-hist-note">点一条直接进入该对话，不会新开</span>
            <span class="aip-hist-note" style="margin-left:auto">{{ ai.history.length }} 条</span>
          </div>
          <div v-if="ai.historyLoading" class="aip-hist-empty">读取中…</div>
          <div v-else-if="!ai.history.length" class="aip-hist-empty">
            还没有历史对话（这个平台的对话保存在本机，发第一条消息后才会出现）
          </div>
          <button
            v-for="h in ai.history"
            :key="h.id"
            class="aip-hist-item"
            :class="{ on: h.id === ai.sessionId }"
            :title="`${h.title}\n读取范围：${h.sections.map(catalog.label).join('、')}`"
            @click="enterHistory(h.id)"
          >
            <span class="hi-main">
              <b>{{ h.title }}</b>
              <em>{{ rel(h.updatedAt) }} · {{ h.messageCount }} 条 · {{ catalog.scopeSummary(h.sections) }}</em>
            </span>
            <span class="hi-go">进入 →</span>
          </button>
          <div v-if="histErr" class="aip-hist-empty" style="color: var(--red)">{{ histErr }}</div>
        </div>

        <!-- 本页没画出块的子模块（如「告警分布」只是表格里一列）：用胶囊兜底，保证都能勾 -->
        <div v-if="missing.length" class="aip-miss">
          <span class="aip-miss-l">本页未上屏</span>
          <button
            v-for="m in missing"
            :key="m.key"
            class="aip-chip"
            :class="{ on: ai.draft.includes(m.key) }"
            :title="m.desc"
            @click="toggle(m.key)"
          >{{ m.label }}</button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 云管 AI · 在原有界面上勾选读取范围。
 *
 * 做法：页面各子模块块上挂 `data-ai="<section key>"`，这里按元素的实际位置
 * 在它右上角浮一个勾选框（fixed 定位，不看 DOM 层级，因此不会被 overflow 裁掉）。
 *
 * 三个必须注意的点：
 * 1) 位置要跟着滚动/布局变化重算——滚动事件用 capture 抓内层滚动容器，另加 200ms 轮询兜底；
 * 2) 被抽屉/弹窗盖住的块不再画勾选框（用 elementFromPoint 判断，避免浮在抽屉之上）；
 * 3) 勾选状态写 ai.draft，点「开始对话 / 应用」才落到 ai.sections（与原来的语义一致）。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { AiWindowCatalog, AiWindowStore } from '../../cloud/aiCatalog'
import { cloud } from '../../cloud/state'

/**
 * 勾选态的通用外壳：OCP 与 Oracle 共用。
 * store 提供状态与动作，catalog 提供文案 / 范围摘要 / 未上屏兜底。
 */
const props = defineProps<{
  store: AiWindowStore
  catalog: AiWindowCatalog
  /** 勾选相关的动作（两个 store 的函数名不同，由调用方注入） */
  actions: {
    cancel: () => void
    clear: () => void
    finish: () => void | Promise<void>
    toggle: (key: string) => void
    open: (id: string) => Promise<void>
  }
}>()

const ai = props.store
const catalog = props.catalog
const { cancel, clear, finish, toggle, open } = props.actions

interface Anchor {
  key: string
  label: string
  /** 子模块说明（悬停胶囊时的提示，说明这块数据是什么） */
  desc: string
  /** 窄块（KPI 磁贴这类）：只画方框，块本身的标题已经说明是什么，避免压住内容 */
  compact: boolean
  top: number
  left: number
}

const anchors = shallowRef<Anchor[]>([])
/** 页面上真实存在的 data-ai（含滚动到视口外、当前画不出勾选框的）：判断「未上屏」用它，而不是可见锚点 */
const present = shallowRef<string[]>([])
const HELP = '点模块本身（或右上角的方框）即可勾选；切换左侧模块可以继续勾其他模块；Esc 取消。AI 只读取勾中的部分。'
const HISTORY_TIP = '历史会话：选一条直接进入该对话（不新开），左侧是当时读取的范围'
/** 历史面板是否展开（纯界面状态） */
const historyOpen = ref(false)
/** 打开失败（会话被删）的提示 */
const histErr = ref('')

/** 本模块中没在当前页面画出块的子模块：用底部小胶囊兜底，避免勾不到 */
const missing = computed(() => catalog.missing(present.value))

/** 「总览 3/4 · 集群 1/5」——底部条上的范围摘要 */
const scopeText = computed(() => catalog.draftScopeText(ai.draft))

let timer: ReturnType<typeof setInterval> | null = null

/**
 * 取块的实际外框：有些容器自己高度是 0（grid 用 flex:1 撑开、子元素却已渲染），
 * 这时退化成「所有子元素外框的并集」，否则勾选框会贴在页顶。
 */
function boxOf(el: HTMLElement): { left: number; right: number; top: number; bottom: number; width: number; height: number } {
  const r = el.getBoundingClientRect()
  if (r.width >= 40 && r.height >= 18) return r
  const kids = [...el.children]
    .map((c) => c.getBoundingClientRect())
    .filter((x) => x.width > 0 && x.height > 0)
  if (!kids.length) return r
  const left = Math.min(...kids.map((x) => x.left))
  const right = Math.max(...kids.map((x) => x.right))
  const top = Math.min(...kids.map((x) => x.top))
  const bottom = Math.max(...kids.map((x) => x.bottom))
  return { left, right, top, bottom, width: right - left, height: bottom - top }
}

function visible(el: HTMLElement): boolean {
  const r = boxOf(el)
  if (r.width < 40 || r.height < 18) return false
  if (r.bottom < 8 || r.top > window.innerHeight - 8) return false
  // 被抽屉 / 弹窗盖住时不画：取块内左上角一点看最上层是不是它自己
  const x = Math.min(window.innerWidth - 2, r.left + 14)
  const y = Math.min(window.innerHeight - 2, r.top + 14)
  const hit = document.elementFromPoint(x, y)
  return !!hit && (hit === el || el.contains(hit))
}

function refresh(): void {
  const out: Anchor[] = []
  const seen = new Set<string>()
  const all: string[] = []
  const vh = window.innerHeight
  for (const el of document.querySelectorAll<HTMLElement>('.cloud [data-ai]')) {
    const key = el.getAttribute('data-ai')
    if (key) all.push(key)
    if (!key || seen.has(key) || !visible(el)) continue
    const r = boxOf(el)
    // 很高的块（表格）滚出上边界时，把勾选框贴在可见区顶部，避免跟着一起消失
    const top = Math.round(Math.min(Math.max(r.top + 8, 10), vh - 76))
    const left = Math.round(Math.min(Math.max(r.right - 26, 10), window.innerWidth - 32))
    seen.add(key)
    out.push({
      key,
      // 页面自己给的名字更准（如「主机数」「obcluster-prod」），没有就退回归一化后的子模块名
      label: el.getAttribute('data-ai-name')?.trim() || catalog.label(key),
      desc: catalog.desc(key),
      // 窄块（KPI 磁贴）与表格行不挂名字：它们自己就写着名字/IP，别压住最后一列
      // 块自己有标题（Oracle 的卡片/磁贴都带标题）时挂 data-ai-compact：只画方框，别压内容
      compact: el.hasAttribute('data-ai-compact') || r.width < 220 || el.tagName === 'TR',
      top,
      left
    })
  }
  // 只在真的变了才写回，避免每 200ms 重建一次节点导致闪烁
  const sig = (list: Anchor[]): string => list.map((a) => `${a.key}@${a.top},${a.left}`).join('|')
  if (sig(out) !== sig(anchors.value)) anchors.value = out
  const pSig = all.join('|')
  if (pSig !== present.value.join('|')) present.value = all
}

/** 进入某条历史会话：直接打开该对话，不新建（失败时留在勾选态并提示） */
async function enterHistory(id: string): Promise<void> {
  histErr.value = ''
  await open(id)
  if (ai.picking) histErr.value = '这条会话已不存在（可能被删除），换一条试试'
  else historyOpen.value = false
}

/** 相对时间（历史列表用） */
function rel(ts: number): string {
  const diff = Date.now() - Number(ts || 0)
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  const d = new Date(Number(ts || 0))
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 本页可勾项：catalog 明确给了整页清单就用它（Oracle 库详情 = 当前 tab 整块），
 * 否则用页面上真正画出来的浮动锚点（OCP）。
 * 反过来会漏：抽屉里卡片很多，锚点只覆盖视口内可见的那几张。
 */
const pagePickable = computed(() => {
  const own = catalog.pageKeys()
  return own.length ? own : anchors.value.map((a) => a.key)
})

/** 全选本页：只勾当前页面能勾的项 */
function pickPage(): void {
  for (const key of pagePickable.value) if (!ai.draft.includes(key)) toggle(key)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') cancel()
}

/**
 * 勾选态下「点这块的任何地方」都算勾选：
 * 在捕获阶段截住块内的点击（否则会触发卡片下钻 / 行展开），再切换该子模块。
 * 只放行底部操作条与勾选框自己。
 */
function onDocClick(e: MouseEvent): void {
  if (!ai.picking || e.button !== 0) return
  const t = e.target as Element | null
  if (!t?.closest) return
  if (t.closest('.aip-bar, .aip-anchor')) return
  const el = t.closest('.cloud [data-ai]') as HTMLElement | null
  if (!el) return
  const key = el.getAttribute('data-ai')
  if (!key) return
  // 拖选文字时不当作点击
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && String(sel).trim()) return
  e.preventDefault()
  e.stopPropagation()
  toggle(key)
}

function syncBodyClass(on: boolean): void {
  document.body.classList.toggle('ai-picking', on)
}

watch(
  () => ai.picking,
  (on) => {
    syncBodyClass(on)
    if (!on) {
      historyOpen.value = false
      histErr.value = ''
    }
    if (on) {
      refresh()
      if (!timer) timer = setInterval(refresh, 200)
    } else if (timer) {
      clearInterval(timer)
      timer = null
      anchors.value = []
      present.value = []
    }
  },
  { immediate: true }
)

// 切模块 / 数据回来（表格高度变化）时立刻重算一次，不用等轮询
watch(() => [cloud.view, cloud.loading, cloud.clusterId, cloud.alarmSubTab], () => {
  if (ai.picking) requestAnimationFrame(refresh)
})

onMounted(() => {
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  document.addEventListener('keydown', onKey)
  document.addEventListener('click', onDocClick, true)
})

function onScroll(): void {
  if (ai.picking) refresh()
}

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('click', onDocClick, true)
  if (timer) clearInterval(timer)
  timer = null
  syncBodyClass(false)
})
</script>

<style>
/* 非 scoped：要同时在 body 与各页面块上生效 */

/* 勾选状态下把可选的块标出来（虚线框 + 悬停实线），让「哪里能勾」一眼可见 */
body.ai-picking .cloud [data-ai] {
  outline: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 3px;
  border-radius: 8px;
  transition: outline-color 0.14s ease;
}
body.ai-picking .cloud [data-ai]:hover {
  outline: 1px solid var(--accent);
  outline-offset: 3px;
}

.aip-anchor {
  position: fixed;
  z-index: 940;
  display: flex;
  align-items: center;
  gap: 4px;
  transform: translateX(-100%);
  height: 22px;
}
.aip-name {
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  line-height: 1;
  padding: 4px 7px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-side);
  color: var(--text-dim);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
}
.aip-anchor.on .aip-name { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }

.aip-box {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  background: var(--bg-side);
  color: transparent;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, transform 0.12s ease;
}
.aip-box:hover { transform: scale(1.08); border-color: var(--accent); }
/* 勾选态：整块可点，指针给出明确反馈 */
body.ai-picking .cloud [data-ai] { cursor: pointer; }
body.ai-picking .cloud [data-ai] * { cursor: inherit; }
.aip-box.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.aip-bar {
  position: fixed;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 945;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  max-width: min(1180px, calc(100vw - 40px));
  padding: 9px 12px;
  background: var(--bg-side);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
}
.aip-logo { color: var(--accent); font-size: 13px; }
.aip-bar b { font-size: 12.5px; white-space: nowrap; }
.aip-bar > .aip-logo { flex-shrink: 0; }
.aip-cnt { font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.aip-cnt b { color: var(--text); }
.aip-tip { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; opacity: 0.75; }
.aip-cnt b { color: var(--accent); font-family: var(--mono); }
.aip-help {
  flex-shrink: 0;
  width: 15px; height: 15px; line-height: 14px; text-align: center;
  border: 1px solid var(--border-strong); border-radius: 50%;
  font-size: 10px; color: var(--text-faint); cursor: help;
}
.aip-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.aip-badge {
  font-style: normal; margin-left: 4px; font-family: var(--mono); font-size: 9.5px;
  padding: 0 4px; border-radius: 99px; background: var(--bg-card); border: 1px solid var(--border);
  color: var(--text-faint);
}
.aip-hist {
  flex-basis: 100%; max-height: 210px; overflow-y: auto;
  padding-top: 6px; border-top: 1px dashed var(--border);
  display: flex; flex-direction: column; gap: 3px;
}
.aip-hist-h { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 3px; }
.aip-hist-h b { font-size: 11.5px; }
.aip-hist-note { font-size: 10px; color: var(--text-faint); }
.aip-hist-empty { font-size: 10.5px; color: var(--text-faint); padding: 4px 2px; }
.aip-hist-item {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 5px 8px; border-radius: 7px; border: 1px solid transparent;
  background: none; color: var(--text); font-family: inherit; cursor: pointer;
}
.aip-hist-item:hover { background: var(--bg-card); border-color: var(--border); }
.aip-hist-item.on { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.aip-hist-item .hi-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.aip-hist-item .hi-main b { font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aip-hist-item .hi-main em { font-style: normal; font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aip-hist-item .hi-go { flex-shrink: 0; font-size: 10.5px; color: var(--accent); opacity: 0; }
.aip-hist-item:hover .hi-go { opacity: 1; }

.aip-miss {
  flex-basis: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 5px 6px;
  padding-top: 6px; border-top: 1px dashed var(--border);
}
.aip-miss-l { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; }
.aip-chip {
  border: 1px dashed var(--border-strong);
  background: var(--bg-input);
  color: var(--text-dim);
  border-radius: 5px;
  font-size: 10.5px;
  padding: 1px 7px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.aip-chip.on { border-style: solid; border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
.aip-chip:hover { color: var(--text); }
.aip-btn {
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-dim);
  border-radius: 7px;
  font-size: 11.5px;
  padding: 4px 11px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.aip-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.aip-btn:disabled { opacity: 0.45; cursor: default; }
.aip-btn.ghost { background: none; }
.aip-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }

</style>
