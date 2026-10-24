<template>
  <div class="ot" :style="height ? { maxHeight: height } : undefined">
    <div v-if="searchable" class="ot-bar">
      <input v-model="kw" class="ot-search" type="text" :placeholder="searchPlaceholder" spellcheck="false" />
      <span class="ot-cnt">{{ filtered.length }} / {{ rows.length }}</span>
      <span class="sp"></span>
      <slot name="tools"></slot>
    </div>
    <div class="ot-wrap">
      <table class="ot-tbl">
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.key"
              :style="{ width: c.width, textAlign: c.align || 'left' }"
              :title="c.hint || ''"
              :class="{ sortable: c.sort !== false, on: sortKey === c.key }"
              @click="toggleSort(c)"
            >
              {{ c.label }}
              <i v-if="sortKey === c.key" class="ot-arrow">{{ sortDir > 0 ? '▲' : '▼' }}</i>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!filtered.length">
            <td :colspan="columns.length" class="ot-empty">{{ empty || '没有数据' }}</td>
          </tr>
          <tr
            v-for="(r, i) in paged"
            :key="rowKey ? r[rowKey] : i"
            :class="{ clickable: !!$attrs.onRow }"
            @click="$emit('row', r)"
          >
            <td v-for="c in columns" :key="c.key" :style="{ textAlign: c.align || 'left' }" :class="cellClass(c, r)">
              <span v-if="c.type === 'state'" class="ot-badge" :class="tone(r[c.key])">{{ r[c.key] || '—' }}</span>
              <span v-else-if="c.type === 'bar'" class="ot-bar-cell">
                <template v-if="r[c.key] !== null && r[c.key] !== undefined && r[c.key] !== '' && Number.isFinite(Number(r[c.key]))">
                  <i class="ot-bar-track"><b :style="{ width: Math.max(0, Math.min(100, Number(r[c.key]) || 0)) + '%' }" :class="pctTone(r[c.key])"></b></i>
                  <em>{{ fmtPct(r[c.key]) }}</em>
                </template>
                <em v-else class="ot-na">—</em>
              </span>
              <span v-else class="ot-val" :title="String(r[c.key] ?? '')">{{ fmt(c, r[c.key]) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="total > pageSize" class="ot-foot">
      <button class="ot-pg" :disabled="page <= 1" @click="page--">上一页</button>
      <span>{{ page }} / {{ pages }}</span>
      <button class="ot-pg" :disabled="page >= pages" @click="page++">下一页</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** Oracle 看板的通用表格：列定义 + 类型化渲染 + 排序 + 过滤 + 分页（大结果集不全塞 DOM） */
import { computed, ref, watch } from 'vue'
import type { OraCol } from './table'

const props = withDefaults(
  defineProps<{
    columns: OraCol[]
    rows: any[]
    rowKey?: string
    empty?: string
    height?: string
    searchable?: boolean
    searchPlaceholder?: string
    /** 默认排序字段与方向 */
    defaultSort?: string
    defaultDir?: 1 | -1
    pageSize?: number
  }>(),
  {
    rowKey: '',
    empty: '没有数据',
    height: '',
    searchable: false,
    searchPlaceholder: '过滤…',
    defaultSort: '',
    defaultDir: -1,
    pageSize: 100
  }
)

defineEmits<{ row: [row: any] }>()

const kw = ref('')
const sortKey = ref(props.defaultSort)
const sortDir = ref<1 | -1>(props.defaultDir)
const page = ref(1)

watch(kw, () => { page.value = 1 })
watch(() => props.rows, () => { page.value = 1 })

const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase()
  if (!k) return props.rows || []
  return (props.rows || []).filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(k)))
})

const sorted = computed(() => {
  if (!sortKey.value) return filtered.value
  const key = sortKey.value
  const dir = sortDir.value
  return [...filtered.value].sort((a, b) => {
    const x = a[key]
    const y = b[key]
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) return (nx - ny) * dir
    return String(x ?? '').localeCompare(String(y ?? '')) * dir
  })
})

const total = computed(() => sorted.value.length)
const pages = computed(() => Math.max(1, Math.ceil(total.value / props.pageSize)))
const paged = computed(() => sorted.value.slice((page.value - 1) * props.pageSize, page.value * props.pageSize))

function toggleSort(c: OraCol): void {
  if (c.sort === false) return
  if (sortKey.value === c.key) sortDir.value = sortDir.value > 0 ? -1 : 1
  else {
    sortKey.value = c.key
    sortDir.value = c.type === 'num' || c.type === 'pct' || c.type === 'size' || c.type === 'bar' ? -1 : 1
  }
}

function fmt(c: OraCol, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (c.type) {
    case 'num': {
      // 非数字（如占位的 '—'）原样显示：Number('—') 会变 NaN 再 toLocaleString 成 "NaN"
      const n = Number(v)
      return Number.isFinite(n) ? n.toLocaleString('zh-CN') : String(v)
    }
    case 'pct':
      return fmtPct(v)
    case 'size':
      return fmtSize(Number(v))
    case 'time':
      return String(v)
    default:
      return String(v)
  }
}

