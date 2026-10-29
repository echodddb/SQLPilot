<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal arc-modal">
      <h3>
        <span>项目归档</span>
        <span class="badge blue">{{ project }}</span>
        <span style="flex: 1"></span>
        <span class="arc-count" v-if="entries.length">{{ entries.length }} 条</span>
      </h3>
      <div class="arc-tip">
        归档会话的总结（按时间倒序；该项目下会话的提示词自动携带最近部分作为任务背景）。
        <b>恢复</b>＝原对话完整回到左侧会话列表；<b>继续</b>＝旧版归档（原会话已删）以总结为背景新开会话。
      </div>

      <div class="arc-list">
        <div v-if="loading" class="arc-hint-block">读取中…</div>
        <div v-else-if="!entries.length" class="arc-hint-block">
          该项目还没有归档。<br />
          归档入口：会话输入框「归档对话」，或左侧会话行的 <b>▤</b>。
        </div>
        <template v-else>
          <div v-for="(a, i) in entries" :key="i" class="arc-item" :class="{ open: expanded.has(i) }">
            <div class="arc-line">
              <span class="arc-ts">{{ a.ts }}</span>
              <span class="arc-title" :title="a.title">{{ a.title }}</span>
              <span v-if="a.summarizing" class="arc-flag">总结生成中…</span>
              <span v-else-if="a.legacy" class="arc-flag legacy">仅总结</span>
              <span v-if="a.messageCount" class="arc-msg">{{ a.messageCount }} 条消息</span>
              <span style="flex: 1"></span>
              <button
                class="btn ghost sm"
                :title="a.sessionId ? '恢复此会话：原对话完整保留，回到活跃列表' : '旧版归档（原会话已删）：以总结为背景新建会话'"
                :disabled="busy === i"
                @click="resume(a)"
              >↻ {{ a.sessionId ? '恢复' : '继续' }}</button>
              <button class="btn ghost sm danger" :disabled="busy === i" title="彻底删除这条归档" @click="remove(a, i)">✕</button>
            </div>
            <div class="arc-sum" @click="toggleExpand(i)">{{ a.summary || '（无摘要）' }}</div>
            <button v-if="(a.summary || '').length > 90" class="arc-more" @click="toggleExpand(i)">
              {{ expanded.has(i) ? '收起' : '展开全文' }}
            </button>
          </div>
        </template>
      </div>

      <div class="actions">
        <button v-if="entries.length" class="btn ghost danger-text" :disabled="clearing" @click="clearAll">
          {{ clearing ? '清空中…' : `清空归档（${entries.length} 条）` }}
        </button>
        <span style="flex: 1"></span>
        <button class="btn" @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, reactive, ref, watch } from 'vue'
import { restoreArchivedSession, createSessionInProject, sendMessage } from '../store'

/**
 * 项目归档弹窗。
 *
 * 此前归档是在左侧项目树里就地展开的：条目一多，项目树被撑得很长，
 * 恢复/删除按钮又挤在 12px 的窄行里，容易点错。改成弹窗后列表有独立滚动区，
 * 每个条目能完整显示摘要（折叠/展开全文），操作按钮也有足够的点击面积。
 */
interface ArchEntry {
  sessionId: string | null
  ts: string
  title: string
  summary: string
  summarizing?: boolean
  messageCount?: number
  legacy?: boolean
  raw?: string
}

