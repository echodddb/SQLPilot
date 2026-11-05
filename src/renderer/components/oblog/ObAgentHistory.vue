<template>
  <div class="oh">
    <div class="oh-h">
      <b>历史排查</b>
      <span class="oh-n">{{ obHistory.list.length ? `${obHistory.list.length} 场` : '' }}</span>
      <span class="sp"></span>
      <button class="lnk" :disabled="obHistory.loading" @click="refreshObHistory()">刷新</button>
      <button class="lnk danger" :disabled="!obHistory.list.length" @click="confirmClear">清空</button>
    </div>

    <div class="oh-body">
      <div v-if="obHistory.loading && !obHistory.list.length" class="oh-empty">读取中…</div>
      <div v-else-if="!obHistory.list.length" class="oh-empty">
        还没有历史。<br />每场排查结束会自动存一份，关掉浮窗也不会丢。
      </div>

      <button
        v-for="s in obHistory.list"
        :key="s.id"
        class="oh-row"
        :class="{ cur: s.id === obAgent.sessionId }"
        @click="open(s.id)"
      >
        <span class="oh-r1">
          <i class="oh-dot" :class="s.status" :title="STATUS_TIP[s.status]"></i>
          <b class="oh-t">{{ s.title || '未命名排查' }}</b>
          <span v-if="s.id === obAgent.sessionId" class="oh-cur">当前</span>
        </span>
        <span class="oh-r2">
          <span class="oh-w">{{ s.serverName || '未知服务器' }}</span>
          <span v-if="s.host" class="oh-host">{{ s.host }}</span>
          <span class="sp"></span>
          <span class="oh-meta">{{ s.cmdCount }} 条命令</span>
          <span v-if="s.blocked" class="oh-meta danger" :title="`其中 ${s.blocked} 条被安全策略拦截`">拦 {{ s.blocked }}</span>
          <span class="oh-meta">{{ ago(s.updatedAt) }}</span>
        </span>
      </button>
    </div>

    <div v-if="obHistory.error" class="oh-err">{{ obHistory.error }}</div>
    <div v-if="confirming" class="oh-confirm">
      <span>删掉全部 {{ obHistory.list.length }} 场记录？不可恢复。</span>
      <span class="sp"></span>
      <button class="lnk" @click="confirming = false">取消</button>
      <button class="lnk danger" @click="doClearAll">确认清空</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 历史排查记录。
 *
 * 列表只吃摘要（标题 / 服务器 / 命令条数 / 时间），点开才去主进程取整场 ——
 * 一场对话里可能有十几条命令和几十 KB 输出，全量拉过来会让浮窗卡一下。
 */
import { ref } from 'vue'
import { obAgent, obHistory, clearObHistory, loadObSession, refreshObHistory } from '../../oblog/agent'

const confirming = ref(false)
const STATUS_TIP = {
  running: '排查进行中',
  done: '已完成',
  error: '中途出错'
} as const

function ago(ts: number): string {
  const d = Date.now() - ts
  if (!Number.isFinite(ts) || d < 0) return ''
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  if (d < 172_800_000) return '昨天'
  const dt = new Date(ts)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

function open(id: string): void {
  if (id === obAgent.sessionId) {
    obHistory.open = false
    return
  }
  void loadObSession(id)
}

function confirmClear(): void {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  void doClearAll()
}

function doClearAll(): void {
  confirming.value = false
  void clearObHistory()
}
</script>

<style scoped>
.oh {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: inherit;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: oh-in 0.16s cubic-bezier(0.2, 0.8, 0.3, 1);
}
@keyframes oh-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

.oh-h {
  display: flex; align-items: center; gap: 7px; padding: 8px 10px;
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.oh-h b { font-size: 12px; }
.oh-n { font-size: 10px; color: var(--text-faint); font-family: var(--mono); }
.sp { flex: 1; }

.oh-body { overflow-y: auto; min-height: 0; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.oh-body::-webkit-scrollbar { width: 8px; }
.oh-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }

.oh-empty { padding: 18px 12px; font-size: 11.5px; line-height: 1.7; color: var(--text-faint); text-align: center; }

.oh-row {
  display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left;
  padding: 7px 8px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: var(--text); font-family: inherit;
  transition: background-color 0.14s ease, border-color 0.14s ease;
}
.oh-row:hover { background: var(--bg-card-hover); border-color: var(--border); }
.oh-row.cur { border-color: color-mix(in srgb, var(--accent) 40%, transparent); background: var(--accent-dim); }

.oh-r1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.oh-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--text-faint); }
.oh-dot.done { background: var(--green); }
.oh-dot.error { background: var(--red); }
.oh-dot.running { background: var(--accent); animation: oh-pulse 1.2s ease-in-out infinite; }
@keyframes oh-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.oh-t { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oh-cur {
  flex-shrink: 0; font-size: 9px; padding: 0 4px; border-radius: 4px; font-family: var(--mono);
  color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
}

.oh-r2 { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 10px; color: var(--text-faint); }
.oh-w { color: var(--text-dim); flex-shrink: 0; }
.oh-host { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px; }
.oh-meta { font-family: var(--mono); flex-shrink: 0; }
.oh-meta.danger { color: var(--red); }

.oh-err {
  margin: 0 8px 8px; padding: 5px 8px; border-radius: 7px; font-size: 10.5px;
  color: var(--red); background: var(--red-dim); border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
}
.oh-confirm {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px; flex-shrink: 0;
  border-top: 1px solid var(--border); font-size: 10.5px; color: var(--text-dim);
  background: var(--red-dim);
}
.lnk {
  border: none; background: none; padding: 0; font-family: inherit; font-size: 10.5px;
  color: var(--text-faint); cursor: pointer; flex-shrink: 0;
}
.lnk:hover:not(:disabled) { color: var(--accent); }
.lnk.danger:hover:not(:disabled) { color: var(--red); }
.lnk:disabled { opacity: 0.4; cursor: default; }
</style>
