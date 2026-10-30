<template>
  <div class="mask" @click.self="close">
    <div class="panel">
      <header class="ph">
        <div>
          <b>云管平台接入</b>
          <span class="sub">OceanBase 云平台（OCP 4.x，调 REST 接口） / Oracle（直连查 v$ 视图）</span>
        </div>
        <button class="x" @click="close">✕</button>
      </header>

      <div class="body">
        <!-- 已接入平台：直连模式可同时配多个集群，这里必须给出显式的「新增」入口，
             否则用户只会在"编辑当前平台"的表单里改地址，把旧集群悄悄覆盖掉 -->
        <div class="plist-head">
          <b>已接入平台</b>
          <span class="dim">直连模式可配多个集群，界面合并展示</span>
          <span style="flex: 1"></span>
          <button class="mini primary" @click="startNew('obdirect')">＋ 新增集群</button>
        </div>
        <div v-if="cloud.platforms.length" class="plist" data-src="cfgOcp">
          <div v-for="p in cloud.platforms" :key="p.id" class="pitem" :class="{ editing: form.id === p.id }">
            <div class="pico" :class="{ ora: p.type === 'oracle' }">{{ p.type === 'oracle' ? 'ORA' : 'OB' }}</div>
            <div class="pmain">
              <div class="pname">
                {{ p.name }}
                <span v-if="p.type === 'oracle'" class="tag">Oracle 直连</span>
                <span v-if="p.type === 'obdirect'" class="tag">OceanBase 直连 · 无 OCP</span>
                <span v-if="p.insecure" class="tag">跳过证书校验</span>
              </div>
              <div class="purl mono">{{ addrOf(p) }}</div>
              <div class="pmeta">{{ p.username }} · 密码{{ p.hasPassword ? '已保存' : '未保存' }}</div>
            </div>
            <button class="mini" @click="edit(p)">编辑</button>
            <button class="mini danger" @click="remove(p)">删除</button>
          </div>
        </div>

        <!-- 表单 -->
        <div class="form">
          <div class="form-head">
            <b>{{ form.id ? `编辑：${form.name || '未命名平台'}` : '新增平台' }}</b>
            <span class="dim">
              {{ form.id ? '保存会更新这一条；要再加一个集群请点上方「＋ 新增集群」' : '保存后新增一条，不影响已有平台' }}
            </span>
            <span style="flex: 1"></span>
            <button v-if="form.id" class="mini" @click="startNew(form.type)">切换为新增</button>
          </div>
          <div class="frow">
            <label>类型</label>
            <div class="seg">
              <button :class="{ on: form.type === 'ocp' }" @click="setType('ocp')">OceanBase（OCP）</button>
              <button :class="{ on: form.type === 'obdirect' }" @click="setType('obdirect')">OceanBase（直连）</button>
              <button :class="{ on: form.type === 'oracle' }" @click="setType('oracle')">Oracle（直连）</button>
            </div>
          </div>

          <div class="frow">
            <label>接入名称</label>
            <input v-model="form.name" :placeholder="form.type === 'oracle' ? '例如：核心业务库' : '例如：perf / 生产集群 A'" spellcheck="false" />
            <span class="fhint">
              这条接入配置的别名，会作为「接入名称」单独成列显示在集群 / 租户列表里
              ——它标识的是「从哪套连接读到的」，与集群自身的名字（DBA_OB_SERVERS 里那个）是两回事。
            </span>
          </div>

          <template v-if="form.type === 'ocp'">
            <div class="frow">
              <label>地址</label>
              <input v-model="form.baseUrl" placeholder="http://192.168.1.100:8080" spellcheck="false" />
              <span class="fhint">只填到端口，内网建议直接用 IP（主机名要能被本机 DNS 解析）；带 context path 时形如 http://主机:8080/ocp。误填成登录页地址（/login）会自动纠正。</span>
            </div>
            <div class="frow two">
              <div>
                <label>用户名</label>
                <input v-model="form.username" placeholder="admin" spellcheck="false" />
              </div>
              <div>
                <label>密码</label>
                <input v-model="password" type="password" :placeholder="form.id && form.hasPassword ? '已保存，留空则不修改' : 'OCP 登录密码'" />
              </div>
            </div>
            <label class="chk">
              <input v-model="form.insecure" type="checkbox" />
              <span>跳过 HTTPS 证书校验（仅内网自签证书时勾选；开启后该平台的登录密码与数据流量可被中间人截获）</span>
            </label>
          </template>

          <template v-else-if="form.type === 'obdirect'">
            <div class="frow three">
              <div>
                <label>主机</label>
                <input v-model="form.host" placeholder="192.168.1.100" spellcheck="false" />
              </div>
              <div>
                <label>SQL 端口</label>
                <input v-model.number="form.port" type="number" placeholder="2881" />
              </div>
              <div>
                <label>用户名</label>
                <input v-model="form.username" placeholder="root@sys" spellcheck="false" />
              </div>
            </div>
            <div class="frow two">
              <div>
                <label>密码</label>
                <input v-model="password" type="password" :placeholder="form.id && form.hasPassword ? '已保存，留空则不修改' : 'root@sys 的密码'" />
              </div>
            </div>
            <span class="fhint">
              直连模式<b>不需要 OCP</b>：直接连 OBServer 的 SQL 端口（默认 2881）读 oceanbase 库的系统视图。
              用户名必须带租户后缀（<code>root@sys</code>）；默认库为 oceanbase，无需填写。
              当前仅以 sys 租户视角采集，业务租户的内存 / 会话数据不在覆盖范围内。
              没有 OCP 代理层，因此没有运维任务编排、告警推送与 Agent 管理；集群「写操作」是直接执行 SQL，不可回滚。
            </span>
          </template>

          <template v-else>
            <div class="frow three">
              <div>
                <label>主机</label>
                <input v-model="form.host" placeholder="192.168.1.100" spellcheck="false" />
              </div>
              <div>
                <label>端口</label>
                <input v-model.number="form.port" type="number" placeholder="1521" />
              </div>
              <div>
                <label>服务名</label>
                <input v-model="form.serviceName" placeholder="trade_db" spellcheck="false" />
              </div>
            </div>
            <div class="frow two">
              <div>
                <label>用户名</label>
                <input v-model="form.username" placeholder="dba 账号（需要 SELECT_CATALOG_ROLE）" spellcheck="false" />
              </div>
              <div>
                <label>密码</label>
                <input v-model="password" type="password" :placeholder="form.id && form.hasPassword ? '已保存，留空则不修改' : '数据库密码'" />
              </div>
            </div>
            <div class="frow two">
              <div>
                <label>连接身份</label>
                <select v-model="form.role">
                  <option value="default">普通用户（DBA 账号选这个）</option>
                  <option value="sysdba">SYSDBA</option>
                  <option value="sysoper">SYSOPER</option>
                </select>
                <span class="fhint">
                  SYSDBA / SYSOPER 是<b>独立特权</b>，要在口令文件里显式授予（GRANT SYSDBA TO 用户），
                  有 DBA 角色不等于有它。看板只读 v$ / dba_ 视图，选「普通用户」即可。
                </span>
              </div>
              <div>
                <label>Instant Client 目录（11g 必填）</label>
                <input v-model="form.instantClientDir" placeholder="C://oracle//instantclient_19_20" spellcheck="false" />
              </div>
            </div>
            <span class="fhint">
              Oracle 11g 及更早版本不支持 node-oracledb 的 thin 模式，需要本机装 Instant Client 并填上面的目录（thick 模式）；
              12c 及以上可留空。看板只读 v$ / dba_ 视图，建议用只读 DBA 账号，不要用 SYS。
            </span>
          </template>

          <div class="fnote" data-src="cfgOcp">
            <span class="i">i</span>
            密码经 Windows DPAPI 加密后保存在本机（secrets.json），不写入配置文件、不下发渲染层；保存前会先真实连接一次。
          </div>

          <div v-if="msg" class="msg" :class="msgKind">{{ msg }}</div>

          <div class="actions">
            <button class="btn ghost" :disabled="busy" @click="test">测试连接</button>
            <span style="flex: 1"></span>
            <button v-if="form.id" class="btn ghost" @click="reset">取消编辑</button>
            <button class="btn primary" :disabled="busy" @click="save">保存</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * OCP 接入设置：平台清单 + 新增/编辑表单。
 * 交互要点：保存 = 先验证登录再落盘，避免存下连不上的配置；
 * 编辑时密码留空 = 沿用已存密码（不把密码回填到界面）。
 */
