/**
 * dsh-model-probe — host half.
 *
 * Answers ONE question for the settings page's「测试连通性」button: can this
 * model actually be talked to? It registers /model-probe-api/* on the DSH
 * webServer so the patched official Models page can ask over same-origin HTTP.
 *
 * Why not typert remote: `llm.registerModelDiscovery()` refuses a second
 * registration for a namespace it already serves (`DUPLICATE_DISCOVERY`), so
 * the official catalog probe cannot be taken over; and adding a remote method
 * would mean patching the `dsh-llm` service class itself. A host route is the
 * shape this repo already ships four times (see dsh-miasaki-free-model),
 * needs no build step, and is same-origin from the browser.
 *
 * Division of labour with the client patch:
 *   - host (here): credentials, URL construction, the two-stage probe, the
 *     trust fence, redaction. Never returns a credential.
 *   - client (patched client.js): decides to call this, renders the kind as
 *     localized copy, and falls back to the v1 catalog probe when this plugin
 *     is absent (HTTP 404) so the button is never dead.
 *
 * @module dsh-model-probe
 */

import {
  BODY_LIMIT,
  DEFAULT_TIMEOUT_MS,
  PROBE_PROTOCOLS,
  buildProbeRequest,
  classifyStatus,
  isProbeable,
  redactSecret,
  sameOrigin,
  shouldContinueToGenerate,
  summarizeDetail,
} from './probe.js';
import { readSettingsSection } from './settings-read.js';

// 凭据边界判定（纯逻辑，住在 probe.js）：同源才允许复用已存凭据。导出以便单测直接打。
export { sameOrigin };

const NS = 'llm-pi-ai';
const HEALTH_PATH = '/model-probe-api/health';
const PROBE_PATH = '/model-probe-api/probe';
const CAPABILITIES_PATH = '/model-probe-api/capabilities';
const PLUGIN_VERSION = '0.2.1';

/** A request body beyond this is refused before parsing — the client only ever sends a few fields. */
const MAX_BODY_BYTES = 64 * 1024;
/** Upper bound for one batch capability query — a provider catalog is small, and the loop is sequential. */
const MAX_CAPABILITY_MODELS = 200;

export const name = 'model-probe';
export const inject = ['settings', 'webServer'];

/**
 * Host/host:port fence for the /model-probe-api routes (mirrors the sidebar and
 * canvas plugins): the DSH /api browser-trust fence does not cover plugin
 * routes, so without this any page that resolves to 127.0.0.1 could make the
 * host spend a model call. These checks are defense in depth, not
 * authentication — the probe has no side effects beyond one bounded request.
 * @param config - plugin config carrying optional extra authorities.
 * @returns the trusted hostname set.
 */
function trustedHostSet(config) {
  const extra = Array.isArray(config?.trustedHosts) ? config.trustedHosts : [];
  return new Set(['localhost', '127.0.0.1', ...[...extra].map((host) => String(host).trim().toLowerCase()).filter(Boolean)]);
}

/**
 * The port named by a `Host` header, defaulted from the Origin scheme when the
 * header carries no explicit port (browsers omit the default one).
 * @param rawHost - the raw `Host` header value (`host` or `host:port`, IPv6 bracketed).
 * @param originProtocol - the parsed Origin protocol (`http:` or `https:`).
 * @returns the port as a string.
 */
function hostPortOf(rawHost, originProtocol) {
  const explicit = /:(\d+)$/.exec(rawHost);
  if (explicit !== null) return String(Number(explicit[1]));
  return originProtocol === 'https:' ? '443' : '80';
}

/**
 * The structural browser-trust fence: ① Host must be loopback or configured;
 * ② the browser's own cross-site verdict is refused; ③ a present Origin must
 * name our hostname (hostname, not authority — `null` = opaque, refused) and,
 * when it carries an explicit port, the same port as the `Host` header.
 *
 * The port rule is the 2026-10-19 fix for a cross-port page
 * (`http://127.0.0.1:5173` served on another local port) passing the hostname
 * check: a non-empty `Origin` port that differs from the request's `Host` port
 * is now refused. Chromium strips the default port from `Origin` on some
 * builds; an empty `Origin` port therefore keeps the old hostname-only verdict
 * so a legitimate same-origin request is not falsely rejected.
 * @param headers - the incoming request headers.
 * @param trusted - trusted hostname set; defaults to the built-in loopback set.
 * @returns `{ok:true}` or `{ok:false, status, error, reason}`.
 */
