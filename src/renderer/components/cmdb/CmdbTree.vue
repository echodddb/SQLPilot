<template>
  <aside class="ct-root">
    <div class="ct-head">
      <span>资产树</span>
      <button class="cm-mini" title="管理客户 / 机房 / 机柜" @click="emit('org', 'customer')">组织</button>
    </div>

    <div class="ct-body">
      <div v-for="c in tree" :key="c.id" class="ct-group">
        <div
          class="ct-row ct-lv1"
          :class="{ on: cm.filter.customerId === c.id && !cm.filter.idcId }"
          @click="pickCustomer(c.id)"
        >
          <span class="ct-caret" @click.stop="toggle(c.id)">{{ opened.has(c.id) ? '▾' : '▸' }}</span>
          <span class="ct-dot" :style="{ background: colorOf(c.id) }"></span>
          <span class="ct-name" :title="c.name">{{ c.name }}</span>
          <span class="ct-count">{{ c.count }}</span>
        </div>

        <template v-if="opened.has(c.id)">
          <div v-for="d in c.children" :key="d.id" class="ct-group">
            <div
              class="ct-row ct-lv2"
              :class="{ on: cm.filter.idcId === d.id && cm.filter.customerId === c.id }"
              @click="pickIdc(c.id, d.id)"
            >
              <span class="ct-caret" @click.stop="toggle(d.id)">{{ opened.has(d.id) ? '▾' : '▸' }}</span>
              <span class="ct-name" :title="d.name">{{ d.name }}</span>
              <span class="ct-count">{{ d.count }}</span>
            </div>
            <template v-if="opened.has(d.id)">
              <div
                v-for="r in d.children"
                :key="r.id"
                class="ct-row ct-lv3"
                :class="{ on: cm.rackId === r.id && cm.mode === 'rack' }"
                @click="pickRack(c.id, d.id, r.id)"
              >
                <span class="ct-caret ghost">·</span>
                <span class="ct-name" :title="r.name">{{ r.name }}</span>
                <span class="ct-count">{{ r.count }}</span>
              </div>
            </template>
          </div>
        </template>
      </div>

      <div v-if="!tree.length" class="cm-empty">
        <div class="big">⛁</div>
        <div>还没有客户与机房</div>
        <button class="cm-mini" style="margin-top: 6px" @click="emit('org', 'customer')">＋ 新建客户</button>
      </div>
    </div>

    <div class="ct-foot">
      <button class="cm-mini" @click="emit('org', 'customer')">＋客户</button>
      <button class="cm-mini" @click="emit('org', 'idc')">＋机房</button>
      <button class="cm-mini" @click="emit('org', 'rack')">＋机柜</button>
      <span class="spacer"></span>
      <button class="cm-mini" title="回收站：软删除的资产可恢复" @click="emit('trash')">回收站{{ stats?.deleted ? ` ${stats.deleted}` : '' }}</button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import { cm, customers, stats, tree, setMode } from '../../cmdb/state'

const emit = defineEmits<{
  (e: 'org', tab: 'customer' | 'idc' | 'rack'): void
  (e: 'trash'): void
}>()

const opened = reactive(new Set<string>())

// 首次拿到数据时把客户层展开：进来看见"有几个客户"比看见一排折叠箭头有用
watch(
  () => tree.value,
  (t) => {
    if (!opened.size) for (const c of t) opened.add(c.id)
  },
  { immediate: true }
)

function toggle(id: string): void {
  if (opened.has(id)) opened.delete(id)
  else opened.add(id)
}

function colorOf(id: string): string {
  const c = customers.value.find((x) => x.id === id)
  return c?.color || '#38bdf8'
}

function pickCustomer(id: string): void {
  cm.filter.customerId = id
  cm.filter.idcId = ''
  if (cm.mode === 'rack') setMode('3d')
}

function pickIdc(customerId: string, idcId: string): void {
  cm.filter.customerId = customerId
  cm.filter.idcId = idcId
  if (cm.mode === 'rack') setMode('3d')
}

function pickRack(customerId: string, idcId: string, rackId: string): void {
  cm.filter.customerId = customerId
  cm.filter.idcId = idcId
  cm.rackId = rackId
  if (rackId.endsWith('::loose')) {
    // "未上架"不是真机柜，只在台账里筛出来，不进机柜视图
    cm.filter.idcId = idcId
    setMode('table')
    return
  }
  setMode('rack')
}
</script>

<style scoped>
.ct-root {
  width: 226px;
  min-width: 226px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-side);
  min-height: 0;
}
.ct-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: 0.4px;
}
.ct-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 6px 10px;
}
.ct-group {
  min-width: 0;
}
.ct-row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 6px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
  user-select: none;
}
.ct-row:hover {
  background: var(--bg-card-hover);
  color: var(--text);
}
.ct-row.on {
  background: var(--accent-dim);
  color: var(--accent);
}
.ct-lv1 { font-size: 12.5px; color: var(--text); }
.ct-lv2 { padding-left: 14px; }
.ct-lv3 { padding-left: 28px; font-size: 11.5px; }
.ct-caret {
  width: 11px;
  flex: none;
  font-size: 9px;
  color: var(--text-faint);
  text-align: center;
}
.ct-caret.ghost { opacity: 0.35; }
.ct-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex: none;
}
.ct-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-count {
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.ct-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 8px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.ct-foot .spacer { flex: 1; }
</style>
