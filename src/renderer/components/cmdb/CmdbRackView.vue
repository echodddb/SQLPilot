<template>
  <div class="cr-root">
    <div class="cr-side">
      <div class="cr-side-head">机柜</div>
      <div class="cr-racks">
        <div
          v-for="r in rackList"
          :key="r.id"
          class="cr-rack-row"
          :class="{ on: r.id === current?.id }"
          @click="pick(r.id)"
        >
          <span>{{ r.code }}</span>
          <span class="cr-cnt">{{ countOf(r.id) }}</span>
        </div>
        <div v-if="!rackList.length" class="cm-empty">
          <div class="big">▥</div>
          <div>该机房还没有机柜</div>
          <button class="cm-mini" style="margin-top: 6px" @click="emit('org', 'rack')">＋ 新建机柜</button>
        </div>
      </div>
    </div>

    <div class="cr-main">
      <template v-if="current">
        <div class="cr-head">
          <b>{{ current.code }}</b>
          <span class="cm-hint">{{ idcName(current.idcId) }} · {{ used }}/{{ current.uTotal || 42 }}U 已用</span>
          <span class="spacer"></span>
          <button class="cm-mini" @click="emit('new', current.id)">＋ 上架资产</button>
        </div>

        <div ref="viewEl" class="cr-view">
          <div class="cr-ruler">
            <div v-for="n in total" :key="n" class="cr-u">{{ total - n + 1 }}</div>
          </div>
          <div ref="slotsEl" class="cr-slots">
            <template v-for="s in slots" :key="s.key">
              <div
                v-if="s.kind === 'asset'"
                class="cr-asset"
                :class="`k-${s.kindOf}`"
                :style="{ height: `${s.height * ROW - 2}px` }"
                :title="`${s.asset.name} · U${s.asset.u}${s.asset.uHeight && s.asset.uHeight > 1 ? `-U${s.asset.u + s.asset.uHeight - 1}` : ''}`"
                @click="cm.selected = s.asset.id"
                @dblclick="emit('edit', s.asset.id)"
              >
                <span class="cr-glyph">{{ typeGlyph(s.asset.type) }}</span>
                <span class="cr-aname">{{ s.asset.name }}</span>
                <span class="cr-ameta">{{ [typeName(s.asset.type), s.asset.ips[0]].filter(Boolean).join(' · ') }}</span>
              </div>
              <div v-else class="cr-empty-slot" :class="{ pair: s.u % 2 === 0 }" :style="{ height: `${ROW - 2}px` }"></div>
            </template>
          </div>
        </div>

        <div v-if="loose.length" class="cr-loose">
          <div class="cr-loose-head">未标 U 位（{{ loose.length }}）</div>
          <div class="cr-loose-list">
            <button v-for="a in loose" :key="a.id" class="cm-mini" @click="cm.selected = a.id">{{ a.name }}</button>
          </div>
        </div>
      </template>
      <div v-else class="cm-empty" style="flex: 1">
        <div class="big">▥</div>
        <div>左侧选一个机柜看正视图</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { assetsOfRack, cm, idcs, liveAssets, racks } from '../../cmdb/state'
import { assetTypeOf, typeGlyph, typeName } from '../../cmdb/dict'

const emit = defineEmits<{ (e: 'org', tab: 'rack'): void; (e: 'new', rackId: string): void; (e: 'edit', id: string): void }>()

const ROW = 20

const rackList = computed(() => {
  const idcId = cm.filter.idcId
  return idcId ? racks.value.filter((r) => r.idcId === idcId) : racks.value
})

const current = computed(() => rackList.value.find((r) => r.id === cm.rackId) || rackList.value[0] || null)
const total = computed(() => current.value?.uTotal || 42)
const idcName = (id: string): string => idcs.value.find((d) => d.id === id)?.name || '—'

function countOf(rackId: string): number {
  return liveAssets.value.filter((a) => a.rackId === rackId).length
}
function pick(id: string): void {
  cm.rackId = id
}

const rackAssets = computed(() => (current.value ? assetsOfRack(current.value.id) : []))

