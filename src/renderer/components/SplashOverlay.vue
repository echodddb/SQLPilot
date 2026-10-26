<template>
  <div ref="rootEl" class="sp" :class="{ boot: booted, ready: seqDone, leaving }">
    <div class="sp-bg"></div>
    <div class="sp-grid"></div>
    <div class="sp-glow"></div>

    <i class="sp-brk a"></i><i class="sp-brk b"></i><i class="sp-brk c"></i><i class="sp-brk d"></i>

    <!-- 内容区按 620×410 设计稿换算成真实像素尺寸（不走 transform 缩放），HUD 贴窗口边不参与 -->
    <div class="sp-stage">
      <svg class="sp-wires">
        <line
          v-for="(n, i) in nodes"
          :key="'w' + i"
          :x1="n.x1" :y1="n.y1" :x2="n.x2" :y2="n.y2"
          :class="{ lit: hover === i }"
        />
      </svg>

      <div class="sp-orbit">
        <div class="ring r3"></div>
        <div class="ticks"></div>
        <div class="ring r2"></div>
        <div class="ring r1"></div>
      </div>

      <div class="sp-core" :class="{ hot: hover >= 0 }">
        <div class="arc a1"></div>
        <div class="arc a2"></div>
        <svg viewBox="0 0 24 24"><path d="M12 2.6 20.2 7.2v9.6L12 21.4 3.8 16.8V7.2z" /></svg>
        <span class="dot"></span>
      </div>

      <div class="sp-nodes">
        <div
          v-for="(n, i) in nodes"
          :key="n.k"
          class="sp-node"
          :class="{ in: shown[i] }"
          :style="{ left: n.x + 'px', top: n.y + 'px', '--dx': n.dx + 'px', '--dy': n.dy + 'px' }"
          @mouseenter="hover = i"
          @mouseleave="hover = -1"
        >
          <div class="face" :style="{ '--brand': n.brand }">
            <i class="cnr a"></i><i class="cnr b"></i><i class="cnr c"></i><i class="cnr d"></i>
            <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="k">{{ n.k }}</span>
            <div class="meta">
              <span class="nm">{{ n.name }}</span>
              <span class="pt">:{{ n.port }}</span>
            </div>
            <div class="flash"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="sp-scan" :class="{ run: scanning }"></div>

    <div class="sp-top">
      <span class="brand">SQLPILOT</span>
      <span class="sep"></span>
      <span class="sub">{{ isLock ? 'SESSION LOCKED · IDLE TIMEOUT' : 'DB ENGINE MATRIX' }}</span>
    </div>

    <div class="sp-bot" :class="{ done: seqDone }">
      <div class="st"><i class="dot"></i><span>{{ status }}</span></div>
      <div class="row">
        <div class="bar"><i :style="{ width: pct + '%' }"></i></div>
        <button
          class="sp-enter"
          :class="{ ready: seqDone }"
          type="button"
          :disabled="phase === 'wait'"
          @click="requestEnter"
        >
          <span>{{ enterLabel }}</span>
          <span class="arw">→</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ENGINES } from '../cloud/engines'

/**
 * 环形顺序与云管「选择云平台」页共用 engines.ts 的那一份清单，
 * 这里只做字段改名（code → k），别再单独排一份顺序。
 */
const DB = ENGINES.map((e) => ({ k: e.code, name: e.name, port: e.port, brand: e.brand }))

const CX = 310
const CY = 205
const R = 150

const T_START = 260   // 首个模块落位
const T_STEP = 168    // 模块间隔
const T_SCAN = 2180   // 扫描带
const T_READY = 2860  // 编排结束，进入驻留

const props = defineProps<{
  appReady: boolean
  /** boot=开机启动；lock=空闲锁屏（同一套动画，文案与出口不同） */
  mode?: 'boot' | 'lock'
  /** 锁屏时提示用的空闲阈值（分钟） */
  idleMin?: number
}>()
const isLock = computed(() => props.mode === 'lock')
const emit = defineEmits<{ (e: 'exiting'): void; (e: 'close'): void }>()

