<template>
  <div class="cloud">
    <!-- 进来先选数据库类型：整页环形选择器，选中后才露出真正的控制台 -->
    <DbPicker v-if="cloud.picking" @pick="onPick" />
    <DbIntro v-else-if="cloud.intro" :key="cloud.intro" :vendor="cloud.intro" @done="enterPlatform" />
    <!-- 只做了架构预览的引擎：动画演完给一页占位，功能页后续按模块替换 -->
    <EnginePreview v-else-if="cloud.preview" :engine="cloud.preview" @back="pickAnother" />
    <div v-else class="cwrap">
    <!-- 顶部全局栏：品牌 + 全局入口（对齐 OCP header） -->
    <header class="ctop">
      <div class="ctop-brand">
        <span class="ctop-logo">☁</span>
        <b>云管平台</b>
        <!-- 当前平台标识：点一下回到平台选择页 -->
        <button class="vback" title="返回平台选择" @click="cloud.picking = true">
          <i>‹</i>
          <b>{{ isOracle ? 'Oracle' : 'OceanBase' }}</b>
          <em>切换平台</em>
        </button>
        <!-- OceanBase 二级接入方式：OCP 托管 / 直连集群（直连支持多套，合并展示） -->
        <div v-if="!isOracle" class="accseg" role="tablist" aria-label="接入方式">
          <button
            role="tab"
            :class="{ on: cloud.access === 'ocp' }"
            :disabled="!hasOcpPlatform"
            :title="hasOcpPlatform ? '通过 OCP 接口管理集群' : '尚未配置 OCP 平台'"
            @click="switchAccess('ocp')"
          >
            OCP
          </button>
          <button
            role="tab"
            :class="{ on: cloud.access === 'direct' }"
            :disabled="!hasDirectPlatform"
            :title="hasDirectPlatform ? `直连集群 SQL 端口，已配置 ${directCount} 套，合并展示` : '尚未配置直连平台'"
            @click="switchAccess('direct')"
          >
            直连<em v-if="directCount > 1" class="accn">{{ directCount }}</em>
          </button>
        </div>
      </div>
      <!-- AI 助手：点一下先在页面上勾选读取范围（各子模块 / tab 右上角出现勾选框），勾完再开对话 -->
      <button
        class="tbi ai-btn"
        :class="{ on: aiOn, picking: aiPicking }"
        :disabled="!platform"
        :title="aiPicking ? '正在勾选 AI 读取范围：点这里取消（Esc 同样取消）' : `${aiAppName}：在页面上勾选要读取的内容，再基于这些数据开对话`"
        @click="toggleActiveAi"
      >
        <span class="tbi-ico">✦</span><em>AI 助手</em>
        <i v-if="aiBusy" class="ai-dot"></i>
      </button>
      <span class="spacer"></span>
      <button v-if="!isOracle" class="tbi" :disabled="!platform" title="搜索集群 / 租户 / 主机（Ctrl+K）" @click="cloud.searchOpen = true">
        <span class="tbi-ico">⌕</span><em>搜索</em>
      </button>
      <button v-if="!isOracle" class="tbi" :class="{ on: cloud.view === 'alarms' }" :disabled="!platform" title="活跃告警" @click="setView('alarms')">
        <span class="tbi-ico">⚠</span><em>告警</em>
        <i v-if="alarmCount" class="tbi-badge" :class="{ bad: criticalCount }">{{ alarmCount }}</i>
      </button>
      <button v-if="!isOracle && !isDirect" class="tbi" :class="{ on: cloud.view === 'tasks' }" :disabled="!platform" title="运维任务流水" @click="setView('tasks')">
        <span class="tbi-ico">⟳</span><em>任务</em>
      </button>
      <span class="ctop-sep"></span>
      <!-- 学习 / 工作模式已提到顶栏 logo 旁（全局设置），云管这里不再重复放开关 -->
      <select v-if="!isOracle && ocpPlatforms.length" class="ctop-select" :value="cloud.activeId" title="切换 OCP 平台" @change="onPlatformChange">
        <option v-for="p in ocpPlatforms" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <button class="tbi icon" :title="cloud.platforms.length ? '管理云平台接入' : '接入平台（OCP / Oracle）'" @click="cloud.settingsOpen = true">
        <span class="tbi-ico">⚙</span>
      </button>
      <span class="ctop-status" :class="statusTone" :title="statusTitle"><i class="dot"></i>{{ statusText }}</span>
    </header>

    <OracleConsole v-if="isOracle" />

    <div v-else class="cbody">
      <!-- 左侧菜单：与 OCP 一样平铺，不做多层折叠 -->
      <aside class="cn">
        <div v-for="g in NAV_GROUPS" :key="g.title" class="cn-group">
          <div class="cn-title">{{ g.title }}<span v-if="g.soon" class="soon">{{ g.soon }}</span></div>
          <button
            v-for="v in g.items"
            :key="v.key"
            class="cn-item"
            :class="{ active: cloud.view === v.key }"
            :title="v.desc"
            @click="setView(v.key)"
          >
            <span class="cn-ico">{{ v.icon }}</span>
            <span class="cn-label">{{ v.label }}</span>
            <span v-if="v.key === 'alarms' && alarmCount" class="cn-badge" :class="{ bad: criticalCount }">{{ alarmCount }}</span>
            <span v-else-if="v.key === 'clusters' && clusterCount" class="cn-num">{{ clusterCount }}</span>
            <span v-else-if="v.key === 'backup' && backupNoStrategy" class="cn-num">{{ backupNoStrategy }}</span>
            <span v-else-if="v.key === 'inspection' && inspectionHigh" class="cn-badge bad">{{ inspectionHigh }}</span>
          </button>
        </div>
      </aside>

      <section class="cm">
        <!-- 页面标题区：OCP 是「大标题 + 一句说明 + 右侧动作」，不用面包屑 -->
        <div class="page-head">
          <div class="ph-main">
            <h1>{{ viewLabel }}<span v-if="clusterName" class="ph-tail">{{ clusterName }}</span></h1>
            <p>{{ viewDesc }}</p>
          </div>
          <div class="ph-actions">
            <span v-if="cloud.updatedAt" class="updated">{{ updatedText }}</span>
            <button class="tb" :disabled="cloud.loading || !platform" :title="isDirect ? '重新读取直连集群数据' : '重新读取 OCP 数据'" @click="load">
              <span class="spin-ico" :class="{ spin: cloud.loading }">⟳</span> 刷新
            </button>
            <!-- 直连模式没有 OCP 控制台可跳，别留一个点了没反应的按钮 -->
            <button v-if="!isDirect" class="tb" :disabled="!platform" title="在系统浏览器中打开 OCP 原生控制台" @click="openNative">↗ 打开 OCP</button>
          </div>
        </div>

      <div class="cm-body">
        <!-- 未接入 -->
        <div v-if="!ocpPlatforms.length" class="state">
          <div class="state-ico">☁</div>
          <b>接入云平台</b>
          <p>
            <b>OceanBase（OCP）</b>：填 OCP 地址与账号，直接调 REST 接口取集群 / 租户 / 主机 / 告警 / 任务。<br />
            <b>Oracle</b>：填数据库连接信息，直接查 v$ / dba_ 视图取 RAC、实例、表空间、会话、SQL、备份、Data Guard。
          </p>
          <button class="btn primary" @click="cloud.settingsOpen = true">＋ 接入平台</button>
        </div>

        <!-- 连接异常：本地视图（任务日志）不依赖连接，不能被整页错误顶掉——
             排查故障时恰恰最需要看它 -->
        <div v-else-if="cloud.status && !cloud.status.ok && !isLocalView" class="state err">
          <div class="state-ico bad">!</div>
          <b>{{ isDirect ? '无法连接直连集群' : '无法访问 OCP' }}</b>
          <p class="mono">{{ cloud.status.error }}</p>
          <div class="state-actions">
            <button class="btn primary" @click="retry">重试</button>
            <button class="btn ghost" @click="cloud.settingsOpen = true">检查配置</button>
          </div>
        </div>

        <template v-else>
          <div v-if="cloud.status && !cloud.status.ok" class="errbar">
            <span class="errbar-ico">!</span>
            <span>{{ cloud.status.error }}</span>
            <button class="link" @click="cloud.settingsOpen = true">检查配置</button>
          </div>
          <div v-if="cloud.error" class="errbar">
            <span class="errbar-ico">!</span>
            <span>{{ cloud.error }}</span>
            <button class="link" @click="load">重试</button>
          </div>
          <OverviewPane v-if="cloud.view === 'overview'" />
          <ClustersPane v-else-if="cloud.view === 'clusters'" />
          <TenantsPane v-else-if="cloud.view === 'tenants'" />
          <ObproxyPane v-else-if="cloud.view === 'obproxy'" />
          <HostsPane v-else-if="cloud.view === 'hosts'" />
          <BackupPane v-else-if="cloud.view === 'backup'" />
          <InspectionPane v-else-if="cloud.view === 'inspection'" />
          <MonitorPane v-else-if="cloud.view === 'monitor'" />
          <SqlDiagPane v-else-if="cloud.view === 'sqldiag'" />
          <AlarmsPane v-else-if="cloud.view === 'alarms'" />
          <!-- 直连的「任务」是本地文本日志，与 OCP 的任务子系统不是一回事 -->
          <DirectTasksPane v-else-if="cloud.view === 'dtasks'" />
          <TasksPane v-else-if="cloud.view === 'tasks'" />
          <PlatformPane v-else-if="cloud.view === 'platform'" />
          <DirectOpsPane v-else-if="cloud.view === 'direct'" />
        </template>
        </div>

        <!-- 主机 SSH 分窗：作为主区的最后一个 flex 子节点贴在窗口底部，
             上边界可拖动；支持多会话，最小化后成任务栏（组件不卸载，内容保留） -->
        <HostSshDock v-if="cloud.hostSshSessions.length" />
      </section>
    </div>

    <PlatformSettings v-if="cloud.settingsOpen" @close="cloud.settingsOpen = false" />

    <!-- 全局搜索（Ctrl+K） -->
    <CloudSearch v-if="cloud.searchOpen" />

    <!-- 采集来源悬浮卡：全局挂一次，各页元素挂 data-src 即可 -->
    <SourceTip :sources="ALL_SOURCES" :resolve="sourceDetail" />

    <!-- 云管 AI 助手浮窗（对话；顶部可切历史/重新开始） -->
    <CloudAi />
    <OraAi />
    <!-- AI 读取范围：直接在原有界面上勾（各子模块 / tab 右上角方框 + 底部操作条） -->
    <AiPickOverlay
      :key="isOracle ? 'oracle' : 'ocp'"
      :store="isOracle ? oraAi : ai"
      :catalog="isOracle ? ORA_AI_CATALOG : OCP_AI_CATALOG"
      :actions="pickActions"
    />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 云管平台（一级模块）：左侧二级导航 + 主区。
 * 目前只有 OceanBase（OCP）一组入口，结构上按"厂商分组"预留后续扩展位。
 */
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import DbPicker from './DbPicker.vue'
import DbIntro from './DbIntro.vue'
import EnginePreview from './EnginePreview.vue'
import OverviewPane from './OverviewPane.vue'
import ClustersPane from './ClustersPane.vue'
import TenantsPane from './TenantsPane.vue'
import ObproxyPane from './ObproxyPane.vue'
import HostsPane from './HostsPane.vue'
import BackupPane from './BackupPane.vue'
import InspectionPane from './InspectionPane.vue'
import MonitorPane from './MonitorPane.vue'
import SqlDiagPane from './SqlDiagPane.vue'
import AlarmsPane from './AlarmsPane.vue'
import TasksPane from './TasksPane.vue'
import PlatformPane from './PlatformPane.vue'
import DirectOpsPane from './DirectOpsPane.vue'
import DirectTasksPane from './direct/DirectTasksPane.vue'
import HostSshDock from './host/HostSshDock.vue'
import PlatformSettings from './PlatformSettings.vue'
import CloudSearch from './CloudSearch.vue'
import SourceTip from './SourceTip.vue'
import CloudAi from './CloudAi.vue'
import AiPickOverlay from './AiPickOverlay.vue'
import OraAi from './OraAi.vue'
import OracleConsole from './oracle/OracleConsole.vue'
import { CLOUD_VIEWS, cloud, activePlatform, initCloud, load, platformsOf, selectPlatform, setVendor, setView, setAccess } from '../../cloud/state'
import { ora, loadEnvs } from '../../cloud/oracle'
import type { CloudView as CloudViewKey } from '../../cloud/state'
import { ai, cancelPick, clearDraft, finishPick, openSession, toggleAi, toggleDraft } from '../../cloud/ai'
import { OCP_AI_CATALOG } from '../../cloud/aiCatalog'
import {
  oraAi,
  ORA_AI_CATALOG,
  cancelOraPick,
  clearOraDraft,
  finishOraPick,
  openOraSession,
  toggleOraAi,
  toggleOraDraft
} from '../../cloud/oraAi'
import { isRealVendor, type EngineId } from '../../cloud/engines'
import { relTime } from '../../cloud/parts'
import { ALL_SOURCES } from '../../cloud/sources'
import { sourceDetail } from '../../cloud/sources/detail'

