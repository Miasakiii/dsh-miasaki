/**
 * @miasaki/dsh-free-model — host half.
 *
 * Registers /freemodel-api/* JSON routes on the webServer so the client panel
 * can detect free models on ANY OpenAI-compatible platform configured under
 * llm-pi-ai.providers, write detected models back into that provider route's
 * settings (settings.yaml on ≤0.1.6, the profile entry config on 0.1.7+ — see
 * lib/settings-read.js), and switch the three agent presets' subagent backend
 * to a chosen free model.
 *
 * Platform set is the live llm-pi-ai.providers dict: a route with a baseURL
 * (or a catalog provider whose models endpoint is known) becomes a scan
 * target. OpenRouter is just one of them; adding a new platform later needs
 * zero plugin changes.
 *
 * Free-model rules per platform (first match wins):
 *   - id ends with ':free' or '-free' (OpenRouter convention / free-lane listings)
 *   - pricing fields all zero         (OpenRouter exposes pricing; gateways
 *                                      that mirror it inherit the same rule)
 *   - name matches /免费|free/i       (loose convention for gateways that
 *                                      mark free models in the display name)
 *
 * The rules are intentionally permissive/layered because a gateway may only
 * signal free status one way. Each rule must be cheap and avoid false
 * positives on paid models: the id suffixes and zero pricing are exact; the
 * name pattern only fires on explicit Chinese/English markers.
 *
 * 来源 A（已注册的 provider 路由，见 lib/scan.js）另加一层 **L0**：
 * provider 的 id 或显示名命中 /free/i ⇒ 疑似免 Key 车道，整路由免费。
 * 写法刻意不硬编码任何插件名 —— 任何免 Key 车道都适用，第三方改名也不失效。
 * 该层判出的模型默认**不可写入** llm-pi-ai 配置（免 Key 车道靠上游指纹计额度）。
 *
 * M1 起能力画像只有一个实现（lib/profile.js）：端点自述与适配器自述共用同一份
 * verdict 逻辑，避免两个来源给出互相矛盾的结论。
 *
 * @module @miasaki/dsh-free-model
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProfile } from './profile.js';
import { freeIdReason, freeLaneOf, scanAdapterProviders, scanConfigurableProviders } from './scan.js';
import { readSettingsSection } from './settings-read.js';
import { trustFence } from './trust.js';

const NS = 'llm-pi-ai';
const PRESETS = ['kurumi', 'whale', 'inverse'];

const FREE_FIELDS = ['prompt', 'completion', 'request', 'image', 'web_search', 'reasoning', 'input', 'output'];
const FREE_NAME_RE = /免费|free/i;

/**
 * 分层免费判定（来源 B：端点自述）。返回**命中依据**，未命中返回 null ——
 * "为什么说它免费"要和"它免费"一样可见，否则用户无法判断该不该信。
 */
function freeReasonOf(m) {
  if (!m || !m.id) return null;
  const suffix = freeIdReason(m.id);
  if (suffix !== null) return suffix;
  const p = m.pricing || {};
  const hasPricing = FREE_FIELDS.some((k) => p[k] != null);
  if (hasPricing && FREE_FIELDS.every((k) => (p[k] == null) || Number(p[k]) === 0)) return '定价字段全零';
  if (FREE_NAME_RE.test(String(m.name || ''))) return '名称含「免费/free」';
  return null;
}

/** Whether one model is free by the layered rules above. */
function isFreeModel(m) {
  return freeReasonOf(m) !== null;
}

/** Extract display fields free of platform-specific noise. */
function describeModel(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.context_length ?? null,
    maxTokens: (m.top_provider && m.top_provider.max_completion_tokens) ?? null,
    supported: Array.isArray(m.supported_parameters) ? m.supported_parameters.join(',') : '',
  };
}

/**
 * Capability profile for ONE model as its ENDPOINT declares it.
 *
 * 判定逻辑住在 lib/profile.js —— 与适配器来源（免 Key 车道）共用同一份实现，
 * 两个来源不会给出互相矛盾的 verdict。这里只把 OpenRouter 方言的字段翻译成
 * buildProfile 的入参；"能力只到能被证明的程度"那条纪律由 buildProfile 承担。
 */
