<template>
  <div v-if="d" class="oc-wrap">
    <div v-if="!d.isCdb" class="oc-empty">
      <b style="font-size: 13px">当前实例不是 CDB</b>
      <p>{{ d.note }}</p>
      <p class="oc-note">Oracle 11g 之前没有多租户架构；12c 起用 v$pdbs / v$containers 查看。</p>
    </div>

    <template v-else>
      <div class="oc-card" data-src="orPdbList" :data-ai="oraPickKey('pdb','list')" data-ai-compact data-ai-name="PDB 列表">
        <div class="oc-card-h">
          <span>PDB 列表</span><span class="cnt">{{ d.pdbs.length }}</span><span class="sp"></span>
          <span class="oc-note">OPEN_MODE 不是 READ WRITE 的 PDB，业务连上会直接报错</span>
        </div>
        <OraTable :columns="cols" :rows="d.pdbs" row-key="conId" default-sort="conId" default-dir="1" />
      </div>

      <div class="oc-card" data-src="orPdbFiles" :data-ai="oraPickKey('pdb','files')" data-ai-compact data-ai-name="数据文件占用">
        <div class="oc-card-h"><span>PDB 数据文件占用</span><span class="cnt">{{ d.files.length }}</span></div>
        <div v-if="!d.files.length" class="oc-note">没有读到 v$datafile 的 con_id 信息（权限或版本限制）</div>
        <div v-else class="oc-bars">
          <div v-for="f in d.files" :key="f.conId" class="oc-bar-row">
            <span>CON{{ f.conId }} · {{ f.name }}</span>
            <i><b :style="{ width: pct(f.sizeMb, maxSize) + '%' }"></b></i>
            <em>{{ fmtSize(f.sizeMb) }}</em>
          </div>
        </div>
      </div>
    </template>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { oraData } from '../../../cloud/oracle'

const d = computed(() => oraData('pdb'))
const maxSize = computed(() => Math.max(1, ...(d.value?.files.map((f) => f.sizeMb) || [1])))

const cols: OraCol[] = [
  { key: 'conId', label: 'CON_ID', type: 'num', width: '70px' },
  { key: 'name', label: '名称', type: 'mono' },
  { key: 'conType', label: '类型' },
  { key: 'openMode', label: '打开模式', type: 'state' },
  { key: 'restricted', label: '受限' },
  { key: 'openTime', label: '打开时间', type: 'time' }
]

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}
function fmtSize(mb: number): string {
  const n = Number(mb) || 0
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n.toFixed(0)} MB`
}
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
