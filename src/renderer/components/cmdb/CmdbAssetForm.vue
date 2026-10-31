<template>
  <div class="cm-mask" @click.self="emit('close')">
    <div class="cm-dlg">
      <div class="cm-dlg-head">
        {{ isNew ? '新增资产' : '编辑资产' }}
        <span class="sub">{{ isNew ? '归属（客户 / 机房 / 机柜）决定它在拓扑里的位置' : asset?.name }}</span>
        <button class="cm-close" @click="emit('close')">✕</button>
      </div>

      <div class="cm-dlg-body">
        <div class="cm-grid3">
          <label class="cm-field">
            <span class="cm-label">客户<i class="req">*</i></span>
            <select v-model="form.customerId" class="cm-select">
              <option value="" disabled>— 选择客户 —</option>
              <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">机房</span>
            <select v-model="form.idcId" class="cm-select" @change="form.rackId = ''">
              <option value="">— 未指定 —</option>
              <option v-for="d in idcs" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">机柜 / U 位</span>
            <div style="display: flex; gap: 6px">
              <select v-model="form.rackId" class="cm-select" :disabled="!form.idcId">
                <option value="">— 未上架 —</option>
                <option v-for="r in rackOptions" :key="r.id" :value="r.id">{{ r.code }}</option>
              </select>
              <input v-model.number="form.u" class="cm-input" style="width: 66px" type="number" min="1" placeholder="U" :disabled="!form.rackId" />
            </div>
          </label>
        </div>

        <div class="cm-grid3">
          <label class="cm-field">
            <span class="cm-label">类型<i class="req">*</i></span>
            <select v-model="form.type" class="cm-select">
              <optgroup v-for="g in typeGroups" :key="g.kind" :label="g.name">
                <option v-for="t in g.list" :key="t.id" :value="t.id">{{ t.glyph }} {{ t.name }}</option>
              </optgroup>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">名称<i class="req">*</i></span>
            <input v-model="form.name" class="cm-input" placeholder="如 srv-db-01 / core-sw-01" />
          </label>
          <label class="cm-field">
            <span class="cm-label">状态</span>
            <select v-model="form.status" class="cm-select">
              <option v-for="s in STATUSES" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </label>
        </div>

        <div class="cm-grid3">
          <label class="cm-field">
            <span class="cm-label">设备规格<span class="cm-hint-i">（决定占几 U、前面板有哪些口）</span></span>
            <select v-model="form.spec" class="cm-select" @change="applySpec">
              <option value="">— 自定义 / 未选 —</option>
              <optgroup v-for="g in specGroups" :key="g.name" :label="g.name">
                <option v-for="sp in g.list" :key="sp.id" :value="sp.id">{{ sp.name }}（{{ sp.u ? sp.u + 'U' : '落地' }}）</option>
              </optgroup>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">用途</span>
            <select v-model="form.role" class="cm-select">
              <option value="">— 未指定 —</option>
              <option v-for="r in ROLES" :key="r.id" :value="r.id">{{ r.name }}</option>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">占 U 数</span>
            <input v-model.number="form.uHeight" class="cm-input" type="number" min="1" max="20" />
          </label>
        </div>

        <div class="cm-grid3">
          <label class="cm-field">
            <span class="cm-label">集群架构</span>
            <select v-model="form.arch" class="cm-select">
              <option value="">— 无（单机）—</option>
              <option v-for="a in ARCHS" :key="a.id" :value="a.id">{{ a.name }}</option>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">架构组名（同组的设备会互相高亮）</span>
            <input v-model="form.archGroup" class="cm-input" placeholder="如 rac-prod / dg-order" />
          </label>
          <div class="cm-field">
            <span class="cm-label">端口面板</span>
            <div class="cm-ports">
              <span v-for="g in portSummary" :key="g.name" class="cm-port-tag" :title="g.name">{{ g.short }} ×{{ g.count }}</span>
              <span v-if="!portSummary.length" class="cm-hint-i">选规格后显示</span>
            </div>
          </div>
        </div>

        <div class="cm-grid2">
          <label class="cm-field">
            <span class="cm-label">IP（多个用逗号或空格分隔）</span>
            <input v-model="ipsText" class="cm-input" placeholder="10.1.2.31, 10.1.2.32" />
          </label>
          <label class="cm-field">
            <span class="cm-label">主机名</span>
            <input v-model="form.hostname" class="cm-input" placeholder="留空则与名称一致" />
          </label>
        </div>

        <div class="cm-grid3">
          <label class="cm-field">
            <span class="cm-label">厂商</span>
            <input v-model="form.vendor" class="cm-input" placeholder="Dell / 华为 / H3C" />
          </label>
          <label class="cm-field">
            <span class="cm-label">型号</span>
            <input v-model="form.model" class="cm-input" placeholder="R750 / CE6865" />
          </label>
          <label class="cm-field">
            <span class="cm-label">序列号</span>
            <input v-model="form.sn" class="cm-input" />
          </label>
        </div>

        <div class="cm-grid3">
          <label class="cm-field">
            <span class="cm-label">操作系统 / 版本</span>
            <input v-model="form.os" class="cm-input" placeholder="CentOS 7.9 / Oracle Linux 8.6" />
          </label>
          <label class="cm-field">
            <span class="cm-label">负责人</span>
            <input v-model="form.owner" class="cm-input" />
          </label>
          <label class="cm-field">
            <span class="cm-label">标签</span>
            <input v-model="tagsText" class="cm-input" placeholder="核心 / 生产" />
          </label>
        </div>

        <div class="cm-grid2">
          <label class="cm-field">
            <span class="cm-label">关联 SSH 服务器（可直接开终端）</span>
            <select v-model="form.linkServerId" class="cm-select">
              <option value="">— 不关联 —</option>
              <option v-for="s in servers" :key="s.id" :value="s.id">{{ s.name }}（{{ s.host }}）</option>
            </select>
          </label>
          <label class="cm-field">
            <span class="cm-label">关联数据库连接（可直接开控制台）</span>
            <select v-model="form.linkConnId" class="cm-select">
              <option value="">— 不关联 —</option>
              <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}（{{ c.host }}:{{ c.port }}）</option>
            </select>
          </label>
        </div>

        <label class="cm-field">
          <span class="cm-label">备注</span>
          <textarea v-model="form.note" class="cm-textarea" rows="2" placeholder="用途、责任人交接、特殊说明…" />
        </label>
      </div>

      <div class="cm-dlg-foot">
        <span class="cm-hint">归属与类型决定它在 3D 里的位置和颜色；关系在图上拖拽建立</span>
        <span class="spacer"></span>
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="saving || !form.name.trim() || !form.customerId" @click="submit">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ASSET_TYPES, STATUSES, KIND_NAME, SPECS, ROLES, ARCHS, specOf } from '../../cmdb/dict'
import { portsOf } from '../../../main/cmdb-model'
import { cm, customers, idcs, racks, saveAsset } from '../../cmdb/state'
import { store } from '../../store'

