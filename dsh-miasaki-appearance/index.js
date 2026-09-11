// @miasaki/dsh-appearance — Host half.
//
// 挂载在 DSH web 的 WebServer 上（与 canvas / sidebar / ssh 三条线同一范式，
// 复用现有 DSH 服务器，不起第二个进程）：
//
//   GET  /appearance/api/state      读配置（含 revision 与是否可落盘）
//   POST /appearance/api/config     写配置（按板块深合并；支持 expectedRevision 乐观并发）
//   POST /appearance/api/contract   提交浏览器侧契约探针，返回判定结果
//
// 首帧：订阅 webServer 的 `webserver/index-inject`，把门控脚本插在 body 开标签之后、
// shell 挂载之前 —— 与官方 ui-theme 的 bootThemeInjection 同理，避免「先原生后外观」
// 的闪色。总开关关闭时该脚本对页面零影响（只写两个 data-* 属性）。
//
// 本文件不含任何第三方依赖：配置模型与判定规则在 lib/config.js（纯逻辑、可单测），
// 持久化在 lib/store.js，围栏在 lib/fence.js。
import { DEFAULT_CONFIG, buildBootScript, buildBootStyle, configEquals, evaluateContract, mergeConfig, sanitizeConfig } from './lib/config.js'
import { AppearanceStore } from './lib/store.js'
import { buildTrustedHosts, fenceCheck } from './lib/fence.js'

export const name = 'appearance'
/** webServer 是硬依赖（要挂路由与首帧注入）；settings 刻意不用，见 lib/store.js 注释。 */
export const inject = ['webServer']

const MAX_BODY_BYTES = 32 * 1024
const API_PREFIX = '/appearance/api/'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 读取并解析 JSON 请求体；超过上限或非法 JSON 抛错。 */
async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求不是有效 JSON')
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 上下文。
 * @param {object} config - 本行在 cordis.patch.yml 里的 config。
 */
export function apply(ctx, config) {
  const trustedHosts = buildTrustedHosts(config?.trustedHosts)
  const store = new AppearanceStore(config?.dataDir)

  /** 内存态：apply 是同步的，而 store.load 是异步的 —— 先用出厂配置兜底。 */
  let current = sanitizeConfig(DEFAULT_CONFIG)
  /** 配置修订号：每次成功写入 +1，用于乐观并发与客户端缓存失效。 */
  let revision = 0
  /** 写入串行化，避免并发请求互相覆盖。 */
  let writeChain = Promise.resolve()

  ctx.effect(() => () => { store.persistent = false }, 'appearance: release store')

  ctx.effect(() => {
    store.load().then(loaded => {
      current = loaded
      revision += 1
    }).catch(error => {
      ctx.logger?.error?.(error instanceof Error ? error : new Error(String(error)))
    })
    return () => {}
  }, 'appearance: load config')

  // ---------------------------------------------------------------- 首帧注入
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    table.push({ kind: 'script', placement: 'body', text: buildBootScript(current) })
    const style = buildBootStyle(current)
    if (style !== '') table.push({ kind: 'style', text: style })
  })

  // ---------------------------------------------------------------- REST API
  const api = async (req, res) => {
    const fence = fenceCheck(req.headers, trustedHosts)
    if (!fence.ok) return sendJson(res, 403, { error: `不被信任的请求来源（${fence.reason}）` })

    let path = '/'
    try {
      path = new URL(req.url ?? '/', 'http://dsh.local').pathname
    } catch {
      return sendJson(res, 400, { error: '非法请求路径' })
    }

    if (path === `${API_PREFIX}state` && req.method === 'GET') {
      return sendJson(res, 200, { config: current, revision, persistent: store.persistent })
    }

    if (path === `${API_PREFIX}config` && req.method === 'POST') {
      let body = null
      try {
        body = await readJson(req)
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      const expected = body?.expectedRevision
      if (expected !== undefined && expected !== null && Number(expected) !== revision) {
        // 乐观并发：调用方读到的是旧修订 → 拒绝并回带当前状态，由调用方决定重试策略。
        return sendJson(res, 409, { error: 'revision-conflict', revision, config: current })
      }
      const patch = body?.patch !== undefined ? body.patch : body?.config
      const next = mergeConfig(current, patch)
      if (configEquals(next, current)) {
        // 无实质变化：不写盘、不递增修订，但仍回答最新状态（面板的重复提交是常态）。
        return sendJson(res, 200, { config: current, revision, persistent: store.persistent, changed: false })
      }
      writeChain = writeChain.then(async () => {
        current = await store.save(next)
        revision += 1
      }).catch(error => {
        ctx.logger?.error?.(error instanceof Error ? error : new Error(String(error)))
      })
      await writeChain
      return sendJson(res, 200, { config: current, revision, persistent: store.persistent, changed: true })
    }

    if (path === `${API_PREFIX}contract` && req.method === 'POST') {
      let body = null
      try {
        body = await readJson(req)
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      // 浏览器只采集事实，判定规则集中在 lib/config.js（可单测）。
      const verdict = evaluateContract(body?.probe)
      return sendJson(res, 200, { ...verdict, revision })
    }

    return sendJson(res, 404, { error: '未知的接口路径' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/appearance/api/', handler: api }), 'appearance: api route')
}

/** 供单测与后续里程碑复用：本线对外暴露的出厂配置。 */
export { DEFAULT_CONFIG }
