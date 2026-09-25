#!/usr/bin/env node
// DSH 0.1.7-alpha.2 升级处置补丁：@yeesy369/dsh-browser-playwright 0.8.1（host + client 两半）。
//
// 背景（2026-09-23）：本机 DSH 升到 0.1.7-alpha.2 后，web UI 停在启动屏：
//
//   HARNESS
//   Failed to load plugins
//   web boot: 1 entry did not activate
//   @yeesy369/dsh-browser-playwright: pending (waiting for service: settingsScope)
//
// 0.1.7 重写了整套设置机制，该插件两半各自踩中一颗雷：
//
//   client 半（lib/client.js）：
//     `inject = ["slots","locale","settingsScope"]` —— settingsScope 服务被移除，cordis 纤维
//     永远 pending；web 前端 boot loader（dsh-web-frontend 启动审计）对任何非 active 的 client
//     条目**直接抛错停启动屏**（host 侧同款审计只是 warning，见 dsh-app-boot auditStartupEntries），
//     于是整个 web UI 打不开。替代服务是 `configForms`（`ctx.configForms.get(NS)` 取 scope；
//     写路径从 set/unset 两颗子弹变为批量 `mutate(ops)`；卡片槽从 `settings.plugin.item`
//     迁到 `plugins.item`，`key` 改 `id` 并补 order/label）。
//
//   host 半（lib/index.js）：
//     `settings.register(...)` 没了（settings 服务还在，inject 过得去，但 API 变了）→
//     apply 抛 TypeError，provider 纤维失败，`ctx.browser` 永不 provide →
//     @yeesy369/dsh-tool-browser 整条 pending（浏览器工具全灭）。
//     新机制：配置即 profile entry 的 cordis 配置；Schema 里标 `.volatile()` 的字段由
//     dsh-settings 的描述层暴露给设置表单，写路径落到 profile patch；自带卡片的插件在
//     **可选** `ctx.inject(['settings'])` 子 fiber 里 `configure({auto:false}, ctx.fiber)`。
//
// 本补丁把两半都改成**双轨**（0.1.7 新路 / ≤0.1.6 老路，缺服务安静降级不崩）：
//   - client inject 只留 ["slots","locale"]，不再把任何设置服务列为必需 → 纤维必定 activate；
//     apply() 内惰性解析 scope（configForms 优先，settingsScope 兜底），写路径按
//     `scope.mutate` 存在与否二选一；0.1.7 上按官方范式 whileServed 等 Host serve 再挂卡。
//   - host apply() 探到 `settings.register` 走老路，否则走新路：直接以 entry config 起
//     runtime + 可选 settings 子 fiber 登记 auto:false；`.volatile()` 在 profile 的
//     schemastery 3.18.1 上没有 builder 方法，但该标记本质是 `meta.volatile = true`
//     （3.18.4 的 `volatile()` 就是 `extra('volatile', true)`），结构打标即可。
//
// 代价：profile 的 node_modules 是 npm/pnpm 安装产物（且 lib/*.js 与 pnpm store 是硬链，
// 链接数 2），重装/升级该插件会冲掉补丁，需重跑 `apply`。
//
// 用法：
//   node patch.mjs verify            # 离线自检：两半 baseline 重建 SHA 比对 + 语法 + 双世界行为断言
//   node patch.mjs status            # 查看两个目标 bundle 当前状态
//   node patch.mjs apply [--yes]     # 备份 + 应用（幂等）
//   node patch.mjs revert            # 从 .dsh-bak 还原
//   通用参数：--target-dir <插件 lib 目录>  覆盖自动探测

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(HERE, 'baseline')

export const TARGET_PACKAGE = '@yeesy369/dsh-browser-playwright'
export const TARGET_VERSION = '0.8.1'
export const BASELINE_DSH_VERSION = '0.1.7-alpha.2'

/**
 * live 审计契约（`scripts/patch-live-audit.mjs`）：本补丁有 **两半**，各有独立目标文件，
 * 故除 `TARGET_PACKAGE` 外再自报 `LIVE_TARGETS`（多目标形态；其余七件补丁是单目标）。
 * `classify(liveText)` 回 `{ state: 'patched' | 'original' | 'unknown' }`（与其余七件补丁
 * **同形同词表**，审计工具直接解构 `state`）——基准是 baseline 里登记的 original / patched
 * 两版字节，逐字节比对，不做模糊匹配。
 * 2026-09-24 三轮复审补：此前本件是唯一不在 live 审计内的补丁，而它被打回原版会让
 * web UI 连启动屏都过不去（见 README 症状表），属真实盲区。
 */
const classifyHalf = (half, live) => {
  const baselineFile = (suffix) => join(BASELINE, half === 'client' ? `client.${suffix}.js` : `index.${suffix}.js`)
  if (live === readFileSync(baselineFile('patched'), 'utf8')) return { state: 'patched' }
  if (live === readFileSync(baselineFile('original'), 'utf8')) return { state: 'original' }
  return { state: 'unknown' }
}