// 620×410 只是设计稿坐标，实际渲染按 --u 换算成真实像素。
// 不用 transform: scale：1px 边框被放大 1.9 倍后成了 1.9 个设备像素，
// 抗锯齿怎么调都是灰边，窗口越大越糊。
const unit = ref(1)
const nodes = computed(() => {
  const u = unit.value
  return DB.map((d, i) => {
    const ang = ((-90 + (360 / DB.length) * i) * Math.PI) / 180
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)
    // 取整到整数像素，避免落在半像素上再次发虚
    const px = (v: number) => Math.round(v * u)
    return {
      ...d,
      x: px(CX + R * cos),
      y: px(CY + R * sin),
      dx: px(-14 * cos),
      dy: px(-14 * sin),
      x1: px(CX + 58 * cos),
      y1: px(CY + 58 * sin),
      x2: px(CX + 108 * cos),
      y2: px(CY + 108 * sin)
    }
  })
})

const rootEl = ref<HTMLElement | null>(null)
const booted = ref(false)
const shown = ref<boolean[]>(DB.map(() => false))
const status = ref('POWER ON · INIT BUS')
const pct = ref(0)
const seqDone = ref(false)
const scanning = ref(false)
const leaving = ref(false)
const hover = ref(-1)
// run=动画进行中 hold=演完停住等用户点「进入」 wait=已点但主界面还没就绪
const phase = ref<'run' | 'hold' | 'wait'>('run')

const enterLabel = computed(() => {
  if (phase.value === 'wait') return '载入中'
  if (phase.value === 'run') return '跳过'
  return isLock.value ? '解锁进入' : '进入'
})

let timers: number[] = []
const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
const clearTimers = () => {
  timers.forEach((t) => clearTimeout(t))
  timers = []
}

// 自适应：算出缩放系数 --u，尺寸在 CSS 里用 calc(px * var(--u)) 展开成真实像素。
// 这样边框永远是 1px、字号永远是整数级像素，屏幕多大都锐利。
function updateScale(): void {
  const el = rootEl.value
  if (!el) return
  const fit = Math.min(window.innerWidth / 620, (window.innerHeight - 120) / 410)
  const u = Math.min(1.9, Math.max(0.55, fit))
  unit.value = u
  el.style.setProperty('--u', u.toFixed(4))
  el.style.setProperty('--hu', Math.min(1.35, Math.max(1, u * 0.8)).toFixed(4))
}

function start(): void {
  clearTimers()
  booted.value = false
  shown.value = DB.map(() => false)
  seqDone.value = false
  scanning.value = false
  leaving.value = false
  phase.value = 'run'
  hover.value = -1
  status.value = isLock.value ? 'LOCK · 会话已锁定' : 'POWER ON · INIT BUS'
  pct.value = 0

  // 不用 requestAnimationFrame 起跑：窗口在后台/未聚焦时 rAF 会被 Chromium 暂停，
  // 整个序列会卡在初始帧（实测会停在 POWER ON）。定时器 + 已渲染的一帧足够触发 CSS 过渡。
  window.setTimeout(() => {
    booted.value = true

    nodes.value.forEach((n, i) => {
      later(T_START + i * T_STEP, () => {
        shown.value[i] = true
        // 锁屏只是借这套动画，别再说"挂载驱动"，改成在逐个核对引擎
        status.value = isLock.value ? 'LOCK · ' + n.name.toUpperCase() : 'MOUNT · ' + n.name.toUpperCase() + ' DRIVER'
        pct.value = Math.round(((i + 1) / DB.length) * 90)
      })
    })

    later(T_SCAN, () => {
      scanning.value = true
      status.value = 'VERIFY · HANDSHAKE'
    })

    // 3s 演完就停在这儿等用户：不自动进主界面
    later(T_READY, () => {
      pct.value = 100
      seqDone.value = true
      phase.value = 'hold'
      status.value = isLock.value
        ? `LOCKED · 空闲 ${props.idleMin || 3} 分钟已自动锁定，点右下角进入`
        : 'SYSTEM READY · ' + DB.length + ' ENGINES ONLINE'
    })
  }, 30)
}

