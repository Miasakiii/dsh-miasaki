/**
 * dsh-pet-panel — host half（空壳，无 host 职责）。
 *
 * 桌宠命令不走 host：设置面板（client）把命令写入主窗口 URL hash
 * （#...&cmd=pet-show|pet-hide|pet-reset|pet-state&seq=...），由 Miasaki
 * 桌面端进程（Tauri + 原生 Win32 桌宠）的 hash watchdog 轮询执行；
 * 状态经 Rust eval 的 `miasaki-pet-state` CustomEvent 回推到页面。
 *
 * 不在桌面端环境运行时（普通浏览器打开 DSH），面板检测
 * window.__MIASAKI_BOOTED__ 缺失并提示命令不会生效。
 *
 * @module dsh-pet-panel
 */

export const name = 'dsh-pet-panel';
export const inject = [];

export function apply() {
  // 故意为空：本 bundle 的功能完全由 client 面板 + 桌面端 hash 通道承担。
}
