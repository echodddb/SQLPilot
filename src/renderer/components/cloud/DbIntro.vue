<template>
  <div ref="rootEl" class="in" :style="rootStyle" :class="[vendor, { hold: seqDone }]">
    <div class="in-bg"></div>
    <div class="in-grid"></div>
    <div class="in-halo"></div>

    <div class="in-stage">
      <svg class="in-wires">
        <line
          v-for="(w, i) in wires"
          :key="'w' + i"
          :x1="w.x1" :y1="w.y1" :x2="w.x2" :y2="w.y2"
          :class="{ lit: wireLit[i], dash: w.dash }"
        />
      </svg>

      <!-- Zone / SGA 这类容器用虚线框圈起来 -->
      <div
        v-for="(f, i) in frames"
        :key="'f' + i"
        class="frame"
        :class="{ on: shown[0] }"
        :style="{ left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' }"
      >
        <span :style="{ fontSize: f.fs + 'px' }">{{ f.label }}</span>
      </div>

      <div
        v-for="(m, i) in layout"
        :key="m.k + (m.s || '')"
        class="mod"
        :class="[m.shape, m.tone, { on: shown[i] }]"
        :style="{
          left: m.cx + 'px',
          top: m.cy + 'px',
          '--w': m.w + 'px',
          '--h': m.h + 'px',
          '--tx': m.tx + 'px',
          '--ty': m.ty + 'px'
        }"
        @mouseenter="onEnter($event, m)"
        @mouseleave="tip = null"
      >
        <div class="shape"></div>
        <div class="body" :style="{ padding: `0 ${m.pad}px` }">
          <b :style="{ fontSize: m.fs + 'px' }">{{ m.k }}</b>
          <span v-if="m.s" :style="{ fontSize: m.fs2 + 'px' }">{{ m.s }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="tip"
      class="tip-float"
      :style="{ left: tip.x + 'px', top: tip.y + 'px', transform: tip.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)' }"
    >
      <b>{{ tip.k }}<em v-if="tip.s"> · {{ tip.s }}</em></b>
      <span>{{ tip.desc }}</span>
    </div>

    <header class="in-top">
      <span class="brand">{{ title }}</span>
      <span class="sep"></span>
      <span class="sub">{{ subtitle }}</span>
    </header>

    <div class="in-bot">
      <div class="st"><i class="dot"></i><span>{{ status }}</span></div>
      <div class="row">
        <div class="bar"><i :style="{ width: pct + '%' }"></i></div>
        <button class="in-enter" :class="{ ready: seqDone }" type="button" @click="enter">
          <span>{{ seqDone ? '进入云管平台' : '跳过' }}</span>
          <span class="arw">→</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { engineOf, type EngineId } from '../../cloud/engines'
import { INTRO_MODELS } from '../../cloud/introModels'
import { autoAdvance, introScale } from '../../app-mode'

const W = 720
const H = 420

const props = defineProps<{ vendor: EngineId }>()
const emit = defineEmits<{ (e: 'done'): void }>()

/** 每个引擎一套架构模型：模块坐标、虚线框、连线都在 introModels.ts 里 */
const model = computed(() => INTRO_MODELS[props.vendor] || INTRO_MODELS.ocp)
const brand = computed(() => engineOf(props.vendor).brand)

/** 品牌色只给色相，最终颜色和主题文字色混一次，深浅主题都不会刺眼 */
const rootStyle = computed(() => ({ '--i-brand': brand.value, ...(model.value.tones || {}) }))

const title = computed(() => model.value.title)
const subtitle = computed(() => model.value.subtitle)

const rootEl = ref<HTMLElement | null>(null)
const unit = ref(1)
const shown = ref<boolean[]>([])
const wireLit = ref<boolean[]>([])
const seqDone = ref(false)
const pct = ref(0)
const status = ref('')
const tip = ref<{ k: string; s?: string; desc: string; x: number; y: number; below: boolean } | null>(null)

const layout = computed(() => {
  const u = unit.value
  return model.value.mods.map((m) => ({
    ...m,
    cx: Math.round(m.cx * u),
    cy: Math.round(m.cy * u),
    w: Math.round(m.w * u),
    h: Math.round(m.h * u),
    tx: Math.round(m.from[0] * u),
    ty: Math.round(m.from[1] * u),
    // 字号/内边距直接用 JS 算成 px：calc(px * var(--u)) 在这个组件里求值不生效（--u 明明是 1.5）
    fs: Math.round(12 * u),
    fs2: Math.round(9.5 * u),
    pad: Math.round(12 * u)
  }))
})

const frames = computed(() => {
  const u = unit.value
  return model.value.frames.map((f) => ({
    ...f,
    x: Math.round(f.x * u),
    y: Math.round(f.y * u),
    w: Math.round(f.w * u),
    h: Math.round(f.h * u),
    fs: Math.round(10 * u)
  }))
})

const wires = computed(() => {
  const u = unit.value
  const src = model.value.mods
  return model.value.wires.map(([a, b, dash]) => {
    const A = src[a]
    const B = src[b]
    return {
      x1: Math.round(A.cx * u),
      y1: Math.round(A.cy * u),
      x2: Math.round(B.cx * u),
      y2: Math.round(B.cy * u),
      dash: !!dash
    }
  })
})

let timers: number[] = []
const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))

