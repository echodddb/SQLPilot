<template>
  <Teleport to="body">
    <div class="mask" @click.self="closeTenant">
      <section class="panel" @click.stop>
        <header class="ph">
          <div>
            <div class="title">
              <b>{{ t.tenant.name }}</b>
              <span class="pill">{{ t.tenant.mode }}</span>
              <span class="pill" :class="t.tenant.status === 'NORMAL' ? 'ok' : 'warn'">{{ t.tenant.status }}</span>
              <span v-if="t.tenant.locked" class="pill warn">已锁定</span>
            </div>
            <div class="sub">
              {{ t.tenant.clusterName }} · OB 租户 ID <span class="mono">{{ t.tenant.obTenantId }}</span>
              · 主 Zone <span class="mono">{{ t.tenant.primaryZone || '—' }}</span>
              · {{ t.zones.length }} 个 Zone
            </div>
          </div>
          <button class="x" title="关闭（Esc）" @click="closeTenant">✕</button>
        </header>

        <nav class="tabs">
          <button v-for="x in TABS" :key="x.key" class="tab" :class="{ on: tab === x.key }" @click="tab = x.key">
            {{ x.label }}
          </button>
        </nav>

        <div class="body">
          <!-- 概览 -->
          <template v-if="tab === 'overview'">
            <div class="attrs">
              <div><span>兼容模式</span><b>{{ t.tenant.mode }}</b></div>
              <div><span>管理员账号</span><b class="mono">{{ isOracle ? 'sys' : 'root' }}</b></div>
              <div><span>字符集</span><b class="mono">{{ t.charset }}</b></div>
              <div><span>排序规则</span><b class="mono">{{ t.collation }}</b></div>
              <div><span>Locality</span><b class="mono">{{ t.tenant.locality || '—' }}</b></div>
              <div><span>租户类型</span><b>{{ t.tenant.loadType || '—' }}</b></div>
              <div><span>角色</span><b>{{ t.tenant.role || 'PRIMARY' }}</b></div>
              <div><span>创建时间</span><b>{{ t.tenant.createTime || '—' }}</b></div>
            </div>
            <div class="fnote">
              <template v-if="isOracle">
                Oracle 兼容模式：管理员账号是 <b>SYS</b>，字符集固定 utf8mb4 / utf8mb4_bin，
                库对象以 Schema 为单位（「数据库」页看到的是 Schema 列表）。
              </template>
              <template v-else>
                MySQL 兼容模式：管理员账号是 <b>root</b>，字符集默认 utf8mb4 / utf8mb4_general_ci，
                含系统内置库（information_schema / mysql / oceanbase / sys），系统库不可删除。
              </template>
            </div>
          </template>

          <!-- 副本与资源 -->
          <template v-else-if="tab === 'resource'">
            <table class="tbl">
              <thead>
                <tr><th>Zone</th><th class="r">Unit 数</th><th class="r">CPU</th><th class="r">内存</th><th>Unit 落点</th></tr>
              </thead>
              <tbody>
                <tr v-for="z in t.zones" :key="z.name">
                  <td class="mono">{{ z.name }}</td>
                  <td class="r mono">{{ z.unitCount }}</td>
                  <td class="r mono">{{ round(z.unitCpu) }}</td>
                  <td class="r mono">{{ fmtMem(z.unitMemory) }}</td>
                  <td class="mono dim">{{ z.units.map((u) => `${u.ip}:${u.port}`).join('，') || '—' }}</td>
                </tr>
                <tr v-if="!t.zones.length"><td colspan="5" class="empty">没有 Unit 信息</td></tr>
              </tbody>
            </table>
          </template>

          <!-- 连接：连接串 + 业务凭据 -->
          <template v-else-if="tab === 'connect'">
            <div class="sec">连接串（口令以占位符表示，不会回显历史密码）</div>
            <div v-for="(c, i) in conns" :key="i" class="conn">
              <div class="conn-head">
                <span class="conn-label">{{ c.label }}</span>
                <button class="copy" @click="copy(c.command)">复制</button>
              </div>
              <code class="conn-cmd">{{ c.command }}</code>
            </div>
            <div v-if="!conns.length" class="dim">读取连接串中…</div>

            <div class="sec">业务租户凭据</div>
            <div class="cred">
              <div class="cred-status">
                <span v-if="cred.has" class="pill ok">已录入 {{ cred.user }}</span>
                <span v-else class="pill warn">未录入</span>
                <span class="dim">用于租户内部的建库 / 建账号 / 授权；密码加密保存在本机</span>
              </div>
              <div class="row">
                <label>账号</label>
                <input v-model="credForm.user" placeholder="root（MySQL）/ sys（Oracle）" spellcheck="false" />
                <label>密码</label>
                <input v-model="credForm.password" type="password" placeholder="留空表示沿用已保存的密码" />
                <button class="ghost" :disabled="!platformId || credBusy" @click="saveCred">保存</button>                <button class="ghost" :disabled="!cred.has || credBusy" @click="testCred">测试连接</button>
                <button class="ghost" :disabled="!cred.has || credBusy" @click="removeCred">清除</button>
              </div>
              <div v-if="credMsg" class="msg" :class="credOk ? 'ok' : 'err'">{{ credMsg }}</div>
            </div>
          </template>

          <!-- 会话 -->
          <template v-else-if="tab === 'session'">
            <div class="bar">
              <span class="dim">共 {{ sessions.length }} 个会话（最多显示 200）</span>
              <button class="ghost" @click="loadSessions">刷新</button>
            </div>
            <table class="tbl">
              <thead>
                <tr><th class="r">ID</th><th>用户</th><th>来源</th><th>库</th><th class="r">时长(s)</th><th>状态</th><th>当前 SQL</th></tr>
              </thead>
              <tbody>
                <tr v-for="s in sessions" :key="s.id">
                  <td class="r mono">{{ s.id }}</td>
                  <td class="mono">{{ s.user }}</td>
                  <td class="mono dim">{{ s.host }}</td>
                  <td class="mono dim">{{ s.db || '—' }}</td>
                  <td class="r mono">{{ s.seconds }}</td>
                  <td class="dim">{{ s.state || s.command }}</td>
                  <td class="mono dim ellipsis" :title="s.sql">{{ s.sql || '—' }}</td>
                </tr>
                <tr v-if="!sessions.length"><td colspan="7" class="empty">{{ loading ? '读取中…' : '该租户当前没有会话' }}</td></tr>
              </tbody>
            </table>
          </template>

          <!-- 数据库 -->
          <template v-else-if="tab === 'database'">
            <div v-if="!cred.has" class="need">
              <span>库对象需要在租户内部查询，请先到「连接」页录入业务租户凭据。</span>
              <button class="ghost" @click="tab = 'connect'">去录入</button>
            </div>
            <template v-else>
              <div class="bar">
                <span class="dim">{{ isOracle ? 'Schema' : '数据库' }} {{ dbRows.length }} 个（含系统内置）</span>
                <button class="ghost" @click="loadDbs">刷新</button>
                <button v-if="!isOracle" class="ghost" @click="dbFormOpen = !dbFormOpen">
                  {{ dbFormOpen ? '收起' : '＋ 新建数据库' }}
                </button>
              </div>
              <div v-if="dbFormOpen && !isOracle" class="row form">
                <label>库名</label>
                <input v-model="dbForm.name" placeholder="字母开头，如 app_order" spellcheck="false" />
                <label>字符集</label>
                <select v-model="dbForm.charset">
                  <option value="utf8mb4">utf8mb4</option>
                  <option value="utf8">utf8</option>
                  <option value="gbk">gbk</option>
                  <option value="latin1">latin1</option>
                </select>
                <button class="ghost" :disabled="dbBusy || !dbForm.name.trim()" @click="createDb">创建</button>
              </div>
              <div v-if="dbMsg" class="msg" :class="dbOk ? 'ok' : 'err'">{{ dbMsg }}</div>
              <table class="tbl">
                <thead><tr><th>{{ isOracle ? 'Schema' : '数据库' }}</th><th>字符集</th><th>排序规则</th><th class="r">操作</th></tr></thead>
                <tbody>
                  <tr v-for="d in dbRows" :key="d.name">
                    <td class="mono">{{ d.name }}<span v-if="d.system" class="mini">系统</span></td>
                    <td class="mono dim">{{ d.charset || '—' }}</td>
                    <td class="mono dim">{{ d.collation || '—' }}</td>
                    <td class="r">
                      <button
                        class="op danger"
                        :disabled="d.system || dbBusy"
                        :title="d.system ? '系统内置库禁止删除' : '删除该库'"
                        @click="dropDb(d.name)"
                      >删除</button>
                    </td>
                  </tr>
                  <tr v-if="!dbRows.length"><td colspan="4" class="empty">{{ loading ? '读取中…' : '没有可展示的库对象' }}</td></tr>
                </tbody>
              </table>
            </template>
          </template>

          <!-- 用户 -->
          <template v-else-if="tab === 'user'">
            <div v-if="!cred.has" class="need">
              <span>账号管理需要在租户内部执行，请先到「连接」页录入业务租户凭据。</span>
              <button class="ghost" @click="tab = 'connect'">去录入</button>
            </div>
            <template v-else>
              <div class="bar">
                <span class="dim">账号 {{ userRows.length }} 个</span>
                <button class="ghost" @click="loadUsers">刷新</button>
                <button class="ghost" @click="userFormOpen = !userFormOpen">{{ userFormOpen ? '收起' : '＋ 新建账号' }}</button>
              </div>
              <div v-if="userFormOpen" class="row form">
                <label>账号</label>
                <input v-model="userForm.name" placeholder="如 app_user" spellcheck="false" />
                <template v-if="!isOracle">
                  <label>Host</label>
                  <input v-model="userForm.host" placeholder="%" spellcheck="false" />
                </template>
                <label>密码</label>
                <input v-model="userForm.password" type="password" placeholder="初始密码" />
                <button class="ghost" :disabled="userBusy || !userForm.name.trim() || !userForm.password" @click="createUser">创建</button>
              </div>
              <div v-if="userMsg" class="msg" :class="userOk ? 'ok' : 'err'">{{ userMsg }}</div>
              <table class="tbl">
                <thead><tr><th>账号</th><th v-if="!isOracle">Host</th><th>状态</th><th class="r">操作</th></tr></thead>
                <tbody>
                  <tr v-for="u in userRows" :key="`${u.user}@${u.host}`">
                    <td class="mono">{{ u.user }}</td>
                    <td v-if="!isOracle" class="mono dim">{{ u.host || '%' }}</td>
                    <td class="dim">{{ u.status || '—' }}</td>
                    <td class="r">
                      <button class="op" @click="openGrant(u)">授权</button>
                      <button class="op danger" :disabled="userBusy" @click="dropUser(u)">删除</button>
                    </td>
                  </tr>
                  <tr v-if="!userRows.length"><td :colspan="isOracle ? 3 : 4" class="empty">{{ loading ? '读取中…' : '读取不到账号（视图可能未开放）' }}</td></tr>
                </tbody>
              </table>

              <div v-if="grant.open" class="row form">
                <label>为 {{ grant.name }} 授权</label>
                <input v-if="!isOracle" v-model="grant.db" placeholder="库名，留空=所有库" spellcheck="false" />
                <input v-model="grant.priv" placeholder="SELECT,INSERT,UPDATE 或 ALL PRIVILEGES" spellcheck="false" />
                <button class="ghost" :disabled="userBusy" @click="doGrant">执行授权</button>
                <button class="ghost" @click="grant.open = false">取消</button>
              </div>
            </template>
          </template>

          <!-- 参数（分页） -->
          <template v-else-if="tab === 'params'">
            <div class="bar">
              <input v-model="paramKw" class="search" placeholder="搜索参数名 / 说明" spellcheck="false" @keyup.enter="loadParams" />
              <button class="ghost" @click="loadParams">查询</button>
              <span class="dim">共 {{ params.length }} 项</span>
            </div>
            <table class="tbl">
              <thead><tr><th>参数</th><th>值</th><th>可编辑级别</th></tr></thead>
              <tbody>
                <tr v-for="p in pagedParams" :key="p.name">
                  <td class="mono">{{ p.name }}</td>
                  <td class="mono dim ellipsis" :title="p.value">{{ p.value || '—' }}</td>
                  <td class="dim">{{ p.editLevel || '—' }}</td>
                </tr>
                <tr v-if="!params.length"><td colspan="3" class="empty">{{ loading ? '读取中…' : '没有匹配的参数' }}</td></tr>
              </tbody>
            </table>
            <div class="pager">
              <button class="ghost" :disabled="paramPage <= 1" @click="paramPage--">上一页</button>
              <span class="dim">{{ paramPage }} / {{ paramPages }}</span>
              <button class="ghost" :disabled="paramPage >= paramPages" @click="paramPage++">下一页</button>
            </div>
          </template>

          <!-- TopSQL（分页） -->
          <template v-else>
            <div class="bar">
              <select v-model.number="sqlHours" @change="loadTopSql">
                <option :value="1">近 1 小时</option>
                <option :value="6">近 6 小时</option>
                <option :value="24">近 24 小时</option>
                <option :value="72">近 3 天</option>
              </select>
              <button class="ghost" @click="loadTopSql">刷新</button>
              <span class="dim">共 {{ topSql.length }} 条</span>
            </div>
            <table class="tbl">
              <thead>
                <tr><th>SQL ID</th><th class="r">执行次数</th><th class="r">平均耗时</th><th class="r">最大耗时</th><th>SQL</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in pagedSql" :key="r.sqlId">
                  <td class="mono">{{ r.sqlId }}</td>
                  <td class="r mono">{{ r.executions }}</td>
                  <td class="r mono">{{ r.avgElapsedMs }} ms</td>
                  <td class="r mono">{{ r.maxElapsedMs }} ms</td>
                  <td class="mono dim ellipsis" :title="r.sqlText">{{ r.sqlText || '—' }}</td>
                </tr>
                <tr v-if="!topSql.length"><td colspan="5" class="empty">{{ loading ? '读取中…' : '窗口内没有审计数据（可能未开启 SQL 审计）' }}</td></tr>
              </tbody>
            </table>
            <div class="pager">
              <button class="ghost" :disabled="sqlPage <= 1" @click="sqlPage--">上一页</button>
              <span class="dim">{{ sqlPage }} / {{ sqlPages }}</span>
              <button class="ghost" :disabled="sqlPage >= sqlPages" @click="sqlPage++">下一页</button>
            </div>
          </template>
        </div>

        <footer class="ft">
          <button class="btn" :disabled="!platformId" @click="askOp(t.tenant.locked ? 'unlock' : 'lock')">
            {{ t.tenant.locked ? '解锁租户' : '锁定租户' }}
          </button>
          <button
            class="btn danger"
            :disabled="!platformId || isSys || !t.tenant.locked"
            :title="t.tenant.locked ? '删除该租户' : '需先锁定租户才能删除'"
            @click="askOp('delete')"
          >
            删除租户
          </button>
          <span class="spacer" />
          <button class="btn" @click="reloadAll">刷新</button>
          <button class="btn" @click="closeTenant">关闭</button>
        </footer>
      </section>

      <DirectOpModal
        v-if="opAction"
        :platform-id="platformId"
        :action="opAction"
        :tenant="{ name: t.tenant.name, clusterName: t.tenant.clusterName, locked: t.tenant.locked }"
        @close="opAction = null"
        @done="onOpDone"
      />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 直连模式的租户详情。
 *
 * tab 按 OCP 租户详情的口径挑可实现子集：概览 / 副本与资源 / 连接 / 会话 / 数据库 / 用户 / 参数 / TopSQL。
 * 其中「数据库」「用户」在**业务租户内部**执行，需要用户先录入该租户的凭据（与平台 sys 连接是两回事）。
 * 参数与 TopSQL 都是「一次性取回 + 前端分页」，避免几百行把页面撑开。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cloud, closeTenant, load, openTenant } from '../../../cloud/state'
