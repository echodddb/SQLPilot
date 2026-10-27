<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header class="ph">
        <div>
          <b>创建备租户</b>
          <span class="sub">主租户：{{ main.name }} @ {{ main.clusterName }} → 在目标集群创建一个只读备租户</span>
        </div>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="body">
        <div class="warn-banner">
          主备要求源租户已开启<b>日志归档</b>并能访问归档存储；未开归档时 OCP 会拒绝创建。
          此入口尚未在生产集群真机验证过创建动作。
        </div>

        <!-- 主租户信息 -->
        <div class="sec">主租户</div>
        <div v-if="infoLoading" class="note">读取主租户副本配置…</div>
        <template v-else-if="info">
          <div class="kv-grid">
            <div class="kv"><span>负载类型</span><b>{{ info.loadType || '—' }}</b></div>
            <div class="kv"><span>Locality</span><b class="mono">{{ info.locality || '—' }}</b></div>
            <div class="kv"><span>日志备份</span><b :style="info.logBackupOn ? 'color:var(--green)' : 'color:var(--yellow)'">{{ info.logBackupOn ? '已开启' : '未开启' }}</b></div>
            <div class="kv"><span>日志完整性</span><b>{{ info.logComplete ? '完整' : '不完整' }}</b></div>
            <div class="kv"><span>可访问备份存储</span><b>{{ info.canVisitPrimaryBackupStorage ? '是' : '否' }}</b></div>
            <div class="kv"><span>可从备份恢复</span><b>{{ info.canRestoreTenant ? '是' : '否' }}</b></div>
          </div>
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th>资源池</th><th>Zone</th><th class="r">Unit 数</th><th class="r">单 Unit CPU</th><th class="r">单 Unit 内存</th></tr></thead>
              <tbody>
                <tr v-for="p in info.resourcePools" :key="p.name">
                  <td class="mono">{{ p.name }}</td>
                  <td class="mono dim">{{ p.zoneList.join(', ') }}</td>
                  <td class="r mono">{{ p.unitCount }}</td>
                  <td class="r mono">{{ p.unitCpu }}</td>
                  <td class="r mono">{{ fmtBytes(p.unitMemory) }}</td>
                </tr>
                <tr v-if="!info.resourcePools.length"><td colspan="5" class="empty">OCP 未返回主租户资源池</td></tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- 备租户 -->
        <div class="sec">备租户</div>
        <div class="grid">
          <label class="frow">目标集群（备集群）
            <select v-model.number="form.clusterId" class="inp" @change="onClusterChange">
              <option :value="0" disabled>请选择集群</option>
              <option v-for="c in clusters" :key="c.id" :value="c.id" :disabled="c.status !== 'RUNNING'">
                {{ c.name }}{{ /metadb|meta_cluster|ocp.?meta/i.test(c.name) ? '（OCP 元数据集群，不建议）' : '' }}{{ c.status !== 'RUNNING' ? '（' + c.status + '）' : '' }}{{ c.id === main.clusterId ? '（与主租户同集群）' : '' }}
              </option>
            </select>
          </label>
          <label class="frow">备租户名
            <input v-model="form.name" class="inp mono" placeholder="如 obmysql_standby" spellcheck="false" />
          </label>
          <label class="frow">主备同步方式
            <select v-model="form.logTransportMode" class="inp">
              <option value="ASYNC">ASYNC（异步，性能优先）</option>
              <option value="SYNC">SYNC（强同步，切换不丢数据）</option>
            </select>
          </label>
          <label class="frow">主 Zone（备集群内）
            <select v-model="form.primaryZone" class="inp">
              <option value="RANDOM">RANDOM</option>
              <option v-for="z in form.zones" :key="z.name" :value="z.name">{{ z.name }}</option>
            </select>
          </label>
        </div>
        <div class="grid">
          <label class="frow">字符集
            <input v-model="form.charset" class="inp mono" />
          </label>
          <label class="frow">排序规则
            <input v-model="form.collation" class="inp mono" />
          </label>
          <label class="frow">白名单
            <input v-model="form.whitelist" class="inp mono" />
          </label>
        </div>

        <div class="sec">备租户副本</div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Zone</th><th>副本类型</th><th>Unit 规格</th><th>Unit 数</th></tr></thead>
            <tbody>
              <tr v-for="z in form.zones" :key="z.name">
                <td class="mono">{{ z.name }}</td>
                <td>
                  <select v-model="z.replicaType" class="inp sm">
                    <option value="FULL">FULL</option>
                    <option value="READONLY">READONLY</option>
                    <option value="LOGONLY">LOGONLY</option>
                  </select>
                </td>
                <td>
                  <select v-model="z.unitSpecName" class="inp sm" :class="{ warn: !z.unitSpecName }">
                    <option value="" disabled>请选择规格</option>
                    <option v-for="s in targetSpecs" :key="s.id" :value="s.name">{{ s.name }}（{{ s.maxCpu }}C/{{ s.maxMemory }}G）</option>
                  </select>
                </td>
                <td><input v-model.number="z.unitCount" type="number" min="1" class="inp sm num" /></td>
              </tr>
              <tr v-if="!form.zones.length"><td colspan="4" class="empty">{{ loadingTarget ? '读取目标集群 Zone…' : '先选择目标集群' }}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="hint">默认按目标集群的全部 Zone 生成三副本 FULL 配置，Unit 数与主租户对齐；建议与主租户规格保持一致，避免切换后性能落差。</div>
        <div v-if="specMissing" class="warn-banner">有 Zone 还没选 Unit 规格：主租户的 Unit 规格没能按 CPU/内存反查到目标环境的同名规格，请手动指定。</div>

        <div v-if="msg" class="msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

        <div class="actions">
          <span class="sp"></span>
          <button class="btn" :disabled="busy" @click="close">取消</button>
          <button class="btn primary" :disabled="busy || !canSubmit" @click="submit">{{ busy ? '提交中…' : '创建备租户' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 创建备租户：以当前打开的租户为主租户，在目标集群创建 STANDBY 租户。
 * POST /clusters/{cid}/tenants/createStandbyTenant（cid = 备集群）。
 * 依赖主租户日志归档，未验证过真机创建。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtBytes } from '../../../cloud/parts'
import { pushNotice } from '../../../store'

const emit = defineEmits<{ (e: 'close'): void }>()

const d = computed(() => cloud.tenant as CloudTenantDetail)
const main = computed(() => d.value.tenant)

const clusters = ref<CloudCluster[]>([])
const info = ref<CloudPrimaryTenantInfo | null>(null)
const infoLoading = ref(true)
const targetSpecs = ref<CloudUnitSpec[]>([])
const loadingTarget = ref(false)
const busy = ref(false)
const msg = ref('')
const msgOk = ref(true)

const form = reactive({
  clusterId: 0,
  name: '',
  logTransportMode: 'ASYNC',
  primaryZone: 'RANDOM',
  charset: '',
  collation: '',
  whitelist: '',
  zones: [] as { name: string; replicaType: string; unitSpecName: string; unitCount: number }[]
})

const canSubmit = computed(() => !!form.clusterId && !!form.name.trim() && form.zones.length > 0 && form.zones.every((z) => !!z.unitSpecName))

/** 有 Zone 没选规格时提示 */
const specMissing = computed(() => form.zones.length > 0 && form.zones.some((z) => !z.unitSpecName))

/** 按 CPU/内存反查规格名；反查不到返回空（不猜，避免用错规格） */
function pickSpecName(cpu: number, memBytes: number): string {
  const gib = memBytes > 0 ? memBytes / 1024 ** 3 : 0
  const hit = targetSpecs.value.find((s) => Math.abs(s.maxCpu - cpu) < 0.001 && Math.abs(s.maxMemory - gib) < 0.05)
  return hit?.name || ''
}

async function loadInfo(): Promise<void> {
  infoLoading.value = true
  try {
    const t = main.value
    const r = await window.sqlpilot.cloudPrimaryTenantInfo(cloud.activeId, t.clusterId, t.id)
    info.value = r.ok ? r.data || null : null
  } finally {
    infoLoading.value = false
  }
}

async function onClusterChange(): Promise<void> {
  form.zones = []
  targetSpecs.value = []
  if (!form.clusterId) return
  loadingTarget.value = true
  try {
    const [cd, sp] = await Promise.all([
      window.sqlpilot.cloudCluster(cloud.activeId, form.clusterId),
      window.sqlpilot.cloudUnitSpecs(cloud.activeId)
    ])
    targetSpecs.value = sp.ok ? sp.data || [] : []
    const zoneNames = (cd.ok ? cd.data?.zones || [] : []).map((z) => z.name)
    const pool = info.value?.resourcePools[0]
    const specName = pool ? pickSpecName(pool.unitCpu, pool.unitMemory) : ''
    const unitCount = pool?.unitCount || 1
    form.zones = zoneNames.map((n) => ({
      name: n,
      replicaType: 'FULL',
      unitSpecName: specName,
      unitCount
    }))
    if (form.primaryZone !== 'RANDOM' && !zoneNames.includes(form.primaryZone)) form.primaryZone = 'RANDOM'
  } finally {
    loadingTarget.value = false
  }
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const t = main.value
  const ok = await window.sqlpilot.uiConfirm(
    `在集群「${clusters.value.find((c) => c.id === form.clusterId)?.name}」创建备租户「${form.name.trim()}」？`,
    '备租户会持续回放主租户的 redo 日志，占用目标集群资源。创建为 OCP 异步任务。'
  )
  if (!ok) return
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudCreateStandbyTenant(cloud.activeId, form.clusterId, {
      name: form.name.trim(),
      mode: t.mode,
      primaryTenantId: t.id,
      logTransportMode: form.logTransportMode,
      charset: form.charset || undefined,
      collation: form.collation || undefined,
      primaryZone: form.primaryZone || undefined,
      whitelist: form.whitelist || undefined,
      zones: form.zones.map((z) => ({ name: z.name, replicaType: z.replicaType, unitSpecName: z.unitSpecName, unitCount: z.unitCount }))
    })
    if (!r.ok) { msg.value = r.error || '创建失败'; msgOk.value = false; return }
    pushNotice(r.data?.taskId ? `创建备租户任务已提交：任务 #${r.data.taskId}` : '创建备租户任务已提交')
    emit('close')
  } finally {
    busy.value = false
  }
}

