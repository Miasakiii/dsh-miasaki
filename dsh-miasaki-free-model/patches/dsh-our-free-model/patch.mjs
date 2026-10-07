#!/usr/bin/env node
/**
 * dsh-our-free-model 增量补丁 —— 把「免费模型」线的扫描能力接进上游插件的设置页。
 *
 * ## 为什么是补丁而不是改它的仓库
 *
 * 用户的三条诉求：设置里**只要一个页面**、要**长在 Our Free Model 那张页面上**、
 * 视觉要与它一致。而上游插件的设置页是**整页自绘**的（六个 `<Section>` 写死在
 * `SettingsPage` 的返回值里），官方 slot 机制只允许别的插件注册**自己的** section，
 * 没有往别人 section 里插内容的通道。所以只有"在它身上做增量"这一条路。
 *
 * 同时不改它的源仓库（那是人家的项目），只改**本机安装副本**，并把这套改写固化成
 * 可重放、可自检、可回退的补丁 —— 因为它的**应用内升级会覆盖清单内文件**
 * （`src/updater.js` 的 `installStaged`：写清单内文件 + 删除清单外文件），
 * 所以每次升级后都要重打，`status` 一眼可见当前处于哪种状态。
 *
 * ## 改动面（十二处锚点，全部唯一命中才动手）
 *
 * 【一】界面收敛（2026-09-28，用户点名「只要一个页面、且没有公告」）
 *
 *   nav-label                       左栏名字 `t('nav')` → 「免费模型」
 *   drop-news-section               删掉「公告中心」分区那一行
 *   drop-onboarding                 删掉首启公告弹窗（`settings.onboarding` 整块注册）
 *   inject-panel-component          注入 `PlatformScanPanel` 组件（`inject/platform-panel.js`）
 *   inject-platform-section         在模型清单之后挂上「本机自配平台」分区
 *
 * 【二】静默化（2026-10-07，用户点名「去掉右下角弹窗公告，以后有更新在设置页提醒」）
 *
 *   silence-announcement-push       公告推送：右下角 toast / 紧急模态 / 系统通知**三条一起关**
 *   silence-update-push             「插件可升级」的 toast 与系统通知
 *   silence-reload-notice           热重载 / 升级后的右下角提示（整块 effect）
 *   inject-update-notice-component  注入 `UpdateNotice` 组件（`inject/update-notice.js`）
 *   inject-update-notice-bar        把提醒条挂在页首（hero 之后、模型清单之前）
 *
 * 【三】标题层级（2026-10-07，用户点名「分区标题与内容一样大一样粗」）
 *
 *   enlarge-section-title           上游分区标题 14px/650 → 16px（字重 650 保留）
 *
 *   上游的分区标题（`.ofm_sec_title`，14px/650）与卡片名（`.ofm_cardname`，13.5px/650）
 *   **几乎同级** ⇒ 「模型清单 / 本机自配平台 / 升级」这些分区与分区内的模型卡看不出层级。
 *   只提字号、保留上游的字重（650）与配色，改动面一行、可整行还原。
 *   **这一处刻意破了"本补丁不动上游 CSS"的自我约束**（原决策见 §【一】的 2026-09-28 记录）：
 *   该约束的收益是"少一处升级漂移面"，而漂移本来就会被 `self-test.mjs` 显式打红（不会静默
 *   写坏文件），用户点名的层级问题优先。除这一行外，本补丁仍不碰上游 CSS 与 i18n 字典。
 *
 * 【四】自升级不再被 8 秒超时打断（2026-10-07，用户截图报错后补）
 *
 *   apply-upgrade-long-timeout      升级按钮那次 `post('/update/apply', {})` → `ofmApplyUpgrade()`
 *
 *   现象：点「立即升级」后红框 `signal is aborted without reason`，看起来像按钮坏了。
 *   根因：`api()` 给每个请求套了 8 秒 `AbortController`（上游为防挂起的兜底），而
 *   `/update/apply` 要做「拉 manifest（自身 15s）→ 并发 4 路下载全部文件（每路 30s）→
 *   备份 → 安装 → 热重载」。8 秒必然打断，而**真实失败原因**（host 侧 `updates.json` 记的
 *   `staging failed: vendor/channel-pack/NOTICE.md: fetch failed`，随 500 响应发出）
 *   到达时客户端早已断开 —— 用户永远看不到它。实测那次升级在 host 侧**真的跑了、也真的失败了**。
 *   修法：`inject/update-notice.js` 里的 `ofmApplyUpgrade()`（240 秒超时）原地取代那次调用，
 *   提醒条自己也走同一个函数；失败原因照实透出。**这是修上游的缺陷**，不是我们的功能新增。
 *
 * 不改它的任何内部逻辑、不动它的 i18n 字典（新分区文案用中文字面量）、
 * 不留任何新文件（纯文本改写，所以 `revert` 能整文件还原）。
 *
 * **刻意保留的一处 toast**：设置页里「保存失败」的即时反馈（`t('settings.failed')`）——
 * 那是对用户刚做的动作的应答，不是公告；删了它只会让保存失败变成静默无提示。
 * 因此 `showToast` 机制本身留着，被关掉的是"主动找上门"的那三个调用点。
 *
 * ## 用法
 *
 *   node patch.mjs status            # 每处锚点：applied / pending / drift
 *   node patch.mjs apply --yes       # 打补丁（先跑 status，drift 会显式失败）
 *   node patch.mjs verify            # 全部 applied 才算过（进 verify-all 闸门）
 *   node patch.mjs revert --yes      # 从 .ofm-patchbak 整文件还原
 *   node self-test.mjs               # 离线自证：在临时副本上验证锚点仍可应用
 *
 * 目标文件默认 `~/.dsh/local-plugins/dsh-our-free-model/client.js`，
 * 可用环境变量 `OFM_CLIENT` 覆盖（自证脚本就靠它）。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(join(HERE, 'inject', 'platform-panel.js'), 'utf8').replace(/\n+$/, '');
const NOTICE = readFileSync(join(HERE, 'inject', 'update-notice.js'), 'utf8').replace(/\n+$/, '');

/** 模型清单那一行 —— 新分区挂在它后面，这样"免 Key 车道"与"本机自配平台"挨着。 */
const MODELS_SECTION = "        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t: tagged, onBench: bench, benches })),\n";

