# M36 三主题端到端校验（2026-08-22）

> 从原 `docs/m36-rc8-regression-smoke-2026-08-22.md` 拆出的桌面端部分。
> 平台级回归见 `../../dsh-miasaki-shared-docs/dsh-platform/m36-rc8-regression-2026-08-22.md`。

桌面端 P1-3。首次在真机完整跑通 `scripts/verify-themes.mjs`（此前因无头 Edge 命名管道限制未在沙箱跑成）。结果 **18/18 通过**。

| 主题 | 关键断言 | 结果 |
|---|---|---|
| pure | 属性 / 切换条 / 无水印 / 不干预明暗 | 4/4 ✅ |
| zafkiel | 强制暗色 / 墨夜基底 `#0c0b11` / 绯红 `#c23a2e` / 鎏金 `#d9b36a` / 表盘水印 | 5/5 ✅ |
| kurkuriel | 强制亮色 / 骨白基底 / 深端同步覆盖 `#0f0d0b` / 血绯 `#9e1b1b` / 破裂表盘水印 | 5/5 ✅ |
| 持久化 + 切回 pure | localStorage / 切回生效 | 2/2 ✅ |

## 附带修复
原断言 `kurkuriel: 骨白基底令牌` 检查 `--dsw-static-neutral-bluish-950 === '#e9e5e1'`，但 `kurkuriel.css` 自初版（4f07bd9）起该令牌即声明 `#0f0d0b`——骨白实际走 DSH 亮色语义亮端令牌（`--dsw-static-neutral-bluish-50=#fcfaf8`）+ `--dsw-alias-bg-base=rgba(247,244,241,.88)`。该断言从首次提交即不可满足（脚本从未跑通而潜伏）。修正为：亮端令牌 + alias 基底含 `247,244,241`，并新增「深端令牌同步覆盖=`#0f0d0b`」断言佐证覆盖链路健康。见 `scripts/verify-themes.mjs`。

> 注：测试断言修复，非主题代码回归——实测值与主题声明值一致，令牌覆盖链路在 0.1.1-rc.1 下健康。
