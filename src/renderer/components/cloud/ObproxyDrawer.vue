<template>
  <div class="omask" @click.self="closeObproxy">
    <aside class="odrawer">
      <header class="oh">
        <div class="oh-id">
          <div class="oh-title">
            <span class="dot" :class="d?.status === 'RUNNING' ? 'ok' : 'warn'"></span>
            <b>{{ d?.name || '—' }}</b>
            <span class="tp-chip" :class="d?.status === 'RUNNING' ? 'ok' : 'warn'">{{ d?.status || '加载中' }}</span>
            <span class="tp-chip idle">{{ d?.workMode || 'RS_LIST' }}</span>
          </div>
          <div class="oh-sub tp-mono">{{ d?.address || '—' }}:{{ d?.port || '—' }} · {{ d?.instances.length || 0 }} 个代理实例</div>
        </div>
        <button class="x" title="关闭" @click="closeObproxy">✕</button>
      </header>

      <div v-if="cloud.obproxy.detailLoading" class="oh-wait"><span class="spin"></span>读取 OBProxy 集群详情…</div>

      <div v-else class="obody">
        <section>
          <h4>基本信息</h4>
          <div class="kv-grid">
            <div class="kv"><span>集群 ID</span><b class="tp-mono">{{ d?.id || '—' }}</b></div>
            <div class="kv"><span>版本</span><b class="tp-mono">{{ d?.version || '—' }}</b></div>
            <div class="kv"><span>最高版本</span><b class="tp-mono">{{ d?.maxVersion || '—' }}</b></div>
            <div class="kv"><span>参数版本</span><b class="tp-mono">{{ d?.parameterVersion ?? '—' }}</b></div>
            <div class="kv"><span>操作系统</span><b class="tp-mono">{{ d?.os || '—' }}</b></div>
            <div class="kv"><span>VPC</span><b>{{ d?.vpcName || '—' }}</b></div>
            <div class="kv"><span>创建人</span><b>{{ d?.creatorName || '—' }}</b></div>
            <div class="kv"><span>创建时间</span><b>{{ d?.createTime ? fmtTime(d.createTime) : '—' }}</b></div>
            <div class="kv wide"><span>配置地址</span><b class="tp-mono ell" :title="d?.configUrl">{{ d?.configUrl || '—' }}</b></div>
          </div>
        </section>

        <section>
          <h4>代理实例 <span class="cnt">{{ d?.instances.length || 0 }}</span></h4>
          <div class="tp-tbl-wrap">
            <table class="tp-tbl">
              <thead>
                <tr><th>IP</th><th>状态</th><th>运维状态</th><th class="r">SQL</th><th class="r">RPC</th><th class="r">Exporter</th><th>版本</th><th>IDC</th><th>最后活跃</th></tr>
              </thead>
              <tbody>
                <tr v-for="i in d?.instances || []" :key="i.id">
                  <td class="tp-mono">{{ i.ip }}<span v-if="i.offline" class="tp-chip bad">离线</span></td>
                  <td><span class="tp-chip" :class="i.status === 'RUNNING' ? 'ok' : 'warn'">{{ i.status || '—' }}</span></td>
                  <td class="tp-dim">{{ i.operateStatus || '—' }}</td>
                  <td class="r tp-mono">{{ i.sqlPort || '—' }}</td>
                  <td class="r tp-mono">{{ i.rpcPort || '—' }}</td>
                  <td class="r tp-mono">{{ i.exporterPort || '—' }}</td>
                  <td class="tp-mono tp-dim">{{ i.version || '—' }}</td>
                  <td class="tp-dim">{{ i.idcName || '—' }}</td>
                  <td class="tp-mono tp-dim">{{ i.lastActiveTime ? fmtTime(i.lastActiveTime) : '—' }}</td>
                </tr>
                <tr v-if="!(d?.instances || []).length"><td colspan="9" class="tp-empty">该集群下没有代理实例</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h4>连接的 OB 集群 <span class="cnt">{{ d?.links.length || 0 }}</span></h4>
          <div class="tp-tbl-wrap">
            <table class="tp-tbl">
              <thead><tr><th>集群</th><th>类型</th><th>状态</th><th class="r">连接数</th><th>代理用户</th><th>OB 版本</th></tr></thead>
              <tbody>
                <tr v-for="l in d?.links || []" :key="l.clusterId">
                  <td class="tp-mono">{{ l.clusterName }}</td>
                  <td class="tp-dim">{{ l.clusterType || '—' }}</td>
                  <td><span class="tp-chip" :class="l.status === 'RUNNING' ? 'ok' : 'warn'">{{ l.status || '—' }}</span></td>
                  <td class="r tp-mono">{{ l.connections }}</td>
                  <td class="tp-mono tp-dim">{{ l.username || '—' }}</td>
                  <td class="tp-mono tp-dim">{{ l.version || '—' }}</td>
                </tr>
                <tr v-if="!(d?.links || []).length"><td colspan="6" class="tp-empty">还没有通过该 OBProxy 反代任何集群</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div class="sec-bar">
            <h4>参数 <span class="cnt">{{ params.length }}</span></h4>
            <span class="sp"></span>
            <input v-model="kw" class="tp-input tp-search" placeholder="搜索参数名 / 说明" spellcheck="false" />
          </div>
          <div class="tp-tbl-wrap scroll">
            <table class="tp-tbl">
              <thead><tr><th>参数</th><th>当前值</th><th>生效级别</th><th>需重启</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="p in params" :key="`${p.name}-${p.configLevel}-${p.tenantName}`">
                  <td class="tp-mono">{{ p.name }}<span v-if="p.readonly" class="tp-chip idle">只读</span></td>
                  <td class="tp-mono val" :title="p.value">{{ p.value || '—' }}</td>
                  <td class="tp-dim">{{ p.configLevel || '—' }}<span v-if="p.tenantName" class="tp-faint"> · {{ p.tenantName }}</span></td>
                  <td><span v-if="p.needReboot" class="tp-chip warn">是</span><span v-else class="tp-dim">否</span></td>
                  <td class="tp-dim ell" :title="p.description">{{ p.description || '—' }}</td>
                </tr>
                <tr v-if="!params.length"><td colspan="5" class="tp-empty">读取不到参数（该 OBProxy 集群可能还没上报参数版本）</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * OBProxy 集群详情抽屉：基本信息 / 代理实例 / 连接的 OB 集群 / 参数（按级别 + 只读标记）。
 * 数据来自 obproxy/clusters/{id} 与 .../parameters（都实测过）。
 */
