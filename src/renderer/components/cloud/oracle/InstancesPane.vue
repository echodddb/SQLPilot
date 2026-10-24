<template>
  <div v-if="d" class="oc-wrap">
    <div v-for="i in d" :key="i.instId" class="oc-card" data-src="orInstMeta" :data-ai="oraPickKey('instances', `detail.${i.instanceName}`)" data-ai-compact :data-ai-name="i.instanceName">
      <div class="oc-card-h">
        <span>{{ i.instanceName }}</span>
        <span class="cnt">INST {{ i.instId }}</span>
        <span class="sp"></span>
        <span class="oc-note">{{ i.hostName }} · {{ i.version }} · 启动 {{ i.startupTime }}</span>
      </div>

      <div class="oc-kvs">
        <div class="oc-kv"><span>状态</span><b>{{ i.status }} · {{ i.activeState }} · {{ i.dbStatus }}</b></div>
        <div class="oc-kv"><span>内存（SGA / PGA 目标）</span><b>{{ fmtSize(i.sgaMb) }} / {{ fmtSize(i.pgaMb) }}</b></div>
        <div class="oc-kv"><span>主机 CPU / 内存</span><b>{{ i.osCpus }} 核 · {{ i.osMemGb }} GB · load {{ i.load.toFixed(2) }}</b></div>
        <div class="oc-kv"><span>processes / sessions</span><b>{{ i.processes }} / {{ i.sessions }}</b></div>
        <div class="oc-kv"><span>优化器 / 游标共享</span><b>{{ i.optimizerMode }} · {{ i.cursorSharing }}</b></div>
        <div class="oc-kv"><span>兼容版本 / 块大小</span><b>{{ i.compat }} · {{ i.dbBlockSize }}</b></div>
        <div class="oc-kv"><span>UNDO / 临时表空间</span><b>{{ i.undoTablespace }} / {{ i.defaultTempTs || '—' }}</b></div>
        <div class="oc-kv"><span>open_cursors</span><b>{{ i.openCursors }}</b></div>
      </div>

      <div class="oc-cards">
        <div data-src="orInstSga" :data-ai="oraPickKey('instances', `sga.${i.instanceName}`)" data-ai-compact data-ai-name="SGA 组成">
          <div class="oc-card-h"><span>SGA 组成</span></div>
          <div class="oc-bars">
            <div v-for="s in i.sga" :key="s.name" class="oc-bar-row">
              <span>{{ s.name }}</span>
              <i><b :style="{ width: pct(s.mb, i.sgaMb) + '%' }"></b></i>
              <em>{{ fmtSize(s.mb) }}</em>
            </div>
          </div>
        </div>
        <div>
          <div data-src="orInstPga" :data-ai="oraPickKey('instances', `pga.${i.instanceName}`)" data-ai-compact data-ai-name="PGA">
            <div class="oc-card-h"><span>PGA</span></div>
            <div class="oc-bars">
              <div v-for="p in i.pga" :key="p.name" class="oc-bar-row">
                <span>{{ p.name }}</span>
                <i><b :style="{ width: pct(p.mb, i.pgaMb || p.mb) + '%' }"></b></i>
                <em>{{ fmtSize(p.mb) }}</em>
              </div>
            </div>
          </div>
          <div data-src="orInstBuf" :data-ai="oraPickKey('instances', `buffer.${i.instanceName}`)" data-ai-compact data-ai-name="缓冲池" style="margin-top: 10px">
            <div class="oc-card-h"><span>缓冲池</span></div>
            <div class="oc-bars">
              <div v-for="b in i.bufferHit" :key="b.name" class="oc-bar-row">
                <span>{{ b.name }}（miss {{ b.missPct.toFixed(2) }}%）</span>
                <i><b :class="b.missPct > 10 ? 'bad' : b.missPct > 5 ? 'warn' : ''" :style="{ width: Math.min(100, b.missPct * 5) + '%' }"></b></i>
                <em>{{ b.missPct.toFixed(2) }}%</em>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div data-src="orInstRes" :data-ai="oraPickKey('instances', `res.${i.instanceName}`)" data-ai-compact data-ai-name="资源使用">
        <div class="oc-card-h"><span>资源使用</span><span class="sp"></span><span class="oc-note">current / limit</span></div>
        <div class="oc-bars">
          <div v-for="r in i.resource" :key="r.name" class="oc-bar-row">
            <span>{{ r.name }}</span>
            <i><b :class="r.max > 0 && r.current / r.max > 0.9 ? 'bad' : r.max > 0 && r.current / r.max > 0.8 ? 'warn' : ''" :style="{ width: pct(r.current, r.max) + '%' }"></b></i>
            <em>{{ r.current }} / {{ r.max }}</em>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import { oraData } from '../../../cloud/oracle'

const d = computed(() => oraData('instances'))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

function fmtSize(mb: number): string {
  const n = Number(mb) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} TB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`
  return `${n.toFixed(0)} MB`
}
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
