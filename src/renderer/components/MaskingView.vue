<template>
  <div class="masking-view">
    <header class="mask-head">
      <div>
        <div class="mask-title">
          <span class="mask-icon">▦</span>
          <h2>脱敏工具</h2>
          <span class="mask-badge">AWR 已可用</span>
        </div>
        <p>对 Oracle AWR 报告等运维文件做本地脱敏后再共享。当前先开放 Oracle AWR；普通日志规则可预先配置，处理能力后续开放。</p>
      </div>
    </header>

    <!-- 紧凑导入区：只保留类型、文件和关键动作 -->
    <section class="mask-card upload-card">
      <div class="upload-bar">
        <div class="upload-field">
          <label>文件类型</label>
          <select v-model="fileType" :disabled="busy" @change="onFileTypeChange">
            <option value="oracle_awr">Oracle AWR 报告</option>
            <option value="generic_log">普通日志（规划中）</option>
          </select>
        </div>

        <div
          class="drop-zone"
          :class="{ over: dragOver, disabled: fileType !== 'oracle_awr' }"
          tabindex="0"
          role="button"
          aria-label="选择或拖入 AWR 文件"
          @click="pickFile"
          @keydown.enter.prevent="pickFile"
          @keydown.space.prevent="pickFile"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <b>{{ fileType === 'oracle_awr' ? '选择 / 拖入 AWR 文件' : '普通日志暂未开放' }}</b>
          <div class="drop-meta">
            <span>AWR / TXT / HTML / LOG · 最大 20MB</span>
            <em>本地处理，不修改原文件</em>
          </div>
        </div>

        <div class="upload-side">
          <div v-if="source" class="source-info">
            <div class="file-name" :title="source.fileName">{{ source.fileName }}</div>
            <div class="file-meta">{{ formatSize(source.size) }} · {{ fileTypeLabel }}</div>
            <button class="btn ghost small" @click="clearFile">移除</button>
          </div>
          <div class="actions">
            <button class="btn primary" :disabled="!source || busy || fileType !== 'oracle_awr'" @click="runMask">
              {{ busy ? '处理中…' : '开始脱敏' }}
            </button>
            <button class="btn" :disabled="busy" @click="rulesOpen = true">⚙ 规则 {{ enabledCount }}/{{ activeRules.length }}</button>
            <button class="btn" :disabled="!result || busy" @click="copyResult">复制</button>
            <button class="btn" :disabled="!result || busy" @click="saveResult">另存</button>
          </div>
        </div>
      </div>

      <div v-if="savedPath" class="saved-line">
        已保存：<code>{{ savedPath }}</code>
        <button class="link" @click="openSavedFolder">打开目录</button>
      </div>
    </section>

    <!-- 结果 -->
    <section class="mask-card output-card">
      <div class="card-row">
        <div>
          <div class="card-title">脱敏结果</div>
          <div class="card-sub">
            <template v-if="result">
              共命中 {{ totalMatches }} 处；
              <template v-if="stats.length">
                <span v-for="s in stats" :key="s.ruleId" class="stat-chip">{{ s.name }} {{ s.count }}</span>
              </template>
              <template v-else>未发现可命中的规则，请检查文件内容或调整规则。</template>
            </template>
            <template v-else>上传文件后点击“开始脱敏”，此处只展示脱敏后的内容。</template>
          </div>
        </div>
      </div>
      <div v-if="result" class="output-toolbar">
        <div class="view-tabs" role="tablist" aria-label="结果展示方式">
          <button class="view-tab" :class="{ active: outputMode === 'compare' }" role="tab" :aria-selected="outputMode === 'compare'" @click="outputMode = 'compare'">前后对比</button>
          <button class="view-tab" :class="{ active: outputMode === 'result' }" role="tab" :aria-selected="outputMode === 'result'" @click="outputMode = 'result'">仅脱敏结果</button>
        </div>
        <div class="compare-legend">
          <button class="map-toggle" :class="{ active: mappingOpen }" @click="mappingOpen = !mappingOpen">映射备注 {{ mappings.length }}</button>
          <span><i class="legend-original"></i>原始敏感内容</span>
          <span><i class="legend-masked"></i>替换后的内容</span>
        </div>
      </div>

      <div v-if="result && mappingOpen" class="mapping-notes">
        <div v-for="m in mappings" :key="m.category + ':' + m.original" class="mapping-row">
          <span class="mapping-label">{{ m.label }}</span>
          <code>{{ m.original }}</code>
          <span>→</span>
          <b>{{ m.replacement }}</b>
          <em>{{ m.count }} 处</em>
        </div>
      </div>

      <div v-if="result && outputMode === 'compare'" class="compare-wrap">
        <div class="compare-heads">
          <div class="pane-head">原始文件</div>
          <div class="pane-head masked-head">脱敏后</div>
        </div>
        <div class="pane-body">
          <div v-for="row in visibleCompareRows" :key="row.no" class="compare-row">
            <div class="compare-cell">
              <span class="line-no">{{ row.original.no }}</span>
              <span class="line-text">
                <template v-for="(seg, si) in row.original.segments" :key="si">
                  <mark v-if="seg.masked" class="mark-original" :title="seg.note || seg.ruleName">{{ seg.text }}</mark>
                  <span v-else>{{ seg.text }}</span>
                </template>
              </span>
            </div>
            <div class="compare-cell">
              <span class="line-no">{{ row.masked.no }}</span>
              <span class="line-text">
                <template v-for="(seg, si) in row.masked.segments" :key="si">
                  <mark v-if="seg.masked" class="mark-masked" :title="seg.note || seg.ruleName">{{ seg.text }}</mark>
                  <span v-else>{{ seg.text }}</span>
                </template>
              </span>
            </div>
          </div>
        </div>
        <div v-if="compareHasMore" class="compare-more">
          <button class="btn small" @click="compareVisibleLines += 1000">加载更多（已显示 {{ visibleCompareRows.length }} / {{ compareRows.length }} 行）</button>
        </div>
        <p class="compare-warning">⚠ 对比视图会显示原始敏感值；如需外发，请使用“仅脱敏结果”或另存后的文件。</p>
      </div>

      <pre v-else-if="result && outputMode === 'result'" class="result-pre">{{ previewText }}</pre>
      <div v-else class="result-empty">
        <span>🛡</span>
        <b>尚未生成脱敏结果</b>
        <p>预览与导出内容均为脱敏后文本；不会展示原始敏感值。</p>
      </div>
    </section>
    <!-- 脱敏规则浮窗：默认不占用主工作区 -->
    <Teleport to="body">
      <div v-if="rulesOpen" class="rules-overlay" @click.self="rulesOpen = false">
        <section class="rules-modal" role="dialog" aria-modal="true" aria-label="脱敏规则设置">
          <header class="rules-modal-head">
            <div>
              <div class="card-title">脱敏规则</div>
              <div class="card-sub">{{ fileTypeLabel }} · {{ activeRules.length }} 条，启用 {{ enabledCount }} 条</div>
            </div>
            <div class="rule-actions">
              <button class="btn small" :disabled="busy" @click="addRule">添加规则</button>
              <button class="btn small" :disabled="busy" @click="resetRules">恢复默认</button>
              <button class="icon-btn modal-close" title="关闭" @click="rulesOpen = false">×</button>
            </div>
          </header>

          <div class="rule-list">
            <div v-for="r in activeRules" :key="r.id" class="rule-item" :class="{ off: !r.enabled }">
              <label class="switch" :title="r.enabled ? '停用规则' : '启用规则'">
                <input v-model="r.enabled" type="checkbox" @change="invalidateResult" />
                <span></span>
              </label>
              <div class="rule-main">
                <input v-model="r.name" class="rule-name" @input="invalidateResult" />
                <p v-if="r.kind === 'builtin'" class="rule-desc">{{ r.description }}</p>
                <div v-else class="custom-row">
                  <input v-model="r.pattern" class="mono" placeholder="正则表达式，如 customer[_-]?id\s*=\s*\d+" @input="invalidateResult" />
                  <input v-model="r.flags" class="flags" title="标志：i 忽略大小写 / m 多行 / s 点号换行 / u Unicode" @input="invalidateResult" />
                </div>
              </div>
              <input v-model="r.replacement" class="replacement" placeholder="替换文本" @input="invalidateResult" />
              <button v-if="r.kind === 'custom'" class="icon-btn" title="删除自定义规则" @click="removeRule(r)">×</button>
              <span v-else class="builtin-tag">内置</span>
            </div>
          </div>

          <footer class="rules-modal-foot">
            <p class="rule-foot">内置规则可调整启用状态与替换文本；自定义规则使用 JavaScript 正则表达式，替换文本按普通字符串处理（$1 等捕获变量不会展开）。</p>
            <button class="btn primary small" :disabled="busy" @click="saveRules()">保存并关闭</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { pushNotice, store, toPlain } from '../store'

