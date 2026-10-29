<template>
  <!-- pe-mask：从本弹窗内部还会打开「新建连接 / 新建服务器」子弹窗，本项目属性必须让位 -->
  <div class="modal-mask pe-mask" @click.self="$emit('close')">
    <div class="modal pe-modal">
      <h3>
        <span>项目属性</span>
        <span class="badge blue">{{ form.name || '未命名项目' }}</span>
        <span style="flex: 1"></span>
        <span class="pe-stat">数据库 {{ selectedConns.length }} · 服务器 {{ form.serverIds.length }}</span>
      </h3>

      <!-- 主体独立滚动：关联项一多时窗口不会被顶出屏幕，底部按钮始终可点 -->
      <div class="pe-body">
        <div class="frow">
          <div class="fitem"><label>项目名称</label><input type="text" v-model="form.name" /></div>
          <div class="fitem" style="flex: 2"><label>项目文件夹（只读）</label><input type="text" :value="form.rootPath" readonly style="opacity:.7" /></div>
        </div>
        <div class="frow">
          <div class="fitem">
            <label>项目说明（注入 AI 提示词：环境说明、注意事项，如"生产环境，写操作前必须备份"）</label>
            <textarea v-model="form.description" rows="2" style="width:100%" placeholder="例如：核心业务库生产环境。数据库改动需走变更流程；服务器为 CentOS，Oracle 19c 部署在 /u01/app"></textarea>
          </div>
        </div>

        <!-- 数据库：与服务器一致的勾选式关联，按分组文件夹展示 -->
        <div class="sec-title">
          <b>数据库</b>
          <span class="sec-hint">默认不关联；勾选才挂到本项目（AI 优先使用，未勾选仍全局可用）</span>
          <span style="flex: 1"></span>
          <button class="mini-btn" title="新建数据库连接（默认不关联项目；建好后在本页勾选即可关联）" @click="openConnModal()">＋ 新建连接</button>
        </div>
        <div class="pick-box">
          <div v-if="!conns.length" class="pick-empty">还没有数据库连接。点右上「＋ 新建连接」添加，或在「数据库」模块里管理。</div>
          <template v-else>
            <div v-for="g in connGroups" :key="'db-' + g.name" class="pick-group">
              <div class="pick-ghead" @click="toggleGroup('db', g.name)">
                <span class="caret" :class="{ closed: groupClosed('db', g.name) }">▾</span>
                <span class="gicon">▣</span>
                <span class="gname">{{ g.name }}</span>
                <span class="gcount">{{ groupChecked(g.items, selectedConns) }}/{{ g.items.length }}</span>
              </div>
              <template v-if="!groupClosed('db', g.name)">
                <label v-for="c in g.items" :key="c.id" class="pick-item" :title="`${c.user}@${c.host}:${c.port}`">
                  <input type="checkbox" :value="c.id" v-model="selectedConns" />
                  <span class="pick-ico">🗄</span>
                  <span class="pick-main">
                    <span class="pick-name">{{ c.name }}</span>
                    <span class="pick-sub">{{ TYPE_LABELS[c.type] || c.type }} · {{ c.role === 'readonly' ? 'RO' : 'RW' }} · {{ c.user }}@{{ c.host }}:{{ c.port }}</span>
                  </span>
                  <span v-if="otherProjectOf(c)" class="pick-badge" :title="`已关联到「${otherProjectOf(c)}」，勾选后会改挂到本项目`">属 {{ otherProjectOf(c) }}</span>
                  <span v-else-if="c.projectId === form.id" class="pick-badge on">本项目</span>
                </label>
              </template>
            </div>
          </template>
        </div>

        <!-- SSH 服务器：引用全局清单，同样按分组展示 -->
        <div class="sec-title">
          <b>SSH 远程服务器</b>
          <span class="sec-hint">勾选引用全局清单（服务器在左侧「服务器」模块维护）</span>
          <span style="flex: 1"></span>
          <button class="mini-btn" title="新建 SSH 服务器（全局注册，项目按需引用）" @click="openServerModal()">＋ 新建服务器</button>
        </div>
        <div class="pick-box">
          <div v-if="!servers.length" class="pick-empty">
            还没有可引用的服务器。点右上「＋ 新建服务器」添加（SSH 密码 / 私钥认证，口令 DPAPI 加密存储）。
          </div>
          <template v-else>
            <div v-for="g in serverGroups" :key="'srv-' + g.name" class="pick-group">
              <div class="pick-ghead" @click="toggleGroup('srv', g.name)">
                <span class="caret" :class="{ closed: groupClosed('srv', g.name) }">▾</span>
                <span class="gicon">▣</span>
                <span class="gname">{{ g.name }}</span>
                <span class="gcount">{{ groupChecked(g.items, form.serverIds) }}/{{ g.items.length }}</span>
              </div>
              <template v-if="!groupClosed('srv', g.name)">
                <label v-for="s in g.items" :key="s.id" class="pick-item" :title="`${s.user}@${s.host}:${s.port}${s.note ? `\n${s.note}` : ''}`">
                  <input type="checkbox" :value="s.id" v-model="form.serverIds" />
                  <span class="pick-ico">🖥</span>
                  <span class="pick-main">
                    <span class="pick-name">{{ s.name }}</span>
                    <span class="pick-sub">{{ s.user }}@{{ s.host }}:{{ s.port }}{{ s.tag ? ` · ${s.tag}` : '' }}</span>
                  </span>
                  <span v-if="s.tag" class="pick-badge" :class="{ prod: s.tag === '生产' }">{{ s.tag }}</span>
                </label>
              </template>
            </div>
          </template>
        </div>
      </div>

      <div class="actions">
        <span v-if="saveHint" class="save-hint">{{ saveHint }}</span>
        <span style="flex: 1"></span>
        <button class="btn ghost" :disabled="saving" @click="$emit('close')">取消</button>
        <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存项目' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref } from 'vue'
