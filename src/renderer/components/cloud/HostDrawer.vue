<template>
  <div class="drawer-mask" @click.self="closeHost">
    <aside class="drawer">
      <header class="dw-head">
        <div class="dw-id">
          <div class="dw-title">
            <span class="dot" :class="hostStatus(h.status).tone"></span>
            <b class="mono">{{ h.ip }}</b>
            <span class="pill" :class="hostStatus(h.status).tone">{{ hostStatus(h.status).label }}</span>
            <span v-if="isDirect && h.withRootserver" class="pill info">RootServer</span>
            <span v-else-if="!isDirect" class="pill" :class="h.agentStatus === 'AVAILABLE' ? 'ok' : 'warn'">Agent {{ agentStatus(h.agentStatus).label }}</span>
          </div>
          <div class="dw-sub" :class="{ mono: !isDirect }">
            <template v-if="isDirect">
              OBServer {{ h.svrPort || '—' }}<span class="sep">·</span>{{ h.zone || '—' }}<span class="sep">·</span>OB v{{ shortV(h.buildVersion) }}
            </template>
            <template v-else>{{ h.os || '—' }}</template>
          </div>
        </div>
        <button class="x" @click="closeHost">✕</button>
      </header>

      <!-- 动作条：复制有就地反馈（toast 会被抽屉遮住，看不见） -->
      <div class="dw-actions">
        <button class="act" :class="{ done: copied }" @click="copyIp">{{ copied ? '已复制 ✓' : '复制 IP' }}</button>
        <!-- 直连没有 OCP 的资源监控页，跳过去只会打开一个空页面 -->
        <button v-if="!isDirect" class="act" @click="goMonitor">看该主机监控</button>
        <button class="act" :disabled="!h.clusters.length" @click="goCluster">{{ isDirect ? '所属集群' : '所属集群' }}</button>
        <span class="sp"></span>
        <button class="act primary" :disabled="!platformId" @click="openTerminal">打开 SSH 终端</button>
      </div>

      <div class="dw-body">
        <!-- ================= 直连模式：只用 OB 系统视图里真有的字段 ================= -->
        <template v-if="isDirect">
          <h4>节点信息</h4>
          <div class="kv-grid">
            <div class="kv"><span>节点 IP</span><b class="mono">{{ h.ip }}</b></div>
            <div class="kv"><span>SQL 端口</span><b class="mono">{{ h.svrPort || '—' }}</b></div>
            <div class="kv"><span>Zone</span><b class="mono">{{ h.zone || '—' }}</b></div>
            <div class="kv"><span>进程状态</span><b :class="h.status === 'ONLINE' ? 'ok-t' : 'warn-t'">{{ h.status === 'ONLINE' ? 'ACTIVE' : 'INACTIVE' }}</b></div>
            <div class="kv"><span>RootServer</span><b>{{ h.withRootserver ? '是' : '否' }}</b></div>
            <div class="kv"><span>版本</span><b class="mono">{{ shortV(h.buildVersion) || '—' }}</b></div>
            <div class="kv wide"><span>启动时间</span><b class="mono" :title="h.startServiceTime">{{ h.startServiceTime || '—' }}</b></div>
          </div>
          <div class="lbl-note">以上取自 DBA_OB_SERVERS；直连模式没有 OCP Agent，因此不展示 Agent / 机型 / 操作系统等 OCP 侧字段。</div>

          <h4>资源与容量</h4>
          <div class="cap-grid">
            <div class="cap">
              <div class="cap-t"><span>CPU 分配</span><b class="mono">{{ h.cpu ? `${h.cpu.used}/${h.cpu.total}` : '—' }}</b></div>
              <div class="meter"><i :style="{ width: (h.cpu?.pct || 0) + '%' }" :class="toneOf(h.cpu?.pct)"></i></div>
            </div>
            <div class="cap">
              <div class="cap-t"><span>内存分配</span><b class="mono">{{ h.memory ? `${fmtBytes(h.memory.used)}/${fmtBytes(h.memory.total)}` : '—' }}</b></div>
              <div class="meter"><i :style="{ width: (h.memory?.pct || 0) + '%' }" :class="toneOf(h.memory?.pct)"></i></div>
            </div>
            <div class="cap">
              <div class="cap-t"><span>数据盘</span><b class="mono">{{ h.dataDisk ? `${fmtBytes(h.dataDisk.used)}/${fmtBytes(h.dataDisk.total)}` : '—' }}</b></div>
              <div class="meter"><i :style="{ width: (h.dataDisk?.pct || 0) + '%' }" :class="toneOf(h.dataDisk?.pct)"></i></div>
            </div>
            <div class="cap">
              <div class="cap-t"><span>日志盘</span><b class="mono">{{ h.logDisk ? `${fmtBytes(h.logDisk.used)}/${fmtBytes(h.logDisk.total)}` : '—' }}</b></div>
              <div class="meter"><i :style="{ width: (h.logDisk?.pct || 0) + '%' }" :class="toneOf(h.logDisk?.pct)"></i></div>
            </div>
          </div>
          <div class="kv-grid tight">
            <div class="kv"><span>磁盘健康</span><b :class="h.diskHealth && h.diskHealth !== 'NORMAL' ? 'warn-t' : 'ok-t'">{{ h.diskHealth || '—' }}</b></div>
            <div class="kv"><span>所属集群</span><b>{{ h.clusters[0] || '—' }}</b></div>
          </div>
        </template>

        <!-- ================= OCP 模式：沿用原有字段 ================= -->
        <template v-else>
          <h4>基本信息</h4>
          <div class="kv-grid">
            <div class="kv"><span>主机名</span><b class="mono">{{ h.name }}</b></div>
            <div class="kv"><span>别名</span><b>{{ h.alias || '—' }}</b></div>
            <div class="kv"><span>IP</span><b class="mono">{{ h.ip }}</b></div>
            <div class="kv"><span>SSH 端口</span><b class="mono">{{ h.sshPort || '—' }}</b></div>
            <div class="kv"><span>机型</span><b>{{ h.typeName || hostKind(h.kind) }}</b></div>
            <div class="kv"><span>区域 / IDC</span><b>{{ h.region || '—' }} / {{ h.idc || '—' }}</b></div>
            <div class="kv wide"><span>操作系统</span><b class="mono ellipsis" :title="h.os">{{ h.os || '—' }}</b></div>
            <div class="kv"><span>纳管时间</span><b>{{ fmtTime(h.createTime) }}</b></div>
          </div>

          <h4>OCP-Agent</h4>
          <div class="kv-grid">
            <div class="kv"><span>状态</span><b :class="h.agentStatus === 'AVAILABLE' ? 'ok-t' : 'warn-t'">{{ agentStatus(h.agentStatus).label }}</b></div>
            <div class="kv"><span>版本</span><b class="mono">{{ h.agentVersion || '—' }}</b></div>
          </div>
          <div v-if="h.agentStatus !== 'AVAILABLE'" class="hint-warn">
            Agent 心跳异常。OBServer 的启停、参数下发都依赖 Agent，此时对该主机的运维动作会失败。
          </div>
        </template>

        <!-- 系统信息：直连专有（OS 只能从主机取），OCP 模式本就有 os 字段 -->
        <template v-if="isDirect">
        <h4>
          系统信息
          <span v-if="sysInfo" class="count">{{ sysInfo.osPretty || sysInfo.osName }}</span>
          <button class="act tiny" :disabled="sysBusy || !sshStatus" :title="sshStatus ? '通过 SSH 采集 OS / CPU / 内存 / 磁盘' : '先录入 SSH 凭据才能采集'" @click="collectSys">
            {{ sysBusy ? '采集中…' : sysInfo ? '重新采集' : '采集' }}
          </button>
        </h4>
        <template v-if="sysInfo">
          <div class="kv-grid">
            <div class="kv"><span>操作系统</span><b :title="sysInfo.osPretty">{{ sysInfo.osPretty || sysInfo.osName || '—' }}</b></div>
            <div class="kv"><span>内核</span><b class="mono">{{ sysInfo.kernel || '—' }}</b></div>
            <div class="kv"><span>CPU 型号</span><b :title="sysInfo.cpuModel">{{ sysInfo.cpuModel || '—' }}</b></div>
            <div class="kv"><span>逻辑核数</span><b class="mono">{{ sysInfo.cores || '—' }}</b></div>
            <div class="kv"><span>物理内存</span><b class="mono">{{ sysInfo.memBytes ? fmtBytes(sysInfo.memBytes) : '—' }}</b></div>
            <div class="kv"><span>主机名</span><b class="mono">{{ sysInfo.hostname || '—' }}</b></div>
            <div class="kv wide"><span>运行时长</span><b>{{ sysInfo.uptime || '—' }}</b></div>
          </div>
          <div v-if="sysInfo.disks.length" class="disks">
            <div v-for="d in sysInfo.disks" :key="d.mount" class="disk">
              <span class="disk-m mono">{{ d.mount }}</span>
              <span class="disk-t mono">{{ fmtBytes(d.used) }} / {{ fmtBytes(d.size) }}</span>
              <div class="meter"><i :style="{ width: d.pct + '%' }" :class="d.pct >= 90 ? 'bad' : d.pct >= 80 ? 'warn' : ''"></i></div>
              <span class="disk-p mono">{{ d.pct }}%</span>
            </div>
          </div>
        </template>
        <div v-else class="lbl-note">
          {{ sshStatus
            ? '尚未采集。直连模式读的是 OB 系统视图，不含操作系统信息——点「采集」经 SSH 读取一次（OS / 内核 / CPU / 内存 / 磁盘）。'
            : '未录入 SSH 凭据，无法采集操作系统信息（直连模式下 OS 信息只能从主机本身取）。' }}
        </div>
        <div v-if="sysMsg" class="msg" :class="sysOk ? 'ok' : 'err'">{{ sysMsg }}</div>
        </template>

        <h4>承载服务 <span class="count">{{ h.services.length }}</span></h4>
        <div v-if="h.services.length" class="svc-list">
          <div v-for="s in h.services" :key="`${s.type}-${s.name}`" class="svc">
            <span class="svc-type" :class="s.type === 'OB_CLUSTER' ? 'ob' : 'proxy'">{{ serviceLabel(s.type) }}</span>
            <span class="svc-name mono">{{ s.name }}</span>
            <span class="svc-ver mono">{{ s.version }}</span>
          </div>
        </div>
        <div v-else class="empty">该主机上没有 OBServer / OBProxy 实例</div>

        <h4>关联集群</h4>
        <div class="chips">
          <span v-for="c in h.clusters" :key="c" class="chip link" @click="openClusterByName(c)">{{ c }} →</span>
          <span v-for="p in h.obproxies" :key="p" class="chip proxy">{{ p }}</span>
          <span v-if="!h.clusters.length && !h.obproxies.length" class="dim">无</span>
        </div>

        <!-- ================= 主机凭据（SSH） ================= -->
        <h4 class="ssh-h">
          SSH 凭据
          <span v-if="sshStatus" class="chip ok-lite">已录入 {{ sshStatus.user }}@{{ sshStatus.port }}</span>
          <span v-else class="chip warn-lite">未录入</span>
        </h4>
        <div class="ssh-box">
          <div class="ssh-grid">
            <label>用户名</label>
            <input v-model="form.user" class="tp-input mono" placeholder="root" spellcheck="false" />
            <label>端口</label>
            <input v-model.number="form.port" class="tp-input mono" type="number" placeholder="22" />
            <label>认证方式</label>
            <div class="seg">
              <button :class="{ on: form.auth === 'password' }" @click="form.auth = 'password'">密码</button>
              <button :class="{ on: form.auth === 'key' }" @click="form.auth = 'key'">私钥</button>
            </div>
            <template v-if="form.auth === 'password'">
              <label>密码</label>
              <input
                v-model="form.password"
                class="tp-input"
                type="password"
                :placeholder="sshStatus?.hasPassword ? '已保存，留空则不修改' : '登录密码'"
              />
            </template>
            <template v-else>
              <label>私钥文件</label>
              <div class="row">
                <input v-model="form.keyPath" class="tp-input mono" placeholder="私钥绝对路径" spellcheck="false" />
                <button class="act" @click="pickKey">选择…</button>
              </div>
              <label>私钥口令</label>
              <input v-model="form.keyPassphrase" class="tp-input" type="password" placeholder="没有口令可留空" />
            </template>
          </div>
          <div v-if="sshMsg" class="msg" :class="sshOk ? 'ok' : 'err'">{{ sshMsg }}</div>
          <div class="ssh-acts">
            <span class="lbl-note">保存前会先试连一次；密码经 DPAPI 加密存本机，不上传。</span>
            <button class="act danger" v-if="sshStatus" @click="clearCred">清除凭据</button>
            <button class="act" :disabled="sshBusy" @click="saveCred">{{ sshBusy ? '保存中…' : '保存' }}</button>
            <button class="act primary" :disabled="sshBusy" @click="saveAndOpen">保存并连接</button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
