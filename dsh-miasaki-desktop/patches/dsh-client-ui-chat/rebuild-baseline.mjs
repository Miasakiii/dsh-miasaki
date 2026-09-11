#!/usr/bin/env node
// rebuild-baseline.mjs — DSH 升级后重建本补丁的 baseline。
//
// 用法：
//   node rebuild-baseline.mjs [--target <client.js 路径>]
//
// 什么时候用：`node patch.mjs status` 报 `unknown`（DSH 升级覆盖了补丁），且
// `node patch.mjs verify` 因基线不匹配而失败时。它把**当前已安装的 client.js**
// （升级后的官方原版）作为新基线，用 patch.mjs 的 applyPatch 纯函数试跑一次重建，
// 覆盖 baseline/client.original.js，并打印需要同步进 patch.mjs 的常量。
//
// 与 settings-models 补丁的差别：本补丁**不存 patched 全文**（目标 361KB，再存一份
// 不划算），因此这里只写 original，产物以 SHA 常量形式记录 —— verify 用「重建后的 SHA
// 是否等于常量」自证，与逐字节比对等价。
//
// 前提：两条锚点在新版中仍唯一命中 —— `function isTokenDelta(chunk) {`（注入点）与
// `firstTokenTime: state.firstTokenTime ?? null,`（timing 回退点）。applyPatch 在锚点
// 缺失或多重命中时抛错，**不会瞎改** —— 抛错就说明 EDITS 需要人工适配（见 README）。
//
// 注意：本脚本只写 baseline/，**不改 patch.mjs 的常量**。三个值请按输出手动更新
// （刻意如此：改常量是有语义的决策，不该由脚本代劳）。
import { existsSync } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// patch.mjs 的 CLI 有 `import.meta.url === process.argv[1]` 守卫，import 不会执行它。
import { applyPatch, TARGET_PACKAGE } from './patch.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')
const ORIGINAL_FILE = join(BASELINE, 'client.original.js')

/** 与 patch.mjs 的 defaultTarget 保持同一套候选顺序。 */
function defaultTarget() {
	const rel = join('@deepseek-ai', 'dsh', 'node_modules', TARGET_PACKAGE, 'lib', 'client.js')
	const candidates = []
	if (process.env.MIASAKI_DSH_CHAT_BUNDLE) candidates.push(process.env.MIASAKI_DSH_CHAT_BUNDLE)
	if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', rel))
	candidates.push(join('/usr/local/lib/node_modules', rel))
	return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** 从安装路径向上找出 dsh 包自身的版本号（路径嵌套层数随包管理器而异）。 */
async function findDshVersion(start) {
	let dir = start
	for (let depth = 0; depth < 8; depth += 1) {
		dir = dirname(dir)
		const pkgPath = join(dir, 'package.json')
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
				if (pkg.name === '@deepseek-ai/dsh') return pkg.version
			} catch { /* 继续向上找 */ }
		}
	}
	return null
}

const argv = process.argv.slice(2)
const targetFlag = argv.indexOf('--target')
const target = targetFlag >= 0 ? argv[targetFlag + 1] : defaultTarget()
if (target === undefined || target === null || !existsSync(target)) {
	console.error('[baseline] 未找到已安装的 client.js（用 --target 指定，或设 MIASAKI_DSH_CHAT_BUNDLE）')
	process.exit(2)
}

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex').toUpperCase()

const source = await readFile(target, 'utf8')
console.log(`[baseline] 源文件 ${target}`)
console.log(`[baseline] 字节   ${Buffer.byteLength(source, 'utf8')}`)

// 先重建；失败会指明是哪条编辑、哪个锚点不匹配。产物只用于算 SHA，不落盘。
let rebuilt
try {
	rebuilt = applyPatch(source)
} catch (error) {
	console.error(`[baseline] 重建失败：${error instanceof Error ? error.message : String(error)}`)
	console.error('[baseline] 提示：锚点漂移需人工适配 EDITS，见 README「DSH 升级后怎么办」')
	process.exit(1)
}

await copyFile(target, ORIGINAL_FILE)

const version = await findDshVersion(target)
console.log(`[baseline] 已重建 baseline/client.original.js（${Buffer.byteLength(source, 'utf8')} B）`)
console.log(`[baseline] 补丁产物按 SHA 记录，不落盘（${Buffer.byteLength(rebuilt, 'utf8')} B）`)
console.log('')
console.log('[baseline] 请把下面三个值同步进 patch.mjs：')
console.log(`  BASELINE_DSH_VERSION = '${version ?? '<未能从安装目录读出，请手动填写>'}'`)
console.log(`  ORIGINAL_SHA256 = '${sha(source)}'`)
console.log(`  PATCHED_SHA256  = '${sha(rebuilt)}'`)
console.log('')
console.log('[baseline] 然后跑 node patch.mjs verify 自证，再 node patch.mjs apply 重打。')
