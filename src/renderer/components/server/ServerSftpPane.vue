<template>
  <div class="sf">
    <div class="sf-cols">
      <!-- ============ 本地 ============ -->
      <section class="sf-col">
        <div class="sf-head">
          <span class="sf-title">本地</span>
          <select class="sf-drive" :value="driveOf(localPath)" @change="goDrive($event)">
            <option v-for="r in roots" :key="r.path" :value="r.path">{{ r.name }}</option>
            <option v-if="!roots.some((r) => driveOf(localPath) === r.path)" :value="driveOf(localPath)">{{ driveOf(localPath) }}</option>
          </select>
          <button class="sf-btn" title="上一级" :disabled="atLocalRoot(localPath)" @click="localUp">↑</button>
          <button class="sf-btn" title="刷新" @click="loadLocal">⟳</button>
        </div>
        <input v-model="localPath" class="sf-path" spellcheck="false" @keyup.enter="loadLocal" />
        <div class="sf-list" @dragover.prevent="localDragOver = true" @dragleave="localDragOver = false" @drop.prevent="dropToLocal">
          <div v-if="localLoading" class="sf-hint">加载中…</div>
          <div v-else-if="!localEntries.length" class="sf-hint">（空目录）</div>
          <div
            v-for="f in localEntries"
            :key="f.path"
            class="sf-row"
            :class="{ sel: localSel.has(f.path), over: localDragOver }"
            :title="f.path"
            @click="pickLocal(f, $event)"
            @dblclick="openLocal(f)"
          >
            <span class="sf-ico">{{ f.isDir ? '📁' : '📄' }}</span>
            <span class="sf-name">{{ f.name }}</span>
            <span class="sf-size">{{ f.isDir ? '' : fmtBytes(f.size) }}</span>
            <span class="sf-time">{{ fmtTime(f.mtime) }}</span>
          </div>
        </div>
        <div class="sf-foot">
          <span>{{ localSel.size ? `已选 ${localSel.size} 项` : `${localEntries.length} 项` }}</span>
          <span style="flex:1"></span>
          <button class="sf-btn" :disabled="!localSel.size" title="上传选中项到右侧目录" @click="uploadSelected">上传 ⬆</button>
        </div>
      </section>

      <!-- ============ 远程 ============ -->
      <section class="sf-col" @dragover.prevent="remoteDragOver = true" @dragleave="remoteDragOver = false" @drop.prevent="dropToRemote">
        <div class="sf-head">
          <span class="sf-title">{{ serverName }}</span>
          <button class="sf-btn" title="主目录" @click="goHome">~</button>
          <button class="sf-btn" title="上一级" @click="remoteUp">↑</button>
          <button class="sf-btn" title="刷新" @click="loadRemote">⟳</button>
          <button class="sf-btn" :class="{ on: showHidden }" title="显示隐藏文件" @click="toggleHidden">.</button>
        </div>
        <input v-model="remotePath" class="sf-path" spellcheck="false" @keyup.enter="loadRemote" />
        <!-- 新建目录：Electron 渲染层没有 window.prompt（调用即抛异常），用内联输入框 -->
        <div v-if="mkdirOpen" class="sf-mkdir">
          <input
            v-model="mkdirName"
            class="sf-path"
            placeholder="新目录名称（回车确认 / Esc 取消）"
            spellcheck="false"
            @keyup.enter="confirmMkdir"
            @keyup.esc="mkdirOpen = false"
          />
          <button class="sf-btn primary" @click="confirmMkdir">创建</button>
          <button class="sf-btn" @click="mkdirOpen = false">取消</button>
        </div>
        <div class="sf-list" :class="{ over: remoteDragOver }">
          <div v-if="remoteLoading" class="sf-hint">加载中…</div>
          <div v-else-if="remoteError" class="sf-hint err">
            {{ remoteError }}
            <button class="sf-btn" style="margin-left:8px" @click="loadRemote">重试</button>
          </div>
          <div v-else-if="!remotePath" class="sf-hint">连接服务器后自动加载远程目录</div>
          <div v-else-if="!visibleRemote.length" class="sf-hint">（空目录）</div>
          <div
            v-for="f in visibleRemote"
            :key="f.name"
            class="sf-row"
            :class="{ sel: remoteSel.has(f.name) }"
            draggable="true"
            :title="`${f.name}\n${f.perms} ${f.isDir ? '目录' : fmtBytes(f.size)}`"
            @click="pickRemote(f, $event)"
            @dblclick="openRemote(f)"
            @dragstart="dragRemote(f)"
          >
            <span class="sf-ico">{{ f.isDir ? '📁' : f.isLink ? '🔗' : '📄' }}</span>
            <span class="sf-name">{{ f.name }}</span>
            <span class="sf-perm">{{ f.perms }}</span>
            <span class="sf-size">{{ f.isDir ? '' : fmtBytes(f.size) }}</span>
            <span class="sf-time">{{ fmtTime(f.mtime) }}</span>
          </div>
        </div>
        <div class="sf-foot">
          <span>{{ remoteSel.size ? `已选 ${remoteSel.size} 项` : `${visibleRemote.length} 项` }}</span>
          <span style="flex:1"></span>
          <button class="sf-btn" title="新建目录" @click="mkRemoteDir">新建目录</button>
          <button class="sf-btn" :disabled="!remoteSel.size" title="删除选中项" @click="removeRemote">删除</button>
          <button class="sf-btn" :disabled="!remoteSel.size" title="下载到左侧目录" @click="downloadSelected">下载 ⬇</button>
        </div>
      </section>
    </div>

    <!-- 传输队列 -->
    <div v-if="srv.transfers.length" class="sf-queue">
      <div class="sf-queue-head">
        <span>传输队列（{{ runningCount }} 进行中）</span>
        <span style="flex:1"></span>
        <button class="sf-btn" @click="clearFinished">清除已完成</button>
        <button class="sf-btn" @click="collapseQueue = !collapseQueue">{{ collapseQueue ? '展开' : '收起' }}</button>
      </div>
      <div v-if="!collapseQueue" class="sf-queue-list">
        <div v-for="t in srv.transfers" :key="t.id" class="sf-qitem">
          <span class="sf-qkind">{{ t.kind === 'upload' ? '⬆' : '⬇' }}</span>
          <span class="sf-qname">{{ t.name }}</span>
          <div class="sf-qbar">
            <div class="sf-qfill" :class="t.status" :style="{ width: pct(t) + '%' }"></div>
          </div>
          <span class="sf-qstat">{{ statusText(t) }}</span>
          <button v-if="t.status === 'running'" class="sf-btn" @click="cancelTransfer(t.id)">取消</button>
          <button v-else class="sf-btn" @click="dropTransfer(t.id)">✕</button>
        </div>
      </div>
    </div>

    <!-- 远程文件编辑（内置轻量编辑器：改配置不用往返下载） -->
    <Teleport to="body">
      <div v-if="edit" class="ctx-mask" @mousedown.self="edit = null">
        <div class="ed-box">
          <div class="ed-head">
            <span class="ed-title">{{ edit.path }}</span>
            <span class="ed-meta">{{ edit.size != null ? fmtBytes(edit.size) : '' }} · {{ edit.encoding }}</span>
            <span style="flex:1"></span>
            <button class="sf-btn" @click="edit = null">关闭</button>
            <button class="sf-btn primary" :disabled="edit.saving || edit.truncated" @click="saveEdit">{{ edit.saving ? '保存中…' : '保存' }}</button>
          </div>
          <div v-if="edit.truncated" class="ed-warn">文件超过 2MB，只加载了前面一部分：为避免把原文件截短，已禁用保存，请下载后编辑。</div>
          <textarea v-model="edit.content" class="ed-area" spellcheck="false" :readonly="!!edit.truncated"></textarea>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { pathFor, srv, transferPercent, type TransferItem } from '../../server/state'