const platform = computed(() => activePlatform())
/** 当前厂商入口：Oracle 直连（查 v$ 视图）/ OceanBase（调 OCP 接口） */
const isOracle = computed(() => cloud.vendor === 'oracle')
const ocpPlatforms = computed(() => platformsOf('ocp'))
const oracleEnvCount = computed(() => platformsOf('oracle').length)

/** AI 助手：两个厂商各一套 store，顶栏按钮跟着当前厂商走 */
const aiOn = computed(() => (isOracle.value ? oraAi.open || oraAi.picking : ai.open || ai.picking))
const aiPicking = computed(() => (isOracle.value ? oraAi.picking : ai.picking))
const aiBusy = computed(() => (isOracle.value ? oraAi.streaming || oraAi.building : ai.streaming || ai.building))
const aiAppName = computed(() => (isOracle.value ? 'Oracle AI 助手' : '云管 AI 助手'))

function toggleActiveAi(): void {
  if (isOracle.value) toggleOraAi()
  else toggleAi()
}

/** 勾选条的动作：两个 store 的函数名不同，这里按厂商注入 */
const pickActions = computed(() =>
  isOracle.value
    ? { cancel: cancelOraPick, clear: clearOraDraft, finish: finishOraPick, toggle: toggleOraDraft, open: openOraSession }
    : { cancel: cancelPick, clear: clearDraft, finish: finishPick, toggle: toggleDraft, open: openSession }
)

