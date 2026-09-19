/**
 * dsh-model-probe — probe planning & classification (pure logic).
 *
 * The settings page's「测试连通性」button asks one question: *can this model
 * actually be talked to?* Answering it means sending a real request to the
 * provider endpoint — but paying as little as possible for the answer, and
 * never mistaking "this gateway does not list models" for "this model is dead"
 * (the v1 catalog probe's failure mode).
 *
 * Two stages, in order:
 *   ① handshake — a request the endpoint must reject on PARAMETERS (empty
 *      `messages`). Gateways authenticate before validating, so the reply
 *      separates "key is bad" (401/403) from "key is fine, endpoint is there"
 *      (400) at ZERO token cost.
 *   ② generate — max_tokens=1 with a one-word prompt. Only reached once ①
 *      proved authentication, so a bad key never spends anything.
 *
 * This module holds no I/O and no context: URL/body construction, status
 * classification and secret redaction are pure so `node --test` can cover the
 * whole decision table without a network.
 *
 * @module dsh-model-probe/probe
 */

/** Protocols this plugin knows how to talk to. Others report `unsupported`. */
export const PROBE_PROTOCOLS = ['anthropic-messages', 'openai-completions', 'openai-responses'];

/** Default per-request budget. Long enough for a distant gateway, short enough to feel like a button. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** Bytes read off a response before parsing — a hostile endpoint cannot stream the host to death. */
export const BODY_LIMIT = 4096;

/** Response bodies are diagnostic only; never let one flood the UI. */
const DETAIL_LIMIT = 300;

/** Anthropic Messages requires this header on every call. */
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The Anthropic conversation root for one configured baseURL.
 *
 * Gateway documentation publishes both `https://gw.example` and
 * `https://gw.example/v1` as the same base, and the real client (`@anthropic-ai/sdk`,
 * which pi-ai drives for this protocol) appends `/v1/messages` to whatever root it
 * is given. Stripping one trailing `/v1` makes both spellings reach the same
 * endpoint — the same normalization `dsh-llm-pi-ai`'s `listingUrl()` applies to
 * model discovery, kept identical on purpose: a probe that builds a different URL
 * than the conversation path would answer a question nobody asked.
 * @param baseURL - the configured API base.
 * @returns the root, without trailing slashes.
 */
export function messagesRoot(baseURL) {
  const base = String(baseURL ?? '').replace(/\/+$/, '');
  return base.endsWith('/v1') ? base.slice(0, -3) : base;
}

/**
 * Whether one provider protocol can be probed at all.
 * @param api - the configured protocol id.
 * @returns true when a request can be built for it.
 */
export function isProbeable(api) {
  return PROBE_PROTOCOLS.includes(String(api ?? ''));
}

/**
 * The wire request for one stage.
 *
 * Stage bodies differ ONLY in the parameter that the endpoint is expected to
 * reject: `messages: []` (Anthropic and OpenAI chat) or `input: ''` (Responses)
 * is invalid on purpose. A gateway that answers 400 has authenticated us and
 * validated the body; one that answers 401 never looked at the body at all.
 * @param options - protocol, endpoint base, model id, credential, and stage.
 * @returns the planned request, or `null` when the protocol is not probeable.
 */
export function buildProbeRequest({ api, baseURL, model, apiKey, stage }) {
  const protocol = String(api ?? '');
  if (!isProbeable(protocol)) return null;
  const generate = stage === 'generate';
  const base = String(baseURL ?? '').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };

  if (protocol === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (typeof apiKey === 'string' && apiKey.length > 0) headers['x-api-key'] = apiKey;
    return {
      url: `${messagesRoot(base)}/v1/messages`,
      headers,
      body: {
        model,
        max_tokens: 1,
        messages: generate ? [{ role: 'user', content: 'ping' }] : [],
      },
    };
  }

  if (typeof apiKey === 'string' && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

  if (protocol === 'openai-responses') {
    return {
      url: `${base}/responses`,
      headers,
      body: { model, max_output_tokens: 16, input: generate ? 'ping' : '' },
    };
  }

  // openai-completions
  return {
    url: `${base}/chat/completions`,
    headers,
    body: {
      model,
      max_tokens: 1,
      messages: generate ? [{ role: 'user', content: 'ping' }] : [],
    },
  };
}