import { findServer } from '../../server/state'
import { startUpload, startDownload } from '../../server/transfer-api'
import { parentLocalPath, atLocalRoot, driveOf as driveOfPath } from '../../server/paths'
import { effectivePrefs, fmtBytes, fmtTime } from '../../server/prefs'

const props = defineProps<{ serverId: string }>()

const serverName = computed(() => findServer(props.serverId)?.name || '远程')
const enc = computed(() => (findServer(props.serverId)?.fileEncoding || effectivePrefs(findServer(props.serverId)).encoding) as string)

// ---------- 本地 ----------
const roots = ref<{ name: string; path: string }[]>([])
const localPath = ref(pathFor(props.serverId).local || '')
const localEntries = ref<LocalEntryView[]>([])
const localSel = ref(new Set<string>())
const localLoading = ref(false)
const localDragOver = ref(false)

// ---------- 远程 ----------
const remotePath = ref(pathFor(props.serverId).remote || '')
const remoteEntries = ref<SftpEntryView[]>([])
const remoteSel = ref(new Set<string>())
const remoteLoading = ref(false)
const remoteError = ref('')
const showHidden = ref(true)
const remoteDragOver = ref(false)
/** 新建目录的内联输入（Electron 没有 window.prompt） */
const mkdirOpen = ref(false)
const mkdirName = ref('')