import {
  clearTenantCred,
  dropDbAs,
  createDbAs,
  createUserAs,
  dropUserAs,
  grantAs,
  platformOfCluster,
  saveTenantCred,
  tenantConnections,
  tenantCredStatus,
  tenantDbsAs,
  tenantParams,
  tenantSessions,
  tenantTopSql,
  tenantUsersAs,
  testTenantLogin
} from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'
import DirectOpModal from './DirectOpModal.vue'

type TabKey = 'overview' | 'resource' | 'connect' | 'session' | 'database' | 'user' | 'params' | 'topsql'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'resource', label: '副本与资源' },
  { key: 'connect', label: '连接' },
  { key: 'session', label: '会话' },
  { key: 'database', label: '数据库' },
  { key: 'user', label: '用户' },
  { key: 'params', label: '参数' },
  { key: 'topsql', label: 'TopSQL' }
]

const PAGE_SIZE = 20

const t = computed(() => cloud.tenant as CloudTenantDetail)
const platformId = computed(() => platformOfCluster(t.value.tenant.clusterId))
const isSys = computed(() => String(t.value.tenant.name).toLowerCase() === 'sys')
const isOracle = computed(() => t.value.tenant.mode === 'ORACLE')

const tab = ref<TabKey>('overview')
const loading = ref(false)
const opAction = ref<'lock' | 'unlock' | 'delete' | null>(null)

