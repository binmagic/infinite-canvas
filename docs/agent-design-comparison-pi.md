# Infinite Canvas Agent 与 Pi（earendil-works/pi）、Mastra（mastra-ai/mastra）设计对比

> 说明：本文档中 Infinite Canvas 部分的结论来自对仓库源码的实际阅读（见 `docs/agent-system-design.md`）；Pi 部分的结论来自对其 GitHub 仓库 README（根目录、`packages/protocol`、`packages/agent`、`packages/server`、`packages/coding-agent`、`packages/coding-agent/docs/containerization.md`、`packages/coding-agent/docs/rpc.md`）的公开文档阅读；Mastra 部分的结论来自其 GitHub 仓库 README 以及官方文档站 `mastra.ai/docs` 的 Agents、Tools/MCP、Workflows（含 Suspend and Resume）、Memory、Deployment 几个页面。**Pi 和 Mastra 都没有读取具体实现源码**，涉及内部实现细节的判断以公开文档描述为准，可能与实际代码有出入，文中会标注哪些点是文档未覆盖、无法验证的。

## 1. 三个项目的定位不是同一类东西

这一点需要先说清楚，否则后面的对比会显得不公平：

- **Infinite Canvas Agent** 是"为一个具体产品（无限画布网页）定制的本地桥接服务"。它不是通用 Agent 框架，`canvas-agent/` 里几乎所有代码都在做同一件事：把 Codex/Claude 的工具调用翻译成"画布该怎么变"，再用 SSE 推给一个特定的 React 前端。它的价值边界很窄，但很深——从 Skill 草稿的敏感信息过滤到断线重放缓存，都是围着"这一个画布网页"精雕细琢的。
- **Pi** 是一个通用的、厂商无关的 Agent 工具包（monorepo），目标是给任何人搭建自己的 coding agent /终端 UI /服务，`pi-agent-core` 提供的是可复用的 agent loop 和工具调用框架，`pi-coding-agent` 只是官方给出的一个参考实现（交互式终端编码 agent），`pi-server`/`pi-protocol`/`chord` 则是更底层的、可插拔的会话路由和服务组合基础设施。它的价值边界很宽，但每一层都比较薄——刻意"不做"很多事（无内置权限系统、无 MCP、无内置审批 UI），把决定权交给使用者。
- **Mastra** 是一个面向生产环境的 TypeScript AI 应用框架（"a framework for building AI-powered applications and agents with a modern TypeScript stack"），定位介于 Pi 和传统后端框架之间：它同样是通用的、Provider 无关的（`mastra.ai` 号称"Connect to 40+ providers through one standard interface"），但比 Pi 多做了很多"企业级后端框架该有的东西"——内置的 Workflow 引擎（含结构化 suspend/resume）、内置的 Memory 系统（thread/resource、working memory、semantic recall，依赖持久化存储和向量库）、内置的 MCP client **和** server 支持、内置的可视化调试环境（Mastra Studio）、以及针对 Vercel/Netlify/Cloudflare 的部署器。代价是它的核心框架之外还有一个 `ee/`（Enterprise）目录，生产环境使用需要商业授权，这是三者里唯一带双许可结构的。

三者的关系可以概括成一句话：Infinite Canvas Agent 是"薄桥接层 + 深场景打磨"，Pi 是"薄运行时 + 宽泛的组合自由度，权限完全下放"，Mastra 是"厚运行时 + 内置的生产级基础设施（持久化、审批、可观测性），用双许可换商业化"。下面的对比会在这个前提下进行。

## 2. 架构总览对比