import { computed, ref } from 'vue'
import { cloud, closeObproxy } from '../../cloud/state'
import { fmtTime } from '../../cloud/parts'

const d = computed(() => cloud.obproxy.detail)
const kw = ref('')

const params = computed(() => {
  const k = kw.value.trim().toLowerCase()
  const list = cloud.obproxy.params
  if (!k) return list
  return list.filter((p) => `${p.name} ${p.description} ${p.configLevel} ${p.tenantName}`.toLowerCase().includes(k))
})
</script>

<style scoped>
.omask {
  position: fixed; inset: 0; z-index: 820; background: rgba(0, 0, 0, 0.42);
  display: flex; justify-content: flex-end; backdrop-filter: blur(1px);
}
.odrawer {
  width: 900px; max-width: 96vw; height: 100%; display: flex; flex-direction: column;
  background: var(--bg-side); border-left: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
}
.oh {
  display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border);
  background: var(--bg-side);
}
.oh-id { min-width: 0; }
.oh-title { display: flex; align-items: center; gap: 7px; }
.oh-title b { font-size: 14px; }
.oh-title .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.oh-title .dot.ok { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.oh-title .dot.warn { background: var(--yellow); }
.oh-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 3px; }
.x {
  margin-left: auto; width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-family: inherit;
}
.x:hover { color: var(--red); border-color: var(--red); }
.oh-wait { display: flex; align-items: center; gap: 8px; padding: 24px; color: var(--text-dim); font-size: 12px; }
.spin {
  width: 12px; height: 12px; border: 2px solid var(--accent-dim); border-top-color: var(--accent);
  border-radius: 50%; animation: rot 0.8s linear infinite;
}
@keyframes rot { to { transform: rotate(360deg); } }
.obody { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; gap: 14px; }
.obody > section { display: flex; flex-direction: column; gap: 7px; flex: none; }
h4 { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.cnt {
  font-family: var(--mono); font-size: 9.5px; color: var(--text-dim); background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 99px; padding: 0 5px; font-weight: 400;
}
.sec-bar { display: flex; align-items: center; gap: 8px; }
.sec-bar .sp { flex: 1; }
.kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 6px; }
.kv {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 8px;
  background: var(--bg-input); border: 1px solid var(--border);
}
.kv span { font-size: 9.5px; color: var(--text-faint); }
.kv b { font-size: 11px; font-weight: 500; }
.kv.wide { grid-column: span 2; }
.ell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scroll { max-height: 42vh; overflow-y: auto; }
.val { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
