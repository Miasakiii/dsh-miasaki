import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * client.js 是 `__ModuleLoader__` bundle（没有 exports），所以纯逻辑按源码
 * 抽取求值 —— 与 review-view-store.test.js 同一手法（桌面线注入层也用这招）。
 *
 * 覆盖「改错了很难在实机发现」的一处逻辑：审查列表的目录分组与组内统计求和。
 * 抽取靠锚点，改名或挪位会**响亮失败**而不是静默通过。
 *
 * 历史：本文件原为 client-tabs.test.js，其中 7 项覆盖自研壳的持久化 v3 与
 * v2/v1 迁移。自研壳于 2026-09-10 退役、2026-09-11 完成第二阶段清理（代码已删），
 * 那 7 项随壳退役；此处只保留与壳无关的分组统计。
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 箭头函数体括号匹配（该函数体内字符串不含花括号）。 */
function loadArrowFunction(name) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const marker = `const ${name} = `
  const at = source.indexOf(marker)
  assert.notStrictEqual(at, -1, `client.js 里找不到 ${name}`)
  const exprStart = at + marker.length
  const bodyStart = source.indexOf('{', source.indexOf('=>', exprStart))
  assert.notStrictEqual(bodyStart, -1, `${name} 缺少箭头函数体`)
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  assert.notStrictEqual(end, -1, `${name} 的函数体未闭合`)
  return new Function(`"use strict";return (${source.slice(exprStart, end)})`)()
}

const groupEntries = loadArrowFunction('groupEntries')

// ---------------------------------------------------------------------------
// 目录分组与统计
// ---------------------------------------------------------------------------

test('groupEntries: groups by directory, sums stats, keeps paths normalized', () => {
  const groups = groupEntries([
    { path: 'lib/cache.ts', add: 155, del: 23, binary: false },
    { path: 'lib/oauth.ts', add: 37, del: 18, binary: false },
    { path: 'app/page.tsx', add: 7, del: 0, binary: false },
    { path: 'README.md', add: 3, del: 1, binary: false },
    { path: 'img.png', add: null, del: null, binary: true },
    { path: 'sub\\win.ts', add: 2, del: 2, binary: false },
  ])
  const byDir = new Map(groups.map(group => [group.dir, group]))
  assert.deepEqual([...byDir.keys()], ['', 'app', 'lib', 'sub'], '目录字典序，根目录是空串')
  assert.equal(byDir.get('').label, './')
  assert.equal(byDir.get('lib').label, 'lib/')
  assert.deepEqual([byDir.get('lib').add, byDir.get('lib').del], [192, 41], '组统计是组内求和')
  assert.deepEqual(byDir.get('lib').entries.map(entry => entry.name), ['cache.ts', 'oauth.ts'])
  assert.equal(byDir.get('sub').entries[0].name, 'win.ts', '反斜杠路径归一后取文件名')
})

test('groupEntries: binary entries contribute no numbers and do not fake a sum', () => {
  const groups = groupEntries([
    { path: 'assets/logo.png', add: null, del: null, binary: true },
    { path: 'assets/icon.svg', add: 4, del: 1, binary: false },
  ])
  const group = groups[0]
  assert.equal(group.counted, 1, '只有带数字的条目参与统计计数')
  assert.deepEqual([group.add, group.del], [4, 1])
})

test('groupEntries: an empty list produces no groups', () => {
  assert.deepEqual(groupEntries([]), [])
})
