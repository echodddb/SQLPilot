<template>
  <div class="efp-mask" @mousedown.self="close">
    <div class="efp" @keydown.esc.stop="close">
      <header class="efp-h">
        <span class="efp-logo">✦</span>
        <div class="efp-title">
          <b>选择文件问 AI</b>
          <em>{{ rootName || '已打开的文件' }} · 可多选，正文一并作为上下文</em>
        </div>
        <span class="sp"></span>
        <button class="efp-x" title="关闭 (Esc)" @click="close">✕</button>
      </header>

      <div class="efp-tools">
        <input
          ref="qEl"
          v-model="q"
          class="efp-q"
          type="search"
          placeholder="搜索文件名 / 路径…"
          spellcheck="false"
          @keydown.enter.prevent="onEnter"
        />
        <button class="efp-t" :disabled="!visible.length" @click="toggleAll">
          {{ allPicked ? '清空' : '全选' }}
        </button>
      </div>

      <div class="efp-list">
        <div v-if="loading" class="efp-hint">读取目录…</div>
        <div v-else-if="err" class="efp-hint err">{{ err }}</div>
        <div v-else-if="!visible.length" class="efp-hint">
          {{ files.length ? '没有匹配的文件' : '这个文件夹里没有可读的文件' }}
        </div>
        <button
          v-for="f in visible"
          :key="f.path"
          class="efp-row"
          :class="{ on: sel.includes(f.path) }"
          :title="f.path"
          @click="toggle(f.path)"
        >
          <span class="efp-ck">{{ sel.includes(f.path) ? '✓' : '' }}</span>
          <span class="efp-name">{{ f.name }}</span>
          <span v-if="f.open" class="efp-tag">打开中</span>
          <span class="efp-dir">{{ dirOf(f) }}</span>
          <span class="efp-size" :class="{ big: f.size > MAX_BYTES }">{{ fmtSize(f.size) }}</span>
        </button>
        <div v-if="hiddenCount" class="efp-hint">
          还有 {{ hiddenCount }} 个文件没显示，用上面的搜索缩小范围
        </div>
      </div>

      <footer class="efp-f">
        <div class="efp-sum">
          <b>{{ sel.length }}</b> 个文件<span v-if="sel.length"> · {{ fmtSize(selBytes) }}</span>
          <em v-if="sel.length > 1">上下限 {{ budget }} 字符，超出会截断</em>
        </div>
        <span class="sp"></span>
        <button v-if="busy" class="efp-btn" disabled>{{ progress }}</button>
        <button v-else class="efp-btn primary" :disabled="!sel.length" @click="confirm">
          读取并提问<template v-if="sel.length">（{{ sel.length }}）</template>
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 「选择文件问 AI」的选择器。
 *
 * 入口：文件夹树里文件行的 ✦（预勾该文件）、AI 浮窗顶栏的「文件」按钮。
 * 只读目录信息与选中的文件内容，不打开标签、不改文档。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { closeEditorAiPicker, edAi, openEditorAiFiles, type EdAiFile } from '../../editor/ai'
import { detectLang, langById } from '../../editor/langs'

const props = withDefaults(
  defineProps<{
    /** 工作区根目录；没有工作区时只列 extra */
    root?: string
    /** 已打开的标签（没有工作区时也能选） */
    extra?: { path: string; name: string }[]
  }>(),
  { root: '', extra: () => [] }
)
const emit = defineEmits<{ (e: 'warn', msg: string): void }>()

interface Row {
  path: string
  name: string
  rel: string
  size: number
  open?: boolean
}

/** 与主进程 readTextForAi 一致：单文件超过这个大小读不了 */
const MAX_BYTES = 4 * 1024 * 1024
/** 多文件上下文总预算（字符），与主进程 MAX_FILES_CHARS 对齐 */
const budget = 24000
/** 列表最多画这么多行，其余靠搜索 */
const SHOW_MAX = 300

const qEl = ref<HTMLInputElement | null>(null)
const files = ref<Row[]>([])
const loading = ref(false)
const err = ref('')
const q = ref('')
/** 选中的路径，按点击顺序（读文件时也按这个顺序，用户可控） */
const sel = ref<string[]>([])
const busy = ref(false)
const progress = ref('')
/** 读取途中被关掉（点遮罩 / Esc）：别再继续读，也别自作主张打开浮窗 */
let canceled = false

const rootName = computed(() => (props.root ? props.root.split(/[\\/]/).filter(Boolean).pop() || props.root : ''))

