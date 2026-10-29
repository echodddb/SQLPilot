<template>
  <div class="si" :class="{ closing, ready }" :style="{ '--k': seqScale }" @click="finish" @keydown.esc="finish">
    <div class="si-grid"></div>
    <div class="si-scan"></div>

    <div class="si-inner">
      <div class="si-tag">
        <span class="si-tag-dot" :class="{ ready }"></span>
        SERVER FLEET · {{ ids.length }} DISTROS
      </div>

      <div class="si-head">
        <div class="si-title">服务器</div>
        <div class="si-sub">SSH 终端 · SFTP 传输 · 多发行版适配</div>
      </div>

      <!-- 机架式排布：5 列 × 3 行，逐列通电，不是环形排列 -->
      <div class="si-racks">
        <div v-for="(col, ci) in columns" :key="ci" class="si-rack">
          <div class="si-colno" :class="{ on: lit }" :style="{ '--d': ci * 100 + 'ms' }">
            {{ String(ci + 1).padStart(2, '0') }}
          </div>
          <div
            v-for="(m, ri) in col"
            :key="m.id"
            class="si-mark"
            :class="{ on: lit, hot: hover?.id === m.id }"
            :style="{ '--d': ci * 100 + ri * 42 + 'ms', '--brand': m.brand }"
            @mouseenter="onEnter($event, m)"
            @mouseleave="hover = null"
          >
            <svg v-if="m.logo" class="si-lg" :viewBox="m.logo.viewBox">
              <path :d="m.logo.d" :fill="m.brand" />
            </svg>
            <svg v-else class="si-lg si-mono" viewBox="0 0 64 64">
              <text x="32" y="32" text-anchor="middle" dominant-baseline="central" :fill="m.brand">{{ m.mono }}</text>
            </svg>
          </div>
        </div>
      </div>

      <div class="si-foot">
        <div class="si-bar"><div class="si-bar-fill" :class="{ done: ready }"></div></div>
        <div class="si-log">
          <span class="si-prompt">&gt;</span>
          <span class="si-logtext" :class="{ ok: ready }">{{ ready ? '就绪 · 全部发行版已挂载，点击进入' : line }}</span>
          <!-- 播完停在就绪态，必须点一下才进模块（跟数据库侧的架构动画一致） -->
          <button class="si-enter" :class="{ ready }" type="button" @click.stop="finish">
            <span>{{ ready ? '进入服务器模块' : '跳过' }}</span>
            <span class="arw">→</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 悬停介绍卡：fixed 挂在根层级，避免被 .si-inner 的层叠上下文裁掉 -->
    <div
      v-if="hover"
      class="si-tip"
      :style="{
        left: hover.x + 'px',
        top: hover.y + 'px',
        transform: hover.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
        '--brand': hover.brand
      }"
    >
      <div class="si-tip-h"><span class="si-tip-dot"></span>{{ hover.label }}</div>
      <div class="si-tip-d">{{ hover.desc }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { autoAdvance, introScale } from '../../app-mode'
import { DISTRO_IDS, markFor, type DistroMark } from '../../server/distros'

const emit = defineEmits<{ (e: 'done'): void }>()

const ROWS = 3
const ids = DISTRO_IDS
const columns = computed(() => {
  const out: ReturnType<typeof markFor>[][] = []
  for (let c = 0; c < Math.ceil(ids.length / ROWS); c++) {
    out.push(ids.slice(c * ROWS, c * ROWS + ROWS).map((id) => markFor(id)))
  }
  return out
})

const LINES = ['正在载入 SSH 会话与密钥…', '挂载 SFTP 双栏传输通道…', '适配 15 种 Linux 发行版…']

const lit = ref(false)
/** 序列播完停在就绪态：不自动进模块，等用户点「进入」（或点空白处） */
const ready = ref(false)
const closing = ref(false)
const line = ref(LINES[0])

/** 悬停介绍：放大 130% + 一句话说明（位置按卡片实际矩形算，上方放不下就翻到下面） */
interface TipState {
  id: string
  label: string
  desc: string
  brand: string
  x: number
  y: number
  below: boolean
}
const hover = ref<TipState | null>(null)

function onEnter(e: MouseEvent, m: DistroMark): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const below = r.top < 120
  const half = 128
  hover.value = {
    id: m.id,
    label: m.label,
    desc: m.desc,
    brand: m.brand,
    x: Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half),
    y: Math.round(below ? r.bottom + 10 : r.top - 10),
    below
  }
}