/**
 * 主机详情抽屉。
 *
 * 直连与 OCP 是两套完全不同的数据来源，这里按 `isDirect` 分支渲染：
 *   直连 —— 只有 DBA_OB_SERVERS / GV$OB_SERVERS 里真实存在的字段（Zone、端口、RootServer、容量、磁盘健康），
 *           不出现 Agent / 机型 / 操作系统这些 OCP 概念；
 *   OCP  —— 保持原有字段。
 * 主机 SSH 凭据也在这里录入（与列表里的「终端」按钮共用同一份存储）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { activePlatform, cloud, closeHost, openCluster, setView, setMonitorEntity, setMonitorScope } from '../../cloud/state'
import { platformOfCluster } from '../../cloud/directTenant'
import { forgetHostSsh, loadHostSshMap, openHostSsh, saveHostSsh, type HostSshStatus } from '../../cloud/hostSsh'
import { agentStatus, fmtBytes, fmtTime, hostKind, hostStatus, serviceLabel } from '../../cloud/parts'
import { pushNotice } from '../../store'

const h = computed(() => cloud.host as CloudHost)
const isDirect = computed(() => cloud.access === 'direct' || activePlatform()?.type === 'obdirect')

/** 主机所属的直连平台：优先按集群名反查，退回到当前激活平台 */
const platformId = computed(() => {
  const cname = h.value.clusters[0]
  const c = cloud.clusters.find((x) => x.name === cname)
  const pid = c ? platformOfCluster(c.id) : ''
  return pid || (activePlatform()?.type === 'obdirect' ? activePlatform()!.id : '')
})