const VENDORS = [
  { key: 'ocp' as const, label: 'OceanBase', icon: 'OB', desc: 'OceanBase 云平台（OCP）：调 REST 接口取集群 / 租户 / 主机 / 告警 / 任务' },
  { key: 'oracle' as const, label: 'Oracle', icon: 'ORA', desc: 'Oracle 直连：多套环境并排，点进去查该环境的 v$ / dba_ 视图' }
]

/**
 * 选择页里点了某个数据库云平台：先进架构装配动画，数据在后台同步加载，
 * 3 秒演完通常已经拿到首屏数据了。
 */
function onPick(v: EngineId): void {
  cloud.picking = false
  cloud.intro = v
  // 只做了预览的引擎：直接进占位页，不碰 OCP / Oracle 的数据链路
  if (!isRealVendor(v)) {
    cloud.preview = v
    return
  }
  cloud.preview = null
  if (cloud.vendor === v) {
    if (v === 'oracle') void loadEnvs()
    return
  }
  switchVendor(v)
}

/** 动画演完（或用户点了跳过）→ 露出控制台 / 占位页 */
function enterPlatform(): void {
  cloud.intro = null
}

/** 占位页「返回平台选择」：连预览态一起收掉 */
function pickAnother(): void {
  cloud.preview = null
  cloud.picking = true
}

