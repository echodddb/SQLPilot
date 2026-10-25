<template>
  <div class="as" :style="{ width: store.artifactW + 'px' }">
    <div class="as-drag" title="拖拽调整宽度" @mousedown="startDrag"></div>

    <div class="as-head">
      <span class="as-title">产物</span>
      <span class="as-count" v-if="list.length">{{ list.length }}</span>
      <span style="flex: 1"></span>
      <button class="as-icon" title="收起右侧栏（Ctrl+Shift+A）" @click="store.artifactsOpen = false">›</button>
    </div>

    <div v-if="!list.length" class="as-empty">
      <div class="as-empty-big">▦</div>
      <div>这次对话还没有产物</div>
      <div class="as-empty-dim">查询结果、DDL、读写的文件、命令输出会自动收到这里</div>
    </div>

    <template v-else>
      <div class="as-list">
        <div
          v-for="a in list"
          :key="a.id"
          class="as-item"
          :class="{ active: a.id === cur?.id }"
          :title="`${a.title}\n${a.subtitle}`"
          @click="pick(a.id)"
        >
          <span class="as-kind" :class="'k-' + a.kind">{{ iconOf(a.kind) }}</span>
          <span class="as-item-text">
            <span class="as-item-title">{{ a.title }}</span>
            <span class="as-item-sub">{{ a.subtitle || a.tool }}</span>
          </span>
        </div>
      </div>

      <div class="as-body" v-if="cur">
        <div class="as-body-head">
          <span class="as-body-title" :title="cur.title">{{ cur.title }}</span>
          <span style="flex: 1"></span>
          <span class="as-body-tool">{{ cur.tool }}</span>
        </div>

        <!-- 表格：结果集 / 表结构 / 对象清单 / CSV -->
        <ArtifactTable v-if="cur.kind === 'table' && cur.table" :key="cur.id" :data="cur.table" :name="cur.title" />

        <!-- 代码 / 纯文本 -->
        <template v-else-if="cur.kind === 'code' || cur.kind === 'text'">
          <div class="as-code-bar">
            <span class="as-lang">{{ cur.lang || 'text' }}</span>
            <span class="as-dim">{{ (cur.text || '').split('\n').length }} 行</span>
            <span style="flex: 1"></span>
            <button class="as-btn" @click="copyText(cur.text || '')">复制</button>
            <button v-if="cur.path" class="as-btn" title="在文件管理器中显示" @click="reveal(cur.path)">所在文件夹</button>
          </div>
          <div class="as-code-wrap">
            <pre class="as-code"><code><span v-for="(ln, i) in codeLines" :key="i" class="as-line"><span class="as-ln">{{ i + 1 }}</span>{{ ln }}
</span></code></pre>
          </div>
        </template>

        <!-- Markdown（报告 / md 文件） -->
        <template v-else-if="cur.kind === 'markdown'">
          <div class="as-code-bar">
            <span class="as-lang">markdown</span>
            <span style="flex: 1"></span>
            <button class="as-btn" @click="copyText(cur.text || '')">复制原文</button>
            <button v-if="cur.path" class="as-btn" @click="reveal(cur.path)">所在文件夹</button>
          </div>
          <div class="as-md as-scroll" v-html="mdHtml"></div>
        </template>

        <!-- 图片 -->
        <template v-else-if="cur.kind === 'image'">
          <div class="as-code-bar">
            <span class="as-lang">image</span>
            <span class="as-dim as-ellipsis" :title="cur.path">{{ cur.path }}</span>
            <span style="flex: 1"></span>
            <button class="as-btn" @click="zoom = zoom === 'fit' ? 'real' : 'fit'">{{ zoom === 'fit' ? '原始大小' : '适应窗口' }}</button>
            <button class="as-btn" @click="reveal(cur.path || '')">所在文件夹</button>
          </div>
          <div class="as-scroll as-imgbox">
            <div v-if="imgError" class="as-empty-dim">{{ imgError }}</div>
            <img v-else-if="imgUrl" :src="imgUrl" :class="zoom === 'fit' ? 'fit' : 'real'" :alt="cur.title" />
            <div v-else class="as-empty-dim">载入中…</div>
          </div>
        </template>

        <!-- 普通文件（只有路径） -->
        <template v-else>
          <div class="as-file">
            <div class="as-file-icon">📎</div>
            <div class="as-file-name">{{ cur.title }}</div>
            <div class="as-file-path">{{ cur.path }}</div>
            <div class="as-file-actions">
              <button class="as-btn" @click="reveal(cur.path || '')">打开所在文件夹</button>
              <button class="as-btn" @click="copyText(cur.path || '')">复制路径</button>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store, curSession } from '../../store'