const copied = ref(false)
async function copyIp(): Promise<void> {
  try {
    await window.sqlpilot.writeClipboard(h.value.ip)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1600)
    pushNotice(`已复制 ${h.value.ip}`)
  } catch {
    pushNotice('复制失败：剪贴板不可用')
  }
}

/** 5.7.25-OceanBase-v4.3.5.2 / 4.3.5.2_2025... → 4.3.5.2 */
function shortV(v?: string): string {
  const s = String(v || '')
  const m = /OceanBase[^\d]*(\d[\d.]*)/i.exec(s)
  if (m) return m[1].replace(/\.$/, '')
  const m2 = /^([\d.]+)_/.exec(s)
  return m2 ? m2[1] : s
}
function toneOf(pct?: number): string {
  const p = Number(pct || 0)
  return p >= 90 ? 'bad' : p >= 80 ? 'warn' : ''
}

async function goMonitor(): Promise<void> {
  const id = h.value.id
  closeHost()
  void setView('monitor')
  await setMonitorScope('HOST')
  await setMonitorEntity(`h${id}`)
}

/**
 * 打开所属集群。
 * 主机页不会加载集群列表，所以这里按需补拉一次——否则 `cloud.clusters` 为空，
 * 点了"所属集群"毫无反应（这正是之前的表现）。
 */
