<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <h3>{{ editing ? '编辑连接' : '新增连接' }}</h3>

      <div class="form-row">
        <div>
          <label>连接名称 *</label>
          <input type="text" v-model="form.name" placeholder="如：lisdb-19c" />
        </div>
        <div>
          <label>类型</label>
          <select v-model="form.type">
            <option value="oracle">Oracle（11g / 19c）</option>
            <option value="ob-mysql">OceanBase · MySQL 租户</option>
            <option value="mysql">MySQL</option>
            <option value="ob-oracle" disabled>OceanBase · Oracle 租户（M2 接入）</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div style="flex:2">
          <label>主机</label>
          <input type="text" v-model="form.host" placeholder="192.168.x.x" />
        </div>
        <div>
          <label>端口</label>
          <input type="number" v-model.number="form.port" />
        </div>
      </div>

      <div class="form-row" v-if="form.type === 'oracle'">
        <div>
          <label>服务名（Service Name）</label>
          <input type="text" v-model="form.serviceName" placeholder="orcl" />
        </div>
      </div>
      <div class="form-row" v-else>
        <div>
          <label>数据库（可留空）</label>
          <input type="text" v-model="form.database" placeholder="业务库名" />
        </div>
      </div>

      <div class="form-row">
        <div>
          <label>用户名</label>
          <input type="text" v-model="form.user" placeholder="数据库账号" />
        </div>
        <div>
          <label>密码</label>
          <input type="password" v-model="password" :placeholder="editing ? '（未修改则留空）' : ''" />
        </div>
        <div>
          <label>账号角色</label>
          <select v-model="form.role">
            <option value="readonly">只读账号</option>
            <option value="admin">管理账号</option>
          </select>
        </div>
      </div>

      <div class="form-row" v-if="form.type === 'oracle'">
        <div>
          <label>Instant Client 目录（连 11g 必填；19c 纯协议可留空）</label>
          <input type="text" v-model="form.instantClientDir" placeholder="D:\instantclient_19_x，留空则用全局设置" />
        </div>
      </div>

      <div class="form-row">
        <div>
          <label>关联项目（可选：关联后作为该项目的库；不关联则全局可用）</label>
          <select v-model="form.projectId">
            <option value="">不关联（全局）</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </div>

      <div class="test-result" v-if="testMsg" :style="{ color: testOk ? 'var(--green)' : 'var(--red)' }">{{ testMsg }}</div>

      <div class="actions">
        <button class="btn" @click="doTest" :disabled="testing">{{ testing ? '测试中…' : '测试连接' }}</button>
        <span style="flex:1"></span>
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="doSave">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { store } from '../store'

const props = defineProps<{ editing: any }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const DEFAULT_PORT: Record<string, number> = { oracle: 1521, mysql: 3306, 'ob-mysql': 2881, 'ob-oracle': 2881 }

const form = reactive({
  id: props.editing?.id || `conn_${Date.now()}`,
  name: props.editing?.name || '',
  type: props.editing?.type || 'oracle',
  host: props.editing?.host || '',
  port: props.editing?.port || 1521,
  serviceName: props.editing?.serviceName || '',
  database: props.editing?.database || '',
  user: props.editing?.user || '',
  role: props.editing?.role || 'readonly',
  instantClientDir: props.editing?.instantClientDir || '',
  projectId: (props.editing?.projectId as string) || ''
})

const projects = computed(() => store.cfg?.projects || [])

const password = ref('')
const testing = ref(false)
const testOk = ref(false)
const testMsg = ref('')

// 切换数据库类型时联动默认端口（用户已手改过端口则不覆盖）
let portTouched = false
watch(
  () => form.port,
  () => { portTouched = true },
  { once: true }
)
watch(
  () => form.type,
  (t, old) => {
    if (t !== old && !portTouched) form.port = DEFAULT_PORT[t] ?? 3306
  }
)

async function doTest() {
  if (!form.host || !form.user) { testMsg.value = '请先填写主机和用户名'; testOk.value = false; return }
  testing.value = true
  testMsg.value = ''
  try {
    const r = await window.sqlpilot.testConn({ ...form }, password.value)
    testOk.value = r.ok
    testMsg.value = r.ok ? `✓ 连接成功：${r.label}` : `✗ ${r.error}`
  } catch (e: any) {
    testOk.value = false
    testMsg.value = `✗ ${e?.message || e}`
  } finally {
    testing.value = false
  }
}

async function doSave() {
  if (!form.name || !form.host || !form.user) { alert('名称、主机、用户名为必填'); return }
  if (form.type === 'oracle' && !form.serviceName) { alert('Oracle 需要填写服务名'); return }
  const r = await window.sqlpilot.saveConn({ ...form, projectId: form.projectId || null }, password.value || undefined)
  if (!r.ok) { alert(r.error || '保存失败'); return }
  store.cfg = await window.sqlpilot.getConfig()
  if (store.tree[form.id]) store.tree[form.id].schemas = undefined
  emit('close')
}
</script>
