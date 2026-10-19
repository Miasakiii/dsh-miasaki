# 桌宠 A：多形象架构（appearance / 换装）（2026-10-19）

> 状态：**A-M1（架构）已实施（cargo test 306 例 / hash-sync 17 / 面板 32 全绿），
> 待构建部署 + 用户实机走查（E42）；首个新形象素材待生成（runbook §7）**。
> 触发：用户「桌宠鲸鱼娘是不是可以有多个形象，把参考仓库纳进来？」讨论后的路线拍板 ——
> **先 C（零素材，已落地 `2026-10-19-pet-c-time-aware-ambient.md`）解决眼前单调，
> A（本文）作多形象的主干道**。
> 关联：参考仓库评估（[`pet-reference-benchmark.md`](pet-reference-benchmark.md) §8）——
> `PC2005-cloud/dsh-pet` 素材「禁止商用 + 二创署名」⇒ **不引入其素材**；
> 多形象走**自建素材链**（源头 [TreapGoGo/deepseek-whale-girl](https://github.com/TreapGoGo/deepseek-whale-girl)，MIT）。

---

## 0. 结论先行

1. **形象 = 同一 pet mode 下的一套完整外观资产**（行集 + 立绘）。schema 用**平铺前缀键**：
   `frames.json` 的 `whale`（= default 形象，**现状一字不动**）+ `whale.<name>`（新形象，
   自包含同 schema 条目）。不嵌套——default 资产的登记零迁移，闸门与构建链天然适配。
2. **加载期烘焙**：`load_frames_for(color, appearance)` 把当前形象的行/states 装进
   **现有字段**（`whale_rows` / `whale_states`…）⇒ compose / `can_wander` / 回退链
   **零改动**，与 P2-a 配色重载同一条路径。形象切换 = `(color, appearance)` 二元组
   比对，任一变化整份重载（百 ms 级，只在用户主动切换时发生）。
3. **appearance 只对 whale 生效**（P2-a 配色先例）：kurumi / inverse 的发型服装是角色设定，
   不参与换装；解析处一句 mode 门控，面板文案写明。
4. **回落不静默**：请求了帧表里不存在的形象 ⇒ `pet.log` 留痕 + 回落 default
   （宁可用旧形象，不空白——与 `atlas_row` 回退链同哲学）。
5. **A-M1 只搭架构、不含新形象素材**：形象清单初始 `["default"]`，面板行在
   可选数 ≤1 时**不渲染**（不放 speculative UI）。首个新形象走生成流程，操作手册见 §7。
6. **ambient 可用性过滤**（P1-a 空转槽纪律的推广）：新形象未必有全部行
   （如节日形象可能没有 `wave`）⇒ 选行时按**当前生效行集**过滤池，
   池空则回落未过滤池（维持 default 行为，不回 blank）。

## 1. 范围

| 做 | 不做（记录去向） |
|---|---|
| `frames.json` 前缀键 schema（`whale.<name>`） | 引入 dsh-pet 素材 → **永久不做**（许可） |
| `load_frames_for` 加载期烘焙 + 变更重载 | 运行时解码 webm → **不做**（零依赖铁律） |
| `PetSettings.appearance` + hash `psapr` + 面板行（条件渲染） | 运行时热切换（无重载） → 不做（重载路径已够便宜） |
| build.rs 动态发现 variant 目录 + cut-frames / check-pet-assets 适配 | 稀疏覆盖（variant 只写差异行） → 不做（「看起来是 B、动作是 A」的四不像风险） |
| ambient 池按生效行集过滤 | 形象级 ambient 池声明 → 不做（行名空间跨形象不一致，噪声大于收益） |

## 2. 现状基座（A 前的相关事实）

- **帧表 schema**（`ui/pets/frames.json`）：`{ kurumi: {kind:atlas, rows}, whale: {kind:atlas, rows, states}, inverse: {kind:states, states} }`。
- **加载**（`image.rs::load_frames_colored`）：读 `frames.json` → 按主题分流到
  `kurumi` / `whale_rows` / `whale_states` / `inverse_states` → P2-a 重着色（whale only）。
- **切换重载**（`window.rs` compose 顶部）：`loaded_color` 与 `shared.settings.color`
  比对，不一致 ⇒ 整份重载 + 强制重绘（E38① 判据）。
- **设置通道**：面板 `applyShell` → hash `ps*` → `main.rs` 解析（`psclr=` 等十项）→
  `update_settings`（normalize 白名单）→ `push_pet_state` 回推（漏推 = 面板默认值覆盖用户值，R20-c 教训）。
- **构建链**：`build.rs::gen_assets` **显式清单**登记 `pets/<mode>/frames|states` 的 PNG
  （注释原话：「新增图集主题必须在这里补一行，否则运行时静默回落」）；
  `cut-frames.mjs` 按 `ATLAS_SPECS[mode]` 切图集；`check-pet-assets.mjs` 做
  frames.json ↔ 盘上文件双向校验 + 再生源在位。
- **部署镜像**：`tauri.conf.json` 的 `frontendDist: "../ui"` 整目录拷贝 ⇒ variant 子目录
  自动进 `dist/ui/` 与安装目录（robocopy /MIR），镜像链零改动。

## 3. 逐项设计

### 3.1 Schema：平铺前缀键

```jsonc
{
  "whale":     { "kind": "atlas",  "rows": { /* 现状不动 */ }, "states": { /* 现状 */ } },
  "kurumi":    { "kind": "atlas",  "rows": { } },
  "inverse":   { "kind": "states", "states": { } },
  "whale.sakura": { "kind": "atlas", "rows": { /* 新形象自包含 */ } }   // 未来
}
```

- 键 = `<mode>.<name>`；`name` 限 `[a-z0-9-]+`（小写连字符，URL/文件名安全）。
- **自包含**：variant 必须写全自己要用的行；缺失行走 `atlas_row` 回退链（§3.6 再兜一层过滤）。
- 目录 = `ui/pets/whale.sakura/`（与 `whale/` 平级），内含 `spritesheet.png`（再生源）+
  `frames/`（切帧派生）+ 可选 `states/`。

### 3.2 加载期烘焙（`image.rs`）

```rust
/// 按（配色, 形象）加载。appearance = "default" 或 "<mode>.<name>" 的 name 段；
/// 仅 whale 参与换装（调用方已做 mode 门控，这里再兜一层非 whale 回落 default）。
pub(crate) fn load_frames_for(color: u32, appearance: &str) -> Frames
```

- whale 的行/states 取 `manifest["whale.<appearance>"]`，缺失则 `manifest["whale"]`，
  再缺失（帧表被改坏）⇒ **留痕**（`pet_log_line`：`[native-pet] appearance <x> 不在帧表，回落 default`）。
- 其余主题恒 default（换装不涉及其角色设定）。
- 重着色（P2-a）在烘焙后照旧全份走一遍——**形象 × 配色正交**（樱粉配色的樱花形象 = 两者叠加）。

### 3.3 设置与 hash 通道

- `PetSettings.appearance: String`，默认 `"default"`；`APPEARANCES: &[&str] = &["default"]`
  （白名单，normalize 越界回落——既有枚举纪律）。**加形象 = 这里加一个字符串 + 面板加一个选项**。
- hash `psapr=`（字符串，与 `pspet=` 同款不转义路径）；`main.rs` 四处接线：
  parse 段、`ps_seen`、apply 段、`push_pet_state` 回推（R20-c 漏推教训）。
- window 侧重载键 `(loaded_color, loaded_appearance)`；appearance 生效值 =
  `if mode == "whale" { settings.appearance } else { "default" }`。

### 3.4 面板（`plugins/dsh-pet-panel/lib/client.js`）

- `SHELL_SETTINGS_DEFAULTS` + `appearance: "default"`；`APPEARANCE_CHOICES = [["default","默认"]]`
  （与 Rust `APPEARANCES` **逐字镜像**，闸门测试对齐——仿 `COLOR_CHOICES`）。
- 「形象」行：`choices.length > 1` 才渲染（一个选项的单选是噪音）；文案注明
  「只对鲸鱼娘生效；狂三与反转狂三是角色设定，不随这里变化」（配色行同款口径）。
- 控件走官方 `SegmentedControl`（`segmentCtl`，与配色行同家族）。

### 3.5 构建链适配

- **build.rs**：`pets/` 目录扫描从显式两主题扩为**动态发现** `^[a-z]+(\.[a-z0-9-]+)?$`
  的目录（默认三主题 + 任意 variant），frames/ 与 states/ 各扫各的 PNG。
  variant 素材**零代码入链**；「静默回落」风险由 loader 留痕（§3.2）+ check-pet-assets 双向校验管。
- **cut-frames.mjs**：`ATLAS_SPECS` 加 variant 键时顺带加它的行名表（切图规格按图集实测，
  与 default 不共享——2026-09-27 教训：行号是模板约定，不是跨主题语义契约）。
- **check-pet-assets.mjs**：`references()` / 孤儿派生 / 再生源三件套按 manifest 键遍历，
  **对前缀键天然适用**；`REGEN_SOURCES` / `MANUAL_ASSETS` 在新增形象时补条目。

### 3.6 ambient 可用性过滤（`model.rs` + `window.rs`）

```rust
pub(crate) fn pick_ambient_choice(
    band: AmbientBand, mode: &str, time: TimeBand, has: &dyn Fn(&str) -> bool,
) -> AmbientChoice
```

- 池 = `ambient_pool(mode)` 经 `has` 过滤（`has` = 当前生效行集里该行有帧）；
- 过滤后为空 ⇒ 回落**未过滤**池（degenerate 形象至少维持 default 节奏，不回 blank）；
- E5 不重复记忆不变（索引空间以过滤后池为准；形象切换时由重载路径天然重置——
  重载不重置 `AMBIENT_LAST`，但池内容随形象变，索引可能指向不同行：**可接受**
  （最坏是一次「不重复」判定的短暂失准，不产生空转槽——过滤已保证行都存在）。

## 4. 与既有机制的关系

1. **与配色（P2-a）正交**：配色是运行期重着色（加载期做一次），形象是资产集切换；
   两者在 `load_frames_for` 汇合成一个加载键。
2. **与 pet_override 正交**：override 选 mode（whale/kurumi/inverse），appearance 在
   mode 内选自定；override 到非 whale ⇒ appearance 自动失效（mode 门控）。
3. **与六态/动作槽零耦合**：形象只换「演出的演员」，不换「演出脚本」（`pick_state_row` 不动）。
4. **零新模块**：settings 加一字段、image 加一函数、window 改重载块、main 加一 hash 键、
   面板加一行、build.rs 改发现逻辑。

## 5. 单测清单（实施后实况）

| 文件 | 例 | 判据 |
|---|---|---|
| `settings.rs` | +3 | `appearance` 默认 "default"；白名单越界回落；roundtrip 保留 |
| `image.rs` | +1 | `appearance_key_resolves_default_and_variant`（7 形断言：default / 空 / 合法 variant / 缺失回落 / 非法字符 / 大写 / 空格） |
| `model.rs` | +2 | 池过滤（有 has 时只返存在的行）；过滤空 → 回落未过滤池 |
| `window.rs` 源码契约 | +2 | 重载块含 appearance 比对；ambient 传 has 闭包 |
| `main.rs` | +0 | `psapr=` 解析与 `push_pet_state` 回推由 `themes/test/hash-sync.test.js` 的 2 例覆盖（main.rs 无新增 `#[test]`） |
| 面板 `panel-settings.test.js` | +3 | `APPEARANCE_CHOICES` 与 Rust 白名单镜像；条件渲染（≤1 不渲染）；默认值含 `appearance:"default"` |

## 6. 验收判据（实施后入回归矩阵 E42）

1. **架构就位（工程）**：`cargo test` 全绿（**新增 8 例，298 → 306**；面板契约组另 3 例、
   `hash-sync` 另 2 例属 JS 测试，不计入 cargo 例数）；`verify-all desktop` PASS；
   `node --test plugins/dsh-pet-panel/test/` 全绿（含三条新闸门）。
2. **无回归（实机）**：构建 + 签名 + 外部终端部署 + 重启 ⇒ 桌宠三主题行为与升级前一致
   （形象字段默认 default = 现有资产；hash 新键不影响既有 `ps*` 通道）。
3. **机制就位（实机，间接）**：面板桌宠页在只有「默认」形象时**不出现**「形象」行（无机噪音）；
   `pet-settings.json` 含 `appearance:"default"` 字段。
4. **首个新形象（另立验收）**：视觉切换本身待素材——按 §7 runbook 生成第一个形象后
   补实机判据（切换即时、位置不动、其余设置不丢、落盘重启保持、halo/配色正交叠加）。

## 7. 加第一个形象的操作手册（runbook）

以「樱花（sakura）」为例，**六处、一处不能少**（顺序即依赖）：

1. **素材**：按自建链生成 11 行图集（ prompts 参考 MIT 资产库 + 既有图集规格 192×208/格），
   存 `ui/pets/whale.sakura/spritesheet.png`（+ 可选 `states/` 立绘）。
2. **切帧**：`cut-frames.mjs` 的 `ATLAS_SPECS` 加 `"whale.sakura"` 行名表 → 跑脚本
   （产出 `frames/` + frames.json 增量；`check-pet-assets` 的 `REGEN_SOURCES` 同步补一条）。
3. **帧表**：`ui/pets/frames.json` 加 `"whale.sakura": { "kind": "atlas", "rows": {...} }`
   （脚本自动写入则核对；script 未覆盖则手补）。
4. **Rust 白名单**：`settings.rs` 的 `APPEARANCES` 加 `"sakura"`。
5. **面板**：`APPEARANCE_CHOICES` 加 `["sakura", "樱花"]`（行自动出现）。
6. **构建 + 闸门 + 部署**：`cargo test` → `verify-all desktop` → 外部终端 `deploy-local.ps1`
   → 重启实机走查（§6.4 判据）。

> build.rs **不用改**（动态发现）；`main.rs` / `window.rs` / `image.rs` **不用改**
> （白名单 + 加载键 + 烘焙路径对任意形象同名）。

## 8. 落地记录（2026-10-19）

| 项 | 文件 | 验证 |
|---|---|---|
| 形象键解析 + 加载期烘焙 | `image.rs`（`resolve_appearance_key` / `load_frames_appearance` / `load_frames_for` / `Frames::rows_have`） | `appearance_key_resolves_default_and_variant`（default/空/合法 variant/缺失/非法字符/大写/空格 7 形） |
| 设置字段 + 白名单 | `settings.rs`（`appearance` / `APPEARANCES` / `APPEARANCE_DEFAULT` / normalize） | `appearance_whitelist_falls_back` / `appearance_survives_round_trip` / `appearance_default_is_whitelisted`（白名单必须含回落值） |
| 加载键重载 | `window.rs`（`(color, appearance)` 二元组比对 + `loaded_appearance` 字段 + mode 门控） | `compose_reloads_frames_on_appearance_change` / `compose_reloads_frames_on_color_change`（同步改断言） |
| ambient 可用性过滤 | `model.rs`（`pick_ambient_choice` 第四入参 `has`）+ `window.rs`（闭包接线） | `ambient_pool_filters_by_available_rows` / `ambient_pool_empty_filter_falls_back_to_full` / `ambient_choice_filters_by_available_rows`（源码契约） |
| hash 通道 | `main.rs`（`psapr` parse/apply/ps_seen/`push_pet_state` 回推）+ `themes/src/02-core.js`（psSegs + **keep 管理列表两处**） | `themes/test/hash-sync.test.js` 新增 2 测（psapr 上报/缺字段不写/旧值替换） |
| 面板 | `plugins/dsh-pet-panel/lib/client.js`（`appearance` 默认值 / `APPEARANCE_CHOICES` / 条件渲染行） | `panel-settings.test.js` A 契约组（清单镜像 / ≤1 不渲染 / segmentCtl / 上报字段名） |
| 构建链 | `build.rs`（主题目录**动态发现** `^mode(\.name)?$`）+ `cut-frames.mjs`（按 ATLAS_SPECS 键自动切） | 随 `cargo test` 编译；`check-pet-assets.mjs` 对前缀键天然适配（零改动） |

**回归证据**：`cargo test` 298 → **306 例**（305 passed + 1 ignored；A 新增 8）；
`themes/test/hash-sync.test.js` **17/17**；`panel-settings.test.js` **32/32**；
`verify-all desktop` **43/43**（A 批不新增闸门项——架构就位由上述单测与契约管）。

**同批修掉的真 bug（R20-c pshl，非本批引入）**：`pshl` 只加进 `02-core.js` 的 psSegs、
漏加 keep 管理列表 ⇒ 当前 hash 里的旧 `pshl` 被 keepPart 原样保留、与 psPart 新值拼出
**重复键**，Rust 顺序解析后值覆盖（keepPart 在 target 尾部）⇒ 用户切换柔光开关
**间歇性不生效**。修法 = keep 列表补 `pshl`；`hash-sync.test.js` 新增回归测
（「切换后 hash 里只许一个新值」）——这条判据从此钉住**所有** ps* 管辖键。
