<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-cards">
      <div class="oc-card" data-src="orStFra" :data-ai="oraPickKey('storage','fra')" data-ai-compact data-ai-name="FRA 快速恢复区">
        <div class="oc-card-h"><span>FRA 快速恢复区</span><span class="sp"></span>
          <span class="oc-note">{{ d.fra ? '≥85% 需清理归档' : '未配置' }}</span>
        </div>
        <div v-if="!d.fra" class="oc-note">没有配置 db_recovery_file_dest</div>
        <template v-else>
          <div class="oc-bars">
            <div class="oc-bar-row">
              <span>{{ d.fra.name }}</span>
              <i><b :class="fraPct >= 90 ? 'bad' : fraPct >= 85 ? 'warn' : ''" :style="{ width: Math.min(100, fraPct) + '%' }"></b></i>
              <em>{{ fraPct.toFixed(1) }}%</em>
            </div>
          </div>
          <div class="oc-note">已用 {{ d.fra.usedGb }} GB / 上限 {{ d.fra.limitGb }} GB · 可回收 {{ d.fra.reclaimGb }} GB · {{ d.fra.files }} 个文件</div>
          <div class="oc-kvs" style="margin-top: 4px">
            <div v-for="u in d.fra.usage" :key="u.type" class="oc-kv">
              <span>{{ u.type }}</span>
              <b>{{ u.usedPct.toFixed(1) }}% · {{ u.files }} 个</b>
            </div>
          </div>
        </template>
      </div>

      <div class="oc-card" data-src="orStArch" :data-ai="oraPickKey('storage','archive')" data-ai-compact data-ai-name="归档">
        <div class="oc-card-h"><span>归档</span><span class="sp"></span>
          <span class="oc-note">近 24 小时 {{ d.archive.last24h.count }} 个 · {{ d.archive.last24h.gb }} GB</span>
        </div>
        <OraTable :columns="archCols" :rows="d.archive.dests" empty="没有归档目标" default-sort="destId" default-dir="1" />
      </div>
    </div>

    <div class="oc-card" data-src="orStTs" :data-ai="oraPickKey('storage','tablespaces')" data-ai-compact data-ai-name="表空间水位">
      <div class="oc-card-h">
        <span>表空间水位</span><span class="cnt">{{ d.tablespaces.length }}</span><span class="sp"></span>
        <span class="oc-note">MAX MB 是自动扩展上限（32G 表示未设上限的 smallfile）</span>
      </div>
      <OraTable :columns="tsCols" :rows="d.tablespaces" searchable search-placeholder="表空间过滤…" default-sort="usedPct" />
    </div>

    <div class="oc-card" data-src="orStTemp" :data-ai="oraPickKey('storage','temp')" data-ai-compact data-ai-name="临时表空间">
      <div class="oc-card-h"><span>临时表空间</span><span class="cnt">{{ d.temp.length }}</span></div>
      <OraTable :columns="tempCols" :rows="d.temp" empty="没有临时表空间数据" />
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orStUndo" :data-ai="oraPickKey('storage','undo')" data-ai-compact data-ai-name="UNDO 段">
        <div class="oc-card-h"><span>UNDO 段</span><span class="sp"></span>
          <span class="oc-note">{{ d.undo.segments.map((s) => `${s.status} ${s.count}`).join(' · ') }}</span>
        </div>
        <OraTable :columns="undoCols" :rows="d.undo.recent" empty="没有 UNDO 统计" />
      </div>
      <div class="oc-card" data-src="orStRedo" :data-ai="oraPickKey('storage','redo')" data-ai-compact data-ai-name="在线日志">
        <div class="oc-card-h"><span>在线日志</span><span class="cnt">{{ d.redo.length }}</span><span class="sp"></span>
          <span class="oc-note">CURRENT 只能有一个；ACTIVE 未归档完</span>
        </div>
        <OraTable :columns="redoCols" :rows="d.redo" default-sort="group" default-dir="1" />
      </div>
    </div>

    <div class="oc-card" data-src="orStAsm" :data-ai="oraPickKey('storage','asm')" data-ai-compact data-ai-name="ASM 磁盘组">
      <div class="oc-card-h"><span>ASM 磁盘组</span><span class="cnt">{{ d.asm.length }}</span><span class="sp"></span>
        <span class="oc-note">非 ASM 存储时为空</span>
      </div>
      <OraTable :columns="asmCols" :rows="d.asm" empty="没有 ASM 磁盘组（文件系统或已用其他存储）" />
    </div>

    <div class="oc-card" data-src="orStDf" :data-ai="oraPickKey('storage','datafiles')" data-ai-compact data-ai-name="数据文件">
      <div class="oc-card-h"><span>数据文件</span><span class="cnt">{{ d.datafiles.length }}</span><span class="sp"></span>
        <span class="oc-note">AUTOEXTENSIBLE=NO 且接近满的文件需要人工扩容</span>
      </div>
      <OraTable :columns="dfCols" :rows="d.datafiles" searchable search-placeholder="文件名 / 表空间过滤…" page-size="60" default-sort="sizeMb" />
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

