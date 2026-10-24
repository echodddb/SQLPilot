<template>
  <div ref="rootEl" class="pk">
    <div class="pk-bg"></div>
    <div class="pk-grid"></div>
    <div class="pk-glow"></div>

    <div class="pk-stage">
      <svg class="pk-wires">
        <line
          v-for="(n, i) in nodes"
          :key="'w' + i"
          :x1="n.x1" :y1="n.y1" :x2="n.x2" :y2="n.y2"
          :class="{ lit: hover === i }"
        />
      </svg>

      <div class="pk-orbit">
        <div class="ring r3"></div>
        <div class="ticks"></div>
        <div class="ring r2"></div>
        <div class="ring r1"></div>
      </div>

      <div class="pk-core" :class="{ hot: hover >= 0 }">
        <div class="arc a1"></div>
        <div class="arc a2"></div>
        <svg viewBox="0 0 24 24"><path d="M12 2.6 20.2 7.2v9.6L12 21.4 3.8 16.8V7.2z" /></svg>
        <span class="dot"></span>
      </div>

      <div class="pk-nodes">
        <div
          v-for="(n, i) in nodes"
          :key="n.id"
          class="pk-node"
          :class="{ in: shown[i] }"
          :style="{ left: n.x + 'px', top: n.y + 'px', '--dx': n.dx + 'px', '--dy': n.dy + 'px' }"
          @mouseenter="hover = i"
          @mouseleave="hover = -1"
          @click="pick(n)"
        >
          <div class="face" :style="{ '--brand': n.brand }">
            <i class="cnr a"></i><i class="cnr b"></i><i class="cnr c"></i><i class="cnr d"></i>
            <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="k">{{ n.code }}</span>
            <div class="meta">
              <span class="nm">{{ n.name }}</span>
              <span class="pt">{{ n.ready ? '已就绪' : '架构预览' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <header class="pk-top">
      <span class="brand">CLOUD PLATFORM</span>
      <span class="sep"></span>
      <span class="sub">选择要接入的数据库云平台</span>
    </header>

    <div class="pk-bot">
      <span class="dot"></span>
      <span>Oracle · OceanBase 已接入真实数据，其余引擎可先看架构</span>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ENGINES as ENGINE_LIST, isReady, type EngineId } from '../../cloud/engines'

const CX = 310
const CY = 205
const R = 150

const emit = defineEmits<{ (e: 'pick', id: EngineId): void }>()

const rootEl = ref<HTMLElement | null>(null)
const unit = ref(1)
const shown = ref<boolean[]>(ENGINE_LIST.map(() => false))
const hover = ref(-1)

const nodes = computed(() => {
  const u = unit.value
  const px = (v: number) => Math.round(v * u)
  return ENGINE_LIST.map((d, i) => {
    const ang = ((-90 + (360 / ENGINE_LIST.length) * i) * Math.PI) / 180
    const cos = Math.cos(ang)
    const sin = Math.sin(ang)
    return {
      ...d,
      ready: isReady(d.id),
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

function updateScale(): void {
  const el = rootEl.value
  if (!el) return
  const fit = Math.min(window.innerWidth / 620, (window.innerHeight - 200) / 410)
  const u = Math.min(1.7, Math.max(0.5, fit))
  unit.value = u
  el.style.setProperty('--u', u.toFixed(4))
}

let timers: number[] = []

function pick(n: { id: EngineId }): void {
  emit('pick', n.id)
}

onMounted(() => {
  updateScale()
  window.addEventListener('resize', updateScale)
  // 快速依次落位：是「启动动画」的形，但不拖 3 秒
  nodes.value.forEach((_, i) => {
    timers.push(window.setTimeout(() => (shown.value[i] = true), 120 + i * 62))
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateScale)
  timers.forEach(clearTimeout)
})
</script>

<style scoped>
.pk {
  --u: 1;
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: var(--mono, 'Cascadia Code', 'Consolas', monospace);
  user-select: none;
}

.pk-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    62% 62% at 50% 46%,
    color-mix(in srgb, var(--accent) 7%, var(--bg)) 0%,
    var(--bg) 62%,
    var(--bg) 100%
  );
}

.pk-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px);
  background-size: 40px 40px;
  -webkit-mask: radial-gradient(circle at 50% 46%, #000 0%, #000 40%, transparent 72%);
  mask: radial-gradient(circle at 50% 46%, #000 0%, #000 40%, transparent 72%);
}

.pk-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(34% 34% at 50% 45%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 70%);
}

/* ============ 内容区 ============ */
.pk-stage {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(620px * var(--u));
  height: calc(410px * var(--u));
  transform: translate(-50%, -50%);
}

.pk-wires {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.pk-wires line {
  stroke: color-mix(in srgb, var(--text) 13%, transparent);
  stroke-width: 1;
  transition: stroke 0.1s linear;
}
.pk-wires line.lit {
  stroke: var(--accent);
}

.pk-orbit {
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
}
.r1 { width: calc(96px * var(--u)); height: calc(96px * var(--u)); border: 1px solid color-mix(in srgb, var(--text) 14%, transparent); }
.r2 { width: calc(116px * var(--u)); height: calc(116px * var(--u)); border: 1px dashed color-mix(in srgb, var(--text) 20%, transparent); animation: pk-spin 16s linear infinite; }
.r3 { width: calc(300px * var(--u)); height: calc(300px * var(--u)); border: 1px solid color-mix(in srgb, var(--text) 7%, transparent); }
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
    color-mix(in srgb, var(--text) 26%, transparent) 0deg 0.55deg,
    transparent 0.55deg 3deg
  );
  -webkit-mask: radial-gradient(circle, transparent 47.5%, #000 48%, #000 50%, transparent 50.5%);
  mask: radial-gradient(circle, transparent 47.5%, #000 48%, #000 50%, transparent 50.5%);
  animation: pk-spin 40s linear infinite reverse;
}
@keyframes pk-spin {
  to { rotate: 360deg; }
}

.pk-core {
  position: absolute;
  left: calc(310px * var(--u));
  top: calc(205px * var(--u));
  width: calc(44px * var(--u));
  height: calc(44px * var(--u));
  translate: -50% -50%;
  display: grid;
  place-items: center;
  color: var(--text);
}
.pk-core svg { width: calc(28px * var(--u)); height: calc(28px * var(--u)); }
.pk-core svg path { fill: none; stroke: currentColor; stroke-width: 1.4; opacity: 0.5; transition: stroke 0.15s, opacity 0.15s; }
.pk-core .dot {
  position: absolute;
  width: calc(5px * var(--u));
  height: calc(5px * var(--u));
  border-radius: 50%;
  background: var(--text);
  box-shadow: 0 0 10px 2px color-mix(in srgb, var(--text) 55%, transparent);
  transition: box-shadow 0.15s, background 0.15s;
}
.pk-core.hot svg path { stroke: var(--accent); opacity: 1; }
.pk-core.hot .dot { background: var(--accent); box-shadow: 0 0 16px 4px color-mix(in srgb, var(--accent) 70%, transparent); }
.arc { position: absolute; border-radius: 50%; border: 1px solid transparent; }
.arc.a1 {
  width: calc(74px * var(--u)); height: calc(74px * var(--u));
  border-top-color: color-mix(in srgb, var(--accent) 60%, transparent);
  border-left-color: color-mix(in srgb, var(--text) 12%, transparent);
  animation: pk-spin 3.4s linear infinite;
}
.arc.a2 {
  width: calc(86px * var(--u)); height: calc(86px * var(--u));
  border-bottom-color: color-mix(in srgb, var(--text) 18%, transparent);
  animation: pk-spin 6.5s linear infinite reverse;
}

/* ============ 模块 ============ */
.pk-nodes { position: absolute; inset: 0; }
.pk-node {
  position: absolute;
  width: calc(80px * var(--u));
  height: calc(80px * var(--u));
  margin: calc(-40px * var(--u)) 0 0 calc(-40px * var(--u));
  transition: transform 0.12s cubic-bezier(0.2, 0.9, 0.25, 1.2);
  cursor: pointer;
}
/* 悬停放大：所有引擎都能进（没接接口的进占位页） */
.pk-node:hover {
  transform: scale(1.3);
  z-index: 40;
}
.pk-nodes:has(.pk-node:hover) .pk-node:not(:hover) {
  transform: scale(0.965);
}

.face {
  position: absolute;
  inset: 0;
  background: var(--bg-card);
  border: 1px solid var(--border);
  opacity: 0;
  transform: translate(var(--dx, 0px), var(--dy, 0px)) scale(0.55) rotate(-7deg);
  transition: opacity 0.4s ease, transform 0.5s cubic-bezier(0.18, 1.45, 0.32, 1),
    border-color 0.1s linear, box-shadow 0.1s linear, background 0.1s linear;
}
.pk-node.in .face {
  opacity: 1;
  transform: translate(0, 0) scale(1) rotate(0deg);
}
.pk-nodes:has(.pk-node:hover) .pk-node:not(:hover) .face {
  opacity: 0.42;
  border-color: color-mix(in srgb, var(--border) 60%, transparent);
  transition: opacity 0.12s ease, transform 0.12s ease, border-color 0.12s ease;
}
.pk-node:hover .face {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent),
    0 8px 28px -8px color-mix(in srgb, var(--accent) 55%, transparent);
}


.face::before {
  content: "";
  position: absolute;
  left: calc(8px * var(--u));
  right: calc(8px * var(--u));
  top: -1px;
  height: 2px;
  background: var(--brand);
  opacity: 0.55;
  transition: opacity 0.15s;
}
.pk-node:hover .face::before { opacity: 1; }

.cnr {
  position: absolute;
  width: calc(7px * var(--u));
  height: calc(7px * var(--u));
  border: 1px solid color-mix(in srgb, var(--text) 28%, transparent);
}
.cnr.a { left: -1px; top: -1px; border-right: 0; border-bottom: 0; }
.cnr.b { right: -1px; top: -1px; border-left: 0; border-bottom: 0; }
.cnr.c { left: -1px; bottom: -1px; border-right: 0; border-top: 0; }
.cnr.d { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
.pk-node:hover .cnr { border-color: var(--accent); }

.idx {
  position: absolute;
  right: calc(6px * var(--u));
  top: calc(4px * var(--u));
  font-size: calc(8px * var(--u));
  color: var(--text-faint);
}
.k {
  position: absolute;
  left: calc(9px * var(--u));
  bottom: calc(33px * var(--u));
  font-size: calc(15px * var(--u));
  letter-spacing: calc(1px * var(--u));
  font-weight: 600;
  color: var(--text);
  transition: color 0.15s;
}
.pk-node:hover .k { color: var(--accent); }
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
  transition: opacity 0.15s;
}
.nm { color: var(--text-dim); }
.pt { color: var(--accent); opacity: 0; }
.pk-node:hover .nm { opacity: 0; }
.pk-node:hover .pt { opacity: 1; }

/* ============ HUD ============ */
.pk-top {
  position: absolute;
  left: 30px;
  right: 30px;
  top: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  letter-spacing: 2px;
  font-family: var(--mono, monospace);
}
.pk-top .brand { color: var(--text); font-weight: 700; letter-spacing: 3px; }
.pk-top .sep { width: 18px; height: 1px; background: color-mix(in srgb, var(--text) 22%, transparent); }
.pk-top .sub { color: var(--text-dim); }

.pk-bot {
  position: absolute;
  left: 30px;
  bottom: 26px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-dim);
}
.pk-bot .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--green, #3fb950);
  box-shadow: 0 0 8px 1px color-mix(in srgb, var(--green, #3fb950) 60%, transparent);
}

</style>
