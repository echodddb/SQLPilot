<template>
  <div class="oc-body">
    <aside class="oc-nav">
      <div v-for="g in ORA_NAV" :key="g.title" class="oc-group">
        <div class="oc-title">{{ g.title }}</div>
        <button
          v-for="v in g.items"
          :key="v.key"
          class="oc-item"
          :class="{ active: v.key !== 'settings' && ora.view === v.key }"
          :title="v.desc"
          @click="go(v.key)"
        >
          <span class="oc-ico">{{ v.icon }}</span>
          <span class="oc-label">{{ v.label }}</span>
          <span v-if="v.key === 'env' && ora.envs.length" class="oc-num">{{ ora.envs.length }}</span>
          <span v-else-if="v.key === 'fleet' && issueCount" class="oc-num bad">{{ issueCount }}</span>
        </button>
      </div>
    </aside>

    <section class="oc-main">
      <div class="oc-head">
        <div style="min-width: 0">
          <div class="oc-h1">
            {{ viewLabel }}
            <span class="oc-tail">{{ viewTail }}</span>
          </div>
          <p class="oc-sub">{{ viewDesc }}</p>
        </div>
        <div class="oc-actions">
          <span v-if="meta.at" class="oc-meta">{{ meta.ms ? `取数 ${meta.ms} ms · ` : '' }}{{ clk }}</span>
          <button class="oc-btn" :disabled="meta.loading" title="重新探测所有环境（绕过 45 秒缓存）" @click="refreshOra('env')">
            <span :class="{ spin: meta.loading }">⟳</span> 刷新全部
          </button>
          <button class="oc-btn primary" @click="cloud.settingsOpen = true">＋ 接入环境</button>
        </div>
      </div>

      <div class="oc-content">
        <div v-if="meta.error" class="oc-err">
          <span>!</span>
          <span style="flex: 1">{{ meta.error }}</span>
          <button class="oc-btn" @click="refreshOra('env')">重试</button>
        </div>

        <EnvsPane v-if="ora.view === 'env'" />
        <FleetPane v-else />
      </div>
    </section>

    <!-- 库详情：全屏抽屉，单个库/实例的 14 个深度 tab 都在里面（对齐 OCP 的租户详情） -->
    <OraDatabaseDrawer v-if="ora.drawerOpen" />
  </div>
</template>

<script setup lang="ts">
/**
 * Oracle 云平台控制台（环境级）。
 * 左侧只放跨环境的整体内容：环境列表 + 全局面板；单个库/实例的深度内容在 OraDatabaseDrawer 里。
 */
import { computed, onMounted, watch } from 'vue'
import { ORA_NAV, ora, loadEnvs, refreshOra, viewMeta, type OraView } from '../../../cloud/oracle'
import { cloud } from '../../../cloud/state'
import EnvsPane from './EnvsPane.vue'
import FleetPane from './FleetPane.vue'
import OraDatabaseDrawer from './OraDatabaseDrawer.vue'

const META: Record<string, { label: string; desc: string }> = {
  env: { label: 'Oracle 环境', desc: '已接入的所有 Oracle 环境：点卡片进入库详情（单个库/实例的深度看板）' },
  fleet: { label: '全局面板', desc: '跨环境汇总：可用性、待处理问题、表空间水位榜、会话与阻塞榜' }
}

const viewLabel = computed(() => META[ora.view]?.label || '')
const viewDesc = computed(() => META[ora.view]?.desc || '')
const viewTail = computed(() => (ora.view === 'env' ? `${ora.envs.length} 套环境` : `${goodCount.value}/${ora.envs.length} 可用`))
const meta = computed(() => viewMeta())
const clk = computed(() => (meta.value.at ? meta.value.at.slice(11, 19) : ''))
const goodCount = computed(() => ora.envs.filter((e) => e.summary && !e.error).length)

/** 左导航角标：全手段内 "high" 级问题数（连接失败 / 阻塞 / 水位≥90 / 非 READ WRITE） */
const issueCount = computed(() => {
  let n = 0
  for (const e of ora.envs) {
    if (e.error) { n++; continue }
    const s = e.summary
    if (!s) continue
    if (s.blocking > 0) n++
    if (s.tsWorst && s.tsWorst.usedPct >= 90) n++
    if (!s.openMode.includes('READ WRITE')) n++
  }
  return n
})

function go(key: OraView | 'settings'): void {
  if (key === 'settings') { cloud.settingsOpen = true; return }
  if (ora.view === key) return
  ora.view = key
}

onMounted(() => { void loadEnvs() })

// 平台清单变了（新增/删除环境）→ 同步环境列表
watch(() => cloud.platforms.length, () => { void loadEnvs() })
</script>

<style>
@import './oracle.css';
</style>
