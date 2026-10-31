<template>
  <div class="cm-mask" @click.self="emit('close')">
    <div class="cm-dlg" style="width: min(700px, calc(100vw - 80px))">
      <div class="cm-dlg-head">
        纳管与导入
        <span class="sub">只增不改：已存在的资产不会被覆盖，最多补 OS / 状态</span>
        <button class="cm-close" @click="emit('close')">✕</button>
      </div>

      <div class="cm-dlg-body">
        <section class="cs-sec">
          <div class="cs-title">从 SSH 服务器注册表纳管</div>
          <div class="cm-hint">把「服务器」模块里已有的机器一次性登记成资产，自动关联，之后详情页能直接开终端。</div>
          <div class="cm-grid3" style="margin-top: 8px">
            <label class="cm-field">
              <span class="cm-label">归到客户<i class="req">*</i></span>
              <select v-model="serverForm.customerId" class="cm-select">
                <option value="" disabled>— 选择 —</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="cm-field">
              <span class="cm-label">机房</span>
              <select v-model="serverForm.idcId" class="cm-select">
                <option value="">— 未指定 —</option>
                <option v-for="d in idcs" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
            </label>
            <div class="cs-act">
              <button class="cm-mini" :disabled="!serverForm.customerId || busy" @click="previewServers">预览</button>
              <button class="btn primary" :disabled="!serverPlan || busy" @click="applyServers">确认纳管</button>
            </div>
          </div>
          <div v-if="serverPlan" class="cs-plan">{{ planText(serverPlan) }}</div>
          <div v-if="serverMsg" class="cs-msg">{{ serverMsg }}</div>
        </section>

        <section class="cs-sec">
          <div class="cs-title">从云管平台纳管</div>
          <div class="cm-hint">读取平台主机列表（OCP / Oracle 直连），生成资产草稿；云上 IP、OS、Agent 状态会带过来。</div>
          <div class="cm-grid3" style="margin-top: 8px">
            <label class="cm-field">
              <span class="cm-label">平台</span>
              <select v-model="cloudForm.platformId" class="cm-select">
                <option value="" disabled>— 选择平台 —</option>
                <option v-for="p in platforms" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </label>
            <label class="cm-field">
              <span class="cm-label">归到客户<i class="req">*</i></span>
              <select v-model="cloudForm.customerId" class="cm-select">
                <option value="" disabled>— 选择 —</option>
                <option v-for="c in customers" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="cm-field">
              <span class="cm-label">机房</span>
              <select v-model="cloudForm.idcId" class="cm-select">
                <option value="">— 未指定 —</option>
                <option v-for="d in idcs" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
            </label>
          </div>
          <div class="cs-row">
            <button class="cm-mini" :disabled="!cloudForm.platformId || !cloudForm.customerId || busy" @click="previewCloud">预览</button>
            <button class="btn primary" :disabled="!cloudPlan || busy" @click="applyCloud">确认纳管</button>
            <span v-if="!platforms.length" class="cm-hint">还没有配置云管平台（「云管平台」模块里添加）</span>
          </div>
          <div v-if="cloudPlan" class="cs-plan">{{ planText(cloudPlan) }}</div>
          <div v-if="cloudMsg" class="cs-msg">{{ cloudMsg }}</div>
        </section>

        <section class="cs-sec">
          <div class="cs-title">备份与批量导入</div>
          <div class="cs-row">
            <button class="cm-mini" @click="exportJson">导出 JSON 备份</button>
            <button class="cm-mini" @click="importJson">从 JSON 恢复（整体替换）</button>
            <button class="cm-mini" @click="exportCsv">导出资产 CSV</button>
            <button class="cm-mini" @click="importCsv">从 CSV 导入</button>
          </div>
          <div class="cm-hint" style="margin-top: 6px">
            CSV 表头：客户, 机房, 机柜, U位, 类型, 名称, 主机名, IP, 序列号, 厂商, 型号, OS, 状态, 负责人, 标签, 备注。
            客户/机房/机柜不存在时会自动创建，避免"少一个客户整批导入失败"。
          </div>
        </section>
      </div>

      <div class="cm-dlg-foot">
        <span class="cm-hint">台账文件：{{ cm.file || 'userData/cmdb/cmdb.json' }}</span>
        <span class="spacer"></span>
        <button class="btn ghost" @click="emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { cm, customers, idcs, toast } from '../../cmdb/state'

const emit = defineEmits<{ (e: 'close'): void }>()

const busy = ref(false)
const platforms = ref<any[]>([])

