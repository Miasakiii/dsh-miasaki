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
 * shape this repo already ships four times (see plugins/dsh-free-model-pool),
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
  shouldContinueToGenerate,
  summarizeDetail,
} from './probe.js';

const NS = 'llm-pi-ai';
const HEALTH_PATH = '/model-probe-api/health';
const PROBE_PATH = '/model-probe-api/probe';
const CAPABILITIES_PATH = '/model-probe-api/capabilities';
const PLUGIN_VERSION = '0.2.0';

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
 * The three-layer browser-trust fence: ① Host must be loopback or configured;
 * ② the browser's own cross-site verdict is refused; ③ a present Origin must
 * name our hostname (hostname, not authority — some Chromium builds strip a
 * non-default loopback port; `null` = opaque, refused).
 * @param headers - the incoming request headers.
 * @param trusted - trusted hostname set.
 * @returns `{ok:true}` or `{ok:false, status, error}`.
 */
export function fenceRequest(headers, trusted) {
  const hostname = (typeof headers.host === 'string' ? headers.host : '').replace(/:\d+$/, '').toLowerCase();
  if (!trusted.has(hostname)) return { ok: false, status: 403, error: '不被信任的 Host' };
  if (headers['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, error: '跨站请求被拒绝' };
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originHostname = null;
    try { originHostname = new URL(origin).hostname.toLowerCase(); } catch { originHostname = null; }
    if (originHostname === null || originHostname !== hostname) return { ok: false, status: 403, error: '跨站来源被拒绝' };
  }
  return { ok: true };
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
 * The stored llm-pi-ai profile for one provider route.
 * @param ctx - plugin context.
 * @param provider - the route key.
 * @returns the profile object, or null when unknown.
 */
function resolveProfile(ctx, provider) {
  const route = pickString(provider);
  if (route === null) return null;
  let section = null;
  try { section = ctx.settings.get(NS); } catch { section = null; }
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
  const credentials = ctx.get('credentials');
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
 * @param ctx - plugin context.
 * @param request - provider / model / optional draft baseURL, api, apiKey.
 * @returns the probe result in the shared vocabulary.
 */
export async function probeModel(ctx, request) {
  const model = pickString(request?.model);
  if (model === null) return { ok: false, kind: 'no-model' };

  const profile = resolveProfile(ctx, request?.provider);
  const baseURL = pickString(request?.baseURL) ?? pickString(profile && profile.baseURL);
  const api = pickString(request?.api) ?? pickString(profile && profile.api) ?? 'openai-completions';
  if (baseURL === null) return { ok: false, kind: 'no-endpoint' };
  if (!isProbeable(api)) return { ok: false, kind: 'unsupported', api };

  const supplied = pickString(request?.apiKey);
  const apiKey = supplied ?? await resolveCredential(ctx, profile && profile.apiKeyEnv);
  if (apiKey === null) return { ok: false, kind: 'no-credential', api, apiKeyEnv: pickString(profile && profile.apiKeyEnv) };

  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const handshake = await sendOnce({ api, baseURL, model, apiKey, stage: 'handshake', timeoutMs });
  if (!shouldContinueToGenerate(handshake.kind)) return handshake;

  return sendOnce({ api, baseURL, model, apiKey, stage: 'generate', timeoutMs });
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
  const llm = ctx.get('llm');
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

export function apply(ctx, config) {
  const trusted = trustedHostSet(config);

  const register = (path, method, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const fence = fenceRequest(req.headers, trusted);
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
