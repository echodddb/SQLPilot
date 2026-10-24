<template>
  <aside ref="panelEl" class="ws" :style="{ width: width + 'px' }">
    <div class="ws-head">
      <button
        class="ws-switch"
        :class="{ open: rootsOpen }"
        :title="`${root}\n点击切换其他文件夹`"
        @click.stop="toggleRoots"
      >
        <span class="ws-folder">▣</span>
        <span class="ws-title">{{ rootName }}</span>
        <span v-if="roots.length > 1" class="ws-count">{{ roots.length }}</span>
        <span class="ws-caret">▾</span>
      </button>
      <span class="ws-actions">
        <button class="ws-btn" title="刷新（重新读取已展开的目录）" @click="refresh">⟳</button>
        <button class="ws-btn" title="更多操作" @click.stop="openMenu">⋯</button>
      </span>

      <!-- 文件夹树切换 -->
      <div v-if="rootsOpen" class="ws-roots" @click.stop>
        <div class="ws-roots-head">文件夹树</div>
        <div
          v-for="r in roots"
          :key="r"
          class="ws-root-row"
          :class="{ cur: samePath(r, root) }"
          :title="r"
          @click="onPickRoot(r)"
        >
          <span class="ws-root-check">{{ samePath(r, root) ? '✓' : '' }}</span>
          <span class="ws-root-main">
            <span class="ws-root-name">{{ baseName(r) }}</span>
            <span class="ws-root-path">{{ dirOf(r) }}</span>
          </span>
          <button class="ws-root-x" title="从列表移除（不删除磁盘文件）" @click.stop="emit('remove-root', r)">✕</button>
        </div>
        <div class="ws-menu-sep"></div>
        <div class="ws-menu-item" @click="rootsOpen = false; pick()">＋ 打开文件夹…</div>
      </div>
      <div v-if="menuOpen" class="ws-menu" @click.stop>
        <div class="ws-menu-item" @click="menuOpen = false; pick()">打开文件夹…</div>
        <div class="ws-menu-item" @click="menuOpen = false; rootsOpen = true">切换文件夹树…</div>
        <div class="ws-menu-sep"></div>
        <div class="ws-menu-item" @click="menuOpen = false; refresh()">刷新</div>
        <div class="ws-menu-item" @click="menuOpen = false; collapseAll()">折叠全部</div>
        <div class="ws-menu-sep"></div>
        <div class="ws-menu-item" @click="menuOpen = false; emit('remove-root', root)">从列表移除当前文件夹</div>
        <div class="ws-menu-item" @click="menuOpen = false; emit('close')">关闭文件夹树</div>
      </div>
    </div>

    <div class="ws-body" @contextmenu.self.prevent>
      <div
        v-for="row in rows"
        :key="row.key"
        class="ws-row"
        :class="{ dir: row.isDir, active: row.path === activePath, hidden: row.hidden, more: row.isMore }"
        :style="{ paddingLeft: 6 + row.depth * 13 + 'px' }"
        :title="row.isMore ? '显示更多' : row.path"
        @click="onRowClick(row)"
      >
        <template v-if="row.isMore">
          <span class="ws-more">显示更多（还有 {{ row.remaining }} 项）</span>
        </template>
        <template v-else>
          <span class="ws-arrow" :class="{ blank: !row.isDir }" @click.stop="row.isDir && toggle(row)">
            {{ row.isDir ? (row.expanded ? '▾' : '▸') : '' }}
          </span>
          <span class="ws-dot" :class="dotClass(row)"></span>
          <span class="ws-name">{{ row.name }}</span>
          <span v-if="row.loading" class="ws-loading"></span>
          <!-- 文件行：打开「选择文件」弹层（可多选），这个文件先勾上 -->
          <button
            v-if="!row.isDir"
            class="ws-ai"
            title="问 AI：勾选这个文件（在弹层里还能再选别的文件）"
            @click.stop="emit('ai', row.path)"
          >✦</button>
        </template>
      </div>

      <div v-if="rootState.loading && !rows.length" class="ws-hint">读取中…</div>
      <div v-else-if="rootState.error" class="ws-hint err">{{ rootState.error }}</div>
      <div v-else-if="!rows.length" class="ws-hint">（空文件夹）</div>
    </div>

    <div class="ws-resizer" title="拖动调整宽度" @mousedown.prevent="startResize"></div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

interface DirEntry {
  name: string
  path: string
  isDir: boolean
  hidden: boolean
}

interface NodeState {
  entries: DirEntry[] | null
  expanded: boolean
  loading: boolean
  error: string
  limit: number
}

