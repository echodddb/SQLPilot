<template>
  <div class="settings-wrap">
    <div class="settings-inner">
      <div class="card">
        <h3>大模型提供商</h3>
        <div class="desc">
          选择厂商后模型列表自动带出，无需手填。密钥经 Windows DPAPI 加密后存储在本机（config.json 不落明文）。
          顶栏可为每个会话选择不同模型；会话内可随时切换。
        </div>

        <div v-for="p in store.cfg.providers" :key="p.id" class="provider-item" :class="{ active: p.id === activeProviderId }">
          <b>{{ p.name }}</b>
          <span class="badge" :class="p.protocol === 'anthropic' ? 'green' : 'blue'">{{ vendorLabel(p.vendor) }}</span>
          <span style="font-family:var(--mono); font-size:12px">{{ p.model }}</span>
          <span style="flex:1"></span>
          <button v-if="p.id !== activeProviderId" class="btn" @click="setActive(p.id)">设为默认</button>
          <span v-else class="badge green">默认</span>
          <button class="icon-btn" @click="editP = { ...p }">✎</button>
          <button class="icon-btn" @click="delProvider(p)">✕</button>
        </div>
        <div v-if="!store.cfg.providers.length" class="desc" style="text-align:center; padding:16px 0">尚未配置模型</div>

        <div style="border-top:1px solid var(--border); margin-top:14px; padding-top:14px">
          <div style="font-size:13px; margin-bottom:10px">{{ editP.id ? '编辑提供商' : '添加提供商' }}</div>

          <div class="frow">
            <div class="fitem" style="flex:1">
              <label>显示名称</label>
              <input type="text" v-model="editP.name" placeholder="如 DeepSeek-思考" />
            </div>
            <div class="fitem" style="width:230px">
              <label>厂商</label>
              <select v-model="editP.vendor" @change="onVendorChange">
                <option v-for="v in VENDOR_CATALOG" :key="v.id" :value="v.id">{{ v.label }}</option>
              </select>
            </div>
          </div>

          <div class="frow">
            <div class="fitem" style="flex:2">
              <label>Base URL{{ editP.vendor === 'custom' ? '（自定义必填）' : '' }}</label>
              <input type="text" v-model="editP.baseUrl" :disabled="editP.vendor !== 'custom'" :placeholder="currentVendor.baseUrl || 'https://…/v1'" />
            </div>
            <div class="fitem" style="flex:2">
              <label>模型（可从列表选择，也可手动填写任意型号 ID）</label>
              <input type="text" v-model="editP.model" list="model-presets" :placeholder="currentVendor.models[0]?.id || '模型名，如 glm-5.3'" />
              <datalist id="model-presets">
                <option v-for="m in currentVendor.models" :key="m.id" :value="m.id">
                  {{ m.label }}{{ m.note ? ` — ${m.note}` : '' }}
                </option>
              </datalist>
            </div>
            <div class="fitem" style="width: 150px">
              <label>上下文窗口 K</label>
              <input type="number" v-model.number="editP.contextK" :placeholder="String(presetContextK())" title="会话上下文占用百分比的分母；留空用厂商预设" />
            </div>
          </div>

          <div class="frow">
            <div class="fitem" style="flex:2">
              <label>API Key</label>
              <input type="password" v-model="editP.apiKey" :placeholder="!editP.id ? 'sk-…' : editP.hasKey ? '（已保存，留空则沿用）' : '（尚未保存 Key）'" />
            </div>
            <div class="fitem" style="flex:0 0 auto; align-self: flex-end">
              <button class="btn" :disabled="testing" @click="doTestProvider" style="margin-bottom:1px">{{ testing ? '测试中…' : '测试模型' }}</button>
            </div>
          </div>
          <div class="test-result" v-if="testMsg" :style="{ color: testOk ? 'var(--green)' : 'var(--red)', whiteSpace: 'pre-wrap' }">{{ testMsg }}</div>

          <div style="display:flex; gap:8px; justify-content:flex-end">
            <button v-if="editP.id" class="btn ghost" @click="resetForm">取消编辑</button>
            <button class="btn primary" @click="saveProvider">{{ editP.id ? '保存修改' : '添加' }}</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>技能（Skills）
          <button class="btn" style="font-size:12px; margin-left:8px" @click="newSkill">＋ 新建</button>
          <button class="btn ghost" style="font-size:12px; margin-left:4px" @click="doImport">导入文件…</button>
        </h3>
        <div class="desc">
          技能是一份 Markdown 指令（SKILL.md，含名称和描述），可带附属资源文件。启用后模型会在任务匹配时自动读取并遵循其步骤——
          把 DBA 操作手册、巡检流程写成技能即可复用。支持导入 .md 单文件或 .zip / 目录技能包（如
          <a href="#" @click.prevent="fillOracleSkillsUrl">oracle/oracle-skills</a>）。
        </div>
        <div class="frow" style="margin-top:10px">
          <div class="fitem" style="flex:1">
            <input type="text" v-model="importUrl" placeholder="技能包 URL：GitHub 仓库链接或 .zip 直链" style="width:100%" @keyup.enter="doImportUrl" />
          </div>
          <div class="fitem" style="flex:0 0 auto">
            <button class="btn primary" :disabled="importing || !importUrl.trim()" @click="doImportUrl">{{ importing ? '下载导入中…' : '从 URL 导入' }}</button>
          </div>
        </div>
        <div v-if="importMsg" class="test-result" :style="{ color: importOk ? 'var(--green)' : 'var(--red)', whiteSpace: 'pre-wrap' }">{{ importMsg }}</div>

        <div v-for="s in skills" :key="s.id" class="provider-item">
          <input type="checkbox" :checked="s.enabled" @change="toggleSkill(s, ($event.target as HTMLInputElement).checked)" title="启用/停用" />
          <b>{{ s.name }}</b>
          <span v-if="s.files && s.files > 1" class="badge blue" title="技能包：SKILL.md + 附属资源文件">{{ s.files }} 个文件</span>
          <span style="color:var(--text-dim); font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ s.description }}</span>
          <button class="icon-btn" @click="editSkill(s)" title="编辑">✎</button>
          <button class="icon-btn" @click="delSkill(s)" title="删除">✕</button>
        </div>
        <div v-if="!skills.length" class="desc" style="text-align:center; padding:12px 0">暂无技能</div>

        <div v-if="skillEditor" style="border-top:1px solid var(--border); margin-top:14px; padding-top:14px">
          <div style="font-size:13px; margin-bottom:10px">{{ skillEditor.id ? '编辑技能' : '新建技能' }}</div>
          <div class="frow">
            <div class="fitem"><label>名称</label><input type="text" v-model="skillEditor.name" placeholder="如：每周巡检报告" /></div>
            <div class="fitem" style="flex:2"><label>描述（模型据此判断何时使用）</label><input type="text" v-model="skillEditor.description" placeholder="生成每周数据库巡检报告，含表空间/慢SQL/备份检查" /></div>
          </div>
          <div class="frow">
            <div class="fitem">
              <label>指令内容（Markdown，模型将逐步遵循）</label>
              <textarea v-model="skillEditor.content" rows="8" style="width:100%; font-family:var(--mono); font-size:12.5px" placeholder="1. 查询 v$tablespace…&#10;2. 汇总为表格…&#10;3. 用 fs_write 写入 巡检报告.md"></textarea>
            </div>
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end">
            <button class="btn ghost" @click="skillEditor = null">取消</button>
            <button class="btn primary" @click="saveSkillEditor">保存技能</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>通用</h3>
        <label style="display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px">Oracle Instant Client 目录（全局默认，连接 11g 时需要）</label>
        <div style="display:flex; gap:8px">
          <input type="text" v-model="icDir" placeholder="D:\instantclient_19_28" style="flex:1" />
          <button class="btn" @click="saveGeneral">保存</button>
        </div>
        <div class="desc" style="margin-top:8px">
          下载：Oracle 官网 "Instant Client for Windows x64" Basic Light 包（19c 版本，约 80MB），解压后把目录填到这里。19c 纯协议连接可不需要；11g 必需。
          <br />新会话默认权限模式：
          <select v-model="defaultMode" @change="saveGeneral" style="width:auto; padding:3px 8px">
            <option v-for="m in MODES" :key="m.key" :value="m.key">{{ m.label }}</option>
          </select>
          <br />密码加密存储（Windows DPAPI）：{{ store.secretsAvailable ? '✓ 可用' : '✗ 不可用' }}
        </div>
        <div class="privacy-cfg">
          <label class="privacy-item">
            <input type="checkbox" :checked="store.cfg?.maskPromptDetails !== false" @change="toggleCfg('maskPromptDetails', $event)" />
            <span>系统提示词脱敏<em>（默认开）</em>：不向大模型发送连接服务名/库名、服务器地址账号、项目本地路径等明细，模型按名称寻址</span>
          </label>
          <label class="privacy-item">
            <input type="checkbox" :checked="!!store.cfg?.previewLlm" @change="toggleCfg('previewLlm', $event)" />
            <span>大模型发送前预览<em>（默认关）</em>：每次请求前弹窗展示完整发送内容，确认后才发出（开启/关闭立即生效，含正在进行的回合）</span>
          </label>
        </div>
      </div>

      <div class="card">
        <h3>审计日志 <span class="desc" style="font-weight:normal">结构化可查 · 共 {{ auditTotal }} 条匹配</span>
          <button class="btn ghost" style="font-size:12px; margin-left:8px" @click="runAuditQuery">刷新</button>
        </h3>
        <div class="desc">字段规范与完整日志见 userData/audit.log（JSONL）；子代理记录可按 runId 关联 subagent-runs/ 下的完整过程</div>

        <div class="audit-filters">
          <select v-model="auditF.kind" @change="runAuditQuery">
            <option value="">全部类型</option>
            <option v-for="(label, k) in AUDIT_KINDS" :key="k" :value="k">{{ label }}</option>
          </select>
          <select v-model="auditF.actor" @change="runAuditQuery">
            <option value="">全部来源</option>
            <option v-for="(label, a) in AUDIT_ACTORS" :key="a" :value="a">{{ label }}</option>
          </select>
          <select v-model="auditF.conn" @change="runAuditQuery">
            <option value="">全部连接</option>
            <option v-for="c in (store.cfg?.connections || [])" :key="c.id" :value="c.name">{{ c.name }}</option>
          </select>
          <select v-model="auditF.range" @change="runAuditQuery">
            <option value="">全部时间</option>
            <option value="1d">近 24 小时</option>
            <option value="7d">近 7 天</option>
            <option value="today">今天</option>
          </select>
          <label style="display:flex; align-items:center; gap:4px; font-size:12px; color:var(--text-dim)">
            <input type="checkbox" v-model="auditF.errorsOnly" @change="runAuditQuery" /> 只看失败
          </label>
          <input v-model="auditF.q" placeholder="搜索 SQL / 对象 / 错误…" style="flex:1; min-width:140px" @keyup.enter="runAuditQuery" />
          <button class="btn" style="font-size:12px" @click="runAuditQuery">搜索</button>
        </div>

        <div class="audit-table">
          <div class="audit-row audit-head-row">
            <span class="c-ts">时间</span><span class="c-kind">类型</span><span class="c-actor">来源</span><span class="c-conn">连接</span><span class="c-detail">操作</span><span class="c-meta">行/耗时</span><span class="c-st">状态</span>
          </div>
          <div v-for="(a, i) in audit" :key="i" class="audit-row" :class="{ open: auditOpen === i, err: !!a.error }" @click="auditOpen = auditOpen === i ? -1 : i">
            <span class="c-ts">{{ a.ts?.replace('T', ' ').slice(5, 19) }}</span>
            <span class="c-kind"><b :class="'k-' + (a.kind || '').replace('.', '-')">{{ AUDIT_KINDS[a.kind] || a.kind }}</b></span>
            <span class="c-actor">{{ AUDIT_ACTORS[a.actor] || a.actor || '—' }}</span>
            <span class="c-conn">{{ a.conn || '—' }}</span>
            <span class="c-detail">{{ a.detail?.slice(0, 90) }}<em v-if="a.target"> · {{ a.target }}</em></span>
            <span class="c-meta">{{ [a.rows != null ? `${a.rows}行` : '', a.ms != null ? `${a.ms}ms` : ''].filter(Boolean).join(' ') || '—' }}</span>
            <span class="c-st" :style="{ color: a.approved === false ? 'var(--orange, #e6a23c)' : a.error ? 'var(--red)' : 'var(--green)' }">{{ a.approved === false ? '拦截' : a.error ? '✗' : '✓' }}</span>
            <div v-if="auditOpen === i" class="audit-expand">
              <template v-if="a.sql"><div class="lbl">SQL</div><pre>{{ a.sql }}</pre></template>
              <template v-if="a.target"><div class="lbl">对象</div><div>{{ a.target }}</div></template>
              <template v-if="a.error"><div class="lbl">错误</div><div style="color:var(--red)">{{ a.error }}</div></template>
              <div class="lbl">明细</div>
              <div style="white-space:pre-wrap">{{ a.detail }}</div>
              <div v-if="a.runId" class="lbl">子代理运行 {{ a.runId }}（完整过程：工具卡片 → 查看完整过程）</div>
            </div>
          </div>
        </div>
        <div v-if="!audit.length" class="desc" style="text-align:center">无匹配记录</div>
        <div v-if="auditHasMore" style="text-align:center; margin-top:8px">
          <button class="btn ghost" style="font-size:12px" @click="loadMoreAudit">加载更多（已显示 {{ audit.length }} / {{ auditTotal }}）</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { store, MODES, toPlain, pushNotice } from '../store'