async function openClusterByName(name: string): Promise<void> {
  let hit = cloud.clusters.find((c) => c.name === name)
  if (!hit && platformId.value) {
    const r = await window.sqlpilot.cloudClusters(platformId.value)
    if (r.ok && r.data) {
      hit = r.data.find((c) => c.name === name)
      if (hit) {
        // 补登记归属关系：openCluster 靠 directOf 决定用哪套连接取详情
        cloud.directOf = { ...cloud.directOf, ...Object.fromEntries(r.data.map((c) => [c.id, platformId.value])) }
        cloud.clusters = r.data
      }
    }
  }
  if (!hit) {
    pushNotice(`集群「${name}」未在当前接入里找到`)
    return
  }
  closeHost()
  cloud.view = 'clusters'
  void openCluster(hit.id)
}

function goCluster(): void {
  const name = h.value.clusters[0]
  if (name) void openClusterByName(name)
}

// ---------------- 系统信息（SSH 采集） ----------------
const sysBusy = ref(false)
const sysMsg = ref('')
const sysOk = ref(true)
const sysInfo = computed(() => cloud.hostSys[h.value.ip] || null)

async function collectSys(): Promise<void> {
  if (!platformId.value) return
  sysBusy.value = true
  sysMsg.value = ''
  try {
    const r = await window.sqlpilot.cloudHostSysInfo(platformId.value, h.value.ip)
    if (!r.ok || !r.data) {
      sysOk.value = false
      sysMsg.value = r.error || '采集失败'
      return
    }
    cloud.hostSys = { ...cloud.hostSys, [h.value.ip]: r.data }
    sysOk.value = true
    sysMsg.value = '已采集（缓存到本机，可在列表中直接查看）'
  } finally {
    sysBusy.value = false
  }
}

