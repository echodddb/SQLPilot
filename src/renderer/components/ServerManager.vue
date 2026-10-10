<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 560px">
      <h3>{{ server?.id ? '编辑服务器' : '添加服务器' }}</h3>

      <div class="frow">
        <div class="fitem"><label>名称 *</label><input v-model="form.name" placeholder="如 db-prod-01" /></div>
        <div class="fitem"><label>标签（注入提示词提醒 AI）</label>
          <select v-model="form.tag">
            <option value="">无</option><option>生产</option><option>测试</option><option>开发</option>
          </select>
        </div>
      </div>
      <div class="frow">
        <div class="fitem" style="flex:2"><label>主机 *</label><input v-model="form.host" placeholder="192.168.x.x" /></div>
        <div class="fitem"><label>端口</label><input type="number" v-model.number="form.port" /></div>
        <div class="fitem"><label>用户名 *</label><input v-model="form.user" placeholder="root / oracle" /></div>
      </div>
      <div class="frow">
        <div class="fitem"><label>密码{{ server?.id ? '（不修改则留空）' : ' *' }}</label><input type="password" v-model="password" /></div>
        <div class="fitem" style="flex:2"><label>备注（注入提示词）</label><input v-model="form.note" placeholder="如 Oracle 19c 服务器，alert 在 /u01/diag" /></div>
      </div>

      <div class="test-result" v-if="testMsg" :style="{ color: testOk ? 'var(--green)' : 'var(--red)' }">{{ testMsg }}</div>

      <div class="actions">
        <button class="btn" :disabled="testing" @click="test">{{ testing ? '测试中…' : '测试连接' }}</button>
        <span style="flex:1"></span>
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { store } from '../store'

const props = defineProps<{ server: any }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const form = reactive({
  id: props.server?.id || `srv_${Date.now()}`,
  name: props.server?.name || '',
  host: props.server?.host || '',
  port: props.server?.port ?? 22,
  user: props.server?.user || '',
  tag: props.server?.tag || '',
  note: props.server?.note || ''
})
const password = ref('')
const testing = ref(false)
const testOk = ref(false)
const testMsg = ref('')

async function test() {
  if (!form.host || !form.user) { testMsg.value = '请先填写主机和用户名'; testOk.value = false; return }
  testing.value = true
  testMsg.value = ''
  try {
    const r = await window.sqlpilot.testServer({ ...form }, password.value || undefined)
    testOk.value = r.ok
    testMsg.value = r.ok ? `✓ ${r.label}` : `✗ ${r.error}`
  } catch (e: any) {
    testOk.value = false
    testMsg.value = `✗ ${e?.message || e}`
  } finally {
    testing.value = false
  }
}

async function save() {
  if (!form.name || !form.host || !form.user) { window.sqlpilot.uiAlert('名称、主机、用户名必填'); return }
  if (!props.server?.id && !password.value) { window.sqlpilot.uiAlert('请填写密码'); return }
  const r = await window.sqlpilot.saveServer({ ...form }, password.value || undefined)
  if (!r.ok) {
    window.sqlpilot.uiAlert((r as any).error || '保存失败')
    return
  }
  store.cfg = await window.sqlpilot.getConfig()
  emit('saved')
  emit('close')
}
</script>

<style scoped>
.frow { display: flex; gap: 10px; margin-bottom: 10px; }
.fitem { flex: 1; min-width: 0; }
.fitem label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
.test-result { font-size: 12px; margin: 6px 0; word-break: break-all; }
</style>
