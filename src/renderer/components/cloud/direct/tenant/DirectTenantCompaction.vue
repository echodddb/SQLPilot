<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">合并</h4>
      <span v-if="major" class="tp-chip" :class="major.status === 'IDLE' ? 'ok' : 'warn'">major {{ major.status }}</span>
      <span v-if="major?.isSuspended === 'YES'" class="tp-chip warn">已暂停</span>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <!-- 集群级 major 状态：压成一行 8 格，别把下面的进度表顶出屏幕 -->
    <div v-if="major" class="tp-card">
      <div class="tp-kv-grid">
        <div class="tp-kv"><span>状态</span><b>{{ major.status || '—' }}</b></div>
        <div class="tp-kv"><span>是否出错</span><b :style="major.isError === 'YES' ? 'color:var(--red)' : ''">{{ major.isError || '—' }}</b></div>
        <div class="tp-kv"><span>已暂停</span><b>{{ major.isSuspended || '—' }}</b></div>
        <div class="tp-kv"><span>冻结版本 SCN</span><b class="mono">{{ major.frozenScn }}</b></div>
        <div class="tp-kv"><span>冻结时刻</span><b>{{ major.frozenTime || '—' }}</b></div>
        <div class="tp-kv"><span>最近开始</span><b>{{ major.startTime || '—' }}</b></div>
        <div class="tp-kv"><span>最近完成</span><b>{{ major.lastFinishTime || '—' }}</b></div>
        <div class="tp-kv"><span>备注</span><b>{{ major.info || '—' }}</b></div>
      </div>
    </div>

    <h4 class="tp-h" style="font-size:11.5px">本租户合并进度 <span class="cnt">{{ data?.progress.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:30vh">
      <table class="tp-tbl">
        <thead><tr><th>类型</th><th>Zone</th><th>状态</th><th class="r">Tablet（完成/总）</th><th class="r">数据量</th><th class="r">压缩比</th><th>开始时间</th><th>预计完成</th></tr></thead>
        <tbody>
          <tr v-for="(p, i) in data?.progress || []" :key="i">
            <td class="tp-mono">{{ p.type }}</td>
            <td class="tp-dim">{{ p.zone }}</td>
            <td><span class="tp-chip" :class="p.status === 'FINISH' ? 'ok' : 'warn'">{{ p.status }}</span></td>
            <td class="r tp-mono">{{ p.totalTablets - p.unfinishedTablets }} / {{ p.totalTablets }}</td>
            <td class="r tp-mono">{{ fmtBytes(p.dataSize) }}</td>
            <td class="r tp-mono">{{ p.compressionRatio ? p.compressionRatio.toFixed(2) : '—' }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ p.startTime || '—' }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ p.estimatedFinish || '—' }}</td>
          </tr>
          <tr v-if="!data?.progress.length"><td colspan="8" class="tp-empty">{{ loading ? '读取中…' : '没有合并进度记录' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h" style="font-size:11.5px">合并建议 <span class="cnt">{{ data?.suggestions.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:22vh">
      <table class="tp-tbl">
        <thead><tr><th>类型</th><th class="r">LS</th><th class="r">Tablet</th><th>建议</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="(s0, i) in data?.suggestions || []" :key="i">
            <td class="tp-mono">{{ s0.type }}</td>
            <td class="r tp-mono">{{ s0.lsId }}</td>
            <td class="r tp-mono">{{ s0.tabletId }}</td>
            <td class="tp-dim">{{ s0.suggestion }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ s0.startTime || s0.finishTime || '—' }}</td>
          </tr>
          <tr v-if="!data?.suggestions.length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : '没有待处理建议' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h" style="font-size:11.5px">合并相关参数</h4>
    <div class="tp-bar" style="flex-wrap:wrap">
      <span v-for="s in data?.settings || []" :key="s.name" class="tp-chip">
        <span class="tp-mono">{{ s.name }}</span>=<b>{{ s.value }}</b>
        <span class="tp-dim" style="font-size:9.5px">{{ s.scope }}</span>
      </span>
      <span v-if="!data?.settings.length" class="tp-note">没有读到参数（需要 sys 账号读 GV$OB_PARAMETERS）</span>
    </div>

    <div class="tp-note">
      进度来自 <code class="tp-mono">GV$OB_COMPACTION_PROGRESS WHERE TENANT_ID = {{ tenantId }}</code>；
      合并状态来自集群级的 <code class="tp-mono">DBA_OB_MAJOR_COMPACTION</code>（4.2 没有租户级 major 状态视图）。
      触发/暂停合并属于写操作，暂不在本页开放。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 直连租户 · 合并：进度 + 建议 + 相关参数（4.2 实测视图） */
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ platformId: string; tenantId: number; reloadToken: number }>()

const data = ref<CloudDirectCompaction | null>(null)
const loading = ref(false)
const err = ref('')

const major = computed(() => data.value?.major || null)

function fmtBytes(b: number): string {
  const n = Math.max(0, Number(b) || 0)
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectTenantCompaction(props.platformId, props.tenantId)
    if (!r.ok) { err.value = r.error || '读取合并信息失败'; data.value = null; return }
    data.value = r.data || null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.mono { font-family: var(--mono); }
</style>