import { onMounted, reactive, ref } from 'vue'
import { cloud, deletePlatform, savePlatform } from '../../cloud/state'

const emit = defineEmits<{ (e: 'close'): void }>()

const form = reactive<{
  id: string
  type: 'ocp' | 'obdirect' | 'oracle'
  name: string
  baseUrl: string
  host: string
  port: number
  serviceName: string
  role: 'default' | 'sysdba' | 'sysoper'
  instantClientDir: string
  username: string
  insecure: boolean
  hasPassword: boolean
}>({
  id: '', type: 'ocp', name: '', baseUrl: '', host: '', port: 1521, serviceName: '',
  role: 'default', instantClientDir: '', username: '', insecure: false, hasPassword: false
})
const password = ref('')
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'warn'>('ok')

onMounted(() => {
  // 默认直接进「新增」：这个面板最常见的用途是再接一套集群 / 环境。
  // 之前默认预填当前平台（编辑态），改完地址保存就把已有配置覆盖了——
  // 列表里的「编辑」按钮才是进编辑态的入口，语义也更清楚。
  const active = cloud.platforms.find((p) => p.id === cloud.activeId) || cloud.platforms[0]
  const type = active?.type === 'ocp' ? 'ocp' : active?.type === 'oracle' ? 'oracle' : 'obdirect'
  startNew(type)
})