function requestEnter(): void {
  if (leaving.value) return
  // 主界面还没就绪就先等着，别让用户进到一个空窗口（锁屏时内容早就在了）
  if (!isLock.value && !props.appReady) {
    phase.value = 'wait'
    status.value = 'WAITING WORKBENCH…'
    return
  }
  close()
}

function close(): void {
  if (leaving.value) return
  leaving.value = true
  clearTimers()
  // 先通知外层「我要退了」，主界面同一时刻开始淡入，两段动画叠成一次交叉溶解
  emit('exiting')
  window.setTimeout(() => emit('close'), 300)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') requestEnter()
}

// 点了「进入」但当时还没就绪：一就绪就放行，不用再点一次
watch(
  () => props.appReady,
  (v) => {
    if (v && phase.value === 'wait') close()
  }
)

onMounted(() => {
  updateScale()
  window.addEventListener('resize', updateScale)
  window.addEventListener('keydown', onKey)
  start()
})

onBeforeUnmount(() => {
  clearTimers()
  window.removeEventListener('resize', updateScale)
  window.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
/* ============================================================
   配色唯一入口：换主题只改这一组变量。
   当前＝「紫」，取自 output/splash-themes.html 的 violet。
   9 个模块顶部那条品牌色不在这里（由 JS 里的 brand 字段注入）。
   ============================================================ */
.sp {
  /* —— 暗色：底色与窗口标题栏（- □ × 那条）同色，启动/锁屏时不会出现一条割裂的色带 —— */
  --bg-c: #0c111c;
  --bg-m: #060910;
  --bg-o: #04060c;

  --grid: rgba(255, 255, 255, 0.055);
  --halo: rgba(255, 255, 255, 0.06);

  --ring-a: rgba(255, 255, 255, 0.13);
  --ring-b: rgba(255, 255, 255, 0.19);
  --ring-c: rgba(255, 255, 255, 0.055);
  --tick: rgba(255, 255, 255, 0.25);

  --core: #ffffff;
  --core-hi: #ffffff;
  --core-dot: #ffffff;
  --dot-glow: rgba(255, 255, 255, 0.8);

  --wire: rgba(255, 255, 255, 0.12);
  --wire-lit: rgba(255, 255, 255, 0.6);

  --mod-1: #2b2b2b;
  --mod-2: #1c1c1c;
  --mod-h1: #363636;
  --mod-h2: #262626;
  --bd: rgba(255, 255, 255, 0.13);
  --bd-dim: rgba(255, 255, 255, 0.06);
  --bd-hi: rgba(255, 255, 255, 0.5);
  --cnr: rgba(255, 255, 255, 0.3);
  --glow-sh: rgba(255, 255, 255, 0.12);
  --mod-sh: none;

  --txt: #e4e4e4;
  --txt-hi: #ffffff;
  --txt-dim: rgba(212, 212, 212, 0.6);
  --accent: #4099ff;
  --hud: #f5f5f5;
  --hud-dim: rgba(255, 255, 255, 0.4);

  --bar-a: rgba(255, 255, 255, 0.16);
  --bar-b: #ffffff;
  --bar-glow: rgba(255, 255, 255, 0.45);
  --bar-dot: #ffffff;
  --ok: #46bf72;
  --ok-a: rgba(70, 191, 114, 0.2);
  --ok-hi: #87d9a4;
  --ok-dot: #d6f5e2;
  --ok-glow: rgba(70, 191, 114, 0.5);

  --btn-bg: rgba(255, 255, 255, 0.05);
  --btn-bd: rgba(255, 255, 255, 0.15);
  --btn-tx: rgba(255, 255, 255, 0.68);
  --btn-hb: rgba(255, 255, 255, 0.55);
  --btn-hbg: rgba(255, 255, 255, 0.1);
  --btn-grad1: #f5f5f5;
  --btn-grad2: #d4d4d4;
  --btn-glow: rgba(255, 255, 255, 0.22);
  --btn-ready-tx: #0d0d0d;

  --scan: rgba(255, 255, 255, 0.22);
  --scan-dim: rgba(255, 255, 255, 0.035);
  --flash: rgba(255, 255, 255, 0.3);

  --u: 1;
  --hu: 1;
  position: fixed;
  inset: 0;
  z-index: 9000;
  overflow: hidden;
  background: var(--bg-o);
  font-family: "JetBrains Mono", "Cascadia Mono", Consolas, "Microsoft YaHei", monospace;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  cursor: default;
  transition: opacity 0.26s cubic-bezier(0.4, 0, 0.2, 1), transform 0.26s cubic-bezier(0.4, 0, 0.2, 1);
}
/* —— 亮色（ZCode Light：#f8f8f8 底 / #ffffff 卡片 / 纯黑强调）—— */
html[data-theme='light'] .sp {
  --bg-c: #ffffff;
  --bg-m: #f4f7fb;
  --bg-o: #e9f0f9;

  --grid: rgba(13, 13, 13, 0.08);
  --halo: rgba(13, 13, 13, 0.03);

  --ring-a: rgba(13, 13, 13, 0.16);
  --ring-b: rgba(13, 13, 13, 0.25);
  --ring-c: rgba(13, 13, 13, 0.085);
  --tick: rgba(13, 13, 13, 0.32);

  --core: #0d0d0d;
  --core-hi: #000000;
  --core-dot: #0d0d0d;
  --dot-glow: rgba(13, 13, 13, 0.5);

  --wire: rgba(13, 13, 13, 0.17);
  --wire-lit: rgba(13, 13, 13, 0.7);

  --mod-1: #ffffff;
  --mod-2: #f7f8fa;
  --mod-h1: #ffffff;
  --mod-h2: #eef1f6;
  --bd: rgba(13, 13, 13, 0.17);
  --bd-dim: rgba(13, 13, 13, 0.09);
  --bd-hi: rgba(13, 13, 13, 0.4);
  --cnr: rgba(13, 13, 13, 0.36);
  --glow-sh: rgba(13, 13, 13, 0.08);
  /* 浅底白卡必须有极淡投影，否则卡片像浮在半空 */
  --mod-sh: 0 1px 3px rgba(13, 13, 13, 0.06);

  --txt: #262626;
  --txt-hi: #000000;
  --txt-dim: rgba(38, 38, 38, 0.62);
  --accent: #0b7fff;
  --hud: #0d0d0d;
  --hud-dim: rgba(13, 13, 13, 0.52);

  --bar-a: rgba(13, 13, 13, 0.12);
  --bar-b: #0d0d0d;
  --bar-glow: rgba(13, 13, 13, 0.2);
  --bar-dot: #0d0d0d;
  --ok: #1e8a3e;
  --ok-a: rgba(30, 138, 62, 0.14);
  --ok-hi: #2fa355;
  --ok-dot: #1e8a3e;
  --ok-glow: rgba(30, 138, 62, 0.28);

  --btn-bg: rgba(13, 13, 13, 0.04);
  --btn-bd: rgba(13, 13, 13, 0.13);
  --btn-tx: rgba(13, 13, 13, 0.68);
  --btn-hb: rgba(13, 13, 13, 0.4);
  --btn-hbg: rgba(13, 13, 13, 0.07);
  --btn-grad1: #262626;
  --btn-grad2: #0d0d0d;
  --btn-glow: rgba(13, 13, 13, 0.15);
  --btn-ready-tx: #ffffff;

  --scan: rgba(13, 13, 13, 0.12);
  --scan-dim: rgba(13, 13, 13, 0.025);
  --flash: rgba(13, 13, 13, 0.14);
}

/* 退场：260ms 内淡出并轻微推近，比主界面淡入快一拍，避免两层文字长时间叠在一起 */
.sp.leaving {
  opacity: 0;
  transform: scale(1.035);
  pointer-events: none;
}

.sp-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    62% 62% at 50% 46%,
    var(--bg-c) 0%,
    var(--bg-m) 62%,
    var(--bg-o) 100%
  );
}

