<template>
  <div class="tp-pane op">
    <div class="tp-cards">
      <div class="tp-card">
        <div class="k-label">OBProxy 集群</div>
        <div class="k-val">{{ list.length }}</div>
        <div class="k-sub">{{ running }} 个运行中</div>
      </div>
      <div class="tp-card">
        <div class="k-label">代理实例</div>
        <div class="k-val">{{ instanceCount }}</div>
        <div class="k-sub">SQL 端口 2883 / RPC 2885（默认）</div>
      </div>
      <div class="tp-card">
        <div class="k-label">连接的 OB 集群</div>
        <div class="k-val">{{ linkCount }}</div>
        <div class="k-sub">通过 oblink 反向代理的集群数</div>
      </div>
      <div class="tp-card">
        <div class="k-label">版本分布</div>
        <div class="k-val small">{{ versionText }}</div>
        <div class="k-sub">滚动升级时按实例统计</div>
      </div>
    </div>

    <div class="tp-card" data-ai="obproxy.clusters">
      <div class="tp-bar">
        <div class="tp-h">OBProxy 集群 <span class="cnt">{{ list.length }}</span></div>
        <span class="sp"></span>
        <input v-model="q" class="tp-input tp-search" placeholder="搜索集群 / 地址 / 连接的集群" spellcheck="false" />
        <button class="tp-btn sm ghost" :disabled="cloud.loading" @click="refresh">刷新</button>
      </div>
      <div class="tp-tbl-wrap">
        <table class="tp-tbl">
          <thead>
            <tr>
              <th>集群</th><th>状态</th><th>访问地址</th><th>版本</th><th>工作模式</th>
              <th class="r">实例</th><th>IDC 分布</th><th>连接的 OB 集群</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in rows" :key="c.id" class="clickable" @click="openObproxy(c.id)">
              <td>
                <div class="cell-main">{{ c.name }}</div>
                <div class="cell-sub tp-mono">#{{ c.id }} · {{ c.vpcName || '默认 VPC' }}</div>
              </td>
              <td><span class="tp-chip" :class="c.status === 'RUNNING' ? 'ok' : c.status ? 'warn' : 'idle'">{{ statusLabel(c.status) }}</span></td>
              <td class="tp-mono">{{ c.address || '—' }}<span class="tp-dim">:{{ c.port || '—' }}</span></td>
              <td class="tp-mono tp-dim">{{ c.version || '—' }}</td>
              <td class="tp-dim">{{ c.workMode || '—' }}</td>
              <td class="r tp-mono">{{ onlineOf(c) }}/{{ c.instances.length }}</td>
              <td>
                <span v-for="t in c.topo" :key="t.idcName" class="tp-chip idle">{{ t.idcName }} · {{ t.count }}</span>
                <span v-if="!c.topo.length" class="tp-dim">—</span>
              </td>
              <td>
                <span v-for="l in c.links" :key="l.clusterId" class="tp-chip" :class="l.status === 'RUNNING' ? 'ok' : 'warn'" :title="`${l.username || ''} · 连接 ${l.connections}`">
                  {{ l.clusterName }}
                </span>
                <span v-if="!c.links.length" class="tp-dim">未连接</span>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="8" class="tp-empty">没有 OBProxy 集群（OCP 未纳管 OBProxy 时为空）</td></tr>
          </tbody>
        </table>
      </div>
      <div class="tp-note">点任意一行查看代理实例、连接关系与参数。OBProxy 参数按 LEVEL_GLOBAL / LEVEL_TENANT 分层生效。</div>
    </div>

    <div class="tp-err" v-if="cloud.obproxy.error">{{ cloud.obproxy.error }}</div>
    <ObproxyDrawer v-if="cloud.obproxy.drawerId" />
  </div>
</template>

<script setup lang="ts">
/**
 * OBProxy（对齐 OCP 官方「OBProxy」导航）：
 * 集群列表 → 点开抽屉看实例 / 连接集群 / 参数。
 */
import { computed, ref } from 'vue'
import ObproxyDrawer from './ObproxyDrawer.vue'
import { cloud, load, openObproxy } from '../../cloud/state'

const q = ref('')
const list = computed(() => cloud.obproxy.clusters)
const running = computed(() => list.value.filter((c) => c.status === 'RUNNING').length)
const instanceCount = computed(() => list.value.reduce((s, c) => s + c.instances.length, 0))
const linkCount = computed(() => list.value.reduce((s, c) => s + c.links.length, 0))
const versionText = computed(() => {
  const m = new Map<string, number>()
  for (const c of list.value) for (const v of c.versions) m.set(v.version, (m.get(v.version) || 0) + v.count)
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1])
  if (!arr.length) return '—'
  const [v, n] = arr[0]
  return `${v}${arr.length > 1 ? ` +${arr.length - 1}` : ''}（${n} 实例）`
})

const rows = computed(() => {
  const k = q.value.trim().toLowerCase()
  if (!k) return list.value
  return list.value.filter((c) =>
    `${c.name} ${c.address} ${c.links.map((l) => l.clusterName).join(' ')} ${c.topo.map((t) => t.idcName).join(' ')}`
      .toLowerCase()
      .includes(k)
  )
})

function onlineOf(c: CloudObproxyCluster): number {
  return c.instances.filter((i) => i.status === 'RUNNING' && !i.offline).length
}
function statusLabel(s: string): string {
  if (!s) return '未知'
  if (s === 'RUNNING') return '运行中'
  if (s === 'CREATING') return '创建中'
  if (s === 'UPGRADING') return '升级中'
  if (s === 'STOPPED') return '已停止'
  return s
}
function refresh(): void {
  void load()
}
</script>

<style scoped>
.op { display: flex; flex-direction: column; gap: 10px; }
.op .tp-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.k-label { font-size: 10.5px; color: var(--text-faint); }
.k-val { font-family: var(--mono); font-size: 19px; font-weight: 650; line-height: 1.25; }
.k-val.small { font-size: 12.5px; font-weight: 600; }
.k-sub { font-size: 9.5px; color: var(--text-faint); }
.cell-main { font-size: 11.5px; }
.cell-sub { font-size: 9.5px; color: var(--text-faint); margin-top: 1px; }
</style>
