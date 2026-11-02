<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">资源管理</h4>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>

    <div v-if="needCred" class="tp-warn">
      资源隔离计划属于租户内部对象，要用该租户自己的账号连进去读。
      {{ err }}
      <div style="margin-top:6px">
        <button class="tp-btn sm primary" @click="emit('goto', 'connect')">去「连接」页录入凭据</button>
      </div>
    </div>
    <div v-else-if="err" class="tp-err">{{ err }}</div>

    <template v-if="!needCred">
    <h4 class="tp-h" style="font-size:11.5px">资源隔离计划 <span class="cnt">{{ data?.plans.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:26vh">
      <table class="tp-tbl">
        <thead><tr><th>计划</th><th class="r">指令数</th><th>状态</th><th>必选</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="p in data?.plans || []" :key="p.plan">
            <td class="tp-mono">{{ p.plan }}</td>
            <td class="r tp-mono">{{ p.directives ?? '—' }}</td>
            <td class="tp-dim">{{ p.status || '—' }}</td>
            <td class="tp-dim">{{ p.mandatory || '—' }}</td>
            <td class="tp-dim ell" style="max-width:280px">{{ p.comments || '—' }}</td>
          </tr>
          <tr v-if="!(data?.plans || []).length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : '该租户没有资源隔离计划' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h" style="font-size:11.5px">计划指令 <span class="cnt">{{ data?.directives.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:26vh">
      <table class="tp-tbl">
        <thead><tr><th>计划</th><th>资源组</th><th>类型</th><th class="r">CPU_P1</th><th class="r">CPU_P2</th><th class="r">MGMT_P1</th><th class="r">MAX_IOPS</th></tr></thead>
        <tbody>
          <tr v-for="(d0, i) in data?.directives || []" :key="`${d0.plan}-${d0.group}-${i}`">
            <td class="tp-mono">{{ d0.plan }}</td>
            <td class="tp-mono">{{ d0.group }}</td>
            <td class="tp-dim">{{ d0.type || '—' }}</td>
            <td class="r tp-mono">{{ d0.cpuP1 }}</td>
            <td class="r tp-mono">{{ d0.cpuP2 }}</td>
            <td class="r tp-mono">{{ d0.mgmtP1 }}</td>
            <td class="r tp-mono">{{ d0.maxIops ?? '—' }}</td>
          </tr>
          <tr v-if="!(data?.directives || []).length"><td colspan="7" class="tp-empty">{{ loading ? '读取中…' : '没有计划指令' }}</td></tr>
        </tbody>
      </table>
    </div>

    <h4 class="tp-h" style="font-size:11.5px">资源组 <span class="cnt">{{ data?.groups.length || 0 }}</span></h4>
    <div class="tp-tbl-wrap" style="max-height:24vh">
      <table class="tp-tbl">
        <thead><tr><th>资源组</th><th class="r">ID</th><th>内部使用</th><th>说明</th></tr></thead>
        <tbody>
          <tr v-for="g in data?.groups || []" :key="g.id">
            <td class="tp-mono">{{ g.name }}</td>
            <td class="r tp-mono">{{ g.id }}</td>
            <td class="tp-dim">{{ g.internal || '—' }}</td>
            <td class="tp-dim ell" style="max-width:300px">{{ g.comments || '—' }}</td>
          </tr>
          <tr v-if="!(data?.groups || []).length"><td colspan="4" class="tp-empty">{{ loading ? '读取中…' : '没有资源组' }}</td></tr>
        </tbody>
      </table>
    </div>

    </template>

    <div class="tp-note">
      数据源（在租户内部执行）：<code class="tp-mono">DBA_RSRC_PLANS</code> /
      <code class="tp-mono">DBA_RSRC_PLAN_DIRECTIVES</code> /
      <code class="tp-mono">DBA_RSRC_CONSUMER_GROUPS</code> /
      <code class="tp-mono">DBA_OB_RSRC_IO_DIRECTIVES</code>（4.2.1 实测；OCP 文档里写的
      <code class="tp-mono">DBA_OB_RSRC_PLANS</code> 在直连库里不存在）。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 直连租户 · 资源管理：资源隔离计划 / 指令 / 资源组 / IO 指令（需租户凭据） */
import { computed, onMounted, ref, watch } from 'vue'

const props = defineProps<{ platformId: string; tenantName: string; reloadToken: number }>()
const emit = defineEmits<{ (e: 'goto', tab: string): void }>()

const data = ref<CloudDirectRsrc | null>(null)
const loading = ref(false)
const err = ref('')
const needCred = computed(() => /凭据|credential|登录/i.test(err.value))

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.cloudDirectTenantRsrc(props.platformId, props.tenantName)
    if (!r.ok) { err.value = r.error || '读取资源管理数据失败'; data.value = null; return }
    data.value = r.data || null
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
watch(() => props.tenantName, load)
</script>
