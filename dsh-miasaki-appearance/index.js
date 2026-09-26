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
//   GET  /appearance/api/avatars         头像清单（avatars 目录扫描；M2.5）
//   POST /appearance/api/avatar          上传头像（PNG data URL → avatars/<新文件名>.png；M2.5）
//   GET  /appearance/api/presets         应用图标预设清单（按需生成/复制到 avatars/；M2.7）
//   GET  /appearance/wallpaper/local/…   本地壁纸文件（白名单目录 + 文件名白名单，防穿越）
//   GET  /appearance/avatar/…            头像文件（同上；桌面壳不经 HTTP，直读磁盘）
//
// 首帧：订阅 webServer 的 `webserver/index-inject`，把门控脚本插在 body 开标签之后、
// shell 挂载之前 —— 与官方 ui-theme 的 bootThemeInjection 同理，避免「先原生后外观」
// 的闪色。总开关关闭时该脚本对页面零影响（只写 data-* 属性）。
//
// 本文件不含任何第三方依赖：配置模型与判定规则在 lib/config.js（纯逻辑、可单测），
// 持久化在 lib/store.js，围栏在 lib/fence.js，预设图标在 lib/icon-presets.js。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, basename, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, buildBootScript, buildBootStyle, buildSurfaceTokens, configEquals, evaluateContract, mergeConfig, sanitizeConfig } from './lib/config.js'
import { buildSplashHtml, buildSplashScript, buildSplashStyle } from './lib/splash.js'
import { AVATAR_DIRNAME, AVATAR_NAME_RE, AVATAR_URL_PREFIX, makeAvatarName, parseAvatarDataUrl } from './lib/avatar.js'
import { ICON_PRESETS, presetAssetPath, presetFileName, presetUrl, renderPresetPng } from './lib/icon-presets.js'
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

/**
 * 头像走的是另一条链路（M2.5）：它除了在设置面板里预览，还要被**桌面壳**读去做
 * 窗口 / 任务栏 / 托盘图标。因此目录与白名单都独立于壁纸，且格式收敛到 PNG ——
 * 壳侧只依赖 `png` crate，不引入 jpeg/webp 解码器。规则细节见 lib/avatar.js。
 */
const AVATAR_DIR = AVATAR_DIRNAME

export const name = 'appearance'
/** webServer 是硬依赖（要挂路由与首帧注入）；settings 刻意不用，见 lib/store.js 注释。 */
export const inject = ['webServer']

