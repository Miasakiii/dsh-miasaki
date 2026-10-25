/**
 * Host-half coverage for the probe.
 *
 * Three groups of rules that have bitten or could bite a real deployment:
 *   ① 纯逻辑判定表：the double `/v1` spelling, the empty-conversation
 *      handshake, the model-vs-request refusal split, redaction, badges;
 *   ② 凭据边界（2026-10-19 P1）：a draft `baseURL` on another origin must never
 *      carry the stored credential, and the decision must happen before any
 *      network I/O (`sameOrigin` 纯函数 + `probeModel` 接线);
 *   ③ 路由准入（2026-10-19 P1）：`connection.requestRejection` 两层围栏、
 *      Origin 端口判据、围栏先于 method 检查 —— 用假 webServer / 假 fetch 打，
 *      本文件不出网。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_LIMIT,
  DEFAULT_TIMEOUT_MS,
  PROBE_PROTOCOLS,
  buildProbeRequest,
  classifyStatus,
  isProbeable,
  looksLikeMissingModel,
  messagesRoot,
  redactSecret,
  sameOrigin,
  shouldContinueToGenerate,
  summarizeDetail,
} from '../lib/probe.js';
import {
  apply,
  capabilityFlags,
  fenceRequest,
  probeModel,
  structuralFence,
  trustFence,
} from '../lib/index.js';

const NS = 'llm-pi-ai';

/** A StepFun-shaped credential: long, mixed case, no `sk-` prefix. */
const STEP_KEY = '1fa9p4EjVyNJdeB05NOgamdgnbb9cdaMz9DUMQ122e7iggbn6VnYEygQ03KVB8waX';

test('messagesRoot keeps a deployment path and strips exactly one trailing /v1', () => {
  assert.equal(messagesRoot('https://api.stepfun.com/step_plan'), 'https://api.stepfun.com/step_plan');
  assert.equal(messagesRoot('https://api.anthropic.com/v1'), 'https://api.anthropic.com');
  assert.equal(messagesRoot('https://gw.example/v1/'), 'https://gw.example');
  assert.equal(messagesRoot('https://gw.example///'), 'https://gw.example');
});

test('anthropic handshake posts an empty conversation to the real conversation path', () => {
  const spec = buildProbeRequest({
    api: 'anthropic-messages',
    baseURL: 'https://api.stepfun.com/step_plan',
    model: 'step-5-preview',
    apiKey: STEP_KEY,
    stage: 'handshake',
  });
  assert.equal(spec.url, 'https://api.stepfun.com/step_plan/v1/messages');
  assert.equal(spec.headers['x-api-key'], STEP_KEY);
  assert.equal(spec.headers['anthropic-version'], '2023-06-01');
  assert.equal(spec.body.model, 'step-5-preview');
  assert.equal(spec.body.max_tokens, 1);
  assert.deepEqual(spec.body.messages, []);
});

test('anthropic generate spends one token on one word', () => {
  const spec = buildProbeRequest({
    api: 'anthropic-messages',
    baseURL: 'https://api.stepfun.com/step_plan',
    model: 'step-5-preview',
    apiKey: STEP_KEY,
    stage: 'generate',
  });
  assert.deepEqual(spec.body.messages, [{ role: 'user', content: 'ping' }]);
  assert.equal(spec.body.max_tokens, 1);
});

test('a baseURL spelled with /v1 still lands on the same conversation path', () => {
  const bare = buildProbeRequest({ api: 'anthropic-messages', baseURL: 'https://gw.example', model: 'm', apiKey: 'k', stage: 'generate' });
  const withV1 = buildProbeRequest({ api: 'anthropic-messages', baseURL: 'https://gw.example/v1', model: 'm', apiKey: 'k', stage: 'generate' });
  assert.equal(bare.url, withV1.url);
  assert.equal(bare.url, 'https://gw.example/v1/messages');
});

