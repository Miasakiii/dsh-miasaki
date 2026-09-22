/**
 * Decision-table coverage for the probe's pure half. Every assertion here is
 * about a rule that has bitten or could bite a real gateway: the double `/v1`
 * spelling, the empty-conversation handshake, the model-vs-request refusal
 * split, and redaction.
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
  shouldContinueToGenerate,
  summarizeDetail,
} from '../lib/probe.js';
import { capabilityFlags } from '../lib/index.js';

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
