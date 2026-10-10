<template>
  <div class="res-panel">
    <div class="res-head">
      <span class="res-title">本机资源</span>
      <span v-if="r" class="res-meta">
        {{ r.sys.hostname }} · {{ r.sys.platform }} · 开机 {{ fmtUptime(r.sys.uptimeSec) }}
      </span>
      <span style="flex:1"></span>
      <span class="res-meta" title="每 2 秒自动刷新">{{ refreshing ? '刷新中…' : `更新于 ${lastTick}` }}</span>
      <button class="icon-btn" title="关闭面板" @click="$emit('close')">✕</button>
    </div>

    <div v-if="r" class="res-body">
      <div class="res-card">
        <div class="res-card-head">
          <b>CPU</b>
          <span class="res-val" :class="pctClass(r.cpu.usagePct)">{{ r.cpu.usagePct == null ? '—' : r.cpu.usagePct + '%' }}</span>
        </div>
        <div class="res-sub" :title="r.cpu.model">{{ r.cpu.model }}</div>
        <div class="res-bar"><div class="res-fill" :class="pctClass(r.cpu.usagePct)" :style="{ width: (r.cpu.usagePct || 0) + '%' }"></div></div>
        <div class="res-cores" v-if="r.cpu.perCore.length">
          <div v-for="(c, i) in r.cpu.perCore" :key="i" class="core-col" :title="`核 ${i + 1}：${c}%`">
            <div class="core-bar" :class="pctClass(c)" :style="{ height: Math.max(3, c * 0.32) + 'px' }"></div>
          </div>
          <span class="res-sub" style="margin-left:6px">{{ r.cpu.cores }} 线程</span>
        </div>
      </div>

      <div class="res-card">
        <div class="res-card-head">
          <b>内存</b>
          <span class="res-val" :class="pctClass(r.mem.usedPct)">{{ r.mem.usedPct }}%</span>
        </div>
        <div class="res-sub">{{ fmtGB(r.mem.totalBytes - r.mem.freeBytes) }} / {{ fmtGB(r.mem.totalBytes) }}</div>
        <div class="res-bar"><div class="res-fill" :class="pctClass(r.mem.usedPct)" :style="{ width: r.mem.usedPct + '%' }"></div></div>
        <div class="res-sub">可用 {{ fmtGB(r.mem.freeBytes) }}</div>
      </div>

      <div class="res-card disks">
        <div class="res-card-head">
          <b>磁盘</b>
          <span class="res-sub">{{ r.disks.length }} 个卷</span>
        </div>
        <div class="disk-list">
          <div v-for="d in r.disks" :key="d.drive" class="disk-row" :title="`${d.drive} 总 ${fmtGB(d.totalBytes)}，可用 ${fmtGB(d.freeBytes)}`">
            <span class="disk-drive">{{ d.drive }}</span>
            <div class="res-bar" style="flex:1"><div class="res-fill" :class="pctClass(d.usedPct)" :style="{ width: d.usedPct + '%' }"></div></div>
            <span class="res-val small" :class="pctClass(d.usedPct)">{{ d.usedPct }}%</span>
            <span class="disk-free">剩 {{ fmtGB(d.freeBytes) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="r" class="res-foot">
      SQLPilot 进程：内存 {{ fmtMB(r.app.rssBytes) }}<template v-if="r.app.cpuPct != null"> · CPU {{ r.app.cpuPct }}%（单核基准）</template>
    </div>
    <div v-else class="res-foot">加载中…</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { store } from '../store'

defineEmits<{ (e: 'close'): void }>()

const r = ref<Awaited<ReturnType<typeof window.sqlpilot.sysResources>> | null>(null)
const refreshing = ref(false)
const lastTick = ref('')

let timer: ReturnType<typeof setInterval> | null = null

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    r.value = await window.sqlpilot.sysResources()
    const d = new Date()
    lastTick.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  } finally {
    refreshing.value = false
  }
}

// 面板可见才轮询（组件常驻挂载、v-show 隐藏时停表，不做无谓采样——
// CPU 差分窗口也由此保持在 2s，隐藏再打开的第一帧显示上一窗口的值）
function syncTimer(): void {
  const visible = store.workbench === 'resources'
  if (visible && !timer) {
    timer = setInterval(refresh, 2000)
    refresh()
  } else if (!visible && timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(() => store.workbench, syncTimer, { immediate: true })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

function pctClass(pct: number | null): string {
  if (pct == null) return ''
  return pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
}
function fmtGB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1) + ' GB'
}
function fmtMB(bytes: number): string {
  return Math.round(bytes / 1024 ** 2).toLocaleString() + ' MB'
}
function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${Math.floor((sec % 3600) / 60)} 分` : `${Math.floor(sec / 60)} 分`
}
</script>

<style scoped>
.res-panel {
  border-top: 1px solid var(--border);
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  height: 232px;
  flex-shrink: 0;
}
.res-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px 5px;
  border-bottom: 1px solid var(--border);
}
.res-title { font-size: 12.5px; font-weight: 700; }
.res-meta { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.res-body {
  display: flex;
  gap: 12px;
  padding: 10px 14px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.res-card {
  flex: 1;
  min-width: 200px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg);
}
.res-card.disks { flex: 1.4; }
.res-card-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 12px; }
.res-val { font-family: var(--mono); font-size: 15px; font-weight: 700; }
.res-val.small { font-size: 11.5px; }
.res-val.ok { color: var(--green); }
.res-val.warn { color: var(--yellow); }
.res-val.danger { color: var(--red); }
.res-sub { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.res-bar {
  height: 7px;
  border-radius: 99px;
  background: var(--bg-input);
  overflow: hidden;
  min-width: 60px;
}
.res-fill { height: 100%; border-radius: 99px; transition: width 0.6s ease; }
.res-fill.ok { background: var(--green); }
.res-fill.warn { background: var(--yellow); }
.res-fill.danger { background: var(--red); }
.res-cores { display: flex; align-items: flex-end; gap: 2px; flex: 1; min-height: 34px; }
.core-col { flex: 1; display: flex; align-items: flex-end; height: 100%; }
.core-bar { width: 100%; border-radius: 2px; min-height: 3px; transition: height 0.6s ease; }
.core-bar.ok { background: var(--accent); opacity: 0.75; }
.core-bar.warn { background: var(--yellow); }
.core-bar.danger { background: var(--red); }
.disk-list { display: flex; flex-direction: column; gap: 7px; overflow: auto; flex: 1; }
.disk-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
.disk-drive { font-family: var(--mono); font-weight: 700; width: 22px; }
.disk-free { color: var(--text-faint); font-size: 11px; width: 76px; text-align: right; white-space: nowrap; }
.res-foot {
  padding: 4px 14px 6px;
  border-top: 1px dashed var(--border);
  font-size: 11px;
  color: var(--text-faint);
}
</style>
