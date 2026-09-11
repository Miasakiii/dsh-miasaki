#!/usr/bin/env node
// DSH 轨迹面板「首 token 计时可恢复」运行时补丁。
//
// 背景：轨迹页的计时面板（开始时间 / 总时长 / 首 token 延迟 / 生成 / 吞吐量）里，
// 「首 token 延迟」的后两项依赖同一个 `firstTokenTime`：
//
//   ttft()          firstTokenTime === null → 「首 token 时间不可用」
//   generationTime() 同样先查它            → 同一句
//   throughput()     同样先查它            → 同一句
//
// 而轨迹的 assistant 节点只在**实时流式 chunk**（`assistant/live-chunk`）里折叠出这个
// 时间戳（lib/client.js 的 updateChunk → isTokenDelta 命中才记）。问题是该事件是浏览器端
// session controller 在流式过程中**合成**的 transient 事件，**从不落盘**：
//
//   dsh-api-session-controller/lib/client.js  1386 / 1447 行   ← 合成点（transient frame）
//   dsh-api-session-controller/lib/client.js  1381–1398 行     ← 仅「重连时 attempt 仍在进行中」才回填
//
// 于是一旦事件窗口被重建（刷新页面、重开会话、切走再切回），已结束的步骤全部由 durable
// 事件重建，`settleMessage()` 不恢复这个字段 → `firstTokenTime` 永远是 null →
// 三行一起显示「首 token 时间不可用」。**数据并没有丢**：同一条 `assistant/message`
// 事件自带紧凑 stream（`data.stream`，text-chunks / reasoning-chunks / tool-call-chunks /
// chunk 记录，每条都带时间），官方 host 侧统计投影 `dsh-session-stats` 正是用它恢复
// 首 token 的（`assistantStreamFirstTokenTime`），所以「统计」对话框里的平均 TTFT 一直正常。
//
// 本补丁只做一件事：给轨迹节点的 timing 补一条回退 —— 实时值没有时，从
// `event.data.stream` 恢复；再没有才保留原样的 null（真正的不可用）。
//
// 代价与边界（与 settings-models / conversation 两个补丁同）：DSH 升级会覆盖该包，
// 需重新应用；只改这一个包的 client 产物，不动 DSH 源码、不动其他包。
//
// 用法：
//   node patch.mjs verify            # 离线自检：baseline 原始 → 重建 → SHA 比对 + 恢复逻辑行为断言
//   node patch.mjs status            # 检查已安装 bundle 的补丁状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等：已打过则跳过）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target <client.js 路径>  覆盖自动探测
//
// 设计文档：../../design/trajectory-ttft-restore.md
// 姊妹补丁：../dsh-client-ui-chat（消息气泡的逐条 TTFT 走同一个 timing 字段）

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')

export const TARGET_PACKAGE = '@deepseek-ai/dsh-client-ui-trajectory'
/** DSH 版本基线：锚点文本与原始 baseline 都取自这个版本。 */
export const BASELINE_DSH_VERSION = '0.1.5-rc.1'
/** 官方原版 client.js 的 SHA-256（安装目录中该文件尚无 .dsh-bak，即从未被改过）。 */
export const ORIGINAL_SHA256 = '73A878B46046F20D2B28764E33215274CB170F3909681D547D5ED620E19621AF'
/**
 * 应用本补丁后的 SHA-256。
 *
 * 与 conversation 补丁同一取舍：**不存 patched 全文**（目标 384KB，再存一份不划算），
 * 改存产物 SHA —— `verify` 用「由原始 baseline 重建后的 SHA 是否等于本常量」自证，
 * 与逐字节比对等价（SHA 相等即逐字节相等），锚点失配时仍会响亮报错。
 */
export const PATCHED_SHA256 = 'C3485ADFC25E6F32738DD33358791C0969760ADB8E31533EE35211CAE4FEF24C'
/** 补丁特征串：出现即视为已应用（用于幂等与状态判定）。 */
const PATCH_MARKER = 'dshPatchedFirstTokenTime'

