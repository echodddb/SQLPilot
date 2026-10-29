<template>
  <div class="tp">
    <!-- 页内 tab：与 OCP「租户列表 / Unit 规格 / 参数模板」同一位置 -->
    <div class="subtabs">
      <button class="subtab" :class="{ on: sub === 'list' }" @click="sub = 'list'">租户列表</button>
      <button v-if="!isDirect" class="subtab" :class="{ on: sub === 'spec' }" @click="sub = 'spec'">Unit 规格</button>
      <button v-else class="subtab" :class="{ on: sub === 'unit' }" @click="sub = 'unit'">Unit 配置</button>
      <button v-if="isDirect" class="subtab" :class="{ on: sub === 'pool' }" @click="sub = 'pool'">资源池</button>
    </div>

    <template v-if="sub === 'list'">
      <div class="tp-head">
        <h2>租户 <span class="count">{{ filtered.length }}</span></h2>
        <div class="filters">
          <input v-model="q" class="search" placeholder="搜索租户 / 集群 / 主 Zone" spellcheck="false" />
          <!-- 直连：按集群（= 一个直连平台）收敛范围，租户的写操作只在这个集群内发起 -->
          <select v-if="isDirect" v-model.number="directTenant.scopeClusterId" title="选择要管理的集群">
            <option :value="0">全部集群</option>
            <option v-for="c in directScopes" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <select v-else v-model="cluster">
            <option value="">全部集群</option>
            <option v-for="c in clusterNames" :key="c" :value="c">{{ c }}</option>
          </select>
          <select v-model="mode">
            <option value="">全部模式</option>
            <option value="MYSQL">MySQL</option>
            <option value="ORACLE">Oracle</option>
          </select>
          <select v-model="role">
            <option value="">全部角色</option>
            <option value="PRIMARY">主租户</option>
            <option value="STANDBY">备租户</option>
          </select>
          <button class="create" :title="createHint" :disabled="isDirect && !canCreate" @click="openCreate">
            ＋ 新建租户
          </button>
        </div>
      </div>

      <div class="table-wrap" data-ai="tenants.list">
        <table class="tbl">
          <thead data-src="tnList">
            <tr>
              <th>租户名</th><th>所属集群</th><th>模式</th><th>状态</th><th>角色</th>
              <th>Zone 优先级</th><th>Locality</th><th class="r">Unit</th><th class="r">租户 ID</th><th>创建时间</th>
              <th v-if="isDirect" class="r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="t in filtered"
              :key="t.id"
              class="clickable"
              :data-ai="`tenants.list:${t.name}`"
              :data-ai-name="t.name"
              @click="openTenant(t.clusterId, t.id)"
            >
              <td class="cell-main" data-src="tnList" :data-tenant="t.name">
                {{ t.name }}<span v-if="t.locked" class="mini">锁定</span><span v-if="t.readonly" class="mini">只读</span>
              </td>
              <td>{{ t.clusterName }}</td>
              <td><span class="pill" :class="t.mode === 'ORACLE' ? 'info' : 'gray'">{{ t.mode }}</span></td>
              <td><span class="pill" :class="tenantStatus(t.status).tone">{{ tenantStatus(t.status).label }}</span></td>
              <td>
                <span v-if="t.role" class="pill" :class="t.role === 'PRIMARY' ? 'info' : 'gray'">
                  {{ t.role === 'PRIMARY' ? '主' : '备' }}
                </span>
                <span v-else class="dim">—</span>
              </td>
              <td class="mono dim">{{ t.primaryZone || '—' }}</td>
              <td class="dim ellipsis" :title="t.locality" data-src="tnReplica" :data-tenant="t.name">{{ t.locality || '—' }}</td>
              <td class="r mono dim" :title="unitHint(t.locality)">{{ unitCount(t.locality) }}</td>
              <td class="r mono dim">{{ t.obTenantId }}</td>
              <td class="dim">{{ fmtTime(t.createTime) }}</td>
              <td v-if="isDirect" class="r">
                <div class="ops" @click.stop>
                  <button class="op" :disabled="!platformOfCluster(t.clusterId)" @click="runAction(t, t.locked ? 'unlock' : 'lock')">
                    {{ t.locked ? '解锁' : '锁定' }}
                  </button>
                  <button
                    class="op danger"
                    :disabled="!platformOfCluster(t.clusterId) || t.name.toLowerCase() === 'sys' || !t.locked"
                    :title="t.name.toLowerCase() === 'sys'
                      ? 'sys 租户不可删除'
                      : t.locked ? '删除该租户' : '需先锁定租户才能删除'"
                    @click="runAction(t, 'delete')"
                  >
                    删除
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="!filtered.length"><td :colspan="isDirect ? 11 : 10" class="empty">没有匹配的租户</td></tr>
          </tbody>
        </table>
      </div>
      <div class="foot">
        {{ isDirect
          ? '点任意一行查看租户详情（概览 / 副本与资源 / 会话 / 数据库 / 用户 / 参数 / TopSQL）；锁定与删除也可在右侧操作列直接执行'
          : '点任意一行打开租户工作台（概览 / 副本 / 拓扑 / 库表 / 会话 / 事务 / SQL / 参数 / 合并 / 统计 / 备份 / 用户 / 安全）' }}
      </div>
    </template>

    <!-- 直连的 Unit 规格按集群独立维护，用专属面板；OCP 走原来的 UnitSpecManager -->
    <DirectPoolManager v-else-if="sub === 'pool'" :scopes="directScopes" />
    <DirectUnitManager v-else-if="isDirect" :scopes="directScopes" />
    <UnitSpecManager v-else data-ai="tenants.unitSpecs" />
  </div>
  <!-- 两套租户详情：直连走精简面板（只有系统视图能支撑的内容），OCP 走 13 个 tab 的工作台 -->
  <!-- key 用「集群 + 租户 ID」：换租户时强制重建面板，避免上一个租户的
       库 / 账号 / 会话列表残留（看着像"能查到数据却又报错"） -->
  <DirectTenantDrawer
    v-if="cloud.tenant && isDirect"
    :key="`${cloud.tenant.tenant.clusterId}-${cloud.tenant.tenant.obTenantId}`"
  />
  <TenantDrawer v-else-if="cloud.tenant" />
  <TenantCreate v-if="tenantCreate && !isDirect" @close="tenantCreate = false" />
  <DirectTenantCreate
    v-if="directTenant.createOpen && directTenant.createPlatformId && createTarget"
    :platform-id="directTenant.createPlatformId"
    :cluster-id="createTarget.id"
    :cluster-name="createTarget.name"
  />
  <!-- 锁定 / 删除的执行进度弹窗（不再只弹 toast） -->
  <DirectOpModal
    v-if="op.open && op.tenant"
    :platform-id="platformOfCluster(op.tenant.clusterId)"
    :action="op.action"
    :tenant="op.tenant"
    @close="op.open = false"
    @done="onOpDone"
  />
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import TenantDrawer from './TenantDrawer.vue'
import TenantCreate from './TenantCreate.vue'
import UnitSpecManager from './tenant/UnitSpecManager.vue'
import DirectTenantDrawer from './direct/DirectTenantDrawer.vue'
import DirectTenantCreate from './direct/DirectTenantCreate.vue'
import DirectUnitManager from './direct/DirectUnitManager.vue'
import DirectPoolManager from './direct/DirectPoolManager.vue'
import DirectOpModal from './direct/DirectOpModal.vue'
import { cloud, load, openTenant } from '../../cloud/state'
import { canManage, directTenant, openCreate as openDirectCreate, platformOfCluster } from '../../cloud/directTenant'
import { fmtTime, tenantStatus } from '../../cloud/parts'