// ---------- 队列 ----------
const collapseQueue = ref(false)
const runningCount = computed(() => srv.transfers.filter((t) => t.status === 'running').length)

// ---------- 远程编辑 ----------
const edit = ref<{ path: string; content: string; encoding: string; size?: number; truncated?: boolean; saving?: boolean } | null>(null)

const visibleRemote = computed(() => (showHidden.value ? remoteEntries.value : remoteEntries.value.filter((f) => !f.name.startsWith('.'))))

watch(remotePath, (v) => { pathFor(props.serverId).remote = v })
watch(localPath, (v) => { pathFor(props.serverId).local = v })
// 终端区拖拽上传完成后刷新远程列表
watch(() => srv.remoteRefresh, () => { if (remotePath.value) void loadRemote() })

function driveOf(p: string): string {
  return driveOfPath(p) || (roots.value[0]?.path || 'C:\\')
}

function goDrive(e: Event): void {
  localPath.value = (e.target as HTMLSelectElement).value
  localSel.value.clear()
  void loadLocal()
}

async function loadLocal(): Promise<void> {
  if (!localPath.value) return
  localLoading.value = true
  const r = await window.sqlpilot.localLs(localPath.value)
  localLoading.value = false
  if (r.ok) {
    localPath.value = r.dir || localPath.value
    localEntries.value = r.entries || []
  } else {
    localEntries.value = []
    srv.status = r.error || '本地目录读取失败'
  }
}

function localUp(): void {
  const next = parentLocalPath(localPath.value)
  if (!next) return
  localPath.value = next
  localSel.value.clear()
  void loadLocal()
}

function pickLocal(f: LocalEntryView, e: MouseEvent): void {
  if (e.ctrlKey || e.metaKey) {
    if (localSel.value.has(f.path)) localSel.value.delete(f.path)
    else localSel.value.add(f.path)
  } else {
    localSel.value.clear()
    localSel.value.add(f.path)
  }
  // 触发响应式更新（Set 的增删不会被 Vue 深层侦测到）
  localSel.value = new Set(localSel.value)
}

function openLocal(f: LocalEntryView): void {
  if (f.isDir) {
    localPath.value = f.path
    localSel.value.clear()
    void loadLocal()
  } else {
    void window.sqlpilot.localOpen(f.path)
  }
}

// ---------- 远程操作 ----------
/** 请求序号：连点 ⟳ / 快速进目录时，后到的旧响应不能覆盖新目录的列表与地址 */
let remoteSeq = 0
async function loadRemote(): Promise<void> {
  const my = ++remoteSeq
  remoteError.value = ''
  if (!remotePath.value) {
    const h = await window.sqlpilot.sftpHome(props.serverId)
    if (my !== remoteSeq) return
    remotePath.value = (h.ok && h.path) || '/'
    if (!h.ok) {
      remoteError.value = h.error || '无法获取主目录'
      return
    }
    // 取到主目录后要继续列一次：以前这里 return，首次打开面板永远显示"（空目录）"
  }
  remoteLoading.value = true
  const r = await window.sqlpilot.sftpLs(props.serverId, remotePath.value)
  if (my !== remoteSeq) return
  remoteLoading.value = false
  if (r.ok) {
    remoteEntries.value = r.entries || []
    if (r.path) remotePath.value = r.path
  } else {
    remoteEntries.value = []
    remoteError.value = r.error || '读取失败'
  }
}