const d = computed(() => oraData('storage'))
const fraPct = computed(() => {
  const f = d.value?.fra
  return f && f.limitGb > 0 ? (f.usedGb * 100) / f.limitGb : 0
})

const tsCols: OraCol[] = [
  { key: 'name', label: '表空间', type: 'mono' },
  { key: 'contents', label: '类型' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'logging', label: 'LOGGING' },
  { key: 'sizeMb', label: '已分配', type: 'size' },
  { key: 'usedMb', label: '已用', type: 'size' },
  { key: 'freeMb', label: '剩余', type: 'size' },
  { key: 'usedPct', label: '水位', type: 'bar', width: '150px' },
  { key: 'maxMb', label: '上限', type: 'size' },
  { key: 'files', label: '文件数', type: 'num' },
  { key: 'autoext', label: '可扩展', type: 'num' }
]

const tempCols: OraCol[] = [
  { key: 'name', label: '临时表空间', type: 'mono' },
  { key: 'totalMb', label: '总大小', type: 'size' },
  { key: 'usedMb', label: '已用', type: 'size' },
  { key: 'freeMb', label: '剩余', type: 'size' },
  { key: 'usedPct', label: '水位', type: 'bar', width: '150px' }
]

const undoCols: OraCol[] = [
  { key: 'begin', label: '开始', type: 'mono' },
  { key: 'end', label: '结束', type: 'mono' },
  { key: 'undoblks', label: 'UNDO 块', type: 'num' },
  { key: 'txnCount', label: '事务数', type: 'num' },
  { key: 'maxQueryLen', label: '最长查询(s)', type: 'num' },
  { key: 'ssolderrcnt', label: '快照过旧', type: 'num' },
  { key: 'nospaceerrcnt', label: '空间不足', type: 'num' }
]

const redoCols: OraCol[] = [
  { key: 'group', label: '组', type: 'num', width: '52px' },
  { key: 'thread', label: '线程', type: 'num', width: '56px' },
  { key: 'sequence', label: '序号', type: 'num' },
  { key: 'mb', label: '大小', type: 'size' },
  { key: 'members', label: '成员', type: 'num' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'archived', label: '已归档' },
  { key: 'firstTime', label: '首次写入', type: 'time' }
]

const asmCols: OraCol[] = [
  { key: 'name', label: '磁盘组', type: 'mono' },
  { key: 'type', label: '冗余' },
  { key: 'state', label: '状态', type: 'state' },
  { key: 'totalMb', label: '总容量', type: 'size' },
  { key: 'freeMb', label: '剩余', type: 'size' },
  { key: 'usableMb', label: '可用', type: 'size' },
  { key: 'usedPct', label: '水位', type: 'bar', width: '140px' },
  { key: 'disks', label: '磁盘数', type: 'num' }
]

const archCols: OraCol[] = [
  { key: 'destId', label: 'DEST', type: 'num', width: '56px' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'destination', label: '目标', type: 'mono' },
  { key: 'dbUnique', label: 'DB Unique', type: 'mono' },
  { key: 'syncStatus', label: '同步状态' },
  { key: 'synchronized', label: '已同步' },
  { key: 'gapStatus', label: 'GAP' },
  { key: 'error', label: '错误' }
]

const dfCols: OraCol[] = [
  { key: 'fileId', label: 'FILE#', type: 'num', width: '64px' },
  { key: 'fileName', label: '文件', type: 'mono' },
  { key: 'tablespace', label: '表空间', type: 'mono' },
  { key: 'sizeMb', label: '大小', type: 'size' },
  { key: 'autoextensible', label: '自动扩展', type: 'state' },
  { key: 'maxMb', label: '上限', type: 'size' },
  { key: 'incMb', label: '每次增量', type: 'size' },
  { key: 'onlineStatus', label: '在线状态', type: 'state' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
