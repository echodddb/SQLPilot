<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-card" data-src="orPaKey" :data-ai="oraPickKey('params','key')" data-ai-compact data-ai-name="关键参数">
      <div class="oc-card-h"><span>关键参数</span><span class="sp"></span>
        <span class="oc-note">ISSYS_MODIFIABLE：IMMEDIATE 可在线改，FALSE 要重启</span>
      </div>
      <div class="oc-kvs">
        <div v-for="p in d.key" :key="p.name" class="oc-kv">
          <span>{{ p.name }}<i v-if="p.isDefault === 'FALSE'" style="font-style: normal; color: var(--accent)"> ·已改</i></span>
          <b :title="p.value">{{ p.value || '(空)' }}</b>
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orPaChanged" :data-ai="oraPickKey('params','changed')" data-ai-compact data-ai-name="非默认参数">
      <div class="oc-card-h"><span>非默认参数</span><span class="cnt">{{ d.changed.length }}</span><span class="sp"></span>
        <span class="oc-note">isdefault = FALSE：与出厂的默认值不同，排查问题先看这里</span>
      </div>
      <OraTable :columns="cols" :rows="d.changed" searchable search-placeholder="参数名 / 值…" page-size="80" default-sort="name" default-dir="1" />
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { oraData } from '../../../cloud/oracle'

const d = computed(() => oraData('params'))

const cols: OraCol[] = [
  { key: 'name', label: '参数', type: 'mono' },
  { key: 'value', label: '当前值', type: 'mono' },
  { key: 'modifiable', label: '可修改性', type: 'state' },
  { key: 'desc', label: '说明' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