async function goHome(): Promise<void> {
  const h = await window.sqlpilot.sftpHome(props.serverId)
  if (h.ok && h.path) {
    remotePath.value = h.path
    remoteSel.value.clear()
    await loadRemote()
  }
}

function remoteUp(): void {
  const p = remotePath.value.replace(/\/+$/, '')
  if (p === '' || p === '/') return
  const i = p.lastIndexOf('/')
  remotePath.value = i <= 0 ? '/' : p.slice(0, i)
  remoteSel.value.clear()
  void loadRemote()
}

function joinRemote(dir: string, name: string): string {
  return `${String(dir || '').replace(/\/+$/, '')}/${name}`
}

function pickRemote(f: SftpEntryView, e: MouseEvent): void {
  if (e.ctrlKey || e.metaKey) {
    if (remoteSel.value.has(f.name)) remoteSel.value.delete(f.name)
    else remoteSel.value.add(f.name)
  } else {
    remoteSel.value.clear()
    remoteSel.value.add(f.name)
  }
  remoteSel.value = new Set(remoteSel.value)
}

async function openRemote(f: SftpEntryView): Promise<void> {
  if (f.isDir) {
    remotePath.value = joinRemote(remotePath.value, f.name)
    remoteSel.value.clear()
    await loadRemote()
    return
  }
  // 文本文件直接开编辑器；二进制/超大文件提示下载。
  // 门槛必须与 sftpRead 的读取上限一致：以前是 4MB 门槛、2MB 上限，2~4MB 的文件会被截断却允许整份写回
  if (f.size > 2 * 1024 * 1024) {
    await window.sqlpilot.uiAlert(`文件 ${fmtBytes(f.size)}，超过内置编辑器 2MB 上限`, '请下载后用文本编辑器打开。')
    return
  }
  const p = joinRemote(remotePath.value, f.name)
  const r = await window.sqlpilot.sftpRead(props.serverId, p, 2 * 1024 * 1024, enc.value)
  if (!r.ok) {
    await window.sqlpilot.uiAlert('读取失败：' + (r.error || ''))
    return
  }
  edit.value = { path: p, content: r.content || '', encoding: enc.value, size: r.size, truncated: r.truncated }
}

async function saveEdit(): Promise<void> {
  const e = edit.value
  if (!e) return
  if (e.truncated) {
    await window.sqlpilot.uiAlert('这个文件只加载了前 2MB（已截断）', '直接保存会把原文件截短，已阻止。请下载后用文本编辑器打开。')
    return
  }
  e.saving = true
  const r = await window.sqlpilot.sftpWrite(props.serverId, e.path, e.content, e.encoding)
  e.saving = false
  if (!r.ok) {
    await window.sqlpilot.uiAlert('保存失败：' + (r.error || ''))
    return
  }
  edit.value = null
  srv.status = `已保存 ${e.path}`
  void loadRemote()
}

async function mkRemoteDir(): Promise<void> {
  mkdirName.value = ''
  mkdirOpen.value = true
}

async function confirmMkdir(): Promise<void> {
  const name = mkdirName.value.trim()
  if (!name) return
  mkdirOpen.value = false
  const r = await window.sqlpilot.sftpMkdir(props.serverId, joinRemote(remotePath.value, name))
  if (!r.ok) await window.sqlpilot.uiAlert('创建失败：' + (r.error || ''))
  else void loadRemote()
}

async function removeRemote(): Promise<void> {
  const names = [...remoteSel.value]
  if (!names.length) return
  // 用主进程对话框：渲染层的 window.confirm 是同步原生框，会锁死整个渲染线程
  const ok = await window.sqlpilot.uiConfirm(
    `确认删除以下 ${names.length} 项？`,
    `${names.join('\n')}\n\n目录会递归删除，不可恢复。`,
    true
  )
  if (!ok) return
  for (const n of names) {
    const r = await window.sqlpilot.sftpRemove(props.serverId, joinRemote(remotePath.value, n), true)
    if (!r.ok) {
      await window.sqlpilot.uiAlert(`删除 ${n} 失败：` + (r.error || ''))
      break
    }
  }
  remoteSel.value.clear()
  void loadRemote()
}