const props = defineProps<{ projectId: string; project: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const entries = ref<ArchEntry[]>([])
const loading = ref(false)
const clearing = ref(false)
const busy = ref(-1)
const expanded = reactive(new Set<number>())

async function load(): Promise<void> {
  if (!props.projectId) return
  loading.value = true
  try {
    const r = await window.sqlpilot.listArchive(props.projectId)
    entries.value = r.ok ? (r.entries || []) : []
    if (!r.ok) await window.sqlpilot.uiAlert(r.error || '读取归档失败')
  } catch (e: any) {
    entries.value = []
    await window.sqlpilot.uiAlert(`读取归档失败：${String(e?.message || e)}`)
  } finally {
    loading.value = false
  }
}

watch(() => props.projectId, () => { expanded.clear(); void load() }, { immediate: true })

function toggleExpand(i: number): void {
  if (expanded.has(i)) expanded.delete(i)
  else expanded.add(i)
}

/** 恢复（会话型）/ 继续（legacy：只有总结） */
async function resume(a: ArchEntry): Promise<void> {
  if (a.sessionId) {
    await restoreArchivedSession(a.sessionId)
    emit('close')
    return
  }
  await createSessionInProject(props.projectId)
  emit('close')
  await sendMessage(`请基于以下历史归档继续工作（${a.ts} · ${a.title}）：\n\n${a.summary}\n\n——请先简要确认你从中掌握的背景，然后等我给出具体任务。`)
}

async function remove(a: ArchEntry, i: number): Promise<void> {
  const what = a.sessionId ? `该归档会话（${a.messageCount || 0} 条消息）将被彻底删除` : '仅删除这条历史总结'
  if (!(await window.sqlpilot.uiConfirm(`删除归档「${a.ts} · ${a.title}」？`, what + '，不可恢复', true))) return
  busy.value = i
  try {
    const r = await window.sqlpilot.deleteArchiveEntry(props.projectId, {
      sessionId: a.sessionId, reverseIndex: i, rawCheck: a.raw, ts: a.ts, title: a.title
    })
    if (!r.ok) {
      await window.sqlpilot.uiAlert(r.error || '删除失败')
      return
    }
    expanded.clear()
    await load()
  } finally {
    busy.value = -1
  }
}

async function clearAll(): Promise<void> {
  const n = entries.value.length
  if (!n) return
  if (!(await window.sqlpilot.uiConfirm(`清空该项目全部 ${n} 条归档？`, '删除后不可恢复；该项目后续会话将不再携带这些历史背景', true))) return
  clearing.value = true
  try {
    const r = await window.sqlpilot.clearArchive(props.projectId)
    if (!r.ok) {
      await window.sqlpilot.uiAlert(r.error || '清空失败')
      return
    }
    expanded.clear()
    await load()
  } finally {
    clearing.value = false
  }
}

// LLM 增强总结在后台完成 → 弹窗开着时实时补上摘要
const offArchiveUpdated = window.sqlpilot.onArchiveUpdated(({ projectId }) => {
  if (projectId === props.projectId) void load()
})
onUnmounted(() => { offArchiveUpdated() })
</script>

<style scoped>
.arc-modal {
  width: 760px;
  max-width: 94vw;
  display: flex;
  flex-direction: column;
  max-height: 86vh;
  overflow: hidden;
}
.arc-modal h3 { margin-bottom: 8px; }
.arc-count { font-size: 11.5px; font-weight: 400; color: var(--text-faint); }
.arc-tip { font-size: 11.5px; color: var(--text-dim); line-height: 1.7; margin-bottom: 10px; }
.arc-tip b { color: var(--text); font-weight: 600; }

/* 列表独立滚动：条目再多也不会把弹窗顶出屏幕 */
.arc-list {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 4px 2px 0;
  scrollbar-width: thin;
}
.arc-hint-block {
  padding: 26px 12px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1.9;
}
.arc-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-input);
  padding: 7px 10px 8px;
}
.arc-item:hover { border-color: var(--border-strong); }
.arc-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.arc-ts { font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
.arc-title { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arc-flag { font-size: 10px; color: var(--accent); flex-shrink: 0; }
.arc-flag.legacy { color: var(--text-faint); }
.arc-msg {
  font-size: 10px; color: var(--text-faint); flex-shrink: 0;
  background: var(--bg-card-hover); border-radius: 99px; padding: 0 6px;
}
.arc-sum {
  margin-top: 4px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  /* 默认 3 行，避免一条长总结把弹窗撑满；点开看全文 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
}
.arc-item.open .arc-sum { display: block; overflow: visible; }
.arc-more {
  border: none; background: none; padding: 0; margin-top: 2px;
  font-size: 10.5px; color: var(--accent); cursor: pointer; font-family: inherit;
}
.arc-more:hover { text-decoration: underline; }
.btn.sm { font-size: 11px; padding: 2px 8px; height: auto; }
.btn.sm.danger { background: transparent; color: var(--red); }
.btn.sm.danger:hover { background: var(--red-dim); }
.danger-text { color: var(--red); }
</style>
