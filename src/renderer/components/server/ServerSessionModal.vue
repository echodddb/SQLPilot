<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="sm">
      <div class="sm-head">
        <span class="sm-title">{{ isNew ? '新建会话' : '编辑会话' }}</span>
        <span style="flex:1"></span>
        <button class="sm-x" @click="emit('close')">✕</button>
      </div>

      <div class="sm-body">
        <div class="sm-sec">
          <div class="sm-sec-t">基本</div>
          <div class="sm-grid">
            <label class="sm-f">
              <span>名称 *</span>
              <input v-model="form.name" placeholder="如 db-prod-01" />
            </label>
            <label class="sm-f">
              <span>分组</span>
              <input v-model="form.group" list="srv-groups" placeholder="如 生产环境" />
              <datalist id="srv-groups">
                <option v-for="g in groupNames" :key="g" :value="g" />
              </datalist>
            </label>
            <label class="sm-f">
              <span>标签（注入 AI 提示词）</span>
              <select v-model="form.tag">
                <option value="">无</option>
                <option>生产</option><option>测试</option><option>开发</option>
              </select>
            </label>
            <label class="sm-f sm-span2">
              <span>标签标识色（用于标签栏/会话列表区分；不选则按上方标签自动：生产红 / 测试黄 / 开发绿）</span>
              <div class="sm-colors">
                <button class="sm-sw auto" :class="{ on: !form.color }" title="自动（按标签推断）" @click="form.color = ''">自动</button>
                <button
                  v-for="c in SERVER_COLORS"
                  :key="c.value"
                  class="sm-sw"
                  :class="{ on: form.color === c.value }"
                  :style="{ background: c.value }"
                  :title="c.name"
                  @click="form.color = c.value"
                ></button>
              </div>
            </label>
            <label class="sm-f sm-span2">
              <span>备注</span>
              <input v-model="form.note" placeholder="如 该机器 alert 日志在 /u01/diag" />
            </label>
          </div>
        </div>

        <div class="sm-sec">
          <div class="sm-sec-t">连接</div>
          <div class="sm-grid">
            <label class="sm-f sm-span2">
              <span>主机 *</span>
              <input v-model="form.host" placeholder="192.168.1.100 或域名" spellcheck="false" />
            </label>
            <label class="sm-f">
              <span>端口</span>
              <input v-model.number="form.port" type="number" min="1" max="65535" />
            </label>
            <label class="sm-f">
              <span>用户名 *</span>
              <input v-model="form.user" placeholder="root / oracle" spellcheck="false" />
            </label>
            <label class="sm-f">
              <span>认证方式</span>
              <select v-model="form.auth">
                <option value="password">密码</option>
                <option value="key">私钥文件</option>
              </select>
            </label>
            <label class="sm-f">
              <span>跳板机</span>
              <select v-model="form.jumpId">
                <option value="">不使用</option>
                <option v-for="s in jumpCandidates" :key="s.id" :value="s.id">{{ s.name }}（{{ s.host }}）</option>
              </select>
            </label>

            <template v-if="form.auth === 'key'">
              <label class="sm-f sm-span2">
                <span>私钥文件 {{ isNew || !form.id ? '*' : '' }}</span>
                <div class="sm-row">
                  <input v-model="form.keyPath" placeholder="C:\Users\you\.ssh\id_rsa" spellcheck="false" />
                  <button class="sm-mini" @click="pickKey">选择…</button>
                </div>
              </label>
              <label class="sm-f sm-span2">
                <span>私钥口令（passphrase，此处留空 = 未加密或无口令）</span>
                <input v-model="keyPassphrase" type="password" :placeholder="hasKeyPass ? '已保存口令，留空不修改' : '无口令则留空'" />
              </label>
            </template>
            <label v-else class="sm-f sm-span2">
              <span>密码</span>
              <input v-model="password" type="password" :placeholder="hasPassword ? '已保存密码，留空不修改' : '请输入登录密码'" />
            </label>
          </div>
        </div>

        <div class="sm-sec">
          <div class="sm-sec-t">终端</div>
          <div class="sm-grid">
            <label class="sm-f">
              <span>终端编码</span>
              <select v-model="encodingOr">
                <option value="">跟随全局</option>
                <option v-for="e in ENCODINGS" :key="e.id" :value="e.id">{{ e.name }} — {{ e.hint }}</option>
              </select>
            </label>
            <label class="sm-f">
              <span>SFTP 文件名编码</span>
              <select v-model="fileEncodingOr">
                <option value="">跟随终端编码</option>
                <option v-for="e in ENCODINGS" :key="e.id" :value="e.id">{{ e.name }}</option>
              </select>
            </label>
            <label class="sm-f">
              <span>终端配色（文字/背景）</span>
              <select v-model="schemeOr">
                <option value="">跟随全局</option>
                <option v-for="s in TERM_SCHEMES" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </label>
            <label class="sm-f">
              <span>字号</span>
              <select v-model="fontSizeOr">
                <option value="">跟随全局</option>
                <option v-for="n in FONT_SIZES" :key="n" :value="n">{{ n }}px</option>
              </select>
            </label>
            <label class="sm-f sm-span2">
              <span>登录后进入目录</span>
              <input v-model="form.cwd" placeholder="如 /u01/app/oracle（留空则用登录用户主目录）" spellcheck="false" />
            </label>
          </div>
        </div>

        <div v-if="testMsg" class="sm-test" :class="{ ok: testOk }">
          <span>{{ testOk ? '✓' : '✗' }}</span>
          <span class="sm-test-t">{{ testMsg }}</span>
        </div>
      </div>

      <div class="sm-foot">
        <button class="sm-btn" :disabled="testing" @click="test">{{ testing ? '测试中…' : '测试连接' }}</button>
        <span style="flex:1"></span>
        <button class="sm-btn" @click="emit('close')">取消</button>
        <button class="sm-btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { SshServerCfg } from '../../../main/types'
