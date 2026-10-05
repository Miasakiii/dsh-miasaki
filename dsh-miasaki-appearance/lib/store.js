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
import { CONFIG_VERSION, DEFAULT_CONFIG, sanitizeConfig } from './config.js'

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
   * 读磁盘上的**原始**配置（未归一化）。文件缺失 / 损坏 / 非对象一律返回 null。
   *
   * 单一 IO 读入口：`load` 与 `loadWithMigration` 都走它，避免两套「读失败怎么办」的判据。
   * 刻意不叫 `readJsonOrNull` / `safeReadJSON` —— 那两个名字是仓库级闸门
   * `scripts/check-silent-guards.mjs` R3（静默回退读取）的**判据符号**。
   * @returns {Promise<object|null>} 原始配置对象，或 null。
   */
  async readRawConfig() {
    if (!this.persistent) return null
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      // 数组 / 标量 / null 都不是配置对象 —— 与「文件损坏」同档处理（回退默认）。
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * 读取配置。文件缺失或损坏一律回退默认值 —— 绝不因配置问题阻断插件装载。
   * @returns {Promise<object>} 归一化后的配置。
   */
  async load() {
    const raw = await this.readRawConfig()
    return sanitizeConfig(raw === null ? DEFAULT_CONFIG : raw)
  }

  /**
   * 读取配置，并在**盘上版本落后于当前 schema** 时把迁移结果回写一次。
   *
   * 为什么必须回写（2026-10-05 修「片头怎么还不播」）：跨线消费端
   * `dsh-miasaki-desktop/src-tauri/src/boot_intro.rs` **直接读本文件**，
   * 看不见 `sanitizeConfig` 在内存里做的迁移 —— 只归一化不落盘时，v6 旧配置
   * 永远不带 `boot` 板块 ⇒ 桌面壳永远判「不播」，而且**用户不动一次面板就永远修不好**
   * （落盘原本只发生在 `save` 路径上）。这与 `lib/config.js` 的 `migrateConfig`
   * 注释里「抬版本号让旧配置在下次写入时清净落盘」的假设相悖：**「下次写入」可能永远不来**。
   *
   * 回写失败**不阻断**（本次仍以迁移后的配置生效，插件照常装载），但把原因交回调用方
   * 记录 —— 静默失败会让同一个死锁换个姿势复发。
   * @returns {Promise<{config: object, migrated: boolean, error: Error|null}>}
   *   `migrated` = 是否发现版本落后（不论回写是否成功）；`error` = 回写失败的异常。
   */
  async loadWithMigration() {
    const raw = await this.readRawConfig()
    const config = sanitizeConfig(raw === null ? DEFAULT_CONFIG : raw)
    // 没有磁盘文件（首次运行）或已是当前版本 ⇒ 无事可做（不写盘，避免无谓的 IO 与 mtime 抖动）。
    if (raw === null || raw.version === CONFIG_VERSION) return { config, migrated: false, error: null }
    try {
      await this.save(config)
      return { config, migrated: true, error: null }
    } catch (error) {
      return { config, migrated: true, error: error instanceof Error ? error : new Error(String(error)) }
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