// 打开机柜直接滚到第一台设备所在 U：46U 的柜子里设备通常在低 U，不滚就是一片空格
const viewEl = ref<HTMLDivElement | null>(null)
const slotsEl = ref<HTMLDivElement | null>(null)
function scrollToFirstAsset(): void {
  const blocks = slotsEl.value?.querySelectorAll('.cr-asset')
  const main = viewEl.value?.closest('.cr-main') as HTMLElement | null
  if (!blocks?.length || !main) return
  // 用 getBoundingClientRect 换算（offsetTop 的参考系是"最近的定位祖先"，
  // 这里链路上没有 relative，直接拿 offsetTop 会算错），把有设备的区间摆到视口上部
  const first = blocks[0].getBoundingClientRect()
  const last = blocks[blocks.length - 1].getBoundingClientRect()
  const box = main.getBoundingClientRect()
  const center = (first.top + last.bottom) / 2 - box.top + main.scrollTop
  main.scrollTop = Math.max(0, center - box.height * 0.45)
}
watch(
  () => [current.value?.id, rackAssets.value.length],
  async () => {
    await nextTick()
    scrollToFirstAsset()
  },
  { immediate: true }
)

/** 未标 U 位 / U 位越界的单独列出来，别让它们从正视图里"消失" */
const loose = computed(() => rackAssets.value.filter((a) => !a.u || a.u > total.value))

const used = computed(() => rackAssets.value.filter((a) => a.u && a.u <= total.value).reduce((n, a) => n + (a.uHeight || 1), 0))

interface Slot {
  key: string
  kind: 'asset' | 'empty'
  u: number
  height: number
  kindOf?: string
  asset?: any
}

const slots = computed<Slot[]>(() => {
  const out: Slot[] = []
  const placed = rackAssets.value.filter((a) => a.u && a.u <= total.value)
  const covered = new Set<number>()
  // 从上往下排（U42 在最上面，符合机柜真实摆放）
  for (let u = total.value; u >= 1; u--) {
    if (covered.has(u)) continue
    const a = placed.find((x) => x.u === u)
    if (a) {
      const h = Math.min(a.uHeight || 1, u)
      for (let k = 1; k < h; k++) covered.add(u - k)
      out.push({ key: `a-${a.id}`, kind: 'asset', u, height: h, kindOf: assetTypeOf(a.type).kind, asset: a })
    } else {
      out.push({ key: `e-${u}`, kind: 'empty', u, height: 1 })
    }
  }
  return out
})
</script>

<style scoped>
.cr-root {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  background: var(--bg);
}
.cr-side {
  width: 150px;
  min-width: 150px;
  border-right: 1px solid var(--border);
  background: var(--bg-side);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.cr-side-head {
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-faint);
  border-bottom: 1px solid var(--border);
}
.cr-racks {
  flex: 1;
  overflow: auto;
  padding: 5px;
}
.cr-rack-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 7px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
.cr-rack-row:hover { background: var(--bg-card-hover); color: var(--text); }
.cr-rack-row.on { background: var(--accent-dim); color: var(--accent); }
.cr-cnt { font-size: 10.5px; color: var(--text-faint); }
.cr-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 14px 16px;
  overflow: auto;
}
.cr-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
}
.cr-head b { font-size: 13px; font-weight: 500; color: var(--text); }
.cr-head .spacer { flex: 1; }
.cr-view {
  display: flex;
  gap: 6px;
  align-self: flex-start;
  /* 必须 flex:none：否则父级 flex 列会把它压缩，42 行槽位被挤到 12px，
     和 20px 一格的刻度尺直接错位（这个 bug 一眼能看出来） */
  flex: none;
}
.cr-ruler {
  display: flex;
  flex-direction: column;
  flex: none;
}
.cr-u {
  flex: none;
  height: 20px;
  font-size: 9.5px;
  color: var(--text-faint);
  text-align: right;
  padding-right: 4px;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
}
.cr-slots {
  width: min(460px, 60vw);
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
}
.cr-slots > * { flex: none; }
.cr-empty-slot {
  border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  border-radius: 3px;
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
}
.cr-empty-slot.pair { background: color-mix(in srgb, var(--bg-card) 30%, transparent); }
.cr-asset {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
  border: 1px solid;
}
.cr-asset.k-hardware { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--text); }
.cr-asset.k-software { background: color-mix(in srgb, var(--purple) 13%, transparent); border-color: color-mix(in srgb, var(--purple) 45%, transparent); color: var(--text); }
.cr-asset.k-logical { background: var(--green-dim); border-color: color-mix(in srgb, var(--green) 45%, transparent); color: var(--text); }
.cr-asset:hover { filter: brightness(1.12); }
.cr-glyph { font-size: 11px; opacity: 0.8; flex: none; }
.cr-aname { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cr-ameta { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cr-loose { margin-top: 14px; }
.cr-loose-head { font-size: 11px; color: var(--text-faint); margin-bottom: 6px; }
.cr-loose-list { display: flex; flex-wrap: wrap; gap: 5px; }
</style>