export function structuralFence(headers, trusted) {
  const allowed = trusted instanceof Set ? trusted : trustedHostSet(null);
  const rawHost = typeof headers?.host === 'string' ? headers.host : '';
  const hostname = rawHost.replace(/:\d+$/, '').toLowerCase();
  if (!allowed.has(hostname)) return { ok: false, status: 403, error: '不被信任的 Host', reason: 'untrusted-host' };
  if (String(headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, error: '跨站请求被拒绝', reason: 'cross-site' };
  }
  const origin = headers?.origin;
  if (typeof origin === 'string' && origin.trim() !== '') {
    let parsed = null;
    try { parsed = new URL(origin.trim()); } catch { parsed = null; }
    const originHostname = parsed === null ? null : parsed.hostname.toLowerCase();
    if (originHostname === null || originHostname !== hostname) {
      return { ok: false, status: 403, error: '跨站来源被拒绝', reason: 'cross-origin' };
    }
    // `URL.port` is '' both for「no explicit port」and for a default port the
    // parser normalized away — both keep the hostname-only verdict (compat).
    if (parsed.port !== '' && parsed.port !== hostPortOf(rawHost, parsed.protocol)) {
      return { ok: false, status: 403, error: '跨端口来源被拒绝', reason: 'cross-port-origin' };
    }
  }
  return { ok: true };
}

/**
 * The old export name of the structural fence. `lib/index.d.ts` publishes it,
 * so keeping the name preserves the package's exported API; new code may use
 * either name (`structuralFence` matches the sibling plugins' wording).
 */
export const fenceRequest = structuralFence;

/**
 * The two-layer admission fence used by every /model-probe-api route.
 *
 * The exact routes never pass through the harness `/api` admission chain, so
 * they must reproduce it: when the composition provides `connection` (and its
 * `requestRejection`), its verdict wins — 401/403 refused, `undefined` allowed,
 * anything else falls back to the structural layer (a malformed verdict must
 * not open the door). The `connection` service may be provided after this
 * plugin loads, so callers must read it **per request**; a snapshot taken in
 * `apply()` would silently downgrade the fence for the whole process lifetime.
 * @param headers - the incoming request headers.
 * @param connection - the per-request `ctx.get('connection')` value.
 * @param trusted - trusted hostname set for the structural fallback.
 * @returns `{ok:true}` or `{ok:false, status, error, reason}`.
 */
export function trustFence(headers, connection, trusted) {
  if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers });
      if (rejection === 401) return { ok: false, status: 401, error: '未通过浏览器鉴权', reason: 'unauthorized' };
      if (rejection === 403) return { ok: false, status: 403, error: '请求来源不被信任', reason: 'forbidden' };
      if (rejection === undefined) return { ok: true };
    } catch {
      // connection 抛错属 composition 缺陷：退回结构层，而不是让每个请求 500。
    }
  }
  return structuralFence(headers, trusted);
}

/** Reply JSON with a stable envelope; never leaks internal objects. */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/** Read one JSON body from an IncomingMessage, bounded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** A trimmed non-empty string, or null. */
function pickString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** A readable message from an unknown thrown value. */
function safeMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error);
}

/**
 * Read an optional service (`credentials` / `llm` / `connection`) without letting
 * a host that lacks it — or a context mock that has no `get` — turn the probe
 * into an error page. Real cordis contexts always expose `get`; the `typeof`
 * guard only covers offline tests and torn-down contexts.
 * @param ctx - plugin context.
 * @param name - service name.
 * @returns the service, or undefined when unavailable.
 */
function optionalService(ctx, name) {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined; } catch { return undefined; }
}

/**
 * The stored llm-pi-ai profile for one provider route.
 *
 * The read is dual-track (lib/settings-read.js): 0.1.7 removed
 * `ctx.settings.get(ns)`, so the stored profile now comes from the profile
 * entry config projected by `describe()`. The try/catch stays — a settings
 * hiccup must degrade the probe to its request-supplied fields, never throw.
 * @param ctx - plugin context.
 * @param provider - the route key.
 * @returns the profile object, or null when unknown.
 */
function resolveProfile(ctx, provider) {
  const route = pickString(provider);
  if (route === null) return null;
  let section = null;
  try { section = readSettingsSection(ctx, NS); } catch { section = null; }
  const providers = section && typeof section === 'object' ? (section.providers || {}) : {};
  const profile = providers[route];
  return profile && typeof profile === 'object' ? profile : null;
}

