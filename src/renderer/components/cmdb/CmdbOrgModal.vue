<template>
  <div class="cm-mask" @click.self="emit('close')">
    <div class="cm-dlg" style="width: min(760px, calc(100vw - 80px))">
      <div class="cm-dlg-head">
        组织管理
        <span class="sub">客户与机房是两个独立维度：一个机房可以同时服务多个客户</span>
        <button class="cm-close" @click="emit('close')">✕</button>
      </div>

      <div class="co-tabs">
        <button v-for="t in tabs" :key="t.id" class="co-tab" :class="{ on: tab === t.id }" @click="switchTab(t.id)">
          {{ t.name }}<span class="co-n">{{ countOf(t.id) }}</span>
        </button>
      </div>

      <div class="cm-dlg-body co-body">
        <div class="co-list">
          <button class="cm-mini" style="margin-bottom: 6px" @click="newItem">＋ 新增{{ tabName }}</button>
          <div
            v-for="it in items"
            :key="it.id"
            class="co-item"
            :class="{ on: form.id === it.id }"
            @click="edit(it)"
          >
            <span v-if="tab === 'customer'" class="co-dot" :style="{ background: it.color || '#38bdf8' }"></span>
            <span class="co-item-name">{{ labelOf(it) }}</span>
            <span class="co-item-sub">{{ subOf(it) }}</span>
          </div>
          <div v-if="!items.length" class="cm-hint" style="padding: 8px 2px">还没有{{ tabName }}</div>
        </div>

        <div class="co-form">
          <template v-if="tab === 'customer'">
            <div class="cm-grid2">
              <label class="cm-field">
                <span class="cm-label">客户名称<i class="req">*</i></span>
                <input v-model="form.name" class="cm-input" placeholder="如 某银行 / 某运营商" />
              </label>
              <label class="cm-field">
                <span class="cm-label">代号</span>
                <input v-model="form.code" class="cm-input" placeholder="BANK-A" />
              </label>
            </div>
            <div class="cm-grid2">
              <label class="cm-field">
                <span class="cm-label">标识色（图谱里区分客户）</span>
                <div class="co-color">
                  <input v-model="form.color" class="cm-input mono" placeholder="#38bdf8" />
                  <input v-model="form.color" type="color" class="co-picker" />
                </div>
              </label>
              <label class="cm-field">
                <span class="cm-label">联系人</span>
                <input v-model="form.contact" class="cm-input" />
              </label>
            </div>
          </template>

          <template v-else-if="tab === 'idc'">
            <div class="cm-grid2">
              <label class="cm-field">
                <span class="cm-label">机房名称<i class="req">*</i></span>
                <input v-model="form.name" class="cm-input" placeholder="如 上海外高桥 IDC1" />
              </label>
              <label class="cm-field">
                <span class="cm-label">区域</span>
                <input v-model="form.region" class="cm-input" placeholder="华东 / 华北" />
              </label>
            </div>
            <div class="cm-grid2">
              <label class="cm-field">
                <span class="cm-label">地址</span>
                <input v-model="form.address" class="cm-input" />
              </label>
              <label class="cm-field">
                <span class="cm-label">房间 / 楼层</span>
                <input v-model="form.room" class="cm-input" placeholder="3F-A 区" />
              </label>
            </div>
            <div class="cm-grid3">
              <label class="cm-field">
                <span class="cm-label">地面 横向格数</span>
                <input v-model.number="form.cols" class="cm-input" type="number" min="4" max="40" />
              </label>
              <label class="cm-field">
                <span class="cm-label">纵向格数</span>
                <input v-model.number="form.rows" class="cm-input" type="number" min="4" max="40" />
              </label>
              <label class="cm-field">
                <span class="cm-label">单格边长（mm）</span>
                <input v-model.number="form.tileMm" class="cm-input" type="number" min="300" max="1200" step="100" />
              </label>
            </div>
            <div class="co-tip">
              地板按正方形格子铺：{{ form.cols || 8 }} × {{ form.rows || 6 }} 格 =
              {{ Math.round(((form.cols || 8) * (form.tileMm || 600)) / 100) }} × {{ Math.round(((form.rows || 6) * (form.tileMm || 600)) / 100) }} 米。
              机柜默认占 1 格宽 × 2 格深（600×1200）。
            </div>
          </template>

          <template v-else>
            <div class="cm-grid3">
              <label class="cm-field">
                <span class="cm-label">所属机房<i class="req">*</i></span>
                <select v-model="form.idcId" class="cm-select">
                  <option value="" disabled>— 选择机房 —</option>
                  <option v-for="d in idcs" :key="d.id" :value="d.id">{{ d.name }}</option>
                </select>
              </label>
              <label class="cm-field">
                <span class="cm-label">机柜编号<i class="req">*</i></span>
                <input v-model="form.code" class="cm-input" placeholder="A-12" />
              </label>
              <label class="cm-field">
                <span class="cm-label">总 U 数</span>
                <input v-model.number="form.uTotal" class="cm-input" type="number" min="1" max="60" />
              </label>
            </div>
            <div class="cm-grid3">
              <label class="cm-field">
                <span class="cm-label">宽（mm）</span>
                <input v-model.number="form.widthMm" class="cm-input" type="number" min="300" max="900" step="50" />
              </label>
              <label class="cm-field">
                <span class="cm-label">深（mm）</span>
                <input v-model.number="form.depthMm" class="cm-input" type="number" min="300" max="1400" step="50" />
              </label>
              <label class="cm-field">
                <span class="cm-label">额定功率（kW）</span>
                <input v-model.number="form.powerKw" class="cm-input" type="number" min="0" max="100" step="0.5" />
              </label>
            </div>
            <div class="cm-grid3">
              <label class="cm-field">
                <span class="cm-label">落位 列（0 基）</span>
                <input v-model.number="form.gridCol" class="cm-input" type="number" min="0" max="39" placeholder="留空自动排" />
              </label>
              <label class="cm-field">
                <span class="cm-label">落位 排（0 基）</span>
                <input v-model.number="form.gridRow" class="cm-input" type="number" min="0" max="39" placeholder="留空自动排" />
              </label>
              <label class="cm-field">
                <span class="cm-label">列 / 排（文字备注）</span>
                <input v-model="form.row" class="cm-input" placeholder="A 列 第 2 排" />
              </label>
            </div>
            <div class="co-tip">落位留空就自动排（每排 2 格柜 + 1 格通道）；也可以在 3D 视图里直接拖。</div>
          </template>

          <label class="cm-field">
            <span class="cm-label">备注</span>
            <textarea v-model="form.note" class="cm-textarea" rows="2" />
          </label>

          <div v-if="error" class="co-err">{{ error }}</div>
        </div>
      </div>

      <div class="cm-dlg-foot">
        <button v-if="form.id" class="btn ghost" style="color: var(--red)" @click="remove">删除</button>
        <span class="spacer"></span>
        <button class="btn ghost" @click="emit('close')">关闭</button>
        <button class="btn primary" :disabled="saving || !form.name && !form.code" @click="submit">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { cm, customers, deleteCustomer, deleteIdc, deleteRack, idcs, racks, saveCustomer, saveIdc, saveRack, toast } from '../../cmdb/state'

