<template>
  <div class="ed-root" :data-doc-id="activeTab ? activeTab.id : ''" @keydown="onRootKey">
    <!-- 菜单栏 -->
    <div class="ed-menubar">
      <div v-for="m in menus" :key="m.id" class="ed-menu">
        <button class="ed-menu-title" :class="{ open: menuOpen === m.id }" @click.stop="toggleMenu(m.id)">{{ m.label }}</button>
        <div v-if="menuOpen === m.id" class="ed-menu-pop" @click.stop>
          <template v-for="(it, i) in m.items" :key="i">
            <div v-if="it.sep" class="ed-menu-sep"></div>
            <div
              v-else
              class="ed-menu-item"
              :class="{ disabled: it.disabled }"
              @click="runItem(it)"
            >
              <span class="chk">{{ it.checked ? '✓' : '' }}</span>
              <span class="lbl">{{ it.label }}</span>
              <span class="hint">{{ it.hint }}</span>
            </div>
          </template>
        </div>
      </div>
      <span class="spacer"></span>
      <button class="ed-quick" :class="{ on: edState.workspaceOpen }" :title="edState.workspaceOpen ? '隐藏文件夹树' : '打开文件夹树'" @click="toggleWorkspace">▤</button>
      <button class="ed-quick" title="查找 (Ctrl+F)" @click="openFind(false)">⌕</button>
      <button class="ed-quick" title="保存 (Ctrl+S)" :disabled="!activeTab || activeTab.readOnly" @click="save()">⌸</button>
      <!-- 选中文本的 AI：固定在右上角；有选区时高亮，点它针对选中的那段提问 -->
      <button
        class="ed-quick ed-ai-quick"
        :class="{ on: selReady, busy: edAi.streaming || edAi.open }"
        :title="selReady ? '针对选中的文本提问' : '先在编辑区选中一段文本，再点这里提问；没选中时点它看历史会话'"
        @mousedown.prevent
        @click="openAiForSelection"
      >
        ✦<i v-if="selReady" class="ed-ai-dot"></i>
      </button>
    </div>

    <!-- 编辑区 -->
    <div class="ed-body" @wheel.ctrl.prevent="onWheelZoom">
      <!-- 左侧文件夹树（对应 Notepad++ 的 Folder as Workspace） -->
      <WorkspaceTree
        v-if="edState.workspaceOpen && edState.workspaceRoot"
        :root="edState.workspaceRoot"
        :roots="edState.workspaceRoots"
        :active-path="activeTab?.path || null"
        @open="onTreeOpen"
        @ai="pickFilesForAi"
        @close="closeWorkspace"
        @switch-root="switchWorkspace"
        @add-root="openWorkspace"
        @remove-root="removeWorkspace"
      />

      <div class="ed-main">
        <!-- 标签页：位于编辑区上方（文件夹树独占左侧整列高度） -->
        <div class="ed-tabs" v-if="edState.tabs.length">
          <div
            v-for="t in edState.tabs"
            :key="t.id"
            class="ed-tab"
            :class="{ active: t.id === edState.activeId }"
            :title="t.path || t.name"
            @click="activate(t)"
            @mousedown.middle.prevent="closeTab(t)"
          >
            <span class="ed-tab-dot" :class="{ dirty: t.dirty }">●</span>
            <span class="ed-tab-name">{{ t.name }}</span>
            <span v-if="t.readOnly" class="ed-tab-ro">RO</span>
            <button class="ed-tab-x" title="关闭 (Ctrl+W)" @click.stop="closeTab(t)">×</button>
          </div>
          <button class="ed-tab-add" title="新建 (Ctrl+N)" @click="newFile()">＋</button>
          <span class="spacer"></span>
          <div v-if="isMarkdown" class="ed-md-switch" title="Markdown 显示方式（Ctrl+Shift+M 切换预览）">
            <button :class="{ on: edState.mdView === 'off' }" title="只看源码" @click="setMdView('off')">源码</button>
            <button :class="{ on: edState.mdView === 'live' }" title="即时渲染：边看排版边编辑（Typora 式）" @click="setMdView('live')">即时</button>
            <button :class="{ on: edState.mdView === 'preview' }" title="整页渲染预览" @click="setMdView('preview')">预览</button>
            <button :class="{ on: edState.mdView === 'split' }" title="左侧编辑、右侧预览" @click="setMdView('split')">分屏</button>
          </div>
          <span v-if="activeTab?.dirty" class="ed-tabs-hint">未保存</span>
        </div>

      <div v-if="!activeTab" class="ed-welcome">
        <div class="wl-icon">✎</div>
        <div class="wl-title">文本编辑器</div>
        <div class="wl-sub">Notepad++ 式多标签编辑 · 支持超大文件（按需加载，200MB 日志秒开）</div>
        <div class="wl-actions">
          <button class="btn primary" @click="newFile()">新建文件</button>
          <button class="btn" @click="openFiles()">打开文件…</button>
          <button class="btn" @click="pickWorkspace()">打开文件夹…</button>
          <button class="btn ghost" @click="openFolderAsWorkspace()">在文件夹中查找…</button>
        </div>
        <div class="wl-recents" v-if="edState.recents.length">
          <div class="wl-recents-head">
            <span>最近打开</span>
            <button class="link" @click="clearRecents">清空</button>
          </div>
          <div
            v-for="r in edState.recents.slice(0, 12)"
            :key="r.path"
            class="wl-recent"
            :title="r.path"
            @click="openPath(r.path)"
          >
            <span class="wl-recent-name">{{ r.name }}</span>
            <span class="wl-recent-path">{{ r.path }}</span>
          </div>
        </div>
      </div>

      <template v-else>
        <!-- Markdown 格式快捷栏：只在源码/分屏下显示，作用于当前选区或光标行 -->
        <div v-if="isMarkdown && edState.mdView !== 'preview'" class="ed-md-bar">
          <span class="mdb-label">Markdown</span>
          <button class="mdb" title="粗体 (Ctrl+B)" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('bold')"><b>B</b></button>
          <button class="mdb" title="斜体 (Ctrl+I)" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('italic')"><i>I</i></button>
          <button class="mdb" title="删除线" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('strike')"><s>S</s></button>
          <button class="mdb" title="行内代码" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('code')">&lt;/&gt;</button>
          <span class="mdb-sep"></span>
          <button class="mdb" title="标题 1 (Ctrl+1)" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('h1')">H1</button>
          <button class="mdb" title="标题 2 (Ctrl+2)" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('h2')">H2</button>
          <button class="mdb" title="标题 3 (Ctrl+3)" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('h3')">H3</button>
          <span class="mdb-sep"></span>
          <button class="mdb" title="无序列表" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('ul')">• 列表</button>
          <button class="mdb" title="有序列表" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('ol')">1. 列表</button>
          <button class="mdb" title="任务列表" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('task')">☑ 任务</button>
          <button class="mdb" title="引用" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('quote')">❝ 引用</button>
          <span class="mdb-sep"></span>
          <button class="mdb" title="链接 (Ctrl+K)" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('link')">链接</button>
          <button class="mdb" title="图片" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('image')">图片</button>
          <button class="mdb" title="代码块" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('codeblock')">{ } 代码块</button>
          <button class="mdb" title="表格" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('table')">▦ 表格</button>
          <button class="mdb" title="分隔线" :disabled="!canEdit" @mousedown.prevent @click="mdFormat('hr')">― 分隔线</button>
          <span class="spacer"></span>
          <button class="mdb view" @mousedown.prevent :title="edState.mdView === 'split' ? '退出分屏预览' : '左右分屏预览'" @click="toggleMdSplit()">
            {{ edState.mdView === 'split' ? '退出分屏' : '分屏预览' }}
          </button>
        </div>

        <div class="ed-edit-area" :class="{ split: mdSplit }">
          <div class="ed-edit-pane" v-show="!(isMarkdown && (edState.mdView === 'preview' || edState.mdView === 'live'))">
            <div v-if="activeTab.readOnly" class="ed-banner">
              <span>大文件模式 · {{ fmtSize(activeTab.size) }} · 按需加载可视区（滚动/查找不占内存）</span>
              <span style="flex: 1"></span>
              <button class="link" @click="forceFull">载入完整内容以编辑</button>
            </div>
            <EditorCore
              ref="coreRef"
              :tab="activeTab"
              :font-size="edState.fontSize"
              :show-line-numbers="edState.view.lineNumbers"
              :show-invisibles="edState.view.invisibles"
              :highlight-current-line="edState.view.curLine"
              :match-brackets="edState.view.brackets"
              :auto-close="edState.autoClose"
              :tab-size="edState.tabSize"
              :use-spaces="edState.useSpaces"
              :active="true"
              @change="onDocChange"
              @cmd="onCmd"
              @contextmenu="openCtx"
            />
          </div>
          <div v-if="mdLive" class="ed-wys-pane">
            <div v-if="activeTab.readOnly || mdLiveTooBig" class="md-ro-hint">
              {{ activeTab.readOnly
                ? '大文件只读模式暂不支持即时渲染。点上方横幅「载入完整内容以编辑」后即可使用。'
                : '文件较大（超过 150 万字符），即时渲染会明显变慢，已停用；请切回「源码」编辑。' }}
            </div>
            <MarkdownWysiwyg
              v-else
              ref="liveRef"
              :tab="activeTab"
              :font-size="edState.fontSize"
              :patch="patchLines"
            />
          </div>
          <div v-if="isMarkdown && (edState.mdView === 'preview' || edState.mdView === 'split')" class="ed-preview-pane">
            <div v-if="activeTab.readOnly" class="md-ro-hint">
              大文件只读模式暂不提供预览。点上方横幅「载入完整内容以编辑」后即可预览。
            </div>
            <MarkdownPreview v-else :content="mdSource" :font-size="edState.fontSize" />
          </div>
        </div>
      </template>
      </div>

      <!-- 重开编码 / 整篇载入 的进度层（同步重建文档前先绘制，避免看起来卡死） -->
      <div v-if="busyText" class="ed-busy">
        <span class="spinner"></span>
        <span>{{ busyText }}</span>
      </div>

      <!-- 查找 / 替换 -->
      <div v-if="edState.findOpen && activeTab" class="ed-find-panel" @keydown.stop>
        <div class="fp-head">
          <span>{{ edState.replaceMode ? '替换' : '查找' }}</span>
          <span class="spacer"></span>
          <span class="fp-count">{{ findCountText }}</span>
          <button class="fp-x" title="关闭 (Esc)" @click="closeFind">✕</button>
        </div>
        <div class="fp-row">
          <input
            ref="findInputEl"
            v-model="edState.query"
            placeholder="查找内容"
            @input="onQueryInput"
            @keydown.enter.prevent="findNext(1)"
          />
          <button class="fp-btn" title="查找上一个 (Shift+F3)" @click="findNext(-1)">↑</button>
          <button class="fp-btn" title="查找下一个 (F3)" @click="findNext(1)">↓</button>
        </div>
        <div v-if="edState.replaceMode" class="fp-row">
          <input v-model="edState.replacement" placeholder="替换为（正则支持 $1）" @keydown.enter.prevent="replaceOne" />
          <button class="fp-btn wide" :disabled="activeTab.readOnly" @click="replaceOne">替换</button>
          <button class="fp-btn wide" :disabled="activeTab.readOnly" @click="replaceAll">全部替换</button>
        </div>
        <div class="fp-opts">
          <label><input type="checkbox" v-model="edState.matchCase" @change="onOptChange" />区分大小写</label>
          <label><input type="checkbox" v-model="edState.wholeWord" @change="onOptChange" />全字</label>
          <label><input type="checkbox" v-model="edState.regex" @change="onOptChange" />正则</label>
          <label><input type="checkbox" v-model="wrapSearch" />循环</label>
          <span class="spacer"></span>
          <button class="link" @click="findAllInDoc">全部查找</button>
        </div>
      </div>

      <!-- 右键菜单 -->
      <div v-if="ctx" class="ed-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
        <div class="ed-ctx-item" @click="ctxAction('undo')">撤销<span>Ctrl+Z</span></div>
        <div class="ed-ctx-item" @click="ctxAction('redo')">重做<span>Ctrl+Y</span></div>
        <div class="ed-ctx-sep"></div>
        <div class="ed-ctx-item" @click="ctxAction('cut')">剪切<span>Ctrl+X</span></div>
        <div class="ed-ctx-item" @click="ctxAction('copy')">复制<span>Ctrl+C</span></div>
        <div class="ed-ctx-item" @click="ctxAction('paste')">粘贴<span>Ctrl+V</span></div>
        <div class="ed-ctx-sep"></div>
        <div class="ed-ctx-item" @click="ctxAction('selectAll')">全选<span>Ctrl+A</span></div>
        <div class="ed-ctx-item" @click="ctxAction('goto')">转到行…<span>Ctrl+G</span></div>
        <div class="ed-ctx-item" @click="ctxAction('find')">查找<span>Ctrl+F</span></div>
      </div>

      <!-- 保存询问 -->
      <div v-if="closeAsk" class="ed-mask" @click.self="closeAsk = null">
        <div class="ed-dialog">
          <h3>保存文件？</h3>
          <p>「{{ closeAsk.name }}」有未保存的修改。</p>
          <div class="ed-dialog-actions">
            <button class="btn" @click="closeAsk = null">取消</button>
            <button class="btn danger-outline" @click="discardAndClose">不保存</button>
            <button class="btn primary" @click="saveAndClose">保存</button>
          </div>
        </div>
      </div>

      <!-- 转到行 -->
      <div v-if="gotoOpen" class="ed-mask" @click.self="gotoOpen = false">
        <div class="ed-dialog small">
          <h3>转到行</h3>
          <input ref="gotoInputEl" v-model="gotoText" placeholder="行号，或 行号:列号（如 120:8）" @keydown.enter="doGoto" />
          <div class="ed-dialog-actions">
            <button class="btn" @click="gotoOpen = false">取消</button>
            <button class="btn primary" @click="doGoto">跳转</button>
          </div>
        </div>
      </div>

      <!-- 在文件夹中查找 -->
      <div v-if="sif.open" class="ed-mask" @click.self="sif.open = false">
        <div class="ed-dialog">
          <h3>在文件夹中查找</h3>
          <label>文件夹</label>
          <div class="row">
            <input v-model="sif.dir" readonly placeholder="选择要搜索的文件夹" />
            <button class="btn" @click="pickFolder">选择…</button>
          </div>
          <label>文件名过滤</label>
          <input v-model="sif.pattern" placeholder="*.sql;*.log;*.*" />
          <label>查找内容</label>
          <input ref="sifInputEl" v-model="sif.query" placeholder="要查找的文本或正则" @keydown.enter="runFindInFiles" />
          <div class="fp-opts" style="margin-top: 8px">
            <label><input type="checkbox" v-model="sif.matchCase" />区分大小写</label>
            <label><input type="checkbox" v-model="sif.wholeWord" />全字</label>
            <label><input type="checkbox" v-model="sif.regex" />正则</label>
            <label><input type="checkbox" v-model="sif.subdirs" />包含子目录</label>
          </div>
          <div class="ed-dialog-actions">
            <button class="btn" @click="sif.open = false">取消</button>
            <button class="btn primary" :disabled="sif.busy" @click="runFindInFiles">{{ sif.busy ? '查找中…' : '查找' }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 查找结果面板 -->
    <div v-if="edState.results.open" class="ed-results">
      <div class="res-head">
        <span>查找结果 · {{ edState.results.query }}</span>
        <span class="res-meta">
          {{ edState.results.busy ? '搜索中…' : `${edState.results.hits.length} 条命中 · ${edState.results.files} 个文件${edState.results.truncated ? '（已截断）' : ''}` }}
        </span>
        <span class="spacer"></span>
        <button class="icon-btn" title="关闭" @click="edState.results.open = false">✕</button>
      </div>
      <div class="res-list">
        <div v-if="edState.results.error" class="res-empty">{{ edState.results.error }}</div>
        <div v-else-if="!edState.results.hits.length && !edState.results.busy" class="res-empty">没有命中</div>
        <div
          v-for="(h, i) in edState.results.hits.slice(0, 3000)"
          :key="i"
          class="res-item"
          :title="h.file"
          @click="openHit(h)"
        >
          <span class="res-file">{{ h.rel }}</span>
          <span class="res-ln">{{ h.line }}:{{ h.col }}</span>
          <span class="res-text">{{ h.text }}</span>
        </div>
      </div>
    </div>

    <!-- 状态栏 -->
    <div class="ed-status" v-if="activeTab">
      <span class="st-item">Ln {{ activeTab.caret.line + 1 }}, Col {{ activeTab.caret.col + 1 }}</span>
      <span v-if="selLenText" class="st-item">{{ selLenText }}</span>
      <span class="spacer"></span>
      <span class="st-item">长度 {{ activeTab.mode === 'full' ? activeTab.charCount.toLocaleString() : '—' }}</span>
      <span class="st-item">行数 {{ activeTab.lineCount.toLocaleString() }}</span>
      <span class="st-item">{{ encLabel(activeTab.encoding) }}</span>
      <span class="st-item clickable" title="点击切换换行符" @click="cycleEol">{{ activeTab.eol }}</span>
      <span class="st-item">{{ langLabel(activeTab.langId) }}</span>
      <span class="st-item clickable" title="Ctrl+滚轮缩放；Ctrl+0 重置" @click="resetZoom">{{ Math.round(activeTab.zoom * 100) }}%</span>
      <span class="st-item clickable" title="插入/覆盖（Insert）" @click="activeTab.overtype = !activeTab.overtype">{{ activeTab.overtype ? 'OVR' : 'INS' }}</span>
      <span v-if="activeTab.readOnly" class="st-item ro">只读</span>
    </div>
    <div class="ed-status" v-else>
      <span class="st-item">就绪</span>
      <span class="spacer"></span>
      <span class="st-item">{{ edState.tabs.length }} 个文档</span>
    </div>

    <!-- 选中文本的 AI 问答浮窗 -->
    <EditorAiPanel v-if="edAi.open" />
    <!-- 选择文件问 AI（可多选）：文件夹树文件行的 ✦ / 浮窗顶栏「文件」都从这里进 -->
    <EditorAiFilePick
      v-if="edAi.pickerOpen"
      :root="edState.workspaceRoot"
      :extra="openedTabFiles"
      @warn="toast"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import EditorCore from './editor/EditorCore.vue'
import WorkspaceTree from './editor/WorkspaceTree.vue'
import MarkdownPreview from './editor/MarkdownPreview.vue'
import MarkdownWysiwyg from './editor/MarkdownWysiwyg.vue'
import EditorAiPanel from './editor/EditorAiPanel.vue'
import EditorAiFilePick from './editor/EditorAiFilePick.vue'
import { edState, activeTab as getActiveTab, removeTab, savePrefs } from '../editor/session'
import { createTab, maxLineLengthOf, type Tab } from '../editor/types'
import { detectLang, LANG_MENU, langById } from '../editor/langs'
import { edAi, initEditorAi, openEditorAi, openEditorAiHistory, openEditorAiPicker, toggleEditorAiHistory } from '../editor/ai'
import { LineDoc, UndoStack, selEnd, selStart } from '../editor/model'
import { HighlightCache } from '../editor/highlight'
import { SearchMatcher } from '../editor/search'
import { pushNotice as toast } from '../store'

interface MenuItem {
  label?: string
  hint?: string
  action?: () => void
  checked?: boolean
  sep?: boolean
  disabled?: boolean
}

const coreRef = ref<any>(null)
const activeTab = computed(() => getActiveTab())
const menuOpen = ref<string | null>(null)
const ctx = ref<{ x: number; y: number } | null>(null)
const closeAsk = ref<Tab | null>(null)
const gotoOpen = ref(false)
const gotoText = ref('1')
const gotoInputEl = ref<HTMLInputElement | null>(null)
const findInputEl = ref<HTMLInputElement | null>(null)
const wrapSearch = ref(true)
const busyText = ref('')

// ---------------- Markdown：显示方式 + 格式快捷 ----------------
const isMarkdown = computed(() => activeTab.value?.langId === 'markdown')
const mdSplit = computed(() => isMarkdown.value && edState.mdView === 'split')
/** 即时渲染（Typora 式）：整篇渲染，点到哪块哪块变源码 */
const mdLive = computed(() => isMarkdown.value && edState.mdView === 'live')
/** 超大 Markdown 不做即时渲染（每次编辑都要重新切块，会明显卡顿） */
const mdLiveTooBig = computed(() => mdLive.value && (activeTab.value?.charCount || 0) > 1_500_000)
const liveRef = ref<any>(null)
/** 预览内容（源码文本，按需重建；切标签/编辑/切视图都会刷新） */
const mdSource = ref('')
let mdTimer = 0
const MD_PREVIEW_MAX = 2_000_000

function docTextLimited(t: Tab, max: number): string {
  const doc = t.doc
  if (!doc) return ''
  if (doc.charCount <= max) return doc.toText()
  const out: string[] = []
  let n = 0
  for (let i = 0; i < doc.lineCount && n < max; i++) {
    const l = doc.line(i)
    out.push(l)
    n += l.length + 1
  }
  return out.join('\n')
}

function refreshMdSource(): void {
  const t = activeTab.value
  const on = !!t && t.langId === 'markdown' && edState.mdView !== 'off'
  if (!on || !t || t.mode !== 'full' || !t.doc) { mdSource.value = ''; return }
  mdSource.value = docTextLimited(t, MD_PREVIEW_MAX)
}

function scheduleMdRefresh(): void {
  if (mdTimer) { clearTimeout(mdTimer); mdTimer = 0 }
  mdTimer = window.setTimeout(() => { mdTimer = 0; refreshMdSource() }, 200)
}

watch(
  () => [activeTab.value?.id, activeTab.value?.rev, activeTab.value?.langId, edState.mdView] as const,
  () => {
    if (!isMarkdown.value || edState.mdView === 'off') { mdSource.value = ''; return }
    if (edState.mdView === 'preview' || edState.mdView === 'split') scheduleMdRefresh()
  }
)

function setMdView(v: 'off' | 'live' | 'preview' | 'split'): void {
  if (v !== 'off' && !isMarkdown.value) {
    toast('仅 Markdown 文件支持预览；其他文件可在「语言」菜单切到 Markdown')
    return
  }
  edState.mdView = v
  savePrefs()
  if (v === 'off') mdSource.value = ''
  else refreshMdSource()
  nextTick(() => {
    if (v === 'off' || v === 'split') coreRef.value?.focus()
  })
}

function toggleMdPreview(): void {
  if (!isMarkdown.value) {
    toast('仅 Markdown 文件支持预览；其他文件可在「语言」菜单切到 Markdown')
    return
  }
  setMdView(edState.mdView === 'preview' ? 'off' : 'preview')
}

function toggleMdSplit(): void {
  if (!isMarkdown.value) {
    toast('仅 Markdown 文件支持预览；其他文件可在「语言」菜单切到 Markdown')
    return
  }
  setMdView(edState.mdView === 'split' ? 'off' : 'split')
}

function mdFormat(kind: string): void {
  if (!isMarkdown.value) return
  if (!canEdit.value) { toast('大文件只读模式不能编辑，请先「载入完整内容以编辑」'); return }
  if (mdLive.value) {
    if (!liveRef.value?.hasActive()) { toast('先在渲染区点一下要编辑的那一行，再设置格式'); return }
    liveRef.value.applyFormat(kind)
    return
  }
  coreRef.value?.mdFormat(kind)
  if (edState.mdView === 'preview' || edState.mdView === 'split') scheduleMdRefresh()
}

/** 即时渲染提交一个块：由内核按行替换（可撤销） */
function patchLines(start: number, del: number, lines: string[]): void {
  coreRef.value?.replaceLines(start, del, lines)
}
const matchCount = ref<number | null>(null)
const countCapped = ref(false)
const sifInputEl = ref<HTMLInputElement | null>(null)

const sif = reactive({
  open: false,
  dir: '',
  pattern: '*.*',
  query: '',
  matchCase: false,
  wholeWord: false,
  regex: false,
  subdirs: true,
  busy: false
})

let countTimer: ReturnType<typeof setTimeout> | null = null

const ENC_LABELS: Record<string, string> = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  utf16le: 'UTF-16 LE',
  utf16be: 'UTF-16 BE',
  gbk: 'GBK',
  gb18030: 'GB18030',
  big5: 'BIG5',
  latin1: 'ANSI'
}

