<template>
  <div v-if="d" class="oc-wrap">
    <div class="oc-cards">
      <div class="oc-card" data-src="orUsSummary" :data-ai="oraPickKey('users','summary')" data-ai-compact data-ai-name="账号概览">
        <div class="oc-card-h"><span>账号概览</span></div>
        <div class="oc-kvs">
          <div class="oc-kv"><span>用户总数</span><b>{{ d.users.length }}</b></div>
          <div class="oc-kv"><span>已锁定 / 过期</span><b :style="locked+expired ? 'color: var(--warn, #d9a441)' : ''">{{ locked + expired }}</b></div>
          <div class="oc-kv"><span>对象总数</span><b>{{ d.totalObjects.toLocaleString('zh-CN') }}</b></div>
          <div class="oc-kv"><span>失效对象</span><b :style="invalidTotal ? 'color: var(--red)' : ''">{{ invalidTotal }}</b></div>
        </div>
      </div>
      <div class="oc-card" data-src="orUsPwfile" :data-ai="oraPickKey('users','pwfile')" data-ai-compact data-ai-name="特权账号">
        <div class="oc-card-h"><span>特权账号（v$pwfile_users）</span><span class="cnt">{{ d.pwfile.length }}</span></div>
        <OraTable :columns="pwCols" :rows="d.pwfile" empty="没有口令文件用户（或未使用密码文件认证）" />
      </div>
      <div class="oc-card" data-src="orUsRoles" :data-ai="oraPickKey('users','roles')" data-ai-compact data-ai-name="当前用户角色">
        <div class="oc-card-h"><span>当前用户角色</span><span class="cnt">{{ d.roles.length }}</span></div>
        <OraTable :columns="roleCols" :rows="d.roles" empty="没有直接授予的角色" />
      </div>
    </div>

    <div class="oc-card" data-src="orUsUsers" :data-ai="oraPickKey('users','list')" data-ai-compact data-ai-name="数据库用户">
      <div class="oc-card-h"><span>数据库用户</span><span class="cnt">{{ d.users.length }}</span><span class="sp"></span>
        <span class="oc-note">EXPIRED / LOCKED 的账号业务连上会直接认证失败</span>
      </div>
      <OraTable :columns="userCols" :rows="d.users" searchable search-placeholder="用户名 / 表空间…" page-size="60" default-sort="username" default-dir="1" />
    </div>

    <div class="oc-cards">
      <div class="oc-card" data-src="orUsInvalid" :data-ai="oraPickKey('users','invalid')" data-ai-compact data-ai-name="失效对象">
        <div class="oc-card-h"><span>失效对象</span><span class="cnt">{{ d.invalid.length }}</span></div>
        <OraTable :columns="invCols" :rows="d.invalid" empty="没有失效对象" default-sort="count" />
      </div>
      <div class="oc-card" data-src="orUsTypes" :data-ai="oraPickKey('users','objects')" data-ai-compact data-ai-name="对象类型分布">
        <div class="oc-card-h"><span>对象类型分布</span><span class="cnt">{{ d.objectTypes.length }}</span></div>
        <div class="oc-bars">
          <div v-for="t in d.objectTypes.slice(0, 12)" :key="t.objectType" class="oc-bar-row">
            <span>{{ t.objectType }}</span>
            <i><b :style="{ width: pct(t.count, maxType) + '%' }"></b></i>
            <em>{{ t.count }}</em>
          </div>
        </div>
      </div>
    </div>

    <div class="oc-card" data-src="orUsSeg" :data-ai="oraPickKey('users','segments')" data-ai-compact data-ai-name="最大段 TOP">
      <div class="oc-card-h"><span>最大段 TOP</span><span class="cnt">{{ d.segments.length }}</span><span class="sp"></span>
        <span class="oc-note">dba_segments 全表扫描，打开这个页面才会查</span>
      </div>
      <OraTable :columns="segCols" :rows="d.segments" empty="没有段信息" default-sort="mb" />
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

const d = computed(() => oraData('users'))
const locked = computed(() => (d.value?.users.filter((u) => u.status.includes('LOCKED')).length || 0))
const expired = computed(() => (d.value?.users.filter((u) => u.status.includes('EXPIRED')).length || 0))
const invalidTotal = computed(() => (d.value?.invalid.reduce((a, b) => a + b.count, 0) || 0))
const maxType = computed(() => Math.max(1, ...(d.value?.objectTypes.map((t) => t.count) || [1])))

function pct(v: number, max: number): number {
  return Math.max(2, Math.min(100, (Number(v) || 0) * 100 / (max || 1)))
}

const userCols: OraCol[] = [
  { key: 'username', label: '用户名', type: 'mono' },
  { key: 'status', label: '状态', type: 'state' },
  { key: 'expiry', label: '过期时间' },
  { key: 'defaultTs', label: '默认表空间', type: 'mono' },
  { key: 'tempTs', label: '临时表空间', type: 'mono' },
  { key: 'profile', label: 'PROFILE' },
  { key: 'authType', label: '认证方式' },
  { key: 'created', label: '创建时间' }
]

const pwCols: OraCol[] = [
  { key: 'username', label: '用户名', type: 'mono' },
  { key: 'sysdba', label: 'SYSDBA' },
  { key: 'sysoper', label: 'SYSOPER' },
  { key: 'admin', label: 'ADMIN' }
]

const roleCols: OraCol[] = [
  { key: 'role', label: '角色', type: 'mono' },
  { key: 'adminOption', label: 'WITH ADMIN' },
  { key: 'defaultRole', label: 'DEFAULT' }
]

const invCols: OraCol[] = [
  { key: 'owner', label: 'OWNER', type: 'mono' },
  { key: 'objectType', label: '类型' },
  { key: 'count', label: '数量', type: 'num' }
]

const segCols: OraCol[] = [
  { key: 'owner', label: 'OWNER', type: 'mono' },
  { key: 'name', label: '段名', type: 'mono' },
  { key: 'type', label: '类型' },
  { key: 'tablespace', label: '表空间', type: 'mono' },
  { key: 'mb', label: '大小', type: 'size' }
]
</script>

<style scoped>
.oc-wrap { display: flex; flex-direction: column; gap: 12px; }
</style>