| 维度 | Infinite Canvas Agent | Pi | Mastra |
|---|---|---|---|
| 定位 | 单一产品的本地桥接进程 | 通用 Agent 工具包 / monorepo | 通用 TypeScript AI 应用框架（含企业版） |
| 进程形态 | 常驻本地 HTTP 服务（Express），监听 `127.0.0.1:17371` | 交互式 CLI 进程；另有 `--mode rpc` 的 stdin/stdout 子进程模式；还有实验性的 `pi-server`（Unix domain socket） | 可嵌入 React/Next.js/Node 应用内运行，也可 `mastra build` 后作为独立 HTTP server（基于 Hono）部署到任意 VM/容器/PaaS |
| 与前端的连接方式 | SSE（`GET /events`）+ REST（结果回传、状态查询） | 默认是同进程内的终端 UI（`pi-tui`）；跨进程集成走 stdin/stdout 的 LF-delimited JSONL；`pi-server` 走 Unix socket + 自定义 CBOR 二进制帧协议（`pi-protocol`），非 HTTP/SSE/WebSocket | Hono server 对外提供接口（文档未给出具体路由/协议细节）；独立部署的理由之一被明确列为"需要 WebSocket 连接"，暗示支持长连接场景；另有 Mastra Studio 作为托管的可视化调试环境 |
| 底层模型执行者 | 外部 CLI 子进程：`codex app-server --stdio`（JSON-RPC）、`claude -p --output-format stream-json` | `pi-ai` 直连各家 LLM Provider API（OpenAI/Anthropic/Google 等），不依赖外部 CLI 子进程 | 内置多 Provider 抽象层，`model` 直接写成 `"provider/model"` 字符串（如 `openai/gpt-5.6-sol`），号称支持 40+ Provider，同样不依赖外部 CLI 子进程 |
| 工具调用协议 | MCP（`@modelcontextprotocol/sdk`），工具入参用 zod 描述，工具名固定的 29 个 | 自定义 `AgentTool` 接口（typebox 描述参数），无 MCP（官方立场是"No MCP"） | 双向支持 MCP：`createTool()` 定义原生工具（zod 描述 `inputSchema`），同时提供 `MCPClient` 消费外部 MCP server、`MCPServer` 把自己的 agent/tool/workflow/prompt/resource 反向暴露成 MCP server（stdio 或 HTTP transport） |
| 审批/确认机制 | 两层：Codex 沙箱原生审批（`codex_approval` accept/acceptForSession/decline）+ 画布写操作可选二次确认（`confirmTools`，默认关闭） | 无内置权限/确认系统；官方立场"No permission popups"，确认逻辑要靠扩展自己实现（`extension_ui_request` 的 `confirm`/`select` 对话框），默认权限边界靠容器/VM/沙箱环境（Gondolin、Docker、OpenShell、`sbx`）划定 | 两处内置机制：① MCPClient 层的 `requireToolApproval`（布尔或按工具名过滤的回调，如 `toolName.startsWith('delete_')`）；② Workflow 层结构化的 `suspend()`/`resume()`，配合 `suspendSchema`/`resumeSchema` 做类型安全的人工审批，挂起状态持久化到 storage，可跨进程/跨部署恢复 |
| 会话持久化 | Codex 侧线程由 `codex app-server` 自己管理；Canvas Agent 额外维护 `conversationState` 状态机 + 断线重放缓存 + 消息展示元数据（`message-metadata` 目录） | JSONL 树形文件，`~/.pi/agent/sessions/`，每条记录带 `id`/`parentId`，原生支持分支、fork、clone、resume | `@mastra/memory` + storage provider（如 `@mastra/libsql` 的 `LibSQLStore`），核心概念是 `thread`（隔离单次会话，owner 不可变）+ `resource`（稳定的用户/实体标识），额外内置 working memory（结构化用户偏好，作为 system message 或 state signal 注入）和 semantic recall（基于 embedding 的语义检索，默认 `scope: 'resource'`） |
| 事件流粒度 | `thread.started`/`turn.started`/`item.*`/`turn.completed`（Codex 原生事件）+ Canvas Agent 自己的 `codex_state`/`conversation_changed`/`skills_changed` 等 | `agent_start`→`turn_start`→`message_start/update/end`→`tool_execution_start/update/end`→`turn_end`→…→`agent_end`，是 `pi-agent-core` 自己定义的统一事件序列 | 公开文档里只看到 `.generate()`（一次性返回 `text`/`toolCalls`/`toolResults`/`steps`/`usage`）和 `.stream()`（`textStream` 增量 + 其余字段以 promise 形式给出）两级 API，**没有**公开的细粒度事件类型清单（不含 `tool-call`/`step-start` 之类的事件名），Workflow 侧的 `.stream()` 有 `fullStream`/`result` 但具体事件粒度文档同样没展开 |
| 扩展机制 | Skill（Codex 原生 Skill 发现 + 画布专属 `SkillStore` 管理的 `.agents/skills/*/SKILL.md`） | Extension（可挂钩 `beforeToolCall`/`afterToolCall`，可注册自定义 UI 对话框）+ Skill（约定为"带 README 的 CLI 工具"，官方替代 MCP 的方案） | `.agents/skills` 目录，CLI 初始化时"为检测到的编码助手安装 Mastra skills"（面向编码助手的约定，细节文档未展开）；另有"MCP Apps"扩展——工具结果可携带 `ui://` 形式的 resource，在 Mastra Studio 的 sandboxed iframe 里渲染成可交互 HTML（表单、计算器等） |
| 安全隔离哲学 | 网络面收紧（只监听 loopback + Origin 白名单）+ 具体动作确认（审批/二次确认），本机进程本身不隔离 | 进程/环境隔离（容器、微 VM、策略沙箱），具体动作不设确认弹窗 | 动作级审批内置且类型化（MCP 工具按名过滤审批、Workflow 挂起审批），但没有 Pi 那种进程/环境级隔离方案；商业化边界靠 `ee/` 目录的许可证限制，不是安全隔离 |

