# Datawhale《最新！DeepSeek Harness 插件教程来了！》归档

- 归档日期：2026-08-16
- 原发布：2026-08-14 22:16（北京时间）
- 来源：微信公众号「Datawhale」（user_name: gh_7e08dd400559）
- 原文 URL：https://mp.weixin.qq.com/s/gip3nyB6mw48aTa-Q3gYjg
- 获取方式：直连原文页面解析正文（微信对第三方抓取有验证码拦截）；代码块由提取文本重建为规范格式
- 关联文档：`docs/multi-agent-cli-orchestrator-design.md`（v0.6 已吸收其结论）
- 归档者：总指挥（Miasaki 会话）

---

Datawhale 干货 · 最新：DeepSeek Harness

上一篇 DeepSeek Harness 保姆安装教程之后，因为 DeepSeek Harness 最重要的设计原则：**一切皆插件**。今天，我们就来教大家如何玩插件！

这件事可以分成两部分：

1. 自己写一个最小插件，理解 Harness 怎样注册工具。
2. 安装别人写好的插件，直接获得完整能力。

第一部分是学习机制，第二部分是日常使用。

## 保姆教程：写一个 DeepSeek Harness 的最小插件

我们做一个 greet 工具。Agent 调用它并传入名字，插件返回：

> 你好，Datawhale！你的第一个 Harness 插件已经运行。

### 1. 准备源码环境

直接体验 Harness 时，用 `npx @deepseek-ai/dsh web` 就够了。开发原始 TypeScript 插件，需要进入 Harness 源码仓库，这也是官方入门文档采用的方式。

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack enable
pnpm install
pnpm run build
```

本文实测使用 Node.js v24.19.0。Harness 声明的 Node.js 范围是 ^22.19.0 || >=24.0.0，不确定时直接用 Node 24。

**`pnpm run build` 不要省。** 我第一次只安装依赖，插件日志虽然出现了，Web 页面却缺少构建产物。

### 2. 创建插件文件

仍在 deepseek-harness 仓库根目录执行：

```bash
mkdir -p scratch-plugin/src
```

新建 `scratch-plugin/src/greet-tool.ts`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `你好，${args.name}！你的第一个 Harness 插件已经运行。`
    },
  }))
  console.log('[greet-tool] loaded; tool name: greet')
}
```

先不用研究所有类型。这个插件只有四个部分：

- `name`：插件名称。
- `inject`：声明需要 Harness 的工具服务。
- `apply(ctx)`：插件加载入口。
- `ctx.tools.register(...)`：注册一个模型可以调用的工具。

`parameters` 告诉模型该传什么；`execute` 真正执行代码；`output` 约定结果的类型和显示方式。

### 3. 把插件插入 Harness

先执行 `pwd`，拿到当前 Harness 仓库的绝对路径。

新建 `scratch-plugin/cordis.yml`：

```yaml
- insert:
  - id: greet-tool
    name: '/Users/yourname/deepseek-harness/scratch-plugin/src/greet-tool.ts'
```

把 name 换成你机器上的绝对路径。

**插件最好放在 Harness 源码仓库内。** 这个示例依赖仓库里的 @deepseek-ai/cordis 和 @deepseek-ai/dsh-tools；放到另一个目录，可能出现 Cannot find module。

### 4. 启动并检查