.sp-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 40px 40px;
  -webkit-mask: radial-gradient(circle at 50% 46%, #000 0%, #000 42%, transparent 76%);
  mask: radial-gradient(circle at 50% 46%, #000 0%, #000 42%, transparent 76%);
  opacity: 0;
  transition: opacity 1.2s ease;
}
.sp.boot .sp-grid {
  opacity: 1;
}

.sp-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    34% 34% at 50% 45%,
    var(--halo),
    transparent 70%
  );
  opacity: 0;
  transition: opacity 1.4s ease;
}
.sp.boot .sp-glow {
  opacity: 1;
}

.sp-brk {
  position: absolute;
  width: 14px;
  height: 14px;
  border: 1px solid var(--ring-a);
}
.sp-brk.a { left: 12px; top: 12px; border-right: 0; border-bottom: 0; }
.sp-brk.b { right: 12px; top: 12px; border-left: 0; border-bottom: 0; }
.sp-brk.c { left: 12px; bottom: 12px; border-right: 0; border-top: 0; }
.sp-brk.d { right: 12px; bottom: 12px; border-left: 0; border-top: 0; }

/* ============ 内容区：等比缩放 ============ */
.sp-stage {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(620px * var(--u));
  height: calc(410px * var(--u));
  transform: translate(-50%, -50%);
}

