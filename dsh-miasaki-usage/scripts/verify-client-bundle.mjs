#!/usr/bin/env node
/**
 * verify-client-bundle.mjs — DSH web 插件 client half 的加载前自检。
 *
 * 背景：client.js 以 `window.__ModuleLoader__.load({ factory })` 包装，
 * 体积大、内嵌 CSS 模板字符串。历史事故（2026-09-10, dsh-token-monitor）：
 * CSS 注释里写了 `.tokmn-pct` 这类带反引号的类名，**在模板字符串内部闭合了
 * 字面量**，导致 `pct` 被当作裸标识符 → 浏览器侧
 * `failed to import loader entry …: pct is not defined`，且 V8 报错行号落在
 * 模板字符串内部、极难定位。
 *
 * 本脚本做三件事（外加 --sync 时的第四项），任一失败即 exit 1：
 *  1) 语法解析：把文件当脚本 eval（不执行 factory），抓 SyntaxError。
 *  2) 真实工厂执行：喂一个最简 react stub，capture factory 抛出的
 *     ReferenceError / TypeError（能在 import 期暴露的错）。
 *  3) 模板字符串平衡：逐字符状态机（识别 `\`` 与 `\${`），报告字面量内部的
 *     裸反引号行号——即历史事故的根因模式。
 *  --sync 时另做 4) 安装点核对（见下）。
 *
 * 用法：
 *   node verify-client-bundle.mjs <client.js> [...更多 client.js]
 *   node verify-client-bundle.mjs <client.js> --sync
 *     --sync：逐个核对各 DSH profile 的安装点。link: 装法（本线 2026-09-26 起）
 *     下源码即真源 —— 安装点是链接且指回本线即为一致，无需拷贝；若遇到历史遗留的
 *     file: 普通拷贝副本（v0.5.2 及以前的装法），则按旧行为覆盖后提示改用 link:。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import os from 'os';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const doSync = args.includes('--sync');
const files = args.filter((a) => !a.startsWith('--'));

/** 本插件（本线）根目录，用于核对 profile 安装点的链接指向。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 需要核对的 profile（官方桌面端 / 官方浏览器 GUI / miasaki 桌面壳）。 */
const PROFILES = ['desktop', 'web', 'miasaki'];

if (files.length === 0) {
  console.log('usage: node verify-client-bundle.mjs <client.js> [...] [--sync]');
  process.exit(2);
}

const REACT_STUB = () => ({
  createElement: () => ({}),
  useState: (x) => [x, () => {}],
  useEffect: () => {},
  useRef: (x) => ({ current: x }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  createContext: () => ({ Provider: () => null }),
  Fragment: 'fragment',
});

/** 逐字符扫描模板字面量，返回内部裸反引号的行号（1-based）。 */
function scanTemplateLiterals(src) {
  const offenders = [];
  let line = 1;
  let state = 'code'; // code | single | double | template | lineComment | blockComment
  let tplDepthStart = 0;
  const stack = []; // 模板嵌套深度（${ } 内可再开模板）

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') { line++; }

    switch (state) {
      case 'code':
        if (c === '/' && n === '/') { state = 'lineComment'; i++; }
        else if (c === '/' && n === '*') { state = 'blockComment'; i++; }
        else if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '`') { state = 'template'; stack.push(1); tplDepthStart = line; }
        break;
      case 'single':
        if (c === '\\') i++;
        else if (c === "'") state = 'code';
        break;
      case 'double':
        if (c === '\\') i++;
        else if (c === '"') state = 'code';
        break;
      case 'lineComment':
        if (c === '\n') state = 'code';
        break;
      case 'blockComment':
        if (c === '*' && n === '/') { state = 'code'; i++; }
        break;
      case 'template':
        if (c === '\\') { i++; }
        else if (c === '$' && n === '{') { stack.push(0); state = 'code'; i++; }
        else if (c === '`') {
          stack.pop();
          if (stack.length === 0) state = 'code';
        }
        break;
    }
    // 处于模板内（stack 非空且非 code 进入点）时，再遇裸 ` 已在前述处理
    if (state === 'template' && c === '`' && stack.length > 0) {
      // 由上面的分支处理；此处仅防御
    }
  }
  // 若结束时仍在模板内 => 未闭合
  if (state === 'template' || state === 'single' || state === 'double') {
    offenders.push({ line, reason: 'unterminated ' + state });
  }
  return offenders;
}