function switchVendor(v: 'ocp' | 'oracle'): void {
  if (cloud.vendor === v) return
  // 换厂商就收掉 AI 勾选态与浮窗：勾选框挂的是另一家的块，留着会错位
  cancelPick()
  cancelOraPick()
  ai.open = false
  oraAi.open = false
  void setVendor(v).then(() => {
    if (v === 'oracle') void loadEnvs()
  })
}
const viewLabel = computed(() => CLOUD_VIEWS.find((v) => v.key === cloud.view)?.label || '')
const viewDesc = computed(() => CLOUD_VIEWS.find((v) => v.key === cloud.view)?.desc || '')

/** 左侧导航按 OCP 的分组铺开：数据库对象 / 备份与巡检 / 平台 */
const viewOf = (k: CloudViewKey) => CLOUD_VIEWS.find((v) => v.key === k)!

/** 直连模式（无 OCP）没有代理 / 备份任务 / 平台用户体系，导航只留能取到数的页 */
/** 纯本地视图：数据来自本机文件/配置，不需要连上集群（任务日志） */
const isLocalView = computed(() => cloud.view === 'dtasks')

const isDirect = computed(() =>
  cloud.vendor === 'ocp' && (cloud.access === 'direct' || activePlatform()?.type === 'obdirect')
)

const hasOcpPlatform = computed(() => cloud.platforms.some((p) => p.type === 'ocp'))
const hasDirectPlatform = computed(() => cloud.platforms.some((p) => p.type === 'obdirect'))
const directCount = computed(() => cloud.platforms.filter((p) => p.type === 'obdirect').length)

