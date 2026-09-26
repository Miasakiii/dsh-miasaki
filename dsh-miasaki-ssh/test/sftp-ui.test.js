// Unit + contract tests for the SFTP drawer frontend (U2.2).
// Part 1: the module loads in a bare vm (no DOM at load time) and exposes the API.
// Part 2: pure helpers via the documented `_pure` test seam.
// Part 3: static contracts — endpoint shapes, size/overwrite double-check on upload,
// ticket renewal window, concurrency, and the app.js/index.js wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../sftp-ui.js', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8')
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const cssSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

test('sftp-ui: 模块在裸 vm 里可加载，window.SshFiles API 齐全', () => {
  const context = vm.createContext({ window: {} })
  vm.runInContext(source, context, { filename: 'sftp-ui.js' })
  const api = context.window.SshFiles
  assert.equal(typeof api.open, 'function')
  assert.equal(typeof api.close, 'function')
  assert.equal(typeof api.isOpenFor, 'function')
})

test('sftp-ui _pure：路径拼接 / 上级目录 / 名称校验', () => {
  const context = vm.createContext({ window: {} })
  vm.runInContext(source, context, { filename: 'sftp-ui.js' })
  const { parentPath, joinPath, validName, crumbName } = context.window.SshFiles._pure
  assert.equal(joinPath('/', 'a.txt'), '/a.txt')
  assert.equal(joinPath('/srv', 'a.txt'), '/srv/a.txt')
  assert.equal(parentPath('/srv/app'), '/srv')
  assert.equal(parentPath('/srv'), '/')
  assert.equal(parentPath('/'), '/')
  assert.equal(crumbName('/srv/app'), 'app')
  assert.equal(crumbName('/'), '/')
  assert.equal(validName('logs'), true)
  assert.equal(validName('a/b'), false, '名字不能穿越目录')
  assert.equal(validName('..'), false)
  assert.equal(validName('a\0b'), false)
  assert.equal(validName(''), false)
  assert.equal(validName(undefined), false)
})

test('sftp-ui _pure：体积与时间格式化', () => {
  const context = vm.createContext({ window: {} })
  vm.runInContext(source, context, { filename: 'sftp-ui.js' })
  const { formatSize, formatTime } = context.window.SshFiles._pure
  assert.equal(formatSize(null), '—')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatTime(null), '')
})

// ---- 静态契约 ----

test('sftp-ui 契约：上传带 overwrite=0 与 size（host 双重校验的浏览器侧一半）', () => {
  assert.match(source, /overwrite=0/)
  assert.match(source, /size=\$\{item\.size\}/)
  assert.match(source, /\/ssh\/api\/sftp\/upload\?/)
  assert.match(source, /\/ssh\/api\/sftp\/list\?/)
  assert.match(source, /\/ssh\/api\/sftp\/op/)
  assert.match(source, /\/ssh\/api\/sftp\/download\?/)
  assert.match(source, /\/ssh\/api\/sftp\/ticket/)
  assert.match(source, /\/ssh\/api\/sftp\/renew/)
})

test('sftp-ui 契约：续期窗口 4 分钟 < 票据 TTL 10 分钟；并发 2', () => {
  assert.match(source, /4 \* 60 \* 1000/)
  assert.match(source, /const CONCURRENCY = 2/)
})

test('sftp-ui 契约：路径进 URL 前 encodeURIComponent（NUL / .. 也不能破出）', () => {
  assert.match(source, /const encodePath = p => encodeURIComponent\(p\)/)
  assert.match(source, /encodePath\(path\)/)
})

test('app.js 接线：文件按钮随存活态启用、主机菜单有文件面板、断开即收起', () => {
  assert.match(appSource, /btn-files/)
  assert.match(appSource, /\$\('#btn-files'\)\.disabled = !live/)
  assert.match(appSource, /window\.SshFiles\?\.open\(conn\.id, conn\.label\)/)
  assert.match(appSource, /window\.SshFiles\?\.isOpenFor\(id\) === true && window\.SshFiles\.close\(\)/)
})

test('index.js 接线：sftp-ui.js 静态路由与页面脚本标签', () => {
  assert.match(indexSource, /cachedAsset\('\.\/sftp-ui\.js'\)/)
  assert.match(indexSource, /path: '\/ssh\/sftp-ui\.js'/)
  assert.match(indexSource, /<script src="\/ssh\/sftp-ui\.js"><\/script>/)
})

test('styles.css 契约：抽屉形态与窄屏全宽覆盖', () => {
  assert.match(cssSource, /\.files-drawer \{/)
  assert.match(cssSource, /position: absolute/)
  assert.match(cssSource, /@media \(max-width: 720px\) \{\s*\.files-drawer \{ inset: 0; width: 100%;/)
})