function encLabel(e: string): string {
  return ENC_LABELS[e] || e
}

function langLabel(id: string): string {
  return langById(id).label
}

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// ---------------- 菜单 ----------------
function toggleMenu(id: string): void {
  menuOpen.value = menuOpen.value === id ? null : id
}

function runItem(it: MenuItem): void {
  if (it.disabled) return
  menuOpen.value = null
  it.action?.()
  // 菜单按钮会抢走焦点：动作结束后把焦点交还编辑区（弹窗动作会自行聚焦输入框）
  nextTick(() => {
    if (activeTab.value && !document.querySelector('.ed-mask')) coreRef.value?.focus()
  })
}

const hasTab = computed(() => !!activeTab.value)
const canEdit = computed(() => !!activeTab.value && !activeTab.value.readOnly)

function menuItemsFile(): MenuItem[] {
  return [
    { label: '新建', hint: 'Ctrl+N', action: newFile },
    { label: '打开…', hint: 'Ctrl+O', action: openFiles },
    { label: '打开文件夹…', hint: '', action: () => pickWorkspace() },
    { label: '关闭文件夹树', action: closeWorkspace, disabled: !edState.workspaceOpen },
    { label: '在文件夹中查找…', hint: 'Ctrl+Shift+F', action: () => openSif() },
    { sep: true },
    { label: '保存', hint: 'Ctrl+S', action: () => save(), disabled: !canEdit.value },
    { label: '另存为…', hint: 'Ctrl+Shift+S', action: () => saveAs(), disabled: !canEdit.value },
    { label: '全部保存', hint: '', action: saveAll },
    { sep: true },
    { label: '重新载入', hint: '', action: reload, disabled: !hasTab.value || !activeTab.value?.path },
    { label: '在资源管理器中显示', hint: '', action: showInFolder, disabled: !activeTab.value?.path },
    { sep: true },
    { label: '关闭', hint: 'Ctrl+W', action: () => activeTab.value && closeTab(activeTab.value), disabled: !hasTab.value },
    { label: '关闭全部', hint: '', action: closeAll, disabled: !hasTab.value }
  ]
}

