<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" style="width: 480px">
      <h3>{{ mode === 'switch' ? '切换会话项目' : '新建会话 · 选择项目' }}</h3>

      <div v-if="!projects.length" class="side-empty" style="padding: 8px 4px 12px; color: var(--text-dim); font-size: 13px; line-height: 1.9">
        还没有项目。会话必须在一个项目下工作（文件产出、连接关联都以项目为单位）。<br />请先创建项目。
      </div>

      <div v-for="p in projects" :key="p.id" class="proj-pick" @click="$emit('pick', p.id)" :title="p.rootPath">
        <span>📁</span>
        <span class="pname">{{ p.name }}</span>
        <span class="ppath">{{ p.rootPath }}</span>
        <span class="pgo">→</span>
      </div>

      <div class="actions">
        <button class="btn" @click="$emit('create-project')">＋ 新建项目</button>
        <span style="flex:1"></span>
        <button class="btn ghost" @click="$emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../store'

const props = defineProps<{ mode: 'new' | 'switch' }>()
defineEmits<{ (e: 'close'): void; (e: 'pick', projectId: string): void; (e: 'create-project'): void }>()

const projects = computed(() => store.cfg?.projects || [])
</script>

<style scoped>
.proj-pick {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.proj-pick:hover { border-color: var(--accent); background: var(--accent-dim); }
.proj-pick .pname { font-weight: 600; }
.proj-pick .ppath { flex: 1; font-size: 11.5px; color: var(--text-faint); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-pick .pgo { color: var(--accent); font-weight: 700; }
</style>