/**
 * Whether a refusal body names the MODEL as the problem (rather than the request shape).
 *
 * Both orders count, because gateways phrase it either way: `model "x" does not
 * exist` names the model first, `invalid model` names the verdict first. The
 * window is 40 characters because a real message quotes the id between the two
 * words (`The model \`gpt-x\` does not exist`), and quoting an id that may contain
 * letters is exactly what a `[^a-z]` window gets wrong.
 *
 * The check keys on the literal words "model"/"模型" only. That is what keeps a
 * parameter refusal like `messages: at least one message is required` out of
 * this class — it talks about messages, not models, and misreading it would
 * report a healthy model as missing.
 * @param text - the response body.
 * @returns true when the endpoint blames the model id.
 */
export function looksLikeMissingModel(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const subject = 'model|模型';
  const verdict = "not\\s+found|not\\s+exist|does\\s+not\\s+exist|doesn'?t\\s+exist|no\\s+such|unknown|invalid|unsupported|unavailable|不存在|未找到|无效|不支持";
  const forward = new RegExp(`(?:${subject})[^\\n]{0,40}(?:${verdict})`, 'i');
  const backward = new RegExp(`(?:${verdict})[^\\n]{0,40}(?:${subject})`, 'i');
  return forward.test(text) || backward.test(text);
}

/**
 * Map one HTTP reply onto the result vocabulary the settings page renders.
 *
 * The table is total: every status lands somewhere, so the button can always
 * say something truer than a raw status line. 401/403 need no body inspection —
 * on every gateway that answers them, the credential is what failed; reading
 * the body to "confirm" would only invent a second opinion. `detail` carries
 * the endpoint's own words for the user who wants to dig.
 * @param status - HTTP status code.
 * @param bodyText - the response body, already redacted.
 * @returns the classification kind.
 */
export function classifyStatus(status, bodyText) {
  const code = Number(status);
  if (code === 200) return 'ok';
  if (code === 401 || code === 403) return 'unauthorized';
  if (code === 402) return 'quota';
  if (code === 429) return 'rate-limited';
  if (code === 404) return looksLikeMissingModel(bodyText) ? 'model-missing' : 'not-found';
  if (code === 400 || code === 422) return looksLikeMissingModel(bodyText) ? 'model-missing' : 'bad-request';
  if (code >= 500) return 'server-error';
  return 'unknown';
}

/**
 * Remove anything key-shaped from a diagnostic string.
 *
 * Two independent passes because a leaked credential can arrive either as the
 * exact key we sent (echoed by a verbose gateway) or as a different secret the
 * endpoint decided to quote back at us.
 * @param text - raw diagnostic text.
 * @param secret - the credential this probe used, if any.
 * @returns text safe to return to the browser.
 */
export function redactSecret(text, secret) {
  let out = typeof text === 'string' ? text : '';
  if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('***');
  return out
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '***')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, (match) => (/^[0-9]+$/.test(match) ? match : '***'));
}

/**
 * One-line diagnostic excerpt for the UI, redacted and bounded.
 * @param text - raw body text.
 * @param secret - the credential this probe used, if any.
 * @returns a bounded, redacted excerpt.
 */
export function summarizeDetail(text, secret) {
  const redacted = redactSecret(text, secret).replace(/\s+/g, ' ').trim();
  return redacted.length > DETAIL_LIMIT ? `${redacted.slice(0, DETAIL_LIMIT)}…` : redacted;
}

/**
 * Decide the next move after the handshake reply.
 *
 * Only two outcomes continue to the paid stage: an explicit parameter refusal
 * (400/422 — the endpoint authenticated us and read the body), and an
 * unexpected 2xx (an endpoint lax enough to accept an empty conversation).
 * Everything else is terminal, which is what keeps a broken key free. A
 * handshake that already named the model as missing is terminal too: paying for
 * a generate request cannot change that answer.
 * @param kind - the handshake classification.
 * @returns whether to send the generate request.
 */
export function shouldContinueToGenerate(kind) {
  return kind === 'bad-request' || kind === 'ok';
}