function menuItemsEdit(): MenuItem[] {
  return [
    { label: '撤销', hint: 'Ctrl+Z', action: () => coreRef.value?.exec('undo'), disabled: !canEdit.value },
    { label: '重做', hint: 'Ctrl+Y', action: () => coreRef.value?.exec('redo'), disabled: !canEdit.value },
    { sep: true },
    { label: '剪切', hint: 'Ctrl+X', action: () => coreRef.value?.exec('cut') },
    { label: '复制', hint: 'Ctrl+C', action: () => coreRef.value?.exec('copy') },
    { label: '粘贴', hint: 'Ctrl+V', action: () => coreRef.value?.exec('paste'), disabled: !canEdit.value },
    { label: '删除', hint: 'Del', action: () => coreRef.value?.exec('delete'), disabled: !canEdit.value },
    { label: '全选', hint: 'Ctrl+A', action: () => coreRef.value?.exec('selectAll') },
    { sep: true },
    { label: '复制当前行', hint: 'Ctrl+D', action: () => coreRef.value?.exec('duplicate'), disabled: !canEdit.value },
    { label: '删除当前行', hint: 'Ctrl+L', action: () => coreRef.value?.exec('deleteLine'), disabled: !canEdit.value },
    { label: '上移当前行', hint: 'Ctrl+Shift+↑', action: () => coreRef.value?.exec('moveUp'), disabled: !canEdit.value },
    { label: '下移当前行', hint: 'Ctrl+Shift+↓', action: () => coreRef.value?.exec('moveDown'), disabled: !canEdit.value },
    { sep: true },
    { label: '切换行注释', hint: 'Ctrl+Q', action: () => coreRef.value?.exec('comment'), disabled: !canEdit.value },
    { label: '增加缩进', hint: 'Tab', action: () => coreRef.value?.exec('indent'), disabled: !canEdit.value },
    { label: '减少缩进', hint: 'Shift+Tab', action: () => coreRef.value?.exec('outdent'), disabled: !canEdit.value },
    { label: '转为大写', hint: 'Ctrl+U', action: () => coreRef.value?.exec('upper'), disabled: !canEdit.value },
    { label: '转为小写', hint: 'Ctrl+Shift+U', action: () => coreRef.value?.exec('lower'), disabled: !canEdit.value },
    { sep: true },
    { label: '切换书签', hint: 'Ctrl+F2', action: () => coreRef.value?.exec('bookmark') },
    { label: '下一个书签', hint: 'F2', action: () => coreRef.value?.exec('nextBookmark') }
  ]
}

function menuItemsSearch(): MenuItem[] {
  return [
    { label: '查找…', hint: 'Ctrl+F', action: () => openFind(false) },
    { label: '替换…', hint: 'Ctrl+H', action: () => openFind(true), disabled: !canEdit.value },
    { label: '查找下一个', hint: 'F3', action: () => findNext(1) },
    { label: '查找上一个', hint: 'Shift+F3', action: () => findNext(-1) },
    { sep: true },
    { label: '转到行…', hint: 'Ctrl+G', action: openGoto },
    { label: '在文件夹中查找…', hint: 'Ctrl+Shift+F', action: () => openSif() },
    { sep: true },
    { label: '清除查找标记', hint: '', action: clearFindMarks }
  ]
}

