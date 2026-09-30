/**
 * dsh-token-monitor — 插件数据目录的**身份**（I1 闸门，2026-09-30）。
 *
 * ## 为什么要单独成模块
 *
 * 目录名是**数据身份**而不是包身份：2026-09-29 包名由 `dsh-token-monitor` 改为
 * `@miasaki/dsh-token-monitor`（对外分发需要 scope），如果目录名跟着改，既有账本
 * 等于「搬家」—— 用户会看到统计凭空清零（改动时账本实况：desktop 1.8MB /
 * miasaki 4.1MB / web 25KB）。另一层现实原因：`@miasaki/dsh-token-monitor` 含 `/`，
 * 直接 `path.join` 会被当成两级子目录。
 *
 * 这条纪律此前**只有注释、没有闸门**（回归矩阵台账 I1 原话：「2026-09-29 已用
 * `LEDGER_DIR_NAME` 解耦但**无闸门**」）—— 属于「静默失效第 17 位」：一次顺手统一
 * 命名就会让全量历史统计清零，且不报任何错。抽成单点后可被
 * `test/ledger-dir.test.mjs` 钉住两件事：
 *   ① 目录名**冻结为历史值**（改名即失败 —— 改名意味着历史账本失联）；
 *   ② 本模块**不读包名**，目录身份与包身份之间没有任何派生关系。
 *
 * @module dsh-token-monitor/ledger-dir
 */

import os from 'node:os';
import path from 'node:path';

/**
 * 账本目录名 —— **刻意不跟随插件名**（2026-09-29 解耦，2026-09-30 加闸门）。
 *
 * 改这个字符串 = 所有既有账本对新版本不可见（历史统计从零开始）。
 */
export const LEDGER_DIR_NAME = 'dsh-token-monitor';

/**
 * 插件数据目录：优先宿主提供的服务，否则 `~/.dsh/plugins-data/<LEDGER_DIR_NAME>/`。
 *
 * 探测顺序 `pluginData` → `dataDir` → `storage`（宿主版本差异），三种形态都认：
 * 字符串（直接当根）/ `{resolve(name)}` / `{dir}`。
 * 任一探测抛错 ⇒ 回退默认路径（不因宿主服务异常而丢掉账本）。
 *
 * @param ctx 宿主上下文（用 `ctx.get(name)` 取服务）；测试可传等价 stub
 * @returns 账本根目录（**不含** profile 分区，分区由调用方拼）
 */
export function resolveDataDir(ctx) {
	try {
		for (const k of ['pluginData', 'dataDir', 'storage']) {
			const v = ctx.get(k);
			if (typeof v === 'string' && v) return path.join(v, LEDGER_DIR_NAME);
			if (v && typeof v === 'object') {
				if (typeof v.resolve === 'function') {
					const r = v.resolve(LEDGER_DIR_NAME);
					if (typeof r === 'string' && r) return r;
				}
				if (typeof v.dir === 'string' && v.dir) return path.join(v.dir, LEDGER_DIR_NAME);
			}
		}
	} catch (e) { /* 探测失败走默认 */ }
	return path.join(os.homedir(), '.dsh', 'plugins-data', LEDGER_DIR_NAME);
}

/** profile 分区键的来源（随下发数据给页面，供它如实标注口径）。 */
export const PROFILE_SOURCES = Object.freeze(['profileContext', 'env', 'unknown']);

/**
 * 解析 profile 分区键 —— **账本口径的隔离键**（2026-09-26「统计要干净」）：
 * 官方桌面端（`desktop`）、自制壳（`miasaki`）、浏览器 GUI（`web`）各记各的账。
 *
 * 来源三档：宿主 `profileContext` 服务（`profile-boot` 提供，字段 `name`）→
 * 进程环境变量 `DSH_PROFILE`（launcher 注入）→ **兜底**。
 *
 * 兜底那一档刻意**不假装**是某个真实 profile：目录仍落 `default`（既有账本不能丢），
 * 但 `source` 如实标 `'unknown'`。理由是那个桶的性质 —— 宿主既没给 profileContext、
 * 环境也没有 DSH_PROFILE 时，**多个不同环境会写进同一个桶**（它是共享兜底区，不是隔离区）。
 * 此前本函数返回裸字符串 `'default'`，于是页面照常显示「本页只统计当前 profile（default）·
 * 与其它 profile 的账本完全隔离」—— **用户以为干净，实际可能混账**（静默失效 #18）。
 * 现在页面据 `source` 分支：unknown 时明确写「未识别 profile，可能与其它环境混账」。
 *
 * @param ctx 宿主上下文
 * @param env 环境变量表（测试可注入；默认 `process.env`）
 * @returns `{ name, source }`，`source ∈ PROFILE_SOURCES`
 */
export function resolveProfileKey(ctx, env = process.env) {
	try {
		const pc = ctx.get('profileContext');
		if (pc && typeof pc.name === 'string' && pc.name.trim()) {
			return { name: pc.name.trim(), source: 'profileContext' };
		}
	} catch (e) { /* 服务缺席：走环境变量 */ }
	const raw = env ? env.DSH_PROFILE : undefined;
	if (typeof raw === 'string' && raw.trim()) return { name: raw.trim(), source: 'env' };
	return { name: 'default', source: 'unknown' };
}

/**
 * profile 名净化成目录名：只留字母数字与 `._-`，其余换 `_`，空则 `default`。
 *
 * 净化是**安全边界**而非美化：profile 名来自环境变量，未净化时 `../` 之类会逃出账本根目录。
 */
export function safeProfileDir(profile) {
	return String(profile || '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';
}
