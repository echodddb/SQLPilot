<template>
  <div class="um">
    <div class="um-head">
      <h2>Unit 配置 <span class="count">{{ rows.length }}</span></h2>
      <div class="filters">
        <select v-model.number="directTenant.adminScopeClusterId" @change="reload">
          <option :value="0" disabled>选择集群</option>
          <option v-for="c in scopes" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button class="create" :disabled="!platformId || creating" @click="formOpen = !formOpen">
          {{ formOpen ? '收起' : '＋ 新建规格' }}
        </button>
        <button class="ghost" :disabled="!platformId" @click="reload">刷新</button>
      </div>
    </div>

    <div v-if="!scopes.length" class="tip">还没有可管理的直连集群，请先在云管平台设置里接入。</div>
    <div v-else-if="!directTenant.adminScopeClusterId" class="tip">先选择集群——Unit 规格是按集群独立维护的。</div>

    <template v-else>
      <div v-if="formOpen" class="form">
        <div class="row">
          <label>规格名</label>
          <input v-model="form.name" placeholder="如 unit_s2" spellcheck="false" />
          <label>CPU</label>
          <input v-model.number="form.maxCpu" type="number" min="1" step="1" class="num" />
          <label>内存</label>
          <input v-model.number="form.maxMemoryMb" type="number" min="512" step="512" class="num" />
          <span class="unit">MB</span>
          <label>日志盘</label>
          <input v-model.number="form.logDiskMb" type="number" min="0" step="1024" class="num" />
          <span class="unit">MB</span>
          <button class="create" :disabled="!canSubmit" @click="submit">{{ creating ? '创建中…' : '创建' }}</button>
        </div>
        <div class="hint">
          内存与日志盘按当前实例的能力自动选择写法（老版本用 MEMORY_SIZE，新版本用 MIN/MAX_MEMORY）。
        </div>
      </div>

      <div v-if="msg" class="msg" :class="msgKind">{{ msg }}</div>

      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr><th>规格名</th><th class="r">CPU</th><th class="r">内存</th><th class="r">日志盘</th><th>类型</th><th class="r">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in rows" :key="u.name">
              <td class="mono">{{ u.name }}</td>
              <td class="r mono">{{ u.maxCpu }}</td>
              <td class="r mono">{{ mem(u.maxMemory) }}</td>
              <td class="r mono">{{ u.logDiskSize ? mem(u.logDiskSize) : '—' }}</td>
              <td><span class="pill" :class="u.system ? 'gray' : 'ok'">{{ u.system ? '系统' : '自定义' }}</span></td>
              <td class="r">
                <button class="del" :disabled="u.system || busyName === u.name" @click="remove(u.name)">删除</button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="6" class="empty">{{ loading ? '读取中…' : '该集群还没有 Unit 规格' }}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="foot">建租户时只能从这里的规格里选；被资源池占用的规格无法删除（OB 会拒绝）。</div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 直连模式的 Unit 规格管理（按集群独立）。
 *
 * 与 OCP 的 UnitSpecManager 无关：那边调 cloudUnitSpecs（OCP 接口），
 * 这边直接读 DBA_OB_UNIT_CONFIGS、用 CREATE/DROP RESOURCE UNIT 落库。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { directTenant, platformOfCluster, unitConfigsOf, createUnitConfig, dropUnitConfig } from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'

const props = defineProps<{ scopes: { id: number; name: string }[] }>()

const rows = ref<CloudDirectUnitConfig[]>([])
const loading = ref(false)
const busyName = ref('')
const creating = ref(false)
const formOpen = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err'>('ok')

const form = reactive({ name: '', maxCpu: 2, maxMemoryMb: 4096, logDiskMb: 10240 })

const platformId = computed(() => platformOfCluster(directTenant.adminScopeClusterId))
const canSubmit = computed(() => !!platformId.value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(form.name.trim()))

function mem(bytes: number): string {
  const b = Number(bytes) || 0
  if (!b) return '—'
  const gb = b / 1024 ** 3
  return gb >= 1 ? `${Math.round(gb * 10) / 10}G` : `${Math.round(b / 1024 ** 2)}M`
}

