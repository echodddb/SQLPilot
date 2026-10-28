<template>
  <aside class="ss">
    <div class="ss-head">
      <input v-model="srv.filter" class="ss-search" placeholder="搜索名称 / 地址 / 分组" spellcheck="false" />
      <button class="ss-add" title="新建会话" @click="emit('new')">＋</button>
    </div>

    <div class="ss-tools">
      <button class="ss-tool" title="从 ~/.ssh/config 导入" @click="emit('import')">导入配置</button>
      <button class="ss-tool" :class="{ on: srv.prefsOpen }" title="终端外观与交互偏好" @click="emit('prefs')">终端偏好</button>
      <button class="ss-tool new-grp" title="新建分组文件夹" @click="startNewGroup">＋分组</button>
    </div>

    <div class="ss-list">
      <div v-if="creating" class="ss-gnew">
        <input
          ref="newInput"
          v-model="newName"
          class="ss-ginput"
          placeholder="分组名，回车创建"
          spellcheck="false"
          @keydown.enter="commitNew"
          @keydown.esc="cancelNew"
          @blur="commitNew"
        />
      </div>

      <div v-if="!groups.length" class="ss-empty">
        <div class="ss-empty-t">还没有服务器</div>
        <div class="ss-empty-d">点右上角「＋」新建，或从 ~/.ssh/config 导入。想先分好类可以点「＋分组」建文件夹，再把会话拖进去。</div>
      </div>

      <div v-for="g in groups" :key="g.name" class="ss-group">
        <div v-if="renaming === g.name" class="ss-ghead editing">
          <input
            :ref="setRenameInput"
            v-model="renameName"
            class="ss-ginput"
            spellcheck="false"
            @keydown.enter="commitRename(g.name)"
            @keydown.esc="cancelRename"
            @blur="commitRename(g.name)"
          />
        </div>
        <button
          v-else
          class="ss-ghead"
          :class="{ 'drop-on': dropTarget === g.name }"
          :title="g.virtual ? '没有分组的会话' : '右键可重命名/删除分组，拖会话进来即可归组'"
          @click="toggleGroup(g.name)"
          @contextmenu.prevent="showGroupMenu($event, g)"
          @dragover.prevent="onDragOver(g.name)"
          @dragleave="onDragLeave($event, g.name)"
          @drop.stop.prevent="onDrop(g.name)"
        >
          <span class="ss-caret" :class="{ closed: srv.collapsed[g.name] }">▾</span>
          <span class="ss-gicon" :class="{ virtual: g.virtual }">{{ g.virtual ? '·' : '▣' }}</span>
          <span class="ss-gname">{{ g.name }}</span>
          <span class="ss-gcount">{{ g.items.length }}</span>
        </button>
        <template v-if="!srv.collapsed[g.name]">
          <div
            v-for="s in g.items"
            :key="s.id"
            class="ss-item"
            :class="{ active: isActive(s.id), open: openCount(s.id) > 0, dragging: dragId === s.id }"
            :title="`${s.user}@${s.host}:${s.port}`"
            draggable="true"
            @dragstart="onDragStart($event, s)"
            @dragend="onDragEnd"
            @click="emit('open', s)"
            @dblclick="emit('open', s, true)"
            @contextmenu.prevent="showMenu($event, s)"
          >
            <span v-if="colorOf(s)" class="ss-bar" :style="{ background: colorOf(s) }" :title="colorSource(s)"></span>
            <span class="ss-dot" :class="{ live: openCount(s.id) > 0 }"></span>
            <span class="ss-main">
              <span class="ss-name">{{ s.name }}</span>
              <span class="ss-sub">{{ s.user }}@{{ s.host }}{{ s.port && s.port !== 22 ? ':' + s.port : '' }}</span>
            </span>
            <span v-if="s.jumpId" class="ss-badge" title="经跳板机">跳</span>
            <span v-if="s.tag" class="ss-badge" :class="{ prod: s.tag === '生产' }">{{ s.tag }}</span>
            <span v-if="openCount(s.id)" class="ss-tabs">{{ openCount(s.id) }}</span>
          </div>
        </template>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="menu" class="ctx-mask" @mousedown.self="menu = null" @contextmenu.prevent="menu = null">
        <div class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
          <button class="ctx-item" @click="run('open')">打开终端</button>
          <button class="ctx-item" @click="run('tab')">新建标签</button>
          <button class="ctx-item" @click="run('sftp')">打开 SFTP</button>
          <div class="ctx-sep"></div>
          <div class="ctx-label">移动到分组</div>
          <div class="ctx-chips">
            <button
              v-for="f in foldersForMove()"
              :key="f"
              class="ctx-chip"
              :class="{ on: (menu?.server.group || UNGROUPED) === f }"
              @click="moveTo(f)"
            >{{ f }}</button>
            <button class="ctx-chip add" title="新建分组并移入" @click="moveToNew">＋新建…</button>
          </div>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="run('edit')">编辑会话…</button>
          <button class="ctx-item" @click="run('dup')">复制会话</button>
          <button class="ctx-item" @click="run('copy')">复制连接串</button>
          <button class="ctx-item" @click="run('forgetKey')">忘记主机密钥</button>
          <div class="ctx-sep"></div>
          <button class="ctx-item danger" @click="run('del')">删除会话</button>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="gmenu" class="ctx-mask" @mousedown.self="gmenu = null" @contextmenu.prevent="gmenu = null">
        <div class="ctx" :style="{ left: gmenu.x + 'px', top: gmenu.y + 'px' }">
          <div class="ctx-label">{{ gmenu.group.name }}</div>
          <button class="ctx-item" @click="runGroup('newServer')">在此分组新建会话</button>
          <template v-if="!gmenu.group.virtual">
            <div class="ctx-sep"></div>
            <button class="ctx-item" @click="runGroup('rename')">重命名分组…</button>
            <button class="ctx-item danger" @click="runGroup('del')">删除分组</button>
          </template>
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="runGroup('toggle')">{{ srv.collapsed[gmenu.group.name] ? '展开' : '收起' }}</button>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { SshServerCfg } from '../../../main/types'
import { store } from '../../store'
import { srv, servers, flash, serverGroups, UNGROUPED } from '../../server/state'
import { colorOf, colorSource } from '../../server/colors'

