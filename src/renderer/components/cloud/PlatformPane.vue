<template>
  <div class="tp-pane pp">
    <div class="tp-bar tabs">
      <button v-for="t in TABS" :key="t.key" class="tab" :class="{ on: p.tab === t.key }" @click="setPlatformTab(t.key)">
        {{ t.label }}<em v-if="countOf(t.key)">{{ countOf(t.key) }}</em>
      </button>
      <span class="sp"></span>
      <input
        v-if="p.tab === 'properties'"
        v-model="p.propKeyword"
        class="tp-input tp-search"
        placeholder="搜索参数 key / 说明"
        spellcheck="false"
      />
      <input
        v-else-if="p.tab === 'users' || p.tab === 'roles' || p.tab === 'logins'"
        v-model="kw"
        class="tp-input tp-search"
        :placeholder="p.tab === 'logins' ? '搜索用户 / IP' : p.tab === 'roles' ? '搜索角色名称' : '搜索用户名 / 邮箱'"
        spellcheck="false"
      />
      <button class="tp-btn sm ghost" :disabled="cloud.loading" @click="refresh">刷新</button>
    </div>

    <!-- 用户 -->
    <div v-if="p.tab === 'users'" class="tp-tbl-wrap" data-ai="platform.users">
      <table class="tp-tbl">
        <thead><tr><th>用户名</th><th>角色</th><th>邮箱</th><th>组织 / 部门</th><th>来源</th><th>状态</th><th>最近改密</th><th>创建时间</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>
              <div class="cell-main">{{ u.username }}</div>
              <div class="cell-sub tp-mono">#{{ u.id }}</div>
            </td>
            <td>
              <span v-for="r in u.roles" :key="r" class="tp-chip" :class="r === 'ADMIN' ? 'warn' : 'idle'">{{ r }}</span>
              <span v-if="!u.roles.length" class="tp-dim">—</span>
            </td>
            <td class="tp-mono tp-dim">{{ u.email || '—' }}</td>
            <td class="tp-dim">{{ u.organization || '—' }}<span v-if="u.department"> / {{ u.department }}</span></td>
            <td class="tp-dim">{{ u.origin || '—' }}</td>
            <td>
              <span class="tp-chip" :class="u.enabled ? 'ok' : 'idle'">{{ u.enabled ? '启用' : '禁用' }}</span>
              <span v-if="u.locked" class="tp-chip bad">已锁定</span>
              <span v-if="u.accountExpired" class="tp-chip warn">已过期</span>
            </td>
            <td class="tp-mono tp-dim">{{ u.lastPasswordChange ? fmtTime(u.lastPasswordChange) : '—' }}</td>
            <td class="tp-mono tp-dim">{{ u.createTime ? fmtTime(u.createTime) : '—' }}</td>
          </tr>
          <tr v-if="!users.length"><td colspan="8" class="tp-empty">没有匹配的用户</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 角色 -->
    <div v-if="p.tab === 'roles'" class="tp-tbl-wrap scroll" data-ai="platform.users">
      <table class="tp-tbl">
        <thead><tr><th>角色名称</th><th>类型</th><th>说明</th><th>组织</th><th class="r">用户</th><th class="r">资源权限</th><th>创建时间</th></tr></thead>
        <tbody>
          <tr v-for="r in roles" :key="r.id">
            <td class="tp-mono">{{ r.name }}</td>
            <td><span class="tp-chip" :class="r.type === 'DEFAULT' ? 'warn' : 'idle'">{{ r.type === 'DEFAULT' ? '默认角色' : '自定义' }}</span></td>
            <td class="tp-dim ell" :title="r.description">{{ r.description || '—' }}</td>
            <td class="tp-dim">{{ r.organization || '—' }}</td>
            <td class="r tp-mono">{{ r.userCount }}</td>
            <td class="r tp-mono">{{ r.permissionCount }}</td>
            <td class="tp-mono tp-dim">{{ r.createTime ? fmtTime(r.createTime) : '—' }}</td>
          </tr>
          <tr v-if="!roles.length"><td colspan="7" class="tp-empty">没有匹配的角色</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 平台参数 -->
    <div v-if="p.tab === 'properties'" class="tp-card flat" data-ai="platform.params">
      <div class="tp-tbl-wrap scroll">
        <table class="tp-tbl">
          <thead><tr><th>参数</th><th>当前值</th><th>运行值</th><th>类型</th><th>Profile</th><th>需重启</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="x in props" :key="x.id">
              <td class="tp-mono">{{ x.key }}<span v-if="x.label" class="tp-faint"> · {{ x.label }}</span></td>
              <td class="tp-mono val" :title="x.value">{{ x.value || '—' }}</td>
              <td class="tp-mono tp-dim val" :title="x.runningValue">{{ x.runningValue || '—' }}</td>
              <td class="tp-dim">{{ x.type || '—' }}</td>
              <td class="tp-dim">{{ x.profile || '—' }}</td>
              <td><span v-if="x.needRestart" class="tp-chip warn">是</span><span v-else class="tp-dim">否</span></td>
              <td class="tp-dim ell" :title="x.description">{{ x.description || '—' }}</td>
            </tr>
            <tr v-if="!props.length"><td colspan="7" class="tp-empty">没有匹配的参数</td></tr>
          </tbody>
        </table>
      </div>
      <div class="tp-bar pager">
        <span class="tp-dim">
          共 {{ p.bundle?.propertyTotal || 0 }} 项，当前第 {{ p.propPage }} / {{ propPages }} 页
          <span v-if="p.propKeyword" class="tp-faint">（本页内过滤）</span>
        </span>
        <span class="sp"></span>
        <button class="tp-btn sm ghost" :disabled="p.propPage <= 1" @click="loadPlatformProperties(p.propPage - 1)">上一页</button>
        <button class="tp-btn sm ghost" :disabled="p.propPage >= propPages" @click="loadPlatformProperties(p.propPage + 1)">下一页</button>
      </div>
    </div>

    <!-- 登录审计 -->
    <div v-if="p.tab === 'logins'" class="tp-card flat" data-ai="platform.logins">
      <div class="tp-tbl-wrap scroll">
        <table class="tp-tbl">
          <thead><tr><th>时间</th><th>用户</th><th>来源 IP</th><th>结果</th><th>客户端</th></tr></thead>
          <tbody>
            <tr v-for="(l, i) in logins" :key="`${l.userId}-${l.loginTime}-${i}`">
              <td class="tp-mono tp-dim">{{ l.loginTime ? fmtTime(l.loginTime) : '—' }}</td>
              <td class="tp-mono">{{ l.username || `#${l.userId}` }}</td>
              <td class="tp-mono tp-dim">{{ l.clientAddress || '—' }}</td>
              <td>
                <span class="tp-chip" :class="l.loginResult === 'SUCCESS' ? 'ok' : 'bad'">
                  {{ l.loginResult === 'SUCCESS' ? '成功' : l.loginResult || '—' }}
                </span>
              </td>
              <td class="tp-dim ell" :title="l.userAgent">{{ l.userAgent || '—' }}</td>
            </tr>
            <tr v-if="!logins.length"><td colspan="5" class="tp-empty">没有匹配的登录记录</td></tr>
          </tbody>
        </table>
      </div>
      <div class="tp-note">共 {{ p.bundle?.loginTotal || 0 }} 条登录记录，展示最近 50 条。SQLPilot 自身的访问也会记在这里（UA 为 SQLPilot-CloudConsole）。</div>
    </div>

    <!-- 系统信息 -->
    <div v-if="p.tab === 'system'" class="sys">
      <div class="tp-card">
        <div class="tp-h">系统能力</div>
        <div class="tp-kv-grid">
          <div class="tp-kv"><span>认证方式</span><b>{{ sys?.authType || '—' }}</b></div>
          <div class="tp-kv"><span>监控采集间隔</span><b class="tp-mono">{{ sys?.monitorInterval ? sys.monitorInterval + ' s' : '—' }}</b></div>
          <div class="tp-kv"><span>VPC 模式</span><b>{{ sys?.vpcModeEnabled ? '已开启' : '关闭' }}</b></div>
          <div class="tp-kv"><span>多集群（MC）</span><b>{{ sys?.multiClusterEnabled ? '已开启' : '关闭' }}</b></div>
          <div class="tp-kv"><span>只读模式</span><b :class="sys?.readOnly ? 'bad-t' : ''">{{ sys?.readOnly ? '已开启' : '关闭' }}</b></div>
          <div class="tp-kv"><span>AI 助手</span><b>{{ sys?.aiAssistantStatus || '—' }}</b></div>
          <div class="tp-kv"><span>SQL 诊断</span><b>{{ sys?.analyzeEnabled ? '已开启' : '关闭' }}</b></div>
          <div class="tp-kv"><span>文件服务</span><b>{{ sys?.fileServerType || '—' }}</b></div>
        </div>
      </div>
      <div class="tp-card">
        <div class="tp-h">其它开关</div>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead><tr><th>配置项</th><th>值</th></tr></thead>
            <tbody>
              <tr v-for="o in sys?.others || []" :key="o.key">
                <td class="tp-mono">{{ o.key }}</td>
                <td class="tp-dim ell" :title="o.value">{{ o.value }}</td>
              </tr>
              <tr v-if="!(sys?.others || []).length"><td colspan="2" class="tp-empty">—</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tp-err" v-if="p.error">{{ p.error }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 平台管理（对齐 OCP 官方「平台管理 / 认证」）：用户、角色、平台参数、登录审计、系统信息。
 * 全部只读——OCP 侧的写操作（建用户/改角色/改参数）涉及权限模型，SQLPilot 先做看板。
 */
