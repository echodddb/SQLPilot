<template>
  <div class="tp-pane" style="padding:0">
    <!-- 筛选条 -->
    <div class="tp-bar">
      <select class="tp-select" :value="r.level" @change="onLevel">
        <option :value="0">全部等级</option>
        <option :value="1">严重</option>
        <option :value="2">警告</option>
        <option :value="3">注意</option>
      </select>
      <select class="tp-select" :value="r.scope" @change="onScope">
        <option value="">全部对象类型</option>
        <option v-for="s in SCOPES" :key="s" :value="s">{{ alarmScope(s) }}</option>
      </select>
      <select class="tp-select" :value="String(r.enabled)" @change="onEnabled">
        <option value="">全部状态</option>
        <option value="true">仅启用</option>
        <option value="false">仅停用</option>
      </select>
      <input
        :value="r.keyword"
        class="tp-input tp-search"
        placeholder="关键词：规则名 / 指标名，回车搜索"
        spellcheck="false"
        @input="kwDraft = ($event.target as HTMLInputElement).value"
        @keyup.enter="applyKeyword"
      />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="cloud.loading" @click="reload">刷新</button>
    </div>

    <div
      class="tp-tbl-wrap tp-scroll-y"
      data-src="alarmRules"
      :data-detail="`告警规则 ${r.total} 条|筛选：${levelLabel} · ${r.scope ? alarmScope(r.scope) : '全部对象'} · ${enabledLabel}${r.keyword ? ' · 关键词 ' + r.keyword : ''}`"
    >
      <table class="tp-tbl">
        <thead>
          <tr>
            <th>规则名称</th><th>对象类型</th><th>等级</th><th>检测表达式</th>
            <th class="r">评估间隔</th><th class="r">持续</th><th class="r">恢复超时</th>
            <th>状态</th><th>来源</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in r.items" :key="rule.id" class="clickable" @click="open(rule)">
            <td>
              <div class="rl-name">{{ rule.name }}</div>
              <div class="rl-sub mono">{{ rule.alarmType }}<template v-if="rule.groups.length"> · {{ rule.groups.join(' / ') }}</template></div>
            </td>
            <td class="tp-dim">{{ alarmScope(rule.scope) }}</td>
            <td><span class="lv" :class="alarmLevel(rule.level).tone">{{ alarmLevel(rule.level).label }}</span></td>
            <td class="rl-expr mono" :title="rule.detects.map(d => d.expression).join('\n')">
              {{ rule.detects[0]?.expression || '—' }}
              <span v-if="rule.detects.length > 1" class="rl-more">+{{ rule.detects.length - 1 }}</span>
            </td>
            <td class="r tp-mono tp-dim">{{ sec(rule.evaluationIntervalSeconds) }}</td>
            <td class="r tp-mono tp-dim">{{ sec(rule.detects[0]?.durationSeconds) }}</td>
            <td class="r tp-mono tp-dim">{{ sec(rule.resolveTimeoutSeconds) }}</td>
            <td><span class="tp-chip" :class="rule.isEnabled ? 'ok' : 'idle'">{{ rule.isEnabled ? '启用' : '停用' }}</span></td>
            <td class="tp-dim">{{ rule.isBuildIn ? '内置' : (rule.createdBy || '自定义') }}</td>
            <td @click.stop><button class="tp-btn sm" @click="open(rule)">详情</button></td>
          </tr>
          <tr v-if="!r.items.length">
            <td colspan="10" class="tp-empty">{{ cloud.loading ? '读取中…' : '当前筛选下没有告警规则' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="tp-note">共 {{ r.total }} 条 · 每页 {{ r.size }}</span>
      <span class="sp"></span>
      <button class="tp-btn sm" :disabled="r.page <= 1 || cloud.loading" @click="setAlarmRulePage(r.page - 1)">上一页</button>
      <span class="tp-mono tp-dim" style="font-size:11px">{{ r.page }} / {{ maxPage }}</span>
      <button class="tp-btn sm" :disabled="r.page >= maxPage || cloud.loading" @click="setAlarmRulePage(r.page + 1)">下一页</button>
    </div>

    <!-- 规则详情 -->
    <div v-if="detail" class="rl-mask" @click.self="detail = null">
      <aside class="rl-drawer" @click.stop>
        <header class="rd-head">
          <div>
            <div class="rd-title">
              <span class="lv" :class="alarmLevel(detail.level).tone">{{ alarmLevel(detail.level).label }}</span>
              <b>{{ detail.name }}</b>
              <span class="tp-chip" :class="detail.isEnabled ? 'ok' : 'idle'">{{ detail.isEnabled ? '启用中' : '已停用' }}</span>
            </div>
            <div class="rd-sub mono">{{ detail.alarmType }} · 规则 #{{ detail.id }}</div>
          </div>
          <button class="x" @click="detail = null">✕</button>
        </header>
        <div class="rd-body">
          <div class="tp-kv-grid">
            <div class="tp-kv"><span>对象类型</span><b>{{ alarmScope(detail.scope) }}</b></div>
            <div class="tp-kv"><span>应用</span><b>{{ detail.appType || '—' }}</b></div>
            <div class="tp-kv"><span>评估间隔</span><b>{{ sec(detail.evaluationIntervalSeconds) }}</b></div>
            <div class="tp-kv"><span>恢复超时</span><b>{{ sec(detail.resolveTimeoutSeconds) }}</b></div>
            <div class="tp-kv"><span>自动恢复</span><b>{{ detail.autoResolved ? '是' : '否' }}</b></div>
            <div class="tp-kv"><span>创建者</span><b>{{ detail.isBuildIn ? `${detail.createdBy || 'system'}（内置）` : detail.createdBy || '—' }}</b></div>
          </div>

          <h4 class="tp-h">检测规则 <span class="cnt">{{ detail.detects.length }}</span></h4>
          <div class="tp-tbl-wrap">
            <table class="tp-tbl">
              <thead><tr><th>指标</th><th>表达式</th><th>等级</th><th class="r">持续</th><th class="r">间隔</th></tr></thead>
              <tbody>
                <tr v-for="d in detail.detects" :key="d.id">
                  <td class="tp-mono">{{ d.metric }}</td>
                  <td class="tp-mono tp-dim">{{ d.expression || '—' }}</td>
                  <td><span class="lv" :class="alarmLevel(d.level).tone">{{ alarmLevel(d.level).label }}</span></td>
                  <td class="r tp-mono tp-dim">{{ sec(d.durationSeconds) }}</td>
                  <td class="r tp-mono tp-dim">{{ sec(d.evaluationIntervalSeconds, d.evaluationIntervalSeconds ? '' : '—') }}</td>
                </tr>
                <tr v-if="!detail.detects.length"><td colspan="5" class="tp-empty">该规则没有检测项</td></tr>
              </tbody>
            </table>
          </div>

          <h4 class="tp-h">生效对象</h4>
          <div class="rd-targets">
            <span v-for="(t, i) in detail.targets" :key="i" class="tp-chip">
              {{ t.appType || '全部应用' }} · {{ alarmScope(t.scope) }}
              <template v-if="t.includeCount"> · 指定 {{ t.includeCount }} 个</template>
              <template v-else> · 全部</template>
              <template v-if="t.excludeCount"> · 排除 {{ t.excludeCount }}</template>
            </span>
            <span v-if="!detail.targets.length" class="tp-note">规则未限制对象（作用于全部同类对象）</span>
          </div>

          <h4 class="tp-h">告警文本模板</h4>
          <div class="tp-code rd-tpl">{{ detail.descriptionTemplate || '—' }}</div>
          <div class="tp-code rd-tpl">{{ detail.summaryTemplate || '—' }}</div>

          <template v-if="detail.targetLabels.length">
            <h4 class="tp-h">标签维度</h4>
            <div class="rd-targets">
              <span v-for="l in detail.targetLabels" :key="l" class="tp-chip mono">{{ l }}</span>
            </div>
          </template>

          <div class="tp-note">
            规则只读展示：OCP 的规则新建 / 启停 / 阈值调整属于写操作，SqlPilot 暂未开放（避免误改生产告警）。
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 告警规则（只读）：GET /api/v2/alarm/rules。
 * 服务端支持 level / scope / keyword / isEnabled，规则名搜索走 keyword（name 无效，实测）。
 */
import { computed, ref } from 'vue'
import { cloud, loadAlarmRules, setAlarmRuleFilter, setAlarmRulePage } from '../../../cloud/state'
import { alarmLevel, alarmScope } from '../../../cloud/parts'

const SCOPES = ['Host', 'Cluster', 'Tenant', 'Service', 'OBProxyCluster', 'OCP']
const r = computed(() => cloud.alarmRules)
const maxPage = computed(() => Math.max(1, Math.ceil(r.value.total / Math.max(1, r.value.size))))
const kwDraft = ref(r.value.keyword)
const detail = ref<CloudAlarmRule | null>(null)

const levelLabel = computed(() => (r.value.level ? alarmLevel(r.value.level).label : '全部等级'))
const enabledLabel = computed(() => (r.value.enabled === '' ? '全部状态' : r.value.enabled ? '启用' : '停用'))

/** 秒数 → 「30 秒 / 5 分 / 1 小时」 */
function sec(v?: number, empty = '—'): string {
  const n = Number(v)
  if (!n) return empty
  if (n < 60) return `${n} 秒`
  if (n < 3600) return `${Math.round(n / 60)} 分`
  if (n % 3600 === 0) return `${n / 3600} 小时`
  return `${(n / 3600).toFixed(1)} 小时`
}

function onLevel(e: Event): void {
  void setAlarmRuleFilter({ level: Number((e.target as HTMLSelectElement).value) || 0 })
}
function onScope(e: Event): void {
  void setAlarmRuleFilter({ scope: (e.target as HTMLSelectElement).value })
}
function onEnabled(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  void setAlarmRuleFilter({ enabled: v === '' ? '' : v === 'true' })
}
function applyKeyword(): void {
  void setAlarmRuleFilter({ keyword: kwDraft.value })
}
function reload(): void {
  void loadAlarmRules()
}
function open(rule: CloudAlarmRule): void {
  detail.value = rule
}
</script>

<style scoped>
.rl-name { font-size: 12.5px; font-weight: 550; }
.rl-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
.rl-expr { font-size: 10.5px; color: var(--text-dim); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rl-more { color: var(--accent); margin-left: 4px; }
.pager { display: flex; align-items: center; gap: 7px; }
.pager .sp { flex: 1; }
.lv { font-size: 10.5px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--border); }
.lv.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); background: var(--red-dim); }
.lv.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); background: var(--yellow-dim); }
.lv.info { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.lv.idle { color: var(--text-dim); }

.rl-mask { position: fixed; inset: 0; z-index: 300; background: rgba(6, 8, 14, 0.42); display: flex; justify-content: flex-end; padding-top: var(--titlebar-h); }
.rl-drawer {
  width: 620px; max-width: 96vw; height: 100%; background: var(--bg-card); border-left: 1px solid var(--border-strong);
  display: flex; flex-direction: column;
}
.rd-head { display: flex; align-items: flex-start; gap: 10px; padding: 13px 16px 11px; border-bottom: 1px solid var(--border); }
.rd-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rd-title b { font-size: 14px; }
.rd-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 5px; }
.rd-head .x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.rd-head .x:hover { color: var(--red); border-color: var(--red); }
.rd-body { flex: 1; overflow-y: auto; padding: 12px 16px 22px; display: flex; flex-direction: column; gap: 9px; }
.rd-body > * { flex: none; }
.rd-targets { display: flex; flex-wrap: wrap; gap: 6px; }
.rd-tpl { font-size: 10.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
</style>