.sp-wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.sp-wires line {
  stroke: var(--wire);
  stroke-width: 1.2;
  stroke-dasharray: 92;
  stroke-dashoffset: 92;
  transition: stroke-dashoffset 0.5s ease, stroke 0.1s linear;
}
.sp-wires line.lit {
  stroke: var(--wire-lit);
}
.sp.boot .sp-wires line {
  stroke-dashoffset: 0;
}

.sp-orbit {
  position: absolute;
  left: calc(310px * var(--u));
  top: calc(205px * var(--u));
  width: 0;
  height: 0;
}
.ring {
  position: absolute;
  border-radius: 50%;
  left: 50%;
  top: 50%;
  translate: -50% -50%;
  opacity: 0;
  transition: opacity 0.8s ease;
}
.sp.boot .ring {
  opacity: 1;
}
.r1 { width: calc(96px * var(--u)); height: calc(96px * var(--u)); border: 1px solid var(--ring-a); }
.r2 { width: calc(116px * var(--u)); height: calc(116px * var(--u)); border: 1px dashed var(--ring-b); animation: sp-spin 14s linear infinite; }
.r3 { width: calc(300px * var(--u)); height: calc(300px * var(--u)); border: 1px solid var(--ring-c); }
.ticks {
  position: absolute;
  left: 0;
  top: 0;
  width: calc(320px * var(--u));
  height: calc(320px * var(--u));
  translate: -50% -50%;
  border-radius: 50%;
  background: repeating-conic-gradient(
    from 0deg,
    var(--tick) 0deg 0.55deg,
    transparent 0.55deg 3deg
  );
  -webkit-mask: radial-gradient(circle, transparent 47.5%, #000 48%, #000 50%, transparent 50.5%);
  mask: radial-gradient(circle, transparent 47.5%, #000 48%, #000 50%, transparent 50.5%);
  animation: sp-spin 34s linear infinite reverse;
  opacity: 0;
  transition: opacity 1s ease 0.2s;
}
.sp.boot .ticks {
  opacity: 0.75;
}
@keyframes sp-spin {
  to { rotate: 360deg; }
}

.sp-core {
  position: absolute;
  left: calc(310px * var(--u));
  top: calc(205px * var(--u));
  width: calc(44px * var(--u));
  height: calc(44px * var(--u));
  translate: -50% -50%;
  display: grid;
  place-items: center;
  color: var(--core);
  opacity: 0;
  scale: 0.6;
  transition: opacity 0.6s ease 0.1s, scale 0.8s cubic-bezier(0.2, 1.5, 0.35, 1) 0.1s;
}
.sp.boot .sp-core {
  opacity: 1;
  scale: 1;
}
.sp-core svg {
  width: calc(28px * var(--u));
  height: calc(28px * var(--u));
}
.sp-core svg path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  opacity: 0.78;
  transition: stroke 0.12s linear, opacity 0.12s linear;
}
.sp-core .dot {
  position: absolute;
  width: calc(5px * var(--u));
  height: calc(5px * var(--u));
  border-radius: 50%;
  background: var(--core-dot);
  box-shadow: 0 0 10px 2px var(--dot-glow);
  transition: box-shadow 0.12s linear;
}
.sp-core.hot svg path {
  opacity: 1;
  stroke: var(--core-hi);
}
.sp-core.hot .dot {
  box-shadow: 0 0 18px 5px var(--dot-glow);
}
.arc {
  position: absolute;
  border-radius: 50%;
  border: 1px solid transparent;
}
.arc.a1 {
  width: calc(74px * var(--u));
  height: calc(74px * var(--u));
  border-top-color: var(--ring-b);
  border-left-color: var(--ring-c);
  animation: sp-spin 2.8s linear infinite;
}
.arc.a2 {
  width: calc(86px * var(--u));
  height: calc(86px * var(--u));
  border-bottom-color: var(--ring-c);
  border-right-color: var(--ring-c);
  animation: sp-spin 5.2s linear infinite reverse;
}
.sp.ready .arc.a1 {
  animation-duration: 9s;
}

/* ============ 模块 ============ */
.sp-nodes {
  position: absolute;
  inset: 0;
}
.sp-node {
  position: absolute;
  width: calc(80px * var(--u));
  height: calc(80px * var(--u));
  margin: calc(-40px * var(--u)) 0 0 calc(-40px * var(--u));
  /* 悬停要跟手：150ms 以内才不会被感知成「慢半拍」 */
  transition: transform 0.12s cubic-bezier(0.2, 0.9, 0.25, 1.2);
}
.sp-node:hover {
  transform: scale(1.3);
  z-index: 40;
}
/* 用 :has 判定「确实悬停在某个模块上」才压暗邻居；
   否则鼠标停在中心空白区时整屏模块都会变暗（实测就是这个问题） */
.sp-nodes:has(.sp-node:hover) .sp-node:not(:hover) {
  transform: scale(0.965);
}

.face {
  position: absolute;
  inset: 0;
  background: linear-gradient(155deg, var(--mod-1), var(--mod-2));
  border: 1px solid var(--bd);
  box-shadow: var(--mod-sh);
  opacity: 0;
  transform: translate(var(--dx, 0px), var(--dy, 0px)) scale(0.55) rotate(-7deg);
  filter: blur(1.2px);
  transition: opacity 0.45s ease, transform 0.55s cubic-bezier(0.18, 1.45, 0.32, 1),
    filter 0.3s ease, border-color 0.1s linear, box-shadow 0.1s linear, background 0.1s linear;
}
.sp-node.in .face {
  opacity: 1;
  transform: translate(0, 0) scale(1) rotate(0deg);
  filter: none;
}
.sp-nodes:has(.sp-node:hover) .sp-node:not(:hover) .face {
  opacity: 0.45;
  transform: scale(0.97);
  border-color: var(--bd-dim);
  /* 压暗也要跟手，否则整屏「慢慢灰下去」很拖 */
  transition: opacity 0.12s ease, transform 0.12s ease, border-color 0.12s ease;
}
.sp-node:hover .face {
  border-color: var(--bd-hi);
  box-shadow: 0 0 0 1px var(--ring-b), 0 8px 30px -6px var(--glow-sh),
    inset 0 0 24px -8px var(--bd);
  background: linear-gradient(155deg, var(--mod-h1), var(--mod-h2));
  transition: border-color 0.1s linear, box-shadow 0.1s linear, background 0.1s linear;
}
.face::before {
  content: "";
  position: absolute;
  left: calc(8px * var(--u));
  right: calc(8px * var(--u));
  top: -1px;
  height: calc(2px * var(--u));
  background: var(--brand);
  opacity: 0.3;
  transition: opacity 0.25s, box-shadow 0.25s;
}
.sp-node:hover .face::before {
  opacity: 1;
  box-shadow: 0 0 10px 0 var(--brand);
}

.cnr {
  position: absolute;
  width: calc(7px * var(--u));
  height: calc(7px * var(--u));
  border: 1px solid var(--cnr);
  transition: border-color 0.1s linear;
}
.cnr.a { left: -1px; top: -1px; border-right: 0; border-bottom: 0; }
.cnr.b { right: -1px; top: -1px; border-left: 0; border-bottom: 0; }
.cnr.c { left: -1px; bottom: -1px; border-right: 0; border-top: 0; }
.cnr.d { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
.sp-node:hover .cnr {
  border-color: var(--bd-hi);
}

.idx {
  position: absolute;
  right: calc(6px * var(--u));
  top: calc(4px * var(--u));
  font-size: calc(8px * var(--u));
  letter-spacing: 0.5px;
  color: var(--hud-dim);
}
.k {
  position: absolute;
  left: calc(9px * var(--u));
  bottom: calc(33px * var(--u));
  font-size: calc(15px * var(--u));
  letter-spacing: calc(1px * var(--u));
  font-weight: 600;
  color: var(--txt);
  transition: color 0.2s;
}
.sp-node:hover .k {
  color: var(--txt-hi);
}
.meta {
  position: absolute;
  left: calc(9px * var(--u));
  right: calc(9px * var(--u));
  bottom: calc(12px * var(--u));
  height: calc(14px * var(--u));
}
.meta span {
  position: absolute;
  left: 0;
  top: 0;
  font-size: calc(10px * var(--u));
  white-space: nowrap;
  transition: opacity 0.22s, transform 0.22s;
}
.nm {
  color: var(--txt-dim);
}
.pt {
  color: var(--accent);
  opacity: 0;
  transform: translateY(4px);
  letter-spacing: 0.5px;
}
.sp-node:hover .nm {
  opacity: 0;
  transform: translateY(-4px);
}
.sp-node:hover .pt {
  opacity: 1;
  transform: translateY(0);
}

.flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, var(--flash), transparent 70%);
  opacity: 0;
}
.sp-node.in .flash {
  animation: sp-flash 0.45s ease-out;
}
@keyframes sp-flash {
  0% { opacity: 0.85; }
  100% { opacity: 0; }
}