## 3. 关键设计差异逐项分析

### 3.1 连接方式：常驻服务 vs 子进程 vs 可选独立部署

Canvas Agent 选择做一个**常驻的本地 HTTP 服务**，原因是它天生要服务多个不同的调用方：本地 Codex 终端（通过 MCP）、浏览器侧边栏（通过 SSE）、Codex app 插件、Claude Code——这些是完全独立的进程，互相之间没有父子关系，只能通过一个共享的、可长期存活的网络端点协调。SSE 的选择也很务实：单向的服务端推送足够覆盖"Agent 事件流"这个场景，比 WebSocket 省掉了双向握手的复杂度，浏览器原生 `EventSource` 自带重连。

Pi 的核心场景不同——`pi` 本身就是终端里跑的那个进程，agent loop 和 TUI 天然在同一个进程里，不需要跨进程通信。它把"跨进程集成"作为一个附加能力提供（`--mode rpc`），选择了最轻的方案：stdin/stdout + JSONL，代价是天然只支持一对一。更实验性的 `pi-server` 走向另一个极端：Unix domain socket + 自定义 CBOR 二进制帧协议，协议本身故意做成"payload-agnostic"，业务语义交给上层的 `chord` 服务契约。

Mastra 的选择又不一样：它默认是"嵌入宿主应用"的库形态（直接 `new Mastra({...})` 用在 React/Next.js/Node 项目里），只有当你需要"完全掌控基础设施、长驻进程、或 WebSocket 连接"时才建议 `mastra build` 出一个独立的 Hono server 去部署。这本质上是把"要不要做成常驻服务"这个决定完全交还给使用者——Mastra 本身既能像 Pi 一样被内嵌进宿主进程，也能像 Canvas Agent 一样跑成独立服务，只是它没有像 Canvas Agent 那样为"这一个具体前端"预先做好协议选型（SSE vs WebSocket 之类），也没有公开文档说明这个 Hono server 对外暴露的具体路由和协议形态。另外它内置了 Mastra Studio 这个"托管的可视化环境"，用来跑 agent/workflow 测试和看 trace，这是三者里唯一自带调试/观测 UI 产品的。

**小结**：三者在"连接方式"上的选择直接反映了各自要服务的调用方数量和同构程度——Canvas Agent 面对少量但异构的固定调用方（一个前端 + 若干个受信 Agent CLI），协议选简单够用的；Pi 面对未知数量的、可能异构的客户端，把协议做成分层可插拔；Mastra 则把"要不要独立部署、用什么协议"这个决策完全留给宿主应用，自己只保证"库可以被任意方式包起来"。

### 3.2 工具调用协议：MCP vs 自定义 AgentTool vs MCP 双向支持

Canvas Agent 选 MCP 是因为它的核心需求是"让 Codex/Claude 这些**已有的、不受自己控制的** Agent 产品去操作画布"，MCP 是这些产品原生支持的标准协议，用它意味着不需要修改 Codex/Claude 本身。`server/mcp.ts` 本身薄到只做协议转发，所有实际的业务逻辑都在 HTTP 层的 `CanvasSession` 里。

Pi 反过来自己实现 Agent 运行时，定义了一套自己的 `AgentTool` 接口，官方明确拒绝 MCP（"No MCP. Build CLI tools with READMEs (see Skills)"），代价是 Pi 生态下的工具不能被 Codex/Claude 这类外部 Agent 产品直接复用。

