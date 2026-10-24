<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">副本与资源池 <span class="cnt">{{ d.zones.length }}</span></h4>
      <span class="sp"></span>
      <button class="tp-btn" :disabled="busy || zoneEdit !== null" @click="startAddReplica">＋ 新增副本</button>
      <button class="tp-btn" :disabled="busy" @click="refresh">刷新</button>
    </div>
    <div class="tp-note">
      修改规格 / Unit 数 / 副本类型都会作为一次变更任务提交（OCP modifyReplica 语义：整份副本列表覆盖），任务进度见「任务」页。
      主租户的 Unit 规格受所在 OBServer 剩余资源限制，扩缩容前建议先看集群资源。
    </div>

    <div v-if="msg" class="tp-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

    <!-- 新增副本 -->
    <div v-if="addForm" class="tp-card">
      <div class="tp-h" style="font-size:12px">新增副本</div>
      <div class="opgrid">
        <label class="frow">Zone（集群内空闲 Zone）
          <select v-model="addForm.zoneName" class="tp-select">
            <option v-for="z in freeZones" :key="z" :value="z">{{ z }}</option>
          </select>
        </label>
        <label class="frow">Unit 规格
          <select v-model="addForm.unitSpecName" class="tp-select">
            <option v-for="s in unitSpecs" :key="s.name" :value="s.name">{{ s.name }}（{{ s.cpu }}C/{{ fmtBytes(s.memory) }}）</option>
          </select>
        </label>
        <label class="frow">Unit 数
          <input v-model.number="addForm.unitCount" type="number" min="1" class="tp-input" />
        </label>
      </div>
      <div class="tp-bar">
        <span class="tp-note">副本类型默认 FULL；新增副本会同时创建资源池</span>
        <span class="sp"></span>
        <button class="tp-btn" :disabled="busy" @click="addForm = null">取消</button>
        <button class="tp-btn primary" :disabled="busy || !addForm.zoneName" @click="doAddReplica">提交</button>
      </div>
    </div>

    <!-- 副本卡片 -->
    <div v-for="z in d.zones" :key="z.name" class="tp-card" data-src="tnReplica" :data-tenant="d.tenant.name">
      <template v-if="zoneEdit?.name === z.name">
        <div class="opgrid">
          <label class="frow">Unit 规格
            <select v-model="zoneEdit.unitSpecName" class="tp-select">
              <option v-for="s in unitSpecs" :key="s.name" :value="s.name">{{ s.name }}（{{ s.cpu }}C/{{ fmtBytes(s.memory) }}）</option>
            </select>
          </label>
          <label class="frow">Unit 数
            <input v-model.number="zoneEdit.unitCount" type="number" min="1" class="tp-input" />
          </label>
          <label class="frow">副本类型
            <select v-model="zoneEdit.replicaType" class="tp-select">
              <option value="FULL">FULL</option>
              <option value="READONLY">READONLY</option>
              <option value="LOGONLY">LOGONLY</option>
            </select>
          </label>
        </div>
        <div class="tp-bar">
          <span class="tp-note">提交时会把全部副本一起下发，未改动的 Zone 保持原样</span>
          <span class="sp"></span>
          <button class="tp-btn" :disabled="busy" @click="zoneEdit = null">取消</button>
          <button class="tp-btn primary" :disabled="busy" @click="doZoneEdit">保存</button>
        </div>
      </template>

      <template v-else>
        <div class="tp-bar">
          <b style="font-size:13px">{{ z.name }}</b>
          <span class="tp-chip" style="color:var(--accent);border-color:var(--accent)">{{ z.replicaType }}</span>
          <span class="tp-chip tp-mono" :title="z.poolName">{{ z.poolName || '—' }}</span>
          <span class="sp"></span>
          <button class="tp-btn sm" :disabled="busy || addForm !== null" @click="startZoneEdit(z)">编辑</button>
          <button class="tp-btn sm danger" :disabled="busy || d.zones.length <= 1" title="删除该 Zone 的副本" @click="doDeleteReplica(z.name)">删除</button>
        </div>
        <div class="tp-bar" style="font-size:11px;color:var(--text-dim)">
          <span>Unit {{ z.unitCount }} 个</span>
          <span>单 Unit {{ z.unitCpu }} 核 / {{ fmtBytes(z.unitMemory) }}</span>
          <span>合计 {{ (z.unitCpu * z.unitCount).toFixed(0) }} 核 / {{ fmtBytes(z.unitMemory * z.unitCount) }}</span>
        </div>
        <div class="tp-bar">
          <span v-for="u in z.units" :key="u.id" class="tp-chip tp-mono">
            <i class="tp-dot" :class="u.status === 'ACTIVE' ? '' : 'warn'"></i>{{ u.ip }}:{{ u.port }}
          </span>
          <span v-if="!z.units.length" class="tp-note">OCP 未返回该 Zone 的 Unit 明细</span>
        </div>
      </template>
    </div>
    <div v-if="!d.zones.length" class="tp-empty">该租户暂无副本信息</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 副本与资源：编辑 Unit 规格 / 数量 / 副本类型，新增与删除副本。
 * 规格候选来自集群详情的 unitSpecs（过滤掉 SYSTEM 规格），空闲 Zone 来自集群 zones 差集。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud, refreshTenant, tenantAddReplica, tenantDeleteReplica, tenantModifyReplica } from '../../../cloud/state'
