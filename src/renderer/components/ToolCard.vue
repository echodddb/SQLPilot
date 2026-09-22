<template>
  <div class="tool-card" :class="tool.status">
    <div class="tool-head" @click="expanded = !expanded">
      <span class="arrow">{{ expanded ? '▾' : '▸' }}</span>
      <span class="tool-icon">{{ ICONS[tool.name] || '🔧' }}</span>
      <span class="badge" :class="tool.name === 'db_write' ? 'red' : 'blue'">{{ tool.name }}</span>
      <span class="tool-sql">{{ summary }}</span>
      <span v-if="tool.status === 'running'" class="spinner"></span>
      <span v-else-if="tool.sub?.status === 'stopped'" style="color: var(--text-dim); font-size:12px">⏹ {{ tool.sub.summary || '已停止' }}</span>
      <span v-else-if="bgStatus === 'async_launched'" style="color: var(--text-dim); font-size:12px">⏏ 已转后台</span>
      <span v-else-if="bgStatus === 'auto_backgrounded'" style="color: var(--text-dim); font-size:12px">⏱ 超时转后台</span>
      <span v-else-if="tool.status === 'ok'" style="color: var(--green); font-size:12px">✓ {{ resultMeta }}</span>
      <span v-else style="color: var(--red); font-size:12px">✗ 失败</span>
    </div>
    <div class="tool-body" v-if="expanded">
      <!-- 子代理卡片：参数 → 实时活动流水 → 最终报告 / 后台信息 -->
      <template v-if="tool.name === 'agent_spawn'">
        <div style="font-size:11.5px; color:var(--text-dim); margin-bottom:6px">任务书</div>
        <pre>{{ spawnPrompt }}</pre>
        <template v-if="bgStatus">
          <div style="font-size:11.5px; color:var(--text-dim); margin:8px 0 6px">后台执行</div>
          <div style="font-size:12px; line-height:1.7; color:var(--text)">
            {{ parsed?.note }}<br />
            任务 id：<code>{{ parsed?.runId }}</code>
          </div>
        </template>
        <template v-else>
          <template v-if="tool.sub?.activity?.length">
            <div style="font-size:11.5px; color:var(--text-dim); margin:8px 0 6px">执行过程
              <span v-if="tool.sub.status === 'running'" class="spinner" style="display:inline-block;vertical-align:-2px;margin-left:4px"></span>
            </div>
            <div class="sub-activity">
              <div v-for="(line, i) in tool.sub.activity" :key="i" :class="{ 'sub-err': line.startsWith('✗') }">{{ line }}</div>
            </div>
          </template>
          <template v-if="parsed?.report != null">
            <div style="font-size:11.5px; color:var(--text-dim); margin:8px 0 6px">
              最终报告
              <span v-if="parsed.status && parsed.status !== 'completed'" style="color:var(--red)">（{{ SUB_STATUS[parsed.status] || parsed.status }}）</span>
            </div>
            <pre class="sub-report">{{ parsed.report }}</pre>
          </template>
        </template>
        <div style="margin-top:8px">
          <button class="btn ghost" style="font-size:11.5px; padding:2px 10px" @click.stop="viewRun">🔍 查看完整过程（含每步 SQL）</button>
        </div>
      </template>
      <template v-else>
        <div style="font-size:11.5px; color:var(--text-dim); margin-bottom:6px">参数</div>
        <pre>{{ prettyArgs }}</pre>
        <template v-if="tool.result">
          <div style="font-size:11.5px; color:var(--text-dim); margin:8px 0 6px">结果</div>
          <div v-if="resultTable" style="max-height:300px; overflow:auto">
            <table class="result-table">
              <thead><tr><th v-for="c in resultTable.columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, i) in resultTable.rows" :key="i">
                  <td v-for="(cell, j) in row" :key="j" :title="String(cell)">{{ cell === null ? '∅' : String(cell) }}</td>
                </tr>
              </tbody>
            </table>
            <div style="font-size:11px;color:var(--text-dim);margin-top:4px" v-if="resultTable.note">{{ resultTable.note }}</div>
          </div>
          <pre v-else>{{ tool.result }}</pre>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { openSubRun } from '../store'

