// 验证补丁是否生效：HEAD 裁切 + 白圆补丁 → 扫描残余鲜蓝
import sharp from 'sharp'
const patch = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
  '<circle cx="11.5" cy="73.5" r="8.5" fill="white"/></svg>'
)
const src = 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/ui/icons/avatar-source.png'
const out = await sharp(src)
  .extract({ left: 34, top: 10, width: 96, height: 96 })
  .composite([{ input: patch }])
  .png()
  .toBuffer()
const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
const hits = []
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (b > 190 && (b - r) > 90 && (b - g) > 60) hits.push([x, y])
  }
}
console.log('blue after patch:', hits.length)
if (hits.length) {
  const xs = hits.map(h => h[0]), ys = hits.map(h => h[1])
  console.log('bbox:', Math.min(...xs), Math.min(...ys), '..', Math.max(...xs), Math.max(...ys))
}