import { VENDOR_CATALOG } from '../../main/agent/catalog'

const editP = ref<any>({ name: '', vendor: 'deepseek', protocol: 'openai', baseUrl: '', apiKey: '', model: '', effort: 'off', contextK: undefined })
const icDir = ref(store.cfg?.instantClientDir || '')
const defaultMode = ref(store.cfg?.mode || 'readonly')
const audit = ref<any[]>([])
const skills = ref<any[]>([])
const skillEditor = ref<any>(null)
const testing = ref(false)
const testOk = ref(false)
const testMsg = ref('')

async function doTestProvider() {
  testing.value = true
  testMsg.value = ''
  try {
    const r = await window.sqlpilot.testProvider({ ...editP.value }, editP.value.apiKey || undefined)
    testOk.value = r.ok
    testMsg.value = r.ok ? `✓ ${r.label}` : `✗ ${r.error}`
  } catch (e: any) {
    testOk.value = false
    testMsg.value = `✗ ${e?.message || e}`
  } finally {
    testing.value = false
  }
}

const activeProviderId = computed(() => store.cfg?.activeProviderId)

const currentVendor = computed(() => VENDOR_CATALOG.find((v) => v.id === editP.value.vendor) || VENDOR_CATALOG[0])

/** 当前所选模型的厂商预设上下文窗口（K），作为表单占位与默认值 */
function presetContextK(): number {
  const m = currentVendor.value.models.find((x) => x.id === editP.value.model)
  return m?.contextK || 128
}

