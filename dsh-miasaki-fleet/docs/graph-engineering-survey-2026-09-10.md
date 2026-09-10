# Graph Engineering（图工程）调研报告 —— 面向多模型多 Agent 协作

- 日期：2026-09-10
- 性质：**调研报告**（不含实现承诺）
- **唯一落点：`dsh-miasaki-fleet`（多 Agent CLI 编排线）**——本报告全部结论服务于"给 fleet 搭建 Graph Engineering"
- **落地文档**：[graph-engineering-fleet-design.md](graph-engineering-fleet-design.md)（字段级搭建方案；本报告是它的依据与背景）
- 调研对象：2026-07 起发酵的 Graph Engineering 概念、2026-08 的首篇系统性综述，以及可迁移到 fleet 的工程机制
- 方法：一手文献（arXiv 综述 + 作者配套 Awesome 仓库）+ 官方立场（LangChain 等）+ 中文社区实操解读，三源交叉；凡属推测处均显式标注

> **⚠️ 取证限制（必须知悉）**：本轮调研期间**HTTPS 出网受限**——`web_fetch` 对 arxiv.org / github.com raw / 部分学术站点大量超时，`curl` 因 TLS 凭据不可用直接失败（exit 35）；可用通道为 `web_search`（返回标题与片段）、部分白名单站点（163 / 腾讯云 / 阿里云 / 七牛云 / jsdelivr）与 `mcporter` exa。
> 因此：**中文社区文章与官方配套 Awesome 仓库为原文级证据**；**2026 年新发表的论文（2503/2505 系列除外）多为标题+片段级的机制归类，未逐篇精读**，凡此类处均已在文中逐条标注，**未编造任何实验数字**。如需逐篇精读，需在有出网的环境补抓或取得 PDF。

---

## 0. 摘要（先看六条）

1. **Graph Engineering 不是新发明，但指向的问题是真的。** LangChain 明确回应"图工程不是新东西"——他们用 LangGraph 做基于图的 Agent 系统已经三年、月下载量 6500 万+；后端圈更早，BPMN / Airflow DAG / Saga 长事务是同一套思想。真正的增量只有一句话：**节点里能装的东西变了**——节点从"单次 LLM 调用"升级为"一个完整的 Agent 运行"，于是"编排 Agent"成了新问题。

