// client.test.mjs — @miasaki/dsh-fleet-panel client half 契约（2026-10-20）
//
// 形态：**会话视图 tab**（conversation.view，排在「用量」之后，order 16）+ **原生渲染**
// （不再 iframe；解决「设计语言不统一」与「里页无法滚动」两个用户反馈）。
//
// 覆盖点：
//   · bundle 自声明 module（DSH 装载器不注入 module —— 漏了就是「入口整块不出现」）；
//   · 只注册 conversation.view，且 order 在「用量」(15) 之后、label 为 Fleet；
//   · **不再注册 sidebar.footer.action / shell.overlay / 不使用 iframe / 不调用 window.open**
//     （防回退到旧形态；旧「在浏览器打开」按钮在桌面壳里无效，已移除）；
//   · 原生视图渲染：style + 视图容器 + **可滚动内容区** + 判定层/Agent 区块；
//   · 数据源走同源代理：/dsh-fleet/api/{fleet,dispatchable,gaps,events,verifiers}；
//   · 样式只走 --dsw 令牌（禁硬编码 hex / rgb）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')
const SOURCE = fs.readFileSync(CLIENT, 'utf8')

/** 在只有 window.__ModuleLoader__ 的 VM 里跑 client bundle（对齐 DSH 装载器形状）。 */
function loadBundle() {
	let def = null
	const sandbox = {
		window: { __ModuleLoader__: { load: (d) => { def = d } } },
		console,
		Symbol,
		Object,
		fetch: () => Promise.reject(new Error('no network in test')),
		setInterval: () => 0,
		clearInterval: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		open: () => null,
		Date,
		Math,
		Number,
		String,
		JSON,
		encodeURIComponent,
	}
	vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
	assert.ok(def, 'client bundle 必须调用 window.__ModuleLoader__.load')
	return def
}

/** 最小 react 替身：只覆盖本插件用到的 API，不执行 effect。 */
function makeReact() {
	const react = {
		createElement(type, props, ...children) {
			return { type, props: props || {}, children }
		},
		useState(initial) {
			const value = typeof initial === 'function' ? initial() : initial
			return [value, () => {}]
		},
		useEffect() {},
		useRef(value) {
			return { current: value }
		},
	}
	return { react }
}

function makeCtx() {
	const injections = []
	const registrations = []
	return {
		injections,
		registrations,
		ctx: {
			slots: {
				inject(name, register) { injections.push(name); register() },
				register(meta, component) { registrations.push({ meta, component }) },
			},
		},
	}
}

/** 深度遍历元素并收集 className / 文本。 */
function walk(node, out = { classNames: [], texts: [], types: [] }) {
	if (node === null || node === undefined) return out
	if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
	if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
	if (typeof node === 'object') {
		if (node.type) out.types.push(node.type)
		if (node.props && typeof node.props.className === 'string') out.classNames.push(node.props.className)
		if (Array.isArray(node.children)) for (const child of node.children) walk(child, out)
	}
	return out
}

test('bundle 自声明 module 并声明插件 id', () => {
	assert.match(SOURCE, /var module = \{ exports: \{\} \};/, '必须自声明 module —— 装载器只交 require')
	assert.match(SOURCE, /window\.__ModuleLoader__\.load/)
	const def = loadBundle()
	assert.equal(def.id, '@miasaki/dsh-fleet-panel')
	assert.equal(typeof def.factory, 'function')
})

test('factory 返回 apply / inject，且只依赖 slots', () => {
	const def = loadBundle()
	const { react } = makeReact()
	const exports = def.factory((name) => {
		if (name === 'react') return react
		throw new Error(`未预期的依赖：${name}`)
	})
	assert.equal(typeof exports.apply, 'function')
	// 跨 realm 数组原型不同：先转主 realm 再比较。
	assert.deepEqual(Array.from(exports.inject), ['slots'])
})

test('只注册会话视图 tab：conversation.view，order 紧跟「用量」(15) 之后', () => {
	const def = loadBundle()
	const { react } = makeReact()
	const exports = def.factory((name) => (name === 'react' ? react : undefined))
	const { injections, registrations, ctx } = makeCtx()
	exports.apply(ctx)
	assert.deepEqual(injections, ['conversation.view'])
	assert.equal(registrations.length, 1)
	const { meta, component } = registrations[0]
	assert.equal(meta.name, 'conversation.view')
	assert.equal(meta.id, 'fleet-panel')
	assert.equal(meta.label, 'Fleet')
	assert.equal(meta.order, 16, '应排在「用量」order=15 之后')
	assert.equal(typeof component, 'function')
	// 防回退：不再占用侧栏脚部 / 全局浮窗。
	assert.ok(!injections.includes('sidebar.footer.action'), '不得再注册侧栏脚部按钮')
	assert.ok(!injections.includes('shell.overlay'), '不得再注册全局浮窗')
})

test('原生渲染：不使用 iframe，也不调用 window.open（桌面壳里无效的旧按钮已移除）', () => {
	assert.ok(!SOURCE.includes('createElement("iframe"'), '不得回退到 iframe（主题不统一且里页滚不动）')
	assert.ok(!/window\.open\s*\(/.test(SOURCE), '旧「在浏览器打开」按钮在桌面壳无效，已移除')
	assert.ok(SOURCE.includes('http://127.0.0.1:39801/'), '完整面板地址仍以文本形式给出')
})

test('数据源走同源代理：fleet / dispatchable / gaps / events / verifiers', () => {
	for (const p of ['/api/fleet', '/api/dispatchable', '/api/gaps', '/api/events?limit=8', '/api/verifiers', '/api/toggle/']) {
		assert.ok(SOURCE.includes(p), `缺少数据源：${p}`)
	}
	assert.ok(SOURCE.includes('const API = "/dsh-fleet"'), '所有请求必须走 /dsh-fleet 同源前缀')
})

test('视图渲染：style + 视图容器 + 可滚动内容区 + 判定层与 Agent 区块', () => {
	const def = loadBundle()
	const { react } = makeReact()
	const exports = def.factory((name) => (name === 'react' ? react : undefined))
	const { registrations, ctx } = makeCtx()
	exports.apply(ctx)
	const view = registrations[0].component
	const tree = view({ sessionId: 'session-1' })
	assert.ok(Array.isArray(tree), '视图必须返回数组（逗号表达式会丢弃 style）')
	assert.equal(tree.length, 2)
	assert.equal(tree[0].type, 'style')
	assert.equal(tree[1].props.className, 'fpanel-view')
	const info = walk(tree)
	assert.ok(info.classNames.some((c) => c.includes('fpanel-scroll')), '需要可滚动内容区（里页无法滚动的修复点）')
	const text = info.texts.join('|')
	assert.match(text, /Fleet/)
	assert.match(text, /判定层/)
	assert.match(text, /Agent Fleet/)
	assert.match(text, /会话级入口/, '传入 sessionId 时应标出会话级入口')
})

test('样式只走 --dsw 令牌，不夹带硬编码颜色', () => {
	assert.ok(SOURCE.includes('var(--dsw-alias-'), '应使用官方主题令牌')
	assert.doesNotMatch(SOURCE, /#[0-9a-fA-F]{3,8}\b/, '不得出现硬编码 hex 颜色')
	assert.doesNotMatch(SOURCE, /\brgba?\(/, '不得出现硬编码 rgb/rgba 颜色')
})