import { store, toPlain, TYPE_LABELS } from '../store'
import { bucketByFolder, connGroupFolders, serverGroupFolders } from '../grouping'

const props = defineProps<{ project: any }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()
const openServerModal = inject<(s?: any) => void>('openServerModal')!
const openConnModal = inject<(c?: any) => void>('openConnModal')!

const form = reactive({
  id: props.project.id,
  name: props.project.name,
  rootPath: props.project.rootPath,
  description: props.project.description || '',
  // 服务器已全局注册，项目只存引用 id（兼容未迁移的内联定义：兜底从 servers 映射）
  serverIds: Array.isArray(props.project.serverIds)
    ? [...props.project.serverIds]
    : (props.project.servers || []).map((s: any) => s.id)
})

/** 勾选的数据库连接：保存时才写回连接上的 projectId（取消 = 不改动任何连接） */
const selectedConns = ref<string[]>(
  ((store.cfg?.connections || []) as any[]).filter((c) => c.projectId === form.id).map((c) => c.id)
)

const conns = computed(() => (store.cfg?.connections || []) as any[])
const servers = computed(() => (store.cfg?.servers || []) as any[])

/** 分组文件夹（空分组不展示：关联面板里空文件夹只是噪音） */
const connGroups = computed(() =>
  bucketByFolder(connGroupFolders(), conns.value, {
    sort: (a: any, b: any) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }),
    keepEmpty: false
  })
)
const serverGroups = computed(() =>
  bucketByFolder(serverGroupFolders(), servers.value, {
    sort: (a: any, b: any) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }),
    keepEmpty: false
  })
)

// ---------- 分组折叠（纯 UI 状态，弹窗关掉即丢，不需要持久化） ----------
const closedGroups = reactive(new Set<string>())
function groupClosed(section: 'db' | 'srv', name: string): boolean {
  return closedGroups.has(`${section}:${name}`)
}
function toggleGroup(section: 'db' | 'srv', name: string): void {
  const key = `${section}:${name}`
  if (closedGroups.has(key)) closedGroups.delete(key)
  else closedGroups.add(key)
}
function groupChecked(items: any[], selected: string[]): number {
  const set = new Set(selected)
  return items.filter((i) => set.has(i.id)).length
}

/** 该连接已关联到别的项目：勾选会把它改挂过来，需要显式提示 */
function otherProjectOf(c: any): string {
  const pid = c.projectId
  if (!pid || pid === form.id) return ''
  return (store.cfg?.projects || []).find((p: any) => p.id === pid)?.name || '其它项目'
}

const saving = ref(false)
const saveHint = ref('')

