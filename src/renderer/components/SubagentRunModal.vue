<template>
  <div class="modal-mask" @click.self="close">
    <div class="modal" style="width:860px; height:80vh; display:flex; flex-direction:column">
      <h3 style="margin:0 0 8px">子代理完整过程 <span style="font-size:12px; color:var(--text-dim); font-weight:normal">{{ title }}</span></h3>

      <div style="flex:1; overflow:auto; border:1px solid var(--border); border-radius:6px; padding:8px; font-size:12px">
        <div v-if="!entries.length" style="color:var(--text-dim); padding:20px; text-align:center">
          {{ loading ? '读取中…' : '暂无记录（任务可能尚未开始，或应用重启后审计文件归属旧实例）' }}
        </div>
        <div v-for="(e, i) in entries" :key="i" class="run-entry" :class="e.t">
          <div class="run-head" @click="toggle(i)">
            <span class="arrow">{{ openSet.has(i) ? '▾' : '▸' }}</span>
            <span v-if="e.t === 'start'" class="tag start">启动</span>
            <span v-else-if="e.t === 'tool'" class="tag" :class="e.ok ? 'ok' : 'err'">{{ e.ok ? '✓' : '✗' }} {{ e.tool }}</span>
            <span v-else-if="e.t === 'end'" class="tag end">结束</span>
            <span v-else class="tag">{{ e.t }}</span>
            <span class="run-meta">
              <template v-if="e.t === 'start'">{{ e.agentType }} · {{ e.description }} · 模式 {{ e.mode }}</template>
              <template v-else-if="e.t === 'tool'">第 {{ e.iter }} 轮 · {{ e.ms }}ms</template>
              <template v-else-if="e.t === 'end'">{{ e.status }} · {{ e.iterations }} 轮 · {{ e.toolCalls }} 次工具 · {{ Math.round((e.durationMs || 0) / 1000) }}s</template>
            </span>
            <span class="run-ts">{{ (e.ts || '').slice(11, 19) }}</span>
          </div>
          <div v-if="openSet.has(i)" class="run-body">
            <pre v-if="e.t === 'start'">{{ e.prompt }}</pre>
            <template v-else-if="e.t === 'tool'">
              <div class="lbl">参数</div>
              <pre>{{ e.args }}</pre>
              <div class="lbl">结果（截断至 2000 字符）</div>
              <pre>{{ e.resultHead }}</pre>
            </template>
            <pre v-else-if="e.t === 'end' && e.reportHead">{{ e.reportHead }}</pre>
          </div>
        </div>
      </div>

      <div style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:11px; color:var(--text-faint)">
        <label style="display:flex; align-items:center; gap:4px; cursor:pointer">
          <input type="checkbox" v-model="autoRefresh" /> 每 3 秒自动刷新（任务运行中）
        </label>
        <span style="flex:1"></span>
        <span :title="file">{{ file ? file.split(/[\\/]/).pop() : '' }}</span>
        <button class="btn" @click="load">⟳ 刷新</button>
        <button class="btn primary" @click="close">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { closeSubRun } from '../store'

const props = defineProps<{ runId: string; title: string }>()

const entries = ref<any[]>([])
const file = ref('')
const loading = ref(false)
const autoRefresh = ref(true)
const openSet = reactive(new Set<number>())
const expandedDefault = new Set<number>()

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await window.sqlpilot.subagentAudit(props.runId)
    if (r.ok) {
      entries.value = r.entries || []
      file.value = r.file || ''
      // 新条目默认展开 end 行；工具行保持折叠
      entries.value.forEach((e, i) => {
        if (e.t === 'end' && !expandedDefault.has(i)) {
          expandedDefault.add(i)
          openSet.add(i)
        }
      })
    }
  } finally {
    loading.value = false
  }
}

function toggle(i: number): void {
  openSet.has(i) ? openSet.delete(i) : openSet.add(i)
}

function close(): void {
  closeSubRun()
}

let timer: any = null
onMounted(() => {
  load()
  timer = setInterval(() => { if (autoRefresh.value) load() }, 3000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.run-entry { border-bottom: 1px solid var(--border); padding: 2px 0; }
.run-head { display: flex; align-items: center; gap: 6px; padding: 3px 4px; cursor: pointer; }
.run-head:hover { background: var(--bg-hover, rgba(128,128,128,.08)); }
.run-meta { color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-ts { color: var(--text-faint); font-size: 11px; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 3px; background: var(--border); }
.tag.start { background: #2b6cb0; color: #fff; }
.tag.end { background: #2f855a; color: #fff; }
.tag.ok { background: #2f855a; color: #fff; }
.tag.err { background: #c53030; color: #fff; }
.run-body { padding: 2px 8px 8px 22px; }
.run-body pre { margin: 4px 0; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; background: var(--bg2, rgba(0,0,0,.15)); padding: 6px; border-radius: 4px; }
.lbl { color: var(--text-dim); font-size: 11px; margin-top: 4px; }
</style>
