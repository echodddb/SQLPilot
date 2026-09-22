<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 520px">
      <h3> 新建项目</h3>

      <div class="form-row">
        <div>
          <label>项目文件夹</label>
          <div style="display:flex; gap:8px">
            <input type="text" v-model="rootPath" placeholder="点击右侧按钮选择文件夹…" readonly style="flex:1; cursor:pointer" @click="pick" />
            <button class="btn" @click="pick" :disabled="picking">{{ picking ? '…' : '选择…' }}</button>
          </div>
        </div>
      </div>

      <div class="form-row">
        <div>
          <label>项目名称</label>
          <input type="text" v-model="name" :placeholder="suggestedName || '如：LIS 巡检'" />
        </div>
      </div>

      <div style="font-size:12px; color:var(--text-dim); line-height:1.7; margin:4px 0 6px">
        该文件夹将作为会话的默认工作目录：agent 生成的报告、脚本等文件会写到这里。数据库连接可在"编辑连接"里可选地关联到本项目。
      </div>

      <div class="test-result" v-if="err" style="color: var(--red)">{{ err }}</div>

      <div class="actions">
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" :disabled="!rootPath || !name.trim()" @click="save">创建项目</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { store, toPlain } from '../store'

const emit = defineEmits<{ (e: 'close'): void; (e: 'created', project: any): void }>()

const rootPath = ref('')
const name = ref('')
const err = ref('')
const picking = ref(false)
const suggestedName = ref('')

async function pick() {
  picking.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.pickFolder()
    if (r.ok && r.path) {
      rootPath.value = r.path
      suggestedName.value = r.path.split(/[\\/]/).filter(Boolean).pop() || ''
      if (!name.value.trim()) name.value = suggestedName.value
    }
  } catch (e: any) {
    err.value = '选择文件夹失败：' + (e?.message || e)
  } finally {
    picking.value = false
  }
}

async function save() {
  err.value = ''
  const project = { id: `proj_${Date.now()}`, name: name.value.trim(), rootPath: rootPath.value }
  try {
    await window.sqlpilot.saveProject(toPlain(project))
    store.cfg = await window.sqlpilot.getConfig()
    emit('created', project)
  } catch (e: any) {
    err.value = '保存失败：' + (e?.message || e)
  }
}
</script>
