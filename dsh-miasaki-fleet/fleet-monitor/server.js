#!/usr/bin/env node
/* ============================================================
 * Fleet Monitor — 多 Agent 编排监控面板 后端
 * 
 * 功能：
 *   GET  /            → panel.html（监控面板）
 *   GET  /api/fleet   → 聚合的 fleet 状态 JSON
 *   POST /api/toggle/:agentId → 切换 agent 开关（写 control.json）
 *   GET  /api/usage/:agentId  → 单 agent 的 usage.jsonl 原始数据
 *   GET  /api/report?days=N   → 历史成本报表（按天/按 agent 聚合）
 *
 * 安全：**所有**路由（含静态面板）都先过 fence.cjs 的三道信任围栏
 *   （Host / sec-fetch-site / Origin），未过者一律 403 且不带 CORS 头。
 *   本服务含写接口（POST /api/toggle/:agentId 落盘 control.json），
 *   只绑 127.0.0.1 挡不住浏览器代发的跨站请求 —— 见 fence.cjs 头部说明。
 *
 * 启动：node server.js [workspace-root] [port]
 * 默认 workspace = 项目根目录（server.js 所在目录的上级）
 * 默认 port = 39801
 * ============================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
// F3 判活：与 publish-pulse 共用同一口径（实现在 workers/lib/liveness.cjs）。
const { evaluateLiveness } = require('../workers/lib/liveness.cjs');
// 2026-09-26 审计 P1.5：本服务原为「CORS 通配 + 写接口零鉴权」。补三道信任围栏，
// 与 appearance / ssh / sidebar 三条线同构（同判据、同 reason 词表，各自独立实现）。
const { fenceCheck, buildTrustedHosts, corsHeadersFor } = require('./fence.cjs');

/* ---------- 配置 ---------- */
const WORKSPACE = process.argv[2] || path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[3] || '39801', 10);
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
const STATE_DIR = path.join(WORKSPACE, 'state');
const PANEL_HTML = path.join(__dirname, 'panel.html');
// 逃生门：确需从其它主机名访问时用 `FLEET_MONITOR_TRUSTED_HOSTS=a.example,b.example`
// 显式声明；默认只认本机（localhost / 127.0.0.1 恒在放行集内）。
const TRUSTED_HOSTS = buildTrustedHosts((process.env.FLEET_MONITOR_TRUSTED_HOSTS || '').split(','));

/* ---------- 缓存 ---------- */
let fleetCache = null;
let cacheTime = 0;
const CACHE_TTL = 800; // ms

/* ---------- 工具函数 ---------- */

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

