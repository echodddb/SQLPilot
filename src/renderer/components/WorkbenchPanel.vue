<template>
  <div class="wb-panel" :style="{ height: panelH + 'px' }">
    <div class="wb-drag" @mousedown="startVDrag" title="拖拽调整高度（双击收起/展开）" @dblclick="panelH = panelH > 60 ? 40 : 320"></div>

    <div class="wb-head">
      <span class="wb-title">终端<span v-if="terms.length" class="wb-count">（{{ terms.length }}）</span></span>
      <span style="flex:1"></span>
      <button class="icon-btn" title="关闭面板" @click="$emit('close')">✕</button>
    </div>

    <div class="wb-body">
      <div class="wb-side" :style="{ width: sideW + 'px' }">
        <div class="wb-side-title">服务器</div>
        <div v-if="!servers.length" class="wb-hint">项目未挂载服务器<br />右键项目 → 编辑属性</div>
        <div v-for="s in servers" :key="s.id" class="srv-item" :title="`${s.user}@${s.host}:${s.port}`" @click="openTerm(s)">
          <span class="name">{{ s.name }}</span>
          <span v-if="s.tag" class="tag" :class="{ prod: s.tag === '生产' }">{{ s.tag }}</span>
        </div>
      </div>
      <div class="wb-hsplit" @mousedown="startHDrag"></div>
      <div class="wb-main">
        <div class="term-tabs" v-if="terms.length">
          <div v-for="t in terms" :key="t.id" class="term-tab" :class="{ active: t.id === activeId }" @click="activeId = t.id">
            {{ t.name }}
            <button class="icon-btn" style="padding:0 3px; font-size:11px" @click.stop="closeTerm(t.id)">✕</button>
          </div>
          <span style="flex:1"></span>
          <button class="wb-mini" :class="{ on: sftpOpen }" title="SFTP 文件浏览器" @click="toggleSftp">文件</button>
        </div>
        <div class="term-host" ref="hostEl">
          <div v-for="t in terms" :key="t.id" v-show="t.id === activeId" :ref="setPaneRef(t.id)"></div>
          <div v-if="!terms.length" class="term-empty">← 点击服务器打开交互式终端</div>
        </div>
      </div>

      <!-- SFTP 文件浏览器 -->
      <div v-if="sftpOpen && activeTerm" class="sftp-panel" :style="{ width: sftpW + 'px' }">
        <div class="wb-drag-h" @mousedown="startSftpDrag"></div>
        <div class="sftp-head">
          <button class="wb-mini" title="上一级" @click="sftpUp">↑</button>
          <input v-model="sftpPath" class="sftp-path" @keyup.enter="loadSftp" placeholder="/remote/path" />
          <button class="wb-mini" title="刷新" @click="loadSftp">⟳</button>
          <button class="wb-mini" title="上传文件到当前目录" @click="sftpUploadFiles">⬆ 上传</button>
        </div>
        <div class="sftp-list">
          <div v-if="sftpLoading" class="wb-hint">加载中…</div>
          <div v-else-if="!sftpEntries.length" class="wb-hint">（空目录）</div>
          <div
            v-for="f in sftpEntries"
            :key="f.name"
            class="sftp-item"
            :title="f.isDir ? f.name : `${f.name} · ${fmtSize(f.size)}（双击下载到项目 downloads/）`"
            @click="f.isDir && enterDir(f.name)"
            @dblclick="!f.isDir && sftpDownloadFile(f.name)"
          >
            <span>{{ f.isDir ? '▸' : '' }}</span>
            <span class="name">{{ f.name }}</span>
            <span class="size">{{ f.isDir ? '' : fmtSize(f.size) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { store, curSession } from '../store'

defineEmits<{ (e: 'close'): void }>()

// ---------- 尺寸拖拽 ----------
const panelH = ref(320)
const sideW = ref(200)
const sftpW = ref(300)

function startVDrag(e: MouseEvent) {
  const startY = e.clientY
  const startH = panelH.value
  const move = (ev: MouseEvent) => {
    panelH.value = Math.min(Math.max(startH - (ev.clientY - startY), 160), window.innerHeight - 260)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
function startHDrag(e: MouseEvent) {
  const startX = e.clientX
  const startW = sideW.value
  const move = (ev: MouseEvent) => {
    sideW.value = Math.min(Math.max(startW + (ev.clientX - startX), 150), 460)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
function startSftpDrag(e: MouseEvent) {
  const startX = e.clientX
  const startW = sftpW.value
  const move = (ev: MouseEvent) => {
    sftpW.value = Math.min(Math.max(startW - (ev.clientX - startX), 200), 520)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

// ---------- 服务器列表（当前会话项目的挂载服务器） ----------
const project = computed(() => {
  const pid = curSession()?.meta.projectId
  return pid ? (store.cfg?.projects || []).find((p: any) => p.id === pid) : null
})
const servers = computed(() => project.value?.servers || [])

// ---------- 终端 ----------
interface TermTab { id: string; name: string; term: Terminal; fit: FitAddon; serverId: string; sftpPath: string }
const hostEl = ref<HTMLElement | null>(null)
const terms = ref<TermTab[]>([])
const activeId = ref('')
const paneEls = new Map<string, HTMLElement>()
const activeTerm = computed(() => terms.value.find((t) => t.id === activeId.value))

function setPaneRef(id: string) {
  return (el: any) => {
    if (el) paneEls.set(id, el as HTMLElement)
  }
}

async function openTerm(s: any) {
  const existing = terms.value.find((t) => t.serverId === s.id)
  if (existing) {
    activeId.value = existing.id
    return
  }
  const id = `term_${Date.now()}_${Math.floor(Math.random() * 1000)}`
  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    theme: document.documentElement.getAttribute('data-theme') === 'light' ? { background: '#ffffff', foreground: '#1f2433' } : { background: '#0b0d13', foreground: '#e8ebf4' },
    cursorBlink: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.onData((d) => window.sqlpilot.termInput(id, d))
  const tab: TermTab = { id, name: s.name, term, fit, serverId: s.id, sftpPath: `/home/${s.user}` }
  terms.value.push(tab)
  activeId.value = id
  await nextTick()
  const el = paneEls.get(id)
  if (el) {
    term.open(el)
    fit.fit()
    window.sqlpilot.termResize(id, term.cols, term.rows)
  }
  const r = await window.sqlpilot.termOpen(id, s.id)
  if (!r.ok) {
    // 连接失败不留死标签页
    alert(`连接 ${s.name} 失败：${r.error || '未知错误'}`)
    closeTerm(id)
    return
  }
  doFit(id)
}

function closeTerm(id: string) {
  const t = terms.value.find((x) => x.id === id)
  if (!t) return
  window.sqlpilot.termClose(id)
  t.term.dispose()
  terms.value = terms.value.filter((x) => x.id !== id)
  paneEls.delete(id)
  if (activeId.value === id) activeId.value = terms.value[terms.value.length - 1]?.id || ''
}

function doFit(id: string) {
  const t = terms.value.find((x) => x.id === id)
  if (!t) return
  try {
    t.fit.fit()
    window.sqlpilot.termResize(id, t.term.cols, t.term.rows)
  } catch { /* 忽略 */ }
}

let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let resizeObs: ResizeObserver | null = null

onMounted(() => {
  offData = window.sqlpilot.onTermData(({ termId, data }) => {
    terms.value.find((x) => x.id === termId)?.term.write(data)
  })
  offExit = window.sqlpilot.onTermExit(({ termId }) => {
    terms.value.find((x) => x.id === termId)?.term.writeln('\r\n\x1b[90m— 连接已关闭 —\x1b[0m')
  })
  resizeObs = new ResizeObserver(() => activeId.value && doFit(activeId.value))
  if (hostEl.value) resizeObs.observe(hostEl.value)
})

onBeforeUnmount(() => {
  offData?.()
  offExit?.()
  resizeObs?.disconnect()
  for (const t of terms.value) {
    window.sqlpilot.termClose(t.id)
    t.term.dispose()
  }
})

// 切换终端子标签：重适配尺寸 + 刷新该终端的 SFTP 目录
watch(activeId, () => {
  nextTick(() => activeId.value && doFit(activeId.value))
  if (sftpOpen.value && activeTerm.value) loadSftp()
})

// 面板重新显示（v-show 显隐，隐藏期间尺寸为 0）：恢复后重适配当前终端
watch(() => store.workbench, (v) => {
  if (v) nextTick(() => setTimeout(() => activeId.value && doFit(activeId.value), 60))
})

// ---------- SFTP ----------
const sftpOpen = ref(true)
const sftpEntries = ref<any[]>([])
const sftpLoading = ref(false)
/** 当前终端各自的远程路径（每台服务器独立记忆） */
const sftpPath = computed({
  get: () => activeTerm.value?.sftpPath ?? '',
  set: (v: string) => {
    if (activeTerm.value) activeTerm.value.sftpPath = v
  }
})

function toggleSftp() {
  sftpOpen.value = !sftpOpen.value
  if (sftpOpen.value && activeTerm.value && !sftpEntries.value.length) loadSftp()
}

async function loadSftp() {
  if (!activeTerm.value || !sftpPath.value) return
  sftpLoading.value = true
  const r = await window.sqlpilot.sftpList(activeTerm.value.serverId, sftpPath.value)
  sftpLoading.value = false
  if (r.ok) sftpEntries.value = r.entries || []
  else sftpEntries.value = []
}

function enterDir(name: string) {
  sftpPath.value = sftpPath.value.replace(/\/+$/, '') + '/' + name
  loadSftp()
}

function sftpUp() {
  const parts = sftpPath.value.replace(/\/+$/, '').split('/')
  parts.pop()
  sftpPath.value = parts.join('/') || '/'
  loadSftp()
}

async function sftpDownloadFile(name: string) {
  if (!activeTerm.value) return
  const remote = sftpPath.value.replace(/\/+$/, '') + '/' + name
  const projRoot = (project.value as any)?.rootPath
  const dir = projRoot ? projRoot + '\\downloads' : ''
  const r = await window.sqlpilot.sftpDownload(activeTerm.value.serverId, remote, dir)
  if (r.ok && r.local) {
    await window.sqlpilot.showInFolder(r.local)
  } else if (r.error) {
    alert('下载失败：' + r.error)
  }
}

async function sftpUploadFiles() {
  if (!activeTerm.value) return
  const r = await window.sqlpilot.sftpUpload(activeTerm.value.serverId, sftpPath.value || '.')
  if (r.ok) await loadSftp()
  else if (r.error) alert('上传失败：' + r.error)
}

function fmtSize(n: number): string {
  if (n > 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + 'G'
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M'
  if (n > 1024) return (n / 1024).toFixed(1) + 'K'
  return n + 'B'
}
</script>

<style scoped>
.wb-panel {
  border-top: 1px solid var(--border-strong);
  background: var(--bg-side);
  display: flex;
  flex-direction: column;
  position: relative;
  flex-shrink: 0;
}
.wb-drag {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 7px;
  cursor: ns-resize;
  z-index: 10;
}
.wb-drag:hover { background: var(--accent-dim); }
.wb-head {
  display: flex;
  align-items: center;
  padding: 0 8px;
  height: 36px;
  border-bottom: 1px solid var(--border);
}
.wb-title { font-size: 12.5px; font-weight: 600; color: var(--text-dim); }
.wb-count { color: var(--text-faint); font-weight: 400; }
.wb-body { flex: 1; display: flex; min-height: 0; }
.wb-side { border-right: 1px solid var(--border); overflow-y: auto; padding: 4px 0; flex-shrink: 0; }
.wb-side-title { padding: 6px 12px 4px; font-size: 11px; color: var(--text-faint); font-weight: 700; letter-spacing: 1px; }
.wb-hint { padding: 8px 12px; color: var(--text-faint); font-size: 12px; line-height: 1.7; }
.wb-hsplit { width: 5px; cursor: ew-resize; flex-shrink: 0; background: transparent; }
.wb-hsplit:hover { background: var(--accent-dim); }
.wb-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.srv-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; margin: 1px 6px; border-radius: 7px;
  cursor: pointer; color: var(--text-dim); font-size: 12.5px;
}
.srv-item:hover { background: var(--bg-card-hover); color: var(--text); }
.srv-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srv-item .tag { font-size: 10px; padding: 1px 6px; border-radius: 99px; background: var(--accent-dim); color: var(--accent); }
.srv-item .tag.prod { background: var(--red-dim); color: var(--red); }

.term-tabs {
  display: flex; align-items: center; gap: 4px; padding: 4px 8px 0;
  border-bottom: 1px solid var(--border); background: var(--bg-input);
  overflow-x: auto;
}
.term-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; border: 1px solid var(--border); border-bottom: none;
  border-radius: 7px 7px 0 0; cursor: pointer; font-size: 12px;
  color: var(--text-dim); background: var(--bg-card);
}
.term-tab.active { color: var(--text); background: var(--bg-code); border-color: var(--border-strong); }
.term-host { flex: 1; min-height: 0; padding: 4px 6px; background: var(--bg-code); position: relative; }
.term-host > div { height: 100%; }
.term-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 12.5px; }
.wb-mini {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11.5px; padding: 2px 8px; cursor: pointer; font-family: inherit;
}
.wb-mini:hover { color: var(--accent); border-color: var(--accent); }
.wb-mini.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

/* SFTP */
.sftp-panel { border-left: 1px solid var(--border); display: flex; flex-direction: column; position: relative; flex-shrink: 0; min-width: 0; }
.wb-drag-h { position: absolute; left: -3px; top: 0; bottom: 0; width: 7px; cursor: ew-resize; z-index: 10; }
.wb-drag-h:hover { background: var(--accent-dim); }
.sftp-head { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border); align-items: center; }
.sftp-path {
  flex: 1; min-width: 0; font-size: 12px; font-family: var(--mono);
  padding: 3px 8px; border-radius: 6px;
}
.sftp-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.sftp-item {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 10px; font-size: 12px; cursor: pointer; color: var(--text-dim);
  font-family: var(--mono);
}
.sftp-item:hover { background: var(--bg-card-hover); color: var(--text); }
.sftp-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sftp-item .size { color: var(--text-faint); font-size: 11px; }
</style>