// ── 被静默化的三段上游代码（逐字取自上游 `client.js`，2026-10-07）─────────────────
//
// 为什么逐字而不是正则：改的是人家的文件，锚点必须"要么精确命中一次、要么显式失败"。
// 正则改写会在上游微调时静默匹配到别处 —— 那正是补丁最不该有的失败形态。
// 段落里的缩进与换行都是原样，改动任一处都会让 `status` 报 drift（而非默默写坏文件）。

/** 公告推送（`announcements` SSE）：右下角 toast / 紧急模态 / 系统通知三合一的那一块。 */
const ANNOUNCEMENT_PUSH = [
  "            for (const item of data.items ?? []) {",
  "              osNotify(t('toast.annTitle'), item.title)",
  "              if (item.level === 'urgent') {",
  "                showUrgentModal({",
  "                  title: `${t('news.urgentTitle')} · ${item.title}`,",
  "                  html: item.html ?? '',",
  "                  confirmLabel: t('news.gotIt'),",
  // guard-ok: 上游代码逐字拷贝 —— 这是「要被删掉的那段」的锚点数据，不是本仓的降级逻辑
  "                  onClose: () => { void post('/announcements/ack', { id: item.id }).catch(() => {}) },",
  "                })",
  "              } else {",
  "                showToast({ title: t('toast.annTitle'), body: item.title, tone: item.level === 'warn' ? 'warn' : undefined })",
  "              }",
  "            }",
  '',
].join('\n');

