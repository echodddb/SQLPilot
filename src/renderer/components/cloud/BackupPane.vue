<template>
  <div class="tp-pane bp">
    <!-- 核心指标：对齐 OCP「备份恢复 · 概览」的四张卡 -->
    <div class="tp-cards kpi">
      <div class="tp-card kc" data-ai="backup.overview:strategy" data-ai-name="备份策略覆盖">
        <div class="kc-label">已创建备份策略的集群</div>
        <div class="kc-val">
          {{ ov.hasBackupStrategyClusterNum }}<em>/{{ ov.totalClusterNum }}</em>
        </div>
        <div class="kc-sub">创建了集群级或租户级备份策略的集群</div>
        <div class="tp-bar-meter"><i :style="{ width: pct(ov.hasBackupStrategyClusterNum, ov.totalClusterNum) + '%' }"></i></div>
      </div>
      <div class="tp-card kc" data-ai="backup.overview:success" data-ai-name="本周备份成功率">
        <div class="kc-label">本周数据备份成功率</div>
        <div class="kc-val" :class="ov.weekDataSuccessPct >= 99 ? 'ok' : ov.weekDataSuccessPct >= 90 ? 'warn' : 'bad'">
          {{ ov.weekDataSuccessPct }}<em>%</em>
        </div>
        <div class="kc-sub">本周数据备份任务的成功比例</div>
        <div class="tp-bar-meter"><i :class="ov.weekDataSuccessPct >= 99 ? '' : 'warn'" :style="{ width: Math.min(100, ov.weekDataSuccessPct) + '%' }"></i></div>
      </div>
      <div class="tp-card kc" data-ai="backup.overview:logDelay" data-ai-name="日志备份延时">
        <div class="kc-label">日志备份存在延时的对象</div>
        <div class="kc-val" :class="ov.logBackupObjectNum ? 'bad' : 'ok'">{{ ov.logBackupObjectNum }}</div>
        <div class="kc-sub">日志备份落后于最新数据备份的租户</div>
      </div>
      <div class="tp-card kc" data-ai="backup.overview:rehearsal" data-ai-name="恢复抽检">
        <div class="kc-label">本周恢复抽检成功任务</div>
        <div class="kc-val">
          {{ ov.samplingSuccess }}<em>/{{ ov.samplingTotal }}</em>
        </div>
        <div class="kc-sub">基于备份文件验证可恢复性</div>
      </div>
    </div>

    <!-- 备份对象 -->
    <div class="tp-card" data-ai="backup.objects">
      <div class="tp-bar">
        <div class="tp-h">备份对象 <span class="cnt">{{ rows.length }}</span></div>
        <span class="sp"></span>
        <div class="seg">
          <button class="sg" :class="{ on: b.objFilter === 'all' }" @click="setBackupObjFilter('all')">全部 {{ all.length }}</button>
          <button class="sg" :class="{ on: b.objFilter === 'has' }" @click="setBackupObjFilter('has')">
            已备份 {{ hasCount }}
          </button>
          <button class="sg" :class="{ on: b.objFilter === 'none' }" @click="setBackupObjFilter('none')">
            未备份 {{ all.length - hasCount }}
          </button>
        </div>
      </div>
      <div class="tp-tbl-wrap">
        <table class="tp-tbl">
          <thead>
            <tr>
              <th>集群 / 租户</th>
              <th>对象类型</th>
              <th>版本</th>
              <th>备份状态</th>
              <th>调度状态</th>
              <th>集群状态</th>
              <th>OB 备份能力</th>
              <th class="r">租户</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in rows" :key="o.clusterId">
              <td>
                <div class="cell-main">{{ o.clusterName }}</div>
                <div class="cell-sub">{{ o.clusterMode ? clusterMode(o.clusterMode) : '—' }}</div>
              </td>
              <td>
                <span class="tp-chip" :class="o.primaryAndStandbyMode ? 'warn' : 'idle'">
                  {{ o.primaryAndStandbyMode ? '主备集群' : '普通集群' }}
                </span>
              </td>
              <td class="tp-mono tp-dim">{{ o.obVersion || '—' }}</td>
              <td>
                <span class="tp-chip" :class="o.backupStatus === 'HAS_BACKUP_STRATEGY' ? 'ok' : 'idle'">
                  {{ o.backupStatus === 'HAS_BACKUP_STRATEGY' ? '已建策略' : '未建策略' }}
                </span>
              </td>
              <td>
                <span class="tp-chip" :class="scheduleTone(o.scheduleStatus)">{{ scheduleLabel(o.scheduleStatus) }}</span>
              </td>
              <td>
                <span class="tp-chip" :class="clusterStatus(o.obClusterStatus).tone">{{ clusterStatus(o.obClusterStatus).label }}</span>
              </td>
              <td class="tp-dim">{{ abilityLabel(o.ability) }}</td>
              <td class="r tp-mono tp-dim">
                <span :title="o.tenants.map((t) => `${t.tenantName} ${t.backupStatus}`).join('\n')">{{ o.tenants.length }}</span>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="8" class="tp-empty">
                {{ all.length ? '该筛选下没有集群' : '这台 OCP 还没有可纳管的 OB 集群' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 备份 / 恢复任务 -->
    <div class="tp-card" data-ai="backup.tasks">
      <div class="tp-bar">
        <div class="tp-h">备份与恢复任务 <span class="cnt">{{ tasks.length }}</span></div>
        <span class="sp"></span>
        <div class="seg">
          <button v-for="k in TASK_KINDS" :key="k.key" class="sg" :class="{ on: b.taskKind === k.key }" @click="switchKind(k.key)">
            {{ k.label }} {{ b.bundle?.tasks[k.key].length || 0 }}
          </button>
        </div>
        <button class="tp-btn sm ghost" :disabled="b.loading" @click="reloadBackupTasks()">刷新</button>
      </div>
      <div class="tp-tbl-wrap">
        <table class="tp-tbl">
          <thead>
            <tr><th>任务</th><th>集群 / 租户</th><th>状态</th><th>开始</th><th>结束</th><th>信息</th></tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in tasks" :key="`${t.kind}-${t.id}-${i}`">
              <td>
                <div class="cell-main">{{ t.name || `#${t.id}` }}</div>
                <div class="cell-sub tp-mono">{{ t.id ? `ID ${t.id}` : '—' }}</div>
              </td>
              <td class="tp-dim">{{ t.clusterName || '—' }}<span v-if="t.tenantName"> / {{ t.tenantName }}</span></td>
              <td>
                <span class="tp-chip" :class="taskTone(t.status)">{{ t.status || '—' }}</span>
              </td>
              <td class="tp-mono tp-dim">{{ t.startTime ? fmtTime(t.startTime) : '—' }}</td>
              <td class="tp-mono tp-dim">{{ t.endTime ? fmtTime(t.endTime) : '—' }}</td>
              <td class="tp-dim ell" :title="t.message">{{ t.message || '—' }}</td>
            </tr>
            <tr v-if="!tasks.length">
              <td colspan="6" class="tp-empty">暂无{{ TASK_KINDS.find((x) => x.key === b.taskKind)?.label }}记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 服务 / 存储 / 告警 -->
    <div class="cols2">
      <div class="tp-card">
        <div class="tp-bar"><div class="tp-h">备份服务 <span class="cnt">{{ services.length }}</span></div></div>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead><tr><th>服务名称</th><th>类型</th><th>版本</th><th>架构</th><th class="r">节点</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="s in services" :key="s.id">
                <td>{{ s.name || `#${s.id}` }}</td>
                <td class="tp-dim">{{ s.type || '—' }}</td>
                <td class="tp-mono tp-dim">{{ s.version || '—' }}</td>
                <td class="tp-mono tp-dim">{{ s.architecture || '—' }}</td>
                <td class="r tp-mono">{{ s.nodeCount || '—' }}</td>
                <td><span class="tp-chip" :class="s.status === 'RUNNING' ? 'ok' : 'idle'">{{ s.status || '—' }}</span></td>
              </tr>
              <tr v-if="!services.length"><td colspan="6" class="tp-empty">未安装备份服务（逻辑备份场景才需要）</td></tr>
            </tbody>
          </table>
        </div>
        <div class="tp-note">备份服务仅用于逻辑备份场景；物理备份不需要安装。</div>
      </div>

      <div class="tp-card">
        <div class="tp-bar"><div class="tp-h">备份存储 <span class="cnt">{{ storages.length }}</span></div></div>
        <div class="tp-tbl-wrap">
          <table class="tp-tbl">
            <thead><tr><th>名称</th><th>类型</th><th>地址</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="s in storages" :key="s.id">
                <td>{{ s.name || `#${s.id}` }}</td>
                <td class="tp-dim">{{ s.type || '—' }}</td>
                <td class="tp-mono tp-dim ell" :title="s.endpoint">{{ s.endpoint || '—' }}</td>
                <td><span class="tp-chip" :class="s.status === 'AVAILABLE' || s.status === 'ACTIVE' ? 'ok' : 'idle'">{{ s.status || '—' }}</span></td>
              </tr>
              <tr v-if="!storages.length"><td colspan="4" class="tp-empty">还没有配置备份存储（NFS / OSS / S3）</td></tr>
            </tbody>
          </table>
        </div>
        <div class="tp-note">存储由「备份恢复 → 备份策略」引用，配置后会出现在这里。</div>
      </div>
    </div>

    <div class="tp-card">
      <div class="tp-bar">
        <div class="tp-h">备份告警 <span class="cnt">{{ alarms.items.length }}</span></div>
        <span class="sp"></span>
        <span v-if="alarms.logDelayObjects" class="tp-chip bad">日志备份延时对象 {{ alarms.logDelayObjects }}</span>
        <span v-for="t in alarms.typeStats" :key="t.type" class="tp-chip warn">{{ t.type }} · {{ t.count }}</span>
      </div>
      <div class="tp-tbl-wrap">
        <table class="tp-tbl">
          <thead><tr><th>告警对象</th><th>告警类型</th><th>级别</th><th>产生时间</th><th>最近告警</th><th>恢复时间</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="a in alarms.items" :key="a.id">
              <td>{{ a.object || '—' }}</td>
              <td class="tp-dim">{{ a.alarmType || '—' }}</td>
              <td><span class="tp-chip" :class="levelTone(a.level)">{{ a.level || '—' }}</span></td>
              <td class="tp-mono tp-dim">{{ a.createTime ? fmtTime(a.createTime) : '—' }}</td>
              <td class="tp-mono tp-dim">{{ a.lastTime ? fmtTime(a.lastTime) : '—' }}</td>
              <td class="tp-mono tp-dim">{{ a.recoverTime ? fmtTime(a.recoverTime) : '—' }}</td>
              <td class="tp-dim">{{ a.status || '—' }}</td>
            </tr>
            <tr v-if="!alarms.items.length"><td colspan="7" class="tp-empty">没有备份相关告警</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="tp-err" v-if="b.error">{{ b.error }}</div>
  </div>
</template>

<script setup lang="ts">
/**
 * 备份恢复（对齐 OCP 官方「备份恢复 · 概览」）：
 * 核心指标 → 备份对象（已备份/未备份）→ 数据/日志/恢复/清理任务 → 服务 / 存储 / 告警。
 */
import { computed } from 'vue'
import {
  backupObjects,
  cloud,
  reloadBackupTasks,
  setBackupObjFilter,
  setBackupTaskKind
} from '../../cloud/state'
import { clusterMode, clusterStatus, fmtTime } from '../../cloud/parts'

const b = cloud.backup
const TASK_KINDS: { key: CloudBackupTaskKind; label: string }[] = [
  { key: 'data', label: '数据备份' },
  { key: 'log', label: '日志备份' },
  { key: 'restore', label: '恢复任务' },
  { key: 'clean', label: '清理任务' }
]

const ov = computed(
  () =>
    b.bundle?.overview || {
      totalClusterNum: 0,
      hasBackupStrategyClusterNum: 0,
      logBackupObjectNum: 0,
      weekDataSuccessPct: 0,
      samplingTotal: 0,
      samplingSuccess: 0
    }
)
const all = computed(() => b.bundle?.objects || [])
const rows = computed(() => backupObjects())
const hasCount = computed(() => all.value.filter((o) => o.backupStatus === 'HAS_BACKUP_STRATEGY').length)
const tasks = computed(() => b.bundle?.tasks[b.taskKind] || [])
const services = computed(() => b.bundle?.services || [])
const storages = computed(() => b.bundle?.storages || [])
const alarms = computed(() => b.bundle?.alarms || { items: [], logDelayObjects: 0, typeStats: [] })

const pct = (a: number, t: number): number => (t > 0 ? Math.min(100, Math.round((a / t) * 100)) : 0)

function scheduleLabel(s: string): string {
  if (!s || s === 'NONE') return '未启动'
  if (s === 'RUNNING') return '运行中'
  if (s === 'SUSPENDED') return '已暂停'
  if (s === 'STOPPED') return '已停止'
  return s
}
function scheduleTone(s: string): string {
  if (s === 'RUNNING') return 'ok'
  if (s === 'SUSPENDED' || s === 'STOPPED') return 'warn'
  return 'idle'
}
function abilityLabel(a: string): string {
  // OCP 给的是 PHYSICAL_BACKUP / LOGICAL_BACKUP / PHYSICAL_AND_LOGICAL，转成运维看得懂的说法
  if (a === 'PHYSICAL_BACKUP') return '物理备份'
  if (a === 'LOGICAL_BACKUP') return '逻辑备份'
  if (a === 'PHYSICAL_AND_LOGICAL' || a === 'ALL') return '物理 + 逻辑'
  if (a === 'SUPPORTED') return '支持'
  if (a === 'UNSUPPORTED' || a === 'NONE') return '不支持'
  return a || '—'
}
function levelTone(l: string): string {
  const v = (l || '').toUpperCase()
  if (v === 'CRITICAL' || v === 'HIGH' || v === 'SEVERE') return 'bad'
  if (v === 'WARNING' || v === 'MEDIUM') return 'warn'
  return 'idle'
}
function taskTone(s: string): string {
  const v = (s || '').toUpperCase()
  if (['SUCCESSFUL', 'SUCCESS', 'FINISHED', 'COMPLETED'].includes(v)) return 'ok'
  if (['RUNNING', 'EXECUTING', 'PENDING'].includes(v)) return 'info'
  if (['FAILED', 'FAILURE', 'ERROR'].includes(v)) return 'bad'
  return 'idle'
}
async function switchKind(k: CloudBackupTaskKind): Promise<void> {
  setBackupTaskKind(k)
  // 首屏只拉 50 条，切成 100 条并顺手刷新一次，避免长列表被截断
  await reloadBackupTasks(k)
}
</script>

<style scoped>
.bp { display: flex; flex-direction: column; gap: 10px; }
.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
@media (max-width: 1180px) { .cols2 { grid-template-columns: 1fr; } }
.kpi { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.kc { display: flex; flex-direction: column; gap: 3px; }
.kc-label { font-size: 10.5px; color: var(--text-faint); }
.kc-val { font-family: var(--mono); font-size: 20px; font-weight: 650; line-height: 1.2; }
.kc-val em { font-style: normal; font-size: 11px; color: var(--text-faint); margin-left: 1px; }
.kc-val.ok { color: var(--green); }
.kc-val.warn { color: var(--yellow); }
.kc-val.bad { color: var(--red); }
.kc-sub { font-size: 9.5px; color: var(--text-faint); line-height: 1.5; min-height: 26px; }
.seg { display: flex; align-items: center; gap: 2px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 2px; }
.sg {
  height: 22px; padding: 0 8px; border: none; border-radius: 6px; background: none; color: var(--text-dim);
  font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.sg:hover { color: var(--text); }
.sg.on { background: var(--accent-dim); color: var(--accent); }
.cell-main { font-size: 11.5px; }
.cell-sub { font-size: 9.5px; color: var(--text-faint); margin-top: 1px; }
.ell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
