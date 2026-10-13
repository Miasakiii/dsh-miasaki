// M2.5 软件头像：lib/avatar.js 的收窄与校验（纯逻辑，无运行时依赖）。
//
// 这些断言钉的是**跨线契约**：桌面壳（Miasaki.exe）会读同一份配置去取图标，
// 因此「什么算合法图源」必须是 host 单方面定义、且窄到壳侧永远只读自己那一个目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AVATAR_MAX_BYTES,
  AVATAR_NAME_RE,
  AVATAR_URL_PREFIX,
  PRESET_FILE_PREFIX,
  avatarFileFromSource,
  isPng,
  isUserAvatarName,
  makeAvatarName,
  parseAvatarDataUrl,
} from '../lib/avatar.js'
import { ICON_PRESETS, presetFileName } from '../lib/icon-presets.js'

/** 一个只有魔数 + 尾部字节的最小 PNG 载荷（校验只看魔数，不解码）。 */
function pngBytes(tail = 4) {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(tail, 7)])
}

test('isPng：只认 PNG 魔数', () => {
  assert.equal(isPng(pngBytes()), true)
  // JPEG / GIF / 随手一段文本 / 空
  assert.equal(isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), false)
  assert.equal(isPng(Buffer.from('GIF89a!!')), false)
  assert.equal(isPng(Buffer.from('not an image')), false)
  assert.equal(isPng(Buffer.alloc(0)), false)
  assert.equal(isPng(undefined), false)
})

test('parseAvatarDataUrl：合法 PNG 往返一致', () => {
  const bytes = pngBytes(16)
  const parsed = parseAvatarDataUrl(`data:image/png;base64,${bytes.toString('base64')}`)
  assert.equal(parsed.ok, true)
  assert.deepEqual(Buffer.from(parsed.bytes), bytes)
})

test('parseAvatarDataUrl：非 PNG 前缀一律拒绝（浏览器侧必须已归一化）', () => {
  const bytes = pngBytes()
  for (const prefix of ['data:image/jpeg;base64,', 'data:image/webp;base64,', 'data:image/svg+xml;base64,', 'data:text/plain;base64,']) {
    const parsed = parseAvatarDataUrl(`${prefix}${bytes.toString('base64')}`)
    assert.equal(parsed.ok, false, `${prefix} 必须被拒`)
    assert.equal(typeof parsed.error, 'string')
  }
})

test('parseAvatarDataUrl：伪装成 PNG 的其它内容被魔数拦下', () => {
  // 声明是 PNG，内容是 GIF —— 只看前缀的实现会放行，真查魔数的不会。
  const fake = `data:image/png;base64,${Buffer.from('GIF89a-not-really-png').toString('base64')}`
  const parsed = parseAvatarDataUrl(fake)
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /PNG/)
})

test('parseAvatarDataUrl：空、超限、非法 base64 各有明确错误', () => {
  assert.equal(parseAvatarDataUrl(undefined).ok, false)
  assert.equal(parseAvatarDataUrl('').ok, false)
  assert.equal(parseAvatarDataUrl(123).ok, false)
  // 体积上限：直接超 data URL 文本上限比构造 4MB 载荷更快，且覆盖同一道闸门。
  const huge = `data:image/png;base64,${'A'.repeat(AVATAR_MAX_BYTES * 2)}`
  assert.equal(parseAvatarDataUrl(huge).ok, false)
  assert.match(parseAvatarDataUrl(huge).error, /过大/)
  // 非法 base64 字符（不在字符表内）
  assert.equal(parseAvatarDataUrl('data:image/png;base64,!!!!').ok, false)
})

test('avatarFileFromSource：只认本线头像路由下的单段白名单文件名', () => {
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}avatar-lz3k9q-4f2a1b.png`), 'avatar-lz3k9q-4f2a1b.png')
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}My_Avatar-2.PNG`), 'My_Avatar-2.PNG', '扩展名大小写不敏感')
  // 非本线路径 / 外链：桌面壳永远不联网，所以这里必须为空
  assert.equal(avatarFileFromSource('https://example.com/a.png'), null)
  assert.equal(avatarFileFromSource('/appearance/wallpaper/local/a.png'), null)
  assert.equal(avatarFileFromSource(''), null)
  assert.equal(avatarFileFromSource(undefined), null)
  // 穿越与嵌套路径
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}../config.json`), null)
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}sub/dir.png`), null)
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}%2e%2e%2fconfig.json`), null)
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}..%5Cconfig.json`), null)
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}%2Fetc%2Fpasswd`), null)
  // 非 PNG 扩展名
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}avatar.jpg`), null)
  assert.equal(avatarFileFromSource(`${AVATAR_URL_PREFIX}.hidden.png`), null, '首字符必须是白名单起始字符')
})