const emit = defineEmits<{
  (e: 'open', server: SshServerCfg, newTab?: boolean): void
  (e: 'new', group?: string): void
  (e: 'import'): void
  (e: 'prefs'): void
  (e: 'edit', server: SshServerCfg): void
  (e: 'deleted'): void
  (e: 'sftp'): void
  (e: 'refresh'): void
}>()

interface Group { name: string; items: SshServerCfg[]; virtual?: boolean }

const byName = (a: SshServerCfg, b: SshServerCfg) =>
  a.name.localeCompare(b.name, 'zh-CN', { numeric: true })

const groups = computed<Group[]>(() => {
  const q = srv.filter.trim().toLowerCase()
  const list = servers().filter((s) => {
    if (!q) return true
    return [s.name, s.host, s.user, s.group, s.tag, s.note].filter(Boolean).join(' ').toLowerCase().includes(q)
  })
  const bucket = new Map<string, SshServerCfg[]>()
  for (const s of list) {
    const g = (s.group || '').trim() || UNGROUPED
    if (!bucket.has(g)) bucket.set(g, [])
    bucket.get(g)!.push(s)
  }
  // 文件夹顺序跟着配置走（= 用户创建顺序），空文件夹也留着
  const out: Group[] = serverGroups().map((name) => ({ name, items: (bucket.get(name) || []).slice().sort(byName) }))
  // 搜索时只留有命中的文件夹：找机器的时候不想看一堆空文件夹
  const visible = q ? out.filter((g) => g.items.length) : out
  const rest = bucket.get(UNGROUPED) || []
  if (rest.length) visible.push({ name: UNGROUPED, items: rest.slice().sort(byName), virtual: true })
  return visible
})

function toggleGroup(name: string): void {
  srv.collapsed[name] = !srv.collapsed[name]
}

function openCount(serverId: string): number {
  return srv.tabs.filter((t) => t.serverId === serverId).length
}

function isActive(serverId: string): boolean {
  const t = srv.tabs.find((x) => x.id === srv.activeId)
  return !!t && t.serverId === serverId
}

// ---------- 新建 / 重命名分组 ----------
const creating = ref(false)
const newName = ref('')
const newInput = ref<HTMLInputElement | null>(null)
const renaming = ref<string | null>(null)
const renameName = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
/** 「＋新建…」从会话右键进来的：建完分组顺手把这个会话放进去 */
const pendingMoveId = ref<string | null>(null)