/** 替换文本：删掉通告块，只留一句补丁说明（下一行的事件广播照旧）。 */
const ANNOUNCEMENT_SILENCED = [
  "            // 【补丁 · @miasaki/dsh-free-model】公告不再弹窗：右下角 toast / 紧急模态 /",
  "            // 系统通知三条通道一并关闭（2026-10-07 用户点名），只留给下一行的事件广播。",
  '',
].join('\n');

/** 「插件可升级」推送：右下角 toast + 系统通知。 */
const UPDATE_PUSH = [
  "            osNotify(t('toast.updateTitle'), t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''))",
  "            showToast({",
  "              title: t('toast.updateTitle'),",
  "              body: t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''),",
  "              tone: 'warn', holdMs: 14000,",
  "            })",
  '',
].join('\n');

/** 替换文本：提醒改在设置页顶部（`UpdateNotice`），这里只留事件广播。 */
const UPDATE_SILENCED = [
  "            // 【补丁 · @miasaki/dsh-free-model】插件可升级不再弹右下角 toast 与系统通知：",
  "            // 提醒改在「免费模型」设置页顶部（UpdateNotice），这里只留给下一行的事件广播。",
  '',
].join('\n');

/** 热重载 / 升级后的右下角提示 —— 整个 effect 的唯一产物就是那个 toast，故整块移除。 */
const RELOAD_NOTICE = [
  "      // A hot reload or in-app upgrade swaps this bundle while the page stays",
  "      // open. The only durable marker across that swap is localStorage, so the",
  "      // successor announces what happened exactly once.",
  "      ctx.effect(() => {",
  "        void (async () => {",
  "          try {",
  "            const meta = await api('/meta')",
  "            const at = Number(meta?.reloadedAt ?? 0)",
  "            if (at <= 0) return",
  "            let seen = ''",
  // 以下四处 `guard-ok` 同 ANNOUNCEMENT_PUSH：都是锚点数据（上游原文），不是本仓的吞错逻辑。
  // guard-ok: 锚点数据 —— 要整块删掉的那段上游代码
  "            try { seen = window.localStorage?.getItem('ofm.reloadedAt') ?? '' } catch { /* storage unavailable */ }",
  "            if (String(at) === seen) return",
  // guard-ok: 锚点数据 —— 要整块删掉的那段上游代码
  "            try { window.localStorage?.setItem('ofm.reloadedAt', String(at)) } catch { /* ignore */ }",
  "            showToast({",
  "              title: meta.version !== '' ? `Our Free Model ${meta.version}` : 'Our Free Model',",
  "              body: t('reload.done').replace('{n}', String(meta.reloadCount ?? 0)),",
  // guard-ok: 锚点数据 —— 要整块删掉的那段上游代码
  "              actions: [{ label: t('reload.refresh'), onClick: () => { try { window.location.reload() } catch { /* top-level navigation refused */ } } }],",
  "              holdMs: 12000,",
  "            })",
  // guard-ok: 锚点数据 —— 要整块删掉的那段上游代码
  "          } catch { /* backend absent */ }",
  "        })()",
  "        return () => {}",
  "      }, 'our-free-model: reload notice')",
  '',
].join('\n');

/** 替换文本：`ofm.reloadedAt` 这个 localStorage 键只被这一块读写，整块删掉不留死逻辑。 */
const RELOAD_SILENCED = [
  "      // 【补丁 · @miasaki/dsh-free-model】热重载 / 升级后的右下角提示已关闭：",
  "      // 它唯一的载体就是 showToast，整块移除后不再有「插件重载过」的弹窗。",
  '',
].join('\n');

/** 默认目标：本机安装副本。 */
export function defaultTarget() {
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'local-plugins', 'dsh-our-free-model', 'client.js');
}

