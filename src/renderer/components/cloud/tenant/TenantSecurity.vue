<template>
  <div class="tp-pane">
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="msg" class="tp-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

    <!-- 访问控制 -->
    <h4 class="tp-h">访问控制</h4>
    <div class="tp-card">
      <label class="frow">访问白名单（逗号分隔 IP / CIDR，% 表示不限制）
        <textarea v-model="whitelist" rows="2" class="tp-textarea mono" spellcheck="false"></textarea>
      </label>
      <div class="tp-bar">
        <span class="tp-note">只有白名单内的地址能连到该租户。多网段用英文逗号分隔，例如 <span class="tp-mono">10.0.0.0/8,192.168.1.5</span></span>
        <span class="sp"></span>
        <button class="tp-btn" :disabled="busy || !wlDirty" @click="resetWl">还原</button>
        <button class="tp-btn primary" :disabled="busy || !whitelist.trim() || !wlDirty" @click="saveWhitelist">保存白名单</button>
      </div>
    </div>

    <!-- 管理员密码 -->
    <h4 class="tp-h">管理员密码</h4>
    <div class="tp-card">
      <div class="grid">
        <label class="frow">root@{{ t.name }} 新密码
          <input v-model="pwd" type="password" class="tp-input" placeholder="OCP 会校验密码强度" />
        </label>
        <label class="frow">确认新密码
          <input v-model="pwd2" type="password" class="tp-input" />
        </label>
      </div>
      <div class="tp-bar">
        <span class="tp-note">新密码立即生效；已建立的连接不受影响，重连需使用新密码。密码会按 OCP 要求 RSA 加密后提交。</span>
        <span class="sp"></span>
        <button class="tp-btn primary" :disabled="busy || !pwd || pwd !== pwd2" @click="savePwd">
          {{ pwd && pwd2 && pwd !== pwd2 ? '两次输入不一致' : '修改密码' }}
        </button>
      </div>
    </div>

    <!-- 锁定 -->
    <h4 class="tp-h">租户锁定</h4>
    <div class="tp-card">
      <div class="tp-bar">
        <span class="tp-chip" :style="t.locked ? 'color:var(--yellow);border-color:var(--yellow)' : ''">{{ t.locked ? '已锁定（禁止写入）' : '正常（可读写）' }}</span>
        <span class="sp"></span>
        <button class="tp-btn" :class="{ danger: !t.locked }" :disabled="busy" @click="toggleLock">
          {{ t.locked ? '解锁租户' : '锁定租户' }}
        </button>
      </div>
      <div class="tp-note">锁定的租户无法写入，常用于变更前的保护动作；sys / meta 等系统租户 OCP 会直接拒绝。</div>
    </div>

    <!-- 透明加密 -->
    <h4 class="tp-h">透明加密（TDE）</h4>
    <div class="tp-card">
      <div v-if="tdeLoading" class="tp-note">读取中…</div>
      <template v-else-if="tde">
        <div class="tp-bar">
          <span class="tp-chip" :style="tde.enabled ? 'color:var(--green);border-color:var(--green)' : /ENABLING/i.test(tde.status) ? 'color:var(--yellow);border-color:var(--yellow)' : ''">
            {{ tde.enabled ? '已启用' : tde.status }}
          </span>
          <span class="tp-chip">密钥类型 {{ tde.secretKeyType }}</span>
          <span class="tp-chip">KMS {{ tde.kmsValidType }}</span>
          <span class="tp-chip">OB {{ tde.obVersion }}</span>
        </div>
        <div class="tp-note">
          TDE 开启后**不可回退**（OB 不支持关闭数据加密），一旦开启需要配套的密钥管理与备份策略。
          SqlPilot 只展示状态，不提供开启入口；需要开启请在 OCP 的「安全」页操作。
        </div>
      </template>
      <div v-else-if="!tdeErr" class="tp-note">OCP 未返回该租户的 TDE 信息（低版本 OCP 或权限不足）。</div>
      <div v-if="tdeErr" class="tp-err">{{ tdeErr }}</div>
    </div>

    <!-- 描述 -->
    <h4 class="tp-h">租户描述</h4>
    <div class="tp-card">
      <div class="tp-note">{{ d.description || '（未设置描述）' }}</div>
      <div class="tp-note" style="color:var(--text-faint)">描述在 OCP 里随 modifyTenant 一起提交；SqlPilot 暂不支持修改。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 安全：访问白名单、管理员改密、锁定/解锁、TDE 状态展示。
 * TDE 只读——OB 开启加密后无法回退，不在此处提供开启入口。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud, refreshTenant, tenantChangePassword, tenantModifyWhitelist, tenantSetLocked } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)