const q = ref('')
const cluster = ref('')
const mode = ref('')
const role = ref('')
const tenantCreate = ref(false)
/** 页内 tab：租户列表 / Unit 规格（OCP）/ Unit 配置、资源池（直连） */
const sub = ref<'list' | 'spec' | 'unit' | 'pool'>('list')

/** 直连模式：租户的读写都落在某一个直连平台上，界面按集群收敛 */
const isDirect = computed(() => cloud.vendor === 'ocp' && cloud.access === 'direct')

/** 直连可管理的集群清单（从已加载的租户里推，避免为了个下拉再打一遍接口） */
const directScopes = computed(() => {
  const map = new Map<number, string>()
  for (const t of cloud.tenants) {
    if (!map.has(t.clusterId)) map.set(t.clusterId, t.clusterName || `集群 ${t.clusterId}`)
  }
  return [...map].map(([id, name]) => ({ id, name }))
})

/** 新建租户的目标集群：显式选了就用它，只有一个集群时默认它 */
const createTarget = computed(() => {
  const id = directTenant.scopeClusterId || (directScopes.value.length === 1 ? directScopes.value[0].id : 0)
  if (!id) return null
  const hit = directScopes.value.find((c) => c.id === id)
  return hit ? { id: hit.id, name: hit.name } : null
})

const canCreate = computed(() => !!createTarget.value && canManage(createTarget.value.id))
const createHint = computed(() => {
  if (!isDirect.value) return '在指定集群新建租户'
  if (!createTarget.value) return '先在上方选择一个集群，再新建租户'
  if (!canManage(createTarget.value.id)) return '该集群未关联直连平台，无法新建租户'
  return `在集群 ${createTarget.value.name} 新建租户（sys 租户直连执行）`
})

function openCreate(): void {
  if (!isDirect.value) {
    tenantCreate.value = true
    return
  }
  const target = createTarget.value
  if (!target) {
    void window.sqlpilot.uiAlert('请先选择集群', '直连模式下每个集群是一套独立连接，请先在上方选定要在哪个集群建租户。')
    return
  }
  if (!openDirectCreate(target.id)) {
    void window.sqlpilot.uiAlert('无法定位直连平台', '该集群没有关联的直连平台，请到云管平台设置里检查。')
  }
}