type FileType = 'oracle_awr' | 'generic_log'
interface Rule {
  id: string
  name: string
  description?: string
  kind: 'builtin' | 'custom'
  builtinId?: string
  pattern?: string
  flags?: string
  replacement: string
  enabled: boolean
}

interface MaskingEdit {
  ruleId: string
  category: string
  original: string
  replacement: string
  originalStart: number
  originalEnd: number
  outputStart: number
  outputEnd: number
}

interface MaskingMapping {
  category: string
  label: string
  original: string
  replacement: string
  count: number
}

interface CompareSegment {
  text: string
  masked: boolean
  ruleName?: string
  note?: string
}

interface CompareLine {
  no: number
  segments: CompareSegment[]
}

const fileType = ref<FileType>('oracle_awr')
const source = ref<{ fileName: string; size: number; content: string } | null>(null)
const result = ref<string | null>(null)
const stats = ref<{ ruleId: string; name: string; count: number }[]>([])
const edits = ref<MaskingEdit[]>([])
const mappings = ref<MaskingMapping[]>([])
const mappingOpen = ref(true)
const outputMode = ref<'compare' | 'result'>('compare')
const rulesOpen = ref(false)
const busy = ref(false)
const dragOver = ref(false)
const savedPath = ref('')

const fileTypeLabel = computed(() => fileType.value === 'oracle_awr' ? 'Oracle AWR' : '普通日志（规划中）')
const activeRules = computed<Rule[]>(() => (store.cfg?.masking?.[fileType.value]?.rules || []) as Rule[])
const enabledCount = computed(() => activeRules.value.filter(r => r.enabled).length)
const totalMatches = computed(() => stats.value.reduce((a, b) => a + b.count, 0))
const previewText = computed(() => result.value ? result.value.slice(0, 40000) + (result.value.length > 40000 ? '\n…（预览截断，另存会包含完整结果）' : '') : '')
const ruleNames = computed(() => new Map(activeRules.value.map(r => [r.id, r.name])))
const compareVisibleLines = ref(500)
const originalCompareLines = computed(() => source.value ? buildCompareLines(source.value.content, edits.value.map(e => ({ start: e.originalStart, end: e.originalEnd, ruleId: e.ruleId, original: e.original, replacement: e.replacement, label: mappingLabel(e.category) }))) : [])
const maskedCompareLines = computed(() => result.value ? buildCompareLines(result.value, edits.value.map(e => ({ start: e.outputStart, end: e.outputEnd, ruleId: e.ruleId, original: e.original, replacement: e.replacement, label: mappingLabel(e.category) }))) : [])
const compareHasMore = computed(() => compareRows.value.length > compareVisibleLines.value)
const visibleCompareRows = computed(() => compareRows.value.slice(0, compareVisibleLines.value))
const compareRows = computed(() => {
  const original = originalCompareLines.value
  const masked = maskedCompareLines.value
  const count = Math.max(original.length, masked.length)
  return Array.from({ length: count }, (_, i) => ({
    no: i + 1,
    original: original[i] || { no: i + 1, segments: [{ text: '', masked: false }] },
    masked: masked[i] || { no: i + 1, segments: [{ text: '', masked: false }] }
  }))
})

