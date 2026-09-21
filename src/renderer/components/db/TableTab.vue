<template>
  <div class="tt-body">
    <!-- 子标签：数据 / 结构 / DDL -->
    <div class="tt-subtabs">
      <button class="tt-sub" :class="{ active: sub === 'data' }" @click="sub = 'data'">数据</button>
      <button class="tt-sub" :class="{ active: sub === 'cols' }" @click="sub = 'cols'">结构</button>
      <button class="tt-sub" :class="{ active: sub === 'ddl' }" @click="sub = 'ddl'">DDL</button>
      <span class="tt-target">{{ schema }}.{{ table }}</span>
      <span style="flex: 1"></span>
      <template v-if="sub === 'data'">
        <input
          v-model="where"
          class="tt-where"
          placeholder="WHERE 条件（可选，如：created > SYSDATE - 1）"
          @keyup.enter="loadData(1)"
        />
        <button class="mini-btn" @click="loadData(1)">查询</button>
        <select v-model.number="pageSize" class="tt-type-sel" title="每页行数" @change="loadData(1)">
          <option :value="50">50 行</option>
          <option :value="100">100 行</option>
          <option :value="200">200 行</option>
          <option :value="500">500 行</option>
        </select>
        <button class="mini-btn" title="重新加载当前页" @click="loadData(page)">⟳</button>
        <button class="mini-btn" title="把当前页结果复制为 TSV（可粘贴到 Excel）" @click="copyTsv">复制 TSV</button>
        <span v-if="result" class="tt-meta">{{ result.total }} 行 · {{ result.ms }}ms</span>
      </template>
      <template v-else-if="sub === 'cols'">
        <button class="mini-btn" title="绕过缓存重读表结构" @click="refreshCols">⟳ 刷新结构</button>
      </template>
    </div>

    <!-- 网格编辑状态条（数据页） -->
    <div class="edit-bar" v-if="sub === 'data' && (editCount > 0 || editState === 'uncommitted')">
      <template v-if="editCount > 0">
        <span class="eb-count">✏ {{ editCount }} 处未保存修改</span>
        <button class="mini-btn" :disabled="editState === 'saving'" @click="saveGridEdits">
          {{ editState === 'saving' ? '保存中…' : '💾 保存修改' }}
        </button>
        <button class="mini-btn" :disabled="editState === 'saving'" @click="discardEdits">放弃修改</button>
        <span v-if="isOracle" class="eb-hint">Oracle：保存后需再 ✓ 提交才生效</span>
      </template>
      <template v-if="editState === 'uncommitted'">
        <span class="eb-uncommitted">● 已应用修改，事务未提交（关标签页将回滚）</span>
        <button class="mini-btn" @click="runGridTx('COMMIT')">✓ 提交</button>
        <button class="mini-btn" @click="runGridTx('ROLLBACK')">↩ 回滚</button>
      </template>
      <span v-if="editMsg" class="eb-msg">{{ editMsg }}</span>
    </div>
    <div class="edit-bar dim" v-else-if="sub === 'data' && editKnown && edit && !edit.editable && result">
      <span title="编辑需要能唯一定位行">🔒 {{ edit.reason || '该结果集不可编辑' }}</span>
    </div>

    <!-- 数据页 -->
    <div class="tt-grid" v-if="sub === 'data'">
      <table class="result-table" v-if="result?.columns?.length">
        <thead>
          <tr>
            <th class="rownum">#</th>
            <th
              v-for="col in result.columns"
              :key="col"
              class="sortable"
              :title="`点击按 ${col} 排序`"
              @click="sortBy(col)"
            >{{ col }}<span class="sort-mark" v-if="orderBy === col">{{ orderDir === 'desc' ? ' ▼' : ' ▲' }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in result.rows" :key="i">
            <td class="rownum">{{ (page - 1) * pageSize + i + 1 }}</td>
            <td
              v-for="(cell, j) in row"
              :key="j"
              :class="{ dirty: !!edits[`${i}:${j}`], celledit: cellEditable(j) }"
              :title="cellTitle(i, j, cell)"
              @dblclick="startEdit(i, j)"
            >
              <div v-if="editing && editing.rowIdx === i && editing.colIdx === j" class="cell-editor">
                <input
                  :ref="focusEditInput"
                  v-model="editing.value"
                  :disabled="editing.isNull"
                  :placeholder="editing.isNull ? 'NULL' : ''"
                  @keyup.enter="confirmEdit"
                  @keyup.esc="cancelEdit"
                  @blur="confirmEdit"
                />
                <button class="ce-btn" title="设为 NULL（Oracle 下空串即 NULL）" @mousedown.prevent @click="setEditNull">{{ editing.isNull ? '∅✓' : '∅' }}</button>
                <button class="ce-btn ok" title="确认（Enter）" @mousedown.prevent @click="confirmEdit">✓</button>
                <button class="ce-btn" title="取消（Esc）" @mousedown.prevent @click="cancelEdit">✕</button>
              </div>
              <template v-else>{{ stagedOrFmt(i, j, cell) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="loading" class="tt-empty"><span class="spinner"></span> 查询中…</div>
      <div v-else-if="error" class="tt-empty err">✗ {{ error }}</div>
      <div v-else class="tt-empty">（0 行）</div>
    </div>
    <div class="tt-pager" v-if="sub === 'data' && result">
      <button class="mini-btn" :disabled="page <= 1" @click="loadData(page - 1)">‹ 上一页</button>
      <span>第 {{ page }} / {{ totalPages }} 页</span>
      <button class="mini-btn" :disabled="page >= totalPages" @click="loadData(page + 1)">下一页 ›</button>
    </div>

    <!-- 结构页 -->
    <div class="tt-grid" v-if="sub === 'cols'">
      <div v-if="colsLoading" class="tt-empty"><span class="spinner"></span> 加载中…</div>
      <div v-else-if="colsError" class="tt-empty err">✗ {{ colsError }}</div>
      <table class="result-table" v-else-if="cols">
        <thead><tr><th>#</th><th>列名</th><th>类型</th><th>可空</th></tr></thead>
        <tbody>
          <tr v-for="(c2, i) in cols.columns" :key="c2.name">
            <td class="rownum">{{ i + 1 }}</td>
            <td>{{ c2.name }}</td>
            <td>{{ c2.type }}</td>
            <td>{{ c2.nullable === 'Y' || c2.nullable === 'YES' ? '✓' : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="tt-meta" style="padding: 6px 10px" v-if="cols?.approxRows != null">
        近似行数：{{ Number(cols.approxRows).toLocaleString() }}（来自统计信息）
      </div>
    </div>

    <!-- DDL 页 -->
    <div class="tt-grid" v-if="sub === 'ddl'">
      <div v-if="ddlLoading" class="tt-empty"><span class="spinner"></span> 加载中…</div>
      <div v-else-if="ddlError" class="tt-empty err">✗ {{ ddlError }}</div>
      <div v-else class="tt-ddl">
        <button class="mini-btn" @click="copyText(ddl)">复制</button>
        <pre>{{ ddl }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { store } from '../../store'

const props = defineProps<{
  /** tab 唯一键 = 网格编辑的独立数据库会话 sessionKey */
  tabKey: string
  connId: string
  schema: string
  table: string
}>()

const sub = ref<'data' | 'cols' | 'ddl'>('data')
const page = ref(1)
const pageSize = ref(50)
const where = ref('')
const orderBy = ref('')
const orderDir = ref<'asc' | 'desc'>('asc')
const loading = ref(false)
const result = ref<{ columns: string[]; rows: any[][]; total: number; ms: number; rids?: string[] } | null>(null)
const error = ref('')
/** 请求序号：防止乱序响应覆盖最新状态（快速翻页/排序时） */
const seq = ref(0)
const cols = ref<{ columns: { name: string; type: string; nullable: string }[]; approxRows?: number } | null>(null)
const colsLoading = ref(false)
const colsError = ref('')
const ddl = ref('')
const ddlLoading = ref(false)
const ddlError = ref('')

/** 网格编辑：可编辑性信息（editKnown 标记是否已查询过，失败静默降级只读） */
const edit = ref<{ editable: boolean; reason?: string; keyMode: 'rowid' | 'cols'; keyCols: string[]; readonlyCols: string[] } | undefined>(undefined)
const editKnown = ref(false)
/** 暂存修改：`${rowIdx}:${colIdx}` → 修改内容（rowIdx 相对当前页） */
const edits = reactive<Record<string, { rowIdx: number; colIdx: number; col: string; value: string | null }>>({})
const editState = ref<'' | 'saving' | 'uncommitted'>('')
const editMsg = ref('')
/** 是否已建立独立编辑会话（卸载时需释放，Oracle 未提交事务随断连回滚） */
const hasEditSession = ref(false)

const isOracle = computed(() => (store.cfg?.connections || []).find((c: any) => c.id === props.connId)?.type === 'oracle')

// ---------- 数据加载 ----------
async function loadData(p: number) {
  // 有暂存修改时翻页/过滤/排序/刷新都先确认；确认放弃后必须清空——
  // 暂存以行下标为键，新页同下标已是不同的行，保留会把修改（和保存时的 UPDATE）落到错误的行上
  const pending = Object.keys(edits).length
  if (pending && !window.confirm(`当前页有 ${pending} 处未保存的修改，放弃并继续？`)) return
  if (pending) discardEdits()
  editing.value = null
  page.value = p
  const mySeq = ++seq.value
  loading.value = true
  error.value = ''
  try {
    const r = await window.sqlpilot.objData({
      connId: props.connId, schema: props.schema, table: props.table,
      page: page.value, pageSize: pageSize.value,
      where: where.value, orderBy: orderBy.value || undefined, orderDir: orderDir.value
    })
    if (mySeq !== seq.value) return // 已有更新的请求在途，丢弃本次响应
    if (r.ok) {
      result.value = { columns: r.columns || [], rows: r.rows || [], total: r.total || 0, ms: r.ms || 0, rids: r.rids }
    } else {
      result.value = null
      error.value = r.error || '查询失败'
    }
  } catch (e: any) {
    if (mySeq !== seq.value) return
    result.value = null
    error.value = String(e?.message || e)
  } finally {
    if (mySeq === seq.value) loading.value = false
  }
}

function sortBy(col: string) {
  if (orderBy.value !== col) {
    orderBy.value = col
    orderDir.value = 'asc'
  } else {
    orderDir.value = orderDir.value === 'asc' ? 'desc' : 'asc'
  }
  loadData(1)
}

const totalPages = computed(() => Math.max(1, Math.ceil((result.value?.total || 0) / pageSize.value)))

// 子标签懒加载：结构 / DDL 首次切入时取数
watch(sub, async (s) => {
  if (s === 'cols' && !cols.value && !colsLoading.value) {
    colsLoading.value = true
    const r = await window.sqlpilot.objDescribe(props.connId, props.schema, props.table)
    if (r.ok) cols.value = r.info || null
    else colsError.value = r.error || '获取结构失败'
    colsLoading.value = false
  } else if (s === 'ddl' && !ddl.value && !ddlLoading.value) {
    ddlLoading.value = true
    const r = await window.sqlpilot.objDdl(props.connId, props.schema, props.table)
    if (r.ok) ddl.value = r.ddl || ''
    else ddlError.value = r.error || '获取 DDL 失败'
    ddlLoading.value = false
  }
}, { immediate: true })

async function refreshCols() {
  cols.value = null
  colsError.value = ''
  colsLoading.value = true
  const r = await window.sqlpilot.objDescribe(props.connId, props.schema, props.table, true)
  if (r.ok) cols.value = r.info || null
  else colsError.value = r.error || '获取结构失败'
  colsLoading.value = false
}

onMounted(() => {
  loadData(1)
  // 并行取可编辑性信息（进主进程元数据缓存）；失败静默降级为只读
  window.sqlpilot.objEditInfo(props.connId, props.schema, props.table).then((r) => {
    if (r.ok) {
      edit.value = { editable: !!r.editable, reason: r.reason, keyMode: r.keyMode || 'cols', keyCols: r.keyCols || [], readonlyCols: r.readonlyCols || [] }
    }
    editKnown.value = true
  }).catch(() => { editKnown.value = true })
})

// ---------- 结果网格编辑（双击单元格 → 暂存 → 保存；Oracle 保存后显式提交/回滚） ----------
interface EditState {
  rowIdx: number
  colIdx: number
  value: string
  isNull: boolean
}
const editing = ref<EditState | null>(null)

function focusEditInput(el: any) {
  if (el && el.focus) el.focus()
}

const editCount = computed(() => Object.keys(edits).length)

/** 该单元格是否可编辑：表可编辑 + 非只读列 + 行标识可用 */
function cellEditable(j: number): boolean {
  if (!edit.value?.editable || !result.value) return false
  const col = String(result.value.columns[j] ?? '')
  if (!col) return false
  if ((edit.value.readonlyCols || []).some((c) => c.toLowerCase() === col.toLowerCase())) return false
  // rowid 模式但本页没取到行标识（视图降级路径）→ 不可编辑
  if (edit.value.keyMode === 'rowid') return !!result.value.rids?.length
  return true
}

function cellTitle(i: number, j: number, cell: any): string {
  const staged = edits[`${i}:${j}`]
  const base = staged ? `${staged.value === null ? '已暂存：NULL' : `已暂存：${staged.value}`}\n原值：${full(cell)}` : full(cell)
  return cellEditable(j) ? `${base}\n（双击编辑）` : base
}

function stagedOrFmt(i: number, j: number, cell: any): string {
  const staged = edits[`${i}:${j}`]
  if (!staged) return fmt(cell)
  return staged.value === null ? '∅' : staged.value
}

function startEdit(i: number, j: number) {
  if (!cellEditable(j)) return
  const orig = result.value?.rows[i]?.[j]
  editing.value = {
    rowIdx: i,
    colIdx: j,
    value: orig === null || orig === undefined ? '' : orig instanceof Date ? fmt(orig) : String(orig),
    isNull: false
  }
}

function cancelEdit() {
  editing.value = null
}

function setEditNull() {
  if (editing.value) editing.value.isNull = !editing.value.isNull
}

/** 确认暂存：与原值相同则不暂存（并清掉该格已有暂存）。blur/Enter/✓ 都走这里，需幂等 */
function confirmEdit() {
  const ed = editing.value
  if (!ed) return
  editing.value = null
  if (!result.value) return
  const orig = result.value.rows[ed.rowIdx]?.[ed.colIdx]
  const origStr = orig === null || orig === undefined ? null : orig instanceof Date ? fmt(orig) : String(orig)
  const newVal = ed.isNull ? null : ed.value
  const key = `${ed.rowIdx}:${ed.colIdx}`
  if (newVal === origStr) {
    delete edits[key]
    return
  }
  edits[key] = { rowIdx: ed.rowIdx, colIdx: ed.colIdx, col: String(result.value.columns[ed.colIdx] ?? ''), value: newVal }
}

function discardEdits() {
  for (const k of Object.keys(edits)) delete edits[k]
  editMsg.value = ''
}

/** 行键值（MySQL/OB 主键模式）：按列名（忽略大小写）从当前行取 */
function keyValues(rowIdx: number): any[] {
  const colsList = result.value?.columns || []
  const row = result.value?.rows[rowIdx] || []
  return (edit.value?.keyCols || []).map((k) => {
    const j = colsList.findIndex((c) => String(c).toLowerCase() === k.toLowerCase())
    const v = j >= 0 ? row[j] : undefined
    if (v === undefined) throw new Error(`键列 ${k} 的值缺失，请刷新数据后重试`)
    return v
  })
}

async function saveGridEdits() {
  const list = Object.entries(edits).map(([key, e]) => ({ key, ...e }))
  if (!list.length || !edit.value || !result.value) return
  if (edit.value.keyMode === 'rowid' && !result.value.rids?.length) {
    alert('本页数据没有行标识（可能是视图），不可保存，请改用查询窗口修改')
    return
  }
  editState.value = 'saving'
  editMsg.value = ''
  try {
    const payload = list.map((e) => ({
      rid: edit.value!.keyMode === 'rowid' ? result.value!.rids?.[e.rowIdx] : undefined,
      keys: edit.value!.keyMode === 'cols' ? keyValues(e.rowIdx) : undefined,
      col: e.col,
      value: e.value
    }))
    const r = await window.sqlpilot.objSaveEdits({
      connId: props.connId, sessionKey: props.tabKey, schema: props.schema, table: props.table,
      keyMode: edit.value.keyMode, keyCols: edit.value.keyCols, edits: payload
    })
    hasEditSession.value = true
    if (r.ok) {
      discardEdits()
      if (r.uncommitted) {
        // Oracle：UPDATE 已执行未提交，工具栏 ✓/↩ 决定最终结果
        editState.value = 'uncommitted'
        editMsg.value = `已应用 ${r.applied ?? 0} 处修改（未提交）`
        if (r.conflicts?.length) {
          alert(`${r.conflicts.length} 处修改未生效（目标行已被他人修改或删除），其余已应用未提交，可 ↩ 回滚后重试`)
        }
      } else {
        // MySQL：整批一个事务，有冲突已全部回滚；无冲突已提交
        editState.value = ''
        if (r.conflicts?.length) {
          alert(`${r.conflicts.length} 处修改未生效（目标行已被他人修改或删除），本批已整体回滚`)
        } else {
          loadData(page.value) // 已提交：刷新显示库端规范值
        }
      }
    } else {
      editState.value = ''
      alert('保存失败：' + (r.error || '未知错误'))
    }
  } catch (e: any) {
    editState.value = ''
    alert('保存失败：' + String(e?.message || e))
  }
}

/** Oracle 网格编辑事务的提交/回滚：复用 SQL 控制台通道（同一 sessionKey = 同一数据库会话） */
async function runGridTx(stmt: 'COMMIT' | 'ROLLBACK') {
  if (!hasEditSession.value) return
  const r = await window.sqlpilot.sqlRun(props.connId, stmt, props.tabKey)
  if (r.ok) {
    editState.value = ''
    discardEdits()
    editMsg.value = stmt === 'COMMIT' ? '已提交' : '已回滚'
    loadData(page.value)
  } else {
    alert((stmt === 'COMMIT' ? '提交' : '回滚') + '失败：' + (r.error || '未知错误'))
  }
}

// 卸载（关 tab / 切走视图）释放编辑会话：Oracle 未提交事务随断连由数据库回滚
onBeforeUnmount(() => {
  if (hasEditSession.value) window.sqlpilot.sqlCloseSession(props.connId, props.tabKey)
})

// ---------- 单元格格式化 ----------
function fmt(v: any): string {
  if (v === null || v === undefined) return '∅'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function full(v: any): string {
  if (v === null || v === undefined) return 'NULL'
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 23)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function copyText(text: string) {
  window.sqlpilot.writeClipboard(text)
}

function copyTsv() {
  if (!result.value) return
  const lines = [result.value.columns.join('\t')]
  for (const row of result.value.rows) lines.push(row.map((c) => (c === null || c === undefined ? '' : c instanceof Date ? c.toISOString() : typeof c === 'object' ? JSON.stringify(c) : String(c))).join('\t'))
  copyText(lines.join('\n'))
}
</script>

<style scoped>
.tt-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tt-subtabs {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap;
}
.tt-sub {
  border: none; background: transparent; color: var(--text-dim); font-size: 12.5px;
  padding: 4px 12px; border-radius: 7px; cursor: pointer; font-family: inherit;
}
.tt-sub:hover { color: var(--text); background: var(--bg-card-hover); }
.tt-sub.active { color: var(--accent); background: var(--accent-dim); font-weight: 600; }
.tt-target { font-family: var(--mono); font-size: 11.5px; color: var(--text-faint); margin-left: 8px; }
.tt-where { width: 300px; max-width: 40vw; font-size: 12px; font-family: var(--mono); }
.tt-type-sel { font-size: 12px; padding: 2px 6px; background: var(--bg-input); color: var(--text-dim); border-radius: 7px; }
.tt-meta { font-size: 11.5px; color: var(--text-faint); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 1px 7px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }
.mini-btn:disabled { opacity: .45; cursor: default; }

.tt-grid { flex: 1; min-height: 0; overflow: auto; padding: 6px 10px; position: relative; }
.tt-grid .result-table { min-width: 100%; }
.rownum { color: var(--text-faint); background: var(--bg-card); position: sticky; left: 0; }
th.sortable { cursor: pointer; }
th.sortable:hover { color: var(--accent); }
.sort-mark { color: var(--accent); }
.tt-pager {
  display: flex; align-items: center; gap: 12px; padding: 5px 12px;
  border-top: 1px solid var(--border); font-size: 12px; color: var(--text-dim); flex-shrink: 0;
}
.tt-empty { padding: 40px 20px; text-align: center; color: var(--text-faint); font-size: 13px; line-height: 2; }
.tt-empty.err { color: var(--red); white-space: pre-wrap; word-break: break-all; }
.tt-ddl { position: relative; height: 100%; }
.tt-ddl .mini-btn { position: absolute; top: 6px; right: 14px; z-index: 2; }
.tt-ddl pre { margin: 0; font-size: 12.5px; }

/* 网格编辑 */
.edit-bar {
  display: flex; align-items: center; gap: 8px; padding: 4px 12px; flex-shrink: 0; flex-wrap: wrap;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  font-size: 12px; color: var(--text-dim);
}
.edit-bar.dim { color: var(--text-faint); }
.eb-count { color: var(--yellow, #d9b84a); font-weight: 600; }
.eb-uncommitted { color: var(--accent); font-weight: 600; }
.eb-hint, .eb-msg { font-size: 11px; color: var(--text-faint); }
td.dirty { background: var(--accent-dim); color: var(--accent); }
td.celledit { cursor: text; }
.cell-editor { display: flex; align-items: center; gap: 2px; }
.cell-editor input { width: 110px; font-size: 12px; font-family: var(--mono); padding: 1px 4px; }
.ce-btn { border: none; background: transparent; color: var(--text-dim); cursor: pointer; font-size: 11px; padding: 0 3px; }
.ce-btn:hover { color: var(--accent); }
.ce-btn.ok { color: var(--green, #4caf7d); }
</style>
