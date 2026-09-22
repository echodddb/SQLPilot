<template>
  <div class="modal-mask">
    <div class="modal" style="width:640px">
      <h3>写操作确认 <span class="badge" :class="riskClass">{{ req.kind }} · 风险{{ req.risk }}</span></h3>

      <div style="font-size:12.5px; color:var(--text-dim); line-height:1.8">
        目标连接：<b style="color:var(--text)">{{ req.conn }}</b>
        <span v-if="req.origin"><br />执行者：<b style="color:var(--orange, #e6a23c)">「{{ req.origin }}」</b>（由子代理发起，权限不会超出本会话）</span>
        <span v-if="sessionLabel"><br />来自会话：<b style="color:var(--text)">{{ sessionLabel }}</b></span>
        <br />Agent 请求执行以下语句：
      </div>

      <div class="confirm-sql">{{ req.sql }}</div>

      <div v-if="queueLength > 1" style="font-size:11.5px;color:var(--text-faint);margin-bottom:6px">
        （队列中还有 {{ queueLength - 1 }} 个确认请求等待处理）
      </div>

      <div class="actions">
        <button class="btn danger" @click="reply('deny')">拒绝</button>
        <span style="flex:1"></span>
        <button class="btn" @click="reply('session')">本会话均允许此类操作</button>
        <button class="btn primary" @click="reply('once')">仅此次允许</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../store'

const req = computed(() => store.confirmQueue[0])
const riskClass = computed(() => (req.value.risk >= 3 ? 'red' : req.value.risk === 2 ? 'yellow' : 'gray'))
const queueLength = computed(() => store.confirmQueue.length)

const sessionLabel = computed(() => {
  const sid = req.value.sessionId
  const s = sid ? store.sessions[sid] : null
  return s ? s.meta.title : ''
})

async function reply(decision: string) {
  const id = req.value.requestId
  store.confirmQueue = store.confirmQueue.filter((c) => c.requestId !== id)
  await window.sqlpilot.replyConfirm(id, decision)
}
</script>