// 连接 / 凭据
const conns = ref<{ label: string; command: string }[]>([])
const cred = ref<{ has: boolean; user?: string }>({ has: false })
const credForm = ref({ user: '', password: '' })
const credBusy = ref(false)
const credMsg = ref('')
const credOk = ref(true)

// 会话
const sessions = ref<Awaited<ReturnType<typeof tenantSessions>>>([])
// 数据库
const dbRows = ref<Awaited<ReturnType<typeof tenantDbsAs>>['rows']>([])
const dbFormOpen = ref(false)
const dbForm = ref({ name: '', charset: 'utf8mb4' })
const dbBusy = ref(false)
const dbMsg = ref('')
const dbOk = ref(true)
// 用户
const userRows = ref<Awaited<ReturnType<typeof tenantUsersAs>>['rows']>([])
const userFormOpen = ref(false)
const userForm = ref({ name: '', host: '%', password: '' })
const userBusy = ref(false)
const userMsg = ref('')
const userOk = ref(true)
const grant = ref({ open: false, name: '', host: '%', db: '', priv: 'SELECT' })
// 参数 / TopSQL
const params = ref<Awaited<ReturnType<typeof tenantParams>>>([])
const paramKw = ref('')
const paramPage = ref(1)
const topSql = ref<Awaited<ReturnType<typeof tenantTopSql>>>([])
const sqlHours = ref(24)
const sqlPage = ref(1)