/** v-for 里的 ref 会被收集成数组，这里用函数 ref 只留当前那一个输入框 */
function setRenameInput(el: any): void {
  if (el) renameInput.value = el as HTMLInputElement
}

function startNewGroup(): void {
  creating.value = true
  newName.value = ''
  nextTick(() => newInput.value?.focus())
}

function cancelNew(): void {
  creating.value = false
  newName.value = ''
  pendingMoveId.value = null
}

async function commitNew(): Promise<void> {
  if (!creating.value) return // blur 与回车会连着触发，第二次直接吞掉
  const name = newName.value.trim()
  const moveId = pendingMoveId.value
  pendingMoveId.value = null
  creating.value = false
  if (!name) return
  const ok = await createGroup(name, !!moveId)
  if (ok && moveId) await moveIds([moveId], name)
}

async function createGroup(name: string, quiet: boolean): Promise<boolean> {
  const r = await window.sqlpilot.saveServerGroup(name)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '创建分组失败')
    return false
  }
  await reload()
  if (!quiet) flash(`已创建分组「${r.name || name}」`)
  return true
}

function startRename(name: string): void {
  renaming.value = name
  renameName.value = name
  nextTick(() => renameInput.value?.focus())
}

function cancelRename(): void {
  renaming.value = null
  renameName.value = ''
}

async function commitRename(oldName: string): Promise<void> {
  if (renaming.value !== oldName) return
  const name = renameName.value.trim()
  renaming.value = null
  renameName.value = ''
  if (!name || name === oldName) return
  const r = await window.sqlpilot.saveServerGroup(name, oldName)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '重命名失败')
    return
  }
  // 折叠状态跟着改名走，否则改完分组会自己展开
  if (srv.collapsed[oldName] !== undefined) {
    srv.collapsed[name] = srv.collapsed[oldName]
    delete srv.collapsed[oldName]
  }
  await reload()
  flash(r.moved ? `分组改名为「${name}」，${r.moved} 个会话已同步` : `分组改名为「${name}」`)
}

/**
 * 重新拉配置。分组改动是主进程连带给服务器改 group 字段的，必须等新配置回来再渲染，
 * 否则会出现"分组建好了但会话还在旧组里"的中间态。
 */
async function reload(): Promise<void> {
  try {
    store.cfg = await window.sqlpilot.getConfig()
  } catch { /* 保留旧配置 */ }
  emit('refresh')
}

// ---------- 拖拽归组 ----------
const dragId = ref<string | null>(null)
const dropTarget = ref<string | null>(null)

function onDragStart(e: DragEvent, s: SshServerCfg): void {
  dragId.value = s.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // 某些平台不带数据就不发 drop，塞个 id 最省事
    e.dataTransfer.setData('text/plain', s.id)
  }
}

function onDragEnd(): void {
  dragId.value = null
  dropTarget.value = null
}

function onDragOver(name: string): void {
  if (!dragId.value) return
  dropTarget.value = name
}

function onDragLeave(e: DragEvent, name: string): void {
  // 在分组头内部的 span 之间移动不算离开，否则高亮会闪
  const to = e.relatedTarget as Node | null
  if (to && (e.currentTarget as HTMLElement)?.contains(to)) return
  if (dropTarget.value === name) dropTarget.value = null
}

async function onDrop(name: string): Promise<void> {
  const id = dragId.value
  dropTarget.value = null
  dragId.value = null
  if (!id) return
  await moveIds([id], name)
}

async function moveIds(ids: string[], group: string): Promise<void> {
  const target = group === UNGROUPED ? '' : group
  // 已经在目标分组里就别白写一次配置
  const hits = servers().filter((s) => ids.includes(s.id))
  if (hits.length && hits.every((s) => (s.group || '') === target)) return
  const r = await window.sqlpilot.moveServersToGroup(ids, target)
  if (!r.ok) {
    await window.sqlpilot.uiAlert(r.error || '移动失败')
    return
  }
  await reload()
  flash(target ? `已移到「${target}」（${r.moved} 个会话）` : `已移出分组（${r.moved} 个会话）`)
}

// ---------- 会话右键菜单 ----------
const menu = ref<{ x: number; y: number; server: SshServerCfg } | null>(null)

