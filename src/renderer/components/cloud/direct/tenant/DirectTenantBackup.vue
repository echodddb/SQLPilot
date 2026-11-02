<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">备份 <span class="cnt">{{ data?.jobs.length || 0 }}</span></h4>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <div v-if="data && !data.available" class="tp-warn">{{ data.note }}</div>
    <div v-else-if="data?.note" class="tp-note">{{ data.note }}</div>

    <div class="tp-tbl-wrap tp-scroll-y">
      <table class="tp-tbl">
        <thead><tr><th class="r">任务</th><th>类型</th><th>级别</th><th>状态</th><th>结果</th><th>开始</th><th>结束</th><th>路径</th></tr></thead>
        <tbody>
          <tr v-for="j in data?.jobs || []" :key="j.jobId">
            <td class="r tp-mono">{{ j.jobId }}</td>
            <td class="tp-dim">{{ j.backupType || '—' }}</td>
            <td class="tp-dim">{{ j.level || '—' }}</td>
            <td><span class="tp-chip" :class="j.status === 'COMPLETED' ? 'ok' : j.status === 'FAILED' ? 'bad' : 'warn'">{{ j.status || '—' }}</span></td>
            <td class="tp-dim">{{ j.result || '—' }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ j.startTime || '—' }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ j.endTime || '—' }}</td>
            <td class="tp-mono ell tp-dim" style="max-width:260px" :title="j.path">{{ j.path || '—' }}</td>
          </tr>
          <tr v-if="!(data?.jobs || []).length"><td colspan="8" class="tp-empty">{{ loading ? '读取中…' : '没有备份任务' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h" style="font-size:11.5px">备份参数 <span class="cnt">{{ data?.params.length || 0 }}</span></h4>
    <div class="tp-bar" style="flex-wrap:wrap">
      <span v-for="p in data?.params || []" :key="p.name" class="tp-chip">
        <span class="tp-mono">{{ p.name }}</span>=<b>{{ p.value }}</b>
      </span>
      <span v-if="!(data?.params || []).length" class="tp-note">没读到备份参数（未配置备份时为空）</span>
    </div>

    <div class="tp-note">
      数据源 <code class="tp-mono">CDB_OB_BACKUP_JOBS WHERE TENANT_ID = {{ tenantId }}</code> 与
      <code class="tp-mono">DBA_OB_BACKUP_PARAMETER</code>（sys 身份读）。
      直连模式只做查看：立即备份 / 恢复要走 <code class="tp-mono">ALTER SYSTEM BACKUP</code> 一类写语句，未在本页开放。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 直连租户 · 备份：任务列表 + 备份参数（只读） */
import { onMounted, ref, watch } from 'vue'

const props = defineProps<{ platformId: string; tenantId: number; reloadToken: number }>()

const data = ref<CloudDirectBackup | null>(null)
const loading = ref(false)
const err = ref('')

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectTenantBackup(props.platformId, props.tenantId)
    if (!r.ok) { err.value = r.error || '读取备份信息失败'; data.value = null; return }
    data.value = r.data || null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>