const paramPages = computed(() => Math.max(1, Math.ceil(params.value.length / PAGE_SIZE)))
const pagedParams = computed(() => params.value.slice((paramPage.value - 1) * PAGE_SIZE, paramPage.value * PAGE_SIZE))
const sqlPages = computed(() => Math.max(1, Math.ceil(topSql.value.length / PAGE_SIZE)))
const pagedSql = computed(() => topSql.value.slice((sqlPage.value - 1) * PAGE_SIZE, sqlPage.value * PAGE_SIZE))

const round = (n: number): string => String(Math.round((Number(n) || 0) * 10) / 10)
function fmtMem(bytes: number): string {
  const b = Number(bytes) || 0
  const gb = b / 1024 ** 3
  return gb >= 1 ? `${Math.round(gb * 10) / 10}G` : `${Math.round(b / 1024 ** 2)}M`
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    pushNotice('已复制')
  } catch {
    void window.sqlpilot.uiAlert('复制失败', '当前环境不允许访问剪贴板，请手动选中复制。')
  }
}

// ---------------- 数据加载 ----------------

async function loadConnect(): Promise<void> {
  if (!platformId.value) return
  conns.value = await tenantConnections(platformId.value, t.value.tenant.name, isOracle.value ? 'ORACLE' : 'MYSQL')
  const s = await tenantCredStatus(platformId.value, t.value.tenant.name)
  cred.value = s
  if (s.has && !credForm.value.user) credForm.value.user = s.user || ''
}

