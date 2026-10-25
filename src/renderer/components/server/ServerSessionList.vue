<template>
  <aside class="ss">
    <div class="ss-head">
      <input v-model="srv.filter" class="ss-search" placeholder="搜索名称 / 地址 / 分组" spellcheck="false" />
      <button class="ss-add" title="新建会话" @click="emit('new')">＋</button>
    </div>

    <div class="ss-tools">
      <button class="ss-tool" title="从 ~/.ssh/config 导入" @click="emit('import')">导入配置</button>
      <button class="ss-tool" :class="{ on: srv.prefsOpen }" title="终端外观与交互偏好" @click="emit('prefs')">终端偏好</button>
    </div>

    <div class="ss-list">
      <div v-if="!groups.length" class="ss-empty">
        <div class="ss-empty-t">还没有服务器</div>
        <div class="ss-empty-d">点右上角「＋」新建，或从 ~/.ssh/config 导入。</div>
      </div>

      <div v-for="g in groups" :key="g.name" class="ss-group">
        <button class="ss-ghead" @click="toggleGroup(g.name)">
          <span class="ss-caret" :class="{ closed: srv.collapsed[g.name] }">▾</span>
          <span class="ss-gname">{{ g.name }}</span>
          <span class="ss-gcount">{{ g.items.length }}</span>
        </button>
        <template v-if="!srv.collapsed[g.name]">
          <div
            v-for="s in g.items"
            :key="s.id"
            class="ss-item"
            :class="{ active: isActive(s.id), open: openCount(s.id) > 0 }"
            :title="`${s.user}@${s.host}:${s.port}`"
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

    <div v-if="!srv.sftpOpen" class="ss-note">SFTP 面板已收起（终端标签右侧按钮可展开）</div>

    <Teleport to="body">
      <div v-if="menu" class="ctx-mask" @mousedown.self="menu = null" @contextmenu.prevent="menu = null">
        <div class="ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
          <button class="ctx-item" @click="run('open')">打开终端</button>
          <button class="ctx-item" @click="run('tab')">新建标签</button>
          <button class="ctx-item" @click="run('sftp')">打开 SFTP</button>
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
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SshServerCfg } from '../../../main/types'
import { srv, servers, flash } from '../../server/state'
import { colorOf, colorSource } from '../../server/colors'

const emit = defineEmits<{
  (e: 'open', server: SshServerCfg, newTab?: boolean): void
  (e: 'new'): void
  (e: 'import'): void
  (e: 'prefs'): void
  (e: 'edit', server: SshServerCfg): void
  (e: 'deleted'): void
  (e: 'sftp'): void
  (e: 'refresh'): void
}>()

interface Group { name: string; items: SshServerCfg[] }

const groups = computed<Group[]>(() => {
  const q = srv.filter.trim().toLowerCase()
  const list = servers().filter((s) => {
    if (!q) return true
    return [s.name, s.host, s.user, s.group, s.tag, s.note].filter(Boolean).join(' ').toLowerCase().includes(q)
  })
  const map = new Map<string, SshServerCfg[]>()
  for (const s of list) {
    const g = (s.group || '').trim() || '未分组'
    if (!map.has(g)) map.set(g, [])
    map.get(g)!.push(s)
  }
  // 未分组永远排最后：它是兜底桶，不是用户建的组
  return [...map.entries()]
    .map(([name, items]) => ({ name, items: items.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) }))
    .sort((a, b) => (a.name === '未分组' ? 1 : b.name === '未分组' ? -1 : a.name.localeCompare(b.name, 'zh-CN')))
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

const menu = ref<{ x: number; y: number; server: SshServerCfg } | null>(null)

function showMenu(e: MouseEvent, s: SshServerCfg): void {
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - 210),
    y: Math.min(e.clientY, window.innerHeight - 300),
    server: s
  }
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
  flex: 1; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-dim);
  border-radius: 6px; font-size: 11px; padding: 3px 0; cursor: pointer; font-family: inherit;
}
.ss-tool:hover, .ss-tool.on { color: var(--accent); border-color: var(--accent); }
.ss-list { flex: 1; overflow-y: auto; padding-bottom: 10px; min-height: 0; }

.ss-empty { padding: 22px 16px; }
.ss-empty-t { font-size: 13px; color: var(--text-dim); margin-bottom: 6px; }
.ss-empty-d { font-size: 11.5px; color: var(--text-faint); line-height: 1.7; }

.ss-group { margin-top: 2px; }
.ss-ghead {
  display: flex; align-items: center; gap: 5px; width: 100%;
  padding: 5px 10px; border: none; background: none; cursor: pointer;
  color: var(--text-faint); font-size: 11px; font-family: inherit; letter-spacing: .4px;
}
.ss-ghead:hover { color: var(--text-dim); }
.ss-caret { display: inline-block; transition: transform .15s ease; font-size: 9px; }
.ss-caret.closed { transform: rotate(-90deg); }
.ss-gname { flex: 1; text-align: left; font-weight: 700; }
.ss-gcount { font-weight: 400; }

.ss-item {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 10px 5px 9px; margin: 0 5px; border-radius: 7px;
  cursor: pointer; color: var(--text-dim); min-width: 0;
}
.ss-item:hover { background: var(--bg-card-hover); color: var(--text); }
.ss-item.active { background: var(--accent-dim); color: var(--text); }
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
.ss-note { padding: 6px 12px; font-size: 10.5px; color: var(--text-faint); border-top: 1px solid var(--border); }
</style>
