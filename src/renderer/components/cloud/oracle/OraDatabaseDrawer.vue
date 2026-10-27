<template>
  <div class="od-mask" @click.self="close">
    <section class="od-shell" :data-cluster="env?.name || ''" @click.stop>
      <header class="od-head">
        <div class="od-id">
          <div class="od-title">
            <span class="od-logo">ORA</span>
            <b>{{ env?.name || 'Oracle 库' }}</b>
            <span v-if="s" class="pill" :class="s.openMode === 'READ WRITE' ? 'ok' : 'warn'">{{ s.openMode }}</span>
            <span v-if="s" class="pill gray">{{ s.databaseRole }}</span>
            <span v-if="s" class="pill gray">{{ s.isRac ? 'RAC' : '单实例' }}</span>
            <span v-if="s?.isCdb" class="pill info">CDB</span>
            <span v-if="(env?.role || 'default') !== 'default'" class="pill warn">{{ (env?.role || '').toUpperCase() }}</span>
          </div>
          <div class="od-sub" data-src="orDbMeta">
            <span class="mono">{{ env?.host }}:{{ env?.port }}{{ env?.serviceName ? '/' + env.serviceName : '' }}</span>
            <i class="dot-sep">·</i> {{ env?.username }}
            <i class="dot-sep">·</i> {{ shortVer }}
            <template v-if="s"><i class="dot-sep">·</i> 启动 {{ s.startupTime || '—' }}</template>
          </div>
        </div>
        <div class="od-actions">
          <span v-if="meta.at" class="od-meta">取数 {{ meta.ms }} ms</span>
          <!-- AI 助手：直接在这个库里勾选要读的 tab；已有对话时也先勾选（等价于「调整范围」） -->
          <button
            class="act ai"
            :class="{ on: oraAi.picking, busy: oraAi.streaming || oraAi.building }"
            :title="oraAi.picking ? '正在勾选 AI 读取范围：点这里取消（Esc 同样取消）' : 'AI 助手：勾选这个库要读取的 tab，基于这些数据提问'"
            @click="onAiClick"
          >
            ✦ AI
          </button>
          <button class="act" :disabled="meta.loading" @click="refreshOra(ora.drawerTab)">
            <span :class="{ spin: meta.loading }">⟳</span> 刷新
          </button>
          <button class="x" title="关闭（Esc）" @click="close">✕</button>
        </div>
      </header>

      <nav class="od-tabs" :class="{ picking: oraAi.picking }">
        <button
          v-for="t in ORA_DETAIL_TABS"
          :key="t.key"
          class="od-tab"
          :class="{ on: ora.drawerTab === t.key, picking: oraAi.picking, picked: aiPicked(t.key) }"
          :data-src="t.src"
          :title="oraAi.picking ? `${t.desc}（点左边的方框把这一块加入 AI 读取范围）` : t.desc"
          @click="setDrawerTab(t.key)"
        >
          <span
            v-if="oraAi.picking"
            class="t-ck"
            :class="{ on: aiPicked(t.key) }"
            role="checkbox"
            :aria-checked="aiPicked(t.key)"
            :title="aiPicked(t.key) ? '已加入 AI 读取范围，点一下移除' : '点一下把这块加入 AI 读取范围'"
            @click.stop.prevent="toggleTab(t.key)"
          >✓</span>
          <span v-else class="t-ico">{{ t.icon }}</span>{{ t.label }}
          <i v-if="t.key === 'sessions' && blockingCount" class="t-badge bad">{{ blockingCount }}</i>
          <i v-else-if="t.key === 'overview' && issueCount" class="t-badge bad">{{ issueCount }}</i>
          <i v-else-if="t.key === 'users' && invalidCount" class="t-badge warn">{{ invalidCount }}</i>
        </button>
      </nav>

      <div class="od-body">
        <!-- 勾选提示条：把「怎么选」写清楚，点页面任意处也能勾当前这块 -->
        <div v-if="oraAi.picking" class="od-aipick" @click.stop>
          <span class="ic">✦</span>
          <span class="tx">
            AI 勾选模式 · 点<b>卡片 / 指标</b>就只读那一块；点<b>空白处</b>或 tab 左边的方框 = 整个「{{ currentTabLabel }}」（{{ aiPicked(ora.drawerTab) ? '已加入，点此移除' : '点此加入' }}）
          </span>
          <span class="sp"></span>
          <button class="pk" :class="{ on: aiPicked(ora.drawerTab) }" @click="toggleTab(ora.drawerTab)">
            {{ aiPicked(ora.drawerTab) ? '✓ 已加入，点此移除' : '＋ 加入读取范围' }}
          </button>
          <button class="pk ghost" @click="cancelOraPick">退出勾选</button>
        </div>
        <div v-if="meta.error" class="oc-err" style="margin: 10px 14px 0">
          <span>!</span>
          <span style="flex: 1">{{ meta.error }}</span>
          <button class="act" @click="refreshOra(ora.drawerTab)">重试</button>
        </div>
        <div v-if="meta.warnings.length" class="oc-warn" style="margin: 10px 14px 0">
          <span>⚠</span>
          <ul>
            <li v-for="w in meta.warnings" :key="w">{{ w }}</li>
          </ul>
        </div>
        <div v-if="meta.loading && !hasData" class="oc-loading">正在查库…</div>
        <div v-else class="od-pane" @click.capture="onPaneClick">
          <KeepAlive>
            <component :is="activeComp" :key="ora.drawerTab" />
          </KeepAlive>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * Oracle 库详情工作台（对齐 OCP 的租户详情：全屏覆盖 + 顶部 tab）。
 * 单个库/实例的 14 个深度分区都在这里，左侧导航只保留跨环境的整体视图。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import {
  ORA_DETAIL_TABS,
  closeDrawer,
  currentEnv,
  drawerMeta,
  ora,
  refreshOra,
  setDrawerTab,
  type OraPaneKey
} from '../../../cloud/oracle'
import { cancelOraPick, oraAi, oraAiKey, startOraPick, toggleOraDraft } from '../../../cloud/oraAi'
import OverviewPane from './OverviewPane.vue'
import RacPane from './RacPane.vue'
import InstancesPane from './InstancesPane.vue'
import PdbPane from './PdbPane.vue'
import StoragePane from './StoragePane.vue'
import SessionsPane from './SessionsPane.vue'
import SqlPane from './SqlPane.vue'
import PerfPane from './PerfPane.vue'
import AlertsPane from './AlertsPane.vue'
import BackupPane from './BackupPane.vue'
import DgPane from './DgPane.vue'
import JobsPane from './JobsPane.vue'
import ParamsPane from './ParamsPane.vue'
import UsersPane from './UsersPane.vue'