Mastra 在这一点上走的是三者里最"折中"也最"全面"的路线：它自己的原生工具接口是 `createTool({ id, description, inputSchema, execute })`（用 zod 描述参数，和 Canvas Agent 的 MCP 工具描述方式殊途同归），但**同时**内置了完整的 MCP 双向支持——`MCPClient` 可以连接任意外部 MCP server（本地 stdio 子进程或远程 HTTP，支持 OAuth）并把拿到的工具直接喂给 `Agent` 的 `tools` 参数；`MCPServer` 则可以把 Mastra 自己的 agent/tool/workflow（以及 prompt、resource）反向注册成一个 MCP server 对外暴露（stdio 用 `startStdio()`，或者 HTTP 加 OAuth 中间件）。这意味着 Mastra 生态里的 agent 既能"消费"整个 MCP 生态（等价于 Canvas Agent 的角色：把外部标准工具接进来），也能把自己"发布"成标准 MCP 工具供 Codex/Claude 等外部 Agent 使用（这是 Canvas Agent 和 Pi 都没有覆盖到的方向——Canvas Agent 只做了"MCP server 转发到画布"这一半，没有反向把画布能力包装成通用 MCP server 给别的场景复用；Pi 干脆整个拒绝了 MCP）。

代价是 Mastra 因此背上了两套工具协议：原生的 `createTool`/`AgentTool` 体系和外部对接用的 MCP 体系，需要在 `MCPClient.listTools()`（静态、共享凭据）和 `listToolsets()`（运行时、按请求凭据）之间做选择，这层复杂度是 Canvas Agent（只有 MCP 一种协议）和 Pi（只有自定义协议一种）都不需要处理的。

### 3.3 审批/权限哲学：动作级确认 vs 环境级隔离 vs 结构化挂起审批

这是三者哲学分歧最大的地方，值得展开讲，而且 Mastra 的加入让这个对比从"两极"变成了"三种模式"。

**Canvas Agent**：信任外部 Agent 沙箱的判断，但给用户一层针对"画布会被改成什么样"的语义层确认。Codex 自己的沙箱审批走 `codex_approval`，Canvas Agent 只是转发；画布写操作的 `confirmTools` 二次确认是 Canvas Agent 自己加的一层，且默认**关闭**（"Writes are automatically confirmed by default"）。这套设计的前提是进程本身运行在受信本机环境，风险落在"这次具体改动对不对"，所以确认粒度在语义层而非系统调用层。

**Pi**：agent 本身默认拥有启动者的全部权限，不在动作层面拦截，边界要在启动前用容器/VM/沙箱划好（"Pi runs with all permissions by default"）。它提供的四种隔离模式全部是进程/环境边界，不是单次动作确认；文档里的确认能力（`extension_ui_request` 的 `confirm`/`select`）明确是"扩展要自己实现"，不是核心默认行为。

**Mastra**：既不是纯语义层确认（像 Canvas Agent），也不是纯环境隔离（像 Pi），而是把"人工审批"做成了框架的一等公民、结构化能力：
- MCP 工具调用层：`requireToolApproval` 可以是布尔值（全部工具都要批准）或一个按工具名过滤的回调（比如只拦截 `delete_*` 前缀的工具），这比 Canvas Agent 的 `confirmTools`（全部画布写操作一刀切）更细粒度，但也比它更依赖使用者自己写判断逻辑。
- Workflow 层：`suspend()`/`resume()` 配合 `suspendSchema`/`resumeSchema` 做**类型安全**的挂起审批——挂起时可以携带结构化的 `reason`/`requestDetails` 之类的上下文（由 `suspendSchema` 定义），恢复时必须提供符合 `resumeSchema` 的数据（比如 `{ approved: boolean }`）。挂起状态是完整的执行快照，持久化到配置的 storage provider，"persist across deployments and application restarts"——也就是说审批可以真正跨进程、跨部署完成（比如挂起时进程重启，审批人在几天后通过一个全新进程、只用 `runId` 就能 `resume`），这是 Canvas Agent（画布写操作确认是同进程内的即时交互）和 Pi（没有内置审批状态持久化机制）都不具备的能力。