test('openai-completions probes {baseURL}/chat/completions with a bearer key', () => {
  const spec = buildProbeRequest({
    api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1/',
    model: 'z-ai/glm-5.2:free',
    apiKey: 'sk-test',
    stage: 'generate',
  });
  assert.equal(spec.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(spec.headers.authorization, 'Bearer sk-test');
  assert.equal(spec.headers['anthropic-version'], undefined);
});

test('openai-responses probes {baseURL}/responses with its own body shape', () => {
  const spec = buildProbeRequest({ api: 'openai-responses', baseURL: 'https://gw.example/v1', model: 'm', apiKey: 'sk-test', stage: 'handshake' });
  assert.equal(spec.url, 'https://gw.example/v1/responses');
  assert.equal(spec.body.input, '');
  assert.equal('messages' in spec.body, false);
});

test('an unprobeable protocol plans no request at all', () => {
  assert.equal(buildProbeRequest({ api: 'aws-bedrock', baseURL: 'https://x', model: 'm', apiKey: 'k', stage: 'handshake' }), null);
  assert.equal(isProbeable('anthropic-messages'), true);
  assert.equal(isProbeable('aws-bedrock'), false);
  assert.deepEqual(PROBE_PROTOCOLS, ['anthropic-messages', 'openai-completions', 'openai-responses']);
});

test('a probe without a credential sends no authorization header', () => {
  const spec = buildProbeRequest({ api: 'openai-completions', baseURL: 'https://x/v1', model: 'm', apiKey: null, stage: 'handshake' });
  assert.equal('authorization' in spec.headers, false);
  const anthropic = buildProbeRequest({ api: 'anthropic-messages', baseURL: 'https://x', model: 'm', apiKey: null, stage: 'handshake' });
  assert.equal('x-api-key' in anthropic.headers, false);
});

test('classifyStatus maps every status onto the result vocabulary', () => {
  const cases = [
    [200, 'ok'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [402, 'quota'],
    [429, 'rate-limited'],
    [404, 'not-found'],
    [400, 'bad-request'],
    [422, 'bad-request'],
    [500, 'server-error'],
    [503, 'server-error'],
    [418, 'unknown'],
  ];
  for (const [status, kind] of cases) assert.equal(classifyStatus(status, ''), kind, `status ${status}`);
});

test('classifyStatus reads the body to separate a missing model from a bad request', () => {
  assert.equal(classifyStatus(400, '{"error":{"message":"model does not exist"}}'), 'model-missing');
  assert.equal(classifyStatus(404, '模型不存在'), 'model-missing');
  assert.equal(classifyStatus(400, '{"error":"messages: at least one message is required"}'), 'bad-request');
  assert.equal(classifyStatus(404, '{"error":"not found"}'), 'not-found');
});

test('looksLikeMissingModel fires on model-shaped refusals only', () => {
  assert.equal(looksLikeMissingModel('The model `gpt-x` does not exist'), true);
  assert.equal(looksLikeMissingModel('invalid model id'), true);
  assert.equal(looksLikeMissingModel('模型不存在'), true);
  assert.equal(looksLikeMissingModel('invalid api key'), false);
  assert.equal(looksLikeMissingModel('messages: at least one message is required'), false);
  assert.equal(looksLikeMissingModel(''), false);
  assert.equal(looksLikeMissingModel(undefined), false);
});

test('redactSecret removes the exact credential that was sent', () => {
  const out = redactSecret(`bad key ${STEP_KEY} rejected`, STEP_KEY);
  assert.equal(out.includes(STEP_KEY), false);
  assert.ok(out.includes('***'));
});

test('redactSecret also catches key-shaped strings it never sent', () => {
  assert.equal(redactSecret('leaked sk-abcdefghijklmnop in body', null).includes('sk-abcdefghijklmnop'), false);
  const long = 'a'.repeat(48);
  assert.equal(redactSecret(`echo ${long}`, null).includes(long), false);
});

test('redactSecret leaves short and purely numeric tokens readable', () => {
  assert.equal(redactSecret('trace 12345', null), 'trace 12345');
  const stamp = '1'.repeat(40);
  assert.equal(redactSecret(`ts ${stamp}`, null), `ts ${stamp}`);
});

test('summarizeDetail collapses whitespace and bounds the excerpt', () => {
  assert.equal(summarizeDetail('a\n\n  b', null), 'a b');
  const long = 'word '.repeat(120).trim();
  const out = summarizeDetail(long, null);
  assert.ok(long.length > 300);
  assert.equal(out.length, 301);
  assert.ok(out.endsWith('…'));
});

test('summarizeDetail never re-leaks a credential that appears in the body', () => {
  const out = summarizeDetail(`{"error":"invalid key ${STEP_KEY}"}`, STEP_KEY);
  assert.equal(out.includes(STEP_KEY), false);
});

test('only a parameter refusal or an unexpected 2xx continues to the paid stage', () => {
  assert.equal(shouldContinueToGenerate('bad-request'), true);
  assert.equal(shouldContinueToGenerate('ok'), true);
  for (const kind of ['unauthorized', 'model-missing', 'quota', 'rate-limited', 'timeout', 'unreachable', 'server-error', 'not-found', 'unknown']) {
    assert.equal(shouldContinueToGenerate(kind), false, kind);
  }
});

test('the module declares a bounded budget', () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 1000 && DEFAULT_TIMEOUT_MS <= 60000);
  assert.ok(BODY_LIMIT >= 1024 && BODY_LIMIT <= 1024 * 1024);
});

