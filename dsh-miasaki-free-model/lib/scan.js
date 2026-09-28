/**
 * @miasaki/dsh-free-model — 来源 A：经官方 `llm` 服务枚举本机已注册的 provider 路由。
 *
 * 为什么走这条路而不是读对方插件的私有路由：一个 DSH 插件只要注册了适配器，
 * 它的 provider 路由就出现在 `llm.listProviders()` 里，模型与元数据经
 * `llm.listModels()` / `llm.resolveModelInfo()` 可得。于是免 Key 车道
 * （如 `dsh-our-free-model`）与自配平台**在同一个抽象下同构** ——
 * 本线不需要它的任何私有接口、不读它的存储、也不改变它的任何对外承诺。
 *
 * 三条纪律：
 *   1. **逐 provider 隔离**：一个平台挂了不影响其它平台（失败进 `partial[]`，不整体失败）。
 *   2. **逐调用超时**：`listModels` / `resolveModelInfo` 都可能被远端拖住，
 *      每个都有独立上限；超时按"这个 provider 没扫到"处理，不拖死整轮请求。
 *   3. **缓存 + 手动刷新**：`resolveModelInfo` 是逐模型的，一轮扫描会打 N 次；
 *      结果缓存在调用方持有的 Map 里，`refresh` 时清空。
 *
 * 免费判定（来源 A，命中即算）：
 *   - **L0 provider 级**：路由 id 或显示名命中 `/free/i` ⇒ 疑似"免 Key 车道"，
 *     整路由的模型都标为免费。**不硬编码任何插件名** —— 任何免 Key 车道都适用，
 *     第三方改名也不会让规则失效。
 *   - **L1 模型级**：id 以 `:free`（OpenRouter 方言）或 `-free`（免 Key 清单方言）结尾。
 * L0 命中的来源在 UI 上单独分组、且**默认不可写入**配置（免 Key 车道靠上游指纹计额度，
 * 用普通 provider 接入拿不到）。
 *
 * @module @miasaki/dsh-free-model/scan
 */

import { buildProfile } from './profile.js';

/** provider 级免 Key 车道的判定正则。 */
const FREE_LANE_RE = /free/i;
/** 模型级免费后缀：`:free`（OpenRouter）与 `-free`（免 Key 清单）。 */
const FREE_ID_SUFFIX_RE = /(:free|-free)$/i;

/** 已知的编码类模型特征。 */
const CODE_RE = /code|codex|north-mini/i;
/** 预览/临时模型特征。 */
const PREVIEW_RE = /preview|beta|nightly|dev/i;

/** provider 是否是"疑似免 Key 车道"（L0）。 */
export function freeLaneOf(provider) {
  const id = String(provider?.id ?? '');
  const name = String(provider?.name ?? '');
  return FREE_LANE_RE.test(id) || FREE_LANE_RE.test(name);
}

/** 模型 id 的免费后缀依据（L1），不命中返回 null。 */
export function freeIdReason(id) {
  return FREE_ID_SUFFIX_RE.test(String(id ?? '')) ? 'id 以 :free / -free 结尾' : null;
}

/** 来源 A 的免费依据：L0 整路由优先，其次 L1 后缀；都不命中返回 null。 */
export function adapterFreeReason(provider, model) {
  if (freeLaneOf(provider)) {
    return `provider「${provider.name || provider.id}」判定为免 Key 车道（L0）`;
  }
  return freeIdReason(model?.id);
}

/** 把官方模型元数据折算成与端点来源同形的画像。 */
export function adapterProfile(model, resolved) {
  const modalities = Array.isArray(resolved?.inputModalities) && resolved.inputModalities.length > 0
    ? resolved.inputModalities
    : (Array.isArray(model?.inputModalities) ? model.inputModalities : []);
  const efforts = resolved?.reasoning?.efforts;
  const idText = String(model?.id ?? '');
  const label = String(model?.name ?? model?.id ?? '');
  return buildProfile({
    modality: modalities.length > 0 ? `${modalities.join('+')}->text` : 'text->text',
    // 适配器自述**不提供** supported_parameters：工具能力未知，不假设。
    hasTools: false,
    hasToolChoice: false,
    toolsUnknown: true,
    hasReasoning: Array.isArray(efforts) && efforts.length > 0,
    hasStructured: false,
    hasVision: modalities.includes('image'),
    hasAudio: false,
    isCodeModel: CODE_RE.test(idText) || /code/i.test(label),
    contextWindow: Number(resolved?.context?.contextWindow ?? 0) || 0,
    maxOutput: Number(resolved?.defaultMaxTokens ?? 0) || 0,
    isPreview: PREVIEW_RE.test(idText) || /预览|测试/i.test(label),
    source: 'adapter',
  });
}

/** 一个来源 A 的模型条目（形状与来源 B 的 `describeModel + profile` 对齐）。 */
export function adapterEntry(provider, model, resolved, freeReason) {
  const modalities = Array.isArray(resolved?.inputModalities) ? resolved.inputModalities
    : (Array.isArray(model?.inputModalities) ? model.inputModalities : []);
  return {
    id: model.id,
    name: model.name || model.id,
    provider: provider.id,
    providerName: provider.name || provider.id,
    source: 'adapter',
    writable: false,
    freeReason,
    contextWindow: Number(resolved?.context?.contextWindow ?? 0) || null,
    maxTokens: Number(resolved?.defaultMaxTokens ?? 0) || null,
    supported: modalities.join(','),
    profile: adapterProfile(model, resolved),
  };
}