/**
 * The credential for one environment-style reference.
 *
 * The harness credential store comes first — that is where the Models page
 * writes a key (`.credentials.yaml`), and the process environment is only the
 * launcher-supplied fallback. `credentials` is resolved through `ctx.get`
 * rather than `inject` so the probe still works on a host that runs without
 * that service.
 * @param ctx - plugin context.
 * @param apiKeyEnv - the reference name from the provider profile.
 * @returns the key, or null when unset.
 */
async function resolveCredential(ctx, apiKeyEnv) {
  const ref = pickString(apiKeyEnv);
  if (ref === null) return null;
  const credentials = optionalService(ctx, 'credentials');
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref);
      const value = hit && typeof hit.value === 'string' ? hit.value : null;
      if (value !== null && value.length > 0) return value;
    } catch { /* fall through to the environment */ }
  }
  const fromEnv = process.env[ref];
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null;
}

/** Read a bounded, redacted response body. */
async function readText(response, apiKey) {
  try {
    const raw = await response.text();
    return redactSecret(raw.slice(0, BODY_LIMIT), apiKey);
  } catch { return ''; }
}

/**
 * One stage of the probe: send the planned request, classify the reply.
 * @param options - protocol, base, model, key, stage, timeout.
 * @returns the classified stage result.
 */
