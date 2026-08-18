/* ============================================================
 * Miasaki 桌宠窗口渲染器
 * - 模式：whale（DS 鲸鱼娘立绘三态·随思考强度成长）/ kurumi / inverse（图集动画）
 * - 强度档位（由主窗口经 Rust 下发）：idle 待机 / work 常规 / deep 深度
 * - 交互：整窗拖动（data-tauri-drag-region）/ 单击跳跃+气泡 / 双击挥手 / 右键菜单
 * ============================================================ */
(function () {
  'use strict'

  function dlog(msg) {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('pet_log', { msg: msg }).catch(function () {})
      }
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('error', function (e) {
    dlog('pet-page-error: ' + (e.message || e.type) + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno)
    try {
      var d = document.createElement('div')
      d.style.cssText = 'position:fixed;left:0;top:0;right:0;background:#d00;color:#fff;font:11px monospace;padding:4px;z-index:999'
      d.textContent = 'PET-ERR: ' + e.message
      document.body.appendChild(d)
    } catch (e2) { /* ignore */ }
  })
  dlog('pet-page-boot tauri=' + !!window.__TAURI__)

  var CELL_W = 192, CELL_H = 208, COLS = 8
  var ASSET = 'http://127.0.0.1:39800/'

  var QUOTES = {
    whale: {
      idle: ['咕噜咕噜…', '（吐泡泡）', '呜~ 我在听', '（摇尾巴）'],
      work: ['正在处理…', '这个我来看看', '稍等一下下'],
      deep: ['全算力运转中！', '深海计算模式', '别打扰，正在想']
    },
    kurumi: {
      idle: ['ふふふ…', '啊啦，你来了呢', '时间，可是很宝贵的哦', '刻刻帝在看着你'],
      work: ['（轻笑）这就开始', '让我看看…', '正在处理中哦'],
      deep: ['全力以赴。', '时间加速中…', '别眨眼']
    },
    inverse: {
      idle: ['选好了吗？', '别让我等太久', '（冷笑）', '你的时间，归我支配'],
      work: ['效率。现在。', '继续。', '别停下'],
      deep: ['全力运转。', '别让我失望', '（血瞳亮起）']
    }
  }

  var ROW = { idle: 0, runRight: 1, runLeft: 2, wave: 3, jump: 4, failed: 5, wait: 6, run: 7, review: 8 }
  var FPS = { idle: 8, run: 10, wave: 10, jump: 11, wait: 6 }

  var STATE_IMAGES = { idle: 'idle.png', work: 'work.png', deep: 'deep.png' }

  var stage = document.getElementById('stage')
  var view = document.getElementById('view')
  var vctx = view.getContext('2d')
  var bubble = document.getElementById('bubble')
  var menu = document.getElementById('menu')

  var mode = 'whale'
  var intensity = 'idle'
  var atlasCache = {}
  var stateImgCache = {}
  var anim = null
  var timer = null
  var quoteTimer = null
  var busyUntil = 0
  var lastClick = 0
  var moved = 0

  /* ---------- 图集（狂三/反转） ---------- */
  function loadAtlas(name) {
    var url = ASSET + 'pets/' + name + '/spritesheet.png'
    if (atlasCache[url]) return Promise.resolve(atlasCache[url])
    return new Promise(function (resolve, reject) {
      var img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight
          var cv = document.createElement('canvas')
          cv.width = w; cv.height = h
          var cx = cv.getContext('2d')
          cx.drawImage(img, 0, 0)
          var data = cx.getImageData(0, 0, w, h).data
          var rows = Math.floor(h / CELL_H)
          var frames = {}
          for (var r = 0; r < rows; r++) {
            var cols = []
            for (var c = 0; c < COLS; c++) {
              var hits = 0
              for (var y = r * CELL_H + 4; y < (r + 1) * CELL_H - 4 && hits < 30; y += 8) {
                for (var x = c * CELL_W + 4; x < (c + 1) * CELL_W - 4; x += 8) {
                  if (data[(y * w + x) * 4 + 3] > 24) { hits++; break }
                }
              }
              if (hits >= 8) cols.push(c)
            }
            frames[r] = cols
          }
          var entry = { canvas: cv, frames: frames }
          atlasCache[url] = entry
          resolve(entry)
        } catch (e) { reject(e) }
      }
      img.onerror = function () { reject(new Error('atlas ' + name + ' load failed')) }
      img.src = url
    })
  }

  function drawCell(row, col) {
    var entry = atlasCache[ASSET + 'pets/' + mode + '/spritesheet.png']
    if (!entry) return
    vctx.clearRect(0, 0, CELL_W, CELL_H)
    vctx.drawImage(entry.canvas, col * CELL_W, row * CELL_H, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H)
  }

  function stopAnim() {
    if (timer) { clearInterval(timer); timer = null }
    anim = null
  }

  function play(stateName, opts) {
    opts = opts || {}
    var fps = opts.fps || FPS[stateName] || 8
    var loop = opts.loop !== undefined ? opts.loop : stateName === 'idle' || stateName === 'run'
    var atlasUrl = ASSET + 'pets/' + mode + '/spritesheet.png'
    loadAtlas(mode).then(function (entry) {
      var rowName = stateName === 'working' ? 'run' : stateName
      var cols = entry.frames[ROW[rowName]] || entry.frames[ROW.idle] || [0]
      if (!cols.length) cols = [0]
      stopAnim()
      var i = 0
      anim = { row: ROW[rowName], cols: cols, fps: fps, loop: loop, atlas: atlasUrl }
      function tick() {
        if (anim && anim.atlas === atlasUrl) {
          drawCell(anim.row, anim.cols[i])
          i++
          if (i >= anim.cols.length) {
            if (anim.loop) { i = 0 } else {
              stopAnim()
              if (opts.onEnd) opts.onEnd()
              return
            }
          }
        }
      }
      timer = setInterval(tick, 1000 / fps)
      tick()
    }).catch(function (e) {
      say('素材加载失败：' + String(e).slice(0, 50), 8000)
    })
  }

  /* ---------- 鲸鱼娘立绘三态 ---------- */
  function drawState() {
    var file = STATE_IMAGES[intensity] || STATE_IMAGES.idle
    var url = ASSET + 'pets/whale/states/' + file
    var cached = stateImgCache[url]
    if (cached) { drawStateNow(cached); return }
    var img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = function () { stateImgCache[url] = img; drawStateNow(img) }
    img.onerror = function () { say('立绘加载失败', 8000) }
    img.src = url
  }
  function drawStateNow(img) {
    vctx.clearRect(0, 0, CELL_W, CELL_H)
    var h = 192
    var w = img.width / img.height * h
    vctx.drawImage(img, (CELL_W - w) / 2, CELL_H - h, w, h)
  }

  /* ---------- 状态应用（动作联动） ---------- */
  function applyState() {
    view.classList.remove('bob', 'sway', 'focus', 'pulse')
    if (mode === 'whale') {
      drawState()
      void view.offsetWidth
      view.classList.add('pulse')
      view.classList.add(intensity === 'idle' ? 'bob' : (intensity === 'deep' ? 'focus' : 'sway'))
    } else {
      play(intensity === 'idle' ? 'idle' : 'working')
    }
  }

  window.__setPetMode = function (m) {
    if (m === mode) return
    mode = m
    stopAnim()
    applyState()
    refreshMenu()
  }

  window.__setIntensity = function (i) {
    if (i !== 'idle' && i !== 'work' && i !== 'deep') return
    if (i === intensity && mode === 'whale') return
    intensity = i
    if (mode === 'whale' || (mode !== 'whale' && (i === 'idle') !== (intensity === 'idle'))) {
      applyState()
    }
  }

  /* ---------- 气泡 ---------- */
  function say(text, ms) {
    bubble.innerHTML = ''
    bubble.textContent = text
    bubble.className = 'show'
    if (quoteTimer) clearTimeout(quoteTimer)
    quoteTimer = setTimeout(function () { bubble.className = 'hidden' }, ms || 3200)
  }
  function randomQuote() {
    var q = QUOTES[mode] || QUOTES.whale
    var pool = q[intensity] || q.idle
    say(pool[Math.floor(Math.random() * pool.length)])
  }

  /* ---------- 交互 ---------- */
  var dragging = null
  var movedTotal = 0

  function hop() {
    view.classList.remove('hop')
    void view.offsetWidth
    view.classList.add('hop')
  }

  // 手动拖动：指针事件 → invoke pet_move_by（增量），本地 invoke 通道稳定
  stage.addEventListener('pointerdown', function (ev) {
    if (ev.button !== 0) return
    dragging = { sx: ev.clientX, sy: ev.clientY }
    movedTotal = 0
    if (stage.setPointerCapture) stage.setPointerCapture(ev.pointerId)
  })
  stage.addEventListener('pointermove', function (ev) {
    if (!dragging) return
    var dx = Math.round(ev.clientX - dragging.sx)
    var dy = Math.round(ev.clientY - dragging.sy)
    if (Math.abs(dx) + Math.abs(dy) > 2) {
      movedTotal += Math.abs(dx) + Math.abs(dy)
      invoke('pet_move_by', { dx: dx, dy: dy })
      dragging.sx = ev.clientX
      dragging.sy = ev.clientY
    }
  })
  stage.addEventListener('pointerup', function () { dragging = null })

  stage.addEventListener('click', function () {
    hideMenu()
    if (movedTotal > 6) { movedTotal = 0; return }
    if (busyUntil > Date.now()) return
    busyUntil = Date.now() + 700
    hop()
    randomQuote()
  })

  stage.addEventListener('dblclick', function () {
    hideMenu()
    busyUntil = Date.now() + 700
    hop()
    randomQuote()
  })

  stage.addEventListener('contextmenu', function (ev) {
    ev.preventDefault()
    bubble.className = 'hidden'
    menu.classList.toggle('show')
  })

  function invoke(cmd, args) {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke(cmd, args || {}).catch(function () {})
      }
    } catch (e) { /* ignore */ }
  }

  menu.addEventListener('click', function (ev) {
    var item = ev.target && ev.target.closest ? ev.target.closest('.mi') : null
    if (!item) return
    hideMenu()
    if (item.id === 'mi-hide') { invoke('pet_hide'); return }
    if (item.id === 'mi-min') { invoke('minimize_main'); return }
    if (item.id === 'mi-exit') { invoke('exit_app'); return }
  })

  document.addEventListener('click', function (ev) {
    if (!menu.contains(ev.target) && !stage.contains(ev.target)) hideMenu()
  })

  function hideMenu() { menu.classList.remove('show') }

  function refreshMenu() {
    // 模式由主题联动驱动，菜单无模式项
  }

  /* ---------- 启动 ---------- */
  function boot() {
    dlog('boot-start mode=' + mode)
    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('pet-mode', function (ev) {
          if (ev.payload && ev.payload.mode) window.__setPetMode(ev.payload.mode)
        })
        window.__TAURI__.core.invoke('get_pet_mode').then(function (m) {
          if (m && m !== mode) window.__setPetMode(m)
        }).catch(function () {})
      }
    } catch (e) { /* ignore */ }
    applyState()
    refreshMenu()
    dlog('boot-done')
  }

  boot()
})()