import { collectArtifacts, type Artifact } from '../../artifacts'
import { renderMarkdown } from '../../editor/markdown'
import ArtifactTable from './ArtifactTable.vue'

const list = computed<Artifact[]>(() => collectArtifacts(curSession()?.msgs as any))

/** 当前选中：显式聚焦优先；否则跟随最后一个产物（最新产出最可能是用户要看的） */
const cur = computed<Artifact | null>(() => {
  if (!list.value.length) return null
  const hit = store.artifactFocus ? list.value.find((a) => a.id === store.artifactFocus) : null
  return hit || list.value[list.value.length - 1]
})

function pick(id: string): void {
  store.artifactFocus = id
}

const ICONS: Record<string, string> = { table: '▦', code: '</>', markdown: '¶', image: '🖼', file: '📎', text: '¶' }
function iconOf(k: string): string {
  return ICONS[k] || '•'
}

const codeLines = computed(() => String(cur.value?.text || '').split('\n'))

const mdHtml = computed(() => {
  const t = cur.value?.text || ''
  if (!t) return '<p class="as-dim">（空）</p>'
  return renderMarkdown(t, 400_000).html
})

// ---------- 图片：走主进程读成 data URL（dev 下页面是 http，file:// 会被拦） ----------
const imgUrl = ref('')
const imgError = ref('')
const zoom = ref<'fit' | 'real'>('fit')

watch(
  () => [cur.value?.id, cur.value?.kind, cur.value?.path] as const,
  async () => {
    imgUrl.value = ''
    imgError.value = ''
    if (cur.value?.kind !== 'image' || !cur.value.path) return
    const r = await window.sqlpilot.artifactImageDataUrl(cur.value.path)
    if (r.ok && r.url) imgUrl.value = r.url
    else imgError.value = r.error || '无法预览该图片'
  },
  { immediate: true }
)

async function copyText(t: string): Promise<void> {
  await window.sqlpilot.writeClipboard(t)
}

async function reveal(p: string): Promise<void> {
  if (!p) return
  const r = await window.sqlpilot.showInFolder(p)
  if (r && r.ok === false && r.error) await window.sqlpilot.uiAlert('打开失败：' + r.error)
}