async function loadSessions(): Promise<void> {
  if (!platformId.value) return
  loading.value = true
  try {
    sessions.value = await tenantSessions(platformId.value, t.value.tenant.name)
  } finally {
    loading.value = false
  }
}

async function loadDbs(): Promise<void> {
  if (!platformId.value || !cred.value.has) return
  // Oracle 模式没有 database 概念，直接查 information_schema 会报错，这里给明确说明
  if (isOracle.value) {
    dbRows.value = []
    dbOk.value = true
    dbMsg.value = 'Oracle 模式以 Schema 为单位，暂不提供库级管理；账号与授权请到「用户」页操作。'
    return
  }
  loading.value = true
  dbMsg.value = ''
  dbOk.value = true
  try {
    const r = await tenantDbsAs(platformId.value, t.value.tenant.name)
    dbRows.value = r.rows
    if (r.error) {
      dbOk.value = false
      dbMsg.value = r.error
    }
  } finally {
    loading.value = false
  }
}

async function loadUsers(): Promise<void> {
  if (!platformId.value || !cred.value.has) return
  loading.value = true
  userMsg.value = ''
  userOk.value = true
  try {
    const r = await tenantUsersAs(platformId.value, t.value.tenant.name, isOracle.value ? 'ORACLE' : 'MYSQL')
    userRows.value = r.rows
    if (r.error) {
      userOk.value = false
      userMsg.value = r.error
    }
  } finally {
    loading.value = false
  }
}

async function loadParams(): Promise<void> {
  if (!platformId.value) return
  loading.value = true
  try {
    params.value = await tenantParams(platformId.value, t.value.tenant.obTenantId, paramKw.value.trim() || undefined)
    paramPage.value = 1
  } finally {
    loading.value = false
  }
}