/* ============ 扫描带（铺满窗口，按比例下落） ============ */
.sp-scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 22%;
  top: -22%;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    transparent,
    var(--scan-dim) 40%,
    var(--scan) 50%,
    var(--scan-dim) 60%,
    transparent
  );
  opacity: 0;
}
.sp-scan.run {
  animation: sp-sweep 0.78s cubic-bezier(0.4, 0, 0.3, 1) forwards;
}
@keyframes sp-sweep {
  0% { top: -22%; opacity: 0; }
  15% { opacity: 0.9; }
  100% { top: 100%; opacity: 0; }
}

/* ============ HUD：贴窗口边，只按 --hu 微调字号 ============ */
.sp-top {
  position: absolute;
  left: 26px;
  right: 26px;
  top: 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: calc(11px * var(--hu));
  letter-spacing: 2px;
}
.sp-top .brand {
  color: var(--hud);
  font-weight: 700;
  letter-spacing: 3px;
}
.sp-top .sep {
  width: 18px;
  height: 1px;
  background: var(--ring-b);
}
.sp-top .sub {
  color: var(--hud-dim);
}

/* 右下角：进入按钮（动画进行中先当跳过用） */
.row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.row .bar {
  flex: 1;
  min-width: 0;
}
.sp-enter {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: calc(30px * var(--hu));
  padding: 0 calc(16px * var(--hu));
  border: 1px solid var(--btn-bd);
  background: var(--btn-bg);
  color: var(--btn-tx);
  font-family: inherit;
  font-size: calc(12px * var(--hu));
  letter-spacing: 2px;
  cursor: pointer;
  transition: color 0.18s, border-color 0.18s, background 0.18s, box-shadow 0.18s;
}
.sp-enter .arw {
  font-size: calc(12px * var(--hu));
  opacity: 0.5;
  transition: transform 0.2s, opacity 0.2s;
}
.sp-enter:hover:not(:disabled) {
  color: var(--hud);
  border-color: var(--btn-hb);
  background: var(--btn-hbg);
  box-shadow: 0 0 20px -5px var(--btn-glow);
}
.sp-enter:hover:not(:disabled) .arw {
  opacity: 1;
  transform: translateX(3px);
}
.sp-enter:active:not(:disabled) {
  background: var(--btn-hbg);
}
.sp-enter:disabled {
  cursor: default;
  opacity: 0.55;
}
/* 演完进「进入」态：更亮、带呼吸，成为画面里唯一的行动点 */
.sp-enter.ready {
  border-color: var(--btn-hb);
  background: linear-gradient(180deg, var(--btn-grad1), var(--btn-grad2));
  color: var(--btn-ready-tx);
  box-shadow: 0 0 26px -8px var(--btn-glow), inset 0 0 18px -10px var(--btn-glow);
  animation: sp-breathe 2.6s ease-in-out infinite;
}
.sp-enter.ready .arw {
  opacity: 0.95;
}
@keyframes sp-breathe {
  0%, 100% { box-shadow: 0 0 22px -9px var(--btn-glow), inset 0 0 18px -10px var(--btn-glow); }
  50% { box-shadow: 0 0 34px -6px var(--btn-glow), inset 0 0 22px -8px var(--btn-glow); }
}