const props = defineProps<{
  asset?: any | null
  preset?: { customerId?: string; idcId?: string; rackId?: string; type?: string } | null
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', id: string): void }>()

const isNew = computed(() => !props.asset?.id)
const saving = ref(false)

const servers = computed<any[]>(() => store.cfg?.servers || [])
const connections = computed<any[]>(() => store.cfg?.connections || [])

const form = reactive<any>({
  id: '',
  customerId: '',
  idcId: '',
  rackId: '',
  u: undefined,
  spec: '',
  role: '',
  arch: '',
  archGroup: '',
  uHeight: undefined,
  type: 'server',
  name: '',
  hostname: '',
  ips: [] as string[],
  os: '',
  status: 'running',
  owner: '',
  vendor: '',
  model: '',
  sn: '',
  tags: [] as string[],
  note: '',
  linkServerId: '',
  linkConnId: ''
})

const ipsText = ref('')
const tagsText = ref('')

function fill(a: any): void {
  const src = a || {}
  Object.assign(form, {
    id: src.id || '',
    customerId: src.customerId || props.preset?.customerId || cm.filter.customerId || customers.value[0]?.id || '',
    idcId: src.idcId || props.preset?.idcId || cm.filter.idcId || '',
    rackId: src.rackId || props.preset?.rackId || '',
    u: src.u,
    spec: src.spec || '',
    role: src.role || '',
    arch: src.arch || '',
    archGroup: src.archGroup || '',
    uHeight: src.uHeight,
    type: src.type || props.preset?.type || 'server',
    name: src.name || '',
    hostname: src.hostname || '',
    ips: src.ips || [],
    os: src.os || '',
    status: src.status || 'running',
    owner: src.owner || '',
    vendor: src.vendor || '',
    model: src.model || '',
    sn: src.sn || '',
    tags: src.tags || [],
    note: src.note || '',
    linkServerId: src.linkServerId || '',
    linkConnId: src.linkConnId || ''
  })
  ipsText.value = (src.ips || []).join(', ')
  tagsText.value = (src.tags || []).join(' ')
}

fill(props.asset)
watch(() => props.asset, (a) => fill(a))

const typeGroups = computed(() => {
  const order = ['hardware', 'software', 'logical']
  return order.map((kind) => ({ kind, name: KIND_NAME[kind] || kind, list: ASSET_TYPES.filter((t) => t.kind === kind) }))
})

const rackOptions = computed(() => racks.value.filter((r) => r.idcId === form.idcId))

const specGroups = computed(() => {
  const order: { name: string; types: string[] }[] = [
    { name: '服务器 / 存储', types: ['server', 'storage'] },
    { name: '网络设备', types: ['switch', 'firewall', 'loadbalancer'] },
    { name: '供电 / 其他', types: ['ups', 'pdu', 'other-hw'] }
  ]
  return order.map((g) => ({ name: g.name, list: SPECS.filter((s) => g.types.includes(s.type)) }))
})

/** 端口摘要：让用户在建资产时就知道这台机器有几个电口/光口/电源口 */
const portSummary = computed(() => {
  const spec = specOf(form.spec)
  const groups = spec?.ports || []
  return groups.map((g) => ({
    name: g.group,
    short: g.group === 'nic' ? '电口' : g.group === 'sfp' ? '光口' : g.group === 'power' ? '电源' : g.group === 'disk' ? '盘位' : g.group === 'mgmt' ? '管理' : 'Console',
    count: g.count
  }))
})

/** 选规格 = 把 type / U 数 / 默认用途一起带过来（省得用户自己对齐字段） */
function applySpec(): void {
  const sp = specOf(form.spec)
  if (!sp) return
  form.type = sp.type
  form.uHeight = sp.u || 1
  if (!form.role && sp.role) form.role = sp.role
  if (!form.name.trim()) form.name = form.hostname || ''
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  const payload = {
    ...form,
    id: form.id || undefined,
    ips: ipsText.value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
    tags: tagsText.value.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
  }
  const r = await saveAsset(payload, isNew.value ? '资产已新增' : '资产已保存')
  saving.value = false
  if (r?.ok && r.value?.id) emit('saved', r.value.id)
}
</script>

<style scoped>
.cm-dlg { width: min(900px, calc(100vw - 80px)); }
.cm-hint-i { font-size: 10px; color: var(--text-faint); font-weight: 400; }
.cm-ports { display: flex; flex-wrap: wrap; gap: 4px; min-height: 26px; align-items: center; }
.cm-port-tag {
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-dim);
  background: var(--bg-input);
  border: 1px solid var(--border);
}
optgroup { color: var(--text-faint); }
option { color: var(--text); }
</style>