function vendorLabel(id: string | undefined) {
  return VENDOR_CATALOG.find((v) => v.id === id)?.label.split('（')[0].split(' ')[0] || '自定义'
}

function onVendorChange() {
  const v = currentVendor.value
  editP.value.protocol = v.protocol
  editP.value.baseUrl = v.baseUrl
  // 型号联动：仅当为空或原本就是某厂商预设值时才预填，手填的型号不动
  const isPresetModel = (m: string) => !m || VENDOR_CATALOG.some((x) => x.models.some((mm) => mm.id === m))
  if (isPresetModel(editP.value.model)) editP.value.model = v.models[0]?.id || ''
  editP.value.effort = v.thinkingStyle === 'none' ? 'off' : editP.value.effort || 'off'
  // 自动生成的名称跟随厂商切换（用户改过则不动）
  const isAutoName = (n: string) => !n || VENDOR_CATALOG.some((x) => vendorLabel(x.id) === n)
  if (isAutoName(editP.value.name)) editP.value.name = vendorLabel(v.id)
}

onMounted(() => {
  loadAudit()
  loadSkills()
  if (!editP.value.id) onVendorChange()
})

watch(
  () => store.cfg,
  () => {
    icDir.value = store.cfg?.instantClientDir || ''
    defaultMode.value = store.cfg?.mode || 'readonly'
  }
)

