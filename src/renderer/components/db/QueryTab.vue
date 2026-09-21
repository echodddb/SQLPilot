<template>
  <div class="qt-pane">
    <div class="qt-toolbar">
      <select v-model="connId" class="mini-btn" style="padding: 2px 6px" title="本窗口使用的连接">
        <option v-for="c in allConns" :key="c.id" :value="c.id">{{ c.name }}</option>
      </select>
      <button class="mini-btn" :disabled="running" @click="runSql">{{ running ? '执行中…' : '▶ 执行 (Ctrl+Enter)' }}</button>
      <template v-if="isOracle">
        <button class="mini-btn" title="提交当前事务（Oracle 无自动提交，DML 需显式 COMMIT 生效）" :disabled="running" @click="runTx('COMMIT')">✓ 提交</button>
        <button class="mini-btn" title="回滚当前事务" :disabled="running" @click="runTx('ROLLBACK')">↩ 回滚</button>
      </template>
      <button class="mini-btn" title="查看该连接的数据库信息" @click="emit('open-info', connId)">📊 信息</button>
      <button class="mini-btn" title="导出查询结果为 CSV（可选择列；重新执行查询取全量，上限 10 万行）" :disabled="!lastSql || !result?.columns?.length" @click="openExport">⬇ 导出</button>
      <span v-if="msg" class="qt-msg" :class="{ err: !ok }">{{ msg }}</span>
      <span style="flex: 1"></span>
      <span class="qt-hint">选中语句可单独执行</span>
    </div>
    <div class="qt-editor-host" ref="cmHost"></div>
    <div class="qt-result" v-if="result">
      <table class="result-table" v-if="result.columns?.length">
        <thead><tr><th v-for="c in result.columns" :key="c">{{ c }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in result.rows" :key="i">
            <td v-for="(cell, j) in row" :key="j" :title="String(cell)">{{ cell === null ? '∅' : String(cell) }}</td>
          </tr>
        </tbody>
      </table>
      <!-- 写语句没有结果网格：显示明确的成功消息（Navicat 的 "N row(s) affected"） -->
      <div v-else-if="result.message" class="dml-ok">✓ {{ result.message }} · {{ result.ms }}ms</div>
      <div v-if="result.truncated" style="font-size: 11px; color: var(--text-faint); padding: 4px 0">（结果超过 200 行，已截断显示）</div>
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
let cm: CodeMirror.Editor | null = null

const allConns = computed(() => store.cfg?.connections || [])
const isOracle = computed(() => allConns.value.find((c: any) => c.id === connId.value)?.type === 'oracle')

onMounted(() => {
  if (!cmHost.value) return
  cm = CodeMirror(cmHost.value, {
    value: sql.value,
    mode: 'sql',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    extraKeys: {
      'Ctrl-Enter': () => runSql(),
      'Cmd-Enter': () => runSql()
    }
  })
  cm.setSize('100%', '100%')
  cm.on('change', () => { sql.value = cm!.getValue() })
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
      alert('导出失败：' + (r.error || '未知错误'))
    }
  } catch (e: any) {
    alert('导出失败：' + String(e?.message || e))
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
.qt-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; }
.qt-toolbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
.qt-msg { font-size: 12px; color: var(--green); word-break: break-all; }
.qt-msg.err { color: var(--red); }
.qt-hint { font-size: 11px; color: var(--text-faint); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.mini-btn:disabled { opacity: .45; cursor: default; }
.qt-editor-host { flex: 1.2; min-height: 80px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.qt-editor-host :deep(.CodeMirror) { height: 100% !important; font-family: var(--mono); font-size: 13px; }
.qt-editor-host :deep(.CodeMirror-scroll) { min-height: 60px; }
.qt-result { flex: 1; min-height: 0; overflow: auto; border-top: 1px solid var(--border); padding-top: 6px; }
.dml-ok {
  color: var(--green); font-size: 13px; padding: 10px 4px;
  display: flex; align-items: center; gap: 6px;
}
/* 导出面板列选择 */
.export-cols {
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
  max-height: 260px; overflow: auto; display: flex; flex-wrap: wrap; gap: 4px 14px; margin-bottom: 12px;
}
.export-col { font-size: 12px; font-family: var(--mono); color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.export-col:hover { color: var(--text); }
</style>
