<template>
  <div class="oc-wrap">
    <div class="env-bar">
      <div class="env-tabs">
        <b>已接入环境</b>
        <span class="cnt">{{ ora.envs.length }}</span>
        <span v-if="oraAi.picking" class="oc-note" style="color: var(--accent)">
          勾选模式：点卡片 = 把「该环境概要」加入 AI 读取范围（再点取消）；进库详情还可以按 tab 勾
        </span>
        <span v-else class="oc-note">
          {{ okCount }} 套可连 · 点卡片进入该库的详情（总览 / RAC / 存储 / 会话 / SQL / 备份 …）
        </span>
      </div>
      <span class="sp"></span>
      <span v-if="ora.envsAt" class="oc-meta">{{ relTime(new Date(ora.envsAt).toISOString()) }} 更新</span>
    </div>

    <div v-if="!ora.envs.length" class="oc-empty">
      <b style="font-size: 13px">还没有接入 Oracle 环境</b>
      <p>每个环境就是一条数据库连接（主机 / 端口 / 服务名）。接入后这里会并排显示所有环境的实时状态，点进去是单个库的详情。</p>
      <button class="oc-btn primary" @click="cloud.settingsOpen = true">＋ 接入第一个环境</button>
    </div>

    <div v-else class="env-grid">
      <button
        v-for="e in ora.envs"
        :key="e.id"
        class="env-card"
        :class="{ bad: !!e.error, loading: e.loading, picking: oraAi.picking, picked: aiPicked(e.id) }"
        data-src="orEnv"
        :data-env="e.id"
        :data-cluster="e.name"
        :title="oraAi.picking ? `点一下${aiPicked(e.id) ? '取消勾选' : '把「' + e.name + ' · 环境概要」加入 AI 读取范围'}` : (e.error || '')"
        @click="enter(e)"
      >
        <div class="env-head">
          <span class="env-logo">ORA</span>
          <div class="env-title">
            <b>{{ e.name }}</b>
            <span class="mono">{{ e.host }}:{{ e.port }}{{ e.serviceName ? '/' + e.serviceName : '' }}</span>
          </div>
          <span v-if="oraAi.picking" class="ai-ck" :class="{ on: aiPicked(e.id) }" aria-hidden="true">✓</span>
          <span v-if="e.loading" class="env-state">探测中…</span>
          <span v-else-if="e.error" class="env-state bad">连接失败</span>
          <span v-else class="env-state ok">{{ e.summary?.openMode || '正常' }}</span>
        </div>

        <div v-if="e.error" class="env-err">{{ e.error }}</div>

        <template v-else-if="e.summary">
          <div class="env-ver" :title="e.summary.version">{{ shortVer(e.summary.version) }}</div>
          <div class="env-tags">
            <span class="tag">{{ e.summary.databaseRole }}</span>
            <span class="tag">{{ e.summary.isRac ? 'RAC' : '单实例' }}</span>
            <span v-if="e.summary.isCdb" class="tag">CDB</span>
            <span class="tag">{{ e.summary.logMode }}</span>
            <span v-if="(e.role || 'default') !== 'default'" class="tag warn">{{ (e.role || '').toUpperCase() }}</span>
          </div>
          <div class="env-kv">
            <span><i>实例</i><b>{{ e.summary.instancesOpen }}/{{ e.summary.instances }}</b></span>
            <span><i>会话</i><b>{{ e.summary.sessions }}<em v-if="e.summary.activeSessions"> 活 {{ e.summary.activeSessions }}</em></b></span>
            <span><i>阻塞</i><b :class="{ red: e.summary.blocking > 0 }">{{ e.summary.blocking }}</b></span>
          </div>
          <div v-if="e.summary.tsWorst" class="env-ts">
            <span class="oc-note">最高水位 {{ e.summary.tsWorst.name }}</span>
            <i class="bar"><b :class="tsTone(e.summary.tsWorst.usedPct)" :style="{ width: Math.min(100, e.summary.tsWorst.usedPct) + '%' }"></b></i>
            <em>{{ e.summary.tsWorst.usedPct.toFixed(1) }}%</em>
          </div>
          <div class="env-foot">
            <span class="oc-note">启动 {{ e.summary.startupTime || '—' }}</span>
            <span v-if="e.summary.invalid" class="mini-tag warn">{{ e.summary.invalid }} 个失效对象</span>
            <span v-if="e.summary.longops" class="mini-tag">{{ e.summary.longops }} 个长操作</span>
            <span class="sp"></span>
            <span class="env-go">进入 →</span>
          </div>
        </template>

        <div v-else class="env-note">还没取到数据</div>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** Oracle 环境列表：多套环境并排显示概要，点一张卡进入该环境的完整看板 */
import { computed, onMounted } from 'vue'
import { cloud } from '../../../cloud/state'
import { ora, loadEnvs, openDrawer, type OraEnvItem } from '../../../cloud/oracle'
import { oraAi, oraAiKey, toggleOraDraft } from '../../../cloud/oraAi'
import { relTime } from '../../../cloud/parts'

const okCount = computed(() => ora.envs.filter((e) => !e.error && e.summary).length)