```bash
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

如果 3080 端口已经被占用：

```bash
pnpm dsh web --patch ./scratch-plugin/cordis.yml --port 3082
```

看到下面两行，说明插件和 Web 服务都已就绪：

```
[greet-tool] loaded; tool name: greet
dsh web: http://127.0.0.1:3082
```

进入"设置 → 插件 → 插件列表"，搜索 greet-tool.ts，状态应为"已启用"。

[图片] 插件已经挂载

### 5. 让 Agent 调用它

选择工作区，新建一个标准模式会话，输入：

> 请调用 greet 工具问候 Datawhale。

展开工具调用，可以看到输入和输出：

```
IN  { "name": "Datawhale" }
OUT 你好，Datawhale！你的第一个 Harness 插件已经运行。
```

[图片] greet 工具调用成功

至此，插件最小闭环已经跑通：**加载插件、注册工具、模型调用、返回结果**。

## 直接安装生产级的插件

greet 适合学习，但解决不了真实问题，开发一个完整插件的难度也是比较高的。所以，我们可以直接用大佬们做的插件。

以 **DSH Vision Toolkit** 为例。DeepSeek 当前这条 Chat Completions 路由是纯文本模型，不能直接理解图片；Vision Toolkit 可以把图片交给单独的视觉模型，再把文字、坐标和文件产物送回 Harness。

[图片]

它提供图片问答、OCR、元素定位、图片裁剪、像素对比和 HTML 截图等工具。

### 1. 安装插件

如果你的终端里已经有 dsh 命令：

```bash
dsh plugin --profile web add @dsh-external/dsh-vision-toolkit
```

如果上一篇一直使用 npx，可以写成：

```bash
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add @dsh-external/dsh-vision-toolkit
```

插件安装到 web Profile 后，检查配置里是否已经出现它：

```bash
dsh --profile web --dump-config | grep vision-toolkit
```

然后**重启**正在运行的 Harness Web 服务。插件的宿主代码和浏览器代码都在启动时加载，只刷新页面通常不够。

### 2. 配置视觉模型

Vision Toolkit 要求 Python 3.11 或更高版本。第一次使用 managed 运行时还需要联网安装它锁定的 Python 依赖。

打开 Harness 的"设置 → 视觉工具"，配置：

- 一个兼容 OpenAI 接口的视觉模型地址；
- 对应的视觉模型名称；
- 一个 DSH Credential 引用，例如 VISION_API_KEY。

密钥可以通过命令写入 Harness 的凭据系统：

```bash
dsh credentials set VISION_API_KEY
```

**这里配置的应该是视觉服务 Key，不是默认的 DeepSeek 文本模型 Key**，除非你使用的网关明确同时提供视觉模型。

在设置页面点击"测试连接"。远程图片问答、定位和 OCR 需要视觉服务；裁剪、颜色分析、像素对比等本地工具不需要 Key。

### 3. 在会话中使用

把图片复制进当前工作区，例如：

```
./screenshot.png
```

在会话中先加载插件附带的 Skill：

```
/vision-tools
```

然后直接描述任务：

```
请用 vision_glance 分析 ./screenshot.png，告诉我页面上出现了什么错误。
```

也可以做更具体的工作：

```
请用 vision_ground 定位截图里的发送按钮，并生成带标注的预览图。
请比较 reference.png 和 actual.png，告诉我差异最大的区域。
```

插件会按需向当前 Agent 暴露对应的 vision_* 工具。生成的裁剪图、热力图和报告会保存在工作区的 `.dsh-vision-toolkit/artifacts` 目录中。

### 4. 更新或卸载

```bash
dsh plugin --profile web update
dsh plugin --profile web remove @dsh-external/dsh-vision-toolkit
```

操作后重新启动 Web Profile。

## 安装第三方插件前的注意事项

- 仓库是否公开，许可证和维护者是否清楚；
- 安装脚本会下载什么，是否会运行额外程序；
- 插件需要哪些目录、网络和凭据权限；
- 是否说明支持的 Harness 版本、卸载方式和测试方法。

**Harness 插件运行在宿主进程里，属于可信代码。不要因为安装命令只有一行，就跳过源码和权限检查。**

## 写在最后

自己写插件时，最小结构是：

> apply(ctx) → 注册工具 → execute(args) → 返回结构化结果

使用现成插件时，流程是：

> plugin add → 重启 Profile → 配置凭据 → 加载 Skill → 调用工具

前者让你理解 Harness，后者让 Harness 真正变得有用。

[图片]

一起"点赞"三连↓