/** 编辑起始的连接目标：保存前用它判断"是不是把地址改掉了" */
let editOrigin = { host: '', port: 0, username: '' }

/**
 * 新增一条（不继承当前编辑对象的 id）。
 * 这是「多集群」的关键：id 为空 → 主进程 push 新平台；带着 id 保存只会覆盖旧的那条。
 */
function startNew(type: 'ocp' | 'obdirect' | 'oracle' = 'obdirect'): void {
  reset()
  form.type = type
  form.port = type === 'oracle' ? 1521 : type === 'obdirect' ? 2881 : 1521
  msg.value = ''
  msgKind.value = 'ok'
}

function reset(): void {
  editOrigin = { host: '', port: 0, username: '' }
  form.id = ''
  form.type = 'ocp'
  form.name = ''
  form.baseUrl = ''
  form.host = ''
  form.port = 1521
  form.serviceName = ''
  form.role = 'default'
  form.instantClientDir = ''
  form.username = ''
  form.insecure = false
  form.hasPassword = false
  password.value = ''
  msg.value = ''
}

function setType(t: 'ocp' | 'obdirect' | 'oracle'): void {
  if (form.type === t) return
  form.type = t
  // 两类直连的默认端口不同，切换时给一个合理默认，避免沿用上一个类型的端口
  if (t === 'obdirect') form.port = 2881
  if (t === 'oracle') form.port = 1521
  msg.value = ''
}

function addrOf(p: CloudPlatformView): string {
  if (p.type === 'oracle') return `${p.host}:${p.port}${p.serviceName ? '/' + p.serviceName : ''}`
  if (p.type === 'obdirect') return `${p.host}:${p.port}`
  return p.baseUrl || ''
}

/** 表单 → IPC 入参（Oracle 不带 baseUrl，OCP 不带库连接字段） */
function payload() {
  if (form.type === 'obdirect') {
    return {
      id: form.id || undefined,
      type: 'obdirect' as const,
      name: form.name,
      host: form.host,
      port: Number(form.port) || 2881,
      username: form.username
    }
  }
  if (form.type === 'oracle') {
    return {
      id: form.id || undefined,
      type: 'oracle' as const,
      name: form.name,
      host: form.host,
      port: Number(form.port) || 1521,
      serviceName: form.serviceName,
      username: form.username,
      role: form.role,
      instantClientDir: form.instantClientDir
    }
  }
  return {
    id: form.id || undefined,
    type: 'ocp' as const,
    name: form.name,
    baseUrl: form.baseUrl,
    username: form.username,
    insecure: form.insecure
  }
}

function edit(p: CloudPlatformView): void {
  editOrigin = { host: p.host || '', port: p.port || 0, username: p.username || '' }
  form.id = p.id
  form.type = p.type === 'oracle' ? 'oracle' : p.type === 'obdirect' ? 'obdirect' : 'ocp'
  form.name = p.name
  form.baseUrl = p.baseUrl || ''
  form.host = p.host || ''
  form.port = p.port || 1521
  form.serviceName = p.serviceName || ''
  form.role = (p.role as 'default' | 'sysdba' | 'sysoper') || 'default'
  form.instantClientDir = p.instantClientDir || ''
  form.username = p.username
  form.insecure = !!p.insecure
  form.hasPassword = p.hasPassword
  password.value = ''
  msg.value = ''
}

