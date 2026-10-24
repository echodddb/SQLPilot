<template>
  <div class="tp-pane">
    <div class="tp-bar">
      <h4 class="tp-h">数据库 <span class="cnt">{{ dbs.length }}</span></h4>
      <input v-model="dbFilter" class="tp-input tp-search" placeholder="过滤库名" spellcheck="false" />
      <span class="sp"></span>
      <button class="tp-btn" :disabled="loading" @click="loadDbs">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>
    <div v-if="err" class="tp-err">{{ err }}</div>

    <div class="tp-panes-2">
      <!-- 库列表 -->
      <div class="tp-tbl-wrap tp-scroll-y" data-src="tnDatabases" :data-tenant="d.tenant.name">
        <table class="tp-tbl">
          <thead><tr><th>库名</th><th class="r">数据量</th><th>字符集</th></tr></thead>
          <tbody>
            <tr v-for="x in filteredDbs" :key="x.name" class="clickable" :class="{ on: x.name === activeDb }" @click="pickDb(x.name)">
              <td class="tp-mono">{{ x.name }}<span v-if="x.readonly" class="tp-chip" style="margin-left:6px">只读</span></td>
              <td class="r tp-mono">{{ fmtBytes(x.requiredSize) }}</td>
              <td class="tp-dim" style="font-size:10.5px">{{ x.charset }}</td>
            </tr>
            <tr v-if="!filteredDbs.length"><td colspan="3" class="tp-empty">{{ loading ? '读取中…' : '无数据' }}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 表列表 + 表结构 -->
      <div style="min-width:0;display:flex;flex-direction:column;gap:9px">
        <div class="tp-bar">
          <h4 class="tp-h">{{ activeDb || '选择左侧数据库' }} <span v-if="tables.length" class="cnt">{{ tables.length }}</span></h4>
          <input v-model="tblFilter" class="tp-input tp-search" placeholder="过滤表名" spellcheck="false" :disabled="!activeDb" />
          <span class="sp"></span>
          <span v-if="lastUpdate" class="tp-note">统计更新 {{ lastUpdate }}</span>
        </div>

        <div v-if="tblErr" class="tp-err">{{ tblErr }}</div>
        <div class="tp-tbl-wrap" style="max-height:34vh">
          <table class="tp-tbl">
            <thead data-src="tnTables"><tr><th>表名</th><th class="r">分区</th><th class="r">行数</th><th class="r">数据量</th><th class="r">宏块利用率</th></tr></thead>
            <tbody>
              <tr v-for="t in filteredTables" :key="t.id + t.name" class="clickable" :class="{ on: t.name === activeTable }" @click="pickTable(t.name)">
                <td class="tp-mono">{{ t.name }}</td>
                <td class="r tp-mono">{{ t.partitions }}</td>
                <td class="r tp-mono">{{ t.rows.toLocaleString() }}</td>
                <td class="r tp-mono">{{ fmtBytes(t.size) }}</td>
                <td class="r tp-mono">{{ t.macroBlockRatio }}%</td>
              </tr>
              <tr v-if="!filteredTables.length"><td colspan="5" class="tp-empty">{{ tblLoading ? '读取中…' : activeDb ? '该库没有表' : '先选一个库' }}</td></tr>
            </tbody>
          </table>
        </div>

        <template v-if="activeTable">
          <div class="tp-bar">
            <h4 class="tp-h">{{ activeTable }} 结构</h4>
            <span class="sp"></span>
            <button v-if="schema?.ddl" class="tp-btn sm" @click="copy(schema.ddl)">复制 DDL</button>
          </div>
          <div v-if="schemaErr" class="tp-err">{{ schemaErr }}</div>
          <div v-if="schema?.columns.length" class="tp-tbl-wrap" style="max-height:26vh">
            <table class="tp-tbl">
              <thead><tr><th>列名</th><th>类型</th><th>可空</th><th>默认值</th><th>备注</th></tr></thead>
              <tbody>
                <tr v-for="c in schema.columns" :key="c.name">
                  <td class="tp-mono">{{ c.name }}</td>
                  <td class="tp-mono tp-dim">{{ c.type }}</td>
                  <td>{{ c.nullable ? '是' : '否' }}</td>
                  <td class="tp-mono tp-dim">{{ c.def || '—' }}</td>
                  <td class="tp-dim">{{ c.comment || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <pre v-if="schema?.ddl" class="tp-code">{{ schema.ddl }}</pre>
          <div v-else-if="!schemaErr && !schema?.columns.length" class="tp-note">OCP 未返回该表的列信息（系统表常见），DDL 见上。</div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 库表：GET /tenants/{tid}/databases → /database/{db} → /obTableSchema
 * 表结构接口返回数组，createTableStr 是完整 DDL；columnList 对系统表可能为空。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtBytes } from '../../../cloud/parts'
import { pushNotice } from '../../../store'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)

const dbs = ref<CloudTenantDatabase[]>([])
const loading = ref(false)
const err = ref('')
const dbFilter = ref('')

const activeDb = ref('')
const tables = ref<CloudTenantTableList['tables']>([])
const lastUpdate = ref('')
const tblLoading = ref(false)
const tblErr = ref('')
const tblFilter = ref('')

const activeTable = ref('')
const schema = ref<CloudTenantTableSchema | null>(null)
const schemaErr = ref('')

const filteredDbs = computed(() => {
  const k = dbFilter.value.trim().toLowerCase()
  return k ? dbs.value.filter((x) => x.name.toLowerCase().includes(k)) : dbs.value
})
const filteredTables = computed(() => {
  const k = tblFilter.value.trim().toLowerCase()
  return k ? tables.value.filter((x) => x.name.toLowerCase().includes(k)) : tables.value
})

async function loadDbs(): Promise<void> {
  loading.value = true
  err.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantDbs(cloud.activeId, t.clusterId, t.id)
    if (!r.ok) { err.value = r.error || '读取库列表失败'; return }
    dbs.value = r.data || []
    if (!activeDb.value && dbs.value.length) await pickDb(dbs.value[0].name)
  } finally {
    loading.value = false
  }
}

async function pickDb(name: string): Promise<void> {
  activeDb.value = name
  activeTable.value = ''
  schema.value = null
  schemaErr.value = ''
  tblLoading.value = true
  tblErr.value = ''
  try {
    const t = d.value.tenant
    const r = await window.sqlpilot.cloudTenantTables(cloud.activeId, t.clusterId, t.id, name)
    if (!r.ok) { tblErr.value = r.error || '读取表列表失败'; tables.value = []; return }
    tables.value = r.data?.tables || []
    lastUpdate.value = r.data?.lastUpdateTime || ''
  } finally {
    tblLoading.value = false
  }
}

async function pickTable(name: string): Promise<void> {
  activeTable.value = name
  schema.value = null
  schemaErr.value = ''
  const t = d.value.tenant
  const r = await window.sqlpilot.cloudTenantTableSchema(cloud.activeId, t.clusterId, t.id, activeDb.value, name)
  if (!r.ok) { schemaErr.value = r.error || '读取表结构失败'; return }
  schema.value = r.data || null
}

async function copy(text: string): Promise<void> {
  await window.sqlpilot.writeClipboard(text)
  pushNotice('已复制到剪贴板')
}

onMounted(loadDbs)
watch(() => props.reloadToken, async () => {
  await loadDbs()
  if (activeDb.value) await pickDb(activeDb.value)
})
</script>