/** 给一个 promise 套独立超时；超时即按"这个调用没结果"处理。 */
function withTimeout(value, ms, label) {
  const budget = Number(ms);
  if (!Number.isFinite(budget) || budget <= 0) return Promise.resolve(value);
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${budget}ms）`)), budget);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 错误对象 → 可读字符串。 */
function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

/** 逐模型解析元数据，带调用方持有的缓存（失败也缓存 null，刷新时清空）。 */
async function resolveCached(llm, provider, modelId, options) {
  const key = `${provider}\u0000${modelId}`;
  if (options.cache.has(key)) return options.cache.get(key);
  let resolved = null;
  try {
    resolved = await withTimeout(
      llm.resolveModelInfo(provider, modelId),
      options.timeoutMs,
      `resolveModelInfo(${provider}/${modelId})`,
    );
  } catch {
    resolved = null;
  }
  options.cache.set(key, resolved ?? null);
  return resolved ?? null;
}

/**
 * 扫描所有已注册的 provider 路由（来源 A）。
 *
 * @param {object|undefined} llm - `ctx.get('llm')` 的结果；缺席时返回 `available: false`。
 * @param {object} [options]
 * @param {Map} [options.cache] - 跨请求复用的解析缓存。
 * @param {boolean} [options.refresh] - 先清空缓存再扫。
 * @param {string} [options.provider] - 只扫这一个路由键（省略 = 全部）。
 * @param {number} [options.timeoutMs] - 单次调用的超时上限（默认 15s）。
 * @param {number} [options.resolveLimit] - 每个 provider 最多解析多少个模型（默认 200）。
 * @returns {Promise<{available:boolean, sources:object[], models:object[], partial:object[]}>}
 */
export async function scanAdapterProviders(llm, options = {}) {
  const settings = {
    cache: options.cache instanceof Map ? options.cache : new Map(),
    refresh: options.refresh === true,
    provider: typeof options.provider === 'string' && options.provider !== '' ? options.provider : null,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000,
    resolveLimit: Number.isFinite(options.resolveLimit) ? options.resolveLimit : 200,
  };
  if (settings.refresh) settings.cache.clear();

  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { available: false, sources: [], models: [], partial: [] };
  }

  let providers;
  try {
    providers = await withTimeout(llm.listProviders(), settings.timeoutMs, 'listProviders');
  } catch (error) {
    return {
      available: false,
      sources: [],
      models: [],
      partial: [{ source: 'llm.listProviders', error: messageOf(error) }],
    };
  }

  const sources = [];
  const models = [];
  const partial = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    const id = String(provider?.id ?? '');
    if (id === '') continue;
    // 只请求一个路由时不去碰其它：省掉无谓的 listModels/resolveModelInfo 往返，
    // 也让"未被请求的 provider 失败"不会污染本次结果。
    if (settings.provider !== null && id !== settings.provider) continue;
    const lane = freeLaneOf(provider);
    const displayName = String(provider?.name ?? '') || id;

    let listed;
    try {
      listed = await withTimeout(llm.listModels(id), settings.timeoutMs, `listModels(${id})`);
    } catch (error) {
      const reason = messageOf(error);
      partial.push({ source: id, error: reason });
      sources.push({ id, displayName, kind: 'adapter', freeLane: lane, writable: false, modelCount: 0, freeCount: 0, error: reason });
      continue;
    }

    const list = Array.isArray(listed) ? listed : [];
    let freeCount = 0;
    for (const model of list.slice(0, settings.resolveLimit)) {
      if (!model || model.id === undefined) continue;
      const freeReason = adapterFreeReason(provider, model);
      if (freeReason === null) continue;
      freeCount += 1;
      const resolved = await resolveCached(llm, id, model.id, settings);
      models.push(adapterEntry(provider, model, resolved, freeReason));
    }
    sources.push({
      id,
      displayName,
      kind: 'adapter',
      freeLane: lane,
      writable: false,
      modelCount: list.length,
      freeCount,
    });
  }

  return { available: true, sources, models, partial };
}

/**
 * 列出"已声明但未注册"的 provider 目录项（来源 C），用于 UI 引导。
 * 任何失败都吞成 `partial`，绝不阻断扫描。
 */
export async function scanConfigurableProviders(llm, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  if (!llm || typeof llm.listConfigurableProviders !== 'function') return { sources: [], partial: [] };
  try {
    const entries = await withTimeout(llm.listConfigurableProviders(), timeoutMs, 'listConfigurableProviders');
    const sources = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = String(entry?.provider ?? '');
      if (id === '') continue;
      sources.push({
        id,
        displayName: String(entry?.displayName ?? '') || id,
        kind: 'draft',
        settingsNs: typeof entry?.settingsNs === 'string' ? entry.settingsNs : null,
        settingsPath: Array.isArray(entry?.settingsPath) ? entry.settingsPath : [],
        declared: entry?.declared === true,
        // 注意：这里**不**把 draft 当扫描目标 —— 它们没有注册路由，本线只用来提示"未配置"。
        configured: entry?.declared === true,
        error: typeof entry?.error === 'string' ? entry.error : null,
      });
    }
    return { sources, partial: [] };
  } catch (error) {
    return { sources: [], partial: [{ source: 'llm.listConfigurableProviders', error: messageOf(error) }] };
  }
}
