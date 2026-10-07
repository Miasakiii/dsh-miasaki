#!/usr/bin/env node
/**
 * 本补丁的**离线自证**：不改真文件、不起子进程，只回答一个问题 ——
 *
 *   「这十一处锚点，在**当前这台机器上的上游版本**里还成立吗？」
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

// 幂等：对**已打过补丁的文本**再跑一次 applyTo，输出必须逐字节不变。
// 为什么值得一条断言：上游升级冲掉补丁之后，"重打"是常规动作，而 `insert-*` 类锚点的
// pending 判据是"`from` 恰好出现一次"—— 若新注入的源码挤进某个 `from` 与它前一个锚点之间，
// 那条锚点会从 applied 掉成 pending，下一次 apply 就会**二次注入**（2026-10-07 真发生过：
// 把新组件插在 `function SettingsPage` 正上方，直接把 `inject-panel-component` 挤掉了）。
let idempotent = false;
let idempotentError = '';
try {
  idempotent = applyTo(text).text === text;
} catch (error) {
  idempotentError = error && error.message ? error.message : String(error);
}

const checks = [
  [`${after.length} 处锚点全部 applied`, notApplied.length === 0, notApplied.map(r => r.edit.id).join(', ')],
  ['重复 apply 幂等（重打不会二次注入）', idempotent, idempotentError],
  // 注入片段**各只允许出现一次**。这条与上面的幂等断言抓的是两种不同形态：
  // 幂等断言看"再打一次变不变"，而这里是"当前文本里到底有几份"——
  // 2026-10-07 实测踩到：改了 `inject/update-notice.js` 的内容 ⇒ 该插入锚点的 `to` 跟着变
  // ⇒ live 上那份**旧版本**判 pending ⇒ 直接 `apply` 会把 `UpdateNotice` 注入**第二份**
  // （重复函数声明：不报错、不崩溃，最难发现的那种）。正确流程是 `revert` 后整份重打。
  ['注入片段各只出现一次（改注入源码后直接重打会二次注入）',
    ['function PlatformScanPanel()', 'function UpdateNotice()', 'async function ofmApplyUpgrade()']
      .every(mark => text.split(mark).length - 1 === 1)],
  ['左栏名字已改为「免费模型」', text.includes("label: '免费模型',")],
  ['注入组件在场', text.includes('function PlatformScanPanel()')],
  ['新分区挂在模型清单之后', text.includes("title: '本机自配平台'")],
  ['「公告中心」分区那一行已消失', !text.includes("h(Section, { title: t('section.news')")],
  ['首启公告注册已消失', !text.includes("ctx.slots.inject('settings.onboarding'")],
  ['i18n 字典未被改动（只删渲染、不删词条）', text.includes("'section.news'") && text.includes("'toast.updateBody'")],
  // ── 静默化（2026-10-07）────────────────────────────────────────────────────
  // 判据一律用"调用点专有的写法"：i18n 字典里仍有 `'toast.annTitle'` 这类键，
  // 所以不能拿键名当证据，要拿 `t('toast.annTitle')` 这种"只有调用点才有"的串。
  ['公告不再弹右下角 toast', !text.includes("t('toast.annTitle')")],
  ['紧急公告不再开全屏模态', !text.includes("t('news.urgentTitle')")],
  ['「插件可升级」不再弹右下角 toast', !text.includes("t('toast.updateTitle')")],
  // 注意 `osNotify(` 连定义行 `function osNotify(title, body)` 也算命中 —— 判据要写成
  // 只有调用点才有的形态：实参来自 `t(...)`。
  ['系统通知调用点已全部消失', !text.includes('osNotify(t(')],
  ['热重载后的右下角提示整块移除', !text.includes('ofm.reloadedAt') && !text.includes("'our-free-model: reload notice'")],
  ['更新提醒条已注入并挂在页首', text.includes('function UpdateNotice()') && text.includes('h(UpdateNotice, {})')],
  // 标题层级（2026-10-07）：分区标题必须高于卡片名（13.5px/650）——原来 14px/650 只差 0.5px，
  // 分区与内容看不出层级（用户点名）。判据写成整条声明：回到 14px 即红。
  ['分区标题已提档到 16px（与卡片名 13.5px 拉开）',
    text.includes('.ofm_sec_title{font-size:16px;font-weight:650}')],
  // 自升级超时（2026-10-07，用户截图报红框 `signal is aborted without reason`）：
  // `api()` 的 8 秒超时对 `/update/apply` 必然不够（manifest 15s + 每路下载 30s + 安装 + 热重载），
  // 而且真实失败原因随 500 到达时客户端已断开 ⇒ 用户只看到一句无信息量的 abort 报错。
  // 判据是"两处调用点都不再走 8 秒超时的 post"，且长超时辅助函数确实在注入片段里。
  ['升级请求不再走 8 秒超时的 post（两处调用点）',
    !text.includes("post('/update/apply', {})") && text.includes('async function ofmApplyUpgrade()')],
  ['升级失败原因透传路径在场（读服务端 error 再抛）',
    text.includes("payload?.error ?? `HTTP ${response.status}`") && text.includes('240000')],
  // 反向判据：设置页里"保存失败"的即时应答必须留着 —— 静默化不该连操作反馈一起吞掉。
  ['设置页保存失败的错误提示仍保留', text.includes("t('settings.failed')")],
  // 注入源码用的是上游 factory 作用域里的名字；上游哪天重命名，这里先红，
  // 而不是等到用户打开设置页看到白屏。
  ['注入组件引用的上游帮助函数都还在',
    ['async function api(', 'const post =', 'const Button =', 'function useAsync(', "const API = '"].every(mark => text.includes(mark))],
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