async function sendOnce({ api, baseURL, model, apiKey, stage, timeoutMs }) {
  const spec = buildProbeRequest({ api, baseURL, model, apiKey, stage });
  if (spec === null) return { ok: false, kind: 'unsupported', stage, api };
  const started = Date.now();
  try {
    const response = await fetch(spec.url, {
      method: 'POST',
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    const text = await readText(response, apiKey);
    const kind = classifyStatus(response.status, text);
    return {
      ok: kind === 'ok',
      kind,
      status: response.status,
      latencyMs,
      stage,
      endpoint: spec.url,
      ...(text.length === 0 ? {} : { detail: summarizeDetail(text, apiKey) }),
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const timedOut = error !== null && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      ok: false,
      kind: timedOut ? 'timeout' : 'unreachable',
      latencyMs,
      stage,
      endpoint: spec.url,
      detail: summarizeDetail(safeMessage(error), apiKey),
    };
  }
}

/**
 * The two-stage probe for one model.
 *
 * The handshake is free by construction (see probe.js): it is only allowed to
 * continue when the endpoint refused the request on its shape, which is proof
 * that the credential was accepted. A 401 therefore ends the probe with zero
 * tokens spent — the property that makes this safe to click repeatedly.
 *
 * Credential boundary (2026-10-19, P1): the stored credential is re-used only
 * when the request does not carry its own draft `baseURL` (so the target is the
 * stored profile endpoint) or when that draft is **same-origin** with the
 * profile's baseURL. A draft pointing anywhere else must carry its own
 * `apiKey`; otherwise the probe answers `no-credential` and sends **nothing**.
 * Before this, any page that could reach the exact route could attach the
 * user's saved key to a destination of its choosing and use the probe as a
 * credential-carrying SSRF primitive.
 * @param ctx - plugin context.
 * @param request - provider / model / optional draft baseURL, api, apiKey.
 * @returns the probe result in the shared vocabulary.
 */
export async function probeModel(ctx, request) {
  const model = pickString(request?.model);
  if (model === null) return { ok: false, kind: 'no-model' };

  const profile = resolveProfile(ctx, request?.provider);
  const requestBaseURL = pickString(request?.baseURL);
  const profileBaseURL = pickString(profile && profile.baseURL);
  const baseURL = requestBaseURL ?? profileBaseURL;
  const api = pickString(request?.api) ?? pickString(profile && profile.api) ?? 'openai-completions';
  if (baseURL === null) return { ok: false, kind: 'no-endpoint' };
  if (!isProbeable(api)) return { ok: false, kind: 'unsupported', api };

  // 凭据边界：请求自带 baseURL 且与 profile 不同源 ⇒ 不许复用已存凭据。
  const mayReuseCredential = requestBaseURL === null || sameOrigin(requestBaseURL, profileBaseURL);
  const supplied = pickString(request?.apiKey);
  let apiKey = supplied;
  if (apiKey === null && mayReuseCredential) apiKey = await resolveCredential(ctx, profile && profile.apiKeyEnv);
  if (apiKey === null) return { ok: false, kind: 'no-credential', api, apiKeyEnv: pickString(profile && profile.apiKeyEnv) };

  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const handshake = await sendOnce({ api, baseURL, model, apiKey, stage: 'handshake', timeoutMs });
  if (!shouldContinueToGenerate(handshake.kind)) return handshake;

  return sendOnce({ api, baseURL, model, apiKey, stage: 'generate', timeoutMs });
}

/**
 * The badge facts for one resolved model entry.
 *
 * Reads the SAME truth source the composer picker and the dual-model vision
 * route read (`llm.resolveModelInfo`): an explicit `image` modality means the
 * model accepts images, an adapter-declared `reasoning` block means it has
 * selectable effort levels. Absent metadata stays `false` — the page shows no
 * badge rather than a guess. Pure so the decision table is unit-testable.
 * @param info - one resolved model info, or anything a broken adapter returned.
 * @returns `{ image, reasoning }`.
 */
export function capabilityFlags(info) {
  const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : [];
  const reasoning = info !== null && info !== undefined && info.reasoning !== undefined && info.reasoning !== null;
  return {
    image: modalities.some((modality) => modality === 'image'),
    reasoning,
  };
}

/**
 * Batch capability query for the patched Models page badges.
 *
 * Costs nothing per model (adapter-local resolution, no provider call) and
 * never needs a credential: capabilities are declared in the route's own
 * catalog, not behind auth. `llm` is read through `ctx.get` so the probe
 * routes keep working on a host without it — the badges simply stay absent,
 * exactly like the 404 fallback when this whole plugin is missing.
 * @param ctx - plugin context.
 * @param request - `{ provider, models: [...] }`.
 * @returns `{ models: { [id]: { image, reasoning } } }`.
 */
export async function describeCapabilities(ctx, request) {
  const provider = pickString(request?.provider);
  const ids = Array.isArray(request?.models)
    ? request.models.map(pickString).filter((id) => id !== null).slice(0, MAX_CAPABILITY_MODELS)
    : [];
  const llm = optionalService(ctx, 'llm');
  if (provider === null || ids.length === 0 || !llm || typeof llm.resolveModelInfo !== 'function') return { models: {} };
  const models = {};
  for (const id of ids) {
    try {
      models[id] = capabilityFlags(await llm.resolveModelInfo(provider, id));
    } catch {
      models[id] = { image: false, reasoning: false };
    }
  }
  return { models };
}

/**
 * Register the routes once the webServer is up.
 *
 * `inject: ['settings', 'webServer']` is what makes that ordering a guarantee:
 * reading the server through `ctx.get` without declaring it would let an
 * activation race silently skip registration — which surfaces to the user as a
 * 404 and (thanks to the client fallback) a quietly weaker probe.
 * @param ctx - plugin context.
 * @param config - optional `trustedHosts`.
 */
export function apply(ctx, config) {
  const trusted = trustedHostSet(config);

  const register = (path, method, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        // 准入两层（2026-10-19）：exact 路由不经过内核 `/api` 准入链，所以这里
        // 复刻它 —— connection 的 `requestRejection` 优先（逐请求读取：该服务可能
        // 晚 provide，apply 时快照会让围栏整轮退化成结构层），缺席/抛错/给出其他值
        // 时退回结构围栏。围栏排在 method 检查与业务之前。
        const fence = trustFence(req.headers, optionalService(ctx, 'connection'), trusted);
        if (!fence.ok) { sendJson(res, fence.status, { ok: false, error: fence.error }); return; }
        if (req.method !== method) { sendJson(res, 405, { ok: false, error: `需要 ${method}` }); return; }
        try {
          sendJson(res, 200, { ok: true, ...(await handler(req)) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: safeMessage(error) });
        }
      },
    }), `model-probe: ${path}`);
  };

  // Readiness contract for the client patch and for manual checks: seeing
  // `ok: true` here means the routes are live, so a fallback to the catalog
  // probe afterwards is the endpoint's fault, not a missing plugin.
  register(HEALTH_PATH, 'GET', async () => ({
    version: PLUGIN_VERSION,
    protocols: [...PROBE_PROTOCOLS],
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }));

  // The envelope deliberately separates the two questions: the outer `ok` means
  // "the probe ran", the inner `result.ok` means "the model is usable". The
  // client must be able to tell a broken plugin (HTTP 404) from a model that
  // answered 401 — collapsing them would rebuild the v1 bug in a new place.
  register(PROBE_PATH, 'POST', async (req) => ({ result: await probeModel(ctx, await readBody(req)) }));

  // Badge data for the patched Models page: image / reasoning per model id,
  // resolved from the same llm service the composer picker reads. A host
  // without `llm` answers with an empty map, and the client renders no badge
  // — degradation, never an error page.
  register(CAPABILITIES_PATH, 'POST', async (req) => describeCapabilities(ctx, await readBody(req)));
}
