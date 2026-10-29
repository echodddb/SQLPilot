import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// root / outDir 一律用「绝对 + 真实路径」，不要用相对路径。
// 原因：Windows 上 process.cwd() 的盘符大小写不稳定（e:\ 与 E:\ 两种都可能出现），
// 相对 root 会经由 path.resolve(cwd, ...) 继承该大小写，而 Vite 的 html-proxy
// （index.html 内联 <style> 生成的虚拟模块）以路径字符串为缓存键，一旦与
// realpath 规范化得到的真实大小写不一致，就会报：
//   [vite:html-inline-proxy] Could not load ...?html-proxy&inline-css&index=0.css
//   No matching HTML proxy module found
// realpathSync.native 返回 NTFS 上的真实大小写，从而消除对 cwd 形式的依赖。
const root = realpathSync.native(fileURLToPath(new URL('./src/renderer', import.meta.url)))

export default defineConfig({
  root,
  base: './',
  plugins: [vue()],
  build: {
    outDir: resolve(root, '../../dist/renderer'),
    emptyOutDir: true
  }
})
