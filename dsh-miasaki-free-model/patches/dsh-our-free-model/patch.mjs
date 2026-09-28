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
 * ## 改动面（五处锚点，全部唯一命中才动手）
 *
 *   nav-label               左栏名字 `t('nav')` → 「免费模型」
 *   drop-news-section       删掉「公告中心」分区那一行
 *   drop-onboarding         删掉首启公告弹窗（`settings.onboarding` 整块注册）
 *   inject-panel-component  注入 `PlatformScanPanel` 组件（`inject/platform-panel.js`）
 *   inject-platform-section 在模型清单之后挂上「本机自配平台」分区
 *
 * 不改它的任何内部逻辑、不动它的 i18n 字典（新分区文案用中文字面量）、
 * 不留任何新文件（纯文本改写，所以 `revert` 能整文件还原）。
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

/** 模型清单那一行 —— 新分区挂在它后面，这样"免 Key 车道"与"本机自配平台"挨着。 */
const MODELS_SECTION = "        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t: tagged, onBench: bench, benches })),\n";

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
        console.log('\n  重启宿主（或热重载该插件）后生效；设置左栏应只剩一栏「免费模型」，且不再有公告。');
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
