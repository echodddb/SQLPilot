<template>
  <!-- Teleport 到 body：租户页容器若带 transform / filter，会让 position:fixed 失效，
       弹窗被裁到可视区外，表现就是「点了取消/关闭没反应」 -->
  <Teleport to="body">
    <div class="mask" @click.self="onMaskClick">
      <section class="panel" @click.stop>
      <header class="ph">
        <div>
          <h3>{{ running || logs.length ? '创建租户 · 执行日志' : '在直连集群新建租户' }}</h3>
          <span class="sub">{{ clusterName || '未选择集群' }} · 由 sys 租户直接执行 DDL，无任务编排、无回滚</span>
        </div>
        <button class="x" title="关闭" @click="close">✕</button>
      </header>

      <!-- 执行阶段：只显示日志与结果 -->
      <div v-if="running || logs.length" class="body">
        <div class="progress">
          <div v-for="(l, i) in logs" :key="i" class="logline" :class="l.status">
            <span class="dot" />
            <div class="logtext">
              <div class="line1">
                <b>{{ l.title }}</b>
                <span v-if="l.status === 'start'" class="tag">执行中…</span>
                <span v-else-if="l.status === 'ok'" class="tag ok">成功</span>
                <span v-else-if="l.status === 'warn'" class="tag warn">警告</span>
                <span v-else-if="l.status === 'fail'" class="tag fail">失败</span>
                <span class="ts">{{ time(l.at) }}</span>
              </div>
              <div v-if="l.message" class="line2">{{ l.message }}</div>
              <code v-if="l.sql" class="sql">{{ l.sql }}</code>
            </div>
          </div>
          <div v-if="running" class="logline pending">
            <span class="dot" /><div class="logtext"><div class="line1"><b>等待实例返回…</b></div></div>
          </div>
        </div>

        <div v-if="!running && finalResult" class="summary" :class="finalResult.ok ? 'ok' : 'err'">
          {{ finalResult.ok ? (finalResult.warning ? `${finalResult.message}；${finalResult.warning}` : finalResult.message) : finalResult.error }}
        </div>

        <!-- 建租户成功后直接给出连接串：Oracle / MySQL 参数不同，经代理还要带 #集群名 -->
        <div v-if="!running && finalResult?.ok && (finalResult.connections || []).length" class="conns">
          <div class="conns-title">连接串</div>
          <div v-for="(c, i) in finalResult.connections" :key="i" class="conn">
            <div class="conn-head">
              <span class="conn-label">{{ c.label }}</span>
              <button class="copy" :class="{ done: copiedKey === 'conn' + i }" @click="copy(c.command, 'conn' + i)">
                {{ copiedKey === 'conn' + i ? '已复制 ✓' : '复制' }}
              </button>
            </div>
            <code class="conn-cmd">{{ c.command }}</code>
          </div>
        </div>

        <!-- 未设密码时必须提醒：root 空密码等于谁都能进 -->
        <div v-if="!running && finalResult?.ok && !form.rootPassword" class="pwdhint">
          <div class="pwdhint-title">未设置密码，请尽快修改</div>
          <div class="pwdhint-body">
            该租户的 <b>{{ isOracle ? 'sys' : 'root' }}</b> 账号当前为空密码，任何能连到该集群的人都能登录。
            请立即登录租户执行：
          </div>
          <code class="conn-cmd">{{ alterPwdSql }}</code>
          <button class="copy" :class="{ done: copiedKey === 'pwd' }" @click="copy(alterPwdSql, 'pwd')">
            {{ copiedKey === 'pwd' ? '已复制 ✓' : '复制语句' }}
          </button>
        </div>
      </div>

      <!-- 表单阶段 -->
      <div v-else class="body">
        <div class="grid">
          <label>租户名 <i>*</i></label>
          <div>
            <input v-model="form.name" placeholder="字母开头，如 app_order" spellcheck="false" />
            <div v-if="nameErr" class="hint err">{{ nameErr }}</div>
          </div>

          <label>资源池 <i>*</i></label>
          <div class="row">
            <select v-model="form.resourcePoolName" :disabled="!freePools.length">
              <option v-if="!freePools.length" value="">没有可用的资源池</option>
              <option v-for="p in freePools" :key="p.id" :value="p.name">
                {{ p.name }} · {{ p.unitConfigName || '未知规格' }} · {{ p.unitCount }} Unit · {{ p.zoneList }}
              </option>
            </select>
            <span class="dim">只能选未被租户占用的池</span>
          </div>

          <template v-if="pool">
            <label>池内资源</label>
            <div class="derived">
              <span class="kv">规格 <b class="mono">{{ pool.unitConfigName || '—' }}</b></span>
              <span class="kv">每 Zone Unit <b class="mono">{{ pool.unitCount }}</b></span>
              <span class="kv">Zone <b class="mono">{{ poolZones.join(' / ') || '—' }}</b></span>
            </div>
          </template>

          <label>兼容模式</label>
          <div class="row">
            <label class="chk"><input v-model="form.mode" type="radio" value="MYSQL" @change="onModeChange" /> MySQL</label>
            <label class="chk"><input v-model="form.mode" type="radio" value="ORACLE" @change="onModeChange" /> Oracle</label>
          </div>

          <label>字符集</label>
          <div class="row">
            <select v-model="form.charset" :disabled="isOracle" @change="onCharsetChange">
              <option v-for="c in charsets" :key="c" :value="c">{{ c }}</option>
            </select>
            <select v-model="form.collation" :disabled="isOracle">
              <option v-for="c in collations" :key="c" :value="c">{{ c }}</option>
            </select>
            <span class="dim">{{ isOracle ? 'Oracle 模式固定 utf8mb4 / utf8mb4_bin' : '默认 utf8mb4 / utf8mb4_general_ci' }}</span>
          </div>

          <label>主 Zone</label>
          <div class="row">
            <select v-model="form.primaryZone" :disabled="!poolZones.length">
              <option value="RANDOM">RANDOM（随机）</option>
              <option v-for="z in poolZones" :key="z" :value="z">{{ z }}</option>
            </select>
            <span class="dim">只能在所选资源池的 Zone 内选择</span>
          </div>

          <label>备注</label>
          <div><input v-model="form.comment" placeholder="选填，写入租户 COMMENT" spellcheck="false" /></div>

          <label>连接白名单</label>
          <div><input v-model="form.whitelist" placeholder="%" spellcheck="false" /></div>

          <label>{{ isOracle ? 'sys 密码' : 'root 密码' }}</label>
          <div class="row">
            <input v-model="form.rootPassword" :placeholder="isOracle ? '留空则保持空密码（Oracle 密码用双引号设置）' : '留空则保持空密码'" spellcheck="false" />
            <button class="gen" @click="genPassword">生成</button>
          </div>
        </div>

        <div v-if="!freePools.length" class="fnote warn">
          <span class="i">!</span>
          <span>
            该集群没有空闲资源池。直连模式不再自动用 Unit 组装资源池——请先在「资源池」页确认有未绑定的池，
            或在「Unit 配置」页建好规格后在资源池页准备一个池。
          </span>
        </div>

        <div class="fnote">
          <span class="i">i</span>
          <span>
            提交后依次执行「创建租户 → 设白名单 → 设密码」，每一步都会实时打进执行日志。
            直连没有回滚，中途失败需按日志里的语句手工收尾。
          </span>
        </div>
      </div>

      <footer class="ft">
        <template v-if="!logs.length">
          <button class="btn" @click="close">取消</button>
          <button class="btn primary" :disabled="!canSubmit" @click="submit">创建租户</button>
        </template>
        <template v-else>
          <button class="btn" :disabled="running" @click="again">再建一个</button>
          <!-- 关闭永远可点：执行中点击会二次确认，避免「点了没反应」 -->
          <button class="btn primary" @click="close">关闭</button>
        </template>
      </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 直连模式的新建租户向导。
 *
 * 模型与 OCP 对齐：**选一个已存在的资源池**，租户挂到池上；
 * 池的规格 / Unit 数 / Zone 全部由池决定，界面只读展示，不再用 Unit 现组一个池。
 *
 * 执行过程通过主进程推送的进度事件实时打日志（onDirectTenantLog），
 * 每一步带 SQL 与结果，失败时用户能直接看到断在哪一条。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { load } from '../../../cloud/state'
