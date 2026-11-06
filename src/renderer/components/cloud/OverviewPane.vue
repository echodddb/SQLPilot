<template>
  <div class="ov">
    <!-- 直连：没探到的集群单独列出来，别让它们拖住其它集群；确认后不再自动探测 -->
    <div v-if="offline.length" class="ov-off">
      <span class="ov-off-ico">!</span>
      <div class="ov-off-body">
        <b>
          {{ offline.length }} 套集群没有取到数据
          <span class="muted">（其余集群正常展示，这些集群也不再参与其它模块的采集）</span>
        </b>
        <div v-for="o in offline" :key="o.platform.id" class="ov-off-row">
          <span class="dot bad"></span>
          <span class="name">{{ o.platform.name }}</span>
          <span class="addr mono">{{ o.platform.host }}:{{ o.platform.port }}</span>
          <span class="err" :title="o.raw">{{ o.error }}</span>
          <button class="link" :disabled="cloud.loading" @click="retryOne(o.platform.id)">重试</button>
        </div>
        <div class="ov-off-act">
          <span class="tip">确认后本轮不再自动探测，需要时可在「集群」页手动重试。</span>
          <button class="mini" @click="skipAll">知道了，暂不探测</button>
        </div>
      </div>
    </div>
    <!-- 已确认跳过的收敛成一行：不占地方，但信息不能丢 -->
    <div v-else-if="skipped.length" class="ov-skip">
      <span class="dot idle"></span>
      已跳过 {{ skipped.length }} 套集群的探测（{{ skipped.map((x) => x.platform.name).join('、') }}）
      <button class="link" @click="goClusters">去集群页处理 →</button>
    </div>

    <template v-if="ov">
      <div v-if="ov.warnings.length" class="ov-warn">
        <span class="ov-warn-ico">!</span>
        <div>
          <b>部分数据未能取回</b>
          <div v-for="w in ov.warnings" :key="w">{{ w }}</div>
        </div>
      </div>

    <!-- KPI 磁贴（悬浮看采集来源） -->
    <div class="ov-kpis">
      <div class="kpi" data-src="clusters" data-ai="overview.kpi:clusters" data-ai-name="OB 集群数">
        <div class="kpi-label">OB 集群</div>
        <div class="kpi-value">{{ ov.kpis.clusters }}</div>
        <div class="kpi-sub">运行中 {{ ov.kpis.clustersRunning }}</div>
      </div>
      <div class="kpi" data-src="tenants" data-ai="overview.kpi:tenants" data-ai-name="租户数">
        <div class="kpi-label">租户</div>
        <div class="kpi-value">{{ ov.kpis.tenants }}</div>
        <div class="kpi-sub">跨 {{ ov.kpis.clusters }} 个集群</div>
      </div>
      <div class="kpi" :class="ov.hosts.offline ? 'warn' : ''" data-src="hosts" data-ai="overview.kpi:hosts" data-ai-name="主机数">
        <div class="kpi-label">主机</div>
        <div class="kpi-value">{{ ov.kpis.hosts }}</div>
        <div class="kpi-sub">在线 {{ ov.hosts.online }}<template v-if="ov.hosts.offline"> · 离线 {{ ov.hosts.offline }}</template></div>
      </div>
      <div class="kpi" :class="ov.kpis.alarmsCritical ? 'bad' : ov.kpis.alarms ? 'warn' : ''" data-src="alarms" data-ai="overview.kpi:alarms" data-ai-name="活跃告警数">
        <div class="kpi-label">活跃告警</div>
        <div class="kpi-value">{{ ov.kpis.alarms }}</div>
        <div class="kpi-sub">严重 {{ ov.kpis.alarmsCritical }} · 主机 Agent 异常 {{ ov.hosts.agentAbnormal }}</div>
      </div>
      <div class="kpi" data-src="cpu" data-ai="overview.kpi:cpu" data-ai-name="CPU 分配">
        <div class="kpi-label">CPU 已分配</div>
        <div class="kpi-value">{{ ov.kpis.cpuUsed }}<span class="kpi-unit">/{{ ov.kpis.cpuTotal }} 核</span></div>
        <div class="kpi-sub">占可分配总量 {{ ov.kpis.cpuTotal ? Math.round((ov.kpis.cpuUsed / ov.kpis.cpuTotal) * 100) : 0 }}%</div>
      </div>
      <div class="kpi" data-src="info" data-ai="overview.kpi:ocp" data-ai-name="OB 版本">
        <div class="kpi-label">{{ isDirect ? 'OB 版本' : 'OCP 版本' }}</div>
        <div class="kpi-value sm">{{ ov.info.version || '—' }}</div>
        <div class="kpi-sub">{{ editionLabel }}</div>
      </div>
    </div>

    <!-- 集群容量 -->
    <div class="ov-section-head">
      <h3>集群容量</h3>
      <span class="hint">CPU 核数 / 内存与数据盘为分配水位，来自 OCP 集群统计</span>
    </div>
    <div class="ov-clusters">
      <button
        v-for="c in ov.clusters"
        :key="c.id"
        class="cl-card"
        data-src="clusterCap"
        :data-cluster="c.name"
        :data-ai="`overview.clusters:${c.name}`"
        :data-ai-name="c.name"
        @click="drill(c.id)"
      >
        <div class="cl-card-top">
          <div class="cl-name">
            <span class="dot" :class="clusterStatus(c.status).tone"></span>
            <b>{{ c.name }}</b>
            <span class="tag">{{ clusterStatus(c.status).label }}</span>
          </div>
          <span class="cl-ver">v{{ c.version }}</span>
        </div>
        <div class="cl-meta">
          <span>{{ clusterMode(c.clusterMode) }}</span>
          <span>{{ originLabel(c.origin) }}</span>
          <span>{{ c.serverCount }} 节点 · {{ c.tenantCount }} 租户</span>
        </div>
        <div class="cl-cap">
          <CapacityBar label="CPU" :used="c.cpu.used" :total="c.cpu.total" :percent="c.cpu.pct" unit="count" tone="info" />
          <CapacityBar label="内存" :used="c.memory.used" :total="c.memory.total" :percent="c.memory.pct" tone="info" />
          <CapacityBar label="数据盘" :used="c.disk.used" :total="c.disk.total" :percent="c.disk.pct" />
        </div>
        <div class="cl-foot">
          <span class="mono">{{ c.rootServer || '—' }}</span>
          <span v-if="c.alarms.total" class="alarm-chip" :class="worstTone(c)">{{ c.alarms.total }} 条告警</span>
          <span v-else class="alarm-chip ok">无告警</span>
        </div>
      </button>
      <div v-if="!ov.clusters.length" class="ov-empty">OCP 中还没有 OB 集群</div>
    </div>

    <!-- 告警 / 任务 -->
    <div class="ov-twocol">
      <div class="panel" data-ai="overview.alarms">
        <div class="panel-head" data-src="alarmList">
          <h3>活跃告警</h3>
          <button class="link" @click="goAlarms">全部 →</button>
        </div>
        <div v-if="!ov.alarms.length" class="panel-empty">
          {{ isDirect ? '当前没有活跃告警（直连模式按内置规则实时评估，条件恢复即消失）' : '当前没有活跃告警' }}
        </div>
        <ul class="alarm-list">
          <li v-for="a in ov.alarms" :key="a.id">
            <span class="lv" :class="alarmLevel(a.level).tone">{{ alarmLevel(a.level).label }}</span>
            <div class="alarm-body">
              <div class="alarm-name">{{ a.name }}</div>
              <div class="alarm-sub">{{ a.appType }} · {{ alarmScope(a.scope) }}</div>
            </div>
            <span class="alarm-time">{{ relTime(a.activeAt) }}</span>
          </li>
        </ul>
      </div>

      <div class="panel" data-ai="overview.tasks">
        <div class="panel-head" data-src="taskList">
          <h3>{{ isDirect ? '最近操作' : '最近任务' }}</h3>
          <button class="link" @click="goTasks">{{ isDirect ? '操作日志 →' : '全部 →' }}</button>
        </div>
        <!-- 直连没有 OCP 的任务子系统，任务面板改读本地写操作日志，否则永远是"暂无任务记录" -->
        <template v-if="isDirect">
          <div v-if="!localOps.length" class="panel-empty">还没有直连写操作记录（建/删租户、改参数、授权都会记在这里）</div>
          <ul class="task-list">
            <li v-for="t in localOps" :key="t.id">
              <span class="dot" :class="t.ok ? 'ok' : 'bad'"></span>
              <div class="task-body">
                <div class="task-name">{{ t.action }}<span v-if="t.target" class="task-target"> · {{ t.target }}</span></div>
                <div class="task-sub">{{ t.message || t.clusterName || '—' }}</div>
              </div>
              <span class="task-time">{{ relTime(new Date(t.at).toISOString()) }}</span>
            </li>
          </ul>
        </template>
        <template v-else>
          <div v-if="!ov.tasks.length" class="panel-empty">暂无任务记录</div>
          <ul class="task-list">
            <li v-for="t in ov.tasks" :key="t.id">
              <span class="dot" :class="taskStatus(t.status).tone"></span>
              <div class="task-body">
                <div class="task-name">{{ t.name }}</div>
                <div class="task-sub">{{ t.clusterName || '—' }} · {{ t.creator || '—' }}</div>
              </div>
              <span class="task-time">{{ relTime(t.startTime) }}</span>
            </li>
          </ul>
        </template>
      </div>
    </div>
    </template>
    <div v-else class="ov-loading">
      <span class="spinner"></span>
      {{ offline.length ? '其余集群的数据正在读取…' : '正在读取集群数据…' }}
    </div>
  </div>
