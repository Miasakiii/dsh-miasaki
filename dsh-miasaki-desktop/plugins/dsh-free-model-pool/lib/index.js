/**
 * dsh-free-model-pool — host half.
 *
 * Registers /freepool-api/* JSON routes on the webServer so the client panel
 * can detect free models on ANY OpenAI-compatible platform configured under
 * llm-pi-ai.providers, write detected models into settings.yaml for that
 * provider route, and switch the three agent presets' subagent backend to a
 * chosen free model.
 *
 * Platform set is the live llm-pi-ai.providers dict: a route with a baseURL
 * (or a catalog provider whose models endpoint is known) becomes a scan
 * target. OpenRouter is just one of them; adding a new platform later needs
 * zero plugin changes.
 *
 * Free-model rules per platform (first match wins):
 *   - id ends with ':free'            (OpenRouter convention)
 *   - pricing fields all zero         (OpenRouter exposes pricing; gateways
 *                                      that mirror it inherit the same rule)
 *   - name matches /免费|free/i       (loose convention for gateways that
 *                                      mark free models in the display name)
 *
 * The rules are intentionally permissive/layered because a gateway may only
 * signal free status one way. Each rule must be cheap and avoid false
 * positives on paid models: ':free' suffix and zero pricing are exact; the
 * name pattern only fires on explicit Chinese/English markers.
 *
 * @module dsh-free-model-pool
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NS = 'llm-pi-ai';
const PRESETS = ['kurumi', 'whale', 'inverse'];

const FREE_FIELDS = ['prompt', 'completion', 'request', 'image', 'web_search', 'reasoning', 'input', 'output'];
const FREE_NAME_RE = /免费|free/i;

/** Whether one model is free by the layered rules above. */
function isFreeModel(m) {
  if (!m || !m.id) return false;
  const id = String(m.id);
  if (id.endsWith(':free')) return true;
  const p = m.pricing || {};
  const hasPricing = FREE_FIELDS.some((k) => p[k] != null);
  if (hasPricing && FREE_FIELDS.every((k) => (p[k] == null) || Number(p[k]) === 0)) return true;
  const name = String(m.name || '');
  if (FREE_NAME_RE.test(name)) return true;
  return false;
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
 * Capability profile + suitability verdict for one model.
 *
 * The verdict drives two decisions the panel surfaces:
 *  - is this model usable as a SUBAGENT backend? (needs tools + tool_choice)
 *  - what is it for? (coding / vision / reasoning / long context / plain Q&A)
 *
 * Rules are grounded in the endpoint's own declaration (supported_parameters,
 * architecture.modality, reasoning flag, context length, max output), never in
 * benchmark ELO, so a model that advertises nothing is marked "unverified"
 * rather than guessed at.
 */
