/**
 * dsh-model-probe — settings 读取双轨（≤0.1.6 与 0.1.7 兼容）。
 *
 * DSH 0.1.7 重写设置机制：`ctx.settings.get(ns)` 在全树移除（服务本身还在、
 * `inject: ['settings']` 仍过得去），读取改走 `describe()`——每个带 volatile
 * Config 字段的 profile 条目一项，`ns` = 条目 id、`value` = 解析值。本插件用
 * 它解析已保存 provider 路由的 baseURL / api / apiKeyEnv（请求体没带全时），
 * 不双轨时 0.1.7 上 `ctx.settings.get is not a function` 会被 try/catch 吞掉，
 * 退化成「无档案」→ 已保存行「测试连通性」报 no-credential/no-endpoint
 * （2026-09-23 线上实测）。双轨探针：≤0.1.6 上 `get` 是函数走老路，0.1.7 上
 * 缺席走 `describe()`。
 *
 * 配套评估：`dsh-miasaki-shared-docs/dsh-platform/dsh-0.1.7-upgrade-assessment-2026-09-23.md` §7.4。
 *
 * @module dsh-model-probe/settings-read
 */

/**
 * 读一个命名空间 / profile 条目的当前解析值。
 * @param ctx - 插件上下文（`inject` 声明含 `settings`）。
 * @param ns - 命名空间（≤0.1.6 已注册）或 profile 条目 id（0.1.7）。
 * @returns 解析后的配置对象；两个世界都读不到时返回 null。
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
    // ≤0.1.6：已注册命名空间读取；未注册返回 undefined。
    return settings.get(ns) ?? null;
  }
  if (typeof settings.describe === 'function') {
    // 0.1.7+：profile 条目 Config 投影（describe() 不带 options 不脱敏，
    // host 侧直读无需脱敏——脱敏只对远端读取强制）。
    const row = settings.describe().find((d) => d.ns === ns);
    return row !== undefined && row.value !== undefined ? row.value : null;
  }
  return null;
}
