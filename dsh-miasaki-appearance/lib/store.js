// @miasaki/dsh-appearance — 配置持久化（自管 JSON，不依赖 DSH settings 服务）。
//
// 为什么不注册 settings 命名空间：`ctx.settings.register(ns, schema)` 需要一份
// schemastery schema，而本插件以 `link:` 方式装载时 `@deepseek-ai/schemastery`
// 不在其模块查找链上（Node 按符号链接的真实路径解析，实测 ERR_MODULE_NOT_FOUND）。
// 引入该依赖意味着插件目录必须独立安装，一旦解析失败会拖垮整个 profile 的加载。
// 仓库既有约定同样如此：canvas / sidebar / dual-model 三条线都自管持久化。
// （官方 settings 通道本身是可用的，见设计文档 §9-5；迁移路径记在 design/ 里。）
//
// 写入采用「临时文件 + rename」原子替换，避免半截 JSON。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, sanitizeConfig } from './config.js'

/** 一份配置的持久化句柄。dataDir 缺失时降级为「不落盘」（load 给默认值、save 只归一化）。 */
export class AppearanceStore {
  /**
   * @param {string|undefined} dataDir - 本线独占的数据目录（由插件 config 提供）。
   */
  constructor(dataDir) {
    const dir = typeof dataDir === 'string' ? dataDir.trim() : ''
    this.persistent = dir !== ''
    this.file = this.persistent ? join(dir, 'config.json') : ''
  }

  /**
   * 读取配置。文件缺失或损坏一律回退默认值 —— 绝不因配置问题阻断插件装载。
   * @returns {Promise<object>} 归一化后的配置。
   */
  async load() {
    if (!this.persistent) return sanitizeConfig(DEFAULT_CONFIG)
    try {
      const text = await readFile(this.file, 'utf8')
      return sanitizeConfig(JSON.parse(text))
    } catch {
      return sanitizeConfig(DEFAULT_CONFIG)
    }
  }

  /**
   * 原子写入配置（写入前归一化；不可持久化时只返回归一化结果）。
   * @param {object} value - 待写入的配置候选。
   * @returns {Promise<object>} 实际生效的配置。
   */
  async save(value) {
    const next = sanitizeConfig(value)
    if (!this.persistent) return next
    await mkdir(dirname(this.file), { recursive: true })
    // 临时名带 pid 与时间戳：桌面壳 / 浏览器 GUI / 官方桌面端可能同时挂着本插件并各写一份
    // 配置，固定 `.tmp` 名会让两个进程互相截断对方的半截 JSON（2026-09-26 加固）。
    const temp = `${this.file}.${process.pid}-${Date.now().toString(36)}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temp, this.file)
    return next
  }
}