function switchAccess(a: 'ocp' | 'direct'): void {
  if (cloud.access === a) return
  void setAccess(a)
}

const NAV_GROUPS = computed<{ title: string; items: ReturnType<typeof viewOf>[] }[]>(() => {
  if (isDirect.value) {
    return [
      { title: 'OceanBase 直连', items: (['overview', 'clusters', 'tenants', 'hosts'] as CloudViewKey[]).map(viewOf) },
      // 分组叫「运维」而不是「直连运维」：否则分组名与条目名重复，看不出这一组是干什么的
      { title: '运维', items: (['direct', 'dtasks'] as CloudViewKey[]).map(viewOf) },
      { title: '告警', items: (['alarms'] as CloudViewKey[]).map(viewOf) }
    ]
  }
  return [
    {
      title: 'OceanBase',
      items: (['overview', 'clusters', 'tenants', 'obproxy', 'hosts', 'monitor', 'sqldiag', 'alarms', 'tasks'] as CloudViewKey[]).map(viewOf)
    },
    { title: '备份与巡检', items: (['backup', 'inspection'] as CloudViewKey[]).map(viewOf) },
    { title: '平台', items: (['platform'] as CloudViewKey[]).map(viewOf) }
  ]
})

// 切到直连平台时，当前视图可能是 OCP 专有页（如 obproxy），回落到总览避免空白
watch(isDirect, (direct) => {
  if (!direct) return
  if (!['overview', 'clusters', 'tenants', 'hosts', 'alarms', 'direct', 'dtasks'].includes(cloud.view)) {
    setView('overview')
  }
})


/** 未建备份策略的集群数（侧栏角标，提醒「还有集群没备份」） */
const backupNoStrategy = computed(
  () => (cloud.backup.bundle?.objects || []).filter((o) => o.backupStatus !== 'HAS_BACKUP_STRATEGY').length
)
/** 最近一次巡检的高风险项数 */
const inspectionHigh = computed(() => cloud.inspection.bundle?.tasks[0]?.high || 0)
const clusterName = computed(() => (cloud.view === 'clusters' && cloud.cluster ? `· ${cloud.cluster.cluster.name}` : ''))
const clusterCount = computed(() => cloud.overview?.kpis.clusters ?? cloud.clusters.length)
const alarmCount = computed(() => cloud.overview?.kpis.alarms ?? cloud.alarms.length)
const criticalCount = computed(() => (cloud.overview?.kpis.alarmsCritical || 0) > 0)
const statusTone = computed(() => {
  if (isOracle.value) {
    if (!oracleEnvCount.value) return 'idle'
    const bad = ora.envs.filter((e) => e.error).length
    if (!ora.envs.length) return 'wait'
    return bad === ora.envs.length ? 'bad' : 'ok'
  }
  return !cloud.platforms.length ? 'idle' : !cloud.status ? 'wait' : cloud.status.ok ? 'ok' : 'bad'
})
/** 当前接入的所有集群版本（去重）：直连多套环境时版本可能不同，必须如数展示 */
const obVersions = computed(() => {
  const set = new Set(cloud.clusters.map((c) => c.version).filter(Boolean))
  if (!set.size && cloud.overview?.info?.version) set.add(cloud.overview.info.version)
  return [...set]
})

const statusText = computed(() => {
  if (isOracle.value) {
    if (!oracleEnvCount.value) return '未接入环境'
    if (ora.envsLoading && !ora.envs.length) return '探测中…'
    const ok = ora.envs.filter((e) => !e.error && e.summary).length
    return `Oracle ${ok}/${oracleEnvCount.value} 可用`
  }
  if (!cloud.platforms.length) return '未配置'
  if (!cloud.status) return '连接中…'
  if (!cloud.status.ok) return '连接异常'
  // 直连模式直连的是 OB 集群本身，没有 OCP——这里显示的必须是 OB 服务端版本，
  // 之前统一写成「OCP 5.7.25-OceanBase-v4.3.5.2」，既挂了 OCP 的名字，串里还带着 MySQL 兼容前缀
  if (isDirect.value) {
    const vs = obVersions.value
    if (!vs.length) return '直连 · 已连接'
    return vs.length === 1 ? `OB v${vs[0]}` : `OB ${vs.length} 个版本`
  }
  return `OCP ${cloud.status.info?.version || ''}`.trim()
})

