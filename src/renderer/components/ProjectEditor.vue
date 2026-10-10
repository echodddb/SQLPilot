<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 680px">
      <h3> 项目属性 — {{ form.name }}</h3>

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

      <!-- SSH 服务器（引用全局清单） -->
      <div class="sec-title">
        <b>SSH 远程服务器</b>（勾选引用全局清单，服务器在左侧"服务器"区维护）
        <button class="btn" style="font-size:12px; padding:3px 10px; margin-left:8px" @click="openServerModal()">＋ 新建服务器</button>
      </div>
      <div class="srv-pick">
        <div v-if="!allServers.length" style="color:var(--text-faint); font-size:12px; padding:4px 0">
          还没有可引用的服务器，点击「＋ 新建服务器」添加（SSH 密码认证，密码 DPAPI 加密存储）。
        </div>
        <label v-for="s in allServers" :key="s.id" class="srv-pick-item" :title="`${s.user}@${s.host}:${s.port}${s.note ? `\n${s.note}` : ''}`">
          <input type="checkbox" :value="s.id" v-model="form.serverIds" />
          <span>🖥 {{ s.name }}</span>
          <span class="chip-sub">{{ s.user }}@{{ s.host }}:{{ s.port }}{{ s.tag ? ` · ${s.tag}` : '' }}</span>
        </label>
      </div>

      <div class="actions">
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="save">保存项目</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref } from 'vue'
import { store, toPlain } from '../store'

const props = defineProps<{ project: any }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()
const openServerModal = inject<(s?: any) => void>('openServerModal')!

const form = reactive({
  id: props.project.id,
  name: props.project.name,
  rootPath: props.project.rootPath,
  description: props.project.description || '',
  // 服务器已全局注册，项目只存引用 id（兼容未迁移的内联定义：兜底从 servers 映射）
  serverIds: Array.isArray(props.project.serverIds)
    ? [...props.project.serverIds]
    : (props.project.servers || []).map((s: any) => s.id)
})

const allServers = computed(() => store.cfg?.servers || [])

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

async function save() {
  if (!form.name.trim()) { window.sqlpilot.uiAlert('项目名称必填'); return }
  const r = await window.sqlpilot.saveProject(toPlain({ ...form, description: form.description.trim() || undefined }))
  if (!r.ok) {
    window.sqlpilot.uiAlert((r as any).error || '保存失败')
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
/* 服务器引用勾选列表 */
.srv-pick { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
.srv-pick-item {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-card); font-size: 12.5px; cursor: pointer;
}
.srv-pick-item:hover { border-color: var(--accent); }
</style>
