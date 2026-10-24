<template>
  <div class="ep" :style="{ '--brand': engine.brand }">
    <div class="ep-bg"></div>
    <div class="ep-grid"></div>

    <header class="ep-top">
      <span class="logo">☁</span>
      <b>云管平台</b>
      <span class="sep"></span>
      <b class="name">{{ engine.name }}</b>
      <span class="chip">体系预览</span>
      <span class="spacer"></span>
      <button class="ep-back" type="button" @click="emit('back')">
        <i>‹</i> 返回平台选择
      </button>
    </header>

    <div class="ep-body">
      <section class="ep-hero">
        <div class="ep-mark">{{ engine.code }}</div>
        <div class="ep-hero-main">
          <h1>{{ engine.name }}</h1>
          <p>{{ engine.tagline }}</p>
          <div class="tags">
            <span v-for="t in engine.tags" :key="t">{{ t }}</span>
          </div>
        </div>
        <div class="ep-state">
          <i class="dot"></i>
          <span>占位页 · 接口待接入</span>
        </div>
      </section>

      <div class="ep-cols">
        <section class="ep-card">
          <h2>架构要点</h2>
          <ol class="arch">
            <li v-for="(a, i) in engine.arch" :key="i">
              <em>{{ String(i + 1).padStart(2, '0') }}</em>
              <span>{{ a }}</span>
            </li>
          </ol>
        </section>

        <section class="ep-card">
          <h2>计划中的模块</h2>
          <ul class="mods">
            <li v-for="m in engine.modules" :key="m">
              <span>{{ m }}</span>
              <em>待建设</em>
            </li>
          </ul>
        </section>
      </div>

      <div class="ep-note">
        <b>当前交付范围</b>
        <p>
          这一家还没接真实接口：进来能看架构装配动画（{{ engine.name }} 的组件、边界与数据流向），
          控制台先占位。接入方式确定后，按上面「计划中的模块」逐页替换，不用改入口与动效。
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { engineOf, type EngineId } from '../../cloud/engines'

const props = defineProps<{ engine: EngineId }>()
const emit = defineEmits<{ (e: 'back'): void }>()

const engine = computed(() => engineOf(props.engine))
</script>

<style scoped>
.ep {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
  user-select: none;
}

.ep-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(
    70% 60% at 50% 0%,
    color-mix(in srgb, var(--brand) 7%, var(--bg)) 0%,
    var(--bg) 62%
  );
}
.ep-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--text) 5%, transparent) 1px, transparent 1px);
  background-size: 40px 40px;
  -webkit-mask: radial-gradient(ellipse 70% 60% at 50% 0%, #000 0%, transparent 78%);
  mask: radial-gradient(ellipse 70% 60% at 50% 0%, #000 0%, transparent 78%);
}

/* ============ 顶栏 ============ */
.ep-top {
  position: relative;
  height: 46px;
  min-height: 46px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: var(--bg-side);
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.ep-top .logo { color: var(--accent-2); font-size: 14px; }
.ep-top .sep { width: 1px; height: 14px; background: var(--border); }
.ep-top .name { color: var(--text); letter-spacing: 0.4px; }
.ep-top .spacer { flex: 1; }
.ep-top .chip {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--brand);
  border: 1px solid color-mix(in srgb, var(--brand) 45%, transparent);
  background: color-mix(in srgb, var(--brand) 10%, transparent);
}
.ep-back {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.ep-back i { font-style: normal; font-size: 14px; line-height: 1; }
.ep-back:hover { color: var(--text); border-color: var(--accent); background: var(--accent-dim); }

/* ============ 内容 ============ */
.ep-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 26px 26px 34px;
  display: flex;
  flex-direction: column;
  /* 内容不多时整组竖直居中（safe：窗口太矮也不会把顶部推出可视区） */
  justify-content: safe center;
  gap: 16px;
  max-width: 1200px;
  width: 100%;
  margin: 0 auto;
}

.ep-hero { display: flex; align-items: center; gap: 16px; }
.ep-mark {
  flex: none;
  width: 62px;
  height: 62px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  font-family: var(--mono, monospace);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text);
  border: 1px solid color-mix(in srgb, var(--brand) 50%, var(--border));
  background:
    linear-gradient(160deg,
      color-mix(in srgb, var(--brand) 30%, var(--bg-card)) 0%,
      color-mix(in srgb, var(--brand) 8%, var(--bg-card)) 100%);
  box-shadow: 0 10px 30px -18px color-mix(in srgb, var(--brand) 80%, transparent);
}
.ep-hero-main { min-width: 0; }
.ep-hero-main h1 {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.2px;
  margin-bottom: 5px;
}
.ep-hero-main p { font-size: 12.5px; color: var(--text-dim); line-height: 1.6; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.tags span {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-card);
  border: 1px solid var(--border);
}

.ep-state {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-faint);
  font-family: var(--mono, monospace);
  white-space: nowrap;
}
.ep-state .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--yellow);
  box-shadow: 0 0 9px 1px color-mix(in srgb, var(--yellow) 60%, transparent);
}

.ep-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
@media (max-width: 900px) { .ep-cols { grid-template-columns: 1fr; } }

.ep-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px 16px;
}
.ep-card h2 {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: var(--text-dim);
  text-transform: uppercase;
  margin-bottom: 11px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--border);
}

.arch { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.arch li { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.68; color: var(--text); }
.arch em {
  flex: none;
  font-style: normal;
  font-family: var(--mono, monospace);
  font-size: 11px;
  color: var(--brand);
  padding-top: 2px;
  opacity: 0.9;
}

.mods { list-style: none; display: flex; flex-direction: column; gap: 2px; }
.mods li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-dim);
  border: 1px dashed transparent;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.mods li:hover {
  background: var(--bg-card-hover);
  border-color: var(--border);
  color: var(--text);
}
.mods li > span { flex: 1; min-width: 0; }
.mods em {
  flex: none;
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-faint);
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.ep-note {
  border-left: 2px solid color-mix(in srgb, var(--brand) 60%, transparent);
  padding: 2px 0 2px 12px;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.7;
}
.ep-note b { display: block; color: var(--text); font-size: 12.5px; margin-bottom: 3px; }
</style>