interface Row {
  key: string
  name: string
  path: string
  isDir: boolean
  hidden: boolean
  depth: number
  expanded?: boolean
  loading?: boolean
  isMore?: boolean
  remaining?: number
  moreDir?: string
}

const props = defineProps<{ root: string; roots: string[]; activePath: string | null }>()
const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'ai', path: string): void
  (e: 'close'): void
  (e: 'switch-root', dir: string): void
  (e: 'add-root', dir: string): void
  (e: 'remove-root', dir: string): void
}>()

const panelEl = ref<HTMLElement | null>(null)
const nodes = reactive<Record<string, NodeState>>({})
const width = ref(Number(localStorage.getItem('sqlpilot.editor.tree.width') || 236) || 236)
const menuOpen = ref(false)
const rootsOpen = ref(false)

const PAGE = 400

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
const samePath = (a: string, b: string): boolean => !!a && !!b && norm(a).toLowerCase() === norm(b).toLowerCase()
const baseName = (p: string): string => {
  const s = norm(p)
  return s.split('/').pop() || s
}
const dirOf = (p: string): string => {
  const s = norm(p)
  const i = s.lastIndexOf('/')
  if (i <= 0) return s
  // 太长时只显示末尾两级，避免撑破面板
  const parts = s.slice(0, i).split('/')
  const tail = parts.slice(-2).join('/')
  return parts.length > 2 ? '…/' + tail : tail
}

const rootName = computed(() => {
  const p = norm(props.root)
  return p.split('/').pop() || p
})

const EMPTY_NODE: NodeState = { entries: null, expanded: true, loading: true, error: '', limit: PAGE }
const rootState = computed<NodeState>(() => nodes[props.root] || EMPTY_NODE)

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (dir: string, depth: number): void => {
    const n = nodes[dir]
    if (!n?.entries) return
    const shown = n.entries.slice(0, n.limit)
    for (const e of shown) {
      out.push({
        key: e.path,
        name: e.name,
        path: e.path,
        isDir: e.isDir,
        hidden: e.hidden,
        depth,
        expanded: !!nodes[e.path]?.expanded,
        loading: !!nodes[e.path]?.loading
      })
      if (e.isDir && nodes[e.path]?.expanded) walk(e.path, depth + 1)
    }
    if (n.entries.length > n.limit) {
      out.push({
        key: 'more:' + dir,
        name: '',
        path: '',
        isDir: false,
        hidden: false,
        depth,
        isMore: true,
        remaining: n.entries.length - n.limit,
        moreDir: dir
      })
    }
  }
  walk(props.root, 0)
  return out
})

function ensureNode(dir: string): NodeState {
  if (!nodes[dir]) {
    nodes[dir] = { entries: null, expanded: false, loading: false, error: '', limit: PAGE }
  }
  return nodes[dir]
}

async function loadDir(dir: string, force = false): Promise<void> {
  const n = ensureNode(dir)
  if (n.entries && !force) return
  n.loading = true
  try {
    const r = await window.sqlpilot.editorListDir(dir)
    if (r.ok) {
      n.entries = (r.entries || []) as DirEntry[]
      n.error = ''
    } else {
      n.entries = []
      n.error = r.error || '读取失败'
    }
  } catch (e: any) {
    n.entries = []
    n.error = e?.message || '读取失败'
  } finally {
    n.loading = false
  }
}

async function toggle(row: Row): Promise<void> {
  if (!row.isDir) return
  const n = ensureNode(row.path)
  if (!n.expanded) {
    n.expanded = true
    await loadDir(row.path)
    saveExpanded()
  } else {
    n.expanded = false
    saveExpanded()
  }
}

function onRowClick(row: Row): void {
  if (row.isMore) {
    if (row.moreDir) ensureNode(row.moreDir).limit += PAGE
    return
  }
  if (row.isDir) void toggle(row)
  else emit('open', row.path)
}

function dotClass(row: Row): string {
  if (row.isDir) return 'is-dir'
  const ext = (row.name.split('.').pop() || '').toLowerCase()
  if (['sql', 'plsql', 'pkb', 'pks', 'prc', 'fnc', 'trg', 'vw', 'tab'].includes(ext)) return 'is-sql'
  if (['log', 'out', 'err', 'trace', 'audit', 'trc'].includes(ext)) return 'is-log'
  if (['py', 'js', 'mjs', 'cjs', 'ts', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'php', 'rb', 'sh', 'bash', 'bat', 'cmd', 'ps1'].includes(ext)) return 'is-code'
  if (['json', 'xml', 'html', 'htm', 'css', 'yaml', 'yml', 'ini', 'conf', 'cnf', 'toml', 'properties'].includes(ext)) return 'is-conf'
  return 'is-text'
}