async function loadTopSql(): Promise<void> {
  if (!platformId.value) return
  loading.value = true
  try {
    topSql.value = await tenantTopSql(platformId.value, t.value.tenant.obTenantId, sqlHours.value)
    sqlPage.value = 1
  } finally {
    loading.value = false
  }
}

async function loadTab(k: TabKey): Promise<void> {
  if (!platformId.value) return
  if (k === 'connect') return loadConnect()
  if (k === 'session') return loadSessions()
  if (k === 'database') return loadDbs()
  if (k === 'user') return loadUsers()
  if (k === 'params') return loadParams()
  if (k === 'topsql') return loadTopSql()
  if (k === 'overview') {
    // 概览不额外请求，但凭据状态决定「数据库/用户」页的入口，顺手探一次
    const s = await tenantCredStatus(platformId.value, t.value.tenant.name)
    cred.value = s
    if (s.has && !credForm.value.user) credForm.value.user = s.user || ''
  }
}

watch(tab, (k) => void loadTab(k))

// ---------------- 凭据 ----------------

async function saveCred(): Promise<void> {
  if (!platformId.value) return
  credBusy.value = true
  credMsg.value = ''
  try {
    const user = credForm.value.user.trim()
    const r = await saveTenantCred(platformId.value, t.value.tenant.name, user, credForm.value.password)
    if (!r.ok) {
      credOk.value = false
      credMsg.value = r.error || '保存失败'
      return
    }
    credForm.value.password = ''
    await loadConnect()

    // 保存后立刻试连一次：密码为空 / 密码错在这一步就暴露，
    // 而不是等用户切到「数据库」页才看到一句英文 Access denied。
    const base = r.keptPassword ? '凭据已保存（账号已更新，密码沿用原值）' : '凭据已保存（密码已加密存储于本机）'
    const tested = await testTenantLogin(platformId.value, t.value.tenant.name)
    credOk.value = tested.ok
    credMsg.value = tested.ok ? `${base}，连接测试通过` : `${base}，但连接测试未通过：${tested.message}`

    // 凭据变了，旧凭据取到的库 / 账号列表一律作废并立即重取，
    // 否则界面会继续显示上一次（甚至上一个租户）的结果，看着像"能查到但报错"。
    await reloadAfterCredChange()
  } finally {
    credBusy.value = false
  }
}

/** 凭据变更后清空依赖凭据的数据，并重取当前 tab */
async function reloadAfterCredChange(): Promise<void> {
  dbRows.value = []
  userRows.value = []
  dbMsg.value = ''
  userMsg.value = ''
  dbOk.value = true
  userOk.value = true
  await loadTab(tab.value)
}

async function testCred(): Promise<void> {
  if (!platformId.value) return
  credBusy.value = true
  try {
    const r = await testTenantLogin(platformId.value, t.value.tenant.name)
    credOk.value = r.ok
    credMsg.value = r.message
  } finally {
    credBusy.value = false
  }
}

async function removeCred(): Promise<void> {
  if (!platformId.value) return
  const ok = await window.sqlpilot.uiConfirm('清除凭据', '清除后需要重新录入才能做租户内部操作。确定？', false)
  if (!ok) return
  await clearTenantCred(platformId.value, t.value.tenant.name)
  cred.value = { has: false }
  credForm.value = { user: '', password: '' }
  credMsg.value = '已清除'
  credOk.value = true
  dbRows.value = []
  userRows.value = []
}

// ---------------- 库 / 账号 ----------------

async function createDb(): Promise<void> {
  if (!platformId.value) return
  dbBusy.value = true
  dbMsg.value = ''
  try {
    const r = await createDbAs(platformId.value, t.value.tenant.name, {
      name: dbForm.value.name.trim(),
      charset: dbForm.value.charset
    })
    dbOk.value = r.ok
    dbMsg.value = r.ok ? r.message || '已创建' : r.error || '创建失败'
    if (r.ok) {
      dbForm.value.name = ''
      dbFormOpen.value = false
      await loadDbs()
    }
  } finally {
    dbBusy.value = false
  }
}

async function dropDb(name: string): Promise<void> {
  if (!platformId.value) return
  const ok = await window.sqlpilot.uiConfirm(`删除数据库「${name}」？`, '库内所有对象会一并删除，不可恢复。', true)
  if (!ok) return
  dbBusy.value = true
  try {
    const r = await dropDbAs(platformId.value, t.value.tenant.name, name)
    dbOk.value = r.ok
    dbMsg.value = r.ok ? `已删除 ${name}` : r.error || '删除失败'
    if (r.ok) await loadDbs()
  } finally {
    dbBusy.value = false
  }
}

