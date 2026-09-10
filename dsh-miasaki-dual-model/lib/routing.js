// 路由决策 —— 纯函数，无 IO、无 live 数据，可直接单测。
//
// 三层职责中最容易出错的一层：这里的每个分支都对应设计文档 §4.3 的一条硬约束。
// 见 ../../design/2026-09-10-dual-model-design.md §4.3。

/**
 * 归一化一个 provider/model 选择；缺任一项即视为未配置。
 * @param {{ provider?: unknown, model?: unknown } | undefined | null} selection - 候选选择。
 * @returns {{ provider: string, model: string } | undefined} 完整路由，或 undefined。
 */
export function normalizeRoute(selection) {
  if (selection === null || selection === undefined || typeof selection !== 'object') return undefined
  const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection.model === 'string' ? selection.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/** 两个路由是否指向同一 provider/model。 */
export function sameRoute(a, b) {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model
}

/**
 * 决定这一步的模型路由。
 *
 * 硬约束（设计文档 §4.3）：
 *   1. 未启用 / 未配置辅助模型 / 本步不含图 → `keep`（原样交给主模型）
 *   2. 本步处于图片上下文且辅助模型已配置 → `assist`
 *   3. 辅助模型与当前路由相同 → `keep`（不做无意义的 config 抖动，避免污染 prompt cache）
 *
 * 注意本函数**不做能力判定**：辅助模型是否真的支持图片由准入侧（补丁读 `for()`）
 * 与路由侧的 `routeNeedsVision` 协同保证，判定真值只有一个来源（`inputModalities`）。
 *
 * @param {object} input - 决策输入。
 * @param {boolean} input.enabled - 双模型是否启用。
 * @param {{ provider?: unknown, model?: unknown } | undefined} input.assist - 辅助模型配置。
 * @param {boolean} input.hasImage - 本步是否处于图片上下文（pre-step 实测）。
 * @param {{ provider: string, model: string }} input.current - 当前请求的 provider/model。
 * @returns {{ kind: 'keep' } | { kind: 'assist', provider: string, model: string, reason: string }} 决策。
 */
export function decideRoute(input) {
  const { enabled, assist, hasImage, current } = input
  if (enabled !== true) return { kind: 'keep' }
  if (hasImage !== true) return { kind: 'keep' }
  const route = normalizeRoute(assist)
  if (route === undefined) return { kind: 'keep' }
  if (sameRoute(route, current)) return { kind: 'keep' }
  return { kind: 'assist', provider: route.provider, model: route.model, reason: 'image-context' }
}

/**
 * 把决策应用到 frozen call config 上，返回交给 `agent/request` waterfall 的下一版配置。
 *
 * **必须清空继承的 `reasoningEffort`**：官方 `resolveCallConfig` 对"模型不支持的努力等级"
 * 是硬拒（reject before provider I/O）。官方 `installModelSelection` 同样处理了这一点。
 *
 * @param {{ provider: string, model: string, reasoningEffort?: unknown }} config - waterfall 下一版配置。
 * @param {{ kind: string, provider?: string, model?: string }} decision - `decideRoute` 的结果。
 * @returns {object} 应用后的配置（`keep` 时原样返回）。
 */
export function applyRoute(config, decision) {
  if (decision === undefined || decision.kind !== 'assist') return config
  const { reasoningEffort: _inherited, ...rest } = config
  return { ...rest, provider: decision.provider, model: decision.model }
}

/**
 * 判断一组模型能力声明是否支持图片输入。
 *
 * 官方口径：`undefined` 表示 **unknown**（放行），显式不含 `image` 才是负能力。
 * 与 `session.prompt` 的准入判定保持同一口径，避免两处结论不一致。
 *
 * @param {readonly string[] | undefined} inputModalities - `llm.resolveModelInfo` 的返回值字段。
 * @returns {boolean} 是否按"支持图片"处理。
 */
export function supportsImage(inputModalities) {
  if (inputModalities === undefined || inputModalities === null) return true
  if (!Array.isArray(inputModalities)) return true
  return inputModalities.includes('image')
}

/**
 * 选择器的候选过滤：把一批模型能力记录里支持图片的挑出来。
 * 供 client 侧的辅助模型下拉使用（"哪些模型能看图"是用户最需要的决策信息）。
 * @param {readonly { provider: string, id: string, name?: string, inputModalities?: readonly string[] }[]} models - 模型记录。
 * @returns {object[]} 支持图片的模型（保持输入顺序）。
 */
export function selectVisionModels(models) {
  if (!Array.isArray(models)) return []
  return models.filter(model => supportsImage(model?.inputModalities))
}
