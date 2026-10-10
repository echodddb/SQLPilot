<template>
  <div class="report-view">
    <div class="rv-hero">
      <div class="rv-icon">▤</div>
      <h2>巡检报告</h2>
      <span class="rv-badge">规划中</span>
      <p class="rv-desc">
        基于报告模板的数据库巡检报告生成模块——数据采集、模板渲染、报告归档全流程独立于 AI，
        与「AI 助手」模块互不依赖。
      </p>
    </div>

    <div class="rv-plan">
      <div v-for="(p, i) in plan" :key="p.title" class="rv-card">
        <div class="rv-step">{{ i + 1 }}</div>
        <div class="rv-body">
          <b>{{ p.title }}</b>
          <p>{{ p.desc }}</p>
        </div>
      </div>
    </div>

    <p class="rv-foot">此页为占位，功能开发时替换；左侧「AI 助手」模块不受影响。</p>
  </div>
</template>

<script setup lang="ts">
/** 巡检报告模块占位页：仅呈现规划方向，无业务逻辑 */
const plan = [
  { title: '报告模板', desc: '内置 Oracle / OceanBase / MySQL 巡检模板，支持自定义章节与指标项' },
  { title: '数据采集', desc: '按模板对目标连接采集健康检查项（空间、会话、等待事件、备份等）' },
  { title: '报告生成', desc: '模板渲染为 HTML / PDF，问题项自动标级与给出处理建议' },
  { title: '历史归档', desc: '报告按连接与时间归档，可对比两期指标变化' }
]
</script>

<style scoped>
.report-view {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
}
.rv-hero { text-align: center; max-width: 520px; }
.rv-icon {
  font-size: 34px;
  color: var(--accent);
  background: var(--accent-dim);
  width: 72px;
  height: 72px;
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
}
.rv-hero h2 { margin: 0; font-size: 20px; }
.rv-badge {
  display: inline-block;
  margin-top: 8px;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 10px;
  border-radius: 99px;
  background: var(--yellow-dim);
  color: var(--yellow);
}
.rv-desc {
  margin: 14px 0 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.7;
}
.rv-plan {
  display: grid;
  grid-template-columns: repeat(2, minmax(240px, 300px));
  gap: 12px;
  margin-top: 36px;
}
.rv-card {
  display: flex;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-card);
}
.rv-step {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--accent-dim);
  color: var(--accent);
  font-weight: 700;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.rv-body b { font-size: 13.5px; }
.rv-body p { margin: 5px 0 0; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.rv-foot { margin-top: 30px; font-size: 11.5px; color: var(--text-faint); }
@media (max-width: 760px) { .rv-plan { grid-template-columns: 1fr; } }
</style>
