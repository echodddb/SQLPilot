<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">备份与恢复</h4>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-for="(e, i) in bundle?.errors || []" :key="i" class="tp-warn">{{ e }}</div>

    <div class="tp-cards">
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">备份总状态</span>
        <div style="font-size:15px;font-weight:600" :style="statusTone">{{ ov?.backupStatus || '—' }}</div>
        <span class="tp-note">调度：{{ ov?.backupScheduleStatus || '—' }} · 合并：{{ ov?.compactionStatus || '—' }}</span>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">备份能力</span>
        <div style="font-size:15px;font-weight:600">{{ ability?.backupAbility || '—' }}</div>
        <span class="tp-note">
          {{ ability?.canDoIncrementalBackup ? '支持增量备份' : '仅支持全量备份' }}
          · {{ ability?.incrementBackupEnabled ? '增量已启用' : '增量未启用' }}
        </span>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">本租户备份策略</span>
        <div style="font-size:15px;font-weight:600">{{ strategy?.backupEnabled ? (strategy.physical ? '物理备份' : strategy.logical ? '逻辑备份' : '已启用') : '未配置' }}</div>
        <span class="tp-note">保留策略 {{ strategy?.retainMode || '—' }} · 自动合并 {{ strategy?.autoCompactEnabled ? '开' : '关' }}</span>
      </div>
      <div class="tp-card">
        <span class="tp-dim" style="font-size:11px">OB 版本下限</span>
        <div class="tp-mono" style="font-size:12px">{{ ov?.obVersion || '—' }}</div>
        <span class="tp-note">集群 {{ ov?.clusterName || d.tenant.clusterName }}</span>
      </div>
    </div>

    <div v-if="ability?.hint" class="tp-note" style="color:var(--text-dim)">OCP 提示：{{ ability.hint }}</div>

    <h4 class="tp-h">数据备份任务 <span class="cnt">{{ (bundle?.dataTasks || []).length }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:30vh">
      <table class="tp-tbl">
        <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>开始</th><th>结束</th><th class="r">数据量</th><th>结果</th><th>信息</th></tr></thead>
        <tbody>
          <tr v-for="(t, i) in bundle?.dataTasks || []" :key="`d-${t.id}-${i}`">
            <td class="tp-mono">#{{ t.id }}</td>
            <td class="tp-dim">{{ t.type || '—' }}</td>
            <td><span class="tp-chip">{{ t.status || '—' }}</span></td>
            <td class="tp-dim">{{ t.startTime ? fmtTime(t.startTime) : '—' }}</td>
            <td class="tp-dim">{{ t.endTime ? fmtTime(t.endTime) : '—' }}</td>
            <td class="r tp-mono">{{ t.size ? fmtBytes(t.size) : '—' }}</td>
            <td>{{ t.result || '—' }}</td>
            <td class="tp-dim ell" :title="t.message">{{ t.message || '—' }}</td>
          </tr>
          <tr v-if="!(bundle?.dataTasks || []).length"><td colspan="8" class="tp-empty">{{ loading ? '读取中…' : '没有数据备份任务' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h">日志备份任务 <span class="cnt">{{ (bundle?.logTasks || []).length }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:26vh">
      <table class="tp-tbl">
        <thead><tr><th>任务</th><th>状态</th><th>开始</th><th>结束</th><th>结果</th><th>信息</th></tr></thead>
        <tbody>
          <tr v-for="(t, i) in bundle?.logTasks || []" :key="`l-${t.id}-${i}`">
            <td class="tp-mono">#{{ t.id }}</td>
            <td><span class="tp-chip">{{ t.status || '—' }}</span></td>
            <td class="tp-dim">{{ t.startTime ? fmtTime(t.startTime) : '—' }}</td>
            <td class="tp-dim">{{ t.endTime ? fmtTime(t.endTime) : '—' }}</td>
            <td>{{ t.result || '—' }}</td>
            <td class="tp-dim ell" :title="t.message">{{ t.message || '—' }}</td>
          </tr>
          <tr v-if="!(bundle?.logTasks || []).length"><td colspan="6" class="tp-empty">{{ loading ? '读取中…' : '没有日志备份任务' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="tp-note">
      「立即备份」在 OCP 里需要完整的存储配置（backupMode / dataBackupMode / 存储凭据 / 备份对象），
      参数缺失时后端会拒单；SqlPilot 只做状态与任务展示，配置与发起请在 OCP 控制台完成。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 备份：集群备份能力 + 本租户策略 + 数据/日志备份任务 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtBytes, fmtTime } from '../../../cloud/parts'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const bundle = ref<CloudTenantBackupBundle | null>(null)
const loading = ref(false)
const err = ref('')

const ov = computed(() => bundle.value?.overview || null)
const ability = computed(() => bundle.value?.ability || null)
const strategy = computed(() => bundle.value?.strategy || null)

const statusTone = computed(() => {
  const s = String(ov.value?.backupStatus || '')
  if (/NO_BACKUP|FAIL|ERROR/i.test(s)) return 'color:var(--red)'
  if (/RUNNING|DOING/i.test(s)) return 'color:var(--yellow)'
  if (/SUCCESS|AVAILABLE|NORMAL/i.test(s)) return 'color:var(--green)'
  return ''
})

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantBackup(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { err.value = r.error || '读取备份信息失败'; return }
    bundle.value = r.data || null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>
