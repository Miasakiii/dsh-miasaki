/**
 * dsh-session-log-move — host half（空壳，无 host 职责）。
 *
 * 本 bundle 的功能完全由 client 半承担：
 *  - 主界面按钮隐藏（slot 同 id 替换）；
 *  - 轨迹页工具栏注入下载按钮（DOM 注入 + 官方下载服务/HTTP 端点）。
 *
 * 无主机侧路由、无事件监听、无持久化。
 *
 * @module dsh-session-log-move
 */

export const name = 'dsh-session-log-move';
export const inject = [];

export function apply() {
  // 故意为空：本 bundle 是纯 client 插件。
}