test('AVATAR_NAME_RE 与 avatarFileFromSource 口径一致', () => {
  const samples = ['a.png', 'avatar-1-2.png', 'A_b-c.9.png', 'x.jpg', '.png', 'a/b.png', 'a b.png']
  for (const name of samples) {
    const viaSource = avatarFileFromSource(`${AVATAR_URL_PREFIX}${name}`)
    assert.equal(viaSource === null, !AVATAR_NAME_RE.test(name), `${name} 两处口径必须一致`)
  }
})

test('makeAvatarName：时间戳 + 随机后缀，可注入以便确定性断言', () => {
  const name = makeAvatarName(1_700_000_000_000, () => 0.5)
  assert.match(name, /^avatar-[0-9a-z]+-[0-9a-f]{6}\.png$/)
  assert.equal(AVATAR_NAME_RE.test(name), true)
  // 同毫秒不同随机 → 不同名（绝不覆盖既有文件）
  assert.notEqual(makeAvatarName(1_700_000_000_000, () => 0.1), makeAvatarName(1_700_000_000_000, () => 0.9))
  // 边界随机值不越界（1.0 会被夹到 0xfffffe）
  assert.equal(AVATAR_NAME_RE.test(makeAvatarName(0, () => 1)), true)
  assert.equal(AVATAR_NAME_RE.test(makeAvatarName(0, () => 0)), true)
})

test('isUserAvatarName：用户资产可删，预设与非法名一律拒（M2.8 删除围栏）', () => {
  // 2026-10-14 用户「可以添加也应该有删除选项」：新增 POST /avatar/delete 时的唯一出口判据。
  // 两条判据缺一不可 —— ① 过文件名白名单（与**读取路径同一条**，删除不享有更宽的门）；
  // ② 不是预设（preset-* 由 host 幂等落盘，删了下次 GET /presets 又会重新生成，
  //    「删除预设」这个语义本身不成立，面板的「我的上传」也从不列它们）。
  assert.equal(isUserAvatarName('avatar-lz3k9q-4f2a1b.png'), true)
  assert.equal(isUserAvatarName('My_Avatar-2.PNG'), true, '扩展名大小写不敏感（与白名单同口径）')
  assert.equal(isUserAvatarName('A_b-c.9.png'), true)

  assert.equal(isUserAvatarName('preset-default.png'), false, '预设是系统资产，不可删')
  assert.equal(isUserAvatarName('preset-current.png'), false)
  assert.equal(isUserAvatarName('PRESET-default.png'), true,
    '前缀判定是大小写敏感的 —— 白名单允许大写开头的用户文件，别把用户文件误伤成预设')

  for (const bad of ['', '.png', 'a.jpg', 'a b.png', 'sub/a.png', 'sub\\a.png', '../config.json', 'a%2Fb.png',
    `${'x'.repeat(90)}.png`, null, undefined, 42, {}]) {
    assert.equal(isUserAvatarName(bad), false, `${String(bad)} 必须被拒`)
  }

  // **跨模块对账**：ICON_PRESETS 生成的每一个预设文件名都必须
  // ① 命中文件名白名单（否则桌面壳根本读不到它）；② 被删除围栏拒绝。
  // 这一条把 `icon-presets.js` 的命名与 `avatar.js` 的删除围栏绑在一起，防前缀漂移
  // —— 任何一侧改了命名规则，这里立刻转红。
  for (const preset of ICON_PRESETS) {
    const file = presetFileName(preset.id)
    assert.equal(file.startsWith(PRESET_FILE_PREFIX), true, `${file} 必须命中预设前缀契约`)
    assert.equal(AVATAR_NAME_RE.test(file), true, `${file} 应命中文件名白名单（否则壳侧读不到）`)
    assert.equal(isUserAvatarName(file), false, `${file} 是预设，必须不可删`)
  }
})
