    /**
     * 【补丁注入 · @miasaki/dsh-free-model】更新提醒的唯一落点。
     *
     * 背景：上游原先把「插件可升级」做成右下角 toast（还带一条系统通知），新公告与
     * 热重载提示也走同一条通道。本补丁把那条通道关掉了，于是「有新版本」这件事
     * 改在这里说 —— 位置在页首 hero 之后，一进「免费模型」就能看见，且不打断任何操作。
     *
     * 数据走本页现成的 `api('/update/status')`（同源路由、cookie 自动携带），并监听
     * `ofm:update` / `ofm:upgraded` —— 上游的 SSE 订阅仍在广播这两个事件，只是不再弹 toast。
     * 没有新版本时整块渲染 `null`：不占位、不留空白。
     *
     * 样式复用本页 `ofm_*` 类（`ofm_callout` 的警告底色 / `ofm_note` / `ofm_row`），
     * 颜色全部来自主题令牌，与这张页面其余部分同一套设计语言；**不新增 CSS 类**，
     * 少一处升级漂移面。
     *
     * 依赖（都在本文件 factory 作用域里）：`h` / `useState` / `useEffect` / `Button` / `api` / `API`。
     */
    /**
     * 【补丁 · @miasaki/dsh-free-model】自升级请求 —— 刻意**不走**本页的 `api()`。
     *
     * 为什么必须绕开：`api()` 给每个请求套了 8 秒 `AbortController`（上游为防挂起的兜底），
     * 而 `/update/apply` 要做的是**拉 manifest（自身超时 15s）→ 并发 4 路下载全部文件
     * （每路 30s）→ 备份 → 安装 → 热重载**。8 秒必然把它打断，用户看到的只有
     * `signal is aborted without reason` —— 而真正的原因（host 侧 `updates.json` 里记的
     * `staging failed: … fetch failed`）随 500 响应发出来时，**客户端早就走了**。
     *
     * 2026-10-07 实测踩到（用户截图报红框 `signal is aborted without reason`，
     * 而 host 侧那次升级其实真的跑了、也真的失败了）。这里给 **240 秒**：
     * 覆盖完整安装，又不会真挂死（host 侧每一步都有自己的超时）。
     * 失败时把服务端的 `error` 原样抛出 —— 那才是用户该看到的东西。
     */
    async function ofmApplyUpgrade() {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 240000)
      try {
        const response = await fetch(`${API}/update/apply`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          redirect: 'error',
          signal: ctrl.signal,
        })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        if (payload?.ok === false) throw new Error(payload?.error ?? '升级未完成')
        return payload
      } finally { clearTimeout(timer) }
    }

    function UpdateNotice() {
      /** undefined = 正在读；null = 后端不可达（不提醒，也不报错）。 */
      const [status, setStatus] = useState(undefined)
      /** 本次访问里被「稍后再说」按掉的版本号；下次进设置页仍会提醒。 */
      const [dismissed, setDismissed] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        const read = () => {
          api('/update/status')
            .then(payload => { if (alive) setStatus(payload ?? null) })
            .catch(() => { if (alive) setStatus(null) })
        }
        read()
        // 上游的推送订阅仍在，只是不再弹窗：新版本与升级完成都靠这两个事件刷新。
        const handler = () => read()
        window.addEventListener('ofm:update', handler)
        window.addEventListener('ofm:upgraded', handler)
        return () => {
          alive = false
          window.removeEventListener('ofm:update', handler)
          window.removeEventListener('ofm:upgraded', handler)
        }
      }, [])

      const latest = status?.available === true ? String(status.latest ?? '') : ''
      if (latest === '' || latest === dismissed) return null

      const upgrade = async () => {
        setBusy(true); setNote('正在下载并安装新版本（可能要一两分钟），期间插件会热重载…'); setError('')
        try {
          const reply = await ofmApplyUpgrade()
          setNote(reply?.version !== undefined
            ? `已升级到 ${reply.version}；插件已热重载，刷新页面后生效`
            : '升级完成；刷新页面后生效')
        } catch (e) {
          const message = String(e && e.message ? e.message : e)
          // 成功路径上 host 会**先热重载插件再回响应**（`applyUpgrade` 里 reloadFromDisk 在 return 之前），
          // 所以连接被换掉时客户端可能只等来一个网络错 —— 无法与「真失败」区分。
          // 但真失败的原因（如某个文件 fetch failed）会随 500 原样到达，那就照实显示。
          setError(/abort/i.test(message)
            ? '升级请求等待超过 4 分钟仍未返回；请刷新页面查看当前版本，或到下方「升级」分区看状态'
            : message)
        } finally { setBusy(false) }
      }

      return h('div', { className: 'ofm_callout', style: { flexDirection: 'column', alignItems: 'stretch', gap: 8 } },
        h('div', null,
          h('b', null, `插件有新版本 ${latest}`),
          h('div', { className: 'ofm_note' },
            `当前 ${status.current || '?'} → 最新 ${latest}。右下角弹窗已关闭，插件更新只在这里提醒；更新说明见下方「升级」分区。`),
          // 本机事实（不是上游文案）：这一栏的「弹窗静默化 + 更新提醒」是本机补丁做的，
          // 上游自升级会覆盖 client.js ⇒ 补丁全丢。2026-10-07 实测：2.0.0 上 12 处锚点
          // 只有 8 处还能命中（3 处 drift、1 处误导性 applied）⇒ 升级后**打不回来**，得重新对齐。
          h('div', { className: 'ofm_note' },
            '升级会覆盖本机补丁（弹窗静默化 / 更新提醒），且新版结构变动后锚点可能已漂移 —— 升级前先跑 patch.mjs status 预判。')),
        h('div', { className: 'ofm_row' },
          h(Button, { disabled: busy, onClick: upgrade }, busy ? '正在升级…' : '立即升级'),
          h(Button, { kind: 'ghost', disabled: busy, onClick: () => setDismissed(latest) }, '稍后再说')),
        note !== '' ? h('p', { className: 'ofm_note' }, note) : null,
        error !== '' ? h('div', { className: 'ofm_callout ofm_error' }, error) : null)
    }