function showMenu(e: MouseEvent, s: SshServerCfg): void {
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - 230),
    y: Math.min(e.clientY, window.innerHeight - 380),
    server: s
  }
}

/** 「移动到分组」可选目标：现有文件夹 + 未分组 */
function foldersForMove(): string[] {
  return [...serverGroups(), UNGROUPED]
}

async function moveTo(group: string): Promise<void> {
  const m = menu.value
  menu.value = null
  if (!m) return
  await moveIds([m.server.id], group)
}

/** 新建分组 + 移入：不能弹 window.prompt（Electron 渲染层不支持），走侧栏顶部那个内联输入框 */
function moveToNew(): void {
  const m = menu.value
  menu.value = null
  if (!m) return
  pendingMoveId.value = m.server.id
  startNewGroup()
}

async function run(action: string): Promise<void> {
  const m = menu.value
  menu.value = null
  if (!m) return
  const s = m.server
  if (action === 'open') emit('open', s)
  else if (action === 'tab') emit('open', s, true)
  else if (action === 'sftp') {
    emit('open', s)
    srv.sftpOpen = true
    emit('sftp')
  } else if (action === 'edit') emit('edit', s)
  else if (action === 'copy') {
    const cs = `${s.user}@${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`
    try {
      await navigator.clipboard.writeText(cs)
      flash(`已复制 ${cs}`)
    } catch {
      await window.sqlpilot.uiAlert('复制失败', cs)
    }
  } else if (action === 'dup') {
    const copy: any = { ...s, id: `srv_${Date.now()}`, name: `${s.name} 副本` }
    delete copy.password
    const r = await window.sqlpilot.saveServer(copy, undefined, undefined)
    if (!r.ok) await window.sqlpilot.uiAlert('复制失败：' + (r.error || ''))
    else {
      emit('refresh')
      flash(`已复制为「${copy.name}」（密码需重新填写）`)
    }
  } else if (action === 'forgetKey') {
    const r = await window.sqlpilot.forgetHostKey(s.host, s.port || 22)
    flash(r.removed ? `已清除 ${s.host} 的主机密钥记录，下次连接会重新记录` : `${s.host} 没有主机密钥记录`)
  } else if (action === 'del') {
    // 用主进程对话框：window.confirm 是渲染层同步框，弹出期间整个渲染线程被锁死
    const ok = await window.sqlpilot.uiConfirm(
      `确认删除会话「${s.name}」？`,
      '该服务器的密码/私钥口令会一并清除，已打开的终端会被断开。',
      true
    )
    if (!ok) return
    const r = await window.sqlpilot.deleteServer(s.id)
    if (!r.ok) {
      await window.sqlpilot.uiAlert('删除失败')
      return
    }
    emit('deleted')
    flash(`已删除「${s.name}」`)
  }
}

// ---------- 分组右键菜单 ----------
const gmenu = ref<{ x: number; y: number; group: Group } | null>(null)

function showGroupMenu(e: MouseEvent, group: Group): void {
  gmenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 210),
    y: Math.min(e.clientY, window.innerHeight - 220),
    group
  }
}

async function runGroup(action: string): Promise<void> {
  const m = gmenu.value
  gmenu.value = null
  if (!m) return
  const g = m.group
  if (action === 'newServer') {
    emit('new', g.virtual ? undefined : g.name)
  } else if (action === 'rename') {
    startRename(g.name)
  } else if (action === 'toggle') {
    toggleGroup(g.name)
  } else if (action === 'del') {
    const n = g.items.length
    const ok = await window.sqlpilot.uiConfirm(
      `删除分组「${g.name}」？`,
      n ? `组内 ${n} 个会话不会被删除，会移到「${UNGROUPED}」。` : '这是空分组，删除后不影响任何会话。',
      true
    )
    if (!ok) return
    const r = await window.sqlpilot.deleteServerGroup(g.name)
    if (!r.ok) {
      await window.sqlpilot.uiAlert(r.error || '删除分组失败')
      return
    }
    delete srv.collapsed[g.name]
    await reload()
    flash(n ? `已删除分组「${g.name}」，${n} 个会话移到「${UNGROUPED}」` : `已删除空分组「${g.name}」`)
  }
}
</script>

