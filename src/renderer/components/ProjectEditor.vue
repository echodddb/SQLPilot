<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 680px">
      <h3>📁 项目属性 — {{ form.name }}</h3>

      <div class="frow">
        <div class="fitem"><label>项目名称</label><input type="text" v-model="form.name" /></div>
        <div class="fitem" style="flex:2"><label>项目文件夹（只读）</label><input type="text" :value="form.rootPath" readonly style="opacity:.7" /></div>
      </div>
      <div class="frow">
        <div class="fitem">
          <label>项目说明（注入 AI 提示词：环境说明、注意事项，如"生产环境，写操作前必须备份"）</label>
          <textarea v-model="form.description" rows="2" style="width:100%" placeholder="例如：LIS 生产环境。数据库改动需走变更流程；服务器为 CentOS，Oracle 19c 在 /u01/app"></textarea>
        </div>
      </div>

      <!-- 数据库 -->
      <div class="sec-title">
        <b>数据库</b>（关联后 AI 优先使用，全局连接仍可用）
        <select v-model="addConnId" style="width:auto; padding:3px 8px; font-size:12px; margin-left:8px">
          <option value="" disabled>＋ 添加已有连接…</option>
          <option v-for="c in unboundConnections" :key="c.id" :value="c.id">{{ c.name }}（{{ c.type }}）</option>
        </select>
        <button v-if="addConnId" class="btn" style="font-size:12px; padding:3px 10px" @click="addConn">挂入</button>
      </div>
      <div class="chip-list">
        <span v-if="!projConns.length" style="color:var(--text-faint); font-size:12px">未关联数据库（项目可纯文件工作）</span>
        <span v-for="c in projConns" :key="c.id" class="chip">
          🗄 {{ c.name }} <span class="chip-sub">{{ c.type }} · {{ c.role === 'readonly' ? 'RO' : 'RW' }}</span>
          <button class="icon-btn" style="padding:0 2px" title="移出项目" @click="removeConn(c)">✕</button>
        </span>
      </div>

      <!-- SSH 服务器 -->
      <div class="sec-title">
        <b>SSH 远程服务器</b>（密码认证，密码 DPAPI 加密存储）
        <button class="btn" style="font-size:12px; padding:3px 10px; margin-left:8px" @click="newServer">＋ 添加服务器</button>
      </div>
      <div class="chip-list">
        <span v-if="!form.servers?.length" style="color:var(--text-faint); font-size:12px">未挂载服务器</span>
        <span v-for="s in form.servers" :key="s.id" class="chip">
          🖥 {{ s.name }} <span class="chip-sub">{{ s.user }}@{{ s.host }}:{{ s.port }}{{ s.tag ? ` · ${s.tag}` : '' }}</span>
          <button class="icon-btn" style="padding:0 2px" title="编辑" @click="editServer(s)">✎</button>
          <button class="icon-btn" style="padding:0 2px" title="移除" @click="removeServer(s)">✕</button>
        </span>
      </div>

      <!-- 服务器编辑表单 -->
      <div v-if="serverForm" class="server-form">
        <div class="frow">
          <div class="fitem"><label>名称 *</label><input v-model="serverForm.name" placeholder="如 db-prod-01" /></div>
          <div class="fitem"><label>标签</label>
            <select v-model="serverForm.tag">
              <option value="">无</option><option>生产</option><option>测试</option><option>开发</option>
            </select>
          </div>
        </div>
        <div class="frow">
          <div class="fitem" style="flex:2"><label>主机 *</label><input v-model="serverForm.host" placeholder="192.168.x.x" /></div>
          <div class="fitem"><label>端口</label><input type="number" v-model.number="serverForm.port" /></div>
          <div class="fitem"><label>用户名 *</label><input v-model="serverForm.user" placeholder="root / oracle" /></div>
        </div>
        <div class="frow">
          <div class="fitem"><label>密码{{ serverForm.__existing ? '（不修改则留空）' : ' *' }}</label><input type="password" v-model="serverForm.password" /></div>
          <div class="fitem" style="flex:2"><label>备注（注入提示词）</label><input v-model="serverForm.note" placeholder="如 Oracle 19c 服务器，alert 在 /u01/diag" /></div>
        </div>
        <div class="test-result" v-if="serverTestMsg" :style="{ color: serverTestOk ? 'var(--green)' : 'var(--red)' }">{{ serverTestMsg }}</div>
        <div style="display:flex; gap:8px; justify-content:flex-end">
          <button class="btn" :disabled="serverTesting" @click="testServerConn">{{ serverTesting ? '测试中…' : '测试连接' }}</button>
          <button class="btn ghost" @click="serverForm = null">取消</button>
          <button class="btn primary" @click="saveServer">{{ serverForm.__existing ? '保存修改' : '添加' }}</button>
        </div>
      </div>

      <div class="actions">
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="save">保存项目</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { store, toPlain } from '../store'