test('capabilityFlags reads image modality and reasoning block from the resolved info', () => {
  assert.deepEqual(capabilityFlags({ inputModalities: ['text', 'image'], reasoning: { efforts: [] } }), { image: true, reasoning: true });
  assert.deepEqual(capabilityFlags({ inputModalities: ['text'] }), { image: false, reasoning: false });
});

test('capabilityFlags never guesses: absent or broken metadata is all-false', () => {
  for (const info of [undefined, null, {}, { inputModalities: null }, { reasoning: undefined }, 'nonsense', 42]) {
    assert.deepEqual(capabilityFlags(info), { image: false, reasoning: false }, JSON.stringify(info));
  }
});

// ── 凭据边界：sameOrigin 纯函数 ─────────────────────────────────────────────

test('sameOrigin compares scheme + host + port, with default ports normalized', () => {
  assert.equal(sameOrigin('https://gw.example/v1', 'https://gw.example/other'), true, '路径不参与比较');
  assert.equal(sameOrigin('https://gw.example:443/v1', 'https://gw.example'), true, 'https 默认端口规范化');
  assert.equal(sameOrigin('http://gw.example:80', 'http://gw.example'), true, 'http 默认端口规范化');
  assert.equal(sameOrigin('HTTP://GW.Example:80/a', 'http://gw.example/b'), true, 'scheme/host 大小写不敏感');
  assert.equal(sameOrigin('http://gw.example:3080', 'http://gw.example:3081'), false, '不同端口不同源');
  assert.equal(sameOrigin('http://gw.example', 'https://gw.example'), false, 'scheme 不同不同源');
  assert.equal(sameOrigin('http://gw.example', 'http://other.example'), false, 'host 不同不同源');
});

test('sameOrigin is fail-closed: unparsable or non-http(s) URLs never match', () => {
  for (const bad of [null, undefined, '', '   ', 'not a url', '/relative/path', 'http://', 42, {}]) {
    assert.equal(sameOrigin(bad, 'https://gw.example'), false, `左值 ${String(bad)} 应判不同源`);
    assert.equal(sameOrigin('https://gw.example', bad), false, `右值 ${String(bad)} 应判不同源`);
  }
  // 非 http(s) 的 `origin` 在 WHATWG 里都退化成 'null'，若参与比较会误判同源。
  assert.equal(sameOrigin('file:///etc/passwd', 'file:///etc/passwd'), false);
  assert.equal(sameOrigin('ftp://gw.example', 'ftp://gw.example'), false);
  assert.equal(sameOrigin('data:text/plain,x', 'data:text/plain,x'), false);
});

// ── 凭据边界：probeModel 接线 ───────────────────────────────────────────────
// 全部用假 fetch：测的是「发不发、发到哪、带哪个 key」，不出网。

/** 已保存行：唯一允许复用凭据的目标是 `https://gw.example`。 */
const BOUNDARY_ROW = {
  providers: {
    step: { baseURL: 'https://gw.example/v1', api: 'openai-completions', apiKeyEnv: 'MIASAKI_PROBE_BOUNDARY_KEY' },
  },
};