.sp-bot {
  position: absolute;
  left: 26px;
  right: 26px;
  bottom: 24px;
}
.st {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: calc(11px * var(--hu));
  letter-spacing: 1.4px;
  color: var(--txt-dim);
  margin-bottom: 9px;
  height: 12px;
  white-space: nowrap;
}
.st .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--bar-b);
  box-shadow: 0 0 8px 1px var(--bar-glow);
  animation: sp-blink 1.1s steps(1) infinite;
}
.sp-bot.done .st .dot {
  background: var(--ok-hi);
  box-shadow: 0 0 10px 2px var(--ok-glow);
  animation: none;
}
@keyframes sp-blink {
  50% { opacity: 0.18; }
}
.bar {
  height: 1px;
  background: var(--ring-a);
  position: relative;
}
.bar > i {
  position: absolute;
  left: 0;
  top: -1px;
  height: 3px;
  background: linear-gradient(90deg, var(--bar-a), var(--bar-b));
  box-shadow: 0 0 10px 0 var(--bar-glow);
  transition: width 0.5s cubic-bezier(0.2, 0.8, 0.3, 1);
}
.bar > i::after {
  content: "";
  position: absolute;
  right: -2px;
  top: -2px;
  width: 7px;
  height: 7px;
  background: var(--bar-dot);
  box-shadow: 0 0 12px 3px var(--bar-glow);
}
/* 完成态进度条保持主色（白/黑），只有状态点转绿：
   整条变绿会在灰阶画面里抢成焦点，跟 ZCode 的克制调性不符 */
.sp-bot.done .bar > i {
  box-shadow: 0 0 8px 0 var(--bar-glow);
}
</style>