function menuItemsView(): MenuItem[] {
  return [
    { label: '文件夹树', action: toggleWorkspace, checked: edState.workspaceOpen },
    { label: 'Markdown 即时渲染', action: () => setMdView(edState.mdView === 'live' ? 'off' : 'live'), checked: isMarkdown.value && edState.mdView === 'live', disabled: !isMarkdown.value },
    { label: 'Markdown 整页预览', hint: 'Ctrl+Shift+M', action: toggleMdPreview, checked: isMarkdown.value && edState.mdView === 'preview', disabled: !isMarkdown.value },
    { label: 'Markdown 分屏预览', action: toggleMdSplit, checked: isMarkdown.value && edState.mdView === 'split', disabled: !isMarkdown.value },
    { sep: true },
    { label: '显示行号', action: () => { edState.view.lineNumbers = !edState.view.lineNumbers; savePrefs() }, checked: edState.view.lineNumbers },
    { label: '自动换行', hint: 'Ctrl+Alt+W', action: toggleWrap, checked: !!activeTab.value?.wrap },
    { label: '显示空白字符', action: () => { edState.view.invisibles = !edState.view.invisibles; savePrefs() }, checked: edState.view.invisibles },
    { label: '高亮当前行', action: () => { edState.view.curLine = !edState.view.curLine; savePrefs() }, checked: edState.view.curLine },
    { label: '括号匹配', action: () => { edState.view.brackets = !edState.view.brackets; savePrefs() }, checked: edState.view.brackets },
    { sep: true },
    { label: '放大', hint: 'Ctrl+= / Ctrl+滚轮', action: () => zoomBy(0.1) },
    { label: '缩小', hint: 'Ctrl+-', action: () => zoomBy(-0.1) },
    { label: '重置缩放', hint: 'Ctrl+0', action: resetZoom },
    { sep: true },
    { label: 'Tab 使用空格', action: () => { edState.useSpaces = !edState.useSpaces; savePrefs() }, checked: edState.useSpaces },
    { label: 'Tab 宽度 4', action: () => { edState.tabSize = edState.tabSize === 4 ? 2 : 4; savePrefs() }, checked: edState.tabSize === 4 },
    { label: '自动闭合括号/引号', action: () => { edState.autoClose = !edState.autoClose; savePrefs() }, checked: edState.autoClose }
  ]
}

function menuItemsEncoding(): MenuItem[] {
  const list: MenuItem[] = []
  for (const e of ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'gbk', 'gb18030', 'big5', 'latin1']) {
    list.push({
      label: encLabel(e),
      checked: activeTab.value?.encoding === e,
      action: () => convertEncoding(e as any),
      disabled: !canEdit.value || !!activeTab.value?.busy
    })
  }
  list.push({ sep: true })
  for (const e of ['utf8', 'gbk', 'gb18030', 'utf16le', 'utf16be', 'big5', 'latin1']) {
    list.push({ label: `以 ${encLabel(e)} 重新打开`, action: () => reopenWith(e as any), disabled: !activeTab.value?.path || !!activeTab.value?.busy })
  }
  return list
}

function menuItemsEol(): MenuItem[] {
  return [
    { label: 'Windows (CRLF)', checked: activeTab.value?.eol === 'CRLF', action: () => setEol('CRLF') },
    { label: 'Unix (LF)', checked: activeTab.value?.eol === 'LF', action: () => setEol('LF') },
    { label: 'Macintosh (CR)', checked: activeTab.value?.eol === 'CR', action: () => setEol('CR') }
  ]
}

function menuItemsMarkdown(): MenuItem[] {
  const off = !canEdit.value
  const it = (label: string, kind: string, hint = ''): MenuItem => ({ label, hint, action: () => mdFormat(kind), disabled: off })
  return [
    it('标题 1', 'h1', 'Ctrl+1'),
    it('标题 2', 'h2', 'Ctrl+2'),
    it('标题 3', 'h3', 'Ctrl+3'),
    it('标题 4', 'h4', 'Ctrl+4'),
    it('标题 5', 'h5', 'Ctrl+5'),
    it('标题 6', 'h6', 'Ctrl+6'),
    { sep: true },
    it('加粗', 'bold', 'Ctrl+B'),
    it('斜体', 'italic', 'Ctrl+I'),
    it('删除线', 'strike', ''),
    it('行内代码', 'code', ''),
    { sep: true },
    it('无序列表', 'ul', ''),
    it('有序列表', 'ol', ''),
    it('任务列表', 'task', ''),
    it('引用', 'quote', ''),
    { sep: true },
    it('链接…', 'link', 'Ctrl+K'),
    it('图片…', 'image', ''),
    it('代码块', 'codeblock', ''),
    it('表格', 'table', ''),
    it('分隔线', 'hr', ''),
    { sep: true },
    { label: '即时渲染（Typora 式）', hint: '', action: () => setMdView(edState.mdView === 'live' ? 'off' : 'live'), checked: edState.mdView === 'live' },
    { label: '整页预览', hint: 'Ctrl+Shift+M', action: toggleMdPreview, checked: edState.mdView === 'preview' },
    { label: '分屏预览', hint: '', action: toggleMdSplit, checked: edState.mdView === 'split' },
    { label: '只看源码', action: () => setMdView('off'), checked: edState.mdView === 'off' }
  ]
}

const menus = computed(() => [
  { id: 'file', label: '文件', items: menuItemsFile() },
  { id: 'edit', label: '编辑', items: menuItemsEdit() },
  { id: 'search', label: '搜索', items: menuItemsSearch() },
  { id: 'view', label: '视图', items: menuItemsView() },
  { id: 'encoding', label: '编码', items: menuItemsEncoding() },
  { id: 'eol', label: '换行符', items: menuItemsEol() },
  {
    id: 'lang',
    label: '语言',
    items: LANG_MENU.map((l) => ({
      label: l.label,
      checked: activeTab.value?.langId === l.id,
      action: () => setLang(l.id)
    }))
  }
].flatMap((m) => {
  // Markdown 文档多一个「Markdown」菜单（格式 + 预览），其他文件不显示
  if (m.id === 'search' && isMarkdown.value) {
    return [m, { id: 'md', label: 'Markdown', items: menuItemsMarkdown() }]
  }
  return [m]
}))

// ---------------- 文档管理 ----------------
function addDoc(meta: any, goto?: { line: number; col: number }): Tab {
  const existing = edState.tabs.find((t) => t.path && meta.path && t.path.toLowerCase() === String(meta.path).toLowerCase())
  if (existing) {
    edState.activeId = existing.id
    if (goto) navigateTo(existing, goto.line, goto.col)
    return existing
  }
  // 无扩展名/未知扩展名的文件由主进程按内容嗅探语言，其余按扩展名
  const lang = (meta.langHint && langById(meta.langHint).id === meta.langHint) ? meta.langHint : detectLang(meta.path || meta.name)
  const tab = createTab(meta, lang)
  if (edState.view.wrap) tab.wrap = true
  edState.tabs.push(tab)
  edState.activeId = tab.id
  nextTick(() => {
    coreRef.value?.focus()
    if (goto) navigateTo(tab, goto.line, goto.col)
  })
  return tab
}

async function openFiles(): Promise<void> {
  const r = await window.sqlpilot.editorOpenDialog()
  if (r.canceled) return
  if (r.docs) for (const d of r.docs) addDoc(d)
  if (r.errors?.length) toast(r.errors.join('；'))
  if (!r.ok && !r.docs?.length) toast(r.errors?.join('；') || '打开失败')
  loadRecents()
}

async function openPath(path: string, line?: number, col?: number): Promise<void> {
  const r = await window.sqlpilot.editorOpenPath(path)
  if (!r.ok || !r.doc) {
    toast(r.error || '打开失败')
    return
  }
  addDoc(r.doc, line ? { line: line - 1, col: Math.max(0, (col || 1) - 1) } : undefined)
  loadRecents()
}

let untitledSeq = 0
function newFile(): void {
  untitledSeq++
  const name = `未命名${untitledSeq}`
  window.sqlpilot.editorNew(name, 'utf8', 'CRLF').then((meta: any) => {
    addDoc({ ...meta, text: '' })
    nextTick(() => coreRef.value?.focus())
  })
}

function activate(t: Tab): void {
  edState.activeId = t.id
  nextTick(() => coreRef.value?.focus())
}

async function saveTab(t: Tab | null = activeTab.value, forceAs = false): Promise<boolean> {
  if (!t) return false
  if (t.mode !== 'full' || !t.doc) {
    toast('大文件只读模式不能保存，请先「载入完整内容以编辑」')
    return false
  }
  if (!t.path || forceAs) {
    const r = await window.sqlpilot.editorSaveAs(t.id, t.path || t.name)
    if (r.canceled || !r.ok || !r.path) return false
    t.path = r.path
    t.name = r.path.split(/[\\/]/).pop() || t.name
  }
  const text = t.doc.toText()
  const r = await window.sqlpilot.editorSave({
    id: t.id,
    text,
    path: t.path,
    encoding: t.encoding,
    eol: t.eol,
    markRecentLine: { line: t.caret.line, col: t.caret.col }
  })
  if (!r.ok) {
    toast(r.error || '保存失败')
    return false
  }
  t.dirty = false
  t.size = r.doc?.size ?? t.size
  t.rev++
  toast(`已保存 ${t.name}`)
  return true
}

function save(): void {
  if (!canEdit.value) return
  saveTab(activeTab.value)
    .then(() => coreRef.value?.focus())
}

async function saveAs(): Promise<void> {
  if (!canEdit.value) return
  await saveTab(activeTab.value, true)
  coreRef.value?.focus()
}

async function saveAll(): Promise<void> {
  for (const t of edState.tabs) {
    if (t.dirty && t.mode === 'full') await saveTab(t)
  }
}

async function doClose(t: Tab): Promise<void> {
  await window.sqlpilot.editorClose(t.id)
  removeTab(t.id)
  ctx.value = null
}

function closeTab(t: Tab): void {
  if (t.dirty) { closeAsk.value = t; return }
  doClose(t)
}

function discardAndClose(): void {
  const t = closeAsk.value
  closeAsk.value = null
  if (t) doClose(t)
}

async function saveAndClose(): Promise<void> {
  const t = closeAsk.value
  closeAsk.value = null
  if (!t) return
  if (await saveTab(t)) doClose(t)
}

async function closeAll(): Promise<void> {
  const dirty = edState.tabs.filter((t) => t.dirty)
  if (dirty.length) {
    const ok = await window.sqlpilot.uiConfirm(`有 ${dirty.length} 个文件未保存`, '关闭全部文档将丢弃这些修改', true)
    if (!ok) return
  }
  for (const t of [...edState.tabs]) await doClose(t)
}

async function reload(): Promise<void> {
  const t = activeTab.value
  if (!t?.path) return
  if (t.dirty && !(await window.sqlpilot.uiConfirm('重新载入？', '未保存的修改将丢失'))) return
  const r = await window.sqlpilot.editorReopen(t.id, t.encoding)
  if (!r.ok || !r.doc) { toast(r.error || '重新载入失败'); return }
  applyDoc(t, r.doc)
  toast('已重新载入')
}

