<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="im">
      <div class="im-head">
        <span class="im-title">从 ~/.ssh/config 导入</span>
        <span style="flex:1"></span>
        <button class="im-x" @click="emit('close')">✕</button>
      </div>

      <div class="im-path">{{ path }}</div>

      <div v-if="loading" class="im-hint">读取中…</div>
      <div v-else-if="error" class="im-hint err">{{ error }}</div>
      <div v-else-if="!entries.length" class="im-hint">
        没有可导入的条目。文件不存在，或只有通配符 Host 段（如 <code>Host *</code>）。
      </div>

      <div v-else class="im-list">
        <label v-for="e in entries" :key="e.alias" class="im-item" :class="{ dup: e.duplicate }">
          <input type="checkbox" :value="e.alias" v-model="picked" :disabled="e.duplicate" />
          <span class="im-alias">{{ e.alias }}</span>
          <span class="im-target">{{ e.user ? e.user + '@' : '' }}{{ e.host }}:{{ e.port }}</span>
          <span v-if="e.identityFile" class="im-badge key" :title="e.identityFile">私钥</span>
          <span v-else class="im-badge pwd">密码</span>
          <span v-if="e.proxyJump" class="im-badge jump" :title="'ProxyJump ' + e.proxyJump">跳板</span>
          <span v-if="e.duplicate" class="im-dup">已存在</span>
        </label>
      </div>

      <div v-if="entries.length && !error" class="im-note">
        私钥认证的条目会带上私钥路径（若有口令，导入后需在会话里补填）；密码认证的条目导入后需补填密码。
        ProxyJump 的跳板主机也会一并导入，否则跳板关系会断。
      </div>

      <div class="im-foot">
        <button class="im-btn" :disabled="!entries.length" @click="toggleAll">{{ allPicked ? '全不选' : '全选' }}</button>
        <span style="flex:1"></span>
        <button class="im-btn" @click="emit('close')">取消</button>
        <button class="im-btn primary" :disabled="!picked.length || importing" @click="doImport">
          {{ importing ? '导入中…' : `导入 ${picked.length} 项` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { flash } from '../../server/state'

const emit = defineEmits<{ (e: 'close'): void; (e: 'imported'): void }>()

const path = ref('')
const entries = ref<SshConfigEntryView[]>([])
const picked = ref<string[]>([])
const loading = ref(true)
const error = ref('')
const importing = ref(false)

const allPicked = computed(() => entries.value.length > 0 && picked.value.length === entries.value.filter((e) => !e.duplicate).length)

onMounted(async () => {
  const r = await window.sqlpilot.importSshConfig()
  loading.value = false
  path.value = r.path
  error.value = r.error || ''
  entries.value = r.entries || []
  // 默认勾选全部非重复项
  picked.value = entries.value.filter((e) => !e.duplicate).map((e) => e.alias)
})

function toggleAll(): void {
  picked.value = allPicked.value ? [] : entries.value.filter((e) => !e.duplicate).map((e) => e.alias)
}

async function doImport(): Promise<void> {
  importing.value = true
  const list = entries.value.filter((e) => picked.value.includes(e.alias))
  // 先把 ProxyJump 涉及的别名做一张表，导入时尽量连成跳板关系
  const byAlias = new Map(entries.value.map((e) => [e.alias, e]))
  const nameOf = (alias: string) => `ssh:${alias}`
  const created: { alias: string; id: string }[] = []
  let failed = 0

  // 两遍：先建主机（不带 jumpId），再补跳板引用——否则被依赖的跳板还没 id
  for (const e of list) {
    const id = `srv_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`
    const payload: any = {
      id,
      name: nameOf(e.alias),
      host: e.host,
      port: e.port,
      user: e.user || 'root',
      group: 'ssh config',
      auth: e.identityFile ? 'key' : 'password',
      keyPath: e.identityFile || undefined
    }
    const r = await window.sqlpilot.saveServer(payload, undefined, undefined)
    if (r.ok) created.push({ alias: e.alias, id })
    else failed++
  }

  // 补跳板：只连"跳板也在本次导入集合里"的情况，外部跳板留给用户手选
  for (const c of created) {
    const e = byAlias.get(c.alias)
    if (!e?.proxyJump) continue
    const jumpAlias = e.proxyJump.split(',')[0].split('@').pop() || ''
    const jump = created.find((x) => x.alias === jumpAlias)
    if (!jump) continue
    const src = entries.value.find((x) => x.alias === c.alias)!
    await window.sqlpilot.saveServer(
      {
        id: c.id,
        name: nameOf(c.alias),
        host: src.host,
        port: src.port,
        user: src.user || 'root',
        group: 'ssh config',
        auth: src.identityFile ? 'key' : 'password',
        keyPath: src.identityFile || undefined,
        jumpId: jump.id
      },
      undefined,
      undefined
    )
  }

  importing.value = false
  flash(failed ? `导入完成，${failed} 项失败（可能是重名）` : `已导入 ${created.length} 个会话`)
  emit('imported')
  emit('close')
}
</script>

<style scoped>
.im {
  width: 720px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-card); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: var(--shadow-lg); overflow: hidden;
}
.im-head { display: flex; align-items: center; padding: 12px 16px 8px; }
.im-title { font-size: 14px; font-weight: 600; color: var(--text); }
.im-x { border: none; background: none; color: var(--text-faint); cursor: pointer; font-size: 13px; font-family: inherit; }
.im-path { padding: 0 16px 10px; font-family: var(--mono); font-size: 11px; color: var(--text-faint); }
.im-hint { padding: 20px 16px; font-size: 12.5px; color: var(--text-faint); line-height: 1.7; }
.im-hint.err { color: var(--red); }
.im-list { flex: 1; overflow-y: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.im-item {
  display: flex; align-items: center; gap: 9px; padding: 6px 16px;
  font-size: 12.5px; color: var(--text-dim); cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
}
.im-item:hover { background: var(--bg-card-hover); }
.im-item.dup { opacity: .55; }
.im-alias { font-weight: 600; color: var(--text); min-width: 130px; font-family: var(--mono); }
.im-target { flex: 1; font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); }
.im-badge { font-size: 9.5px; padding: 1px 6px; border-radius: 99px; }
.im-badge.key { background: var(--green-dim); color: var(--green); }
.im-badge.pwd { background: var(--yellow-dim); color: var(--yellow); }
.im-badge.jump { background: var(--accent-dim); color: var(--accent); }
.im-dup { font-size: 10.5px; color: var(--text-faint); }
.im-note { padding: 9px 16px; font-size: 11px; color: var(--text-faint); line-height: 1.7; }
.im-foot { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 1px solid var(--border); }
.im-btn {
  border: 1px solid var(--border); background: var(--bg-side); color: var(--text-dim);
  border-radius: 7px; padding: 5px 15px; font-size: 12.5px; cursor: pointer; font-family: inherit;
}
.im-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.im-btn:disabled { opacity: .5; cursor: default; }
.im-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
