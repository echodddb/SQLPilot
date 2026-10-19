<template>
  <div class="qt-pane" ref="paneHost">
    <div class="qt-toolbar">
      <select v-model="connId" class="qt-conn" title="本窗口使用的连接">
        <option v-for="c in allConns" :key="c.id" :value="c.id">{{ c.name }} · {{ typeLabel(c.type) }}</option>
      </select>
      <div class="qt-action-group">
        <button class="qt-run" :disabled="running" @click="runSql">
          <span v-if="running" class="spinner qt-run-spinner"></span>
          <span v-else>▶</span>
          {{ running ? '执行中' : '执行' }}
        </button>
        <button class="mini-btn" title="清空 SQL 编辑器" :disabled="running" @click="clearSql">清空</button>
      </div>
      <template v-if="isOracle">
        <button class="mini-btn" title="提交当前事务（Oracle 无自动提交，DML 需显式 COMMIT 生效）" :disabled="running" @click="runTx('COMMIT')">✓ 提交</button>
        <button class="mini-btn" title="回滚当前事务" :disabled="running" @click="runTx('ROLLBACK')">↩ 回滚</button>
      </template>
      <button class="mini-btn" title="查看该连接的数据库信息" @click="emit('open-info', connId)">信息</button>
      <button class="mini-btn" title="导出查询结果为 CSV（可选择列；重新执行查询取全量，上限 10 万行）" :disabled="!lastSql || !result?.columns?.length" @click="openExport">导出</button>
      <span v-if="msg" class="qt-msg" :class="{ err: !ok }">{{ msg }}</span>
    </div>
    <div
      class="qt-editor-host"
      ref="cmHost"
      :class="{ collapsed: editorCollapsed }"
      :style="editorCollapsed ? undefined : { height: `${editorHeight}px` }"
    ></div>
    <div class="qt-splitter" title="拖拽调整编辑区/结果区高度；双击折叠或展开编辑区" @dblclick="toggleEditor" @mousedown="startResize"><span></span></div>

    <div class="qt-result">
      <div class="qt-result-head">
        <span class="qt-status" :class="{ ok: ok && !running, err: !ok, running }">
          <span v-if="running" class="spinner"></span>
          {{ running ? '执行中' : result ? (ok ? '成功' : '失败') : '待执行' }}
        </span>
        <span class="qt-meta" v-if="result">
          {{ resultFilter ? `${displayRows.length}/${result.rowCount}` : result.rowCount }} 行 · {{ result.ms }}ms<template v-if="result.truncated"> · 已截断</template>
        </span>
        <span class="qt-meta" v-else>Ctrl+Enter 执行 · 有选中时仅执行选中 SQL</span>
        <label class="qt-filter" v-if="result?.columns?.length">
          <span>⌕</span>
          <input v-model.trim="resultFilter" placeholder="过滤当前结果" />
          <button v-if="resultFilter" title="清空过滤" @click="resultFilter = ''">✕</button>
        </label>
        <div class="qt-result-actions" v-if="result?.columns?.length">
          <button class="mini-btn" :class="{ on: resultWrap }" :title="resultWrap ? '切换为省略号显示' : '切换为换行显示'" @click="resultWrap = !resultWrap">{{ resultWrap ? '已换行' : '换行' }}</button>
          <button class="mini-btn" title="复制当前过滤/排序后的结果为 TSV" @click="copyResult">复制</button>
        </div>
        <button class="mini-btn ghost" title="清除当前结果和消息" :disabled="!result && !msg" @click="clearResult">清除</button>
      </div>

      <div class="qt-result-body" v-if="result?.columns?.length">
        <table class="result-table qt-grid" :class="{ wrap: resultWrap }">
        <thead>
          <tr>
            <th class="rownum">#</th>
            <th v-for="(c, j) in result.columns" :key="c" class="sortable" :class="{ sorted: sort.index === j }" :title="`点击按 ${c} 排序`" @click="sortBy(j)">
              {{ c }}<span class="sort-mark">{{ sort.index === j ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '' }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in displayRows" :key="i">
            <td class="rownum">{{ i + 1 }}</td>
            <td
              v-for="(cell, j) in row"
              :key="j"
              :class="{ num: isNumeric(cell), null: cell === null || cell === undefined }"
              :title="cellTitle(cell)"
              @dblclick="copyCell(cell)"
            >{{ formatCell(cell) }}</td>
          </tr>
        </tbody>
      </table>
        <div v-if="!displayRows.length" class="qt-result-empty">没有匹配「{{ resultFilter }}」的行</div>
      </div>

      <!-- 写语句没有结果网格：显示明确的成功消息（Navicat 的 "N row(s) affected"） -->
      <div v-else-if="result?.message" class="dml-ok">✓ {{ result.message }} · {{ result.ms }}ms</div>
      <div v-else class="qt-result-empty">
        <b>SQL 控制台</b>
        <span>输入 SQL 后按 Ctrl+Enter 执行；选中片段时只执行选中内容。</span>
      </div>
    </div>

    <!-- 导出面板：选择要导出的列 -->
    <div class="modal-mask" v-if="exportOpen">
      <div class="modal" style="width: 520px; max-width: 92vw">
        <h3>⬇ 导出查询结果</h3>
        <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 10px">
          重新执行当前查询导出<b>全量结果</b>（上限 10 万行），格式 CSV（UTF-8 带 BOM，Excel 可直接打开）。
        </div>
        <div style="font-size: 12px; color: var(--text-dim); margin-bottom: 6px; display: flex; align-items: center">
          <b>选择列</b>
          <span style="flex: 1"></span>
          <a style="cursor: pointer; color: var(--accent)" @click="toggleAllExportCols">{{ allExportColsOn ? '全不选' : '全选' }}</a>
        </div>
        <div class="export-cols">
          <label v-for="c in exportCols" :key="c.name" class="export-col">
            <input type="checkbox" v-model="c.on" />{{ c.name }}
          </label>
        </div>
        <div class="actions">
          <button class="btn ghost" @click="exportOpen = false">取消</button>
          <span style="flex: 1"></span>
          <button class="btn primary" :disabled="!exportCols.some((c) => c.on) || exporting" @click="doExport">
            {{ exporting ? '导出中…' : `导出 ${exportCols.filter((c) => c.on).length} 列` }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/sql/sql.js'
import 'codemirror/theme/material-darker.css'
import 'codemirror/addon/selection/active-line.js'
import 'codemirror/addon/display/placeholder.js'
import { store } from '../../store'

const props = defineProps<{ tabKey: string; initConnId: string }>()
const emit = defineEmits<{ (e: 'open-info', connId: string): void }>()

const connId = ref(props.initConnId)
const sql = ref('')
const running = ref(false)
const ok = ref(true)
const msg = ref('')
const result = ref<any>(null)
/** 本窗口当前占用的独立会话对应的连接（切换连接后释放旧会话） */
let prevConn: string | null = null

const cmHost = ref<HTMLElement | null>(null)
const paneHost = ref<HTMLElement | null>(null)
let cm: CodeMirror.Editor | null = null
const editorHeight = ref(260)
const editorCollapsed = ref(false)
const resultFilter = ref('')
const resultWrap = ref(false)
const sort = ref<{ index: number; dir: 'asc' | 'desc' }>({ index: -1, dir: 'asc' })

const allConns = computed(() => store.cfg?.connections || [])
const isOracle = computed(() => ['oracle', 'ob-oracle'].includes(allConns.value.find((c: any) => c.id === connId.value)?.type))

function typeLabel(type: string): string {
  if (type === 'oracle') return 'Oracle'
  if (type === 'ob-mysql') return 'OB MySQL'
  if (type === 'ob-oracle') return 'OB Oracle'
  return 'MySQL'
}

function formatCell(value: any): string {
  if (value === null || value === undefined) return '∅'
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function cellTitle(value: any): string {
  return value === null || value === undefined ? 'NULL（双击复制）' : `${formatCell(value)}\n双击复制`
}

function isNumeric(value: any): boolean {
  return (typeof value === 'number' || typeof value === 'bigint') && Number.isFinite(Number(value))
}

const displayRows = computed<any[][]>(() => {
  const rows = result.value?.rows || []
  const needle = resultFilter.value.toLowerCase()
  let output = rows
  if (needle) {
    output = rows.filter((row) => row.some((cell) => formatCell(cell).toLowerCase().includes(needle)))
  }
  if (sort.value.index >= 0) {
    const index = sort.value.index
    const direction = sort.value.dir === 'asc' ? 1 : -1
    output = [...output].sort((left, right) => {
      const a = left[index]
      const b = right[index]
      if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1
      if (b === null || b === undefined) return -1
      if (isNumeric(a) && isNumeric(b)) return (Number(a) - Number(b)) * direction
      return formatCell(a).localeCompare(formatCell(b), undefined, { numeric: true, sensitivity: 'base' }) * direction
    })
  }
  return output
})

function sortBy(index: number) {
  if (sort.value.index === index) {
    sort.value.dir = sort.value.dir === 'asc' ? 'desc' : 'asc'
  } else {
    sort.value = { index, dir: 'asc' }
  }
}

async function copyText(text: string, notice: string) {
  try {
    await navigator.clipboard.writeText(text)
    ok.value = true
    msg.value = `✓ ${notice}`
  } catch (e: any) {
    ok.value = false
    msg.value = '✗ 复制失败：' + String(e?.message || e)
  }
}

function copyCell(cell: any) {
  if (cell !== null && cell !== undefined) copyText(formatCell(cell), '已复制单元格')
}

function copyResult() {
  if (!result.value?.columns?.length) return
  const escape = (value: string) => value.replace(/\t/g, '\\t').replace(/\r?\n/g, '\\n')
  const tsv = [
    result.value.columns.map(escape).join('\t'),
    ...displayRows.value.map((row) => row.map((cell) => escape(formatCell(cell))).join('\t'))
  ].join('\n')
  copyText(tsv, `已复制 ${displayRows.value.length} 行`)
}

function clearSql() {
  cm?.setValue('')
  cm?.focus()
}

function clearResult() {
  result.value = null
  msg.value = ''
  ok.value = true
  resultFilter.value = ''
  sort.value = { index: -1, dir: 'asc' }
}

function toggleEditor() {
  editorCollapsed.value = !editorCollapsed.value
  nextTick(() => cm?.refresh())
}

function startResize(event: MouseEvent) {
  if (editorCollapsed.value || !paneHost.value || event.button !== 0) return
  event.preventDefault()
  const startY = event.clientY
  const startHeight = editorHeight.value
  const maxHeight = Math.max(120, paneHost.value.clientHeight - 170)
  const move = (e: MouseEvent) => {
    editorHeight.value = Math.min(maxHeight, Math.max(90, startHeight + e.clientY - startY))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    cm?.refresh()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

onMounted(() => {
  if (!cmHost.value) return
  cm = CodeMirror(cmHost.value, {
    value: sql.value,
    mode: 'sql',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    styleActiveLine: true,
    placeholder: '-- 输入 SQL；选中片段后 Ctrl+Enter 仅执行选中内容',
    extraKeys: {
      'Ctrl-Enter': () => runSql(),
      'Cmd-Enter': () => runSql()
    }
  })
  cm.setSize('100%', '100%')
  cm.on('change', () => { sql.value = cm!.getValue() })
  cm.focus()
})

// 面板尺寸变化时由父组件调用（tab 激活/视图切换后 CodeMirror 需重新排版）
function refresh() {
  if (cm) nextTick(() => cm!.refresh())
}
defineExpose({ refresh })

async function runSql() {
  // Navicat 习惯：有选中内容执行选中，否则执行整个编辑器
  const text = ((cm && cm.getSelection()) || (cm ? cm.getValue() : sql.value) || '')
    .trim()
    .replace(/;+\s*$/, '')
  if (!text || running.value || !connId.value) return
  await execSql(text)
}

/** 提交/回滚快捷键：Oracle 无自动提交，事务由用户显式控制 */
function runTx(stmt: 'COMMIT' | 'ROLLBACK') {
  if (running.value || !connId.value) return
  execSql(stmt)
}

async function execSql(text: string) {
  // 切换过连接：释放旧连接上本窗口的独立会话（未提交事务随断连回滚）
  if (prevConn && prevConn !== connId.value) {
    window.sqlpilot.sqlCloseSession(prevConn, props.tabKey)
  }
  prevConn = connId.value
  running.value = true
  msg.value = ''
  result.value = null
  exportOpen.value = false
  try {
    const r = await window.sqlpilot.sqlRun(connId.value, text, props.tabKey)
    if (r.ok) {
      ok.value = true
      result.value = r.result
      lastSql.value = text
      resultFilter.value = ''
      sort.value = { index: -1, dir: 'asc' }
      msg.value = r.result.message
        ? `✓ ${r.result.message} · ${r.result.ms}ms`
        : `${r.result.kind || ''} · ${r.result.rowCount} 行 · ${r.result.ms}ms`.trim()
    } else {
      ok.value = false
      msg.value = '✗ ' + r.error
    }
  } catch (e: any) {
    ok.value = false
    msg.value = '✗ ' + String(e?.message || e)
  } finally {
    running.value = false
  }
}

// ---------- 查询结果导出（列可选，CSV 全量） ----------
/** 最近一次成功执行的查询语句（导出时重新执行取全量）。切换连接后即失效：
 *  保留旧语句会在新连接上重跑，与界面显示的结果来源不一致 */
const lastSql = ref('')
watch(connId, () => {
  lastSql.value = ''
  clearResult()
})
const exportOpen = ref(false)
const exporting = ref(false)
const exportCols = ref<{ name: string; on: boolean }[]>([])

const allExportColsOn = computed(() => exportCols.value.every((c) => c.on))

function openExport() {
  if (!lastSql.value || !result.value?.columns?.length) return
  exportCols.value = result.value.columns.map((name) => ({ name, on: true }))
  exportOpen.value = true
}

function toggleAllExportCols() {
  const target = !allExportColsOn.value
  for (const c of exportCols.value) c.on = target
}

async function doExport() {
  const cols = exportCols.value.filter((c) => c.on).map((c) => c.name)
  if (!cols.length || !lastSql.value) return
  exporting.value = true
  try {
    const r = await window.sqlpilot.exportResult({ connId: connId.value, sessionKey: props.tabKey, sql: lastSql.value, columns: cols })
    if (r.ok) {
      exportOpen.value = false
      ok.value = true
      msg.value = `✓ 已导出 ${r.rows ?? 0} 行 → ${r.path}${r.truncated ? '（达到 10 万行上限，已截断）' : ''}`
      if (r.path) await window.sqlpilot.showInFolder(r.path)
    } else if (!r.canceled) {
      window.sqlpilot.uiAlert('导出失败：' + (r.error || '未知错误'))
    }
  } catch (e: any) {
    window.sqlpilot.uiAlert('导出失败：' + String(e?.message || e))
  } finally {
    exporting.value = false
  }
}

// 卸载（关 tab / 切走视图）释放本窗口的独立数据库会话（未提交事务随断连回滚）
onBeforeUnmount(() => {
  if (prevConn) window.sqlpilot.sqlCloseSession(prevConn, props.tabKey)
})
</script>

<style scoped>
.qt-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 9px 10px 10px; background: var(--bg); }
.qt-toolbar {
  display: flex; align-items: center; gap: 7px; flex-shrink: 0; flex-wrap: wrap;
  padding: 7px 8px; margin-bottom: 8px; border: 1px solid var(--border);
  border-radius: 9px; background: var(--bg-card); box-shadow: var(--shadow);
}
.qt-conn {
  max-width: 260px; min-width: 145px; height: 25px; padding: 0 7px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-input);
  color: var(--text); font: inherit; font-size: 11.5px; outline: none;
}
.qt-conn:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.qt-action-group { display: flex; align-items: center; gap: 5px; }
.qt-run {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-width: 72px; height: 25px; padding: 0 10px; border: none; border-radius: 6px;
  background: var(--accent); color: #fff; font: inherit; font-size: 11.8px; font-weight: 700;
  cursor: pointer; transition: filter .15s ease, transform .15s ease;
}
.qt-run:hover { filter: brightness(1.08); }
.qt-run:active { transform: translateY(1px); }
.qt-run:disabled { opacity: .62; cursor: default; transform: none; }
.qt-run-spinner { width: 10px; height: 10px; border-width: 2px; border-top-color: #fff; }
.qt-msg {
  min-width: 0; max-width: 46%; font-size: 11.8px; color: var(--green);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qt-msg.err { color: var(--red); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  height: 25px; border-radius: 6px; font-size: 11.5px; padding: 0 8px; cursor: pointer; font-family: inherit;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  transition: color .15s ease, border-color .15s ease, background .15s ease;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.mini-btn:disabled { opacity: .45; cursor: default; }
.mini-btn.ghost { background: transparent; }
.mini-btn.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.qt-editor-host {
  flex: 0 0 auto; min-height: 90px; border: 1px solid var(--border); border-radius: 9px;
  overflow: hidden; box-shadow: var(--shadow); transition: border-color .15s ease;
}
.qt-editor-host:focus-within { border-color: var(--accent); }
.qt-editor-host.collapsed { display: none; }
.qt-editor-host :deep(.CodeMirror) { height: 100% !important; font-family: var(--mono); font-size: 13px; line-height: 1.58; }
.qt-editor-host :deep(.CodeMirror-scroll) { min-height: 90px; }
.qt-editor-host :deep(.CodeMirror-placeholder) { color: var(--text-faint); }
.qt-splitter {
  height: 12px; flex: 0 0 12px; cursor: ns-resize; display: flex; align-items: center;
  justify-content: center; user-select: none;
}
.qt-splitter span { width: 48px; height: 3px; border-radius: 99px; background: var(--border-strong); transition: background .15s ease, width .15s ease; }
.qt-splitter:hover span, .qt-splitter:active span { width: 72px; background: var(--accent); }
.qt-result {
  flex: 1; min-height: 125px; display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: 9px; background: var(--bg-card);
  overflow: hidden; box-shadow: var(--shadow);
}
.qt-result-head {
  display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-height: 37px;
  padding: 5px 7px; border-bottom: 1px solid var(--border); background: var(--bg-input);
  flex-wrap: wrap;
}
.qt-status {
  display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 7px;
  border-radius: 99px; border: 1px solid var(--border-strong); background: var(--bg-card);
  color: var(--text-dim); font-size: 11px; font-weight: 700; flex-shrink: 0;
}
.qt-status .spinner { width: 9px; height: 9px; border-width: 2px; }
.qt-status.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.qt-status.err { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.qt-status.running { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.qt-meta { font-size: 11.3px; color: var(--text-faint); white-space: nowrap; }
.qt-filter {
  flex: 1; min-width: 130px; max-width: 330px; height: 24px; display: flex; align-items: center;
  gap: 4px; margin-left: auto; padding: 0 5px 0 7px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); color: var(--text-faint);
}
.qt-filter:focus-within { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.qt-filter span { font-size: 11px; }
.qt-filter input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 11.5px; }
.qt-filter button { border: none; background: transparent; color: var(--text-faint); cursor: pointer; padding: 0 2px; font-size: 10px; }
.qt-filter button:hover { color: var(--red); }
.qt-result-actions { display: flex; align-items: center; gap: 4px; }
.qt-result-body { flex: 1; min-height: 0; overflow: auto; padding: 0 0 4px; }
.qt-grid { min-width: 100%; }
.qt-grid th { position: sticky; top: 0; z-index: 2; white-space: nowrap; }
.qt-grid th.sortable { cursor: pointer; }
.qt-grid th.sortable:hover, .qt-grid th.sorted { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
.qt-grid .rownum { position: sticky; left: 0; z-index: 3; background: var(--bg-card); color: var(--text-faint); text-align: right; min-width: 44px; }
.qt-grid td.num { text-align: right; font-variant-numeric: tabular-nums; }
.qt-grid td.null { color: var(--text-faint); font-style: italic; }
.qt-grid td:not(.rownum):hover { background: var(--accent-dim); color: var(--text); }
.qt-grid.wrap th, .qt-grid.wrap td { white-space: pre-wrap; max-width: 620px; word-break: break-word; }
.qt-result-empty {
  flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column;
  gap: 4px; color: var(--text-faint); font-size: 12px; text-align: center; padding: 20px;
}
.qt-result-empty b { color: var(--text-dim); font-size: 13px; }
.dml-ok {
  color: var(--green); font-size: 13px; padding: 10px 4px;
  display: flex; align-items: center; gap: 6px;
}
@media (max-width: 900px) {
  .qt-msg { max-width: 100%; }
  .qt-filter { max-width: none; }
}
/* 导出面板列选择 */
.export-cols {
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  max-height: 260px; overflow: auto; display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 12px;
}
.export-col { font-size: 12px; font-family: var(--mono); color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.export-col:hover { color: var(--text); }
</style>