function applyDoc(t: Tab, meta: any): void {
  if (typeof meta.text === 'string') {
    t.doc = markRaw(new LineDoc(meta.text, meta.eol))
    t.mode = 'full'
    t.readOnly = false
    t.charCount = t.doc.charCount
    t.maxLineLen = maxLineLengthOf(t.doc.lines)
  } else {
    t.doc = null
    t.mode = 'window'
    t.readOnly = true
    t.charCount = 0
    t.win = markRaw({ start: -1, lines: [], total: meta.lineCount })
    t.maxLineLen = 200
  }
  t.lineCount = t.doc ? t.doc.lineCount : meta.lineCount
  t.encoding = meta.encoding
  t.eol = meta.eol
  t.size = meta.size
  t.path = meta.path
  t.name = meta.name
  t.caret = { line: 0, col: 0 }
  t.sel = null
  t.dirty = false
  t.undo = markRaw(new UndoStack())
  const hl = new HighlightCache()
  hl.reset(langById(t.langId), t.lineCount)
  t.hl = markRaw(hl)
  t.rev++
}

async function forceFull(): Promise<void> {
  const t = activeTab.value
  if (!t || t.busy) return
  const ok = await window.sqlpilot.uiConfirm('载入完整内容？', `文件 ${fmtSize(t.size)}，将整篇读入内存以获得编辑能力。`, true)
  if (!ok) return
  t.busy = true
  busyText.value = `正在载入 ${fmtSize(t.size)} 的完整内容…`
  await nextTick()
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  const r = await window.sqlpilot.editorLoadFull(t.id)
  t.busy = false
  busyText.value = ''
  if (!r.ok || typeof r.text !== 'string') { toast(r.error || '载入失败'); return }
  t.doc = markRaw(new LineDoc(r.text, t.eol))
  t.mode = 'full'
  t.readOnly = false
  t.charCount = t.doc.charCount
  t.lineCount = t.doc.lineCount
  t.maxLineLen = maxLineLengthOf(t.doc.lines)
  t.undo = markRaw(new UndoStack())
  const hl = new HighlightCache()
  hl.reset(langById(t.langId), t.lineCount)
  t.hl = markRaw(hl)
  t.dirty = false
  t.rev++
  toast('已载入完整内容，可以编辑')
  nextTick(() => coreRef.value?.focus())
}

function showInFolder(): void {
  const t = activeTab.value
  if (t?.path) window.sqlpilot.showInFolder(t.path)
}

// ---------------- 编码 / EOL / 语言 ----------------
function convertEncoding(enc: any): void {
  const t = activeTab.value
  if (!t) return
  t.encoding = enc
  t.dirty = true
  t.rev++
  toast(`编码设为 ${encLabel(enc)}，保存后生效`)
}

async function reopenWith(enc: any): Promise<void> {
  const t = activeTab.value
  if (!t?.path) return
  if (t.busy) return
  if (t.dirty && !(await window.sqlpilot.uiConfirm('重新打开？', '未保存的修改将丢失'))) return
  t.busy = true
  const wasReadOnly = t.readOnly
  busyText.value = `正在按 ${encLabel(enc)} 重新解码 ${t.name}…`
  // 先让浏览器把进度层画出来，再做后面的同步重建（重建本身不能分片）
  await nextTick()
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  try {
    const r = await window.sqlpilot.editorReopen(t.id, enc)
    if (!r.ok || !r.doc) { toast(r.error || '重新打开失败'); return }
    applyDoc(t, r.doc)
    toast(`已按 ${encLabel(enc)} 重新打开${t.doc ? '' : '（只读窗口模式）'}`)
    if (!wasReadOnly && t.readOnly) {
      toast('文件较大，已切回只读窗口模式；需要编辑请点横幅「载入完整内容以编辑」')
    }
  } finally {
    t.busy = false
    busyText.value = ''
  }
}

function setEol(eol: 'CRLF' | 'LF' | 'CR'): void {
  const t = activeTab.value
  if (!t) return
  t.eol = eol
  t.dirty = true
  t.rev++
  toast(`换行符设为 ${eol}，保存后生效`)
}

function cycleEol(): void {
  const t = activeTab.value
  if (!t) return
  setEol(t.eol === 'CRLF' ? 'LF' : t.eol === 'LF' ? 'CR' : 'CRLF')
}

function setLang(id: string): void {
  const t = activeTab.value
  if (!t) return
  t.langId = id
  const hl = new HighlightCache()
  hl.reset(langById(id), t.lineCount)
  t.hl = markRaw(hl)
  t.rev++
}

// ---------------- 视图 ----------------
function toggleWrap(): void {
  const t = activeTab.value
  if (!t) return
  t.wrap = !t.wrap
  edState.view.wrap = t.wrap
  savePrefs()
  t.rev++
}

function zoomBy(delta: number): void {
  const t = activeTab.value
  if (!t) return
  t.zoom = Math.max(0.5, Math.min(3, Math.round((t.zoom + delta) * 10) / 10))
  t.rev++
}

function resetZoom(): void {
  const t = activeTab.value
  if (t) { t.zoom = 1; t.rev++ }
}

function onWheelZoom(e: WheelEvent): void {
  zoomBy(e.deltaY < 0 ? 0.1 : -0.1)
}

// ---------------- 查找 / 替换 ----------------
const findCountText = computed(() => {
  if (!edState.query) return ''
  if (matchCount.value === null) return ''
  if (matchCount.value === -1) return '命中过多'
  if (matchCount.value === -2) return '正则无效'
  return `${matchCount.value}${countCapped.value ? '+' : ''} 个匹配`
})

function syncFindToTab(t: Tab | null): void {
  if (!t) return
  t.find.query = edState.query
  t.find.matchCase = edState.matchCase
  t.find.wholeWord = edState.wholeWord
  t.find.regex = edState.regex
  t.find.replacement = edState.replacement
  t.rev++
}

function openFind(replace: boolean): void {
  if (!activeTab.value) return
  edState.findOpen = true
  edState.replaceMode = replace && !activeTab.value.readOnly
  syncFindToTab(activeTab.value)
  nextTick(() => {
    findInputEl.value?.focus()
    findInputEl.value?.select()
    scheduleCount()
  })
}

function closeFind(): void {
  edState.findOpen = false
  const t = activeTab.value
  if (t) { t.find.current = null; t.rev++ }
  coreRef.value?.focus()
}

function onQueryInput(): void {
  const t = activeTab.value
  if (t) { t.find.current = null }
  syncFindToTab(t)
  scheduleCount()
}

function onOptChange(): void {
  syncFindToTab(activeTab.value)
  savePrefs()
  scheduleCount()
}

function scheduleCount(): void {
  if (countTimer) clearTimeout(countTimer)
  countTimer = setTimeout(() => { void computeCount() }, 200)
}

let countSeq = 0
async function computeCount(): Promise<void> {
  const t = activeTab.value
  const q = edState.query
  if (!t || !q) { matchCount.value = null; return }
  const seq = ++countSeq
  const opts = { matchCase: edState.matchCase, wholeWord: edState.wholeWord, regex: edState.regex }
  if (t.mode === 'window') {
    // 大文件只统计前 20 万行内的命中（避免为了一个不存在的词扫完整个文件），并丢弃过期结果
    const r = await window.sqlpilot.editorFind(t.id, q, { ...opts, limit: 500, maxScanLines: 200000 })
    if (seq !== countSeq) return
    const n = r.ok ? (r.hits?.length || 0) : -2
    countCapped.value = n >= 500
    matchCount.value = n
    return
  }
  const m = new SearchMatcher(q, opts)
  if (!m.ok) { matchCount.value = -2; return }
  if (t.lineCount > 400000) { matchCount.value = -1; return }
  let n = 0
  for (let i = 0; i < t.lineCount && n < 20000; i++) n += m.all(t.doc!.line(i), 20000 - n).length
  if (seq !== countSeq) return
  countCapped.value = n >= 20000
  matchCount.value = n
}

function currentMatcher(): SearchMatcher | null {
  if (!edState.query) return null
  const m = new SearchMatcher(edState.query, { matchCase: edState.matchCase, wholeWord: edState.wholeWord, regex: edState.regex })
  return m.ok ? m : null
}

async function findNext(dir: 1 | -1): Promise<void> {
  const t = activeTab.value
  if (!t) return
  if (!edState.query) { openFind(false); return }
  syncFindToTab(t)

  if (t.mode === 'window') {
    const r = await window.sqlpilot.editorFind(t.id, edState.query, {
      matchCase: edState.matchCase,
      wholeWord: edState.wholeWord,
      regex: edState.regex,
      fromLine: t.caret.line,
      backward: dir < 0,
      limit: 1
    })
    if (!r.ok) { toast(r.error || '查找失败'); return }
    const hit = r.hits?.[0]
    if (!hit) {
      if (wrapSearch.value) {
        const r2 = await window.sqlpilot.editorFind(t.id, edState.query, {
          matchCase: edState.matchCase, wholeWord: edState.wholeWord, regex: edState.regex,
          fromLine: dir > 0 ? 0 : t.lineCount - 1, backward: dir < 0, limit: 1
        })
        const h2 = r2.hits?.[0]
        if (!h2) { toast('未找到'); return }
        locate(t, h2.line, h2.start, h2.end)
        return
      }
      toast('未找到')
      return
    }
    locate(t, hit.line, hit.start, hit.end)
    return
  }

  const m = currentMatcher()
  if (!m) { toast(m === null ? '正则表达式无效或查找内容为空' : '查找失败'); return }
  let from = { ...t.caret }
  const prev = t.find.current
  if (prev && prev.start === prev.end && prev.line === from.line && prev.start === from.col && from.col < t.doc!.line(from.line).length) {
    from = { line: from.line, col: from.col + 1 }
  }
  const found = searchInDoc(t, m, from, dir)
  if (found) { locate(t, found.line, found.start, found.end); return }
  if (!wrapSearch.value) { toast('未找到'); return }
  const startPos = dir > 0 ? { line: 0, col: 0 } : { line: t.lineCount - 1, col: 1e9 }
  const again = searchInDoc(t, m, startPos, dir)
  if (again) locate(t, again.line, again.start, again.end)
  else toast('未找到')
}

