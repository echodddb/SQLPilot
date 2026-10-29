<template>
  <div class="pm">
    <div class="pm-head">
      <h2>资源池 <span class="count">{{ rows.length }}</span></h2>
      <div class="filters">
        <select v-model.number="directTenant.adminScopeClusterId" @change="reload">
          <option :value="0" disabled>选择集群</option>
          <option v-for="c in scopes" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <button class="create" :disabled="!platformId || creating" @click="formOpen = !formOpen">
          {{ formOpen ? '收起' : '＋ 新建资源池' }}
        </button>
        <button class="ghost" :disabled="!platformId" @click="reload">刷新</button>
      </div>
    </div>

    <div v-if="!scopes.length" class="tip">还没有可管理的直连集群，请先在云管平台设置里接入。</div>
    <div v-else-if="!directTenant.adminScopeClusterId" class="tip">先选择集群——资源池归属于具体集群。</div>

    <template v-else>
      <div v-if="formOpen" class="form">
        <div class="row">
          <label>池名</label>
          <input v-model="form.name" placeholder="如 pool_app" spellcheck="false" />
          <label>Unit 规格</label>
          <select v-model="form.unitConfigName" :disabled="!specs.length">
            <option v-for="u in specs" :key="u.name" :value="u.name">
              {{ u.name }} · {{ u.maxCpu }}C / {{ mem(u.maxMemory) }}
            </option>
            <option v-if="!specs.length" value="">先到「Unit 配置」建规格</option>
          </select>
          <label>每 Zone Unit 数</label>
          <input v-model.number="form.unitCount" type="number" min="1" step="1" class="num" />
        </div>
        <div class="row">
          <label>承载 Zone</label>
          <label v-for="z in zones" :key="z" class="zchk">
            <input type="checkbox" :checked="form.zoneList.includes(z)" @change="toggleZone(z)" />
            {{ z }}
          </label>
          <span v-if="!zones.length" class="dim">读取不到 Zone 列表</span>
          <button class="create" :disabled="!canSubmit" @click="submit">{{ creating ? '创建中…' : '创建池' }}</button>
        </div>
        <div class="hint">池只决定「规格 + 每 Zone Unit 数 + 承载 Zone」；建租户时再从这里的空闲池中挑一个。</div>
      </div>

      <div v-if="msg" class="msg" :class="msgKind">{{ msg }}</div>

      <div class="table-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>资源池</th><th>绑定租户</th><th>Unit 规格</th>
              <th class="r">Unit 数</th><th>Zone 列表</th><th>状态</th><th class="r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in rows" :key="p.id">
              <td class="mono">{{ p.name }}</td>
              <td>
                <span v-if="p.tenantName" class="pill info">{{ p.tenantName }}</span>
                <span v-else class="pill idle">未绑定</span>
              </td>
              <td class="mono">{{ p.unitConfigName || '—' }}</td>
              <td class="r mono">{{ p.unitCount }}</td>
              <td class="mono dim ellipsis" :title="p.zoneList">{{ p.zoneList || '—' }}</td>
              <td class="dim">{{ p.status || '—' }}</td>
              <td class="r">
                <button
                  class="del"
                  :disabled="p.tenantId > 0 || busyName === p.name"
                  :title="p.tenantId > 0 ? '仍绑定租户，需先删除租户' : '删除该资源池'"
                  @click="remove(p)"
                >
                  删除
                </button>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="7" class="empty">{{ loading ? '读取中…' : '该集群没有资源池' }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="foot">
        删租户（DROP TENANT）<b>不会</b>自动回收资源池：池会留下来继续占用 Unit 规格。
        要释放规格，先确认这里显示「未绑定」，再删除池，最后才能删规格。
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 直连模式的资源池管理（按集群）。
 *
 * 两件事：
 *   1) 建池——池的生命周期独立于租户，建租户时只挑空闲池（不再用 Unit 现组一个池）；
 *   2) 删池——DROP TENANT 不会回收资源池，残留池会一直占用 Unit 规格，导致规格删不掉。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  directTenant,
  platformOfCluster,
  resourcePoolsOf,
  dropResourcePool,
  createResourcePool,
  unitConfigsOf,
  type DirectResourcePool
} from '../../../cloud/directTenant'
import { pushNotice } from '../../../store'

const props = defineProps<{ scopes: { id: number; name: string }[] }>()

const rows = ref<DirectResourcePool[]>([])
const specs = ref<CloudDirectUnitConfig[]>([])
const zones = ref<string[]>([])
const loading = ref(false)
const creating = ref(false)
const busyName = ref('')
const formOpen = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err'>('ok')

const form = reactive({ name: '', unitConfigName: '', unitCount: 1, zoneList: [] as string[] })

const platformId = computed(() => platformOfCluster(directTenant.adminScopeClusterId))
const canSubmit = computed(
  () => !!platformId.value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(form.name.trim()) && !!form.unitConfigName && form.zoneList.length > 0
)

