<template>
  <div class="ta-mask" @click.self="$emit('close')">
    <div class="ta-box" role="dialog" aria-modal="true">
      <div class="ta-h">放弃任务</div>
      <div class="ta-body">
        <p class="ta-p">
          将放弃任务 <b>{{ task.name }}</b>
          <span class="tp-chip mono">#{{ task.id }}</span>
        </p>
        <p class="ta-warn">
          此操作会忽略任务当前状态并结束它，之后该任务不再支持任何操作，可能造成 OCP 元信息缺失或状态与真实状态不一致，请谨慎操作。
        </p>
        <label class="ta-lab">
          <span>请输入任务 ID <b class="mono">{{ task.id }}</b> 以确认放弃</span>
          <input
            ref="inputEl"
            v-model="typed"
            class="tp-input mono"
            placeholder="任务 ID"
            spellcheck="false"
            @keyup.enter="submit"
          />
        </label>
        <div v-if="err" class="ta-err">{{ err }}</div>
      </div>
      <div class="ta-foot">
        <button class="tp-btn" :disabled="busy" @click="$emit('close')">取消</button>
        <button class="tp-btn danger-fill" :disabled="!canSubmit || busy" @click="submit">
          {{ busy ? '提交中…' : '放弃任务' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 放弃任务确认框：与 OCP 的「放弃任务」弹窗一致，必须手动输入任务 ID 才能提交
 * （这是不可撤销的终态操作，OCP 用输入校验挡住误点）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { runTaskAction } from '../../../cloud/state'

const props = defineProps<{ task: { id: number; name: string } }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const typed = ref('')
const busy = ref(false)
const err = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const canSubmit = computed(() => typed.value.trim() === String(props.task.id))

async function submit(): Promise<void> {
  if (!canSubmit.value || busy.value) return
  busy.value = true
  err.value = ''
  const r = await runTaskAction(props.task.id, 'abort')
  busy.value = false
  if (!r.ok) {
    err.value = r.error || '操作失败'
    return
  }
  emit('done')
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  inputEl.value?.focus()
})
// 必须摘掉监听：抽屉里每次操作都会新建这个弹窗，不摘会越积越多（Esc 一次触发多个回调）
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.ta-mask {
  position: fixed; inset: 0; z-index: 400; background: rgba(6, 8, 14, 0.5);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.ta-box {
  width: 460px; max-width: 94vw; background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.42); overflow: hidden;
}
.ta-h { padding: 13px 16px 10px; font-size: 13.5px; font-weight: 600; border-bottom: 1px solid var(--border); }
.ta-body { padding: 12px 16px; display: flex; flex-direction: column; gap: 9px; }
.ta-p { margin: 0; font-size: 12px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.ta-warn {
  margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--yellow);
  background: var(--yellow-dim); border-radius: 8px; padding: 8px 10px;
}
.ta-lab { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--text-dim); }
.ta-lab input { font-size: 12px; }
.ta-err { font-size: 11.5px; color: var(--red); }
.ta-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px 13px; }
.danger-fill {
  background: var(--red-dim); color: var(--red); border-color: var(--red);
}
.danger-fill:hover:not(:disabled) { background: var(--red); color: var(--bg-card); }
</style>
