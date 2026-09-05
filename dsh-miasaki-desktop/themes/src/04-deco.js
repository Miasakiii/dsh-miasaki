
  /* ---------- 原创水印（注入层独占装饰） ---------- */
  var WATERMARKS = {
    zafkiel: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<g fill="none" stroke="#D9B36A">' +
      '<circle cx="200" cy="200" r="150" stroke-width="3"/>' +
      '<circle cx="200" cy="200" r="126" stroke-width="1"/>' +
      '<circle cx="200" cy="200" r="64" stroke-width="1.5"/>' +
      '<circle cx="148" cy="252" r="42" stroke-width="14" stroke-dasharray="5 9"/>' +
      '<circle cx="252" cy="148" r="30" stroke-width="12" stroke-dasharray="4 8"/>' +
      '<g stroke-width="2">' +
      '<path d="M200 50v26"/><path d="M200 324v26"/>' +
      '<path d="M50 200h26"/><path d="M324 200h26"/>' +
      '<g transform="rotate(30 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '<g transform="rotate(60 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '<g transform="rotate(120 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '<g transform="rotate(150 200 200)"><path d="M200 50v20"/><path d="M200 330v20"/></g>' +
      '</g>' +
      '<path d="M200 200L200 118" stroke-width="4"/>' +
      '<path d="M200 200L252 236" stroke-width="3"/>' +
      '<path d="M200 200L232 168" stroke-width="1.5"/>' +
      '</g>' +
      '<g fill="#D9B36A" font-family="Georgia,serif" font-size="24" text-anchor="middle" dominant-baseline="central">' +
      '<text x="200" y="44">XII</text><text x="284" y="53">I</text><text x="345" y="115">II</text>' +
      '<text x="368" y="200">III</text><text x="345" y="285">IV</text><text x="284" y="347">V</text>' +
      '<text x="200" y="372">VI</text><text x="116" y="347">VII</text><text x="55" y="285">VIII</text>' +
      '<text x="32" y="200">IX</text><text x="55" y="115">X</text><text x="116" y="53">XI</text>' +
      '</g></svg>',
    kurkuriel: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<g fill="none" stroke="#5E6572">' +
      '<path d="M80 200 A120 120 0 0 1 172 85" stroke-width="3"/>' +
      '<path d="M228 85 A120 120 0 0 1 320 200" stroke-width="3" stroke-dasharray="14 9"/>' +
      '<path d="M320 200 A120 120 0 0 1 228 315" stroke-width="3"/>' +
      '<path d="M172 315 A120 120 0 0 1 80 200" stroke-width="3" stroke-dasharray="6 11"/>' +
      '<circle cx="200" cy="200" r="86" stroke-width="1.5" stroke-dasharray="24 16 8 16"/>' +
      '<circle cx="200" cy="200" r="52" stroke-width="1.5"/>' +
      '<g stroke-width="2">' +
      '<path d="M200 80v22"/><path d="M200 298v22"/>' +
      '<path d="M80 200h22"/><path d="M298 200h22"/>' +
      '<g transform="rotate(45 200 200)"><path d="M200 80v16"/><path d="M200 304v16"/></g>' +
      '<g transform="rotate(135 200 200)"><path d="M200 80v16"/><path d="M200 304v16"/></g>' +
      '</g>' +
      '<path d="M200 200L200 128" stroke-width="4"/>' +
      '<path d="M200 200L243 228" stroke-width="3"/>' +
      '</g>' +
      '<g stroke="#9E1B1B" fill="none" stroke-width="2.5" stroke-linejoin="round">' +
      '<path d="M140 60 L154 44 L148 76 L168 62 L158 92 L182 88"/>' +
      '<path d="M300 332 L288 348 L294 320 L276 336 L286 308 L264 312"/>' +
      '</g>' +
      '<g fill="#5E6572" font-family="Georgia,serif" font-size="30" text-anchor="middle" dominant-baseline="central">' +
      '<text x="200" y="40">\u264c</text><text x="348" y="200">\u264d</text>' +
      '<text x="200" y="360">\u264e</text><text x="52" y="200">\u264f</text>' +
      '</g></svg>'
  }

  function buildWatermark() {
    if (!document.body || IS_LOCAL) return
    var svg = WATERMARKS[current]
    if (!svg) return
    var wm = document.createElement('div')
    wm.id = 'miasaki-watermark'
    wm.innerHTML = svg
    document.body.appendChild(wm)
  }

  /* ---------- 背景光晕层（主题个性层：DSH 面板半透明后透出） ---------- */
  function buildAurora() {
    if (document.getElementById('miasaki-aurora') || !document.body || IS_LOCAL) return
    var a = document.createElement('div')
    a.id = 'miasaki-aurora'
    a.innerHTML =
      '<div class="aur-blob aur-a"></div><div class="aur-blob aur-b"></div>' +
      '<div class="aur-blob aur-c"></div>'
    document.body.appendChild(a)
  }

  function updateAurora() {
    var a = document.getElementById('miasaki-aurora')
    if (a && a.parentNode) a.parentNode.removeChild(a)
    buildAurora()
  }

  function updateWatermark() {
    var wm = document.getElementById('miasaki-watermark')
    if (wm && wm.parentNode) wm.parentNode.removeChild(wm)
    buildWatermark()
  }

  var ICON_BASE = 'http://127.0.0.1:39800/icons/'

  // 图标加载失败时退回文字字形（data-glyph 标记便于需要重建容器的地方清理残留）
  window.__msGlyphFallback = function (img, theme) {
    try {
      img.style.display = 'none'
      var g = document.createElement('span')
      g.setAttribute('data-glyph', '1')
      g.textContent = META[theme] ? META[theme].glyph : '?'
      if (img.parentNode) img.parentNode.appendChild(g)
    } catch (e) { /* ignore */ }
  }



