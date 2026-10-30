<template>
  <div class="hs">
    <!-- 顶部工具条：身份 / 状态 / 动作 -->
    <div class="hs-bar">
      <span class="hs-title"><b>{{ ip }}</b><em v-if="clusterName"> · {{ clusterName }}</em></span>
      <span v-if="cred" class="hs-id mono">{{ cred.user }}@{{ ip }}:{{ cred.port }}</span>
      <span class="hs-state" :class="stateTone"><i class="dot"></i>{{ stateLabel }}</span>
      <span class="sp"></span>
      <button v-if="cred" class="tp-btn sm" :disabled="status === 'connecting'" @click="reconnect">重新连接</button>
      <button v-if="cred" class="tp-btn sm" @click="forget">清除凭据</button>
      <button class="tp-btn sm" @click="emit('close')">关闭</button>
    </div>

    <!-- 未录入凭据：就地填表，不弹窗、不跳页 -->
    <div v-if="!cred && !loadingStatus" class="hs-form">
      <div class="hs-form-head">
        还没有这台主机的 SSH 凭据。录入后仅保存在本机（密码经 DPAPI 加密），
        可直接在此开启终端；凭据按「IP」归属当前接入集群，不会影响服务器模块里的其它会话。
      </div>
      <div class="hs-grid">
        <label>主机</label>
        <input class="tp-input mono" :value="ip" disabled />
        <label>端口</label>
        <input v-model.number="form.port" class="tp-input mono" type="number" placeholder="22" />
        <label>用户名</label>
        <input v-model="form.user" class="tp-input mono" placeholder="root / oceanbase" spellcheck="false" />
        <label>认证方式</label>
        <div class="hs-seg">
          <button :class="{ on: form.auth === 'password' }" @click="form.auth = 'password'">密码</button>
          <button :class="{ on: form.auth === 'key' }" @click="form.auth = 'key'">私钥</button>
        </div>
        <template v-if="form.auth === 'password'">
          <label>密码</label>
          <input v-model="form.password" class="tp-input" type="password" placeholder="登录密码" />
        </template>
        <template v-else>
          <label>私钥文件</label>
          <div class="hs-row">
            <input v-model="form.keyPath" class="tp-input mono" placeholder="C:\\Users\\…\\.ssh\\id_rsa" spellcheck="false" />
            <button class="tp-btn sm" @click="pickKey">选择…</button>
          </div>
          <label>私钥口令</label>
          <input v-model="form.keyPassphrase" class="tp-input" type="password" placeholder="没有口令可留空" />
        </template>
      </div>
      <div v-if="err" class="tp-msg err">{{ err }}</div>
      <div class="hs-acts">
        <span class="tp-note">保存前会先试连一次；连不上不会写入配置。</span>
        <button class="tp-btn primary" :disabled="busy || !form.user.trim()" @click="saveAndConnect">
          {{ busy ? '连接中…' : '保存并连接' }}
        </button>
      </div>
    </div>

    <div v-else-if="loadingStatus" class="hs-loading"><span class="spinner"></span>读取凭据…</div>

    <!-- 终端 -->
    <div v-show="!!cred" ref="hostEl" class="hs-term"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * 云管 · 主机 SSH 终端（页面下方分窗）。
 *
 * 凭据复用「服务器」存储：id 固定为 cloudssh:<平台id>:<ip>，
 * 因此 host key 校验、DPAPI 口令、跳板机、终端编码全部沿用既有 SSH 栈，
 * 本组件只负责「录入 → 试连 → 开终端 → 关闭」。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { forgetHostSsh, hostSshId, loadHostSshMap, saveHostSsh, type HostSshStatus } from '../../../cloud/hostSsh'

