<template>
  <div class="tp">
    <!-- 页内 tab：与 OCP「租户列表 / Unit 规格 / 参数模板」同一位置 -->
    <div class="subtabs">
      <button class="subtab" :class="{ on: sub === 'list' }" @click="sub = 'list'">租户列表</button>
      <button class="subtab" :class="{ on: sub === 'spec' }" @click="sub = 'spec'">Unit 规格</button>
    </div>

    <template v-if="sub === 'list'">
      <div class="tp-head">
        <h2>租户 <span class="count">{{ filtered.length }}</span></h2>
        <div class="filters">
          <input v-model="q" class="search" placeholder="搜索租户 / 集群 / 主 Zone" spellcheck="false" />
          <select v-model="cluster">
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
          <button class="create" title="在指定集群新建租户" @click="tenantCreate = true">＋ 新建租户</button>
        </div>
      </div>

      <div class="table-wrap" data-ai="tenants.list">
        <table class="tbl">
          <thead data-src="tnList">
            <tr>
              <th>租户名</th><th>所属集群</th><th>模式</th><th>状态</th><th>角色</th>
              <th>Zone 优先级</th><th>Locality</th><th class="r">Unit</th><th class="r">租户 ID</th><th>创建时间</th>
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
            </tr>
            <tr v-if="!filtered.length"><td colspan="10" class="empty">没有匹配的租户</td></tr>
          </tbody>
        </table>
      </div>
      <div class="foot">点任意一行打开租户工作台（概览 / 副本 / 拓扑 / 库表 / 会话 / 事务 / SQL / 参数 / 合并 / 统计 / 备份 / 用户 / 安全）</div>
    </template>

    <UnitSpecManager v-else data-ai="tenants.unitSpecs" />
  </div>
  <TenantDrawer v-if="cloud.tenant" />
  <TenantCreate v-if="tenantCreate" @close="tenantCreate = false" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import TenantDrawer from './TenantDrawer.vue'
import TenantCreate from './TenantCreate.vue'
import UnitSpecManager from './tenant/UnitSpecManager.vue'
import { cloud, openTenant } from '../../cloud/state'
import { fmtTime, tenantStatus } from '../../cloud/parts'

const q = ref('')
const cluster = ref('')
const mode = ref('')
const role = ref('')
const tenantCreate = ref(false)
/** 页内 tab：租户列表 / Unit 规格（对齐 OCP 租户页） */
const sub = ref<'list' | 'spec'>('list')

const clusterNames = computed(() => [...new Set(cloud.tenants.map((t) => t.clusterName).filter(Boolean))])

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  return cloud.tenants.filter((t) => {
    if (cluster.value && t.clusterName !== cluster.value) return false
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
</style>