/**
 * 注入的恢复函数：**自包含**（不引用产物里的任何符号，包括它旁边的 isTokenDelta），
 * 语义与 `dsh-llm` 的 `assistantStreamFirstTokenTime` 一致：
 *
 * - `{type:'chunk', time, chunk}`：chunk 是 token delta（非空 text / reasoning，或带
 *   name 或非空 argumentsDelta 的 tool-call）时取其 time；
 * - `{type:'text-chunks'|'reasoning-chunks', time0, dt, texts}`：逐个成员推进时间，
 *   首个非空成员的时间即首 token；
 * - `{type:'tool-call-chunks', time0, dt, args, name?}`：带 name 时整段从 time0 起算，
 *   否则首个非空 args 成员的时间；
 * - 其余记录（usage / finish / 未知类型）与非数组输入一律跳过。
 *
 * 自包含是刻意的：`verify` 会把这段源码从**重建产物**里抠出来单独编译，用 fixture
 * 断言行为（见 CASES），而不是只比 SHA。
 */
const HELPER_SOURCE = [
	'\t\t/**',
	'\t\t* 从紧凑 Assistant 流记录恢复首个输出 token 的时间（本补丁注入）。',
	'\t\t* 已结束的步骤不再有实时 chunk 事件，只有 assistant/message 自带的 stream，',
	'\t\t* 因此这里按 dsh-llm assistantStreamFirstTokenTime 的语义兜底恢复。',
	'\t\t* @param stream - durable Assistant settlement 的紧凑记录数组。',
	'\t\t* @returns 首个 token 的时间戳，或 undefined。',
	'\t\t*/',
	'\t\tfunction dshPatchedFirstTokenTime(stream) {',
	'\t\t\tif (!Array.isArray(stream)) return void 0;',
	'\t\t\tconst isToken = (chunk) => {',
	'\t\t\t\tif (chunk === null || typeof chunk !== "object") return false;',
	'\t\t\t\tswitch (chunk.type) {',
	'\t\t\t\t\tcase "text-delta":',
	'\t\t\t\t\tcase "reasoning-delta": return typeof chunk.text === "string" && chunk.text !== "";',
	'\t\t\t\t\tcase "tool-call-delta": return typeof chunk.argumentsDelta === "string" && chunk.argumentsDelta !== "" || chunk.name !== void 0;',
	'\t\t\t\t\tdefault: return false;',
	'\t\t\t\t}',
	'\t\t\t};',
	'\t\t\tfor (const record of stream) {',
	'\t\t\t\tif (record === null || typeof record !== "object") continue;',
	'\t\t\t\tif (record.type === "chunk") {',
	'\t\t\t\t\tif (Number.isFinite(record.time) && isToken(record.chunk)) return record.time;',
	'\t\t\t\t\tcontinue;',
	'\t\t\t\t}',
	'\t\t\t\tif (record.type !== "text-chunks" && record.type !== "reasoning-chunks" && record.type !== "tool-call-chunks") continue;',
	'\t\t\t\tconst fragments = record.type === "tool-call-chunks" ? record.args : record.texts;',
	'\t\t\t\tif (!Array.isArray(fragments) || !Array.isArray(record.dt) || !Number.isFinite(record.time0)) continue;',
	'\t\t\t\tif (record.type === "tool-call-chunks" && record.name !== void 0) return record.time0;',
	'\t\t\t\tlet time = record.time0;',
	'\t\t\t\tfor (let index = 0; index < fragments.length; index += 1) {',
	'\t\t\t\t\tif (index > 0) time += record.dt[index - 1];',
	'\t\t\t\t\tif (!Number.isFinite(time)) break;',
	'\t\t\t\t\tif (fragments[index] !== "") return time;',
	'\t\t\t\t}',
	'\t\t\t}',
	'\t\t}',
].join('\n')

// ---------------------------------------------------------------------------
// 编辑规则。锚点是编译产物里的**代码片段原文**，必须全文件唯一（命中数 ≠ 1 即报错，
// 宁可失败也不瞎改）。两条编辑各自独立可诊断：
//   1) 注入恢复函数（锚在产物里已有的 isTokenDelta 定义前，同处模块作用域）；
//   2) 轨迹节点 timing 加回退（实时值优先，其次紧凑 stream，最后才是 null）。
// ---------------------------------------------------------------------------
const EDITS = [
	{
		id: 'inject-first-token-restore',
		mode: 'replaceSubstring',
		anchor: 'function isTokenDelta(chunk) {',
		replacement: `${HELPER_SOURCE}\n\t\tfunction isTokenDelta(chunk) {`,
	},
	{
		id: 'timing-first-token-fallback',
		mode: 'replaceSubstring',
		anchor: 'firstTokenTime: state.firstTokenTime ?? null,',
		replacement: 'firstTokenTime: state.firstTokenTime ?? dshPatchedFirstTokenTime(event.data.stream) ?? null,',
	},
]

