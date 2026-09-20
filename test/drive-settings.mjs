// CDP 自动化：复现"设置 → 添加模型提供商"流程，捕获报错原文与界面状态
const BASE = 'http://127.0.0.1:9222'

async function main() {
  const targets = await (await fetch(`${BASE}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let seq = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    } else if (d.method) {
      events.push(d)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq
      pending.set(id, res)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) {
      return { __ex: r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails) }
    }
    return r.result?.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  await send('Runtime.enable')
  await send('Page.enable')

  // 拦截 alert/confirm，避免阻塞并记录内容
  await evalJs(`(() => {
    window.__alerts = []; window.__confirms = []
    window.alert = (m) => { window.__alerts.push(String(m)); return undefined }
    window.confirm = (m) => { window.__confirms.push(String(m)); return true }
    return 'hooked'
  })()`)

  // 1. 打开设置页
  console.log('--- 打开设置页 ---')
  console.log(await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置'))
    if (!btn) return '未找到设置按钮'
    btn.click(); return 'clicked'
  })()`))
  await sleep(800)

  // 2. 检查表单是否存在
  const formState = await evalJs(`(() => {
    const inputs = [...document.querySelectorAll('.card input, .card select, .card textarea')]
    return {
      inputCount: inputs.length,
      labels: [...document.querySelectorAll('.card .fitem label')].map(l => l.textContent.trim()).slice(0, 12)
    }
  })()`)
  console.log('--- 表单结构 ---'); console.log(JSON.stringify(formState, null, 2))

  // 3. 选厂商（第二个：智谱 GLM），触发 change
  console.log('--- 选择厂商：智谱 ---')
  console.log(await evalJs(`(() => {
    const sel = [...document.querySelectorAll('.card select')].find(s => [...s.options].some(o => o.textContent.includes('智谱')))
    if (!sel) return '未找到厂商选择框'
    const opt = [...sel.options].find(o => o.textContent.includes('智谱'))
    sel.value = opt.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return 'vendor=' + opt.value
  })()`))
  await sleep(400)

  // 4. 填 API Key
  console.log(await evalJs(`(() => {
    const key = [...document.querySelectorAll('.card input[type=password]')].pop()
    if (!key) return '未找到 API Key 输入框'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(key, 'sk-test-dummy-key-123')
    key.dispatchEvent(new Event('input', { bubbles: true }))
    return 'key filled'
  })()`))

  // 5. 点击添加
  console.log('--- 点击添加 ---')
  console.log(await evalJs(`(() => {
    const btn = [...document.querySelectorAll('.card button')].find(b => b.textContent.trim() === '添加')
    if (!btn) return '未找到添加按钮'
    btn.click(); return 'clicked'
  })()`))
  await sleep(1200)

  // 6. 结果检查
  const after = await evalJs(`(() => ({
    providers: [...document.querySelectorAll('.provider-item')].map(p => p.textContent.replace(/\\s+/g, ' ').trim()),
    alerts: window.__alerts,
    confirms: window.__confirms
  }))()`)
  console.log('--- 保存后状态 ---'); console.log(JSON.stringify(after, null, 2))

  // 7. 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync('E:/ai/Workspace/wd/dbagent/test/settings-after.png', Buffer.from(shot.result.data, 'base64'))
    console.log('--- 截图已保存 test/settings-after.png ---')
  }

  // 8. 汇总 console 全量
  const consoleAll = events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => `[${e.params.type}] ` + e.params.args?.map((a) => a.value ?? a.description ?? '').join(' '))
  const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description)
  console.log('--- console 全量 ---'); console.log(consoleAll.join('\n') || '(无)')
  console.log('--- 未捕获异常 ---'); console.log(exceptions.join('\n') || '(无)')

  ws.close()
}

main().catch((e) => { console.error('DRIVER FAILED:', e); process.exit(1) })
