<template>
  <div class="imask" @click.self="closeInspectionReport">
    <aside class="ireport">
      <header class="rh">
        <div class="rh-id">
          <div class="rh-title">
            <b>{{ r?.object.name || '巡检报告' }}</b>
            <span class="tp-chip idle">{{ typeLabel(r?.object.type || '') }}</span>
            <span v-if="r?.tag" class="tp-chip info">{{ r.tag }}</span>
            <span class="tp-chip" :class="tone">{{ stateLabel(r?.state || '') }}</span>
          </div>
          <div class="rh-sub tp-mono">
            报告 #{{ r?.id || '—' }} · 任务 {{ r?.taskId || '—' }} ·
            {{ r?.startTime ? fmtTime(r.startTime) : '—' }} → {{ r?.endTime ? fmtTime(r.endTime) : '—' }}
          </div>
        </div>
        <button class="x" title="关闭" @click="closeInspectionReport">✕</button>
      </header>

      <div v-if="s.reportLoading" class="rw"><span class="spin"></span>正在读取报告明细…</div>
      <div v-else-if="s.error" class="rw err">{{ s.error }}</div>

      <div v-else-if="r" class="rbody">
        <div class="risk">
          <div class="rc static">
            <span class="rl">高风险</span><b class="bad">{{ r.risk.high }}</b>
          </div>
          <div class="rc static">
            <span class="rl">中风险</span><b class="warn">{{ r.risk.medium }}</b>
          </div>
          <div class="rc static">
            <span class="rl">低风险</span><b>{{ r.risk.low }}</b>
          </div>
          <div class="rc static">
            <span class="rl">巡检项完成</span><b>{{ r.itemFinished }}/{{ r.itemTotal }}</b>
          </div>
          <div class="rc static">
            <span class="rl">耗时</span><b class="mono">{{ duration(r.startTime, r.endTime) }}</b>
          </div>
        </div>

        <div class="tp-bar">
          <div class="tp-h">巡检明细 <span class="cnt">{{ items.length }}</span></div>
          <span class="sp"></span>
          <button class="tp-btn sm" :class="{ primary: s.riskFilter === 'abnormal' }" @click="toggleAbnormal">
            {{ s.riskFilter === 'abnormal' ? '看全部结果' : `只看异常（${abnormalCount}）` }}
          </button>
          <span class="tp-faint hint">异常项排在最前</span>
        </div>

        <div class="tp-tbl-wrap scroll">
          <table class="tp-tbl fixed">
            <thead>
              <tr><th>巡检项</th><th>检查对象</th><th>结果</th><th>原始值</th><th>判定</th></tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in items" :key="`${it.itemId}-${i}`">
                <td>
                  <div class="cell-main">{{ it.name || `巡检项 ${it.itemId}` }}</div>
                  <div class="cell-sub ell" :title="it.description">{{ it.description || it.targetType || '—' }}</div>
                </td>
                <td class="tp-mono tp-dim">{{ it.target || '—' }}</td>
                <td class="tp-mono res">{{ it.value || '—' }}</td>
                <td class="tp-mono tp-faint raw" :title="it.rawValue">{{ it.rawValue || '—' }}</td>
                <td>
                  <span v-if="it.value && it.value !== '—'" class="tp-chip" :class="it.abnormal ? 'bad' : 'ok'">
                    {{ it.abnormal ? '异常' : '正常' }}
                  </span>
                  <span v-else class="tp-dim">—</span>
                </td>
              </tr>
              <tr v-if="!items.length">
                <td colspan="5" class="tp-empty">{{ s.riskFilter ? '没有明显异常的结果' : '报告里没有明细项' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * 巡检报告抽屉：风险统计（可点击过滤）+ 巡检明细。
 * 明细来自 inspection/report/{reportId} 的 reportItems，名称/说明/风险等级来自同响应的 inspectionItems。
 */
import { computed } from 'vue'
import { cloud, closeInspectionReport, inspectionItems, setInspectionRiskFilter } from '../../cloud/state'
import { duration, fmtTime } from '../../cloud/parts'

const s = cloud.inspection
const r = computed(() => s.report)
const items = computed(() => inspectionItems())
const abnormalCount = computed(() => (r.value?.items || []).filter((x) => x.abnormal).length)
const tone = computed(() => (r.value?.state === 'SUCCESSFUL' ? 'ok' : r.value?.state === 'FAILED' ? 'bad' : 'info'))

function typeLabel(t: string): string {
  if (t === 'OB_CLUSTER') return '集群'
  if (t === 'OB_TENANT') return '租户'
  if (t === 'OB_PROXY') return 'OBProxy'
  return t || '—'
}
function stateLabel(v: string): string {
  if (v === 'SUCCESSFUL') return '已完成'
  if (v === 'RUNNING' || v === 'EXECUTING') return '执行中'
  if (v === 'FAILED') return '失败'
  return v || '—'
}
function toggleAbnormal(): void {
  setInspectionRiskFilter(s.riskFilter === 'abnormal' ? '' : 'abnormal')
}
</script>

<style scoped>
.imask { position: fixed; inset: 0; z-index: 830; background: rgba(0, 0, 0, 0.45); display: flex; justify-content: flex-end; backdrop-filter: blur(1px); }
.ireport {
  width: 980px; max-width: 96vw; height: 100%; display: flex; flex-direction: column;
  background: var(--bg-side); border-left: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
}
.rh { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.rh-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.rh-title b { font-size: 14px; }
.rh-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 3px; }
.x {
  margin-left: auto; width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-family: inherit; flex-shrink: 0;
}
.x:hover { color: var(--red); border-color: var(--red); }
.rw { display: flex; align-items: center; gap: 8px; padding: 22px; color: var(--text-dim); font-size: 12px; }
.rw.err { color: var(--red); }
.spin { width: 12px; height: 12px; border: 2px solid var(--accent-dim); border-top-color: var(--accent); border-radius: 50%; animation: rot 0.8s linear infinite; }
@keyframes rot { to { transform: rotate(360deg); } }
.rbody { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 18px; }
.risk { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.rc {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start; padding: 8px 10px; border-radius: 9px;
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text); font-family: inherit; cursor: pointer; text-align: left;
}
.rc.static { cursor: default; }
.rc:hover:not(.static) { border-color: var(--accent); }
.rc.on { border-color: var(--accent); background: var(--accent-dim); }
.rl { font-size: 9.5px; color: var(--text-faint); }
.rc b { font-family: var(--mono); font-size: 16px; font-weight: 650; }
.rc b.bad { color: var(--red); }
.rc b.warn { color: var(--yellow); }
.rc b.mono { font-size: 12px; }
.tp-bar { padding: 0; }
.hint { font-size: 9.5px; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; }
.cell-main { font-size: 11.5px; }
.cell-sub { font-size: 9.5px; color: var(--text-faint); margin-top: 1px; }
.ell { max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.res { max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.raw { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 列多，用固定布局保证「判定」列不被挤出抽屉 */
.fixed { table-layout: fixed; width: 100%; }
.fixed th:nth-child(1) { width: 32%; }
.fixed th:nth-child(2) { width: 18%; }
.fixed th:nth-child(3) { width: 24%; }
.fixed th:nth-child(4) { width: 14%; }
.fixed th:nth-child(5) { width: 12%; }
.fixed td { overflow: hidden; text-overflow: ellipsis; }
</style>