// ---------- 展开状态持久化（按根目录分别记住） ----------
/** Windows 路径可能混用正反斜杠（对话框给反斜杠、命令行可能给正斜杠），统一比较 */
const slash = (p: string): string => p.replace(/\\/g, '/')
const expKey = (): string => 'sqlpilot.editor.tree.expanded:' + slash(props.root).replace(/\/+$/, '')

function saveExpanded(): void {
  try {
    const list = Object.keys(nodes).filter((p) => nodes[p].expanded).slice(0, 300)
    localStorage.setItem(expKey(), JSON.stringify(list))
  } catch { /* 忽略 */ }
}

async function restoreExpanded(): Promise<void> {
  let saved: string[] = []
  try { saved = JSON.parse(localStorage.getItem(expKey()) || '[]') || [] } catch { saved = [] }
  const rootS = slash(props.root).replace(/\/+$/, '').toLowerCase()
  for (const p of saved.slice(0, 60)) {
    const ps = slash(p).toLowerCase()
    if (ps !== rootS && !ps.startsWith(rootS + '/')) continue
    const n = ensureNode(p)
    n.expanded = true
    await loadDir(p)
  }
}

// ---------- 定位当前文件：展开其父级目录 ----------
let revealing = false
async function reveal(path: string | null): Promise<void> {
  if (!path || revealing) return
  const rootS = slash(props.root).replace(/\/+$/, '')
  const pathS = slash(path)
  if (pathS.toLowerCase().slice(0, rootS.length) !== rootS.toLowerCase()) return
  if (pathS.length <= rootS.length) return
  const parts = pathS.slice(rootS.length + 1).split('/')
  if (parts.length < 2) return
  revealing = true
  try {
    let cur = props.root
    await loadDir(cur)
    for (let i = 0; i < parts.length - 1; i++) {
      const list = nodes[cur]?.entries || []
      const child = list.find((e) => e.isDir && e.name.toLowerCase() === parts[i].toLowerCase())
      if (!child) break
      const n = ensureNode(child.path)
      n.expanded = true
      await loadDir(child.path)
      cur = child.path
    }
    saveExpanded()
  } finally {
    revealing = false
  }
}

// ---------- 头部操作 ----------
function toggleRoots(): void {
  rootsOpen.value = !rootsOpen.value
  if (rootsOpen.value) menuOpen.value = false
}

function openMenu(): void {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) rootsOpen.value = false
}

function onPickRoot(dir: string): void {
  rootsOpen.value = false
  if (samePath(dir, props.root)) return
  emit('switch-root', dir)
}

async function pick(): Promise<void> {
  const r = await window.sqlpilot.editorOpenFolder()
  if (r.ok && r.dir) emit('add-root', r.dir)
}

async function refresh(): Promise<void> {
  const expanded = Object.keys(nodes).filter((p) => nodes[p].expanded)
  for (const p of expanded) {
    const n = nodes[p]
    if (n) { n.entries = null; n.limit = PAGE }
  }
  await loadDir(props.root, true)
  for (const p of expanded) if (p !== props.root) await loadDir(p, true)
}

function collapseAll(): void {
  for (const p of Object.keys(nodes)) if (p !== props.root) nodes[p].expanded = false
  saveExpanded()
}

// ---------- 宽度拖拽 ----------
let resizing = false
let startX = 0
let startW = 0

