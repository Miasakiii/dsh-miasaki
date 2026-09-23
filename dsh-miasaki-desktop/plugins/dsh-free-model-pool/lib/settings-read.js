/**
 * dsh-free-model-pool — settings 读取双轨（≤0.1.6 与 0.1.7 兼容）。
 *
 * DSH 0.1.7 重写设置机制：`settings/updated` 事件与 **`ctx.settings.get(ns)`**
 * 一起在全树移除（0.1.6 有 19 处 → 0.1.7 零处），服务本身（`SettingsForms`）
 * 还在、`inject: ['settings']` 仍过得去，但读取改走 `describe()`：
 * 每个带 volatile Config 字段的 profile 条目一项，`ns` = 条目 id、
 * `value` = 解析值（组合基线 + 用户层合并后的投影）。写路径名字未变，
 * 仍是 `update(ns, patch)`（深合并，只受理 volatile 字段）。
 *
 * 双轨而非版本探测：两个世界的探针各自命中——≤0.1.6 上 `get` 是函数走老路，
 * 0.1.7 上 `get` 缺席走 `describe()`。cordis 语义实测：父 fiber 访问未注入
 * 的服务属性会抛错，故 `ctx.settings` 的取值本身也进 try（本插件已声明
 * inject，正常不可达，兜底不给启动屏添风险）。
 *
 * 落地起因：0.1.7 上不双轨时 `ctx.settings.get is not a function`，
 * 设置页模型栏的免费模型池面板整块报错（2026-09-23 线上实测，
 * `/freepool-api/status` 原样返回该错误）。配套评估：
 * `dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-upgrade-assessment-2026-09-23.md` §7.4。
 *
 * @module dsh-free-model-pool/settings-read
 */

/**
 * 读一个命名空间 / profile 条目的当前解析值。
 * @param ctx - 插件上下文（`inject` 声明含 `settings`）。
 * @param ns - 命名空间（≤0.1.6 已注册）或 profile 条目 id（0.1.7）。
 * @returns 解析后的配置对象；两个世界都读不到时返回 null（调用方按"无配置"处理）。
 */
export function readSettingsSection(ctx, ns) {
  let settings;
  try {
    settings = ctx.settings;
  } catch {
    return null;
  }
  if (settings === undefined || settings === null) return null;
  if (typeof settings.get === 'function') {
    // ≤0.1.6：已注册命名空间读取；未注册返回 undefined —— 与旧代码原样一致。
    return settings.get(ns) ?? null;
  }
  if (typeof settings.describe === 'function') {
    // 0.1.7+：profile 条目 Config 投影。describe() 不带 options 时 value 不脱敏
    // （脱敏只对远端读取强制），host 侧直读无需脱敏。
    const row = settings.describe().find((d) => d.ns === ns);
    return row !== undefined && row.value !== undefined ? row.value : null;
  }
  return null;
}
