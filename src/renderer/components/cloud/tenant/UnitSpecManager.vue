<template>
  <div class="tp-pane embedded">
    <div class="tp-bar">
      <h4 class="tp-h">Unit 规格 <span class="cnt">{{ filtered.length }} / {{ specs.length }}</span></h4>
      <input v-model="kw" class="tp-input tp-search" placeholder="搜索规格名" spellcheck="false" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
      <button class="tp-btn primary" @click="startCreate">＋ 新建规格</button>
    </div>
    <div class="tp-note">
      创建租户、扩缩容时可选这里定义的资源规格。内置（SYSTEM）规格不可改删；被租户资源池引用的规格无法删除。
      内存单位是 GiB，与集群详情里 Unit 的字节数不是同一口径。
    </div>

    <div v-if="err" class="tp-err">{{ err }}</div>
    <div v-if="msg" class="tp-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</div>

    <!-- 新建 / 编辑 -->
    <div v-if="form" class="tp-card">
      <div class="tp-bar">
        <b style="font-size:12px;color:var(--accent)">{{ editing ? `编辑规格「${editing.name}」` : '新建 Unit 规格' }}</b>
      </div>
      <div class="frow-grid">
        <label class="frow">规格名
          <input v-model="form.name" class="tp-input mono" placeholder="如 app_2c8g" spellcheck="false" :disabled="!!editing" />
        </label>
        <label class="frow">CPU（核，0.5 的倍数）
          <input v-model.number="form.cpu" class="tp-input" type="number" min="0.5" step="0.5" />
        </label>
        <label class="frow">内存（GiB）
          <input v-model.number="form.memory" class="tp-input" type="number" min="1" step="1" />
        </label>
        <label class="frow">日志盘（GiB，可选）
          <input v-model.number="form.logDisk" class="tp-input" type="number" min="0" step="1" placeholder="OB 4.0+ 可设" />
        </label>
        <label class="frow">最大 IOPS（可选）
          <input v-model.number="form.iops" class="tp-input" type="number" min="0" step="1" placeholder="OB 4.0+ 可设" />
        </label>
      </div>
      <div class="tp-bar">
        <span class="tp-note">CPU 与内存作为该规格的固定值（min = max），建租户时按此规格分配每个 Unit。</span>
        <span class="sp"></span>
        <button class="tp-btn" :disabled="busy" @click="form = null">取消</button>
        <button class="tp-btn primary" :disabled="busy || !form.name.trim()" @click="save">{{ busy ? '提交中…' : '保存' }}</button>
      </div>
    </div>

    <div class="tp-tbl-wrap tp-scroll-y" data-src="tnUnitSpec" :data-detail="`共 ${specs.length} 个规格|内置 ${systemCount} 个 · 自定义 ${specs.length - systemCount} 个`">
      <table class="tp-tbl">
        <thead>
          <tr><th>规格名</th><th>类型</th><th class="r">CPU（核）</th><th class="r">内存（GiB）</th><th class="r">日志盘</th><th class="r">IOPS</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in filtered" :key="s.id">
            <td class="tp-mono">{{ s.name }}<span v-if="s.notRecommended" class="tag warn">不推荐</span></td>
            <td><span class="tag" :class="s.type === 'SYSTEM' ? 'gray' : 'info'">{{ s.type === 'SYSTEM' ? '内置' : '自定义' }}</span></td>
            <td class="r tp-mono">{{ s.maxCpu }}</td>
            <td class="r tp-mono">{{ s.maxMemory }}</td>
            <td class="r tp-mono tp-dim">{{ s.logDisk ?? '—' }}</td>
            <td class="r tp-mono tp-dim">{{ s.maxIops || '—' }}</td>
            <td>
              <button class="tp-btn sm" :disabled="s.type === 'SYSTEM' || busy" @click="startEdit(s)">编辑</button>
              <button class="tp-btn sm danger" :disabled="s.type === 'SYSTEM' || busy" @click="remove(s)">删除</button>
            </td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="7" class="tp-empty">{{ loading ? '读取中…' : '没有匹配的规格' }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Unit 规格管理（租户页内的 tab，与 OCP「租户 → Unit 规格」一致）。
 * GET/POST /api/v2/ob/unitSpecs，PUT/DELETE /api/v2/ob/unitSpecs/{specId}。
 * 内存字段单位是 GiB（maxMemorySize），注意与集群详情里 unitSpecs.memory 的字节不同。
 */
import { computed, onMounted, ref } from 'vue'
import { cloud } from '../../../cloud/state'
import { pushNotice } from '../../../store'

const specs = ref<CloudUnitSpec[]>([])
const loading = ref(false)
const busy = ref(false)
const err = ref('')
const msg = ref('')
const msgOk = ref(true)
const kw = ref('')

const editing = ref<CloudUnitSpec | null>(null)
const form = ref<{ name: string; cpu: number; memory: number; logDisk: number | null; iops: number | null } | null>(null)

const systemCount = computed(() => specs.value.filter((s) => s.type === 'SYSTEM').length)
const filtered = computed(() => {
  const k = kw.value.trim().toLowerCase()
  return k ? specs.value.filter((s) => s.name.toLowerCase().includes(k)) : specs.value
})

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const r = await window.sqlpilot.cloudUnitSpecs(cloud.activeId)
    if (!r.ok) { err.value = r.error || '读取规格失败'; return }
    specs.value = r.data || []
  } finally {
    loading.value = false
  }
}