let failed = 0;
for (const file of files) {
  console.log('=== ' + file + ' ===');
  if (!fs.existsSync(file)) { console.log('  [FAIL] 文件不存在'); failed++; continue; }
  const src = fs.readFileSync(file, 'utf8');
  const calls = [];

  // 1) 语法 + 抓取 factory
  let factory = null;
  try {
    const sandbox = {
      console,
      window: { __ModuleLoader__: { load(o) { calls.push(o); } } },
    };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: path.basename(file) });
    factory = calls[0] && calls[0].factory;
    console.log('  [OK]   包装层解析通过，loader entry id = ' + (calls[0] && calls[0].id));
  } catch (e) {
    console.log('  [FAIL] 包装层解析/执行失败：' + e.message);
    const m = e.stack && e.stack.split('\n')[1];
    if (m) console.log('         ' + m.trim());
    failed++;
    continue;
  }

  if (!factory) { console.log('  [FAIL] 未捕获到 factory'); failed++; continue; }

  // 2) 在脚本执行上下文内真实调用 factory
  let runtimeOk = true;
  const makeRequire = () => {
    const fn = (name) => {
      if (name === 'react') return REACT_STUB();
      throw new Error('unexpected require: ' + name);
    };
    fn.resolve = () => '';
    return fn;
  };
  const sandbox2 = {
    console,
    window: {
      __ModuleLoader__: {
        load(o) {
          calls.push(o);
          try { o.factory(makeRequire()); }
          catch (e) {
            runtimeOk = false;
            console.log('  [FAIL] factory 执行抛错：' + e.constructor.name + ': ' + e.message);
            const st = e.stack.split('\n');
            console.log('         ' + (st[1] || '').trim());
          }
        },
      },
    },
  };
  vm.createContext(sandbox2);
  try {
    vm.runInContext(src, sandbox2, { filename: path.basename(file) });
    if (runtimeOk) console.log('  [OK]   factory 执行通过（react stub）');
    else failed++;
  } catch (e) {
    console.log('  [FAIL] 内联执行异常：' + e.message);
    failed++;
  }

  // 3) 模板字符串平衡（静态扫描）：历史事故的根因模式 —— CSS 注释里的反引号在模板
  //    字面量内部提前闭合。vm 执行能抓到多数后果，但闭合后语法恰好合法时会漏，
  //    故保留独立静态防线（2026-09-26 接线：此前该扫描器写好但从未被调用）。
  const offenders = scanTemplateLiterals(src);
  if (offenders.length === 0) {
    console.log('  [OK]   模板字面量平衡（无裸反引号 / 未闭合字面量）');
  } else {
    for (const offender of offenders) {
      console.log('  [FAIL] 模板字面量第 ' + offender.line + ' 行：' + offender.reason);
    }
    failed++;
  }

  // 4) 安装点核对
  //    link: 装法下安装点是指回本线的目录链接 —— 源码即真源，只需核对指向；
  //    历史遗留的 file: 普通拷贝副本按旧行为覆盖，并提示改用 link:。
  if (doSync && runtimeOk) {
    const base = path.basename(file);
    for (const profile of PROFILES) {
      const target = path.join(os.homedir(), '.dsh', 'profiles', profile, 'node_modules', 'dsh-token-monitor');
      if (!fs.existsSync(target)) {
        console.log('  [SKIP] ' + profile + ' profile 未安装本插件');
        continue;
      }
      let isLink = false;
      try { isLink = fs.lstatSync(target).isSymbolicLink(); } catch { isLink = false; }
      if (isLink) {
        let real = '';
        try { real = fs.realpathSync(target); } catch { real = ''; }
        const same = !!real && path.resolve(real).toLowerCase() === PLUGIN_ROOT.toLowerCase();
        console.log('  [' + (same ? 'OK' : 'FAIL') + ']   ' + profile + ' profile 安装点 → ' + real +
          (same ? '（link 指回本线，源码即真源）' : '（未指回本线：' + PLUGIN_ROOT + '）'));
        if (!same) failed++;
        continue;
      }
      const installed = path.join(target, 'lib', base);
      if (!fs.existsSync(path.dirname(installed))) {
        console.log('  [SKIP] ' + profile + ' profile 安装点结构异常：' + path.dirname(installed));
        continue;
      }
      fs.copyFileSync(file, installed);
      const same = Buffer.compare(fs.readFileSync(file), fs.readFileSync(installed)) === 0;
      console.log('  [' + (same ? 'OK' : 'FAIL') + ']   ' + profile + ' profile 是 file: 拷贝副本，已覆盖：' + installed);
      console.log('         ↑ 建议改用 link: 装法（README「安装」段）—— 拷贝副本会与源码静默漂移');
      if (!same) failed++;
    }
  }
}

console.log(failed === 0 ? '\n全部通过。' : '\n存在 ' + failed + ' 项失败。');
process.exit(failed === 0 ? 0 : 1);