function updateScale(): void {
  const el = rootEl.value
  if (!el) return
  const fit = Math.min(window.innerWidth / W, (window.innerHeight - 210) / H)
  const u = Math.min(1.5, Math.max(0.5, fit))
  unit.value = u
  el.style.setProperty('--u', u.toFixed(4))
}

function onEnter(e: MouseEvent, m: { k: string; s?: string; desc: string }): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // 悬停放大 1.3 倍（origin 在中心），上下各外扩 15%，提示要让开这段
  const grow = r.height * 0.15
  const below = r.bottom + grow + 110 < window.innerHeight
  tip.value = {
    ...m,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(below ? r.bottom + grow + 8 : r.top - grow - 8),
    below
  }
}

function enter(): void {
  emit('done')
}

function play(): void {
  const src = model.value.mods
  const ws = model.value.wires
  const wc = ws.length
  shown.value = src.map(() => false)
  wireLit.value = new Array(wc).fill(false)
  seqDone.value = false
  pct.value = 0
  status.value = model.value.boot[0]

  // 各引擎的序列长度并不相同（OCP / Oracle 8 块 2760ms，达梦、高斯 12 块要 3200ms），
  // 所以先算出真实的收尾时点，再拿它当缩放基准。按常量 2760 算的话，块多的引擎
  // 在工作模式下会跑到 1.7s，收尾还没演完就进云管了。
  const wiresAt = 120 + src.length * 130 + 120
  const end = Math.max(2760, wiresAt + wc * 90 + 320)
  // 工作模式整段压到 1.5s：所有时点乘同一个系数，模块不会挤成一团
  const k = introScale(end)
  const at = (ms: number) => Math.round(ms * k)

  src.forEach((_, i) => {
    later(at(120 + i * 130), () => {
      shown.value[i] = true
      pct.value = Math.round(((i + 1) / src.length) * 62)
    })
  })

  later(at(wiresAt), () => {
    status.value = model.value.boot[1]
    ws.forEach((_, i) => {
      later(at(i * 90), () => {
        wireLit.value[i] = true
        pct.value = 62 + Math.round(((i + 1) / wc) * 30)
      })
    })
  })

  // 模块多的引擎（达梦 12 块）要把收尾时间一起往后推，别抢在连线前面
  later(at(end), () => {
    seqDone.value = true
    pct.value = 100
    status.value = model.value.boot[2]
    // 工作模式：到点直接进云管，不再停在就绪态等人点
    if (autoAdvance(end)) enter()
  })
}

