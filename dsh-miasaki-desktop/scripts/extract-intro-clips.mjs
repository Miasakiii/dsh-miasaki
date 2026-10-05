// extract-intro-clips.mjs — 启动片头素材入库（design/2026-10-04-boot-intro-video.md §4）。
//
// 判据与纪律：
//   · 素材是**快照不是依赖**：上游更新与本仓无关，本脚本把「取哪一段」写死成台账；
//   · 台账（id / 文件名 / 字节数 / SHA256 前 16 位）对齐上游 lib/clips.meta.js 官方值，
//     **逐段校验通过才允许落 ui/intro/** —— 半截下载、上游改动、手工替换都会被拦下；
//   · **源只在 extract（写盘）模式是前置**：优先本地 `_refs/boot-intro-clips/`（已取证副本，
//     _refs 不入库）；缺失时可用 `--fetch` 经 GitHub raw 下载（需网络）；
//   · `--check`（CI / verify 用的模式）判据**只有「已入库产物 vs 台账」**：不读源、不写盘。
//     源是未入库的本地状态，把它当这个模式的前置，闸门就会**本机假绿、CI 恒红**
//     —— 2026-10-05 CI 首次跑就踩到（本机 `_refs/` 恰好有取证副本）。
//
// 用法：
//   node scripts/extract-intro-clips.mjs            # 从 _refs 校验并拷入 ui/intro/
//   node scripts/extract-intro-clips.mjs --fetch     # 源缺失时从上游下载（tag 固定 v0.4.2）
//   node scripts/extract-intro-clips.mjs --check     # 只校验 ui/intro/ 现状（不写盘）
//
// 退出码：0 = 全部通过；1 = 有段不齐（打印逐段差异，不删旧产物）。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE_ROOT = resolve(HERE, '..')
const OUT_DIR = join(LINE_ROOT, 'ui', 'intro')
const LOCAL_SRC_DIR = resolve(LINE_ROOT, '..', '_refs', 'boot-intro-clips')

/** 上游固定 tag：素材快照口径，换 tag 必须同时改这里与台账 SHA。 */
const UPSTREAM_TAG = 'v0.4.2'
const UPSTREAM_REPO = 'NativeDog1/dsh-boot-animation'
const UPSTREAM_DIR = 'media'

/**
 * 台账（design §2.1 实测表；SHA256 前 16 位 = 上游 lib/clips.meta.js 官方值）。
 * id 即 appearance config 的 `boot.intro` 枚举值域（跨线契约，见 design §5-D10）。
 */
const CLIPS = [
  { id: 'brand', file: 'deepseek-brand-intro.mp4', bytes: 1308725, sha16: 'b22de4810e195b50' },
  { id: 'cyberpunk', file: 'deepseek-cyberpunk-intro.mp4', bytes: 1856280, sha16: 'beabf5956e0b467e' },
  { id: 'awakening', file: 'deepseek-awakening-intro.mp4', bytes: 2600325, sha16: 'ff5afe0dabc16e09' },
  { id: 'startup', file: 'deepseek-startup-intro.mp4', bytes: 3305269, sha16: 'ba72c501021444cd' },
]

const MODE = process.argv.includes('--check') ? 'check' : 'extract'
const FETCH = process.argv.includes('--fetch')

const sha16 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** 读取一段的字节；本地副本优先，--fetch 时回落上游下载。 */
async function readClip(clip) {
  const local = join(LOCAL_SRC_DIR, clip.file)
  if (existsSync(local)) return await readFile(local)
  if (!FETCH) return null
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_TAG}/${UPSTREAM_DIR}/${clip.file}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${url} → HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** 校验一段：返回 { ok, reasons[] }。 */
function verify(clip, buf) {
  const reasons = []
  if (buf === null) reasons.push('源文件缺失（本地无副本；加 --fetch 从上游下载）')
  else {
    if (buf.length !== clip.bytes) reasons.push(`字节数 ${buf.length} ≠ 台账 ${clip.bytes}`)
    const got = sha16(buf)
    if (got !== clip.sha16) reasons.push(`SHA256[0..16] ${got} ≠ 台账 ${clip.sha16}`)
  }
  return { ok: reasons.length === 0, reasons }
}

const report = []
let failed = 0

for (const clip of CLIPS) {
  const target = join(OUT_DIR, `intro-${clip.id}.mp4`)

  // ---- check：判据只有「入库产物 vs 内嵌台账」，**不要求源副本在场** ----
  // 2026-10-05 实测教训：源（`_refs/boot-intro-clips/`，未入库）曾是这个模式的前置，
  // 于是**本机假绿、CI 恒红** —— 闸门的判据一旦依赖未入库的本地状态，它就只在作者的机器上成立。
  // 源只在 extract（写盘）模式是前置；check 模式读源没有任何意义（要比的是产物）。
  if (MODE === 'check') {
    if (!existsSync(target)) {
      report.push(`✗ ${clip.id}: 产物缺失 ${target}`)
      failed += 1
      continue
    }
    const onDisk = await readFile(target)
    const disk = verify(clip, onDisk)
    if (!disk.ok) {
      report.push(`✗ ${clip.id}: 产物不符（${disk.reasons.join('；')}）`)
      failed += 1
      continue
    }
    report.push(`✓ ${clip.id}: 产物已入库且与台账一致（${clip.bytes} B）`)
    continue
  }

  // ---- extract：必须先拿到源字节（本地 _refs 副本优先，--fetch 回落上游）----
  let buf = null
  let sourceNote = ''
  try {
    buf = await readClip(clip)
    const fromLocal = existsSync(join(LOCAL_SRC_DIR, clip.file))
    sourceNote = buf === null ? '' : (fromLocal ? '本地 _refs 副本' : '上游下载')
  } catch (error) {
    report.push(`✗ ${clip.id}: ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
    continue
  }

  const { ok, reasons } = verify(clip, buf)
  if (!ok) {
    report.push(`✗ ${clip.id}: ${reasons.join('；')}`)
    failed += 1
    continue
  }

  await mkdir(OUT_DIR, { recursive: true })
  // 覆盖式写入（同内容重跑幂等）；不「先删后写」——避免失败窗口里产物消失。
  await writeFile(target, buf)
  report.push(`✓ ${clip.id}: 已写入 ui/intro/intro-${clip.id}.mp4（${clip.bytes} B，源：${sourceNote}）`)
}

console.log(`[intro-clips] 模式=${MODE}${FETCH ? ' +fetch' : ''} 台账 ${CLIPS.length} 段`)
for (const line of report) console.log('  ' + line)
if (failed > 0) {
  console.error(`[intro-clips] ${failed} 段未通过 —— 产物未改动，请核对台账与源`)
  process.exit(1)
}
console.log(`[intro-clips] 全部通过（${CLIPS.length}/${CLIPS.length}）`)