const matched = computed(() => {
  const kw = q.value.trim().toLowerCase()
  if (!kw) return files.value
  return files.value.filter((f) => f.name.toLowerCase().includes(kw) || f.rel.toLowerCase().includes(kw))
})
const visible = computed(() => matched.value.slice(0, SHOW_MAX))
const hiddenCount = computed(() => Math.max(0, matched.value.length - SHOW_MAX))
const allPicked = computed(() => !!visible.value.length && visible.value.every((f) => sel.value.includes(f.path)))

const selBytes = computed(() => {
  const map = new Map(files.value.map((f) => [f.path, f.size]))
  return sel.value.reduce((a, p) => a + (map.get(p) || 0), 0)
})

function dirOf(f: Row): string {
  const i = f.rel.lastIndexOf('/')
  return i > 0 ? f.rel.slice(0, i) : ''
}

function fmtSize(n: number): string {
  if (!n) return '0'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function toggle(path: string): void {
  const i = sel.value.indexOf(path)
  if (i >= 0) sel.value.splice(i, 1)
  else sel.value.push(path)
}

function toggleAll(): void {
  if (allPicked.value) {
    const drop = new Set(visible.value.map((f) => f.path))
    sel.value = sel.value.filter((p) => !drop.has(p))
    return
  }
  for (const f of visible.value) if (!sel.value.includes(f.path)) sel.value.push(f.path)
}

function close(): void {
  canceled = true
  busy.value = false
  closeEditorAiPicker()
}

function onEnter(): void {
  if (sel.value.length) void confirm()
}

// ---------------------------------------------------------------- 读取并打开

async function confirm(): Promise<void> {
  if (busy.value || !sel.value.length) return
  const byPath = new Map(files.value.map((f) => [f.path, f]))
  const picked = sel.value.map((p) => byPath.get(p)).filter((x): x is Row => !!x)
  if (!picked.length) return

  busy.value = true
  canceled = false
  err.value = ''
  const out: EdAiFile[] = []
  const skipped: string[] = []
  let left = budget
  for (let i = 0; i < picked.length; i++) {
    if (canceled) return
    const f = picked[i]
    // 预算用尽：剩下的直接跳过并在下面提示，别让用户以为都读进去了
    if (left < 400) {
      skipped.push(`${f.name}（超出上下文上限）`)
      continue
    }
    progress.value = `读取 ${i + 1}/${picked.length}…`
    const r = await window.sqlpilot
      .editorReadTextForAi(f.path, Math.min(12000, left))
      .catch((e: any) => ({ ok: false, error: e?.message || String(e) }) as any)
    if (!r.ok || typeof r.text !== 'string' || !r.text.trim()) {
      skipped.push(`${f.name}（${r.error || '空文件'}）`)
      continue
    }
    out.push({
      path: f.path,
      name: r.name || f.name,
      lang: langById(detectLang(f.path)).label,
      text: r.text,
      lines: r.lineCount || r.text.split('\n').length,
      truncated: !!r.truncated
    })
    left -= r.text.length
  }
  busy.value = false
  progress.value = ''
  if (canceled) return

  if (!out.length) {
    err.value = `这些文件都读不了：${skipped.join('；')}`
    return
  }
  openEditorAiFiles(out)
  closeEditorAiPicker()
  if (skipped.length) emit('warn', `已加入 ${out.length} 个文件；跳过 ${skipped.join('、')}`)
}

// ---------------------------------------------------------------- 加载

function extraRows(): Row[] {
  const seen = new Set<string>()
  const out: Row[] = []
  for (const t of props.extra) {
    if (!t?.path || seen.has(t.path)) continue
    seen.add(t.path)
    out.push({ path: t.path, name: t.name, rel: t.name, size: 0, open: true })
  }
  return out
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  const head = extraRows()
  if (!props.root) {
    files.value = head
    loading.value = false
    if (!head.length) err.value = '没有打开工作区：先用「文件 → 打开文件夹」，或直接打开几个文件'
    return
  }
  const r = await window.sqlpilot
    .editorListFilesForAi(props.root)
    .catch((e: any) => ({ ok: false, error: e?.message || String(e) }) as any)
  loading.value = false
  if (!r.ok || !Array.isArray(r.files)) {
    files.value = head
    err.value = r.error || '读取目录失败'
    return
  }
  const seen = new Set(head.map((x) => x.path))
  // 已打开的标签放最前，方便「我刚在看的这几个文件」
  files.value = [
    ...head,
    ...r.files
      .filter((f: EditorAiFileEntry) => !seen.has(f.path))
      .map((f: EditorAiFileEntry) => ({ path: f.path, name: f.name, rel: f.rel, size: f.size }))
  ]
  // 预勾：点文件行 ✦ 进来的那个文件（列表里没有也加一条，保证选得中）
  const seed = [...edAi.pickerSeed]
  for (const p of seed) {
    if (!files.value.some((f) => f.path === p)) {
      const name = p.split(/[\\/]/).pop() || p
      files.value.unshift({ path: p, name, rel: name, size: 0, open: true })
    }
  }
  sel.value = seed.filter((p) => files.value.some((f) => f.path === p))
}

/** 选择器一直挂在工作区里：每次打开重新拉一次目录（可能在编辑器里新建过文件） */
watch(
  () => edAi.pickerOpen,
  (v) => {
    if (!v) return
    canceled = false
    q.value = ''
    sel.value = []
    files.value = []
    err.value = ''
    void load().then(() => nextTick(() => qEl.value?.focus()))
  },
  { immediate: true }
)

function onWinKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.isComposing && edAi.pickerOpen) {
    e.stopPropagation()
    close()
  }
}