async function reload(): Promise<void> {
  msg.value = ''
  if (!platformId.value) {
    rows.value = []
    return
  }
  loading.value = true
  try {
    rows.value = await unitConfigsOf(platformId.value)
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (!platformId.value) return
  creating.value = true
  msg.value = ''
  try {
    const r = await createUnitConfig(platformId.value, {
      name: form.name.trim(),
      maxCpu: Number(form.maxCpu) || 1,
      minMemory: (Number(form.maxMemoryMb) || 512) * 1024 ** 2,
      maxMemory: (Number(form.maxMemoryMb) || 512) * 1024 ** 2,
      logDiskSize: (Number(form.logDiskMb) || 0) * 1024 ** 2
    })
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '创建失败'
      return
    }
    pushNotice(r.message || 'Unit 规格已创建')
    form.name = ''
    formOpen.value = false
    await reload()
  } finally {
    creating.value = false
  }
}

async function remove(name: string): Promise<void> {
  if (!platformId.value) return
  const ok = await window.sqlpilot.uiConfirm(`删除 Unit 规格「${name}」？`, '被资源池引用的规格无法删除，OB 会直接拒绝。', true)
  if (!ok) return
  busyName.value = name
  try {
    const r = await dropUnitConfig(platformId.value, name)
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '删除失败'
      return
    }
    await reload()
  } finally {
    busyName.value = ''
  }
}

/** 默认落到第一个集群：这两页不落到具体集群就是空页面 */
function pickDefaultScope(): boolean {
  if (!directTenant.adminScopeClusterId && props.scopes.length) {
    directTenant.adminScopeClusterId = props.scopes[0].id
    return true
  }
  return false
}

onMounted(() => {
  if (pickDefaultScope() || directTenant.adminScopeClusterId) void reload()
})

// 集群清单是父组件异步算出来的，可能晚于挂载
watch(
  () => props.scopes.length,
  () => {
    if (pickDefaultScope()) void reload()
  }
)
</script>

<style scoped>
.um { display: flex; flex-direction: column; gap: 10px; }
.um-head { display: flex; align-items: center; gap: 12px; }
.um-head h2 { margin: 0; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.count { font-size: 11px; color: var(--text-faint); font-weight: 400; }
.filters { margin-left: auto; display: flex; gap: 7px; align-items: center; }
select, input {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  padding: 5px 8px; font-size: 11.5px; font-family: inherit; outline: none;
}
select:focus, input:focus { border-color: var(--accent); }
.num { width: 84px; }
.unit { font-size: 11px; color: var(--text-faint); }
.create {
  border: 1px solid var(--accent); background: var(--accent-dim); color: var(--accent);
  border-radius: 7px; padding: 5px 11px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.create:disabled { opacity: 0.45; cursor: not-allowed; }
.ghost {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 5px 10px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.ghost:hover { color: var(--text); }
.form { border: 1px solid var(--border); background: var(--bg-card); border-radius: 9px; padding: 9px 11px; display: flex; flex-direction: column; gap: 6px; }
.form .row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.form label { font-size: 11px; color: var(--text-dim); }
.hint { font-size: 10.5px; color: var(--text-faint); }
.tip { font-size: 11.5px; color: var(--text-faint); background: var(--bg-input); border: 1px dashed var(--border); border-radius: 8px; padding: 14px; text-align: center; }
.msg { font-size: 11.5px; border-radius: 8px; padding: 7px 10px; }
.msg.ok { color: var(--green); background: var(--green-dim); }
.msg.err { color: var(--red); background: var(--red-dim); }
.table-wrap { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.tbl th, .tbl td { text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--border); }
.tbl th { font-size: 10.5px; color: var(--text-faint); font-weight: 500; background: var(--bg-card); }
.tbl tr:last-child td { border-bottom: none; }
.tbl .r { text-align: right; }
.tbl .empty { text-align: center; color: var(--text-faint); padding: 16px; }
.mono { font-family: var(--mono); }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-dim); }
.pill.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.del {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.del:hover:not(:disabled) { color: var(--red); border-color: var(--red); }
.del:disabled { opacity: 0.4; cursor: not-allowed; }
.foot { font-size: 10.5px; color: var(--text-faint); }
</style>
