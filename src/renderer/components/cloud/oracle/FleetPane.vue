<template>
  <div class="oc-wrap">
    <InfoKpis :kpis="kpis" data-src="orFleetKpi" />

    <div class="oc-cards">
      <div class="oc-card" data-src="orFleetIssues">
        <div class="oc-card-h">
          <span>待处理问题</span><span class="cnt">{{ issues.length }}</span><span class="sp"></span>
          <span class="oc-note">按环境汇总，点一条直接跳到该库对应的 tab</span>
        </div>
        <div v-if="!issues.length" class="oc-note">
          {{ ora.envs.length ? '所有已接入环境都没有发现需要处理的问题。' : '还没有接入环境。' }}
        </div>
        <div v-else class="oc-issues">
          <button v-for="(i, k) in issues" :key="k" class="oc-issue row" :class="i.level" @click="openDrawer(i.envId, i.tab)">
            <span>{{ i.level === 'bad' ? '●' : i.level === 'warn' ? '▲' : 'ℹ' }}</span>
            <div>
              <b>{{ i.env }} · {{ i.title }}</b>
              <p>{{ i.detail }}</p>
            </div>
            <em class="go">进入 →</em>
          </button>
        </div>
      </div>

      <div class="oc-card" data-src="orFleetCap">
        <div class="oc-card-h"><span>表空间水位榜</span><span class="sp"></span><span class="oc-note">各环境最高的一个表空间</span></div>
        <div v-if="!tsRank.length" class="oc-note">没有数据</div>
        <div v-else class="oc-bars">
          <div v-for="t in tsRank" :key="t.envId" class="oc-bar-row">
            <span :title="`${t.env} · ${t.ts}`">{{ t.env }}</span>
            <i><b :class="t.pct >= 90 ? 'bad' : t.pct >= 85 ? 'warn' : ''" :style="{ width: Math.min(100, t.pct) + '%' }"></b></i>
            <em>{{ t.pct.toFixed(1) }}%</em>
          </div>
        </div>
        <div class="oc-note">条形长度=水位百分比，红色 ≥90%、黄色 ≥85%；表空间名见悬停提示</div>
      </div>

      <div class="oc-card" data-src="orFleetLoad">
        <div class="oc-card-h"><span>会话与阻塞</span><span class="sp"></span><span class="oc-note">用户会话 / 活跃 / 阻塞</span></div>
        <div v-if="!loadRank.length" class="oc-note">没有数据</div>
        <div v-else class="oc-bars">
          <div v-for="e in loadRank" :key="e.envId" class="oc-bar-row">
            <span :title="e.env">{{ e.env }}</span>
            <i><b :class="e.blocking ? 'bad' : ''" :style="{ width: pct(e.sessions, maxSess) + '%' }"></b></i>
            <em>{{ e.sessions }}<template v-if="e.active"> / {{ e.active }}</template><template v-if="e.blocking"> ⚠{{ e.blocking }}</template></em>
          </div>
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orFleetTable">
      <div class="oc-card-h">
        <span>环境对比</span><span class="cnt">{{ ora.envs.length }}</span><span class="sp"></span>
        <span class="oc-note">点任一行进入该库的详情</span>
      </div>
      <OraTable
        :columns="cols"
        :rows="rows"
        row-key="id"
        empty="还没有接入 Oracle 环境"
        searchable
        search-placeholder="环境名 / 主机 / 版本…"
        default-sort="usedPct"
        @row="onRow"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/** 全局面板：跨环境汇总（可用性 / 问题 / 水位榜 / 会话榜 / 对比表），全部由环境概要推导，不额外查库 */
import { computed } from 'vue'
import InfoKpis from '../../db/InfoKpis.vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { ora, openDrawer, type OraPaneKey } from '../../../cloud/oracle'

const good = computed(() => ora.envs.filter((e) => e.summary && !e.error))

const kpis = computed(() => {
  const total = ora.envs.length
  const ok = good.value.length
  const tsWarn = good.value.filter((e) => (e.summary?.tsWorst?.usedPct || 0) >= 85).length
  const blocking = good.value.filter((e) => (e.summary?.blocking || 0) > 0).length
  const invalid = good.value.reduce((a, b) => a + (b.summary?.invalid || 0), 0)
  return [
    { label: '环境总数', value: `${total}`, sub: `${ok} 套可连`, tone: total && ok === total ? ('ok' as const) : total ? ('warn' as const) : undefined },
    { label: '会话总数', value: `${good.value.reduce((a, b) => a + (b.summary?.sessions || 0), 0)}`, sub: `活跃 ${good.value.reduce((a, b) => a + (b.summary?.activeSessions || 0), 0)}` },
    { label: '有阻塞的环境', value: `${blocking}`, sub: blocking ? '存在锁等待' : '无阻塞', tone: blocking ? ('bad' as const) : ('ok' as const) },
    { label: '水位告警环境', value: `${tsWarn}`, sub: '≥85% 的表空间', tone: tsWarn ? ('warn' as const) : ('ok' as const) },
    { label: '失效对象合计', value: `${invalid}`, sub: invalid ? '需重编译' : '全部有效', tone: invalid ? ('warn' as const) : ('ok' as const) }
  ]
})

interface Issue {
  envId: string
  env: string
  level: 'bad' | 'warn' | 'info'
  title: string
  detail: string
  tab: OraPaneKey
}

