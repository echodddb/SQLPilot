<template>
  <div class="at">
    <div class="at-bar">
      <span class="at-meta">
        {{ shown }} / {{ totalText }} 行 · {{ data.columns.length }} 列
        <span v-if="loading" class="at-dim">· 载入全量…</span>
        <span v-else-if="fullRows" class="at-full">· 全量</span>
        <span v-else-if="loadError" class="at-warn" :title="loadError">· 仅预览</span>
        <span v-else-if="data.truncated" class="at-warn" title="结果被查询或落盘上限截断">· 已截断</span>
      </span>
      <span style="flex: 1"></span>
      <button class="at-btn" title="复制为 TSV（可直接粘进 Excel）" @click="copyTsv">复制</button>
      <button class="at-btn" :disabled="!!exporting" title="导出当前已加载的全部行为 CSV" @click="exportCsv">{{ exporting ? '导出中…' : '导出 CSV' }}</button>
    </div>

    <div v-if="data.note" class="at-note">{{ data.note }}</div>

    <div class="at-scroll" ref="scrollEl">
      <table>
        <thead>
          <tr>
            <th class="rn">#</th>
            <th v-for="(c, i) in data.columns" :key="i" :title="c">{{ c }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, ri) in visibleRows" :key="ri">
            <td class="rn">{{ ri + 1 }}</td>
            <td v-for="(v, ci) in r" :key="ci" :class="{ null: v === null }" :title="cellText(v)">{{ cellText(v) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length" class="at-empty">（没有数据行）</div>
      <div v-if="visibleRows.length < rows.length" class="at-more">
        <button class="at-btn" @click="limit += 500">再显示 500 行（还有 {{ rows.length - visibleRows.length }} 行）</button>
      </div>
    </div>

    <details v-if="data.sql" class="at-sql">
      <summary>查看 SQL</summary>
      <pre>{{ data.sql }}</pre>
      <button class="at-btn" @click="copySql">复制 SQL</button>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ArtifactTableData } from '../../artifacts'

const props = defineProps<{ data: ArtifactTableData; name?: string }>()

const rows = ref<any[][]>(props.data.rows || [])
const limit = ref(200)
const loading = ref(false)
const loadError = ref('')
const fullRows = ref(false)
const exporting = ref(false)

const totalText = computed(() => {
  const n = props.data.rowCount
  return n != null ? n.toLocaleString('zh-CN') : String(rows.value.length)
})
const shown = computed(() => rows.value.length.toLocaleString('zh-CN'))
const visibleRows = computed(() => rows.value.slice(0, limit.value))

function cellText(v: any): string {
  if (v === null || v === undefined) return '∅'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 300 ? s.slice(0, 300) + '…' : s
}

/** 全量行：工具返回值里只有前 30 行，完整结果按 artifactId 从主进程取 */
async function loadFull(): Promise<void> {
  const id = props.data.artifactId
  if (!id) return
  loading.value = true
  loadError.value = ''
  try {
    const r = await window.sqlpilot.getArtifact(id)
    if (r.ok && r.data) {
      rows.value = (r.data.rows || []) as any[][]
      fullRows.value = true
    } else {
      loadError.value = r.error || '读取失败'
    }
  } catch (e: any) {
    loadError.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

onMounted(loadFull)
watch(
  () => props.data,
  () => {
    rows.value = props.data.rows || []
    limit.value = 200
    fullRows.value = false
    loadError.value = ''
    void loadFull()
  }
)

function tsv(): string {
  const head = props.data.columns.join('\t')
  const body = rows.value.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))).join('\t'))
  return [head, ...body].join('\n')
}

async function copyTsv(): Promise<void> {
  await window.sqlpilot.writeClipboard(tsv())
}

async function copySql(): Promise<void> {
  await window.sqlpilot.writeClipboard(String(props.data.sql || ''))
}

async function exportCsv(): Promise<void> {
  if (exporting.value) return
  exporting.value = true
  try {
    const r = await window.sqlpilot.exportArtifactCsv({ columns: props.data.columns, rows: rows.value, name: props.name || '查询结果' })
    if (r.ok) await window.sqlpilot.showInFolder(String(r.path))
    else if (!r.canceled) await window.sqlpilot.uiAlert('导出失败：' + (r.error || ''))
  } finally {
    exporting.value = false
  }
}
</script>

<style scoped>
.at { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.at-bar {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  border-bottom: 1px solid var(--border); font-size: 11.5px; color: var(--text-dim);
  flex-shrink: 0;
}
.at-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.at-dim { color: var(--text-faint); }
.at-full { color: var(--green); }
.at-warn { color: var(--yellow); cursor: help; }
.at-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11.5px; padding: 2px 9px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
.at-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.at-btn:disabled { opacity: 0.6; cursor: default; }
.at-note { padding: 5px 10px; font-size: 11.5px; color: var(--text-faint); border-bottom: 1px dashed var(--border); }
.at-scroll { flex: 1; min-height: 0; overflow: auto; }
.at-scroll table { border-collapse: collapse; width: 100%; font-size: 12px; }
.at-scroll th, .at-scroll td {
  border-bottom: 1px solid var(--border); border-right: 1px solid var(--border);
  padding: 4px 8px; text-align: left; white-space: nowrap;
  max-width: 340px; overflow: hidden; text-overflow: ellipsis;
}
.at-scroll th {
  position: sticky; top: 0; z-index: 1; background: var(--bg-side);
  color: var(--text-dim); font-weight: 600; font-size: 11.5px;
}
.at-scroll td { color: var(--text); font-family: var(--mono); font-size: 11.5px; }
.at-scroll td.null { color: var(--text-faint); }
.at-scroll .rn { width: 42px; color: var(--text-faint); text-align: right; font-family: var(--mono); }
.at-scroll tbody tr:hover td { background: var(--bg-card-hover); }
.at-empty { padding: 16px; color: var(--text-faint); font-size: 12px; text-align: center; }
.at-more { padding: 8px; text-align: center; }
.at-sql { border-top: 1px solid var(--border); padding: 6px 10px; flex-shrink: 0; }
.at-sql summary { cursor: pointer; font-size: 11.5px; color: var(--text-dim); }
.at-sql summary:hover { color: var(--accent); }
.at-sql pre {
  margin: 6px 0; padding: 8px; max-height: 160px; overflow: auto;
  background: var(--bg-code); border: 1px solid var(--border); border-radius: 7px;
  font-size: 11.5px; white-space: pre-wrap; word-break: break-all;
}
</style>
