// theme-source.test.js — 主题来源优先级行为闸门（W0-T0.1，2026-09-25）。
//
// 守什么：壳在窗口创建时把 prefs.json 的主题经 `window.__MIA_THEME__` 注入**每个文档**
// （main.rs:1647-1649 拼在 initialization_script 前缀里），但 2026-09-25 之前
// themes/src 全片**零处读取**它 —— 断链后果：本地唤醒页是 `tauri.localhost`，
// 与 DSH 页（`127.0.0.1:3080`）不同源 ⇒ localStorage 为空 ⇒ current 退化成 'pure'，
// 而该页 `:root` 默认色板是 zafkiel ⇒ 启动画面与进入后的 DSH 页主题不一致（闪窗）。
//
// 本测试把优先级钉死在**行为**层（不只看源码里写了什么）：
//     window.__MIA_THEME__（壳权威值） > URL 参数 > localStorage > 'pure'
// 并覆盖两条安全边界：非壳环境（浏览器）不得报错、localStorage 抛异常时不得整体崩。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../src/02-core.js', import.meta.url), 'utf8')

/** 截出被测段（含首尾标记注释，注释在 JS 里合法）。 */
const slice = (() => {
  const begin = source.indexOf('/* @slice:theme-source:begin')
  assert.notEqual(begin, -1, '02-core.js 必须保留 @slice:theme-source:begin 标记')
  const end = source.indexOf('/* @slice:theme-source:end */', begin)
  assert.notEqual(end, -1, '02-core.js 必须保留 @slice:theme-source:end 标记')
  return source.slice(begin, end)
})()

const ORDER = ['pure', 'zafkiel', 'kurkuriel']
const KEY = 'miasaki-theme'

/**
 * 在最小沙箱里跑截段并返回解析出的 current。
 * @param shell 壳注入值（undefined = 非壳环境，全局不存在）
 * @param url   location.search（含 `?miasaki-theme=…`）
 * @param stored localStorage 里存的主题
 * @param throwOnRead 模拟隐私模式下 localStorage 抛异常
 */
function resolveCurrent({ shell = undefined, url = '', stored = null, throwOnRead = false } = {}) {
  const sandbox = {
    URLSearchParams,
    ORDER,
    KEY,
    location: { search: url },
    localStorage: {
      getItem: () => {
        if (throwOnRead) throw new Error('localStorage denied')
        return stored
      }
    },
    window: {}
  }
  if (shell !== undefined) sandbox.window.__MIA_THEME__ = shell
  vm.runInNewContext(slice, sandbox)
  return sandbox.current
}

test('无任何来源 → 默认 pure', () => {
  assert.equal(resolveCurrent(), 'pure')
})

test('仅 localStorage → 采用存量值（页面内切换后的持久值）', () => {
  assert.equal(resolveCurrent({ stored: 'kurkuriel' }), 'kurkuriel')
})

test('仅 URL 参数 → 采用该值（外部直达 / 调试）', () => {
  assert.equal(resolveCurrent({ url: '?miasaki-theme=zafkiel' }), 'zafkiel')
})

test('URL 参数优先于 localStorage', () => {
  assert.equal(resolveCurrent({ stored: 'pure', url: '?miasaki-theme=kurkuriel' }), 'kurkuriel')
})

test('★★ __MIA_THEME__ 优先级最高（壳权威值，跨源唯一通道）', () => {
  assert.equal(
    resolveCurrent({ shell: 'zafkiel', stored: 'pure', url: '?miasaki-theme=kurkuriel' }),
    'zafkiel'
  )
})

test('非法值逐级忽略（不认识的主题不得污染结果）', () => {
  assert.equal(resolveCurrent({ shell: 'bogus', stored: 'bogus', url: '?miasaki-theme=bogus' }), 'pure')
  assert.equal(resolveCurrent({ shell: 'bogus', stored: 'kurkuriel' }), 'kurkuriel')
})

test('非壳环境（普通浏览器无 __MIA_THEME__）不报错，退回 localStorage/URL', () => {
  assert.equal(resolveCurrent({ stored: 'zafkiel' }), 'zafkiel')
  assert.equal(resolveCurrent({ url: '?miasaki-theme=kurkuriel' }), 'kurkuriel')
})

test('localStorage 抛异常（隐私模式）不整体崩，仍走默认值', () => {
  assert.equal(resolveCurrent({ throwOnRead: true }), 'pure')
  // 即使读取抛异常，壳注入值仍应在 catch 之外生效？——不：读写同在 try 内，
  // 安全边界是「不崩」而非「部分生效」，此处钉死当前语义，避免误改成两段 try。
  assert.equal(resolveCurrent({ throwOnRead: true, shell: 'zafkiel' }), 'pure')
})
