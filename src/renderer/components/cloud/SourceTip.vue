<template>
  <!-- 采集来源悬浮卡：全局挂一次，页面元素只需挂 data-src="key" -->
  <teleport to="body">
    <div v-if="tip" class="src-tip" :style="tipStyle" @mouseenter="hold" @mouseleave="hide">
      <div class="st-head">
        <b>{{ tip.info.title }}</b>
        <span v-if="tip.cluster" class="st-cluster mono">{{ tip.cluster }}</span>
      </div>
      <div class="st-row"><span class="st-k">采集方式</span><span class="st-v mono">{{ tip.info.api }}</span></div>
      <div v-if="tip.info.origin?.table" class="st-origin">
        <span class="st-k">查询位置</span>
        <span class="st-path">
          <i class="st-node cluster" :class="{ placeholder: tip.info.origin.placeholder }">{{ pathCluster }}</i>
          <i class="st-arrow">→</i>
          <i class="st-node" :class="{ placeholder: tip.info.origin.placeholder }">{{ tip.info.origin.tenant }}</i>
          <i class="st-arrow">→</i>
          <i class="st-node" :class="{ placeholder: tip.info.origin.placeholder }">{{ tip.info.origin.db }}</i>
          <i class="st-arrow">→</i>
          <i class="st-node table mono">{{ tip.info.origin.table }}</i>
        </span>
        <span v-if="tip.info.origin.placeholder" class="st-ph">名称随部署而定</span>
      </div>
      <div v-if="tip.info.scope" class="st-row"><span class="st-k">采集范围</span><span class="st-v">{{ tip.info.scope }}</span></div>
      <div v-if="tip.lines.length" class="st-row">
        <span class="st-k">数据明细</span>
        <span class="st-lines">
          <span v-for="(l, i) in tip.lines" :key="i" class="st-line">{{ l }}</span>
        </span>
      </div>
      <pre v-if="tip.info.sql" class="st-sql mono">{{ tip.info.sql }}</pre>
      <div class="st-foot">
        <span class="st-note">{{ tip.info.note || '' }}</span>
        <button v-if="tip.info.sql" class="st-copy" @click="copySql">复制 SQL</button>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
/**
 * 数据采集来源悬浮卡（云管平台通用）。
 *
 * 用法：页面元素挂 data-src="某 key"，可选挂 data-cluster / data-host / data-tenant 让明细行动态带出；
 * 局部数据（抽屉里刚加载的条数等）可挂 data-detail="行1|行2" 由元素自己提供明细。
 * 事件在 document 上委托、只对 scopeSelector 内的元素生效，组件全局挂一次即可。
 *
 * 交互定式（踩过的坑，勿改）：
 * 1) 悬浮卡不跟随鼠标：定位一次 + 靠边翻转，否则 mousemove 追光标会闪；
 * 2) mouseover 先于 mouseenter 触发，卡自身必须视为 pinned 并立刻 return，否则移入卡片瞬间被销毁，再悬停就不显示；
 * 3) 指针进入卡片即 pinned，方便选中复制 SQL；移出卡片才收起。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { type SourceInfo } from '../../cloud/sources'
import { cloud } from '../../cloud/state'

const props = withDefaults(
  defineProps<{
    sources: Record<string, SourceInfo>
    /** 优先于 data-detail：按 key + 元素上下文生成明细行 */
    resolve?: (key: string, el: Element) => string[] | undefined
    /** 只在匹配该选择器的容器内生效，避免影响其它模块 */
    scopeSelector?: string
  }>(),
  { scopeSelector: '.cloud' }
)

interface TipState {
  info: SourceInfo
  cluster?: string
  lines: string[]
}

const tip = ref<TipState | null>(null)
const tipStyle = ref<Record<string, string>>({})
let pinned = false
/** 表格里 data-src 挂得很密，悬停延迟一点点再弹卡，快速划过表格不会一路闪 */
let showTimer: ReturnType<typeof setTimeout> | null = null
/** 当前目标签名（key|cluster），同一目标内移动鼠标不重复计时 */
let lastSig = ''
const SHOW_DELAY = 130

const pathCluster = computed(() => {
  const o = tip.value?.info.origin
  return tip.value?.cluster || o?.cluster || (o?.perCluster ? '各集群' : '目标集群')
})

function cancelShow(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer)
    showTimer = null
  }
}

function showTipFor(el: Element, x: number, y: number): void {
  const key = el.getAttribute('data-src') || ''
  const info = props.sources[key]
  if (!info) {
    lastSig = ''
    return
  }
  let lines = props.resolve?.(key, el)
  if (!lines) {
    const raw = el.getAttribute('data-detail')
    lines = raw ? raw.split('|').map((s) => s.trim()).filter(Boolean) : []
  }
  tip.value = {
    info,
    // 环境名可以直接挂在元素上，也可以挂在祖先（如抽屉壳）上，避免每个卡片重复标注
    cluster: el.getAttribute('data-cluster') || el.closest('[data-cluster]')?.getAttribute('data-cluster') || undefined,
    lines: lines || []
  }
  placeTip(x, y)
}

