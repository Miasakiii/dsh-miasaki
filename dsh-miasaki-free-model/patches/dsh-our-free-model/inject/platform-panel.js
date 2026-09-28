    /**
     * 【补丁注入 · @miasaki/dsh-free-model】本机自配平台。
     *
     * 把「免费模型」线的扫描能力接进本页：数据走同源路由 `/freemodel-api/*`
     * （cookie 自动携带，与内核 `/api` 同级），那个插件不在场时整块退化成一行说明，
     * 不抛错、不影响本页其它分区。
     *
     * 样式全部复用本页已有的 `ofm_*` 类（`ofm_panel` / `ofm_card` / `ofm_badge` /
     * `ofm_tags` / `ofm_metrics` / `ofm_field` / `ofm_input` / `ofm_callout`），
     * 所以它与上面的模型清单看起来是同一套设计的一部分。
     *
     * 文案刻意用中文字面量、不走本页的 `t()` 字典 —— 那套字典是上游插件的 i18n 体系，
     * 补丁不去改它（少一处锚点就少一处升级漂移面）。
     *
     * 依赖（都在本文件的 factory 作用域里）：`h` / `useState` / `useEffect` /
     * `Button` / `kilo`。
     */
    function PlatformScanPanel() {
      /** undefined = 正在读；null = 那条线不在场；数组 = 平台清单。 */
      const [platforms, setPlatforms] = useState(undefined)
      const [selected, setSelected] = useState('')
      const [detected, setDetected] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        fetch('/freemodel-api/status', { redirect: 'error' })
          .then(res => (res.ok ? res.json() : null))
          .then(payload => {
            if (!alive) return
            const list = payload && payload.ok && Array.isArray(payload.platforms) ? payload.platforms : null
            setPlatforms(list)
            if (list && list.length > 0) {
              setSelected(current => (current !== '' && list.some(p => p.id === current) ? current : list[0].id))
            }
          })
          .catch(() => { if (alive) setPlatforms(null) })
        return () => { alive = false }
      }, [])

      const call = async (path, body) => {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
        })
        const payload = await res.json()
        if (!payload.ok) throw new Error(payload.error || '请求失败')
        return payload
      }

      /** 统一的忙碌/错误/提示包装：任何一个动作都不该让整块面板变成错误页。 */
      const guard = async fn => {
        setBusy(true); setError(''); setNote('')
        try { await fn() } catch (e) { setError(String(e && e.message ? e.message : e)) } finally { setBusy(false) }
      }

      if (platforms === undefined) return h('p', { className: 'ofm_note' }, '正在读取本机平台…')

      if (platforms === null) {
        return h('div', { className: 'ofm_callout' },
          h('div', null,
            h('b', null, '「免费模型」插件不在场'),
            h('div', null, '扫描本机自配平台的能力来自 @miasaki/dsh-free-model。装上它之后，这里会列出所有带 baseURL 的 OpenAI 兼容平台，并按免费规则检出模型、给出能力画像。')))
      }

      const current = platforms.find(p => p.id === selected)
      const models = (detected && detected.models) || []
      const rows = models.map(m => {
        const profile = m.profile || {}
        const tags = [...(profile.strengths || []), ...(profile.warnings || [])]
        return h('div', { className: 'ofm_card', key: m.id },
          h('div', { className: 'ofm_cardhead' },
            h('span', { className: 'ofm_cardname' }, m.name || m.id),
            h('span', { className: 'ofm_badge' }, profile.canAgent ? '子代理可用' : '仅问答')),
          h('div', { className: 'ofm_id' }, m.id),
          h('div', { className: 'ofm_metrics' },
            h('span', null, '上下文 ', h('b', null, m.contextWindow == null ? '—' : kilo(m.contextWindow))),
            h('span', null, '最长输出 ', h('b', null, m.maxTokens == null ? '—' : kilo(m.maxTokens)))),
          tags.length > 0
            ? h('div', { className: 'ofm_tags' }, tags.map(tag => h('span', { className: 'ofm_tag', key: tag }, tag)))
            : null,
          h('p', { className: 'ofm_note' }, profile.verdict || ''),
          h('div', { className: 'ofm_row' },
            h(Button, {
              disabled: busy,
              onClick: () => guard(async () => {
                const reply = await call('/freemodel-api/apply', { platform: selected, ids: [m.id] })
                setNote(`已写入 ${reply.written} 个模型到 ${reply.platform} 的配置`)
              }),
            }, '写入配置'),
            h(Button, {
              disabled: busy,
              onClick: () => guard(async () => {
                const reply = await call('/freemodel-api/subagent', { provider: selected, model: m.id, maxTokens: 32768 })
                setNote(`子代理后端已切到 ${reply.provider} / ${reply.model}（${reply.updated.join('、')}），新会话生效`)
              }),
            }, '设为子代理')))
      })

      return h('div', { className: 'ofm_panel' },
        h('div', { className: 'ofm_row' },
          h('label', { className: 'ofm_field', style: { flex: 1, minWidth: 240 } },
            h('span', { className: 'ofm_note' }, '平台 · llm-pi-ai.providers 里带 baseURL 的 OpenAI 兼容路由'),
            h('select', {
              className: 'ofm_input',
              value: selected,
              disabled: busy,
              onChange: event => { setSelected(event.target.value); setDetected(undefined); setNote(''); setError('') },
            }, platforms.length === 0
              ? h('option', { value: '' }, '（没有可用平台）')
              : platforms.map(p => h('option', { key: p.id, value: p.id }, `${p.displayName} · 已配置 ${p.configuredCount}`)))),
          h(Button, {
            disabled: busy || selected === '',
            onClick: () => guard(async () => {
              const reply = await call('/freemodel-api/detect', { platform: selected })
              setDetected(reply)
              setNote(`检出 ${reply.models.length} 个免费模型（该端点共 ${reply.total} 个）`)
            }),
          }, busy ? '处理中…' : '检测免费模型'),
          models.length > 0
            ? h(Button, {
                disabled: busy,
                onClick: () => guard(async () => {
                  const reply = await call('/freemodel-api/apply', { platform: selected })
                  setNote(`已写入 ${reply.written} 个模型到 ${reply.platform} 的配置`)
                }),
              }, '全部写入配置')
            : null),
        error ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, error)) : null,
        note ? h('p', { className: 'ofm_note' }, note) : null,
        current && current.configured.length > 0
          ? h('div', { className: 'ofm_tags' }, current.configured.map(c => h('span', { className: 'ofm_tag', key: c.id }, c.id)))
          : null,
        models.length > 0
          ? h('div', { className: 'ofm_grid' }, rows)
          : detected !== undefined ? h('p', { className: 'ofm_note' }, '这个平台没有检出免费模型。') : null)
    }
