// 模型能力索引 —— 图片能力的**唯一真值源**读取层。
//
// 权威来源：`llm.listProviders()` → `llm.listModels(provider)` 返回的 `inputModalities`。
// 客户端目录（`ModelCatalogModel`）**不携带**能力字段，所以右下角控件要显示
// "这个模型支不支持图片"，必须由 Host 侧查询后再下发 —— 这就是本模块存在的理由。
// 见 ../../design/2026-09-10-dual-model-design.md §2.6 与 §4.4。
//
// 缓存策略：一次全量扫描要遍历每个 provider 的模型目录（部分 provider 走端点查询，
// 有网络开销），因此结果带 TTL 缓存，并由 `llm/adapters-updated` 与「设置变更」双轨事件
// （`settings/updated` + `settings/document-updated`，见 ./invalidation.js）主动失效。
// 并发查询共享同一次 in-flight 扫描。

import { supportsImage } from './routing.js'

/** 缓存存活时间：端点目录变动不频繁，5 分钟足够，且失效事件会立即击穿。 */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * 建立模型能力索引。
 * @param {object} ctx - 插件上下文（只用 `ctx.get`）。
 * @returns {{ snapshot: (force?: boolean) => Promise<object>, invalidate: () => void }} 索引句柄。
 */
export function createCapabilityIndex(ctx) {
  let cache = null
  let inflight = null

  /** 全量扫描一次；单个 provider 失败不影响其余（目录查询本就是 advisory）。 */
  async function scan() {
    const llm = ctx.get('llm')
    if (llm === undefined) return { providers: [], models: [] }

    let providers = []
    try {
      providers = llm.listProviders()
    } catch {
      providers = []
    }

    const providerEntries = []
    const modelEntries = []
    for (const provider of providers) {
      const id = String(provider.id)
      const name = String(provider.name)
      providerEntries.push({ id, name })
      let models = []
      try {
        models = await llm.listModels(id)
      } catch {
        models = []
      }
      for (const model of models) {
        modelEntries.push({
          provider: id,
          providerName: name,
          id: String(model.id),
          name: String(model.name),
          vision: supportsImage(model.inputModalities),
        })
      }
    }
    return { providers: providerEntries, models: modelEntries }
  }

  return {
    /**
     * 读取能力快照（默认走缓存）。
     * @param {boolean} [force] - 为真时跳过缓存强制重扫。
     * @returns {Promise<{providers: object[], models: object[]}>} 分离的 provider 与模型清单。
     */
    async snapshot(force) {
      const now = Date.now()
      if (force !== true && cache !== null && now - cache.at < CACHE_TTL_MS) return cache.value
      if (inflight !== null) return inflight
      inflight = scan()
        .then((value) => {
          cache = { at: Date.now(), value }
          inflight = null
          return value
        })
        .catch((error) => {
          inflight = null
          throw error
        })
      return inflight
    },
    /** 丢弃缓存；下一次 `snapshot` 重新扫描。 */
    invalidate() {
      cache = null
    },
  }
}

/**
 * 查询一条精确路由的能力（用于准入判定与状态回显）。
 * @param {object} ctx - 插件上下文。
 * @param {string} provider - provider 路由。
 * @param {string} model - 模型 id。
 * @returns {Promise<{ vision: boolean, known: boolean, name: string } | undefined>} 能力；查询失败返回 undefined。
 */
export async function resolveRouteCapability(ctx, provider, model) {
  const llm = ctx.get('llm')
  if (llm === undefined || provider === '' || model === '') return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return {
      vision: supportsImage(info.inputModalities),
      known: info.inputModalities !== undefined,
      name: String(info.name),
    }
  } catch {
    return undefined
  }
}