onMounted(() => { void loadEnvs() })

/** 勾选态下点卡片 = 勾「这套环境的环境概要」，不打开详情 */
function enter(e: OraEnvItem): void {
  if (oraAi.picking) {
    toggleOraDraft(oraAiKey(e.id, 'summary'))
    return
  }
  if (e.loading) return
  void openDrawer(e.id)
}

const aiPicked = (id: string): boolean => oraAi.draft.includes(oraAiKey(id, 'summary'))

function shortVer(v: string): string {
  // "Oracle Database 11g Enterprise Edition Release 11.2.0.4.0 - 64bit Production" → "11g EE 11.2.0.4.0"
  const m = /Oracle Database (\S+).*?(Enterprise|Standard) Edition.*?(\d+\.\d+\.\d+\.\d+\.\d+)/i.exec(v || '')
  if (m) return `${m[1]} ${m[2] === 'Enterprise' ? 'EE' : 'SE'} ${m[3]}`
  return (v || 'Oracle').replace('Oracle Database ', '').slice(0, 46)
}

function tsTone(pct: number): string {
  return pct >= 90 ? 'bad' : pct >= 85 ? 'warn' : ''
}
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
.env-bar { display: flex; align-items: center; gap: 8px; }
.env-bar .sp { flex: 1; }
.env-tabs { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.env-tabs b { font-size: 12.5px; }
.env-tabs .cnt {
  font-family: var(--mono); font-size: 10px; color: var(--text-dim); background: var(--bg-input);
  border: 1px solid var(--border); border-radius: 99px; padding: 0 6px;
}
.env-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 10px; }
.env-card.picking { border-style: dashed; border-color: color-mix(in srgb, var(--accent) 45%, transparent); cursor: pointer; }
.env-card.picking:hover { border-color: var(--accent); }
.env-card.picked { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent); }
/* 卡片内的勾选框（勾选态才出现，位置在状态胶囊左边，不压内容） */
.ai-ck {
  width: 16px; height: 16px; flex-shrink: 0; border-radius: 4px;
  border: 1.5px solid var(--border-strong); background: var(--bg-input);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 10px; color: transparent;
}
.ai-ck.on { border-color: var(--accent); background: var(--accent); color: #fff; }
.env-card {
  display: flex; flex-direction: column; gap: 7px; padding: 11px 12px; text-align: left;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 11px;
  font-family: inherit; color: var(--text); cursor: pointer; min-width: 0;
  transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
}
.env-card:hover { border-color: var(--accent); background: var(--bg-card-hover); transform: translateY(-1px); }
.env-card.bad { border-left: 2.5px solid var(--red); }
.env-card.loading { opacity: 0.75; }
.env-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.env-logo {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  font-size: 9.5px; font-weight: 700; background: var(--red-dim); color: var(--red); border: 1px solid var(--red);
}
.env-title { min-width: 0; flex: 1; }
.env-title b { display: block; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-title span { display: block; font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-state { font-size: 10px; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--border); color: var(--text-dim); flex-shrink: 0; }
.env-state.ok { color: var(--ok, #3fa96b); border-color: color-mix(in srgb, var(--ok, #3fa96b) 40%, transparent); }
.env-state.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.env-ver { font-size: 11px; color: var(--text-dim); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  font-size: 9.5px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border);
  color: var(--text-faint); background: var(--bg-input);
}
.tag.warn { color: var(--warn, #d9a441); border-color: color-mix(in srgb, var(--warn, #d9a441) 45%, transparent); }
.env-kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.env-kv > span { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.env-kv i { font-style: normal; font-size: 9.5px; color: var(--text-faint); }
.env-kv b { font-size: 12.5px; font-family: var(--mono); font-weight: 550; }
.env-kv b em { font-style: normal; font-size: 9.5px; color: var(--text-faint); }
.env-kv b.red { color: var(--red); }
.env-kv b.amber { color: var(--warn, #d9a441); }
.env-ts { display: flex; align-items: center; gap: 7px; }
.env-ts .bar { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-input); overflow: hidden; }
.env-ts .bar b { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.env-ts .bar b.warn { background: var(--warn, #d9a441); }
.env-ts .bar b.bad { background: var(--red); }
.env-ts em { font-style: normal; font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); }
.env-ts .oc-note { white-space: nowrap; }
.env-foot { display: flex; align-items: center; gap: 6px; }
.env-foot .sp { flex: 1; }
.env-go { font-size: 11px; color: var(--accent); }
.mini-tag { font-size: 9.5px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--border); color: var(--text-faint); white-space: nowrap; }
.mini-tag.warn { color: var(--warn, #d9a441); border-color: color-mix(in srgb, var(--warn, #d9a441) 45%, transparent); }
.env-err {
  font-size: 10.5px; line-height: 1.5; color: var(--text-dim); background: var(--red-dim);
  border: 1px solid color-mix(in srgb, var(--red) 30%, transparent); border-radius: 7px; padding: 6px 8px;
  max-height: 72px; overflow: auto; word-break: break-word;
}
.env-note { font-size: 11px; color: var(--text-faint); }
</style>