function mappingLabel(category: string): string {
  const labels: Record<string, string> = {
    PASSWORD: '口令', DBUSER: '数据库用户 / Schema', OSUSER: '操作系统用户', INSTANCE: '实例名',
    DB_NAME: '数据库名 / PDB', DBID: '数据库 DBID', CLUSTER: '集群名', ASM_DG: 'ASM 磁盘组',
    SERVICE: '服务名 / TNS', HOSTNAME: '主机名', DOMAIN: '域名', IPV4: 'IPv4 地址', IPV6: 'IPv6 地址',
    MAC: 'MAC 地址', EMAIL: '邮箱', PHONE: '手机号', MANUAL: '自定义匹配'
  }
  return labels[category] || category
}

function buildCompareLines(text: string, ranges: { start: number; end: number; ruleId: string; original: string; replacement: string; label: string }[]): CompareLine[] {
  const lines = text.split('\n')
  const lineStarts: number[] = []
  let pos = 0
  for (const line of lines) {
    lineStarts.push(pos)
    pos += line.length + 1
  }
  const byLine: { start: number; end: number; note?: string }[][] = lines.map(() => [])
  for (const range of ranges) {
    if (range.end <= 0 || range.start >= text.length) continue
    const start = Math.max(0, range.start)
    const end = Math.min(text.length, range.end)
    let li = 0
    while (li + 1 < lineStarts.length && lineStarts[li + 1] <= start) li++
    for (; li < lines.length && lineStarts[li] < end; li++) {
      const lineEnd = lineStarts[li] + lines[li].length
      const rangeStart = Math.max(start, lineStarts[li])
      const rangeEnd = Math.min(end, lineEnd)
      if (rangeEnd > rangeStart) byLine[li].push({ start: rangeStart - lineStarts[li], end: rangeEnd - lineStarts[li], note: `${range.label}：${range.original} → ${range.replacement}` })
    }
  }
  return lines.map((line, i) => {
    const segments: CompareSegment[] = []
    let cursor = 0
    for (const range of byLine[i]) {
      if (range.start < cursor) continue
      if (range.start > cursor) segments.push({ text: line.slice(cursor, range.start), masked: false })
      segments.push({ text: line.slice(range.start, range.end), masked: true, note: range.note })
      cursor = range.end
    }
    if (cursor < line.length) segments.push({ text: line.slice(cursor), masked: false })
    if (!segments.length) segments.push({ text: '', masked: false })
    return { no: i + 1, segments }
  })
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function invalidateResult(): void {
  result.value = null
  stats.value = []
  edits.value = []
  mappings.value = []
  compareVisibleLines.value = 500
  savedPath.value = ''
}

function onFileTypeChange(): void {
  source.value = null
  invalidateResult()
}

async function pickFile(): Promise<void> {
  if (fileType.value !== 'oracle_awr' || busy.value) return
  busy.value = true
  try {
    const r = await window.sqlpilot.maskPickFile(fileType.value)
    if (!r.ok) {
      if (!r.canceled) await window.sqlpilot.uiAlert(r.error || '选择文件失败')
      return
    }
    await acceptFile(r.fileName || 'awr-report', r.size || r.content?.length || 0, r.content || '')
  } finally {
    busy.value = false
  }
}

async function onDrop(e: DragEvent): Promise<void> {
  dragOver.value = false
  if (fileType.value !== 'oracle_awr' || busy.value) return
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  await acceptBrowserFile(file)
}

async function acceptBrowserFile(file: File): Promise<void> {
  if (file.size > 20 * 1024 * 1024) {
    await window.sqlpilot.uiAlert('文件超过 20MB，请先拆分后再脱敏')
    return
  }
  busy.value = true
  try {
    const content = await file.text()
    await acceptFile(file.name, file.size, content)
  } catch (e: any) {
    await window.sqlpilot.uiAlert('读取文件失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}

async function acceptFile(fileName: string, size: number, content: string): Promise<void> {
  source.value = { fileName, size, content }
  invalidateResult()
  await runMask()
}

function clearFile(): void {
  source.value = null
  invalidateResult()
}

async function runMask(): Promise<void> {
  if (!source.value || fileType.value !== 'oracle_awr') return
  busy.value = true
  try {
    const r = await window.sqlpilot.maskText(fileType.value, source.value.content)
    if (!r.ok) {
      await window.sqlpilot.uiAlert(r.error || '脱敏失败')
      return
    }
    result.value = r.content || ''
    stats.value = r.stats || []
    edits.value = r.edits || []
    mappings.value = r.mappings || []
    mappingOpen.value = true
    outputMode.value = 'compare'
    savedPath.value = ''
  } catch (e: any) {
    await window.sqlpilot.uiAlert('脱敏失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}

async function copyResult(): Promise<void> {
  if (!result.value) return
  await window.sqlpilot.writeClipboard(result.value)
  pushNotice('已复制脱敏后的完整文本')
}

async function saveResult(): Promise<void> {
  if (!result.value || !source.value) return
  busy.value = true
  try {
    const r = await window.sqlpilot.maskSave(source.value.fileName, result.value)
    if (!r.ok) {
      if (!r.canceled) await window.sqlpilot.uiAlert(r.error || '保存失败')
      return
    }
    savedPath.value = r.path || ''
    pushNotice('脱敏文件已保存')
  } finally {
    busy.value = false
  }
}

function openSavedFolder(): void {
  if (savedPath.value) window.sqlpilot.showInFolder(savedPath.value)
}

function addRule(): void {
  activeRules.value.push({
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: '自定义规则',
    kind: 'custom',
    pattern: '',
    flags: 'im',
    replacement: '[MASKED.CUSTOM]',
    enabled: true
  })
}

function removeRule(rule: Rule): void {
  const rules = activeRules.value
  rules.splice(rules.findIndex(r => r.id === rule.id), 1)
  invalidateResult()
}

async function persistRules(notice: string): Promise<boolean> {
  if (!store.cfg) return false
  const r = await window.sqlpilot.setConfig(toPlain(store.cfg))
  if (!r?.ok) {
    await window.sqlpilot.uiAlert(r?.error || '规则保存失败')
    return false
  }
  pushNotice(notice)
  invalidateResult()
  return true
}

async function saveRules(): Promise<void> {
  for (const r of activeRules.value) {
    if (!r.name.trim()) return void window.sqlpilot.uiAlert('规则名称不能为空')
    if (!r.replacement) return void window.sqlpilot.uiAlert(`「${r.name}」的替换文本不能为空`)
    if (r.kind === 'custom') {
      if (!r.pattern?.trim()) return void window.sqlpilot.uiAlert(`「${r.name}」的正则表达式不能为空`)
      try {
        new RegExp(r.pattern, r.flags || '')
      } catch (e: any) {
        return void window.sqlpilot.uiAlert(`「${r.name}」正则无效：${e?.message || e}`)
      }
    }
  }
  if (await persistRules('脱敏规则已保存')) rulesOpen.value = false
}

async function resetRules(): Promise<void> {
  if (!store.cfg) return
  if (!(await window.sqlpilot.uiConfirm(`恢复${fileTypeLabel.value}的默认规则？`, '自定义规则会被删除，启用状态和替换文本会还原。', true))) return
  const defaults = await window.sqlpilot.maskDefaults()
  store.cfg.masking = { ...(store.cfg.masking || {}), [fileType.value]: defaults[fileType.value] }
  await persistRules('已恢复默认脱敏规则')
}

onMounted(async () => {
  if (!store.cfg) return
  if (!store.cfg.masking?.oracle_awr?.rules?.length) {
    const defaults = await window.sqlpilot.maskDefaults()
    store.cfg.masking = defaults
  }
})
</script>

<style scoped>
.masking-view {
  flex: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 14px 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 顶部说明压缩为一行，减少对对比区的占用 */
.mask-head {
  flex: 0 0 auto;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(135deg, var(--bg-card), var(--accent-dim));
}
.mask-head > div { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.mask-title { display: flex; align-items: center; gap: 9px; white-space: nowrap; }
.mask-title h2 { margin: 0; font-size: 17px; }
.mask-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 9px;
  background: var(--accent-dim); color: var(--accent); font-size: 15px;
}
.mask-badge {
  font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 99px;
  background: var(--green-dim); color: var(--green);
}
.mask-head p { margin: 0; color: var(--text-dim); font-size: 12px; line-height: 1.5; }

/* 紧凑导入区 */
.mask-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
  box-shadow: var(--shadow);
}
.upload-card { flex: 0 0 auto; padding: 10px 12px; }
.upload-bar {
  display: grid;
  grid-template-columns: 150px minmax(240px, 380px) minmax(320px, 1fr);
  gap: 10px;
  align-items: center;
}
.upload-field { display: flex; align-items: center; gap: 7px; }
.upload-field label { color: var(--text-dim); font-size: 12px; font-weight: 650; white-space: nowrap; }
.upload-field select { min-width: 0; flex: 1; padding: 6px 8px; font-size: 12.5px; }
.drop-zone {
  min-height: 56px;
  border: 1.5px dashed var(--border-strong);
  border-radius: 10px;
  background: var(--bg-input);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-content: center;
  justify-items: center;
  gap: 3px;
  padding: 7px 10px;
  cursor: pointer;
  text-align: center;
  transition: border-color .15s ease, background .15s ease;
}
.drop-zone:hover, .drop-zone.over { border-color: var(--accent); background: var(--accent-dim); }
.drop-zone.disabled { opacity: .55; cursor: not-allowed; }
.drop-zone.disabled:hover { border-color: var(--border-strong); background: var(--bg-input); }
.drop-zone b { font-size: 12.5px; }
.drop-meta { display: flex; align-items: center; gap: 7px; color: var(--text-dim); font-size: 10.5px; white-space: nowrap; }
.drop-zone em { color: var(--text-faint); font-style: normal; }
.upload-side { display: flex; align-items: center; justify-content: flex-end; gap: 9px; min-width: 0; flex-wrap: wrap; }
.source-info {
  flex: 1 1 auto; min-width: 180px; max-width: 380px;
  padding: 6px 8px; border-radius: 9px;
  background: var(--bg-input); border: 1px solid var(--border);
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; align-items: center;
}
.file-name { font-weight: 650; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-meta { grid-column: 1; color: var(--text-dim); font-size: 11px; }
.source-info .btn { grid-column: 2; grid-row: 1 / span 2; }
.actions { display: flex; gap: 6px; flex-wrap: nowrap; }
.small { font-size: 12px; padding: 5px 10px; }
.saved-line { margin-top: 8px; color: var(--text-dim); font-size: 11.5px; display: flex; gap: 6px; align-items: center; }
.saved-line code { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 12px; }

/* 对比区成为主工作区 */
.output-card { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
.card-title { font-size: 14px; font-weight: 700; }
.card-sub { margin-top: 3px; color: var(--text-dim); font-size: 11.5px; line-height: 1.7; }
.card-row { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; }
.output-toolbar {
  flex: 0 0 auto;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  margin-top: 9px; flex-wrap: wrap;
}
.view-tabs {
  display: inline-flex; padding: 3px; border-radius: 9px;
  border: 1px solid var(--border); background: var(--bg-input);
}
.view-tab {
  border: none; background: none; color: var(--text-dim); cursor: pointer;
  padding: 4px 10px; border-radius: 6px; font-size: 12px; font-family: inherit;
}
.view-tab.active { background: var(--accent); color: #fff; font-weight: 650; }
.compare-legend { display: flex; align-items: center; gap: 12px; color: var(--text-dim); font-size: 11px; flex-wrap: wrap; }
.compare-legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend-original, .legend-masked { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.legend-original { background: rgba(248, 113, 113, .35); border: 1px solid var(--red); }
.legend-masked { background: rgba(74, 222, 128, .28); border: 1px solid var(--green); }

.map-toggle {
  border: 1px solid var(--border); border-radius: 99px; background: var(--bg-input);
  color: var(--text-dim); cursor: pointer; padding: 2px 8px; font-size: 11px; font-family: inherit;
}
.map-toggle.active { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
.mapping-notes {
  flex: 0 0 auto; max-height: 92px; overflow-y: auto; margin-top: 8px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-input);
  padding: 6px 8px; display: flex; flex-direction: column; gap: 3px;
}
.mapping-row {
  display: grid; grid-template-columns: 112px minmax(120px, 240px) 12px minmax(110px, 150px) 48px;
  gap: 6px; align-items: center; font-size: 11px; min-width: 560px;
}
.mapping-label { color: var(--text-dim); }
.mapping-row code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.mapping-row span { color: var(--text-faint); }
.mapping-row b { color: var(--green); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.mapping-row em { color: var(--text-faint); font-style: normal; text-align: right; }
.replacement-preview {
  font-size: 10.5px; color: var(--text-faint); padding-top: 8px; text-align: center;
  white-space: nowrap;
}.compare-wrap {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 9px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-code);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.compare-heads {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}
.pane-head {
  padding: 6px 12px; color: var(--text-dim); font-size: 11px;
  font-weight: 700; letter-spacing: .4px;
}
.pane-head + .pane-head { border-left: 1px solid var(--border); }
.pane-head.masked-head { color: var(--green); }
.pane-body { flex: 1 1 auto; min-height: 0; overflow: auto; font-family: var(--mono); font-size: 12px; line-height: 1.6; }
.compare-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
}
.compare-cell { display: grid; grid-template-columns: 48px minmax(0, 1fr); align-items: start; min-height: 23px; }
.compare-cell + .compare-cell { border-left: 1px solid var(--border); }
.line-no {
  user-select: none; text-align: right; padding: 2px 9px 0; color: var(--text-faint);
  font-size: 10.5px; border-right: 1px solid var(--border);
  position: sticky; left: 0; background: var(--bg-code);
}
.line-text { white-space: pre-wrap; word-break: break-word; padding: 2px 11px 0 7px; }
.mark-original {
  background: rgba(248, 113, 113, .25); color: var(--red);
  border-radius: 3px; padding: 0 1px; box-shadow: inset 0 0 0 1px rgba(248, 113, 113, .35);
}
.mark-masked {
  background: rgba(74, 222, 128, .20); color: var(--green);
  border-radius: 3px; padding: 0 1px; box-shadow: inset 0 0 0 1px rgba(74, 222, 128, .35);
}
.compare-more { flex: 0 0 auto; display: flex; justify-content: center; padding: 7px; border-top: 1px solid var(--border); background: var(--bg-card); }
.compare-warning { flex: 0 0 auto; margin: 0; padding: 6px 12px; color: var(--yellow); font-size: 11px; }
.stat-chip {
  display: inline-block; margin: 0 5px 4px 0; padding: 1px 7px; border-radius: 99px;
  background: var(--accent-dim); color: var(--accent); font-size: 11px; font-weight: 650;
}
.result-pre {
  flex: 1 1 auto; min-height: 0; margin-top: 9px; overflow: auto;
  padding: 13px; border-radius: 11px; border: 1px solid var(--border);
  background: var(--bg-code); color: var(--text); font-family: var(--mono);
  font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
}
.result-empty {
  flex: 1 1 auto; min-height: 0; margin-top: 9px; border: 1px dashed var(--border);
  border-radius: 11px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--text-dim); text-align: center;
}
.result-empty span { font-size: 32px; margin-bottom: 8px; }
.result-empty b { color: var(--text); }
.result-empty p { margin: 7px 0 0; font-size: 12px; }

/* 规则浮窗 */
.rules-overlay {
  position: fixed; inset: 0; z-index: 520;
  background: rgba(0, 0, 0, .48);
  display: flex; align-items: center; justify-content: center;
  padding: 28px;
  padding-top: var(--titlebar-h);
}
.rules-modal {
  width: min(1000px, 94vw);
  max-height: min(86vh, 780px);
  display: flex; flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: var(--bg-card);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.rules-modal-head {
  flex: 0 0 auto;
  display: flex; justify-content: space-between; align-items: center; gap: 14px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.rule-actions { display: flex; align-items: center; gap: 6px; }
.rule-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 13px 16px; display: flex; flex-direction: column; gap: 8px; }
.rule-item {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) minmax(140px, 180px) auto;
  gap: 9px; align-items: start;
  padding: 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-input);
}
.rule-item.off { opacity: .62; }
.rule-main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.rule-name, .rule-item input { width: 100%; font-size: 12px; padding: 6px 8px; }
.rule-desc { margin: 0; color: var(--text-faint); font-size: 11px; line-height: 1.5; }
.custom-row { display: grid; grid-template-columns: 1fr 54px; gap: 6px; }
.mono { font-family: var(--mono); }
.flags { text-align: center; }
.replacement { font-family: var(--mono); }
.builtin-tag { font-size: 10.5px; color: var(--text-faint); padding-top: 8px; }
.icon-btn {
  width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg-card); color: var(--text-dim); cursor: pointer; font-size: 15px; line-height: 1;
}
.icon-btn:hover { border-color: var(--accent); color: var(--text); }
.icon-btn.modal-close { font-size: 18px; }
.rules-modal-foot {
  flex: 0 0 auto;
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding: 11px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg-side);
}
.rule-foot { margin: 0; color: var(--text-faint); font-size: 11px; line-height: 1.55; max-width: 720px; }

.switch { position: relative; display: inline-block; margin-top: 5px; cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.switch span {
  display: block; width: 32px; height: 18px; border-radius: 99px; background: var(--border-strong);
  transition: background .15s ease;
}
.switch span::after {
  content: ''; position: absolute; left: 2px; top: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: #fff; transition: transform .15s ease;
}
.switch input:checked + span { background: var(--accent); }
.switch input:checked + span::after { transform: translateX(14px); }

@media (max-width: 1150px) {
  .masking-view { overflow-y: auto; }
  .mask-head > div { flex-direction: column; align-items: flex-start; gap: 6px; }
  .upload-bar { grid-template-columns: 1fr; }
  .upload-side { justify-content: flex-start; flex-wrap: wrap; }
  .drop-meta { white-space: normal; justify-content: center; }
  .compare-row, .compare-heads { grid-template-columns: 1fr; }
  .compare-cell + .compare-cell, .pane-head + .pane-head { border-left: none; border-top: 1px solid var(--border); }
  .pane-body { max-height: 58vh; }
  .output-card { flex: 1 0 70vh; }
  .rule-item { grid-template-columns: auto 1fr; }
  .rule-item .rule-main { grid-column: 2; }
  .rule-item .replacement, .rule-item .builtin-tag, .rule-item .icon-btn { grid-column: 2; }
  .rules-modal-foot { flex-direction: column; align-items: stretch; }
}
</style>