const statusTitle = computed(() => {
  if (isOracle.value) return 'Oracle 直连：可用环境数 / 已接入环境数'
  if (isDirect.value) {
    const vs = obVersions.value
    if (!vs.length) return '直连 OBServer SQL 端口，未读取到版本'
    return `OceanBase 集群版本（取自 DBA_OB_SERVERS.BUILD_VERSION）：${vs.map((v) => `v${v}`).join(' / ')}`
      + '\n直连模式不经过 OCP，因此这里不显示 OCP 版本。'
  }
  const v = cloud.status?.info?.version
  return v ? `OCP 平台版本：${v}（来自 OCP 的 /api/v2/... 系统信息接口）` : 'OCP 平台连接状态'
})
const updatedText = computed(() => (cloud.updatedAt ? `更新于 ${relTime(new Date(cloud.updatedAt).toISOString())}` : ''))

function onPlatformChange(e: Event): void {
  void selectPlatform((e.target as HTMLSelectElement).value)
}
function retry(): void {
  void initCloud()
}
async function openNative(): Promise<void> {
  if (platform.value) await window.sqlpilot.openExternal(platform.value.baseUrl)
}

// 总览页 60s 静默刷新：告警与任务变化能自己浮上来，其它页面保持手动刷新避免打断阅读
let timer: ReturnType<typeof setInterval> | null = null
/** 初始化是异步的：await 回来时组件可能已经卸载，别再建定时器 */
let disposed = false
/** Ctrl/Cmd+K 唤起全局搜索（仅云管模块挂载时生效） */
function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (cloud.platforms.length) cloud.searchOpen = true
  }
}
onMounted(async () => {
  document.addEventListener('keydown', onKey)
  await initCloud()
  // 初始化要走真实探活（秒级），期间用户可能已经切走、组件被卸载：
  // 此时再建定时器就没人清理了，会一直打接口并且每进出一次模块多一个
  if (disposed) return
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (cloud.view === 'overview' && cloud.status?.ok && !cloud.loading) void load()
  }, 60000)
})
onBeforeUnmount(() => {
  disposed = true
  cancelPick()
  cancelOraPick()
  document.removeEventListener('keydown', onKey)
  cloud.searchOpen = false
  if (timer) clearInterval(timer)
  timer = null
})
</script>

<style scoped>
.cloud { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; position: relative; }
/* 选择页与真正控制台互斥；contents 让包裹层不参与布局，原来的 flex 结构原样成立 */
.cwrap { display: contents; }

