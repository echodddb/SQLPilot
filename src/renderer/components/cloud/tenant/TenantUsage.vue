<template>
  <div class="tp-pane">
    <!-- Oracle 租户没有 /databases（400），表级用量取不到；官方「资源」tab 对 Oracle 也基本是空的 -->
    <div v-if="!caps.dbManagement" class="empty">
      <div class="tag">ORACLE</div>
      <h4 class="tp-h">Oracle 租户暂无表用量排行</h4>
      <div class="tp-note" style="text-align:center;max-width:540px">
        表用量来自 OCP 的 <code class="tp-mono">/tenants/{tid}/database/{db}</code>，Oracle 租户不支持该接口。
        如需看 Oracle 租户的空间占用，请到「SQL 编辑器」连 root@sys 查 <code class="tp-mono">DBA_SEGMENTS</code>。
      </div>
    </div>

    <template v-else>
      <div class="tp-bar">
        <h4 class="tp-h">表用量 TOP <span class="cnt">{{ filtered.length }}</span></h4>
        <select v-model="dbPick" class="tp-select" style="width:170px">
          <option value="">全部数据库</option>
          <option v-for="x in dbs" :key="x.name" :value="x.name">{{ x.name }}</option>
        </select>
        <input v-model="q" class="tp-input tp-search" placeholder="过滤表名 / 库名" spellcheck="false" />
        <span class="sp"></span>
        <span v-if="loading" class="tp-note">已扫 {{ scanned }} / {{ dbs.length }} 个库…</span>
        <button class="tp-btn" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
      </div>
      <div v-if="err" class="tp-err">{{ err }}</div>
      <div v-if="warn" class="tp-warn">{{ warn }}</div>

      <div class="tp-tbl-wrap tp-scroll-y" data-src="tnUsage" :data-tenant="d.tenant.name">
        <table class="tp-tbl">
          <thead>
            <tr><th style="width:34%">表</th><th>库</th><th class="r">数据量</th><th class="r">行数</th><th class="r">分区</th><th style="width:22%">占比</th></tr>
          </thead>
          <tbody>
            <tr v-for="t in filtered" :key="`${t.db}.${t.name}`">
              <td class="tp-mono ell" :title="t.name">{{ t.name }}</td>
              <td class="tp-dim">{{ t.db }}</td>
              <td class="r tp-mono">{{ fmtBytes(t.size) }}</td>
              <td class="r tp-mono">{{ t.rows.toLocaleString() }}</td>
              <td class="r tp-mono">{{ t.partitions }}</td>
              <td>
                <div class="tp-bar-meter"><i :style="{ width: pct(t.size) }"></i></div>
              </td>
            </tr>
            <tr v-if="!filtered.length"><td colspan="6" class="tp-empty">{{ loading ? '读取中…' : '没有表数据' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="tp-note">
        官方「资源」tab 是 库/Schema → 表组 → 表 → 分区 四级钻取，但 OCP 4.3 的这一组接口没有在文档里公开
        （按 /usage、/topTables、/resource 等 14 个候选路径实测全部落回 SPA）。这里用
        <code class="tp-mono">/database/{db}</code> 汇总出**表级**用量排行，够定位大表；分区级需要官方接口或直连 SQL。
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/** 资源（表用量 TOP）：把各库的表统计汇总成一张排行表 */
import { computed, onMounted, ref, watch } from 'vue'
import { cloud } from '../../../cloud/state'
import { fmtBytes } from '../../../cloud/parts'
import { tenantCaps } from '../../../cloud/tenantMode'

const props = defineProps<{ reloadToken: number }>()
const d = computed(() => cloud.tenant as CloudTenantDetail)
const caps = computed(() => tenantCaps(d.value?.tenant?.mode))

interface Row { name: string; db: string; size: number; rows: number; partitions: number }

const dbs = ref<CloudTenantDatabase[]>([])
const rows = ref<Row[]>([])
const loading = ref(false)
const scanned = ref(0)
const err = ref('')
const warn = ref('')
const q = ref('')
const dbPick = ref('')

const totalSize = computed(() => rows.value.reduce((s, r) => s + r.size, 0))

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  let list = rows.value
  if (dbPick.value) list = list.filter((r) => r.db === dbPick.value)
  if (k) list = list.filter((r) => `${r.db}.${r.name}`.toLowerCase().includes(k))
  return list.slice(0, 300)
})

function pct(size: number): string {
  const total = totalSize.value
  if (!total) return '0%'
  return `${Math.max(1, Math.round((size / total) * 100))}%`
}

async function load(): Promise<void> {
  loading.value = true
  err.value = ''
  warn.value = ''
  rows.value = []
  scanned.value = 0
  try {
    const t = d.value.tenant
    const rd = await window.sqlpilot.cloudTenantDbs(cloud.activeId, t.clusterId, t.id)
    if (!rd.ok) { err.value = rd.error || '读取库列表失败'; return }
    dbs.value = rd.data || []
    const failed: string[] = []
    // 每个库一次请求；3 个并发，避免把 OCP 打满
    const queue = [...dbs.value]
    const out: Row[] = []
    async function worker(): Promise<void> {
      for (;;) {
        const db = queue.shift()
        if (!db) return
        const r = await window.sqlpilot.cloudTenantTables(cloud.activeId, t.clusterId, t.id, db.name)
        scanned.value++
        if (!r.ok || !r.data) { failed.push(db.name); continue }
        for (const tb of r.data.tables) {
          out.push({ name: tb.name, db: db.name, size: Number(tb.size) || 0, rows: Number(tb.rows) || 0, partitions: Number(tb.partitions) || 0 })
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    out.sort((a, b) => b.size - a.size)
    rows.value = out
    if (failed.length) warn.value = `${failed.length} 个库的表统计读取失败：${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}`
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.reloadToken, load)
</script>

<style scoped>
.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 60px 20px; }
.tag { font-size: 10px; letter-spacing: 0.14em; color: var(--yellow); border: 1px solid color-mix(in srgb, var(--yellow) 45%, transparent); background: var(--yellow-dim); border-radius: 99px; padding: 2px 9px; }
</style>
