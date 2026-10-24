<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header class="ph">
        <div>
          <b>创建集群</b>
          <span class="sub">{{ platformName }} · 主集群（PRIMARY）</span>
        </div>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="steps">
        <span v-for="(s, i) in stepNames" :key="s" class="step" :class="{ active: step === i, done: step > i }">
          <i>{{ i + 1 }}</i>{{ s }}
        </span>
      </div>

      <div class="body">
        <!-- 1 基本信息 -->
        <template v-if="step === 0">
          <div class="frow">
            <label>集群名 <i>*</i></label>
            <input v-model="form.name" placeholder="字母数字下划线，如 ob_prod" spellcheck="false" />
          </div>
          <div class="frow">
            <label>OceanBase 软件包 <i>*</i></label>
            <select v-if="pkgs.length" :value="pkgIdx" @change="pickPkg(Number(($event.target as HTMLSelectElement).value))">
              <option value="-1" disabled>选择 OCP 已上传的 OB 安装包…</option>
              <option v-for="(p, i) in pkgs" :key="p.name" :value="i">{{ p.version }} · {{ p.name }}</option>
            </select>
            <template v-else>
              <input v-model="form.rpmName" placeholder="OCP「系统管理 → 软件包」里显示的包文件名" spellcheck="false" />
              <div class="row two">
                <div class="frow"><label>OB 版本（fullVersion）<i>*</i></label><input v-model="form.fullVersion" placeholder="如 4.3.5.2-20250401123456" spellcheck="false" /></div>
              </div>
            </template>
            <span class="fhint">{{ pkgs.length ? '版本与包文件名取自 OCP 软件包列表，预检查会先校验主机环境。' : '未能取到 OCP 软件包列表（可用「重新检查」按钮刷新），请手工填写包文件名与版本。' }}</span>
          </div>
          <div class="row two">
            <div class="frow">
              <label>主机 admin 密码 <i>*</i></label>
              <input v-model="form.password" type="password" placeholder="OCP 纳管主机的操作系统用户密码" />
            </div>
            <div class="frow">
              <label>OB sys 租户密码 <i>*</i></label>
              <input v-model="form.rootSysPassword" type="password" placeholder="集群 root@sys 的初始密码" />
            </div>
          </div>
          <div class="row three">
            <div class="frow"><label>安装目录</label><input v-model="form.installPath" spellcheck="false" /></div>
            <div class="frow"><label>数据盘</label><input v-model="form.dataDiskPath" spellcheck="false" /></div>
            <div class="frow"><label>日志盘</label><input v-model="form.logDiskPath" spellcheck="false" /></div>
          </div>
          <div class="row three">
            <div class="frow"><label>SQL 端口</label><input v-model.number="form.sqlPort" type="number" /></div>
            <div class="frow"><label>RPC 端口</label><input v-model.number="form.svrPort" type="number" /></div>
            <div class="frow chkrow">
              <label>资源隔离</label>
              <label class="chk"><input v-model="form.cgroupEnabled" type="checkbox" /> 启用 cgroup</label>
            </div>
          </div>
        </template>

        <!-- 2 Zone 与主机 -->
        <template v-else-if="step === 1">
          <div class="zones">
            <div v-for="(z, zi) in form.zones" :key="zi" class="zone">
              <div class="zone-head">
                <input v-model="z.name" class="zname" placeholder="Zone 名称，如 zone1" spellcheck="false" />
                <button v-if="form.zones.length > 1" class="mini danger" @click="form.zones.splice(zi, 1)">移除</button>
              </div>
              <div class="hosts">
                <label v-for="h in freeHosts" :key="h.id" class="host" :class="{ on: z.servers.includes(h.id) }">
                  <input type="checkbox" :checked="z.servers.includes(h.id)" @change="toggleHost(z, h.id)" />
                  <span class="hip mono">{{ h.ip }}</span>
                  <span class="hmeta">{{ h.alias || h.name }} · {{ h.idc }} · {{ h.architecture }}</span>
                </label>
                <span v-if="!freeHosts.length" class="dim">没有空闲主机（未承载 OB 集群的主机才可用于新建集群）</span>
              </div>
            </div>
          </div>
          <button class="mini" @click="addZone">＋ 添加 Zone</button>
          <div class="fnote">
            <span class="i">i</span>
            OCP 会在所选主机上安装 OBServer；每台主机只能属于一个 Zone，Zone 名称与机房（idc）取自主机。
          </div>
        </template>

        <!-- 3 预检查 / 提交 -->
        <template v-else>
          <div class="precheck">
            <div class="pc-head">
              <b>预检查</b>
              <button class="tb" :disabled="busy" @click="runPreCheck">重新检查</button>
            </div>
            <div v-if="!checks.length" class="dim">点「重新检查」让 OCP 校验主机环境（JDK、指令集、磁盘、端口等）。</div>
            <div v-else class="pc-list">
              <div v-for="c in checks" :key="c.key" class="pc-item">
                <span class="pc-dot" :class="checkTone(c.status)"></span>
                <span class="pc-name">{{ c.name }}</span>
                <span class="pc-status" :class="checkTone(c.status)">{{ checkLabel(c.status) }}</span>
                <span v-if="c.message" class="pc-msg" :title="c.message">{{ c.message }}</span>
              </div>
            </div>
          </div>
          <div class="fnote">
            <span class="i">i</span>
            提交后 OCP 会创建集群并安装 OBServer（耗时较长），可到「任务」页看进度；创建完成后集群出现在列表里。
          </div>
        </template>

        <div v-if="msg" class="msg" :class="msgKind">{{ msg }}</div>
      </div>

      <footer class="pf">
        <button class="btn ghost" :disabled="busy" @click="step === 0 ? close() : step--">← {{ step === 0 ? '取消' : '上一步' }}</button>
        <span style="flex:1"></span>
        <button v-if="step < 2" class="btn primary" :disabled="!canNext" @click="next">下一步 →</button>
        <button v-else class="btn primary" :disabled="busy || !canNext" @click="submit">提交创建</button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 创建集群向导：基本信息 → Zone/主机 → 预检查/提交。
 * 请求体按 OCP「新建集群」页的 createParams 组装（type/name/fullVersion/zones[rpmName,idcName,servers(hostId)]…），
 * 预检查走 /ob/clusters/createPreCheck，提交时带上 checkId。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { pushNotice } from '../../store'