const TABS: Record<OraPaneKey, any> = {
  env: null,
  overview: OverviewPane,
  rac: RacPane,
  instances: InstancesPane,
  pdb: PdbPane,
  storage: StoragePane,
  sessions: SessionsPane,
  sql: SqlPane,
  perf: PerfPane,
  alerts: AlertsPane,
  backup: BackupPane,
  dg: DgPane,
  jobs: JobsPane,
  params: ParamsPane,
  users: UsersPane
}

const env = computed(() => currentEnv())
const s = computed(() => env.value?.summary || null)
const meta = computed(() => drawerMeta())
const activeComp = computed(() => TABS[ora.drawerTab] || OverviewPane)
const hasData = computed(() => !!ora.data[ora.envId]?.[ora.drawerTab])

const overview = computed(() => ora.data[ora.envId]?.overview as CloudOraOverview | undefined)
const issueCount = computed(() => overview.value?.issues.filter((i) => i.level !== 'info').length || 0)
const blockingCount = computed(() => (ora.data[ora.envId]?.sessions as CloudOraSessions | undefined)?.blocking.length || 0)
const invalidCount = computed(() => (s.value?.invalid || 0))

const shortVer = computed(() => {
  const m = /Oracle Database (\S+).*?(Enterprise|Standard) Edition.*?(\d+\.\d+\.\d+\.\d+\.\d+)/i.exec(s.value?.version || '')
  return m ? `${m[1]} ${m[2] === 'Enterprise' ? 'EE' : 'SE'} ${m[3]}` : (s.value?.version || 'Oracle')
})

/** 当前 tab 的中文名（提示条用） */
const currentTabLabel = computed(() => ORA_DETAIL_TABS.find((t) => t.key === ora.drawerTab)?.label || '当前页')

const aiPicked = (key: string): boolean => oraAi.draft.includes(oraAiKey(ora.envId, key))

/** 勾选 / 取消勾选某一块 */
function toggleTab(key: string): void {
  toggleOraDraft(oraAiKey(ora.envId, key))
}

/**
 * 头部的 ✦ AI：永远先进入勾选态。
 * 已有对话时按「调整范围」进来（把原范围带出来），避免点了按钮却看不到勾选框。
 */
function onAiClick(): void {
  if (oraAi.picking) {
    cancelOraPick()
    return
  }
  startOraPick(!!oraAi.sessionId)
}

/**
 * 勾选态下点内容区「空白处」= 勾当前这个 tab 整块。
 * 点到具体卡片时由 AiPickOverlay 的捕获处理器接管（data-ai），只勾那一块，不会走到这里。
 */
function onPaneClick(e: MouseEvent): void {
  if (!oraAi.picking) return
  const t = e.target as Element | null
  if (t?.closest('.od-aipick')) return
  // 拖选文字（复制 SQL、数字）时不当作点击，避免误勾/误取消
  const sel = window.getSelection()
  if (sel && !sel.isCollapsed && String(sel).trim()) return
  e.preventDefault()
  e.stopPropagation()
  toggleTab(ora.drawerTab)
}