onMounted(() => {
  updateScale()
  window.addEventListener('resize', updateScale)
  play()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateScale)
  timers.forEach(clearTimeout)
})
</script>

<style scoped>
/* ============================================================
   配色不再自带一套深色底：全部落到应用主题变量上
   （--bg / --bg-card / --text / --accent …），深浅主题自动跟随，
   动画画布就是应用画布的延伸。
   每个引擎只提供一个品牌色相（--i-brand，由组件内联注入），
   再和主题文字色混一次，深浅主题各自得到合适的明度。
   ============================================================ */
.in {
  --u: 1;
  --i-bg: var(--bg);
  --i-card: var(--bg-card);
  --i-text: var(--text);
  --i-dim: var(--text-dim);

  --i-accent: color-mix(in srgb, var(--i-brand, var(--accent)) 80%, var(--text));
  --i-accent2: color-mix(in srgb, var(--i-brand, var(--accent)) 58%, var(--text));

  /* 五类组件的色相，深/浅主题各自算各自的明度 */
  --tone-core: var(--i-accent);
  /* 进程/节点用主色相的实色，内存区用浅一档，免得两种蓝糊成一样 */
  --tone-compute: var(--i-accent);
  --tone-store: var(--green);
  --tone-net: var(--purple);
  --tone-mem: var(--i-accent2);

  /* 以下都由 --i-accent 派生：换引擎/换主题会自动跟着变 */
  --i-line: color-mix(in srgb, var(--i-accent) 32%, transparent);
  --i-frame: color-mix(in srgb, var(--i-accent) 44%, transparent);
  --i-frame-fill: color-mix(in srgb, var(--i-accent) 5%, transparent);
  --i-grid: color-mix(in srgb, var(--text) 6%, transparent);

  position: absolute;
  inset: 0;
  overflow: hidden;
  user-select: none;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
  background: var(--i-bg);
  color: var(--i-text);
}

.mod.core { --cl: var(--tone-core); }
.mod.compute { --cl: var(--tone-compute); }
.mod.store { --cl: var(--tone-store); }
.mod.net { --cl: var(--tone-net); }
.mod.mem { --cl: var(--tone-mem); }

