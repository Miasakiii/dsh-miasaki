// extract kurumi pet download info from petdex html
import { readFileSync } from 'node:fs'
const t = readFileSync('C:/Users/Asakii/Desktop/dsh-miasaki/desktop/scripts/petdex-kurumi.html', 'utf8')
const pats = [
  /https?:\/\/[^"'\s]+\.(?:zip|webp|png|json)/gi,
  /https?:\/\/[^"'\s]+(?:download|spritesheet|release)[^"'\s]*/gi,
  /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gi,
  /raw\.githubusercontent[^"'\s]+/gi
]
let found = false
for (const p of pats) {
  const m = t.match(p)
  if (m) {
    found = true
    console.log('PATTERN', String(p).slice(0, 40))
    console.log([...new Set(m)].slice(0, 12).join('\n'))
  }
}
if (!found) console.log('no matches at all')
