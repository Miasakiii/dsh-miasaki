// 在 petdex 资产与 codexpet.xyz 中搜索"反转狂三/白之女王/inverse kurumi"素材
// 1) petdex 全目录页（列出所有 pets 与资产 URL）
import { readFileSync, writeFileSync } from 'node:fs'

async function fetchText(url, file) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) throw new Error('http ' + r.status)
    const t = await r.text()
    writeFileSync(file, t)
    console.log('saved', url, '->', t.length, 'bytes')
    return t
  } catch (e) {
    console.log('FAIL', url, e.message)
    return ''
  }
}

// 先看 petdex 有没有 pets 目录/API
await fetchText('https://petdex.dev/pets', 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/scripts/petdex-all.html')

// 提取所有 pet 资产 URL + 名称，找 kurumi 变体
const t = readFileSync('C:/Users/Asakii/Desktop/dsh-miasaki/desktop/scripts/petdex-all.html', 'utf8')
const assetRe = /https:\/\/assets\.petdex\.dev\/pets\/([a-z0-9-]+)-[a-f0-9]+\/(sprite\.webp|zip\.zip)/gi
const names = new Set()
let m
while ((m = assetRe.exec(t))) names.add(m[1])
console.log('pets on /pets page:', [...names].join(', '))
const kurumiLike = [...names].filter(n => /kuru|inverse|white|queen|dab|bullet|zafkiel/i.test(n))
console.log('kurumi-like:', kurumiLike.join(', ') || '(none)')
