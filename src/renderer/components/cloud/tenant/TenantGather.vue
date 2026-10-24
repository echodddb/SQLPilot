<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">统计信息（DBMS_STATS）</h4>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-for="(e, i) in bundle?.errors || []" :key="i" class="tp-warn">{{ e }}</div>

    <div class="tp-cards">
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">表总数</span>
        <div style="font-size:18px;font-weight:600">{{ bundle?.overview?.totalTables ?? '—' }}</div>
        <span class="tp-note">统计信息缺失会导致优化器选错执行计划</span>
      </div>
      <div v-for="b in bucketList" :key="b.days" class="tp-card">
        <span class="tp-dim" style="font-size:11px">{{ b.days }} 天未收集</span>
        <div style="font-size:18px;font-weight:600" :style="b.percent > 30 ? 'color:var(--yellow)' : ''">{{ b.count }} <span class="tp-dim" style="font-size:11px">张 · {{ b.percent }}%</span></div>
        <div class="tp-bar-meter"><i :class="b.percent > 50 ? 'bad' : b.percent > 20 ? 'warn' : ''" :style="`width:${Math.min(100, b.percent)}%`"></i></div>
      </div>
    </div>

    <h4 class="tp-h">自动收集窗口 <span class="cnt">{{ bundle?.windows.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap">
      <table class="tp-tbl">
        <thead><tr><th>窗口</th><th>状态</th><th>频率</th><th>下次开始</th><th class="r">时长</th></tr></thead>
        <tbody>
          <tr v-for="w in bundle?.windows || []" :key="w.windowName">
            <td class="tp-mono">{{ w.windowName }}</td>
            <td><span class="tp-chip" :style="w.enabled ? 'color:var(--green);border-color:var(--green)' : ''">{{ w.enabled ? '启用' : '停用' }}</span></td>
            <td class="tp-dim">{{ w.freq }}</td>
            <td class="tp-dim">{{ fmtTime(w.startDate) }}</td>
            <td class="r tp-mono">{{ Math.round(w.duration / 3600) }}h</td>
          </tr>
          <tr v-if="!(bundle?.windows || []).length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : '未返回自动收集窗口' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h">表统计明细 <span class="cnt">{{ (bundle?.tables || []).length }}</span></h4>
    <input v-model="q" class="tp-input tp-search" placeholder="过滤库 / 表" spellcheck="false" />
    <div class="tp-tbl-wrap tp-scroll-y" data-src="tnGather" :data-tenant="d.tenant.name">
      <table class="tp-tbl">
        <thead><tr><th>库</th><th>表</th><th>上次收集</th><th>状态</th><th class="r">行数</th></tr></thead>
        <tbody>
          <tr v-for="(t, i) in filteredTables" :key="`${t.database}-${t.table}-${i}`">
            <td class="tp-dim">{{ t.database || '—' }}</td>
            <td class="tp-mono">{{ t.table }}</td>
            <td class="tp-dim">{{ t.lastGatherTime ? fmtTime(t.lastGatherTime) : '—' }}</td>
            <td><span class="tp-chip" :style="t.stale ? 'color:var(--yellow);border-color:var(--yellow)' : ''">{{ t.stale ? '过期' : '正常' }}</span></td>
            <td class="r tp-mono">{{ t.rowCount.toLocaleString() }}</td>
          </tr>
          <tr v-if="!filteredTables.length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : '未返回表统计信息（可能是空租户或权限不足）' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h">收集策略参数</h4>
    <div class="tp-tbl-wrap">
      <table class="tp-tbl">
        <thead><tr><th>参数</th><th>默认值</th><th>取值范围</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="p in bundle?.prefs || []" :key="p.name">
            <td class="tp-mono">{{ p.name }}</td>
            <td class="tp-mono tp-dim">{{ p.defaultValue || '—' }}</td>
            <td class="tp-dim">{{ p.range || '—' }}</td>
            <td class="tp-dim ell" :title="p.description">{{ p.description || '—' }}</td>
          </tr>
          <tr v-if="!(bundle?.prefs || []).length"><td colspan="4" class="tp-empty">{{ loading ? '读取中…' : '无数据' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tp-note">
      手动收集走 stats/gather/manual（需要 owner 参数），SqlPilot 暂未开放写入口，执行请用「数据库控制台」里的
      <span class="tp-mono">CALL DBMS_STATS.GATHER_TABLE_STATS(...)</span>。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 统计信息：概况（各时间窗未收集比例）+ 自动收集窗口 + 表明细 + 策略参数 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtTime } from '../../../cloud/parts'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const bundle = ref<CloudTenantGatherBundle | null>(null)
const loading = ref(false)
const err = ref('')
const q = ref('')

const bucketList = computed(() => (bundle.value?.overview?.buckets || []).slice().sort((a, b) => a.days - b.days))

const filteredTables = computed(() => {
  const list = bundle.value?.tables || []
  const k = q.value.trim().toLowerCase()
  if (!k) return list
  return list.filter((t) => `${t.database} ${t.table}`.toLowerCase().includes(k))
})

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantGather(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { err.value = r.error || '读取统计信息失败'; return }
    bundle.value = r.data || null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>