function startResize(e: MouseEvent): void {
  resizing = true
  startX = e.clientX
  startW = width.value
  document.addEventListener('mousemove', onResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResize(e: MouseEvent): void {
  if (!resizing) return
  width.value = Math.max(150, Math.min(520, startW + (e.clientX - startX)))
}

function stopResize(): void {
  resizing = false
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  try { localStorage.setItem('sqlpilot.editor.tree.width', String(width.value)) } catch { /* 忽略 */ }
}

function onDocDown(e: MouseEvent): void {
  if (!menuOpen.value && !rootsOpen.value) return
  const el = e.target as HTMLElement | null
  if (!el?.closest('.ws-menu') && !el?.closest('.ws-roots') && !el?.closest('.ws-btn') && !el?.closest('.ws-switch')) {
    menuOpen.value = false
    rootsOpen.value = false
  }
}

onMounted(async () => {
  document.addEventListener('mousedown', onDocDown, true)
  await loadDir(props.root)
  await restoreExpanded()
  void reveal(props.activePath)
})

watch(() => props.root, async () => {
  rootsOpen.value = false
  menuOpen.value = false
  for (const k of Object.keys(nodes)) delete nodes[k]
  await loadDir(props.root)
  await restoreExpanded()
  // 切换工作区后，如果当前标签就在新目录里，直接定位过去
  if (props.activePath) void reveal(props.activePath)
})

watch(() => props.activePath, (p) => { void reveal(p) })

onBeforeUnmount(() => {
  stopResize()
  document.removeEventListener('mousedown', onDocDown, true)
})
</script>

<style scoped>
.ws {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-side);
  border-right: 1px solid var(--border);
  user-select: none;
}
.ws-head {
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px 0 4px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  position: relative;
}
.ws-switch {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 23px;
  padding: 0 5px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
}
.ws-switch:hover { background: var(--bg-card-hover); border-color: var(--border); }
.ws-switch.open { background: var(--accent-dim); border-color: var(--border-strong); }
.ws-folder { color: var(--accent); font-size: 12px; flex: 0 0 auto; }
.ws-caret { color: var(--text-faint); font-size: 8px; flex: 0 0 auto; }
.ws-count {
  flex: 0 0 auto;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 9.5px;
  line-height: 12px;
  text-align: center;
  letter-spacing: 0;
}
.ws-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
}
.ws-roots {
  position: absolute;
  top: 30px;
  left: 4px;
  min-width: 234px;
  max-width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 31;
  text-transform: none;
  letter-spacing: 0;
}
.ws-roots-head {
  padding: 3px 8px 5px;
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-faint);
}
.ws-root-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 4px 5px 2px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text);
  letter-spacing: 0;
}
.ws-root-row:hover { background: var(--bg-card-hover); }
.ws-root-row.cur { background: var(--accent-dim); }
.ws-root-check {
  width: 12px;
  flex: 0 0 12px;
  text-align: center;
  color: var(--accent);
  font-size: 10px;
}
.ws-root-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ws-root-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-root-row.cur .ws-root-name { color: var(--accent); font-weight: 600; }
.ws-root-path {
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: ltr;
}
.ws-root-x {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 9.5px;
  cursor: pointer;
  opacity: 0;
  padding: 0;
  line-height: 1;
}
.ws-root-row:hover .ws-root-x { opacity: 1; }
.ws-root-x:hover { background: var(--red); color: #fff; }
.ws-actions { display: flex; gap: 1px; }
.ws-menu {
  position: absolute;
  top: 29px;
  right: 6px;
  min-width: 148px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 30;
}
.ws-menu-item {
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.ws-menu-item:hover { background: var(--accent-dim); }
.ws-menu-sep { height: 1px; background: var(--border); margin: 4px 6px; }
.ws-btn {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 13px;
  width: 23px;
  height: 23px;
  border-radius: 5px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.ws-btn:hover { background: var(--bg-card-hover); color: var(--text); }
.ws-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 12px;
}
.ws-row {
  height: 22px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  position: relative;
}
.ws-row:hover { background: var(--bg-card-hover); }
/* 文件行右侧的「问 AI」：默认透明，hover 才出现 */
.ws-ai {
  margin-left: auto;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-faint);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.ws-row:hover .ws-ai { opacity: 1; }
.ws-ai:hover { color: var(--accent); background: var(--accent-dim); }
.ws-row.active { background: var(--accent-dim); color: var(--accent); }
.ws-row.hidden { opacity: 0.55; }
.ws-row.dir .ws-name { font-weight: 500; }
.ws-arrow {
  width: 11px;
  flex: 0 0 11px;
  text-align: center;
  color: var(--text-faint);
  font-size: 9px;
}
.ws-arrow.blank { visibility: hidden; }
.ws-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex: 0 0 6px;
  background: var(--text-faint);
}
.ws-dot.is-dir { background: var(--accent); border-radius: 1px; }
.ws-dot.is-sql { background: #5b9bd5; }
.ws-dot.is-log { background: var(--yellow); }
.ws-dot.is-code { background: var(--purple); }
.ws-dot.is-conf { background: var(--green); }
.ws-dot.is-text { background: var(--text-faint); }
.ws-name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.ws-loading {
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ws-spin 0.7s linear infinite;
  flex: 0 0 9px;
}
@keyframes ws-spin { to { transform: rotate(360deg); } }
.ws-more {
  color: var(--accent);
  font-size: 11.5px;
  padding-left: 15px;
}
.ws-hint {
  padding: 10px 12px;
  color: var(--text-faint);
  font-size: 11.5px;
  line-height: 1.7;
}
.ws-hint.err { color: var(--red); }
.ws-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}
.ws-resizer:hover { background: var(--accent-dim); }
</style>