const serverForm = reactive({ customerId: cm.filter.customerId || '', idcId: cm.filter.idcId || '' })
const cloudForm = reactive({ platformId: '', customerId: cm.filter.customerId || '', idcId: cm.filter.idcId || '' })

const serverPlan = ref<any>(null)
const cloudPlan = ref<any>(null)
const serverMsg = ref('')
const cloudMsg = ref('')

onMounted(async () => {
  try {
    const list = await window.sqlpilot.cloudPlatforms()
    platforms.value = Array.isArray(list) ? list : []
  } catch { platforms.value = [] }
})

function planText(p: any): string {
  return `共 ${p.total} 台主机：新增 ${p.creates}，更新 ${p.updates}，已存在跳过 ${p.skipped}`
}

async function previewServers(): Promise<void> {
  busy.value = true
  serverMsg.value = ''
  const r = await window.sqlpilot.cmdbSyncServers(serverForm.customerId, serverForm.idcId, false)
  busy.value = false
  if (r?.ok) serverPlan.value = r.preview
  else {
    serverPlan.value = null
    serverMsg.value = r?.error || '预览失败'
  }
}

async function applyServers(): Promise<void> {
  busy.value = true
  const r = await window.sqlpilot.cmdbSyncServers(serverForm.customerId, serverForm.idcId, true)
  busy.value = false
  if (r?.ok && r.doc) {
    cm.doc = r.doc
    serverPlan.value = null
    serverMsg.value = `纳管完成：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}`
    toast('服务器纳管完成')
  } else serverMsg.value = r?.error || '纳管失败'
}

async function previewCloud(): Promise<void> {
  busy.value = true
  cloudMsg.value = ''
  const r = await window.sqlpilot.cmdbSyncCloud(cloudForm.platformId, cloudForm.customerId, cloudForm.idcId, false)
  busy.value = false
  if (r?.ok) cloudPlan.value = r.preview
  else {
    cloudPlan.value = null
    cloudMsg.value = r?.error || '预览失败'
  }
}

async function applyCloud(): Promise<void> {
  busy.value = true
  const r = await window.sqlpilot.cmdbSyncCloud(cloudForm.platformId, cloudForm.customerId, cloudForm.idcId, true)
  busy.value = false
  if (r?.ok && r.doc) {
    cm.doc = r.doc
    cloudPlan.value = null
    cloudMsg.value = `纳管完成：新增 ${r.created}，更新 ${r.updated}，跳过 ${r.skipped}`
    toast('云平台纳管完成')
  } else cloudMsg.value = r?.error || '纳管失败'
}

async function exportJson(): Promise<void> {
  const r = await window.sqlpilot.cmdbExportJson()
  if (r.ok) toast(`已导出到 ${r.path}`)
  else if (!r.canceled) toast(r.error || '导出失败', 'bad')
}

async function importJson(): Promise<void> {
  const ok = await window.sqlpilot.uiConfirm('从 JSON 恢复会整体替换当前台账', '当前台账里的客户/机房/资产/关系都会被覆盖，建议先导出一份备份。', true)
  if (!ok) return
  const r = await window.sqlpilot.cmdbImportJson()
  if (r.ok && r.doc) {
    cm.doc = r.doc
    toast('台账已恢复')
  } else if (!r.canceled) toast(r.error || '导入失败', 'bad')
}

async function exportCsv(): Promise<void> {
  const r = await window.sqlpilot.cmdbExportCsv()
  if (r.ok) toast(`已导出 ${r.count} 项到 ${r.path}`)
  else if (!r.canceled) toast(r.error || '导出失败', 'bad')
}

async function importCsv(): Promise<void> {
  const r = await window.sqlpilot.cmdbImportCsv()
  if (r.ok && r.doc) {
    cm.doc = r.doc
    const v = r.value
    toast(v ? `导入完成：新增 ${v.created}，跳过 ${v.skipped}` : '导入完成')
    if (v?.errors?.length) toast(v.errors.slice(0, 2).join('；'), 'bad')
  } else if (!r.canceled) toast(r.error || '导入失败', 'bad')
}

const total = computed(() => cm.doc?.assets.filter((a) => !a.deletedAt).length || 0)
</script>

<style scoped>
.cs-sec {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--bg-input);
}
.cs-title { font-size: 12.5px; color: var(--text); margin-bottom: 4px; }
.cs-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.cs-act { display: flex; align-items: flex-end; gap: 6px; }
.cs-plan {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--accent);
  background: var(--accent-dim);
  border-radius: 5px;
  padding: 5px 8px;
}
.cs-msg { margin-top: 6px; font-size: 11.5px; color: var(--text-dim); }
</style>
