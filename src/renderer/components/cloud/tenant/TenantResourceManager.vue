<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">资源管理</h4>
      <div class="seg">
        <button class="tp-btn sm" :class="{ primary: kind === 'plan' }" @click="kind = 'plan'">资源隔离计划</button>
        <button class="tp-btn sm" :class="{ primary: kind === 'group' }" @click="kind = 'group'">资源组</button>
      </div>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>

    <div v-if="err" class="tp-warn">
      {{ err }}
      <div v-if="needCred" class="tp-note" style="margin-top:5px">
        这是 OCP 侧的凭据要求，不是本工具的权限问题：到 OCP 的「凭据管理」里为该租户添加 root 密码，
        或在本页下方「租户凭据」录入（凭据保存在本机，用于 OCP 直连操作）后再刷新。
      </div>
    </div>

    <div class="tp-tbl-wrap tp-scroll-y" :data-src="kind === 'plan' ? 'tnRsrcPlans' : 'tnRsrcGroups'" :data-tenant="d.tenant.name">
      <table class="tp-tbl">
        <thead>
          <tr>
            <th>名称</th>
            <th>目标 / 规则</th>
            <th>状态</th>
            <th>备注</th>
            <th class="r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="x in list" :key="x.name">
            <td class="tp-mono">{{ x.name }}</td>
            <td class="tp-dim">{{ x.targetTenant || '—' }}</td>
            <td>
              <span v-if="x.enabled === null" class="tp-chip idle">—</span>
              <span v-else class="tp-chip" :class="x.enabled ? 'ok' : 'idle'">{{ x.enabled ? '启用' : '停用' }}</span>
            </td>
            <td class="tp-dim ell" style="max-width:280px">{{ x.comment || '—' }}</td>
            <td class="r" @click.stop>
              <template v-if="kind === 'plan'">
                <button class="tp-btn sm" @click="act(x, x.enabled ? 'disable' : 'enable')">{{ x.enabled ? '停用' : '启用' }}</button>
                <button class="tp-btn sm danger" @click="remove(x)">删除</button>
              </template>
              <span v-else class="tp-note">只读</span>
            </td>
          </tr>
          <tr v-if="!list.length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : err ? '读取失败' : '暂无数据' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="tp-note">
      资源隔离计划（<code class="tp-mono">GET /tenants/{tid}/resourcePlans</code>）与资源组
      （<code class="tp-mono">/consumerGroups</code>）都从 OCP 4.3 实测：GET 列表、POST 启停、DELETE 删除。
      部分租户（尤其 Metac 集群上的）会返回 <b>428</b> —— OCP 要求先登记该租户的 root 密码，不是本工具的权限问题。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 资源管理：资源隔离计划 + 资源组（读列表 / 启停 / 删除计划） */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const kind = ref<'plan' | 'group'>('plan')
const plans = ref<CloudTenantResourcePlan[]>([])
const groups = ref<CloudTenantResourcePlan[]>([])
const loading = ref(false)
const err = ref('')
const needCred = computed(() => /凭据|credential|428/i.test(err.value))
const list = computed(() => (kind.value === 'plan' ? plans.value : groups.value))

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const [a, b] = await Promise.all([
      window.sqlpilot.cloudTenantResourcePlans(cloud.activeId, t.clusterId, t.id),
      window.sqlpilot.cloudTenantConsumerGroups(cloud.activeId, t.clusterId, t.id)
    ])
    plans.value = a.ok ? a.data || [] : []
    groups.value = b.ok ? b.data || [] : []
    // 两个都失败时只报第一个，避免重复提示
    if (!a.ok && !b.ok) err.value = a.error || b.error || '读取资源管理数据失败'
    else if (!a.ok) err.value = a.error || ''
    else if (!b.ok) err.value = b.error || ''
  } finally {
    loading.value = false
  }
}

async function act(x: CloudTenantResourcePlan, action: 'enable' | 'disable'): Promise<void> {
  const t = d.value.tenant
  const r = await window.sqlpilot.cloudTenantResourcePlanAction(cloud.activeId, t.clusterId, t.id, x.name, action)
  if (!r.ok) { await window.sqlpilot.uiAlert('操作失败', r.error || 'OCP 返回错误'); return }
  pushNotice(`${action === 'enable' ? '已启用' : '已停用'}计划 ${x.name}`)
  await load()
}

async function remove(x: CloudTenantResourcePlan): Promise<void> {
  const t = d.value.tenant
  const ok = await window.sqlpilot.uiConfirm(`删除资源隔离计划「${x.name}」？`, '删除后该计划的资源限制立即失效。', true)
  if (!ok) return
  const r = await window.sqlpilot.cloudTenantDropResourcePlan(cloud.activeId, t.clusterId, t.id, x.name)
  if (!r.ok) { await window.sqlpilot.uiAlert('删除失败', r.error || 'OCP 返回错误'); return }
  pushNotice(`计划 ${x.name} 已删除`)
  await load()
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.seg { display: flex; gap: 4px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); }
</style>
