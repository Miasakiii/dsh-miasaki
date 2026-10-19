// gen-sfx.mjs — 桌宠音效构建期合成（design/2026-10-17-pet-fullscreen-sfx-sprint.md §3.1）。
//
// 判据与纪律：
//   · **零音频资产**：全部音效由振荡器/噪声经包络、频率斜坡、颤音、滤波器现场合成
//     （合成器照搬 Coopanion `web/sound.js` 的 tone/noise 参数形），构建期写成
//     PCM WAV 后编译期内嵌（build.rs 显式登记）——调音只改本文件的参数表，
//     不引入任何第三方音频文件依赖；
//   · **确定性**：噪声源用种子 PRNG（mulberry32），同参数重放逐字节一致 ⇒
//     `--check` 可以在内存里重建并与落盘产物逐字节比对，**生成器即台账**
//     （不需要外链式台账——intro-clips 那种「上游变动」风险在这里不存在）；
//   · `--check`（CI / verify 用的模式）**不写盘、不读源**：只比对 ui/pets/sfx/ 现状。
//     任何手工替换、半截写入、生成器改动未重跑，都会在这里红；
//   · 输出规格统一：PCM 16-bit 单声道 22050Hz（winmm PlaySound(SND_MEMORY) 直接可播），
//     44 字节标准 RIFF 头。
//
// 用法：
//   node scripts/gen-sfx.mjs          # 重建并写盘 ui/pets/sfx/*.wav（幂等）
//   node scripts/gen-sfx.mjs --check  # 只校验落盘产物与合成结果一致（不写盘）
//
// 退出码：0 = 全部通过；1 = 有不符（打印逐项差异，不删旧产物）。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LINE_ROOT = resolve(HERE, '..')
const OUT_DIR = join(LINE_ROOT, 'ui', 'pets', 'sfx')
const RATE = 22050

/* ---------------- 种子 PRNG（确定性的来源） ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------------- 合成器（port of Coopanion web/sound.js） ---------------- */

/** 振荡器一个周期的取值；phase 为弧度。 */
function osc(type, phase) {
  switch (type) {
    case 'square': return Math.sin(phase) >= 0 ? 1 : -1
    case 'sawtooth': return 2 * (((phase / (2 * Math.PI)) % 1 + 1) % 1) - 1
    case 'triangle': return 2 * Math.abs(2 * (((phase / (2 * Math.PI)) % 1 + 1) % 1) - 1) - 1
    default: return Math.sin(phase)
  }
}

/**
 * 单音：振荡器 + 频率斜坡 + 颤音 + 包络（线性 attack 后指数衰减，照 Web Audio
 * `exponentialRampToValueAtTime(vol→0.0001)` 的衰减率）+ 可选一阶低通。
 * `at` = 起点偏移（秒），用于把多个音串成一声（如审批「叮咚」）。
 */
function tone(o, rnd) {
  const { type = 'sine', f0 = 440, f1 = f0, dur = 0.1, vol = 0.2, at = 0,
    attack = 0.005, vib = 0, vibRate = 0, filter = 0 } = o
  const n = Math.max(1, Math.round(dur * RATE))
  const out = new Float32Array(n)
  // 衰减率：attack 后从 vol 指数衰减到 ~0.0001（与 Web Audio 的指数斜坡同数量级）
  const decay = Math.log(vol / 0.0001) / Math.max(1e-4, dur - attack)
  let phase = 0
  let lp = 0
  const lpK = filter > 0 ? 1 - Math.exp((-2 * Math.PI * filter) / RATE) : 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const p = i / n
    const f = f0 * Math.pow(f1 / f0, p) + (vib ? vib * Math.sin(2 * Math.PI * vibRate * t) : 0)
    phase += (2 * Math.PI * Math.max(20, f)) / RATE
    let v = osc(type, phase)
    if (lpK > 0) { lp += (v - lp) * lpK; v = lp }
    const env = Math.min(1, t / attack) * Math.exp(-decay * Math.max(0, t - attack))
    out[i] = v * env * vol
  }
  void rnd
  return { at, data: out }
}

/**
 * 噪声：白噪声（种子 PRNG）经双二阶带通（RBJ cookbook）+ 同款包络。
 * `f0→f1` 为带通中心频率斜坡（挥手「咻」、落地「噗」都靠它）。
 */
