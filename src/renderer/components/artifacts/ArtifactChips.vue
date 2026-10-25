<template>
  <div class="ac">
    <div class="ac-head">
      <span class="ac-title">产物（{{ items.length }}）</span>
      <span style="flex: 1"></span>
      <button class="ac-link" @click="openAll">在侧栏查看 →</button>
    </div>
    <div class="ac-list">
      <button v-for="a in items" :key="a.id" class="ac-chip" :title="`${a.title}\n${a.subtitle}`" @click="openOne(a.id)">
        <span class="ac-kind" :class="'k-' + a.kind">{{ iconOf(a.kind) }}</span>
        <span class="ac-name">{{ a.title }}</span>
        <span class="ac-sub">{{ shortSub(a) }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { store } from '../../store'
import type { Artifact } from '../../artifacts'

const props = defineProps<{ items: Artifact[] }>()

const ICONS: Record<string, string> = { table: '▦', code: '</>', markdown: '¶', image: '🖼', file: '📎', text: '¶' }
function iconOf(k: string): string {
  return ICONS[k] || '•'
}

/** 芯片里只放最关键的一项信息，细节留给侧栏 */
function shortSub(a: Artifact): string {
  const s = a.subtitle || ''
  return s.length > 28 ? s.slice(0, 28) + '…' : s
}

function openOne(id: string): void {
  store.artifactsOpen = true
  store.artifactFocus = id
}

function openAll(): void {
  store.artifactsOpen = true
  const last = props.items[props.items.length - 1]
  if (last) store.artifactFocus = last.id
}
</script>

<style scoped>
.ac {
  margin-top: 8px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-card); padding: 7px 10px 9px;
}
.ac-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.ac-title { font-size: 11.5px; color: var(--text-dim); font-weight: 600; }
.ac-link {
  border: none; background: none; color: var(--accent); font-size: 11.5px;
  cursor: pointer; font-family: inherit; padding: 0;
}
.ac-link:hover { text-decoration: underline; }
.ac-list { display: flex; flex-wrap: wrap; gap: 6px; }
.ac-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  border: 1px solid var(--border); background: var(--bg-side);
  border-radius: 8px; padding: 3px 9px 3px 5px; cursor: pointer; font-family: inherit;
  color: var(--text-dim); font-size: 11.5px;
}
.ac-chip:hover { border-color: var(--accent); color: var(--text); }
.ac-kind {
  width: 17px; height: 17px; border-radius: 5px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9.5px; font-weight: 700;
  background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent);
}
.ac-kind.k-table { color: var(--blue, #4a9fe0); background: color-mix(in srgb, var(--blue, #4a9fe0) 16%, transparent); }
.ac-kind.k-markdown { color: var(--green); background: color-mix(in srgb, var(--green) 16%, transparent); }
.ac-kind.k-image { color: var(--purple, #a78bfa); background: color-mix(in srgb, var(--purple, #a78bfa) 16%, transparent); }
.ac-name { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-sub { color: var(--text-faint); font-size: 10.5px; font-family: var(--mono); }
</style>