// ---------- 宽度拖拽 ----------
function startDrag(e: MouseEvent): void {
  const startX = e.clientX
  const startW = store.artifactW
  const move = (ev: MouseEvent) => {
    // 面板在右侧：往左拖变宽
    const w = Math.min(Math.max(startW - (ev.clientX - startX), 340), Math.min(900, window.innerWidth - 520))
    store.artifactW = w
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    localStorage.setItem('sqlpilot.artifactW', String(store.artifactW))
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
</script>

<style scoped>
.as {
  border-left: 1px solid var(--border-strong);
  background: var(--bg-side);
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex-shrink: 0;
  position: relative;
}
.as-drag {
  position: absolute; left: -3px; top: 0; bottom: 0; width: 7px;
  cursor: ew-resize; z-index: 5;
}
.as-drag:hover { background: var(--accent-dim); }
.as-head {
  display: flex; align-items: center; gap: 7px;
  height: 34px; padding: 0 10px; flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.as-title { font-size: 12.5px; font-weight: 700; color: var(--text-dim); }
.as-count {
  font-size: 10.5px; padding: 0 6px; border-radius: 99px; line-height: 16px;
  background: var(--accent-dim); color: var(--accent); font-family: var(--mono);
}
.as-icon {
  border: none; background: none; color: var(--text-faint); cursor: pointer;
  font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 6px;
}
.as-icon:hover { color: var(--accent); background: var(--bg-card-hover); }
.as-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text-dim); font-size: 12.5px; padding: 20px; text-align: center; }
.as-empty-big { font-size: 26px; color: var(--text-faint); }
.as-empty-dim { color: var(--text-faint); font-size: 11.5px; line-height: 1.7; }

/* 产物列表：横向紧凑，多了内部滚动 */
.as-list {
  max-height: 168px; overflow-y: auto; flex-shrink: 0;
  border-bottom: 1px solid var(--border); padding: 4px 6px;
}
.as-item {
  display: flex; align-items: center; gap: 8px; padding: 5px 7px;
  border-radius: 7px; cursor: pointer;
}
.as-item:hover { background: var(--bg-card-hover); }
.as-item.active { background: var(--accent-dim); }
.as-kind {
  width: 22px; height: 22px; border-radius: 6px; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
  background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent);
}
.as-kind.k-table { color: var(--blue, #4a9fe0); background: color-mix(in srgb, var(--blue, #4a9fe0) 14%, transparent); }
.as-kind.k-image { color: var(--purple, #a78bfa); background: color-mix(in srgb, var(--purple, #a78bfa) 14%, transparent); }
.as-kind.k-markdown { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }
.as-kind.k-file { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 14%, transparent); }
.as-item-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.as-item-title { font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-item-sub { font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.as-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.as-body-head {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px 5px;
  flex-shrink: 0;
}
.as-body-title { font-size: 12.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-body-tool { font-size: 10.5px; color: var(--text-faint); font-family: var(--mono); }
.as-code-bar {
  display: flex; align-items: center; gap: 8px; padding: 0 10px 6px;
  font-size: 11px; color: var(--text-dim); flex-shrink: 0;
}
.as-lang { font-family: var(--mono); color: var(--accent); font-size: 10.5px; }
.as-dim { color: var(--text-faint); }
.as-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.as-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 2px 8px; cursor: pointer; font-family: inherit;
  white-space: nowrap;
}
.as-btn:hover { color: var(--accent); border-color: var(--accent); }
.as-scroll { flex: 1; min-height: 0; overflow: auto; }

.as-code-wrap { flex: 1; min-height: 0; overflow: auto; background: var(--bg-code); }
.as-code {
  margin: 0; padding: 8px 10px; font-size: 11.5px; line-height: 1.65;
  font-family: var(--mono); color: var(--text); white-space: pre;
}
.as-line { display: inline; }
.as-ln {
  display: inline-block; width: 34px; margin-right: 10px; text-align: right;
  color: var(--text-faint); user-select: none;
}

.as-md { padding: 4px 12px 16px; font-size: 12.5px; line-height: 1.75; color: var(--text); }
.as-md :deep(h1), .as-md :deep(h2), .as-md :deep(h3), .as-md :deep(h4) {
  margin: 12px 0 6px; font-size: 13.5px; color: var(--text);
}
.as-md :deep(p) { margin: 6px 0; }
.as-md :deep(ul), .as-md :deep(ol) { margin: 6px 0; padding-left: 20px; }
.as-md :deep(li) { margin: 2px 0; }
.as-md :deep(code) {
  background: var(--bg-code); border: 1px solid var(--border); border-radius: 4px;
  padding: 0 4px; font-family: var(--mono); font-size: 11.5px;
}
.as-md :deep(pre) {
  background: var(--bg-code); border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 11px; overflow: auto;
}
.as-md :deep(pre code) { border: none; background: none; padding: 0; }
.as-md :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 11.5px; }
.as-md :deep(th), .as-md :deep(td) { border: 1px solid var(--border); padding: 4px 8px; }
.as-md :deep(th) { background: var(--bg-side); color: var(--text-dim); }
.as-md :deep(blockquote) {
  margin: 8px 0; padding: 2px 10px; border-left: 3px solid var(--border-strong); color: var(--text-dim);
}
.as-md :deep(a) { color: var(--accent); }

.as-imgbox { display: flex; align-items: center; justify-content: center; padding: 10px; }
.as-imgbox img { border-radius: 8px; border: 1px solid var(--border); }
.as-imgbox img.fit { max-width: 100%; max-height: 100%; object-fit: contain; }
.as-imgbox img.real { max-width: none; }

.as-file { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 20px; }
.as-file-icon { font-size: 26px; }
.as-file-name { font-size: 12.5px; color: var(--text); }
.as-file-path { font-size: 11px; color: var(--text-faint); font-family: var(--mono); word-break: break-all; text-align: center; max-width: 100%; }
.as-file-actions { display: flex; gap: 6px; margin-top: 8px; }
</style>