import {
  closeCreate,
  createDirectTenant,
  onDirectTenantLog,
  resourcePoolsOf,
  type DirectResourcePool
} from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'

const props = defineProps<{ platformId: string; clusterId: number; clusterName: string }>()

/** 与后端 tenantSql.ts 的 CHARSET_PRESETS 一致（前端只用于联动展示） */
const CHARSETS: Record<'MYSQL' | 'ORACLE', Record<string, string[]>> = {
  MYSQL: {
    utf8mb4: ['utf8mb4_general_ci', 'utf8mb4_bin', 'utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
    utf8: ['utf8_general_ci', 'utf8_bin', 'utf8_unicode_ci'],
    gbk: ['gbk_chinese_ci', 'gbk_bin'],
    binary: ['binary'],
    latin1: ['latin1_swedish_ci', 'latin1_bin', 'latin1_general_ci'],
    gb18030: ['gb18030_chinese_ci', 'gb18030_bin']
  },
  ORACLE: { utf8mb4: ['utf8mb4_bin'] }
}

const pools = ref<DirectResourcePool[]>([])

const form = reactive({
  name: '',
  resourcePoolName: '',
  mode: 'MYSQL' as 'MYSQL' | 'ORACLE',
  charset: 'utf8mb4',
  collation: 'utf8mb4_general_ci',
  comment: '',
  primaryZone: 'RANDOM',
  whitelist: '%',
  rootPassword: ''
})

/** 只有未绑定租户的池能复用 */
const freePools = computed(() => pools.value.filter((p) => p.tenantId === 0))
const pool = computed(() => freePools.value.find((p) => p.name === form.resourcePoolName))

/** 池的 ZONE_LIST 形态不一（分号 / 逗号 / 带引号），统一拆开 */
const poolZones = computed(() =>
  String(pool.value?.zoneList || '')
    .split(/[;,]/)
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, '').trim())
    .filter(Boolean)
)

