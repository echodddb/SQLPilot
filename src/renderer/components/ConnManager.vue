<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal">
      <h3>{{ isNew ? '新增连接' : '编辑连接' }}</h3>

      <div class="form-row">
        <div>
          <label>连接名称 *</label>
          <input type="text" v-model="form.name" placeholder="如：lisdb-19c" />
        </div>
        <div>
          <label>类型</label>
          <select v-model="form.type">
            <option value="oracle">Oracle（11g / 19c）</option>
            <option value="ob-mysql">OceanBase · MySQL 租户</option>
            <option value="mysql">MySQL</option>
            <option value="ob-oracle">OceanBase · Oracle 租户</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div style="flex:2">
          <label>主机</label>
          <input type="text" v-model="form.host" placeholder="192.168.x.x" />
        </div>
        <div>
          <label>端口</label>
          <input type="number" v-model.number="form.port" @change="portTouched = true" />
        </div>
      </div>

      <div class="form-row" v-if="isObTenant">
        <div>
          <label>连接方式</label>
          <select v-model="form.obConnectMode">
            <option value="obproxy">OBProxy（生产推荐）</option>
            <option value="observer">直连 Observer（排障）</option>
          </select>
        </div>
        <div>
          <label>租户 *</label>
          <input type="text" v-model="form.obTenant" placeholder="如 biz_tenant" />
        </div>
        <div>
          <label>集群名（OBProxy 建议填写）</label>
          <input type="text" v-model="form.obCluster" placeholder="如 prod_cluster" />
        </div>
      </div>

      <div class="form-row" v-if="form.type === 'oracle'">
        <div>
          <label>{{ form.type === 'oracle' ? '服务名（Service Name）' : 'Oracle Net 服务名（可选）' }}</label>
          <input type="text" v-model="form.serviceName" :placeholder="form.type === 'oracle' ? 'orcl' : '通常可留空，由 OB 租户路由决定'" />
        </div>
      </div>
      <div class="form-row" v-else>
        <div>
          <label>{{ form.type === 'ob-mysql' ? '数据库 *' : '数据库（可留空）' }}</label>
          <input type="text" v-model="form.database" placeholder="业务库名" />
        </div>
      </div>

      <div class="form-row">
        <div>
          <label>{{ isObTenant ? '用户名（不含租户）' : '用户名' }}</label>
          <input type="text" v-model="form.user" :placeholder="isObTenant ? '如 dbadmin' : '数据库账号'" />
        </div>
        <div>
          <label>密码</label>
          <input type="password" v-model="password" :placeholder="isNew ? '' : '（未修改则留空）'" />
        </div>
        <div>
          <label>账号角色</label>
          <select v-model="form.role">
            <option value="readonly">只读账号</option>
            <option value="admin">管理账号</option>
          </select>
        </div>
      </div>

      <div class="form-row" v-if="form.type === 'oracle'">
        <div>
          <label>Instant Client 目录（连 11g 必填；19c 纯协议可留空）</label>
          <input type="text" v-model="form.instantClientDir" placeholder="D:\instantclient_19_x，留空则用全局设置" />
        </div>
      </div>

      <div class="form-row" v-if="form.type === 'mysql' || isObTenant">
        <div>
          <label>
            <input type="checkbox" v-model="form.ssl" style="width:auto;margin-right:6px" />
            启用 SSL
          </label>
        </div>
        <div>
          <label>
            <input type="checkbox" v-model="form.sslVerifyServer" :disabled="!form.ssl" style="width:auto;margin-right:6px" />
            校验服务器证书
          </label>
        </div>
        <div style="flex:2">
          <label>SSL CA 证书路径（可选）</label>
          <input type="text" v-model="form.sslCa" :disabled="!form.ssl" placeholder="D:\certs\obproxy-ca.pem" />
        </div>
      </div>

      <div class="form-row">
        <div>
          <label title="数据库模块左侧对象树按分组文件夹展示；留空 = 未分组">分组（留空 = 未分组）</label>
          <input v-model="form.group" list="conn-groups" placeholder="如 核心业务库" />
          <datalist id="conn-groups">
            <option v-for="g in connGroups" :key="g" :value="g" />
          </datalist>
        </div>
        <div>
          <label title="不填就是全局连接，任何会话可用；只有显式选择项目才关联">关联项目（留空 = 全局，默认）</label>
          <select v-model="form.projectId">
            <option value="">不关联（全局 · 默认）</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </div>

      <div class="test-result" v-if="testMsg" :style="{ color: testOk ? 'var(--green)' : 'var(--red)' }">{{ testMsg }}</div>

      <div class="actions">
        <button class="btn" @click="doTest" :disabled="testing">{{ testing ? '测试中…' : '测试连接' }}</button>
        <span style="flex:1"></span>
        <button class="btn ghost" @click="$emit('close')">取消</button>
        <button class="btn primary" @click="doSave">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { store } from '../store'
import { connGroupFolders } from '../grouping'

const props = defineProps<{ editing: any }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const DEFAULT_PORT: Record<string, number> = { oracle: 1521, mysql: 3306, 'ob-mysql': 2883, 'ob-oracle': 2883 }
const OB_DEFAULT_PORT: Record<string, number> = { obproxy: 2883, observer: 2881 }