let timers: any[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function finish(): void {
  if (closing.value) return
  closing.value = true
  timers.forEach(clearTimeout)
  sleep(260).then(() => emit('done'))
}

/** 整段序列的基准时长（进度条走满 + 翻就绪态的时点） */
const FULL_MS = 1820
/**
 * 工作模式压到 1.5s：JS 时点与 CSS 时长（--k 倍）用同一个系数，条和卡片不会跑在前面。
 * 故意在 setup 里取一次快照、不跟模式变化重算：序列已经开演，中途改时长只会让
 * CSS 过渡和定时器对不上，不如让它按开演那一刻的节奏走完。
 */
const seqScale = introScale(FULL_MS)
const at = (ms: number) => Math.round(ms * seqScale)

onMounted(() => {
  // 下一帧再点亮，保证 transition 有初始状态可过渡
  requestAnimationFrame(() => { lit.value = true })
  timers.push(setTimeout(() => { line.value = LINES[1] }, at(620)))
  timers.push(setTimeout(() => { line.value = LINES[2] }, at(1180)))
  // 进度条走满后才翻就绪态，否则按钮先亮、条还在爬。
  // 工作模式（序列被压缩过）：到点直接进模块，不停在就绪态等一次点击
  timers.push(setTimeout(() => {
    ready.value = true
    if (autoAdvance(FULL_MS)) finish()
  }, at(FULL_MS)))
  window.addEventListener('keydown', onKey)
})

function onKey(e: KeyboardEvent): void {
  // Esc 随时可跳过；Enter / 空格只在就绪后生效，避免误触把动画跳掉
  if (e.key === 'Escape' || (ready.value && (e.key === 'Enter' || e.key === ' '))) finish()
}

onBeforeUnmount(() => {
  timers.forEach(clearTimeout)
  window.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
.si {
  /* 只覆盖模块内容区（与数据库侧的架构动画一致）：左侧大模块导航与顶栏都露在外面，
     播放期间照样可以切模块 */
  position: absolute; inset: 0; z-index: 30; overflow: hidden;
  background: var(--bg); display: flex; align-items: center; justify-content: center;
  /* 不要给整层做淡入：opacity 从 0 起的那 200ms 会把下面的终端页面透出来，
     看起来就像"动画前闪了一下模块界面"。进场靠内部元素自己动。 */
  cursor: pointer;
}
.si.closing { animation: siOut .26s ease both; }
@keyframes siOut { to { opacity: 0 } }

.si-grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(to right, color-mix(in srgb, var(--border) 50%, transparent) 1px, transparent 1px),
    linear-gradient(to bottom, color-mix(in srgb, var(--border) 50%, transparent) 1px, transparent 1px);
  background-size: 40px 40px;
  mask-image: radial-gradient(ellipse at 50% 50%, #000 10%, transparent 76%);
  -webkit-mask-image: radial-gradient(ellipse at 50% 50%, #000 10%, transparent 76%);
}
/* 横扫光带：像巡检灯扫过整排机架 */
.si-scan {
  position: absolute; top: 0; bottom: 0; left: -180px; width: 180px; pointer-events: none;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 14%, transparent), transparent);
  /* 时长/延迟都乘 --k：工作模式整段压到 1.5s 时，扫光不会拖在序列后面 */
  animation: sweep calc(1.3s * var(--k, 1)) cubic-bezier(.4, 0, .2, 1) calc(.06s * var(--k, 1)) forwards;
}
@keyframes sweep { to { left: 100% } }

.si-inner { position: relative; width: min(760px, 92vw); }

.si-tag {
  display: inline-flex; align-items: center; gap: 7px;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 2px; color: var(--text-faint);
  border: 1px solid var(--border); border-radius: 99px; padding: 3px 10px;
}
.si-tag-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: blink 1s ease-in-out infinite; }
.si-tag-dot.ready { background: var(--green); animation: none; box-shadow: 0 0 8px 1px color-mix(in srgb, var(--green) 70%, transparent); }
@keyframes blink { 50% { opacity: .25 } }

.si-head { margin: 18px 0 26px; }
.si-title { font-size: 30px; font-weight: 700; color: var(--text); letter-spacing: 6px; }
.si-sub { font-size: 12.5px; color: var(--text-faint); margin-top: 7px; letter-spacing: .5px; }

.si-racks { display: flex; gap: 22px; }
.si-rack { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.si-colno {
  font-family: var(--mono); font-size: 10px; color: var(--text-faint);
  opacity: .3; transition: opacity .4s ease, color .4s ease; transition-delay: calc(var(--d) * var(--k, 1));
}
.si-colno.on { opacity: 1; color: var(--accent); }

.si-mark {
  height: 62px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--bg-card) 80%, transparent);
  border: 1px solid var(--border);
  opacity: .16; transform: translateY(8px) scale(.94);
  transition: opacity .5s cubic-bezier(.2, .9, .2, 1), transform .5s cubic-bezier(.2, .9, .2, 1),
    border-color .5s ease, box-shadow .5s ease, background .5s ease;
  transition-delay: calc(var(--d) * var(--k, 1));
}
.si-mark.on {
  opacity: 1; transform: none;
  border-color: color-mix(in srgb, var(--brand) 42%, var(--border));
  background: color-mix(in srgb, var(--brand) 9%, var(--bg-card));
  box-shadow: 0 0 18px color-mix(in srgb, var(--brand) 16%, transparent);
}
/* 悬停：图标 130%、卡片提亮。放大走真实宽高，不用 transform: scale（会变合成层再放大，边缘发虚） */
.si-mark.hot {
  transition-delay: 0ms;
  border-color: color-mix(in srgb, var(--brand) 72%, var(--border));
  background: color-mix(in srgb, var(--brand) 16%, var(--bg-card));
  box-shadow: 0 0 22px color-mix(in srgb, var(--brand) 30%, transparent);
}