const issues = computed<Issue[]>(() => {
  const out: Issue[] = []
  for (const e of ora.envs) {
    if (e.error) {
      out.push({ envId: e.id, env: e.name, level: 'bad', title: '连接失败', detail: e.error.slice(0, 160), tab: 'overview' })
      continue
    }
    const s = e.summary
    if (!s) continue
    if (!s.openMode.includes('READ WRITE')) {
      out.push({ envId: e.id, env: e.name, level: 'bad', title: `库状态 ${s.openMode}`, detail: '只读/挂载状态下业务写入会失败，检查 Data Guard 或恢复状态', tab: 'overview' })
    }
    if (s.blocking > 0) {
      out.push({ envId: e.id, env: e.name, level: 'bad', title: `${s.blocking} 个会话被阻塞`, detail: '查看阻塞链与阻塞者 SQL_ID', tab: 'sessions' })
    }
    if (s.tsWorst && s.tsWorst.usedPct >= 85) {
      out.push({
        envId: e.id,
        env: e.name,
        level: s.tsWorst.usedPct >= 90 ? 'bad' : 'warn',
        title: `表空间 ${s.tsWorst.name} 水位 ${s.tsWorst.usedPct.toFixed(1)}%`,
        detail: s.tsWorst.usedPct >= 90 ? '需扩容或清理，否则写入会报 ORA-01653/01654' : '建议提前规划扩容',
        tab: 'storage'
      })
    }
    if (s.invalid > 0) {
      out.push({ envId: e.id, env: e.name, level: 'warn', title: `${s.invalid} 个对象失效`, detail: '到「用户与对象」按 owner 查看并重编译', tab: 'users' })
    }
    if (s.longops > 0) {
      out.push({ envId: e.id, env: e.name, level: 'info', title: `${s.longops} 个长操作在执行`, detail: '到「会话与锁 · 长操作」看剩余时间', tab: 'sessions' })
    }
  }
  const weight = { bad: 0, warn: 1, info: 2 }
  return out.sort((a, b) => weight[a.level] - weight[b.level])
})

const tsRank = computed(() =>
  [...good.value]
    .filter((e) => e.summary?.tsWorst)
    .map((e) => ({ envId: e.id, env: e.name, ts: e.summary!.tsWorst!.name, pct: e.summary!.tsWorst!.usedPct }))
    .sort((a, b) => b.pct - a.pct)
)

const loadRank = computed(() =>
  [...good.value]
    .map((e) => ({ envId: e.id, env: e.name, sessions: e.summary!.sessions, active: e.summary!.activeSessions, blocking: e.summary!.blocking }))
    .sort((a, b) => b.sessions - a.sessions)
)

const maxSess = computed(() => Math.max(1, ...loadRank.value.map((e) => e.sessions)))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

const cols: OraCol[] = [
  { key: 'name', label: '环境' },
  { key: 'addr', label: '地址', type: 'mono' },
  { key: 'role', label: '角色' },
  { key: 'topo', label: '拓扑' },
  { key: 'ver', label: '版本' },
  { key: 'instances', label: '实例', type: 'num' },
  { key: 'sessions', label: '会话', type: 'num' },
  { key: 'active', label: '活跃', type: 'num' },
  { key: 'blocking', label: '阻塞', type: 'num' },
  { key: 'usedPct', label: '最高水位', type: 'bar', width: '150px' },
  { key: 'invalid', label: '失效对象', type: 'num' },
  { key: 'state', label: '状态', type: 'state' }
]

const rows = computed(() =>
  ora.envs.map((e) => {
    const s = e.summary
    return {
      id: e.id,
      name: e.name,
      addr: `${e.host}:${e.port}${e.serviceName ? '/' + e.serviceName : ''}`,
      role: s?.databaseRole || '—',
      topo: s ? (s.isRac ? 'RAC' : '单实例') : '—',
      ver: shortVer(s?.version),
      instances: s ? `${s.instancesOpen}/${s.instances}` : '—',
      sessions: s?.sessions ?? 0,
      active: s?.activeSessions ?? 0,
      blocking: s?.blocking ?? 0,
      usedPct: s?.tsWorst ? s.tsWorst.usedPct : null,
      invalid: s?.invalid ?? 0,
      state: e.error ? '连接失败' : s?.openMode || '—'
    }
  })
)

/** "Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - ..." → "11g EE 11.2.0.4.0" */
function shortVer(v?: string): string {
  const m = /Oracle Database (\S+).*?(Enterprise|Standard) Edition.*?(\d+\.\d+\.\d+\.\d+\.\d+)/i.exec(v || '')
  if (m) return `${m[1]} ${m[2] === 'Enterprise' ? 'EE' : 'SE'} ${m[3]}`
  return (v || '').replace('Oracle Database ', '').slice(0, 26) || '—'
}

function onRow(row: any): void {
  void openDrawer(String(row.id))
}
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
.oc-issue.row {
  width: 100%; text-align: left; font-family: inherit; color: var(--text); cursor: pointer;
}
.oc-issue.row:hover { background: var(--bg-card-hover); border-color: var(--border-strong); }
.oc-issue .go { margin-left: auto; font-style: normal; font-size: 10.5px; color: var(--accent); flex-shrink: 0; align-self: center; }
</style>