const t = computed(() => d.value.tenant)

const busy = ref(false)
const msg = ref('')
const msgOk = ref(true)
const err = ref('')

const whitelist = ref(d.value.whitelist || '')
const wlDirty = computed(() => whitelist.value.trim() !== (d.value.whitelist || '').trim())

const pwd = ref('')
const pwd2 = ref('')

const tde = ref<CloudTenantTde | null>(null)
const tdeLoading = ref(false)
const tdeErr = ref('')

function resetWl(): void {
  whitelist.value = d.value.whitelist || ''
}
function tip(text: string, ok: boolean): void {
  msg.value = text
  msgOk.value = ok
}

async function saveWhitelist(): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    const r = await tenantModifyWhitelist(t.value.clusterId, t.value.id, whitelist.value)
    if (!r.ok) { tip(r.error || '修改白名单失败', false); return }
    pushNotice('白名单已更新')
    tip('白名单已更新', true)
    await refreshTenant()
  } finally {
    busy.value = false
  }
}

async function savePwd(): Promise<void> {
  if (!pwd.value || pwd.value !== pwd2.value) return
  const ok = await window.sqlpilot.uiConfirm(`修改租户「${t.value.name}」管理员密码？`, '新密码立即生效，正在使用旧密码的连接不受影响，但重连需用新密码。')
  if (!ok) return
  busy.value = true
  msg.value = ''
  try {
    const r = await tenantChangePassword(t.value.clusterId, t.value.id, pwd.value)
    if (!r.ok) { tip(r.error || '修改密码失败', false); return }
    pushNotice(`租户「${t.value.name}」密码已修改`)
    tip('密码已修改，请同步更新业务连接串', true)
    pwd.value = ''
    pwd2.value = ''
  } finally {
    busy.value = false
  }
}

async function toggleLock(): Promise<void> {
  const locking = !t.value.locked
  const ok = await window.sqlpilot.uiConfirm(
    locking ? `锁定租户「${t.value.name}」？` : `解锁租户「${t.value.name}」？`,
    locking ? '锁定后该租户无法写入（sys/meta 租户 OCP 会直接拒绝）。' : '解锁后恢复写入。'
  )
  if (!ok) return
  busy.value = true
  msg.value = ''
  try {
    const r = await tenantSetLocked(t.value.clusterId, t.value.id, locking)
    if (!r.ok) { tip(r.error || (locking ? '锁定失败' : '解锁失败'), false); return }
    pushNotice(locking ? '租户已锁定' : '租户已解锁')
    tip(locking ? '租户已锁定' : '租户已解锁', true)
    await refreshTenant()
  } finally {
    busy.value = false
  }
}

async function loadTde(): Promise<void> {
  tdeLoading.value = true
  tdeErr.value = ''
  try {
    const r = await window.sqlpilot.cloudTenantTde(cloud.activeId, t.value.clusterId, t.value.id)
    if (!r.ok) { tdeErr.value = r.error || '读取 TDE 状态失败'; return }
    tde.value = r.data || null
  } finally {
    tdeLoading.value = false
  }
}

watch(() => d.value.whitelist, (v) => { whitelist.value = v || '' })
onMounted(loadTde)
watch(() => props.reloadToken, loadTde)
</script>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 9px; }
.frow { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-dim); }
</style>