function analyzeModel(m) {
  const sp = new Set(Array.isArray(m.supported_parameters) ? m.supported_parameters : []);
  const arch = m.architecture || {};
  const input = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
  const ctx = m.context_length || 0;
  const maxOut = (m.top_provider && m.top_provider.max_completion_tokens) || 0;

  const hasTools = sp.has('tools');
  const hasToolChoice = sp.has('tool_choice');
  const hasReasoning = m.reasoning === true || sp.has('reasoning') || sp.has('reasoning_effort');
  const hasStructured = sp.has('structured_outputs') || sp.has('response_format');
  const hasVision = input.includes('image') || input.includes('video');
  const hasAudio = input.includes('audio');
  const isCodeModel = /code|codex|north-mini/i.test(String(m.id)) || /code/i.test(String(m.name || ''));
  const isLongContext = ctx >= 512000;
  const isPreview = /preview|beta|nightly|dev/i.test(String(m.id)) || /预览|测试/i.test(String(m.name || ''));

  // 子代理门槛：必须支持 tools + tool_choice（DSH agent loop 依赖工具循环）
  const canAgent = hasTools && hasToolChoice;

  let role = '通用';
  const strengths = [];
  if (canAgent) {
    let flavor = '子代理';
    if (hasReasoning) flavor = '推理型子代理';
    else if (isCodeModel) flavor = '编码子代理';
    else if (hasVision) flavor = '多模态子代理';
    role = `${flavor}可用`;
  } else if (!hasTools) {
    role = '仅纯文本问答';
  }
  if (hasReasoning) strengths.push('推理');
  if (isCodeModel) strengths.push('编码');
  if (hasStructured) strengths.push('结构化输出');
  if (hasVision) strengths.push('视觉');
  if (hasAudio) strengths.push('音频');
  if (isLongContext) strengths.push('超长上下文');
  if (!hasTools && !hasReasoning && !hasStructured && strengths.length === 0) strengths.push('轻量');

  let verdict;
  if (canAgent && hasReasoning && isLongContext) verdict = '首选：复杂任务子代理（推理+超长上下文）';
  else if (canAgent && isCodeModel) verdict = '首选：编码类子代理';
  else if (canAgent && hasVision) verdict = '首选：多模态子代理';
  else if (canAgent) verdict = '可用：通用子代理（工具调用完整）';
  else if (!hasTools && hasVision) verdict = '仅视觉问答：不可当子代理（无工具调用）';
  else if (!hasTools) verdict = '仅问答/批处理：不可当子代理（无工具调用）';
  else verdict = '需实测验证：申明支持工具但无 tool_choice，子代理可能失败';

  const warnings = [];
  if (!canAgent) {
    if (!hasTools) warnings.push('无工具调用：不能做子代理');
    else warnings.push('缺 tool_choice：工具调用可能失败，需实测');
  }
  if (isPreview) warnings.push('预览模型：可能临时免费或随时下线');
  if (maxOut > 0 && maxOut < 8192) warnings.push(`输出上限低（${maxOut}）`);
  if (ctx > 0 && ctx < 64000) warnings.push('上下文较小');
  if (maxOut === 0 && ctx === 0) warnings.push('元数据缺失：能力未验证');

  return {
    modality: arch.modality || (input.length ? input.join('+') + '->text' : 'text->text'),
    reasoning: hasReasoning,
    tools: hasTools,
    toolChoice: hasToolChoice,
    structuredOutput: hasStructured,
    vision: hasVision,
    code: isCodeModel,
    longContext: isLongContext,
    canAgent,
    role,
    strengths,
    warnings,
    verdict,
  };
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

export const name = 'free-model-pool';
export const inject = ['settings', 'webServer'];

export function apply(ctx) {
  const registerRoute = (path, handler) => {
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const payload = await handler(req);
          sendJson(res, 200, { ok: true, ...payload });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    });
  };

  /** Live platform list: every llm-pi-ai provider route that exposes a models endpoint. */
  const listPlatforms = () => {
    const section = ctx.settings.get(NS);
    const providers = section && typeof section === 'object' ? (section.providers || {}) : {};
    const out = [];
    for (const [key, cfg] of Object.entries(providers || {})) {
      if (!cfg || typeof cfg !== 'object') continue;
      // 需要 baseURL 才能指向 models 端点；无 baseURL 的路由（如 catalog 内置）跳过
      const baseURL = typeof cfg.baseURL === 'string' && cfg.baseURL ? cfg.baseURL : null;
      if (!baseURL) continue;
      const models = Array.isArray(cfg.models) ? cfg.models : [];
      out.push({
        id: key,
        displayName: typeof cfg.displayName === 'string' && cfg.displayName ? cfg.displayName : key,
        apiKeyEnv: typeof cfg.apiKeyEnv === 'string' ? cfg.apiKeyEnv : null,
        baseURL,
        endpoint: modelsEndpoint(baseURL),
        configuredCount: models.length,
        configured: models.map((m) => ({ id: m.id, name: m.name || m.id })),
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

  // ── GET /freepool-api/status ───────────────────────────────────────────
  // 返回全部可扫描平台及其已配置模型（不发起网络请求）
  registerRoute('/freepool-api/status', async () => {
    const platforms = listPlatforms();
    return { platforms };
  });

  // ── POST /freepool-api/detect ──────────────────────────────────────────
  // body: { platform: string } — 对指定平台发起在线检测
  registerRoute('/freepool-api/detect', async (req) => {
    const body = await readBody(req);
    const platformId = typeof body.platform === 'string' ? body.platform : null;
    const platform = listPlatforms().find((p) => p.id === platformId);
    if (!platform) throw new Error(`平台 "${platformId ?? ''}" 不存在或未配置 baseURL`);
    const data = await fetchModels(platform);
    const models = [];
    for (const m of data) if (isFreeModel(m)) {
      const summary = describeModel(m);
      models.push({ ...summary, profile: analyzeModel(m) });
    }
    // 排序：子代理可用优先，其次按上下文大小
    models.sort((a, b) => {
      const aAgent = a.profile.canAgent ? 1 : 0;
      const bAgent = b.profile.canAgent ? 1 : 0;
      if (aAgent !== bAgent) return bAgent - aAgent;
      return (b.contextWindow || 0) - (a.contextWindow || 0);
    });
    // 汇总：按角色给出决策摘要
    const agents = models.filter((m) => m.profile.canAgent);
    const summary = {
      agentCount: agents.length,
      total: models.length,
      bestAgent: agents[0] ? {
        id: agents[0].id,
        name: agents[0].name,
        verdict: agents[0].profile.verdict,
        strengths: agents[0].profile.strengths,
      } : null,
      codingAgent: agents.find((m) => m.profile.code) ? agents.find((m) => m.profile.code).id : null,
      visionAgent: agents.find((m) => m.profile.vision) ? agents.find((m) => m.profile.vision).id : null,
      longContextAgent: agents.find((m) => m.profile.longContext) ? agents.find((m) => m.profile.longContext).id : null,
      qaOnly: models.filter((m) => !m.profile.canAgent).length,
    };
    return { platform: platform.id, endpoint: platform.endpoint, models, total: data.length, summary };
  });

  // ── POST /freepool-api/apply ───────────────────────────────────────────
  // body: { platform: string, ids?: string[] } — 写入指定平台的免费模型
  // 省略 ids = 写入该平台全部检测到的免费模型
  registerRoute('/freepool-api/apply', async (req) => {
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

    const section = ctx.settings.get(NS);
    const base = section && typeof section === 'object' ? section : {};
    const providers = Object.assign({}, base.providers || {});
    const prev = providers[platform.id] || {};
    providers[platform.id] = Object.assign({}, prev, {
      api: prev.api || 'openai-completions',
      models: entries,
    });
    await ctx.settings.update(NS, { providers });
    return { written: entries.length, platform: platform.id, models: entries.map((e) => e.id) };
  });

  // ── POST /freepool-api/subagent ────────────────────────────────────────
  // body: { provider: string, model: string, maxTokens?: number }
  // provider 必须是 llm-pi-ai 中已登记的路由键（含 openrouter 等任意平台）
  // 更新三个预设 agent.cordis.yml 中 tool-subagent / tool-subagent-fork 的 agentOptions
  registerRoute('/freepool-api/subagent', async (req) => {
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
}
