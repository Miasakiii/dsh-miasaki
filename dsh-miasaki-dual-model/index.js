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
import { decideAdmission, imageContextOnFailure } from './lib/admission.js'
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

// ---------------------------------------------------------------------------
// 浏览器信任围栏（2026-10-20，ff54a）
// ---------------------------------------------------------------------------
//
// `/dual-model/api/*` 是 webServer 上自注册的 prefix 路由，**不经过**内核 `/api`
// 的准入链。此前唯一门禁是 `fenceOk()`（回环 Host + Origin 全权相等），因此任意
// 本机进程伪造 `Host: 127.0.0.1:<port>` 且不带 Origin 即可静默改本插件配置。
// 现在照 `dsh-miasaki-free-model/lib/trust.js` 的范式改成两层：
//
//   ① composition 挂了 `connection` 服务时，用它给出的准入判定
//      （`requestRejection`，与内核 `/api` 同级：信任围栏 + 浏览器鉴权 cookie）；
//      **必须逐请求读取** —— 该服务可能比本插件晚 provide，apply 期快照会让围栏
//      在整轮进程里永久退化成第 ② 层。
//   ② 没有该服务时，用结构化复刻：只允许回环 Host、拒绝跨站 fetch、
//      Origin/Referer 存在时 hostname 必须与 Host 相同，且 **Origin 显式带端口时
//      必须等于 Host 端口**（SPEC §2 端口判据；Host 无端口时按 Origin 的 scheme
//      取默认 80/443；Origin 不带端口 = 部分 Chromium 会剥掉非默认回环端口，
//      沿用 hostname 判定，避免误拒）。
//
// 两层都是纵深防御而非鉴权本身：真正的鉴权由 connection 服务的 cookie 完成。

/** 同机浏览器可以合法使用的 Host 名（去端口后比较；IPv6 保留方括号，与 URL.hostname 同形）。 */
const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * 取 Host / Origin / Referer 的 hostname、端口与 scheme。
 * Host 头不带 scheme，Origin/Referer 带；补一个再解析，两种形状共用一条路径。
 * @param {string} value - 原始头值。
 * @returns {{hostname: string, port: string, protocol: string} | null} 解析不出返回 null。
 */
function authorityOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const raw = value.trim()
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return { hostname: url.hostname.toLowerCase(), port: url.port, protocol: url.protocol }
  } catch {
    return null
  }
}

/**
 * 结构化围栏：不依赖任何服务，只看请求头。导出是为了单测能直接打它。
 * @param {object} headers - 请求头（`req.headers`）。
 * @returns {{ok: true} | {ok: false, status: number, error: string}} 判定结果。
 */
export function structuralFence(headers) {
  const host = authorityOf(headers?.host)
  if (host === null || !TRUSTED_HOSTNAMES.has(host.hostname)) {
    return { ok: false, status: 403, error: '不被信任的 Host' }
  }
  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, error: '跨站请求被拒绝' }
  }
  for (const name of ['origin', 'referer']) {
    const raw = headers[name]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const source = authorityOf(raw)
    // `Origin: null`（opaque origin）解析出的 hostname 不会命中，同样被拒。
    if (source === null || source.hostname !== host.hostname) {
      return { ok: false, status: 403, error: '跨站来源被拒绝' }
    }
    if (name === 'origin' && source.port !== '') {
      const hostPort = host.port === '' ? (source.protocol === 'https:' ? '443' : '80') : host.port
      if (source.port !== hostPort) return { ok: false, status: 403, error: '跨端口来源被拒绝' }
    }
  }
  return { ok: true }
}

/**
 * 判定一个请求是否放行：`connection` 在场时以它的判定为准，缺席时退回结构围栏。
 * @param {object} headers - 请求头（`req.headers`）。
 * @param {object | undefined} connection - **当次** `ctx.get('connection')` 的结果。
 * @returns {{ok: true} | {ok: false, status: number, error: string}} 判定结果。
 */