2. **学术定型发生在 2026-08。** 吉林大学、厦门大学等 15 家机构的综述 [Graph Engineering in the Era of LLM Agents: From Individual Intelligence to System Intelligence](https://arxiv.org/abs/2608.21156)（arXiv:2608.21156）给出了完整框架，配套资源库 [DEEP-JLU/Awesome-Graph-Engineering](https://github.com/DEEP-JLU/Awesome-Graph-Engineering)。

3. **框架是三层 + 一演化 + 一本体**：任务组织（Task Organization）、智能体协调（Agent Coordination）、运行时状态管理（Runtime State Management），加系统演化（System Evolution），下一步是本体工程（Ontology Engineering）。**这三层恰好是 fleet 现有的三个议题**，不是外来框架，而是给已有工作补上了坐标系。

4. **对本仓最重要的一个判断**：fleet 已经具备"节点 = 完整 Agent"这一**前提条件**（worker = 本机 agent CLI），但协调层仍是**星型拓扑 + 隐式路由**（Commander 当 hub、`skills` 标签当路由依据）。缺的不是"要不要上 LangGraph"，而是三件可增量补齐的事：**任务图显式化、能力图、失败归因**。

5. **一个强反证必须记住**：LangChain 自己承认，路径需要探索的任务（如通用深度研究）**不该硬塞进图**——他们早期用预定义 LangGraph 工作流做深度研究，后来转向更 Agentic 的核心循环；GPT Researcher 做了同样的反向迁移。判断标准：**路径能提前画出来 → 用图；路径本身需要探索 → 用 Agent Harness。**

6. **结论已转化为搭建方案**：本报告的机制清单与差距分析喂给了 [graph-engineering-fleet-design.md](graph-engineering-fleet-design.md)——把 GE 的三层落到 fleet 上，即 **G1 任务图（DAG/钻石结构）、G2 能力图（带类型边的多模型选型）、G3 状态图（机器事件流 + 失败归因）、G4 验证器节点（异构验证）**，全部以"协议字段扩展 + 派单器改造"实现，不引入框架。优先级：G1 > G2 > G4 > G3；失败归因与结构演化留到有真实失败样本之后，避免凭空设计。

---

## 1. 概念谱系：从 Prompt 到 Graph

### 1.1 一条被刻意铺平的阶梯

社区（尤其中文技术圈）把 Agent 工程范式整理成了一条阶梯，每上一级都在解决上一级撞到的墙：

| 范式 | 管辖对象 | 解决的问题 |
|---|---|---|
| Prompt Engineering | 单次调用 | 模型该做什么 |
| Context Engineering | 单次调用的输入 | 模型能看到什么信息 |
| Harness Engineering | 单个 Agent | 工具、记忆、技能、执行环境的接入 |
| Loop Engineering | 单个 Agent 的持续执行 | 规划→行动→观察→反馈的闭环 |
| **Graph Engineering** | **多个执行单元之间** | **任务怎么拆、谁先做谁后做、怎么并行汇合** |
| Ontology Engineering（下一步） | 整个系统的语义 | 让不同组件对"完成/证据/合法状态"有一致定义 |

综述原文的表述更凝练：一个能自主完成任务的 Agent = LLM + Harness + Loop；而 Harness 决定能访问什么资源，Loop 决定如何在规划/行动/观察/验证间循环。**单个单元在"调度并行且相互依赖的任务、整合异构能力、维护运行时状态"三件事上存在固有局限**，这推动智能从"个体智能"走向"系统智能"。

### 1.2 时间线（含热度来源）

| 时间 | 事件 |
|---|---|
| 2026-06 | Peter Steinberger（OpenClaw 创始人）喊出 Loop Engineering |
| 2026-07 上旬 | 同一个人转问："我们还在讨论循环结构，还是已经转向图论了？"评论区出现"Loop Engineering 已死，Graph Engineering 永生" |
| 2026-07-23/24 | [LangChain 官方回应《3 Years of Graph Engineering with LangGraph》](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph)：不是新东西 |
| 2026-08 | [首篇系统性综述发布](https://arxiv.org/abs/2608.21156)，概念学术定型 |
| 2026-08-25 | 中国人工智能学会/学术头条的中文解读《[AI Agent 的下一站：Graph Engineering](https://www.163.com/dy/article/L56UO4DT0511PEBT.html)》扩散至国内 |

> 值得注意：造词者与"泼冷水者"来自同一个圈子，且间隔不到一个月。本报告的建议是**学机制、不追名词**——中文社区对此的判断相当一致（见 §2.2）。

### 1.3 学术框架：三层 + 演化 + 本体

综述把 Graph Engineering 定义为"把原本隐藏在上下文和控制逻辑中的关系**外显为可操作的图结构**"，分三个相互连接的层面：

**① Task Organization（任务组织）—— 明确"要完成什么、如何组织"**

- **目标分解（Goal Decomposition）**：高层目标 → 子目标图；节点 = 子任务/中间目标，边 = 先后顺序、数据依赖或逻辑关系。
- **工作流编译（Workflow Optimization）**：语义子目标 → 可执行图，节点类型包括 LLM、专业 Agent、检索模块、工具、记忆操作、聚合器、验证器。
- 关键点：**这不是一次性制定计划**，而是在目标分解、流程编译、执行反馈之间持续迭代。

**② Agent Coordination（智能体协调）—— 明确"谁来做、信息怎么流动"**

- **能力图**：把 Agent、技能、工具、模型、资源表示为节点，用**带类型的边**记录能力归属、资源访问、权限、可靠性。系统据此按需分配，并在能力/资源变化时寻找替代者。
- **团队图**：规定任务归属、委派路径、输出交接、审查责任。不同拓扑分别适合顺序执行、专业路由、并行协作，但**协调与计算成本不同**。
- **通信图**：谁需要与谁交换信息、反馈如何影响后续行动。**"更多连接不等于更好协作"**——冗余通信会增加成本或放大错误。
- 人类可作为图中的**显式参与者**，承担澄清、审批、纠错、接管。

**③ Runtime State Management（运行时状态管理）—— 让执行可追踪、可诊断、可恢复**

- **状态记录**：记录每次状态变化的内容、来源、版本，并对共享状态更新施加约束。
- **故障定位**：依据执行记录、依赖关系、外部证据定位**最早的无效状态**，判断哪些后续步骤受影响。原文措辞克制：**"图关系可以缩小排查范围，但不能直接证明因果关系"**。
- **失败恢复**：选择明确的恢复边界，保留有效工作、修复受影响部分——回放计算、撤销无效状态、切换执行分支，或**补偿无法回滚的外部操作**。

**④ System Evolution（系统演化）**

- 执行结果本身会揭示：哪些任务分解有效、哪些通信关系成本过高、哪些 Agent 更适合某角色、哪些状态更新容易引发连锁故障。
- **重要区分**：**运行时适应 ≠ 持久化系统演化**。一次执行中的临时路由/恢复/重分配，不等于系统改变了组织方式。真正的自演化需要完整闭环：执行 → 观察 → 结构归因 → 图修改 → 验证 → 提交或回滚。

### 1.4 综述自陈的四大挑战（预判了我们的坑）

| # | 挑战 | 对 fleet 的直接含义 |
|---|---|---|
| 1 | **图原生能力底座** | 记忆库、技能库、工具注册表、模型服务彼此分离；选能力时不仅看"能不能做"，还要看依赖什么、能否替代、怎么组合、要什么权限。**需要统一能力图，并与任务图/Agent 图/状态图连接** |
| 2 | 自演化图系统 | 结构演化必须配套来源记录、版本控制、验证、回放、回滚，阻止不可靠的结构变化跨任务传播 |
| 3 | 图原生 Agent OS | 现有技术栈（模型服务/Harness/工作流引擎/记忆/多 Agent 框架/状态存储）各自抽象不统一；MCP、LangGraph、AIOS 都只解决了一部分 |
| 4 | 隐私与伦理 | 敏感信息在多组件间复制、沿工作流传播、长期留在轨迹里；责任归属更难 |

---

## 2. 争议：这到底是不是新东西

### 2.1 LangChain 的官方立场（最有分量的反调）

要点摘录（[原文](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph)）：

- 图工程不是新东西；LangGraph 已经这样做了三年。
- 新词之所以冒出来，是**因为它们描述了构建者真正面临的挑战**——Prompt / Context / Harness / Loop 工程都是实际落地撞过的墙。
- **新的是节点里能装什么**：早期节点是确定性代码或单次 LLM 调用；现在一个节点可以是一个完整的 Agent 运行。Coding Agent 就是最好的例子——"把一个 Coding Agent 嵌入到更大的图里作为一个节点，这是最近才变得实用的模式"。

### 2.2 后端视角：这就是工作流引擎

中文社区的判断（[腾讯云文章](https://cloud.tencent.cn/developer/article/2715084)、[阿里云文章](https://developer.aliyun.com/article/1750976)）值得记录：

- 这套东西后端圈用了十来年：**Activiti/Flowable/Camunda 的 BPMN 图**（节点=审批环节，边=流转条件，状态=流程实例上下文；串行/并行/会签/回退全在图里）、**Airflow/DolphinScheduler 的 DAG**（fan-out / fan-in 是调度系统的老词）、**Saga 长事务与状态机**（把复杂流程拆成节点，用边控制走向）。
- 所以"Graph Engineering 是设计方法，不是某个框架的专利"——手里有什么工具就能用什么工具落地。

### 2.3 一个诚实的降级：Loop 没死，它变成了图里的一个节点

- Loop 与 Graph **不是替代关系**：Loop 管辖"单个 Agent 内部怎么反复自检"，Graph 管辖"多个执行单元之间怎么拆、怎么并行、怎么汇合"。
- 从图论看：**一个循环就是一条指向自己的边**——Loop 是图的一个退化情形。
- 实际分工：写脚本、修 bug、做小调研 → 一个 Loop 串到底就够，强行上 Graph 编排"等于一个人一下午能干完的活，非要开个项目启动会"。

---

## 3. 可直接抄的工程模式清单（本报告的核心价值）

以下全部来自社区实操总结（[LangChain 三年踩坑 + Codez 路线图的中文整理](https://cloud.tencent.cn/developer/article/2715084)），逐条标注了对 fleet 的适用性。

### 3.1 边的真实性检验 ★ 最高性价比

> **问自己：下一步是否真的读取上一步的输出？如果不是，就没有边，等待就是浪费。**

大多数人写多步 Agent 的结果是一条直线 A→B→C→D，每步都在等上一步。但"总结文件，然后告诉我天气"里的天气根本不读总结——**那条连线是多余的**。

**对 fleet 的直接适用**：当前 `depends_on` 的语义是"全部 done 后才允许 assign"（设计文档 §5），这是**纯顺序依赖**，不区分"数据依赖"与"仅时序依赖"。按本条检验，相当一部分串行可以改成并行。

### 3.2 节点要有契约

- 明确的**输入、输出、单一职责**；
- 用 JSON Schema 强制子 Agent 返回结构化数据，**验证失败自动重试**，而不是收一堆自由文本。

**对 fleet 的适用**：`tasks/<id>/brief.md` 与 `result-<task-id>.md` 目前是 Markdown 自由文本（§4.6/§4.7），验收靠 Commander 人工逐条核对。**可增量引入**：在 `result` 之外加一个机器可读的 `result.json`（结论/完成度/引用/阻塞），让派单器能自动预检，把 Commander 的注意力留给真正的判断。

### 3.3 边按数据命名，而不是按顺序

> 命名边时应该用它的**数据类型**，而不是先后顺序。比如 `AlamofireReview` 而不是"第二步"。

好处：一眼看出边是否真实，且能随时替换节点而不破坏图。

### 3.4 三个关键结构

| 结构 | 形态 | 用途 |
|---|---|---|
| **并行（parallel）** | 一组独立任务同时跑，失败项解析为 `null`，不拉垮整批 | 独立子任务压总耗时 |
| **钻石（diamond）** | fan-out → reduce → synthesize | **"所有严肃 Agent 图的骨架"**：一个节点拆解、多个节点并行、一个节点合并 |
| **验证器节点（validator）** | 专门尝试**推翻**发现的"杀手"角色 | 对抗验证（多个怀疑者）/ 多视角验证 / 评委团打分整合 |

**对 fleet 的适用**：fleet 已有"交付与验收终态区分"（worker 交 done、Commander 验收后 accepted，§5），这**在概念上就是验证器节点**——但验证者与拆解者是同一个（都是 Commander），缺少对抗性。§6.4 第 6 条已经意识到相关问题："Agent 写的测试易与实现共用盲点……须独立运行验证"。

### 3.5 路由用代码，判断用模型

> 用条件节点（if/switch）根据结果决定走哪条路径。**判断可以用 LLM，但路由用代码保证确定性。**

### 3.6 循环直到收敛（未知规模任务）

- 持续生成发现，直到 K 轮没有新东西；
- **关键陷阱**：去重要基于"**所有见过的**"，不只是"确认的"，否则死循环。

### 3.7 多模型协作的三种图上模式 ★ 对"多模型"问题的直接回答

把"用多个模型"这件事翻译成图语汇，只有三种基本形态——**每一种在图上都是明确的结构，而不是"多挂几个模型"**：

| 模式 | 图形态 | 机制 | 主要收益 | 学术/工程对应物 |
|---|---|---|---|---|
| **① 分层路由** | 条件边 / 节点属性 | 按节点性质选模型：提取、分类、格式化用便宜模型；合成、裁断用强模型 | **成本** | LangChain/Codex 实践原文："不是所有节点都需要最强模型"；fleet §6.3 决策表第 2 条 |
| **② 并行聚合（MoA）** | fan-out → reduce | 多个模型并行作答，再由聚合器合成 | **单点能力不足时的多样性** | Mixture of Agents 一族：[RouteMoA](https://aclanthology.org/2026.acl-long.558/)（免预推理的动态路由）、[AdaMoA](https://ieeexplore.ieee.org/document/11661164)（任务自适应架构优化）、[TUMIX](https://proceedings.iclr.cc/paper_files/paper/2026/hash/5b755cf5598a4324d253025e1fbbba52-Abstract-Conference.html)（工具使用混合） |
| **③ 异构验证** | 验证器节点（旁挂） | 一个模型产出，另一个**不同厂商/不同模型**复核 | **消灭自证盲点** | §3.4 验证器节点；fleet §6.4 第 6 条"不得只信 worker 自测" |

> 上表 ② 的三篇论文仅据标题与摘要层面确认存在（网络抓取受限，未逐篇精读），模式归属为本文依据其题名与方法定位所作判断，**引用前建议复核原文**。

**关键判断（这才是"多模型协作"该怎么做）**：

- **① 已在 fleet 的路线上**（manifest 各配 `model` + `model_price`），只是依据是**人工决策表**而非图上可计算的代价——§5.4 的能力图能让它变成可求解的问题。
- **② 的成本是线性的**：N 个模型 = N 倍调用，再加一次聚合。Hermes 多 Agent 拆解给出的实测口径是"多 Agent 并行会把 API 调用量放大到单 Agent 的 **3–5 倍**，模型侧的稳定性和延迟成为瓶颈"（[来源](https://news.qiniu.com/archives/1785119159395)）。**适合验证型/高价值任务，不适合生产型批量任务。**
- **③ 是三者中性价比最高的**：只多一次调用，却直接消灭"自己给自己打分"的系统性盲点。**fleet 在这条上有独特条件**——本机 8 个 agent CLI 天然来自不同厂商、跑不同模型，做异构验证**零额外采购成本**，只差 wiring。这也正是 §3.4 验证器节点从"Commander 身兼拆解与验收"里独立出来的落点。
- **best-of-n 的定位**：它是 ② 的退化形式（同一模型采 N 次）。[RoBoN](https://arxiv.org/pdf/2512.05542v1) 把它扩展成"多模型 + 路由"的在线版本。对 fleet 而言其优先级低于 ②③，**因为它不引入模型多样性**——而多样性正是异构协作的唯一理由。

### 3.8 拓扑即成本与延迟

> **默认用 `pipeline()` 而不是 `parallel()`。** pipeline 让每个 item 独立流经所有阶段、**没有屏障**，快的提前完成；parallel 的屏障会让所有东西等待最慢的节点。

### 3.9 LangGraph 三年踩过的三个坑

| 坑 | 内容 | 对 fleet 的含义 |
|---|---|---|
| **Agent 图通常不是 DAG** | 生产环境需要循环：重试失败的工具调用、向用户追问、验证后修正、反复调工具直到上下文足够、暂停等人工介入再恢复 | fleet 的 `reopen` 流程本质就是环（§5 状态机里 done→queued）——**这是优点，不是需要消除的东西** |
| Loop 就是简单的图 | 循环 = 有向有环图；LangChain 框架本身构建在 LangGraph 之上 | 与 §2.3 一致 |
| **动态转换很重要** | 不一定想前期定义每条边；有时节点在**运行时**才知道要创建多少工作。Map-reduce 是典型案例：把输入拆成 N 份，N 取决于输入，无法提前知道。LangGraph 用 `Send` 在运行时动态路由 | **直接对应 fleet 的痛点**：任务扇出数量由 Commander 在执行中判断，`tasks.jsonl` 目前是"一任务一记录"的平铺结构，没有"父子任务树"的表达 |

### 3.10 什么时候**不该**用图 ★ 必读反证

> **判断标准：如果你的任务路径可以提前画出来，用图。如果路径本身需要探索，用 Agent Harness。**

证据：LangChain 早期用预定义的 LangGraph 工作流做深度研究，**后来转向了更 Agentic 的核心循环**；GPT Researcher 做了同样的迁移——把图状的多 Agent 管线换成 Deep Agents，让规划、委派、上下文管理在 Harness 中自然涌现，而不是硬编码在图里。

**对本仓的含义**：这条反证**不支持**"把 fleet 整个改造成一张大图"。fleet 的定位恰恰是"路径可预画的工程类任务编排"（派单 → 执行 → 交付 → 验收），适合用图；但**不应该试图把"什么时候派什么任务"这类开放式判断也编码进图**——那部分留给 Commander 的 Agentic 判断。**图负责结构，Agent 负责探索。**

---

## 4. 生态全景（选型参考）

### 4.1 开源框架（综述作者归类为 "Graph Engineering" 组）

[LangGraph](https://github.com/langchain-ai/langgraph)、[Microsoft Agent Framework](https://github.com/microsoft/agent-framework)、[Google ADK](https://github.com/google/adk-python)、[AutoGen/GraphFlow](https://github.com/microsoft/autogen)、[AG2](https://github.com/ag2ai/ag2)、[CrewAI](https://github.com/crewAIInc/crewAI)、[CAMEL](https://github.com/camel-ai/camel)、[Mastra](https://github.com/mastra-ai/mastra)、[GPTSwarm](https://github.com/metauto-ai/GPTSwarm)、[MASFactory](https://github.com/BUPT-GAMMA/MASFactory)；另有 2026 年的新候选 [Apache Burr](https://github.com/apache/burr)、[JetBrains Koog](https://github.com/JetBrains/koog)、[Rivet](https://github.com/rivet-gg/rivet)、[Temporal](https://docs.temporal.io/ai-cookbook/openai-agents-sdk-python)。

### 4.1b 横向对比与对 fleet 的关键结论 ★

2026-09-10 逐家核对官方文档 / GitHub / PyPI 后的对比（**本表是"不上框架"决策的支撑证据**）：

| 框架 | 图抽象 | 声明式 | 状态模型 | 回滚/回放 | 异构模型 | 恢复粒度 | 就绪度 |
|---|---|---|---|---|---|---|---|
| LangGraph | StateGraph + channel/reducer，**Pregel 超步** | 否（代码式） | 每超步快照（channel 值+版本） | 时间旅行 + fork | 天然 | 节点/超步 | 1.0 GA，月下载 6500 万+ |
| MS Agent Framework | Executor + 5 种 Edge，超步模型 | 部分（workflow JSON） | 超步 checkpoint（含 pending 消息/请求） | 任意 checkpoint 恢复，整 run 可 replay | 是（各持 client） | 超步 | 1.17.0（2026-09-03），Production/Stable |
| **AG2** | `ag2.network` 声明式 `TransitionGraph`；**classic GraphFlow 已归档** | **是**（JSON 往返） | **WAL + fold 重放（事件溯源）** | 按 channel 回放 WAL | 是（10+ provider） | channel 级 | 1.0.4；**AutoGen 本体已进维护模式** |
| CrewAI | 装饰器推导的**隐式**事件图 | 否 | `@persist` → SQLite 快照 | **resume + fork 双语义最干净** | 是（每 Agent 独立 LLM） | 方法级 | 1.15.21（2026-09-09），58.3k★ |
| Google ADK | **2.0 才真正图原生**：`Workflow(edges=[…])` + route/join | 否（代码式） | Session events + state 三档后端 | Rewind（非原子）+ Resume | 是（LiteLLM 100+） | invocation 级 | Python v2.8.0，三语言 GA |
| GPTSwarm | operation 节点 + 可优化边 | 否 | **无** | 无 | 是（学术） | 无 | v0.1.0，**停滞 7 个月** |
| MASFactory | 有向计算图 + Vibe Graphing 编译 | **是**（NL→规格→图） | **无持久化** | 无 | 是（3 家适配器） | 无 | 1.0.2，ACL Demo 定位 |
| Burr / Koog / Rivet | 状态机图 / graph workflows / durable actor | 部分 | 可插拔 persister / 可恢复状态 | Burr 时间旅行 | Koog 是 | 执行点级 | 2.5k–6.1k★，活跃 |

**结论一：fleet 缺的不是图抽象，而是四样机制。**

fleet 已经具备图编排最贵的三样东西——**持久事件日志、单一写者（天然无数据竞争）、可物化状态**。逐家对比后，真正该补的是：

| # | 缺的机制 | 最接近的先例 |
|---|---|---|
| 1 | **fold 纯函数化**（`state = reduce(fold, 事件流)`） | AG2 `ChannelAdapter.fold` + `Hub.hydrate()` 重放 WAL |
| 2 | **超步提交语义**（收集 → 确定性排序 → 合并 → 提交 → 版本号） | LangGraph Pregel/BSP、MS AF superstep |
| 3 | **checkpoint 与 interrupt 分层** | LangGraph `interrupt()`、MS AF `CheckpointStorage`/`RequestPort`、ADK `NodeInterruptedError` |
| 4 | **动态边与类型化边契约** | LangGraph `Send`、ADK `Event(route=…)` + `input_schema`/`output_schema` |

> 补上这四样，fleet 的协调层就等价于**一个自研的、面向异构 CLI 的 Pregel runtime**——且它是文件持久化的，**比任何进程内先例都更耐崩溃**。

**结论二：三条不值得吸收的**——CrewAI 隐式事件图（与显式总线重叠，更难调试）、GPTSwarm 边优化（停滞 + 无持久化 + CLI 成本模型下收益不明）、MASFactory Vibe Graphing（上游无 checkpoint/resume，**适合做独立的上游 builder**：把自然语言需求编译成 fleet 的图规格 JSON）。

**结论三：一条通用工程约束**——MS Agent Framework 实测踩坑：**重建工作流必须复用相同 executor id，否则 resume 直接失败**。→ 图的节点身份必须是**稳定逻辑 ID**，绝不能是 PID / 会话 ID。

### 4.1c 与 fleet 的关系

fleet 的协调层是**文件总线**（进程独立、可崩溃重启、人类可审计），上述框架都是**进程内库**。**不建议替换总线**——综述本身把"文件/事件总线式协调"与"框架内图调度"视为不同 tradeoff 点，fleet 现有选择（可审计、可人类干预）是其差异化价值（设计文档 §1）。

一个旁证：Temporal 本身**不是图框架**，而是为 agent 提供 journal + replay 的 **durable execution 底座**，并已有官方 OpenAI Agents SDK 集成——它代表的判断是"**图抽象可以自己写，持久化底座别自己写**"。而 fleet 的持久化底座**已经是文件总线**，正好落在"自己写图抽象、复用已有底座"这一侧。

### 4.2 与运行时状态管理强相关的论文（对 fleet 最有价值的一批）

综述的 State Management 分节收录了大量与"文件总线 + JSONL 事件流"直接对话的工作：

| 论文 | 关键机制 | 对 fleet 的潜在用途 |
|---|---|---|
| [MAST — Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)（NeurIPS 2025 D&B） | **3 大类 14 种**失败模式（FC1 规格与系统设计 / FC2 智能体间错位 / FC3 验证与终止），标注一致性 κ≈0.88；**高频四种：错误验证、步骤重复、违反任务规格、验证缺失** | 把 §10 手写的"故障与恢复"表换成有依据的分类法；**且高频四项全部可用结构化手段拦截**，不必等模型判断 |
| [Which Agent Causes Task Failures and When?](https://arxiv.org/abs/2505.00212)（ICML 2025） | 归因形式化为"责任 Agent 级 + 关键错误步级"两个任务；**当时最好方法也仅约 53.5% / 14.2% 准确率** | **反面证据，价值极高**：让 LLM 读全文猜责任方在步级上≈随机。归因必须**降维成证据链回溯**，而非自建 LLM 归因器 |
| [CausalFlow: Causal Attribution and Counterfactual Repair](https://arxiv.org/abs/2605.25338) | 因果图 + 反事实最小干预修复；"多数失败是局部而非系统性" | 迁移需减配：**只要保证每 step 输入可复现，就能支持"从第 k 步重放"，覆盖约 80% 价值** |
| [PatchBoard: Schema-Grounded State Mutation](https://arxiv.org/abs/2605.29313) | Agent **不直接写状态**，提交受 schema 约束的补丁（变更点+值+作者+理由），单点 applier 校验后原子应用并留审计 | ✅ **极适合文件总线**：一次消灭格式写坏、并发覆盖、变更不可追溯三类故障——且比"放宽单一写者"更符合 fleet 原则 |
| [The Log is the Agent: Event-Sourced Reactive Graphs](https://arxiv.org/abs/2605.21997) | 追加式事件日志即**唯一真相**，状态 = `fold(日志)` 的派生态；天然支持逻辑分叉、情景重放、信息溯源 | ✅✅ **fleet 最该抄的一篇**：现在 `tasks`/`ledger`/`events`/`status` 四份文件**互为影子真相**，正是它要治的病 |
| [AgentGit](https://arxiv.org/abs/2511.00628) | 提交 DAG + 分支 + checkout/回滚 + 从检查点续跑 | ⚠️ 全量 Git 语义**过重**，只抄"单写者日志 + 命名检查点" |
| [MemTX: Transactional Belief Commit](https://arxiv.org/abs/2607.23929) | 记忆写入做成事务+提交协议，冲突则中止重读（而非最后写者覆盖） | ✅ 轻量版 = 事件带 `expected_version` 的**乐观并发 CAS** |
| [Concurrency Anomaly Prevention in Multi-Agent LLM Systems](https://arxiv.org/abs/2606.17182) | 形式化检测数据库式异常（丢失更新/脏读/写偏斜）并协议预防 | ⚠️ 不必抄形式化验证，但"**共享状态必须显式定义所有权与写序**"这条纪律必抄——印证 fleet"单一写者"的正确性 |
| [DynTaskMAS](https://scholar.google.com/scholar?q=Dyntaskmas)（ICAPS 2025） | DAG + 动态任务图生成 + 异步并行调度 | ✅ 只抄"**就绪集（ready set）**"抽象：worker 认领依据是**依赖满足**，而非轮次同步 |
| [From Agent Loops to Structured Graphs: A Scheduler-Theoretic Framework](https://arxiv.org/abs/2604.11378) | 把执行系统统一刻画为「状态 + 就绪集 + 调度策略 + 步进关系」 | 观念收益大：**很多"图"能力本质只是调度策略**，文件总线不需要上引擎 |
| [Sovereign Agentic Loops: Decoupling AI Reasoning from Execution](https://arxiv.org/abs/2604.22136) | 推理侧只管决策与意图，执行侧独立承担持久化/重试/幂等，两侧以显式契约交互 | ✅ 与 fleet 现有"Commander 决策 / worker 执行"分工同构，只需把契约显式化 |
| [Swarm Skills](https://arxiv.org/abs/2605.10052) | 把协调知识（角色/拓扑/协议/失败补救）打包为可移植、可版本化的规范单元并从经验自演化 | ✅ 自演化最小可行版 = **MAST 标签失败统计 → 人工确认 → 写成新版 handoff 规则** |

### 4.3 多模型聚合（MoA 族，补充）

> 综述本身把 MoA 归在 Agent Coordination 而非"多模型"条目下，但对本仓的"多模型"诉求而言这批工作是直接对应的，单列于此（详见 §3.7 的三种模式）：

- [RouteMoA: Dynamic Routing without Pre-Inference Boosts Efficient Mixture-of-Agents](https://aclanthology.org/2026.acl-long.558/)（ACL 2026）—— 免预推理的动态路由，降低 MoA 的固定开销
- [AdaMoA: Enhancing Mixture-of-Agents via Task-Adaptive Architecture Optimization](https://ieeexplore.ieee.org/document/11661164)（IEEE）—— 按任务自适应地决定聚合架构
- [TUMIX: Multi-Agent Test-Time Scaling with Tool-Use Mixture](https://proceedings.iclr.cc/paper_files/paper/2026/hash/5b755cf5598a4324d253025e1fbbba52-Abstract-Conference.html)（ICLR 2026）—— 把混合扩展到工具使用维度
- [RoBoN: Routed Online Best-of-n for Test-Time Scaling with Multiple LLMs](https://arxiv.org/pdf/2512.05542v1) —— 多模型在线 best-of-n

> 这一族共同的方法论是：**先固定"多模型 + 聚合"这一结构，再优化"选哪些模型、怎么聚合"**——正好对应 §5.4 能力图要解决的问题。调研时网络抓取受限，上述仅据检索结果的标题与定位收录，**未逐篇精读**。

### 4.4 反证类工作（提醒"多 Agent 不一定更好"）

- [Multi-Agent Teams Hold Experts Back](https://arxiv.org/abs/2602.01011)（ICML 2026）—— **团队表现低于队内最强专家**（`Team/Expert < 1`）：沟通趋同让专家放弃自身判断，**规模本身不带来增益**
- [Drop the Hierarchy and Roles: How Self-Organizing LLM Agents Outperform Designed Structures](https://arxiv.org/abs/2603.28990) —— **自组织、无预设层级与角色的 Agent 反而优于精心设计的结构**
- [Multi-agent design: Optimizing agents with better prompts and topologies](https://arxiv.org/abs/2502.02533) —— **提示/契约优化的收益大于拓扑优化**，优化后的单 Agent 可胜过手搭的多 Agent 系统
- [Information Propagation Effects of Communication Topologies](https://aclanthology.org/2025.emnlp-main.623/) —— 通信拓扑的信息传播效应

**这四条合起来给出三条硬约束**（已写入搭建方案 §0/§7）：

1. **只为"独立验证"而增加 agent，绝不为"凑能力"增加**——多样性只在与产出者可独立判断时才有价值；
2. **禁止多数表决覆盖高置信专家**——若一个专家给出高置信判断，多数投票是净损失；
3. **先修契约，再改拓扑**——fleet 的第一杠杆是任务卡与 handoff 契约（`result.json`），不是更复杂的图。

> 这与 fleet 已有的实测证据方向一致——设计文档 §6.3 记载"工具面配置是第一杠杆……收益可能大于换什么模型"。**多 Agent 的收益不是免费的，拓扑选择与角色设计本身会引入损耗。**

### 4.5 评测基准（System Intelligence 组）

TaskBench、WorFBench、FlowBench、MultiAgentBench、MAST、AgentsNet、TAMAS、MASEval、MAS-Bench 等（完整清单见 [Awesome 仓库](https://github.com/DEEP-JLU/Awesome-Graph-Engineering)）。

> 其中 **MAST** 与 **MultiAgentBench** 与 fleet 的"多 CLI 混合跑一个完整多任务项目"（M6 验收标准）最贴合，若日后要做定量评估可优先看这两个。

---

## 5. 对本仓的对照分析

### 5.1 fleet 现状的图论刻画

用综述的词汇重新描述 fleet（**这不是引入新概念，只是换一套坐标系看已有设计**）：

| GE 概念 | fleet 现状 | 对应位置 |
|---|---|---|
| 任务图 | `tasks.jsonl` 平铺记录 + `depends_on` 线性前置 | §4.5、§5 |
| 节点 = 完整 Agent | ✅ **worker = 本机 agent CLI**（已满足"节点里装完整 Agent"的前提） | §12 v0.11 主路线 |
| 能力图 | `manifest.skills` 扁平标签数组 + `model` / `model_price` 字段 | §4.1 |
| 团队图 | **星型**：Commander 为唯一 hub，worker 互不可见 | §2 架构总览 |
| 通信图 | **禁止直接通信**，一切经 `collective-memory.md` 由 Commander 策展 | §6.6、§1.5 |
| 状态图 | JSONL 追加日志 + "当前状态 = 重放最后一条" | §4.5 |
| 状态记录 | `tasks.jsonl` / `ledger.jsonl` / `events.jsonl` / `status.json` / `usage.jsonl` | §3、§4 |
| 故障定位 | §10 手写场景表（检测→处置），无因果归因 | §10 |
| 失败恢复 | 重启包 + reopen + reassign | §10、§6.5 |
| 系统演化 | **完全人工**：改设计文档 + 改 manifest | §13 |

### 5.2 差距清单（按"价值/成本"排序）

| # | 差距 | 现状 | 价值 | 成本 | 建议 |
|---|---|---|---|---|---|
| 1 | **任务图不是图** | `depends_on` 只做"全部 done 才 assign"的线性检查；无父子任务树，无 fan-out/fan-in | 高（直接决定并行度与总耗时） | 低（只动数据结构与 Commander 逻辑，不动协议主干） | **先做** |
| 2 | **能力不是图** | `skills` 是扁平字符串数组；匹配靠布尔交集打分 | 高（多模型选型、缺能力替代、成本优化全依赖它） | 中 | **先做**（至少补"能力→agent→模型→成本"的显式映射） |
| 3 | 边的真实性未检验 | 顺序派单默认串行 | 中 | 低 | 随 #1 一起做 |
| 4 | 失败归因靠人 | §10 是静态场景表 | 中高（但需要真实失败样本才有意义） | 中高 | **缓做**，先积累 `t-xxxx` 失败样本 |
| 5 | 无回放/分叉/回滚 | 日志是追加式，但只能"重放最后一条" | 中（对"结构演化"是前置条件） | 中 | 缓做 |
| 6 | 通信图过于极端 | "worker 互相不可见"是**有意的强约束** | — | — | **不动**：这是 fleet 的核心安全/可审计设计，综述也强调"更多连接不等于更好协作" |
| 7 | `result` 无机器可读契约 | 自由文本 Markdown | 中（验收自动化） | 低 | 可做 |

### 5.3 实证核查：两个字段的真相（2026-09-10 实测）

在写建议之前先核了一遍 `state/` 的实际内容，结论影响后续判断：

| 核查项 | 结果 | 含义 |
|---|---|---|
| `tasks.jsonl` 中的 `depends_on` | 33 行台账中该字段出现 9 次，**没有任何一行携带非空依赖** | 该字段**自设计以来从未被真正使用**。§5 的依赖规则至今未经受检验；同时说明 t-0001~t-0008 恰好都是可独立的任务，"线性串行的代价"尚未显现 |
| `events.jsonl` 的事件 | 22 类事件**全部是人工里程碑记录**（`m1_kickoff` / `m2_panel_deployed` / `cli_calibration_batch` / `dsh_upgrade_rc7` …） | fleet 的"事件溯源"目前是**文档性的**，不是机器生成的可重放状态源。与 §4.2 表格里 [The Log is the Agent](https://arxiv.org/abs/2605.21997) 意义上的"事件即系统"尚有距离 |

**这两条修正了建议的措辞**：阶段 1 不是"升级已有功能"，而是**让一个已声明但从未启用的字段真正生效**；而"事件流"这一块，fleet 实际上连机器事件都还没有——**在谈回放/分叉/结构演化（阶段 3/4）之前，得先有人写事件**。

### 5.4 `depends_on` 升级为任务图：具体到字段

> 完整设计（就绪度算法、动态扇出、`result.json` 契约、schema 校验）已落在 [graph-engineering-fleet-design.md](graph-engineering-fleet-design.md) §3，此处仅保留分析结论。

当前（§4.5）：

```json
{"op":"create","task":{"id":"t-0012","depends_on":[]}}
```

规则（§5）："`depends_on` 中的任务全部 `done` 后，Commander 才允许 assign。"

按 §3.1 的"边真实性检验"，这条规则把**两种完全不同的关系混为一谈**：

- **数据依赖**：下游真的读取上游的输出 → 必须等
- **仅时序依赖**：只是习惯上排先后 → **不该等，应并行**

**建议的最小改动**（不改协议主干）：

```json
{
  "id": "t-0012",
  "depends_on": ["t-0010"],                    // 保留：向后兼容，语义=数据依赖
  "graph": {
    "kind": "fan-in",                          // task | fan-out | fan-in | reduce | verify
    "parent": "t-0009",                        // 所属扇出组（钻石图的上游）
    "consumes": ["t-0010/result.json"],         // 显式声明"读谁的输出"（边的数据类型）
    "produces": "result.json"
  }
}
```

- `graph.kind` 让"钻石结构"（fan-out → reduce → synthesize）成为一等公民；
- `consumes` 让"边的真实性"可**机械校验**（声明了数据依赖却读不到文件 → 校验期就报错）；
- 与现有 F1 总线校验（`schemas/*.schema.json` + `validate-bus.mjs`）天然衔接——加一个 `graph` 子 schema 即可。

### 5.5 能力图：具体到字段

> 完整设计（边类型清单、confidence 回填公式、选型算法替换）已落在 [graph-engineering-fleet-design.md](graph-engineering-fleet-design.md) §4，此处仅保留分析结论。

当前（§4.1）：`skills: ["web-research", "summarize", "zh-report"]` —— 只回答"会什么"。

综述 §1.3② 要求能力边至少记录：**能力归属、资源访问、权限、可靠性**。建议增量：

```json
{
  "skills": ["web-research", "summarize"],
  "capability_graph": {
    "models": [{ "id": "deepseek-v4-flash", "modalities": ["text"], "ctx": 128000 }],
    "edges": [
      { "type": "provides", "target": "web-research", "confidence": 0.9, "evidence": ["t-0003","t-0007"] },
      { "type": "requires", "target": "network", "scope": "https" },
      { "type": "substitutable_by", "target": "opencode", "quality_delta": -0.1 },
      { "type": "cost", "usd_per_1k_input": 0.0008 }
    ]
  }
}
```

要点：
- `provides.confidence` + `evidence` —— 从 `tasks.jsonl` 的验收结果**自动回填**，这就是综述说的"执行结果还应更新能力的可靠性与适用范围"；
- `substitutable_by` —— 直接解决 §6.2④ "fleet 内无匹配 → 任务暂存"的痛点：暂存前先问"有没有可替代的 agent"；
- `modalities` —— 与 `dual-model` 线的图片能力判定**共享同一个真值源概念**（该线设计文档 §4.4 已经提出 `inputModalities` 作为权威源）。

### 5.6 与 `dual-model` 线的交叉

`dsh-miasaki-dual-model` 解决的是"**同一会话内**主模型 + 辅助模型的路由"，本报告 §3.7 的"模型分层"是它在图层面的同构物：

| dual-model 线 | 本报告的图视角 |
|---|---|
| 主模型 / 辅助模型（会话内） | 节点级模型选择（图内） |
| `agent/request` waterfall 逐步换模型 | 节点契约的一部分（每个节点声明它需要什么能力） |
| 能力真值源 `llm.resolveModelInfo` | 能力图的一个数据源 |
| `stickWithinTurn`（同 turn 粘住） | 对应 §3.8 "拓扑即成本"——避免反复切换破坏前缀缓存 |

**结论**：两条线共享同一个抽象——**"能力"必须被显式表示，路由必须可确定性地重放**。dual-model 线已经把 `inputModalities` 作为权威真值源，fleet 的能力图可直接复用这个口径。

---

## 6. 落地建议（分阶段，均非承诺）

> **本节的分期已被 [graph-engineering-fleet-design.md](graph-engineering-fleet-design.md) §8 取代并细化**（G0 契约与事件流 → G1 任务图 → G2 能力图 → G4 验证器 → G3 失败归因）。此处保留原始分析顺序，供对照"为什么优先级这样排"。

> **本节的分期已被 [graph-engineering-fleet-design.md](graph-engineering-fleet-design.md) §8 取代并细化**（G0 契约与事件流 → G1 任务图 → G2 能力图 → G4 验证器 → G3 失败归因）。此处保留原始分析顺序，供对照"为什么优先级这样排"。

### 阶段 0：先做判定，不写代码（本轮调研的直接产出）

1. **确认 fleet 的定位属于"路径可预画"一侧**——若是，图编排适用；若 fleet 未来要承担开放式研究类任务，则该部分应留在 Commander 的 Agentic 判断里，**不进图**（§3.10）。
2. **只吸收机制，不引入框架**：fleet 的文件总线是差异化资产，不建议换成 LangGraph 之类的进程内库。

### 阶段 1：任务图显式化（低成本、高确定性）

- `tasks.jsonl` 的 task 对象加 `graph` 字段（§5.3）；
- `depends_on` 拆分为"数据依赖（须等）"与"时序偏好（可并行）"；
- `schemas/tasks.schema.json` 同步扩字段，纳入 `validate-bus.mjs`；
- Commander 派单逻辑：从"按 depends_on 串行"改为"按图就绪度调度"（就绪 = 所有数据依赖满足）；
- **验收**：一个真实 3 路 fan-out → reduce 的任务组跑通，且中间产物可核对。

### 阶段 2：能力图（多模型选型的基础设施）

- `manifest` 增 `capability_graph`（§5.4）；
- `provides.confidence` 从 `tasks.jsonl` 验收结果自动回填（复用现有的 F2 计量聚合路径）；
- 派单决策表（§6.3）从"启发式打分"升级为"在能力图上求解"；
- **验收**：故意关闭某个 agent，`substitutable_by` 能自动给出替代者，而不是走 §6.2④ 的暂存流程。

### 阶段 3：验证器与失败归因（需要真实失败样本）

- 引入**独立验证者**：不再由 Commander 身兼拆解者与验收者；小任务可用"另一个 agent CLI"充当对抗验证者（fleet 已具备条件：8 个 CLI 里可挑不同模型）；
- 从 `transcript.md` + `events.jsonl` 自动产出**失败归因报告**（先抄 [MAST](https://arxiv.org/abs/2503.13657) 的分类法，再谈自动化）；
- **前置条件**：积累足够的失败样本（当前 `t-0001`~`t-0008` 只有一条真实 blocked→reopen 案例，样本不足）。

### 阶段 4：结构演化（长期，需要版本化基础设施）

- 综述明确警告：**运行时适应 ≠ 持久化系统演化**；
- 任何"从执行历史改图"的动作，都必须配套**来源记录、版本控制、验证、回放、回滚**（[AgentGit](https://arxiv.org/abs/2511.00628) 可参考）；
- **不建议现在做**——没有足够执行历史时，自演化是凭空设计。

---

## 7. 风险与边界

| 风险 | 说明 | 处置 |
|---|---|---|
| **名词驱动开发** | "Graph Engineering" 一个月一个新词，追名词会持续返工 | 只吸收机制（§3），不追名词；本报告的 §3.1 边真实性检验与 §3.10 何时不该用图，是本次调研最有长期价值的两条 |
| **过度设计** | 社区共识：大部分任务一个 Loop 就够，强上 Graph = "一个人一下午的活开项目启动会" | 阶段 1 只做"任务图显式化"这一件最小的事，不引入调度器 |
| **多 Agent 负收益** | [Multi-agent teams hold experts back](https://arxiv.org/abs/2602.01011) 等反证 | 保持 §6.3 的实测纪律；把每次多 Agent 的收益/成本落账（fleet 已有 `ledger.jsonl`，条件优于多数框架） |
| **图越大越脆** | 综述："更多连接不等于更好协作，冗余通信会增加成本或放大错误" | fleet 的"worker 互不可见"是**有意为之的强约束**，不因图工程而放松 |
| **学术框架过度套用** | 综述是框架性综述，其三层划分是**组织视角**，不是实现规范 | 本报告 §5 只做"用它的词描述我们已有的东西"，不照搬其术语体系 |

---

## 8. 参考来源

**一手文献**

- 综述：[Graph Engineering in the Era of LLM Agents: From Individual Intelligence to System Intelligence](https://arxiv.org/abs/2608.21156)（arXiv:2608.21156，吉林大学 DEEP-JLU / 厦门大学等 15 家机构）
- 作者配套资源库：[DEEP-JLU/Awesome-Graph-Engineering](https://github.com/DEEP-JLU/Awesome-Graph-Engineering)（论文分类清单、benchmark、开源库；本报告 §4 大量依赖该清单）

**中文解读**

- [AI Agent 的下一站：Graph Engineering｜一文读懂](https://www.163.com/dy/article/L56UO4DT0511PEBT.html)（中国人工智能学会 / 学术头条，2026-08-25；三层框架的中文权威转述）
- [图工程（Graph Engineering）来了？LangChain 说不是新东西](https://cloud.tencent.cn/developer/article/2715084)（2026-07-24；**§3 工程模式的来源**）
- [Loop Engineering 已死？Graph Engineering 是什么？我好像在哪里见过](https://developer.aliyun.com/article/1750976)（2026-07-25；后端工作流引擎视角、场景选型清单）
- [Hermes 多 Agent 完整拆解：五种协作机制、选型边界与踩坑清单](https://news.qiniu.com/archives/1785119159395)（2026-07-27；**跨进程编排的工程实现对照**：Kanban 六条可靠性不变量、heartbeat+TTL、僵尸检测、exit-without-complete 自动 block、幻觉闸门）

**官方立场**

- [3 Years of Graph Engineering with LangGraph](https://www.langchain.com/blog/3-years-of-graph-engineering-with-langgraph)（LangChain，2026-07）

**本仓关联文档**

- `docs/multi-agent-cli-orchestrator-design.md` v0.16（fleet 协议唯一依据）
- `../dsh-miasaki-dual-model/design/2026-09-10-dual-model-design.md`（会话内多模型路由）

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-10 | 初稿：概念谱系与时间线、综述三层框架、行为之争（LangChain/后端视角）、10 条可抄工程模式、生态全景（框架/状态管理论文/反证/benchmark）、本仓对照分析、分期落地建议、风险边界 |
| 2026-09-10 | 落点澄清与取证补强：明确**唯一落点为 fleet**（用户澄清），产出转交 [graph-engineering-fleet-design.md](graph-engineering-fleet-design.md)；补入 MAST（3 类 14 种，κ≈0.88）与 Who&When（步级仅 14.2%）的**具体数据**、PatchBoard 的补丁机制、The Log is the Agent 的事件溯源内核；反证四条补入 `Team/Expert < 1` 与"提示优化 > 拓扑优化"；新增取证限制声明 |
| 2026-09-10 | 新增 §4.1b 框架横向对比（八家框架 + 2026 新候选逐家核对官方文档/PyPI）：给出三条结论——**① fleet 缺的不是图抽象而是四样机制**（fold 纯函数化 / 超步提交语义 / checkpoint 与 interrupt 分层 / 动态边与边契约）；② 三条不值得吸收（CrewAI 隐式图 / GPTSwarm 边优化 / MASFactory Vibe Graphing）；③ 节点身份必须稳定逻辑 ID；另补 §4.1c 与 Temporal"持久化底座别自己写"的旁证 |