async function save() {
  if (!form.name.trim()) { await window.sqlpilot.uiAlert('项目名称必填'); return }
  saving.value = true
  saveHint.value = ''
  try {
    const r = await window.sqlpilot.saveProject(toPlain({ ...form, description: form.description.trim() || undefined }))
    if (!r.ok) {
      await window.sqlpilot.uiAlert((r as any).error || '保存失败')
      return
    }
    // 连接归属按勾选结果逐个写回：勾上→挂到本项目，取消→解除（原属其它项目的会被改挂）
    const want = new Set(selectedConns.value)
    const errors: string[] = []
    for (const c of conns.value) {
      const checked = want.has(c.id)
      const boundHere = c.projectId === form.id
      if (checked === boundHere) continue
      const res = await window.sqlpilot.saveConn(toPlain({ ...c, projectId: checked ? form.id : null }))
      if (!res.ok) errors.push(`${c.name}: ${res.error || '保存失败'}`)
    }
    store.cfg = await window.sqlpilot.getConfig()
    if (errors.length) {
      // 项目本身已保存成功；连接保存失败要明确告诉用户是哪几条，别让弹窗直接关掉
      saveHint.value = `项目已保存，但 ${errors.length} 个连接未更新`
      await window.sqlpilot.uiAlert(`项目已保存，以下连接关联失败：\n${errors.join('\n')}`)
      return
    }
    emit('saved')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
/* 弹窗放大：关联项要按分组平铺，680px 会把「类型 · 账号 · 地址」挤成两行 */
.pe-mask { z-index: 90; }
.pe-modal {
  /* 固定尺寸：宽高都写死，关联项多少、分组展开/折叠都不改外框（避免"点一下分组弹窗就跳一下"）。
     小窗口用 max-* 兜底，保证不超出视口；内容在 .pe-body 内部滚动。 */
  width: 920px;
  height: 720px;
  max-width: 95vw;
  max-height: 90vh;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 20px 22px 16px;
}
.pe-modal h3 { margin-bottom: 12px; }
.pe-stat { font-size: 11.5px; font-weight: 400; color: var(--text-faint); }

/* 主体滚动区：内容超出弹窗高度时在这里滚动，底部「保存」永远可见 */
.pe-body { flex: 1; min-height: 0; overflow-y: auto; padding-right: 6px; scrollbar-width: thin; }

.frow { display: flex; gap: 10px; margin-bottom: 10px; }
.fitem { flex: 1; min-width: 0; }
.fitem label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }

.sec-title { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 14px 0 8px; color: var(--text); }
.sec-title b { color: var(--accent); flex-shrink: 0; }
.sec-hint { font-size: 11px; color: var(--text-faint); }
.mini-btn {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 2px 9px; cursor: pointer; flex-shrink: 0; font-family: inherit;
}
.mini-btn:hover { color: var(--accent); border-color: var(--accent); }

/* 勾选面板：外框 + 内部分组，组内条目纵向排列。
   不在面板内部再套滚动条——整块主体（.pe-body）统一滚动，避免出现两层滚动区域 */
.pick-box {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-input);
  padding: 4px 6px 6px;
}
.pick-empty { padding: 14px 10px; font-size: 11.5px; color: var(--text-faint); line-height: 1.7; }
.pick-group + .pick-group { margin-top: 2px; }
.pick-ghead {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 7px; cursor: pointer; user-select: none;
  font-size: 11px; color: var(--text-faint); letter-spacing: .4px;
}
.pick-ghead:hover { color: var(--text-dim); background: var(--bg-card-hover); }
.pick-ghead .caret { display: inline-block; transition: transform .15s ease; font-size: 9px; width: 9px; flex-shrink: 0; }
.pick-ghead .caret.closed { transform: rotate(-90deg); }
.pick-ghead .gicon { font-size: 9px; opacity: .8; }
.pick-ghead .gname { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-ghead .gcount { margin-left: auto; font-weight: 400; flex-shrink: 0; }

.pick-item {
  display: flex; align-items: center; gap: 8px;
  margin: 1px 0 1px 14px; padding: 4px 9px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-card); font-size: 12.5px; cursor: pointer;
  transition: border-color .14s ease, background .14s ease;
}
.pick-item:hover { border-color: var(--accent); }
.pick-item input[type='checkbox'] { flex-shrink: 0; }
.pick-ico { font-size: 12px; flex-shrink: 0; }
.pick-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pick-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-sub {
  font-size: 10.5px; color: var(--text-faint); font-family: var(--mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pick-badge {
  flex-shrink: 0; font-size: 9.5px; padding: 1px 6px; border-radius: 99px;
  background: var(--bg-card-hover); color: var(--text-dim);
}
.pick-badge.on { background: var(--accent-dim); color: var(--accent); }
.pick-badge.prod { background: var(--red-dim); color: var(--red); }

.actions { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
.save-hint { font-size: 11.5px; color: var(--yellow); }
</style>
