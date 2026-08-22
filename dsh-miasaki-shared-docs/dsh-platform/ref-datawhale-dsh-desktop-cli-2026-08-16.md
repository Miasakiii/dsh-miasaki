# Datawhale《最新！DeepSeek Harness 桌面版和 CLI 来了！》归档

- 归档日期：2026-08-16
- 原发布：2026-08-16 23:32（北京时间）
- 来源：微信公众号「Datawhale」（user_name: gh_7e08dd400559）
- 原文 URL：https://mp.weixin.qq.com/s/uIFETPQyOY59gt7dNGKgHQ
- 获取方式：直连原文页面解析正文（微信对第三方抓取有验证码拦截）；代码块由提取文本重建为规范格式
- 关联文档：`docs/multi-agent-cli-orchestrator-design.md`（v0.9 已吸收其结论）
- 归档者：总指挥（Miasaki 会话）

---

Datawhale 干货 · 最新：DeepSeek Harness

DeepSeek Harness 发布后，大家都觉得网页版有点难受。

[图片]

今天，我们挑选了目前 Star 数最高的桌面端、CLI 版的两个社区开源项目做了保姆教程：

- **DSH Desktop**：真正的 macOS、Windows 桌面应用，目前约 8.5k Star（归档时实测 11,129★，2026-08-17）。
- **dsh-TUI**：Claude Code 风格的终端界面，目前约 1.5k Star（归档时实测 1,770★，2026-08-17）。

## 一、安装前：共同的环境要求

两个项目都要求 Node.js ^22.19 || >=24。我建议直接使用 Node 24。dsh-TUI 还需要 pnpm 10 或更高版本。

先检查：

```bash
node --version
pnpm --version
```

本文实测环境：macOS Apple Silicon / Node.js v24.19.0 / pnpm 11.19.0 / @deepseek-ai/dsh 0.1.0-rc.6 / @deepseek-harness-tui/dsh-tui 0.7.1

如果没有 pnpm：

```bash
corepack enable pnpm
pnpm --version
```

下面的命令固定为本文实测版本，方便复现；想追最新版时，可以把版本号换成 @latest。

## 上半篇：安装桌面版 Web UI

[图片]

https://github.com/anywhere-labs/deepseek-harness-desktop

这个项目把 Electron、Node.js 和 Harness 一起打进安装包。普通用户不用安装 Node，不用执行 npx，也不用自己管理 3080 端口。

目前官网提供：macOS（Apple Silicon 版本，要求 macOS 12 或更高）、Windows（x64 安装包）。

### 1. 下载桌面版

打开项目官网：https://www.dshdesktop.cn 根据系统点击"下载 Mac 版"或者"下载 Windows 版"。

### 2. macOS 安装

打开下载好的 DMG，把 DSH Desktop 拖到 Applications 文件夹。

Windows 用户运行下载的 DSH-Desktop-2.0.0-x64-Setup-public.exe，按照安装向导完成即可。

本文下载的 macOS 2.0.0 安装包已通过系统签名和公证检查，随后从"应用程序"目录成功启动。

### 3. 第一次打开

首次启动时，DSH Desktop 会在本机准备默认 Profile，并自动启动 Harness 服务。第一次会比后续启动慢一点。

这时已经不需要再打开浏览器，也不需要保留一个终端窗口。应用会负责本地 Harness 服务的启动、停止和恢复。

### 4. 配置模型

点击左下角"设置"，进入模型设置，在 DeepSeek 卡片中填写 API Key。没有 Key，可以先去 DeepSeek 开放平台创建。

这里有个简单但很重要的习惯：**配置 Key 时不要截图，也不要把 Key 写进会提交到 Git 的文件。**

### 5. 添加工作区

回到主界面，点击工作区旁边的添加按钮，选择一个项目文件夹。

第一次建议新建一个空的 dsh-demo 文件夹，**不要直接选择用户主目录、下载目录或者存放私人文件的目录**。

新建会话时先保持：Agent 标准模式 / 权限 Workspace Write / 模型默认。

第一条任务可以很简单：

> 阅读当前目录，告诉我这里有哪些文件。先不要修改任何内容。

能正常返回目录信息，桌面版就跑通了。

## 二、下半篇：安装 CLI 版 dsh-TUI

[图片]

https://github.com/ccch1mneyyy/dsh-TUI

dsh-TUI 是社区维护的终端界面，使用体验更接近 Claude Code。它仍然调用官方 Harness 的 Agent、会话、工具、Skills、MCP 和权限服务。

### CLI 第 1 步：安装官方命令和 dsh-TUI

```bash
npm install -g \
  @deepseek-ai/dsh@0.1.0-rc.6 \
  @deepseek-harness-tui/dsh-tui@0.7.1
```

再确认 pnpm 不低于 10：

```bash
pnpm --version
```

### CLI 第 2 步：进入项目并启动

第一次运行时，dsh-TUI 会自动创建一个名为 dsh-tui 的 Profile，并把插件装进去。网络慢时，这一步需要多等一会儿。

看到右上角的 dsh-TUI v0.7.1，以及底部的模型名称和当前工作区，就说明 CLI 界面已经加载完成。

### CLI 第 3 步：配置 API Key

macOS 和 Linux 可以在启动 dsh-TUI 的同一个终端里设置：

```bash
export DEEPSEEK_API_KEY='你的 DeepSeek API Key'
dsh-tui
```

如果使用自定义兼容端点，再增加：

```bash
export DEEPSEEK_BASE_URL='https://你的网关地址/v1'
```

不要把 Key 写进会提交到 Git 的脚本或 .env。如果 TUI 已经启动，修改环境变量后需要退出并重新运行。

### CLI 第 4 步：运行环境自检

进入 TUI 后输入 `/doctor`——它会显示 Node 版本、系统架构、模型、工作目录、凭据状态和会话存储位置。

[图片]

本文的隔离测试环境故意没有放真实 Key，所以截图里显示 API key: not configured。Node、工作区和会话存储均已正常加载。

### CLI 第 5 步：发送第一条任务

> 先阅读当前项目，不要修改文件。告诉我启动入口、主要依赖和最值得先修的一个问题。

### CLI 最常用的命令

- `/help` 查看命令和快捷键
- `/doctor` 检查环境
- `/model` 切换模型
- `/preset` 切换 Agent 预设
- `/permissions` 查看权限说明
- `/new` 新建会话
- `/resume` 恢复历史会话
- `/compact` 压缩长上下文
- `/cost` 查看 token 用量
- `/mcp` 查看 MCP 连接
- `/theme` 切换主题

快捷键先记四个：

- Enter 发送
- Shift+Enter 换行
- Ctrl+C 中断当前回合；空闲时连按两次退出
- Ctrl+O 展开或收起思考、工具参数和输出

### CLI 版适合谁

- 喜欢全键盘操作的人
- 经常在 VS Code 内置终端里写代码的人
- 需要通过 SSH 操作远程服务器的人
- 熟悉 Claude Code、希望快速上手的人

## 补充：真正的一行非交互 CLI

dsh-TUI 是交互式终端界面。如果你只想在脚本里执行一次任务，可以使用官方 Headless Profile：

```bash
dsh --profile headless "阅读当前项目，输出模块清单和三个风险点"
```

它会打印最终答案，然后退出。这个入口适合 CI、Shell 脚本和批处理，不建议第一次使用时从这里开始。

[图片]

一起"点赞"三连↓