const props = defineProps<{ tab: 'customer' | 'idc' | 'rack'; itemId?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const tabs = [
  { id: 'customer' as const, name: '客户' },
  { id: 'idc' as const, name: '机房' },
  { id: 'rack' as const, name: '机柜' }
]
const tab = ref<'customer' | 'idc' | 'rack'>(props.tab)
const tabName = computed(() => tabs.find((t) => t.id === tab.value)?.name || '')
const saving = ref(false)
const error = ref('')

const blank = (): any => ({
  id: '', name: '', code: '', color: '', contact: '', region: '', address: '', room: '',
  idcId: cm.filter.idcId || idcs.value[0]?.id || '',
  cols: 8, rows: 6, tileMm: 600,
  uTotal: 42, widthMm: 600, depthMm: 1200, powerKw: undefined,
  gridCol: undefined, gridRow: undefined,
  row: '', note: ''
})
const form = reactive<any>(blank())

const items = computed(() => {
  if (tab.value === 'customer') return customers.value
  if (tab.value === 'idc') return idcs.value
  return racks.value
})

function countOf(id: string): number {
  if (id === 'customer') return customers.value.length
  if (id === 'idc') return idcs.value.length
  return racks.value.length
}

function labelOf(it: any): string {
  if (tab.value === 'rack') return it.code
  return it.name
}
function subOf(it: any): string {
  if (tab.value === 'customer') return it.code || ''
  if (tab.value === 'idc') {
    const n = racks.value.filter((r) => r.idcId === it.id).length
    return `${it.region || '—'} · ${n} 柜`
  }
  const d = idcs.value.find((x) => x.id === it.idcId)
  const n = (cm.doc?.assets || []).filter((a) => a.rackId === it.id && !a.deletedAt).length
  return `${d?.name || '—'} · ${n} 台`
}

function switchTab(t: 'customer' | 'idc' | 'rack'): void {
  tab.value = t
  newItem()
}

function newItem(): void {
  Object.assign(form, blank())
  if (tab.value === 'rack' && !form.idcId) form.idcId = idcs.value[0]?.id || ''
  error.value = ''
}

function edit(it: any): void {
  Object.assign(form, blank(), { ...it })
  if (tab.value === 'rack') form.uTotal = it.uTotal || 42
  error.value = ''
}

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const payload: any = { ...form, id: form.id || undefined }
  let r: any
  if (tab.value === 'customer') r = await saveCustomer(payload)
  else if (tab.value === 'idc') r = await saveIdc(payload)
  else r = await saveRack(payload)
  saving.value = false
  if (r?.ok && r.value) {
    Object.assign(form, blank(), { ...r.value })
    cm.busy = ''
  } else if (r === null) {
    error.value = '保存失败，看下方提示'
  }
}

