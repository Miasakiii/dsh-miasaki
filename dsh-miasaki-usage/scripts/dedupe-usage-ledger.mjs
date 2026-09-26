#!/usr/bin/env node
/**
 * dsh-token-monitor 账本 span 快照去重（v0.5.1 配套的数据修复工具）
 *
 * 背景：v0.5.0 及更早版本的 `loadLedger()` 在载入 `type:'span'` 行时经 `touchSpan`
 * 把这些键重新标脏，于是 `process.on('exit')` 的强制 flush 每次 host 正常退出都
 * 把全部存量 span 快照重写一遍 —— 实测本机账本 4690 行中 970 行是 span 行、去重后
 * 仅 50 个唯一 (date|sessionId)，920 行为纯冗余（占 20%），单键最多重复 82 次。
 *
 * 本脚本把同一 (date, sessionId) 的多行快照**无损合并为一行**（first 取最小、
 * last 取最大 —— 与载入时的 min/max 合并语义完全一致，因为运行时写出的快照本就是
 * 合并结果），非 span 行原样保留、顺序不变。合并后行放在该键最后一次出现的位置。
 *
 * 用法：
 *   node dedupe-usage-ledger.mjs                 # 预演（默认，只打印不写盘）
 *   node dedupe-usage-ledger.mjs --apply         # 执行（先自动备份 .bak-<时间戳>）
 *   node dedupe-usage-ledger.mjs --file <path>   # 指定账本文件
 *   node dedupe-usage-ledger.mjs --profile <名>  # 指定 profile 分区（默认 miasaki）
 *
 * 账本自 2026-09-26 起**按 profile 分区**（官方桌面端只记官方消耗），路径为
 * `~/.dsh/plugins-data/dsh-token-monitor/<profile>/usage-log.jsonl`；分区之前是全局单文件，
 * 那份历史归在 `miasaki` 分区，故本脚本默认作用于它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const fileArg = args.indexOf('--file');
const profArg = args.indexOf('--profile');
const PROFILE = profArg >= 0 && args[profArg + 1] ? args[profArg + 1] : 'miasaki';
const FILE = fileArg >= 0 && args[fileArg + 1]
  ? path.resolve(args[fileArg + 1])
  : path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-token-monitor', PROFILE, 'usage-log.jsonl');

/** 把账本行解析为 {use[], spanRows[]}，坏行计数但不丢弃（原样保留）。 */
function parse(raw) {
  const rows = raw.split('\n').filter((l) => l.trim());
  const use = [];      // 原样保留的行（用量行 / 坏行），带原始下标
  const span = [];     // span 行：{idx, date, sessionId, first, last, ts, raw}
  rows.forEach((line, idx) => {
    let j = null;
    try { j = JSON.parse(line); } catch (e) { /* 坏行原样保留 */ }
    if (j && j.type === 'span' && typeof j.sessionId === 'string'
      && typeof j.first === 'number' && typeof j.last === 'number' && typeof j.date === 'string') {
      span.push({ idx, date: j.date, sessionId: j.sessionId, first: j.first, last: j.last, ts: typeof j.ts === 'number' ? j.ts : 0 });
    } else {
      use.push({ idx, line });
    }
  });
  return { rows, use, span };
}

/** 账本语义摘要：用量聚合 + span min/max 合并结果。用于证明"合并无损"。 */
function summarize(parsed) {
  const tokens = new Map();
  const spans = new Map();
  for (const r of parsed.use) {
    let j = null;
    try { j = JSON.parse(r.line); } catch (e) { continue; }
    if (!j || typeof j.date !== 'string') continue;
    const k = [j.date, j.sessionId, j.provider, j.model].join('|');
    let e = tokens.get(k);
    if (!e) { e = { i: 0, o: 0, c: 0, r: 0, n: 0 }; tokens.set(k, e); }
    e.i += j.inputTokens || 0; e.o += j.outputTokens || 0;
    e.c += j.cacheReadTokens || 0; e.r += j.reasoningTokens || 0; e.n += j.calls || 0;
  }
  for (const s of parsed.span) {
    const k = s.date + '|' + s.sessionId;
    const e = spans.get(k) || { first: s.first, last: s.last };
    if (s.first < e.first) e.first = s.first;
    if (s.last > e.last) e.last = s.last;
    spans.set(k, e);
  }
  const tk = Array.from(tokens.keys()).sort();
  return {
    useRows: parsed.use.length,
    spanRows: parsed.span.length,
    uniqueSpans: spans.size,
    tokenKeys: tk.length,
    tokensDigest: tk.map((k) => { const e = tokens.get(k); return k + ':' + [e.i, e.o, e.c, e.r, e.n].join(','); }).join(';'),
    spansDigest: Array.from(spans.keys()).sort().map((k) => k + ':' + spans.get(k).first + '-' + spans.get(k).last).join(';')
  };
}

/** 合并同键 span 行：每个键输出一行，放回该键最后一次出现的位置。 */
function merge(parsed) {
  const byKey = new Map();
  for (const s of parsed.span) {
    const k = s.date + '|' + s.sessionId;
    const e = byKey.get(k);
    if (!e) byKey.set(k, { date: s.date, sessionId: s.sessionId, first: s.first, last: s.last, ts: s.ts, at: s.idx });
    else {
      if (s.first < e.first) e.first = s.first;
      if (s.last > e.last) e.last = s.last;
      if (s.ts > e.ts) e.ts = s.ts;
      if (s.idx > e.at) e.at = s.idx;
    }
  }
  const out = [];
  for (const r of parsed.use) out.push({ idx: r.idx, line: r.line });
  for (const e of byKey.values()) {
    out.push({ idx: e.at, line: JSON.stringify({ type: 'span', date: e.date, ts: e.ts, sessionId: e.sessionId, first: e.first, last: e.last }) });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out.map((r) => r.line);
}

if (!fs.existsSync(FILE)) {
  console.error('账本不存在: ' + FILE);
  process.exit(1);
}

const raw = fs.readFileSync(FILE, 'utf8');
const parsed = parse(raw);
const before = summarize(parsed);
const merged = merge(parsed);
const after = summarize(parse(merged.join('\n') + '\n'));

const same = before.tokensDigest === after.tokensDigest && before.spansDigest === after.spansDigest;

console.log('账本: ' + FILE);
console.log('  体积        ' + fs.statSync(FILE).size + ' B → ' + Buffer.byteLength(merged.join('\n') + '\n', 'utf8') + ' B');
console.log('  总行数      ' + parsed.rows.length + ' → ' + merged.length);
console.log('  用量行      ' + before.useRows + ' → ' + after.useRows + '（原样保留）');
console.log('  span 行     ' + before.spanRows + ' → ' + after.spanRows + '（唯一键 ' + before.uniqueSpans + '）');
console.log('  合并跨度键  ' + before.uniqueSpans + ' → ' + after.uniqueSpans);
console.log('');
console.log('  语义等价校验（用量聚合 + span min/max 合并结果比对）: ' + (same ? '一致 ✅' : '不一致 ❌'));
if (!same) {
  console.error('  摘要不一致，拒绝写入。请保留原文件并人工核查。');
  process.exit(2);
}

if (!APPLY) {
  console.log('\n预演结束（未写盘）。加 --apply 执行，执行前会自动备份。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = FILE + '.bak-' + stamp;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, merged.join('\n') + '\n', 'utf8');
console.log('\n已写盘。备份: ' + backup);
console.log('  清理后体积 ' + fs.statSync(FILE).size + ' B');