const isOracle = computed(() => form.mode === 'ORACLE')
const charsets = computed(() => Object.keys(CHARSETS[form.mode]))
const collations = computed(() => CHARSETS[form.mode][form.charset] || [])

const nameErr = computed(() => {
  const v = form.name.trim()
  if (!v) return ''
  return /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(v) ? '' : '字母开头，仅含字母/数字/下划线，2~64 位'
})

/**
 * 未设密码时给出的改密语句：两种模式的管理员与语法都不同。
 * Oracle 的密码是标识符，必须用双引号（单引号会被当字符串常量报错）。
 */
const alterPwdSql = computed(() =>
  isOracle.value
    ? 'ALTER USER sys IDENTIFIED BY "****";'
    : "ALTER USER root IDENTIFIED BY '****';"
)

const canSubmit = computed(() => !nameErr.value && !!form.name.trim() && !!form.resourcePoolName)

const running = ref(false)
const logs = ref<{ runId: string; at: number; phase: string; status: 'start' | 'ok' | 'warn' | 'fail'; title: string; sql?: string; message?: string }[]>([])
const finalResult = ref<{
  ok: boolean
  message?: string
  warning?: string
  error?: string
  connections?: { label: string; command: string }[]
} | null>(null)
const runId = ref('')
let off: (() => void) | null = null