/* 官方标志是 24×24 满幅填充，给 30px 让细节（变色龙、企鹅、螺旋）还看得清 */
.si-lg {
  width: 30px; height: 30px;
  transition: width .16s cubic-bezier(.2, .9, .2, 1), height .16s cubic-bezier(.2, .9, .2, 1);
}
.si-mark.hot .si-lg { width: 39px; height: 39px; }
.si-mono text { font-family: var(--mono); font-size: 23px; font-weight: 800; letter-spacing: 1.5px; }

/* 悬停介绍卡 */
.si-tip {
  position: fixed; z-index: 40; width: 246px; pointer-events: none;
  padding: 9px 11px 10px; border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--brand) 45%, var(--border));
  box-shadow: var(--shadow-lg);
  animation: tipIn .12s ease both;
}
.si-tip-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text); }
.si-tip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--brand); flex: none; }
.si-tip-d { margin-top: 5px; font-size: 11px; line-height: 1.55; color: var(--text-dim); }
@keyframes tipIn { from { opacity: 0 } to { opacity: 1 } }

.si-foot { margin-top: 26px; }
.si-bar { height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
.si-bar-fill {
  height: 100%; width: 0; background: var(--accent); border-radius: 2px;
  animation: fill calc(1.75s * var(--k, 1)) cubic-bezier(.3, .9, .3, 1) calc(.05s * var(--k, 1)) forwards;
}
.si-bar-fill.done { animation: none; width: 100%; }
@keyframes fill { to { width: 92% } }

.si-log {
  display: flex; align-items: center; gap: 7px; margin-top: 10px;
  font-family: var(--mono); font-size: 11.5px; color: var(--text-faint);
}
.si-prompt { color: var(--accent); }
.si-logtext { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.si-logtext.ok { color: var(--green); }

/* 就绪后才高亮：「进入」是唯一的自动出口被去掉后的正道，必须够显眼 */
.si-enter {
  flex: none; display: inline-flex; align-items: center; gap: 7px;
  height: 28px; padding: 0 14px; border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent; color: var(--text-faint);
  font-family: var(--mono); font-size: 11px; letter-spacing: 1px;
  cursor: pointer; transition: color .15s, border-color .15s, background .15s, box-shadow .15s;
}
.si-enter .arw { opacity: .5; transition: transform .18s, opacity .18s; }
.si-enter:hover { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.si-enter:hover .arw { opacity: 1; transform: translateX(3px); }
.si-enter.ready {
  color: #fff; border-color: var(--accent); background: var(--accent);
  box-shadow: 0 0 24px -8px var(--accent);
  animation: siNudge .35s cubic-bezier(.2, .9, .2, 1) both;
}
.si-enter.ready .arw { opacity: 1; }
@keyframes siNudge { from { transform: translateY(3px); opacity: .6 } to { transform: none; opacity: 1 } }
</style>