function searchInDoc(t: Tab, m: SearchMatcher, from: { line: number; col: number }, dir: 1 | -1): { line: number; start: number; end: number } | null {
  const total = t.lineCount
  const cap = Math.min(total, 400000)
  for (let k = 0; k < cap; k++) {
    const ln = dir > 0 ? from.line + k : from.line - k
    if (ln < 0 || ln >= total) break
    const text = t.doc!.line(ln)
    if (dir > 0) {
      const h = m.one(text, ln === from.line ? from.col : 0)
      if (h) return { line: ln, ...h }
    } else {
      const hits = m.all(text, 5000)
      const cols = hits.filter((h) => (ln === from.line ? h.start < from.col : true))
      if (cols.length) {
        const h = cols[cols.length - 1]
        return { line: ln, ...h }
      }
    }
  }
  return null
}

function locate(t: Tab, line: number, start: number, end: number): void {
  t.find.current = { line, start, end }
  t.rev++
  if (t.mode === 'window') {
    coreRef.value?.scrollToLine(line, start)
    setTimeout(() => {
      coreRef.value?.setSel({ line, col: start }, { line, col: end })
      coreRef.value?.focus()
    }, 80)
  } else {
    coreRef.value?.setSel({ line, col: start }, { line, col: end })
    coreRef.value?.focus()
  }
}

function findAllInDoc(): void {
  const t = activeTab.value
  if (!t || !edState.query) return
  const m = currentMatcher()
  if (!m) { toast('正则表达式无效'); return }
  const hits: { file: string; rel: string; line: number; col: number; text: string }[] = []
  const limit = 3000
  if (t.mode === 'window') {
    window.sqlpilot.editorFind(t.id, edState.query, {
      matchCase: edState.matchCase, wholeWord: edState.wholeWord, regex: edState.regex, limit
    }).then((r) => {
      if (!r.ok) { toast(r.error || '查找失败'); return }
      for (const h of r.hits || []) hits.push({ file: t.path || t.name, rel: t.name, line: h.line + 1, col: h.start + 1, text: h.text })
      showResults(hits, 1, false)
    })
    return
  }
  for (let i = 0; i < t.lineCount && hits.length < limit; i++) {
    const text = t.doc!.line(i)
    if (!text) continue
    for (const h of m.all(text, 200)) {
      hits.push({ file: t.path || t.name, rel: t.name, line: i + 1, col: h.start + 1, text: text.trim().slice(0, 200) })
      if (hits.length >= limit) break
    }
  }
  showResults(hits, 1, hits.length >= limit)
}

function showResults(hits: any[], files: number, truncated: boolean): void {
  edState.results.open = true
  edState.results.query = edState.query
  edState.results.hits = hits
  edState.results.files = files
  edState.results.truncated = truncated
  edState.results.busy = false
  edState.results.error = ''
}

async function replaceOne(): Promise<void> {
  const t = activeTab.value
  if (!t || t.readOnly) return
  const m = currentMatcher()
  if (!m) { toast('正则表达式无效'); return }
  const cur = t.find.current
  if (!cur) { await findNext(1); return }
  const line = t.doc!.line(cur.line)
  const rep = m.expand(edState.replacement, line, { start: cur.start, end: cur.end })
  coreRef.value?.replaceAt(cur.line, cur.start, cur.end, rep)
  t.find.current = null
  await nextTick()
  await findNext(1)
}

function replaceAll(): void {
  const t = activeTab.value
  if (!t || t.readOnly) return
  const m = currentMatcher()
  if (!m) { toast('正则表达式无效'); return }
  if (t.mode === 'window') { toast('大文件只读模式不能全部替换'); return }
  const n = coreRef.value?.replaceAllWith(m, edState.replacement) || 0
  toast(n ? `已替换 ${n} 处` : '没有可替换的匹配')
  matchCount.value = null
  scheduleCount()
}

function clearFindMarks(): void {
  const t = activeTab.value
  if (!t) return
  t.find.query = ''
  t.find.current = null
  t.rev++
  matchCount.value = null
}

function openGoto(): void {
  if (!activeTab.value) return
  gotoText.value = String(activeTab.value.caret.line + 1)
  gotoOpen.value = true
  nextTick(() => { gotoInputEl.value?.focus(); gotoInputEl.value?.select() })
}

function doGoto(): void {
  const t = activeTab.value
  if (!t) return
  const m = /^\s*(\d+)(?:\s*[:：,]\s*(\d+))?/.exec(gotoText.value)
  if (!m) { toast('请输入行号'); return }
  const line = Math.max(1, Math.min(t.lineCount, Number(m[1]))) - 1
  const col = Math.max(1, Number(m[2] || 1)) - 1
  gotoOpen.value = false
  navigateTo(t, line, col)
  coreRef.value?.focus()
}

function navigateTo(t: Tab, line: number, col: number): void {
  edState.activeId = t.id
  const n = Math.max(0, Math.min(t.lineCount - 1, line))
  if (t.mode === 'window') {
    coreRef.value?.scrollToLine(n, col)
    setTimeout(() => { coreRef.value?.setCaret({ line: n, col }) }, 80)
  } else {
    coreRef.value?.scrollToLine(n, col)
  }
}

// ---------------- 在文件夹中查找 ----------------
function openSif(): void {
  sif.open = true
  sif.query = edState.query
  nextTick(() => sifInputEl.value?.focus())
}

async function pickFolder(): Promise<void> {
  const r = await window.sqlpilot.editorOpenFolder()
  if (r.ok && r.dir) sif.dir = r.dir
}

async function runFindInFiles(): Promise<void> {
  if (!sif.dir || !sif.query) { toast('请选择文件夹并填写查找内容'); return }
  sif.busy = true
  edState.results.open = true
  edState.results.busy = true
  edState.results.error = ''
  edState.results.hits = []
  edState.results.query = sif.query
  edState.results.dir = sif.dir
  try {
    const r = await window.sqlpilot.editorFindInFiles({
      dir: sif.dir,
      query: sif.query,
      opts: {
        matchCase: sif.matchCase,
        wholeWord: sif.wholeWord,
        regex: sif.regex,
        filePattern: sif.pattern,
        includeSubdirs: sif.subdirs,
        maxHits: 3000,
        maxFiles: 1200
      }
    })
    if (!r.ok) {
      edState.results.error = r.error || '查找失败'
      edState.results.busy = false
      return
    }
    edState.results.hits = r.hits || []
    edState.results.files = new Set((r.hits || []).map((h: any) => h.file)).size
    edState.results.truncated = !!r.truncated
    edState.results.busy = false
    sif.open = false
  } finally {
    sif.busy = false
    edState.results.busy = false
  }
}

function openHit(h: any): void {
  if (!h.file) return
  const existing = edState.tabs.find((t) => t.path && t.path.toLowerCase() === String(h.file).toLowerCase())
  if (existing) {
    navigateTo(existing, h.line - 1, h.col - 1)
    return
  }
  window.sqlpilot.editorOpenPath(h.file).then((r: any) => {
    if (!r.ok || !r.doc) { toast(r.error || '打开失败'); return }
    addDoc(r.doc, { line: h.line - 1, col: h.col - 1 })
  })
}

function openFolderAsWorkspace(): void {
  openSif()
}

// ---------------- 文件夹树 ----------------
const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

function findWorkspace(dir: string): string | undefined {
  const n = normDir(dir).toLowerCase()
  return edState.workspaceRoots.find((r) => normDir(r).toLowerCase() === n)
}

/** 打开文件夹：已在列表里就切换过去，否则追加并切换 */
function openWorkspace(dir: string): void {
  if (!dir) return
  const hit = findWorkspace(dir)
  if (!hit) {
    edState.workspaceRoots.push(dir)
    // 列表上限，避免越堆越长
    if (edState.workspaceRoots.length > 20) edState.workspaceRoots.splice(0, edState.workspaceRoots.length - 20)
  }
  edState.workspaceRoot = hit || dir
  edState.workspaceOpen = true
  savePrefs()
}

function switchWorkspace(dir: string): void {
  if (!dir) return
  edState.workspaceRoot = findWorkspace(dir) || dir
  edState.workspaceOpen = true
  savePrefs()
}

/** 只从列表移除，不动磁盘 */
function removeWorkspace(dir: string): void {
  const i = edState.workspaceRoots.findIndex((r) => normDir(r).toLowerCase() === normDir(dir).toLowerCase())
  if (i < 0) return
  edState.workspaceRoots.splice(i, 1)
  if (normDir(edState.workspaceRoot).toLowerCase() === normDir(dir).toLowerCase()) {
    const next = edState.workspaceRoots[i] || edState.workspaceRoots[i - 1] || ''
    edState.workspaceRoot = next
    if (!next) edState.workspaceOpen = false
  }
  savePrefs()
  if (!edState.workspaceRoots.length) toast('已移除所有文件夹树')
  else toast(`已从列表移除：${dir.split(/[\\/]/).pop()}`)
}

function closeWorkspace(): void {
  edState.workspaceOpen = false
  savePrefs()
}

async function pickWorkspace(): Promise<void> {
  const r = await window.sqlpilot.editorOpenFolder()
  if (r.ok && r.dir) {
    const existed = !!findWorkspace(r.dir)
    openWorkspace(r.dir)
    const name = r.dir.split(/[\\/]/).pop()
    toast(existed ? `已切换到文件夹树：${name}` : `已添加文件夹树：${name}`)
  }
}

function toggleWorkspace(): void {
  if (!edState.workspaceRoot) {
    if (edState.workspaceRoots.length) { switchWorkspace(edState.workspaceRoots[0]) ; return }
    void pickWorkspace()
    return
  }
  edState.workspaceOpen = !edState.workspaceOpen
  savePrefs()
}

function onTreeOpen(path: string): void {
  void openPath(path)
}

// ---------------- 右键 / 命令 ----------------
function openCtx(p: { x: number; y: number }): void {
  const root = document.querySelector('.ed-root')?.getBoundingClientRect()
  ctx.value = {
    x: p.x - (root?.left || 0),
    y: p.y - (root?.top || 0)
  }
}

function ctxAction(cmd: string): void {
  ctx.value = null
  if (cmd === 'goto') openGoto()
  else if (cmd === 'find') openFind(false)
  else coreRef.value?.exec(cmd)
}

