<template>
  <div class="wb-panel" :style="{ height: panelH + 'px' }">
    <div class="wb-drag" @mousedown="startVDrag" title="拖拽调整高度（双击收起/展开）" @dblclick="panelH = panelH > 60 ? 40 : 320"></div>

    <div class="wb-head">
      <div class="wb-tabs">
        <button class="wb-tab" :class="{ active: tab === 'terminal' }" @click="$emit('update:tab', 'terminal')">🖥 终端</button>
        <button class="wb-tab" :class="{ active: tab === 'sql' }" @click="$emit('update:tab', 'sql')">🗄 SQL 控制台</button>
      </div>
      <span style="flex:1"></span>
      <button class="icon-btn" title="关闭面板" @click="$emit('close')">✕</button>
    </div>

    <!-- ============ 终端标签（v-show 保持 DOM/xterm 实例存活，切换不丢画面） ============ -->
    <div v-show="tab === 'terminal'" class="wb-body">
      <div class="wb-side" :style="{ width: sideW + 'px' }">
        <div class="wb-side-title">服务器</div>
        <div v-if="!servers.length" class="wb-hint">项目未挂载服务器<br />右键项目 → 编辑属性</div>
        <div v-for="s in servers" :key="s.id" class="srv-item" :title="`${s.user}@${s.host}:${s.port}`" @click="openTerm(s)">
          <span>🖥</span><span class="name">{{ s.name }}</span>
          <span v-if="s.tag" class="tag" :class="{ prod: s.tag === '生产' }">{{ s.tag }}</span>
        </div>
      </div>
      <div class="wb-hsplit" @mousedown="startHDrag"></div>
      <div class="wb-main">
        <div class="term-tabs" v-if="terms.length">
          <div v-for="t in terms" :key="t.id" class="term-tab" :class="{ active: t.id === activeId }" @click="activeId = t.id">
            {{ t.name }}
            <button class="icon-btn" style="padding:0 3px; font-size:11px" @click.stop="closeTerm(t.id)">✕</button>
          </div>
          <span style="flex:1"></span>
          <button class="wb-mini" :class="{ on: sftpOpen }" title="SFTP 文件浏览器" @click="toggleSftp">📁 文件</button>
        </div>
        <div class="term-host" ref="hostEl">
          <div v-for="t in terms" :key="t.id" v-show="t.id === activeId" :ref="setPaneRef(t.id)"></div>
          <div v-if="!terms.length" class="term-empty">← 点击服务器打开交互式终端</div>
        </div>
      </div>

      <!-- SFTP 文件浏览器 -->
      <div v-if="sftpOpen && activeTerm" class="sftp-panel" :style="{ width: sftpW + 'px' }">
        <div class="wb-drag-h" @mousedown="startSftpDrag"></div>
        <div class="sftp-head">
          <button class="wb-mini" title="上一级" @click="sftpUp">↑</button>
          <input v-model="sftpPath" class="sftp-path" @keyup.enter="loadSftp" placeholder="/remote/path" />
          <button class="wb-mini" title="刷新" @click="loadSftp">⟳</button>
          <button class="wb-mini" title="上传文件到当前目录" @click="sftpUploadFiles">⬆ 上传</button>
        </div>
        <div class="sftp-list">
          <div v-if="sftpLoading" class="wb-hint">加载中…</div>
          <div v-else-if="!sftpEntries.length" class="wb-hint">（空目录）</div>
          <div
            v-for="f in sftpEntries"
            :key="f.name"
            class="sftp-item"
            :title="f.isDir ? f.name : `${f.name} · ${fmtSize(f.size)}（双击下载到项目 downloads/）`"
            @click="f.isDir && enterDir(f.name)"
            @dblclick="!f.isDir && sftpDownloadFile(f.name)"
          >
            <span>{{ f.isDir ? '📂' : '📄' }}</span>
            <span class="name">{{ f.name }}</span>
            <span class="size">{{ f.isDir ? '' : fmtSize(f.size) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ SQL 控制台（多会话窗口 + CodeMirror 高亮 + 信息面板） ============ -->
    <div v-show="tab === 'sql'" class="wb-body">
      <div class="wb-side" :style="{ width: sideW + 'px' }">
        <div class="wb-side-title" style="display: flex; align-items: center; justify-content: space-between">
          连接
          <button class="wb-mini" title="对当前选中连接新建查询窗口" @click="newQuery()">＋ 查询</button>
        </div>
        <div v-if="!allConns.length" class="wb-hint">左侧添加数据库连接</div>
        <template v-for="g in connGroups" :key="g.label">
          <div class="wb-side-sub">{{ g.label }}</div>
          <div
            v-for="c in g.items"
            :key="c.id"
            class="srv-item"
            :class="{ active: activeConnId === c.id }"
            :title="`${c.user}@${c.host}:${c.port}\n单击：查看数据库信息　▶ / 双击：新建查询`"
            @click="openInfo(c.id)"
            @dblclick="newQuery(c.id)"
          >
            <span>🗄</span><span class="name">{{ c.name }}</span>
            <span class="tag">{{ c.role === 'readonly' ? 'RO' : 'RW' }}</span>
            <button class="obj-mini" title="新建查询窗口" @click.stop="newQuery(c.id)">▶</button>
          </div>
        </template>
      </div>
      <div class="wb-hsplit" @mousedown="startHDrag"></div>
      <div class="wb-main sql-main">
        <div class="sql-tabs" v-if="sqlTabs.length">
          <div v-for="st in sqlTabs" :key="st.id" class="sql-tab" :class="{ active: st.id === activeSqlId }" @click="activeSqlId = st.id">
            <span>{{ st.kind === 'info' ? '📊' : '📝' }} {{ st.title }}</span>
            <button class="icon-btn" style="padding: 0 3px; font-size: 11px" @click.stop="closeSqlTab(st.id)">✕</button>
          </div>
          <span style="flex: 1"></span>
          <button class="wb-mini" title="新建查询窗口" @click="newQuery()">＋</button>
        </div>

        <template v-for="st in sqlTabs" :key="st.id">
          <!-- 查询窗口 -->
          <div v-show="st.id === activeSqlId && st.kind === 'query'" class="sql-pane">
            <div class="sql-toolbar">
              <select v-model="st.connId" class="wb-mini" style="padding: 2px 6px" title="本窗口使用的连接">
                <option v-for="c in allConns" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <button class="wb-mini" :disabled="st.running" @click="runSqlTab(st)">{{ st.running ? '执行中…' : '▶ 执行 (Ctrl+Enter)' }}</button>
              <button class="wb-mini" title="查看该连接的数据库信息" @click="openInfo(st.connId)">📊 信息</button>
              <span v-if="st.msg" class="sql-msg" :class="{ err: !st.ok }">{{ st.msg }}</span>
              <span style="flex: 1"></span>
              <span class="sql-hint">选中语句可单独执行</span>
            </div>
            <div class="sql-editor-host" :ref="setCmHost(st.id)"></div>
            <div class="sql-result" v-if="st.result">
              <table class="result-table" v-if="st.result.columns?.length">
                <thead><tr><th v-for="c in st.result.columns" :key="c">{{ c }}</th></tr></thead>
                <tbody>
                  <tr v-for="(row, i) in st.result.rows" :key="i">
                    <td v-for="(cell, j) in row" :key="j" :title="String(cell)">{{ cell === null ? '∅' : String(cell) }}</td>
                  </tr>
                </tbody>
              </table>
              <!-- 写语句没有结果网格：显示明确的成功消息（Navicat 的 "N row(s) affected"） -->
              <div v-else-if="st.result.message" class="dml-ok">✓ {{ st.result.message }} · {{ st.result.ms }}ms</div>
              <div v-if="st.result.truncated" style="font-size: 11px; color: var(--text-faint); padding: 4px 0">（结果超过 200 行，已截断显示）</div>
            </div>
          </div>
          <!-- 数据库信息窗口 -->
          <div v-show="st.id === activeSqlId && st.kind === 'info'" class="info-pane">
            <div v-if="st.infoLoading" class="sql-empty"><span class="spinner"></span> 采集数据库信息中…</div>
            <div v-else-if="st.infoError" class="sql-empty" style="color: var(--red)">✗ {{ st.infoError }}</div>
            <template v-else-if="st.info">
              <div v-for="sec in st.info.sections" :key="sec.title" class="info-sec">
                <div class="info-title">{{ sec.title }}</div>
                <div class="info-grid">
                  <template v-for="kv in sec.rows" :key="kv.k">
                    <div class="info-k">{{ kv.k }}</div>
                    <div class="info-v">{{ kv.v }}</div>
                  </template>
                </div>
              </div>
              <!-- Oracle 活跃会话（交互块：列可选 + 刷新，列清单来自 GV$SESSION 实际结构） -->
              <div v-if="st.isOracle && st.as" class="info-sec">
                <div class="as-head">
                  <span class="info-title">活跃会话（wait_class ≠ Idle 且 username 非空，按 last_call_et 排序）</span>
                  <span style="flex: 1"></span>
                  <button class="obj-mini" title="勾选要显示的列（按当前库 GV$SESSION 实际列动态生成）" @click="st.as.open = !st.as.open">列 {{ st.as.open ? '▴' : '▾' }}</button>
                  <button class="obj-mini" title="重新查询" @click="loadActiveSessions(st)">⟳ 刷新</button>
                </div>
                <div v-if="st.as.open" class="as-cols">
                  <label v-for="c in st.as.available" :key="c" class="as-col">
                    <input type="checkbox" :checked="st.as.selected.includes(c)" @change="toggleAsCol(st, c)" />{{ c }}
                  </label>
                  <div class="as-col-hint">列清单取自当前数据库 GV$SESSION 的真实结构（各版本不同）；默认勾选常用排障列</div>
                </div>
                <div v-if="st.as.loading" class="obj-meta" style="padding: 4px 0"><span class="spinner"></span> 查询中…</div>
                <div v-else-if="st.as.error" style="color: var(--red); font-size: 12.5px; padding: 4px 0">✗ {{ st.as.error }}</div>
                <template v-else>
                  <div class="obj-meta" style="padding: 4px 0">{{ st.as.rows.length }} 行 · {{ st.as.ms }}ms{{ st.as.note ? ' · ' + st.as.note : '' }}</div>
                  <div style="max-height: 320px; overflow: auto">
                    <table class="result-table">
                      <thead><tr><th class="rownum">#</th><th v-for="c in st.as.columns" :key="c">{{ c }}</th></tr></thead>
                      <tbody>
                        <tr v-for="(row, i) in st.as.rows" :key="i">
                          <td class="rownum">{{ i + 1 }}</td>
                          <td v-for="(cell, j) in row" :key="j" :title="asFull(cell)">{{ asFmt(cell) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </template>
              </div>
              <div v-for="tb in st.info.tables" :key="tb.title" class="info-sec">
                <div class="info-title">{{ tb.title }}</div>
                <div style="max-height: 280px; overflow: auto">
                  <table class="result-table">
                    <thead><tr><th v-for="c in tb.columns" :key="c">{{ c }}</th></tr></thead>
                    <tbody>
                      <tr v-for="(row, i) in tb.rows" :key="i">
                        <td v-for="(cell, j) in row" :key="j">{{ cell === null || cell === undefined ? '—' : String(cell) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div v-if="!st.info.sections.length && !st.info.tables.length" class="sql-empty">（未采集到信息，可能权限受限）</div>
            </template>
          </div>
        </template>

        <div v-if="!sqlTabs.length" class="sql-empty">点击左侧连接查看数据库信息，或 ＋ 新建查询窗口</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/sql/sql.js'
import 'codemirror/theme/material-darker.css'
import { store, curSession } from '../store'

const props = defineProps<{ tab: 'terminal' | 'sql' }>()
defineEmits<{ (e: 'close'): void; (e: 'update:tab', t: 'terminal' | 'sql'): void }>()

// ---------- 尺寸拖拽 ----------
const panelH = ref(320)
const sideW = ref(200)
const sftpW = ref(300)

function startVDrag(e: MouseEvent) {
  const startY = e.clientY
  const startH = panelH.value
  const move = (ev: MouseEvent) => {
    panelH.value = Math.min(Math.max(startH - (ev.clientY - startY), 160), window.innerHeight - 260)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
function startHDrag(e: MouseEvent) {
  const startX = e.clientX
  const startW = sideW.value
  const move = (ev: MouseEvent) => {
    sideW.value = Math.min(Math.max(startW + (ev.clientX - startX), 150), 460)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
function startSftpDrag(e: MouseEvent) {
  const startX = e.clientX
  const startW = sftpW.value
  const move = (ev: MouseEvent) => {
    sftpW.value = Math.min(Math.max(startW - (ev.clientX - startX), 200), 520)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

// ---------- 公共 ----------
const project = computed(() => {
  const pid = curSession()?.meta.projectId
  return pid ? (store.cfg?.projects || []).find((p: any) => p.id === pid) : null
})
const servers = computed(() => project.value?.servers || [])
const allConns = computed(() => store.cfg?.connections || [])
const connGroups = computed(() => {
  const pid = project.value?.id
  const proj = allConns.value.filter((c: any) => c.projectId === pid)
  const other = allConns.value.filter((c: any) => c.projectId !== pid)
  const groups: { label: string; items: any[] }[] = []
  if (proj.length) groups.push({ label: '本项目', items: proj })
  if (other.length) groups.push({ label: '其他连接', items: other })
  return groups
})

// ---------- 终端 ----------
interface TermTab { id: string; name: string; term: Terminal; fit: FitAddon; serverId: string; sftpPath: string }
const hostEl = ref<HTMLElement | null>(null)
const terms = ref<TermTab[]>([])
const activeId = ref('')
const paneEls = new Map<string, HTMLElement>()
const activeTerm = computed(() => terms.value.find((t) => t.id === activeId.value))

function setPaneRef(id: string) {
  return (el: any) => {
    if (el) paneEls.set(id, el as HTMLElement)
  }
}

async function openTerm(s: any) {
  const existing = terms.value.find((t) => t.serverId === s.id)
  if (existing) {
    activeId.value = existing.id
    return
  }
  const id = `term_${Date.now()}_${Math.floor(Math.random() * 1000)}`
  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? { background: '#ffffff', foreground: '#1f2433' } : { background: '#0b0d13', foreground: '#e8ebf4' },
    cursorBlink: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.onData((d) => window.sqlpilot.termInput(id, d))
  const tab: TermTab = { id, name: s.name, term, fit, serverId: s.id, sftpPath: `/home/${s.user}` }
  terms.value.push(tab)
  activeId.value = id
  await nextTick()
  const el = paneEls.get(id)
  if (el) {
    term.open(el)
    fit.fit()
    window.sqlpilot.termResize(id, term.cols, term.rows)
  }
  const r = await window.sqlpilot.termOpen(id, s.id)
  if (!r.ok) {
    // 连接失败不留死标签页
    alert(`连接 ${s.name} 失败：${r.error || '未知错误'}`)
    closeTerm(id)
    return
  }
  doFit(id)
}

function closeTerm(id: string) {
  const t = terms.value.find((x) => x.id === id)
  if (!t) return
  window.sqlpilot.termClose(id)
  t.term.dispose()
  terms.value = terms.value.filter((x) => x.id !== id)
  paneEls.delete(id)
  if (activeId.value === id) activeId.value = terms.value[terms.value.length - 1]?.id || ''
}

function doFit(id: string) {
  const t = terms.value.find((x) => x.id === id)
  if (!t) return
  try {
    t.fit.fit()
    window.sqlpilot.termResize(id, t.term.cols, t.term.rows)
  } catch { /* 忽略 */ }
}

let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let resizeObs: ResizeObserver | null = null

onMounted(() => {
  offData = window.sqlpilot.onTermData(({ termId, data }) => {
    terms.value.find((x) => x.id === termId)?.term.write(data)
  })
  offExit = window.sqlpilot.onTermExit(({ termId }) => {
    terms.value.find((x) => x.id === termId)?.term.writeln('\r\n\x1b[90m— 连接已关闭 —\x1b[0m')
  })
  resizeObs = new ResizeObserver(() => activeId.value && doFit(activeId.value))
  if (hostEl.value) resizeObs.observe(hostEl.value)
})

onBeforeUnmount(() => {
  offData?.()
  offExit?.()
  resizeObs?.disconnect()
  for (const t of terms.value) {
    window.sqlpilot.termClose(t.id)
    t.term.dispose()
  }
  cms.clear()
  cmHosts.clear()
})

// 切换终端子标签：重适配尺寸 + 刷新该终端的 SFTP 目录；从 SQL 切回终端时同样重适配
watch(activeId, () => {
  nextTick(() => activeId.value && doFit(activeId.value))
  if (sftpOpen.value && activeTerm.value) loadSftp()
})
watch(
  () => props.tab,
  (t) => {
    if (t === 'terminal') nextTick(() => activeId.value && doFit(activeId.value))
  }
)

// ---------- SFTP ----------
const sftpOpen = ref(true)
const sftpEntries = ref<any[]>([])
const sftpLoading = ref(false)
/** 当前终端各自的远程路径（每台服务器独立记忆） */
const sftpPath = computed({
  get: () => activeTerm.value?.sftpPath ?? '',
  set: (v: string) => {
    if (activeTerm.value) activeTerm.value.sftpPath = v
  }
})

function toggleSftp() {
  sftpOpen.value = !sftpOpen.value
  if (sftpOpen.value && activeTerm.value && !sftpEntries.value.length) loadSftp()
}

async function loadSftp() {
  if (!activeTerm.value || !sftpPath.value) return
  sftpLoading.value = true
  const r = await window.sqlpilot.sftpList(activeTerm.value.serverId, sftpPath.value)
  sftpLoading.value = false
  if (r.ok) sftpEntries.value = r.entries || []
  else sftpEntries.value = []
}

function enterDir(name: string) {
  sftpPath.value = sftpPath.value.replace(/\/+$/, '') + '/' + name
  loadSftp()
}

function sftpUp() {
  const parts = sftpPath.value.replace(/\/+$/, '').split('/')
  parts.pop()
  sftpPath.value = parts.join('/') || '/'
  loadSftp()
}

async function sftpDownloadFile(name: string) {
  if (!activeTerm.value) return
  const remote = sftpPath.value.replace(/\/+$/, '') + '/' + name
  const projRoot = (project.value as any)?.rootPath
  const dir = projRoot ? projRoot + '\\downloads' : ''
  const r = await window.sqlpilot.sftpDownload(activeTerm.value.serverId, remote, dir)
  if (r.ok && r.local) {
    await window.sqlpilot.showInFolder(r.local)
  } else if (r.error) {
    alert('下载失败：' + r.error)
  }
}

async function sftpUploadFiles() {
  if (!activeTerm.value) return
  const r = await window.sqlpilot.sftpUpload(activeTerm.value.serverId, sftpPath.value || '.')
  if (r.ok) await loadSftp()
  else if (r.error) alert('上传失败：' + r.error)
}

function fmtSize(n: number): string {
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + 'G'
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M'
  if (n > 1024) return (n / 1024).toFixed(1) + 'K'
  return n + 'B'
}

// ---------- SQL 控制台（多会话窗口 + CodeMirror + 信息面板） ----------
interface SqlTab {
  id: string
  kind: 'query' | 'info'
  connId: string
  title: string
  /** 查询窗口：编辑器内容与执行状态 */
  sql: string
  running: boolean
  ok: boolean
  msg: string
  result: any
  /** 信息窗口 */
  info: { sections: { title: string; rows: { k: string; v: string }[] }[]; tables: { title: string; columns: string[]; rows: any[][] }[] } | null
  infoLoading: boolean
  infoError: string
  /** Oracle 连接的活跃会话交互块（列可选 + 可刷新） */
  isOracle?: boolean
  as?: { available: string[]; selected: string[]; columns: string[]; rows: any[][]; ms: number; note: string; loading: boolean; error: string; open: boolean } | null
}
const sqlTabs = ref<SqlTab[]>([])
const activeSqlId = ref('')
const activeConnId = ref('')
let sqlSeq = 0

function connName(id: string): string {
  return allConns.value.find((c: any) => c.id === id)?.name || id
}

function newQuery(connId?: string) {
  const cid = connId || activeConnId.value || allConns.value[0]?.id || ''
  if (!cid) return
  activeConnId.value = cid
  sqlSeq++
  const tab = reactive({
    id: `sqltab_${Date.now()}_${sqlSeq}`, kind: 'query', connId: cid, title: `查询${sqlSeq}`,
    sql: '', running: false, ok: true, msg: '', result: null,
    info: null, infoLoading: false, infoError: ''
  }) as SqlTab
  sqlTabs.value.push(tab)
  activeSqlId.value = tab.id
  nextTick(() => { ensureCm(tab); refreshActiveCm() })
}

async function openInfo(connId: string) {
  activeConnId.value = connId
  const found = sqlTabs.value.find((t) => t.kind === 'info' && t.connId === connId)
  if (found) {
    activeSqlId.value = found.id
    return
  }
  const isOracle = allConns.value.find((c: any) => c.id === connId)?.type === 'oracle'
  const tab = reactive({
    id: `sqltab_${Date.now()}_${++sqlSeq}`, kind: 'info', connId, title: connName(connId),
    sql: '', running: false, ok: true, msg: '', result: null,
    info: null, infoLoading: true, infoError: '',
    isOracle,
    as: isOracle ? { available: [], selected: [], columns: [], rows: [], ms: 0, note: '', loading: true, error: '', open: false } : null
  }) as SqlTab
  sqlTabs.value.push(tab)
  activeSqlId.value = tab.id
  const r = await window.sqlpilot.connInfo(connId)
  tab.infoLoading = false
  if (r.ok) tab.info = { sections: r.sections || [], tables: r.tables || [] }
  else tab.infoError = r.error || '获取信息失败'
  if (isOracle) loadActiveSessions(tab)
}

/** 活跃会话：selected 为空时后端用默认列；返回后 available=真实列集、columns=实际生效列 */
async function loadActiveSessions(st: SqlTab) {
  if (!st.as) return
  st.as.loading = true
  st.as.error = ''
  try {
    const r = await window.sqlpilot.activeSessions(st.connId, st.as.selected.length ? [...st.as.selected] : undefined)
    if (r.ok) {
      st.as.available = r.available || []
      st.as.columns = r.columns || []
      st.as.selected = st.as.columns
      st.as.rows = r.rows || []
      st.as.ms = r.ms || 0
      st.as.note = r.note || ''
    } else {
      st.as.error = r.error || '查询失败'
    }
  } catch (e: any) {
    st.as.error = String(e?.message || e)
  } finally {
    st.as.loading = false
  }
}

function toggleAsCol(st: SqlTab, col: string) {
  if (!st.as) return
  const i = st.as.selected.indexOf(col)
  if (i >= 0) {
    if (st.as.selected.length <= 1) return // 至少保留一列
    st.as.selected.splice(i, 1)
  } else {
    st.as.selected.push(col)
  }
  loadActiveSessions(st)
}

function asFmt(v: any): string {
  if (v === null || v === undefined) return '∅'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function asFull(v: any): string {
  return v === null || v === undefined ? 'NULL' : asFmt(v)
}

function closeSqlTab(id: string) {
  const i = sqlTabs.value.findIndex((t) => t.id === id)
  if (i >= 0) sqlTabs.value.splice(i, 1)
  cms.delete(id)
  cmHosts.delete(id)
  if (activeSqlId.value === id) activeSqlId.value = sqlTabs.value[Math.min(i, sqlTabs.value.length - 1)]?.id || ''
}

// ---------- CodeMirror 实例管理（每个查询窗口一个，v-show 保活） ----------
const cmHosts = new Map<string, HTMLElement>()
const cms = new Map<string, any>()

function setCmHost(id: string) {
  return (el: any) => {
    if (el) {
      cmHosts.set(id, el as HTMLElement)
      const t = sqlTabs.value.find((x) => x.id === id)
      if (t && t.kind === 'query') ensureCm(t)
    }
  }
}

function ensureCm(tab: SqlTab) {
  if (cms.has(tab.id)) return
  const host = cmHosts.get(tab.id)
  if (!host) return
  const cm = CodeMirror(host, {
    value: tab.sql || '',
    mode: 'sql',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    extraKeys: {
      'Ctrl-Enter': () => runSqlTab(tab),
      'Cmd-Enter': () => runSqlTab(tab)
    }
  })
  cm.setSize('100%', '100%')
  cm.on('change', () => { tab.sql = cm.getValue() })
  cms.set(tab.id, cm)
}

function refreshActiveCm() {
  const cm = cms.get(activeSqlId.value)
  if (cm) nextTick(() => cm.refresh())
}

watch(activeSqlId, refreshActiveCm)
watch(
  () => props.tab,
  (t) => { if (t === 'sql') refreshActiveCm() }
)

async function runSqlTab(st: SqlTab) {
  const cm = cms.get(st.id)
  // Navicat 习惯：有选中内容执行选中，否则执行整个编辑器
  const sql = ((cm && cm.getSelection()) || (cm ? cm.getValue() : st.sql) || '')
    .trim()
    .replace(/;+\s*$/, '')
  if (!sql || st.running || !st.connId) return
  st.running = true
  st.msg = ''
  st.result = null
  try {
    const r = await window.sqlpilot.sqlRun(st.connId, sql)
    if (r.ok) {
      st.ok = true
      st.result = r.result
      st.msg = r.result.message
        ? `✓ ${r.result.message} · ${r.result.ms}ms`
        : `${r.result.kind || ''} · ${r.result.rowCount} 行 · ${r.result.ms}ms`.trim()
    } else {
      st.ok = false
      st.msg = '✗ ' + r.error
    }
  } catch (e: any) {
    st.ok = false
    st.msg = '✗ ' + String(e?.message || e)
  } finally {
    st.running = false
  }
}
</script>

<style scoped>
.wb-panel {
  border-top: 1px solid var(--border-strong);
  background: var(--bg-side);
  display: flex;
  flex-direction: column;
  position: relative;
  flex-shrink: 0;
}
.wb-drag {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 7px;
  cursor: ns-resize;
  z-index: 10;
}
.wb-drag:hover { background: var(--accent-dim); }
.wb-head {
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: 36px;
  border-bottom: 1px solid var(--border);
}
.wb-tabs { display: flex; gap: 2px; }
.wb-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  padding: 6px 14px;
  cursor: pointer;
  border-radius: 7px;
  font-family: inherit;
}
.wb-tab:hover { color: var(--text); background: var(--bg-card-hover); }
.wb-tab.active { color: var(--accent); background: var(--accent-dim); font-weight: 600; }
.wb-body { flex: 1; display: flex; min-height: 0; }
.wb-side { border-right: 1px solid var(--border); overflow-y: auto; padding: 4px 0; flex-shrink: 0; }
.wb-side-title { padding: 6px 12px 4px; font-size: 11px; color: var(--text-faint); font-weight: 700; letter-spacing: 1px; }
.wb-side-sub { padding: 6px 12px 2px; font-size: 11px; color: var(--text-faint); }
.wb-hint { padding: 8px 12px; color: var(--text-faint); font-size: 12px; line-height: 1.7; }
.wb-hsplit { width: 5px; cursor: ew-resize; flex-shrink: 0; background: transparent; }
.wb-hsplit:hover { background: var(--accent-dim); }
.wb-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.srv-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; margin: 1px 6px; border-radius: 7px;
  cursor: pointer; color: var(--text-dim); font-size: 12.5px;
}
.srv-item:hover { background: var(--bg-card-hover); color: var(--text); }
.srv-item.active { background: var(--accent-dim); color: var(--text); }
.srv-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srv-item .tag { font-size: 10px; padding: 1px 6px; border-radius: 99px; background: var(--accent-dim); color: var(--accent); }
.srv-item .tag.prod { background: var(--red-dim); color: var(--red); }

.term-tabs {
  display: flex; align-items: center; gap: 4px; padding: 4px 8px 0;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  overflow-x: auto;
}
.term-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border: 1px solid var(--border); border-bottom: none;
  border-radius: 7px 7px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card);
}
.term-tab.active { color: var(--text); background: var(--bg-code); border-color: var(--border-strong); }
.term-host { flex: 1; min-height: 0; padding: 4px 6px; background: var(--bg-code); position: relative; }
.term-host > div { height: 100%; }
.term-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 12.5px; }
.wb-mini {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit;
}
.wb-mini:hover { color: var(--accent); border-color: var(--accent); }
.wb-mini.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

/* SFTP */
.sftp-panel { border-left: 1px solid var(--border); display: flex; flex-direction: column; position: relative; flex-shrink: 0; min-width: 0; }
.wb-drag-h { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: ew-resize; z-index: 10; }
.wb-drag-h:hover { background: var(--accent-dim); }
.sftp-head { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border); align-items: center; }
.sftp-path {
  flex: 1; min-width: 0; font-size: 12px; font-family: var(--mono);
  padding: 3px 8px; border-radius: 6px;
}
.sftp-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.sftp-item {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; color: var(--text-dim);
  font-family: var(--mono);
}
.sftp-item:hover { background: var(--bg-card-hover); color: var(--text); }
.sftp-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sftp-item .size { color: var(--text-faint); font-size: 11px; }

/* SQL 控制台 */
.sql-main { }
.sql-tabs {
  display: flex; align-items: center; gap: 4px; padding: 4px 8px 0;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  overflow-x: auto; flex-shrink: 0;
}
.sql-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border: 1px solid var(--border); border-bottom: none;
  border-radius: 7px 7px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card); white-space: nowrap;
}
.sql-tab.active { color: var(--text); background: var(--bg-code); border-color: var(--border-strong); }
.sql-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; }
.sql-toolbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
.sql-msg { font-size: 12px; color: var(--green); word-break: break-all; }
.sql-msg.err { color: var(--red); }
.sql-hint { font-size: 11px; color: var(--text-faint); }
.sql-editor-host { flex: 1.2; min-height: 80px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.sql-editor-host :deep(.CodeMirror) { height: 100% !important; font-family: var(--mono); font-size: 13px; }
.sql-editor-host :deep(.CodeMirror-scroll) { min-height: 60px; }
.sql-result { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--border); padding-top: 6px; }
.dml-ok {
  color: var(--green); font-size: 13px; padding: 10px 4px;
  display: flex; align-items: center; gap: 6px;
}
.sql-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 12.5px; gap: 6px; }
.obj-mini {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 1px 7px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.obj-mini:hover { color: var(--accent); border-color: var(--accent); }

/* Oracle 活跃会话块 */
.as-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.as-head .info-title { margin-bottom: 0; }
.as-cols {
  border: 1px dashed var(--border-strong); border-radius: 8px; padding: 8px 10px;
  margin-bottom: 8px; display: flex; flex-wrap: wrap; gap: 4px 12px;
  max-height: 180px; overflow: auto;
}
.as-col { font-size: 11.5px; font-family: var(--mono); color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.as-col:hover { color: var(--text); }
.as-col-hint { flex-basis: 100%; font-size: 11px; color: var(--text-faint); }
.rownum { color: var(--text-faint); background: var(--bg-card); position: sticky; left: 0; }

/* 数据库信息面板 */
.info-pane { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px; }
.info-sec { margin-bottom: 16px; }
.info-title { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 6px; letter-spacing: 0.5px; }
.info-grid { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 4px 16px; font-size: 12.5px; }
.info-k { color: var(--text-faint); }
.info-v { color: var(--text); word-break: break-all; }
</style>
