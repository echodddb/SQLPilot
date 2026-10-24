<template>
  <div class="skp" @click.stop @mousedown.stop>
    <div class="skp-h">
      <b>技能</b>
      <span class="n">{{ items.length ? `${items.length} 个可用` : '' }}</span>
      <span class="sp"></span>
      <button class="skp-x" title="关闭" @click="emit('close')">✕</button>
    </div>
    <p class="skp-note">
      勾选后，技能正文会作为「回答规范」随问题一起发给模型；这一路不执行技能里的工具，只按它的步骤与口径作答。
    </p>
    <div class="skp-list">
      <div v-if="loading" class="skp-hint">读取技能…</div>
      <div v-else-if="!items.length" class="skp-hint">
        还没有启用的技能。到「设置 → 技能」导入后再回来勾选。
      </div>
      <button
        v-for="s in items"
        :key="s.id"
        class="skp-row"
        :class="{ on: selected.includes(s.id), dis: full && !selected.includes(s.id) }"
        :title="s.description || s.name"
        @click="toggle(s.id)"
      >
        <span class="skp-ck">{{ selected.includes(s.id) ? '✓' : '' }}</span>
        <span class="skp-main">
          <b>{{ s.name }}</b>
          <em>{{ s.description || '（没有描述）' }}</em>
        </span>
        <span v-if="(s.files || 1) > 1" class="skp-tag" title="技能包含附属资源文件（本次只注入 SKILL.md 指令部分）">含资源</span>
      </button>
    </div>
    <div class="skp-f">
      <span class="skp-sum">
        {{ selected.length ? `已选 ${selected.length} 个` : '未选技能' }}
        <em v-if="full">（最多 4 个）</em>
      </span>
      <span class="sp"></span>
      <button class="skp-btn" :disabled="!selected.length" @click="clear">清空</button>
      <button class="skp-btn primary" @click="emit('close')">完成</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 技能选择（云管两个助手 + 编辑器助手共用）。
 *
 * 只负责「选哪几个技能」：正文由主进程按 id 读取并拼进系统提示，
 * 渲染层不读技能文件，也不执行任何工具。
 */
import { computed, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ selected: string[] }>(), { selected: () => [] })
const emit = defineEmits<{ (e: 'update:selected', v: string[]): void; (e: 'close'): void }>()

interface Row {
  id: string
  name: string
  description: string
  files?: number
}

const MAX = 4
const items = ref<Row[]>([])
const loading = ref(true)
const full = computed(() => props.selected.length >= MAX)

function toggle(id: string): void {
  if (props.selected.includes(id)) {
    emit('update:selected', props.selected.filter((x) => x !== id))
    return
  }
  if (full.value) return
  emit('update:selected', [...props.selected, id])
}

function clear(): void {
  emit('update:selected', [])
}

onMounted(async () => {
  try {
    const all = (await window.sqlpilot.listSkills()) || []
    items.value = all
      .filter((s) => s.enabled !== false)
      .map((s) => ({ id: s.id, name: s.name, description: s.description, files: s.files }))
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.skp {
  position: absolute;
  right: 8px;
  top: 40px;
  z-index: 8;
  width: 306px;
  max-width: calc(100% - 16px);
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  cursor: default;
  animation: skp-in 0.12s ease;
}
@keyframes skp-in { from { transform: translateY(-4px); opacity: 0.7; } to { transform: none; opacity: 1; } }

.skp-h { display: flex; align-items: baseline; gap: 7px; padding: 8px 10px 4px; }
.skp-h b { font-size: 11.5px; }
.skp-h .n { font-family: var(--mono); font-size: 9.5px; color: var(--text-faint); }
.sp { flex: 1; }
.skp-x {
  align-self: center; width: 18px; height: 18px; border-radius: 5px; border: none; background: none;
  color: var(--text-faint); font-size: 10px; font-family: inherit; cursor: pointer;
}
.skp-x:hover { color: var(--red); background: var(--red-dim); }

.skp-note { margin: 0 10px 6px; font-size: 9.5px; line-height: 1.5; color: var(--text-faint); }

.skp-list { max-height: 236px; overflow-y: auto; padding: 0 6px 4px; }
.skp-hint { padding: 8px 4px; font-size: 10.5px; line-height: 1.6; color: var(--text-faint); }

.skp-row {
  display: flex; align-items: flex-start; gap: 7px; width: 100%; text-align: left;
  padding: 5px 6px; border-radius: 6px; border: 1px solid transparent;
  background: none; color: var(--text); font-family: inherit; cursor: pointer;
}
.skp-row:hover { background: var(--bg-card-hover); }
.skp-row.on { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.skp-row.dis { opacity: 0.45; cursor: default; }
.skp-row.dis:hover { background: none; }
.skp-ck {
  flex-shrink: 0; margin-top: 1px; width: 14px; height: 14px; border-radius: 4px;
  border: 1.5px solid var(--border-strong); background: var(--bg-input); color: #fff;
  font-size: 9px; line-height: 1; display: flex; align-items: center; justify-content: center;
}
.skp-row.on .skp-ck { background: var(--accent); border-color: var(--accent); }
.skp-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.skp-main b { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-main em { font-style: normal; font-size: 9.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skp-row.on .skp-main em { color: var(--text-dim); }
.skp-tag {
  flex-shrink: 0; margin-top: 2px; font-size: 9px; color: var(--text-faint);
  border: 1px solid var(--border); border-radius: 4px; padding: 0 3px;
}

.skp-f { display: flex; align-items: center; gap: 6px; padding: 7px 10px 8px; border-top: 1px solid var(--border); }
.skp-sum { font-size: 10px; color: var(--text-dim); }
.skp-sum em { font-style: normal; color: var(--text-faint); }
.skp-btn {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 2.5px 9px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.skp-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.skp-btn:disabled { opacity: 0.45; cursor: default; }
.skp-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.skp-btn.primary:hover { background: color-mix(in srgb, var(--accent) 86%, #fff); color: #fff; }
</style>