function time(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** 切模式要重置字符集组合，否则会把 utf8mb4_general_ci 带进 Oracle 模式 */
function onModeChange(): void {
  const keys = Object.keys(CHARSETS[form.mode])
  form.charset = keys.includes('utf8mb4') ? 'utf8mb4' : keys[0]
  form.collation = CHARSETS[form.mode][form.charset][0]
}

function onCharsetChange(): void {
  form.collation = collations.value[0] || ''
}

function genPassword(): void {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const digit = '23456789'
  const sym = '!@#$%^&*'
  const all = upper + lower + digit + sym
  const buf = new Uint32Array(16)
  crypto.getRandomValues(buf)
  let out = upper[buf[0] % upper.length] + lower[buf[1] % lower.length] + digit[buf[2] % digit.length] + sym[buf[3] % sym.length]
  for (let i = 4; i < 16; i++) out += all[buf[i] % all.length]
  form.rootPassword = out
}

/** 订阅进度：只认本次 runId，避免上一轮的日志串进来 */
function startLogging(): void {
  runId.value = `dt_${Date.now().toString(36)}`
  logs.value = []
  off?.()
  off = onDirectTenantLog((e) => {
    if (e.runId !== runId.value) return
    logs.value.push(e)
    void nextTick(() => {
      const el = document.querySelector('.progress')
      if (el) el.scrollTop = el.scrollHeight
    })
  })
}

onMounted(async () => {
  pools.value = await resourcePoolsOf(props.platformId)
  form.resourcePoolName = freePools.value[0]?.name || ''
})

onBeforeUnmount(() => off?.())

async function submit(): Promise<void> {
  if (!pool.value) return
  finalResult.value = null
  running.value = true
  startLogging()
  try {
    const input = {
      name: form.name.trim(),
      mode: form.mode,
      charset: form.charset,
      collation: form.collation,
      comment: form.comment.trim() || undefined,
      primaryZone: form.primaryZone,
      whitelist: form.whitelist.trim() || undefined,
      rootPassword: form.rootPassword || undefined,
      resourcePoolName: form.resourcePoolName
    } as CloudDirectCreateTenantInput

    const r = await createDirectTenant(props.platformId, input, runId.value)
    finalResult.value = r.ok
      ? { ok: true, message: r.message || '已创建', warning: r.warning, connections: r.connections }
      : { ok: false, error: r.error || '创建失败' }
    if (r.ok) {
      pushNotice(r.message || '租户已创建')
      // 列表刷新不阻塞界面：某些集群连不通时 load() 可能很久不返回，
      // 一旦 await 就会把 running 卡住、导致「关不掉窗口」。
      void load()
    }
  } finally {
    running.value = false
    off?.()
    off = null
  }
}

/** 再建一个：清空日志回到表单，并刷新可用池（刚用掉的那个池已绑定租户） */
async function again(): Promise<void> {
  logs.value = []
  finalResult.value = null
  form.name = ''
  pools.value = await resourcePoolsOf(props.platformId)
  form.resourcePoolName = freePools.value[0]?.name || ''
}

const copiedKey = ref('')

/**
 * 复制连接串 / 改密语句。
 * 走主进程剪贴板：navigator.clipboard 在部分环境没有权限，静默失败时用户只看到"点了没反应"；
 * 同时把按钮切成「已复制 ✓」，比右下角 toast 更直观。
 */
async function copy(text: string, key = ''): Promise<void> {
  try {
    await window.sqlpilot.writeClipboard(text)
    if (key) {
      copiedKey.value = key
      setTimeout(() => { if (copiedKey.value === key) copiedKey.value = '' }, 1600)
    }
    pushNotice('已复制到剪贴板')
  } catch {
    void window.sqlpilot.uiAlert('复制失败', '当前环境不允许访问剪贴板，请手动选中命令复制。')
  }
}

function onMaskClick(): void {
  close()
}

/**
 * 关闭：任何状态下都能关。
 * 执行中关闭会二次确认——之前把按钮 disabled 掉，给人的观感是「点了没反应」，
 * 这属于交互缺陷，不该用禁用来解决。
 */
function close(): void {
  if (running.value) {
    void window.sqlpilot
      .uiConfirm('创建仍在执行', '关闭后将看不到后续执行日志，但操作会继续完成。确定关闭？', true)
      .then((ok) => {
        if (ok) closeCreate()
      })
    return
  }
  closeCreate()
}
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 300; background: rgba(5, 7, 12, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 22px;
  padding-top: var(--titlebar-h); backdrop-filter: blur(2px);
}
.panel {
  width: 760px; max-width: 100%; max-height: 88vh; display: flex; flex-direction: column;
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
.x:hover:not(:disabled) { color: var(--red); border-color: var(--red); }
.x:disabled { opacity: 0.45; cursor: not-allowed; }
.body { padding: 14px 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.grid { display: grid; grid-template-columns: 116px 1fr; gap: 9px 12px; align-items: center; }
label { font-size: 11px; color: var(--text-dim); }
label i { color: var(--red); font-style: normal; }
input, select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
  padding: 6px 9px; font-size: 12px; font-family: inherit; outline: none; min-width: 0;
}
input:focus, select:focus { border-color: var(--accent); }
input:disabled, select:disabled { opacity: 0.6; cursor: not-allowed; }
input::placeholder { color: var(--text-faint); }
.row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dim { font-size: 11px; color: var(--text-faint); }
.derived { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-dim); }
.kv b { color: var(--text); font-weight: 500; }
.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-dim); }
.chk input { accent-color: var(--accent); }
.gen {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 8px;
  padding: 6px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.gen:hover { color: var(--accent); border-color: var(--accent); }
.hint { font-size: 10.5px; margin-top: 4px; }
.hint.err { color: var(--red); }
.fnote {
  display: flex; gap: 7px; font-size: 11px; line-height: 1.7; color: var(--text-faint);
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
}
.fnote.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); }
.fnote .i {
  width: 14px; height: 14px; border-radius: 50%; background: var(--accent-dim); color: var(--accent);
  display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 2px;
}
/* 执行日志 */
.progress {
  display: flex; flex-direction: column; gap: 8px; max-height: 46vh; overflow: auto;
  padding: 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-input);
}
.logline { display: flex; gap: 8px; align-items: flex-start; }
.logline .dot {
  width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; flex-shrink: 0;
  background: var(--text-faint);
}
.logline.ok .dot { background: var(--green); }
.logline.warn .dot { background: var(--yellow); }
.logline.fail .dot { background: var(--red); }
.logline.start .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
.logline.pending .dot { background: var(--text-faint); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
.logtext { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.line1 { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text); }
.line1 b { font-weight: 500; }
.tag { font-size: 10px; color: var(--text-faint); }
.tag.ok { color: var(--green); }
.tag.warn { color: var(--yellow); }
.tag.fail { color: var(--red); }
.ts { margin-left: auto; font-size: 10px; color: var(--text-faint); font-family: var(--mono); }
.line2 { font-size: 11px; color: var(--text-dim); line-height: 1.6; word-break: break-all; }
.sql {
  display: block; font-family: var(--mono); font-size: 10.5px; color: var(--text-dim);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 7px; white-space: pre-wrap; word-break: break-all;
}
.summary { font-size: 12px; line-height: 1.7; border-radius: 8px; padding: 9px 11px; }
.summary.ok { color: var(--green); background: var(--green-dim); border: 1px solid color-mix(in srgb, var(--green) 35%, transparent); }
.summary.err { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); }
.conns { display: flex; flex-direction: column; gap: 8px; }
.conns-title { font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; }
.conn { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-input); padding: 7px 9px; }
.conn-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.conn-label { font-size: 11px; color: var(--text-dim); }
.copy {
  margin-left: auto; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.copy:hover { color: var(--accent); border-color: var(--accent); }
.copy.done { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.conn-cmd {
  display: block; font-family: var(--mono); font-size: 10.5px; color: var(--text);
  white-space: pre-wrap; word-break: break-all; line-height: 1.7;
}
.pwdhint {
  border: 1px solid color-mix(in srgb, var(--yellow) 45%, transparent);
  background: color-mix(in srgb, var(--yellow) 10%, transparent);
  border-radius: 9px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.pwdhint-title { font-size: 12px; font-weight: 600; color: var(--yellow); }
.pwdhint-body { font-size: 11.5px; line-height: 1.7; color: var(--text-dim); }
.pwdhint-body b { color: var(--text); }
.pwdhint .copy {
  align-self: flex-start; border: 1px solid var(--border); background: var(--bg-card); color: var(--text);
  border-radius: 6px; padding: 3px 10px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.pwdhint .copy:hover { color: var(--accent); border-color: var(--accent); }
.copy.done { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.ft { display: flex; justify-content: flex-end; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
.btn {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 8px; padding: 6px 14px; font-size: 12px; font-family: inherit; cursor: pointer;
}
.btn:hover:not(:disabled) { color: var(--text); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
