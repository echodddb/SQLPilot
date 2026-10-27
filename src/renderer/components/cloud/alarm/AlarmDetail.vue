<template>
  <div class="ad-mask" @click.self="closeAlarm">
    <aside class="ad-drawer" @click.stop>
      <header class="ad-head">
        <div class="ad-id">
          <div class="ad-title">
            <span class="lv" :class="levelInfo.tone">{{ levelInfo.label }}</span>
            <b>{{ a.name }}</b>
            <span v-if="a.status === 'Active'" class="ad-live"><i class="dot"></i>告警中</span>
            <span v-else class="ad-done">已恢复</span>
            <span v-if="cloud.alarmDetailLoading" class="ad-loading">读取详情…</span>
          </div>
          <div class="ad-sub mono">
            告警 ID {{ a.id }}
            <i class="sep">·</i>{{ a.appType || '—' }}
            <i class="sep">·</i>{{ a.alarmType || '—' }}
          </div>
        </div>
        <button class="x" title="关闭（Esc）" @click="closeAlarm">✕</button>
      </header>

      <div class="ad-body">
        <!-- 状态条 -->
        <div class="ad-state" :class="a.status === 'Active' ? 'on' : 'off'">
          <div class="st-main">
            <i class="dot"></i>
            <b>{{ a.status === 'Active' ? `已持续 ${duration(a.activeAt)}` : '已恢复' }}</b>
            <span v-if="a.status !== 'Active' && a.resolvedAt" class="tp-dim">恢复于 {{ fmtTime(a.resolvedAt) }}</span>
          </div>
          <div class="st-side">
            <span class="tp-chip" :class="a.autoResolved ? 'ok' : 'idle'">{{ a.autoResolved ? '指标恢复后自动关闭' : '需人工处理' }}</span>
            <span class="tp-chip" :class="a.push.configured ? 'ok' : 'idle'">
              {{ a.push.configured ? `已推送 ${a.push.successCount} 次` : '未配置推送' }}
            </span>
          </div>
        </div>

        <div class="tp-kv-grid">
          <div class="tp-kv"><span>产生时间</span><b>{{ fmtTime(a.activeAt) }}</b></div>
          <div class="tp-kv"><span>最近状态变更</span><b>{{ fmtTime(a.updatedAt) }}</b></div>
          <div class="tp-kv"><span>对象类型</span><b>{{ alarmScope(a.scope) }}</b></div>
          <div class="tp-kv"><span>告警分类</span><b>{{ a.groups.join(' / ') || '—' }}</b></div>
          <div class="tp-kv"><span>关联集群</span><b>{{ clusterName || '—' }}</b></div>
          <div class="tp-kv"><span>规则模板</span><b>{{ a.templateId ? `#${a.templateId}` : '内置规则' }}</b></div>
        </div>

        <!-- 告警对象 -->
        <h4 class="tp-h">
          告警对象 <span class="cnt">{{ a.targetInfo.names.length }}</span>
          <button v-if="jump" class="tp-btn sm" style="margin-left:auto" @click="goJump">{{ jumpLabel }}</button>
        </h4>
        <div class="ad-target" data-src="alarmTarget" :data-detail="`${alarmScope(a.scope)}：${a.targetInfo.names.join('、') || '—'}|target：${a.target}`">
          <span v-if="!a.targetInfo.names.length" class="tp-note">OCP 未提供告警对象</span>
          <span v-for="n in a.targetInfo.names" :key="n" class="tp-chip mono">{{ n }}</span>
          <span v-if="a.targetInfo.clusterName" class="tp-chip">集群 {{ a.targetInfo.clusterName }}</span>
          <span v-if="a.targetInfo.tenantName" class="tp-chip">租户 {{ a.targetInfo.tenantName }}</span>
        </div>
        <div class="tp-code ad-target-raw">{{ a.target || '—' }}</div>

        <h4 class="tp-h">告警描述</h4>
        <div class="ad-desc">{{ a.description || a.summary || '（OCP 未提供描述）' }}</div>

        <!-- 指标组 -->
        <template v-if="metrics.length">
          <h4 class="tp-h">
            关联指标
            <span class="cnt">{{ metrics.length }}</span>
            <span class="tp-note" style="margin-left:auto">{{ a.metricGroup?.description || a.metricGroup?.name }}</span>
          </h4>
          <div class="tp-tbl-wrap">
            <table class="tp-tbl">
              <thead><tr><th>指标</th><th>单位</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="m in metrics" :key="m.key">
                  <td class="tp-mono">{{ m.name || m.key }}</td>
                  <td class="tp-dim">{{ m.unit || '—' }}</td>
                  <td class="tp-dim">{{ m.description || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- 阈值与实测值 -->
        <template v-if="keyValues.length">
          <h4 class="tp-h">阈值与实测值</h4>
          <div class="ad-kv-inline">
            <div v-for="r in keyValues" :key="r.k" class="ad-kv">
              <span>{{ r.label }}</span><b class="mono">{{ r.v }}</b>
            </div>
          </div>
        </template>

        <!-- 同类型 -->
        <div class="ad-same" data-src="alarmHead">
          <span class="tp-note">同规则（{{ a.alarmType || '—' }}）近 {{ cloud.alarmSameType.hours / 24 }} 天共产生</span>
          <b class="mono">{{ cloud.alarmSameType.loading ? '…' : cloud.alarmSameType.total }}</b>
          <span class="tp-note">次告警（含已恢复）</span>
          <button class="link" :disabled="!a.alarmType" @click="drillSame">查看该类型告警</button>
        </div>

        <!-- 标签 -->
        <h4 class="tp-h">
          标签详情 <span class="cnt">{{ labels.length }}</span>
          <span class="tp-note" style="margin-left:auto">已隐藏 en_us / zh_tw 重复项</span>
        </h4>
        <div class="tp-tbl-wrap ad-labels">
          <table class="tp-tbl">
            <thead><tr><th>标签</th><th>值</th></tr></thead>
            <tbody>
              <tr v-for="r in labels" :key="r.k">
                <td class="tp-mono">{{ r.k }}</td>
                <td class="tp-mono tp-dim">{{ r.v }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="tp-note">
          告警由 OCP 告警规则产生，SqlPilot 只做展示与对象跳转；屏蔽 / 订阅 / 通知通道等写操作尚未接入。
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * 告警详情抽屉（对标 OCP「告警事件详情」）：
 * 状态与推送、对象、描述、关联指标、阈值实测值、同类型统计、标签全量。
 * 打开时由 state.openAlarm 先给列表数据、再拉详情接口补齐 metricGroup / targetLabels。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { cloud, closeAlarm, openCluster, openHost, openTenant, setAlarmType, setAlarmSubTab } from '../../../cloud/state'
import { alarmLevel, alarmScope, duration, fmtTime } from '../../../cloud/parts'

const a = computed(() => cloud.alarmDetail as CloudAlarm)
const levelInfo = computed(() => alarmLevel(a.value.level))
const clusterName = computed(() => a.value.obCluster || a.value.targetInfo.clusterName)

const metrics = computed(() => a.value.metricGroup?.metrics || [])

/** 只留中文主键：去掉 _en_us / _zh_tw / _zh_cn 的重复行 */
const labels = computed(() => Object.entries(a.value.labels || {})
  .filter(([k]) => !/_(en_us|zh_tw|zh_cn)$/.test(k))
  .map(([k, v]) => ({ k, v }))
  .sort((x, y) => x.k.localeCompare(y.k)))

/** 阈值与实测值：从标签里挑出最有用的几项 */
const keyValues = computed(() => {
  const l = a.value.labels || {}
  const rows: { k: string; label: string; v: string }[] = []
  const push = (k: string, label: string) => { if (l[k]) rows.push({ k, label, v: l[k] }) }
  push('alarm_threshold', '阈值')
  push('value_zh_cn', '实测值')
  push('alarm_duration', '持续（秒）')
  push('ob_cluster', '集群')
  push('tenant_name', '租户')
  push('svr_ip', '主机')
  if (!rows.length) {
    for (const [k, v] of Object.entries(l)) {
      if (/_value$/.test(k) && !/_(en_us|zh_tw|zh_cn)$/.test(k)) rows.push({ k, label: k, v })
    }
  }
  return rows.slice(0, 8)
})

/** 对象跳转：主机 / 租户 / 集群 三种（对象名要与已加载列表对得上） */
type Jump = { kind: 'host' | 'tenant' | 'cluster'; key: string; clusterId?: number; tenantId?: number }
const jump = computed<Jump | null>(() => {
  const t = a.value.targetInfo
  const name = t.names[0] || ''
  if (!name) return null
  if (a.value.scope === 'Host') {
    const h = cloud.hosts.find((x) => x.ip === name || x.name === name)
    return h ? { kind: 'host', key: h.ip || h.name } : null
  }
  if (a.value.scope === 'Tenant') {
    const club = cloud.clusters.find((c) => c.name === t.clusterName)
    const ten = cloud.tenants.find((x) => x.name === name && (!club || x.clusterId === club.id))
    return ten ? { kind: 'tenant', key: name, clusterId: ten.clusterId, tenantId: ten.id } : null
  }
  if (a.value.scope === 'Cluster') {
    const c = cloud.clusters.find((x) => x.name === name)
    return c ? { kind: 'cluster', key: name, clusterId: c.id } : null
  }
  return null
})
const jumpLabel = computed(() => {
  const k = jump.value?.kind
  return k === 'host' ? '打开主机详情' : k === 'tenant' ? '打开租户工作台' : k === 'cluster' ? '打开集群详情' : ''
})

function goJump(): void {
  const j = jump.value
  if (!j) return
  if (j.kind === 'host') {
    const h = cloud.hosts.find((x) => x.ip === j.key || x.name === j.key)
    if (h) openHost(h)
  } else if (j.kind === 'cluster' && j.clusterId) {
    void openCluster(j.clusterId)
  } else if (j.kind === 'tenant' && j.clusterId && j.tenantId) {
    void openTenant(j.clusterId, j.tenantId)
  }
  closeAlarm()
}

function drillSame(): void {
  if (!a.value.alarmType) return
  closeAlarm()
  void setAlarmSubTab('event')
  void setAlarmType(a.value.alarmType)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeAlarm()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.ad-mask { position: fixed; inset: 0; z-index: 300; background: rgba(6, 8, 14, 0.42); display: flex; justify-content: flex-end; padding-top: var(--titlebar-h); }
.ad-drawer {
  width: 640px; max-width: 96vw; height: 100%; background: var(--bg-card); border-left: 1px solid var(--border-strong);
  display: flex; flex-direction: column; animation: slide 0.16s ease;
}
@keyframes slide { from { transform: translateX(18px); opacity: 0.6; } to { transform: none; opacity: 1; } }
.ad-head { display: flex; align-items: flex-start; gap: 10px; padding: 13px 16px 11px; border-bottom: 1px solid var(--border); }
.ad-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ad-title b { font-size: 14px; }
.ad-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 5px; }
.ad-sub .sep { margin: 0 5px; opacity: 0.6; }
.ad-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--yellow); }
.ad-live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.ad-done { font-size: 11px; color: var(--text-faint); }
.ad-loading { font-size: 10.5px; color: var(--text-faint); }
.ad-head .x {
  margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px;
}
.ad-head .x:hover { color: var(--red); border-color: var(--red); }
.ad-body { flex: 1; overflow-y: auto; padding: 12px 16px 22px; display: flex; flex-direction: column; gap: 9px; }
/* 表格块在纵向 flex 里会被压扁，这里禁止收缩（否则只剩表头一条线） */
.ad-body > * { flex: none; }

.ad-state {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  border: 1px solid var(--border); border-radius: 9px; padding: 8px 11px; background: var(--bg-input);
}
.ad-state .st-main { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.ad-state .st-main .dot { width: 7px; height: 7px; border-radius: 50%; }
.ad-state.on { border-color: color-mix(in srgb, var(--yellow) 40%, transparent); }
.ad-state.on .st-main .dot { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.ad-state.off .st-main .dot { background: var(--text-faint); }
.ad-state .st-side { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }

.ad-target { display: flex; flex-wrap: wrap; gap: 6px; }
.ad-target-raw { font-size: 10.5px; color: var(--text-faint); word-break: break-all; }
.ad-desc {
  font-size: 12px; line-height: 1.75; color: var(--text-dim); background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; white-space: pre-wrap; word-break: break-word;
}
.ad-kv-inline { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 6px; }
.ad-kv {
  display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px;
}
.ad-kv span { color: var(--text-faint); font-size: 10.5px; }
.ad-kv b { margin-left: auto; color: var(--text); font-weight: 550; }
.ad-same {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11.5px;
  border: 1px dashed var(--border); border-radius: 8px; padding: 7px 10px;
}
.ad-same b { color: var(--accent); font-size: 13px; }
.ad-same .link { margin-left: auto; background: none; border: none; color: var(--accent); font-size: 11.5px; cursor: pointer; font-family: inherit; }
.ad-same .link:disabled { color: var(--text-faint); cursor: default; }
.ad-labels { max-height: 32vh; }
.ad-labels .tp-tbl td:first-child { white-space: nowrap; }
.ad-labels .tp-tbl td:last-child { white-space: normal; word-break: break-word; line-height: 1.5; }
.mono { font-family: var(--mono); }

.lv { font-size: 10.5px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); }
.lv.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.lv.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); background: var(--yellow-dim); }
.lv.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.lv.idle { color: var(--text-dim); }
</style>
