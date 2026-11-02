<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">{{ caps.roles ? '用户与角色' : '数据库用户' }} <span class="cnt">{{ kind === 'user' ? users.length : roles.length }}</span></h4>
      <div v-if="caps.roles" class="seg">
        <button class="tp-btn sm" :class="{ primary: kind === 'user' }" @click="kind = 'user'">用户</button>
        <button class="tp-btn sm" :class="{ primary: kind === 'role' }" @click="kind = 'role'">角色</button>
      </div>
      <input v-model="q" class="tp-input tp-search" :placeholder="kind === 'user' ? '过滤用户名 / 库' : '过滤角色名'" spellcheck="false" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="loadAll">{{ loading ? '读取中…' : '刷新' }}</button>
      <button class="tp-btn primary" @click="form = kind">{{ kind === 'user' ? '新建用户' : '新建角色' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="msg" class="tp-msg ok">{{ msg }}</div>

    <!-- 用户列表 -->
    <div v-show="kind === 'user'" class="split">
      <div class="tp-tbl-wrap tp-scroll-y" data-src="tnUsers" :data-tenant="d.tenant.name">
        <table class="tp-tbl">
          <thead>
            <tr>
              <th>用户</th>
              <th v-if="caps.dbPrivileges">可访问库</th>
              <th v-else>创建时间</th>
              <th class="r">{{ caps.objectPrivileges ? '系统权限' : '全局权限' }}</th>
              <th>状态</th>
              <th class="r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in filteredUsers" :key="`${u.username}@${u.host}`" class="clickable" :class="{ on: isPicked(u) }" @click="pick(u)">
              <td class="tp-mono">{{ u.username }}<span class="tp-dim">@{{ u.host }}</span></td>
              <td v-if="caps.dbPrivileges" class="ell tp-dim" style="font-size:10.5px" :title="u.accessibleDatabases.join(', ')">{{ u.accessibleDatabases.join(', ') || '—' }}</td>
              <td v-else class="tp-dim" style="font-size:10.5px">{{ fmtTime(u.createTime) }}</td>
              <td class="r tp-mono">{{ u.globalPrivileges.length }}</td>
              <td><span class="tp-chip" :style="u.locked ? 'color:var(--yellow);border-color:var(--yellow)' : ''">{{ u.locked ? '锁定' : '正常' }}</span></td>
              <td class="r" @click.stop>
                <button class="tp-btn sm" @click="askPassword(u)">改密</button>
                <button class="tp-btn sm" :disabled="!caps.canLock(u.username)" :title="caps.canLock(u.username) ? '' : `${u.username} 是管理用户，OCP 不允许锁定`" @click="toggleLock(u)">
                  {{ u.locked ? '解锁' : '锁定' }}
                </button>
                <button class="tp-btn sm danger" @click="dropUser(u)">删除</button>
              </td>
            </tr>
            <tr v-if="!filteredUsers.length"><td :colspan="caps.dbPrivileges ? 5 : 5" class="tp-empty">{{ loading ? '读取中…' : '没有用户' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="picked" class="detail">
        <div class="tp-bar">
          <h4 class="tp-h">{{ picked.username }}@{{ picked.host }}</h4>
          <span v-if="picked.locked" class="tp-chip warn">已锁定</span>
          <span v-if="isAdminUser(picked.username)" class="tp-chip idle">管理用户</span>
          <span class="sp"></span>
          <button v-for="(c, i) in picked.connections" :key="i" class="tp-btn sm" @click="copy(c.url)">复制 {{ c.type }} 连接串</button>
        </div>

        <h4 class="tp-h" style="font-size:11.5px">{{ caps.objectPrivileges ? '系统权限' : '全局权限' }} <span class="cnt">{{ picked.globalPrivileges.length }}</span></h4>
        <div class="tp-bar" style="flex-wrap:wrap">
          <span v-for="p in picked.globalPrivileges" :key="p" class="tp-chip tp-mono">{{ p }}</span>
          <span v-if="!picked.globalPrivileges.length" class="tp-note">无</span>
        </div>

        <!-- Oracle：拥有角色 + 可访问对象 -->
        <template v-if="caps.roles">
          <h4 class="tp-h" style="font-size:11.5px">拥有角色 <span class="cnt">{{ ownedRoles.length }}</span></h4>
          <div class="tp-bar" style="flex-wrap:wrap">
            <span v-for="r in ownedRoles" :key="r.name" class="tp-chip tp-mono" style="color:var(--accent);border-color:var(--accent)">{{ r.name }}</span>
            <span v-if="!ownedRoles.length" class="tp-note">无（角色关系由角色列表的 grantees 反查）</span>
          </div>

          <h4 class="tp-h" style="font-size:11.5px">可访问对象 <span class="cnt">{{ objects.length }}</span></h4>
          <div v-if="objErr" class="tp-warn">{{ objErr }}</div>
          <div class="tp-tbl-wrap" style="max-height:24vh">
            <table class="tp-tbl">
              <thead><tr><th>对象</th><th>类型</th><th>Schema</th></tr></thead>
              <tbody>
                <tr v-for="(o, i) in objects" :key="`${o.schema}.${o.name}.${i}`">
                  <td class="tp-mono">{{ o.name }}</td>
                  <td class="tp-dim">{{ o.type }}</td>
                  <td class="tp-mono tp-dim">{{ o.schema || '—' }}</td>
                </tr>
                <tr v-if="!objects.length"><td colspan="3" class="tp-empty">{{ objLoading ? '读取中…' : 'OCP 未返回对象授权' }}</td></tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- MySQL：库级权限 -->
        <template v-else>
          <h4 class="tp-h" style="font-size:11.5px">库级权限 <span class="cnt">{{ picked.dbPrivileges.length }}</span></h4>
          <div class="tp-tbl-wrap" style="max-height:30vh">
            <table class="tp-tbl">
              <thead><tr><th>库</th><th>权限</th></tr></thead>
              <tbody>
                <tr v-for="p in picked.dbPrivileges" :key="p.db">
                  <td class="tp-mono">{{ p.db }}</td>
                  <td class="tp-dim" style="white-space:normal">{{ p.privileges.join(', ') || '—' }}</td>
                </tr>
                <tr v-if="!picked.dbPrivileges.length"><td colspan="2" class="tp-empty">无库级授权</td></tr>
              </tbody>
            </table>
          </div>
        </template>

        <h4 class="tp-h" style="font-size:11.5px">连接串</h4>
        <div class="tp-card">
          <div v-for="(c, i) in picked.connections" :key="i" class="tp-conn">
            <span class="tp-chip">{{ c.type }}</span>
            <code class="tp-mono">{{ c.url }}</code>
          </div>
          <div v-if="!picked.connections.length" class="tp-note">OCP 未返回连接串</div>
        </div>
      </div>
    </div>

    <!-- 角色列表 -->
    <div v-show="kind === 'role'" class="split">
      <div class="tp-tbl-wrap tp-scroll-y" data-src="tnRoles" :data-tenant="d.tenant.name">
        <table class="tp-tbl">
          <thead><tr><th>角色</th><th class="r">系统权限</th><th class="r">被授予</th><th class="r">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in filteredRoles" :key="r.name" class="clickable" :class="{ on: pickedRole?.name === r.name }" @click="pickedRole = r">
              <td class="tp-mono">{{ r.name }}</td>
              <td class="r tp-mono">{{ r.globalPrivileges.length }}</td>
              <td class="r tp-mono">{{ r.grantees.length }}</td>
              <td class="r" @click.stop><button class="tp-btn sm danger" @click="dropRole(r)">删除</button></td>
            </tr>
            <tr v-if="!filteredRoles.length"><td colspan="4" class="tp-empty">{{ loading ? '读取中…' : '没有角色' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="pickedRole" class="detail">
        <div class="tp-bar"><h4 class="tp-h">{{ pickedRole.name }}</h4><span class="sp"></span><button class="tp-btn sm" @click="loadRoles">刷新</button></div>
        <h4 class="tp-h" style="font-size:11.5px">系统权限 <span class="cnt">{{ pickedRole.globalPrivileges.length }}</span></h4>
        <div class="tp-bar" style="flex-wrap:wrap">
          <span v-for="p in pickedRole.globalPrivileges" :key="p" class="tp-chip tp-mono">{{ p }}</span>
          <span v-if="!pickedRole.globalPrivileges.length" class="tp-note">无</span>
        </div>
        <h4 class="tp-h" style="font-size:11.5px">被授予 <span class="cnt">{{ pickedRole.grantees.length }}</span></h4>
        <div class="tp-bar" style="flex-wrap:wrap">
          <span v-for="g in pickedRole.grantees" :key="g" class="tp-chip tp-mono">{{ g }}</span>
          <span v-if="!pickedRole.grantees.length" class="tp-note">没有用户或角色引用它</span>
        </div>
      </div>
    </div>

    <div class="tp-note">
      数据来自 OCP 的 <code class="tp-mono">tenants/{tid}/users|roles|objects</code>。
      <template v-if="caps.mode === 'ORACLE'">Oracle 租户的身份模型是「用户 + 角色 + 系统权限」，没有库级权限；
      管理用户是 <b>SYS</b>，OCP 不允许锁定它。</template>
      <template v-else>MySQL 租户调 <code class="tp-mono">/roles</code> 会被 OCP 拒绝（400），所以只显示用户与库级权限。</template>
    </div>

    <TenantUserForm v-if="form" :kind="form" :roles="roles" @close="form = null" @done="onCreated" />

    <!-- 改密弹窗（Electron 没有 window.prompt） -->
    <div v-if="pwUser" class="pw-mask" @click.self="pwUser = null">
      <div class="pw-box">
        <b>修改 {{ pwUser.username }} 的密码</b>
        <input v-model="pw1" type="password" class="tp-input tp-mono" placeholder="新密码（至少 8 位，含两类字符）" spellcheck="false" />
        <input v-model="pw2" type="password" class="tp-input tp-mono" placeholder="再输一次" spellcheck="false" />
        <div v-if="pwErr" class="tp-err">{{ pwErr }}</div>
        <div class="tp-bar"><span class="sp"></span><button class="tp-btn" @click="pwUser = null">取消</button>
          <button class="tp-btn primary" :disabled="pwBusy || !pw1" @click="savePassword">{{ pwBusy ? '提交中…' : '确定' }}</button></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 租户用户 / 角色管理：
 *  · MySQL 租户 → 用户列表（全局权限 + 库级权限 + 连接串）
 *  · Oracle 租户 → 「用户 / 角色」两个子页，用户详情有 系统权限 / 拥有角色 / 可访问对象 三块
 * 行内操作：改密 / 锁定·解锁 / 删除（SYS 不可锁定，与官方一致）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'
import { tenantCaps } from '../../../cloud/tenantMode'
import TenantUserForm from './TenantUserForm.vue'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)
const caps = computed(() => tenantCaps(d.value?.tenant?.mode))

const kind = ref<'user' | 'role'>('user')
const users = ref<CloudTenantUser[]>([])
const roles = ref<CloudTenantRole[]>([])
const loading = ref(false)
const err = ref('')
const msg = ref('')
const q = ref('')
const picked = ref<CloudTenantUser | null>(null)
const pickedRole = ref<CloudTenantRole | null>(null)
const form = ref<'user' | 'role' | null>(null)

const objects = ref<CloudTenantObject[]>([])
const objLoading = ref(false)
const objErr = ref('')

const pwUser = ref<CloudTenantUser | null>(null)
const pw1 = ref('')
const pw2 = ref('')
const pwErr = ref('')
const pwBusy = ref(false)

const filteredUsers = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return users.value
  return users.value.filter((u) => `${u.username} ${u.host} ${u.accessibleDatabases.join(' ')}`.toLowerCase().includes(k))
})

const filteredRoles = computed(() => {
  const k = q.value.trim().toLowerCase()
  return k ? roles.value.filter((r) => r.name.toLowerCase().includes(k)) : roles.value
})

/** 该用户拥有的角色：OCP 用户详情不含角色，只能从角色列表的 grantees 反查 */
const ownedRoles = computed(() => {
  const name = caps.value.normUser(picked.value?.username || '')
  if (!name) return []
  return roles.value.filter((r) => r.grantees.some((g) => caps.value.normUser(g) === name))
})

/** OCP 的 createTime 是 ISO 带时区（2026-10-31T17:29:33+08:00），表格里只留到秒 */
function fmtTime(v: string): string {
  if (!v) return '—'
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(v)
  return m ? `${m[1]} ${m[2]}` : v
}

function isPicked(u: CloudTenantUser): boolean {
  return picked.value?.username === u.username && picked.value?.host === u.host
}

function isAdminUser(name: string): boolean {
  return caps.value.normUser(name) === caps.value.normUser(caps.value.adminUser)
}

function pick(u: CloudTenantUser): void {
  picked.value = u
  if (caps.value.roles) void loadObjects(u.username)
}

async function loadUsers(): Promise<void> {
  const t = d.value.tenant
  const r = await window.sqlpilot.cloudTenantUsers(cloud.activeId, t.clusterId, t.id)
  if (!r.ok) { err.value = r.error || '读取用户失败'; return }
  users.value = r.data || []
  picked.value = users.value.find(isPicked) || users.value[0] || null
  if (picked.value && caps.value.roles) await loadObjects(picked.value.username)
}

async function loadRoles(): Promise<void> {
  if (!caps.value.roles) { roles.value = []; return }
  const t = d.value.tenant
  const r = await window.sqlpilot.cloudTenantRoles(cloud.activeId, t.clusterId, t.id)
  if (!r.ok) { err.value = r.error || '读取角色失败'; return }
  roles.value = r.data || []
  pickedRole.value = roles.value.find((x) => x.name === pickedRole.value?.name) || roles.value[0] || null
}

async function loadObjects(user: string): Promise<void> {
  objLoading.value = true
  objErr.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantObjects(cloud.activeId, t.clusterId, t.id, { userName: user })
    if (!r.ok) { objErr.value = r.error || '读取对象授权失败'; objects.value = []; return }
    objects.value = r.data || []
  } finally {
    objLoading.value = false
  }
}

async function loadAll(): Promise<void> {
  loading.value = true
  err.value = ''
  msg.value = ''
  try {
    await loadUsers()
    await loadRoles()
  } finally {
    loading.value = false
  }
}

function askPassword(u: CloudTenantUser): void {
  pwUser.value = u
  pw1.value = ''
  pw2.value = ''
  pwErr.value = ''
}

async function savePassword(): Promise<void> {
  const u = pwUser.value
  if (!u) return
  if (pw1.value.length < 8) { pwErr.value = '密码至少 8 位'; return }
  if (pw1.value !== pw2.value) { pwErr.value = '两次输入不一致'; return }
  pwBusy.value = true
  pwErr.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantChangeUserPassword(cloud.activeId, t.clusterId, t.id, u.username, pw1.value)
    if (!r.ok) { pwErr.value = r.error || '修改失败'; return }
    pushNotice(`用户 ${u.username} 密码已修改`)
    msg.value = `用户 ${u.username} 密码已修改`
    pwUser.value = null
  } finally {
    pwBusy.value = false
  }
}

async function toggleLock(u: CloudTenantUser): Promise<void> {
  if (!caps.value.canLock(u.username)) return
  const t = d.value.tenant
  const next = !u.locked
  const ok = await window.sqlpilot.uiConfirm(
    `${next ? '锁定' : '解锁'}用户「${u.username}」？`,
    next ? '锁定后该用户无法登录，但已有会话不会立刻断开。' : '解锁后该用户恢复登录能力。'
  )
  if (!ok) return
  const r = await window.sqlpilot.cloudTenantSetUserLocked(cloud.activeId, t.clusterId, t.id, u.username, next)
  if (!r.ok) { await window.sqlpilot.uiAlert('操作失败', r.error || 'OCP 返回错误'); return }
  pushNotice(next ? '用户已锁定' : '用户已解锁')
  await loadUsers()
}

async function dropUser(u: CloudTenantUser): Promise<void> {
  const t = d.value.tenant
  const ok = await window.sqlpilot.uiConfirm(`删除用户「${u.username}」？`, '该用户及其权限会被删除，操作不可恢复。', true)
  if (!ok) return
  const r = await window.sqlpilot.cloudTenantDropUser(cloud.activeId, t.clusterId, t.id, u.username)
  if (!r.ok) { await window.sqlpilot.uiAlert('删除失败', r.error || 'OCP 返回错误'); return }
  pushNotice(`用户 ${u.username} 已删除`)
  await loadUsers()
}

async function dropRole(r0: CloudTenantRole): Promise<void> {
  const t = d.value.tenant
  const ok = await window.sqlpilot.uiConfirm(`删除角色「${r0.name}」？`, '已授予该角色的用户会失去对应权限。', true)
  if (!ok) return
  const r = await window.sqlpilot.cloudTenantDropRole(cloud.activeId, t.clusterId, t.id, r0.name)
  if (!r.ok) { await window.sqlpilot.uiAlert('删除失败', r.error || 'OCP 返回错误'); return }
  pushNotice(`角色 ${r0.name} 已删除`)
  await loadAll()
}

async function onCreated(): Promise<void> {
  form.value = null
  await loadAll()
}

async function copy(text: string): Promise<void> {
  await window.sqlpilot.writeClipboard(text)
  pushNotice('已复制连接串')
}

onMounted(loadAll)
watch(() => props.reloadToken, loadAll)
</script>

<style scoped>
.split { display: grid; grid-template-columns: minmax(360px, 500px) 1fr; gap: 12px; align-items: start; }
@media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
.detail { display: flex; flex-direction: column; gap: 8px; }
.tp-conn { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
.tp-conn code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg { display: flex; gap: 4px; padding: 2px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); }
.pw-mask { position: fixed; inset: 0; z-index: 320; background: rgba(6, 8, 14, 0.46); display: flex; align-items: center; justify-content: center; }
.pw-box { width: min(420px, 90vw); background: var(--bg-card); border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 14px; display: flex; flex-direction: column; gap: 9px; }
.pw-box b { font-size: 13px; }
</style>
