<template>
  <Teleport to="body">
    <div class="mask" @click.self="close">
      <section class="panel" @click.stop>
        <header class="ph">
          <div>
            <h3>{{ title }}</h3>
            <span class="sub">{{ tenant.clusterName }} · 租户 {{ tenant.name }}</span>
          </div>
          <button class="x" title="关闭（Esc）" @click="close">✕</button>
        </header>

        <div class="body">
          <div class="sqlbox">
            <span class="lbl">执行语句</span>
            <code class="sql">{{ sql }}</code>
          </div>

          <div v-if="submitting" class="state"><span class="spinner"></span>正在提交…</div>
          <div v-else-if="error" class="result err">{{ error }}</div>
          <template v-else>
            <div class="result ok">{{ message }}</div>
            <div class="taskline">
              <span class="lbl">任务</span>
              <code class="mono">{{ taskId || '—' }}</code>
              <span class="dim">已转入后台，关掉本窗口不影响执行</span>
            </div>
          </template>
        </div>

        <footer class="ft">
          <button v-if="taskId" class="btn" @click="openTasks">查看任务日志</button>
          <span style="flex: 1"></span>
          <button class="btn primary" @click="close">{{ submitting ? '提交中…' : '关闭' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 租户锁定 / 删除的提交弹窗。
 *
 * 这两个动作现在是**后台任务**：主进程立刻返回 taskId，SQL 在后台跑。
 * 早先是同步等待，实例一忙弹窗就长时间停在「执行中」——按钮禁用、连 ✕ 都没有，
 * 观感就是"卡死了、关不掉"。现在提交完就能关，结果去「任务日志」看。
 */
import { computed, onMounted, ref } from 'vue'
import { dropDirectTenant, lockDirectTenant } from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'

const props = defineProps<{
  platformId: string
  action: 'lock' | 'unlock' | 'delete'
  tenant: { name: string; clusterName: string; locked?: boolean }
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done'): void
  (e: 'openTask', taskId: string): void
}>()

const submitting = ref(true)
const error = ref('')
const message = ref('')
const taskId = ref('')
/** '' 未结束 / ok 已提交 / fail 提交失败 */
const finished = ref<'' | 'ok' | 'fail'>('')

const title = computed(() =>
  props.action === 'delete' ? '删除租户' : props.action === 'lock' ? '锁定租户' : '解锁租户'
)
const sql = computed(() =>
  props.action === 'delete'
    ? `DROP TENANT ${props.tenant.name}`
    : `ALTER TENANT ${props.tenant.name} ${props.action === 'lock' ? 'LOCK' : 'UNLOCK'}`
)

async function submit(): Promise<void> {
  const name = props.tenant.name
  try {
    if (!props.platformId) {
      error.value = '没有定位到该集群的直连平台，请检查云管平台配置。'
      finished.value = 'fail'
      return
    }
    if (props.action === 'delete' && name.toLowerCase() === 'sys') {
      error.value = '不能删除 sys 租户。'
      finished.value = 'fail'
      return
    }
    const r =
      props.action === 'delete'
        ? await dropDirectTenant(props.platformId, name)
        : await lockDirectTenant(props.platformId, name, props.action === 'lock')
    if (!r.ok) {
      error.value = r.error || '提交失败'
      finished.value = 'fail'
      return
    }
    taskId.value = r.taskId || ''
    message.value = r.message || '已提交后台执行'
    finished.value = 'ok'
    pushNotice(message.value)
  } catch (e: any) {
    error.value = e?.message || String(e)
    finished.value = 'fail'
  } finally {
    submitting.value = false
  }
}

/** 关闭：提交成功要通知父级刷新列表；提交失败只是关窗 */
function close(): void {
  if (finished.value === 'ok') emit('done')
  else emit('close')
}

/** 跳到任务日志并展开这条任务 */
function openTasks(): void {
  if (taskId.value) emit('openTask', taskId.value)
  emit('close')
}

onMounted(submit)
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 320; background: rgba(5, 7, 12, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 22px;
  padding-top: var(--titlebar-h); backdrop-filter: blur(2px);
}
.panel {
  width: 620px; max-width: 100%; max-height: 84vh; display: flex; flex-direction: column;
  background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px;
  box-shadow: var(--shadow-lg);
}
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph h3 { margin: 0; font-size: 14px; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x {
  margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px;
}
.x:hover { color: var(--red); border-color: var(--red); }
.body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }

.sqlbox { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 10.5px; color: var(--text-faint); letter-spacing: 0.4px; }
.sql {
  display: block; font-family: var(--mono); font-size: 11px; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 8px; white-space: pre-wrap; word-break: break-all;
}

.state { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); }
.spinner {
  width: 12px; height: 12px; border: 2px solid var(--accent-dim); border-top-color: var(--accent);
  border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.result { font-size: 12px; line-height: 1.7; border-radius: 8px; padding: 9px 11px; }
.result.ok { color: var(--green); background: var(--green-dim); border: 1px solid color-mix(in srgb, var(--green) 35%, transparent); }
.result.err { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); }
.taskline { display: flex; align-items: center; gap: 8px; font-size: 11px; flex-wrap: wrap; }
.taskline .mono { font-size: 11px; color: var(--text); }
.taskline .dim { color: var(--text-faint); }
.ft { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
.btn {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 8px; padding: 6px 16px; font-size: 12px; font-family: inherit; cursor: pointer;
}
.btn:hover:not(:disabled) { color: var(--text); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
