// 隔离：补丁后 resize / mask 各阶段的蓝色变化
import sharp from 'sharp'
const patch = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
  '<circle cx="11.5" cy="73.5" r="8.5" fill="white"/></svg>'
)
const mask = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">' +
  '<circle cx="64" cy="64" r="64" fill="white"/></svg>'
)
const src = 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/ui/icons/avatar-source.png'

async function scan(buf, label) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
  const hits = []
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (b > 190 && (b - r) > 90 && (b - g) > 60) hits.push([x, y])
    }
  }
  if (hits.length) {
    const xs = hits.map(h => h[0]), ys = hits.map(h => h[1])
    console.log(`${label}: ${hits.length} px bbox (${Math.min(...xs)},${Math.min(...ys)})..(${Math.max(...xs)},${Math.max(...ys)})`)
  } else console.log(`${label}: clean`)
}

const base = sharp(src).extract({ left: 34, top: 10, width: 96, height: 96 })
  .composite([{ input: patch }])

await scan(await base.clone().png().toBuffer(), 'patched-crop')
await scan(await base.clone().resize(128, 128, { kernel: 'lanczos3' }).png().toBuffer(), 'patched+resize')
await scan(await base.clone().resize(128, 128, { kernel: 'lanczos3' })
  .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer(), 'patched+resize+mask')
