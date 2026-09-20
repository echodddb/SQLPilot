<template>
  <div class="tool-card" :class="tool.status">
    <div class="tool-head" @click="expanded = !expanded">
      <span class="arrow">{{ expanded ? '▾' : '▸' }}</span>
      <span class="tool-icon">{{ ICONS[tool.name] || '🔧' }}</span>
      <span class="badge" :class="tool.name === 'db_write' ? 'red' : 'blue'">{{ tool.name }}</span>
      <span class="tool-sql">{{ summary }}</span>
      <span v-if="tool.status === 'running'" class="spinner"></span>
      <span v-else-if="tool.status === 'ok'" style="color: var(--green); font-size:12px">✓ {{ resultMeta }}</span>
      <span v-else style="color: var(--red); font-size:12px">✗ 失败</span>
    </div>
    <div class="tool-body" v-if="expanded">
      <div style="font-size:11.5px; color:var(--text-dim); margin-bottom:6px">参数</div>
      <pre>{{ prettyArgs }}</pre>
      <template v-if="tool.result">
        <div style="font-size:11.5px; color:var(--text-dim); margin:8px 0 6px">结果</div>
        <div v-if="resultTable" style="max-height:300px; overflow:auto">
          <table class="result-table">
            <thead><tr><th v-for="c in resultTable.columns" :key="c">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, i) in resultTable.rows" :key="i">
                <td v-for="(cell, j) in row" :key="j" :title="String(cell)">{{ cell === null ? '∅' : String(cell) }}</td>
              </tr>
            </tbody>
          </table>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px" v-if="resultTable.note">{{ resultTable.note }}</div>
        </div>
        <pre v-else>{{ tool.result }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{ tool: any }>()
const expanded = ref(false)

const ICONS: Record<string, string> = {
  db_list_schemas: '📂',
  db_list_tables: '🗂',
  db_describe_table: '🧬',
  db_get_ddl: '📄',
  db_query: '🔍',
  db_write: '✏️'
}

// 必须是 computed：结果在 tool-end 才到达，setup 时一次性解析会永远停留在空值
const parsed = computed<any>(() => {
  try { return JSON.parse(props.tool.result || 'null') } catch { return null }
})

const summary = computed(() => {
  let a: any = {}
  try { a = JSON.parse(props.tool.args || '{}') } catch { /* ignore */ }
  if (a.sql) return String(a.sql).replace(/\s+/g, ' ').slice(0, 160)
  if (a.schema && a.table) return `${a.schema}.${a.table}`
  if (a.schema) return `schema: ${a.schema}`
  return props.tool.name
})

const prettyArgs = computed(() => {
  try { return JSON.stringify(JSON.parse(props.tool.args || '{}'), null, 2) } catch { return props.tool.args }
})

const resultTable = computed(() => {
  if (parsed.value && Array.isArray(parsed.value.columns) && Array.isArray(parsed.value.rows)) {
    return {
      columns: parsed.value.columns,
      rows: parsed.value.rows.slice(0, 12),
      note: parsed.value.rowCount != null ? `共 ${parsed.value.rowCount} 行，耗时 ${parsed.value.ms}ms${parsed.value.truncated ? '（已截断）' : ''}` : ''
    }
  }
  return null
})

const resultMeta = computed(() => {
  if (parsed.value?.rowCount != null) return `${parsed.value.rowCount} 行 · ${parsed.value.ms}ms`
  if (parsed.value?.affected != null) return `影响 ${parsed.value.affected} 行 · ${parsed.value.ms}ms`
  if (parsed.value?.total != null) return `${parsed.value.total} 项`
  if (parsed.value?.schemas) return `${parsed.value.schemas.length} schema`
  return ''
})
</script>
