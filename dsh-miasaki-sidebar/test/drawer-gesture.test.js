import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Drawer swipe-to-close gesture (design §3.1: "遮罩 + 右滑关闭").
 *
 * client.js is a `__ModuleLoader__` bundle with no exports, so the decision
 * function is exercised by extracting its source — the same technique the
 * desktop line uses for the injection layer. `drawerCloseDecision` keeps its
 * thresholds LOCAL on purpose: that makes the extraction self-contained.
 *
 * If you rename or move the function, this loader fails loudly instead of
 * silently passing.
 */
const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

function loadDrawerCloseDecision() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  const marker = 'const drawerCloseDecision = '
  const at = source.indexOf(marker)
  assert.notStrictEqual(at, -1, 'client.js 里找不到 drawerCloseDecision')
  const exprStart = at + marker.length
  // Start at the FUNCTION BODY brace (after `=>`), not the parameter
  // destructuring brace — the latter would close the depth counter instantly.
  const bodyStart = source.indexOf('{', source.indexOf('=>', exprStart))
  assert.notStrictEqual(bodyStart, -1, 'drawerCloseDecision 缺少箭头函数体')
  // Brace matching over the arrow-function body. No braces inside strings in
  // that function today — keep it that way if you edit it.
  let depth = 0
  let end = -1
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  assert.notStrictEqual(end, -1, 'drawerCloseDecision 的函数体未闭合')
  return new Function(`"use strict";return (${source.slice(exprStart, end)})`)()
}

const decide = loadDrawerCloseDecision()

test('只认向右：向左拖拽不是关闭手势', () => {
  assert.equal(decide({ dx: -120, dy: 0, width: 400, elapsedMs: 100 }), false)
  assert.equal(decide({ dx: -1, dy: 0, width: 400, elapsedMs: 1 }), false)
})

test('垂直意图优先：斜向拖拽交给标签页滚动，绝不关面板', () => {
  assert.equal(decide({ dx: 200, dy: 250, width: 400, elapsedMs: 100 }), false)
  // 等值也算垂直（严格大于才认水平）
  assert.equal(decide({ dx: 100, dy: 100, width: 400, elapsedMs: 10 }), false)
})

test('位移达到面板宽度的 30% 即关闭（阈值边界两侧）', () => {
  assert.equal(decide({ dx: 120, dy: 10, width: 400, elapsedMs: 1000 }), true)
  assert.equal(decide({ dx: 119, dy: 10, width: 400, elapsedMs: 1000 }), false)
})

test('窄面板走 64px 下限（宽度比例不占主导）', () => {
  assert.equal(decide({ dx: 64, dy: 10, width: 200, elapsedMs: 1000 }), true)
  assert.equal(decide({ dx: 63, dy: 10, width: 200, elapsedMs: 1000 }), false)
})

test('快速轻扫：位移不足但速度够即关闭', () => {
  assert.equal(decide({ dx: 50, dy: 5, width: 400, elapsedMs: 50 }), true)
})

test('慢速小幅拖拽回弹（不误关）', () => {
  assert.equal(decide({ dx: 50, dy: 5, width: 400, elapsedMs: 500 }), false)
})

test('轻扫有最小位移门：再快也不认极端小位移', () => {
  assert.equal(decide({ dx: 20, dy: 2, width: 400, elapsedMs: 1 }), false)
})

test('elapsedMs 为 0 时只有位移门生效（不做除零）', () => {
  assert.equal(decide({ dx: 150, dy: 0, width: 400, elapsedMs: 0 }), true)
  assert.equal(decide({ dx: 50, dy: 0, width: 400, elapsedMs: 0 }), false)
})

test('零位移不关闭', () => {
  assert.equal(decide({ dx: 0, dy: 0, width: 400, elapsedMs: 100 }), false)
})
