/**
 * Client bundle 装载契约（第九线）。
 *
 * 迁线与 M2 都改动了 `lib/client.js` 里的关键字符串与注册目标（模块 id、路由前缀、
 * 槽 id 与 key、显式文案），而 `node --check` 只验语法 —— 语法全绿、面板挂不上是
 * 完全可能的。本文件把 bundle 当脚本**真实执行一次**：喂一个 `window.__ModuleLoader__`
 * 捕获器与 React stub，然后驱动 `apply()`（槽注册是同步意图，注入回调立即执行），
 * 断言模块 id、导出面、**唯一的落点**（`settings.section`，条件注册）
 * 以及样式是否真的走了官方主题令牌。
 *
 * 不碰 DSH 运行时、不出网；`.gitattributes` 禁 CRLF，本文件是纯 ASCII + 中文注释。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/** React stub：只有 createElement 会被 factory 顶层用到，其余备而不用。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (factory) => factory(),
  Fragment: Symbol('Fragment'),
};

/**
 * 在 vm 里跑一遍 bundle，返回捕获到的 ModuleLoader 条目与物化后的模块。
 *
 * `upstreamPresent` 模拟上游插件（`dsh-our-free-model`）是否在场 —— 它决定本线
 * 还要不要注册自己的**兜底**设置页（在场时它那一栏就是统一页，本线让位）。
 */
function loadBundle({ upstreamPresent = false } = {}) {
  let captured = null;
  const window = {
    __ModuleLoader__: { load: (entry) => { captured = entry } },
  };
  const context = createContext({
    window,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      if (String(url).includes('/api/our-free-model/meta')) {
        if (upstreamPresent) return { ok: true, json: async () => ({ ok: true }) };
        throw new Error('404：上游插件不在场');
      }
      // 除上游探活之外一律不出网：测试因此是确定性的。
      throw new Error('测试里不出网');
    },
  });
  runInContext(bundle, context);
  assert.notEqual(captured, null, 'client bundle 必须调用 window.__ModuleLoader__.load');
  const module = captured.factory((specifier) => {
    if (specifier === 'react') return reactStub;
    throw new Error(`client bundle 请求了未声明的外部依赖：${specifier}`);
  });
  return { entry: captured, module, window };
}

/** 驱动 apply()，收集注册项与注射目标。 */
async function runApply(options) {
  const { module, window } = loadBundle(options);
  const registered = [];
  const injected = [];
  module.apply({
    slots: {
      register: (options_) => { registered.push(options_) },
      inject: (name, callback) => { injected.push(name); callback() },
    },
    effect: (callback) => { callback(); return () => {} },
  });
  // 条件注册走的是 fetch 的 then/catch（微任务），同步断言会看不到它。
  await new Promise((resolve) => setImmediate(resolve));
  return { registered, injected, window };
}

test('client bundle：以 ModuleLoader 形态装载，模块 id 与包名一致', () => {
  const { entry } = loadBundle();
  assert.equal(entry.id, '@miasaki/dsh-free-model');
});

test('client bundle：导出 apply 与 inject（slots 是唯一硬依赖）', () => {
  const { module } = loadBundle();
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual([...module.inject], ['slots']);
});

test('client bundle：上游不在场 → 注册自己的兜底页（settings.section，id free-model、order 25）', async () => {
  const { registered } = await runApply({ upstreamPresent: false });
  const section = registered.find((entry) => entry.name === 'settings.section');
  assert.notEqual(section, undefined, '上游不在场时必须有兜底入口');
  assert.equal(section.id, 'free-model');
  assert.equal(section.order, 25);
  assert.equal(section.label, '免费模型');
});

test('client bundle：上游在场 → 让位，不注册第二个设置页（一个入口）', async () => {
  const { registered } = await runApply({ upstreamPresent: true });
  assert.equal(registered.some((entry) => entry.name === 'settings.section'), false,
    '上游那一栏就是统一页（补丁已把扫描能力增量进去），本线不该再注册一栏');
  assert.equal(registered.some((entry) => entry.name.startsWith('settings.models.')), false,
    '模型页是官方的地盘，任何情况下都不注册');
});

test('client bundle：绝不往 settings.models.* 注册（2026-09-28 模型页白屏事故的闸门）', async () => {
  // 事故：M2 在 `settings.models.provider-card` 挂过一个"就地扫描"入口，结果官方模型页的
  // **供应商编辑面板一点开就白屏、无法返回** —— 那个 keyed 槽在编辑态也会被 dispatch
  // （官方三处 renderSlot，其中一处就是编辑面板），我们注册的 occupant 跟着进编辑面板，
  // 那条路径上任何一次渲染异常都会让整棵 React 树卸载成白屏。
  // 模型页是官方的地盘：这条闸门钉死"任何情况下都不注册它的槽"。
  for (const upstreamPresent of [false, true]) {
    const { registered, injected } = await runApply({ upstreamPresent });
    const names = [...registered.map((entry) => entry.name), ...injected];
    const trespass = names.filter((name) => name.startsWith('settings.models.'));
    assert.deepEqual(trespass, [], `不得注册模型页的槽：${trespass.join('、')}`);
  }
});

test('client bundle：M2 起不再注册 settings.models.footer（去掉双路回退）', async () => {
  const { registered, injected } = await runApply();
  assert.equal(injected.includes('settings.models.footer'), false);
  assert.equal(registered.some((entry) => entry.name === 'settings.models.footer'), false,
    '三区面板是完整一页，不该再塞在模型页底部');
});

test('client bundle：幂等守卫用新名字，且已无迁线前的旧命名残留', async () => {
  const { window } = await runApply();
  assert.equal(window.__DSH_FREEMODEL_BOOTED__, true);
  assert.equal(bundle.includes('freepool'), false, '不应再有 freepool 前缀');
  assert.equal(bundle.includes('dsh-free-model-pool'), false, '不应再有旧包名');
  assert.equal(bundle.includes('免费模型池'), false, '不应再有旧 label');
});

test('client bundle：样式全部走官方主题令牌（不写死色值）', () => {  for (const token of ['--dsw-alias-label-primary', '--dsw-alias-border-l1', '--dsw-alias-bg-layer-1', '--dsw-alias-state-error-primary']) {
    assert.equal(bundle.includes(token), true, `缺少主题令牌 ${token}`);
  }
  // 十六进制色值只允许出现在注释里：M0 的内联色值（#f66 / #6c6 之类）都要走令牌，
  // 否则换主题时这一块会是页面上唯一不跟着变的地方。
  const offenders = bundle
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return false;
      return /#[0-9a-fA-F]{3,6}\b/.test(line);
    });
  assert.deepEqual(offenders, [], `这些行仍有写死色值：\n${offenders.join('\n')}`);
});

test('client bundle：M3 接线 —— 实测接 model-probe、默认模型走官方路由', () => {
  assert.equal(bundle.includes('/model-probe-api/health'), true, '缺少探测端点探活');
  assert.equal(bundle.includes('/model-probe-api/probe'), true, '缺少实测调用');
  assert.equal(bundle.includes('/freemodel-api/default-model'), true, '缺少默认模型的官方写路径');
  // 「实测」按钮必须受探活结果门控（缺席就隐藏），而不是给用户一个点了报 404 的按钮。
  assert.match(bundle, /probeAvailable \? react\.createElement\("button"/, '实测按钮缺少探活门控');
});
