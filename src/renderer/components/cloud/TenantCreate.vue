<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header class="ph">
        <div>
          <b>创建租户</b>
          <span class="sub">{{ clusterLabel }} · 提交为 OCP 异步任务，进度见「任务」页</span>
        </div>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="body">
        <!-- 1. 基本设置 -->
        <div class="sec">基本设置</div>

        <div class="row two">
          <div class="frow">
            <label>所属集群 <i>*</i></label>
            <select v-model.number="form.clusterId" @change="onClusterChange">
              <option :value="0" disabled>请选择集群</option>
              <option v-for="c in clusters" :key="c.id" :value="c.id" :disabled="c.status !== 'RUNNING'">
                {{ c.name }}{{ isMetaCluster(c.name) ? '（OCP 元数据集群，不建议建业务租户）' : '' }}{{ c.status !== 'RUNNING' ? '（' + c.status + '，不可创建）' : '' }}
              </option>
            </select>
          </div>
          <div class="frow">
            <label>租户名 <i>*</i></label>
            <input v-model="form.name" placeholder="如 app_mysql（字母开头，2~64 位）" spellcheck="false" />
          </div>
        </div>

        <div class="row three">
          <div class="frow">
            <label>兼容模式</label>
            <select v-model="form.mode">
              <option value="MYSQL">MySQL</option>
              <option value="ORACLE">Oracle</option>
            </select>
          </div>
          <div class="frow">
            <label>字符集</label>
            <select v-model="form.charset" @change="onCharsetChange">
              <option v-for="c in charsets" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div class="frow">
            <label>排序规则</label>
            <select v-model="form.collation">
              <option v-for="c in collations" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
        </div>

        <div class="frow">
          <label>租户描述（可选）</label>
          <input v-model="form.description" placeholder="用途 / 归属业务，便于后续识别" spellcheck="false" />
        </div>

        <!-- 2. 副本与资源 -->
        <div class="sec">副本与资源</div>

        <div class="frow">
          <label>副本所在 Zone <i>*</i>（勾选后可在下方逐 Zone 设副本类型与规格）</label>
          <div class="zones">
            <label v-for="z in zoneNames" :key="z" class="zchk" :class="{ off: !zoneOf(z) }">
              <input type="checkbox" :checked="!!zoneOf(z)" @change="toggleZone(z)" />
              <span>{{ z }}</span>
            </label>
            <span v-if="!zoneNames.length" class="dim">{{ loadingCluster ? '读取集群 Zone…' : '该集群没有可用 Zone' }}</span>
          </div>
        </div>

        <div v-if="form.zones.length" class="ztable">
          <div class="zrow head">
            <span>Zone</span><span>副本类型</span><span>Unit 规格</span><span>Unit 数</span><span></span>
          </div>
          <div v-for="(z, i) in form.zones" :key="z.name" class="zrow">
            <span class="zname">{{ z.name }}</span>
            <select v-model="z.replicaType" class="zsel">
              <option value="FULL">FULL（全能）</option>
              <option value="READONLY">READONLY（只读）</option>
              <option value="LOGONLY">LOGONLY（日志）</option>
            </select>
            <select v-model="z.unitSpecName" class="zsel">
              <option v-for="u in unitSpecs" :key="u.name" :value="u.name">{{ u.name }}（{{ u.cpu }}C/{{ fmtBytes(u.memory) }}）</option>
            </select>
            <input v-model.number="z.unitCount" type="number" min="1" class="znum" />
            <button class="zdel" title="移除该 Zone" @click="form.zones.splice(i, 1)">✕</button>
          </div>
          <div class="zsum">
            <span v-for="(g, k) in quota" :key="k" class="tp-chip">{{ k }} {{ g }}</span>
          </div>
        </div>

        <div class="row two">
          <div class="frow">
            <label>主 Zone</label>
            <select v-model="form.primaryZone">
              <option value="RANDOM">RANDOM（随机）</option>
              <option v-for="z in form.zones" :key="z.name" :value="z.name">{{ z.name }}</option>
            </select>
          </div>
          <div class="frow">
            <label>Zone 优先级（可选，高级）</label>
            <input v-model="form.zonePriority" :placeholder="defaultPriority || 'zone1;zone2'" spellcheck="false" />
          </div>
        </div>

        <!-- 3. 安全设置 -->
        <div class="sec">安全设置</div>

        <div class="row two">
          <div class="frow">
            <label>root 初始密码 <i>*</i></label>
            <div class="pwd">
              <input v-model="form.rootPassword" type="text" placeholder="8~32 位，含大小写字母/数字/特殊字符" spellcheck="false" />
              <button class="gen" title="随机生成 16 位强密码" @click="genPassword">生成</button>
            </div>
          </div>
          <div class="frow">
            <label>白名单</label>
            <input v-model="form.whitelist" placeholder="%, 10.0.0.0/8, 192.168.1.%" spellcheck="false" />
          </div>
        </div>

        <div class="fnote">
          <span class="i">i</span>
          <div>
            <div>创建会占用所选集群的 CPU / 内存资源，Unit 数不能超过该 Zone 的 OBServer 数量。</div>
            <div>OCP 会自动把自身 IP 与 127.0.0.1 加入租户白名单。</div>
            <div v-if="pwdWeak" class="warn">{{ pwdWeak }}</div>
          </div>
        </div>

        <div v-if="msg" class="msg" :class="msgKind">{{ msg }}</div>

        <div class="actions">
          <span style="flex:1"></span>
          <button class="btn ghost" :disabled="busy" @click="close">取消</button>
          <button class="btn primary" :disabled="busy || !canSubmit" @click="submit">{{ busy ? '提交中…' : '创建' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 创建租户（对齐 OCP「新建租户」向导的可用子集）：
 * 基本设置（集群/名称/模式/字符集+排序规则/描述）→ 副本与资源（逐 Zone 副本类型·Unit 规格·数量）
 * → 安全设置（root 密码/白名单）。
 *
 * 只支持创建主租户（type=PRIMARY）。OCP 的「复制租户 / 创建备租户 / 使用备份集恢复」
 * 依赖备份归档与主备链路，参数未验证，不在此提供。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { pushNotice } from '../../store'
import { cloud, createTenant } from '../../cloud/state'
import { fmtBytes } from '../../cloud/parts'

const props = defineProps<{ clusterId?: number | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

interface ZoneRow { name: string; replicaType: string; unitSpecName: string; unitCount: number }

/** 字符集 → 排序规则候选（与 OB 支持的组合一致） */
const CHARSET_COLLATIONS: Record<string, string[]> = {
  utf8mb4: ['utf8mb4_general_ci', 'utf8mb4_bin', 'utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci'],
  utf8: ['utf8_general_ci', 'utf8_bin', 'utf8_unicode_ci'],
  gbk: ['gbk_chinese_ci', 'gbk_bin'],
  binary: ['binary'],
  latin1: ['latin1_swedish_ci', 'latin1_bin'],
  gb18030: ['gb18030_chinese_ci', 'gb18030_bin']
}
const charsets = Object.keys(CHARSET_COLLATIONS)

const clusters = ref<CloudCluster[]>([])
const clusterLabel = computed(() => clusters.value.find((c) => c.id === form.clusterId)?.name || '请选择集群')

/** OCP 元数据集群（metadb_cluster），在里面建业务租户几乎一定是误操作 */
function isMetaCluster(name: string): boolean {
  return /metadb|meta_cluster|ocp.?meta/i.test(name)
}

const loadingCluster = ref(false)
const zoneNames = ref<string[]>([])
const unitSpecs = ref<{ name: string; cpu: number; memory: number; type: string }[]>([])

const form = reactive({
  // 集群在 onMounted 里确定：优先用调用方传入的，其次当前打开的集群，最后取第一个运行中的
  clusterId: (props.clusterId ?? cloud.clusterId ?? 0) as number,
  name: '',
  mode: 'MYSQL' as 'MYSQL' | 'ORACLE',
  charset: 'utf8mb4',
  collation: 'utf8mb4_general_ci',
  description: '',
  primaryZone: 'RANDOM',
  zonePriority: '',
  rootPassword: '',
  whitelist: '%',
  zones: [] as ZoneRow[]
})

const collations = computed(() => CHARSET_COLLATIONS[form.charset] || [form.charset + '_general_ci'])
const defaultPriority = computed(() => form.zones.map((z) => z.name).join(';'))

const quota = computed(() => {
  const spec = new Map(unitSpecs.value.map((u) => [u.name, u]))
  let cpu = 0
  let mem = 0
  let units = 0
  for (const z of form.zones) {
    const s = spec.get(z.unitSpecName)
    const n = Math.max(0, Number(z.unitCount) || 0)
    cpu += (s?.cpu || 0) * n
    mem += (s?.memory || 0) * n
    units += n
  }
  return {
    副本: `${form.zones.length} 个`,
    Unit: `${units} 个`,
    CPU: `${cpu} 核`,
    内存: fmtBytes(mem)
  }
})

const pwdWeak = computed(() => {
  const p = form.rootPassword
  if (!p) return ''
  if (p.length < 8) return '密码少于 8 位，OCP 会拒绝'
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p)) return '强度偏弱：建议同时包含大小写字母与数字'
  return ''
})

function zoneOf(name: string): ZoneRow | undefined {
  return form.zones.find((z) => z.name === name)
}

async function loadCluster(id: number): Promise<void> {
  if (!id) return
  loadingCluster.value = true
  try {
    const r = await window.sqlpilot.cloudCluster(cloud.activeId, id)
    if (!r.ok || !r.data) {
      zoneNames.value = []
      unitSpecs.value = []
      return
    }
    zoneNames.value = (r.data.zones || []).map((z) => z.name)
    const list = r.data.unitSpecs || []
    const normal = list.filter((u) => u.type !== 'SYSTEM')
    unitSpecs.value = normal.length ? normal : list
    // 默认勾选全部 Zone（OCP 向导默认全选，三副本集群即 3F）
    form.zones = zoneNames.value.map((n) => ({
      name: n,
      replicaType: 'FULL',
      unitSpecName: unitSpecs.value[0]?.name || 'S1',
      unitCount: 1
    }))
    if (form.primaryZone !== 'RANDOM' && !zoneNames.value.includes(form.primaryZone)) form.primaryZone = 'RANDOM'
  } finally {
    loadingCluster.value = false
  }
}

function onClusterChange(): void {
  form.zonePriority = ''
  void loadCluster(form.clusterId)
}

function onCharsetChange(): void {
  form.collation = collations.value[0]
}

function toggleZone(name: string): void {
  const i = form.zones.findIndex((z) => z.name === name)
  if (i >= 0) form.zones.splice(i, 1)
  else {
    form.zones.push({
      name,
      replicaType: 'FULL',
      unitSpecName: (form.zones[0]?.unitSpecName) || unitSpecs.value[0]?.name || 'S1',
      unitCount: form.zones[0]?.unitCount || 1
    })
    // 保持与集群 Zone 顺序一致，便于对照
    form.zones.sort((a, b) => zoneNames.value.indexOf(a.name) - zoneNames.value.indexOf(b.name))
  }
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

const nameOk = computed(() => /^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(form.name.trim()))
const canSubmit = computed(() => nameOk.value && !!form.rootPassword && form.zones.length > 0 && !!form.clusterId)

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err'>('ok')

async function submit(): Promise<void> {
  if (!nameOk.value) { msgKind.value = 'err'; msg.value = '租户名需字母开头、字母/数字/下划线结尾，2~64 位'; return }
  busy.value = true
  msg.value = ''
  try {
    const r = await createTenant({
      name: form.name.trim(),
      mode: form.mode,
      charset: form.charset,
      collation: form.collation,
      description: form.description.trim() || undefined,
      rootPassword: form.rootPassword,
      whitelist: form.whitelist.trim() || '%',
      primaryZone: form.zonePriority.trim() || form.primaryZone,
      zones: form.zones.map((z) => ({
        name: z.name,
        replicaType: z.replicaType,
        unitSpecName: z.unitSpecName,
        unitCount: Math.max(1, Number(z.unitCount) || 1)
      }))
    }, form.clusterId)
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '创建失败'
      return
    }
    pushNotice(r.taskId ? `创建租户任务已提交：任务 #${r.taskId}` : '创建租户任务已提交')
    emit('close')
  } catch (e: any) {
    msgKind.value = 'err'
    msg.value = e?.message || '创建失败'
  } finally {
    busy.value = false
  }
}

function close(): void { emit('close') }

onMounted(async () => {
  // 租户页只在 cloud.tenants 里存数据，cloud.clusters 可能是空的，这里自己取一次
  if (cloud.clusters.length) clusters.value = cloud.clusters
  else {
    const r = await window.sqlpilot.cloudClusters(cloud.activeId)
    if (r.ok && r.data) clusters.value = r.data
  }
  if (!form.clusterId) {
    // 不预选元数据集群：优先挑第一个非 metadb 的运行中集群，没有就留空让用户选
    const pool = clusters.value.filter((c) => c.status === 'RUNNING')
    const pick = pool.find((c) => !isMetaCluster(c.name)) || pool[0]
    form.clusterId = pick?.id || 0
  }
  if (form.clusterId) await loadCluster(form.clusterId)
})
</script>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 300; background: rgba(5, 7, 12, 0.55); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); padding: 22px; }
.panel { width: 760px; max-width: 100%; max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-lg); }
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph b { font-size: 14.5px; display: block; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.body { overflow-y: auto; padding: 12px 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.sec { font-size: 11px; font-weight: 600; color: var(--accent); letter-spacing: 0.4px; padding-top: 4px; border-top: 1px dashed var(--border); }
.sec:first-child { border-top: none; padding-top: 0; }
.row { display: flex; gap: 10px; }
.row.two > .frow { flex: 1; }
.row.three > .frow { flex: 1; }
.frow { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
label { font-size: 11px; color: var(--text-dim); }
label i { color: var(--red); font-style: normal; }
input:not([type='checkbox']), select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
  font-family: inherit; font-size: 12.5px; padding: 7px 10px; outline: none; width: 100%;
}
input:focus, select:focus { border-color: var(--accent); }
input::placeholder { color: var(--text-faint); }
.zones { display: flex; flex-wrap: wrap; gap: 6px; }
.zchk { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text-dim); border: 1px solid var(--border); background: var(--bg-input); border-radius: 7px; padding: 4px 9px; cursor: pointer; }
.zchk input { accent-color: var(--accent); }
.zchk:has(input:checked) { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.ztable { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--bg-input); }
.zrow { display: grid; grid-template-columns: 110px 1fr 1.3fr 76px 28px; gap: 7px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border); }
.zrow:last-of-type { border-bottom: none; }
.zrow.head { font-size: 10.5px; color: var(--text-faint); background: var(--bg-card); }
.zname { font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; }
.zsel, .znum { padding: 3px 7px !important; font-size: 11.5px !important; }
.znum { text-align: center; }
.zdel { width: 22px; height: 22px; border-radius: 5px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim); cursor: pointer; font-size: 10px; }
.zdel:hover { color: var(--red); border-color: var(--red); }
.zsum { display: flex; gap: 6px; flex-wrap: wrap; padding: 6px 8px; border-top: 1px solid var(--border); background: var(--bg-card); }
.pwd { display: flex; gap: 6px; }
.pwd input { flex: 1; }
.gen { border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 8px; padding: 0 10px; font-size: 11.5px; font-family: inherit; cursor: pointer; white-space: nowrap; }
.gen:hover { color: var(--accent); border-color: var(--accent); }
.dim { color: var(--text-faint); font-size: 11.5px; }
.fnote { display: flex; gap: 7px; font-size: 11px; line-height: 1.7; color: var(--text-faint); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.fnote .i { width: 14px; height: 14px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 2px; }
.fnote .warn { color: var(--yellow); }
.msg { font-size: 11.5px; line-height: 1.55; padding: 7px 10px; border-radius: 8px; word-break: break-word; }
.msg.ok { color: var(--green); background: var(--green-dim); border: 1px solid color-mix(in srgb, var(--green) 35%, transparent); }
.msg.err { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.btn { border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim); border-radius: 8px; padding: 6px 14px; font-size: 12px; font-family: inherit; cursor: pointer; }
.btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tp-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
</style>
