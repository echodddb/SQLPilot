<template>
  <div class="cpar">
    <div class="cp-head">
      <input v-model="q" class="search" placeholder="搜索参数名 / 租户 / 服务器" spellcheck="false" />
      <select v-model="tenant">
        <option value="">全部租户</option>
        <option v-for="t in tenants" :key="t" :value="t">{{ t }}</option>
      </select>
      <span class="count">{{ filtered.length }} / {{ rows.length }} 条</span>
      <button class="tb" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
    </div>

    <div v-if="msg" class="msg" :class="msgKind">{{ msg }}</div>
    <div v-if="error" class="err">{{ error }}</div>

    <div class="table-wrap">
      <table class="tbl">
        <thead data-src="clParams"><tr><th>参数</th><th>当前值</th><th>租户</th><th>Zone</th><th>Server</th><th>范围</th><th>可改</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in visible" :key="i" :class="{ editing: isEditing(r) }">
            <td class="mono" :title="r.info">{{ r.name }}</td>
            <td class="mono val">
              <input
                v-if="isEditing(r)"
                v-model="editValue"
                class="pedit mono"
                spellcheck="false"
                @keyup.enter="save(r)"
                @keyup.esc="edit = null"
              />
              <span v-else>{{ r.value }}</span>
            </td>
            <td class="dim">{{ r.tenant || '—' }}</td>
            <td class="dim">{{ r.zone || '—' }}</td>
            <td class="mono dim">{{ r.server }}</td>
            <td class="dim">{{ r.section }}</td>
            <td class="ops">
              <template v-if="isEditing(r)">
                <button class="mini primary" :disabled="saving" @click="save(r)">存</button>
                <button class="mini" :disabled="saving" @click="edit = null">取消</button>
              </template>
              <button v-else-if="r.editable" class="mini" title="修改该参数的值" @click="startEdit(r)">改</button>
              <span v-else class="pill gray">只读</span>
            </td>
          </tr>
          <tr v-if="!filtered.length"><td colspan="7" class="empty">{{ loading ? '读取中…' : '没有参数数据' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="filtered.length > visible.length" class="more">
      仅显示前 {{ visible.length }} 条，用搜索或租户筛选缩小范围
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 集群参数（只读展示 + 行内修改）。
 * OCP 返回的是 参数 × 租户 × 服务器 的展开值，这里拍平成可搜索表格；
 * 修改时按「参数名」提交给集群，OCP 会下发到该集群全部 OBServer（同名多行会一起变）。
 */
import { computed, onMounted, ref } from 'vue'
import { cloud, updateClusterParams } from '../../cloud/state'
import { pushNotice } from '../../store'

const props = defineProps<{ clusterId: number }>()

const rows = ref<CloudParamRow[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const msg = ref('')
const msgKind = ref<'ok' | 'err'>('ok')
const q = ref('')
const tenant = ref('')

/** 正在编辑的参数名 + 所在服务器（只有这一行显示输入框） */
const edit = ref<{ name: string; server: string } | null>(null)
const editValue = ref('')

const tenants = computed(() => [...new Set(rows.value.map((r) => r.tenant).filter(Boolean))].sort())
const filtered = computed(() => {
  const k = q.value.trim().toLowerCase()
  return rows.value.filter((r) => {
    if (tenant.value && r.tenant !== tenant.value) return false
    if (!k) return true
    return `${r.name} ${r.value} ${r.tenant} ${r.server}`.toLowerCase().includes(k)
  })
})
const visible = computed(() => filtered.value.slice(0, 300))

function isEditing(r: CloudParamRow): boolean {
  return edit.value?.name === r.name && edit.value?.server === r.server
}

function startEdit(r: CloudParamRow): void {
  msg.value = ''
  edit.value = { name: r.name, server: r.server }
  editValue.value = r.value
}

async function save(r: CloudParamRow): Promise<void> {
  const name = r.name
  const value = editValue.value.trim()
  if (value === '') { msgKind.value = 'err'; msg.value = '参数值不能为空'; return }
  if (value === r.value) { edit.value = null; return }
  const sameName = rows.value.filter((x) => x.name === name).length
  const ok = await window.sqlpilot.uiConfirm(
    `修改集群参数「${name}」？`,
    `新值：${value}\n将下发到该集群全部 OBServer${sameName > 1 ? `（该参数当前有 ${sameName} 条记录，会一起变更）` : ''}。部分参数需要重启生效。`
  )
  if (!ok) return
  saving.value = true
  try {
    const res = await updateClusterParams(props.clusterId, [{ name, value }])
    if (!res.ok) {
      msgKind.value = 'err'
      msg.value = `修改失败：${res.error || 'OCP 返回错误'}`
      return
    }
    msgKind.value = 'ok'
    msg.value = `已提交 ${name} = ${value}，OCP 会记录到参数变更历史`
    pushNotice(`集群参数「${name}」已提交修改`)
    edit.value = null
    await load()
  } finally {
    saving.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const r = await window.sqlpilot.cloudClusterParams(cloud.activeId, props.clusterId)
    if (!r.ok || !r.data) { error.value = r.error || '读取参数失败'; return }
    rows.value = r.data
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.cpar { display: flex; flex-direction: column; gap: 7px; }
.cp-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.search { width: 240px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 9px; outline: none; }
.search:focus { border-color: var(--accent); }
select { background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text); font-family: inherit; font-size: 12px; padding: 5px 8px; }
.count { font-size: 10.5px; color: var(--text-faint); }
.tb { margin-left: auto; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); border-radius: 7px; padding: 3px 9px; font-size: 11px; font-family: inherit; cursor: pointer; }
.tb:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.err { font-size: 11.5px; color: var(--red); background: var(--red-dim); border-radius: 7px; padding: 6px 9px; }
.msg { font-size: 11.5px; border-radius: 7px; padding: 6px 9px; }
.msg.ok { color: var(--green); background: var(--green-dim); }
.msg.err { color: var(--red); background: var(--red-dim); }
.table-wrap { border: 1px solid var(--border); border-radius: 10px; overflow: auto; max-height: 420px; background: var(--bg-card); }
.tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tbl th { text-align: left; font-weight: 500; font-size: 10.5px; color: var(--text-faint); padding: 7px 9px; background: var(--bg-input); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
.tbl td { padding: 6px 9px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl tbody tr:last-child td { border-bottom: none; }
.tbl tbody tr:hover { background: var(--bg-card-hover); }
.tbl tr.editing { background: var(--accent-dim); }
.val { color: var(--text); }
.pedit {
  width: 100%; min-width: 120px; background: var(--bg-side); border: 1px solid var(--accent);
  border-radius: 5px; color: var(--text); font-size: 11.5px; padding: 2px 6px; outline: none;
}
.ops { display: flex; gap: 4px; }
.mini {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 5px; font-size: 10.5px; padding: 1px 7px; cursor: pointer; font-family: inherit;
}
.mini.primary { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.mini:hover:not(:disabled) { filter: brightness(1.15); }
.mini:disabled { opacity: 0.5; cursor: not-allowed; }
.mono { font-family: var(--mono); }
.dim { color: var(--text-dim); }
.empty { text-align: center; color: var(--text-faint); padding: 18px !important; }
.more { font-size: 10.5px; color: var(--text-faint); }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 99px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim); }
.pill.gray { color: var(--text-faint); }
</style>