const props = defineProps<{ platformId: string; ip: string; clusterName?: string; port?: number; active?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const hostEl = ref<HTMLElement | null>(null)
const loadingStatus = ref(true)
const busy = ref(false)
const err = ref('')
const status = ref<'idle' | 'connecting' | 'open' | 'closed' | 'error'>('idle')
const statusMsg = ref('')

const cred = ref<HostSshStatus | null>(null)

const form = reactive({
  user: 'root',
  port: props.port || 22,
  auth: 'password' as 'password' | 'key',
  password: '',
  keyPath: '',
  keyPassphrase: ''
})

const serverId = computed(() => hostSshId(props.platformId, props.ip))

const stateLabel = computed(() => {
  if (loadingStatus.value) return '读取凭据'
  if (!cred.value) return '未录入凭据'
  return { idle: '未连接', connecting: '连接中…', open: '已连接', closed: '已断开', error: '连接失败' }[status.value]
})
const stateTone = computed(() => {
  if (!cred.value) return 'idle'
  return status.value === 'open' ? 'ok' : status.value === 'error' ? 'bad' : status.value === 'connecting' ? 'wait' : 'idle'
})

let term: Terminal | null = null
let fit: FitAddon | null = null
let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let ro: ResizeObserver | null = null
let disposed = false
const termId = `cterm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

function mountTerm(): void {
  if (term || !hostEl.value) return
  const t = new Terminal({
    fontSize: 12.5,
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 4000,
    theme: { background: '#0f1319', foreground: '#d7dde7', cursor: '#5aa0ff', selectionBackground: '#2a3f5f' }
  })
  const f = new FitAddon()
  t.loadAddon(f)
  t.open(hostEl.value)
  term = t
  fit = f

  t.onData((d) => { void window.sqlpilot.termInput(termId, d) })
  offData = window.sqlpilot.onTermData((p) => { if (p.termId === termId) t.write(p.data) })
  offExit = window.sqlpilot.onTermExit((p) => {
    if (p.termId !== termId) return
    status.value = 'closed'
    t.writeln('\r\n\x1b[90m—— 连接已断开 ——\x1b[0m')
  })

  ro = new ResizeObserver(() => doFit())
  ro.observe(hostEl.value)
  // 首帧尺寸可能还没定（分窗刚展开 / 面板刚从 display:none 恢复）：
  // fit 一旦算小了，xterm 只会画那么多行，容器下半截就是空的——表现为"终端只有一半"。
  // 因此在几个时间点各补一次，确保拿到最终尺寸。
  void nextTick(() => doFit())
  for (const delay of [60, 180, 420]) setTimeout(() => doFit(), delay)
}

/** 容器有实际尺寸才算，0 尺寸下 fit 会算出 1 行并锁死布局 */
function doFit(): void {
  if (!term || !fit) return
  const el = hostEl.value
  if (!el || el.clientWidth < 40 || el.clientHeight < 30) return
  try {
    fit.fit()
    void window.sqlpilot.termResize(termId, term.cols, term.rows)
  } catch { /* 隐藏中 / 尺寸异常时忽略 */ }
}

async function loadStatus(): Promise<void> {
  loadingStatus.value = true
  try {
    const map = await loadHostSshMap(props.platformId)
    const hit = map[props.ip] || null
    cred.value = hit
    if (hit) {
      form.user = hit.user
      form.port = hit.port
      form.auth = hit.auth
      form.keyPath = hit.keyPath
    }
  } finally {
    loadingStatus.value = false
  }
  if (cred.value) {
    await nextTick()
    mountTerm()
    await connect()
  }
}

async function pickKey(): Promise<void> {
  const r = await window.sqlpilot.sftpPick('files')
  const p = (r as any)?.path || (r as any)?.paths?.[0]
  if (p) form.keyPath = String(p)
}

/** 保存前先试连：连不上就不落盘，避免存下一组永远用不了的凭据 */
async function saveAndConnect(): Promise<void> {
  busy.value = true
  err.value = ''
  try {
    const r = await saveHostSsh(props.platformId, props.ip, props.clusterName || '', {
      user: form.user,
      port: form.port,
      auth: form.auth,
      password: form.password || undefined,
      keyPath: form.keyPath,
      keyPassphrase: form.keyPassphrase || undefined
    })
    if (!r.ok) {
      err.value = r.error || '连接失败'
      return
    }
    cred.value = {
      serverId: serverId.value,
      user: form.user.trim(),
      port: Number(form.port) || 22,
      auth: form.auth,
      keyPath: form.keyPath,
      hasPassword: !!form.password
    }
    await nextTick()
    mountTerm()
    await connect()
  } finally {
    busy.value = false
  }
}

async function connect(): Promise<void> {
  if (!term || !cred.value) return
  status.value = 'connecting'
  term.writeln(`\x1b[90m正在连接 ${cred.value.user}@${props.ip}:${cred.value.port} …\x1b[0m`)
  doFit()
  const r = await window.sqlpilot.termOpen(termId, serverId.value, { cols: term.cols, rows: term.rows })
  if (disposed) {
    if (r.ok) void window.sqlpilot.termClose(termId)
    return
  }
  if (!r.ok) {
    status.value = 'error'
    statusMsg.value = r.error || '连接失败'
    term.writeln(`\x1b[31m${statusMsg.value}\x1b[0m`)
    return
  }
  status.value = 'open'
  term.focus()
}

async function reconnect(): Promise<void> {
  if (!term) return
  await window.sqlpilot.termClose(termId).catch(() => { /* 已断开 */ })
  term.reset()
  await connect()
}

async function forget(): Promise<void> {
  const ok = await window.sqlpilot.uiConfirm(`清除 ${props.ip} 的 SSH 凭据？`, '仅删除本机保存的账号口令，不影响服务器。', false)
  if (!ok) return
  await window.sqlpilot.termClose(termId).catch(() => { /* 忽略 */ })
  await forgetHostSsh(props.platformId, props.ip)
  cred.value = null
  status.value = 'idle'
}

onMounted(() => { void loadStatus() })

/** 从隐藏切到可见（切会话 / 展开任务栏）时重算行列并聚焦，否则会停在 0 尺寸算出的行列上 */
watch(
  () => props.active,
  (on) => {
    if (!on) return
    void nextTick(() => {
      for (const delay of [0, 80, 240]) setTimeout(() => doFit(), delay)
      term?.focus()
    })
  }
)

onBeforeUnmount(() => {
  disposed = true
  offData?.()
  offExit?.()
  ro?.disconnect()
  if (cred.value) void window.sqlpilot.termClose(termId).catch(() => { /* 忽略 */ })
  term?.dispose()
  term = null
})
</script>

<style scoped>
.hs { display: flex; flex-direction: column; height: 100%; width: 100%; min-height: 0; min-width: 0; gap: 6px; }
.hs-bar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.hs-title { font-size: 12px; }
.hs-title b { font-family: var(--mono); font-weight: 600; }
.hs-title em { font-style: normal; color: var(--text-faint); }
.hs-id { font-size: 10.5px; color: var(--text-faint); }
.sp { flex: 1; }
.hs-state { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-faint); }
.hs-state .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); }
.hs-state.ok { color: var(--green); }
.hs-state.ok .dot { background: var(--green); }
.hs-state.bad { color: var(--red); }
.hs-state.bad .dot { background: var(--red); }
.hs-state.wait .dot { background: var(--yellow); }

.hs-form { display: flex; flex-direction: column; gap: 9px; overflow: auto; padding: 2px 2px 4px; }
.hs-form-head { font-size: 11px; color: var(--text-dim); line-height: 1.6; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; }
.hs-grid { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 7px 10px; align-items: center; max-width: 620px; }
.hs-grid > label { font-size: 11px; color: var(--text-faint); }
.hs-row { display: flex; gap: 6px; align-items: center; }
.hs-row .tp-input { flex: 1; min-width: 0; }
.hs-seg { display: flex; gap: 4px; }
.hs-seg button {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.hs-seg button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.hs-acts { display: flex; align-items: center; gap: 10px; }
.hs-acts .tp-note { margin-right: auto; }
.hs-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); padding: 20px; }
.spinner { width: 13px; height: 13px; border: 2px solid var(--accent-dim); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
/* 终端区：占满剩余高度，xterm 自己处理滚动 */
.hs-term { flex: 1; min-height: 0; background: #0f1319; border: 1px solid var(--border); border-radius: 8px; padding: 4px 6px; }
.hs-term :deep(.xterm) { height: 100%; }
.hs-term :deep(.xterm-viewport) { background: transparent !important; }
</style>