const props = defineProps<{ project: any }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const form = reactive({
  id: props.project.id,
  name: props.project.name,
  rootPath: props.project.rootPath,
  description: props.project.description || '',
  servers: JSON.parse(JSON.stringify(props.project.servers || [])) as any[]
})

const projConns = computed(() => (store.cfg?.connections || []).filter((c: any) => c.projectId === form.id))
const unboundConnections = computed(() => (store.cfg?.connections || []).filter((c: any) => c.projectId !== form.id))
const addConnId = ref('')

async function addConn() {
  if (!addConnId.value) return
  const c = (store.cfg?.connections || []).find((x: any) => x.id === addConnId.value)
  if (!c) return
  await window.sqlpilot.saveConn({ ...c, projectId: form.id })
  store.cfg = await window.sqlpilot.getConfig()
  addConnId.value = ''
}

async function removeConn(c: any) {
  await window.sqlpilot.saveConn({ ...c, projectId: null })
  store.cfg = await window.sqlpilot.getConfig()
}

// ---------- 服务器 ----------
const serverForm = ref<any>(null)
const serverTesting = ref(false)
const serverTestOk = ref(false)
const serverTestMsg = ref('')
const serverPasswords = reactive<Record<string, string>>({})

function newServer() {
  serverTestMsg.value = ''
  serverForm.value = { id: `srv_${Date.now()}`, name: '', host: '', port: 22, user: '', tag: '', note: '', password: '', __existing: false }
}

function editServer(s: any) {
  serverTestMsg.value = ''
  serverForm.value = { ...s, password: '', __existing: true }
}

async function testServerConn() {
  const f = serverForm.value
  if (!f.host || !f.user) { serverTestMsg.value = '请先填写主机和用户名'; serverTestOk.value = false; return }
  serverTesting.value = true
  serverTestMsg.value = ''
  try {
    const r = await window.sqlpilot.testServer({ ...f }, f.password || undefined)
    serverTestOk.value = r.ok
    serverTestMsg.value = r.ok ? `✓ ${r.label}` : `✗ ${r.error}`
  } catch (e: any) {
    serverTestOk.value = false
    serverTestMsg.value = `✗ ${e?.message || e}`
  } finally {
    serverTesting.value = false
  }
}

function saveServer() {
  const f = serverForm.value
  if (!f.name || !f.host || !f.user) { alert('名称、主机、用户名必填'); return }
  if (!f.__existing && !f.password) { alert('请填写密码'); return }
  // 同项目内服务器名必须唯一：agent 按名称寻址，重名会产生歧义
  if (form.servers.some((s: any) => s.name === f.name && s.id !== f.id)) {
    alert(`服务器名「${f.name}」在本项目中已存在，请换一个名称（agent 按名称寻址，不能重名）`)
    return
  }
  const { password, __existing, ...srv } = f
  if (password) serverPasswords[srv.id] = password
  const idx = form.servers.findIndex((s: any) => s.id === srv.id)
  if (idx >= 0) form.servers[idx] = srv
  else form.servers.push(srv)
  serverForm.value = null
}

function removeServer(s: any) {
  form.servers = form.servers.filter((x: any) => x.id !== s.id)
}

async function save() {
  if (!form.name.trim()) { alert('项目名称必填'); return }
  const r = await window.sqlpilot.saveProject(toPlain({ ...form, description: form.description.trim() || undefined }), { ...serverPasswords })
  if (!r.ok) {
    alert((r as any).error || '保存失败')
    return
  }
  store.cfg = await window.sqlpilot.getConfig()
  emit('saved')
}
</script>

<style scoped>
.frow { display: flex; gap: 10px; margin-bottom: 10px; }
.fitem { flex: 1; min-width: 0; }
.fitem label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
.sec-title { display: flex; align-items: center; font-size: 13px; margin: 16px 0 8px; color: var(--text); }
.sec-title b { color: var(--accent); }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-card); font-size: 12.5px;
}
.chip-sub { color: var(--text-faint); font-size: 11px; font-family: var(--mono); }
.server-form {
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  padding: 12px;
  margin-top: 10px;
  background: var(--bg-input);
}
.test-result { font-size: 12px; margin: 6px 0; word-break: break-all; }
</style>
