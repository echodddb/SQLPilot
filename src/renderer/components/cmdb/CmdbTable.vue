<template>
  <div class="cb-root">
    <div class="cb-scroll">
      <table class="cb-table">
        <thead>
          <tr>
            <th class="c-chk">
              <input type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked" @change="toggleAll" />
            </th>
            <th class="c-type" :class="sortCls('type')" @click="sortBy('type')">类型</th>
            <th class="c-name" :class="sortCls('name')" @click="sortBy('name')">名称</th>
            <th class="c-ip" :class="sortCls('ip')" @click="sortBy('ip')">IP</th>
            <th class="c-loc" :class="sortCls('loc')" @click="sortBy('loc')">归属（客户 / 机房 / 机柜）</th>
            <th class="c-os">OS / 型号</th>
            <th class="c-rel" :class="sortCls('degree')" @click="sortBy('degree')">关系</th>
            <th class="c-status" :class="sortCls('status')" @click="sortBy('status')">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="r.id"
            :class="{ on: cm.selected === r.id }"
            @click="pick(r.id)"
            @dblclick="emit('edit', r.id)"
            @contextmenu.prevent="emit('menu', { id: r.id, sx: $event.clientX, sy: $event.clientY })"
          >
            <td class="c-chk" @click.stop>
              <input v-model="checked[r.id]" type="checkbox" />
            </td>
            <td class="c-type">
              <span class="cb-glyph" :class="`k-${r.kind}`">{{ typeGlyph(r.type) }}</span>
              <span class="cb-typename">{{ typeName(r.type) }}</span>
            </td>
            <td class="c-name">
              <div class="cb-title" :title="r.name">{{ r.name }}</div>
              <div v-if="r.hostname && r.hostname !== r.name" class="cb-sub">{{ r.hostname }}</div>
            </td>
            <td class="c-ip mono">{{ r.ips.join(', ') || '—' }}</td>
            <td class="c-loc">
              <span class="cb-loc">{{ customerName(r.customerId) }}</span>
              <span class="cb-sep">/</span>
              <span class="cb-loc">{{ idcName(r.idcId) }}</span>
              <span v-if="rackCode(r.rackId)" class="cb-sep">/</span>
              <span v-if="rackCode(r.rackId)" class="cb-loc">{{ rackCode(r.rackId) }}{{ r.u ? ` U${r.u}` : '' }}</span>
            </td>
            <td class="c-os">
              <span v-if="r.os">{{ r.os }}</span>
              <span v-if="r.vendor || r.model" class="cb-sub">{{ [r.vendor, r.model].filter(Boolean).join(' ') }}</span>
              <span v-if="!r.os && !r.vendor && !r.model" class="cb-sub">—</span>
            </td>
            <td class="c-rel">
              <span v-if="degreeOf(r.id)" class="cb-rel" :title="`${degreeOf(r.id)} 条关系`">{{ degreeOf(r.id) }}</span>
              <span v-else class="cb-sub">孤岛</span>
            </td>
            <td class="c-status">
              <span class="cb-status" :class="`st-${r.status}`"><i></i>{{ statusName(r.status) }}</span>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="8">
              <div class="cm-empty">
                <div class="big">⛁</div>
                <div>当前筛选下没有资产</div>
                <div class="cm-hint">换一个客户/机房，或点右上角「＋ 资产」录入</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="cb-foot">
      <span>共 {{ rows.length }} 项<span v-if="hiddenCount"> · 筛选外 {{ hiddenCount }} 项</span></span>
      <span v-if="checkedCount" class="cb-sel">已选 {{ checkedCount }}</span>
      <span class="spacer"></span>
      <button class="cm-mini" :disabled="!checkedCount" @click="exportChecked">导出所选 CSV</button>
      <button class="cm-mini" @click="emit('export-all')">导出全部</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { cm, customers, graph, idcs, liveAssets, racks } from '../../cmdb/state'
import { statusName, typeGlyph, typeName } from '../../cmdb/dict'

const emit = defineEmits<{
  (e: 'edit', id: string): void
  (e: 'menu', payload: { id: string; sx: number; sy: number }): void
  (e: 'export-all'): void
}>()

const checked = reactive<Record<string, boolean>>({})

type SortKey = 'type' | 'name' | 'ip' | 'loc' | 'degree' | 'status'
const sortKey = ref<SortKey>('name')
const sortAsc = ref(true)

function sortBy(k: SortKey): void {
  if (sortKey.value === k) sortAsc.value = !sortAsc.value
  else {
    sortKey.value = k
    sortAsc.value = true
  }
}
function sortCls(k: SortKey): string {
  return sortKey.value === k ? (sortAsc.value ? 'sort-asc' : 'sort-desc') : ''
}

const custMap = computed(() => new Map(customers.value.map((c) => [c.id, c.name])))
const idcMap = computed(() => new Map(idcs.value.map((d) => [d.id, d.name])))
const rackMap = computed(() => new Map(racks.value.map((r) => [r.id, r.code])))
const degreeMap = computed(() => new Map(graph.value.nodes.map((n) => [n.id, n.degree])))