function analyzeModel(m) {
  const sp = new Set(Array.isArray(m.supported_parameters) ? m.supported_parameters : []);
  const arch = m.architecture || {};
  const input = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
  const idText = String(m.id);
  const label = String(m.name || '');
  return buildProfile({
    modality: arch.modality || (input.length ? `${input.join('+')}->text` : 'text->text'),
    hasTools: sp.has('tools'),
    hasToolChoice: sp.has('tool_choice'),
    hasReasoning: m.reasoning === true || sp.has('reasoning') || sp.has('reasoning_effort'),
    hasStructured: sp.has('structured_outputs') || sp.has('response_format'),
    hasVision: input.includes('image') || input.includes('video'),
    hasAudio: input.includes('audio'),
    isCodeModel: /code|codex|north-mini/i.test(idText) || /code/i.test(label),
    contextWindow: m.context_length || 0,
    maxOutput: (m.top_provider && m.top_provider.max_completion_tokens) || 0,
    isPreview: /preview|beta|nightly|dev/i.test(idText) || /预览|测试/i.test(label),
    source: 'endpoint',
  });
}

/** Model entry shape the dsh-llm-pi-ai config schema accepts. */
function toConfigEntry(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.contextWindow ?? null,
    maxTokens: Math.min(m.maxTokens ?? 32768, 262144),
    input: ['text'],
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: 'openrouter',
    },
  };
}

/** Read one JSON body from an IncomingMessage. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** Reply JSON with a stable envelope; never leaks internal objects. */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** Normalize a baseURL to the OpenAI-compatible models endpoint. */
function modelsEndpoint(baseURL) {
  const base = String(baseURL || '').replace(/\/+$/, '');
  return `${base}/models`;
}

export const name = 'free-model';
export const inject = ['settings', 'webServer'];

