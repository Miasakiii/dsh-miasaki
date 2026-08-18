// 鲜蓝杂质检测：限定左上象限，蓝纯度远高于发色
import sharp from 'sharp'
const p = 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/ui/icons/avatar-source.png'
const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true })
const hits = []
for (let y = 0; y < Math.min(90, info.height); y++) {
  for (let x = 0; x < Math.min(90, info.width); x++) {
    const i = (y * info.width + x) * info.channels
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (b > 190 && (b - r) > 90 && (b - g) > 60) hits.push([x, y, r, g, b])
  }
}
if (!hits.length) { console.log('no vivid-blue cluster in top-left quadrant'); process.exit(0) }
const xs = hits.map(h => h[0]), ys = hits.map(h => h[1])
console.log(`cluster: ${hits.length} px, bbox (${Math.min(...xs)},${Math.min(...ys)})..(${Math.max(...xs)},${Math.max(...ys)})`)
// 采样杂质周围背景色
const cx = Math.min(...xs) - 4, cy = Math.min(...ys) - 4
const j = (Math.max(0, cy) * info.width + Math.max(0, cx)) * info.channels
console.log(`bg left-top of cluster: (${data[j]},${data[j+1]},${data[j+2]})`)
const j2 = ((Math.max(...ys) + 4) * info.width + Math.max(...xs) + 4) * info.channels
console.log(`bg right-bottom of cluster: (${data[j2]},${data[j2+1]},${data[j2+2]})`)
