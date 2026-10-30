<template>
  <div class="tk">
    <!-- 状态胶囊 + 刷新（与 OCP「任务」页同构） -->
    <div class="tk-bar">
      <div class="st-tabs">
        <button
          v-for="t in statusTabs"
          :key="t.key"
          class="st-tab"
          :class="{ on: status === t.key }"
          @click="setStatus(t.key)"
        >
          {{ t.label }}<span class="n">{{ t.count }}</span>
        </button>
      </div>
      <span class="sp"></span>
      <span v-if="updatedAt" class="note">最近刷新 {{ relTime(updatedAt) }}</span>
      <button class="ghost" :disabled="!rows.length" title="导出当前筛选结果" @click="exportRows">导出 CSV</button>
      <button class="ghost" :disabled="loading" @click="reload(page)">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>

    <!-- 筛选：直连任务在本地文件里，全部条件都在主进程过滤 -->
    <div class="tk-bar">
      <select v-model="cluster" class="sel" @change="reload(1)">
        <option value="">全部集群</option>
        <option v-for="c in clusters" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="action" class="sel" @change="reload(1)">
        <option value="">全部动作</option>
        <option v-for="a in actions" :key="a" :value="a">{{ a }}</option>
      </select>
      <select v-model.number="hours" class="sel" @change="reload(1)">
        <option :value="0">不限时间</option>
        <option :value="1">近 1 小时</option>
        <option :value="24">近 24 小时</option>
        <option :value="72">近 3 天</option>
        <option :value="168">近 7 天</option>
      </select>
      <input
        v-model="kw"
        class="search"
        placeholder="搜索任务 ID / 动作 / 对象 / 集群，回车"
        spellcheck="false"
        @keyup.enter="reload(1)"
      />
      <button class="ghost" @click="resetFilters">重置</button>
      <span class="sp"></span>
      <select v-model.number="clearDays" class="sel" title="清理范围">
        <option :value="0">清理全部</option>
        <option :value="3">清理 3 天前</option>
        <option :value="7">清理 7 天前</option>
        <option :value="30">清理 30 天前</option>
        <option :value="90">清理 90 天前</option>
      </select>
      <button class="danger" :disabled="!stats.total" @click="clearAll">清理日志</button>
    </div>

    <div class="hint">
      直连没有 OCP 的任务子系统：每次写操作（建 / 删 / 锁租户、建库、建账号、授权…）都会在本机
      <code class="mono">direct-task-log.jsonl</code> 追加记录。<b>执行中</b> 的任务来自后台执行
      （删除 / 锁定租户提交后即可关闭窗口），完成后自动变为成功或失败。
    </div>

    <div class="tbl-wrap">
      <table class="tbl">
        <!-- 6 列：内容区在 1440 窗口下只有 ~740px，8 列会把「结果/操作」挤进横向滚动区外；
             集群与结果分别收进「动作」「状态」的第二行，详情里仍有全量 -->
        <colgroup>
          <col style="width: 100px" />
          <col style="width: 200px" />
          <col style="width: 180px" />
          <col style="width: 118px" />
          <col style="width: 74px" />
          <col style="width: 56px" />
        </colgroup>
        <thead>
          <tr>
            <th>状态</th><th>动作 / 集群</th><th>对象</th>
            <th>开始时间</th><th class="r">耗时</th><th class="r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="row" @click="openDetail(r.id)">
            <td>
              <div class="cell2">
                <span class="st" :class="toneOf(r.status)">
                  <i class="dot"></i>{{ statusLabel(r.status) }}
                </span>
                <span class="sub2 ellipsis" :title="r.message">{{ r.message }}</span>
              </div>
            </td>
            <td>
              <div class="cell2">
                <span class="mono ellipsis" :title="r.action">{{ r.action }}</span>
                <span class="sub2 ellipsis" :title="r.clusterName">{{ r.clusterName }}</span>
              </div>
            </td>
            <td class="mono ellipsis" :title="r.target">{{ r.target || '—' }}</td>
            <td class="mono dim" :title="fmtTime(r.at)">{{ fmtShort(r.at) }}</td>
            <td class="r mono dim">{{ r.status === 'running' ? '—' : durText(r.durationMs) }}</td>
            <td class="r"><button class="link" @click.stop="openDetail(r.id)">详情</button></td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="6" class="empty">{{ loading ? '读取中…' : '没有符合条件的任务' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="note">共 {{ total }} 条 · 每页 {{ size }}</span>
      <span class="sp"></span>
      <select v-model.number="size" class="sel" @change="reload(1)">
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
      <button class="ghost" :disabled="page <= 1 || loading" @click="reload(page - 1)">上一页</button>
      <span class="mono dim" style="font-size: 11px">{{ page }} / {{ pages }}</span>
      <button class="ghost" :disabled="page >= pages || loading" @click="reload(page + 1)">下一页</button>
    </div>

    <!-- 任务详情：右侧抽屉（与 OCP 任务详情同一形态） -->
    <Teleport to="body">
      <div v-if="detail" class="dr-mask" @click.self="detail = null">
        <aside class="dr" @click.stop>
          <header class="dr-head">
            <div>
              <div class="dr-title">
                <b>{{ detail.action }}</b>
                <span class="st" :class="toneOf(detail.status)"><i class="dot"></i>{{ statusLabel(detail.status) }}</span>
              </div>
              <div class="dr-sub mono">任务 {{ detail.id }} · {{ detail.target || '—' }}</div>
            </div>
            <button class="x" title="关闭（Esc）" @click="detail = null">✕</button>
          </header>

          <div class="dr-body">
            <div class="result" :class="detail.status === 'fail' ? 'err' : detail.status === 'ok' ? 'ok' : 'pending'">
              {{ detail.message || (detail.status === 'running' ? '执行中…' : '—') }}
            </div>

            <div class="kv-grid">
              <div class="kv"><span>集群</span><b>{{ detail.clusterName || '—' }}</b></div>
              <div class="kv"><span>平台</span><b>{{ detail.platformName || '—' }}</b></div>
              <div class="kv"><span>对象</span><b class="mono">{{ detail.target || '—' }}</b></div>
              <div class="kv"><span>提交时间</span><b>{{ fmtTime(detail.at) }}</b></div>
              <div class="kv"><span>结束时间</span><b>{{ detail.finishedAt ? fmtTime(detail.finishedAt) : '—' }}</b></div>
              <div class="kv"><span>耗时</span><b>{{ detail.status === 'running' ? '—' : durText(detail.durationMs) }}</b></div>
            </div>

            <h4 class="sec">
              执行的语句 <span class="cnt">{{ detail.steps.length }}</span>
            </h4>
            <ol v-if="detail.steps.length" class="steps">
              <li v-for="(s, i) in detail.steps" :key="i"><code>{{ s }}</code></li>
            </ol>
            <div v-else class="dim">该任务还没有记录语句（执行中，或操作本身没有语句）。</div>
          </div>

          <footer class="dr-ft">
            <span class="dim" style="font-size: 10.5px">记录存放于本机应用数据目录</span>
            <span style="flex: 1"></span>
            <button class="ghost" @click="detail = null">关闭</button>
          </footer>
        </aside>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
/**
 * 直连任务日志页（对齐 OCP「任务」页的形态）。
 *
 * 直连没有 OCP 的任务子系统，写操作落在本机 JSONL。为了和 OCP 任务页一致，
 * 这里也提供：状态胶囊（含「执行中」）、集群/动作/时间/关键词筛选、表格 + 右侧详情抽屉、
 * 分页与每页条数。删除/锁定租户改为后台任务后，「执行中」这一档才有意义，
 * 页面在有运行中任务时自动 3 秒刷新一次。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { directTaskActions, directTaskDetail, directTasks, directTenant } from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'

const rows = ref<CloudDirectTaskRow[]>([])
const total = ref(0)
const stats = ref({ total: 0, running: 0, ok: 0, fail: 0 })
const clusters = ref<string[]>([])
const actions = ref<string[]>([])
const page = ref(1)
const size = ref(20)
const status = ref('')
const cluster = ref('')
const action = ref('')
const kw = ref('')
const hours = ref(0)
const clearDays = ref(0)
const loading = ref(false)
const updatedAt = ref(0)
const detail = ref<CloudDirectTaskRow | null>(null)

const pages = computed(() => Math.max(1, Math.ceil(total.value / Math.max(1, size.value))))

const statusTabs = computed(() => [
  { key: '', label: '全部', count: stats.value.total },
  { key: 'running', label: '执行中', count: stats.value.running },
  { key: 'ok', label: '成功', count: stats.value.ok },
  { key: 'fail', label: '失败', count: stats.value.fail }
])

const toneOf = (s: string): string => (s === 'ok' ? 'ok' : s === 'fail' ? 'bad' : 'warn')
const statusLabel = (s: string): string => (s === 'ok' ? '成功' : s === 'fail' ? '失败' : '执行中')

function fmtTime(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 列表里的紧凑时间：年份省略，省得 19 个字符把列撑成两行 */
function fmtShort(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return `${Math.round(s / 3600)} 小时前`
}
function durText(ms: number): string {
  const n = Math.max(0, Number(ms) || 0)
  if (n < 1000) return `${n} ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`
  return `${Math.floor(n / 60_000)} 分 ${Math.round((n % 60_000) / 1000)} 秒`
}

async function reload(p = 1): Promise<void> {
  page.value = Math.max(1, p)
  loading.value = true
  try {
    const r = await directTasks({
      page: page.value,
      size: size.value,
      keyword: kw.value.trim() || undefined,
      status: status.value || undefined,
      action: action.value || undefined,
      cluster: cluster.value || undefined,
      since: hours.value > 0 ? Date.now() - hours.value * 3600_000 : undefined
    })
    rows.value = r.items as CloudDirectTaskRow[]
    total.value = r.total
    stats.value = r.stats
    clusters.value = r.clusters
    actions.value = await directTaskActions()
    updatedAt.value = Date.now()
  } finally {
    loading.value = false
  }
}

function setStatus(k: string): void {
  status.value = k
  void reload(1)
}

function resetFilters(): void {
  cluster.value = ''
  action.value = ''
  hours.value = 0
  kw.value = ''
  status.value = ''
  void reload(1)
}

async function openDetail(id: string): Promise<void> {
  const d = await directTaskDetail(id)
  if (d) detail.value = d
}

async function exportRows(): Promise<void> {
  const cols = ['任务ID', '状态', '动作', '对象', '集群', '提交时间', '结束时间', '耗时(ms)', '结果']
  const data = rows.value.map((r) => [
    r.id, statusLabel(r.status), r.action, r.target, r.clusterName,
    fmtTime(r.at), r.finishedAt ? fmtTime(r.finishedAt) : '', r.durationMs, r.message
  ])
  const res = await window.sqlpilot.cloudExportCsv('直连任务', cols, data)
  if (res.ok) pushNotice(`已导出 ${data.length} 条任务：${res.path}`)
  else if (!res.canceled) pushNotice(res.error || '导出失败')
}

async function clearAll(): Promise<void> {
  const days = Number(clearDays.value) || 0
  const before = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
  const ok = await window.sqlpilot.uiConfirm(
    days > 0 ? `清理 ${days} 天前的任务日志？` : '清理全部任务日志？',
    days > 0
      ? `只删除 ${days} 天以前产生的记录，最近的记录会保留。操作不可恢复。`
      : '将删除本机上的直连任务记录文件，操作不可恢复。执行中的任务不受影响。',
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
  await reload(1)
}

/** 有运行中任务时自动刷新（3 秒），与 OCP 任务页的"活列表"体验一致 */
let timer: ReturnType<typeof setInterval> | null = null
function syncTimer(): void {
  const need = stats.value.running > 0
  if (need && !timer) {
    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (cloud.view !== 'dtasks') return
      void reload(page.value)
      if (detail.value?.status === 'running') void openDetail(detail.value.id)
    }, 3000)
  } else if (!need && timer) {
    clearInterval(timer)
    timer = null
  }
}
watch(stats, syncTimer, { deep: true })

// 从租户详情「查看任务」跳过来：展开对应任务并清空标记
watch(
  () => directTenant.focusTaskId,
  (id) => {
    if (!id) return
    directTenant.focusTaskId = ''
    void openDetail(id)
  },
  { immediate: true }
)

onMounted(() => {
  void reload(1)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  timer = null
})
</script>

<style scoped>
.tk { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.tk-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tk-bar .sp { flex: 1; }
.note { font-size: 11px; color: var(--text-faint); }

/* 状态胶囊：与 OCP 任务页同一套观感 */
.st-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.st-tab {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 99px; padding: 2px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.st-tab:hover { color: var(--text); }
.st-tab.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.st-tab .n { font-family: var(--mono); font-size: 10px; opacity: 0.85; }

.sel, .search {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  padding: 5px 8px; font-size: 11.5px; font-family: inherit; outline: none;
}
.sel:focus, .search:focus { border-color: var(--accent); }
.search { min-width: 240px; }
.ghost, .danger {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text);
  border-radius: 7px; padding: 5px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.ghost:hover { border-color: var(--accent); color: var(--accent); }
.ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.danger { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.danger:hover:not(:disabled) { background: var(--red-dim); }
.danger:disabled { opacity: 0.45; cursor: not-allowed; }

.hint {
  font-size: 11px; line-height: 1.7; color: var(--text-faint);
  background: var(--bg-input); border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px;
}

.tbl-wrap { border: 1px solid var(--border); border-radius: 9px; overflow: auto; }
.tbl { width: 100%; min-width: 700px; table-layout: fixed; border-collapse: collapse; font-size: 11.5px; }
.tbl th, .tbl td { text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.tbl th { font-size: 10.5px; color: var(--text-faint); font-weight: 500; background: var(--bg-card); }
.tbl tr:last-child td { border-bottom: none; }
.tbl .r { text-align: right; }
.tbl .empty { text-align: center; color: var(--text-faint); padding: 18px; }
.row { cursor: pointer; }
.row:hover { background: var(--bg-card); }
.mono { font-family: var(--mono); }
.dim { color: var(--text-faint); }
/* 注意：这里不能加 display:block —— 这个类直接挂在 <td> 上，
   把单元格改成块级会让整张表失去列布局（表现为每列内容竖着堆叠） */
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cell2 { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sub2 { font-size: 10px; color: var(--text-faint); }
.st { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.st .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
.st.ok { color: var(--green); }
.st.ok .dot { background: var(--green); }
.st.bad { color: var(--red); }
.st.bad .dot { background: var(--red); }
.st.warn { color: var(--accent); }
.st.warn .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

.link { border: none; background: none; color: var(--accent); font-size: 11px; font-family: inherit; cursor: pointer; }
.pager { display: flex; align-items: center; gap: 8px; }

/* 详情抽屉 */
.dr-mask { position: fixed; inset: 0; z-index: 340; background: rgba(5, 7, 12, 0.5); display: flex; justify-content: flex-end; }
.dr {
  width: 560px; max-width: 94vw; height: 100%; display: flex; flex-direction: column;
  background: var(--bg-side); border-left: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
  animation: slide-in 0.18s ease;
}
@keyframes slide-in { from { transform: translateX(18px); opacity: 0.6; } to { transform: none; opacity: 1; } }
.dr-head { display: flex; align-items: flex-start; gap: 8px; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.dr-title { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.dr-title b { font-size: 14px; }
.dr-sub { font-size: 10.5px; color: var(--text-faint); margin-top: 3px; }
.x {
  margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px;
}
.x:hover { color: var(--red); border-color: var(--red); }
.dr-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.result { font-size: 12px; line-height: 1.7; border-radius: 8px; padding: 9px 11px; word-break: break-word; }
.result.ok { color: var(--green); background: var(--green-dim); }
.result.err { color: var(--red); background: var(--red-dim); }
.result.pending { color: var(--accent); background: var(--accent-dim); }
.kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 16px; font-size: 11.5px; }
.kv { display: flex; gap: 8px; min-width: 0; }
.kv span { color: var(--text-faint); min-width: 62px; flex-shrink: 0; }
.kv b { font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sec { margin: 2px 0 0; font-size: 11.5px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; display: flex; gap: 6px; align-items: baseline; }
.sec .cnt { font-size: 10.5px; color: var(--text-faint); font-weight: 400; }
.steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.steps code { font-family: var(--mono); font-size: 10.5px; color: var(--text-dim); word-break: break-all; white-space: pre-wrap; }
.dr-ft { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
</style>
