# 补丁：给 `dsh-our-free-model` 的设置页做增量

## 这是什么

把本线（`@miasaki/dsh-free-model`）的**扫描能力接进上游插件的设置页**，让设置里
**只剩一个页面**、名字叫「免费模型」，且**没有公告**。

## 为什么必须用补丁

用户的三条诉求是：**一个页面**、**长在 Our Free Model 那张页面上**、**视觉与它一致**。
而 `dsh-our-free-model` 的设置页是**整页自绘**的 —— 六个 `<Section>` 写死在
`SettingsPage` 的返回值里（`client.js:1419-1441`）。官方 slot 机制只允许别的插件注册
**自己的** section，**没有往别人 section 里插内容的通道**。所以只有"在它身上做增量"这一条路。

同时**不改它的源仓库**（那是人家的项目），只改**本机安装副本**：
`%USERPROFILE%\.dsh\local-plugins\dsh-our-free-model\client.js`。

## 五处改动（锚点全部唯一命中才动手）

| id | 改动 | 说明 |
|---|---|---|
| `nav-label` | `label: () => t('nav')` → `label: '免费模型'` | 左栏名字 |
| `drop-news-section` | 删掉 `h(Section, { title: t('section.news') … })` 那一行 | 「公告中心」分区 |
| `drop-onboarding` | 删掉 `ctx.slots.inject('settings.onboarding', …)` 整块 | 首启那个 5 页公告弹窗 |
| `inject-panel-component` | 在 `function SettingsPage(props) {` 之前插入 `PlatformScanPanel` | 新分区的组件，源码在 [`inject/platform-panel.js`](inject/platform-panel.js) |
| `inject-platform-section` | 在模型清单那一行之后插入新 `<Section>` | 「本机自配平台」分区 |

**不碰的东西**：它的任何内部逻辑、它的 i18n 字典（`t()` 的 zh/en 表）、它的文件清单
（不留任何新文件 —— 纯文本改写，所以 `revert` 能把文件逐字节还原）。

新分区的**数据来自同源路由** `/freemodel-api/*`（本线 host 半身注册，cookie 自动携带，
与内核 `/api` 同级）。**本线插件不在场时**，新分区退化成一行说明 —— 不抛错、不影响本页其它分区。

## 用法

```bash
node patch.mjs status        # 每处锚点：applied / pending / drift
node patch.mjs apply --yes   # 打补丁（首次会写 client.js.ofm-patchbak）
node patch.mjs verify        # 全部 applied 才算过（已接入 verify-all 的 free-model 类别）
node patch.mjs revert --yes  # 从 .ofm-patchbak 整文件还原
```

`drift` = 锚点既不在场、也非恰好命中一次 —— **上游升级后最可能就是这个状态**，
`apply` 会显式失败而不是写坏文件。

**为什么没有"就地逆向"兜底**：那段实现无法保证逐字节还原（`replace` 类要换回原串、
`insert` 类只能删新增部分而不能删锚点，我第一版写错过）。**给出半对的回退比显式失败更糟** ——
所以无备份时 `revert` 直接失败并给出两条正路：重装插件，或按上表手工撤接入点。

## ⚠️ 升级后必须重打

上游插件的**应用内升级会覆盖清单内文件、并删除清单外文件**
（`src/updater.js` 的 `installStaged`，逐行核实过）。`client.js` 在发布清单内，
所以**每次它自升级之后，本补丁都会被冲掉**：

```
node patch.mjs status        # 期望看到 5 处 pending（= 被升级冲掉了）
node patch.mjs apply --yes   # 重打
node patch.mjs verify
```

这与本仓 `dsh-miasaki-desktop/patches/` 下那 9 件官方补丁**完全同一套纪律**：
补丁一定会被升级冲掉，所以必须有一个一眼可见的状态命令和一个一键重打命令。

若 `status` 报 **drift**（而不是 pending），说明上游改了这几行的写法：照着
`patch.mjs` 顶部 `EDITS` 里的 `from` 逐条到新版 `client.js` 里找对应位置，改准锚点后再 apply；
`inject/platform-panel.js` 与 `inject-platform-section` 的插入位置通常不受影响。

## 验证记录 `[实测]` 2026-09-28

```
副本上跑（OFM_CLIENT 指向临时副本，不动真文件）：
  status 改前        → 5/5 pending
  apply --yes        → 5 处全部写入；node --check 通过
  精确断言           → 左栏名已改 ✓ / 组件已注入 ✓ / 新分区已挂上 ✓ /
                       「公告中心」那一行已消失 ✓ / 首启公告注册已消失 ✓ / i18n 字典未被破坏 ✓
  revert --yes       → 与原文件**逐字节一致**（SHA-256 相同）
  无备份时 revert    → exit 1 + 指引（刻意不给半对的兜底）
```

## 许可

改写对象是 `dsh-our-free-model`（MIT）。本目录**不存放**它的任何副本 ——
只有锚点规则、我们自己的注入组件（`inject/platform-panel.js`）与说明。