/**
 * verify 用的行为样例。期望值按 dsh-llm 的 runFirstTokenTime / isTokenDelta 语义手算：
 * text-chunks 的成员时间是 time0 + dt 前缀和，首个**非空**成员才算 token。
 */
const CASES = [
	{
		name: 'chunk 记录：跳过 block-start 与空 delta，取首个非空 text-delta 的时间',
		stream: [
			{ type: 'chunk', time: 1000, chunk: { type: 'block-start', blockType: 'text', index: 0 } },
			{ type: 'chunk', time: 1200, chunk: { type: 'text-delta', text: '', index: 0 } },
			{ type: 'chunk', time: 1350, chunk: { type: 'text-delta', text: '你', index: 0 } },
			{ type: 'chunk', time: 1400, chunk: { type: 'text-delta', text: '好', index: 0 } },
		],
		expected: 1350,
	},
	{
		name: 'reasoning-chunks：首个非空成员 = time0 + dt 前缀和',
		stream: [{ type: 'reasoning-chunks', time0: 2000, index: 0, dt: [10, 20], texts: ['', '', '嗯'] }],
		expected: 2030,
	},
	{
		name: 'tool-call-chunks 带 name：整段从 time0 起算（官方 runFirstTokenTime 语义）',
		stream: [{ type: 'tool-call-chunks', time0: 3000, index: 1, dt: [5], id: 'call_1', name: 'read_file', args: ['', '{"path"'] }],
		expected: 3000,
	},
	{
		name: 'tool-call-chunks 无 name：取首个非空 args 成员',
		stream: [{ type: 'tool-call-chunks', time0: 4000, index: 1, dt: [7], id: 'call_2', args: ['', '{}'] }],
		expected: 4007,
	},
	{
		name: 'tool-call-delta chunk：argumentsDelta 非空即算 token',
		stream: [
			{ type: 'chunk', time: 5000, chunk: { type: 'block-start', blockType: 'tool-call', index: 0 } },
			{ type: 'chunk', time: 5125, chunk: { type: 'tool-call-delta', index: 0, argumentsDelta: '{"a":1}' } },
		],
		expected: 5125,
	},
	{
		name: '只有 usage / finish：无 token → undefined（保持「不可用」而不是编造时间）',
		stream: [
			{ type: 'chunk', time: 6000, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } },
			{ type: 'chunk', time: 6100, chunk: { type: 'finish', reason: 'stop' } },
		],
		expected: undefined,
	},
	{
		name: '非数组 / 空 / 畸形记录：undefined 或安全跳过，不抛错',
		stream: [null, { type: 'text-chunks', time0: 7000, dt: [1], texts: ['x'] }, { type: 'unknown-records', texts: ['x'] }],
		expected: 7000,
	},
	{
		name: 'undefined 输入：undefined',
		stream: undefined,
		expected: undefined,
	},
]

/** 在 source 中定位唯一锚点并替换；不唯一或不存在即报错（宁可失败，也不瞎改）。 */
export function applyPatch(source) {
	if (source.includes(PATCH_MARKER)) throw new Error('该文件已包含补丁标记，拒绝重复应用')
	let output = source
	for (const edit of EDITS) {
		const hits = output.split(edit.anchor).length - 1
		if (hits !== 1) throw new Error(`${edit.id}: 锚点必须唯一，实际命中 ${hits} 次`)
		output = output.split(edit.anchor).join(edit.replacement)
	}
	return output
}

/** 判定一份 bundle 的状态：original / patched / unknown。 */
export function classify(text) {
	const sha = createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()
	if (sha === ORIGINAL_SHA256) return { state: 'original', sha }
	if (text.includes(PATCH_MARKER)) return { state: 'patched', sha }
	return { state: 'unknown', sha }
}