/** A ctx whose settings resolve BOUNDARY_ROW; `credentials` is optional and counted. */
function boundaryCtx(credentials, row = BOUNDARY_ROW) {
  return {
    settings: { describe: () => [{ ns: NS, value: row }] },
    get: (key) => (key === 'credentials' ? credentials : undefined),
  };
}

/** Count credential-store reads; resolve to `value` (undefined = miss → env fallback). */
function credentialSpy(value) {
  const spy = {
    calls: 0,
    async resolve() { spy.calls += 1; return value === undefined ? undefined : { value }; },
  };
  return spy;
}

/** Replace global fetch for one case; resolves a 401 so the handshake is terminal (one call). */
function fetchSpy(status = 401) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
    return { status, text: async () => '{}' };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('credential boundary: cross-origin draft baseURL + no apiKey sends nothing', async () => {
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'stored-key';
  const credentials = credentialSpy('store-key');
  const fetchStub = fetchSpy();
  try {
    const result = await probeModel(boundaryCtx(credentials), {
      provider: 'step',
      model: 'm',
      baseURL: 'https://attacker.example/v1',
    });
    assert.equal(result.kind, 'no-credential');
    assert.equal(fetchStub.calls.length, 0, '不同源且无显式 key ⇒ 一个请求都不许发');
    assert.equal(credentials.calls, 0, '不同源时连凭据都不该读');
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});

test('credential boundary: same-origin draft reuses the stored credential', async () => {
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'env-key';
  const credentials = credentialSpy('store-key');
  const fetchStub = fetchSpy();
  try {
    const result = await probeModel(boundaryCtx(credentials), {
      provider: 'step',
      model: 'm',
      baseURL: 'https://gw.example/other/v1',
    });
    assert.equal(result.kind, 'unauthorized');
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, 'https://gw.example/other/v1/chat/completions');
    assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer store-key', '凭据存储优先于环境变量');
    assert.equal(credentials.calls, 1);
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});

test('credential boundary: default ports are normalized before the decision', async () => {
  const row = { providers: { step: { baseURL: 'https://gw.example:443/v1', apiKeyEnv: 'MIASAKI_PROBE_BOUNDARY_KEY' } } };
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'env-key';
  const fetchStub = fetchSpy();
  try {
    const result = await probeModel(boundaryCtx(undefined, row), {
      provider: 'step',
      model: 'm',
      baseURL: 'https://gw.example/v2',
    });
    assert.equal(result.kind, 'unauthorized');
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer env-key');
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});

test('credential boundary: a request without baseURL keeps reusing the profile endpoint', async () => {
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'env-key';
  const fetchStub = fetchSpy();
  try {
    const result = await probeModel(boundaryCtx(undefined), { provider: 'step', model: 'm' });
    assert.equal(result.kind, 'unauthorized');
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, 'https://gw.example/v1/chat/completions');
    assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer env-key');
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});

test('credential boundary: an explicit apiKey is sent even to a foreign origin', async () => {
  const credentials = credentialSpy('store-key');
  const fetchStub = fetchSpy();
  try {
    const result = await probeModel(boundaryCtx(credentials), {
      provider: 'step',
      model: 'm',
      baseURL: 'https://attacker.example/v1',
      apiKey: 'draft-key',
    });
    assert.equal(result.kind, 'unauthorized');
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, 'https://attacker.example/v1/chat/completions');
    assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer draft-key');
    assert.equal(credentials.calls, 0, '显式 key 优先，不再读已存凭据');
  } finally {
    fetchStub.restore();
  }
});

test('credential boundary: a draft baseURL with no stored endpoint still needs an explicit key', async () => {
  const row = { providers: { step: { apiKeyEnv: 'MIASAKI_PROBE_BOUNDARY_KEY' } } };
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'env-key';
  const fetchStub = fetchSpy();
  try {
    const result = await probeModel(boundaryCtx(undefined, row), {
      provider: 'step',
      model: 'm',
      baseURL: 'https://gw.example/v1',
    });
    assert.equal(result.kind, 'no-credential', '没有已存 baseURL 就无法证明同源');
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});

test('credential boundary: a ctx without a credentials service still falls back to the environment', async () => {
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'env-key';
  const fetchStub = fetchSpy();
  try {
    // 极简 ctx（离线测试 / 拆解中的 context）：没有 `get` 也不该把探测变成抛错。
    const ctx = { settings: { describe: () => [{ ns: NS, value: BOUNDARY_ROW }] } };
    const result = await probeModel(ctx, { provider: 'step', model: 'm' });
    assert.equal(result.kind, 'unauthorized');
    assert.equal(fetchStub.calls[0].headers.authorization, 'Bearer env-key');
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});

// ── 准入：结构围栏（含端口判据） ───────────────────────────────────────────

const LOOPBACK = { host: '127.0.0.1:3080' };

test('structuralFence: loopback Host without an Origin passes', () => {
  assert.deepEqual(structuralFence(LOOPBACK), { ok: true });
  assert.deepEqual(structuralFence({ host: 'localhost:3080' }), { ok: true });
  assert.deepEqual(fenceRequest(LOOPBACK), { ok: true }, '旧名是新实现的别名');
});

test('structuralFence: untrusted or missing Host is refused', () => {
  for (const headers of [{ host: 'evil.example:3080' }, {}, { host: '' }, { host: '   ' }]) {
    assert.equal(structuralFence(headers).status, 403, JSON.stringify(headers));
  }
});

test('structuralFence: cross-site fetch marker is refused', () => {
  assert.equal(structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'Cross-Site' }).status, 403);
  assert.equal(structuralFence({ ...LOOPBACK, 'sec-fetch-site': 'same-origin' }).ok, true);
});

test('structuralFence: same hostname on a different Origin port is refused', () => {
  const verdict = structuralFence({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:5173' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
  assert.equal(verdict.reason, 'cross-port-origin');
});

test('structuralFence: same-origin port passes; a portless Origin keeps the hostname-only verdict', () => {
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }).ok, true);
  // Chromium 某些构建会剥掉回环 Origin 的端口 —— 空端口时退回 hostname 判定，避免误拒。
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' }).ok, true);
  assert.equal(structuralFence({ host: '127.0.0.1:3080', origin: 'https://127.0.0.1' }).ok, true);
});

