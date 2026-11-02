<template>
  <div class="uf-mask" @click.self="close">
    <section class="uf-box" @click.stop>
      <header class="uf-head">
        <b>{{ title }}</b>
        <span class="tp-chip" :class="caps.mode === 'ORACLE' ? 'warn' : 'idle'">{{ caps.mode }}</span>
        <span class="sp"></span>
        <button class="tp-btn sm" @click="close">✕</button>
      </header>

      <div class="uf-body">
        <div v-if="err" class="tp-err">{{ err }}</div>

        <label class="uf-row">
          <span>{{ kind === 'role' ? '角色名' : '用户名' }}</span>
          <input v-model="name" class="tp-input tp-mono" spellcheck="false" :placeholder="nameHint" @input="onName" />
        </label>
        <div v-if="caps.mode === 'ORACLE'" class="tp-note" style="margin-top:-4px">
          英文名会自动转大写（Oracle 标识符不区分大小写但回显大写）。
        </div>

        <template v-if="kind === 'user'">
          <label class="uf-row">
            <span>密码</span>
            <input v-model="password" type="password" class="tp-input tp-mono" spellcheck="false" placeholder="至少 8 位，含数字/字母/符号中的两类" />
          </label>
          <label v-if="caps.mode === 'MYSQL'" class="uf-row">
            <span>主机</span>
            <input v-model="hostName" class="tp-input tp-mono" spellcheck="false" placeholder="%（允许任意来源）" />
          </label>
        </template>

        <div class="uf-sec">
          <h4 class="tp-h">{{ caps.mode === 'ORACLE' ? '系统权限' : '全局权限' }} <span class="cnt">{{ privs.length }}</span></h4>
          <div class="uf-grid">
            <label v-for="p in privOptions" :key="p.value" class="uf-chk">
              <input v-model="privs" type="checkbox" :value="p.value" />
              <span class="tp-mono">{{ p.value }}</span>
            </label>
          </div>
          <div class="tp-note">{{ caps.mode === 'ORACLE' ? 'Oracle 的系统权限名是 CREATE_SESSION 这种下划线风格，不要照 MySQL 的 SELECT 填。' : '来自 OCP 4.3 全局权限常量表。' }}</div>
        </div>

        <div v-if="kind === 'user' && caps.roles" class="uf-sec">
          <h4 class="tp-h">授予角色 <span class="cnt">{{ roleNames.length }}</span></h4>
          <div v-if="roles.length" class="uf-grid">
            <label v-for="r in roles" :key="r.name" class="uf-chk">
              <input v-model="roleNames" type="checkbox" :value="r.name" />
              <span class="tp-mono">{{ r.name }}</span>
            </label>
          </div>
          <div v-else class="tp-note">该租户还没有角色，可先到「角色」子页新建。</div>
        </div>

        <div v-if="kind === 'user' && caps.dbPrivileges" class="uf-sec">
          <h4 class="tp-h">库级授权 <span class="cnt">{{ dbGrants.length }}</span></h4>
          <div class="uf-bar">
            <input v-model="dbName" class="tp-input tp-mono" style="width:180px" placeholder="库名（如 test）" spellcheck="false" />
            <select v-model="dbPrivPick" class="tp-select" style="width:150px">
              <option value="">选权限…</option>
              <option v-for="p in MYSQL_DB_PRIVILEGES" :key="p" :value="p">{{ p }}</option>
            </select>
            <button class="tp-btn sm" :disabled="!dbName.trim() || !dbPrivPick" @click="addGrant">添加</button>
          </div>
          <div v-if="dbGrants.length" class="uf-bar" style="flex-wrap:wrap">
            <span v-for="(g, i) in dbGrants" :key="i" class="tp-chip">
              <span class="tp-mono">{{ g.dbName }}</span> · {{ g.privileges.join(',') }}
              <button class="uf-x" @click="dbGrants.splice(i, 1)">✕</button>
            </span>
          </div>
        </div>
      </div>

      <footer class="uf-foot">
        <span class="sp"></span>
        <button class="tp-btn" @click="close">取消</button>
        <button class="tp-btn primary" :disabled="busy || !canSubmit" @click="submit">{{ busy ? '提交中…' : '创建' }}</button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 新建用户 / 角色（Oracle 与 MySQL 共用，字段差异走 tenantMode 能力表）。
 * Oracle 建用户密码必须 RSA 加密 → 主进程 ocpTenantCreateUser 负责，明文只在这里短暂存在。
 */