/** 从产物里抠出一个具名函数的源码（花括号配平；补丁注入的函数不含含花括号的字符串字面量）。 */
export function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}(`)
	if (start < 0) throw new Error(`产物中未找到函数 ${name}`)
	const open = source.indexOf('{', start)
	if (open < 0) throw new Error(`${name}: 缺少函数体`)
	let depth = 0
	for (let index = open; index < source.length; index += 1) {
		const char = source[index]
		if (char === '{') depth += 1
		else if (char === '}') {
			depth -= 1
			if (depth === 0) return source.slice(start, index + 1)
		}
	}
	throw new Error(`${name}: 花括号不配平`)
}

/** 用产物里的真实源码跑 CASES，证明恢复逻辑而不只是证明字节一致。 */
function assertBehavior(source) {
	const extracted = extractFunction(source, 'dshPatchedFirstTokenTime')
	const factory = new Function(`${extracted}\nreturn dshPatchedFirstTokenTime`)
	const restore = factory()
	let failed = 0
	for (const testCase of CASES) {
		let actual
		try {
			actual = restore(testCase.stream)
		} catch (error) {
			console.error(`  ✗ ${testCase.name} → 抛错 ${error instanceof Error ? error.message : String(error)}`)
			failed += 1
			continue
		}
		if (actual !== testCase.expected) {
			console.error(`  ✗ ${testCase.name} → 期望 ${testCase.expected}，实际 ${actual}`)
			failed += 1
		}
	}
	if (failed > 0) throw new Error(`恢复逻辑行为断言失败 ${failed}/${CASES.length} 条`)
	console.log(`[patch] PASS 恢复逻辑行为断言 ${CASES.length}/${CASES.length} 条（用重建产物里的真实函数）`)
}

/**
 * 重建产物必须是可解析的 ESM —— 本补丁注入的是代码而不是 CSS，语法破了必须响亮失败。
 * 写到系统临时目录再 `node --check`；临时目录不可写时只 WARN（离线自证不该因此挂掉）。
 */
async function assertParses(source) {
	const file = join(tmpdir(), `dsh-trajectory-patch-check-${process.pid}.mjs`)
	try {
		await writeFile(file, source, 'utf8')
	} catch (error) {
		console.log(`[patch] WARN 跳过语法校验（临时目录不可写：${error instanceof Error ? error.message : String(error)}）`)
		return
	}
	try {
		// stdio: 'ignore' 是刻意的：受限沙箱下捕获子进程管道会 EPERM，而这里只看退出码。
		const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
		if (result.error !== undefined) throw new Error(`无法启动 node --check：${result.error.message}`)
		if (result.status !== 0) throw new Error(`node --check 退出码 ${result.status}`)
		console.log('[patch] PASS 重建产物的 ESM 语法校验通过（node --check）')
	} finally {
		await rm(file, { force: true })
	}
}

/** 定位已安装的 client.js：环境变量 → npm 全局目录 → 常见 POSIX 路径。 */
function defaultTarget() {
	const candidates = []
	if (process.env.MIASAKI_DSH_TRAJECTORY_BUNDLE) candidates.push(process.env.MIASAKI_DSH_TRAJECTORY_BUNDLE)
	const rel = join('@deepseek-ai', 'dsh', 'node_modules', TARGET_PACKAGE, 'lib', 'client.js')
	if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', rel))
	candidates.push(join('/usr/local/lib/node_modules', rel))
	return candidates.find(candidate => existsSync(candidate)) ?? null
}

function parseArgs(argv) {
	const args = { mode: argv[0] ?? 'status', yes: false, target: null }
	for (let i = 1; i < argv.length; i += 1) {
		if (argv[i] === '--yes') args.yes = true
		else if (argv[i] === '--target') { args.target = argv[i + 1] ?? null; i += 1 }
	}
	return args
}

/** verify：baseline 原始文件 → 重建 → 产物 SHA 等于记录值，且恢复逻辑通过行为断言。 */
async function cmdVerify() {
	const original = await readFile(ORIGINAL_FILE, 'utf8')
	const rebuilt = applyPatch(original)
	const sha = createHash('sha256').update(rebuilt, 'utf8').digest('hex').toUpperCase()
	await assertParses(rebuilt)
	assertBehavior(rebuilt)
	if (sha !== PATCHED_SHA256) {
		console.error('[patch] FAIL 由 baseline 重建的产物与记录的 SHA 不一致')
		console.error(`  重建 SHA-256: ${sha}`)
		console.error(`  记录 SHA-256: ${PATCHED_SHA256}`)
		console.error(`  长度 重建=${Buffer.byteLength(rebuilt, 'utf8')}（原始 ${Buffer.byteLength(original, 'utf8')}）`)
		for (const edit of EDITS) {
			const at = rebuilt.indexOf(edit.replacement.slice(0, 48))
			if (at >= 0) console.error(`  ${edit.id} 产物片段: ${rebuilt.slice(at, at + 120)}`)
		}
		process.exitCode = 1
		return
	}
	console.log(`[patch] PASS 由 baseline 原始文件重建出与记录一致的补丁产物（${EDITS.length} 条编辑，SHA-256 ${sha.slice(0, 16)}…）`)
}

async function cmdStatus(args) {
	const target = args.target ?? defaultTarget()
	if (target === null) {
		console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_TRAJECTORY_BUNDLE）')
		process.exitCode = 2
		return
	}
	const text = await readFile(target, 'utf8')
	const { state, sha } = classify(text)
	const backup = `${target}.dsh-bak`
	console.log(`[patch] 目标   ${target}`)
	console.log(`[patch] 状态   ${state}  (SHA-256 ${sha.slice(0, 16)}…)`)
	console.log(`[patch] 备份   ${existsSync(backup) ? backup : '（无）'}`)
	if (state === 'unknown') {
		console.log(`[patch] 提示   该文件既非 ${BASELINE_DSH_VERSION} 原版也非补丁版——DSH 很可能已升级，需先核对锚点再适配`)
	}
}

async function cmdApply(args) {
	const target = args.target ?? defaultTarget()
	if (target === null) {
		console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_TRAJECTORY_BUNDLE）')
		process.exitCode = 2
		return
	}
	const text = await readFile(target, 'utf8')
	const { state } = classify(text)
	if (state === 'patched') {
		console.log('[patch] 已应用，跳过（幂等）')
		return
	}
	if (state === 'unknown' && !args.yes) {
		console.error('[patch] 目标文件不是已知的原始版本，可能已被其他改动或 DSH 升级过；确认无误后加 --yes 强制应用')
		process.exitCode = 2
		return
	}
	const patched = applyPatch(text)
	const backup = `${target}.dsh-bak`
	if (!existsSync(backup)) await copyFile(target, backup)
	await writeFile(target, patched, 'utf8')
	const sha = createHash('sha256').update(patched, 'utf8').digest('hex').toUpperCase()
	console.log(`[patch] 已应用 → ${target}`)
	console.log(`[patch] 备份   ${backup}`)
	console.log(`[patch] 结果   ${Buffer.byteLength(patched, 'utf8')} 字节，SHA-256 ${sha.slice(0, 16)}…${sha === PATCHED_SHA256 ? '（与记录一致）' : ''}`)
	console.log('[patch] 提示   浏览器侧生效需刷新页面；轨迹页与消息气泡的计时面板随后可从日志恢复首 token 时间')
}

async function cmdRevert(args) {
	const target = args.target ?? defaultTarget()
	if (target === null) {
		console.error('[patch] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_TRAJECTORY_BUNDLE）')
		process.exitCode = 2
		return
	}
	const backup = `${target}.dsh-bak`
	if (!existsSync(backup)) {
		console.error(`[patch] 没有备份可还原：${backup}`)
		process.exitCode = 2
		return
	}
	await copyFile(backup, target)
	console.log(`[patch] 已还原 ${target} ← ${backup}`)
}

// 仅在直接执行时跑 CLI（被 import 时不执行）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = parseArgs(process.argv.slice(2))
	const commands = { verify: cmdVerify, status: cmdStatus, apply: cmdApply, revert: cmdRevert }
	const command = commands[args.mode]
	if (command === undefined) {
		console.error(`[patch] 未知模式：${args.mode}（可选 verify / status / apply / revert）`)
		process.exitCode = 2
	} else {
		// 锚点缺失/不唯一时给出可读结论，而不是抛裸栈——这是 DSH 升级后最可能的失败点。
		try {
			await command(args)
		} catch (error) {
			console.error(`[patch] 失败：${error instanceof Error ? error.message : String(error)}`)
			console.error('[patch] 提示：锚点失效通常意味着 DSH 已升级；请按 README「升级后怎么办」核对锚点并更新 EDITS 与 baseline。')
			process.exitCode = 1
		}
	}
}