/* 顶部全局栏（对齐 OCP header） */
.ctop {
  height: 46px; min-height: 46px; display: flex; align-items: center; gap: 3px;
  padding: 0 12px; background: var(--bg-side); border-bottom: 1px solid var(--border);
}
.ctop-brand { display: flex; align-items: center; gap: 8px; }
.ctop-logo {
  width: 24px; height: 24px; border-radius: 7px; display: flex; align-items: center; justify-content: center;
  background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); font-size: 12px; flex-shrink: 0;
}
.ctop-brand b { font-size: 13px; letter-spacing: 0.2px; }
.ctop-plat { font-size: 10.5px; color: var(--text-faint); border: 1px solid var(--border); border-radius: 99px; padding: 0 7px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbi {
  position: relative; display: inline-flex; align-items: center; gap: 5px; height: 27px; padding: 0 9px;
  border: none; border-radius: 7px; background: none; color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.tbi:hover:not(:disabled) { background: var(--bg-card-hover); color: var(--text); }
.tbi.on { background: var(--accent-dim); color: var(--accent); }
.tbi.icon { padding: 0 7px; }
.tbi:disabled { opacity: 0.4; cursor: not-allowed; }
.tbi-ico { font-size: 12px; }
.tbi em { font-style: normal; }
/* AI 入口：比普通工具按钮更显眼一点（accent 描边 + 微光），但仍保持顶栏克制 */
.ai-btn {
  margin-left: 4px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--accent-dim); color: var(--accent); font-weight: 600;
}
.ai-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); }
.ai-btn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
/* 勾选中：按钮加一圈呼吸光圈，提示「还在选，没进对话」 */
.ai-btn.picking { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); animation: ai-pick-pulse 1.6s ease-in-out infinite; }
@keyframes ai-pick-pulse { 50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 18%, transparent); } }
.ai-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--green); margin-left: 1px;
  animation: ai-pulse 1.4s ease-in-out infinite;
}
.ai-btn.on .ai-dot { background: #fff; }
@keyframes ai-pulse { 50% { opacity: 0.25; } }
.tbi-badge {
  position: absolute; top: 0; right: 0; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 99px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
  font-size: 9px; font-style: normal; display: flex; align-items: center; justify-content: center; font-family: var(--mono);
}
.tbi-badge.bad { background: var(--red); border-color: var(--red); color: #fff; }
.ctop-sep { width: 1px; height: 16px; background: var(--border); margin: 0 5px; flex-shrink: 0; }
.ctop-select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  font-family: inherit; font-size: 11.5px; padding: 3px 7px; outline: none; max-width: 130px;
}
.ctop-status { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-faint); margin-left: 6px; white-space: nowrap; }
.ctop-status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.ctop-status.ok { color: var(--green); }
.ctop-status.ok .dot { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.ctop-status.bad { color: var(--red); }
.ctop-status.bad .dot { background: var(--red); }
.ctop-status.wait .dot { background: var(--yellow); }

/* 厂商同级切换（OceanBase / Oracle）：两个独立 chip，选中态有强调色，避免挤成一串 */
/* 当前平台 + 返回选择页 */
.vback {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
  margin-left: 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; line-height: 1; white-space: nowrap;
  transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}
.vback:hover { color: var(--text); border-color: var(--border-strong); background: var(--bg-card); }
.vback i { font-style: normal; font-size: 14px; color: var(--text-faint); margin-right: -2px; }
.vback b { font-weight: 600; color: var(--text); }
.vback em { font-style: normal; font-size: 10.5px; color: var(--text-faint); }

/* OceanBase 二级接入方式开关（OCP / 直连） */
.accseg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 10px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
}
.accseg button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11.5px;
  cursor: pointer;
  transition: background .12s, color .12s;
}
.accseg button:hover:not(:disabled) { color: var(--text); }
.accseg button.on {
  background: rgba(90, 160, 255, .14);
  color: #bcd9ff;
  box-shadow: inset 0 0 0 1px rgba(90, 160, 255, .35);
}
.accseg button:disabled { opacity: .38; cursor: not-allowed; }
.accn {
  font-style: normal;
  font-size: 9.5px;
  line-height: 1;
  padding: 1px 4px;
  border-radius: 999px;
  background: rgba(90, 160, 255, .22);
  color: #cfe3ff;
}

