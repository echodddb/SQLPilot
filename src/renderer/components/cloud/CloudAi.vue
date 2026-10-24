<template>
  <AiChatWindow :store="ai" :catalog="OCP_AI_CATALOG" reset-on-platform-change />
</template>

<script setup lang="ts">
/**
 * OceanBase（OCP）的 AI 助手：把 OCP 的 store 与文案目录注入通用浮窗。
 * 具体交互（勾选范围、对话、历史）都在 AiChatWindow 里。
 */
import AiChatWindow from './AiChatWindow.vue'
import { ai } from '../../cloud/ai'
import { OCP_AI_CATALOG } from '../../cloud/aiCatalog'
</script>
