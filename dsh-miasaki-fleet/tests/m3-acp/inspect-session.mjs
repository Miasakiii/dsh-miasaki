// 流式解压全部 zstd 帧，查找 usage/token 事件（M3.5 计量接通用）
import { readFileSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const out = []
const ds = createZstdDecompress()
ds.on('data', (c) => { out.push(c) })
ds.on('error', (e) => { console.error('stream err:', e.message) })
await new Promise((resolve) => {
  ds.on('end', resolve)
  ds.end(buf)
})
const t = Buffer.concat(out).toString('utf8')
console.log('DECOMPRESSED LEN:', t.length)
const lines = t.split('\n').filter((x) => x.trim())
console.log('LINES:', lines.length)
for (const l of lines) {
  if (/usage|tokens|turn\/end/i.test(l)) {
    console.log(l.slice(0, 700))
    console.log('---')
  }
}