import { computed, ref } from 'vue'
import { cloud, load, loadPlatformProperties, platformProperties, setPlatformTab } from '../../cloud/state'
import { fmtTime } from '../../cloud/parts'

const p = cloud.platform
const kw = ref('')
const TABS: { key: 'users' | 'roles' | 'properties' | 'logins' | 'system'; label: string }[] = [
  { key: 'users', label: '用户' },
  { key: 'roles', label: '角色' },
  { key: 'properties', label: '平台参数' },
  { key: 'logins', label: '登录审计' },
  { key: 'system', label: '系统信息' }
]

const sys = computed(() => p.bundle?.system || null)

const users = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const list = p.bundle?.users || []
  if (!k) return list
  return list.filter((u) => `${u.username} ${u.email} ${u.organization} ${u.department} ${u.roles.join(' ')}`.toLowerCase().includes(k))
})
const roles = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const list = p.bundle?.roles || []
  if (!k) return list
  return list.filter((r) => `${r.name} ${r.description} ${r.organization}`.toLowerCase().includes(k))
})
const logins = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const list = p.bundle?.logins || []
  if (!k) return list
  return list.filter((l) => `${l.username} ${l.clientAddress} ${l.userAgent}`.toLowerCase().includes(k))
})
const props = computed(() => platformProperties())
const propPages = computed(() => Math.max(1, Math.ceil((p.bundle?.propertyTotal || 0) / p.propSize)))

