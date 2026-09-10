// 图片内容检测 —— 与 DSH `contentHasImage` 同语义（含 tool-result 嵌套下钻）。
//
// 为什么自己实现：插件**不能** import `@deepseek-ai/dsh-llm`（仓库约定：插件只依赖
// node 内置模块 + 白名单第三方包，DSH 内部包在 profile 的模块解析路径上不可靠）。
// 语义必须与官方一致，否则会出现"路由认为有图、官方投影认为没图"的错位。

/**
 * 判断一组内容块里是否含图片，递归下钻 tool-result 的嵌套内容。
 * 与 `dsh-llm` 的 `contentHasImage` 保持同一递归深度语义。
 * @param {unknown} content - 内容块数组（live 数据；只读 type 字段，不做序列化）。
 * @returns {boolean} 是否含图片块。
 */
export function contentHasImage(content) {
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'image') return true
    if (block.type === 'tool-result' && contentHasImage(block.content)) return true
  }
  return false
}

/**
 * 判断一组消息里是否含图片（任一 content 含图即为真）。
 * @param {unknown} messages - 消息数组（live 数据；只读 content 字段）。
 * @returns {boolean} 是否含图片。
 */
export function messagesHaveImage(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (contentHasImage(message.content)) return true
  }
  return false
}

/**
 * 读取一个 live Agent 当前会话的消息列表。
 *
 * `session.deriveMessages()` 正是官方 `buildRequest` 用来组装请求的那一个调用，
 * 因此这里拿到的就是"会发生图片投影的那份消息"。
 *
 * live 数据边界：只把它交给本模块的只读遍历函数，绝不序列化、不缓存、不外传。
 * @param {unknown} agent - live Agent（只读其 `session` 成员）。
 * @returns {unknown[]} 消息数组；读取失败时返回空数组（保守：不路由）。
 */
export function deriveAgentMessages(agent) {
  try {
    const session = agent === null || typeof agent !== 'object' ? undefined : agent.session
    if (session === null || session === undefined || typeof session !== 'object') return []
    if (typeof session.deriveMessages !== 'function') return []
    const messages = session.deriveMessages()
    return Array.isArray(messages) ? messages : []
  } catch {
    return []
  }
}