export const EDITS = [
  {
    id: 'nav-label',
    kind: 'replace',
    why: '设置左栏名字：Our Free Model → 免费模型',
    from: "        label: () => t('nav'),",
    to: "        label: '免费模型',",
  },
  {
    id: 'drop-news-section',
    kind: 'remove',
    why: '去掉「公告中心」分区（用户点名）',
    from: "        h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t: tagged })),\n",
  },
  {
    id: 'drop-onboarding',
    kind: 'remove',
    why: '去掉首启公告弹窗（settings.onboarding 整块注册）',
    from: [
      "      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({",
      "        name: 'settings.onboarding',",
      "        id: 'our-free-model-announcement',",
      "        order: -50,",
      "        locale: NS,",
      "      }, props => h(AnnouncementGate, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))\n",
    ].join('\n'),
  },
  {
    id: 'inject-panel-component',
    kind: 'insert-before',
    why: '注入「本机自配平台」组件定义',
    from: '    function SettingsPage(props) {',
    to: () => `${PANEL}\n    function SettingsPage(props) {`,
  },
  {
    id: 'inject-platform-section',
    kind: 'insert-after',
    why: '在模型清单之后挂上「本机自配平台」分区',
    from: MODELS_SECTION,
    to: () => `${MODELS_SECTION}        h(Section, { title: '本机自配平台', hint: '扫描 llm-pi-ai.providers 中带 baseURL 的平台：检出免费模型、给出能力画像，可写入配置或设为子代理' }, h(PlatformScanPanel, {})),\n`,
  },
  // ── 【二】静默化（2026-10-07）────────────────────────────────────────────────
  // 目标：插件不再"主动找上门"。公告 / 更新 / 热重载三条推送通道全部关掉，
  // 只保留「设置页里保存失败」那一处对用户动作的即时应答（见文件头 §刻意保留）。
  {
    id: 'silence-announcement-push',
    kind: 'remove',
    why: '公告推送不再弹窗：右下角 toast + 紧急模态 + 系统通知',
    from: ANNOUNCEMENT_PUSH,
    to: ANNOUNCEMENT_SILENCED,
  },
  {
    id: 'silence-update-push',
    kind: 'remove',
    why: '「插件可升级」不再弹右下角 toast 与系统通知（提醒改到设置页）',
    from: UPDATE_PUSH,
    to: UPDATE_SILENCED,
  },
  {
    id: 'silence-reload-notice',
    kind: 'remove',
    why: '热重载 / 升级后的右下角提示整块移除',
    from: RELOAD_NOTICE,
    to: RELOAD_SILENCED,
  },
  {
    id: 'inject-update-notice-component',
    kind: 'insert-before',
    why: '注入「有新版本就在设置页顶部提醒」的组件定义',
    // 锚点是「in-app upgrade」区块标题行，**刻意不选 `function SettingsPage`**：
    // `inject-panel-component` 的判据要求 `PANEL` 与那一行**逐字相邻**，
    // 在这两者之间再插一份源码会把它挤成 pending ⇒ 下次 apply 会重复注入 PlatformScanPanel。
    // 放在升级面板旁边语义也更顺（提醒条与升级面板本就是同一件事的两端）。
    from: '    // ── in-app upgrade ───────────────────────────────────────────────────────',
    to: () => `${NOTICE}\n    // ── in-app upgrade ───────────────────────────────────────────────────────`,
  },
  {
    id: 'inject-update-notice-bar',
    kind: 'insert-before',
    why: '把更新提醒条挂在页首（hero 之后、模型清单之前）',
    from: MODELS_SECTION,
    to: () => `        h(UpdateNotice, {}),\n${MODELS_SECTION}`,
  },
  // ── 【三】标题层级（2026-10-07）──────────────────────────────────────────────
  // 分区标题 14px/650 与卡片名 13.5px/650 几乎同级（用户点名「标题与内容一样大一样粗」）。
  // 只动这一行的字号：字重 650 与 label-primary 都是上游的，保留 ⇒ 观感仍是它自己的设计语言。
  {
    id: 'enlarge-section-title',
    kind: 'replace',
    why: '分区标题提档：14px → 16px（与卡片名 13.5px 拉开层级）',
    from: '.ofm_sec_title{font-size:14px;font-weight:650}',
    to: '.ofm_sec_title{font-size:16px;font-weight:650}',
  },
  // ── 【四】自升级不再被 8 秒超时打断（2026-10-07，用户截图报错）──────────────────
  // 现象：点「立即升级」后红框 `signal is aborted without reason`，看起来像按钮坏了。
  // 根因：`api()` 给每个请求套了 8 秒 `AbortController`，而 `/update/apply` 要
  // 「拉 manifest（自身 15s）→ 并发下载全部文件（每路 30s）→ 备份 → 安装 → 热重载」——
  // 8 秒必然打断；而真实失败原因（host 侧 `updates.json` 记的
  // `staging failed: vendor/channel-pack/NOTICE.md: fetch failed`，随 500 响应发出）
  // 到达时客户端早已断开，**用户永远看不到它**。
  // 修法：`ofmApplyUpgrade()`（定义在 `inject/update-notice.js`，240 秒超时）原地取代
  // 这里那次 `post()` 调用；提醒条自己也走同一个函数。失败原因照实透出。
  {
    id: 'apply-upgrade-long-timeout',
    kind: 'replace',
    why: '升级按钮改走长超时请求（不再被 api() 的 8 秒超时打断）',
    from: "          const result = await post('/update/apply', {})",
    to: '          const result = await ofmApplyUpgrade()',
  },
];