function safeReadJSON(filePath) {
  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf-8')).trim();
    if (!raw || raw === '[BLOCKED]') return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeReadJSONL(filePath) {
  try {
    const raw = stripBom(fs.readFileSync(filePath, 'utf-8')).trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------- 聚合逻辑 ---------- */

function aggregateFleet() {
  const now = Date.now();
  if (fleetCache && (now - cacheTime) < CACHE_TTL) {
    return fleetCache;
  }

  const agents = [];
  const today = todayKey();
  let totalCostToday = 0;
  let onlineCount = 0;
  let taskCount = 0;

  // 读 registry
  let registry = [];
  try {
    registry = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, 'registry.json'), 'utf-8'));
  } catch { /* ignore */ }

  // 读 tasks.jsonl 获取任务统计
  const allTasks = safeReadJSONL(path.join(STATE_DIR, 'tasks.jsonl'));
  const taskMap = {};
  for (const entry of allTasks) {
    if (entry.task && entry.task.id) {
      taskMap[entry.task.id] = entry.task;
    }
    if (entry.op === 'update' && entry.task_id) {
      const t = taskMap[entry.task_id];
      if (t && entry.status) t.status = entry.status;
    }
  }
  const allTasksList = Object.values(taskMap);
  taskCount = allTasksList.filter(t => t.status === 'running' || t.status === 'blocked').length;

  // 读每个 agent 目录
  const agentDirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'archive')  // 排除 archive（历史标本，非活跃 fleet）
    .map(d => d.name);

  for (const id of agentDirs) {
    const agentDir = path.join(AGENTS_DIR, id);

    // manifest.json
    const manifest = safeReadJSON(path.join(agentDir, 'manifest.json'));
    if (!manifest) continue;

    // control.json
    const control = safeReadJSON(path.join(agentDir, 'control.json'));
    const enabled = control ? !!control.enabled : false;

    // status.json
    const status = safeReadJSON(path.join(agentDir, 'status.json'));

    // usage.jsonl — 聚合当日数据
    const usageLines = safeReadJSONL(path.join(agentDir, 'usage.jsonl'));
    let costToday = 0;
    let tokensToday = 0;
    let taskCountAgent = 0;
    for (const u of usageLines) {
      if (u.ts && u.ts.startsWith(today)) {
        costToday += u.cost || 0;
        tokensToday += (u.input_tokens || 0) + (u.output_tokens || 0);
        taskCountAgent++;
      }
    }

    // 当前任务信息
    let currentTask = null;
    if (status && status.current_task) {
      const t = taskMap[status.current_task];
      if (t) currentTask = { id: t.id, title: t.title, status: t.status };
    }

    // 进程存活判断（F3）：心跳必须新鲜。此前只判 `state !== 'stopped'`，
    // worker 崩溃后遗留的 status.json 会让面板永远显示它在跑；
    // 与 publish-pulse 共用 workers/lib/liveness.mjs 同一口径。
    const live = evaluateLiveness(status, manifest, now);
    const alive = live.alive;

    const agent = {
      id: manifest.id || id,
      name: manifest.name || id,
      runtime: manifest.runtime || 'cli',
      model: manifest.model || null,
      metering: manifest.metering !== false,
      metering_source: manifest.metering_source || null,
      skills: manifest.skills || [],
      limits: manifest.limits || {},
      cli_version: manifest.cli ? manifest.cli.version : null,
      // 状态
      enabled: enabled,
      alive: alive,
      // 修正后的状态：心跳过龄的 running/draining 已降级为 unknown。
      state: live.state,
      // 原始上报值与降级原因一并暴露，便于面板区分「真空闲」与「疑似崩溃」。
      reported_state: status ? (status.state || 'unknown') : 'no-status',
      stale: live.stale,
      stale_reason: live.reason,
      current_task: currentTask,
      progress: status ? (status.progress || 0) : 0,
      step: status ? (status.step || '') : '',
      heartbeat_at: status ? (status.heartbeat_at || null) : null,
      // 成本
      cost_today: Math.round(costToday * 1000000) / 1000000,
      tokens_today: tokensToday,
      tasks_today: taskCountAgent,
      // 控制
      control_updated_at: control ? (control.updated_at || null) : null,
    };

    totalCostToday += costToday;
    if (enabled && alive) onlineCount++;

    agents.push(agent);
  }

  // 按 enabled → state 排序
  agents.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const stateOrder = { running: 0, idle: 1, blocked: 2, error: 3, unknown: 4, 'no-status': 5, stopped: 6 };
    return (stateOrder[a.state] || 9) - (stateOrder[b.state] || 9);
  });

  fleetCache = {
    ts: new Date().toISOString(),
    workspace: WORKSPACE,
    summary: {
      total: agents.length,
      online: onlineCount,
      enabled: agents.filter(a => a.enabled).length,
      tasks_active: taskCount,
      cost_today: Math.round(totalCostToday * 1000000) / 1000000,
    },
    agents,
  };

  cacheTime = now;
  return fleetCache;
}

/* ---------- 历史成本报表聚合 ---------- */

let reportCache = null;
let reportCacheKey = '';
let reportCacheTime = 0;
const REPORT_CACHE_TTL = 3000; // ms

function round6(n) {
  return Math.round(n * 1000000) / 1000000;
}