三种哲学的适用边界更清楚了：
- Canvas Agent 适合"用户本机运行、单一受信工具链、操作对象是一个具体可撤销的应用状态"——动作级确认成本可控。
- Pi 适合"要支持任意 LLM/任意工具/任意执行环境，且很多场景下 agent 会跑在别人的机器上或做真正危险的系统操作"——环境级隔离提供更难被绕过的硬边界。
- Mastra 适合"审批本身就是业务流程的一部分，且审批人和执行进程可能不是同一个、不是同一时刻"（比如一个需要财务审批才能执行的自动化流程，审批人可能第二天才在另一台机器上点击批准）——它用持久化快照把"审批"从"一次同步的 UI 交互"变成了"一个可以跨时间、跨进程完成的业务状态转换"。但 Mastra 的两层审批机制（MCP 层 `requireToolApproval` + Workflow 层 `suspend`/`resume`）默认都需要开发者主动接入（写回调、定义 schema、接 storage），不像 Canvas Agent 那样有一个开箱即用、覆盖所有写操作的总开关；如果开发者两层都不配置，Mastra agent 的默认行为和 Pi 一样是"零拦截"。

一个针对 Canvas Agent 的既有风险点依然成立：默认关闭二次确认、且画布写操作是语义层确认而非系统调用层，如果 Codex 的沙箱审批被设成宽松模式，留给用户的最后一道语义闸门就只剩手动打开 `confirmTools`。这跟 Pi"默认全权限"和 Mastra"审批机制默认不启用"其实是同一类风险，只是暴露方式不同：Pi 从一开始就明确告知"零保护，请自己套壳"；Mastra 提供了现成的审批基建但不强制使用；Canvas Agent 把默认值设置得更宽松，要求用户主动收紧。三者都不是"默认安全"。

### 3.4 事件流设计：Canvas Agent 与 Pi 高度趋同，Mastra 的公开粒度明显更粗

Canvas Agent 和 Pi 的相似度是最意外的发现（见原分析）：`agent_start → turn_start → message_start/update/end → tool_execution_start/update/end → turn_end → … → agent_end`（Pi）和 `thread.started`/`turn.started`/`item.*`/`turn.completed`（Canvas Agent 消费的 Codex 原生事件）在粒度和分层上几乎一一对应，都是"整段对话级 → 单轮 turn 级 → 单条消息级 → 单次工具调用级"的四层结构，都区分"开始/增量更新/结束"三态。这说明这种四层事件模型可能是"流式 LLM Agent loop"的收敛设计。

Mastra 在这一点上是三者里公开文档粒度最粗的：`.stream()` 只给出 `textStream`（增量文本）加上 `toolCalls`/`toolResults`/`steps`/`usage` 几个 promise，**没有**公开一套类似 `tool_execution_start`/`message_update` 这样细粒度、可订阅的事件类型清单；Workflow 侧的 `.stream()` 有 `fullStream` 可迭代，但具体事件粒度文档同样没有展开。这不代表 Mastra 内部没有更细的事件（框架内部大概率也需要类似机制去驱动 UI 更新和 Mastra Studio 的 trace 展示），只是**这部分没有出现在我读到的公开文档里**，无法像 Canvas Agent 和 Pi 那样给出具体事件名做对比，这是本文档明确标注的"未能验证"项之一。

### 3.5 会话持久化：轻量补丁 vs 完整自持 vs 内置数据库化 Memory

Canvas Agent 是"轻量补丁式"持久化：核心状态交给 Codex（存在 Codex 的 rollout 文件里），自己只额外维护 `conversationState` 握手状态机（纯内存）和 `message-metadata` 目录（只存网页展示需要但 Codex 原生历史不保留的元数据）。

Pi 是"完整自持"：JSONL 树形文件，每条消息带 `id`/`parentId`，天然支持在任意历史节点分支（`/resume`、`--fork`、`/clone`），因为 Pi 自己就是 agent loop 的实现者，必须自己做全套会话管理。

