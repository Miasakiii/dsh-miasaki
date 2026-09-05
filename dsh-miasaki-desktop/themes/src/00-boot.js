/* ============================================================
 * Miasaki 主题注入运行时（injected on every document）
 * 职责：主题属性管理 · 明暗锁定 · 悬浮切换条 · 切换过渡 · 水印
 * 构建时由 scripts/build-init.mjs 将 themes/*.css 内联进
 * window.__MIASAKI_STYLES__ 后与本文件合并。
 * ============================================================ */
(function () {
  'use strict'
  if (window.__MIASAKI_BOOTED__) return
  window.__MIASAKI_BOOTED__ = true

  // DSH web 鉴权 cookie 注入（v2026-09-05 修复「桌面端黑屏」）：
  // dsh web 重启后旧 cookie 失效 → 401 纯文本页（深色底 = 黑屏）。
  // 此处用持久 secret 动态签一个 30 天 cookie，并在 401 页自动重载。
  ;(function () {
    try {
      if (location.origin !== 'http://127.0.0.1:3080') return
      if (typeof crypto === 'undefined' || !crypto.subtle) return
      var SECRET_B64 = '2h4nw6Dhj2bmzH3ATVS3MAcld_4DEW1PieSSOi_ETas'
      var b64url = function (u8) {
        var s = ''
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      }
      var fromB64url = function (s) {
        var bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
        var u8 = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
        return u8
      }
      var run = function () {
        var secret = fromB64url(SECRET_B64)
        return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
          .then(function (key) {
            var issued = Date.now()
            var expires = issued + 30 * 86400 * 1000
            var payload = JSON.stringify({ version: 1, authority: '127.0.0.1:3080', issuedAt: issued, expiresAt: expires })
            var body = b64url(new TextEncoder().encode(payload))
            return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)).then(function (sig) {
              return { body: body, sig: b64url(new Uint8Array(sig)) }
            })
          })
          .then(function (p) {
            return crypto.subtle.digest('SHA-256', new TextEncoder().encode('127.0.0.1:3080')).then(function (dig) {
              var name = 'dsh-auth-' + b64url(new Uint8Array(dig))
              document.cookie = name + '=v1.' + p.body + '.' + p.sig + '; Path=/; Max-Age=2592000; SameSite=Strict'
              // init script 运行于 document_start，body 尚未就绪：延迟复查 401 页并重载
              var check = function () {
                try {
                  var txt = document.body ? (document.body.innerText || '') : ''
                  if (txt.indexOf('authentication required') !== -1) {
                    location.reload()
                  }
                } catch (e2) { /* ignore */ }
              }
              check()
              setTimeout(check, 400)
            })
          })
      }
      run().catch(function () {})
    } catch (e) { /* ignore */ }
  })()

  // 全局错误陷阱：异常可视化到屏幕左上角（诊断用，可被 MiMo 读取）
  var ERR_COUNT = 0
  window.addEventListener('error', function (e) {
    ERR_COUNT++
    try {
      var d = document.createElement('div')
      d.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#d00;color:#fff;' +
        'font:11px monospace;padding:5px 8px;max-width:700px;white-space:pre-wrap;border-radius:0 0 8px 0'
      d.textContent = 'MIASAKI-ERR: ' + (e.message || e.type) + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno
      document.body.appendChild(d)
    } catch (e2) { /* ignore */ }
  })

  var STYLES = (typeof window.__MIASAKI_STYLES__ === 'object' && window.__MIASAKI_STYLES__) || {}
  var KEY = 'miasaki.theme'
  var ORDER = ['pure', 'zafkiel', 'kurkuriel']
  var META = {
    pure: { name: '原版', sub: '简约纯净', glyph: '\u25EF', icon: 'theme-pure.png' },
    zafkiel: { name: '刻刻帝', sub: 'Zafkiel \u00b7 XII', glyph: 'XII', icon: 'theme-zafkiel.png' },
    kurkuriel: { name: '狂狂帝', sub: 'Kurkuriel \u00b7 \u53cd\u8f6c', glyph: '\u264f', icon: 'theme-inverse.png' }
  }
  var TIPS = {
    pure: '\u539f\u7248 DSH \u00b7 \u7b80\u7ea6\u7eaf\u51c0',
    zafkiel: '\u3075\u3075\u3075\uff0c\u4eca\u665a\u7684\u65f6\u95f4\u4e5f\u5c5e\u4e8e\u6211\u5462',
    kurkuriel: '\u9009\u597d\u4e86\u5417\uff1f\u6211\u8ba8\u538c\u72b9\u8c6b\u7684\u4eba'
  }
  var FORCE_DARK = { pure: null, zafkiel: true, kurkuriel: false }
  // 原版主题明暗三档：system=跟随 DSH 自身偏好 / light / dark
  var BRIGHT = 'system'
  try {
    var bs = localStorage.getItem('miasaki.bright')
    if (bs === 'light' || bs === 'dark' || bs === 'system') BRIGHT = bs
  } catch (e) { /* ignore */ }
  var PET_MODES = { pure: 'whale', zafkiel: 'kurumi', kurkuriel: 'inverse' }