export function trustFence(headers, connection) {
  if (connection !== undefined && connection !== null && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({ headers })
      if (rejection === 401) return { ok: false, status: 401, error: '未通过浏览器鉴权' }
      if (rejection === 403) return { ok: false, status: 403, error: '请求来源不被信任' }
      if (rejection === undefined) return { ok: true }
    } catch {
      // connection 抛错属 composition 缺陷：退回结构层，而不是让每个请求 500。
    }
  }
  return structuralFence(headers)
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
  /**
   * 已成功建立**图片执行通道**的 agent id 集合。
   *
   * 「成功」= `agent/pre-step` 与 `agent/request` 两个监听都已挂上 —— 只有这时，
   * 准入侧放行的图才**真的**会被路由到辅助模型。集合里没有该 agent 时 `for()` 一律不接管，
   * 让本体走原生分支给出**可见的**拒绝（`Model "X" does not support image input`），
   * 而不是放行一张没有任何模型会看的图。
   *
   * 这条约束是 2026-09-29 补的：此前 `for()` 只看"是否启用 + 是否配置"，
   * 与路由侧 `decideRoute` 的 `hasImage` 判据**不同源**，存在静默丢图链（见 lib/admission.js 头注）。
   */
  const channelReady = new Set()

  ctx.effect(() => ctx.provide(SERVICE_KEY, {
    /**
     * 本会话当前的"图片执行路由"。
     *
     * @param {object} agent - 请求准入的 agent。
     * @returns {{provider: string, model: string} | undefined} 接管时返回路由；
     *   不接管（未启用 / 未配置 / 通道未建立）返回 `undefined`，本体随即走原生准入分支。
     */
    for(agent) {
      let id
      try {
        id = String(agent?.id)
      } catch {
        id = ''
      }
      return decideAdmission({
        enabled: state.enabled,
        assist: { provider: state.assistProvider, model: state.assistModel },
        channelReady: channelReady.has(id),
      })
    },
  }), 'dual-model: vision route service')

  // ---- 2. 每步的图片上下文 + 路由 -------------------------------------------
  // key = sessionId 字符串；每步由 pre-step 重算，因此会随 compaction 自动回落。
  const imageContext = new Map()

  const attach = (agent) => {
    let id
    try {
      id = String(agent.id)
    } catch (error) {
      // 留痕而非静默：attach 失败 ⇒ 该会话的图片执行通道不存在 ⇒ 准入侧据此**不接管**
      // （见 decideAdmission）。静默的话，用户只会看到"配了辅助模型却发不出图"，无从归因。
      console.warn('[dual-model] agent.id 读取失败，本会话不参与图片路由', error)
      return
    }
    let agentCtx
    try {
      agentCtx = agent.ctx
    } catch (error) {
      console.warn('[dual-model] agent.ctx 读取失败，本会话不参与图片路由', { id, error })
      return
    }
    if (agentCtx === undefined || agentCtx === null) {
      console.warn('[dual-model] agent.ctx 不可用，本会话不参与图片路由', { id })
      return
    }

    // 本步是否处于图片上下文：先看本步进入的消息，再补上完整会话历史
    // （历史里仍有图时，官方会把图投影成占位符——那正是必须继续走辅助模型的情形）。
    ctx.effect(() => agentCtx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      let hasImage = false
      try {
        hasImage = messagesHaveImage(decision?.messages)
        if (!hasImage) hasImage = messagesHaveImage(deriveAgentMessages(payload?.agent ?? agent))
      } catch (error) {
        // 判定失败**不能**默认「无图」：准入侧已按"有图"放行，这里判成无图就是静默丢图。
        // 保守取 true（多切一次辅助模型），并留痕 —— 策略与理由见 lib/admission.js。
        hasImage = imageContextOnFailure(error)
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

    // 两个监听都挂上了 ⇒ 图片执行通道建立 ⇒ 准入侧可以接管控入。
    // 刻意放在最后一行：上面任一步抛错都不会把该 agent 标成"就绪"，准入就不会放行没人处理的图。
    channelReady.add(id)
  }

  const agents = ctx.get('agents')
  if (agents !== undefined) {
    let existing = []
    try {
      existing = agents.list()
    } catch (error) {
      console.warn('[dual-model] agents.list() 读取失败，现有会话不参与图片路由', error)
    }
    for (const agent of existing) {
      // 逐 agent 兜底：此前 try 包住了整个循环，一个 agent 抛错会让剩余全部丢掉路由，
      // 与「单个 agent 挂载失败不影响其余」这句注释承诺不符。
      try {
        attach(agent)
      } catch (error) {
        console.warn('[dual-model] agent 图片路由挂载失败', error)
      }
    }
    ctx.effect(() => ctx.on('agent/created', (payload) => {
      try {
        attach(payload.agent)
      } catch (error) {
        console.warn('[dual-model] 新 agent 图片路由挂载失败', error)
      }
    }), 'dual-model: agent/created')
    ctx.effect(() => ctx.on('agent/disposed', (payload) => {
      let id = ''
      try {
        id = String(payload.agent.id)
      } catch { /* 取不到 id 时下面的删除是 no-op */ }
      imageContext.delete(id)
      // 通道随 agent 一并作废：id 若被复用，残留的"就绪"标记会让准入放行一张没人处理的图。
      channelReady.delete(id)
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
    // 逐请求读取 connection：该服务可能比本插件晚 provide，apply 期快照会让围栏
    // 永久退化成结构层（见本文件「浏览器信任围栏」段）。
    const fence = trustFence(req.headers, ctx.get('connection'))
    if (!fence.ok) {
      sendJson(res, fence.status, { error: fence.error })
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
