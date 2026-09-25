// dropguard.test.js — 拖放安全网注入分片契约（design/drag-drop-attachment-upload.md §4.2）。
//
// 守什么：main.rs 主窗 .disable_drag_drop_handler() 后，DSH 各页面（轨迹/用量/设置）
// 的 drop 落空会导航到 file:// 换掉 SPA。安全网是 themes/src/09-dropguard.js，经
// MANIFEST.order 拼接进 src-tauri/injected/theme-init.js（initialization_script 注入
// 每个文档）。本测试钉死四件事：
//   ① 分片在 MANIFEST order 里（漏登记 = 注入产物里没有它，回归面裸奔）；
//   ② 生成产物 theme-init.js 真的含该片特征串（gen-init 跑过的证据）；
//   ③ 三判据齐全：dragover 一律阻止 / drop 只认 Files / defaultPrevented 放行；
//   ④ 形态纪律：自包含 IIFE（08-ready.js 已闭合大 IIFE，本片在其后拼接）、
//      无常驻状态、无定时器（设计 §4.2「全部副作用即监听器本身」）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const slicePath = join(desktop, 'themes', 'src', '09-dropguard.js')
const manifestPath = join(desktop, 'themes', 'src', 'MANIFEST.json')
const bundlePath = join(desktop, 'src-tauri', 'injected', 'theme-init.js')

test('分片存在且已登记进 MANIFEST.order', () => {
  assert.ok(existsSync(slicePath), '缺少 themes/src/09-dropguard.js')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(Array.isArray(manifest.order), 'MANIFEST.order 缺失')
  assert.ok(manifest.order.includes('09-dropguard.js'), '09-dropguard.js 未登记进 order（拼接唯一真相）')
  // 必须排在 08-ready.js 之后（ready 之后收尾，不打断既有启动序列）
  assert.ok(manifest.order.indexOf('09-dropguard.js') > manifest.order.indexOf('08-ready.js'))
})

test('生成产物含安全网（gen-init 已跑）', () => {
  assert.ok(existsSync(bundlePath), '缺少 src-tauri/injected/theme-init.js（先跑 npm run gen-init）')
  const bundle = readFileSync(bundlePath, 'utf8')
  assert.ok(bundle.includes('dragover') && bundle.includes("indexOf('Files')"),
    'theme-init.js 里找不到安全网特征——MANIFEST 或分片内容与生成产物不同步，重跑 npm run gen-init')
})

test('三判据齐全：dragover 阻止 / 只认 Files / defaultPrevented 放行', () => {
  const src = readFileSync(slicePath, 'utf8')
  assert.match(src, /addEventListener\('dragover'/, '缺少 dragover 监听（不阻止则 drop 不触发）')
  assert.match(src, /addEventListener\('drop'/, '缺少 drop 监听')
  assert.match(src, /indexOf\('Files'\) !== -1/, 'drop 必须只认文件拖放（与官方同一判据）')
  assert.match(src, /if \(e\.defaultPrevented\) return/, '官方已消费的 drop 必须放行（defaultPrevented 判据）')
})

test('形态纪律：自包含 IIFE、无常驻状态无定时器', () => {
  const src = readFileSync(slicePath, 'utf8')
  assert.match(src, /;\(\(function \(\) \{/, '必须以 ;((function(){ 开头（前片末尾可能是 )()，防 ASI）')
  assert.match(src, /\}\)\(\)\)\s*$/, '必须按设计的 })()) 自闭合（本片拼在 08-ready.js 闭合大 IIFE 之后，不共享作用域）')
  assert.ok(!/setInterval|setTimeout/.test(src), '不得有定时器（副作用即监听器本身）')
  assert.ok(!/var\s+(state|cache|map)\s*=/.test(src), '不得有常驻状态模块变量')
})