</template>

<script setup lang="ts">
/** 云管平台 · 总览：把 OCP 的集群/主机/告警/任务收敛成一屏可判断的看板；悬浮卡片展示每块数据的采集链路 */
import { computed, onMounted, ref, watch } from 'vue'
import CapacityBar from './CapacityBar.vue'
import { activePlatform, cloud, offlineClusters, openCluster, retryClusters, setView, skipOfflineClusters } from '../../cloud/state'
import { directTasks } from '../../cloud/directTenant'
import * as F from '../../cloud/parts'

const ov = computed(() => cloud.overview)
const editionLabel = computed(() => (ov.value?.info.edition === 'ENTERPRISE' ? '企业版' : ov.value?.info.edition || '—'))

/** 直连模式：任务面板改读本地操作日志 */
const isDirect = computed(() => cloud.access === 'direct' || activePlatform()?.type === 'obdirect')

// ---- 直连：某几套集群没探到 ----
/** 还没确认跳过的：出提示条，可单条重试或整轮确认 */
const offline = computed(() => offlineClusters().filter((x) => !x.skipped))
/** 已确认跳过的：收成一行，不反复打扰，但别让人忘了它们还在 */
const skipped = computed(() => offlineClusters().filter((x) => x.skipped))

function retryOne(platformId: string): void {
  void retryClusters(platformId)
}
function skipAll(): void {
  skipOfflineClusters()
}
function goClusters(): void {
  void setView('clusters')
}
const localOps = ref<{ id: string; at: number; action: string; target: string; message: string; ok: boolean; clusterName: string }[]>([])