.in-bg {
  position: absolute;
  inset: 0;
  /* 与应用画布同源：中心一层极淡的厂商色晕，四周回到 --bg */
  background: radial-gradient(
    62% 60% at 50% 46%,
    color-mix(in srgb, var(--i-accent) 9%, var(--i-bg)) 0%,
    var(--i-bg) 68%,
    var(--i-bg) 100%
  );
}
.in-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--i-grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--i-grid) 1px, transparent 1px);
  background-size: 44px 44px;
  -webkit-mask: radial-gradient(circle at 50% 48%, #000 0%, #000 42%, transparent 72%);
  mask: radial-gradient(circle at 50% 48%, #000 0%, #000 42%, transparent 72%);
}
.in-halo {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(30% 30% at 50% 48%, color-mix(in srgb, var(--i-accent) 8%, transparent), transparent 70%);
}

/* ============ 舞台（720×420 设计稿换算真实像素） ============ */
.in-stage {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(720px * var(--u));
  height: calc(420px * var(--u));
  transform: translate(-50%, -50%);
}
.in-wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.in-wires line {
  stroke: var(--i-line);
  stroke-width: 1;
  stroke-dasharray: 6 5;
  opacity: 0;
  transition: opacity 0.4s ease, stroke 0.2s ease;
}
.in-wires line.lit { opacity: 1; stroke: var(--i-accent); stroke-dasharray: none; }
.in-wires line.dash.lit { stroke-dasharray: 4 4; opacity: 0.5; }

/* 虚线容器：Zone / SGA。标签骑在边框上，靠不透明底色压住那一段虚线 */
.frame {
  position: absolute;
  transform: translate(-50%, -50%);
  border: 1px dashed var(--i-frame);
  border-radius: calc(8px * var(--u));
  background: var(--i-frame-fill);
  /* 显式声明：标签要越出框体（top 为负），不能被裁 */
  overflow: visible;
  z-index: 2;
  opacity: 0;
  transition: opacity 0.5s ease 0.15s;
}
.frame.on { opacity: 1; }
.frame > span {
  position: absolute;
  left: calc(10px * var(--u));
  top: 0;
  transform: translateY(-50%);
  padding: calc(1px * var(--u)) calc(6px * var(--u));
  border-radius: calc(3px * var(--u));
  background: var(--i-bg);
  font-family: var(--mono, monospace);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: 0.8px;
  color: var(--i-accent2);
  white-space: nowrap;
}

/* ============ 模块：形状 + 内容 ============ */
.mod {
  --g: 1;
  position: absolute;
  width: calc(var(--w) * var(--g));
  height: calc(var(--h) * var(--g));
  transform: translate(-50%, -50%) translate(var(--tx, 0), var(--ty, 0)) scale(0.72);
  opacity: 0;
  transition: opacity 0.42s ease, transform 0.62s cubic-bezier(0.18, 1.2, 0.32, 1),
    width 0.13s cubic-bezier(0.2, 0.9, 0.25, 1.2), height 0.13s cubic-bezier(0.2, 0.9, 0.25, 1.2);
  z-index: 3;
  cursor: default;
}
.mod.on { opacity: 1; transform: translate(-50%, -50%) translate(0, 0) scale(1); }
/* 放大走真实宽高：transform: scale 会让文字按原位图放大，首字被裁 */
.mod:hover { --g: 1.3; z-index: 20; }

.shape {
  position: absolute;
  inset: 0;
  transition: filter 0.12s linear;
}
.mod:hover .shape { filter: brightness(1.3) saturate(1.12); }
/* 浅色主题下再提亮就糊成白块，改成轻微压暗 + 提饱和 */
html[data-theme='light'] .mod:hover .shape { filter: brightness(0.97) saturate(1.2); }

/* 圆角矩形：内存区 / 代理 / 日志流 */
.mod.box .shape {
  border-radius: calc(5px * var(--u));
  border: 1px solid color-mix(in srgb, var(--cl) 48%, var(--border));
  background: linear-gradient(
    165deg,
    color-mix(in srgb, var(--cl) 26%, var(--i-card)) 0%,
    color-mix(in srgb, var(--cl) 9%, var(--i-card)) 100%
  );
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--cl) 22%, transparent);
}

/* 六边形：服务进程（OBServer / OBProxy / RootService / Server Process / 后台进程） */
.mod.hex .shape {
  background: color-mix(in srgb, var(--cl) 52%, var(--border));
  clip-path: polygon(13% 0, 87% 0, 100% 50%, 87% 100%, 13% 100%, 0 50%);
}
.mod.hex .shape::after {
  content: '';
  position: absolute;
  inset: calc(1.5px * var(--u));
  clip-path: polygon(13% 0, 87% 0, 100% 50%, 87% 100%, 13% 100%, 0 50%);
  background: linear-gradient(
    165deg,
    color-mix(in srgb, var(--cl) 24%, var(--i-card)) 0%,
    color-mix(in srgb, var(--cl) 8%, var(--i-card)) 100%
  );
}

/* 圆柱：存储引擎 / 数据文件 / 重做日志 */
.mod.cyl .shape {
  border-radius: 50% / 15%;
  border: 1px solid color-mix(in srgb, var(--cl) 48%, var(--border));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--cl) 18%, var(--i-card)) 0%,
    color-mix(in srgb, var(--cl) 8%, var(--i-card)) 100%
  );
}
.mod.cyl .shape::after {
  content: '';
  position: absolute;
  left: -1px;
  right: -1px;
  top: -1px;
  height: 34%;
  border-radius: 50%;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--cl) 30%, var(--i-card)),
    color-mix(in srgb, var(--cl) 16%, var(--i-card))
  );
  border: 1px solid color-mix(in srgb, var(--cl) 48%, var(--border));
  border-bottom-color: color-mix(in srgb, var(--cl) 30%, transparent);
}