// ---------- 上传 / 下载（任务发起在 transfer-api，终端拖拽也走同一套） ----------
async function uploadSelected(): Promise<void> {
  if (!localSel.value.size) return
  await startUpload(props.serverId, [...localSel.value], remotePath.value)
  void loadRemote()
}

async function downloadSelected(): Promise<void> {
  const names = [...remoteSel.value]
  if (!names.length) return
  if (!localPath.value) {
    await window.sqlpilot.uiAlert('请先在左侧选择下载目录')
    return
  }
  const r = await startDownload(
    props.serverId,
    names.map((n) => joinRemote(remotePath.value, n)),
    localPath.value
  )
  if (r.ok) void loadLocal()
}

/** 从本地资源管理器拖文件进远程面板 */
async function dropToRemote(e: DragEvent): Promise<void> {
  remoteDragOver.value = false
  const dt = e.dataTransfer
  if (!dt) return
  // 从对面栏拖来的远程项没有 files，走本地栏的 dropToLocal
  const files = Array.from(dt.files || [])
  if (!files.length) return
  const paths = files.map((f) => window.sqlpilot.getPathForFile(f)).filter(Boolean)
  if (!paths.length) {
    await window.sqlpilot.uiAlert('无法获取拖入文件的本地路径', '请改用「上传」按钮选择文件。')
    return
  }
  await startUpload(props.serverId, paths, remotePath.value)
  void loadRemote()
}

/** 远程项拖到本地栏 → 下载到当前本地目录 */
async function dropToLocal(e: DragEvent): Promise<void> {
  localDragOver.value = false
  const names = [...remoteSel.value]
  if (!names.length) return
  await downloadSelected()
}

function dragRemote(f: SftpEntryView): void {
  if (!remoteSel.value.has(f.name)) {
    remoteSel.value = new Set([f.name])
  }
}

// ---------- 队列 ----------
function pct(t: TransferItem): number {
  return transferPercent(t)
}

function statusText(t: TransferItem): string {
  if (t.status === 'done') return `完成 · ${t.fileCount} 项`
  if (t.status === 'error') return '失败：' + (t.error || '')
  if (t.status === 'canceled') return '已取消'
  const at = `${Math.min(t.index + 1, t.fileCount)}/${t.fileCount}`
  const size = t.fileSize > 0 ? ` · ${fmtBytes(t.transferred)}/${fmtBytes(t.fileSize)}` : ''
  return `${at} · ${t.name}${size}`
}

async function cancelTransfer(id: string): Promise<void> {
  await window.sqlpilot.sftpCancel(id)
}

function dropTransfer(id: string): void {
  srv.transfers = srv.transfers.filter((t) => t.id !== id)
}

function clearFinished(): void {
  srv.transfers = srv.transfers.filter((t) => t.status === 'running')
}

function toggleHidden(): void {
  showHidden.value = !showHidden.value
}

onMounted(async () => {
  const r = await window.sqlpilot.localRoots()
  if (r.ok) {
    roots.value = r.roots
    if (!localPath.value) localPath.value = r.home
  }
  void loadLocal()
  await loadRemote()
})
</script>

<style scoped>
.sf { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg); container-type: inline-size; }
.sf-cols { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); min-height: 0; }
/* 面板窄到 300px 以下时左右双栏各自只剩 150，文件名和按钮都放不下——
   改为上下堆叠（本地在上、远程在下），这是"左侧文件面板"在小窗下的合理降级。
   300 是实测阈值：420 宽时每栏 210，靠下面的列裁剪仍能显示名字 + 大小。 */