test('structuralFence: a Host without an explicit port defaults by the Origin scheme', () => {
  // Origin 的 :80 被 URL 规范化成空端口 ⇒ 沿用 hostname 判定（与剥端口同档）。
  assert.equal(structuralFence({ host: '127.0.0.1', origin: 'http://127.0.0.1:80' }).ok, true);
  // 3080 ≠ 默认 80 ⇒ 拒绝。
  assert.equal(structuralFence({ host: '127.0.0.1', origin: 'http://127.0.0.1:3080' }).status, 403);
});

test('structuralFence: opaque / unparsable / foreign Origin is refused', () => {
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'null' }).status, 403, 'opaque origin');
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'http://evil.example' }).status, 403);
  assert.equal(structuralFence({ ...LOOPBACK, origin: 'not a url' }).status, 403);
});

test('structuralFence: configured trustedHosts extends the Host allowlist', () => {
  assert.equal(structuralFence({ host: 'miasaki.local:3080' }).status, 403);
  assert.equal(structuralFence({ host: 'miasaki.local:3080' }, new Set(['miasaki.local'])).ok, true);
});

// ── 准入：connection.requestRejection 两层 ─────────────────────────────────

test('trustFence: connection verdicts 401/403/undefined win over the structural layer', () => {
  assert.equal(trustFence({ host: 'evil.example' }, { requestRejection: () => 401 }).status, 401);
  assert.equal(trustFence({ host: 'evil.example' }, { requestRejection: () => 401 }).reason, 'unauthorized');
  assert.equal(trustFence({ host: 'evil.example' }, { requestRejection: () => 403 }).status, 403);
  assert.equal(trustFence({ host: 'evil.example' }, { requestRejection: () => undefined }).ok, true);
});