function mem(bytes: number): string {
  const b = Number(bytes) || 0
  if (!b) return '—'
  const gb = b / 1024 ** 3
  return gb >= 1 ? `${Math.round(gb * 10) / 10}G` : `${Math.round(b / 1024 ** 2)}M`
}

function toggleZone(z: string): void {
  const i = form.zoneList.indexOf(z)
  if (i >= 0) form.zoneList.splice(i, 1)
  else form.zoneList.push(z)
  form.zoneList.sort((a, b) => zones.value.indexOf(a) - zones.value.indexOf(b))
}

/** 规格与 Zone 都按当前集群取，切集群要重新拉 */
async function loadMeta(): Promise<void> {
  const pid = platformId.value
  const cid = directTenant.adminScopeClusterId
  if (!pid || !cid) {
    specs.value = []
    zones.value = []
    return
  }
  specs.value = (await unitConfigsOf(pid)).filter((u) => !u.system)
  form.unitConfigName = form.unitConfigName || specs.value[0]?.name || ''

  const r = await window.sqlpilot.cloudCluster(pid, cid)
  zones.value = r.ok && r.data ? (r.data.zones || []).map((z: any) => z.name) : []
  if (!form.zoneList.length) form.zoneList = [...zones.value]
}

async function reload(): Promise<void> {
  msg.value = ''
  formOpen.value = false
  if (!platformId.value) {
    rows.value = []
    return
  }
  loading.value = true
  try {
    rows.value = await resourcePoolsOf(platformId.value)
    await loadMeta()
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (!platformId.value) return
  creating.value = true
  msg.value = ''
  try {
    const r = await createResourcePool(platformId.value, {
      name: form.name.trim(),
      unitConfigName: form.unitConfigName,
      unitCount: Math.max(1, Number(form.unitCount) || 1),
      zoneList: [...form.zoneList]
    })
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '创建失败'
      return
    }
    pushNotice('资源池已创建')
    form.name = ''
    formOpen.value = false
    await reload()
  } finally {
    creating.value = false
  }
}

async function remove(p: DirectResourcePool): Promise<void> {
  if (!platformId.value || p.tenantId > 0) return
  const ok = await window.sqlpilot.uiConfirm(
    `删除资源池「${p.name}」？`,
    '直连模式直接执行 DROP RESOURCE POOL，无回滚。删除后该池占用的 Unit 规格才能被回收。',
    true
  )
  if (!ok) return
  busyName.value = p.name
  try {
    const r = await dropResourcePool(platformId.value, p.name)
    if (!r.ok) {
      msgKind.value = 'err'
      msg.value = r.error || '删除失败'
      return
    }
    pushNotice(`资源池 ${p.name} 已删除`)
    await reload()
  } finally {
    busyName.value = ''
  }
}

/** 默认落到第一个集群 */
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

watch(
  () => props.scopes.length,
  () => {
    if (pickDefaultScope()) void reload()
  }
)
</script>

<style scoped>
.pm { display: flex; flex-direction: column; gap: 10px; }
.pm-head { display: flex; align-items: center; gap: 12px; }
.pm-head h2 { margin: 0; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.count { font-size: 11px; color: var(--text-faint); font-weight: 400; }
.filters { margin-left: auto; display: flex; gap: 7px; align-items: center; }
select, input {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  padding: 5px 8px; font-size: 11.5px; font-family: inherit; outline: none;
}
select:focus, input:focus { border-color: var(--accent); }
.num { width: 84px; }
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
.form { border: 1px solid var(--border); background: var(--bg-card); border-radius: 9px; padding: 9px 11px; display: flex; flex-direction: column; gap: 7px; }
.form .row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.form label { font-size: 11px; color: var(--text-dim); }
.zchk { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); border: 1px solid var(--border); background: var(--bg-input); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
.zchk input { accent-color: var(--accent); }
.zchk:has(input:checked) { color: var(--accent); border-color: var(--accent); }
.hint, .dim { font-size: 10.5px; color: var(--text-faint); }
.tip { font-size: 11.5px; color: var(--text-faint); background: var(--bg-input); border: 1px dashed var(--border); border-radius: 8px; padding: 14px; text-align: center; }
.msg { font-size: 11.5px; border-radius: 8px; padding: 7px 10px; line-height: 1.6; }
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
.dim { color: var(--text-faint); }
.ellipsis { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { font-size: 10px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--border); color: var(--text-dim); }
.pill.info { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.pill.idle { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 40%, transparent); }
.del {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; font-size: 10.5px; font-family: inherit; cursor: pointer;
}
.del:hover:not(:disabled) { color: var(--red); border-color: var(--red); }
.del:disabled { opacity: 0.4; cursor: not-allowed; }
.foot { font-size: 10.5px; line-height: 1.8; color: var(--text-faint); }
.foot b { color: var(--yellow); font-weight: 600; }
</style>
