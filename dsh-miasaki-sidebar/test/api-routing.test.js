import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createApi, resolveWorkdir } from '../index.js'

// 回归对象（2026-09-08 修复）：`resolveWorkdir()` 原先先 `resolve(raw)` 再判
// `isAbsolute`——resolve 之后恒为真，于是「cwd 必须绝对路径」这条约束在真实
// 路由链路上形同虚设：相对路径被静默解释为「相对 host 进程 cwd」，轻则 404，
// 重则（该路径恰好存在时）在 host 自己的目录里真的拉起一个终端。
// 因此测试必须走真实 HTTP 路由，而不只是测被它调用的辅助函数。

const silent = { warn() {}, error() {}, info() {}, debug() {} }

/** 起一个只挂 sidebar API 的真实 HTTP server（随机端口，127.0.0.1）。 */
async function startApi(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sidebar-api-'))
  const api = createApi({ dataFile: join(dir, 'data.json'), logger: silent, ...options })
  const server = http.createServer((req, res) => {
    api(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections?.()
      await new Promise(done => server.close(done))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** 发一个请求并解析 JSON 正文（Host 可覆盖——fetch 不允许改这个头）。 */
function request(port, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }),
        ...headers,
      },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON 正文保持 null */ }
        resolvePromise({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

test('resolveWorkdir: relative paths are refused before resolve() can rewrite them', () => {
  for (const raw of ['relative\\path', 'relative/path', './x', '../x', 'dsh-miasaki-sidebar', '.', '..']) {
    assert.throws(() => resolveWorkdir(raw), /绝对路径/, `应拒绝相对路径：${raw}`)
  }
  // 驱动器相对路径（C:foo）在 Windows 上也不是绝对路径。
  if (process.platform === 'win32') {
    assert.throws(() => resolveWorkdir('C:relative'), /绝对路径/)
    // UNC 是真绝对路径，必须放行（不能把「非驱动器开头」当成相对）。
    assert.ok(isAbsolute(resolveWorkdir('\\\\server\\share\\x')))
  }
  for (const raw of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => resolveWorkdir(raw), /绝对路径/, `应拒绝非路径输入：${String(raw)}`)
  }
})

test('resolveWorkdir: absolute paths normalize and tolerate surrounding blanks', () => {
  const target = process.platform === 'win32' ? 'C:\\Windows' : '/usr'
  assert.equal(resolveWorkdir(`  ${target}  `), resolve(target))
  assert.equal(resolveWorkdir(target), resolve(target))
})

test('POST /terminal/open: a relative cwd is a 400, not a resolved 404', async () => {
  const api = await startApi()
  try {
    const res = await request(api.port, {
      method: 'POST',
      path: '/sidebar/api/terminal/open',
      body: { shell: 'cmd', cwd: 'relative\\path' },
    })
    assert.equal(res.status, 400, `修复前这里会 404（相对路径被 resolve 到 host cwd 下）：${res.text}`)
    assert.match(res.json.error, /绝对路径/)
  } finally {
    await api.close()
  }
})

test('POST /terminal/open: an existing-but-relative cwd is refused before any spawn', async () => {
  const api = await startApi()
  try {
    // 危险场景：'test' 相对 host 进程 cwd 恰好存在，修复前会真的在那里拉起
    // 终端。用未知 shell id 保证断言失败时也不产生副作用——cwd 校验必须
    // 先于 shell 枚举，所以文案仍应是「绝对路径」而非「未知的终端类型」。
    const res = await request(api.port, {
      method: 'POST',
      path: '/sidebar/api/terminal/open',
      body: { shell: 'no-such-shell', cwd: 'test' },
    })
    assert.equal(res.status, 400)
    assert.match(res.json.error, /绝对路径/, 'cwd 守卫必须先于 shell 枚举生效')
  } finally {
    await api.close()
  }
})

test('GET /review/status: the same cwd guard covers the review family', async () => {
  const api = await startApi()
  try {
    const res = await request(api.port, { path: `/sidebar/api/review/status?cwd=${encodeURIComponent('relative\\path')}` })
    assert.equal(res.status, 400)
    assert.match(res.json.error, /绝对路径/)
  } finally {
    await api.close()
  }
})

test('an absolute cwd still behaves as before: missing directory is a 404, not a 400', async () => {
  const api = await startApi()
  try {
    const missing = process.platform === 'win32' ? 'C:\\NoSuchDir_sidebar_api_test' : '/no-such-dir-sidebar-api-test'
    const res = await request(api.port, {
      method: 'POST',
      path: '/sidebar/api/terminal/open',
      body: { shell: 'cmd', cwd: missing },
    })
    assert.equal(res.status, 404, '修复不得误伤绝对路径（存在性仍由 assertDirectory 判定）')
    assert.match(res.json.error, /工作目录不存在/)
  } finally {
    await api.close()
  }
})

test('routing basics: health answers, untrusted Host is fenced, unknown path is 404', async () => {
  const api = await startApi()
  try {
    const health = await request(api.port, { path: '/sidebar/api/health' })
    assert.equal(health.status, 200)
    assert.equal(health.json.plugin, 'sidebar')

    const fenced = await request(api.port, { path: '/sidebar/api/health', headers: { host: 'evil.example.com' } })
    assert.equal(fenced.status, 403)

    const missing = await request(api.port, { path: '/sidebar/api/nope' })
    assert.equal(missing.status, 404)
    assert.match(missing.json.error, /接口不存在/)
  } finally {
    await api.close()
  }
})

test('createApi: an explicit trustedHosts entry is honored', async () => {
  const api = await startApi({ trustedHosts: ['sidebar.test'] })
  try {
    const allowed = await request(api.port, { path: '/sidebar/api/health', headers: { host: 'sidebar.test' } })
    assert.equal(allowed.status, 200)
    // 配置只做并集，回环地址始终可信。
    const loopback = await request(api.port, { path: '/sidebar/api/health' })
    assert.equal(loopback.status, 200)
  } finally {
    await api.close()
  }
})

test('GET /review/status: the view parameter is whitelisted, four legal views answer', async () => {
  const api = await startApi()
  try {
    // 非 git 目录只让 git 命令降级为空数据，不影响路由层判定（真实行集由
    // review-view.test.js 的集成用例覆盖）。
    const cwd = encodeURIComponent(tmpdir())

    const bad = await request(api.port, { path: `/sidebar/api/review/status?cwd=${cwd}&view=bogus` })
    assert.equal(bad.status, 400, '未知视图必须显式拒绝，不能静默回落成别的视图')
    assert.match(bad.json.error, /未知的审查视图/)

    for (const view of ['unstaged', 'staged', 'all', 'last']) {
      const res = await request(api.port, { path: `/sidebar/api/review/status?cwd=${cwd}&view=${view}` })
      assert.equal(res.status, 200, `${view}: ${res.text}`)
      assert.equal(res.json.status.view, view, 'view 必须回显——客户端据此丢弃切视图竞态里的陈旧响应')
    }
  } finally {
    await api.close()
  }
})

// 2026-09-08 加固：Host 围栏之外补两道浏览器信任检查（对齐 better-sidebar
// 的 trust-fence.ts）。Host 只证明「请求打到了本机」，不证明「是本站发起的」；
// DNS-rebinding / 跨站页面仍可满足 Host 检查。
test('browser-trust fence: a cross-site request or a foreign Origin is refused', async () => {
  const api = await startApi()
  try {
    const base = { path: '/sidebar/api/health' }

    // 层 2：浏览器自己判定为跨站 —— 一律拒绝（Host 已通过）。
    const crossSite = await request(api.port, { ...base, headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.status, 403)
    assert.match(crossSite.json.error, /跨站请求/)

    // 层 3：带 Origin 时必须与 Host 同 hostname。
    const foreignOrigin = await request(api.port, { ...base, headers: { origin: 'http://evil.example.com' } })
    assert.equal(foreignOrigin.status, 403)
    assert.match(foreignOrigin.json.error, /跨站来源/)

    // 沙箱 iframe / file: 页面的不透明来源（无法解析）同样拒绝。
    const opaque = await request(api.port, { ...base, headers: { origin: 'null' } })
    assert.equal(opaque.status, 403)

    // 正向：同源 Origin 放行——比较 hostname 而非 host:port。
    const sameOrigin = await request(api.port, {
      ...base,
      headers: { origin: `http://127.0.0.1:${api.port}`, 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(sameOrigin.status, 200, sameOrigin.text)

    // 不带 Origin 的普通请求不受影响（Host 围栏已绑定 authority）。
    const plain = await request(api.port, base)
    assert.equal(plain.status, 200)
  } finally {
    await api.close()
  }
})