export function apply(ctx) {
  /**
   * One exact route, fenced before anything else runs.
   *
   * 顺序是有意的：**围栏先于 method 检查、也先于业务** —— 未通过的请求连
   * "这个路径存不存在"都不该问出来。`ctx.get('connection')` 逐请求求值，
   * 不做 apply 时快照（该服务可能比本插件晚 provide，理由见 lib/trust.js）。
   */
  const registerRoute = (methods, path, handler) => {
    // 一个路径**只能注册一条** exact 路由：webServer 的表按 path 去重，第二条
    // `register` 会抛 `duplicate exact route` —— 而那是 apply 期抛错，会让**整个插件
    // 不激活**（真机实测：GET/POST 分两条注册时，插件在 0.2.0-rc.1 上直接没起来）。
    // 所以一个路径的多个方法由这一条路由内部分派。
    const allowed = Array.isArray(methods) ? methods : [methods];
    const route = async (req, res) => {
      const fence = trustFence(req.headers, ctx.get('connection'));
      if (!fence.ok) {
        sendJson(res, fence.status, { ok: false, error: fence.error });
        return;
      }
      if (!allowed.includes(req.method)) {
        sendJson(res, 405, { ok: false, error: `需要 ${allowed.join(' / ')}` });
        return;
      }
      try {
        const payload = await handler(req);
        sendJson(res, 200, { ok: true, ...payload });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String(error && error.message ? error.message : error) });
      }
    };
    // 方法挂在 handler 上，离线测试的路由表才能按方法取到正确的路由。
    route.method = allowed[0];
    route.methods = allowed;
    ctx.webServer.register({ kind: 'exact', path, handler: route });
  };

  /** Live platform list: every llm-pi-ai provider route that exposes a models endpoint. */
  const listPlatforms = () => {
    const section = readSettingsSection(ctx, NS);
    const providers = section && typeof section === 'object' ? (section.providers || {}) : {};
    const out = [];
    for (const [key, cfg] of Object.entries(providers || {})) {
      if (!cfg || typeof cfg !== 'object') continue;
      // 需要 baseURL 才能指向 models 端点；无 baseURL 的路由（如 catalog 内置）跳过
      const baseURL = typeof cfg.baseURL === 'string' && cfg.baseURL ? cfg.baseURL : null;
      if (!baseURL) continue;
      const models = Array.isArray(cfg.models) ? cfg.models : [];
      const displayName = typeof cfg.displayName === 'string' && cfg.displayName ? cfg.displayName : key;
      out.push({
        id: key,
        kind: 'pi-ai',
        providerRoute: key,
        displayName,
        apiKeyEnv: typeof cfg.apiKeyEnv === 'string' ? cfg.apiKeyEnv : null,
        baseURL,
        endpoint: modelsEndpoint(baseURL),
        configuredCount: models.length,
        configured: models.map((m) => ({ id: m.id, name: m.name || m.id })),
        // 免 Key 车道判定对平台同样适用（id/显示名命中 /free/i）。
        // 可写性按来源分：平台写得进 llm-pi-ai.providers，适配器来源（免 Key 车道）不写。
        freeLane: freeLaneOf({ id: key, name: displayName }),
        writable: true,
      });
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'));
    return out;
  };

  /** Fetch one platform's models list (with optional bearer key). */
  const fetchModels = async (platform) => {
    const headers = {};
    if (platform.apiKeyEnv) {
      const key = process.env[platform.apiKeyEnv];
      if (key) headers.authorization = `Bearer ${key}`;
    }
    const res = await fetch(platform.endpoint, {
      headers,
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`${platform.displayName} 模型列表请求失败: HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : [];
  };

  /** 排序：子代理可用优先，其次按上下文大小。两个来源共用。 */
  const sortModels = (models) => {
    models.sort((a, b) => {
      const aAgent = a.profile.canAgent ? 1 : 0;
      const bAgent = b.profile.canAgent ? 1 : 0;
      if (aAgent !== bAgent) return bAgent - aAgent;
      return (b.contextWindow || 0) - (a.contextWindow || 0);
    });
    return models;
  };

  /** 决策摘要：最佳子代理 / 编码类 / 超长上下文 / 多模态。两个来源共用。 */
  const summarize = (models) => {
    const agents = models.filter((m) => m.profile.canAgent);
    const firstCode = agents.find((m) => m.profile.code);
    const firstVision = agents.find((m) => m.profile.vision);
    const firstLong = agents.find((m) => m.profile.longContext);
    return {
      agentCount: agents.length,
      total: models.length,
      bestAgent: agents[0] ? {
        id: agents[0].id,
        name: agents[0].name,
        verdict: agents[0].profile.verdict,
        strengths: agents[0].profile.strengths,
      } : null,
      codingAgent: firstCode ? firstCode.id : null,
      visionAgent: firstVision ? firstVision.id : null,
      longContextAgent: firstLong ? firstLong.id : null,
      qaOnly: models.filter((m) => !m.profile.canAgent).length,
    };
  };

  // ── GET /freemodel-api/status ───────────────────────────────────────────
  // 返回全部可扫描平台及其已配置模型（不发起网络请求）
  registerRoute('GET', '/freemodel-api/status', async () => {
    const platforms = listPlatforms();
    return { platforms };
  });

  // ── POST /freemodel-api/detect ──────────────────────────────────────────
  // body: { platform: string } — 对指定平台发起在线检测
  registerRoute('POST', '/freemodel-api/detect', async (req) => {
    const body = await readBody(req);
    const platformId = typeof body.platform === 'string' ? body.platform : null;
    const platform = listPlatforms().find((p) => p.id === platformId);
    if (!platform) throw new Error(`平台 "${platformId ?? ''}" 不存在或未配置 baseURL`);
    const data = await fetchModels(platform);
    const models = [];
    for (const m of data) {
      const freeReason = freeReasonOf(m);
      if (freeReason === null) continue;
      models.push({
        ...describeModel(m),
        provider: platform.id,
        providerName: platform.displayName,
        source: 'endpoint',
        writable: true,
        freeReason,
        profile: analyzeModel(m),
      });
    }
    sortModels(models);
    return {
      platform: platform.id,
      endpoint: platform.endpoint,
      models,
      total: data.length,
      summary: summarize(models),
    };
  });

  // ── POST /freemodel-api/scan ────────────────────────────────────────────
  // body: { provider?: string, refresh?: boolean } —— 多来源统一扫描
  //   来源 A：官方 llm 服务枚举的**所有已注册 provider 路由**（含免 Key 车道），
  //           模型与元数据来自适配器自述，不需要任何配置或凭据；
  //   来源 B：llm-pi-ai.providers 中带 baseURL 的平台 —— 此处只列清单，
  //           真正抓取模型目录仍走 /detect（要出网）；
  //   来源 C：已声明但未注册的 provider 目录项，用来在 UI 上提示"还没配"。
  //
  // 纪律：**逐来源隔离**。一个 provider 挂了只进 partial[]，绝不让整轮请求失败
  // （否则一个配错的平台会把整个免费模型视图打成错误页）。
  const resolveCache = new Map();
  registerRoute('POST', '/freemodel-api/scan', async (req) => {
    const body = await readBody(req);
    const wantProvider = typeof body.provider === 'string' && body.provider ? body.provider : null;
    const llm = ctx.get('llm');

    const platforms = listPlatforms();
    const adapter = await scanAdapterProviders(llm, {
      cache: resolveCache,
      refresh: body.refresh === true,
      provider: wantProvider,
    });
    const drafts = await scanConfigurableProviders(llm);

    const sources = [];
    for (const source of adapter.sources) {
      if (wantProvider !== null && source.id !== wantProvider) continue;
      sources.push(source);
    }
    for (const platform of platforms) {
      // 同一个路由键可能两条来源都看得到：适配器来源优先，平台清单不重复列。
      if (adapter.sources.some((s) => s.id === platform.id)) continue;
      if (wantProvider !== null && platform.id !== wantProvider) continue;
      sources.push({ ...platform, modelCount: platform.configuredCount, freeCount: 0 });
    }
    for (const draft of drafts.sources) {
      if (wantProvider !== null && draft.id !== wantProvider) continue;
      if (sources.some((s) => s.id === draft.id)) continue;
      sources.push(draft);
    }

    const models = adapter.models.filter((m) => wantProvider === null || m.provider === wantProvider);
    sortModels(models);

    return {
      adapterAvailable: adapter.available,
      sources,
      models,
      summary: summarize(models),
      partial: [...adapter.partial, ...drafts.partial],
    };
  });

  // ── POST /freemodel-api/apply ───────────────────────────────────────────
  // body: { platform: string, ids?: string[] } — 写入指定平台的免费模型
  // 省略 ids = 写入该平台全部检测到的免费模型
  registerRoute('POST', '/freemodel-api/apply', async (req) => {
    const body = await readBody(req);
    const platformId = typeof body.platform === 'string' ? body.platform : null;
    const platform = listPlatforms().find((p) => p.id === platformId);
    if (!platform) throw new Error(`平台 "${platformId ?? ''}" 不存在或未配置 baseURL`);
    const data = await fetchModels(platform);
    const detected = [];
    for (const m of data) if (isFreeModel(m)) detected.push(describeModel(m));
    const wanted = Array.isArray(body.ids) && body.ids.length > 0 ? new Set(body.ids) : null;
    const entries = detected
      .filter((m) => !wanted || wanted.has(m.id))
      .map(toConfigEntry);
    if (entries.length === 0) throw new Error('该平台没有可写入的免费模型');

    const section = readSettingsSection(ctx, NS);
    const base = section && typeof section === 'object' ? section : {};
    const providers = Object.assign({}, base.providers || {});
    const prev = providers[platform.id] || {};
    providers[platform.id] = Object.assign({}, prev, {
      api: prev.api || 'openai-completions',
      models: entries,
    });
    // 写路径两代同名同义：≤0.1.6 合并进 settings.yaml 用户层；0.1.7 合并进
    // profile 条目 Config 的用户层（providers 是 llm-pi-ai 的 volatile 字段）。
    await ctx.settings.update(NS, { providers });
    return { written: entries.length, platform: platform.id, models: entries.map((e) => e.id) };
  });

  // ── POST /freemodel-api/subagent ────────────────────────────────────────
  // body: { provider: string, model: string, maxTokens?: number }
  // provider 必须是 llm-pi-ai 中已登记的路由键（含 openrouter 等任意平台）
  // 更新三个预设 agent.cordis.yml 中 tool-subagent / tool-subagent-fork 的 agentOptions
  registerRoute('POST', '/freemodel-api/subagent', async (req) => {
    const body = await readBody(req);
    const provider = typeof body.provider === 'string' && body.provider ? body.provider : null;
    const model = typeof body.model === 'string' && body.model ? body.model : null;
    if (!provider || !model) throw new Error('需要 provider 与 model 参数');
    if (!listPlatforms().some((p) => p.id === provider)) {
      throw new Error(`provider "${provider}" 不在 llm-pi-ai.providers 中（请先在模型页配置该平台）`);
    }
    const maxTokens = Number.isFinite(body.maxTokens) && body.maxTokens > 0 ? Math.floor(body.maxTokens) : null;

    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) throw new Error('无法解析用户主目录');

    const files = [];
    for (const id of PRESETS) {
      const p = join(home, '.dsh', '.agent-presets', id, 'agent.cordis.yml');
      // 三个预设（kurumi / whale / inverse）各自独立安装，未装的那个**本就不该被写** ——
      // 跳过不存在的预设是这段的业务语义，不是「输入缺件却继续跑」（existsSync 在这里是判据本身，
      // 不是守卫）。2026-09-29 补：此前只登记在 silent-guard 基线里、reason 欠账。
      // guard-ok: 存在性检查即业务判据，未安装的预设本就不该被写，非缺件静默降级
      if (!existsSync(p)) continue;
      let text = readFileSync(p, 'utf8');
      const lines = text.split('\n');
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        // 匹配 agentOptions: 下紧跟的 provider/model/maxTokens 三行
        if (/^(\s*)agentOptions:\s*$/.test(lines[i])) {
          const indent = (lines[i].match(/^(\s*)/) || ['', ''])[1];
          const bodyIndent = indent + '  ';
          if (lines[i + 1] && lines[i + 2] && lines[i + 3]
            && lines[i + 1].startsWith(bodyIndent + 'provider:')
            && lines[i + 2].startsWith(bodyIndent + 'model:')
            && lines[i + 3].startsWith(bodyIndent + 'maxTokens:')) {
            lines[i + 1] = `${bodyIndent}provider: ${provider}`;
            lines[i + 2] = `${bodyIndent}model: ${model}`;
            lines[i + 3] = `${bodyIndent}maxTokens: ${maxTokens === null ? 32768 : maxTokens}`;
            changed = true;
            i += 3;
          }
        }
      }
      if (changed) {
        writeFileSync(p, lines.join('\n'), 'utf8');
        files.push(id);
      }
    }
    if (files.length === 0) throw new Error('任何预设中都没有找到 agentOptions（检查预设文件）');
    return { updated: files, provider, model, maxTokens: maxTokens ?? 32768 };
  });

  // ── GET|POST /freemodel-api/default-model ───────────────────────────────
  // 默认模型（新会话的模型）走**官方服务** `agentDefaultModel`：读 `currentSelection()`、
  // 写 `saveSelection()`。这与下面的 /subagent 有本质区别 —— 那条是文件级改写，这条是
  // 官方写路径，**下一次会话立即生效**，不依赖预设文件的存在与格式。
  //
  // 服务缺席的 composition（没有配置编辑器的极简组合）返回语义化结果而不是抛错：
  // 读返回 `{supported:false}`，写回一条人话错误。
  //
  // **GET 与 POST 合并在一条路由里**：webServer 的 exact 表按 path 去重，分两条注册会抛
  // `duplicate exact route`，而那是 apply 期抛错 —— 会让整个插件不激活（真机实测）。
  registerRoute(['GET', 'POST'], '/freemodel-api/default-model', async (req) => {
    if (req.method === 'GET') {
      const service = ctx.get('agentDefaultModel');
      if (!service || typeof service.currentSelection !== 'function') {
        return { supported: false, selection: null };
      }
      let selection = null;
      try {
        selection = service.currentSelection() ?? null;
      } catch {
        // 读失败按"读不到"处理：默认模型不是本面板的核心功能，不该因此整块报错。
        selection = null;
      }
      return { supported: true, selection };
    }

    const body = await readBody(req);
    const provider = typeof body.provider === 'string' && body.provider ? body.provider : null;
    const model = typeof body.model === 'string' && body.model ? body.model : null;
    if (!provider || !model) throw new Error('需要 provider 与 model 参数');
    const service = ctx.get('agentDefaultModel');
    if (!service || typeof service.saveSelection !== 'function') {
      throw new Error('本 composition 没有 agentDefaultModel 服务，无法写默认模型');
    }
    await service.saveSelection({ provider, model });
    return { provider, model };
  });
}