// ---------------- SSH 凭据 ----------------
const sshStatus = ref<HostSshStatus | null>(null)
const sshBusy = ref(false)
const sshMsg = ref('')
const sshOk = ref(true)
const form = reactive({
  user: 'root',
  port: 22,
  auth: 'password' as 'password' | 'key',
  password: '',
  keyPath: '',
  keyPassphrase: ''
})

async function loadCred(): Promise<void> {
  if (!platformId.value) return
  const map = await loadHostSshMap(platformId.value)
  const hit = map[h.value.ip] || null
  sshStatus.value = hit
  if (hit) {
    form.user = hit.user
    form.port = hit.port
    form.auth = hit.auth
    form.keyPath = hit.keyPath
  }
}

async function pickKey(): Promise<void> {
  const r = await window.sqlpilot.sftpPick('files')
  const p = (r as any)?.path || (r as any)?.paths?.[0]
  if (p) form.keyPath = String(p)
}

async function saveCred(): Promise<void> {
  if (!platformId.value) return
  sshBusy.value = true
  sshMsg.value = ''
  try {
    const r = await saveHostSsh(platformId.value, h.value.ip, h.value.clusters[0] || '', {
      user: form.user,
      port: form.port,
      auth: form.auth,
      password: form.password || undefined,
      keyPath: form.keyPath,
      keyPassphrase: form.keyPassphrase || undefined
    })
    sshOk.value = r.ok
    sshMsg.value = r.ok ? '凭据已保存（已通过试连）' : r.error || '保存失败'
    if (r.ok) {
      form.password = ''
      form.keyPassphrase = ''
      await loadCred()
    }
  } finally {
    sshBusy.value = false
  }
}

async function saveAndOpen(): Promise<void> {
  await saveCred()
  if (sshOk.value && sshStatus.value) openTerminal()
}

async function clearCred(): Promise<void> {
  if (!platformId.value) return
  const ok = await window.sqlpilot.uiConfirm(`清除 ${h.value.ip} 的 SSH 凭据？`, '仅删除本机保存的账号口令。', false)
  if (!ok) return
  await forgetHostSsh(platformId.value, h.value.ip)
  sshStatus.value = null
  form.password = ''
  sshMsg.value = '已清除'
  sshOk.value = true
}

function openTerminal(): void {
  if (!platformId.value) return
  openHostSsh(platformId.value, h.value.ip, h.value.clusters[0] || '', form.port || 22)
  closeHost()
}

onMounted(async () => {
  await loadCred()
  // 有凭据且还没采过：自动抓一次系统信息，省得用户再点一步
  if (isDirect.value && sshStatus.value && !cloud.hostSys[h.value.ip]) void collectSys()
})
</script>

