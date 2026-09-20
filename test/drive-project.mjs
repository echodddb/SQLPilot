// CDP 验证：项目创建弹窗正常渲染（此前 window.prompt 不被 Electron 支持）
const BASE = 'http://127.0.0.1:9222'

async function main() {
  const targets = await (await fetch(`${BASE}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
  }
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await send('Runtime.enable')
  await send('Page.enable')
  await ev(`window.alert = () => {}; window.confirm = () => true; 'ok'`)

  // 点击侧边栏"项目"区的 ＋
  const clicked = await ev(`(() => {
    const heads = [...document.querySelectorAll('.side-head')]
    const projHead = heads.find(h => h.textContent.includes('项目'))
    if (!projHead) return '未找到项目区'
    const btn = projHead.querySelector('.icon-btn')
    if (!btn) return '未找到＋按钮'
    btn.click(); return 'clicked'
  })()`)
  console.log('点击项目＋:', clicked)
  await sleep(600)

  const modal = await ev(`(() => {
    const titles = [...document.querySelectorAll('.modal h3')].map(h => h.textContent.trim())
    const folderInput = !!document.querySelector('.modal input[readonly]')
    return { titles, hasFolderInput: folderInput }
  })()`)
  console.log('弹窗状态:', JSON.stringify(modal))

  // 新建会话＋ → 应弹出"选择项目"（无项目时直接弹新建项目）
  await ev(`(() => {
    const heads = [...document.querySelectorAll('.side-head')]
    const sHead = heads.find(h => h.textContent.includes('会话'))
    sHead.querySelector('.icon-btn').click(); return 1
  })()`)
  await sleep(600)
  const modal2 = await ev(`[...document.querySelectorAll('.modal h3')].map(h => h.textContent.trim())`)
  console.log('点会话＋后弹窗:', JSON.stringify(modal2))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('E:/ai/Workspace/wd/dbagent/test/project-modal.png', Buffer.from(shot.result.data, 'base64'))
    console.log('截图: test/project-modal.png')
  }
  ws.close()
}

main().catch((e) => { console.error('DRIVER FAILED:', e); process.exit(1) })