import { cloud, activePlatform, reloadMonitor } from '../../cloud/state'

const emit = defineEmits<{ (e: 'close'): void }>()

const stepNames = ['基本信息', 'Zone 与主机', '预检查']
const step = ref(0)
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err'>('ok')
const checks = ref<{ key: string; name: string; status: string; message?: string }[]>([])
const checkId = ref<string | undefined>()

const platformName = computed(() => activePlatform()?.name || 'OCP')

/** OCP 已上传的 OB 安装包（/api/v2/software-packages，仅 OB_SERVER_INSTALL_PACKAGE） */
const pkgs = ref<{ name: string; version: string; architecture: string }[]>([])
const pkgIdx = ref(-1)
const pkgArch = ref('')

onMounted(async () => {
  const r = await window.sqlpilot.cloudPackages(cloud.activeId).catch(() => null)
  if (r?.ok && r.data?.length) {
    pkgs.value = r.data
    if (r.data.length === 1) pickPkg(0)
  }
})
function pickPkg(i: number): void {
  if (i < 0 || !pkgs.value[i]) return
  pkgIdx.value = i
  const p = pkgs.value[i]
  form.fullVersion = p.version
  form.rpmName = p.name
  pkgArch.value = p.architecture || ''
}

const form = reactive({
  name: '',
  fullVersion: '',
  rpmName: '',
  password: '',
  rootSysPassword: '',
  installPath: '/home/admin/oceanbase',
  dataDiskPath: '/data/1',
  logDiskPath: '/data/log1',
  sqlPort: 2881,
  svrPort: 2882,
  cgroupEnabled: true,
  zones: [{ name: 'zone1', servers: [] as number[] }]
})

/** 空闲主机：未承载 OB 集群（hostTags 里没有 OB_CLUSTER） */
const freeHosts = computed(() => cloud.hosts.filter((h) => !h.clusters.length))

function addZone(): void {
  form.zones.push({ name: `zone${form.zones.length + 1}`, servers: [] })
}
function toggleHost(z: { servers: number[] }, id: number): void {
  const i = z.servers.indexOf(id)
  if (i >= 0) z.servers.splice(i, 1)
  else {
    // 一台主机只能属于一个 Zone
    for (const other of form.zones) {
      const j = other.servers.indexOf(id)
      if (j >= 0) other.servers.splice(j, 1)
    }
    z.servers.push(id)
  }
}

const canNext = computed(() => {
  if (step.value === 0) {
    return !!form.name.trim() && !!form.fullVersion.trim() && !!form.rpmName.trim() && !!form.password && !!form.rootSysPassword
  }
  if (step.value === 1) {
    return form.zones.length > 0 && form.zones.every((z) => z.name.trim() && z.servers.length > 0)
  }
  return true
})

function buildInput(): CloudClusterCreateInput {
  return {
    name: form.name.trim(),
    fullVersion: form.fullVersion.trim(),
    rpmName: form.rpmName.trim(),
    password: form.password,
    rootSysPassword: form.rootSysPassword,
    installPath: form.installPath,
    dataDiskPath: form.dataDiskPath,
    logDiskPath: form.logDiskPath,
    sqlPort: Number(form.sqlPort) || 2881,
    svrPort: Number(form.svrPort) || 2882,
    cgroupEnabled: form.cgroupEnabled,
    zones: form.zones.map((z) => {
      const host = cloud.hosts.find((h) => h.id === z.servers[0])
      return {
        name: z.name.trim(),
        idcName: host?.idc || '',
        servers: z.servers,
        rpmName: form.rpmName.trim(),
        architecture: pkgArch.value || (host?.os ? (host.os.includes('aarch64') ? 'aarch64' : 'x86_64') : 'x86_64')
      }
    })
  }
}

