<template>
  <!-- 顶栏资源概述：CPU / 内存 / 磁盘一眼可见，悬停（或点击）展开趋势与各盘明细。
       数据来自 renderer/sysres.ts 的单例采样，与 AI 侧栏底部那份是同一个轮询器。 -->
  <div class="srm" :class="{ pinned }" @mouseenter="hover = true" @mouseleave="hover = false">
    <button
      class="srm-pill"
      :class="{ on: show }"
      :title="summaryTitle"
      @click="pinned = !pinned"
    >
      <span class="c">
        <i class="dot" :class="lvl(lastCpu)"></i>
        <span class="lbl">CPU</span>
        <b :class="lvl(lastCpu)">{{ lastCpu == null ? '—' : lastCpu + '%' }}</b>
      </span>
      <span class="div"></span>
      <span class="c">
        <i class="dot" :class="lvl(memPct)"></i>
        <span class="lbl">内存</span>
        <b :class="lvl(memPct)">{{ memPct == null ? '—' : memPct + '%' }}</b>
      </span>
      <span class="div"></span>
      <span class="c">
        <i class="dot" :class="lvl(sysDisk && sysDisk.usedPct)"></i>
        <!-- 直接写盘符（C盘）：只写「磁盘」看不出是哪一块 -->
        <span class="lbl">{{ sysDisk ? sysDisk.drive.charAt(0) + '盘' : '磁盘' }}</span>
        <b :class="lvl(sysDisk && sysDisk.usedPct)">{{ sysDisk ? sysDisk.usedPct + '%' : '—' }}</b>
      </span>
      <!-- 温度只在宽屏出现在顶栏：它 30 秒才更一次，挤的时候优先让位给 CPU/内存/磁盘 -->
      <span class="div pill-temp"></span>
      <span class="c pill-temp">
        <i class="dot" :class="tempLvl"></i>
        <span class="lbl">温度</span>
        <b :class="tempLvl">{{ tempText }}</b>
      </span>
    </button>

    <div v-if="show" class="srm-pop" role="dialog">
      <div class="pop-head">
        <b>本机资源</b>
        <span class="dim">{{ info ? info.hostname : '读取中…' }}</span>
        <span style="flex: 1"></span>
        <span class="dim">{{ histLen }} 点 · 3 秒采样</span>
      </div>

      <div class="pop-row" :title="cpuTitle">
        <span class="k">CPU</span>
        <svg class="spark" viewBox="0 0 100 22" preserveAspectRatio="none">
          <polyline :points="spark(cpuHist)" />
        </svg>
        <span class="v" :class="lvl(lastCpu)">{{ lastCpu == null ? '—' : lastCpu + '%' }}</span>
      </div>
      <div class="pop-sub">{{ info ? `${info.cpuModel} · ${info.cores} 线程` : '—' }}</div>

      <div class="pop-row" :title="memTitle">
        <span class="k">内存</span>
        <svg class="spark" viewBox="0 0 100 22" preserveAspectRatio="none">
          <polyline class="mem" :points="spark(memHist)" />
        </svg>
        <span class="v" :class="lvl(memPct)">{{ memPct == null ? '—' : memPct + '%' }}</span>
      </div>
      <div class="pop-sub">
        {{ info ? `已用 ${fmtGB(info.memTotal - info.memFree)} / ${fmtGB(info.memTotal)} GB · 可用 ${fmtGB(info.memFree)} GB` : '—' }}
      </div>

      <div class="pop-row" :title="tempTitle">
        <span class="k">温度</span>
        <div class="bar">
          <div class="fill" :class="tempLvl" :style="{ width: tempBarW }"></div>
        </div>
        <span class="v" :class="tempLvl">{{ tempText }}</span>
      </div>
      <div class="pop-sub" :title="tempTitle">{{ tempSub }}</div>

      <div class="pop-sep"></div>

      <div v-for="d in disks" :key="d.drive" class="pop-row disk" :title="diskTitle(d)">
        <span class="k">{{ d.drive }}</span>
        <div class="bar"><div class="fill" :class="lvl(d.usedPct)" :style="{ width: Math.min(100, d.usedPct) + '%' }"></div></div>
        <span class="v" :class="lvl(d.usedPct)">{{ d.usedPct }}%</span>
      </div>
      <div v-if="!disks.length" class="pop-sub">没有读到磁盘信息</div>
      <div v-if="disks.length" class="pop-sub">
        剩余 {{ totalFree }} GB，共 {{ totalAll }} GB（{{ disks.length }} 个盘）
      </div>

      <div class="pop-sep"></div>
      <div class="pop-foot">
        <span>SQLPilot 占用 {{ info ? fmtGB(info.rssBytes) + ' GB' : '—' }}</span>
        <span v-if="info && info.platform" class="dim">{{ info.platform }}</span>
        <!-- 分两行写：跟上面挤一行时会在换行处留下一个孤零零的「·」，而且这组数字最容易被误读。
             「本机已开机」是整台机器（os.uptime），「本次运行」才是 SQLPilot 进程；
             Windows 开了快速启动时关机不算重置内核计时，所以要带上具体起始日期，
             用户才能看出这个时长跨了关机（本机 58 天 = 9/02 起一直累计）。 -->
        <span v-if="info" class="dim full" :title="uptimeTitle">本机已开机 {{ uptimeText }}（自 {{ bootText }} 起）</span>
        <span v-if="info" class="dim full" :title="uptimeTitle">SQLPilot 本次运行 {{ appUptimeText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { appStartedAt, diskTitle, fmtGB, spark, lvl, useSysResources } from '../../sysres'

const { cpuHist, memHist, lastCpu, memPct, cpuTitle, memTitle, disks, info, temp, histLen } = useSysResources()

const hover = ref(false)
/** 点一下钉住，鼠标移开也不收（想对照着看时不用一直悬着） */
const pinned = ref(false)
const show = computed(() => hover.value || pinned.value)

/** 顶栏上只放系统盘（通常是 C:）：其余盘在浮层里逐个列 */
const sysDisk = computed(() => disks.value[0] || null)

const totalFree = computed(() => fmtGB(disks.value.reduce((a, d) => a + d.freeBytes, 0)))
const totalAll = computed(() => fmtGB(disks.value.reduce((a, d) => a + d.totalBytes, 0)))

/** 毫秒 → 「x 天 x 小时 / x 小时 x 分 / x 分」 */
function humanSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d} 天 ${h} 小时`
  if (h > 0) return `${h} 小时 ${m} 分`
  // 刚启动时显示「0 分」很怪，直接说不足 1 分钟
  return m > 0 ? `${m} 分` : '不足 1 分钟'
}

/** 整台机器的开机时长（主进程 os.uptime） */
const uptimeText = computed(() => humanSpan((info.value?.uptimeSec || 0) * 1000))

/** 内核会话起点 → 「09-02 08:42」；快速启动下这个日期会早于用户认知里的"上次开机" */
const bootText = computed(() => {
  const at = info.value?.bootAt
  if (!at) return '—'
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})

/** SQLPilot 本次运行的时长：渲染层启动到最近一次采样的间隔 */
const appUptimeText = computed(() => humanSpan((info.value?.at || Date.now()) - appStartedAt))

const uptimeTitle = computed(() =>
  `本机已开机：整台电脑的内核计时（Windows 的 os.uptime），起始于 ${bootText.value}\n` +
  `SQLPilot 本次运行：本次启动程序至今\n` +
  `注意：Windows 开启「快速启动」后，关机再开机只是休眠恢复，内核计时不清零，\n` +
  `所以「本机已开机」会比实际开机时长更长。看「SQLPilot 本次运行」才是程序跑了多久`
)

// ---------- 温度（ACPI 热区） ----------
//
// 主进程 30 秒才采一次（要起 PowerShell 读性能计数器），和 3 秒的资源轮询不是同一尺度，
// 所以这里只做"当前值 + 条形"，不画趋势线——跟 CPU/内存的趋势线并排画会被误读成同一时间轴。

/** 温度等级：阈值比 CPU 占用率严一点（ACPI 热区读数通常低于核心温度，70℃ 已经不低） */
const tempLvl = computed(() => {
  const t = temp.value?.max
  if (t == null) return ''
  return t > 85 ? 'danger' : t > 70 ? 'warn' : 'ok'
})

/** 条形宽度：20℃ 起算、100℃ 满格（绝对刻度，不随机型变化） */
const tempBarW = computed(() => {
  const t = temp.value?.max
  if (t == null) return '0%'
  return Math.max(0, Math.min(100, ((t - 20) / 80) * 100)).toFixed(1) + '%'
})

const tempText = computed(() => {
  const t = temp.value
  if (!t || (t.at === 0 && !t.error)) return '—'
  if (t.max == null) return '—'
  return `${Math.round(t.max)}℃`
})

const tempSub = computed(() => {
  const t = temp.value
  if (!t || (t.at === 0 && !t.error)) return '首次采样中，约 3 秒后显示'
  if (t.max == null) return t.error || '本机未上报热区温度'
  const secs = Math.max(0, Math.round(((info.value?.at || Date.now()) - t.at) / 1000))
  return `${t.zones.length} 个热区 · ${secs} 秒前采样 · 非核心温度`
})

const tempTitle = computed(() => {
  const t = temp.value
  if (!t || (t.at === 0 && !t.error)) return 'ACPI 热区温度：首次采样中…'
  if (t.max == null) return `ACPI 热区温度不可用：${t.error || '未知原因'}`
  return [
    'ACPI 热区温度（主板传感器读数，通常明显低于 CPU 核心温度）',
    ...t.zones.map((z) => `${z.zone}  ${z.celsius.toFixed(1)}℃`),
    '主进程每 30 秒采样一次（读 WMI，无需管理员权限）'
  ].join('\n')
})

const summaryTitle = computed(() => {
  const parts = [
    `CPU ${lastCpu.value == null ? '—' : lastCpu.value + '%'}`,
    `内存 ${memPct.value == null ? '—' : memPct.value + '%'}`
  ]
  if (sysDisk.value) parts.push(`${sysDisk.value.drive} 剩余 ${fmtGB(sysDisk.value.freeBytes)} GB`)
  const t = temp.value
  if (t && t.max != null) parts.push(`温度 ${Math.round(t.max)}℃`)
  return `本机资源：${parts.join(' · ')}\n点击${pinned.value ? '取消' : ''}固定详情面板`
})
</script>

<style scoped>
/* 顶栏是拖窗口区域（-webkit-app-region: drag），交互元素必须显式让出 */
.srm {
  position: relative;
  flex: none;
  -webkit-app-region: no-drag;
  /* 顶栏在自己之后还渲染了内容区，不抬层级的话浮层会被下面的模块盖住 */
  z-index: 45;
}

.srm-pill {
  display: flex;
  align-items: center;
  gap: 0;
  height: 24px;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  color: var(--text-dim);
  font-family: inherit;
  cursor: pointer;
  transition: border-color .14s ease, background .14s ease;
}
.srm-pill:hover, .srm-pill.on { border-color: var(--border-strong); background: var(--bg-card-hover); }

.c { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; font-size: 11px; }
.c .lbl { color: var(--text-faint); font-size: 10.5px; letter-spacing: .3px; }
.c b { font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--text); min-width: 27px; text-align: right; }
.c b.ok { color: var(--green); }
.c b.warn { color: var(--yellow); }
.c b.danger { color: var(--red); }

/* 小圆点代替图标：三行数据里最省横向空间的语义标记 */
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.dot.ok { background: var(--green); }
.dot.warn { background: var(--yellow); }
.dot.danger { background: var(--red); }

.div { width: 1px; height: 12px; background: var(--border); flex-shrink: 0; }

/* ---- 展开面板 ---- */
.srm-pop {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: 280px;
  padding: 10px 12px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--bg-card);
  box-shadow: var(--shadow-lg);
  color: var(--text-dim);
  font-size: 11px;
  z-index: 46;
}
.pop-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 8px; color: var(--text); }
.pop-head b { font-size: 11.5px; }
.pop-head .dim, .pop-foot .dim { color: var(--text-faint); font-size: 10px; }

.pop-row { display: flex; align-items: center; gap: 8px; }
.pop-row .k {
  width: 34px; flex-shrink: 0; font-size: 10.5px; color: var(--text-faint); letter-spacing: .3px;
}
.pop-row .v {
  width: 34px; flex-shrink: 0; text-align: right;
  font-family: var(--mono); font-size: 10.5px; color: var(--text);
}
.pop-row .v.ok { color: var(--green); }
.pop-row .v.warn { color: var(--yellow); }
.pop-row .v.danger { color: var(--red); font-weight: 700; }

.spark { flex: 1; height: 20px; min-width: 0; }
.spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.4; vector-effect: non-scaling-stroke; opacity: .9; }
.spark polyline.mem { stroke: var(--green); }

.pop-sub {
  margin: 1px 0 7px 42px; font-size: 10px; color: var(--text-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.pop-row.disk { margin-bottom: 4px; }
.bar { flex: 1; height: 5px; border-radius: 99px; background: var(--bg-input); overflow: hidden; }
.fill { height: 100%; border-radius: 99px; background: var(--green); transition: width .3s ease; }
.fill.warn { background: var(--yellow); }
.fill.danger { background: var(--red); }

.pop-sep { height: 1px; background: var(--border); margin: 7px 0; }
.pop-foot { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 10px; color: var(--text-faint); }
.pop-foot .full { flex-basis: 100%; }

/* 顶栏挤的时候先把「CPU/内存/磁盘」文字收掉，只留圆点+数值，别把模型下拉顶走 */
@media (max-width: 1240px) {
  .c .lbl { display: none; }
  .c { padding: 0 7px; }
}
/* 温度 30 秒才更新一次，属于"顺带一看"的信息：窄屏直接整项收掉，不跟 CPU/内存抢位置 */
.pill-temp { display: none; }
@media (min-width: 1241px) {
  .div.pill-temp { display: block; }
  .c.pill-temp { display: inline-flex; }
}
@media (max-width: 1040px) {
  .srm { display: none; }
}
</style>
