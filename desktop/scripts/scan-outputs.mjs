// 对比扫描：所有含补丁路径的产物中的鲜蓝像素分布
import sharp from 'sharp'
const files = [
  ['theme-pure.png', 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/ui/icons/theme-pure.png'],
  ['app.png', 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/ui/icons/app.png'],
  ['app-icon-source.png', 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/src-tauri/app-icon-source.png']
]
for (const [name, path] of files) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
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
    console.log(`${name}: ${hits.length} px, bbox (${Math.min(...xs)},${Math.min(...ys)})..(${Math.max(...xs)},${Math.max(...ys)}) / size ${info.width}x${info.height}`)
  } else {
    console.log(`${name}: clean`)
  }
}
