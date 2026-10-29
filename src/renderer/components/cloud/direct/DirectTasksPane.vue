<template>
  <div class="tk">
    <div class="tk-head">
      <h2>直连任务 <span class="count">{{ total }}</span></h2>
      <div class="filters">
        <input v-model="kw" class="search" placeholder="搜索动作 / 对象 / 集群" spellcheck="false" @keyup.enter="reload(1)" />
        <select v-model="status" @change="reload(1)">
          <option value="">全部状态</option>
          <option value="ok">成功</option>
          <option value="fail">失败</option>
        </select>
        <select v-model="action" @change="reload(1)">
          <option value="">全部动作</option>
          <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
        </select>
        <button class="ghost" @click="reload(page)">刷新</button>
        <select v-model.number="clearDays" class="clear-range" title="清理范围">
          <option :value="0">清理全部</option>
          <option :value="3">清理 3 天前</option>
          <option :value="7">清理 7 天前</option>
          <option :value="30">清理 30 天前</option>
          <option :value="90">清理 90 天前</option>
        </select>
        <button class="danger" :disabled="!total" @click="clearAll">清理日志</button>
      </div>
    </div>

    <div class="hint">
      记录保存在本机文本文件（应用数据目录下的 <code class="mono">direct-task-log.jsonl</code>）：
      每次直连写操作（建租户 / 锁定 / 删除 / 建库 / 建账号 / 授权…）都会追加一行。
      清理可只删早期记录（按上方范围选择），较新的记录会保留。
    </div>

    <div class="table-wrap">
      <table class="tbl">
        <colgroup>
          <col style="width: 138px" />
          <col style="width: 148px" />
          <col style="width: 210px" />
          <col style="width: 130px" />
          <col />
          <col style="width: 84px" />
          <col style="width: 62px" />
        </colgroup>
        <thead>
          <tr>
            <th>时间</th><th>动作</th><th>对象</th><th>集群</th>
            <th>结果</th><th class="r">耗时</th><th class="r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="row" @click="openDetail(r.id)">
            <td class="mono dim">{{ fmtTime(r.at) }}</td>
            <td class="mono ellipsis" :title="r.action">{{ r.action }}</td>
            <td class="mono ellipsis" :title="r.target">{{ r.target || '—' }}</td>
            <td class="dim ellipsis" :title="r.clusterName">{{ r.clusterName }}</td>
            <td>
              <div class="res">
                <span class="pill" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '成功' : '失败' }}</span>
                <span class="msg" :title="r.message">{{ r.message }}</span>
              </div>
            </td>
            <td class="r mono dim">{{ r.durationMs }} ms</td>
            <td class="r"><button class="link" @click.stop="openDetail(r.id)">详情</button></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="7" class="empty">{{ loading ? '读取中…' : '还没有任务记录' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <button class="ghost" :disabled="page <= 1" @click="reload(page - 1)">上一页</button>
      <span class="dim">{{ page }} / {{ pages }}</span>
      <button class="ghost" :disabled="page >= pages" @click="reload(page + 1)">下一页</button>
    </div>

    <!-- 详情 -->
    <Teleport to="body">
      <div v-if="detail" class="mask" @click.self="detail = null">
        <section class="panel" @click.stop>
          <header class="ph">
            <div>
              <h3>{{ detail.action }} <span class="mono dim">{{ detail.target }}</span></h3>
              <span class="sub">{{ fmtTime(detail.at) }} · {{ detail.clusterName }} · {{ detail.durationMs }} ms</span>
            </div>
            <button class="x" @click="detail = null">✕</button>
          </header>
          <div class="body">
            <div class="result" :class="detail.ok ? 'ok' : 'err'">{{ detail.message || (detail.ok ? '成功' : '失败') }}</div>
            <div class="sec">执行的语句（{{ detail.steps.length }} 条）</div>
            <ol v-if="detail.steps.length" class="steps">
              <li v-for="(s, i) in detail.steps" :key="i"><code>{{ s }}</code></li>
            </ol>
            <div v-else class="dim">该操作没有记录语句（例如锁定/解锁只执行一条 ALTER）。</div>
          </div>
          <footer class="ft"><button class="btn" @click="detail = null">关闭</button></footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
/**
 * 直连任务日志页。
 *
 * OCP 有任务子系统，直连没有——所有写操作由主进程追加到本地 JSONL，
 * 这里做列表、筛选、分页、详情与清理。数据是本机文件，清理由用户显式触发。
 */
import { computed, onMounted, ref } from 'vue'
import { pushNotice } from '../../../store'

interface TaskRow {
  id: string
  at: number
  platformName: string
  clusterName: string
  action: string
  target: string
  ok: boolean
  message: string
  steps: string[]
  durationMs: number
}

const rows = ref<TaskRow[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(20)
const kw = ref('')
const status = ref('')
const action = ref('')
/** 清理范围（天）：0 = 全部 */
const clearDays = ref(0)
const actions = ref<string[]>([])
const loading = ref(false)
const detail = ref<TaskRow | null>(null)

const pages = computed(() => Math.max(1, Math.ceil(total.value / size.value)))

function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function reload(p = 1): Promise<void> {
  page.value = Math.max(1, p)
  loading.value = true
  try {
    const r = await window.sqlpilot.cloudDirectTasks({
      page: page.value,
      size: size.value,
      keyword: kw.value.trim() || undefined,
      status: status.value || undefined,
      action: action.value || undefined
    })
    if (!r.ok || !r.data) return
    rows.value = r.data.items as TaskRow[]
    total.value = r.data.total
  } finally {
    loading.value = false
  }
}

async function openDetail(id: string): Promise<void> {
  const r = await window.sqlpilot.cloudDirectTaskDetail(id)
  if (r.ok && r.data) detail.value = r.data as TaskRow
}

async function clearAll(): Promise<void> {
  const days = Number(clearDays.value) || 0
  const before = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
  const ok = await window.sqlpilot.uiConfirm(
    days > 0 ? `清理 ${days} 天前的任务日志？` : '清理全部任务日志？',
    days > 0
      ? `只删除 ${days} 天以前（含当天更早）产生的记录，最近的记录会保留。操作不可恢复。`
      : '将删除本机上的直连任务记录文件，操作不可恢复。正在进行中的操作不受影响。',
    true
  )
  if (!ok) return
  const r = await window.sqlpilot.cloudDirectClearTasks(before ? { before } : {})
  if (!r.ok) {
    void window.sqlpilot.uiAlert('清理失败', r.error || '请检查文件权限')
    return
  }
  const removed = r.data?.removed ?? 0
  const kept = r.data?.kept ?? 0
  pushNotice(days > 0 ? `已清理 ${removed} 条，保留 ${kept} 条` : `已清理 ${removed} 条任务记录`)
  if (!kept) actions.value = []
  await reload(1)
}

onMounted(async () => {
  const a = await window.sqlpilot.cloudDirectTaskActions()
  if (a.ok) actions.value = a.data || []
  await reload(1)
})
</script>

<style scoped>
.tk { display: flex; flex-direction: column; gap: 10px; }
.tk-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.tk-head h2 { margin: 0; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.count { font-size: 11px; color: var(--text-faint); font-weight: 400; }
.filters { margin-left: auto; display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
input, select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  padding: 5px 8px; font-size: 11.5px; font-family: inherit; outline: none;
}
input:focus, select:focus { border-color: var(--accent); }
.search { min-width: 200px; }
.clear-range { max-width: 128px; }
.ghost, .danger {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text);
  border-radius: 7px; padding: 5px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.ghost:hover { border-color: var(--accent); color: var(--accent); }
.danger { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.danger:hover:not(:disabled) { background: var(--red-dim); }
.danger:disabled, .ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.hint { font-size: 11px; line-height: 1.7; color: var(--text-faint); background: var(--bg-input); border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; }
.table-wrap { border: 1px solid var(--border); border-radius: 9px; overflow: auto; }
/* fixed 布局 + colgroup 固定列宽：否则长 SQL / 长报错会把列挤得各行不一样宽 */
.tbl { width: 100%; min-width: 880px; table-layout: fixed; border-collapse: collapse; font-size: 11.5px; }
/* vertical-align: middle 是「对象列与其他列不在同一行」的直接修复：
   早先 ellipsis 用 inline-block + vertical-align: bottom，混排后整格基线被拉低 */
.tbl th, .tbl td { text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl th { font-size: 10.5px; color: var(--text-faint); font-weight: 500; background: var(--bg-card); }
.tbl tr:last-child td { border-bottom: none; }
.tbl .r { text-align: right; }
.tbl .empty { text-align: center; color: var(--text-faint); padding: 18px; }
.row { cursor: pointer; }
.row:hover { background: var(--bg-card); }
.mono { font-family: var(--mono); }
.dim { color: var(--text-faint); }
.ellipsis { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); flex-shrink: 0; }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
/* 结果列：状态与消息并排后居中，长消息单行省略，不撑高整行 */
.res { display: flex; align-items: center; gap: 6px; min-width: 0; }
.res .msg { font-size: 10.5px; color: var(--text-faint); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { border: none; background: none; color: var(--accent); font-size: 11px; font-family: inherit; cursor: pointer; }
.pager { display: flex; align-items: center; gap: 10px; justify-content: flex-end; font-size: 11px; }
.mask { position: fixed; inset: 0; z-index: 340; background: rgba(5, 7, 12, 0.55); display: flex; align-items: center; justify-content: center; padding: 22px; padding-top: var(--titlebar-h); }
.panel { width: 760px; max-width: 100%; max-height: 86vh; display: flex; flex-direction: column; background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-lg); }
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph h3 { margin: 0; font-size: 14px; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.result { font-size: 12px; line-height: 1.7; border-radius: 8px; padding: 9px 11px; }
.result.ok { color: var(--green); background: var(--green-dim); }
.result.err { color: var(--red); background: var(--red-dim); }
.sec { font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; padding-top: 6px; border-top: 1px dashed var(--border); }
.steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
.steps code { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); word-break: break-all; }
.ft { display: flex; justify-content: flex-end; padding: 11px 16px; border-top: 1px solid var(--border); }
.btn { border: 1px solid var(--border); background: var(--bg-input); color: var(--text); border-radius: 8px; padding: 6px 16px; font-size: 12px; font-family: inherit; cursor: pointer; }
</style>
