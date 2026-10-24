<template>
  <div v-if="kpis.length" class="ik-wrap">
    <div
      v-for="k in kpis"
      :key="k.label"
      class="ik-tile"
      :class="k.tone || 'neutral'"
      :data-src="k.src"
      :data-detail="k.sub"
      :data-ai="aiKey ? aiKey(k) : undefined"
      :data-ai-name="aiKey ? k.label : undefined"
    >
      <div class="ik-label">{{ k.label }}</div>
      <div class="ik-value" :title="k.value">{{ k.value }}</div>
      <div v-if="k.sub" class="ik-sub" :title="k.sub">{{ k.sub }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 数据库信息页顶部的 KPI 磁贴（状态/使用率/会话/锁等待等，一眼可见） */
import type { InfoKpi } from './info-chart-types'

/**
 * aiKey：可选的 AI 勾选 key（传了才会在磁贴上挂 data-ai）。
 * 云管平台用它做「单个指标」粒度的读取范围，其它页面不传即可。
 */
withDefaults(defineProps<{ kpis?: InfoKpi[]; aiKey?: (k: InfoKpi) => string }>(), { kpis: () => [] })
</script>

<style scoped>
.ik-wrap {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.ik-tile {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-left: 2.5px solid var(--border-strong);
  border-radius: 10px;
  padding: 8px 11px 9px;
  min-width: 0;
}
.ik-tile.ok { border-left-color: var(--green); }
.ik-tile.warn { border-left-color: var(--yellow); }
.ik-tile.bad { border-left-color: var(--red); }
.ik-label { font-size: 11px; color: var(--text-faint); letter-spacing: 0.3px; }
.ik-value {
  font-size: 17px;
  font-weight: 700;
  color: var(--text);
  margin-top: 3px;
  font-family: var(--mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ik-tile.ok .ik-value { color: var(--green); }
.ik-tile.warn .ik-value { color: var(--yellow); }
.ik-tile.bad .ik-value { color: var(--red); }
.ik-sub {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