function onCmd(cmd: string): void {
  if (cmd === 'find') openFind(false)
  else if (cmd === 'replace') openFind(true)
  else if (cmd === 'goto') openGoto()
  else if (cmd === 'save') save()
  else if (cmd === 'save-as') saveAs()
  else if (cmd === 'open') openFiles()
  else if (cmd === 'new') newFile()
  else if (cmd === 'close') activeTab.value && closeTab(activeTab.value)
  else if (cmd === 'next-tab') nextTab()
  else if (cmd === 'find-next') findNext(1)
  else if (cmd === 'find-prev') findNext(-1)
  else if (cmd === 'find-in-files') openSif()
  else if (cmd === 'md-preview') toggleMdPreview()
  else if (cmd === 'escape') { if (edState.findOpen) closeFind(); ctx.value = null }
}

function nextTab(): void {
  const i = edState.tabs.findIndex((t) => t.id === edState.activeId)
  if (edState.tabs.length < 2) return
  const next = edState.tabs[(i + 1) % edState.tabs.length]
  activate(next)
}

function onDocChange(): void {
  // 查找命中位置在编辑后失效
  const t = activeTab.value
  if (t?.find.current) { t.find.current = null }
}

function onRootKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (e.shiftKey && k === 'f') { e.preventDefault(); openSif(); return }
  if (e.shiftKey && k === 'm') { e.preventDefault(); toggleMdPreview(); return }
  if (e.shiftKey) return
  if (k === 'f') { e.preventDefault(); openFind(false) }
  else if (k === 'h') { e.preventDefault(); openFind(true) }
  else if (k === 'g') { e.preventDefault(); openGoto() }
  else if (k === 's') { e.preventDefault(); save() }
  else if (k === 'o') { e.preventDefault(); openFiles() }
  else if (k === 'n') { e.preventDefault(); newFile() }
  else if (k === 'w') { e.preventDefault(); if (activeTab.value) closeTab(activeTab.value) }
  else if (k === 'tab') { e.preventDefault(); nextTab() }
  else if (k === '0') { e.preventDefault(); resetZoom() }
  else if (k === '=' || k === '+') { e.preventDefault(); zoomBy(0.1) }
  else if (k === '-') { e.preventDefault(); zoomBy(-0.1) }
}

// ---------------- 生命周期 ----------------
const selLenText = computed(() => {
  const t = activeTab.value
  if (!t?.sel) return ''
  void t.rev
  if (t.block) {
    const lines = Math.abs(t.sel.head.line - t.sel.anchor.line) + 1
    const cols = Math.abs(t.sel.head.col - t.sel.anchor.col)
    return `块选 ${lines} 行 × ${cols} 列`
  }
  const s = selStart(t.sel)
  const e = selEnd(t.sel)
  if (s.line === e.line && s.col === e.col) return ''
  if (t.lineCount > 200000 && e.line - s.line > 5000) return `选中 ${e.line - s.line + 1} 行`
  if (!t.doc) return ''
  return `Sel ${t.doc.textRange(s, e).length.toLocaleString()}`
})

function onDocClick(e: MouseEvent): void {
  if (!(e.target as HTMLElement)?.closest('.ed-menu')) menuOpen.value = null
  if (!(e.target as HTMLElement)?.closest('.ed-ctx')) ctx.value = null
}

function onGlobalFocus(): void {
  if (!edState.tabs.length) loadRecents()
}

async function loadRecents(): Promise<void> {
  try {
    edState.recents = await window.sqlpilot.editorRecents()
  } catch { /* 忽略 */ }
}

async function clearRecents(): Promise<void> {
  await window.sqlpilot.editorClearRecents()
  edState.recents = []
}

function onWinKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return
  const mod = e.ctrlKey || e.metaKey
  if (!mod || !e.shiftKey || e.key.toLowerCase() !== 'm') return
  e.preventDefault()
  toggleMdPreview()
}

// ---------------- 选中文本 → AI 提问 ----------------
/** 是否选中了可提问的文本（决定右上角 AI 图标是否高亮） */
const aiBtn = reactive({ show: false })
const selReady = computed(() => aiBtn.show)

/**
 * 选区变化 / 滚动后重算按钮位置。
 * 按钮钉在选区首行的上方 34px；首行贴着顶部时改放到选区下方，避免被菜单栏压住。
 */
function refreshAiBtn(): void {
  // 只判断「有没有可提问的选区」，不读文本、不算坐标
  const info = coreRef.value?.selectionRect?.()
  aiBtn.show = !!info
}

/** 已打开的标签（没有工作区时，选择器里也能直接选这几个文件） */
const openedTabFiles = computed(() =>
  edState.tabs.filter((t): t is typeof t & { path: string } => !!t.path).map((t) => ({ path: t.path, name: t.name }))
)

/**
 * 文件树文件行点「✦」：打开文件选择器，并把这个文件先勾上。
 * 选择器里可以再勾别的文件（多选），确认后一起读成上下文。
 */
function pickFilesForAi(path: string): void {
  openEditorAiPicker([path])
}

/** 点右上角 AI：有选区就以它为上下文，没有就打开历史会话 */
function openAiForSelection(): void {
  const info = coreRef.value?.selectionInfo?.()
  const t = activeTab.value
  if (!info || !t) {
    aiBtn.show = false
    // 没选中文本：打开浮窗看历史（已开着的就切到历史列表）
    if (edAi.open) void toggleEditorAiHistory()
    else void openEditorAiHistory()
    return
  }
  openEditorAi({
    text: info.text,
    file: t.path ? t.path.split(/[\\/]/).pop() || t.name : t.name,
    lang: langLabel(t.langId),
    start: info.start.line + 1,
    end: info.end.line + 1,
    truncated: info.truncated
  })
}

/** 鼠标抬起 / 按键 / 滚动都可能改变选区或位置；点按钮与浮窗自己不算 */
function onSelectionMaybeChanged(e: Event): void {
  const el = (e.target as Element | null) ?? null
  if (el?.closest?.('.ed-ai-btn, .eai')) return
  nextTick(refreshAiBtn)
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick, true)
  window.addEventListener('keydown', onWinKey)
  window.addEventListener('focus', onGlobalFocus)
  loadRecents()
  const pending = edState.pendingOpens.splice(0)
  for (const p of pending) void openPath(p)
  if (edState.pendingFolder) {
    openWorkspace(edState.pendingFolder)
    edState.pendingFolder = ''
  }
  if (activeTab.value) nextTick(() => coreRef.value?.focus())
  // 选中文本的 AI：初始化事件通道 + 监听选区变化
  initEditorAi()
  document.addEventListener('mouseup', onSelectionMaybeChanged)
  document.addEventListener('keyup', onSelectionMaybeChanged)
  window.addEventListener('scroll', onSelectionMaybeChanged, true)
  window.addEventListener('resize', onSelectionMaybeChanged)
})

watch(() => edState.pendingFolder, (dir) => {
  if (!dir) return
  edState.pendingFolder = ''
  openWorkspace(dir)
})

watch(() => edState.pendingOpens.length, () => {
  const list = edState.pendingOpens.splice(0)
  for (const p of list) void openPath(p)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick, true)
  window.removeEventListener('keydown', onWinKey)
  window.removeEventListener('focus', onGlobalFocus)
  if (mdTimer) { clearTimeout(mdTimer); mdTimer = 0 }
  document.removeEventListener('mouseup', onSelectionMaybeChanged)
  document.removeEventListener('keyup', onSelectionMaybeChanged)
  window.removeEventListener('scroll', onSelectionMaybeChanged, true)
  window.removeEventListener('resize', onSelectionMaybeChanged)
  // 切到别的模块时本组件会销毁：浮窗状态不能留着，否则下次进来会凭空弹出来
  edAi.open = false
})

watch(() => edState.activeId, () => {
  if (edState.findOpen) syncFindToTab(activeTab.value)
  ctx.value = null
  menuOpen.value = null
  aiBtn.show = false
})
</script>

<style scoped>
.ed-root {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  position: relative;
  --te-cur-line: color-mix(in srgb, var(--accent) 8%, transparent);
  --te-gutter: #5b6379;
  --te-gutter-bg: var(--bg-side);
  --te-caret: color-mix(in srgb, var(--accent) 55%, white);
  --te-sel: color-mix(in srgb, var(--accent) 34%, transparent);
  --te-find: rgba(251, 191, 36, 0.28);
  --te-find-cur: rgba(251, 191, 36, 0.75);
  --te-bracket: rgba(127, 178, 229, 0.22);
  --te-bracket-line: rgba(127, 178, 229, 0.6);
  --tk-kw: #7aa2f7;
  --tk-type: #7dcfff;
  --tk-str: #9ece6a;
  --tk-num: #ff9e64;
  --tk-com: #5f6b85;
  --tk-fn: #e0af68;
  --tk-const: #bb9af7;
  --tk-var: #f7768e;
  --tk-op: #89ddff;
  --tk-tag: #7aa2f7;
  --tk-attr: #e0af68;
  --tk-key: #7dcfff;
  --tk-head: #bb9af7;
}
:global(html[data-theme='light']) .ed-root {
  --te-cur-line: color-mix(in srgb, var(--accent) 6%, transparent);
  --te-gutter: #9aa2b8;
  --te-caret: var(--accent);
  --te-sel: color-mix(in srgb, var(--accent) 20%, transparent);
  --tk-kw: #1d4ed8;
  --tk-type: #0e7490;
  --tk-str: #15803d;
  --tk-num: #b45309;
  --tk-com: #94a3b8;
  --tk-fn: #a16207;
  --tk-const: #7c3aed;
  --tk-var: #b91c1c;
  --tk-op: #0e7490;
  --tk-tag: #1d4ed8;
  --tk-attr: #a16207;
  --tk-key: #0e7490;
  --tk-head: #7c3aed;
}

