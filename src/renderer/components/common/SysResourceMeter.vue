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
        <!-- 单独一行：跟上面挤一行时会在换行处留下一个孤零零的「·」 -->
        <span v-if="info" class="dim full">已运行 {{ uptimeText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { diskTitle, fmtGB, spark, lvl, useSysResources } from '../../sysres'

const { cpuHist, memHist, lastCpu, memPct, cpuTitle, memTitle, disks, info, histLen } = useSysResources()

const hover = ref(false)
/** 点一下钉住，鼠标移开也不收（想对照着看时不用一直悬着） */
const pinned = ref(false)
const show = computed(() => hover.value || pinned.value)

/** 顶栏上只放系统盘（通常是 C:）：其余盘在浮层里逐个列 */
const sysDisk = computed(() => disks.value[0] || null)

const totalFree = computed(() => fmtGB(disks.value.reduce((a, d) => a + d.freeBytes, 0)))
const totalAll = computed(() => fmtGB(disks.value.reduce((a, d) => a + d.totalBytes, 0)))

const uptimeText = computed(() => {
  const s = info.value?.uptimeSec || 0
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
})

const summaryTitle = computed(() => {
  const parts = [
    `CPU ${lastCpu.value == null ? '—' : lastCpu.value + '%'}`,
    `内存 ${memPct.value == null ? '—' : memPct.value + '%'}`
  ]
  if (sysDisk.value) parts.push(`${sysDisk.value.drive} 剩余 ${fmtGB(sysDisk.value.freeBytes)} GB`)
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
@media (max-width: 1040px) {
  .srm { display: none; }
}
</style>
