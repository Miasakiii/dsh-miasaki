// @miasaki/dsh-dual-model — Host half.
//
// 会话级「主模型 + 辅助模型」：只要其中一个支持图片，就可以上传图片。
//
// 本插件做三件事：
//   1. 提供可选服务 `dualModelVisionRoute` —— DSH 本体补丁（patches/dsh-api-session-controller/）
//      通过它把「带图消息的准入判定」委托给本插件。未装插件时该服务不存在，
//      本体走原生分支，**零退化**。
//   2. 在 agent 的 `agent/pre-step` 记录"这一步是否处于图片上下文"，
//      并在 `agent/request` 据此把该步路由到辅助模型。
//   3. 为右下角控件提供 `/dual-model/api/*` JSON 路由（能力目录 + 配置读写）。
//
// 为什么路由判据来自 `agent/pre-step` 而不是 `agent/request`：
//   官方 `prepareRequest` 的契约是 "Resolve request config ... **before admitting
//   model-visible input**"，即 `agent/request` 触发时本步新消息尚未进入 Session，
//   那里读不到图。`agent/pre-step` 的 payload 带本步消息，历史则由
//   `session.deriveMessages()`（官方组装请求用的同一个调用）补齐。
//
// 设计文档：design/2026-09-10-dual-model-design.md

import { homedir } from 'node:os'
import { join } from 'node:path'
import { messagesHaveImage, deriveAgentMessages } from './lib/content.js'
import { decideRoute, applyRoute, normalizeRoute } from './lib/routing.js'
import { createCapabilityIndex, resolveRouteCapability } from './lib/capability.js'
import { DualModelStore, DEFAULT_CONFIG } from './lib/store.js'
import { watchSettingsInvalidation } from './lib/invalidation.js'

export const name = 'dual-model'
export const inject = ['webServer']

/** 补丁读取的服务名 —— 与 patches/dsh-api-session-controller/patch.mjs 共用的契约。 */
const SERVICE_KEY = 'dualModelVisionRoute'
const API_PREFIX = '/dual-model/api'
const MAX_BODY_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/**
 * 同源围栏：Host 必须是 loopback 字面量，且当浏览器带上 Origin 时其 host 必须与 Host 一致。
 * 本路由只读写本插件自己的配置，但这层校验让跨站页面无法借用户浏览器改配置（CSRF）。
 */
