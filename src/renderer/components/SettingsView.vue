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
          <button class="btn ghost" style="font-size:12px; margin-left:4px" @click="doImport">导入 .md</button>
        </h3>
        <div class="desc">
          技能是一份 Markdown 指令（含名称和描述）。启用后模型会在任务匹配时自动读取并遵循其步骤——把您的 DBA
          操作手册、巡检流程、报表规范写成技能即可复用。
        </div>

        <div v-for="s in skills" :key="s.id" class="provider-item">
          <input type="checkbox" :checked="s.enabled" @change="toggleSkill(s, ($event.target as HTMLInputElement).checked)" title="启用/停用" />
          <b>{{ s.name }}</b>
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
      </div>

      <div class="card">
        <h3>审计日志 <button class="btn ghost" style="font-size:12px; margin-left:8px" @click="loadAudit">刷新</button></h3>
        <div class="desc">每次 SQL 执行 / 文件写入 / 工具调用 / 拦截记录（最近 300 条，完整日志在 userData/audit.log）</div>
        <div v-for="(a, i) in audit" :key="i" class="audit-line">
          <b>{{ a.ts?.replace('T', ' ').slice(0, 19) }}</b>　[{{ a.kind }}] {{ a.conn ? `@${a.conn} ` : '' }}{{ a.detail?.slice(0, 120) }}
          <span v-if="a.error" style="color:var(--red)"> → {{ a.error }}</span>
        </div>
        <div v-if="!audit.length" class="desc" style="text-align:center">暂无记录</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { store, MODES, toPlain } from '../store'
import { VENDOR_CATALOG } from '../../main/agent/catalog'

const editP = ref<any>({ name: '', vendor: 'deepseek', protocol: 'openai', baseUrl: '', apiKey: '', model: '', effort: 'off' })
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
  audit.value = (await window.sqlpilot.getAudit()).slice().reverse()
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

function resetForm() {
  editP.value = { name: '', vendor: 'deepseek', protocol: 'openai', baseUrl: '', apiKey: '', model: '', effort: 'off' }
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
  if (r.ok) await loadSkills()
  else if (r.error) alert('导入失败：' + r.error)
}
</script>

<style scoped>
.frow { display: flex; gap: 10px; margin-bottom: 10px; }
.fitem { flex: 1; min-width: 0; }
.fitem label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
</style>