.ed-menubar {
  height: 34px;
  display: flex;
  align-items: center;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-side);
  flex-shrink: 0;
  position: relative;
  z-index: 20;
}
.ed-menu { position: relative; }
.ed-menu-title {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12.5px;
  padding: 6px 11px;
  border-radius: 7px;
  cursor: pointer;
}
.ed-menu-title:hover, .ed-menu-title.open { background: var(--bg-card-hover); color: var(--text); }
.ed-menu:last-child .ed-menu-pop { left: auto; right: 0; }
.ed-menu-pop {
  position: absolute;
  top: 31px;
  left: 0;
  min-width: 258px;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 5px;
  z-index: 40;
}
.ed-menu-item {
  display: flex;
  align-items: center;
  padding: 6px 9px;
  border-radius: 7px;
  font-size: 12.5px;
  cursor: pointer;
  color: var(--text);
}
.ed-menu-item:hover { background: var(--accent-dim); }
.ed-menu-item.disabled { opacity: 0.42; pointer-events: none; }
.ed-menu-item .chk { width: 16px; color: var(--accent); font-size: 11px; }
.ed-menu-item .lbl { flex: 1; }
.ed-menu-item .hint { color: var(--text-faint); font-size: 11px; margin-left: 18px; }
.ed-menu-sep { height: 1px; background: var(--border); margin: 5px 6px; }
.ed-menubar .spacer { flex: 1; }
.ed-quick {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-dim);
  font-size: 15px;
  width: 30px;
  height: 26px;
  border-radius: 7px;
  cursor: pointer;
  margin-left: 2px;
}
.ed-quick:hover { background: var(--bg-card-hover); color: var(--text); }
.ed-quick.on { color: var(--accent); background: var(--accent-dim); }
.ed-quick:disabled { opacity: 0.35; cursor: not-allowed; }

/* 标签栏：高度与文件夹树头部（32px）一致，两条头部横向对齐 */
.ed-tabs {
  height: 32px;
  display: flex;
  align-items: stretch;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  scrollbar-width: none;
}
.ed-tabs::-webkit-scrollbar { height: 0; }
.ed-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 11px;
  border-right: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 12.5px;
  cursor: pointer;
  max-width: 240px;
  white-space: nowrap;
  position: relative;
  flex: 0 0 auto;
}
.ed-tab:hover { background: var(--bg-card-hover); color: var(--text); }
.ed-tab.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: inset 0 2px 0 var(--accent);
}
.ed-tab-dot { font-size: 8px; color: transparent; }
.ed-tab-dot.dirty { color: var(--yellow); }
.ed-tab-name { overflow: hidden; text-overflow: ellipsis; }
.ed-tab-ro {
  font-size: 9px;
  font-weight: 700;
  color: var(--yellow);
  border: 1px solid var(--yellow);
  border-radius: 4px;
  padding: 0 3px;
  line-height: 1.3;
}
.ed-tab-x {
  background: transparent;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 5px;
}
.ed-tab-x:hover { background: var(--red-dim); color: var(--red); }
.ed-tab-add {
  background: transparent;
  border: none;
  color: var(--text-faint);
  font-size: 14px;
  width: 34px;
  cursor: pointer;
  flex: 0 0 auto;
}
.ed-tab-add:hover { color: var(--text); background: var(--bg-card-hover); }
.ed-tabs .spacer { flex: 1; }
.ed-tabs-hint { font-size: 11px; color: var(--yellow); align-self: center; padding-right: 12px; }

/* Markdown 显示方式切换（源码 / 预览 / 分屏） */
.ed-md-switch {
  display: flex;
  align-items: center;
  gap: 1px;
  margin-right: 10px;
  padding: 2px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 7px;
  align-self: center;
  height: 24px;
}
.ed-md-switch button {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  padding: 0 9px;
  height: 18px;
  border-radius: 5px;
  cursor: pointer;
  line-height: 18px;
}
.ed-md-switch button:hover { color: var(--text); background: var(--bg-card-hover); }
.ed-md-switch button.on { background: var(--accent-dim); color: var(--accent); font-weight: 600; }

/* Markdown 格式快捷栏 */
.ed-md-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 0 8px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ed-md-bar::-webkit-scrollbar { height: 0; }
.mdb {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 11.5px;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  line-height: 22px;
}
.mdb:hover { background: var(--bg-card-hover); color: var(--text); }
.mdb:disabled { opacity: 0.35; cursor: not-allowed; }
.mdb.view { color: var(--accent); border: 1px solid var(--border); }
.mdb-sep { width: 1px; height: 14px; background: var(--border); margin: 0 3px; flex: 0 0 auto; }
.mdb-label {
  flex: 0 0 auto;
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--accent);
  padding: 0 6px 0 2px;
  opacity: 0.85;
}
.md-ro-hint {
  flex: 1;
  padding: 26px 30px;
  color: var(--text-dim);
  font-size: 12.5px;
  line-height: 1.8;
}
.ed-md-bar .spacer { flex: 1; }

/* 编辑 / 预览分栏 */
.ed-edit-area { flex: 1; min-height: 0; display: flex; flex-direction: row; position: relative; }
.ed-edit-pane { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.ed-preview-pane { flex: 1; min-width: 0; min-height: 0; display: flex; border-left: 1px solid var(--border); }
.ed-wys-pane { flex: 1; min-width: 0; min-height: 0; display: flex; }
.ed-edit-area.split .ed-edit-pane { flex: 0 0 50%; }
.ed-edit-area.split .ed-preview-pane { flex: 0 0 50%; }

.ed-body { flex: 1; min-height: 0; display: flex; flex-direction: row; position: relative; }
.ed-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.ed-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 14px;
  background: var(--yellow-dim);
  color: var(--yellow);
  font-size: 11.5px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ed-banner .link { color: var(--yellow); }
.ed-busy {
  position: absolute;
  inset: 0;
  z-index: 18;
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: center;
  background: rgba(8, 10, 18, 0.45);
  backdrop-filter: blur(1.5px);
  color: var(--text);
  font-size: 13px;
  cursor: progress;
}

/* 欢迎页 */
.ed-welcome {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 60px 30px 40px;
}
.wl-icon {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wl-title { font-size: 20px; font-weight: 700; margin-top: 16px; }
.wl-sub { color: var(--text-dim); font-size: 12.5px; margin-top: 6px; text-align: center; max-width: 560px; line-height: 1.7; }
.wl-actions { display: flex; gap: 10px; margin-top: 20px; }
.wl-recents { width: min(680px, 90%); margin-top: 34px; }
.wl-recents-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-faint);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 6px;
}
.wl-recent {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
}
.wl-recent:hover { background: var(--bg-card-hover); }
.wl-recent-name { font-size: 12.5px; color: var(--text); min-width: 140px; }
.wl-recent-path { font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 查找面板 */
.ed-find-panel {
  position: absolute;
  top: 36px;
  right: 22px;
  width: 430px;
  max-width: calc(100% - 44px);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  box-shadow: var(--shadow-lg);
  padding: 9px 12px 10px;
  z-index: 15;
}
.fp-head { display: flex; align-items: center; font-size: 12px; color: var(--text-dim); margin-bottom: 7px; }
.fp-count { font-size: 11px; color: var(--text-faint); margin-right: 8px; }
.fp-x { background: transparent; border: none; color: var(--text-faint); cursor: pointer; font-size: 12px; }
.fp-x:hover { color: var(--text); }
.fp-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
.fp-row input { flex: 1; min-width: 0; padding: 6px 9px; font-size: 12.5px; }
.fp-btn {
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 7px;
  height: 30px;
  min-width: 30px;
  cursor: pointer;
  font-size: 12px;
  padding: 0 8px;
}
.fp-btn:hover { border-color: var(--accent); }
.fp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.fp-btn.wide { padding: 0 11px; }
.fp-opts { display: flex; align-items: center; gap: 12px; font-size: 11.5px; color: var(--text-dim); }
.fp-opts label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.fp-opts input[type='checkbox'] { accent-color: var(--accent); }
.fp-opts .spacer { flex: 1; }

.link {
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 11.5px;
  cursor: pointer;
  font-family: inherit;
  padding: 0;
}
.link:hover { text-decoration: underline; }

/* 右键菜单 */
.ed-ctx {
  position: absolute;
  min-width: 180px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 60;
}
.ed-ctx-item {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 12.5px;
  cursor: pointer;
}
.ed-ctx-item:hover { background: var(--accent-dim); }
.ed-ctx-item span { color: var(--text-faint); font-size: 11px; }
.ed-ctx-sep { height: 1px; background: var(--border); margin: 4px 6px; }

/* 查找结果 */
.ed-results {
  height: 210px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: var(--bg-side);
  display: flex;
  flex-direction: column;
}
.res-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.res-meta { font-size: 11px; color: var(--text-faint); }
.res-head .spacer { flex: 1; }
.res-list { flex: 1; overflow-y: auto; padding: 4px 6px; }
.res-empty { padding: 18px; color: var(--text-faint); font-size: 12px; }
.res-item {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  font-family: var(--mono);
}
.res-item:hover { background: var(--bg-card-hover); }
.res-file { color: var(--accent); min-width: 120px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.res-ln { color: var(--text-faint); min-width: 58px; }
.res-text { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

/* 状态栏 */
.ed-status {
  height: 26px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 12px;
  background: var(--bg-side);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--mono);
}
.ed-status .spacer { flex: 1; }
.st-item.clickable { cursor: pointer; }
.st-item.clickable:hover { color: var(--accent); }
.st-item.ro { color: var(--yellow); }

/* 弹窗 */
.ed-mask {
  position: absolute;
  inset: 0;
  background: rgba(8, 10, 18, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
}
.ed-dialog {
  width: 460px;
  max-width: 92%;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  padding: 20px 22px;
  box-shadow: var(--shadow-lg);
}
.ed-dialog.small { width: 340px; }
.ed-dialog h3 { font-size: 14px; margin-bottom: 12px; }
.ed-dialog p { font-size: 12.5px; color: var(--text-dim); line-height: 1.6; }
.ed-dialog label { display: block; font-size: 11.5px; color: var(--text-faint); margin: 10px 0 4px; }
.ed-dialog input { width: 100%; }
.ed-dialog .row { display: flex; gap: 8px; }
.ed-dialog .row input { flex: 1; }
.ed-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.danger-outline { color: var(--red); border-color: var(--red); background: transparent; }

/* 菜单栏右上角的 AI 图标：固定在原位，有选区时高亮并亮一个小圆点 */
.ed-ai-quick { position: relative; font-size: 14px; color: var(--text-faint); }
.ed-ai-quick:hover { color: var(--accent); }
/* 有可提问的选区：实心高亮，一眼能看出「现在点有用」 */
.ed-ai-quick.on {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
.ed-ai-quick.on:hover { background: color-mix(in srgb, var(--accent) 86%, #fff); color: #fff; }
.ed-ai-quick.busy { opacity: 0.9; }
.ed-ai-dot {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 1.5px var(--accent);
}
</style>