function fenceOk(headers) {
  const host = typeof headers?.host === 'string' ? headers.host : ''
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') return false
  const origin = headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - cordis.patch.yml 提供的配置。
 */
export async function apply(ctx, config) {
  const configuredDir = typeof config?.dataDir === 'string' && config.dataDir !== '' ? config.dataDir : undefined
  const dataDir = configuredDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'miasaki-dual-model')
  const store = new DualModelStore(dataDir)

  // 配置在内存里保持一份最新值；磁盘读取失败一律回退默认（不阻断装载）。
  let state = { ...DEFAULT_CONFIG }
  try {
    state = await store.load()
  } catch {
    state = { ...DEFAULT_CONFIG }
  }

  const capability = createCapabilityIndex(ctx)

  // ---- 1. 可选服务：本体补丁的准入委托目标 ----------------------------------
  ctx.effect(() => ctx.provide(SERVICE_KEY, {
    /**
     * 本会话当前的"图片执行路由"。
     * @returns {{provider: string, model: string} | undefined} 未启用或未配置时为 undefined，
     *   本体随即走原生准入分支。
     */
    for(_agent) {
      if (state.enabled !== true) return undefined
      return normalizeRoute({ provider: state.assistProvider, model: state.assistModel })
    },
  }), 'dual-model: vision route service')

  // ---- 2. 每步的图片上下文 + 路由 -------------------------------------------
  // key = sessionId 字符串；每步由 pre-step 重算，因此会随 compaction 自动回落。
  const imageContext = new Map()

  const attach = (agent) => {
    let id
    try {
      id = String(agent.id)
    } catch {
      return
    }
    let agentCtx
    try {
      agentCtx = agent.ctx
    } catch {
      return
    }
    if (agentCtx === undefined || agentCtx === null) return

    // 本步是否处于图片上下文：先看本步进入的消息，再补上完整会话历史
    // （历史里仍有图时，官方会把图投影成占位符——那正是必须继续走辅助模型的情形）。
    ctx.effect(() => agentCtx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      let hasImage = false
      try {
        hasImage = messagesHaveImage(decision?.messages)
        if (!hasImage) hasImage = messagesHaveImage(deriveAgentMessages(payload?.agent ?? agent))
      } catch {
        hasImage = false
      }
      imageContext.set(id, hasImage)
      return decision
    }), 'dual-model: pre-step image context')

    // 据上下文替换本步的调用配置。
    ctx.effect(() => agentCtx.on('agent/request', async (payload, next) => {
      const requestConfig = await next()
      const decision = decideRoute({
        enabled: state.enabled,
        assist: { provider: state.assistProvider, model: state.assistModel },
        hasImage: imageContext.get(id) === true,
        current: { provider: String(requestConfig.provider), model: String(requestConfig.model) },
      })
      if (decision.kind !== 'assist') return requestConfig
      return applyRoute(requestConfig, decision)
    }), 'dual-model: request routing')
  }

  const agents = ctx.get('agents')
  if (agents !== undefined) {
    try {
      for (const agent of agents.list()) attach(agent)
    } catch {
      /* 单个 agent 挂载失败不影响其余 */
    }
    ctx.effect(() => ctx.on('agent/created', (payload) => attach(payload.agent)), 'dual-model: agent/created')
    ctx.effect(() => ctx.on('agent/disposed', (payload) => {
      try {
        imageContext.delete(String(payload.agent.id))
      } catch {
        /* noop */
      }
    }), 'dual-model: agent/disposed')
  }

  // ---- 3. 能力目录缓存失效 --------------------------------------------------
  ctx.effect(() => ctx.on('llm/adapters-updated', () => capability.invalidate()), 'dual-model: adapters invalidation')
  // 设置变更：新旧事件双轨监听（0.1.5/0.1.6 的 settings/updated 与 0.1.7+ 的
  // settings/document-updated），理由与实测依据见 lib/invalidation.js。
  ctx.effect(() => watchSettingsInvalidation(ctx, () => capability.invalidate()), 'dual-model: settings invalidation')

  // ---- 4. 右下角控件的 JSON 路由 --------------------------------------------
  /** 该会话上一次请求实际使用的路由（主模型）。 */
  function readPrimaryRoute(agent) {
    if (agent !== undefined && agent !== null) {
      try {
        const header = agent.session?.requestHeader?.()
        const cfg = header?.config
        if (cfg !== undefined && cfg !== null && cfg.provider && cfg.model) {
          return { provider: String(cfg.provider), model: String(cfg.model) }
        }
      } catch {
        /* 回退到主机默认 */
      }
    }
    const fallback = ctx.get('agentDefaultModel')
    if (fallback !== undefined) {
      try {
        const selection = fallback.currentSelection()
        return { provider: String(selection.provider), model: String(selection.model) }
      } catch {
        /* noop */
      }
    }
    return undefined
  }

  function findAgent(sessionId) {
    if (sessionId === '' || agents === undefined) return undefined
    try {
      const direct = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (direct !== undefined && direct !== null) return direct
      for (const agent of agents.list()) if (String(agent.id) === sessionId) return agent
    } catch {
      /* noop */
    }
    return undefined
  }

  function readImageLimits() {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return null
    try {
      const limits = attachments.imageLimits
      if (limits === null || limits === undefined) return null
      const mediaTypes = Array.isArray(limits.mediaTypes) ? limits.mediaTypes.map(String) : []
      return {
        maxImagesPerMessage: Number(limits.maxImagesPerMessage),
        maxImageBytes: Number(limits.maxImageBytes),
        mediaTypes,
      }
    } catch {
      return null
    }
  }

  /** 组装控件的完整视图：配置 + 双方能力 + 视觉候选 + 图片归属结论。 */
  async function buildState(sessionId) {
    const assist = normalizeRoute({ provider: state.assistProvider, model: state.assistModel })
    const agent = findAgent(sessionId)
    const primary = readPrimaryRoute(agent)

    const [assistCap, primaryCap, catalog] = await Promise.all([
      assist === undefined ? Promise.resolve(undefined) : resolveRouteCapability(ctx, assist.provider, assist.model),
      primary === undefined ? Promise.resolve(undefined) : resolveRouteCapability(ctx, primary.provider, primary.model),
      capability.snapshot().catch(() => ({ providers: [], models: [] })),
    ])

    const primaryVision = primaryCap !== undefined && primaryCap.vision === true
    const assistVision = assistCap !== undefined && assistCap.vision === true

    return {
      enabled: state.enabled,
      assist: { provider: state.assistProvider, model: state.assistModel },
      primary: primary ?? null,
      primaryVision,
      assistVision,
      assistName: assistCap?.name ?? null,
      // 图片归属结论：控件据此给出"图片将由 X 处理"或"两个模型都不支持图片"。
      imageOwner: primaryVision ? 'primary' : (assistVision ? 'assist' : 'none'),
      visionModels: catalog.models.filter(model => model.vision === true),
      providers: catalog.providers,
      imageLimits: readImageLimits(),
    }
  }

  async function api(req, res) {
    if (!fenceOk(req.headers)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length)

    if (route === '/state' && (req.method === 'GET' || req.method === undefined)) {
      sendJson(res, 200, await buildState(url.searchParams.get('sessionId') ?? ''))
      return
    }

    if (route === '/settings' && req.method === 'POST') {
      let patch
      try {
        patch = await readJson(req)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid body' })
        return
      }
      const next = { ...state }
      if (patch.enabled !== undefined) next.enabled = patch.enabled === true
      if (typeof patch.assistProvider === 'string') next.assistProvider = patch.assistProvider.trim()
      if (typeof patch.assistModel === 'string') next.assistModel = patch.assistModel.trim()
      try {
        state = await store.save(next)
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'persist failed' })
        return
      }
      sendJson(res, 200, await buildState(url.searchParams.get('sessionId') ?? ''))
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: api }), 'dual-model: api')
}