async function remove(): Promise<void> {
  if (!form.id) return
  const kind = tabName.value
  const ok = await window.sqlpilot.uiConfirm(
    `删除${kind}「${labelOf(form)}」？`,
    tab.value === 'customer'
      ? '该客户下的资产不会被删除，只会变成「未归属」'
      : tab.value === 'idc'
        ? '机柜会一并删除，资产保留记录但位置被清空'
        : '机柜里的资产会变成「未上架」',
    true
  )
  if (!ok) return
  const fn = tab.value === 'customer' ? deleteCustomer : tab.value === 'idc' ? deleteIdc : deleteRack
  const r = await fn(form.id)
  if (r?.ok) newItem()
}

// 打开时：优先定位到调用方指定的条目（从 3D 里双击机柜进来），否则给第一条或空白表单
const focused = props.itemId ? items.value.find((x: any) => x.id === props.itemId) : null
if (focused) edit(focused)
else if (!items.value.length) newItem()
else if (props.tab === 'customer') edit(customers.value[0])
</script>

<style scoped>
.co-tabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-side);
}
.co-tab {
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-family: inherit;
  font-size: 12px;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.co-tab:hover { color: var(--text-dim); }
.co-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
.co-n { margin-left: 5px; font-size: 10px; opacity: 0.7; }
.co-body {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 14px;
  align-items: start;
}
.co-list {
  border-right: 1px solid var(--border);
  padding-right: 10px;
  max-height: 340px;
  overflow: auto;
}
.co-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-dim);
}
.co-item:hover { background: var(--bg-card-hover); color: var(--text); }
.co-item.on { background: var(--accent-dim); color: var(--accent); }
.co-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.co-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.co-item-sub { font-size: 10.5px; color: var(--text-faint); }
.co-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 220px;
}
.co-color { display: flex; gap: 6px; }
.co-picker {
  width: 34px;
  height: 30px;
  padding: 2px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  cursor: pointer;
}
.co-err { font-size: 11.5px; color: var(--red); }
.co-tip {
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-faint);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 6px 8px;
}
.mono { font-family: var(--mono); }
</style>
