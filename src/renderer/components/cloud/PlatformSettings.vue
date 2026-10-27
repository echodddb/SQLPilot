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
        <!-- 已接入平台 -->
        <div v-if="cloud.platforms.length" class="plist" data-src="cfgOcp">
          <div v-for="p in cloud.platforms" :key="p.id" class="pitem" :class="{ editing: form.id === p.id }">
            <div class="pico" :class="{ ora: p.type === 'oracle' }">{{ p.type === 'oracle' ? 'ORA' : 'OB' }}</div>
            <div class="pmain">
              <div class="pname">
                {{ p.name }}
                <span v-if="p.type === 'oracle'" class="tag">Oracle 直连</span>
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
          <div class="frow">
            <label>类型</label>
            <div class="seg">
              <button :class="{ on: form.type === 'ocp' }" @click="setType('ocp')">OceanBase（OCP）</button>
              <button :class="{ on: form.type === 'oracle' }" @click="setType('oracle')">Oracle（直连）</button>
            </div>
          </div>

          <div class="frow">
            <label>名称</label>
            <input v-model="form.name" :placeholder="form.type === 'oracle' ? '例如：核心业务库' : '例如：生产 OCP / 测试 OCP'" spellcheck="false" />
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
  type: 'ocp' | 'oracle'
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
  // 打开面板先带出当前平台：多数时候用户是来改这条连接的（尤其刚配完连不上时）
  const active = cloud.platforms.find((p) => p.id === cloud.activeId) || cloud.platforms[0]
  if (active) edit(active)
  else reset()
})

function reset(): void {
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

function setType(t: 'ocp' | 'oracle'): void {
  if (form.type === t) return
  form.type = t
  msg.value = ''
}

function addrOf(p: CloudPlatformView): string {
  if (p.type === 'oracle') return `${p.host}:${p.port}${p.serviceName ? '/' + p.serviceName : ''}`
  return p.baseUrl || ''
}

/** 表单 → IPC 入参（Oracle 不带 baseUrl，OCP 不带库连接字段） */
function payload() {
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
  form.id = p.id
  form.type = p.type === 'oracle' ? 'oracle' : 'ocp'
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