function fmtPct(v: unknown): string {
  const n = Number(v)
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '—'
}

function fmtSize(mb: number): string {
  if (!Number.isFinite(mb)) return '—'
  if (Math.abs(mb) >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(2)} TB`
  if (Math.abs(mb) >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

function pctTone(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n >= 90 ? 'bad' : n >= 85 ? 'warn' : ''
}

const OK = /^(OPEN|ONLINE|VALID|SUCCESS|SUCCEEDED|COMPLETED|ACTIVE|NORMAL|YES|TRUE|OK|CONNECTED|ENABLED|SCHEDULED|PRIMARY|APPLYING|SYNCHRONIZED)$/i
const BAD = /(ERROR|FAIL|INVALID|BROKEN|ABORTED|CRITICAL|BLOCKED|UNUSABLE|OFFLINE|STOPPED|ORA-|SUSPENDED|GAP)/i
const WARN = /(WARN|PENDING|RETRY|PAUSED|DISABLED|INACTIVE|RESTRICTED|UNKNOWN|CLOSING|IDLE|STALE|MOUNTED|READ ONLY)/i

function tone(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (BAD.test(s)) return 'bad'
  if (OK.test(s)) return 'ok'
  if (WARN.test(s)) return 'warn'
  return ''
}

function cellClass(c: OraCol, r: any): string {
  const cls: string[] = []
  if (c.type === 'mono') cls.push('mono')
  if (c.type === 'num' || c.type === 'size') cls.push('num')
  if (c.type === 'pct') cls.push('num', pctTone(r[c.key]))
  return cls.join(' ')
}
</script>

<style scoped>
.ot { display: flex; flex-direction: column; min-height: 0; }
.ot-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ot-bar .sp { flex: 1; }
.ot-search {
  width: 200px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text); font-family: inherit; font-size: 11.5px; padding: 4px 8px; outline: none;
}
.ot-search:focus { border-color: var(--accent); }
.ot-cnt { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); }
.ot-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-card); }
.ot-tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.ot-tbl th {
  position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 500; font-size: 10.5px;
  color: var(--text-faint); background: var(--bg-input); border-bottom: 1px solid var(--border);
  padding: 7px 9px; white-space: nowrap; user-select: none;
}
.ot-tbl th.sortable { cursor: pointer; }
.ot-tbl th.sortable:hover { color: var(--text); }
.ot-tbl th.on { color: var(--accent); }
.ot-arrow { font-style: normal; font-size: 9px; margin-left: 3px; }
.ot-tbl td { padding: 5px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.ot-tbl tbody tr:last-child td { border-bottom: none; }
.ot-tbl tbody tr.clickable { cursor: pointer; }
.ot-tbl tbody tr.clickable:hover { background: var(--bg-card-hover); }
.ot-tbl td.num { text-align: right; font-family: var(--mono); }
.ot-tbl td.mono { font-family: var(--mono); }
.ot-tbl td.bad { color: var(--danger, #e05555); }
.ot-tbl td.warn { color: var(--warn, #d9a441); }
.ot-val { display: inline-block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.ot-empty { text-align: center; color: var(--text-faint); padding: 22px 0 !important; font-size: 11.5px; }
.ot-badge {
  display: inline-block; padding: 0 6px; border-radius: 99px; font-size: 10px; line-height: 15px;
  border: 1px solid var(--border); color: var(--text-dim); background: var(--bg-input);
}
.ot-badge.ok { color: var(--ok, #3fa96b); border-color: color-mix(in srgb, var(--ok, #3fa96b) 40%, transparent); }
.ot-badge.bad { color: var(--danger, #e05555); border-color: color-mix(in srgb, var(--danger, #e05555) 45%, transparent); }
.ot-badge.warn { color: var(--warn, #d9a441); border-color: color-mix(in srgb, var(--warn, #d9a441) 45%, transparent); }
.ot-bar-cell { display: flex; align-items: center; gap: 6px; min-width: 110px; }
.ot-bar-track { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-input); overflow: hidden; }
.ot-bar-track b { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.ot-bar-track b.warn { background: var(--warn, #d9a441); }
.ot-bar-track b.bad { background: var(--danger, #e05555); }
.ot-bar-cell em { font-style: normal; font-size: 10.5px; font-family: var(--mono); color: var(--text-faint); width: 44px; text-align: right; }
.ot-bar-cell em.ot-na { color: var(--text-faint); }
.ot-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 6px; font-size: 10.5px; color: var(--text-faint); }
.ot-pg {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; font-size: 10.5px; padding: 2px 8px; cursor: pointer; font-family: inherit;
}
.ot-pg:disabled { opacity: 0.45; cursor: default; }
</style>
