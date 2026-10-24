<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">租户参数 <span v-if="params.length" class="cnt">{{ filtered.length }} / {{ params.length }}</span></h4>
      <input v-model="q" class="tp-input tp-search" placeholder="过滤参数名 / 值 / 说明" spellcheck="false" :disabled="!params.length" />
      <label class="chk"><input v-model="onlyChanged" type="checkbox" />只看已修改</label>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : params.length ? '刷新' : '加载参数' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="msg" class="tp-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

    <div class="tp-tbl-wrap tp-scroll-y" data-src="tnParams" :data-tenant="d.tenant.name" :data-detail="`已加载 ${params.length} 个参数|租户 ${d.tenant.name}（OB 租户 ID ${d.tenant.obTenantId}）`">
      <table class="tp-tbl">
        <thead><tr><th style="width:34%">参数</th><th>当前值</th><th>默认值</th><th>类型</th><th></th></tr></thead>
        <tbody>
          <tr v-for="p in filtered" :key="p.name">
            <td class="tp-mono" :title="p.description">{{ p.name }}<div v-if="p.description" class="tp-note" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ p.description }}</div></td>
            <template v-if="edit?.name === p.name">
              <td colspan="2"><input v-model="edit.value" class="tp-input tp-mono" style="width:100%" spellcheck="false" @keyup.enter="save" @keyup.esc="edit = null" /></td>
              <td class="tp-dim">{{ p.type || '—' }}</td>
              <td>
                <button class="tp-btn sm primary" :disabled="busy" @click="save">保存</button>
                <button class="tp-btn sm" @click="edit = null">取消</button>
              </td>
            </template>
            <template v-else>
              <td class="tp-mono" :class="p.value !== p.def ? 'changed' : ''" :title="p.value">{{ p.value || '—' }}</td>
              <td class="tp-mono tp-faint" :title="p.def">{{ p.def || '—' }}</td>
              <td class="tp-dim">{{ p.type || '—' }}</td>
              <td><button class="tp-btn sm" @click="edit = { name: p.name, value: p.value }">改</button></td>
            </template>
          </tr>
          <tr v-if="!filtered.length"><td colspan="5" class="tp-empty">{{ loading ? '读取中…' : params.length ? '没有匹配的参数' : '点「加载参数」读取（约 200+ 项，首次稍慢）' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="tp-note">
      参数修改走 OCP 的 PUT /tenants/{tid}/parameters（body 顶层数组 [{name,value}]），按参数名下发给租户内全部 OBServer。
      部分参数需要重启或仅在新建 session 生效，改动前建议确认 EDIT_LEVEL。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 租户参数：查看 / 过滤 / 行内修改（PUT /parameters） */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud, tenantUpdateParams } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const params = ref<{ name: string; value: string; def: string; type: string; description: string }[]>([])
const loading = ref(false)
const err = ref('')
const msg = ref('')
const msgOk = ref(true)
const busy = ref(false)
const q = ref('')
const onlyChanged = ref(false)
const edit = ref<{ name: string; value: string } | null>(null)

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  let list = params.value
  if (onlyChanged.value) list = list.filter((p) => p.value !== p.def)
  if (!k) return list
  return list.filter((p) => `${p.name} ${p.value} ${p.description}`.toLowerCase().includes(k))
})

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  msg.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantParams(cloud.activeId, t.clusterId, t.id)
    if (!r.ok || !r.data) { err.value = r.error || '读取参数失败'; return }
    params.value = r.data
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  const t = d.value.tenant
  const e = edit.value
  if (!e) return
  const old = params.value.find((x) => x.name === e.name)
  if (old && e.value === old.value) { edit.value = null; return }
  busy.value = true
  msg.value = ''
  try {
    const r = await tenantUpdateParams(t.clusterId, t.id, [{ name: e.name, value: e.value }])
    if (!r.ok) { msg.value = r.error || '修改失败'; msgOk.value = false; return }
    pushNotice(`参数 ${e.name} 已修改`)
    msg.value = `参数 ${e.name} 修改已提交`
    msgOk.value = true
    edit.value = null
    await load()
  } finally {
    busy.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
.chk input { width: auto; accent-color: var(--accent); }
.changed { color: var(--accent); }
</style>