test('trustFence: a throwing or unknown connection verdict falls back to the structural layer', () => {
  const boom = { requestRejection: () => { throw new Error('composition bug'); } };
  assert.equal(trustFence(LOOPBACK, boom).ok, true, '回落到结构层：回环放行');
  assert.equal(trustFence({ host: 'evil.example' }, boom).status, 403, '回落到结构层：非环回照样拦');
  assert.equal(trustFence({ host: 'evil.example' }, { requestRejection: () => 500 }).status, 403, '未知返回值不作放行');
});

test('trustFence: absent connection services fall back to the structural layer', () => {
  for (const connection of [undefined, null, {}]) {
    assert.equal(trustFence(LOOPBACK, connection).ok, true, String(connection));
    assert.equal(trustFence({ host: 'evil.example' }, connection).status, 403);
  }
});

// ── 准入：挂在路由上（端到端，假 webServer / 假 fetch） ────────────────────

/** Boot apply() against a fake webServer; `live` lets one case change the connection mid-flight. */
function bootProbe(options = {}) {
  const routes = new Map();
  const live = { connection: options.connection, credentials: options.credentials };
  apply({
    settings: { describe: () => [{ ns: NS, value: options.row ?? BOUNDARY_ROW }] },
    webServer: { register: (entry) => { routes.set(entry.path, entry.handler); } },
    effect: (fn) => fn(),
    get: (key) => (key === 'connection' ? live.connection : key === 'credentials' ? live.credentials : undefined),
  }, options.config);
  const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
    const handler = routes.get(path);
    assert.notEqual(handler, undefined, `route ${path} must be registered`);
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
      method,
      headers,
      on(event, cb) {
        if (event === 'data' && text !== '') cb(Buffer.from(text));
        if (event === 'end') cb();
        return this;
      },
    };
    const res = {
      status: 0,
      payload: '',
      writeHead(status) { this.status = status; },
      end(chunk) { this.payload = chunk; },
    };
    await handler(req, res);
    return { status: res.status, body: JSON.parse(res.payload) };
  };
  return { call, live };
}

test('route: the fence runs before the method check', async () => {
  const { call } = bootProbe();
  const crossSite = await call('/model-probe-api/health', {
    method: 'POST',
    headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403, '围栏先于 method 检查：跨站应得 403 而非 405');
  const wrongMethod = await call('/model-probe-api/health', { method: 'POST', headers: LOOPBACK });
  assert.equal(wrongMethod.status, 405);
});

test('route: cross-port Origin is refused end-to-end', async () => {
  const { call } = bootProbe();
  const reply = await call('/model-probe-api/health', {
    headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:5173' },
  });
  assert.equal(reply.status, 403);
  assert.equal(reply.body.ok, false);
});

test('route: connection 401 is enforced and read per request (a late provide takes over)', async () => {
  const { call, live } = bootProbe();
  assert.equal((await call('/model-probe-api/health', { headers: LOOPBACK })).status, 200);
  live.connection = { requestRejection: () => 401 };
  assert.equal((await call('/model-probe-api/health', { headers: LOOPBACK })).status, 401, '晚 provide 的 connection 必须当次生效');
  live.connection = undefined;
  assert.equal((await call('/model-probe-api/health', { headers: LOOPBACK })).status, 200);
});

test('route: configured trustedHosts passes the structural fence', async () => {
  const { call } = bootProbe({ config: { trustedHosts: ['miasaki.local'] } });
  const reply = await call('/model-probe-api/health', { headers: { host: 'miasaki.local:3080' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.ok, true);
});

test('route: a cross-origin draft probe target is refused without sending anything', async () => {
  process.env.MIASAKI_PROBE_BOUNDARY_KEY = 'stored-key';
  const fetchStub = fetchSpy();
  try {
    const { call } = bootProbe();
    const reply = await call('/model-probe-api/probe', {
      method: 'POST',
      headers: LOOPBACK,
      body: { provider: 'step', model: 'm', baseURL: 'https://attacker.example/v1' },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ok, true, '外层 ok 表示探测执行了');
    assert.deepEqual(reply.body.result, {
      ok: false,
      kind: 'no-credential',
      api: 'openai-completions',
      apiKeyEnv: 'MIASAKI_PROBE_BOUNDARY_KEY',
    });
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
    delete process.env.MIASAKI_PROBE_BOUNDARY_KEY;
  }
});
