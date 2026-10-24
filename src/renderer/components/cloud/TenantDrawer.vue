<template>
  <div class="td-mask" @click.self="closeTenant">
    <section class="td-shell" @click.stop>
      <header class="td-head">
        <div class="td-id">
          <div class="td-title">
            <b>{{ d.tenant.name }}</b>
            <span class="pill" :class="d.tenant.mode === 'ORACLE' ? 'info' : 'gray'">{{ d.tenant.mode }}</span>
            <span class="pill" :class="tenantStatus(d.tenant.status).tone">{{ tenantStatus(d.tenant.status).label }}</span>
            <span v-if="d.tenant.locked" class="pill warn">已锁定</span>
            <span v-if="d.tenant.readonly" class="pill warn">只读</span>
            <span v-if="d.tenant.role" class="pill" :class="d.tenant.role === 'PRIMARY' ? 'info' : 'gray'">{{ d.tenant.role }}</span>
          </div>
          <div class="td-sub" data-src="tnList" :data-tenant="d.tenant.name">
            {{ d.tenant.clusterName }}
            <i class="dot-sep">·</i> OB 租户 ID <span class="mono">{{ d.tenant.obTenantId }}</span>
            <i class="dot-sep">·</i> 主 Zone <span class="mono">{{ d.tenant.primaryZone || '—' }}</span>
            <i class="dot-sep">·</i> {{ d.zones.length }} 个副本
          </div>
        </div>
        <div class="td-head-actions">
          <button class="act" :class="{ on: tab === 'security' }" @click="tab = 'security'">安全</button>
          <button class="act" title="以当前租户为源克隆一个新租户" @click="cloneOpen = true">克隆</button>
          <button class="act" :disabled="busy" @click="refreshAll">刷新</button>
          <button class="act danger" :disabled="busy" @click="remove">删除租户</button>
          <button class="x" title="关闭（Esc）" @click="closeTenant">✕</button>
        </div>
      </header>

      <nav class="td-tabs">
        <button v-for="t in TABS" :key="t.key" class="td-tab" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }}
        </button>
      </nav>

      <div class="td-body">
        <KeepAlive>
          <component :is="activeComp" :key="tab" :reload-token="reloadToken" />
        </KeepAlive>
      </div>
    </section>
    <TenantClone v-if="cloneOpen" @close="cloneOpen = false" />
  </div>
</template>

<script setup lang="ts">
/**
 * 租户详情工作台（对齐 OCP 租户详情页的 13 个 tab）。
 *
 * 全屏覆盖而非侧边抽屉：OCP 的租户详情本身就是独立页面，库表/会话/SQL 这些 tab
 * 在 480px 抽屉里放不下。各面板组件自己拉数据，切换用 KeepAlive 保活。
 *
 * 危险动作（改密 / 白名单 / TDE）收进「安全」面板；头部只留锁定与删除的快捷入口。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { cloud, closeTenant, deleteTenant } from '../../cloud/state'
import { pushNotice } from '../../store'
import { tenantStatus } from '../../cloud/parts'
import TenantOverview from './tenant/TenantOverview.vue'
import TenantResource from './tenant/TenantResource.vue'
import TenantTopo from './tenant/TenantTopo.vue'
import TenantDatabases from './tenant/TenantDatabases.vue'
import TenantSessions from './tenant/TenantSessions.vue'
import TenantTxns from './tenant/TenantTxns.vue'
import TenantSql from './tenant/TenantSql.vue'
import TenantParams from './tenant/TenantParams.vue'
import TenantCompaction from './tenant/TenantCompaction.vue'
import TenantGather from './tenant/TenantGather.vue'
import TenantBackup from './tenant/TenantBackup.vue'
import TenantUsers from './tenant/TenantUsers.vue'
import TenantSecurity from './tenant/TenantSecurity.vue'
import TenantClone from './tenant/TenantClone.vue'

const d = computed(() => cloud.tenant as CloudTenantDetail)

const TABS = [
  { key: 'overview', label: '概览', comp: TenantOverview },
  { key: 'resource', label: '副本与资源', comp: TenantResource },
  { key: 'topo', label: '拓扑', comp: TenantTopo },
  { key: 'database', label: '库表', comp: TenantDatabases },
  { key: 'session', label: '会话', comp: TenantSessions },
  { key: 'txn', label: '事务', comp: TenantTxns },
  { key: 'sql', label: 'SQL 诊断', comp: TenantSql },
  { key: 'params', label: '参数', comp: TenantParams },
  { key: 'compaction', label: '合并', comp: TenantCompaction },
  { key: 'gather', label: '统计信息', comp: TenantGather },
  { key: 'backup', label: '备份', comp: TenantBackup },
  { key: 'users', label: '用户', comp: TenantUsers },
  { key: 'security', label: '安全', comp: TenantSecurity }
] as const

type TabKey = (typeof TABS)[number]['key']
const tab = ref<TabKey>('overview')
const activeComp = computed(() => TABS.find((t) => t.key === tab.value)!.comp)

const busy = ref(false)
/** 克隆租户弹窗 */
const cloneOpen = ref(false)
/** 头部「刷新」自增该值，各面板 watch 后重新拉自己的数据 */
const reloadToken = ref(0)
let refreshing = false

async function refreshAll(): Promise<void> {
  if (refreshing) return
  refreshing = true
  busy.value = true
  try {
    reloadToken.value++
  } finally {
    busy.value = false
    refreshing = false
  }
}

async function remove(): Promise<void> {
  const t = d.value.tenant
  const ok = await window.sqlpilot.uiConfirm(
    `删除租户「${t.name}」？`,
    '租户及其数据将被删除，操作不可恢复；OCP 会先做删除前检查。',
    true
  )
  if (!ok) return
  const r = await deleteTenant(t.clusterId, t.id)
  if (!r.ok) {
    await window.sqlpilot.uiAlert('删除租户失败', r.error || 'OCP 返回错误')
    return
  }
  pushNotice(r.taskId ? `删除租户任务已提交：任务 #${r.taskId}` : '删除租户任务已提交')
  closeTenant()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeTenant()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.td-mask {
  position: fixed; inset: 0; z-index: 260; background: rgba(6, 8, 14, 0.46);
  display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px);
}
.td-shell {
  width: min(1320px, 96vw); height: 92vh; background: var(--bg-card);
  border: 1px solid var(--border-strong); border-radius: 13px; box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column; overflow: hidden; animation: pop 0.16s ease;
}
@keyframes pop { from { transform: translateY(8px) scale(0.995); opacity: 0.7; } to { transform: none; opacity: 1; } }
.td-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 11px; }
.td-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.td-title b { font-size: 16px; }
.td-sub { font-size: 11px; color: var(--text-dim); margin-top: 5px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dot-sep { color: var(--text-faint); font-style: normal; }
.td-head-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.act { border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 7px; padding: 4px 11px; font-size: 11.5px; font-family: inherit; cursor: pointer; }
.act:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.act.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.act.danger:hover:not(:disabled) { color: var(--red); border-color: var(--red); }
.act:disabled { opacity: 0.5; cursor: not-allowed; }
.x { width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.td-tabs { display: flex; gap: 1px; padding: 0 14px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.td-tabs::-webkit-scrollbar { display: none; }
.td-tab {
  border: none; background: transparent; color: var(--text-faint); font-size: 12px; font-family: inherit;
  padding: 8px 11px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; flex-shrink: 0;
}
.td-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.td-tab:hover { color: var(--text); }
.td-body { flex: 1; overflow: hidden; display: flex; }
.mono { font-family: var(--mono); }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.pill.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.pill.gray { color: var(--text-dim); }
</style>
