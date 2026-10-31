<template>
  <div class="cm-mask" @click.self="emit('close')">
    <div class="cm-dlg" style="width: min(620px, calc(100vw - 80px))">
      <div class="cm-dlg-head">
        回收站
        <span class="sub">删除的资产保留关系，恢复后关系自动回来</span>
        <button class="cm-close" @click="emit('close')">✕</button>
      </div>
      <div class="cm-dlg-body" style="gap: 6px">
        <div v-for="a in list" :key="a.id" class="ct-row">
          <span class="ct-glyph">{{ typeGlyph(a.type) }}</span>
          <div class="ct-main">
            <div class="ct-name">{{ a.name }}</div>
            <div class="ct-sub">{{ typeName(a.type) }} · {{ customerName(a.customerId) }} · 删除于 {{ fmt(a.deletedAt) }}</div>
          </div>
          <button class="cm-mini" @click="restore(a.id)">恢复</button>
          <button class="cm-mini danger" @click="purge(a.id)">彻底删除</button>
        </div>
        <div v-if="!list.length" class="cm-empty">
          <div class="big">▤</div>
          <div>回收站是空的</div>
        </div>
      </div>
      <div class="cm-dlg-foot">
        <span class="cm-hint">彻底删除会连带清掉与它相关的所有关系，不可撤销</span>
        <span class="spacer"></span>
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { cm, customers, deletedAssets, purgeAsset, restoreAsset } from '../../cmdb/state'
import { typeGlyph, typeName } from '../../cmdb/dict'

const emit = defineEmits<{ (e: 'close'): void }>()
const list = computed(() => deletedAssets.value)

function customerName(id: string): string {
  return customers.value.find((c) => c.id === id)?.name || '未归属'
}
function fmt(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
async function restore(id: string): Promise<void> {
  await restoreAsset(id)
}
async function purge(id: string): Promise<void> {
  const a = cm.doc?.assets.find((x) => x.id === id)
  const ok = await window.sqlpilot.uiConfirm(`彻底删除「${a?.name || ''}」？`, '会同时清掉与它相关的所有关系，不可撤销。', true)
  if (!ok) return
  await purgeAsset(id)
}
</script>

<style scoped>
.ct-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
}
.ct-glyph {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: var(--bg-card-hover);
  color: var(--text-faint);
  font-size: 11px;
  flex: none;
}
.ct-main { flex: 1; min-width: 0; }
.ct-name { font-size: 12px; color: var(--text); }
.ct-sub { font-size: 10.5px; color: var(--text-faint); }
</style>