.body {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  pointer-events: none;
}
/* 圆柱的顶面占了上三分之一，文字往下让 */
.mod.cyl .body { padding-top: 12px !important; }
.mod.hex .body { padding-left: 20px !important; padding-right: 20px !important; }

.body b {
  font-family: var(--mono, 'Consolas', monospace);
  font-weight: 700;
  letter-spacing: calc(0.3px * var(--u));
  color: var(--i-text);
  white-space: nowrap;
}
.body span {
  letter-spacing: 0.4px;
  color: var(--i-dim);
  white-space: nowrap;
}
.mod:hover .body b { color: color-mix(in srgb, var(--i-text) 88%, var(--cl)); }

/* ============ 悬停提示（fixed 浮层，不受舞台层叠影响） ============ */
.tip-float {
  position: fixed;
  z-index: 60;
  width: 250px;
  padding: 9px 12px;
  background: var(--i-card);
  border: 1px solid color-mix(in srgb, var(--i-accent) 55%, var(--border));
  border-radius: 6px;
  box-shadow: var(--shadow-lg), 0 0 0 1px color-mix(in srgb, var(--i-accent) 16%, transparent);
  pointer-events: none;
  animation: tip-in 0.12s ease;
}
@keyframes tip-in { from { opacity: 0; } to { opacity: 1; } }
.tip-float b {
  display: block;
  font-family: var(--mono, monospace);
  font-size: 11.5px;
  color: var(--i-accent2);
  margin-bottom: 5px;
}
.tip-float b em { font-style: normal; color: var(--i-dim); font-weight: 400; }
.tip-float span {
  display: block;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--i-text);
  opacity: 0.9;
}

/* ============ HUD ============ */
.in-top {
  position: absolute;
  left: 28px;
  right: 28px;
  top: 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--mono, monospace);
  font-size: 11px;
  letter-spacing: 2px;
}
.in-top .brand { color: var(--i-text); font-weight: 700; letter-spacing: 3px; }
.in-top .sep { width: 18px; height: 1px; background: var(--i-line); }
.in-top .sub { color: var(--i-dim); letter-spacing: 0.5px; }

.in-bot {
  position: absolute;
  left: 28px;
  right: 28px;
  bottom: 24px;
}
.st {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono, monospace);
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--i-dim);
  margin-bottom: 9px;
}
.st .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--i-accent2);
  box-shadow: 0 0 8px 1px var(--i-accent);
}
.in.hold .st .dot { background: var(--green); box-shadow: 0 0 10px 2px color-mix(in srgb, var(--green) 60%, transparent); }
.row { display: flex; align-items: center; gap: 16px; }
.bar { flex: 1; height: 1px; background: var(--i-line); position: relative; }
.bar > i {
  position: absolute;
  left: 0;
  top: -1px;
  height: 3px;
  background: linear-gradient(90deg, transparent, var(--i-accent2));
  box-shadow: 0 0 10px 0 color-mix(in srgb, var(--i-accent) 60%, transparent);
  transition: width 0.45s cubic-bezier(0.2, 0.8, 0.3, 1);
}
.in-enter {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 16px;
  border: 1px solid var(--i-line);
  background: transparent;
  color: var(--i-dim);
  font-family: inherit;
  font-size: 12px;
  letter-spacing: 1px;
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.in-enter .arw { opacity: 0.5; transition: transform 0.18s, opacity 0.18s; }
.in-enter:hover { color: var(--i-text); border-color: var(--i-accent); background: color-mix(in srgb, var(--i-accent) 14%, transparent); }
.in-enter:hover .arw { opacity: 1; transform: translateX(3px); }
.in-enter.ready {
  color: #fff;
  border-color: var(--i-accent);
  background: var(--i-accent);
  box-shadow: 0 0 24px -8px var(--i-accent);
}
.in-enter.ready .arw { opacity: 1; }
</style>
