// @miasaki/dsh-appearance — Host half.
//
// 挂载在 DSH web 的 WebServer 上（与 canvas / sidebar / ssh 三条线同一范式，
// 复用现有 DSH 服务器，不起第二个进程）：
//
//   GET  /appearance/api/state           读配置（含 revision 与是否可落盘）
//   POST /appearance/api/config          写配置（按板块深合并；支持 expectedRevision 乐观并发）
//   POST /appearance/api/contract        提交浏览器侧契约探针，返回判定结果
//   GET  /appearance/api/skin            当前皮肤的 token 表（client overrideTokens 消费）
//   GET  /appearance/api/wallpapers      壁纸图源清单（内置 id + local 目录扫描）
//   GET  /appearance/wallpaper/local/…   本地壁纸文件（白名单目录 + 文件名白名单，防穿越）
//
// 首帧：订阅 webServer 的 `webserver/index-inject`，把门控脚本插在 body 开标签之后、
// shell 挂载之前 —— 与官方 ui-theme 的 bootThemeInjection 同理，避免「先原生后外观」
// 的闪色。总开关关闭时该脚本对页面零影响（只写 data-* 属性）。
//
// 本文件不含任何第三方依赖：配置模型与判定规则在 lib/config.js（纯逻辑、可单测），
// 持久化在 lib/store.js，围栏在 lib/fence.js。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, normalize, sep } from 'node:path'
import { DEFAULT_CONFIG, buildBootScript, buildBootStyle, buildSurfaceTokens, configEquals, evaluateContract, mergeConfig, sanitizeConfig } from './lib/config.js'
import { AppearanceStore } from './lib/store.js'
import { buildTrustedHosts, fenceCheck } from './lib/fence.js'
import { meta as zafkielMeta, tokens as zafkielTokens } from './lib/skins/zafkiel.js'
import { meta as kurkurielMeta, tokens as kurkurielTokens } from './lib/skins/kurkuriel.js'

/** M2 S3 的编译产物直接作为 host 半的皮肤事实源；client 半经 /skin 路由消费同一份。 */
const SKIN_MODULES = Object.freeze({
  zafkiel: Object.freeze({ meta: zafkielMeta, tokens: zafkielTokens }),
  kurkuriel: Object.freeze({ meta: kurkurielMeta, tokens: kurkurielTokens }),
})

/**
 * 内置壁纸（M2 §5.2）：**程序化 CSS 渐变**（零图片资产、零请求、首帧即成）。
 * 键即 `builtin:<id>` 的 id；值是 background-image 用的 CSS 渐变。
 */
const BUILTIN_WALLPAPERS = Object.freeze({
  aurora: 'linear-gradient(135deg, #0b1026 0%, #1b2a4a 35%, #274b63 60%, #0e7c7b 100%)',
  dusk: 'linear-gradient(160deg, #2b1055 0%, #7597de 55%, #ffb26b 100%)',
  ember: 'linear-gradient(145deg, #14100e 0%, #3f1f1b 45%, #7c2b24 75%, #d9b36a 100%)',
})

/** 本地壁纸目录（cordis.patch.yml 的 dataDir 之下），与配置数据同住不与其它线共享。 */
const LOCAL_WALLPAPER_DIRNAME = 'wallpapers'
/** 文件名白名单：防路径穿越的最终闸门（basename 后仍必须整体命中）。 */
const LOCAL_WALLPAPER_RE = /^[\w][\w.-]{0,80}\.(?:png|jpe?g|webp|gif|bmp|avif)$/i
const LOCAL_WALLPAPER_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' }

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
    const mod = SKIN_MODULES[current.theme.skin]
    const style = buildBootStyle(current, mod === undefined ? null : mod.tokens, BUILTIN_WALLPAPERS)
    if (style !== '') table.push({ kind: 'style', text: style })
  })

  /** 本地壁纸目录（dataDir 之下；无 dataDir 时图源路由降级 404）。 */
  const localDir = config?.dataDir !== undefined && config?.dataDir !== ''
    ? join(config.dataDir, LOCAL_WALLPAPER_DIRNAME)
    : null

  function listLocalWallpapers() {
    if (localDir === null || !existsSync(localDir)) return []
    try {
      return readdirSync(localDir)
        .filter(name => LOCAL_WALLPAPER_RE.test(name))
        .filter(name => statSync(join(localDir, name)).isFile())
        .sort()
    } catch {
      return []
    }
  }

  /** 解析并安全校验 local 图源请求的文件名；不合法返回 null。 */
  function resolveLocalWallpaper(file) {
    if (localDir === null) return null
    const name = basename(file)
    if (!LOCAL_WALLPAPER_RE.test(name)) return null
    const full = normalize(join(localDir, name))
    if (!full.startsWith(normalize(localDir) + sep)) return null
    if (!existsSync(full)) return null
    return full
  }

  function sendFile(res, fullPath) {
    const type = LOCAL_WALLPAPER_TYPES[fullPath.slice(fullPath.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=300' })
    // 壁纸文件是本机用户自放的图片；readFileSync 的体积上限交给 store 同款纪律（不设也只影响本机自己）
    res.end(readFileSync(fullPath))
  }

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

    // M2 S4：当前配置皮肤的 token 表（client 半 overrideTokens 与 boot style 消费同一份）。
    // M2 S5：顺带下发 params 层（表面不透明度）的覆盖表——它也是 overrideTokens 层，
    // 且与皮肤同样「host 计算、client 注册」，一次拉取双份。
    if (path === `${API_PREFIX}skin` && req.method === 'GET') {
      const mod = SKIN_MODULES[current.theme.skin]
      return sendJson(res, 200, {
        id: current.theme.skin,
        meta: mod === undefined ? null : { label: mod.meta.label, preferredScheme: mod.meta.preferredScheme },
        tokens: mod === undefined ? null : mod.tokens,
        surface: buildSurfaceTokens(current),
        wallpaperActive: current.wallpaper.source !== '',
      })
    }

    // M2 S5：壁纸图源清单（内置 id + local 目录扫描，面板选择器消费）。
    if (path === `${API_PREFIX}wallpapers` && req.method === 'GET') {
      return sendJson(res, 200, {
        builtin: Object.keys(BUILTIN_WALLPAPERS),
        local: listLocalWallpapers(),
      })
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

  /** 本地壁纸文件：不走 JSON 围栏（img/background 请求无自定义头），安全靠路径白名单。 */
  const wallpaperFile = async (req, res) => {
    let pathname = '/'
    try {
      pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
    } catch {
      res.writeHead(400); return res.end()
    }
    const prefix = '/appearance/wallpaper/local/'
    if (req.method !== 'GET' || !pathname.startsWith(prefix)) {
      res.writeHead(404); return res.end()
    }
    const fullPath = resolveLocalWallpaper(decodeURIComponent(pathname.slice(prefix.length)))
    if (fullPath === null) {
      res.writeHead(404); return res.end()
    }
    sendFile(res, fullPath)
  }

  // 路由前缀不得带尾随斜杠：webserver 的 prefix 匹配是
  // `pathname === prefix || pathname.startsWith(prefix + '/')`，
  // '/appearance/api/' 会把 /appearance/api/state 拿去和 '/appearance/api//' 比对而永远 404。
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/appearance/api', handler: api }), 'appearance: api route')
  // 最长前缀优先（webserver 是 longest-prefix-wins），/appearance/wallpaper 不会吞掉 /appearance/api。
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/appearance/wallpaper', handler: wallpaperFile }), 'appearance: wallpaper route')
}

/** 供单测与后续里程碑复用：本线对外暴露的出厂配置。 */
export { DEFAULT_CONFIG }
