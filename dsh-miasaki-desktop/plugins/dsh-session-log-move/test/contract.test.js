// dsh-session-log-move 契约测试（纯源码/清单断言，与 canvas、ssh 线同风格）：
// 钉住 2026-09-26 的清理 —— 删掉注定失败的 slot 替换路线，只留 DOM 路径。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (rel) => readFile(new URL('../' + rel, import.meta.url), 'utf8')

test('does not depend on slot declarations it cannot win', async () => {
  const source = await read('lib/client.js')
  // 官方 dsh-session-log-export 自 0.1.5-rc.1 起占同 id ⇒ 同 id 替换必然冲突；
  // 而 0.1.7 的槽声明是多级异步链，apply 时同步 register 只会留一条
  // `slot … is not declared` 的 error 噪声。两条路都不该再出现。
  assert.doesNotMatch(source, /ctx\.slots\.register/)
  assert.doesNotMatch(source, /ctx\.slots\.inject/)
  // slots 也不再是需要注入的服务（少一处「服务缺失即 fiber 挂起」的风险面）。
  assert.match(source, /const inject = \["timer", "sessions"\]/)
})

test('keeps the DOM path as the working one', async () => {
  const source = await read('lib/client.js')
  // 隐藏官方头部按钮：子串锚点 + display 往返（卸载可逆）。
  assert.match(source, /button\[class\*="sessionLogButton"\]/)
  assert.match(source, /node\.style\.display = "none"/)
  assert.match(source, /node\.style\.display === "none"\) node\.style\.display = ""/)
  // 轨迹页注入：toolbar 搜索框左侧 + MutationObserver + 重试兜底。
  assert.match(source, /input\[type="search"\]/)
  assert.match(source, /new MutationObserver/)
  assert.match(source, /MAX_ATTEMPTS = 60/)
})

test('download path still prefers the official service and degrades to the endpoint', async () => {
  const source = await read('lib/client.js')
  assert.match(source, /ctx\.get\("sessionLogDownload"\)/)
  assert.match(source, /\/api\/session\.export\?sessionId=/)
})

test('declares the web platform without extra client inject', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.dsh.client.platform, 'web')
  // 不再声明 dsh.client.inject：本插件不注册任何槽，少一处跨 entry 耦合。
  assert.equal(pkg.dsh.client.inject, undefined)
  assert.equal(pkg.version, '0.1.2')
})