Mastra 走的是第三条路——"内置数据库化 Memory 系统"，比前两者都更接近传统后端应用的数据建模思路：
- 概念上区分 `thread`（隔离单次会话/对话，owner 即 `resourceId` 创建后不可变）和 `resource`（跨会话稳定的用户/实体标识），调用时通过 `memory: { resource, thread }` 传入，这比 Pi 的"一棵树"或 Canvas Agent 的"一个线性 thread"多了一个显式的"用户身份"维度。
- 内置 **working memory**：结构化的用户偏好/目标数据，会被注入为 system message（或者开启 `useStateSignals` 后作为 state signal），这是 Canvas Agent 和 Pi 都没有的"跨会话用户画像"能力——Canvas Agent 的 `message-metadata` 只存展示元数据，不做用户画像抽取；Pi 的树形历史本身不做语义层面的偏好提炼。
- 内置 **semantic recall**：基于 embedding 的语义检索历史消息，默认 `scope: 'resource'`（跨该用户的所有会话检索），同 thread 内的结果按时间戳与其他历史消息交错插入，跨 thread 的结果则整理成一条 system message。这需要一个向量库后端（公开文档没有列出具体支持哪些 vector store），是三者中唯一依赖 embedding/向量检索做记忆召回的。
- 但这一切都**要求配置 storage provider**（文档原文："Memory **requires** a storage provider to persist message history"，示例用 `@mastra/libsql` 的 `LibSQLStore`），也就是说 Mastra 把"记忆"这个能力做成了强依赖外部数据库的重量级子系统，不像 Pi 的 JSONL 文件那样零依赖，也不像 Canvas Agent 那样可以完全不管持久化（把这个责任丢给 Codex）。

一个额外的细节：Mastra 支持多 agent 委派场景下的记忆继承规则——子 agent 的 `resourceId` 按 `{parentResourceId}-{agentName}` 派生（保证跨次委派时该子 agent 的资源级记忆稳定持续），但 `threadId` 每次委派都是全新的（子 agent 每次对话历史是干净的）。这是一种"身份记忆继承、对话历史不继承"的精细化设计，Canvas Agent 和 Pi 目前都没有对应的多 agent 记忆传递规则可比较（两者公开信息里都没有明确的多 agent 委派记忆继承机制）。

### 3.6 扩展机制：Skill 定位三种都不同，Mastra 多了一个"结构化审批"作为独立维度

三边都用了"Skill"这个词，含义都不完全一样：

- Canvas Agent 的 Skill 是 **Codex 原生 Skill 概念的复用**（`skills/list`、`skills/config/write` 是 Codex app-server 协议自带的），Canvas Agent 只是加了一层"画布专属托管"和"从对话/画布快照提炼 Skill 草稿"的生成能力。本质上是 Codex Skill 体系的消费者+管理面板，不是发明者。
- Pi 的 Skill 是自己发明的一套约定："带 README 的 CLI 工具"，明确是用来**替代 MCP** 的方案。更轻量（不需要协议，只要一个可执行文件 + 说明文档），但 Skill 生态和 MCP 生态是割裂的。
- Mastra 的 Skill（`.agents/skills` 目录，CLI 会"为检测到的编码助手安装 Mastra skills"）看起来更接近"给编码助手（如 Claude Code、Codex 这类开发工具）提供的项目级操作手册/脚手架约定"，公开文档没有展开它的加载协议或格式规范，无法判断它和 Codex 原生 Skill、Pi 的 CLI-with-README 约定在格式上是否兼容——**这是本文档未能验证的部分**。

不过 Mastra 在"扩展能力"上还有两个三者里独有的点值得单独记一下：
- **MCP Apps**：工具执行结果可以携带 `ui://` 形式的 MCP resource，让工具输出直接渲染成可交互 HTML（表单、计算器等），在 Mastra Studio 的 sandboxed iframe 里展示（用 `@modelcontextprotocol/ext-apps` 的 `App` 类，`app.ontoolinput`/`app.callServerTool()`/`app.sendMessage()`/`app.connect()`）。这是把"工具调用结果的可视化"标准化成了协议层能力，Canvas Agent 里等价的东西是"画布本身就是可视化结果"（不需要单独的 UI 协议，因为消费端固定是画布），Pi 的文档里没有对应机制。
- **Workflow 作为一等公民**：Mastra 的 Workflow（`createStep`/`createWorkflow`/`.then()`/`.commit()`）本身可以互相嵌套（一个 workflow 作为另一个 workflow 的 step），也可以在 step 里调用 agent（`mastra.getAgent().stream()` 再 `pipeTo` 进 workflow 的输出流），文档也提到"can run workflows from agents"。这种"workflow 和 agent 互相调用"的组合能力，在 Canvas Agent（没有独立于 Codex thread 之外的 workflow 概念）和 Pi（agent loop 是唯一的编排单元，没有独立的 workflow 抽象）里都没有对应物。

