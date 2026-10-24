<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">数据库用户 <span class="cnt">{{ users.length }}</span></h4>
      <input v-model="q" class="tp-input tp-search" placeholder="过滤用户名 / 库" spellcheck="false" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <div class="split">
      <div class="tp-tbl-wrap tp-scroll-y" data-src="tnUsers" :data-tenant="d.tenant.name">
        <table class="tp-tbl">
          <thead><tr><th>用户</th><th>可访问库</th><th class="r">全局权限</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="u in filtered" :key="`${u.username}@${u.host}`" class="clickable" :class="{ on: picked?.username === u.username && picked?.host === u.host }" @click="pick(u)">
              <td class="tp-mono">{{ u.username }}<span class="tp-dim">@{{ u.host }}</span></td>
              <td class="ell tp-dim" style="font-size:10.5px" :title="u.accessibleDatabases.join(', ')">{{ u.accessibleDatabases.join(', ') || '—' }}</td>
              <td class="r tp-mono">{{ u.globalPrivileges.length }}</td>
              <td><span class="tp-chip" :style="u.locked ? 'color:var(--yellow);border-color:var(--yellow)' : ''">{{ u.locked ? '锁定' : '正常' }}</span></td>
            </tr>
            <tr v-if="!filtered.length"><td colspan="4" class="tp-empty">{{ loading ? '读取中…' : '没有用户' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div v-if="picked" class="detail">
        <div class="tp-bar">
          <h4 class="tp-h">{{ picked.username }}@{{ picked.host }}</h4>
          <span class="sp"></span>
          <button v-for="(c, i) in picked.connections" :key="i" class="tp-btn sm" @click="copy(c.url)">复制 {{ c.type }} 连接串</button>
        </div>

        <h4 class="tp-h" style="font-size:11.5px">全局权限 <span class="cnt">{{ picked.globalPrivileges.length }}</span></h4>
        <div class="tp-bar" style="flex-wrap:wrap">
          <span v-for="p in picked.globalPrivileges" :key="p" class="tp-chip tp-mono">{{ p }}</span>
          <span v-if="!picked.globalPrivileges.length" class="tp-note">无</span>
        </div>

        <h4 class="tp-h" style="font-size:11.5px">库级权限 <span class="cnt">{{ picked.dbPrivileges.length }}</span></h4>
        <div class="tp-tbl-wrap" style="max-height:34vh">
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

    <div class="tp-note">
      用户与授权展示自 OCP 的 tenants/{tid}/users（含全局权限、库级权限、连接串）。
      新建用户 / 改密 / 授权在 OCP 里走 createUser、modifyGlobalPrivilege、modifyDbPrivilege；
      SqlPilot 目前只读展示，避免在高权限对象上误操作。
    </div>
  </div>
</template>

<script setup lang="ts">
/** 租户内数据库用户：列表 + 全局/库级权限 + 连接串 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const users = ref<CloudTenantUser[]>([])
const loading = ref(false)
const err = ref('')
const q = ref('')
const picked = ref<CloudTenantUser | null>(null)

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return users.value
  return users.value.filter((u) => `${u.username} ${u.host} ${u.accessibleDatabases.join(' ')}`.toLowerCase().includes(k))
})

function pick(u: CloudTenantUser): void {
  picked.value = u
}

async function copy(text: string): Promise<void> {
  await window.sqlpilot.writeClipboard(text)
  pushNotice('已复制连接串')
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantUsers(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { err.value = r.error || '读取用户失败'; return }
    users.value = r.data || []
    if (!picked.value && users.value.length) picked.value = users.value[0]
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.split { display: grid; grid-template-columns: minmax(300px, 420px) 1fr; gap: 12px; align-items: start; }
@media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }
.detail { display: flex; flex-direction: column; gap: 8px; }
.tp-conn { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
.tp-conn code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