const MAX_BODY_BYTES = 32 * 1024
/** 头像上传的 body 上限：base64 后的 PNG（面板侧最长边已压到 512），远小于此。 */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** 插件根目录：位图预设（`assets/presets/*.png`）以它为基准解析。 */
const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))
/** 预设图标生成尺寸：与面板上传归一化的上限一致（桌面壳最大用到 256）。 */
const PRESET_ICON_SIZE = 512
const API_PREFIX = '/appearance/api/'

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 读取并解析 JSON 请求体；超过上限或非法 JSON 抛错。 */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > limit) throw new Error('请求体过大')
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
  // W4.1（2026-09-25）官方 index-inject 行类型白名单。由来：DSH 前端应用注入行时对未知
  // kind 是 `throw new Error("web boot: unknown index injection row")` —— **启动期抛错**，
  // 会让整个前端起不来（不是静默降级）。产出侧先把关，别把构建期就能发现的错误留到运行期。
  // 白名单与官方 `dsh-host-webserver` 的 `renderRow` 六种行一一对应（实测 0.1.7-rc.2）。
  const INJECTION_KINDS = new Set(['global', 'script', 'script-src', 'script-preload', 'style', 'html'])
  const pushRow = (table, row) => {
    if (!INJECTION_KINDS.has(row.kind)) {
      ctx.logger?.error?.(
        new Error(
          `appearance: 非法 index-inject 行类型 ${JSON.stringify(row.kind)}；` +
          `官方白名单：${[...INJECTION_KINDS].join(' / ')}（写错会让 DSH 前端启动期抛错）`
        )
      )
      return
    }
    table.push(row)
  }

  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    pushRow(table, { kind: 'script', placement: 'body', text: buildBootScript(current) })
    const mod = SKIN_MODULES[current.theme.skin]
    const style = buildBootStyle(current, mod === undefined ? null : mod.tokens, BUILTIN_WALLPAPERS)
    if (style !== '') pushRow(table, { kind: 'style', text: style })
    // P2 Boot Splash（2026-09-26 实施，设计 2026-09-22-appearance-boot-splash-design.md）：
    // 叠在 boot style 之上的独立一层，共用总开关门控（enabled=false 或 bootSplash='off'
    // 时三个函数全返回空串 ⇒ 一行不注入，「关掉即原生」）。行序即官方 table 顺序：
    // style(splash) → html(splash) → script(splash)，全部落在官方 __DSH_BOOT_READY__ 之前。
    // splash 样式不读皮肤 token 表——颜色走 var() 经 body 继承（boot style 把皮肤 token
    // 定义在 body 上），明暗由官方 body[data-ds-dark-theme] 自动切换；这样皮肤在运行期
    // 被换掉时启动画跟着变，且浅色模式下不会拿到「静态最深色当底色」的不可见组合
    // （踩坑记录见 lib/splash.js 头部）。
    const splashStyle = buildSplashStyle(current)
    if (splashStyle !== '') pushRow(table, { kind: 'style', text: splashStyle })
    const splashHtml = buildSplashHtml(current)
    if (splashHtml !== '') pushRow(table, { kind: 'html', placement: 'body', html: splashHtml })
    if (splashHtml !== '') pushRow(table, { kind: 'script', placement: 'body', text: buildSplashScript() })
  })

  /** 本地壁纸目录（dataDir 之下；无 dataDir 时图源路由降级 404）。 */
  const localDir = config?.dataDir !== undefined && config?.dataDir !== ''
    ? join(config.dataDir, LOCAL_WALLPAPER_DIRNAME)
    : null

  /** 头像目录（同上；无 dataDir 时上传被拒、文件路由降级 404）。 */
  const avatarDir = config?.dataDir !== undefined && config?.dataDir !== ''
    ? join(config.dataDir, AVATAR_DIR)
    : null

  /** 按目录 + 文件名白名单列文件（壁纸与头像共用同一条纪律）。 */
  function listDirFiles(dir, nameRe) {
    if (dir === null || !existsSync(dir)) return []
    try {
      return readdirSync(dir)
        .filter(name => nameRe.test(name))
        .filter(name => statSync(join(dir, name)).isFile())
        .sort()
    } catch {
      return []
    }
  }

  /** 解析并安全校验请求的文件名；不合法返回 null（basename + 二次前缀核对，防穿越）。 */
  function resolveInDir(dir, nameRe, file) {
    if (dir === null) return null
    const name = basename(file)
    if (!nameRe.test(name)) return null
    const full = normalize(join(dir, name))
    if (!full.startsWith(normalize(dir) + sep)) return null
    if (!existsSync(full)) return null
    return full
  }

  function listLocalWallpapers() {
    return listDirFiles(localDir, LOCAL_WALLPAPER_RE)
  }

  function resolveLocalWallpaper(file) {
    return resolveInDir(localDir, LOCAL_WALLPAPER_RE, file)
  }

  /** 头像清单：面板的「已有头像」选择器消费（含手动放进目录的文件）。 */
  function listLocalAvatars() {
    return listDirFiles(avatarDir, AVATAR_NAME_RE)
  }

  function resolveLocalAvatar(file) {
    return resolveInDir(avatarDir, AVATAR_NAME_RE, file)
  }

  /**
   * 取一款预设图标的 PNG 字节：位图预设读插件自带资源，其余即时渲染。
   * @param {string} id - 预设 id。
   * @returns {Buffer|null} 字节；资源缺失或未知 id 返回 null。
   */
  function presetBytes(id) {
    const asset = presetAssetPath(id)
    if (asset !== null) {
      try {
        return readFileSync(join(PLUGIN_ROOT, asset))
      } catch {
        return null
      }
    }
    return renderPresetPng(id, PRESET_ICON_SIZE)
  }

  /**
   * 把一款预设图标落到 avatars 目录（内容相同则跳过写入）。
   *
   * 落盘这一步是**跨线契约的关键**：桌面壳只认 `avatars/<白名单文件名>`，预设图标因此
   * 与用户上传的图走同一条路 —— 壳侧对"预设"零感知，一个字的改动都不需要。
   * @param {string} id - 预设 id。
   * @returns {Promise<string|null>} 写入的文件名；无法落盘返回 null。
   */
  async function materializePreset(id) {
    if (avatarDir === null) return null
    const bytes = presetBytes(id)
    if (bytes === null) return null
    const file = presetFileName(id)
    const full = join(avatarDir, file)
    try {
      if (existsSync(full) && readFileSync(full).equals(bytes)) return file
      await mkdir(avatarDir, { recursive: true })
      await writeFile(full, bytes)
      return file
    } catch (error) {
      ctx.logger?.error?.(error instanceof Error ? error : new Error(String(error)))
      return null
    }
  }

  /** 确保全部预设就位，返回可直接给面板消费的清单（幂等，重复调用只读一次磁盘）。 */
  async function materializePresets() {
    const out = []
    for (const preset of ICON_PRESETS) {
      const file = await materializePreset(preset.id)
      if (file !== null) {
        out.push({ id: preset.id, label: preset.label, file, url: presetUrl(preset.id) })
      }
    }
    return out
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

    // M2.5：头像清单（面板的「已有头像」选择器消费）。
    if (path === `${API_PREFIX}avatars` && req.method === 'GET') {
      return sendJson(res, 200, { local: listLocalAvatars() })
    }

    // M2.7：应用图标预设清单。**这个 GET 带一次幂等落盘**（把预设图标写进 avatars/），
    // 因为「预设」对桌面壳必须长得和用户上传的图一模一样；重复请求只做一次字节比较。
    // 无 dataDir 时仍返回清单（面板可预览），只是选了也落不了盘 —— 由面板给提示。
    if (path === `${API_PREFIX}presets` && req.method === 'GET') {
      const presets = await materializePresets()
      return sendJson(res, 200, { presets, persistent: avatarDir !== null, local: listLocalAvatars() })
    }

    // M2.5：上传头像。浏览器侧已用 canvas 把任意格式重编码成 PNG，这里只做最终把关
    // （真 PNG？多大？能不能落盘？），文件名由 host 生成 —— 绝不采信客户端给的名字。
    // 只写文件、不改配置：是否启用由面板随后的 /config 请求决定（两步语义清晰，
    // 也避免「上传即启用」把用户已选的头像顶掉）。
    if (path === `${API_PREFIX}avatar` && req.method === 'POST') {
      if (avatarDir === null) {
        return sendJson(res, 503, { error: '未配置 dataDir，头像无法落盘' })
      }
      let body = null
      try {
        body = await readJson(req, MAX_UPLOAD_BYTES)
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      const parsed = parseAvatarDataUrl(body?.dataUrl)
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.error })
      const file = makeAvatarName(Date.now())
      try {
        await mkdir(avatarDir, { recursive: true })
        await writeFile(join(avatarDir, file), parsed.bytes)
      } catch (error) {
        ctx.logger?.error?.(error instanceof Error ? error : new Error(String(error)))
        return sendJson(res, 500, { error: '头像写入失败（检查数据目录权限）' })
      }
      return sendJson(res, 200, {
        file,
        url: `${AVATAR_URL_PREFIX}${file}`,
        bytes: parsed.bytes.length,
        local: listLocalAvatars(),
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
      // 写盘失败必须**如实失败**（2026-09-26 修：此前 `.catch` 只记日志，随后仍无条件返回
      // 200 + `changed: true`，而 `current` / `revision` 停在旧值 ⇒ 客户端据此 setState 旧配置、
      // 清空错误提示，用户改动静默回滚且无任何提示）。现在把成败显式带回：失败一律
      // 500 + `changed: false` + 当前（未生效的旧）配置，客户端不再有「假成功」可依据。
      let saveError = null
      writeChain = writeChain.then(async () => {
        try {
          current = await store.save(next)
          revision += 1
        } catch (error) {
          saveError = error
          throw error
        }
      }).catch(error => {
        // 链本身必须保持 resolved（否则一次失败会永久拒绝后续写入）；错误已由 saveError 承载并上报。
        ctx.logger?.error?.(error instanceof Error ? error : new Error(String(error)))
      })
      await writeChain
      if (saveError !== null) {
        return sendJson(res, 500, {
          error: 'persist-failed',
          // 人类可读原因（面板直接显示）；`error` 保留机器枚举供上层判定。
          message: `配置写入失败：${saveError instanceof Error ? saveError.message : String(saveError)}`,
          config: current,
          revision,
          persistent: store.persistent,
          changed: false,
        })
      }
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

  /**
   * 本机图片文件路由（壁纸 / 头像共用）：不走 JSON 围栏（img/background 请求无自定义头），
   * 安全完全靠「目录 + 文件名白名单 + 防穿越」三件套。
   */
  function fileRoute(prefix, resolve) {
    return async (req, res) => {
      let pathname = '/'
      try {
        pathname = new URL(req.url ?? '/', 'http://dsh.local').pathname
      } catch {
        res.writeHead(400); return res.end()
      }
      if (req.method !== 'GET' || !pathname.startsWith(prefix)) {
        res.writeHead(404); return res.end()
      }
      let decoded = ''
      try {
        decoded = decodeURIComponent(pathname.slice(prefix.length))
      } catch {
        res.writeHead(404); return res.end()
      }
      const fullPath = resolve(decoded)
      if (fullPath === null) {
        res.writeHead(404); return res.end()
      }
      sendFile(res, fullPath)
    }
  }

  /** 本地壁纸文件。 */
  const wallpaperFile = fileRoute('/appearance/wallpaper/local/', resolveLocalWallpaper)
  /** 头像文件（面板预览用；桌面壳直读磁盘，不经这条路由）。 */
  const avatarFile = fileRoute(AVATAR_URL_PREFIX, resolveLocalAvatar)

  // 路由前缀不得带尾随斜杠：webserver 的 prefix 匹配是
  // `pathname === prefix || pathname.startsWith(prefix + '/')`，
  // '/appearance/api/' 会把 /appearance/api/state 拿去和 '/appearance/api//' 比对而永远 404。
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/appearance/api', handler: api }), 'appearance: api route')
  // 最长前缀优先（webserver 是 longest-prefix-wins），/appearance/wallpaper 不会吞掉 /appearance/api。
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/appearance/wallpaper', handler: wallpaperFile }), 'appearance: wallpaper route')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/appearance/avatar', handler: avatarFile }), 'appearance: avatar route')
}

/** 供单测与后续里程碑复用：本线对外暴露的出厂配置。 */
export { DEFAULT_CONFIG }