function noise(o, rnd) {
  const { type = 'bandpass', f0 = 1000, f1 = f0, q = 1, dur = 0.2, vol = 0.15, at = 0, attack = 0.01 } = o
  const n = Math.max(1, Math.round(dur * RATE))
  const out = new Float32Array(n)
  const decay = Math.log(vol / 0.0001) / Math.max(1e-4, dur - attack)
  // RBJ 带通系数（每 64 点按当前中心频率重算一次，频率斜坡因此成立）
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < n; i++) {
    if (i % 64 === 0) {
      const f = f0 * Math.pow(f1 / f0, i / n)
      const w0 = (2 * Math.PI * f) / RATE
      const alpha = Math.sin(w0) / (2 * Math.max(0.0001, q))
      const cw = Math.cos(w0)
      if (type === 'bandpass') {
        b0 = alpha; b1 = 0; b2 = -alpha
      } else { // lowpass
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2
      }
      a1 = -2 * cw; a2 = 1 - alpha
      const norm = 1 / (1 + alpha)
      b0 *= norm; b1 *= norm; b2 *= norm; a1 *= norm; a2 *= norm
    }
    const x = rnd() * 2 - 1
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x; y2 = y1; y1 = y
    const t = i / RATE
    const env = Math.min(1, t / attack) * Math.exp(-decay * Math.max(0, t - attack))
    out[i] = y * env * vol
  }
  return { at, data: out }
}

/* ---------------- 参数表（调音只改这里） ---------------- */

const T = (o) => ({ kind: 'tone', o })
const N = (o) => ({ kind: 'noise', o })

/**
 * 13 个音效（v1 八件 R20-b + P0 五件，触发点映射见设计文档 §3.3 与
 * design/2026-10-18-pet-p0-interaction-emote.md §4）。
 * 每个条目 = 若干层（同时叠加）或 seq（首尾相接）。
 */
const SOUNDS = [
  { name: 'jump', layers: [T({ type: 'triangle', f0: 300, f1: 720, dur: 0.14, vol: 0.22, vib: 22, vibRate: 26 })] },
  {
    name: 'land', layers: [
      N({ type: 'bandpass', f0: 900, f1: 200, q: 1.2, dur: 0.10, vol: 0.16 }),
      T({ type: 'sine', f0: 170, f1: 60, dur: 0.10, vol: 0.20 }),
    ]
  },
  { name: 'wave', layers: [N({ type: 'bandpass', f0: 1300, f1: 420, q: 0.8, dur: 0.22, vol: 0.13 })] },
  { name: 'grab', layers: [T({ type: 'square', f0: 420, f1: 660, dur: 0.07, vol: 0.16 })] },
  { name: 'drop', layers: [T({ type: 'square', f0: 660, f1: 380, dur: 0.09, vol: 0.16 })] },
  {
    name: 'alert', seq: [
      T({ type: 'sine', f0: 880, dur: 0.09, vol: 0.20 }),
      T({ type: 'sine', f0: 1174, dur: 0.14, vol: 0.20, at: 0.09 }),
    ]
  },
  {
    name: 'done', seq: [
      T({ type: 'triangle', f0: 523, dur: 0.09, vol: 0.18 }),
      T({ type: 'triangle', f0: 659, dur: 0.09, vol: 0.18, at: 0.08 }),
      T({ type: 'triangle', f0: 784, dur: 0.16, vol: 0.18, at: 0.16 }),
    ]
  },
  { name: 'tick', layers: [T({ type: 'sine', f0: 1000, dur: 0.03, vol: 0.10 })] },
  // —— P0 五件（2026-10-18，design/2026-10-18-pet-p0-interaction-emote.md §4）——
  // pat：橡胶鸭般的吱吱——上行方短音 + 一簇高频气声
  {
    name: 'pat', layers: [
      T({ type: 'square', f0: 900, f1: 1400, dur: 0.06, vol: 0.12 }),
      N({ type: 'bandpass', f0: 2000, f1: 1200, q: 1.5, dur: 0.06, vol: 0.10 }),
    ]
  },
  // chomp：两声咬合 + 一下闷响（seq 首尾相接）
  {
    name: 'chomp', seq: [
      N({ type: 'bandpass', f0: 800, f1: 300, q: 2, dur: 0.05, vol: 0.20 }),
      N({ type: 'bandpass', f0: 800, f1: 300, q: 2, dur: 0.05, vol: 0.18, at: 0.09 }),
      T({ type: 'sine', f0: 120, f1: 60, dur: 0.08, vol: 0.20, at: 0.14 }),
    ]
  },
  // whoosh：甩出去的上行风声
  { name: 'whoosh', layers: [N({ type: 'bandpass', f0: 300, f1: 1800, q: 0.7, dur: 0.25, vol: 0.12 })] },
  // bounce：撞边弹跳（比 land 更「弹」——带一点回挑的尾音）
  {
    name: 'bounce', layers: [
      T({ type: 'sine', f0: 240, f1: 120, dur: 0.08, vol: 0.18 }),
      N({ type: 'bandpass', f0: 600, f1: 250, q: 1.2, dur: 0.07, vol: 0.12 }),
    ]
  },
  // yawn：哈欠——缓慢下行的气声
  {
    name: 'yawn', layers: [
      T({ type: 'sine', f0: 420, f1: 170, dur: 0.5, vol: 0.10 }),
      N({ type: 'lowpass', f0: 400, dur: 0.45, vol: 0.05 }),
    ]
  },
]