async function createUser(): Promise<void> {
  if (!platformId.value) return
  userBusy.value = true
  userMsg.value = ''
  try {
    const r = await createUserAs(platformId.value, t.value.tenant.name, {
      name: userForm.value.name.trim(),
      host: isOracle.value ? undefined : userForm.value.host.trim() || '%',
      password: userForm.value.password,
      mode: isOracle.value ? 'ORACLE' : 'MYSQL'
    })
    userOk.value = r.ok
    userMsg.value = r.ok ? r.message || '已创建' : r.error || '创建失败'
    if (r.ok) {
      userForm.value = { name: '', host: '%', password: '' }
      userFormOpen.value = false
      await loadUsers()
    }
  } finally {
    userBusy.value = false
  }
}

async function dropUser(u: { user: string; host: string }): Promise<void> {
  if (!platformId.value) return
  const ok = await window.sqlpilot.uiConfirm(
    `删除账号「${u.user}${isOracle.value ? '' : `@${u.host}`}」？`,
    isOracle.value ? 'Oracle 模式会连带删除该用户下的所有对象（CASCADE）。' : '删除后该账号立即失效。',
    true
  )
  if (!ok) return
  userBusy.value = true
  try {
    const r = await dropUserAs(platformId.value, t.value.tenant.name, {
      name: u.user,
      host: isOracle.value ? undefined : u.host,
      mode: isOracle.value ? 'ORACLE' : 'MYSQL'
    })
    userOk.value = r.ok
    userMsg.value = r.ok ? `已删除 ${u.user}` : r.error || '删除失败'
    if (r.ok) await loadUsers()
  } finally {
    userBusy.value = false
  }
}

function openGrant(u: { user: string; host: string }): void {
  grant.value = { open: true, name: u.user, host: u.host, db: '', priv: isOracle.value ? 'CONNECT' : 'SELECT' }
}

async function doGrant(): Promise<void> {
  if (!platformId.value) return
  userBusy.value = true
  try {
    const r = await grantAs(platformId.value, t.value.tenant.name, {
      name: grant.value.name,
      host: isOracle.value ? undefined : grant.value.host,
      database: isOracle.value ? undefined : grant.value.db.trim() || undefined,
      privileges: grant.value.priv.trim(),
      mode: isOracle.value ? 'ORACLE' : 'MYSQL'
    })
    userOk.value = r.ok
    userMsg.value = r.ok ? r.message || '已授权' : r.error || '授权失败'
    if (r.ok) grant.value.open = false
  } finally {
    userBusy.value = false
  }
}

// ---------------- 操作 ----------------

async function reloadAll(): Promise<void> {
  const cur = t.value.tenant
  await openTenant(cur.clusterId, cur.obTenantId)
  await loadTab(tab.value)
}

/**
 * 锁定 / 解锁 / 删除的统一入口。
 * 三个动作都直接改实例状态、且直连模式没有回滚，因此一律先二次确认，
 * 再交给执行进度弹窗（那里会在完成后停留展示结果，关掉才刷新）。
 */
async function askOp(kind: 'lock' | 'unlock' | 'delete'): Promise<void> {
  if (!platformId.value) return
  const name = t.value.tenant.name
  if (kind === 'delete') {
    const ok = await window.sqlpilot.uiConfirm(
      `删除租户「${name}」？`,
      '删除后不可恢复；资源池不会被自动回收，需要到「资源池」页手工清理。',
      true
    )
    if (!ok) return
  } else if (kind === 'lock') {
    const ok = await window.sqlpilot.uiConfirm(
      `锁定租户「${name}」？`,
      '锁定后该租户拒绝写入（仍可读），业务侧会立刻感知。',
      false
    )
    if (!ok) return
  } else {
    const ok = await window.sqlpilot.uiConfirm(`解锁租户「${name}」？`, '解锁后该租户恢复读写。', false)
    if (!ok) return
  }
  opAction.value = kind
}