async function loadLocalOps(): Promise<void> {
  if (!isDirect.value) return
  const r = await directTasks({ page: 1, size: 6 })
  localOps.value = r.items.map((x) => ({
    id: x.id,
    at: x.at,
    action: x.action,
    target: x.target,
    message: x.message,
    ok: x.ok,
    clusterName: x.clusterName
  }))
}
onMounted(() => void loadLocalOps())
watch(() => cloud.updatedAt, () => void loadLocalOps())

const clusterStatus = F.clusterStatus
const clusterMode = F.clusterMode
const originLabel = F.originLabel
const alarmLevel = F.alarmLevel
const alarmScope = F.alarmScope
const taskStatus = F.taskStatus
const relTime = F.relTime

function worstTone(c: CloudCluster): string {
  const levels = c.alarms.levels.filter((x) => x.count > 0).map((x) => x.level)
  if (!levels.length) return 'ok'
  const min = Math.min(...levels)
  if (min === 1) return 'bad'
  if (min === 2) return 'warn'
  return 'info'
}

function drill(id: number): void {
  cloud.view = 'clusters'
  void openCluster(id)
}
function goAlarms(): void { void setView('alarms') }
function goTasks(): void { void setView(isDirect.value ? 'dtasks' : 'tasks') }
</script>