/** 合成一个音效 → Float32 混音（单声道）。 */
function render(spec) {
  const rnd = mulberry32(0x5f20_1017) // 每个音效同一把种子：换参数即变、同参数必一致
  const parts = (spec.layers ?? spec.seq).map(({ kind, o }) =>
    (kind === 'noise' ? noise(o, rnd) : tone(o, rnd)))
  const total = parts.reduce((m, p) => Math.max(m, p.at * RATE + p.data.length), 0)
  const mix = new Float32Array(Math.ceil(total))
  for (const p of parts) {
    const off = Math.round(p.at * RATE)
    for (let i = 0; i < p.data.length; i++) {
      if (off + i < mix.length) mix[off + i] += p.data[i]
    }
  }
  // 整体限幅（层叠加可能越 1；限幅而不是归一，保留各层相对响度）
  for (let i = 0; i < mix.length; i++) mix[i] = Math.max(-1, Math.min(1, mix[i]))
  return mix
}

/** Float32 → 16-bit PCM → 标准 44 字节 RIFF/WAVE。 */
function toWav(mix) {
  const dataBytes = mix.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)        // fmt 块长
  buf.writeUInt16LE(1, 20)         // PCM
  buf.writeUInt16LE(1, 22)         // 单声道
  buf.writeUInt32LE(RATE, 24)
  buf.writeUInt32LE(RATE * 2, 28)  // 字节率
  buf.writeUInt16LE(2, 32)         // 块对齐
  buf.writeUInt16LE(16, 34)        // 位深
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < mix.length; i++) {
    buf.writeInt16LE(Math.round(mix[i] * 32767), 44 + i * 2)
  }
  return buf
}

/* ---------------- 主流程 ---------------- */

const CHECK = process.argv.includes('--check')
const sha16 = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16)

let fail = 0
for (const spec of SOUNDS) {
  const wav = toWav(render(spec))
  const file = join(OUT_DIR, `${spec.name}.wav`)
  if (CHECK) {
    if (!existsSync(file)) {
      console.error(`MISS  ${spec.name}.wav — 落盘产物不存在（跑 node scripts/gen-sfx.mjs 重建）`)
      fail++
      continue
    }
    const disk = await readFile(file)
    if (Buffer.compare(disk, wav) !== 0) {
      console.error(`DIFF  ${spec.name}.wav — 落盘 ${disk.length}B/${sha16(disk)} vs 合成 ${wav.length}B/${sha16(wav)}`
        + `（生成器参数改过？重跑 node scripts/gen-sfx.mjs）`)
      fail++
    } else {
      console.log(`OK    ${spec.name}.wav  ${wav.length}B  ${sha16(wav)}`)
    }
  } else {
    let same = false
    if (existsSync(file)) {
      const disk = await readFile(file)
      same = Buffer.compare(disk, wav) === 0
    }
    if (same) {
      console.log(`same  ${spec.name}.wav  ${wav.length}B  ${sha16(wav)}`)
    } else {
      await mkdir(OUT_DIR, { recursive: true })
      await writeFile(file, wav)
      console.log(`write ${spec.name}.wav  ${wav.length}B  ${sha16(wav)}`)
    }
  }
}

if (fail > 0) {
  console.error(`\ngen-sfx --check: ${fail} 个音效不符`)
  process.exit(1)
}
if (CHECK) console.log(`\ngen-sfx --check: ${SOUNDS.length} 个音效全部一致`)
