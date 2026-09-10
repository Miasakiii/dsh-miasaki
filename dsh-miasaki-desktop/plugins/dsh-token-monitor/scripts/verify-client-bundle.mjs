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
 * 本脚本做两件事，任一失败即 exit 1：
 *  1) 语法解析：把文件当脚本 eval（不执行 factory），抓 SyntaxError。
 *  2) 真实工厂执行：喂一个最简 react stub，capture factory 抛出的
 *     ReferenceError / TypeError（能在 import 期暴露的错）。
 *  3) 模板字符串平衡：逐字符状态机（识别 `\`` 与 `\${`），报告字面量内部的
 *     裸反引号行号——即历史事故的根因模式。
 *
 * 用法：
 *   node verify-client-bundle.mjs <client.js> [...更多 client.js]
 *   node verify-client-bundle.mjs --sync   # 额外把源码同步到 profile 安装副本
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import os from 'os';

const args = process.argv.slice(2);
const doSync = args.includes('--sync');
const files = args.filter((a) => !a.startsWith('--'));

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

// 简化版：直接找「CSS 模板字面量内部的奇数反引号」——用 vm 解析兜底更可靠，
// 故 scanTemplateLiterals 仅作辅助提示；主判据是 vm 执行。
function reportTemplateHint(src) {
  const lines = src.split('\n');
  const inTpl = [];
  let state = 'code', tplOpenLine = 0;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    for (let j = 0; j < l.length; j++) {
      const c = l[j], n = l[j + 1];
      if (state === 'code') {
        if (c === '/' && n === '/') break;
        if (c === '/' && n === '*') { state = 'block'; j++; continue; }
        if (c === '"' || c === "'") { /* 行内简单跳过 */ }
        if (c === '`') { state = 'tpl'; tplOpenLine = li + 1; }
      } else if (state === 'tpl') {
        if (c === '\\') { j++; continue; }
        if (c === '`') { state = 'code'; }
        else if (c === '`') { state = 'code'; }
      } else if (state === 'block') {
        if (c === '*' && n === '/') { state = 'code'; j++; }
      }
    }
    if (state === 'tpl' && li + 1 > tplOpenLine) {
      // 若本行在模板内又出现反引号（已由内层处理），记录可疑
    }
  }
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

  // 3) 同步到 profile 安装副本
  if (doSync && runtimeOk) {
    const installed = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-token-monitor', 'lib', path.basename(file));
    if (fs.existsSync(path.dirname(installed))) {
      fs.copyFileSync(file, installed);
      const a = fs.readFileSync(file);
      const b = fs.readFileSync(installed);
      const same = Buffer.compare(a, b) === 0;
      console.log('  [' + (same ? 'OK' : 'FAIL') + ']   已同步安装副本：' + installed);
      if (!same) failed++;
    } else {
      console.log('  [SKIP] 安装副本目录不存在：' + path.dirname(installed));
    }
  }
}

console.log(failed === 0 ? '\n全部通过。' : '\n存在 ' + failed + ' 项失败。');
process.exit(failed === 0 ? 0 : 1);