<style scoped>
.drawer-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 800;
  display: flex; justify-content: flex-end; backdrop-filter: blur(1px);
  padding-top: var(--titlebar-h);
}
.drawer {
  width: 600px; max-width: 94vw; height: 100%; background: var(--bg-side);
  border-left: 1px solid var(--border-strong); display: flex; flex-direction: column;
  box-shadow: var(--shadow-lg);
}
.dw-head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid var(--border); }
.dw-id { flex: 1; min-width: 0; }
.dw-title { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dw-title b { font-size: 15px; font-weight: 650; }
.dw-sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
.sep { margin: 0 6px; color: var(--text-faint); }
.x { border: none; background: none; color: var(--text-faint); font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.x:hover { color: var(--text); background: var(--bg-input); }

.dw-actions { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--border); }
.act {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer; white-space: nowrap;
}
.act:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.act:disabled { opacity: 0.45; cursor: not-allowed; }
.act.primary { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.act.done { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); background: var(--green-dim); }
.act.danger:hover { color: var(--red); border-color: var(--red); }
.act.tiny { margin-left: auto; padding: 1px 7px; font-size: 10px; }
.sp { flex: 1; }

.dw-body { flex: 1; overflow: auto; padding: 12px 16px 20px; display: flex; flex-direction: column; gap: 8px; }
.dw-body h4 { font-size: 12px; font-weight: 600; margin: 6px 0 2px; display: flex; align-items: center; gap: 6px; }
.dw-body h4.ssh-h { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); }
.count { font-family: var(--mono); font-size: 10px; color: var(--text-dim); background: var(--bg-input); border: 1px solid var(--border); border-radius: 99px; padding: 0 6px; }
.kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.kv-grid.tight { margin-top: 4px; }
.kv {
  display: flex; flex-direction: column; gap: 1px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; min-width: 0;
}
.kv.wide { grid-column: 1 / -1; }
.kv span { font-size: 10px; color: var(--text-faint); }
.kv b { font-size: 11.5px; font-weight: 550; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kv b.ok-t { color: var(--green); }
.kv b.warn-t { color: var(--yellow); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lbl-note { font-size: 10.5px; color: var(--text-faint); line-height: 1.55; }

/* 容量条：直连主机只有分配量，用细条表达水位 */
.cap-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cap { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; display: flex; flex-direction: column; gap: 5px; }
.cap-t { display: flex; align-items: baseline; gap: 8px; }
.cap-t span { font-size: 10px; color: var(--text-faint); }
.cap-t b { font-size: 11px; margin-left: auto; }
.meter { height: 4px; border-radius: 99px; background: var(--bg-input); overflow: hidden; }
.meter > i { display: block; height: 100%; background: var(--accent); }
.meter > i.warn { background: var(--yellow); }
.meter > i.bad { background: var(--red); }
/* 磁盘列表：挂载点 / 用量 / 水位 */
.disks { display: flex; flex-direction: column; gap: 4px; }
.disk { display: grid; grid-template-columns: 120px 130px 1fr 40px; gap: 8px; align-items: center; font-size: 11px; }
.disk-m { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.disk-t { color: var(--text-faint); font-size: 10.5px; }
.disk-p { text-align: right; color: var(--text-faint); font-size: 10.5px; }

.hint-warn {
  font-size: 11px; color: var(--yellow); background: var(--yellow-dim);
  border: 1px solid color-mix(in srgb, var(--yellow) 35%, transparent); border-radius: 7px; padding: 6px 9px;
}
.svc-list { display: flex; flex-direction: column; gap: 3px; }
.svc {
  display: flex; align-items: center; gap: 8px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px; font-size: 11px;
}
.svc-type { font-size: 9.5px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--border); color: var(--text-dim); }
.svc-type.ob { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-dim); }
.svc-type.proxy { color: var(--text-dim); }
.svc-name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc-ver { color: var(--text-faint); font-size: 10px; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  font-size: 10.5px; padding: 1px 8px; border-radius: 99px; background: var(--bg-input);
  border: 1px solid var(--border); color: var(--text-dim); font-family: var(--mono);
}
.chip.link { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); cursor: pointer; }
.chip.link:hover { background: var(--accent-dim); }
.chip.proxy { color: var(--text-faint); }
.chip.ok-lite { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); font-family: inherit; }
.chip.warn-lite { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); font-family: inherit; }
.empty { font-size: 11.5px; color: var(--text-faint); padding: 8px 2px; }
.dim { color: var(--text-faint); font-size: 11px; }
.pill { display: inline-block; font-size: 10.5px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); background: var(--green-dim); }
.pill.warn { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); background: var(--yellow-dim); }
.pill.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); background: var(--red-dim); }
.pill.info { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-dim); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.dot.ok { background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.dot.warn { background: var(--yellow); box-shadow: 0 0 0 3px var(--yellow-dim); }
.dot.bad { background: var(--red); box-shadow: 0 0 0 3px var(--red-dim); }
.mono { font-family: var(--mono); }

/* SSH 凭据表单 */
.ssh-box { border: 1px solid var(--border); border-radius: 9px; background: var(--bg-card); padding: 9px 11px; display: flex; flex-direction: column; gap: 8px; }
.ssh-grid { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 7px 10px; align-items: center; }
.ssh-grid > label { font-size: 10.5px; color: var(--text-faint); }
.ssh-grid .row { display: flex; gap: 6px; align-items: center; }
.ssh-grid .row .tp-input { flex: 1; min-width: 0; }
.seg { display: flex; gap: 4px; }
.seg button {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3px 11px; font-size: 11px; font-family: inherit; cursor: pointer;
}
.seg button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
.ssh-acts { display: flex; align-items: center; gap: 8px; }
.ssh-acts .lbl-note { margin-right: auto; }
.msg { font-size: 11px; border-radius: 7px; padding: 5px 9px; }
.msg.ok { color: var(--green); background: var(--green-dim); }
.msg.err { color: var(--red); background: var(--red-dim); }
:deep(.tp-input) {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  font-family: inherit; font-size: 11.5px; padding: 4px 8px; outline: none; width: 100%;
}
:deep(.tp-input:focus) { border-color: var(--accent); }
</style>