function close(): void {
  closeDrawer()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ora.drawerOpen) closeDrawer()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.od-mask {
  position: fixed; inset: 0; z-index: 260; background: rgba(6, 8, 14, 0.46);
  display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px);
  /* 面板从原生窗口按钮区（- □ ×）以下开始，头部 ✕ 才点得到 */
  padding-top: var(--titlebar-h);
}
.od-shell {
  width: min(1320px, 96vw); height: 92vh; background: var(--bg-card);
  border: 1px solid var(--border-strong); border-radius: 13px; box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column; overflow: hidden; animation: pop 0.16s ease;
}
@keyframes pop { from { transform: translateY(8px) scale(0.995); opacity: 0.7; } to { transform: none; opacity: 1; } }
.od-head { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px 11px; }
.od-id { min-width: 0; }
.od-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.od-title b { font-size: 16px; }
.od-logo {
  width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center;
  font-size: 8.5px; font-weight: 700; background: var(--red-dim); color: var(--red); border: 1px solid var(--red);
}
.od-sub { font-size: 11px; color: var(--text-dim); margin-top: 5px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dot-sep { color: var(--text-faint); font-style: normal; }
.od-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.od-meta { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); margin-right: 2px; }
.act { border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 7px; padding: 4px 11px; font-size: 11.5px; font-family: inherit; cursor: pointer; }
.act:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.act:disabled { opacity: 0.5; cursor: not-allowed; }
/* 头部 ✦ AI：默认主色描边，勾选态实心（点完能看出已经进了勾选模式） */
.act.ai { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.act.ai:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-dim); }
.act.ai.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.act.ai.busy { opacity: 0.6; cursor: progress; }
.x { width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.od-tabs { display: flex; gap: 1px; padding: 0 14px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.od-tabs::-webkit-scrollbar { display: none; }
.od-tab {
  border: none; background: transparent; color: var(--text-faint); font-size: 12px; font-family: inherit;
  padding: 8px 10px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 5px;
}
.od-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.od-tab:hover { color: var(--text); }
.t-ico { font-size: 11px; opacity: 0.8; }
.t-badge {
  font-style: normal; font-family: var(--mono); font-size: 9.5px; padding: 0 4px; border-radius: 99px;
  border: 1px solid var(--border); color: var(--text-dim); line-height: 13px;
}
.t-badge.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.t-badge.warn { color: var(--warn, #d9a441); border-color: color-mix(in srgb, var(--warn, #d9a441) 45%, transparent); }
.od-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.od-body > * { flex: none; }
/* tab 内容自己滚动：panes 的根是 .oc-wrap（自己有 gap/列布局），外面再包一层只负责滚动与内边距 */
.od-pane { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 20px; display: flex; flex-direction: column; }
.pill { font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.pill.gray { color: var(--text-dim); }
.mono { font-family: var(--mono); }

/* ---------- AI 勾选态：tab 前的方框 / 已勾 tab / 顶部提示条 ----------
   注意：这几组类名必须在 scoped 里写全。缺了样式时方框会退化成
   一个几像素宽的 "✓" 文字，用户点不到、也看不出勾没勾。 */
.od-tab.picking { cursor: pointer; }
.od-tab.picking:hover { background: var(--bg-input); }
/* 已加入读取范围：底色 + 主色，和「当前 tab」的下划线区分开 */
.od-tab.picked { color: var(--accent); background: var(--accent-dim); border-radius: 5px 5px 0 0; }
.od-tab.picked.on { background: var(--accent-dim); }

/* tab 里的勾选框：16px 可点方框，未勾只显示空框 */
.t-ck {
  width: 16px; height: 16px; flex-shrink: 0; box-sizing: border-box;
  border-radius: 4px; border: 1.5px solid color-mix(in srgb, var(--accent) 55%, transparent); background: var(--bg-input);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; line-height: 1; color: transparent; cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.od-tab.picking:hover .t-ck { border-color: var(--accent); }
.t-ck:hover { border-color: var(--accent); }
.t-ck.on { border-color: var(--accent); background: var(--accent); color: #fff; }

/* 勾选提示条 */
.od-aipick {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 10px 14px 0; padding: 7px 10px;
  background: var(--accent-dim);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 8px; font-size: 11.5px; color: var(--text-dim);
}
.od-aipick .ic { color: var(--accent); font-size: 12px; flex-shrink: 0; }
.od-aipick .tx { min-width: 0; }
.od-aipick .tx b { color: var(--accent); }
.od-aipick .sp { flex: 1; }
.od-aipick .pk {
  flex-shrink: 0; cursor: pointer; font-family: inherit; font-size: 11px;
  padding: 3px 9px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  background: var(--bg-input); color: var(--accent);
}
.od-aipick .pk:hover { border-color: var(--accent); }
.od-aipick .pk.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.od-aipick .pk.ghost { color: var(--text-dim); border-color: var(--border); background: none; }
.od-aipick .pk.ghost:hover { color: var(--text); border-color: var(--border-strong); }

/* 勾选态下内容区整块可点：给出手型与虚线边框，让「点哪都能勾」看得出来 */
:global(body.ai-picking) .od-pane { cursor: pointer; padding-bottom: 104px; }
:global(body.ai-picking) .od-pane:hover { outline: 1px dashed color-mix(in srgb, var(--accent) 40%, transparent); outline-offset: -7px; }
:global(body.ai-picking) .od-pane * { cursor: inherit; }
</style>