async function onOpDone(): Promise<void> {
  const wasDelete = opAction.value === 'delete'
  opAction.value = null
  if (wasDelete) {
    closeTenant()
    await load()
    return
  }
  await reloadAll()
  await load()
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 执行进度弹窗打开时，Esc 不该把整个详情一起关掉（否则刚执行完的结果看不到了）
  if (opAction.value) return
  closeTenant()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  void loadTab('overview')
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 300; background: rgba(5, 7, 12, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 22px;
  padding-top: var(--titlebar-h); backdrop-filter: blur(2px);
}
.panel {
  width: 980px; max-width: 100%;
  /* 固定高度：默认 560px（约为「概览」页自增高度的 1.3 倍）。
     超出内容由 .body 内部滚动，切换 tab 时窗口不再忽高忽低。 */
  height: min(88vh, 560px);
  display: flex; flex-direction: column;
  background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px;
  box-shadow: var(--shadow-lg);
}
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.title { display: flex; align-items: center; gap: 7px; font-size: 14px; }
.title b { font-size: 15px; }
.sub { font-size: 11px; color: var(--text-faint); margin-top: 4px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-dim); background: var(--bg-card); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); }
.tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab { border: none; background: none; color: var(--text-dim); font-family: inherit; font-size: 11.5px; padding: 8px 10px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab.on { color: var(--accent); border-bottom-color: var(--accent); }
/* flex:1 + min-height:0 才能让 body 在固定高度面板里正确滚动，而不是把面板撑开 */
.body { flex: 1; min-height: 0; padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.attrs { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px 18px; font-size: 11.5px; }
.attrs div { display: flex; gap: 8px; }
.attrs span { color: var(--text-faint); min-width: 74px; }
.attrs b { font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bar .dim { font-size: 11px; color: var(--text-faint); }
input, select { background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text); padding: 5px 8px; font-size: 11.5px; font-family: inherit; outline: none; }
input:focus, select:focus { border-color: var(--accent); }
.search { flex: 1; max-width: 280px; }
.ghost, .op {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text);
  border-radius: 7px; padding: 5px 10px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.ghost:hover:not(:disabled), .op:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.ghost:disabled, .op:disabled { opacity: 0.45; cursor: not-allowed; }
.op { padding: 2px 8px; font-size: 10.5px; }
/* 危险操作默认中性，hover 才泛红：整片红色反而削弱了"删除"的警示层级 */
.op.danger { color: var(--text-dim); border-color: var(--border); }
.op.danger:hover:not(:disabled) { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.row label { font-size: 11px; color: var(--text-dim); }
.form { border: 1px solid var(--border); background: var(--bg-card); border-radius: 8px; padding: 8px 10px; }
.sec { font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; padding-top: 6px; border-top: 1px dashed var(--border); }
.tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tbl th, .tbl td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.tbl th { font-size: 10.5px; color: var(--text-faint); font-weight: 500; background: var(--bg-card); }
.tbl .r { text-align: right; }
.tbl .empty { text-align: center; color: var(--text-faint); padding: 16px; }
.mono { font-family: var(--mono); }
.dim { color: var(--text-faint); }
.ellipsis { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }
.mini { font-size: 9.5px; color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent); border-radius: 4px; padding: 0 4px; margin-left: 5px; }
.fnote { font-size: 11px; line-height: 1.7; color: var(--text-faint); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.fnote b { color: var(--text); font-weight: 600; }
.need { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--text-dim); background: var(--bg-input); border: 1px dashed var(--border); border-radius: 8px; padding: 12px; }
.msg { font-size: 11.5px; border-radius: 8px; padding: 7px 10px; line-height: 1.6; }
.msg.ok { color: var(--green); background: var(--green-dim); }
.msg.err { color: var(--red); background: var(--red-dim); }
.conn { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); padding: 7px 9px; }
.conn-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.conn-label { font-size: 11px; color: var(--text-dim); }
.copy { margin-left: auto; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); border-radius: 6px; padding: 2px 8px; font-size: 10.5px; font-family: inherit; cursor: pointer; }
.copy:hover { color: var(--accent); border-color: var(--accent); }
.conn-cmd { display: block; font-family: var(--mono); font-size: 10.5px; color: var(--text); white-space: pre-wrap; word-break: break-all; line-height: 1.7; }
.cred { display: flex; flex-direction: column; gap: 8px; }
.cred-status { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.pager { display: flex; align-items: center; gap: 10px; justify-content: flex-end; font-size: 11px; }
.ft { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
.spacer { flex: 1; }
.btn { border: 1px solid var(--border); background: var(--bg-input); color: var(--text); border-radius: 8px; padding: 6px 12px; font-size: 12px; font-family: inherit; cursor: pointer; }
.btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.danger { color: var(--text-dim); border-color: var(--border); }
.btn.danger:hover:not(:disabled) { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
</style>
