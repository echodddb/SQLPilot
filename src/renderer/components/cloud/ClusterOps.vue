<template>
  <div class="ops">
    <button class="op" :disabled="busy" title="滚动重启集群内所有 OBServer" @click="run('restart')">重启</button>
    <button class="op" :disabled="busy || cluster.status === 'STOPPED'" title="停止集群" @click="run('stop')">停止</button>
    <button class="op" :disabled="busy || cluster.status === 'RUNNING'" title="启动集群" @click="run('start')">启动</button>
    <button class="op" :disabled="busy" title="立即发起一次合并" @click="run('triggerCompaction')">合并</button>
    <button class="op danger" :disabled="busy" title="删除集群（不可恢复）" @click="run('delete')">删除</button>
  </div>
</template>

<script setup lang="ts">
/**
 * 集群运维动作。全部经 OCP 原生接口提交，前台二次确认后执行；
 * OCP 会为动作生成任务，成功后提示任务号，可到「任务」页看进度。
 */
import { ref } from 'vue'
import { pushNotice } from '../../store'
import { runClusterAction } from '../../cloud/state'

const props = defineProps<{ cluster: CloudCluster }>()
const busy = ref(false)

const META: Record<string, { title: string; detail: string; danger?: boolean; done: string }> = {
  restart: { title: '重启集群', detail: '将按 Zone 滚动重启所有 OBServer，业务会短暂中断。', done: '重启任务已提交' },
  stop: { title: '停止集群', detail: '集群内所有 OBServer 将停止，业务完全中断，需要手动启动。', danger: true, done: '停止任务已提交' },
  start: { title: '启动集群', detail: '启动集群内所有 OBServer。', done: '启动任务已提交' },
  triggerCompaction: { title: '立即合并', detail: '合并期间 CPU 与 IO 会有明显升高，建议避开业务高峰。', done: '合并任务已提交' },
  delete: { title: '删除集群', detail: '集群将从 OCP 中移除，该操作不可恢复；请确认已备份。', danger: true, done: '删除任务已提交' }
}

async function run(action: string): Promise<void> {
  const meta = META[action]
  const ok = await window.sqlpilot.uiConfirm(`${meta.title}「${props.cluster.name}」？`, meta.detail, !!meta.danger)
  if (!ok) return
  busy.value = true
  try {
    const r = await runClusterAction(props.cluster.id, action)
    if (!r.ok) {
      await window.sqlpilot.uiAlert(`${meta.title}失败`, r.error || 'OCP 返回错误')
      return
    }
    pushNotice(r.taskId ? `${meta.done}：任务 #${r.taskId}` : meta.done)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.op {
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text-dim);
  border-radius: 7px; padding: 3px 9px; font-size: 11.5px; font-family: inherit; cursor: pointer;
}
.op:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.op.danger:hover:not(:disabled) { color: var(--red); border-color: var(--red); }
.op:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
