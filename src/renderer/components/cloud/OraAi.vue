<template>
  <AiChatWindow :store="oraAi" :catalog="ORA_AI_CATALOG" />
</template>

<script setup lang="ts">
/**
 * Oracle 的 AI 助手：同一套浮窗，换成「环境 × 单元」的 store 与文案。
 * Oracle 的对话可以跨多套环境，所以不做「切平台即重开」。
 */
import AiChatWindow from './AiChatWindow.vue'
import { oraAi, ORA_AI_CATALOG } from '../../cloud/oraAi'
</script>