## 4. 三方优缺点对比

### Infinite Canvas Agent

**优点**
- 对具体场景打磨得很深：断线重放缓存、多标签页焦点仲裁、Skill 草稿的两轮敏感信息过滤、会话准备状态机对 MCP 清单的精确追踪——这些都是"用起来才会发现要处理"的边界情况。
- 复用现成的 Agent 沙箱能力：不用自己实现 Agent loop，把这部分完全委托给 Codex/Claude 官方 CLI，工程量和维护成本都更小。
- 协议选型务实：SSE 对"单向事件推送给浏览器"够用且简单，MCP 让画布能力立刻对接到 Codex/Claude 已有用户群。
- 双层确认机制职责清晰：沙箱审批（执行层安全）和画布二次确认（结果层用户体验）分离，互不干扰。

**缺点/局限**
- 强绑定外部 CLI 的可用性和版本，Codex/Claude CLI 协议 breaking change 时这一层要跟着改。
- 默认写入自动确认，语义层确认依赖用户主动开启，风险敞口比看起来大。
- 只支持三种固定的 Agent 后端，没有像 Pi/Mastra 那样的统一多 Provider LLM 抽象层。
- 单机单前端假设较重，没有 Pi `pi-server` 或 Mastra 独立部署那样的多客户端路由能力。
- 没有内置的"记忆"抽象（working memory / semantic recall），跨会话的用户偏好只能靠 Codex/Claude 自己的能力或手工拼 prompt。

### Pi

**优点**
- 模型/Provider 无关，不依赖任何外部 CLI 子进程，理论上更容易接入新模型或做多模型对比。
- 权限哲学诚实且可验证：不假装有内置的动作级安全网，`sbx`/OpenShell 方案里"真实凭证不进容器"比任何动作级审批都更难被绕过。
- 会话模型表达力更强：JSONL 树形结构原生支持分支/fork/clone。
- 架构分层更通用：`pi-protocol` 故意做成 payload-agnostic，改动量比"从 Express+SSE 服务改造成通用路由层"要小。

**缺点/局限**
- 无内置 MCP 支持，无法直接复用日益增长的 MCP 工具/服务生态，也不能像 Mastra 那样把自己的能力反向发布成 MCP server。
- 零默认防护，责任完全下放给使用者，对不熟悉容器化/沙箱的用户是真实风险。
- 文档层面能看到的"确认/审批"仍然是扩展点，不是标准件，也没有 Mastra 那种带持久化快照、可跨进程恢复的结构化审批流程。
- 没有内置的记忆/存储子系统抽象（只有会话文件本身），working memory、semantic recall 这类能力要自己在 extension 里实现。
- 本文未能验证的部分：Pi 实际的错误恢复、并发写入保护、跨进程一致性等工程细节无法评估。

### Mastra

**优点**
- 工具协议两头通吃：原生 `createTool` + 完整的 MCP 双向支持（`MCPClient` 消费外部生态，`MCPServer` 反向发布），是三者里唯一同时做到"能接外部标准工具"和"能把自己发布成标准工具"的。
- 审批机制标准化且可持久化：`suspend`/`resume` 配合 `suspendSchema`/`resumeSchema` 做类型安全的挂起审批，快照持久化到 storage，天然支持跨进程/跨部署恢复，是三者里唯一把"人工审批"当成框架一等公民、且解决了"审批人和执行环境不同步"这个真实业务问题的。
- Memory 子系统数据库化、能力更全：thread/resource 双维度身份模型 + working memory（用户画像）+ semantic recall（语义检索），多 agent 委派场景下有明确的记忆继承规则。
- Workflow 是独立于 Agent 的一等编排单元，可以和 agent 互相嵌套调用，适合"agent 只是流程里一步"的复杂业务场景，这是 Canvas Agent 和 Pi 都没有的抽象层级。
- 部署形态灵活：既能像库一样嵌入宿主应用，也能构建成独立 Hono server 部署到主流 PaaS/云平台，还自带 Mastra Studio 可视化调试环境。

