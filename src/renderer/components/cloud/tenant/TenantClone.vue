<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header class="ph">
        <div>
          <b>克隆租户</b>
          <span class="sub">源：{{ src.name }} @ {{ src.clusterName }} · 复制为一个新租户（不含会话与临时状态）</span>
        </div>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="body">
        <!-- 预检查 -->
        <div v-if="checkLoading" class="note">正在做克隆预检查…</div>
        <template v-else-if="check">
          <div v-if="check.valid" class="ok-banner">预检查通过，可以提交克隆任务。</div>
          <div v-else class="bad-banner">
            <b>不满足克隆条件</b>
            <div v-for="(c, i) in check.checkResults" :key="i" class="chk-row">
              <span class="code">{{ c.errorCode }}</span>{{ c.errorMessage }}
            </div>
            <div class="hint">克隆依赖源租户的日志归档（用于保证数据一致）。请先在「备份」里为源租户开启归档后重试。</div>
          </div>
          <div v-if="check.valid && check.checkResults.length" class="warn-banner">
            <div v-for="(c, i) in check.checkResults" :key="i" class="chk-row">
              <span class="code">{{ c.errorCode }}</span>{{ c.errorMessage }}
            </div>
          </div>
        </template>

        <div class="sec">新租户</div>
        <div class="grid">
          <label class="frow">租户名
            <input v-model="form.name" class="inp mono" spellcheck="false" :placeholder="`${src.name}_clone`" />
          </label>
          <label class="frow">字符集
            <input v-model="form.charset" class="inp mono" />
          </label>
          <label class="frow">排序规则
            <input v-model="form.collation" class="inp mono" />
          </label>
          <label class="frow">主 Zone
            <input v-model="form.primaryZone" class="inp mono" />
          </label>
        </div>
        <label class="frow">白名单
          <input v-model="form.whitelist" class="inp mono" />
        </label>
        <label class="frow">描述
          <input v-model="form.description" class="inp" placeholder="可选" />
        </label>

        <div class="sec">副本与资源</div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th style="width:26px"></th><th>Zone</th><th>副本类型</th><th>Unit 规格</th><th>Unit 数</th></tr></thead>
            <tbody>
              <tr v-for="z in form.zones" :key="z.name">
                <td><input type="checkbox" v-model="z.checked" /></td>
                <td class="mono">{{ z.name }}</td>
                <td>
                  <select v-model="z.replicaType" class="inp sm">
                    <option value="FULL">FULL</option>
                    <option value="READONLY">READONLY</option>
                    <option value="LOGONLY">LOGONLY</option>
                  </select>
                </td>
                <td>
                  <select v-model="z.unitSpecName" class="inp sm" :class="{ warn: z.checked && !z.unitSpecName }">
                    <option value="" disabled>请选择规格</option>
                    <option v-for="s in userSpecs" :key="s.id" :value="s.name">{{ s.name }}（{{ s.maxCpu }}C/{{ s.maxMemory }}G）</option>
                  </select>
                </td>
                <td><input v-model.number="z.unitCount" type="number" min="1" class="inp sm num" /></td>
              </tr>
              <tr v-if="!form.zones.length"><td colspan="5" class="empty">源租户没有副本信息</td></tr>
            </tbody>
          </table>
        </div>
        <div class="hint">规格按「CPU + 内存」与源租户 Unit 匹配；同 CPU/内存可能有多个规格（日志盘、IOPS 不同），提交前请核对。</div>
        <div v-if="specMissing" class="warn-banner">有 Zone 还没选 Unit 规格。源租户的 Unit 规格没能按 CPU/内存反查到同名规格，请手动选择后再提交。</div>

        <div v-if="msg" class="msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

        <div class="actions">
          <span class="sp"></span>
          <button class="btn" :disabled="busy" @click="close">取消</button>
          <button class="btn primary" :disabled="busy || !canSubmit" @click="submit">
            {{ busy ? '提交中…' : canSubmit ? '开始克隆' : '预检查未通过' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 克隆租户：POST /tenants/{tid}/clonePreCheck → /clone
 * 克隆依赖源租户的日志归档；预检查不通过时禁用提交（不硬闯）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { cloud, refreshTenant } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const emit = defineEmits<{ (e: 'close'): void }>()

const d = computed(() => cloud.tenant as CloudTenantDetail)
const src = computed(() => d.value.tenant)

const check = ref<CloudPreCheckResult | null>(null)
const checkLoading = ref(true)
const specs = ref<CloudUnitSpec[]>([])
const busy = ref(false)
const msg = ref('')
const msgOk = ref(true)

const userSpecs = computed(() => specs.value)

const form = reactive({
  name: '',
  charset: '',
  collation: '',
  primaryZone: '',
  whitelist: '',
  description: '',
  zones: [] as { name: string; checked: boolean; replicaType: string; unitSpecName: string; unitCount: number }[]
})

const canSubmit = computed(() =>
  !!check.value?.valid
  && !!form.name.trim()
  && form.zones.some((z) => z.checked)
  && form.zones.filter((z) => z.checked).every((z) => !!z.unitSpecName)
)

/** 有 Zone 未选规格时的提示（避免用错规格建租户） */
const specMissing = computed(() => form.zones.some((z) => z.checked && !z.unitSpecName))

async function loadSpecs(): Promise<void> {
  const r = await window.sqlpilot.cloudUnitSpecs(cloud.activeId)
  specs.value = r.ok ? r.data || [] : []
}

/**
 * 按 CPU 核数 + 内存（字节）反查 Unit 规格名。
 * 租户详情给的是资源池名（pool_xxx）与 Unit 的 CPU/内存，不是规格名，所以要反查。
 * 反查不到就**不预选**（宁可让用户明确选，也不能悄悄用错规格建出租户）。
 */
function pickSpecName(cpu: number, memBytes: number, fallbackPool: string): string {
  const gib = memBytes > 0 ? memBytes / 1024 ** 3 : 0
  const hit = specs.value.find((s) => Math.abs(s.maxCpu - cpu) < 0.001 && Math.abs(s.maxMemory - gib) < 0.05)
  if (hit) return hit.name
  // 有的部署资源池直接以规格名命名，能直接命中
  if (fallbackPool && specs.value.some((s) => s.name === fallbackPool)) return fallbackPool
  return ''
}

async function runCheck(): Promise<void> {
  checkLoading.value = true
  try {
    const t = src.value
    const r = await window.sqlpilot.cloudTenantClonePreCheck(cloud.activeId, t.clusterId, t.id)
    check.value = r.ok ? r.data || null : { valid: false, checkResults: [{ errorCode: 'REQUEST', errorMessage: r.error || '预检查失败', warning: false }] }
  } finally {
    checkLoading.value = false
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const t = src.value
  const ok = await window.sqlpilot.uiConfirm(
    `克隆租户「${t.name}」为「${form.name.trim()}」？`,
    '克隆会复制源租户的数据与结构，占用目标集群的资源，并提交为 OCP 异步任务。'
  )
  if (!ok) return
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudTenantClone(cloud.activeId, t.clusterId, t.id, {
      name: form.name.trim(),
      mode: t.mode,
      charset: form.charset || undefined,
      collation: form.collation || undefined,
      primaryZone: form.primaryZone || undefined,
      whitelist: form.whitelist || undefined,
      description: form.description || undefined,
      zones: form.zones.map((z) => ({
        name: z.name,
        checked: z.checked,
        replicaType: z.replicaType,
        unitSpecName: z.unitSpecName,
        unitCount: z.unitCount
      }))
    })
    if (!r.ok) { msg.value = r.error || '克隆失败'; msgOk.value = false; return }
    pushNotice(r.data?.taskId ? `克隆任务已提交：任务 #${r.data.taskId}` : '克隆任务已提交')
    await refreshTenant()
    emit('close')
  } finally {
    busy.value = false
  }
}

function close(): void { emit('close') }

onMounted(async () => {
  const t = src.value
  form.name = `${t.name}_clone`
  form.charset = d.value.charset || 'utf8mb4'
  form.collation = d.value.collation || 'utf8mb4_general_ci'
  form.primaryZone = t.primaryZone || 'RANDOM'
  form.whitelist = d.value.whitelist || '%'
  form.description = d.value.description || ''
  // 先拿规格列表，才能把源租户的 Unit 规格反查成规格名
  await loadSpecs()
  form.zones = d.value.zones.map((z) => ({
    name: z.name,
    checked: true,
    replicaType: z.replicaType || 'FULL',
    unitSpecName: pickSpecName(z.unitCpu, z.unitMemory, z.poolName),
    unitCount: z.unitCount || 1
  }))
  await runCheck()
})
</script>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 310; background: rgba(5, 7, 12, 0.55); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); padding: 22px; padding-top: var(--titlebar-h); }
.panel { width: 780px; max-width: 100%; max-height: 88vh; display: flex; flex-direction: column; background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-lg); }
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph b { font-size: 14.5px; display: block; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.body { overflow-y: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 9px; }
.sec { font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; padding-top: 4px; border-top: 1px dashed var(--border); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 9px; }
.frow { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-dim); }
.inp { background: var(--bg-card); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 8px; outline: none; width: 100%; }
.inp:focus { border-color: var(--accent); }
.inp.sm { padding: 2px 6px; font-size: 11px; }
.inp.warn { border-color: var(--yellow); color: var(--yellow); }
.num { width: 64px; }
.mono { font-family: var(--mono); }
.tbl-wrap { border: 1px solid var(--border); border-radius: 9px; overflow: auto; background: var(--bg-card); }
.tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tbl th { text-align: left; font-size: 10.5px; font-weight: 500; color: var(--text-faint); padding: 6px 9px; background: var(--bg-input); border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl td { padding: 4px 9px; border-bottom: 1px solid var(--border); }
.tbl tbody tr:last-child td { border-bottom: none; }
.empty { text-align: center; color: var(--text-faint); padding: 16px !important; }
.ok-banner { font-size: 11.5px; color: var(--green); background: var(--green-dim); border-radius: 8px; padding: 7px 10px; }
.bad-banner { font-size: 11.5px; color: var(--red); background: var(--red-dim); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; }
.warn-banner { font-size: 11.5px; color: var(--yellow); background: var(--yellow-dim); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; }
.chk-row { display: flex; gap: 6px; line-height: 1.5; }
.chk-row .code { font-family: var(--mono); font-size: 10px; opacity: 0.85; flex-shrink: 0; }
.hint { font-size: 10.5px; color: var(--text-faint); line-height: 1.55; }
.bad-banner .hint { color: color-mix(in srgb, var(--red) 75%, var(--text-faint)); }
.note { font-size: 11.5px; color: var(--text-dim); }
.msg { font-size: 11px; border-radius: 7px; padding: 6px 9px; }
.msg.ok { color: var(--green); background: var(--green-dim); }
.msg.err { color: var(--red); background: var(--red-dim); }
.actions { display: flex; align-items: center; gap: 8px; }
.actions .sp { flex: 1; }
.btn { border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim); border-radius: 7px; padding: 5px 13px; font-size: 11.5px; font-family: inherit; cursor: pointer; }
.btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.btn.primary { background: var(--accent-dim); color: var(--accent); border-color: var(--accent); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