function startCreate(): void {
  editing.value = null
  msg.value = ''
  form.value = { name: '', cpu: 2, memory: 8, logDisk: null, iops: null }
}

function startEdit(s: CloudUnitSpec): void {
  editing.value = s
  msg.value = ''
  form.value = { name: s.name, cpu: s.maxCpu, memory: s.maxMemory, logDisk: s.logDisk, iops: s.maxIops }
}

async function save(): Promise<void> {
  const f = form.value
  if (!f) return
  if (f.cpu < 0.5) { msg.value = 'CPU 至少 0.5 核'; msgOk.value = false; return }
  if (f.memory < 1) { msg.value = '内存至少 1 GiB'; msgOk.value = false; return }
  busy.value = true
  msg.value = ''
  try {
    const input: CloudUnitSpecInput = {
      name: f.name.trim(),
      minCpuCoreCount: f.cpu,
      maxCpuCoreCount: f.cpu,
      minMemorySize: f.memory,
      maxMemorySize: f.memory
    }
    if (f.logDisk) input.logDiskSize = f.logDisk
    if (f.iops) input.maxIops = f.iops
    const r = editing.value
      ? await window.sqlpilot.cloudUnitSpecUpdate(cloud.activeId, editing.value.id, input)
      : await window.sqlpilot.cloudUnitSpecCreate(cloud.activeId, input)
    if (!r.ok) { msg.value = r.error || '保存失败'; msgOk.value = false; return }
    pushNotice(editing.value ? '规格已更新' : '规格已创建')
    msg.value = editing.value ? '规格已更新' : `规格「${input.name}」已创建`
    msgOk.value = true
    form.value = null
    editing.value = null
    await load()
  } finally {
    busy.value = false
  }
}

async function remove(s: CloudUnitSpec): Promise<void> {
  const ok = await window.sqlpilot.uiConfirm(`删除 Unit 规格「${s.name}」？`, '若该规格正被租户资源池引用，OCP 会拒绝删除。', true)
  if (!ok) return
  busy.value = true
  msg.value = ''
  try {
    const r = await window.sqlpilot.cloudUnitSpecDelete(cloud.activeId, s.id)
    if (!r.ok) { msg.value = r.error || '删除失败'; msgOk.value = false; return }
    pushNotice(`规格「${s.name}」已删除`)
    msg.value = `规格「${s.name}」已删除`
    msgOk.value = true
    await load()
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
/* 作为租户页的页内 tab 嵌入时，外层 .cm-body 已经有内边距，这里不再叠加 */
.tp-pane.embedded { padding: 0; }
.frow-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 9px; }
.frow { display: flex; flex-direction: column; gap: 4px; font-size: 10.5px; color: var(--text-dim); }
.tag { font-size: 9.5px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--border); color: var(--text-dim); margin-left: 5px; }
.tag.gray { color: var(--text-faint); }
.tag.info { color: var(--accent); border-color: var(--accent); }
.tag.warn { color: var(--yellow); border-color: var(--yellow); }
</style>
