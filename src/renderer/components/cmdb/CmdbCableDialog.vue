<template>
  <div class="cm-mask" @click.self="emit('close')">
    <div class="cm-dlg" style="width: 480px">
      <div class="cm-dlg-head">
        接线
        <span class="sub">选两端端口 + 网络类型，线在 3D 里按网络颜色显示</span>
        <button class="cm-close" @click="emit('close')">✕</button>
      </div>
      <div class="cm-dlg-body">
        <div class="cd-ends">
          <div class="cd-end">
            <b>{{ fromName }}</b>
            <select v-model="fromPort" class="cm-select">
              <option v-for="p in fromPorts" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </div>
          <span class="cd-arrow">⟶</span>
          <div class="cd-end">
            <b>{{ toName }}</b>
            <select v-model="toPort" class="cm-select">
              <option v-for="p in toPorts" :key="p.id" :value="p.id">{{ p.label }}</option>
            </select>
          </div>
        </div>

        <div class="cm-field">
          <span class="cm-label">网络类型（决定线色）</span>
          <div class="cd-nets">
            <button
              v-for="n in NETWORKS"
              :key="n.id"
              class="cd-net"
              :class="{ on: net === n.id }"
              :title="n.hint"
              @click="net = n.id"
            >
              <i :style="{ background: dark ? n.colorDark : n.color }"></i>{{ n.name }}
            </button>
          </div>
        </div>

        <label class="cm-field">
          <span class="cm-label">备注（可选）</span>
          <input v-model="label" class="cm-input" placeholder="如：bond0 → core-sw-01 GE1/0/1" />
        </label>

        <div v-if="error" class="cd-err">{{ error }}</div>
      </div>
      <div class="cm-dlg-foot">
        <span class="cm-hint">一个端口只能插一根线，接新线会顶掉旧线</span>
        <span class="spacer"></span>
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="saving" @click="submit">{{ saving ? '连接中…' : '连接' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { cm, saveCable, toast } from '../../cmdb/state'
import { NETWORKS } from '../../cmdb/dict'
import { portsOf } from '../../../main/cmdb-model'
import { isDarkTheme } from '../../cmdb/theme'

const props = defineProps<{ fromId: string; toId: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'done'): void }>()

const dark = isDarkTheme()
const saving = ref(false)
const error = ref('')
const net = ref<'biz' | 'backup' | 'storage' | 'mgmt' | 'private' | 'heartbeat' | 'other'>('biz')
const label = ref('')

const fromAsset = computed(() => cm.doc?.assets.find((a) => a.id === props.fromId))
const toAsset = computed(() => cm.doc?.assets.find((a) => a.id === props.toId))
const fromName = computed(() => fromAsset.value?.name || '?')
const toName = computed(() => toAsset.value?.name || '?')

/** 只列"接线用得到"的口：电口/光口优先，没有就退回全部（配线架只有电口） */
function wirePorts(assetId: string) {
  const a = cm.doc?.assets.find((x) => x.id === assetId)
  if (!a) return []
  const all = portsOf(a)
  const data = all.filter((p) => p.group === 'nic' || p.group === 'sfp')
  return data.length ? data : all
}

const fromPorts = computed(() => wirePorts(props.fromId))
const toPorts = computed(() => wirePorts(props.toId))
const fromPort = ref(fromPorts.value[0]?.id || 'nic-1')
const toPort = ref(toPorts.value[0]?.id || 'nic-1')

async function submit(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const r = await saveCable({
    fromId: props.fromId,
    fromPort: fromPort.value,
    toId: props.toId,
    toPort: toPort.value,
    net: net.value,
    label: label.value.trim() || undefined
  })
  saving.value = false
  if (r?.ok) {
    toast(`已接线：${fromName.value} → ${toName.value}`)
    emit('done')
    emit('close')
  } else {
    error.value = r?.error || '接线失败'
  }
}
</script>

<style scoped>
.cd-ends {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: end;
  gap: 10px;
}
.cd-end {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.cd-end b {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cd-arrow { color: var(--accent); font-size: 15px; padding-bottom: 5px; }
.cd-nets { display: flex; flex-wrap: wrap; gap: 5px; }
.cd-net {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 11.5px;
  padding: 4px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.cd-net i { width: 8px; height: 3px; border-radius: 2px; }
.cd-net:hover { border-color: var(--border-strong); color: var(--text); }
.cd-net.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: var(--accent-dim);
}
.cd-err { font-size: 11.5px; color: var(--red); }
</style>