function parseObUser(user?: string): { user: string; tenant: string; cluster: string } {
  const raw = (user || '').trim()
  const match = raw.match(/^([^@#]+)(?:@([^#]+))?(?:#(.+))?$/)
  return {
    user: match?.[1] || raw,
    tenant: match?.[2] || '',
    cluster: match?.[3] || ''
  }
}

// 调用方可能只带预填字段（如项目属性里「新建连接」带 projectId、分组右键带 group）：
// 没有 id 就是新增，别显示成"编辑连接"
const isNew = !props.editing?.id

const editingObUser = parseObUser(props.editing?.user)
const editingIsObTenant = props.editing?.type === 'ob-mysql' || props.editing?.type === 'ob-oracle'

const form = reactive({
  id: props.editing?.id || `conn_${Date.now()}`,
  name: props.editing?.name || '',
  type: props.editing?.type || 'oracle',
  host: props.editing?.host || '',
  port: props.editing?.port || 1521,
  serviceName: props.editing?.serviceName || '',
  database: props.editing?.database || '',
  user: editingIsObTenant ? editingObUser.user : props.editing?.user || '',
  role: props.editing?.role || 'readonly',
  obConnectMode: editingIsObTenant
    ? props.editing?.obConnectMode || (props.editing?.port === 2881 ? 'observer' : 'obproxy')
    : 'obproxy',
  obTenant: editingIsObTenant ? props.editing?.obTenant || editingObUser.tenant : '',
  obCluster: editingIsObTenant ? props.editing?.obCluster || editingObUser.cluster : '',
  ssl: props.editing?.ssl || false,
  sslVerifyServer: props.editing?.sslVerifyServer || false,
  sslCa: props.editing?.sslCa || '',
  instantClientDir: props.editing?.instantClientDir || '',
  // 新建时可带上分组（数据库模块在某个分组上右键「在此分组新建连接」）
  group: props.editing?.group || '',
  projectId: (props.editing?.projectId as string) || ''
})

const isObTenant = computed(() => form.type === 'ob-mysql' || form.type === 'ob-oracle')

const projects = computed(() => store.cfg?.projects || [])

/** 已有分组（datalist 提示，避免手打错字建出两个相似分组） */
const connGroups = computed(() => connGroupFolders())

const password = ref('')
const testing = ref(false)
const testOk = ref(false)
const testMsg = ref('')

// 切换数据库类型时联动默认端口（用户已手改过端口则不覆盖）
let portTouched = false
let sslDefaultInitialized = !isNew
watch(
  () => form.type,
  (t, old) => {
    if (t !== old && !portTouched) form.port = DEFAULT_PORT[t] ?? 3306
    if (isObTenant.value && form.obConnectMode !== 'observer') form.obConnectMode = 'obproxy'
    if (isObTenant.value && !portTouched) form.port = OB_DEFAULT_PORT[form.obConnectMode] || 2883
    if (t !== old && t !== 'mysql' && !isObTenant.value) {
      form.ssl = false
      form.sslVerifyServer = false
      form.sslCa = ''
    }
  }
)
watch(
  () => form.obConnectMode,
  () => {
    if (isObTenant.value && !portTouched) form.port = OB_DEFAULT_PORT[form.obConnectMode] || 2883
  }
)

watch(
  () => form.ssl,
  (enabled) => {
    if (enabled && !sslDefaultInitialized) {
      form.sslVerifyServer = true
      sslDefaultInitialized = true
    }
  }
)

function validate(): string {
  if (!form.name || !form.host || !form.user) return '名称、主机、用户名为必填'
  if (form.type === 'oracle' && !form.serviceName) return 'Oracle 需要填写服务名'
  if (isObTenant.value) {
    if (!form.obTenant && !form.user.includes('@')) return 'OceanBase 需要填写租户'
    if (/[@#]/.test(form.user) || /#/.test(form.obTenant) || /#/.test(form.obCluster)) return 'OceanBase 用户、租户、集群请分开填写，不要包含 @ 或 #'
    if (form.obConnectMode === 'obproxy' && !form.obCluster) return '经 OBProxy 连接需要填写集群名'
    if (form.type === 'ob-mysql' && !form.database) return 'OceanBase MySQL 租户需要显式指定业务数据库'
  }
  if (form.type === 'ob-mysql') {
    if (form.ssl && form.sslVerifyServer && !form.sslCa) return '校验服务器证书需要填写 SSL CA 证书路径'
  }
  return ''
}

async function doTest() {
  const validationError = validate()
  if (validationError) { testMsg.value = validationError; testOk.value = false; return }
  testing.value = true
  testMsg.value = ''
  try {
    const r = await window.sqlpilot.testConn({ ...form }, password.value)
    testOk.value = r.ok
    testMsg.value = r.ok ? `✓ 连接成功：${r.label}` : `✗ ${r.error}`
  } catch (e: any) {
    testOk.value = false
    testMsg.value = `✗ ${e?.message || e}`
  } finally {
    testing.value = false
  }
}

async function doSave() {
  const validationError = validate()
  if (validationError) { window.sqlpilot.uiAlert(validationError); return }
  const r = await window.sqlpilot.saveConn({ ...form, projectId: form.projectId || null }, password.value || undefined)
  if (!r.ok) { window.sqlpilot.uiAlert(r.error || '保存失败'); return }
  store.cfg = await window.sqlpilot.getConfig()
  if (store.tree[form.id]) store.tree[form.id].schemas = undefined
  emit('close')
}
</script>