const clusterNames = computed(() => [...new Set(cloud.tenants.map((t) => t.clusterName).filter(Boolean))])

// 表格操作列的锁定/删除：走统一的执行进度弹窗
const op = reactive({
  open: false,
  action: 'delete' as 'lock' | 'unlock' | 'delete',
  tenant: null as { clusterId: number; name: string; clusterName: string; locked?: boolean } | null
})

function runAction(t: CloudTenant, action: 'lock' | 'unlock' | 'delete'): void {
  op.tenant = { clusterId: t.clusterId, name: t.name, clusterName: t.clusterName, locked: t.locked }
  op.action = action
  op.open = true
}

function onOpDone(): void {
  void load()
}

// 两套 Unit 页含义不同（OCP 资源规格 / 直连集群的 DBA_OB_UNIT_CONFIGS），
// 切换接入方式时回到列表，避免把另一家面板渲染出来
watch(
  isDirect,
  () => {
    sub.value = 'list'
  },
  { immediate: true }
)

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  const scope = isDirect.value ? directTenant.scopeClusterId : 0
  return cloud.tenants.filter((t) => {
    if (scope && t.clusterId !== scope) return false
    if (!isDirect.value && cluster.value && t.clusterName !== cluster.value) return false
    if (mode.value && t.mode !== mode.value) return false
    if (role.value && (t.role || 'PRIMARY') !== role.value) return false
    if (!k) return true
    return `${t.name} ${t.clusterName} ${t.locality} ${t.primaryZone}`.toLowerCase().includes(k)
  })
})

/**
 * 从 Locality 解析 Unit 数：形如 `FULL{1}@zone1, READONLY{2}@zone2`
 * 每段 {n} 是该 Zone 的 Unit 数，累加即租户 Unit 总数（省一次 units 请求）。
 */
function unitCount(locality: string): number {
  let n = 0
  for (const x of String(locality || '').matchAll(/\{(\d+)\}/g)) n += Number(x[1]) || 0
  return n
}

function unitHint(locality: string): string {
  const n = unitCount(locality)
  return n ? `Locality 解析：共 ${n} 个 Unit（各 Zone {n} 之和）` : 'Locality 中没有 Unit 数'
}
</script>

<style scoped>
.tp { display: flex; flex-direction: column; gap: 10px; }
/* 页内 tab（OCP 式下划线） */
.subtabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: -2px 0 2px; }
.subtab {
  border: none; background: none; color: var(--text-faint); font-family: inherit; font-size: 12.5px;
  padding: 6px 10px 7px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.subtab:hover { color: var(--text); }
.subtab.on { color: var(--accent); border-bottom-color: var(--accent); }
.tp-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tp-head h2 { font-size: 12.5px; font-weight: 600; }
.count { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: 99px; padding: 0 6px; margin-left: 3px; }
.filters { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.search {
  width: 190px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 9px; outline: none;
}
.search:focus { border-color: var(--accent); }
select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  font-family: inherit; font-size: 12px; padding: 5px 8px; outline: none;
}
.create {
  border: 1px solid var(--accent); background: var(--accent-dim); color: var(--accent);
  border-radius: 7px; padding: 4px 11px; font-size: 11.5px; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.create:hover { background: var(--accent); color: #fff; }
.spec {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 4px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.spec:hover { color: var(--accent); border-color: var(--accent); }
.table-wrap { border: 1px solid var(--border); border-radius: 11px; overflow: auto; background: var(--bg-card); }
.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.tbl th { text-align: left; font-weight: 500; font-size: 10.5px; color: var(--text-faint); letter-spacing: 0.4px; padding: 8px 10px; background: var(--bg-input); border-bottom: 1px solid var(--border); white-space: nowrap; position: sticky; top: 0; }
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl .r { text-align: right; }
.tbl tbody tr.clickable { cursor: pointer; }
.tbl tbody tr.clickable:hover { background: var(--bg-card-hover); }
.cell-main { font-weight: 550; }
.ellipsis { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.mono { font-family: var(--mono); }
.dim { color: var(--text-dim); }
.empty { text-align: center; color: var(--text-faint); padding: 20px !important; }
.mini { font-size: 9.5px; color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent); border-radius: 4px; padding: 0 4px; margin-left: 5px; }
.foot { font-size: 10.5px; color: var(--text-faint); }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.pill.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.pill.gray { color: var(--text-dim); }

/* 表格操作列：文字必须显式给色，避免继承表格的 dim 色导致“看不到字” */
.ops { display: inline-flex; gap: 5px; justify-content: flex-end; }
.op {
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 11px;
  font-family: inherit;
  line-height: 1.6;
  cursor: pointer;
  white-space: nowrap;
}
.op:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
/* 与租户详情保持一致：危险操作默认中性，hover 才泛红，避免整列红按钮造成视觉噪音 */
.op.danger { color: var(--text-dim); border-color: var(--border); }
.op.danger:hover:not(:disabled) { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.op:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