const props = defineProps<{ tool: any }>()
const expanded = ref(false)

const ICONS: Record<string, string> = {
  db_list_schemas: '📂',
  db_list_tables: '🗂',
  db_describe_table: '🧬',
  db_get_ddl: '📄',
  db_query: '🔍',
  db_write: '✏️',
  agent_spawn: '🤖'
}

const SUB_STATUS: Record<string, string> = {
  completed: '已完成',
  stopped: '被中止',
  failed: '失败',
  exhausted: '达到迭代上限'
}

// 必须是 computed：结果在 tool-end 才到达，setup 时一次性解析会永远停留在空值
const parsed = computed<any>(() => {
  try { return JSON.parse(props.tool.result || 'null') } catch { return null }
})

const argsObj = computed<any>(() => {
  try { return JSON.parse(props.tool.args || '{}') } catch { return {} }
})

/** 后台化状态（agent_spawn 专属） */
const bgStatus = computed(() => {
  if (props.tool.name !== 'agent_spawn') return ''
  const st = parsed.value?.status
  return st === 'async_launched' || st === 'auto_backgrounded' ? st : ''
})

const summary = computed(() => {
  const a = argsObj.value
  if (props.tool.name === 'agent_spawn') {
    const sub = props.tool.sub
    return `${a.agent_type || sub?.agentType || parsed.value?.agentType || '?'} · ${a.description || sub?.description || parsed.value?.description || ''}`
  }
  if (a.sql) return String(a.sql).replace(/\s+/g, ' ').slice(0, 160)
  if (a.schema && a.table) return `${a.schema}.${a.table}`
  if (a.schema) return `schema: ${a.schema}`
  return props.tool.name
})

const spawnPrompt = computed(() => String(argsObj.value.prompt ?? ''))

const prettyArgs = computed(() => {
  try { return JSON.stringify(JSON.parse(props.tool.args || '{}'), null, 2) } catch { return props.tool.args }
})

function viewRun(): void {
  const runId = props.tool.toolCallId || parsed.value?.runId
  if (runId) openSubRun(String(runId), summary.value)
}

const resultTable = computed(() => {
  if (parsed.value && Array.isArray(parsed.value.columns) && Array.isArray(parsed.value.rows)) {
    return {
      columns: parsed.value.columns,
      rows: parsed.value.rows.slice(0, 12),
      note: parsed.value.rowCount != null ? `共 ${parsed.value.rowCount} 行，耗时 ${parsed.value.ms}ms${parsed.value.truncated ? '（已截断）' : ''}` : ''
    }
  }
  return null
})

const resultMeta = computed(() => {
  const p = parsed.value
  if (props.tool.name === 'agent_spawn') {
    if (p?.toolCalls != null) return `${p.iterations} 轮 · ${p.toolCalls} 工具 · ${Math.round((p.durationMs || 0) / 1000)}s`
    return props.tool.sub?.summary || ''
  }
  if (p?.rowCount != null) return `${p.rowCount} 行 · ${p.ms}ms`
  if (p?.affected != null) return `影响 ${p.affected} 行 · ${p.ms}ms`
  if (p?.total != null) return `${p.total} 项`
  if (p?.schemas) return `${p.schemas.length} schema`
  return ''
})
</script>

<style scoped>
.sub-activity {
  max-height: 180px;
  overflow: auto;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-dim);
  border-left: 2px solid var(--border);
  padding-left: 8px;
}
.sub-activity .sub-err {
  color: var(--red);
}
.sub-report {
  white-space: pre-wrap;
  max-height: 320px;
  overflow: auto;
}
</style>