import { servers, flash } from '../../server/state'
import { FONT_SIZES, ENCODINGS } from '../../server/prefs'
import { TERM_SCHEMES } from '../../server/schemes'
import { SERVER_COLORS } from '../../server/colors'

const props = defineProps<{ server: Partial<SshServerCfg> | null; isNew: boolean }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const form = reactive({
  id: props.server?.id || `srv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
  name: props.server?.name || '',
  host: props.server?.host || '',
  port: props.server?.port ?? 22,
  user: props.server?.user || '',
  group: props.server?.group || '',
  tag: props.server?.tag || '',
  note: props.server?.note || '',
  auth: (props.server?.auth || 'password') as 'password' | 'key',
  keyPath: props.server?.keyPath || '',
  jumpId: props.server?.jumpId || '',
  cwd: props.server?.cwd || '',
  // 空串 = 跟随全局（显式区分"没设置"与"设为 utf-8"）
  encoding: props.server?.encoding || '',
  fileEncoding: props.server?.fileEncoding || '',
  scheme: props.server?.scheme || '',
  fontSize: props.server?.fontSize ?? '',
  color: props.server?.color || ''
})

const password = ref('')
const keyPassphrase = ref('')
const testing = ref(false)
const saving = ref(false)
const testOk = ref(false)
const testMsg = ref('')

const hasPassword = computed(() => !props.isNew && props.server?.id)
const hasKeyPass = computed(() => !props.isNew && props.server?.id && props.server?.auth === 'key')

const encodingOr = computed({
  get: () => form.encoding,
  set: (v: string) => { form.encoding = v }
})
const fileEncodingOr = computed({
  get: () => form.fileEncoding,
  set: (v: string) => { form.fileEncoding = v }
})
const schemeOr = computed({
  get: () => form.scheme,
  set: (v: string) => { form.scheme = v }
})
const fontSizeOr = computed({
  get: () => form.fontSize,
  set: (v: any) => { form.fontSize = v === '' ? '' : Number(v) }
})

const groupNames = computed(() => {
  const set = new Set<string>()
  for (const s of servers()) if (s.group) set.add(s.group)
  return [...set].sort()
})

/** 跳板候选：不能选自己；也不能选以自己为跳板的下游（否则成环，主进程也会拒绝） */
const jumpCandidates = computed(() =>
  servers().filter((s) => {
    if (s.id === form.id) return false
    let cur: SshServerCfg | undefined = s
    const seen = new Set<string>()
    while (cur?.jumpId) {
      if (cur.jumpId === form.id) return false
      if (seen.has(cur.id)) break
      seen.add(cur.id)
      cur = servers().find((x) => x.id === cur!.jumpId)
    }
    return true
  })
)

function payload(): any {
  const p: any = { ...form }
  // 空串字段不入库：主进程按"缺失=跟随全局"处理
  for (const k of ['group', 'tag', 'note', 'keyPath', 'jumpId', 'cwd', 'encoding', 'fileEncoding', 'scheme', 'color']) {
    if (!p[k]) delete p[k]
  }
  if (p.fontSize === '' || p.fontSize == null) delete p.fontSize
  return p
}

async function pickKey(): Promise<void> {
  const r = await window.sqlpilot.pickFile('选择私钥文件', [
    { name: '私钥', extensions: ['pem', 'key', 'ppk', 'id_rsa', 'id_ed25519', 'id_ecdsa', '*'] },
    { name: '所有文件', extensions: ['*'] }
  ])
  if (r.ok && r.path) form.keyPath = r.path
}

async function test(): Promise<void> {
  if (!form.host || !form.user) {
    testOk.value = false
    testMsg.value = '请先填写主机和用户名'
    return
  }
  testing.value = true
  testMsg.value = ''
  try {
    const r = await window.sqlpilot.testServer(payload(), password.value || undefined, keyPassphrase.value || undefined)
    testOk.value = r.ok
    testMsg.value = r.ok
      ? [r.label, r.viaJump ? `经跳板 ${r.viaJump}` : '', r.locale ? `locale ${r.locale}` : ''].filter(Boolean).join(' · ')
      : (r.error || '连接失败')
  } catch (e: any) {
    testOk.value = false
    testMsg.value = String(e?.message || e)
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  if (!form.name.trim() || !form.host.trim() || !form.user.trim()) {
    await window.sqlpilot.uiAlert('名称、主机、用户名必填')
    return
  }
  if (form.auth === 'key' && !form.keyPath.trim()) {
    await window.sqlpilot.uiAlert('认证方式为私钥时必须选择私钥文件')
    return
  }
  if (props.isNew && form.auth === 'password' && !password.value) {
    await window.sqlpilot.uiAlert('新建密码认证的服务器需要填写密码', '如需免密登录，请改用私钥认证。')
    return
  }
  saving.value = true
  const r = await window.sqlpilot.saveServer(payload(), password.value || undefined, keyPassphrase.value || undefined)
  saving.value = false
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '保存失败')
    return
  }
  emit('saved')
  flash(props.isNew ? `已创建「${form.name}」` : `已更新「${form.name}」`)
  emit('close')
}
</script>

<style scoped>
.sm {
  width: 720px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden;
}
.sm-head { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.sm-title { font-size: 14px; font-weight: 600; color: var(--text); }
.sm-x { border: none; background: none; color: var(--text-faint); cursor: pointer; font-size: 13px; font-family: inherit; }
.sm-x:hover { color: var(--red); }
.sm-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
.sm-sec { margin-bottom: 16px; }
.sm-sec-t {
  font-size: 11px; font-weight: 700; color: var(--text-faint);
  letter-spacing: 1px; margin-bottom: 8px; padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.sm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
.sm-f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sm-f > span { font-size: 11.5px; color: var(--text-dim); }
.sm-f input, .sm-f select { font-size: 12.5px; padding: 5px 9px; border-radius: 7px; }
.sm-span2 { grid-column: span 2; }
.sm-row { display: flex; gap: 6px; }
.sm-row input { flex: 1; min-width: 0; }
.sm-mini {
  border: 1px solid var(--border); background: var(--bg-side); color: var(--text-dim);
  border-radius: 7px; padding: 0 10px; font-size: 12px; cursor: pointer; font-family: inherit; white-space: nowrap;
}
.sm-mini:hover { color: var(--accent); border-color: var(--accent); }
.sm-test {
  display: flex; gap: 8px; font-size: 12px; line-height: 1.6;
  padding: 8px 10px; border-radius: 8px; background: var(--red-dim); color: var(--red);
  word-break: break-all; white-space: pre-wrap; max-height: 130px; overflow: auto;
}
/* 标识色色板 */
.sm-colors { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; padding: 2px 0; }
.sm-sw {
  width: 26px; height: 22px; border-radius: 6px; cursor: pointer;
  border: 2px solid transparent; outline: 1px solid var(--border);
  transition: transform .1s ease, outline-color .1s ease;
}
.sm-sw:hover { transform: translateY(-1px); }
.sm-sw.on { border-color: var(--bg-card); outline: 2px solid var(--text); }
.sm-sw.auto {
  width: auto; padding: 0 9px; height: 22px; font-size: 11.5px; font-family: inherit;
  background: var(--bg-side); color: var(--text-dim);
}
.sm-sw.auto.on { color: var(--accent); outline-color: var(--accent); }
.sm-test.ok { background: var(--green-dim); color: var(--green); }
.sm-test-t { flex: 1; }
.sm-foot { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
.sm-btn {
  border: 1px solid var(--border); background: var(--bg-side); color: var(--text-dim);
  border-radius: 7px; padding: 5px 15px; font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.sm-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sm-btn:disabled { opacity: .5; cursor: default; }
.sm-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.sm-btn.primary:hover:not(:disabled) { filter: brightness(1.1); }
</style>