<style scoped>
.ss { width: 228px; min-width: 228px; display: flex; flex-direction: column; background: var(--bg-side); border-right: 1px solid var(--border); min-height: 0; }
.ss-head { display: flex; gap: 6px; padding: 8px 8px 6px; }
.ss-search { flex: 1; min-width: 0; font-size: 12px; padding: 4px 9px; border-radius: 7px; }
.ss-add {
  width: 27px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 7px; cursor: pointer; font-size: 14px; line-height: 1; font-family: inherit;
}
.ss-add:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.ss-tools { display: flex; gap: 5px; padding: 0 8px 7px; }
.ss-tool {
  flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 3px 0; cursor: pointer; font-family: inherit;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ss-tool:hover, .ss-tool.on { color: var(--accent); border-color: var(--accent); }
.ss-tool.new-grp { flex: 0 0 52px; }
.ss-list { flex: 1; overflow-y: auto; padding-bottom: 10px; min-height: 0; }

.ss-empty { padding: 22px 16px; }
.ss-empty-t { font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }
.ss-empty-d { font-size: 11.5px; color: var(--text-faint); line-height: 1.7; }

/* 新建/重命名分组的内联输入框：就地编辑，不弹窗 */
.ss-gnew { padding: 4px 8px 2px; }
.ss-ginput {
  width: 100%; box-sizing: border-box; font-size: 12px; padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--accent); background: var(--bg-card); color: var(--text); font-family: inherit;
}

.ss-group { margin-top: 2px; }
.ss-ghead {
  display: flex; align-items: center; gap: 5px; width: 100%;
  padding: 5px 10px; border: none; background: none; cursor: pointer;
  color: var(--text-faint); font-size: 11px; font-family: inherit; letter-spacing: .4px;
}
.ss-ghead:hover { color: var(--text-dim); }
/* 拖会话悬停到分组头：整行高亮 + 虚线框，明确"松手就归这个组" */
.ss-ghead.drop-on {
  color: var(--accent); background: var(--accent-dim);
  box-shadow: inset 0 0 0 1px var(--accent); border-radius: 6px;
}
.ss-ghead.editing { padding: 4px 8px; }
.ss-caret { display: inline-block; transition: transform .15s ease; font-size: 9px; }
.ss-caret.closed { transform: rotate(-90deg); }
.ss-gicon { font-size: 9px; opacity: .8; }
.ss-gicon.virtual { opacity: .5; }
.ss-gname { flex: 1; text-align: left; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-gcount { font-weight: 400; }

.ss-item {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 10px 5px 9px; margin: 0 5px; border-radius: 7px;
  cursor: pointer; color: var(--text-dim); min-width: 0;
}
.ss-item:hover { background: var(--bg-card-hover); color: var(--text); }
.ss-item.active { background: var(--accent-dim); color: var(--text); }
.ss-item.dragging { opacity: .45; }
/* 会话标识色（生产红/测试黄…），与右侧连接状态点是两回事 */
.ss-bar { width: 3px; height: 17px; border-radius: 2px; flex-shrink: 0; }
.ss-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border-strong); flex-shrink: 0; }
.ss-dot.live { background: var(--green); box-shadow: 0 0 5px var(--green); }
.ss-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ss-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-sub { font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.ss-badge { font-size: 9.5px; padding: 0 4px; border-radius: 4px; background: var(--accent-dim); color: var(--accent); flex-shrink: 0; }
.ss-badge.prod { background: var(--red-dim); color: var(--red); }
.ss-tabs {
  font-size: 9.5px; min-width: 14px; text-align: center; border-radius: 99px;
  background: var(--bg-card); color: var(--text-faint); padding: 0 4px; flex-shrink: 0;
}

/* 「移动到分组」小标签：分组多时也不会把右键菜单撑成两屏 */
.ctx-label { font-size: 10.5px; color: var(--text-faint); padding: 2px 10px 4px; letter-spacing: .5px; }
.ctx-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 5px; max-width: 210px; }
.ctx-chip {
  border: 1px solid var(--border); background: var(--bg-side); color: var(--text-dim);
  border-radius: 99px; font-size: 10.5px; padding: 2px 8px; cursor: pointer; font-family: inherit;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ctx-chip:hover { color: var(--accent); border-color: var(--accent); }
.ctx-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
.ctx-chip.add { border-style: dashed; }
</style>