import { fmtBytes } from '../../../cloud/parts'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const busy = ref(false)
const msg = ref('')
const msgOk = ref(true)

interface SpecItem { name: string; cpu: number; memory: number; type: string }
const unitSpecs = ref<SpecItem[]>([])
const clusterZoneNames = ref<string[]>([])
const specsLoaded = ref(false)

const freeZones = computed(() => clusterZoneNames.value.filter((z) => !d.value.zones.some((x) => x.name === z)))

const zoneEdit = ref<{ name: string; replicaType: string; unitSpecName: string; unitCount: number } | null>(null)
const addForm = ref<{ zoneName: string; unitSpecName: string; unitCount: number } | null>(null)

async function ensureSpecs(): Promise<void> {
  if (specsLoaded.value) return
  const t = d.value.tenant
  const r = await window.sqlpilot.cloudCluster(cloud.activeId, t.clusterId)
  if (r.ok && r.data) {
    const list = r.data.unitSpecs || []
    const normal = list.filter((u) => u.type !== 'SYSTEM')
    unitSpecs.value = normal.length ? normal : list
    clusterZoneNames.value = (r.data.zones || []).map((z) => z.name)
    specsLoaded.value = true
  }
}

function tip(text: string, ok: boolean): void {
  msg.value = text
  msgOk.value = ok
}

async function startZoneEdit(z: CloudTenantDetail['zones'][number]): Promise<void> {
  await ensureSpecs()
  addForm.value = null
  zoneEdit.value = {
    name: z.name,
    replicaType: z.replicaType || 'FULL',
    unitSpecName: z.poolName || unitSpecs.value[0]?.name || '',
    unitCount: z.unitCount || 1
  }
}

async function startAddReplica(): Promise<void> {
  await ensureSpecs()
  zoneEdit.value = null
  if (!freeZones.value.length) {
    await window.sqlpilot.uiAlert('没有可用的 Zone', '集群内所有 Zone 都已有该租户的副本。')
    return
  }
  addForm.value = { zoneName: freeZones.value[0], unitSpecName: unitSpecs.value[0]?.name || '', unitCount: 1 }
}

async function doZoneEdit(): Promise<void> {
  const t = d.value.tenant
  const edit = zoneEdit.value
  if (!edit) return
  busy.value = true
  msg.value = ''
  try {
    const replicas = d.value.zones.map((z) => ({
      zoneName: z.name,
      replicaType: z.name === edit.name ? edit.replicaType : (z.replicaType || 'FULL'),
      unitSpecName: z.name === edit.name ? edit.unitSpecName : (z.poolName || ''),
      unitCount: z.name === edit.name ? Math.max(1, Number(edit.unitCount) || 1) : (z.unitCount || 1)
    }))
    const r = await tenantModifyReplica(t.clusterId, t.id, replicas)
    if (!r.ok) { tip(r.error || '修改失败', false); return }
    pushNotice(r.taskId ? `修改副本任务已提交：任务 #${r.taskId}` : '修改副本任务已提交')
    tip(r.taskId ? `变更任务 #${r.taskId} 已提交，等待 OCP 执行` : '变更任务已提交', true)
    zoneEdit.value = null
    await refreshTenant()
  } finally {
    busy.value = false
  }
}

async function doAddReplica(): Promise<void> {
  const t = d.value.tenant
  const f = addForm.value
  if (!f) return
  busy.value = true
  msg.value = ''
  try {
    const r = await tenantAddReplica(t.clusterId, t.id, [{ zoneName: f.zoneName, replicaType: 'FULL', unitSpecName: f.unitSpecName, unitCount: Math.max(1, Number(f.unitCount) || 1) }])
    if (!r.ok) { tip(r.error || '新增失败', false); return }
    pushNotice(r.taskId ? `新增副本任务已提交：任务 #${r.taskId}` : '新增副本任务已提交')
    tip(r.taskId ? `新增副本任务 #${r.taskId} 已提交` : '新增副本任务已提交', true)
    addForm.value = null
    await refreshTenant()
  } finally {
    busy.value = false
  }
}

async function doDeleteReplica(zoneName: string): Promise<void> {
  const t = d.value.tenant
  const ok = await window.sqlpilot.uiConfirm(`删除 Zone「${zoneName}」上的副本？`, '该 Zone 的 Unit 与数据副本将被移除，任务号见「任务」页。', true)
  if (!ok) return
  busy.value = true
  msg.value = ''
  try {
    const r = await tenantDeleteReplica(t.clusterId, t.id, [zoneName])
    if (!r.ok) { tip(r.error || '删除失败', false); return }
    pushNotice(r.taskId ? `删除副本任务已提交：任务 #${r.taskId}` : '删除副本任务已提交')
    tip('删除副本任务已提交', true)
    await refreshTenant()
  } finally {
    busy.value = false
  }
}

async function refresh(): Promise<void> {
  await refreshTenant()
  specsLoaded.value = false
  await ensureSpecs()
}

onMounted(ensureSpecs)
watch(() => props.reloadToken, refresh)
</script>

<style scoped>
.opgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 9px; }
.frow { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-dim); min-width: 0; }
</style>