async function loadAudit() {
  await runAuditQuery()
}

// ---------- 结构化审计查询 ----------
const AUDIT_KINDS: Record<string, string> = {
  'sql.read': '读',
  'sql.write': '写',
  'tool': '工具',
  'subagent': '子代理',
  'conn': '连接',
  'llm.error': 'LLM错误',
  'ui.error': '界面错误'
}
const AUDIT_ACTORS: Record<string, string> = {
  'agent': '主代理',
  'sub:*': '子代理(全部)',
  'human': '人工',
  'app': '应用'
}
const auditF = ref<{ kind: string; actor: string; conn: string; range: string; q: string; errorsOnly: boolean }>({ kind: '', actor: '', conn: '', range: '', q: '', errorsOnly: false })
const auditOpen = ref(-1)
const auditTotal = ref(0)
const auditHasMore = ref(false)
const AUDIT_PAGE = 100

async function runAuditQuery(reset = true): Promise<void> {
  if (reset) {
    audit.value = []
    auditOpen.value = -1
  }
  const f = auditF.value
  const now = Date.now()
  let fromMs: number | undefined
  if (f.range === '1d') fromMs = now - 24 * 3600_000
  else if (f.range === '7d') fromMs = now - 7 * 24 * 3600_000
  else if (f.range === 'today') {
    const d = new Date()
    fromMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const r = await window.sqlpilot.auditQuery({
    kinds: f.kind ? [f.kind] : undefined,
    actors: f.actor ? [f.actor] : undefined,
    conns: f.conn ? [f.conn] : undefined,
    q: f.q.trim() || undefined,
    fromMs,
    errorsOnly: f.errorsOnly || undefined,
    limit: AUDIT_PAGE,
    offset: audit.value.length
  })
  audit.value = audit.value.concat(r.entries || [])
  auditTotal.value = r.total
  auditHasMore.value = r.hasMore
}

async function loadMoreAudit(): Promise<void> {
  await runAuditQuery(false)
}

async function loadSkills() {
  skills.value = await window.sqlpilot.listSkills()
}

async function saveProvider() {
  let p = { ...editP.value }
  // 厂商预设自动补全（防止表单状态缺失导致"必填"误报）
  const v = VENDOR_CATALOG.find((x) => x.id === p.vendor)
  if (v && p.vendor !== 'custom') {
    if (!p.protocol) p.protocol = v.protocol
    if (!p.baseUrl) p.baseUrl = v.baseUrl
    if (!p.model && v.models.length) p.model = v.models[0].id
  }
  if (!p.name || !p.baseUrl || !p.model) { alert('名称、Base URL、模型均必填'); return }
  if (!p.id && !p.apiKey) { alert('请填写 API Key'); return }
  if (!p.id) p.id = `p_${Date.now()}`
  if (!p.contextK || p.contextK <= 0) p.contextK = undefined
  // 空 Key = 沿用已存（主进程对空值不覆盖 secrets；渲染层拿到的是掩码，没有明文可回填）
  try {
    const idx = store.cfg.providers.findIndex((x: any) => x.id === p.id)
    if (idx >= 0) store.cfg.providers[idx] = p
    else store.cfg.providers.push(p)
    if (!store.cfg.activeProviderId) store.cfg.activeProviderId = p.id
    await window.sqlpilot.setConfig(toPlain(store.cfg))
    // 重新拉取掩码配置，避免刚输入的明文 Key 常驻渲染层状态
    store.cfg = await window.sqlpilot.getConfig()
  } catch (e: any) {
    alert('保存失败：' + (e?.message || e))
    return
  }
  resetForm()
}

async function setActive(id: string) {
  store.cfg.activeProviderId = id
  await window.sqlpilot.setConfig(toPlain(store.cfg))
}

async function delProvider(p: any) {
  if (!window.confirm(`删除提供商「${p.name}」？`)) return
  store.cfg.providers = store.cfg.providers.filter((x: any) => x.id !== p.id)
  if (store.cfg.activeProviderId === p.id) store.cfg.activeProviderId = store.cfg.providers[0]?.id || null
  await window.sqlpilot.setConfig(toPlain(store.cfg))
}

async function saveGeneral() {
  store.cfg.instantClientDir = icDir.value.trim() || undefined
  store.cfg.mode = defaultMode.value
  await window.sqlpilot.setConfig(toPlain(store.cfg))
}

/** 隐私相关开关：即改即存（maskPromptDetails / previewLlm）；预览开关变化时在聊天里给提示 */
async function toggleCfg(key: 'maskPromptDetails' | 'previewLlm', e: Event) {
  const on = (e.target as HTMLInputElement).checked
  store.cfg[key] = on
  await window.sqlpilot.setConfig(toPlain(store.cfg))
  if (key === 'previewLlm') {
    pushNotice(on
      ? '👁 已开启发送前预览：下一次把内容发给大模型前会弹窗展示完整请求，确认后才发出'
      : '👁 已关闭发送前预览：请求将直接发出（脱敏不受影响，仍默认开启）')
  }
}

function resetForm() {
  editP.value = { name: '', vendor: 'deepseek', protocol: 'openai', baseUrl: '', apiKey: '', model: '', effort: 'off', contextK: undefined }
  onVendorChange()
}

// ---------- 技能 ----------
function newSkill() {
  skillEditor.value = { id: '', name: '', description: '', content: '' }
}

async function editSkill(s: any) {
  const r = await window.sqlpilot.readSkillFull(s.id)
  skillEditor.value = { ...s, content: r.ok ? r.content : '' }
}

async function toggleSkill(s: any, enabled: boolean) {
  s.enabled = enabled
  await window.sqlpilot.toggleSkill(s.id, enabled)
}

async function delSkill(s: any) {
  if (!window.confirm(`删除技能「${s.name}」？`)) return
  await window.sqlpilot.deleteSkill(s.id)
  await loadSkills()
}

async function saveSkillEditor() {
  const e = skillEditor.value
  if (!e.name || !e.content?.trim()) { alert('名称和内容必填'); return }
  await window.sqlpilot.saveSkill({ id: e.id || undefined, name: e.name, description: e.description || '', content: e.content })
  skillEditor.value = null
  await loadSkills()
}

async function doImport() {
  const r = await window.sqlpilot.importSkill()
  if (r.ok) {
    showImportResult(r.pack ? { imported: r.pack.imported, updated: r.pack.updated } : null, r.skill ? [r.skill.name] : [])
    await loadSkills()
  } else if (r.error) {
    importOk.value = false
    importMsg.value = '✗ 导入失败：' + r.error
  }
}

const importUrl = ref('')
const importing = ref(false)
const importOk = ref(true)
const importMsg = ref('')

function fillOracleSkillsUrl() {
  importUrl.value = 'https://github.com/oracle/oracle-skills'
}

/** 导入结果反馈：包导入列出技能名，单文件导入只报数量 */
function showImportResult(pack: { imported: { name: string }[]; updated: { name: string }[] } | null, single: string[]) {
  importOk.value = true
  if (pack) {
    const parts: string[] = []
    if (pack.imported.length) parts.push(`新增 ${pack.imported.length} 个：${pack.imported.map((s) => s.name).join('、')}`)
    if (pack.updated.length) parts.push(`更新 ${pack.updated.length} 个：${pack.updated.map((s) => s.name).join('、')}`)
    importMsg.value = '✓ ' + (parts.join('；') || '（包内没有可导入的技能）')
  } else if (single.length) {
    importMsg.value = `✓ 已导入技能：${single.join('、')}`
  }
}

async function doImportUrl() {
  const url = importUrl.value.trim()
  if (!url || importing.value) return
  importing.value = true
  importMsg.value = ''
  try {
    const r = await window.sqlpilot.importSkillUrl(url)
    if (r.ok) {
      showImportResult(r.pack ? { imported: r.pack.imported, updated: r.pack.updated } : null, [])
      await loadSkills()
    } else {
      importOk.value = false
      importMsg.value = '✗ ' + (r.error || '导入失败')
    }
  } catch (e: any) {
    importOk.value = false
    importMsg.value = '✗ ' + (e?.message || e)
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.frow { display: flex; gap: 10px; margin-bottom: 10px; }
.fitem { flex: 1; min-width: 0; }
.fitem label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
.privacy-cfg { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 8px; }
.privacy-item { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--text-dim); cursor: pointer; line-height: 1.6; }
.privacy-item em { color: var(--text-faint); font-style: normal; }

/* 审计查看器 */
.audit-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0; }
.audit-filters select, .audit-filters input { border: 1px solid var(--border); background: var(--bg-card); color: var(--text); border-radius: 5px; font-size: 12px; padding: 3px 8px; font-family: inherit; }
.audit-table { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 12px; max-height: 480px; overflow-y: auto; }
.audit-row { display: grid; grid-template-columns: 110px 62px 84px 90px 1fr 90px 36px; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--border); cursor: pointer; align-items: baseline; }
.audit-row:hover { background: var(--bg-hover, rgba(128,128,128,.07)); }
.audit-row.err .c-detail { color: var(--red); }
.audit-head-row { position: sticky; top: 0; background: var(--bg-card); color: var(--text-dim); font-size: 11px; cursor: default; z-index: 1; }
.c-ts { color: var(--text-faint); font-size: 11px; white-space: nowrap; }
.c-kind b { font-weight: 500; font-size: 11px; padding: 1px 5px; border-radius: 3px; background: var(--border); color: var(--text-dim); }
.c-kind .k-sql-write { background: #c53030; color: #fff; }
.c-kind .k-sql-read { background: #2b6cb0; color: #fff; }
.c-kind .k-subagent { background: #6b46c1; color: #fff; }
.c-kind .k-llm-error, .c-kind .k-ui-error { background: #c05621; color: #fff; }
.c-actor, .c-conn { color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c-detail em { color: var(--text-faint); font-style: normal; font-size: 11px; }
.c-meta { color: var(--text-faint); font-size: 11px; white-space: nowrap; text-align: right; }
.c-st { text-align: center; }
.audit-expand { grid-column: 1 / -1; padding: 6px 0 4px; color: var(--text-dim); font-size: 12px; }
.audit-expand .lbl { font-size: 11px; color: var(--text-faint); margin: 4px 0 2px; }
.audit-expand pre { white-space: pre-wrap; word-break: break-all; background: var(--bg2, rgba(0,0,0,.15)); padding: 6px; border-radius: 4px; margin: 2px 0; max-height: 220px; overflow: auto; }
</style>