.vswitch { display: flex; gap: 4px; margin-left: 12px; }
.vswitch > button {
  display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px 0 7px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-faint);
  font-family: inherit; font-size: 11.5px; line-height: 1; white-space: nowrap; cursor: pointer;
  transition: color 0.14s ease, border-color 0.14s ease, background 0.14s ease;
}
.vswitch > button:hover { color: var(--text); border-color: var(--border-strong); }
.vswitch > button.on { color: var(--text); border-color: var(--border-strong); background: var(--bg-card); box-shadow: inset 0 -2px 0 var(--accent); }
.vswitch .vico {
  font-style: normal; font-size: 8.5px; font-weight: 700; letter-spacing: 0.2px; padding: 1px 4px; border-radius: 4px;
  background: var(--bg-side); color: var(--text-faint); border: 1px solid var(--border); flex-shrink: 0;
}
.vswitch .vico.ocp { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.vswitch .vico.oracle { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.vswitch em { font-style: normal; font-family: var(--mono); font-size: 9.5px; color: var(--text-faint); }

.cbody { flex: 1; min-height: 0; display: flex; }

/* 二级导航 */
.cn {
  width: 196px; min-width: 196px; background: var(--bg-side); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 10px 9px;
}
.cn-head { padding: 0 4px 10px; }
.cn-brand { display: flex; align-items: center; gap: 9px; }
.cn-logo {
  width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
  background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); font-size: 15px; flex-shrink: 0;
}
.cn-brand b { display: block; font-size: 13px; letter-spacing: 0.3px; }
.cn-brand span { display: block; font-size: 10.5px; color: var(--text-faint); margin-top: 2px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cn-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
.cn-title {
  display: flex; align-items: center; gap: 6px; font-size: 10px; letter-spacing: 1.1px; text-transform: uppercase;
  color: var(--text-faint); padding: 6px 7px 4px;
}
.soon { font-size: 9px; letter-spacing: 0; text-transform: none; color: var(--text-faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; margin-left: auto; }
.cn-item {
  position: relative; display: flex; align-items: center; gap: 9px; height: 31px; padding: 0 9px;
  border: none; border-radius: 8px; background: none; color: var(--text-dim); cursor: pointer;
  font-family: inherit; font-size: 12.5px; text-align: left; transition: background 0.14s ease, color 0.14s ease;
}
.cn-item:hover { background: var(--bg-card-hover); color: var(--text); }
.cn-item.active { background: var(--accent-dim); color: var(--accent); }
.cn-item.active::before {
  content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 2.5px; border-radius: 0 2px 2px 0; background: var(--accent);
}
.cn-ico { width: 15px; text-align: center; font-size: 12px; color: var(--text-faint); flex-shrink: 0; }
.cn-item.active .cn-ico { color: var(--accent); }
.cn-label { flex: 1; }
.cn-badge, .cn-num {
  font-family: var(--mono); font-size: 10px; padding: 0 5px; border-radius: 99px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
}
.cn-badge.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.cn-soon { display: flex; align-items: center; gap: 9px; height: 26px; padding: 0 9px; font-size: 12px; color: var(--text-faint); opacity: 0.75; }
.cn-ico.dim { opacity: 0.5; }
.cn-spacer { flex: 1; }
.cn-foot { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.cn-foot select {
  width: 100%; background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text); font-family: inherit; font-size: 11.5px; padding: 5px 7px; outline: none;
}
.cn-set {
  display: flex; align-items: center; justify-content: center; gap: 6px; height: 27px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.cn-set:hover { color: var(--accent); border-color: var(--accent); }
.cn-status { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--text-faint); padding: 2px 2px 0; }
.cn-status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.cn-status.ok { color: var(--green); }
.cn-status.ok .dot { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.cn-status.bad { color: var(--red); }
.cn-status.bad .dot { background: var(--red); }
.cn-status.wait .dot { background: var(--yellow); }

/* 主区 */
.cm { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }

/* 页面标题区（OCP：大标题 + 一句说明 + 右侧动作，不用面包屑） */
.page-head {
  display: flex; align-items: flex-end; gap: 12px; padding: 13px 16px 11px;
  background: var(--bg-side); border-bottom: 1px solid var(--border);
}
.ph-main { min-width: 0; }
.ph-main h1 { font-size: 18px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.ph-tail { font-size: 12px; font-weight: 500; color: var(--accent); white-space: nowrap; }
.ph-main p { font-size: 11px; color: var(--text-faint); margin-top: 4px; line-height: 1.5; }
.ph-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; padding-bottom: 1px; }
.cm-bar {
  display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 42px; min-height: 42px;
  border-bottom: 1px solid var(--border); background: var(--bg-side);
}
.crumb { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-faint); }
.crumb b { color: var(--text); font-weight: 600; }
.crumb i { color: var(--border-strong); font-style: normal; }
.crumb-extra { color: var(--accent); font-size: 11.5px; }
.spacer { flex: 1; }
.updated { font-size: 10.5px; color: var(--text-faint); margin-right: 2px; }
.tb {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.tb:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.tb:disabled { opacity: 0.45; cursor: not-allowed; }
.spin-ico { display: inline-block; }
.spin-ico.spin { animation: rot 1s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }
.cm-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 22px; }

.errbar {
  display: flex; align-items: center; gap: 9px; margin-bottom: 10px; padding: 8px 11px; border-radius: 9px;
  background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent);
  color: var(--text); font-size: 12px;
}
.errbar-ico { width: 15px; height: 15px; border-radius: 50%; background: var(--red); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; }
.link { margin-left: auto; background: none; border: none; color: var(--accent); font-size: 11.5px; cursor: pointer; font-family: inherit; }
.link:hover { text-decoration: underline; }

.state {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px;
  text-align: center; padding: 60px 24px; color: var(--text-dim); font-size: 12.5px; line-height: 1.75; max-width: 560px; margin: 0 auto;
}
.state b { font-size: 15px; color: var(--text); }
.state p { color: var(--text-dim); }
.state-ico {
  width: 52px; height: 52px; border-radius: 15px; display: flex; align-items: center; justify-content: center;
  background: var(--accent-dim); border: 1px solid var(--accent); color: var(--accent); font-size: 23px; margin-bottom: 4px;
}
.state-ico.bad { background: var(--red-dim); border-color: var(--red); color: var(--red); font-weight: 800; font-size: 20px; }
.state-actions { display: flex; gap: 8px; margin-top: 6px; }
.state .mono { font-family: var(--mono); font-size: 11.5px; color: var(--red); max-width: 460px; word-break: break-word; }
</style>

<style>
/* 云管各页面共用的面板/表格/按钮样式（tp- 前缀），全局引一次即可 */
@import './panel.css';
</style>
