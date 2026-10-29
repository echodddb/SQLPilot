<template>
  <Teleport to="body">
    <div class="mask" @click.self="maybeClose">
      <section class="panel" @click.stop>
        <header class="ph">
          <div>
            <h3>{{ title }}</h3>
            <span class="sub">{{ tenant.clusterName }} · 租户 {{ tenant.name }}</span>
          </div>
          <button v-if="!running" class="x" title="关闭" @click="close">✕</button>
        </header>

        <div class="body">
          <div class="steps">
            <div v-for="(s, i) in steps" :key="i" class="step" :class="s.status">
              <span class="dot" />
              <div class="text">
                <div class="line1">
                  <b>{{ s.title }}</b>
                  <span class="tag">{{ tagOf(s.status) }}</span>
                </div>
                <div v-if="s.detail" class="line2">{{ s.detail }}</div>
                <code v-if="s.sql" class="sql">{{ s.sql }}</code>
              </div>
            </div>
            <div v-if="running" class="step pending">
              <span class="dot" /><div class="text"><div class="line1"><b>等待实例返回…</b></div></div>
            </div>
          </div>

          <div v-if="!running && message" class="result" :class="ok ? 'ok' : 'err'">{{ message }}</div>
        </div>

        <footer class="ft">
          <button class="btn" :disabled="running" @click="close">{{ running ? '执行中…' : '关闭' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 租户锁定 / 删除的进度弹窗。
 *
 * 存在意义：直连的这些操作是「一条 DDL + 无回滚」，
 * 之前只弹一个 toast，用户既看不到进度也不知道到底执行了什么。
 * 这里把「准备 → 执行 DDL → 结果」逐条显示，失败时把错误原文留在界面上。
 */
import { computed, onMounted, ref } from 'vue'
import { dropDirectTenant, lockDirectTenant } from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'

const props = defineProps<{
  platformId: string
  action: 'lock' | 'unlock' | 'delete'
  tenant: { name: string; clusterName: string; locked?: boolean }
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

interface Step {
  title: string
  detail?: string
  sql?: string
  status: 'start' | 'ok' | 'fail'
}

const steps = ref<Step[]>([])
const running = ref(true)
const ok = ref(false)
const message = ref('')
/** 执行结论：'' 未结束 / 'ok' 成功 / 'fail' 失败；关闭时据此决定是否通知父级刷新 */
const finished = ref<'' | 'ok' | 'fail'>('')

const title = computed(() =>
  props.action === 'delete' ? '删除租户' : props.action === 'lock' ? '锁定租户' : '解锁租户'
)

function tagOf(s: Step['status']): string {
  return s.status === 'ok' ? '成功' : s.status === 'fail' ? '失败' : '执行中…'
}

async function run(): Promise<void> {
  const name = props.tenant.name
  const isDelete = props.action === 'delete'

  try {
    steps.value.push({ title: '校验参数', status: 'start' })
    if (!props.platformId) {
      steps.value[0].status = 'fail'
      message.value = '没有定位到该集群的直连平台，请检查云管平台配置。'
      finished.value = 'fail'
      return
    }
    if (isDelete && name.toLowerCase() === 'sys') {
      steps.value[0].status = 'fail'
      message.value = '不能删除 sys 租户。'
      finished.value = 'fail'
      return
    }
    steps.value[0].status = 'ok'

    const sql = isDelete ? `DROP TENANT ${name}` : `ALTER TENANT ${name} ${props.action === 'lock' ? 'LOCK' : 'UNLOCK'}`
    const step: Step = { title: isDelete ? '执行 DROP TENANT' : `执行 ${props.action === 'lock' ? 'LOCK' : 'UNLOCK'}`, sql, status: 'start' }
    steps.value.push(step)

    const r = isDelete
      ? await dropDirectTenant(props.platformId, name)
      : await lockDirectTenant(props.platformId, name, props.action === 'lock')

    if (!r.ok) {
      step.status = 'fail'
      ok.value = false
      message.value = r.error || '执行失败'
      finished.value = 'fail'
      return
    }
    step.status = 'ok'
    ok.value = true
    message.value = isDelete
      ? `租户 ${name} 已删除。资源池不会被自动回收，可到「资源池」页清理。`
      : props.action === 'lock'
        ? `租户 ${name} 已锁定，当前不可写入。`
        : `租户 ${name} 已解锁。`
    finished.value = 'ok'
    pushNotice(isDelete ? `已删除租户 ${name}` : props.action === 'lock' ? '租户已锁定' : '租户已解锁')
  } finally {
    running.value = false
  }
}

function maybeClose(): void {
  if (!running.value) close()
}

/**
 * 关闭：成功的结果要先让用户看清。
 * 早先这里在执行成功后直接 emit('done')，父组件立刻卸载弹窗，
 * 观感就是"点一下一闪而过"，根本读不到锁定/解锁到底成没成。
 * 现在改成执行完停在结果页，用户确认后再关闭，关闭时才通知父级刷新。
 */
function close(): void {
  if (running.value) return
  if (finished.value === 'ok') emit('done')
  else emit('close')
}

onMounted(run)
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 320; background: rgba(5, 7, 12, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 22px;
  padding-top: var(--titlebar-h); backdrop-filter: blur(2px);
}
.panel {
  width: 640px; max-width: 100%; max-height: 84vh; display: flex; flex-direction: column;
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
.steps { display: flex; flex-direction: column; gap: 9px; }
.step { display: flex; gap: 8px; align-items: flex-start; }
.step .dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; background: var(--text-faint); }
.step.start .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.step.ok .dot { background: var(--green); }
.step.fail .dot { background: var(--red); }
@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
.text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.line1 { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text); }
.line1 b { font-weight: 500; }
.tag { font-size: 10px; color: var(--text-faint); }
.step.ok .tag { color: var(--green); }
.step.fail .tag { color: var(--red); }
.line2 { font-size: 11px; color: var(--text-dim); line-height: 1.6; }
.sql {
  display: block; font-family: var(--mono); font-size: 10.5px; color: var(--text-dim);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 7px; white-space: pre-wrap; word-break: break-all;
}
.result { font-size: 12px; line-height: 1.7; border-radius: 8px; padding: 9px 11px; }
.result.ok { color: var(--green); background: var(--green-dim); border: 1px solid color-mix(in srgb, var(--green) 35%, transparent); }
.result.err { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); }
.ft { display: flex; justify-content: flex-end; padding: 11px 16px; border-top: 1px solid var(--border); }
.btn {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 8px; padding: 6px 16px; font-size: 12px; font-family: inherit; cursor: pointer;
}
.btn:hover:not(:disabled) { color: var(--text); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
