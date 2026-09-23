// 设置变更 → 能力目录缓存击穿信号。
//
// DSH 0.1.7 重写了设置机制：0.1.5/0.1.6 的 `settings/updated`
// （resolved 值深比较后发出）在 0.1.7 全树移除，取而代之的是 RAW 文档层的
// `settings/document-updated(ns, revision)`（详见 dsh-miasaki-shared-docs/dsh-platform/
// dsh-0.1.7-upgrade-assessment-2026-09-23.md §7.3）。
//
// 这里对两个名字**都**监听而不是按版本探测：
//   - 0.1.5/0.1.6 上前者命中、后者静默；
//   - 0.1.7+ 上前者静默、后者命中。
// Cordis 的 `ctx.on()` 监听一个没有任何提供方发出的事件是无害空操作——
// 实测 cordis 4.0.2（0.1.5-rc.1）与 4.0.4（0.1.7-alpha.2）均不抛错、
// 正常返回 disposer。因此无需运行时探测 DSH 版本，升级前后零改动过渡。
//
// 新事件比旧事件更敏感（RAW 文档变更即触发，不比较 resolved 值），
// 多余的 invalidate 只是清一次缓存，下一次快照自然重扫，无正确性影响。

/** 双轨设置的失效信号事件名：旧名在前（兼容 0.1.5/0.1.6），新名在后（0.1.7+）。 */
export const SETTINGS_INVALIDATION_EVENTS = ['settings/updated', 'settings/document-updated']

/**
 * 监听设置变更事件，任一发出都击穿调用方缓存。
 * @param {object} ctx - 插件上下文（只用 `ctx.on`）。
 * @param {() => void} invalidate - 缓存失效回调；允许被重复调用。
 * @returns {() => void} 反注册全部监听的 disposer（幂等）。
 */
export function watchSettingsInvalidation(ctx, invalidate) {
  const disposers = SETTINGS_INVALIDATION_EVENTS.map((name) => ctx.on(name, () => invalidate()))
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
  }
}
