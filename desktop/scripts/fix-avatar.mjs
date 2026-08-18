// fix-avatar.mjs — 把消除补丁永久烙进源图主副本（avatar-source.png）
// 杂质：鲜蓝箭头图标，实测 bbox (40,78)..(51,89)，周围为白衣领（纯白）
import sharp from 'sharp'
const p = 'C:/Users/Asakii/Desktop/dsh-miasaki/desktop/ui/icons/avatar-source.png'
const patch = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="165">' +
  '<circle cx="45.5" cy="83.5" r="10" fill="white"/>' +
  '<circle cx="45.5" cy="83.5" r="6" fill="white"/></svg>'
)
await sharp(p)
  .composite([{ input: patch }])
  .png()
  .toFile(p.replace('.png', '-patched.png'))
console.log('patched copy written')
// 验证：扫补丁后的蓝
const { data, info } = await sharp(p.replace('.png', '-patched.png')).raw().toBuffer({ resolveWithObject: true })
const hits = []
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (b > 190 && (b - r) > 90 && (b - g) > 60) hits.push([x, y])
  }
}
console.log('vivid blue after bake:', hits.length)
