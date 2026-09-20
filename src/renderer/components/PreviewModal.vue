<template>
  <div class="modal-mask">
    <div class="modal" style="width: 880px; max-width: 94vw; display: flex; flex-direction: column; max-height: 88vh">
      <h3>👁 发送前预览 <span class="badge blue" style="font-family: var(--mono); font-size: 11px">{{ req.url }}</span></h3>
      <div style="font-size: 12px; color: var(--text-dim); margin: 4px 0 8px">
        以下为即将发送给大模型的<b>完整请求体</b>（含系统提示词、全部对话历史与工具定义）。
        模型：{{ req.body?.model }}；消息条数：{{ msgCount }}。
      </div>
      <pre class="pv-body">{{ bodyText }}</pre>
      <div v-if="queueLength > 1" style="font-size: 11.5px; color: var(--text-faint); margin-top: 4px">
        （队列中还有 {{ queueLength - 1 }} 个预览请求等待处理）
      </div>
      <div class="actions">
        <button class="btn danger" @click="reply(false)">取消本轮</button>
        <span style="flex: 1"></span>
        <button class="pv-disable-link" title="以后不再弹预览（本次请求放行）；随时可用顶栏 👁 按钮重新开启" @click="disableAndSend">
          不再预览（本次放行并关闭功能，之后可在 ⚙ 设置 → 通用 重新开启）
        </button>
        <button class="btn primary" @click="reply(true)">发送</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { store, toPlain } from '../store'

const req = computed(() => store.previewQueue[0])
const queueLength = computed(() => store.previewQueue.length)

// 展示层截断（发送的仍是完整内容）
const bodyText = computed(() => {
  let s = ''
  try {
    s = JSON.stringify(req.value.body, null, 2)
  } catch {
    s = String(req.value.body)
  }
  return s.length > 200_000 ? s.slice(0, 200_000) + '\n…（内容过长，展示已截断；实际发送为完整内容）' : s
})

const msgCount = computed(() => {
  const b = req.value.body
  return Array.isArray(b?.messages) ? b.messages.length : '—'
})

async function reply(ok: boolean) {
  const id = req.value.requestId
  store.previewQueue = store.previewQueue.filter((c) => c.requestId !== id)
  await window.sqlpilot.replyLlmPreview(id, ok)
}

async function disableAndSend() {
  store.cfg.previewLlm = false
  await window.sqlpilot.setConfig(toPlain(store.cfg))
  await reply(true)
}
</script>

<style scoped>
.pv-body {
  flex: 1; min-height: 200px; max-height: 52vh; overflow: auto; margin: 0;
  font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-all;
  background: var(--bg-code); border: 1px solid var(--border); border-radius: 8px; padding: 10px;
}
/* 弱化的"关闭功能"入口：避免与发送/取消同等视觉权重导致误触后功能静默关闭 */
.pv-disable-link {
  border: none; background: transparent; color: var(--text-faint); font-size: 11px;
  cursor: pointer; font-family: inherit; padding: 4px 8px; text-decoration: underline dotted;
}
.pv-disable-link:hover { color: var(--text-dim); }
</style>