// 以 UTC 日键计算偏移日（与 aggregateFleet 的今日口径一致：usage.ts 前 10 位）
function dayKeyOffset(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function aggregateReport(days) {
  const now = Date.now();
  if (reportCache && reportCacheKey === String(days) && (now - reportCacheTime) < REPORT_CACHE_TTL) {
    return reportCache;
  }

  const endKey = dayKeyOffset(0);
  const startKey = dayKeyOffset(-(days - 1));

  const byDayMap = {};       // date → 聚合
  const byAgentMap = {};     // agentId → 聚合
  const byDayAgentMap = {};  // "date|agent" → 聚合

  const agentDirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'archive')  // 排除 archive（历史标本，非活跃 fleet）
    .map(d => d.name);

  for (const id of agentDirs) {
    const manifest = safeReadJSON(path.join(AGENTS_DIR, id, 'manifest.json'));
    if (!manifest) continue;

    const usageLines = safeReadJSONL(path.join(AGENTS_DIR, id, 'usage.jsonl'));
    for (const u of usageLines) {
      const dateKey = u.ts ? String(u.ts).slice(0, 10) : null;
      if (!dateKey || dateKey < startKey || dateKey > endKey) continue;

      const cost = u.cost || 0;
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0);
      const cache = (u.cache_read_tokens || 0) + (u.cache_write_tokens || 0);

      // 按天
      const d = byDayMap[dateKey] || (byDayMap[dateKey] = { date: dateKey, cost: 0, tokens: 0, cache: 0, calls: 0 });
      d.cost += cost; d.tokens += tokens; d.cache += cache; d.calls++;

      // 按 agent
      const a = byAgentMap[id] || (byAgentMap[id] = {
        agent: id, name: manifest.name || id,
        cost: 0, tokens: 0, cache: 0, calls: 0, days: new Set(),
      });
      a.cost += cost; a.tokens += tokens; a.cache += cache; a.calls++;
      a.days.add(dateKey);

      // 天 × agent 交叉
      const dk = dateKey + '|' + id;
      const da = byDayAgentMap[dk] || (byDayAgentMap[dk] = { date: dateKey, agent: id, cost: 0, tokens: 0, calls: 0 });
      da.cost += cost; da.tokens += tokens; da.calls++;
    }
  }

  // 按天序列（含空日补 0，旧 → 新）
  const byDay = [];
  for (let i = 0; i < days; i++) {
    const date = dayKeyOffset(-(days - 1 - i));
    const d = byDayMap[date] || { date, cost: 0, tokens: 0, cache: 0, calls: 0 };
    byDay.push({ date: d.date, cost: round6(d.cost), tokens: d.tokens, cache: d.cache, calls: d.calls });
  }

  const byAgent = Object.values(byAgentMap)
    .map(a => ({
      agent: a.agent, name: a.name,
      cost: round6(a.cost), tokens: a.tokens, cache: a.cache, calls: a.calls, days: a.days.size,
    }))
    .sort((x, y) => y.cost - x.cost);

  const byDayAgent = Object.values(byDayAgentMap).map(da => ({
    date: da.date, agent: da.agent,
    cost: round6(da.cost), tokens: da.tokens, calls: da.calls,
  }));

  const totalCost = byDay.reduce((s, d) => s + d.cost, 0);
  const totalTokens = byDay.reduce((s, d) => s + d.tokens, 0);
  const totalCache = byDay.reduce((s, d) => s + d.cache, 0);
  const totalCalls = byDay.reduce((s, d) => s + d.calls, 0);

  reportCache = {
    ts: new Date().toISOString(),
    days,
    range: { start: startKey, end: endKey },
    summary: {
      total_cost: round6(totalCost),
      total_tokens: totalTokens,
      total_cache_tokens: totalCache,
      total_calls: totalCalls,
      avg_daily_cost: round6(totalCost / days),
      days_with_data: byDay.filter(d => d.calls > 0).length,
    },
    byDay,
    byAgent,
    byDayAgent,
  };
  reportCacheKey = String(days);
  reportCacheTime = now;
  return reportCache;
}

/* ---------- HTTP 服务 ---------- */

