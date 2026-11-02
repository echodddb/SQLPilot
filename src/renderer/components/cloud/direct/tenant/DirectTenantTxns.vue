<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">事务 <span class="cnt">{{ rows.length }}</span></h4>
      <input v-model="q" class="tp-input tp-search" placeholder="过滤事务 ID / 会话" spellcheck="false" />
      <span class="sp"></span>
      <span class="tp-note">最多 200 条，按最近请求时间倒序</span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <div class="tp-tbl-wrap tp-scroll-y">
      <table class="tp-tbl">
        <thead>
          <tr><th>会话</th><th>事务 ID</th><th>状态</th><th>类型</th><th class="r">LS</th><th>创建时间</th><th>最近请求</th><th>OBServer</th></tr>
        </thead>
        <tbody>
          <tr v-for="x in filtered" :key="`${x.svrIp}:${x.sessionId}:${x.txId}`">
            <td class="tp-mono">{{ x.sessionId }}</td>
            <td class="tp-mono ell" :title="x.txId" style="max-width:220px">{{ x.txId }}</td>
            <td><span class="tp-chip" :class="x.state === 'ACTIVE' ? 'ok' : 'idle'">{{ x.state || '—' }}</span></td>
            <td class="tp-dim">{{ x.txType || '—' }}</td>
            <td class="r tp-mono">{{ x.lsId }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ x.createTime || '—' }}</td>
            <td class="tp-dim" style="font-size:10.5px">{{ x.lastRequestTime || '—' }}</td>
            <td class="tp-mono tp-dim">{{ x.svrIp }}:{{ x.svrPort }}</td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="8" class="tp-empty">{{ loading ? '读取中…' : '当前没有活跃事务（空表 = 没有未提交事务）' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="tp-note">
      数据源 <code class="tp-mono">GV$OB_TRANSACTION_PARTICIPANTS WHERE TENANT_ID = {{ tenantId }}</code>。
      4.2 里没有 <code class="tp-mono">GV$OB_TRANS_STAT</code>，所以这里不展示提交/回滚计数；
      需要看历史请用「SQL 诊断」里的审计数据。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 直连租户 · 事务：GV$OB_TRANSACTION_PARTICIPANTS（按 TENANT_ID 过滤） */
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ platformId: string; tenantId: number; reloadToken: number }>()

const rows = ref<CloudDirectTxn[]>([])
const loading = ref(false)
const err = ref('')
const q = ref('')

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return rows.value
  return rows.value.filter((x) => `${x.txId} ${x.sessionId} ${x.state}`.toLowerCase().includes(k))
})

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectTenantTxns(props.platformId, props.tenantId, 200)
    if (!r.ok) { err.value = r.error || '读取事务失败'; rows.value = []; return }
    rows.value = r.data || []
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>