onMounted(() => window.addEventListener('keydown', onWinKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onWinKey))
</script>

<style scoped>
.efp-mask {
  position: fixed;
  inset: 0;
  z-index: 330;
  background: rgba(0, 0, 0, 0.36);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
}
.efp {
  width: 470px;
  max-width: calc(100vw - 40px);
  max-height: min(560px, 78vh);
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: efp-in 0.13s ease;
}
@keyframes efp-in { from { transform: translateY(-6px); opacity: 0.7; } to { transform: none; opacity: 1; } }

.efp-h { display: flex; align-items: center; gap: 8px; padding: 10px 11px 9px; border-bottom: 1px solid var(--border); }
.efp-logo {
  width: 22px; height: 22px; flex-shrink: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent);
}
.efp-title { min-width: 0; }
.efp-title b { display: block; font-size: 12.5px; }
.efp-title em { display: block; font-style: normal; font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp { flex: 1; }
.efp-x {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); font-size: 11px; font-family: inherit; cursor: pointer;
}
.efp-x:hover { color: var(--red); border-color: var(--red); }

.efp-tools { display: flex; gap: 6px; padding: 8px 11px 6px; }
.efp-q {
  flex: 1; min-width: 0; height: 26px; padding: 0 8px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text);
  font-family: inherit; font-size: 11.5px; outline: none;
}
.efp-q:focus { border-color: var(--accent); }
.efp-t {
  flex-shrink: 0; height: 26px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); font-family: inherit; font-size: 11px; cursor: pointer;
}
.efp-t:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.efp-t:disabled { opacity: 0.4; cursor: default; }

.efp-list { flex: 1; min-height: 120px; overflow-y: auto; padding: 2px 7px 6px; }
.efp-hint { padding: 8px 6px; font-size: 10.5px; color: var(--text-faint); }
.efp-hint.err { color: var(--red); }

.efp-row {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  padding: 4px 7px; border-radius: 6px; border: 1px solid transparent;
  background: none; color: var(--text); font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.efp-row:hover { background: var(--bg-card-hover); }
.efp-row.on { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.efp-ck {
  flex-shrink: 0; width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid var(--border-strong);
  background: var(--bg-input); color: #fff; font-size: 9px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.efp-row.on .efp-ck { background: var(--accent); border-color: var(--accent); }
.efp-name { flex-shrink: 0; max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.efp-tag {
  flex-shrink: 0; font-size: 9.5px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 4px; padding: 0 3px;
}
.efp-dir { flex: 1; min-width: 0; font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.efp-size { flex-shrink: 0; font-family: var(--mono); font-size: 9.5px; color: var(--text-faint); }
.efp-size.big { color: var(--red); }

.efp-f { display: flex; align-items: center; gap: 8px; padding: 8px 11px 9px; border-top: 1px solid var(--border); }
.efp-sum { font-size: 10.5px; color: var(--text-dim); }
.efp-sum b { font-family: var(--mono); color: var(--accent); font-size: 11.5px; }
.efp-sum em { font-style: normal; margin-left: 6px; color: var(--text-faint); }
.efp-btn {
  flex-shrink: 0; height: 26px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.efp-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.efp-btn:disabled { opacity: 0.5; cursor: default; }
.efp-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.efp-btn.primary:disabled { opacity: 0.4; }
</style>