import { computed, ref } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'
import { tenantCaps } from '../../../cloud/tenantMode'
import { MYSQL_GLOBAL_PRIVILEGES, MYSQL_DB_PRIVILEGES, ORACLE_SYSTEM_PRIVILEGES } from '../../../cloud/tenantPrivileges'

const props = defineProps<{ kind: 'user' | 'role'; roles: CloudTenantRole[] }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const d = computed(() => cloud.tenant as CloudTenantDetail)
const caps = computed(() => tenantCaps(d.value?.tenant?.mode))

const title = computed(() => `${props.kind === 'role' ? '新建角色' : '新建用户'} · ${d.value.tenant.name}`)
const nameHint = computed(() => (props.kind === 'role' ? '如 READONLY_ROLE' : caps.value.mode === 'ORACLE' ? '如 APP_USER' : '如 app_user'))

const name = ref('')
const password = ref('')
const hostName = ref('%')
const privs = ref<string[]>([])
const roleNames = ref<string[]>([])
const dbName = ref('')
const dbPrivPick = ref('')
const dbGrants = ref<{ dbName: string; privileges: string[] }[]>([])
const busy = ref(false)
const err = ref('')

const privOptions = computed(() =>
  caps.value.mode === 'ORACLE'
    ? ORACLE_SYSTEM_PRIVILEGES.map((v) => ({ value: v, label: v }))
    : MYSQL_GLOBAL_PRIVILEGES
)

const canSubmit = computed(() => !!name.value.trim() && (props.kind === 'role' || !!password.value))

function onName(): void {
  if (caps.value.mode === 'ORACLE') name.value = caps.value.normUser(name.value)
}

function addGrant(): void {
  const db = dbName.value.trim()
  const p = dbPrivPick.value
  if (!db || !p) return
  const hit = dbGrants.value.find((g) => g.dbName === db)
  if (hit) {
    if (!hit.privileges.includes(p)) hit.privileges.push(p)
  } else {
    dbGrants.value.push({ dbName: db, privileges: [p] })
  }
  dbPrivPick.value = ''
}

async function submit(): Promise<void> {
  busy.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r =
      props.kind === 'role'
        ? await window.sqlpilot.cloudTenantCreateRole(cloud.activeId, t.clusterId, t.id, name.value.trim(), [...privs.value])
        : await window.sqlpilot.cloudTenantCreateUser(cloud.activeId, t.clusterId, t.id, {
            username: name.value.trim(),
            password: password.value,
            hostName: caps.value.mode === 'MYSQL' ? hostName.value.trim() || '%' : undefined,
            // 跨 contextBridge 传 reactive 数组会报 An object could not be cloned，这里一律摊平成新数组
            globalPrivileges: [...privs.value],
            roleNames: [...roleNames.value],
            dbPrivileges: dbGrants.value.map((g) => ({ dbName: g.dbName, privileges: [...g.privileges] }))
          })
    if (!r.ok) { err.value = r.error || '创建失败'; return }
    pushNotice(props.kind === 'role' ? `角色 ${name.value} 已创建` : `用户 ${name.value} 已创建`)
    emit('done')
  } finally {
    busy.value = false
  }
}

function close(): void {
  emit('close')
}
</script>

<style scoped>
.uf-mask { position: fixed; inset: 0; z-index: 300; background: rgba(6, 8, 14, 0.46); display: flex; align-items: center; justify-content: center; padding-top: var(--titlebar-h); }
.uf-box { width: min(720px, 92vw); max-height: 86vh; background: var(--bg-card); border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.uf-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.uf-head b { font-size: 14px; }
.uf-head .sp { flex: 1; }
.uf-body { padding: 12px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.uf-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
.uf-foot .sp { flex: 1; }
.uf-row { display: grid; grid-template-columns: 76px 1fr; align-items: center; gap: 10px; font-size: 11.5px; color: var(--text-dim); }
.uf-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.uf-sec { display: flex; flex-direction: column; gap: 7px; border-top: 1px dashed var(--border); padding-top: 9px; }
.uf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 4px 10px; max-height: 190px; overflow-y: auto; }
.uf-chk { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); cursor: pointer; }
.uf-chk input { width: auto; accent-color: var(--accent); }
.uf-chk span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uf-x { border: none; background: transparent; color: var(--text-faint); cursor: pointer; font-size: 10px; padding: 0 0 0 4px; }
.uf-x:hover { color: var(--red); }
</style>