function close(): void { emit('close') }

onMounted(async () => {
  const t = main.value
  form.name = `${t.name}_standby`
  form.charset = d.value.charset || 'utf8mb4'
  form.collation = d.value.collation || 'utf8mb4_general_ci'
  form.whitelist = d.value.whitelist || '%'

  const r = await window.sqlpilot.cloudClusters(cloud.activeId)
  clusters.value = r.ok ? r.data || [] : []
  // 先取主租户副本配置（备租户的 Unit 数/规格要参照它），再选目标集群
  await loadInfo()
  // 默认挑另一个「业务」集群：排除主租户所在集群与 OCP 元数据集群
  const pool = clusters.value.filter((c) => c.status === 'RUNNING' && !/metadb|meta_cluster|ocp.?meta/i.test(c.name))
  const pick = pool.find((c) => c.id !== t.clusterId) || pool[0]
  if (pick) {
    form.clusterId = pick.id
    await onClusterChange()
  }
})
</script>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 310; background: rgba(5, 7, 12, 0.55); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); padding: 22px; padding-top: var(--titlebar-h); }
.panel { width: 820px; max-width: 100%; max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-lg); }
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph b { font-size: 14.5px; display: block; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.body { overflow-y: auto; padding: 12px 16px 16px; display: flex; flex-direction: column; gap: 9px; }
.sec { font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; padding-top: 4px; border-top: 1px dashed var(--border); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 9px; }
.frow { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-dim); }
.inp { background: var(--bg-card); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 8px; outline: none; width: 100%; }
.inp:focus { border-color: var(--accent); }
.inp.sm { padding: 2px 6px; font-size: 11px; }
.inp.warn { border-color: var(--yellow); color: var(--yellow); }
.num { width: 64px; }
.mono { font-family: var(--mono); }
.kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 6px; }
.kv { background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 5px 9px; }
.kv span { display: block; font-size: 10px; color: var(--text-faint); }
.kv b { display: block; font-size: 11.5px; font-weight: 550; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tbl-wrap { border: 1px solid var(--border); border-radius: 9px; overflow: auto; max-height: 30vh; background: var(--bg-card); }
.tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tbl th { text-align: left; font-size: 10.5px; font-weight: 500; color: var(--text-faint); padding: 6px 9px; background: var(--bg-input); border-bottom: 1px solid var(--border); white-space: nowrap; position: sticky; top: 0; }
.tbl td { padding: 4px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl .r { text-align: right; }
.dim { color: var(--text-dim); }
.empty { text-align: center; color: var(--text-faint); padding: 16px !important; }
.warn-banner { font-size: 11.5px; color: var(--yellow); background: var(--yellow-dim); border-radius: 8px; padding: 8px 10px; line-height: 1.6; }
.hint { font-size: 10.5px; color: var(--text-faint); line-height: 1.55; }
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