function customerName(id: string): string {
  return custMap.value.get(id) || '未归属'
}
function idcName(id?: string): string {
  return id ? idcMap.value.get(id) || '—' : '未指定'
}
function rackCode(id?: string): string {
  return id ? rackMap.value.get(id) || '' : ''
}
function degreeOf(id: string): number {
  return degreeMap.value.get(id) || 0
}

const rows = computed(() => {
  // graph 已经做过筛选（客户/机房/类型/搜索/下线），台账直接复用同一套结果：
  // 两个视图的"可见集合"必须一致，否则用户在台账里看不到图上刚筛掉的资产会困惑
  const ids = new Set(graph.value.nodes.map((n) => n.id))
  const list = liveAssets.value.filter((a) => ids.has(a.id))
  const dir = sortAsc.value ? 1 : -1
  const key = sortKey.value
  return [...list].sort((a, b) => {
    let r = 0
    if (key === 'name') r = a.name.localeCompare(b.name, 'zh')
    else if (key === 'type') r = a.type.localeCompare(b.type)
    else if (key === 'ip') r = (a.ips[0] || '').localeCompare(b.ips[0] || '')
    else if (key === 'loc') r = (customerName(a.customerId) + idcName(a.idcId)).localeCompare(customerName(b.customerId) + idcName(b.idcId), 'zh')
    else if (key === 'status') r = a.status.localeCompare(b.status)
    else if (key === 'degree') r = degreeOf(a.id) - degreeOf(b.id)
    return r * dir
  })
})

const hiddenCount = computed(() => graph.value.hidden)
const checkedIds = computed(() => Object.keys(checked).filter((k) => checked[k]))
const checkedCount = computed(() => checkedIds.value.length)
const allChecked = computed(() => rows.value.length > 0 && rows.value.every((r) => checked[r.id]))
const someChecked = computed(() => !allChecked.value && checkedCount.value > 0)

function toggleAll(): void {
  const next = !allChecked.value
  for (const k of Object.keys(checked)) delete checked[k]
  if (next) for (const r of rows.value) checked[r.id] = true
}

function pick(id: string): void {
  cm.selected = id
  cm.selectedEdge = ''
}

function exportChecked(): void {
  void window.sqlpilot.cmdbExportCsv(checkedIds.value)
}

// 切换筛选后把看不见的勾选清掉，避免"导出了别的机房的资产"
watch(rows, (list) => {
  const keep = new Set(list.map((r) => r.id))
  for (const k of Object.keys(checked)) if (!keep.has(k)) delete checked[k]
})
</script>

<style scoped>
.cb-root {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.cb-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.cb-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}
.cb-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--text-faint);
  padding: 6px 8px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.cb-table th:hover { color: var(--text-dim); }
.cb-table th.sort-asc::after { content: ' ▲'; font-size: 8px; color: var(--accent); }
.cb-table th.sort-desc::after { content: ' ▼'; font-size: 8px; color: var(--accent); }
.cb-table td {
  padding: 5px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  color: var(--text-dim);
  vertical-align: middle;
}
.cb-table tbody tr { cursor: pointer; }
.cb-table tbody tr:hover td { background: var(--bg-card-hover); }
.cb-table tbody tr.on td { background: var(--accent-dim); color: var(--text); }
.c-chk { width: 30px; text-align: center; }
.c-type { width: 108px; }
.c-ip { width: 118px; font-family: var(--mono); font-size: 11.5px; }
.c-loc { width: 200px; }
.c-os { width: 150px; }
.c-rel { width: 54px; text-align: center; }
.c-status { width: 84px; }
.cb-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border: 1px solid;
  border-radius: 4px;
  font-size: 10px;
  margin-right: 5px;
  opacity: 0.95;
}
.cb-typename { font-size: 11.5px; }
/* 类型/状态用主题变量而不是十六进制：切换亮色主题时表格跟着走 */
.cb-glyph.k-hardware { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: var(--accent-dim); }
.cb-glyph.k-software { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 55%, transparent); background: color-mix(in srgb, var(--purple) 12%, transparent); }
.cb-glyph.k-logical { color: var(--green); border-color: color-mix(in srgb, var(--green) 55%, transparent); background: var(--green-dim); }
.st-running { color: var(--green); }
.st-running i { background: var(--green); }
.st-stopped { color: var(--text-faint); }
.st-stopped i { background: var(--text-faint); }
.st-maintenance { color: var(--yellow); }
.st-maintenance i { background: var(--yellow); }
.st-planned { color: var(--accent); }
.st-planned i { background: var(--accent); }
.st-retired { color: var(--text-faint); opacity: 0.7; }
.st-retired i { background: var(--text-faint); }
.cb-title {
  color: var(--text);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}
.cb-sub {
  display: block;
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cb-loc { font-size: 11.5px; }
.cb-sep { color: var(--text-faint); margin: 0 3px; opacity: 0.6; }
.cb-rel {
  display: inline-block;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 10.5px;
  text-align: center;
}
.cb-status { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; }
.cb-status i { width: 5px; height: 5px; border-radius: 50%; }
.cb-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
  background: var(--bg-side);
}
.cb-foot .spacer { flex: 1; }
.cb-sel { color: var(--accent); }
.mono { font-family: var(--mono); }
</style>