async function test(): Promise<void> {
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudTest(payload() as any, password.value || undefined)
    if (r.ok && form.type === 'oracle') {
      const mode = r.mode === 'thick' ? 'thick/Instant Client' : 'thin'
      const priv = r.privileges
        ? ` · 账号特权：${r.privileges.sysdba ? '已授 SYSDBA' : r.privileges.dba ? 'DBA 角色' : '普通账号'}`
        : ''
      if (r.downgraded) {
        // 账号没有 SYSDBA：直接把身份改回普通用户，省得用户再点一次
        form.role = 'default'
        msgKind.value = 'warn'
        msg.value = `${r.note || '该账号未被授予 SYSDBA 特权，已按普通身份连通。'}连通信息：${r.version || 'Oracle'}（${mode}）${priv}。看板只读 v$ / dba_ 视图，用普通用户即可。`
      } else {
        msgKind.value = 'ok'
        msg.value = `连接成功：${r.version || 'Oracle'}（${mode} 模式）${priv}`
      }
    } else if (r.ok && form.type === 'obdirect') {
      msgKind.value = 'ok'
      msg.value = `连接成功：OceanBase ${r.version || ''}（直连模式）${r.note ? ' · ' + r.note : ''}`
    } else if (r.ok && r.info) {
      // 地址会被归一化（去掉 /login 之类的网页路由）：回填到表单，让用户看到真正生效的地址
      if (r.baseUrl && r.baseUrl !== form.baseUrl) form.baseUrl = r.baseUrl
      msgKind.value = 'ok'
      msg.value = `连接成功：OCP ${r.info.version}（${r.info.edition}），构建于 ${r.info.buildTime || '—'}`
    } else {
      msgKind.value = 'err'
      msg.value = r.error || '连接失败'
    }
  } catch (e: any) {
    msgKind.value = 'err'
    msg.value = e?.message || '连接失败'
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  // 编辑态却改了主机/端口/用户名：多半是想"再加一个集群"，直接保存会把旧集群覆盖掉——
  // 这里拦一次，并明确告诉用户正确的入口。
  if (form.id && form.type !== 'ocp') {
    const moved =
      String(form.host || '').trim() !== editOrigin.host ||
      Number(form.port) !== editOrigin.port ||
      String(form.username || '').trim() !== editOrigin.username
    if (moved) {
      const ok = await window.sqlpilot.uiConfirm(
        `将修改已有平台「${form.name || editOrigin.host}」的连接目标`,
        '保存会直接更新这一条平台（旧地址不再保留）。如果是要再接入一个集群，请取消后点「＋ 新增集群」。',
        false
      )
      if (!ok) return
    }
  }
  busy.value = true
  msg.value = ''
  try {
    const r = await savePlatform(payload() as any, password.value || undefined)
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '保存失败'
      return
    }
    if (r.warning) {
      // 降级保存：关闭面板后还要让用户知道身份被改成了普通用户
      emit('close')
      await window.sqlpilot.uiAlert('已保存，但身份已调整', r.warning)
      return
    }
    emit('close')
  } catch (e: any) {
    msgKind.value = 'err'
    msg.value = e?.message || '保存失败'
  } finally {
    busy.value = false
  }
}

async function remove(p: CloudPlatformView): Promise<void> {
  const ok = await window.sqlpilot.uiConfirm(`删除云平台「${p.name}」？`, '仅移除本机的接入配置与密码，不会影响服务端或数据库。', true)
  if (!ok) return
  const r = await deletePlatform(p.id)
  if (!r.ok) {
    msgKind.value = 'err'
    msg.value = r.error || '删除失败'
    return
  }
  if (form.id === p.id) reset()
}