/** 入口统一调用：只有**已过围栏**的请求才会走到这里。 */
function setCors(res, headers) {
  for (const [key, value] of Object.entries(corsHeadersFor(headers))) res.setHeader(key, value);
}

function sendJSON(res, data, status = 200) {
  // 不在此设 CORS 头：由 handleRequest 入口统一设置，被围栏拒绝的响应必须一个都不带。
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendHTML(res, filePath) {
  try {
    const html = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Failed to load panel: ' + e.message);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── 信任围栏（三道：Host / sec-fetch-site / Origin）──────────────────────
  // 必须排在**所有**路由之前。理由：本服务带写接口（POST /api/toggle/:agentId
  // 直接落盘 control.json）。只绑 127.0.0.1 限制的是「谁能连」，而浏览器可以把
  // 任意网页发起的请求送到 127.0.0.1 —— 挡跨站要靠这三道判定，不是靠绑定地址。
  // 被拒响应不发任何 CORS 头，页面侧连字段都读不到。
  const verdict = fenceCheck(req.headers, TRUSTED_HOSTS);
  if (!verdict.ok) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'forbidden', reason: verdict.reason }, null, 2));
    return;
  }
  setCors(res, req.headers);

  // CORS preflight（只有已过围栏的请求能到达这里）
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET / → panel.html
  if (req.method === 'GET' && pathname === '/') {
    return sendHTML(res, PANEL_HTML);
  }

  // GET /api/fleet → 聚合状态
  if (req.method === 'GET' && pathname === '/api/fleet') {
    return sendJSON(res, aggregateFleet());
  }

  // GET /api/report?days=N → 历史成本报表（1~90 天）
  if (req.method === 'GET' && pathname === '/api/report') {
    const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
    const days = Math.min(Math.max(isNaN(daysParam) ? 30 : daysParam, 1), 90);
    return sendJSON(res, aggregateReport(days));
  }

  // POST /api/toggle/:agentId → 切换开关
  if (req.method === 'POST' && pathname.startsWith('/api/toggle/')) {
    const agentId = pathname.split('/')[3];
    if (!agentId || agentId.includes('..')) {
      return sendJSON(res, { error: 'invalid agent id' }, 400);
    }
    try {
      const body = JSON.parse(await readBody(req));
      const controlPath = path.join(AGENTS_DIR, agentId, 'control.json');
      let control = safeReadJSON(controlPath) || {};
      control.enabled = !!body.enabled;
      control.updated_at = new Date().toISOString();
      control.updated_by = 'operator-panel';
      if (body.force_kill !== undefined) control.force_kill = !!body.force_kill;
      fs.writeFileSync(controlPath, JSON.stringify(control, null, 2) + '\n');
      fleetCache = null; // invalidate cache
      return sendJSON(res, { ok: true, agent: agentId, enabled: control.enabled });
    } catch (e) {
      return sendJSON(res, { error: e.message }, 500);
    }
  }

  // GET /api/usage/:agentId → usage.jsonl
  if (req.method === 'GET' && pathname.startsWith('/api/usage/')) {
    const agentId = pathname.split('/')[3];
    if (!agentId || agentId.includes('..')) {
      return sendJSON(res, { error: 'invalid agent id' }, 400);
    }
    const usagePath = path.join(AGENTS_DIR, agentId, 'usage.jsonl');
    return sendJSON(res, safeReadJSONL(usagePath));
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

const server = http.createServer(handleRequest);

// 只在被直接运行时监听：require 本模块做单测不应占端口、不应产生副作用。
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Fleet Monitor] listening on http://127.0.0.1:${PORT}`);
    console.log(`[Fleet Monitor] workspace: ${WORKSPACE}`);
    console.log(`[Fleet Monitor] agents dir: ${AGENTS_DIR}`);
    console.log(`[Fleet Monitor] trusted hosts: ${[...TRUSTED_HOSTS].join(', ')}`);
  });
}

module.exports = { handleRequest, server, TRUSTED_HOSTS };
