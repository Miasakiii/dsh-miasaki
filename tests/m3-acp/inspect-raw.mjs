// 检查原始字节：zstd 帧后是否跟着原始 JSONL 事件
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const buf = readFileSync(file)
console.log('SIZE:', buf.length)
const str = buf.toString('latin1')
const idx = str.indexOf('{"type":"user/message"')
const idx2 = str.indexOf('assistant/message')
console.log('user/message at:', idx, ' assistant/message at:', idx2)
if (idx >= 0) {
  console.log('FROM user/message:', str.slice(idx, idx + 300))
}