/** 把（可能是函数的）`to` 求值。 */
export function resolveTo(edit) {
  return typeof edit.to === 'function' ? edit.to() : (edit.to ?? '');
}

/** 一处锚点在当前文本里的状态：applied / pending / drift。 */
export function stateOf(text, edit) {
  const to = resolveTo(edit);
  if (edit.kind === 'remove') {
    if (!text.includes(edit.from)) return 'applied';
  } else if (text.includes(to)) {
    return 'applied';
  }
  return text.split(edit.from).length - 1 === 1 ? 'pending' : 'drift';
}

/** 每处锚点的状态（CLI 与自证脚本共用）。 */
export function plan(text) {
  return EDITS.map(edit => ({ edit, state: stateOf(text, edit) }));
}

/** 依次应用所有锚点；drift 直接抛错（绝不写坏文件）。 */
export function applyTo(text) {
  let out = text;
  const done = [];
  for (const { edit, state } of plan(out)) {
    if (state === 'drift') {
      throw new Error(
        `锚点 "${edit.id}" 漂移（既不在场、也非恰好命中一次）—— 上游可能已升级；\n` +
        '  见 patches/dsh-our-free-model/README.md 的「升级后重新对齐」一节。',
      );
    }
    if (state === 'applied') { done.push(`${edit.id}（已应用，跳过）`); continue }
    out = out.replace(edit.from, resolveTo(edit));
    done.push(edit.id);
  }
  return { text: out, done };
}

// ── live 审计契约（`scripts/patch-live-audit.mjs` 消费，2026-09-30 接入）────────
//
// 为什么必须接进来：本补丁改的是**上游插件的本机安装副本**，而上游的**应用内升级会覆盖
// 清单内文件**（见文件头 §为什么是补丁）⇒ 那栏会悄悄退化成上游原样（公告中心与首启
// 弹窗回来了），而本线**不崩不报错、离线自证照常全绿**（`verify` 只证「规则与基线自洽」，
// 不查 live 安装）。这是静默失效第 6 位 —— 矩阵台账 J5 一直写着「常驻闸门」，
// 但**此前只在人记得手跑 `status` 时才存在**。契约与 desktop / dual-model / shared-docs
// 的补丁同款（见 patch-live-audit.mjs 头部「目标契约」）。
//
// 注意：本补丁**没有 DSH 基线** —— 它的基线是上游插件自身的版本，不是 DSH 版本。
// 因此不导出 `BASELINE_DSH_VERSION`，审计侧据此把「未打上」判为**真回归**而非
// 「升级待重打」（playwright 补丁当初的审计盲区正是这个形态）。

/** live 目标目录名（`~/.dsh/local-plugins/<TARGET_PACKAGE>/<TARGET_RELATIVE>`）。 */
export const TARGET_PACKAGE = 'dsh-our-free-model';

