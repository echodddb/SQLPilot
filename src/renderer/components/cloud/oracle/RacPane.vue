<template>
  <div v-if="d" class="oc-wrap">
    <div v-if="!isRac" class="oc-warn">
      <span>ℹ</span>
      <div>
        <b>当前不是 RAC 集群</b>
        <div class="oc-note">
          cluster_database = {{ d.clusterDatabase }}，gv$instance 只有 {{ d.nodes.length }} 个实例。
          下面仍然展示实例、服务与私网信息（单实例同样有默认服务）。
        </div>
      </div>
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orRacCfg" :data-ai="oraPickKey('rac','config')" data-ai-compact data-ai-name="集群配置">
        <div class="oc-card-h"><span>集群配置</span></div>
        <div class="oc-kvs">
          <div class="oc-kv"><span>cluster_database</span><b>{{ d.clusterDatabase }}</b></div>
          <div class="oc-kv"><span>配置实例数</span><b>{{ d.configuredInstances || '—' }}</b></div>
          <div class="oc-kv"><span>在线实例数</span><b>{{ d.nodes.filter((n) => n.status === 'OPEN').length }} / {{ d.nodes.length }}</b></div>
          <div class="oc-kv"><span>活跃实例（v$active_instances）</span><b>{{ d.activeInstances.length || '—' }}</b></div>
        </div>
      </div>
      <div class="oc-card" data-src="orRacSess" :data-ai="oraPickKey('rac','sessions')" data-ai-compact data-ai-name="节点会话">
        <div class="oc-card-h"><span>节点会话</span><span class="sp"></span><span class="oc-note">用户会话 / 活跃</span></div>
        <div class="oc-bars">
          <div v-for="n in d.nodes" :key="n.instId" class="oc-bar-row">
            <span>{{ n.instanceName }} · {{ n.hostName }}</span>
            <i><b :style="{ width: pct(n.sessions, maxSess) + '%' }"></b></i>
            <em>{{ n.sessions }} / {{ n.active }}</em>
          </div>
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orRacNodes" :data-ai="oraPickKey('rac','nodes')" data-ai-compact data-ai-name="实例与节点">
      <div class="oc-card-h"><span>实例与节点</span><span class="cnt">{{ d.nodes.length }}</span></div>
      <OraTable :columns="nodeCols" :rows="d.nodes" row-key="instId" default-sort="instId" default-dir="1" />
    </div>

    <div class="oc-card" data-src="orRacSvc" :data-ai="oraPickKey('rac','services')" data-ai-compact data-ai-name="服务分布">
      <div class="oc-card-h"><span>服务分布</span><span class="cnt">{{ d.services.length }}</span><span class="sp"></span>
        <span class="oc-note">gv$active_services：某实例上跑着哪些服务</span>
      </div>
      <OraTable :columns="svcCols" :rows="d.services" searchable search-placeholder="服务名过滤…" default-sort="instId" default-dir="1" />
    </div>

    <div class="oc-card" data-src="orRacIc" :data-ai="oraPickKey('rac','interconnect')" data-ai-compact data-ai-name="私网">
      <div class="oc-card-h"><span>私网 / 互联</span><span class="cnt">{{ d.interconnects.length }}</span><span class="sp"></span>
        <span class="oc-note">gv$cluster_interconnects 为空通常表示没有配置 RAC 私网</span>
      </div>
      <OraTable :columns="icCols" :rows="d.interconnects" empty="没有私网地址（单实例或未配置）" />
    </div>
  </div>
  <div v-else class="oc-loading">正在查库…</div>
</template>

<script setup lang="ts">
import { oraPickKey } from '../../../cloud/oraAi'
import { computed } from 'vue'
import OraTable from './OraTable.vue'
import type { OraCol } from './table'
import { oraData } from '../../../cloud/oracle'

const d = computed(() => oraData('rac'))
const isRac = computed(() => String(d.value?.clusterDatabase).toUpperCase() === 'TRUE' || (d.value?.nodes.length || 0) > 1)
const maxSess = computed(() => Math.max(1, ...(d.value?.nodes.map((n) => n.sessions) || [1])))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

const nodeCols: OraCol[] = [
  { key: 'instId', label: 'INST', type: 'num', width: '52px' },
  { key: 'instanceName', label: '实例', type: 'mono' },
  { key: 'hostName', label: '主机', type: 'mono' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'instanceRole', label: '角色' },
  { key: 'activeState', label: '活动状态' },
  { key: 'databaseStatus', label: '库状态' },
  { key: 'sessions', label: '会话', type: 'num' },
  { key: 'active', label: '活跃', type: 'num' },
  { key: 'startupTime', label: '启动时间', type: 'time' },
  { key: 'version', label: '版本' }
]

const svcCols: OraCol[] = [
  { key: 'instId', label: 'INST', type: 'num', width: '52px' },
  { key: 'serviceId', label: 'ID', type: 'num', width: '52px' },
  { key: 'name', label: '服务名', type: 'mono' },
  { key: 'networkName', label: '网络名', type: 'mono' }
]

const icCols: OraCol[] = [
  { key: 'instId', label: 'INST', type: 'num', width: '52px' },
  { key: 'name', label: '网卡/名称', type: 'mono' },
  { key: 'ip', label: 'IP', type: 'mono' },
  { key: 'isPublic', label: '公网' },
  { key: 'source', label: '来源' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