<style scoped>
.ov { display: flex; flex-direction: column; gap: 14px; }
.task-target { color: var(--text-faint); font-weight: 400; }
.ov-warn {
  display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border-radius: 9px;
  background: var(--yellow-dim); border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent);
  color: var(--text); font-size: 12px; line-height: 1.6;
}
.ov-warn-ico {
  width: 16px; height: 16px; border-radius: 50%; background: var(--yellow); color: #1a1206;
  display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px; flex-shrink: 0; margin-top: 1px;
}
.ov-warn b { display: block; margin-bottom: 2px; }

/* 直连：没探到的集群（黄条，可单条重试 / 整轮确认跳过） */
.ov-off {
  display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 9px;
  background: var(--yellow-dim); border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent);
  font-size: 12px; line-height: 1.6;
}
.ov-off-ico {
  width: 16px; height: 16px; border-radius: 50%; background: var(--yellow); color: #1a1206;
  display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 11px; flex-shrink: 0; margin-top: 2px;
}
.ov-off-body { flex: 1; min-width: 0; }
.ov-off-body b { font-weight: 600; }
.ov-off-body .muted { color: var(--text-dim); font-weight: 400; }
.ov-off-row { display: flex; align-items: center; gap: 8px; margin-top: 5px; min-width: 0; }
.ov-off-row .name { font-weight: 600; flex-shrink: 0; }
.ov-off-row .addr { font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
.ov-off-row .err { color: var(--text-dim); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ov-off-row .link { flex-shrink: 0; }
.ov-off-act { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
.ov-off-act .tip { font-size: 11px; color: var(--text-dim); flex: 1; }
.mini {
  border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text);
  border-radius: 7px; font-size: 11.5px; padding: 3px 10px; cursor: pointer; font-family: inherit; flex-shrink: 0;
}
.mini:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.mini:disabled { opacity: 0.5; cursor: not-allowed; }
.link:disabled { opacity: 0.4; cursor: not-allowed; }

/* 已确认跳过：一行灰字，别占版面 */
.ov-skip {
  display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-dim);
  padding: 7px 12px; border: 1px dashed var(--border); border-radius: 9px; background: var(--bg-card);
}
.ov-skip .link { margin-left: auto; }

.ov-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.kpi {
  background: var(--bg-card); border: 1px solid var(--border); border-left: 2.5px solid var(--border-strong);
  border-radius: 10px; padding: 9px 12px 10px; min-width: 0;
}
.kpi.warn { border-left-color: var(--yellow); }
.kpi.bad { border-left-color: var(--red); }
.kpi-label { font-size: 11px; color: var(--text-faint); letter-spacing: 0.3px; }
.kpi-value { font-size: 20px; font-weight: 700; font-family: var(--mono); margin-top: 2px; line-height: 1.15; }
.kpi-value.sm { font-size: 15px; padding-top: 3px; }
.kpi-unit { font-size: 11px; color: var(--text-dim); font-weight: 500; margin-left: 3px; }
.kpi-sub { font-size: 11px; color: var(--text-dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi.warn .kpi-value { color: var(--yellow); }
.kpi.bad .kpi-value { color: var(--red); }

.ov-section-head { display: flex; align-items: baseline; gap: 10px; margin-top: 2px; }
.ov-section-head h3 { font-size: 12.5px; font-weight: 600; color: var(--text); letter-spacing: 0.2px; }
.ov-section-head .hint { font-size: 11px; color: var(--text-faint); }

.ov-clusters { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 10px; }
.cl-card {
  text-align: left; font-family: inherit; cursor: pointer; color: inherit;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 13px; display: flex; flex-direction: column; gap: 8px;
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.cl-card:hover { border-color: var(--accent); box-shadow: var(--shadow); transform: translateY(-1px); }
.cl-card-top { display: flex; align-items: center; gap: 8px; }
.cl-name { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
.cl-name b { font-size: 13.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cl-ver { font-family: var(--mono); font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
.tag {
  font-size: 10.5px; padding: 1px 6px; border-radius: 99px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim); flex-shrink: 0;
}
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-faint); }
.dot.ok { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.dot.warn { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.dot.bad { background: var(--red); box-shadow: 0 0 0 3px var(--red-dim); }
.dot.info { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
.dot.idle { background: var(--text-faint); }
.cl-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--text-dim); }
.cl-cap { display: flex; flex-direction: column; gap: 5px; margin-top: 2px; }
.cl-foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-faint); margin-top: 2px; }
.mono { font-family: var(--mono); }
.alarm-chip { margin-left: auto; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim); }
.alarm-chip.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.alarm-chip.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); background: var(--yellow-dim); }
.alarm-chip.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.alarm-chip.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }

.ov-twocol { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 10px; }
.panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.panel-head { display: flex; align-items: center; padding: 10px 13px 8px; border-bottom: 1px solid var(--border); }
.panel-head h3 { font-size: 12.5px; font-weight: 600; flex: 1; }
.link { background: none; border: none; color: var(--accent); font-size: 11.5px; cursor: pointer; font-family: inherit; padding: 2px 4px; border-radius: 5px; }
.link:hover { background: var(--accent-dim); }
.panel-empty { padding: 22px 14px; text-align: center; color: var(--text-faint); font-size: 12px; }
.alarm-list, .task-list { list-style: none; margin: 0; padding: 4px 0; }
.alarm-list li, .task-list li { display: flex; align-items: center; gap: 9px; padding: 7px 13px; }
.alarm-list li:hover, .task-list li:hover { background: var(--bg-card-hover); }
.lv { font-size: 10px; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; border: 1px solid transparent; }
.lv.bad { color: var(--red); background: var(--red-dim); border-color: color-mix(in srgb, var(--red) 35%, transparent); }
.lv.warn { color: var(--yellow); background: var(--yellow-dim); border-color: color-mix(in srgb, var(--yellow) 35%, transparent); }
.lv.info { color: var(--accent); background: var(--accent-dim); border-color: var(--accent-dim); }
.lv.idle { color: var(--text-dim); background: var(--bg-input); border-color: var(--border); }
.alarm-body, .task-body { min-width: 0; flex: 1; }
.alarm-name, .task-name { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alarm-sub, .task-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alarm-time, .task-time { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; flex-shrink: 0; }

.ov-empty { padding: 24px; text-align: center; color: var(--text-faint); font-size: 12.5px; border: 1px dashed var(--border); border-radius: 12px; }
.ov-loading { display: flex; align-items: center; gap: 9px; color: var(--text-dim); font-size: 12.5px; padding: 40px 0; justify-content: center; }
.spinner { width: 13px; height: 13px; border: 2px solid var(--accent-dim); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