**缺点/局限**
- 记忆能力强依赖外部存储和向量库（"Memory requires a storage provider"），不是 Pi 那种零依赖的本地文件方案，也不是 Canvas Agent 那种"完全不管、丢给上游 CLI"的轻量做法，接入成本更高。
- 公开文档里的流式事件粒度明显比 Canvas Agent（Codex 原生事件）和 Pi（`pi-agent-core` 自定义事件序列）粗，没有看到细粒度、可订阅的事件类型清单，无法判断是否支持"单次工具调用内部的增量更新"这类精细订阅。
- 两层审批机制（MCP `requireToolApproval` + Workflow `suspend/resume`）都需要开发者主动接入，默认不开启，不像 Canvas Agent 那样有一个覆盖所有写操作的总开关式确认能力（虽然默认也关闭）。
- 核心框架之外有 `ee/`（Enterprise）目录，生产环境使用部分功能需要商业授权，是三者中唯一有商业许可边界的，采用前需要弄清楚哪些能力落在 `ee/` 里。
- 本文未能验证的部分：Hono server 对外具体路由/协议、Mastra Skill 的加载格式和协议、workflow `.stream()` 的具体事件粒度、Memory 支持的向量库种类，这些公开文档均未展开，可能存在文档没体现出的成熟度或限制。

## 5. 结论与可借鉴之处

三者不是竞品关系，更像是同一问题（"让 LLM Agent 安全地操作一个真实系统"）在不同抽象层级和不同商业模型下的三种答案：

- **Pi** 解决的是"如何造一个通用、诚实、权限哲学清晰的 Agent 运行时"，把几乎所有基建决策（协议、存储、审批、隔离）都留给使用者，换来的是最小的强制约束和最大的组合自由度。
- **Canvas Agent** 解决的是"如何让已有的 Agent 产品，安全、顺滑地操作我这一个具体应用"，用最省事的方式（复用外部 CLI 的 Agent loop 和沙箱）把工程重心全部放在"这一个前端体验"上。
- **Mastra** 解决的是"如何提供一个开箱即用、覆盖生产场景常见需求（持久化记忆、结构化审批、多 Provider、可视化调试、多平台部署）的应用框架"，用换取商业化边界（`ee/`）和更重的外部依赖（storage/vector）为代价，把 Pi 刻意不做的很多事情做成了标准件。

如果要互相借鉴：

- **Canvas Agent 可以从 Pi 借鉴**：更诚实地暴露默认风险（`permissionMode` 设为 `full` 且 `confirmTools` 关闭时给出更明显的风险提示）；也可以考虑给画布状态引入类似"分支/fork"的能力（目前只有一步 undo）。
- **Canvas Agent 可以从 Mastra 借鉴**：Mastra 的 `suspend`/`resume` 模式——把"画布写操作二次确认"从"同进程内的即时 UI 交互"升级成一个可持久化、可跨会话恢复的状态（比如用户中途关闭浏览器，几分钟后重新打开还能看到待确认的画布操作并继续处理），比现在纯内存的 `confirmTools` 更稳健；另外 working memory 的思路（把用户在画布上反复表达的偏好结构化存下来，而不只是存展示元数据）也值得参考。
- **Pi 系如果想覆盖 Canvas Agent 这类"桥接到一个具体图形化应用"的场景**，可以参考 Canvas Agent 里"高层语义工具在服务端展开为原子操作序列 + 前端只认一种通用 apply_ops 协议"的模式，这比让每个 `AgentTool.execute` 自己拼具体的 UI 状态变更更容易维护和审查。
- **Pi 系如果想覆盖 Mastra 这类"审批人和执行环境不同步"的场景**，可以参考 Mastra 的挂起快照持久化思路，在 `extension_ui_request` 之上补一层"挂起状态落盘、允许换进程 resume"的标准扩展，而不是要求每个 extension 自己解决持久化问题。
- **Mastra 如果想覆盖 Canvas Agent 这类"轻量桥接到已有 Agent CLI"的场景**，目前的架构里 agent loop 是自己实现的，如果要复用 Codex/Claude 官方 CLI 的沙箱能力（而不是重新在 Mastra 里造一套等价的安全机制），需要额外的适配层；反过来 Canvas Agent 也可以观察 Mastra 的 `MCPServer` 反向发布模式——如果未来想让画布能力不仅服务于 Codex/Claude，也能被其他支持 MCP 的通用 Agent 框架（包括 Mastra 自己）消费，`MCPServer` 这种"把自己的能力包装成标准 MCP server"的模式是一个直接可参考的落地方式。
