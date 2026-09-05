  /* ---------- 人格会话联动:主题 → Agent 预设(whale/kurumi/inverse) ----------
   * 注入层本身不做 RPC(0.1.2-rc.1 起 HTTP POST /api/* 路由已移除,改 WebSocket
   * mux;fetch 会 404 → 2026-09-06 起的「人格会话创建失败」)。改为派发
   * 'miasaki-persona-request' CustomEvent(detail.theme),由 dsh-pet-panel 插件
   * 的客户端(ctx.remote.session.create,官方代理、版本自适应)完成创建/去重/
   * toast;插件不可用时静默降级,绝不阻断主题切换。 */
  function ensurePersonaSession(theme) {
    if (IS_LOCAL) return
    try {
      window.dispatchEvent && window.dispatchEvent(new CustomEvent('miasaki-persona-request', { detail: { theme: theme } }))
    } catch (e) { /* 联动失败绝不阻断主题切换 */ }
  }

