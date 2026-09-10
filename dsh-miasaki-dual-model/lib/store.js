// 插件自有配置的持久化 —— 不依赖 DSH settings 服务。
//
// 为什么不注册 settings 命名空间：`ctx.settings.register(ns, schema)` 需要一份
// schemastery schema，而本插件以 `link:` 方式装载时，`@deepseek-ai/schemastery`
// 不在其模块查找链上（Node 按符号链接的真实路径解析）。引入该依赖意味着插件目录
// 需要独立安装，一旦解析失败会**拖垮整个 profile 的加载**——代价远大于收益。
// 仓库既有约定同样如此：sidebar / ssh 两条线都自管持久化。
//
// 写入采用「临时文件 + rename」原子替换，避免半截 JSON。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 配置默认值；也是未知字段被丢弃后的形状。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  assistProvider: '',
  assistModel: '',
})

/** 只保留已知字段并归一化类型 —— 磁盘上的内容一律视为不可信输入。 */
export function sanitizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: source.enabled === undefined ? DEFAULT_CONFIG.enabled : source.enabled === true,
    assistProvider: typeof source.assistProvider === 'string' ? source.assistProvider.trim() : '',
    assistModel: typeof source.assistModel === 'string' ? source.assistModel.trim() : '',
  }
}

/** 一份配置的持久化句柄。 */
export class DualModelStore {
  /**
   * @param {string} dataDir - 本线独占的数据目录（由插件 config 提供）。
   */
  constructor(dataDir) {
    this.file = join(dataDir, 'config.json')
  }

  /**
   * 读取配置；文件缺失或损坏时回退默认值（绝不因配置问题阻断插件装载）。
   * @returns {Promise<object>} 归一化后的配置。
   */
  async load() {
    try {
      const text = await readFile(this.file, 'utf8')
      return sanitizeConfig(JSON.parse(text))
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  /**
   * 原子写入配置。
   * @param {object} value - 待写入的配置（写入前归一化）。
   * @returns {Promise<object>} 实际落盘的配置。
   */
  async save(value) {
    const next = sanitizeConfig(value)
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temp, this.file)
    return next
  }
}