async function runPreCheck(): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudClusterPreCheck(cloud.activeId, buildInput())
    if (!r.ok || !r.data) {
      msgKind.value = 'err'
      msg.value = r.error || '预检查失败'
      return
    }
    checks.value = r.data.items
    checkId.value = r.data.checkId
  } finally {
    busy.value = false
  }
}

async function next(): Promise<void> {
  if (step.value === 1) {
    step.value = 2
    await runPreCheck()
    return
  }
  step.value++
}

async function submit(): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudClusterCreate(cloud.activeId, buildInput(), checkId.value)
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '创建失败'
      return
    }
    pushNotice(r.data?.taskId ? `创建集群任务已提交：任务 #${r.data.taskId}` : '创建集群任务已提交')
    void reloadMonitor()
    emit('close')
  } catch (e: any) {
    msgKind.value = 'err'
    msg.value = e?.message || '创建失败'
  } finally {
    busy.value = false
  }
}

function checkTone(s: string): string {
  if (/SUCCESS|PASSED|FINISHED/i.test(s)) return 'ok'
  if (/FAIL|ERROR/i.test(s)) return 'bad'
  if (/RUNNING|PENDING/i.test(s)) return 'wait'
  return 'idle'
}
function checkLabel(s: string): string {
  const m: Record<string, string> = { SUCCESSFUL: '通过', SUCCESS: '通过', PASSED: '通过', FAILED: '不通过', RUNNING: '检查中', PENDING: '等待中' }
  return m[s] || s
}

function close(): void { emit('close') }
</script>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 300; background: rgba(5, 7, 12, 0.55); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); padding: 20px; }
.panel { width: 680px; max-width: 100%; max-height: 90vh; display: flex; flex-direction: column; background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-lg); }
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph b { font-size: 14.5px; display: block; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.steps { display: flex; gap: 18px; padding: 11px 16px 0; }
.step { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-faint); }
.step i { width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 9.5px; font-style: normal; }
.step.active { color: var(--accent); }
.step.active i { border-color: var(--accent); background: var(--accent-dim); }
.step.done i { border-color: var(--green); color: var(--green); }
.body { overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.row { display: flex; gap: 10px; }
.row.two > .frow { flex: 1; }
.row.three > .frow { flex: 1; }
.frow { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
label { font-size: 11px; color: var(--text-dim); }
label i { color: var(--red); font-style: normal; }
input:not([type='checkbox']), select { background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 12.5px; padding: 7px 10px; outline: none; width: 100%; }
input:focus { border-color: var(--accent); }
input::placeholder { color: var(--text-faint); }
.chkrow { justify-content: flex-end; }
.chk { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-dim); }
.chk input { accent-color: var(--accent); }
.fhint { font-size: 10.5px; color: var(--text-faint); line-height: 1.5; }
.zones { display: flex; flex-direction: column; gap: 8px; }
.zone { border: 1px solid var(--border); border-radius: 10px; padding: 9px 10px; background: var(--bg-card); }
.zone-head { display: flex; gap: 8px; align-items: center; }
.zname { max-width: 200px; }
.hosts { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 5px; margin-top: 8px; }
.host { display: flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 7px; padding: 5px 8px; cursor: pointer; background: var(--bg-input); }
.host.on { border-color: var(--accent); background: var(--accent-dim); }
.host input { accent-color: var(--accent); }
.hip { font-size: 11.5px; }
.hmeta { font-size: 10px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mini { border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 7px; font-size: 11.5px; padding: 3px 9px; cursor: pointer; font-family: inherit; align-self: flex-start; }
.mini.danger:hover { color: var(--red); border-color: var(--red); }
.precheck { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-card); padding: 9px 11px; }
.pc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.pc-head b { font-size: 12px; }
.tb { margin-left: auto; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 7px; padding: 2px 8px; font-size: 11px; font-family: inherit; cursor: pointer; }
.pc-list { display: flex; flex-direction: column; gap: 3px; max-height: 240px; overflow-y: auto; }
.pc-item { display: flex; align-items: center; gap: 7px; font-size: 11.5px; padding: 3px 0; border-bottom: 1px dashed var(--border); }
.pc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.pc-dot.ok { background: var(--green); }
.pc-dot.bad { background: var(--red); }
.pc-dot.wait { background: var(--yellow); }
.pc-name { flex: 1; color: var(--text-dim); }
.pc-status { font-size: 10.5px; color: var(--text-faint); }
.pc-status.ok { color: var(--green); }
.pc-status.bad { color: var(--red); }
.pc-status.wait { color: var(--yellow); }
.pc-msg { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--text-faint); }
.dim { color: var(--text-faint); font-size: 11.5px; }
.mono { font-family: var(--mono); }
.fnote { display: flex; gap: 7px; font-size: 11px; line-height: 1.6; color: var(--text-faint); background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.fnote .i { width: 14px; height: 14px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 1px; }
.msg { font-size: 11.5px; line-height: 1.55; padding: 7px 10px; border-radius: 8px; word-break: break-word; }
.msg.err { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); }
.msg.ok { color: var(--green); background: var(--green-dim); }
.pf { display: flex; align-items: center; gap: 8px; padding: 11px 16px 13px; border-top: 1px solid var(--border); }
</style>