/** live 目标文件（相对上面那个目录）。 */
export const TARGET_RELATIVE = 'client.js';

/**
 * 把十一处锚点的状态汇总成 live 审计要的三态。
 * @returns `{ state: 'patched' | 'original' | 'unknown', detail? }`
 */
export function classify(text) {
  const rows = plan(text);
  if (rows.some(row => row.state === 'drift')) {
    return { state: 'unknown', detail: '锚点漂移，上游可能已升级，需重新对齐' };
  }
  if (rows.every(row => row.state === 'applied')) return { state: 'patched' };
  return { state: 'original', detail: '上游原版，补丁未打上' };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isCli = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const TARGET = process.env.OFM_CLIENT ?? defaultTarget();
  const BACKUP = `${TARGET}.ofm-patchbak`;
  const mode = (process.argv[2] ?? 'status').toLowerCase();
  const confirmed = process.argv.includes('--yes');

  if (!existsSync(TARGET)) {
    console.error(`[ofm-patch] 目标文件不存在：${TARGET}`);
    console.error('           上游插件没装在本机的话，这个补丁无事可做。');
    process.exit(2);
  }

  const current = readFileSync(TARGET, 'utf8');

  if (mode === 'status' || mode === 'verify') {
    const rows = plan(current);
    const bad = rows.filter(row => row.state !== 'applied');
    for (const { edit, state } of rows) {
      const flag = state === 'applied' ? '✓' : state === 'pending' ? '·' : '✗';
      console.log(`  ${flag} ${edit.id.padEnd(24)} ${state.padEnd(8)} ${edit.why}`);
    }
    if (mode === 'verify') {
      if (bad.length > 0) {
        console.error(`\n[ofm-patch] verify 失败：${bad.length}/${rows.length} 处未到位（状态见上）。`);
        process.exit(1);
      }
      console.log(`\n[ofm-patch] verify PASS —— ${rows.length} 处锚点全部 applied。`);
    } else {
      console.log(`\n[ofm-patch] 目标：${TARGET}`);
      console.log(`[ofm-patch] ${rows.filter(r => r.state === 'applied').length}/${rows.length} 处已应用。`);
    }
    process.exit(0);
  }

  if (mode === 'apply' || mode === 'revert') {
    if (!confirmed) {
      console.error(`[ofm-patch] ${mode} 会改写本机安装副本：${TARGET}`);
      console.error('           确认后重跑并加 --yes。');
      process.exit(2);
    }
    try {
      if (mode === 'apply') {
        const { text, done } = applyTo(current);
        if (!existsSync(BACKUP)) copyFileSync(TARGET, BACKUP);
        writeFileSync(TARGET, text, 'utf8');
        console.log('[ofm-patch] apply 完成，已备份到 ' + BACKUP);
        for (const line of done) console.log('  · ' + line);
        console.log('\n  重启宿主（或热重载该插件）后生效；设置左栏应只剩一栏「免费模型」，不再有公告，');
        console.log('  右下角不再出现任何弹窗；有插件更新时，只在「免费模型」页顶部出现一条提醒。');
      } else if (existsSync(BACKUP)) {
        // 唯一受支持的回退路径：整文件还原。
        writeFileSync(TARGET, readFileSync(BACKUP, 'utf8'), 'utf8');
        console.log('[ofm-patch] revert 完成：已从备份整文件还原');
        console.log('  · ' + BACKUP);
      } else {
        console.error('[ofm-patch] 找不到备份文件，无法回退：');
        console.error('           ' + BACKUP);
        console.error('           两条正路：① 从上游重装该插件；② 按 README 的改动清单手工撤接入点。');
        console.error('           刻意**不**提供"就地逆向"兜底 —— 那段实现无法保证逐字节还原，');
        console.error('           给出半对的回退比显式失败更糟。');
        process.exit(1);
      }
    } catch (error) {
      console.error('[ofm-patch] ' + (error && error.message ? error.message : error));
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`[ofm-patch] 未知模式 "${mode}"；可用：status / apply / verify / revert`);
  process.exit(2);
}
