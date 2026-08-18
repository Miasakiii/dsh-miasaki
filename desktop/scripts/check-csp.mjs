// 检查 DSH 页面 HTML 中的 CSP meta 与安全头
const r = await fetch('http://127.0.0.1:3080/')
const t = await r.text()
console.log('headers:', JSON.stringify(Object.fromEntries(r.headers.entries())))
const cspMeta = t.match(/<meta[^>]*content-security-policy[^>]*>/gi)
console.log('CSP meta:', cspMeta ? JSON.stringify(cspMeta) : 'NONE')
const metas = t.match(/<meta[^>]*>/gi) || []
console.log('all meta tags:')
metas.slice(0, 15).forEach(m => console.log('  ' + m.slice(0, 160)))