/** 估算尺寸后翻转避让（悬浮卡约 430x360，内容长短不一，只在越界时回退） */
function placeTip(x: number, y: number): void {
  const W = 430
  const H = 380
  const M = 12
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = x + M
  let top = y + M
  if (left + W > vw - 8) left = Math.max(8, x - W - M)
  if (top + H > vh - 8) top = Math.max(8, vh - H - 16)
  tipStyle.value = { left: `${left}px`, top: `${top}px` }
}

function hide(): void {
  pinned = false
  lastSig = ''
  cancelShow()
  tip.value = null
}
function hold(): void {
  pinned = true
}

function onOver(e: MouseEvent): void {
  const t = e.target as Element | null
  if (!t?.closest) return
  // 卡片自身：视为保持，绝不在这里销毁（见文件头注释 2）
  if (t.closest('.src-tip')) {
    pinned = true
    return
  }
  if (pinned) return
  // 工作模式：不弹来源详情卡（悬停只用于正常操作）；学习模式才有这层教学浮层
  if (!cloud.learnMode) {
    hide()
    return
  }
  // 正在勾选 AI 读取范围时不弹来源卡：两层浮层会互相打架
  if (document.body.classList.contains('ai-picking')) {
    hide()
    return
  }
  // 输入类控件上不弹卡：表格的过滤框、参数搜索框都在带 data-src 的容器里
  if (t.closest('input, textarea, select')) {
    hide()
    return
  }
  const el = t.closest('[data-src]')
  if (!el || !el.closest(props.scopeSelector)) {
    hide()
    return
  }
  // 同一目标内（单元格里的子元素之间）移动不重新计时，否则一直取消、卡片永远不出现
  const sig = `${el.getAttribute('data-src') || ''}|${el.getAttribute('data-cluster') || ''}|${el.getAttribute('data-tenant') || ''}|${el.getAttribute('data-host') || ''}`
  if (sig === lastSig) return
  lastSig = sig
  cancelShow()
  const x = e.clientX
  const y = e.clientY
  showTimer = setTimeout(() => {
    showTimer = null
    if (el.isConnected) showTipFor(el, x, y)
  }, SHOW_DELAY)
}

function onOut(e: MouseEvent): void {
  if (pinned) return
  const to = e.relatedTarget as Element | null
  if (to && to.closest?.('.src-tip')) return
  const el = (e.target as Element).closest?.('[data-src]')
  if (el && (!to || !to.closest?.('[data-src]'))) {
    lastSig = ''
    cancelShow()
    tip.value = null
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && tip.value) hide()
}

async function copySql(): Promise<void> {
  const sql = tip.value?.info.sql
  if (!sql) return
  await window.sqlpilot.writeClipboard(sql)
  hide()
}

// 切到工作模式时，屏幕上已经弹着的卡要立刻收起
watch(
  () => cloud.learnMode,
  (on) => {
    if (!on && tip.value) hide()
  }
)

onMounted(() => {
  document.addEventListener('mouseover', onOver)
  document.addEventListener('mouseout', onOut)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mouseover', onOver)
  document.removeEventListener('mouseout', onOut)
  document.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
/* 采集来源悬浮卡（teleport 到 body，fixed 定位） */
.src-tip {
  position: fixed; z-index: 900; width: 430px; max-width: 92vw;
  background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 11px;
  box-shadow: var(--shadow-lg); padding: 11px 12px; display: flex; flex-direction: column; gap: 7px;
  pointer-events: auto;
}
.st-head { display: flex; align-items: center; gap: 8px; }
.st-head b { font-size: 12.5px; }
.st-cluster { font-size: 10.5px; color: var(--accent); background: var(--accent-dim); border-radius: 4px; padding: 1px 7px; }
.st-row { display: flex; gap: 8px; font-size: 11px; align-items: baseline; }
.st-k { flex-shrink: 0; width: 58px; color: var(--text-faint); }
.st-v { color: var(--text-dim); word-break: break-all; }
.st-origin {
  display: flex; align-items: baseline; gap: 8px;
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; padding: 6px 9px;
}
.st-path { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.st-node { font-style: normal; font-size: 10.5px; color: var(--text); background: var(--bg-card); border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; }
.st-node.cluster { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.st-node.table { font-family: var(--mono); }
.st-node.placeholder { border-style: dashed; color: var(--text-dim); }
.st-arrow { font-style: normal; font-size: 10px; color: var(--text-faint); }
.st-ph { font-size: 10px; color: var(--warn, #b8860b); font-style: normal; white-space: nowrap; }
.st-lines { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.st-line { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-sql {
  margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--text-dim);
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px;
  padding: 7px 9px; overflow: auto; max-height: 150px; white-space: pre;
}
.st-foot { display: flex; align-items: center; gap: 8px; }
.st-note { flex: 1; font-size: 10.5px; color: var(--text-faint); line-height: 1.5; }
.st-copy {
  flex-shrink: 0; border: 1px solid var(--border); background: var(--bg-input); color: var(--accent);
  border-radius: 6px; font-size: 10.5px; padding: 2px 9px; cursor: pointer; font-family: inherit;
}
.st-copy:hover { border-color: var(--accent); }
</style>
