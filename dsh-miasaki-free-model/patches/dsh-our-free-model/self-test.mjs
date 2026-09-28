#!/usr/bin/env node
/**
 * 本补丁的**离线自证**：不改真文件、不起子进程，只回答一个问题 ——
 *
 *   「这五处锚点，在**当前这台机器上的上游版本**里还成立吗？」
 *
 * 为什么必须有它：上游插件的应用内升级会覆盖 `client.js`（清单内文件），补丁一定会被
 * 冲掉；而"能不能重打"取决于锚点是否仍然唯一命中。等升级完手工发现，代价是"设置页少了
 * 一整个分区"。把它做成闸门，每次回归都会验一次锚点与当前上游版本是否还对得上。
 *
 * 三种输入状态各有明确处置：
 *   · 全部 applied  → 真文件已带补丁：直接做结构断言；
 *   · 全部 pending  → 真文件是原版（被升级冲掉 / 还没打）：在**临时副本**上跑一遍 apply，
 *                     验证锚点仍可应用，再断言；
 *   · 出现 drift    → **exit 1**：上游改了这几行的写法，照 README 重新对齐锚点。
 *
 * 上游插件不在本机（CI / 别人 clone）时**显式打印跳过**并 exit 0 —— 与仓库里
 * `check-message-sources.mjs` 对 `~/.dsh` 缺席的处置同构。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';

import { applyTo, defaultTarget, plan } from './patch.mjs';

const SOURCE = process.env.OFM_CLIENT ?? defaultTarget();

if (!existsSync(SOURCE)) {
  console.log(`[ofm-patch self-test] 上游插件不在本机，跳过：${SOURCE}`);
  console.log('[ofm-patch self-test] （CI 与别人 clone 的机器上没有 ~/.dsh/local-plugins —— 这是环境性跳过，不是静默通过。）');
  process.exit(0);
}

const original = readFileSync(SOURCE, 'utf8');
const before = plan(original);
const drifted = before.filter(row => row.state === 'drift');

if (drifted.length > 0) {
  console.error('[ofm-patch self-test] ✗ 锚点与当前上游版本不匹配：');
  for (const { edit } of drifted) console.error(`    · ${edit.id}（${edit.why}）`);
  console.error('  照 patches/dsh-our-free-model/README.md 的「升级后重新对齐」一节更新 EDITS 后再跑。');
  process.exit(1);
}

const alreadyApplied = before.every(row => row.state === 'applied');
let text = original;
let how = '真文件已带补丁，直接断言';

if (!alreadyApplied) {
  // 在临时副本上跑一遍 apply —— 这一步验的是"锚点仍然可应用"，也就是"升级后能重打"。
  const dir = mkdtempSync(join(tmpdir(), 'ofm-patch-selftest-'));
  const copy = join(dir, 'client.js');
  try {
    copyFileSync(SOURCE, copy);
    const result = applyTo(readFileSync(copy, 'utf8'));
    writeFileSync(copy, result.text, 'utf8');
    text = result.text;
    how = `真文件是原版 → 在临时副本上 apply 了 ${result.done.length} 处`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const after = plan(text);
const notApplied = after.filter(row => row.state !== 'applied');

const checks = [
  ['五处锚点全部 applied', notApplied.length === 0, notApplied.map(r => r.edit.id).join(', ')],
  ['左栏名字已改为「免费模型」', text.includes("label: '免费模型',")],
  ['注入组件在场', text.includes('function PlatformScanPanel()')],
  ['新分区挂在模型清单之后', text.includes("title: '本机自配平台'")],
  ['「公告中心」分区那一行已消失', !text.includes("h(Section, { title: t('section.news')")],
  ['首启公告注册已消失', !text.includes("ctx.slots.inject('settings.onboarding'")],
  ['i18n 字典未被改动（只删渲染、不删词条）', text.includes("'section.news'")],
];

let ok = checks.every(([, pass]) => pass === true);

// 语法：用 vm 编译（不起子进程，受限沙箱也能跑）。
if (ok) {
  try {
    new Script(text, { filename: 'dsh-our-free-model/client.js' });
  } catch (error) {
    console.error(`[ofm-patch self-test] ✗ 改写后语法不通过：${error && error.message}`);
    ok = false;
  }
}

console.log(`[ofm-patch self-test] 输入：${SOURCE}`);
console.log(`[ofm-patch self-test] ${how}`);
for (const [label, pass, detail] of checks) {
  console.log(`  ${pass === true ? '✓' : '✗'} ${label}${detail ? `（${detail}）` : ''}`);
}
console.log(ok ? '  ✓ 改写后语法通过（vm 编译）' : '');

if (!ok) {
  console.error('\n[ofm-patch self-test] ✗ 失败');
  process.exit(1);
}
console.log(`\n[ofm-patch self-test] PASS —— ${after.length} 处锚点在上游当前版本上成立，补丁可应用。`);