function close(): void { emit('close') }
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 300; background: rgba(5, 7, 12, 0.55);
  display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); padding: 22px;
  padding-top: var(--titlebar-h);
}
.panel {
  width: 620px; max-width: 100%; max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-side); border: 1px solid var(--border-strong); border-radius: 14px; box-shadow: var(--shadow-lg);
  animation: pop 0.16s ease;
}
@keyframes pop { from { transform: translateY(6px) scale(0.99); opacity: 0.7; } to { transform: none; opacity: 1; } }
.ph { display: flex; align-items: flex-start; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
.ph b { font-size: 14.5px; display: block; }
.ph .sub { font-size: 11px; color: var(--text-faint); display: block; margin-top: 3px; }
.x { margin-left: auto; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); cursor: pointer; font-size: 11px; }
.x:hover { color: var(--red); border-color: var(--red); }
.body { overflow-y: auto; padding: 14px 16px 18px; display: flex; flex-direction: column; gap: 14px; }

.plist-head { display: flex; align-items: center; gap: 8px; }
.plist-head b { font-size: 12px; }
.plist-head .dim, .form-head .dim { font-size: 10.5px; color: var(--text-faint); }
.mini.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.form-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.form-head b { font-size: 12px; }
.plist { display: flex; flex-direction: column; gap: 6px; }
.pitem {
  display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg-card);
}
.pitem.editing { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim) inset; }
.pico {
  width: 30px; height: 30px; border-radius: 8px; background: var(--accent-dim); color: var(--accent);
  display: flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 700; flex-shrink: 0;
  border: 1px solid var(--accent);
}
.pmain { flex: 1; min-width: 0; }
.pname { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.purl { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pmeta { font-size: 10.5px; color: var(--text-faint); margin-top: 1px; }
.tag { font-size: 9.5px; font-weight: 400; color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 40%, transparent); border-radius: 4px; padding: 0 4px; }
.mini {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 6px;
  font-size: 11px; padding: 3px 8px; cursor: pointer; font-family: inherit; flex-shrink: 0;
}
.mini:hover { color: var(--accent); border-color: var(--accent); }
.mini.danger:hover { color: var(--red); border-color: var(--red); }

.form { display: flex; flex-direction: column; gap: 10px; border-top: 1px dashed var(--border); padding-top: 13px; }
.frow { display: flex; flex-direction: column; gap: 5px; }
.frow.two { flex-direction: row; gap: 10px; }
.frow.two > div { flex: 1; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.frow.three { flex-direction: row; gap: 8px; }
.frow.three > div { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.frow.three > div:nth-child(1) { flex: 2; }
.frow.three > div:nth-child(2) { flex: 0 0 84px; }
.frow.three > div:nth-child(3) { flex: 1.4; }
.seg { display: flex; gap: 4px; }
.seg > button {
  height: 28px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text-dim); font-family: inherit; font-size: 11.5px; cursor: pointer;
}
.seg > button:hover { color: var(--text); }
.seg > button.on { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
.pico.ora { background: var(--red-dim); color: var(--red); border-color: var(--red); }
select {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
  font-family: inherit; font-size: 12.5px; padding: 7px 10px; outline: none; width: 100%;
}
select:focus { border-color: var(--accent); }
label { font-size: 11px; color: var(--text-dim); }
input:not([type='checkbox']) {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
  font-family: inherit; font-size: 12.5px; padding: 7px 10px; outline: none; width: 100%;
}
input:not([type='checkbox']):focus { border-color: var(--accent); }
input::placeholder { color: var(--text-faint); }
.chk { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--text-dim); cursor: pointer; }
.chk input { accent-color: var(--accent); }
.fhint { font-size: 10.5px; color: var(--text-faint); line-height: 1.5; }
.fnote {
  display: flex; gap: 7px; font-size: 11px; line-height: 1.6; color: var(--text-faint);
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
}
.fnote .i {
  width: 14px; height: 14px; border-radius: 50%; background: var(--accent-dim); color: var(--accent);
  display: flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; margin-top: 1px;
}
.msg { font-size: 11.5px; line-height: 1.55; padding: 7px 10px; border-radius: 8px; word-break: break-word; }
.msg.ok { color: var(--green); background: var(--green-dim); border: 1px solid color-mix(in srgb, var(--green) 35%, transparent); }
.msg.warn {
  color: var(--warn, #d9a441);
  border-color: color-mix(in srgb, var(--warn, #d9a441) 40%, transparent);
  background: var(--warn-dim, rgba(217, 164, 65, 0.1));
}
.msg.err { color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 35%, transparent); }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
</style>