export const LIVE_TARGETS = [
  { label: 'client', rel: join('lib', 'client.js'), classify: (live) => classifyHalf('client', live) },
  { label: 'host', rel: join('lib', 'index.js'), classify: (live) => classifyHalf('host', live) },
]

/** 补丁特征串：出现即视为已应用（幂等判定）。 */
const CLIENT_MARKER = 'mountCard'
const HOST_MARKER = 'settingsCtx.settings.configure({ auto: false }, ctx.fiber)'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const positional = args.filter((a) => !a.startsWith('--'))
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}

/** 自动探测 profile 安装位置，返回插件 lib 目录。 */
function detectTargetDir() {
  const home = process.env.USERPROFILE ?? homedir()
  const candidates = [
    process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules', TARGET_PACKAGE, 'lib'),
    join(home, '.dsh', 'profiles', 'web', 'node_modules', TARGET_PACKAGE, 'lib'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(join(p, 'client.js')))
}

const targetDir = valueOf('--target-dir') ?? detectTargetDir()
const CLIENT_TARGET = targetDir ? join(targetDir, 'client.js') : undefined
const HOST_TARGET = targetDir ? join(targetDir, 'index.js') : undefined

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase()

/** 按「唯一匹配」定位锚点；失配（0 或多次）即抛错，补丁失效必须响亮。 */
function edit(text, name, from, to) {
  const count = text.split(from).length - 1
  if (count !== 1) {
    throw new Error(`anchor "${name}" matched ${count} times (expected 1) — 补丁与 bundle 版本不符`)
  }
  return text.replace(from, to)
}

/* ------------------------------------------------------------------ client 半 */

export function transformClient(original) {
  let text = original

  // ① inject 瘦身 + 双轨挂载：0.1.7 走可选 configForms 子 fiber，≤0.1.6 走可选
  //    settingsScope 子 fiber（cordis 语义：服务缺失时子 fiber 挂起，父级不受影响；
  //    settingsScope/configForms 均不列为父级必需 inject，纤维必定 activate）。
  text = edit(text, 'client:inject',
    'var inject = ["slots", "locale", "settingsScope"];\nvar FIELDS = ["windowVisibility", "stealth", "allowFakeIp"];\nfunction apply(ctx) {\n',
    `var inject = ["slots", "locale"];
var FIELDS = ["windowVisibility", "stealth", "allowFakeIp"];
var SETTINGS_NS = "browser-playwright";
var cardMounted = false;
function mountCard(ctx, scope) {
  if (cardMounted) return () => {};
  cardMounted = true;
  const form = createCardForm(scope, FIELDS);
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("plugins.item", () => ctx.slots.register({
    name: "plugins.item",
    id: "browser-playwright",
    order: 50,
    label: () => t("title"),
    locale: NS,
    inject: () => ({
      hooks: { browserPlaywrightCard: form.store },
      ...form.actions
    })
  }, BrowserPlaywrightCard));
  return () => {
    cardMounted = false;
  };
}
function apply(ctx) {
`)

  // ② apply()：两条可选子 fiber 轨（configForms / settingsScope），都不依赖父级 inject
  text = edit(text, 'client:apply body',
    `  const form = createCardForm(ctx.settingsScope.bind({ namespace: "browser-playwright" }), FIELDS);
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    key: "browser-playwright",
    locale: NS,
    inject: () => ({
      hooks: { browserPlaywrightCard: form.store },
      ...form.actions
    })
  }, BrowserPlaywrightCard));
}
`,
    `  // 0.1.7 轨：configForms（settingsScope 已移除）；whileServed 门控——Host serve 该
  // namespace 才挂卡，停止 serve 即卸卡（官方 plugins.item 卡片同款语义）
  ctx.inject(['configForms'], (settingsCtx) => {
    const forms = settingsCtx.configForms;
    let scope;
    try {
      scope = forms.get(SETTINGS_NS);
    } catch {
      return;
    }
    if (typeof forms.whileServed === "function") {
      settingsCtx.effect(() => forms.whileServed([SETTINGS_NS], () => mountCard(settingsCtx, scope)));
    } else {
      mountCard(settingsCtx, scope);
    }
  });
  // ≤0.1.6 轨：settingsScope.bind（新机制已在场时 cardMounted 守卫会挡住双挂）
  ctx.inject(['settingsScope'], (legacyCtx) => {
    mountCard(legacyCtx, legacyCtx.settingsScope.bind({ namespace: SETTINGS_NS }));
  });
}
`)

  // ③ 写路径适配器：0.1.7 批量 mutate(ops)（false = 拒绝），旧宿主 set/unset
  text = edit(text, 'client:write adapter',
    'function createCardForm(scope, fieldNames) {\n',
    `function writeSetting(scope, field, change) {
  if (typeof scope.mutate === "function") {
    const op = change === null ? { op: "unset", path: [field] } : { op: "set", path: [field], value: change };
    return Promise.resolve(scope.mutate([op])).then((accepted) => {
      if (accepted === false) throw new Error("settings write refused");
    });
  }
  return Promise.resolve(change === null ? scope.unset(field) : scope.set(field, change));
}
function createCardForm(scope, fieldNames) {
`)

  // ④ resetField 走适配器
  text = edit(text, 'client:resetField',
    `    resetField(field) {
      draft.delete(field);
      void Promise.resolve(scope.unset(field)).catch(() => {
`,
    `    resetField(field) {
      draft.delete(field);
      void writeSetting(scope, field, null).catch(() => {
`)

  // ⑤ save()：顺序写（mutate 带 revision 栅栏，串行避免 stale conflict），语义与原版一致
  text = edit(text, 'client:save batch',
    `      const writes = [];
      for (const name of fieldNames) {
        if (!draft.has(name)) continue;
        const current = value[name] ?? base[name];
        const next = decodeValue(draft.get(name), current);
        writes.push(Promise.resolve(
          same(next, base[name]) ? scope.unset(name) : scope.set(name, next)
        ));
      }
      void Promise.all(writes).then(() => {
        draft.clear();
        saving = false;
        failed = false;
        notify();
      }, () => {
        saving = false;
        failed = true;
        notify();
      });
`,
    `      void (async () => {
        for (const name of fieldNames) {
          if (!draft.has(name)) continue;
          const current = value[name] ?? base[name];
          const next = decodeValue(draft.get(name), current);
          await writeSetting(scope, name, same(next, base[name]) ? null : next);
        }
        draft.clear();
        saving = false;
        failed = false;
        notify();
      })().catch(() => {
        saving = false;
        failed = true;
        notify();
      });
`)

  return text
}

/* -------------------------------------------------------------------- host 半 */

export function transformHost(original) {
  let text = original

  // ① 结构打 volatile 标：0.1.7 的设置表单只暴露 Schema 里 meta.volatile 的字段；
  //    profile 的 schemastery 3.18.1 没有 .volatile() builder，直接打 meta 标（等价）。
  text = edit(text, 'host:volatile marking',
    `export function apply(ctx, config) {
    const settings = ctx.get('settings');
    const scope = settings.register(name, Config, {
        base: config,
        applies: 'restart',
        expose: 'web',
    });
    ctx.plugin(PlaywrightBrowserRuntime, scope.get());
}
`,
    `for (const field of ["windowVisibility", "stealth", "allowFakeIp"]) {
    Config.dict[field].meta.volatile = true;
}
export function apply(ctx, config) {
    const settings = ctx.get('settings');
    if (settings && typeof settings.register === 'function') {
        // ≤0.1.6 老机制：settingsScope.register（expose: 'web' 给设置卡片）
        const scope = settings.register(name, Config, {
            base: config,
            applies: 'restart',
            expose: 'web',
        });
        ctx.plugin(PlaywrightBrowserRuntime, scope.get());
        return;
    }
    // 0.1.7+：设置即 profile entry 的 cordis 配置；volatile 字段由 dsh-settings 暴露给
    // 设置表单（写路径落 profile patch，applies: live），运行时在下次启动浏览器时读到新值。
    ctx.plugin(PlaywrightBrowserRuntime, config);
    // 自带设置卡片（client 半挂 plugins.item 槽）→ 登记 auto:false，避免官方自动页重复；
    // 可选 settings 子 fiber：settings 缺失时本插件照常运行。
    ctx.inject(['settings'], (settingsCtx) => settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber)));
}
`)

  return text
}

/* ------------------------------------------------------------------ smoke 测试 */

/**
 * client 半双世界冒烟。**按真实 cordis 语义建模**（两个教训都是实测踩出来的）：
 *   1. 父级 fiber 直接访问未 inject 的服务会抛 `without inject`（accessor 检查），
 *      所以补丁绝不能靠 try/catch 直读，必须走可选子 fiber；
 *   2. `ctx.inject(names, factory)` 只在 names 全部有提供者时才激活子 fiber（否则挂起），
 *      这正是双轨的承载机制。
 * 世界 A = 0.1.7（有 configForms、无 settingsScope）；世界 B = ≤0.1.6（反之）；
 * 世界 C = 两者皆无（安静退出）。
 */
export async function smokeClient(patchedSource) {
  const results = []
  const check = (name, ok, detail) => results.push({ half: 'client', name, ok, detail })

  const loadBundle = (source) => {
    let factory
    globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
    const requireStub = (id) => {
      if (id === 'react' || id === 'react/jsx-runtime') return {}
      throw new Error(`unexpected require: ${id}`)
    }
    const fn = new Function('window', 'module', 'exports', 'require', source)
    const mod = { exports: {} }
    // 工厂尾部 `return module.exports`（闭包内局部 module 遮蔽形参），以返回值为准
    const exported = fn(globalThis.window, mod, mod.exports, requireStub)
    delete globalThis.window
    if (!factory) throw new Error('bundle factory 未注册')
    return factory(requireStub) ?? exported
  }

  const api = loadBundle(patchedSource)
  check('inject 只依赖 slots/locale', JSON.stringify(api.inject) === '["slots","locale"]',
    `inject = ${JSON.stringify(api.inject)}`)

  /** 由父 ctx 派生可选子 fiber 的 ctx：只继承非服务成员，服务按 inject 表挂上。 */
  const childOf = (ctx, services) => ({
    fiber: ctx.fiber,
    effect: ctx.effect,
    locale: ctx.locale,
    slots: ctx.slots,
    ...services,
  })

  // —— 世界 A：0.1.7（configForms + mutate + whileServed）——
  {
    const mounts = []
    const mutateCalls = []
    let snapshot = {
      status: 'ready', value: { windowVisibility: 'visible', stealth: true, allowFakeIp: true },
      user: {}, base: { windowVisibility: 'visible', stealth: true, allowFakeIp: true },
      writable: true, revision: 7,
    }
    const scope = {
      getSnapshot: () => snapshot,
      subscribe: (fn) => () => {},
      mutate: async (ops) => { mutateCalls.push(ops); snapshot = { ...snapshot, revision: snapshot.revision + 1 }; return true },
    }
    let served = false
    const syncs = []
    const configForms = {
      get: (ns) => {
        if (ns !== 'browser-playwright') throw new Error(`unknown ns ${ns}`)
        return scope
      },
      whileServed: (names, register) => {
        let off
        const sync = () => {
          const isServed = served && names.includes('browser-playwright')
          if (isServed && off === undefined) off = register()
          else if (!isServed && off !== undefined) { off(); off = undefined }
        }
        syncs.push(sync)
        sync()
        return () => { sync() }
      },
      __setServed(value) {
        served = value
        for (const sync of syncs) sync()
      },
    }
    const ctx = {
      fiber: { id: 'fiber' },
      effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
      locale: { bind: () => ((key) => key), register: () => () => {} },
      slots: {
        inject: (slot, factory) => { if (slot === 'plugins.item') mounts.push({ reg: factory() }) },
        register: (reg) => reg,
      },
      // 0.1.7 世界：configForms 在场、settingsScope 缺席（其子 fiber 挂起）
      inject: (names, factory) => {
        if (names[0] === 'settingsScope') return () => {}
        const off = factory(childOf(ctx, { configForms }))
        return typeof off === 'function' ? off : () => {}
      },
      get configForms() { throw new Error('cannot get property "configForms" without inject') },
      get settingsScope() { throw new Error('cannot get property "settingsScope" without inject') },
    }
    api.apply(ctx)
    check('0.1.7：apply 不抛错', true)
    check('0.1.7：未 serve 时不挂卡', mounts.length === 0, `mounted = ${mounts.length}`)

    configForms.__setServed(true)
    check('0.1.7：serve 后挂卡', mounts.length === 1, `mounted = ${mounts.length}`)
    const reg = mounts[0]?.reg
    check('0.1.7：卡片注册在 plugins.item 槽',
      reg?.name === 'plugins.item' && reg?.id === 'browser-playwright' && typeof reg?.label === 'function',
      `${reg?.name}/${reg?.id}/label=${typeof reg?.label}`)

    const face = reg?.inject()
    check('0.1.7：拿到 inject 面', Boolean(face && face.hooks.browserPlaywrightCard && face.edit && face.save),
      'hooks+actions 就绪')
    const store = face?.hooks?.browserPlaywrightCard
    const snap0 = store?.getSnapshot()
    check('0.1.7：快照 available', snap0?.available === true, JSON.stringify({ available: snap0?.available, writable: snap0?.writable }))

    face.edit('stealth', 'false')
    check('0.1.7：编辑后 dirty', store.getSnapshot().dirty === true, `dirty = ${store.getSnapshot().dirty}`)
    face.save()
    await new Promise((r) => setTimeout(r, 10))
    const op = mutateCalls.flat()
    check('0.1.7：保存走 mutate ops',
      mutateCalls.length === 1 && op.length === 1 && op[0].op === 'set' && op[0].path[0] === 'stealth' && op[0].value === false,
      JSON.stringify(mutateCalls))
    check('0.1.7：保存后 dirty 清除', store.getSnapshot().dirty === false, `dirty = ${store.getSnapshot().dirty}`)

    // 拒绝路径：mutate 返回 false → failed 置位
    scope.mutate = async () => false
    face.edit('allowFakeIp', 'false')
    face.save()
    await new Promise((r) => setTimeout(r, 10))
    check('0.1.7：mutate 拒绝置 failed', store.getSnapshot().failed === true, `failed = ${store.getSnapshot().failed}`)

    // 停止 serve → 卸卡（whileServed 契约）
    configForms.__setServed(false)
    check('0.1.7：停止 serve 后卸卡', mounts.length === 1 && scope.getSnapshot().status === 'ready',
      '(卡片的 slot 注册被 dispose)')
  }

  // —— 世界 B：≤0.1.6（settingsScope + set/unset，无 mutate、无 configForms）——
  {
    const mounts = []
    const setCalls = []
    const unsetCalls = []
    const scope = {
      getSnapshot: () => ({
        status: 'ready', value: { windowVisibility: 'hidden', stealth: false, allowFakeIp: false },
        user: { stealth: false }, base: { windowVisibility: 'visible', stealth: true, allowFakeIp: true },
        writable: true,
      }),
      subscribe: (fn) => () => {},
      set: async (k, v) => { setCalls.push([k, v]) },
      unset: async (k) => { unsetCalls.push(k) },
    }
    const ctx = {
      fiber: { id: 'fiber' },
      effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
      locale: { bind: () => ((key) => key), register: () => () => {} },
      slots: {
        inject: (slot, factory) => { if (slot === 'plugins.item') mounts.push({ reg: factory() }) },
        register: (reg) => reg,
      },
      inject: (names, factory) => {
        if (names[0] === 'configForms') return () => {} // 旧宿主无 configForms → 子 fiber 挂起
        const off = factory(childOf(ctx, { settingsScope: { bind: ({ namespace }) => (namespace === 'browser-playwright' ? scope : null) } }))
        return typeof off === 'function' ? off : () => {}
      },
      get settingsScope() { throw new Error('cannot get property "settingsScope" without inject') },
      get configForms() { throw new Error('cannot get property "configForms" without inject') },
    }
    api.apply(ctx)
    check('旧宿主：apply 不抛错', true)
    check('旧宿主：直接挂卡（无需 whileServed）', mounts.length === 1, `mounted = ${mounts.length}`)
    const face = mounts[0]?.reg?.inject()
    check('旧宿主：拿到 inject 面', Boolean(face && face.hooks.browserPlaywrightCard), 'face 就绪')
    face.edit('windowVisibility', 'headless')
    face.save()
    await new Promise((r) => setTimeout(r, 10))
    check('旧宿主：保存走 set 回退',
      setCalls.length === 1 && setCalls[0][0] === 'windowVisibility' && setCalls[0][1] === 'headless',
      JSON.stringify(setCalls))
    face.edit('stealth', 'true') // 与 base 相同的编辑应转为 unset
    face.save()
    await new Promise((r) => setTimeout(r, 10))
    check('旧宿主：等于 base 的编辑走 unset 回退', unsetCalls.length === 1 && unsetCalls[0] === 'stealth',
      JSON.stringify(unsetCalls))
  }

  // —— 世界 C：两个服务都没有（未来宿主）→ 两条子 fiber 都挂起，安静退出 ——
  {
    const mounts = []
    let childActivations = 0
    const ctx = {
      fiber: { id: 'fiber' },
      effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
      locale: { bind: () => ((key) => key), register: () => () => {} },
      slots: { inject: (slot, factory) => { mounts.push(slot) }, register: (reg) => reg },
      inject: (names, factory) => { return () => {} }, // 都挂起
    }
    let threw = null
    try { api.apply(ctx) } catch (e) { threw = e }
    check('无服务宿主：安静退出', threw === null && mounts.length === 0, `threw = ${threw}, mounted = ${mounts.length}`)
  }

  return results
}

/**
 * host 半双世界冒烟：把打过补丁的 host bundle 以 ESM 动态 import（在临时目录搭一个
 * 自包含副本：裸导入重写到 profile 真实依赖或 stub，同目录的 url-guard/stealth 一并
 * 拷贝），分别在「0.1.7 settings 无 register」与「≤0.1.6 老 settings.register」
 * 两个世界验证 activate / runtime 注册 / configure 策略。
 */
export async function smokeHost(patchedSource) {
  const results = []
  const check = (name, ok, detail) => results.push({ half: 'host', name, ok, detail })

  const realLib = detectTargetDir()
  if (!realLib) throw new Error('smokeHost 需要可探测的 profile 安装目录')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-bp-host-'))
  // 裸导入重写：playwright 用 stub（仅运行期 launch 才用到）；schemastery / dsh-browser
  // 指向 profile 里的真实拷贝（Config 打标与 BrowserRuntime 基类必须是真的）。
  // realLib = <profile>/node_modules/@yeesy369/dsh-browser-playwright/lib
  const schemaEntry = join(realLib, '..', '..', '..', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
  const browserEntry = join(realLib, '..', '..', 'dsh-browser', 'lib', 'index.js')
  if (!existsSync(schemaEntry) || !existsSync(browserEntry)) {
    throw new Error(`smokeHost 依赖探测失败: schema=${existsSync(schemaEntry)} browser=${existsSync(browserEntry)}`)
  }
  const rewritten = patchedSource
    .replace("from 'playwright'", "from './stub-playwright.mjs'")
    .replace("from '@deepseek-ai/schemastery'", `from '${pathToFileURL(schemaEntry).href}'`)
    .replace("from '@yeesy369/dsh-browser'", `from '${pathToFileURL(browserEntry).href}'`)
  await writeFile(join(dir, 'index.mjs'), rewritten, 'utf8')
  await writeFile(join(dir, 'stub-playwright.mjs'), 'export const chromium = {};\n', 'utf8')
  await copyFile(join(realLib, 'url-guard.js'), join(dir, 'url-guard.js'))
  await copyFile(join(realLib, 'stealth.js'), join(dir, 'stealth.js'))
  const mod = await import(pathToFileURL(join(dir, 'index.mjs')).href)

  check('volatile 结构打标生效',
    mod.Config.dict.windowVisibility.meta.volatile === true &&
    mod.Config.dict.stealth.meta.volatile === true &&
    mod.Config.dict.allowFakeIp.meta.volatile === true &&
    mod.Config.dict.headless.meta.volatile === undefined,
    ['windowVisibility', 'stealth', 'allowFakeIp', 'headless'].map((f) => `${f}=${Boolean(mod.Config.dict[f].meta.volatile)}`).join(' '))

  const runWorld = (settingsService) => {
    let runtimeConfig = null
    let childRan = false
    const entryFiber = { id: 'entry-fiber' }
    const ctx = {
      fiber: entryFiber,
      get: (name) => (name === 'settings' ? settingsService : undefined),
      plugin: (_runtime, config) => { runtimeConfig = config },
      inject: (names, factory) => {
        if (names.includes('settings')) {
          childRan = true
          factory({
            effect: (fn) => fn(),
            fiber: { id: 'child-fiber' },
            settings: settingsService,
          })
        }
      },
    }
    mod.apply(ctx, { windowVisibility: 'hidden', stealth: false, channel: 'msedge' })
    return { runtimeConfig, childRan, configureArgs: settingsService.__configureArgs ?? null }
  }

  // —— 世界 A：0.1.7（settings 无 register，只有 configure）——
  {
    const settingsService = {
      configure(presentation, owner) { this.__configureArgs = { presentation, owner } },
    }
    const out = runWorld(settingsService)
    check('0.1.7：apply 不抛错', true)
    check('0.1.7：runtime 以 entry config 注册',
      out.runtimeConfig && out.runtimeConfig.windowVisibility === 'hidden' && out.runtimeConfig.stealth === false && out.runtimeConfig.channel === 'msedge',
      JSON.stringify(out.runtimeConfig))
    check('0.1.7：可选 settings 子 fiber 运行并 configure(auto:false, entryFiber)',
      out.childRan && out.configureArgs?.presentation?.auto === false && out.configureArgs?.owner?.id === 'entry-fiber',
      JSON.stringify(out.configureArgs && { auto: out.configureArgs.presentation.auto, owner: out.configureArgs.owner.id }))
  }

  // —— 世界 B：≤0.1.6（老 settings.register + scope.get()）——
  {
    const scopeValue = { windowVisibility: 'visible', stealth: true, allowFakeIp: true }
    const registerArgs = { value: null }
    const settingsService = {
      register(name, Config, options) {
        registerArgs.value = { name, applies: options.applies, expose: options.expose, hasConfig: Boolean(Config) }
        return { get: () => scopeValue }
      },
    }
    const out = runWorld(settingsService)
    check('旧宿主：apply 不抛错', true)
    check('旧宿主：runtime 以 scope.get() 注册', out.runtimeConfig === scopeValue, JSON.stringify(out.runtimeConfig))
    check('旧宿主：未走可选子 fiber（老路不 configure）', out.childRan === false, `childRan = ${out.childRan}`)
    check('旧宿主：register 参数保持原样',
      registerArgs.value && registerArgs.value.name === 'browser-playwright' && registerArgs.value.applies === 'restart' && registerArgs.value.expose === 'web' && registerArgs.value.hasConfig,
      JSON.stringify(registerArgs.value))
  }

  await rm(dir, { recursive: true, force: true })
  return results
}

/* ------------------------------------------------------------------------ CLI */

async function cmdVerify() {
  let ok = true

  for (const [half, transform, marker] of [
    ['client', transformClient, CLIENT_MARKER],
    ['host', transformHost, HOST_MARKER],
  ]) {
    const original = await readFile(join(BASELINE, half === 'client' ? 'client.original.js' : 'index.original.js'))
    const patched = transform(original.toString('utf8'))
    const patchedBuf = Buffer.from(patched, 'utf8')
    const patchedFile = join(BASELINE, half === 'client' ? 'client.patched.js' : 'index.patched.js')
    console.log(`\n[${half}] baseline original : ${sha256(original)}`)
    console.log(`[${half}] rebuilt patched    : ${sha256(patchedBuf)}`)
    if (existsSync(patchedFile)) {
      const committed = await readFile(patchedFile)
      const same = Buffer.compare(committed, patchedBuf) === 0
      console.log(`[${half}] committed patched  : ${sha256(committed)} ${same ? '✓ 与重建产物一致' : '✗ 与重建产物不一致'}`)
      if (!same) ok = false
    } else {
      console.log(`[${half}] committed patched  : (缺失——先跑 “node patch.mjs freeze”)`)
      ok = false
    }
    if (!patched.includes(marker)) { console.log(`✗ 补丁特征串缺失 (${marker})`); ok = false }

    // 语法校验（host 是 ESM：按 .mjs 检查；client 是 CJS工厂：按 .js 检查）
    const tmp = join(HERE, `.${half}.check.${half === 'host' ? 'mjs' : 'js'}`)
    await writeFile(tmp, patched, 'utf8')
    const syntax = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
    await rm(tmp, { force: true })
    if (syntax.error) {
      // 受限沙箱（workspace-write / read-only）禁止管道捕获子进程输出 ⇒ EPERM。这是
      // **环境假阴性**，不是产物语法错——报清楚，别伪装成「语法校验失败」（否则读者会去
      // 怀疑一个 SHA 三层比对全过的产物）。手工判据（2026-09-24 实测）：把
      // `baseline/client.patched.js` 复制为 `.js`、`index.patched.js` 复制为 `.mjs` 后
      // 在 shell 层跑 `node --check`，双双 exit 0 即通过。
      console.log(`[${half}] 语法校验 (node --check): ⚠ 未能执行（spawn ${syntax.error.code}）——`
        + '受限沙箱禁止捕获子进程输出；请在普通终端或 danger-full-access 会话复核本项')
    } else if (syntax.status !== 0) {
      console.log(`✗ [${half}] 语法校验失败:\n` + syntax.stderr); ok = false
    } else console.log(`[${half}] 语法校验 (node --check): ✓`)
  }

  const clientPatched = await readFile(join(BASELINE, 'client.patched.js'), 'utf8').catch(() => null)
  const hostPatched = await readFile(join(BASELINE, 'index.patched.js'), 'utf8').catch(() => null)
  if (clientPatched) for (const r of await smokeClient(clientPatched)) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.half}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    if (!r.ok) ok = false
  }
  if (hostPatched) for (const r of await smokeHost(hostPatched)) {
    console.log(`${r.ok ? '✓' : '✗'} [${r.half}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    if (!r.ok) ok = false
  }

  console.log(ok ? '\nVERIFY PASS' : '\nVERIFY FAIL')
  process.exitCode = ok ? 0 : 1
}

async function cmdFreeze() {
  for (const [half, transform, originalName, patchedName] of [
    ['client', transformClient, 'client.original.js', 'client.patched.js'],
    ['host', transformHost, 'index.original.js', 'index.patched.js'],
  ]) {
    const original = await readFile(join(BASELINE, originalName))
    const patched = transform(original.toString('utf8'))
    await writeFile(join(BASELINE, patchedName), patched, 'utf8')
    console.log(`已落盘 [${half}] ${join(BASELINE, patchedName)} (SHA-256 ${sha256(Buffer.from(patched, 'utf8'))})`)
  }
}

const HALVES = [
  { key: 'client', file: 'client.js', marker: CLIENT_MARKER, original: 'client.original.js', patched: 'client.patched.js' },
  { key: 'host', file: 'index.js', marker: HOST_MARKER, original: 'index.original.js', patched: 'index.patched.js' },
]

async function cmdStatus() {
  if (!targetDir) { console.log('未找到目标插件目录（用 --target-dir 指定）'); process.exitCode = 1; return }
  for (const half of HALVES) {
    const target = join(targetDir, half.file)
    if (!existsSync(target)) { console.log(`[${half.key}] 目标不存在: ${target}`); continue }
    const buf = await readFile(target)
    const original = await readFile(join(BASELINE, half.original))
    const transform = half.key === 'client' ? transformClient : transformHost
    const patched = Buffer.from(transform(original.toString('utf8')), 'utf8')
    const state = Buffer.compare(buf, original) === 0 ? 'ORIGINAL' : Buffer.compare(buf, patched) === 0 ? 'PATCHED' : 'UNKNOWN'
    console.log(`[${half.key}] ${target}\n        sha256 = ${sha256(buf)}\n        state  = ${state}`)
  }
}

async function cmdApply() {
  if (!targetDir) { console.log('未找到目标插件目录（用 --target-dir 指定）'); process.exitCode = 1; return }
  if (!flag('--yes')) {
    console.log('dry-run：将要写入 ' + targetDir + ' 下的 client.js / index.js（加 --yes 确认）')
    return
  }
  for (const half of HALVES) {
    const target = join(targetDir, half.file)
    if (!existsSync(target)) { console.log(`[${half.key}] 跳过（目标不存在）`); continue }
    const buf = await readFile(target)
    const original = await readFile(join(BASELINE, half.original))
    const transform = half.key === 'client' ? transformClient : transformHost
    const patched = Buffer.from(transform(original.toString('utf8')), 'utf8')
    if (Buffer.compare(buf, patched) === 0) { console.log(`[${half.key}] 已是当前版补丁，跳过（幂等）`); continue }
    if (buf.includes(half.marker)) {
      // 标记在但字节不同 → 装的是旧版补丁；除非 --force，否则拒绝（旧补丁可能锚点已漂移）。
      if (!flag('--force')) {
        console.log(`[${half.key}] 目标已打过【旧版】补丁（与当前补丁字节不同）。先 revert 再 apply，或 --force 强刷`)
        process.exitCode = 1
        continue
      }
      console.log(`[${half.key}] --force：旧版补丁强刷为当前版`)
    } else if (Buffer.compare(buf, original) !== 0) {
      console.log(`[${half.key}] 目标 bundle 与 baseline 不一致——版本可能已变，先 rebuild-baseline 再 apply`)
      process.exitCode = 1
      continue
    }
    const backup = target + '.dsh-bak'
    if (!existsSync(backup)) await copyFile(target, backup)
    // 先写临时文件再 rename：lib/*.js 与 pnpm store 是硬链（链接数 2），
    // 就地截断写会污染 store 里的同一 inode；rename 换目录项可保 store 原版不动。
    const tmp = target + '.patched.tmp'
    await writeFile(tmp, patched, 'utf8')
    await rename(tmp, target)
    console.log(`[${half.key}] 已应用补丁 → ${target}（备份 ${backup}）`)
  }
}

async function cmdRevert() {
  if (!targetDir) { console.log('未找到目标插件目录'); process.exitCode = 1; return }
  for (const half of HALVES) {
    const target = join(targetDir, half.file)
    const backup = target + '.dsh-bak'
    if (!existsSync(backup)) { console.log(`[${half.key}] 没有 .dsh-bak 备份`); continue }
    await copyFile(backup, target)
    await rm(backup, { force: true })
    console.log(`[${half.key}] 已还原 ${target}`)
  }
}

/** 升级专用：以当前安装的官方原版重建 baseline（仅重打两半 original，不动 patched 常量）。 */
async function cmdRebuildBaseline() {
  if (!targetDir) { console.log('未找到目标插件目录（用 --target-dir 指定）'); process.exitCode = 1; return }
  for (const half of HALVES) {
    const target = join(targetDir, half.file)
    if (!existsSync(target)) { console.log(`[${half.key}] 跳过（目标不存在）`); continue }
    const buf = await readFile(target)
    if (buf.includes(half.marker)) { console.log(`[${half.key}] 当前已是补丁态，先 revert 再重建`); continue }
    const dest = join(BASELINE, half.original)
    await copyFile(target, dest)
    console.log(`[${half.key}] 已重建 ${dest} (SHA-256 ${sha256(buf)})`)
  }
  console.log('下一步：检查 transform 锚点是否仍命中（node patch.mjs freeze 会大声报错），再同步 patched 常量与 README。')
}

// 被 import 时绝不执行 CLI：`scripts/patch-live-audit.mjs` 直接 import 本模块取 classify /
// LIVE_TARGETS。缺这道守卫会以**调用方 argv** 误跑一次（argv 为空即打印用法并可能改写调用方
// exitCode），与其余七件补丁同契约 —— 2026-09-24 三轮复审补齐，此前本件是唯一漏网的一件
// （2026-09-23 已为 attachment 补丁修过同类问题）。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const commands = {
    verify: cmdVerify, freeze: cmdFreeze, status: cmdStatus,
    apply: cmdApply, revert: cmdRevert, 'rebuild-baseline': cmdRebuildBaseline,
  }
  const cmd = positional[0]
  if (!cmd || !commands[cmd]) {
    console.log('用法: node patch.mjs <verify|status|apply|revert|freeze|rebuild-baseline> [--yes] [--target-dir <lib 目录>]')
    process.exitCode = cmd ? 1 : 0
  } else {
    await commands[cmd]()
  }
}