@container (max-width: 300px) {
  .sf-cols { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
}
.sf-col {
  display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg);
  /* 宽度驱动的列裁剪：容器查询比媒体查询合适——面板宽度由用户拖拽决定，与窗口无关 */
  container-type: inline-size;
}
/* 窄栏先丢时间和权限，再丢大小；文件名任何时候都不能没（否则列表等于空白） */
@container (max-width: 300px) {
  .sf-perm, .sf-time { display: none; }
}
@container (max-width: 230px) {
  .sf-size { display: none; }
}
.sf-head {
  display: flex; align-items: center; gap: 5px; padding: 5px 8px;
  border-bottom: 1px solid var(--border); background: var(--bg-side);
  flex-wrap: nowrap; overflow: hidden;
}
.sf-title { font-size: 11.5px; font-weight: 700; color: var(--text-dim); letter-spacing: .5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
.sf-drive {
  font-size: 11px; padding: 1px 4px; border-radius: 5px; background: var(--bg-card);
  border: 1px solid var(--border); color: var(--text-dim); font-family: inherit; max-width: 78px;
}
.sf-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 5px; font-size: 11px; padding: 2px 7px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
.sf-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.sf-btn:disabled { opacity: .4; cursor: default; }
.sf-btn.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.sf-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sf-path {
  margin: 5px 8px; font-size: 11.5px; font-family: var(--mono);
  padding: 3px 8px; border-radius: 6px;
}
/* 新建目录的内联行：与路径输入等高，占一行 */
.sf-mkdir { display: flex; align-items: center; gap: 6px; padding: 0 8px 4px; }
.sf-mkdir .sf-path { flex: 1; margin: 0; }
.sf-list { flex: 1; overflow: auto; min-height: 0; }
.sf-list.over { outline: 2px dashed var(--accent); outline-offset: -4px; background: var(--accent-dim); }
.sf-hint { padding: 14px; color: var(--text-faint); font-size: 12px; }
.sf-hint.err { color: var(--red); }
.sf-row {
  display: flex; align-items: center; gap: 6px; padding: 3px 9px;
  font-size: 12px; color: var(--text-dim); cursor: default;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
}
.sf-row:hover { background: var(--bg-card-hover); }
.sf-row.sel { background: var(--accent-dim); color: var(--text); }
.sf-ico { width: 15px; flex-shrink: 0; font-size: 11px; }
.sf-name { flex: 1; min-width: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.sf-perm { font-family: var(--mono); font-size: 10.5px; color: var(--text-faint); flex-shrink: 0; }
.sf-size { font-size: 10.5px; color: var(--text-faint); width: 58px; text-align: right; flex-shrink: 0; }
.sf-time { font-size: 10.5px; color: var(--text-faint); width: 96px; text-align: right; flex-shrink: 0; }
.sf-foot {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  border-top: 1px solid var(--border); background: var(--bg-side);
  font-size: 11px; color: var(--text-faint);
  flex-wrap: wrap; row-gap: 4px;
}

.sf-queue { border-top: 1px solid var(--border-strong); background: var(--bg-side); max-height: 190px; display: flex; flex-direction: column; }
.sf-queue-head { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11.5px; color: var(--text-dim); }
.sf-queue-list { overflow: auto; padding: 0 10px 6px; }
.sf-qitem { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 11.5px; color: var(--text-dim); }
.sf-qkind { width: 12px; }
.sf-qname { width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.sf-qbar { flex: 1; height: 5px; background: var(--bg-card); border-radius: 3px; overflow: hidden; min-width: 60px; }
.sf-qfill { height: 100%; background: var(--accent); transition: width .2s ease; }
.sf-qfill.done { background: var(--green); }
.sf-qfill.error { background: var(--red); }
.sf-qfill.canceled { background: var(--text-faint); }
.sf-qstat { width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-faint); }
</style>

<style>
/* 远程文件编辑器（teleport 到 body，不能 scoped） */
.ed-box {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: 880px; max-width: 94vw; height: 76vh; display: flex; flex-direction: column;
  background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden;
}
.ed-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--border); }
.ed-title { font-family: var(--mono); font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 460px; }
.ed-meta { font-size: 11px; color: var(--text-faint); }
.ed-warn { padding: 6px 14px; font-size: 11.5px; color: var(--yellow); background: var(--yellow-dim); }
.ed-area {
  flex: 1; width: 100%; resize: none; border: none; outline: none;
  background: var(--bg-code); color: var(--text);
  font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
  padding: 12px 14px; tab-size: 4;
}
</style>
