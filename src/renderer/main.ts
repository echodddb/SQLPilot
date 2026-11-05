import { createApp } from 'vue'
import App from './App.vue'
import ObAgentWindow from './components/oblog/ObAgentWindow.vue'
import './styles.css'

const q = new URLSearchParams(location.search)

// 主进程按配置把主题塞进 query，这里立刻落到 <html> 上。
// 不能等 init() 把配置读回来再切，否则亮色用户会先看见一屏深色启动画面。
document.documentElement.setAttribute('data-theme', q.get('theme') === 'light' ? 'light' : 'dark')

// 独立浮窗（OB 排障 Agent 脱离主窗口时用）：同一个页面，只挂浮窗那一块
const panel = q.get('panel')

// 跳过启动画面时（SQLPILOT_NO_SPLASH=1）连首屏骨架一起摘掉，别闪一下
if (q.get('nosplash') === '1' || panel) {
  document.getElementById('boot-veil')?.remove()
}

if (panel === 'obagent') {
  // 透明 HUD：窗口背景必须透，圆角/阴影才不会被窗口边缘切成直角
  document.documentElement.setAttribute('data-shell', 'panel')
  createApp(ObAgentWindow).mount('#app')
} else {
  createApp(App).mount('#app')
}