function countOf(k: string): string {
  if (k === 'users') return String(p.bundle?.users.length || 0)
  if (k === 'roles') return String(p.bundle?.roles.length || 0)
  if (k === 'properties') return String(p.bundle?.propertyTotal || 0)
  if (k === 'logins') return String(p.bundle?.loginTotal || 0)
  return ''
}
function refresh(): void {
  void load()
}
</script>

<style scoped>
.pp { display: flex; flex-direction: column; gap: 10px; }
.tabs { gap: 2px; padding: 0 0 8px; border-bottom: 1px solid var(--border); }
.tab {
  height: 26px; padding: 0 10px; border: none; border-radius: 7px; background: none; color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
}
.tab:hover { background: var(--bg-card-hover); color: var(--text); }
.tab.on { background: var(--accent-dim); color: var(--accent); }
.tab em {
  font-style: normal; font-family: var(--mono); font-size: 9px; padding: 0 4px; border-radius: 99px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
}
.tab.on em { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.tp-card.flat { padding: 0; gap: 0; }
.scroll { max-height: 62vh; overflow-y: auto; }
.pager { padding: 8px 2px 0; border-top: 1px solid var(--border); margin-top: 6px; }
.cell-main { font-size: 11.5px; }
.cell-sub { font-size: 9.5px; color: var(--text-faint); margin-top: 1px; }
.ell { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.val { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sys { display: flex; flex-direction: column; gap: 10px; }
.bad-t { color: var(--red); }
</style>
