  /* ---------- 悬浮切换条（全部变量带回退色，样式层异常时仍可见可用） ---------- */
  var SWITCHER_CSS =
    '#miasaki-switcher{position:fixed;right:16px;bottom:16px;z-index:99990;' +
    'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;user-select:none;' +
    'direction:ltr;text-align:left;}' +
    '#miasaki-switcher .ms-btn{position:relative;width:46px;height:46px;border-radius:50%;display:flex;' +
    'align-items:center;justify-content:center;cursor:pointer;' +
    'background:var(--ms-panel,#1e1a27);border:2px solid var(--ms-accent,#d9b36a);color:var(--ms-accent,#d9b36a);' +
    'box-shadow:0 0 0 4px rgba(0,0,0,.22),0 6px 20px rgba(0,0,0,.5);' +
    'transition:transform .2s ease;' +
    'font-family:Georgia,"Times New Roman",serif;font-size:13px;font-weight:700;}' +
    '#miasaki-switcher .ms-btn::after{content:"";position:absolute;inset:-6px;border-radius:50%;' +
    'border:1px solid var(--ms-accent,#d9b36a);opacity:.5;animation:ms-ping 2.6s ease-out infinite;}' +
    '@keyframes ms-ping{0%{transform:scale(.8);opacity:.6}70%{transform:scale(1.15);opacity:0}100%{opacity:0}}' +
    '#miasaki-switcher .ms-btn:hover{transform:scale(1.08);}' +
    '#miasaki-switcher .ms-panel{position:absolute;right:0;bottom:62px;display:none;' +
    'flex-direction:column;gap:4px;padding:8px;border-radius:12px;min-width:176px;' +
    'background:var(--ms-panel,#1e1a27);border:1px solid var(--ms-accent,#d9b36a);color:var(--ms-text,#e4def0);' +
    'box-shadow:0 12px 30px rgba(0,0,0,.5);z-index:1;}' +
    '#miasaki-switcher.open .ms-panel{display:flex;}' +
    '#miasaki-switcher .ms-opt{display:flex;align-items:center;gap:10px;padding:7px 10px;' +
    'border-radius:8px;cursor:pointer;}' +
    '#miasaki-switcher .ms-opt:hover{background:var(--ms-hover,#2a2434);}' +
    '#miasaki-switcher .ms-opt.active{box-shadow:inset 0 0 0 1.5px var(--ms-accent,#d9b36a);}' +
    '#miasaki-switcher .ms-glyph{width:30px;height:30px;flex:none;border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;' +
    'border:1px solid var(--ms-accent,#d9b36a);color:var(--ms-accent,#d9b36a);background:transparent;}' +
    '#miasaki-switcher .ms-name{font-size:13px;font-weight:600;}' +
    '#miasaki-switcher .ms-sub{font-size:11px;opacity:.62;}' +
    '#miasaki-switcher .ms-tip{font-size:11px;opacity:.55;padding:3px 10px 1px;max-width:200px;}' +
    '#miasaki-overlay{position:fixed;inset:0;z-index:99999;pointer-events:none;opacity:0;}' +
    '#miasaki-overlay.run{animation:ms-sweep .4s ease forwards;}' +
    '@keyframes ms-sweep{0%{opacity:0}45%{opacity:.85}100%{opacity:0}}' +
    '@media (prefers-reduced-motion: reduce){' +
    '#miasaki-switcher .ms-btn::after{animation:none}' +
    '#miasaki-titlebar .tb-brand{animation:none}' +
    '#miasaki-overlay.run{animation:ms-sweep .15s ease forwards;}}' +
    '#miasaki-switcher .ms-bright{display:none;align-items:center;gap:6px;padding:5px 10px 2px;' +
    'border-top:1px solid var(--ms-border,#3a3243);margin-top:4px;}' +
    '#miasaki-switcher .ms-bright .mb-label{font-size:11px;opacity:.6;margin-right:4px;}' +
    '#miasaki-switcher .ms-bright .mb{width:26px;height:26px;border-radius:50%;display:flex;' +
    'align-items:center;justify-content:center;cursor:pointer;font-size:13px;' +
    'border:1px solid transparent;opacity:.55;}' +
    '#miasaki-switcher .ms-bright .mb:hover{background:var(--ms-hover,#2a2434);opacity:.9;}' +
    '#miasaki-switcher .ms-bright .mb.on{border-color:var(--ms-accent,#d9b36a);opacity:1;}' +
    // 标题栏 = 零占位叠加层(V4):对 DSH 页面零布局侵入——不设色带、不推挤页面(y=0 起,
    // 页面顶部控件与 web 端同位置)。窗控三键无壳裸排右上角(去胶囊:无底色/无边框/无毛
    // 玻璃/padding),hover 底色只落在单按钮上(Win11 原生标题栏同款);标题栏容器
    // pointer-events:none,仅按钮组内子元素接收事件;拖动由 06-titlebar.js 的 document
    // 级命中判定接管(空白拖动,可点击元素一律放行)。
    '#miasaki-titlebar{position:fixed;left:0;top:0;right:0;height:0;z-index:100000;' +
    'pointer-events:none;background:transparent;' +
    'color:var(--dsw-alias-label-primary,var(--ms-text,#e4def0));font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'user-select:none;-webkit-user-select:none;cursor:default;}' +
    '#miasaki-titlebar>*{pointer-events:auto;}' +
    // 按钮组纵向位置:DSH 视图控件的垂直中心落在 24~25px(会话头 titleRow = header
    // padding-top 10px + 30px 行高内居中;dockkit strip = padding-top 10px + 28px 高),
    // 故 top:11px 使 26px 裸键组中心停在 24px,与官方「展开/收起」同一条水平线;
    // 旧值 5px 会让中心停在 18px,与官方控件错开 6~7px。
    '#miasaki-titlebar .tb-group{position:fixed;top:11px;right:8px;display:flex;align-items:center;gap:2px;}' +
    '#miasaki-titlebar .tb-brand{width:16px;height:16px;border-radius:50%;flex:none;object-fit:cover;display:block;' +
    'margin:0 4px;box-shadow:0 0 5px var(--ms-glow,rgba(217,179,106,.35));}' +
    '@keyframes ms-brand-breathe{0%,100%{opacity:.78}50%{opacity:1}}' +
    '#miasaki-titlebar .tb-btn{width:26px;height:26px;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;font-size:13px;border-radius:7px;color:var(--dsw-alias-label-secondary,var(--ms-text,#e4def0));' +
    'opacity:.92;transition:background .15s ease,color .15s ease;}' +
    '#miasaki-titlebar .tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--ms-hover,#2a2434));' +
    'color:var(--dsw-alias-label-primary,var(--ms-accent,#d9b36a));opacity:1;}' +
    '#miasaki-titlebar .tb-btn:active{transform:scale(.94);}' +
    // 按钮图标统一 SVG 线形：同一视口/描边/端帽，消除字符字形(–/□/✕)粗细基线不一
    '#miasaki-titlebar .tb-btn svg{width:11px;height:11px;display:block;fill:none;' +
    'stroke:currentColor;stroke-width:1;stroke-linecap:round;stroke-linejoin:round;}' +
    '#miasaki-titlebar .tb-btn.tb-close:hover{background:var(--ms-danger,#c23a2e);color:#fff;opacity:1;}' +
    // ---------- 右上角安全区:官方右栏两处控件的让位(DSH 0.1.5 起) ----------
    // 窗控裸键组实测宽 = 徽章(16+4×2=24) + 三键(26×3=78) + gap(2×3=6) = 108px,加
    // right:8px 后恒占「距窗口右缘 [8,116]px、高 [11,37]px」这一带。DSH 0.1.5 官方右栏
    // 有两个控件正好落在这里,且按钮尺寸(28px)/图标(15px)都比窗控大,叠压后双方都难点:
    //   ① 折叠态的「打开侧边栏」= conversation.session.header.corner 里的 ExpandButton
    //      (只在右栏折叠时渲染);官方自带 margin-right:-16px 会把按钮推进安全区。
    //   ② 展开态的面板 chrome = dockkit strip 末端的全屏/收起两键,该 strip 官方只有
    //      padding-right:6px,按钮右缘落在距窗口右缘 6px 处 —— 与窗控几乎完全重合。
    // 旧规则只认 [role="tablist"],而该行仅在 view tab 数 >1 时渲染(官方 tabs.length>1),
    // 单 tab 会话下整条让位静默失效;且 118px 未计入 corner 的 -16px,实际只让出 102px。
    // 现在按恒存锚点让位:corner 容器(条件属性但它恒在 DOM,仅 :empty 时 display:none)
    // 与 dockkit 的 data-dockkit-strip-chrome(恒存)。后者只在 chromePaneId(分栏时最右
    // 一格)渲染,故分栏左格天然不受影响。两条让位线都落在 --ms-titlebar-reserve 上,
    // 与官方控件保持 12px 呼吸位。选择器一律带 #root 提权,压过官方 CSS Module(注入
    // 时机晚于我们,同特异性会反超)。
    ':root{--ms-titlebar-reserve:128px;}' +
    '#root header:has([data-conversation-header-corner]){padding-right:var(--ms-titlebar-reserve);}' +
    // 展开(推挤)时**主动撤回**让位:收起态中栏延伸到窗口右缘,窗控会压住会话头右端的
    // 展开按钮;而推挤展开时(`data-sidebar-right-panel="push"` + 官方 panel 上的
    // `data-sidebar-right-open` —— panel 用 transform:translate(100%) 移出屏幕、并未卸载,
    // 故该属性才是可靠的开合判据)窗控压的是**右栏**头部,中栏右边界已退到分栏线内,
    // 会话头再留安全区就是白空。2026-09-10 实测:展开态 `⋯` 右边界距分栏线 144px
    // (= 128 让位 + 官方 28 padding)。
    //
    // ⚠ 必须写成**覆写**,而不是"给上面那条加 :not() 门控":已经发布出去的壳二进制里嵌着
    // 上面那条**无条件**规则(include_str! 编译期内嵌),源文件改了、页面上的旧规则也不会
    // 消失;门控版在展开态"不匹配",等于没人去覆盖它,让位照旧生效(这就是上一版失效的
    // 原因)。覆写靠特异性取胜:`#root:has([a][b]) header:has([c])` = (1,3,1) > 原规则 (1,1,1)。
    // 28px 是官方 header 的 padding-right(`.wSkVaW_header{padding:10px 28px 0 20px}`),
    // 官方若改需同步此处。
    // 已知限制:浮窗模式(data-sidebar-right-float-host)下 panel 仍带 push+open,会被判为
    // 已展开而撤回让位 —— 浮窗不占布局、中栏满宽,严格说仍应让位。浮窗是低频用法,
    // 需要时再用 float-host 判据补上。
    '#root:has([data-sidebar-right-panel="push"][data-sidebar-right-open]) header:has([data-conversation-header-corner]){padding-right:28px}' +
    '#root [data-conversation-header-corner]{margin-right:0;}' +
    '#root [data-sidebar-right-panel] [data-dockkit-strip-chrome]{' +
    'margin-right:calc(var(--ms-titlebar-reserve) - 6px);}' +
    // ---------- 基线同心:会话头控件与窗控/右栏 chrome 落在同一条中心线 ----------
    // 官方两处控件的垂直中心本来就不齐:会话头 titleRow = padding-top 10px + min-height
    // 30px,28px 控件居中 ⇒ 中心 25px;而 dockkit strip(10px + 28px)与窗控组(top:11px +
    // 26px)都是 24px。收起态多看 1px 偏差,展开态因为会话头里没有可比控件而看不出来。
    // 2026-09-10 像素实测(用户截图逐控件切分):展开态全部控件 cy=19.5~20.0(齐);
    // 收起态会话头控件 cy=21.5~22.0 而窗控 cy=17.5~18.0 —— 差的 4px 里 3px 来自
    // canvas 切换器把 titleRow 撑高到 36px(已在该线收敛到 30px),余下这 1px 是官方
    // 两处的固有差,在这里补齐。仅位移不改布局:top:-1px 不参与 flex 计算,控件仍在
    // header 的 padding 内,不会被裁。
    '#root [class*="_headerActions"],#root [class*="_headerUtilities"],' +
    '#root [class*="_headerCorner"]{position:relative;top:-1px;}' +
    'html,body{height:100%;overflow:hidden;}' +
    'html,body{height:100%;overflow:hidden;}' +
    '#miasaki-switcher .ms-glyph img{width:24px;height:24px;border-radius:50%;object-fit:cover;display:block;}' +
    '#miasaki-switcher .ms-btn img{width:30px;height:30px;border-radius:50%;object-fit:cover;display:block;}' +
    '#miasaki-aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;' +
    'transition:opacity .6s ease;}' +
    '#miasaki-aurora .aur-blob{position:absolute;border-radius:50%;filter:blur(90px);' +
    'opacity:0;transition:opacity 1.2s ease;}' +
    '#miasaki-aurora .aur-a{width:52vw;height:52vw;left:-14vw;top:-18vw;}' +
    '#miasaki-aurora .aur-b{width:44vw;height:44vw;right:-12vw;top:16vw;}' +
    '#miasaki-aurora .aur-c{width:38vw;height:38vw;left:28vw;bottom:-16vw;}' +
    '#miasaki-close-mask{position:fixed;inset:0;z-index:100001;background:rgba(6,5,10,.55);' +
    'opacity:0;pointer-events:none;transition:opacity .2s ease;}' +
    '#miasaki-close-mask.on{opacity:1;pointer-events:auto;}' +
    '#miasaki-close-dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'z-index:100002;display:none;min-width:320px;max-width:430px;border-radius:12px;' +
    'padding:18px 20px 16px;background:var(--ms-panel,#1e1a27);border:1px solid var(--ms-accent,#d9b36a);' +
    'color:var(--ms-text,#e4def0);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'box-shadow:0 18px 44px rgba(0,0,0,.55);}' +
    '#miasaki-close-dialog.on{display:block;}' +
    '#miasaki-close-dialog .mc-title{font-size:14.5px;font-weight:600;margin-bottom:6px;}' +
    '#miasaki-close-dialog .mc-body{font-size:12.5px;line-height:1.65;opacity:.82;}' +
    '#miasaki-close-dialog .mc-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;}' +
    '#miasaki-close-dialog .mc-btn{padding:6px 16px;font-size:12.5px;border-radius:6px;cursor:pointer;' +
    'border:1px solid var(--ms-border,#3a3243);background:transparent;color:var(--ms-text,#e4def0);' +
    'font-family:inherit;letter-spacing:.04em;}' +
    '#miasaki-close-dialog .mc-btn:hover{background:var(--ms-hover,#2a2434);}' +
    '#miasaki-close-dialog .mc-btn.mc-ok{background:var(--ms-danger,#c23a2e);' +
    'border-color:var(--ms-danger,#c23a2e);color:#fff;}' +
    '#miasaki-close-dialog .mc-btn.mc-ok:hover{filter:brightness(1.08);}'

  var switcher = null
  var overlay = null

  function refreshSwitcher() {
    if (!switcher) return
    var btn = switcher.querySelector('.ms-btn')
    if (btn) {
      btn.innerHTML = '<img src="' + ICON_BASE + META[current].icon + '" alt=""' +
        ' onerror="window.__msGlyphFallback && window.__msGlyphFallback(this, \'' + current + '\')">'
    }
    var opts = switcher.querySelectorAll('.ms-opt')
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('active', opts[i].getAttribute('data-theme') === current)
    }
    var tip = switcher.querySelector('.ms-tip')
    if (tip) tip.textContent = TIPS[current]
    var bright = switcher.querySelector('.ms-bright')
    if (bright) {
      bright.style.display = current === 'pure' ? 'flex' : 'none'
      var mbs = bright.querySelectorAll('.mb')
      for (var j = 0; j < mbs.length; j++) {
        mbs[j].classList.toggle('on', mbs[j].getAttribute('data-b') === BRIGHT)
      }
    }
    switcher.setAttribute('title', TIPS[current])
  }

  function runOverlay(target) {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || !document.body) { apply(target); ensurePersonaSession(target); return }
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'miasaki-overlay'
      document.body.appendChild(overlay)
    }
    overlay.style.background = (target === 'zafkiel')
      ? 'radial-gradient(circle at 50% 50%, rgba(217,179,106,.9) 0%, rgba(194,58,46,.55) 55%, rgba(12,11,17,0) 75%)'
      : (target === 'kurkuriel')
        ? 'linear-gradient(100deg, rgba(158,27,27,.85) 0%, rgba(36,31,34,.9) 45%, rgba(158,27,27,0) 75%)'
        : 'radial-gradient(circle, rgba(128,128,128,.35), rgba(128,128,128,0) 70%)'
    overlay.classList.remove('run')
    void overlay.offsetWidth
    overlay.classList.add('run')
    setTimeout(function () {
      apply(target)
      ensurePersonaSession(target)
      overlay.classList.remove('run')
    }, reduced ? 150 : 400)
  }

  function buildSwitcher() {
    if (!document.body || IS_LOCAL) return
    // 仅当切换条真实挂载在文档中时才视为已构建：若元素被页面重渲染移除，
    // switcher 变量仍指向旧节点（parentNode=null），此前按变量非空判断会导致
    // 1s 巡检永远无法重建（按钮永久消失）；构建中途抛错时同理可重试。
    if (switcher && switcher.parentNode) return
    switcher = document.createElement('div')
    switcher.id = 'miasaki-switcher'
    var html = '<div class="ms-btn" title=""></div><div class="ms-panel">'
    for (var i = 0; i < ORDER.length; i++) {
      var t = ORDER[i]
      html += '<div class="ms-opt" data-theme="' + t + '">' +
        '<div class="ms-glyph"><img src="' + ICON_BASE + META[t].icon + '" alt=""' +
        ' onerror="window.__msGlyphFallback && window.__msGlyphFallback(this, \'' + t + '\')"></div>' +
        '<div><div class="ms-name">' + META[t].name + '</div>' +
        '<div class="ms-sub">' + META[t].sub + '</div></div></div>'
    }
    // 原版主题明暗三档（仅纯色主题显示）
    html += '<div class="ms-bright"><span class="mb-label">明暗</span>' +
      '<span class="mb" data-b="light" title="浅色">\u2600</span>' +
      '<span class="mb" data-b="dark" title="深色">\u263E</span>' +
      '<span class="mb" data-b="system" title="跟随系统">\u{1F5A5}</span></div>'
    html += '<div class="ms-tip"></div></div>'
    switcher.innerHTML = html
    var opts = switcher.querySelectorAll('.ms-opt')
    for (var ki = 0; ki < opts.length; ki++) {
      var oo = opts[ki]
      var tt = oo.getAttribute('data-theme')
      oo.setAttribute('title', TIPS[tt] || (META[tt].name + ' · ' + META[tt].sub))
    }
    (function bindTipHover() {
      try {
        var tip = switcher.querySelector('.ms-tip')
        var opts2 = switcher.querySelectorAll('.ms-opt')
        for (var k2 = 0; k2 < opts2.length; k2++) {
          (function (optEl) {
            var tt2 = optEl.getAttribute('data-theme')
            optEl.addEventListener('mouseenter', function () {
              if (tip && TIPS[tt2]) tip.textContent = TIPS[tt2]
            })
            optEl.addEventListener('mouseleave', function () {
              if (tip) tip.textContent = TIPS[current]
            })
          })(opts2[k2])
        }
      } catch (e) {}
    })()
    switcher.addEventListener('click', function (ev) {
      var opt = ev.target && ev.target.closest ? ev.target.closest('.ms-opt') : null
      if (opt) {
        var target = opt.getAttribute('data-theme')
        switcher.classList.remove('open')
        // M2 S6 双入口：让位时本地 apply 已停用（styleFor 只出 deco），换肤改为写
        // 外观线配置；成功后自行同步 <html> 门控属性（与 appearance client 半 save()
        // 的同步逻辑同源、幂等）——appearance 的 yieldObserver 感知翻转；切回 pure
        // 会解除让位，desktop 自动恢复注入。桌宠人格随目标主题联动。
        if (appearanceYield()) {
          try {
            fetch('/appearance/api/state').then(function (s) { return s.json() }).then(function (st) {
              return fetch('/appearance/api/config', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ patch: { theme: { skin: target } }, expectedRevision: st.revision })
              })
            }).then(function (res) {
              if (!res.ok) return
              var root = document.documentElement
              root.setAttribute('data-mia-appearance', 'on')
              root.setAttribute('data-mia-skin', target)
              try { notifyPet(target) } catch (e2) { /* 桌宠联动失败不阻断 */ }
            }).catch(function () {})
          } catch (e) { /* fetch 不可用（本地页）时静默 */ }
          return
        }
        if (target !== current) runOverlay(target)
        return
      }
      var mb = ev.target && ev.target.closest ? ev.target.closest('.mb') : null
      if (mb) {
        BRIGHT = mb.getAttribute('data-b')
        try { localStorage.setItem('miasaki.bright', BRIGHT) } catch (e) { /* ignore */ }
        syncDark()
        refreshSwitcher()
        return
      }
      if (ev.target && ev.target.closest && ev.target.closest('.ms-btn')) {
        switcher.classList.toggle('open')
      }
    })
    // hover 展开 + 延迟关闭:鼠标移出后 300ms 宽限,移回则取消(解决"一挪开就点不到")
    var closeTimer = null
    function openPanel() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      switcher.classList.add('open')
    }
    function scheduleClose() {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = setTimeout(function () {
        switcher.classList.remove('open')
        closeTimer = null
      }, 300)
    }
    switcher.addEventListener('mouseenter', openPanel)
    switcher.addEventListener('mouseleave', scheduleClose)
    // 面板自身 hover 时保持展开(面板是 switcher 子元素,mouseleave 不触发,此兜底防误关)
    var panel = switcher.querySelector('.ms-panel')
    if (panel) panel.addEventListener('mouseenter', openPanel)
    document.body.appendChild(switcher)
    refreshSwitcher()
  }
