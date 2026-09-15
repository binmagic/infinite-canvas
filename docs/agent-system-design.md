# Infinite Canvas Agent 设计与实现文档

本文基于对以下源码的实际阅读整理，不是概念性描述：

- 前端：`web/src/stores/use-agent-store.ts`、`web/src/components/agent/*`、`web/src/lib/agent/*`、`web/src/lib/canvas/canvas-agent-ops.ts`、`web/src/pages/canvas/hooks/use-agent-bridge.ts`
- 本地服务：`canvas-agent/src/**`（`server/http.ts`、`server/mcp.ts`、`canvas/*`、`agent/*`、`skills/*`、`config.ts`）
- 插件：`plugins/infinite-canvas/**`

代码中的中文注释已在引用处保留原意；本文档面向理解整体设计，不逐行复述实现。

## 1. 总体架构

Codex/Claude Code 不直接操作浏览器 DOM，也不模拟鼠标点击。三方通过一个本地常驻进程 **Canvas Agent**（`canvas-agent/` 包，发布为 `@basketikun/canvas-agent`）桥接：

```
┌────────────────┐      JSON-RPC/stdio      ┌────────────────────┐      HTTP/SSE      ┌─────────────────────┐
│ Codex app-server │ ◄──────────────────────► │  Canvas Agent 进程   │ ◄─────────────────► │  浏览器画布 (React)   │
│ (--stdio 子进程)  │                          │ 127.0.0.1:17371    │                     │ use-agent-store.ts   │
└────────────────┘                            └────────────────────┘                     └─────────────────────┘
        ▲                                              ▲
        │ stdio JSON-RPC (MCP)                          │ /api/tools (HTTP)
        └────────────── canvas-agent mcp 子进程 ─────────┘
```

关键设计取舍（来自 `docs/content/docs/development/local-codex-canvas.mdx`，与代码实现一致）：

- Canvas Agent 默认只监听 `127.0.0.1`，不接受远程连接。
- 浏览器必须带正确 token 才能建立 SSE 连接；Agent 记录第一个通过校验的网页 Origin，之后拒绝其他 Origin 复用（`canvas-agent/src/server/http.ts` 的 `setCors`）。
- 画布真正的写入、审批、撤销权始终留在浏览器一侧；Canvas Agent 和 Codex 都不能绕过浏览器直接改状态。
- 托管网站不存储本地 Codex 登录态、API Key 或本机文件权限——这些只存在于用户本机的 Canvas Agent 进程里。

有两个独立入口都会驱动同一条 "Codex → MCP → Canvas Agent → 浏览器" 的写路径：

1. **本地 Codex/Claude Code 终端** 通过 `infinite-canvas` MCP 工具，请求打到 Canvas Agent 的 `/api/tools`。
2. **浏览器侧边栏**（`LocalAgentPanel`）把用户输入发送到 `/agent/codex/turn`，Canvas Agent 内部启动/复用一个 `codex app-server --stdio` 子进程，并把同一套 MCP 工具挂给这个对话。

## 2. Canvas Agent 后端（`canvas-agent/`）

### 2.1 进程与配置

- 入口 `src/index.ts`（未展开阅读，从 `README.md` 及 `server/http.ts`/`server/mcp.ts` 可知）按子命令分流：默认启动 HTTP 服务（`startHttpServer`），`mcp` 子命令启动 stdio MCP 服务（`startMcpServer`）。
- `config.ts`：
  - 配置文件固定在 `~/.infinite-canvas/canvas-agent.json`，目录权限 `0700`、文件权限 `0600`（`writeConfigFile`），token 用 `crypto.randomBytes(18)` 生成。
  - `ensureSiteWorkspace`/`updateSiteWorkspace` 管理一个「站点级工作空间」目录（默认 `~/.infinite-canvas/codex-workspaces/site`），首次初始化时写入 `AGENT_PROMPT`（`agent-instructions.md`）作为该目录的 `AGENTS.md`。这个工作空间就是 Codex/Claude 进程的 `cwd`，也是 Skill 文件的落地目录。
  - `DEFAULT_PORT = 17371`；端口可用 `PORT` 环境变量覆盖。

### 2.2 HTTP 服务（`server/http.ts`）

Express 应用，中间件链：

1. 调试日志中间件（仅 `logger.enabled` 时生效，记录方法/路径/状态码/耗时，`/health`、`/canvas/state`、`/canvas/activate` 的 2xx 响应不记录，避免刷屏）。
2. CORS 中间件 `setCors`：读取 `Origin`，`OPTIONS`/`/health`/`/config` 直接放行；其余请求校验 token 后把该 Origin 记入 `config.origins` 并持久化，之后只允许这个 Origin 列表内的来源。
3. Token 校验中间件（除 `/health`、`/config` 外全部路由）：`validToken` 同时接受 query 参数 `token` 和请求头 `x-canvas-agent-token`。

路由按职责分组：

| 分组 | 路由 | 作用 |
|---|---|---|
| 连接 | `GET /events` | 建立 SSE，见 2.3 |
| 画布状态 | `POST /canvas/state`、`POST /canvas/activate`、`POST /canvas/result` | 浏览器上报快照、声明当前活跃标签页、回传工具调用结果 |
| MCP 转发 | `POST /api/tools` | Codex/Claude 的 MCP 工具最终都落到这一个入口 |
| Codex 会话 | `GET/POST /agent/codex/threads*`、`/agent/codex/turn`、`/agent/codex/approval`、`/agent/codex/interrupt` | 侧边栏对话生命周期 |
| Skill | `GET/POST /agent/codex/skills*` | 原生 Skill 列表 + 画布专属 Skill 的 CRUD |
| 附件/资源 | `/agent/attachments/:id`、`/agent/message-assets/:key/:file`、`/agent/local-image`、`/agent/local-file/reveal` | 图片附件回显、本地文件定位 |
| Claude | `POST /agent/claude/turn` | 预留的 Claude CLI 直连入口 |

值得注意的实现细节：

- **`codexMutation` 包装器**：所有会修改 Codex 会话状态的路由（新建/恢复/删除线程、发起 turn、Skill 写操作）都包一层 `session.beginCodexMutation()`，本质是一个进程内互斥锁——`codexState.busy` 或 `codexMutationBusy` 为真时新请求直接 409（`CONVERSATION_BUSY`），执行完在 `finally` 里释放。这防止多个浏览器标签页并发操作同一个 Codex 会话导致状态错乱。
- **草稿线程预热（`prepareDraftThread`）**：新建对话时先立即起一个 Codex 线程并等待 MCP 清单就绪，再挂到 `activeThreadId`；用一个模块级 Promise (`draftThreadStart`) 去重并发的预热请求。
- **`/agent/codex/turn` 的一致性校验**：请求体带 `threadId`/`conversationId`/`expectedRevision`，服务端逐项比对当前 `session.conversationStateSnapshot`，任一不匹配就返回 `409 CONVERSATION_STALE` 并附带最新状态，前端据此重新同步而不是盲目重试。
- **附件上下文注入（`withAttachmentContext`）**：浏览器上传的图片会被列成 `attachmentId=... name=...` 清单追加进 prompt 末尾，并附一句指令：需要把附件放入画布或作为生成参考图时，先调用 `canvas_create_attachment_nodes`。这是把「浏览器端状态」转译成「LLM 可读文本」的桥接点。
- **启动时线程恢复**：`app.listen` 的回调里，如果配置里已有 `activeThreadId`，会尝试 `prepareExistingThread`；失败且是可恢复错误（`isRecoverableThreadError`，见 4.4）时自动降级为新建草稿线程，而不是直接报错退出。

### 2.3 会话状态机（`canvas/session.ts` 的 `CanvasSession`）

这是整个后端的状态核心，管理四类东西：

**a) 浏览器客户端连接**

- `clients: Map<clientId, ServerResponse>`：所有存活的 SSE 连接。
- `activeClientId` / `boundClientId`：`targetClientId` getter 优先取 `boundClientId`（当前 turn 显式绑定的标签页），否则回退到 `activeClientId`（最近一次 focus 的标签页）。这套双层设计是为了让"多标签页打开同一画布"时，Codex 发起的一次 turn 能稳定绑定到发起它的那个标签页，而不会因为用户切换到另一个标签页而把工具调用发错地方。
- `clientFocusOrder` + `focusSequence`：记录每个 client 最近一次被 `activateClient` 的序号；某个 client 断线且它恰好是 `activeClientId` 时，按这个序号回退到次新的存活 client。

**b) Codex 运行态（`codexState: { busy, threadId, turnId }`）**

- `setCodexState` 是唯一修改入口，会判断线程/turn 是否变化来决定是否清空「断线重放缓存」（见下）。
- `codexEventScope` 把当前 `threadId`/`turnId`/`boundClientId` 暴露给外层 `emit`，用来给广播事件打上归属标签。

**c) 会话准备状态机（`conversationState`）**

状态枚举 `idle → preparing → ready|warning|failed → running → ready|warning`：

- `beginConversation` 进入 `preparing`，清空 `mcpStatuses`。
- `updateConversationMcp` 逐个记录每个 MCP 服务的启动状态（`starting/ready/failed/cancelled`）。
- `completeConversationMcpInventory` 用 app-server 返回的权威 MCP 清单（`mcpServerStatus/list`）补齐没有单独发通知的服务，并把 `notLoggedIn` 的服务标记为失败。
- `completeConversationPreparation` 综合判断：只要 `infinite-canvas`（画布自身的 MCP）没 ready，整个会话就是 `failed`；其他 MCP 失败只降级为 `warning`，不阻塞发消息。
- 每次状态变更都会 `revision += 1` 并广播 `conversation_changed`；前端发起 turn 时要求 `expectedRevision` 匹配，天然防止"用户在旧状态快照上操作"。

**d) 断线重放缓存（`codexReplayEvents` / `codexReplayActiveItems`）**

这是为了解决 SSE 断线重连后不丢失当前 turn 进度的问题：

- 只在 `codexState.busy` 且事件属于当前 thread/turn 时才缓存（`emitThread` 内部逻辑）。
- 用 `codexReplayKey` 给不同事件类型生成稳定 key（聊天消息按 `clientMessageId`，`agent_event` 按 `item:turnId:itemId`，`plan.updated`/`usage.updated` 按类型+turnId）。
- 对文本增量事件（`item.updated`/`item.completed`）用 `replaySnapshot` 合并成完整文本快照存起来，而不是存原始 delta——这样重连的客户端拿到的是全量文本，不需要重放所有历史 delta。
- 缓存做了软上限（240 条），超限时优先淘汰不在 `codexReplayActiveItems`（未完成的流式 item）里的旧条目。
- `openEvents` 建立连接时，如果请求带的 `activeThreadId` 与当前 `codexState.threadId` 一致，会把整份重放缓存回放给新连接。

**e) 工具调用的请求/响应桥接（`requestCanvasTool` / `resolveResult`）**

这是 MCP 工具落地到浏览器写操作的关键路径：

```
callTool(name, input)
  → 校验/解析参数（parseToolInput，zod）
  → 判断 SITE_TOOLS（站点级只读/工作台工具）还是 canvas 写操作
  → 站点工具/需要连接画布的读工具：直接走 requestCanvasTool
  → 其余 canvas_* 工具：buildCanvasToolRequest 转换成 canvas_apply_ops
  → requestCanvasTool(name, input)
      → 生成 requestId，SSE 事件 "tool_call" 推给 targetClientId
      → pending.set(requestId, {resolve, reject})，30s 超时
      → 等待浏览器 POST /canvas/result 触发 resolveResult
```

超时和断线都会 reject 对应 Promise，MCP 那一层会把错误包成 JSON-RPC 错误返回给 Codex。

### 2.4 工具定义与转换（`canvas/schemas.ts` / `canvas/tools.ts` / `canvas/operations.ts`）

- `schemas.ts` 用 `zod` 定义了 29 个工具名（`toolNames`）及各自的输入 schema、中文 description。这些 description 直接作为 MCP 工具描述提供给 Codex/Claude，是实际影响模型行为的"提示词"。
- 工具按落地方式分三类：
  1. **`canvas_apply_ops`**：底层通用接口，`ops` 是判别联合类型（`add_node`/`update_node`/`delete_node`/`delete_connections`/`connect_nodes`/`set_viewport`/`select_nodes`/`run_generation`），前端 `applyCanvasAgentOps` 直接消费。
  2. **高层语义工具**（`canvas_create_text_node`、`canvas_create_image_prompt_flow`、`canvas_generate_image` 等）：由 `operations.ts` 的 `buildCanvasToolRequest` 在服务端**转换**成一组 `canvas_apply_ops`，再统一走同一条 SSE 通道。例如 `canvas_create_image_prompt_flow` 会生成"提示词文本节点 + 生成配置节点 + 连线 + 可选立即触发"这一整套操作序列（`generationFlowOps`），前端只需认识 `canvas_apply_ops` 这一种协议。
  3. **站点级工具**（`SITE_TOOLS` 集合：`site_navigate`、`canvas_list_projects`、`workbench_*`、`prompts_search`、`assets_*`、`generation_get_status`）：直接把工具名和入参原样通过 SSE 发给浏览器，由前端 `runSiteTool`（`agent-site-tools.ts`）在本地状态（zustand + localforage）里执行，不经过画布快照。
- `tools.ts` 的 `compactCanvasState`/`compactNode` 在把画布快照返回给 Codex 前做压缩：超过 240 字符的文本内容会截断，避免把整个画布的长文本灌进模型上下文。
- `@[node:ID]` 引用语法：`generationFlowOps` 支持一种"复用已有节点"的优化——如果 prompt 里 `@`提及的节点 ID 恰好等于要连线的 `referenceNodeIds`，且 prompt 去掉引用标记后是空的，就不再新建文本节点，直接复用已选中的节点。

### 2.5 Codex 集成层（`agent/codex.ts` + `agent/codex-client.ts`）

这是与 Codex 通信最复杂的部分，拆两层：

**`CodexAppClient`（codex-client.ts）**：对 `codex app-server --stdio` 子进程的 JSON-RPC 协议做面向对象封装。

- 子进程用 `spawn(process.execPath, [codexBin(), "app-server", "--stdio"], ...)` 启动，`codexBin()` 通过 `require.resolve("@openai/codex/package.json")` 定位 CLI 可执行文件——即 Canvas Agent 内置了对 `@openai/codex` 的依赖，不依赖用户是否单独装了全局 `codex`（`version-check.ts` 会额外提示全局版本与内置版本不一致）。
- 请求/响应用自增 `nextId` 配对，`pending: Map<id, {resolve,reject}>`；通知（无 id 的 method 推送）走 `handleNotification` 分发。
- **流式文本合并**：`item/agentMessage/delta` 等增量通知不会逐条转发给上层，而是先攒进 `pendingDeltas`，`STREAM_UPDATE_INTERVAL_MS = 40ms` 做节流合并后才 `emit("agent_event", {type:"item.updated", ...})`，减少 SSE 消息数和前端渲染次数。
- **reasoning 分段**：Codex 的推理摘要按 `summaryIndex` 分段流式返回，`appendReasoningDelta` 按 index 排序拼接，保证多段摘要顺序正确。
- **turn 完成的两种时序**：如果 `turn/completed` 通知先于本地 `startTurn` 的 Promise 注册到达（`completedTurns`/`completedTurnResults` 缓存这种"早到"的结果），后续 `startTurn` 会直接消费缓存而不是挂起等待。
- **审批（approval）自动应答**：`answerServerRequest` 处理 app-server 主动发起的 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`——这些不是普通通知而是需要响应的 JSON-RPC 请求（带 `id`）。正常情况下会存入 `approvalRequests` 并 `emit("codex_approval", ...)` 等待浏览器决策；如果线程是"静默草稿线程"（`silentThreadIds`，用于 Skill 草稿生成），则自动拒绝/回空权限，绝不打断草稿流程也不会让浏览器看到这些请求。
- **草稿线程隔离**：`startSkillDraftThread`/`forkSkillDraftThread`（配 `skillDraftThreadSettings`：`sandbox: "read-only"`、`ephemeral: true`、专门的系统指令 `SKILL_DRAFT_INSTRUCTIONS` 禁止调用工具/执行命令/读文件/联网）用于从对话或画布快照提炼 Skill 草稿，产出走 `outputSchema` 结构化输出而非普通 turn，且这些线程的所有事件都被 `handleSilentNotification` 拦截、既不广播也不进补充历史。
- **失败与清理（`failAll`）**：子进程异常退出或出错时，遍历所有 `activeTurns`/`pendingTurnStart`，把仍在进行、尚未落盘的 turn 记为 `failed` 并写入历史（`eventHistory.recordTurn`），再统一 reject 所有挂起的 Promise。同时会清空所有内存缓存（delta、item 序号、plan、审批请求等），保证下一次重新拉起的子进程从干净状态开始。

**`codex.ts`（业务编排层）**：

- 模块级串行队列 `codexQueue`：`runCodexTurn` 和 `generateCodexSkillDraft` 都排进这同一条 Promise 链，保证同一进程内 Codex 交互严格顺序执行（配合上面的 `codexMutation` HTTP 层锁，双重保证不会并发踩踏）。
- `ensureCodexThread`：优先复用请求指定的 `threadId`；线程不可用时（`isRecoverableThreadError` 匹配 "thread not loaded"/"no rollout found"）自动新建线程重试，而不是把错误原样抛给用户。
- **Skill 草稿的敏感信息过滤**是这个文件里最重的一块逻辑（`canvasSkillSource`/`sanitizeCanvasValue`/`assertDraftHasNoSensitiveValues`）：
  - 把画布快照转成"节点引用（`node-1`, `node-2`...）+ 类型 + 标题 + 精简 metadata"的抽象表示，替换掉真实节点 ID，避免草稿里出现可复用的具体 ID。
  - 用一组正则黑名单移除 API Key/Token/密码/JWT/Bearer/已知服务商 Token 前缀（`sk-`、`ghp_`、`AKIA`...）、本地文件路径、`data:`/`blob:` URL、外部 `http(s)` URL。
  - 有节点/连线数量上限（300 节点、600 连线）和字符数上限（120KB），超限时标记 `truncated` 而不是静默丢数据。
  - 生成结果还要过一遍 `assertDraftHasNoSensitiveValues` 二次校验（本地路径、外部 URL、凭证模式、以及画布真实 ID/clientId 是否被泄漏到草稿文本里），任一命中直接抛错拒绝返回——这是"防止 Skill 草稿意外记录一次性凭证或内部 ID"的最后一道防线。
- **工作空间校验（`assertThreadWorkspace`/`threadInWorkspace`）**：每次恢复/读取线程都会比较线程的 `cwd` 和当前站点工作空间路径（Windows 下不区分大小写），防止误用不属于这个画布工作空间的旧线程。

### 2.6 MCP Server（`server/mcp.ts`）

这是 stdio 侧的 MCP 服务端实现，逻辑很薄：

```ts
toolNames.forEach(name => registerCanvasTool(server, config, name));
```

每个工具注册时用 `toolInputSchemas[name].shape` 作为 MCP `inputSchema`（复用同一份 zod 定义，保证 HTTP 直连和 MCP 两条路径的参数校验完全一致），处理函数就是把参数原样 `POST /api/tools`，再把结果包成 MCP 要求的 `{content: [{type:"text", text: JSON.stringify(result)}]}`。也就是说 **MCP Server 本身不包含任何画布逻辑**，它只是"Codex stdio ↔ Canvas Agent HTTP"的协议转换适配器。这也是为什么 `canvas-agent mcp` 可以作为独立子进程，被 Codex CLI、Codex app 插件、Claude Code 三种不同的宿主并行拉起使用同一个 Canvas Agent HTTP 服务。

### 2.7 Skill 管理（`skills/store.ts`）

`SkillStore` 只管理站点工作空间下 `.agents/skills/<name>/SKILL.md` 这一类"画布专属托管 Skill"（与 Codex 原生发现的其他 Skill 区分，`isManagedPath` 用路径结构判断：必须是 `skillsPath/<合法名称>/SKILL.md`）。落地格式是带 YAML frontmatter 的 Markdown（用 `gray-matter` 解析），写操作都排进 `writeQueue` 串行执行避免并发写坏文件。这一层与 `codex.ts` 里的草稿生成配合：浏览器先调 `/agent/codex/skills/draft` 让 Codex 生成草稿 JSON，用户确认后再调 `POST /agent/codex/skills` 落地成真正的 Skill 文件。

## 3. 前端（`web/src/`）

### 3.1 状态管理：`use-agent-store.ts`

zustand store，是整个前端 Agent UI 的单一状态源。几个模块级变量（`agentSource: EventSource`、`connectTimer`）故意放在 store 外部而不是 state 里，因为它们是"连接对象"而不是"可序列化状态"，由 `LocalAgentPanel` 里的 `useEffect` 生命周期管理。

关键状态分组：

- **连接**：`url`/`token`（持久化到 `localStorage`）、`connected`/`enabled`/`silentConnect`/`fragmentBootstrap`。
- **对话内容**：`messages: AgentChatItem[]`、`eventLogs`（保留最近 160 条，用于调试日志面板）、`tokenUsage`。
- **会话/线程**：`threads`、`activeThreadId`、`activeTurnId`、`conversation: AgentConversationState`（与后端 `ConversationState` 的字段一一对应）。
- **模型与权限**：`models`、`model`、`reasoningEffort`、`permissionMode`（`request`/`automatic`/`full`，持久化）、`confirmTools`（画布写操作是否需要二次确认，见 4.2）。
- **待处理项**：`pendingTool: AgentPendingToolCall | null`（画布二次确认）、`pendingApprovals: AgentPendingApproval[]`（Codex 原生权限请求）。
- **画布桥接**：`canvasContext: AgentCanvasContext | null`，由 `useAgentBridge` 注入（见 3.2）。

`connectAgent`/`disconnectAgent` 只负责校验 URL/token 格式并切换 `enabled` 标志；真正的 `EventSource` 创建/销毁是 `LocalAgentPanel` 的副作用，store 本身不直接持有连接逻辑，这样 store 可以在没有 DOM/浏览器 API 的环境下被安全导入（例如测试）。

### 3.2 画布桥接：`use-agent-bridge.ts` + `canvas-agent-ops.ts`

`canvas-agent-ops.ts` 定义前端侧的 `CanvasAgentOp` 联合类型（与后端 `canvasOpSchema` 字段对齐但更宽松——前端信任已经过后端 zod 校验的输入），核心是纯函数 `applyCanvasAgentOps(snapshot, ops)`：按顺序 reduce 出新的 `{nodes, connections, selectedNodeIds, viewport}`，不产生副作用。

`use-agent-bridge.ts` 的 `useAgentBridge` hook 在画布页面挂载，做两件事：

1. 把当前画布 React state（`nodes`/`connections`/`selectedNodeIds`/`viewport`）打包成 `agentSnapshot`，通过 `setCanvasContext` 注入 `use-agent-store`，让 Agent 侧随时能读到画布现状（这个 snapshot 也是 `POST /canvas/state` 上报给后端的内容）。
2. 暴露 `applyAgentOps(ops)`：
   - 用 `nodesRef`/`connectionsRef`/`selectedNodeIdsRef`/`viewportRef` 这组 ref 保存"操作前"的快照到 `agentUndoSnapshot`（只保留一步，新的 apply 会覆盖旧的 undo 点）。
   - 用 `applyCanvasAgentOps` 计算新状态，同步写回 refs 和真正的 React state。
   - 特殊处理 `run_generation`：这类 op 不能用同步 reducer 处理（触发生成是异步 IO），过滤出来后用 `queueMicrotask` 单独调用 `generateNodeRef.current(nodeId, mode, prompt)`，prompt 默认取节点已有的 `composerContent`/`prompt` metadata。
   - `undoAgentOps()` 直接把 refs/state 还原成 `agentUndoSnapshot`。

### 3.3 连接生命周期与 SSE 处理：`local-agent-panel.tsx`

这是前端最大的单个文件，承担"建立连接 + 派发所有 SSE 事件 + 驱动 UI"。核心结构：

- `AGENT_PROTOCOL_VERSION = 6`，与后端 `canvas/session.ts` 的常量必须一致；`hello` 事件里版本不匹配会强制断开并要求用户升级 Canvas Agent（`agentOutdated` 文案），这是前后端协议演进的硬门槛，不做向后兼容降级。
- 连接方式支持两种引导：
  1. 手动填地址/token，调用 `toggleAgentConnection`，内部会先试 `discoverAgentConfig`（GET `/config`）自动探测本机 Agent。
  2. URL fragment 引导：`agentUrl`/`agentToken` 写在 `#hash` 里（`agent-url-bootstrap.ts` 解析），典型场景是 Codex app 插件打开画布页面时直接带上这两个参数，网页 `useLayoutEffect` 检测到就自动填充并静默连接（`silentConnect: true`），同时清理掉 URL 上的敏感 fragment 参数。
- **SSE 事件队列化（`enqueueEvent`）**：除 `hello`/`tool_call` 外的大多数事件（`agent_event`、`codex_state` 等）不是收到就立即处理，而是 `.then()` 串进一条 `eventQueue` Promise 链，且每次执行前检查 `isCurrentConnection()`。这保证：(a) 事件按到达顺序严格串行处理，不会因为异步操作交错而导致状态乱序；(b) 一旦当前 EventSource 被替换（比如用户重新连接），旧连接排队中的回调会被静默跳过，不会污染新连接的状态。
- **鉴权/一致性事件**：`hello` 处理里会读取服务端返回的 `conversation` 快照来决定 UI 的 `activity` 文案（`awaitingApproval`/`codexRunning`/`connected`），并且如果服务端没有活跃线程会自动触发 `/agent/codex/threads/reset` 去新建一个草稿线程。
- **历史回放去重（`liveTurnKeysRef`/`authoritativeHistoryTurnsRef`/`registerLiveAgentTurn`）**：SSE 实时事件和 REST 拉取的历史消息（`readCodexThread` 返回的 `settledTurnIds`）可能对同一个 turn 都有描述，`isCurrentThreadEvent`/`registerLiveAgentTurn` 负责判断一个实时事件是否已经被权威历史覆盖，避免同一条消息重复渲染或被旧状态覆盖新状态。

### 3.4 工具调用执行与二次确认（4.2 节详细展开，此处列代码位置）

`handleToolCall` → `runToolCall` → 按工具名分派：

- `site_navigate`：调用 react-router `navigate`。
- `canvas_apply_ops`：`canvasContextRef.current.applyOps(ops)`（即 3.2 节的桥接函数），并 `postState` 把结果回传同步给后端。
- `canvas_create_attachment_nodes`：先把 `payload.input.nodes`（服务端 `createAttachmentNodes` 算好的坐标/尺寸）转成真正的画布图片节点 ops，再走同一个 `applyOps`。
- 其它站点工具：`isSiteTool(name)` 判断后交给 `runSiteTool`（本地 zustand/localforage 操作，见 3.6）。

不管哪条分支，最终都通过 `postToolResult(endpoint, token, clientId, {requestId, result|error})` 回传给后端，后端凭 `requestId` 唤醒 `CanvasSession.requestCanvasTool` 里挂起的 Promise。

### 3.5 双层审批/确认机制

这是设计上容易混淆但职责分离清晰的两套机制：

**a) `pendingApprovals`（Codex 原生权限请求）**

对应 Codex app-server 主动发起的 `item/commandExecution/requestApproval` 等 JSON-RPC 请求（执行 shell 命令、改文件等）。前端收到 SSE `codex_approval` 事件后加入 `pendingApprovals` 列表，用户三选一：

- `accept`：本次批准
- `acceptForSession`：本次会话内都批准（对应 app-server `scope: "session"`）
- `decline`：拒绝

决策通过 `decideApproval` → `postCodexApproval` → `POST /agent/codex/approval` → `CodexAppClient.resolveApproval` 完成，采用乐观更新（先标记 `deciding`），失败时区分"请求已失效"（静默移除）和真正失败（回滚状态、toast 报错）。

**b) `pendingTool`（画布写操作二次确认）**

只对 `isCanvasWriteTool(name)`（即 `canvas_apply_ops`、`canvas_create_attachment_nodes`）生效，且只在用户主动开启 `confirmTools` 开关时才拦截；默认是自动确认（对应文档 `local-codex-canvas.mdx` 里"Writes are automatically confirmed by default"）。拦截后不会自动执行，`payload` 存入 `pendingTool`，UI 展示待确认卡片，用户点击后：

- `approvePendingTool`：清空 pending，调用 `runToolCall` 真正执行。
- `rejectPendingTool`：直接 `postToolResult` 回一个 `error: "canvasToolCanceled"`。

这两套机制的关系：`pendingApprovals` 管的是"Codex 要不要执行某个动作"（执行层面的安全闸门，由 Codex/app-server 的沙箱策略决定何时触发），`pendingTool` 管的是"画布已经决定要写，但用户想在真正生效前看一眼"（结果层面的用户确认，纯前端开关控制）。两者可以同时存在——一次 turn 里既可能有 shell 命令审批，也可能有画布写操作确认。

### 3.6 站点工具执行（`agent-site-tools.ts`）

区别于 `canvas_*` 系列（依赖画布快照+SSE round-trip），这 9 个工具（`canvas_list_projects`、`generation_get_status`、`workbench_image/video_*`、`prompts_search`、`assets_*`）完全在浏览器本地状态里执行，不需要通过后端转发画布操作：

- `canvas_list_projects`：读 `useCanvasStore` 里 localforage 持久化的项目列表，支持关键字过滤+分页。
- `workbench_image_generate`/`workbench_video_generate`：直接修改 `useConfigStore` 里的生成参数配置，`navigate` 跳转到对应工作台页面，再调用 `useWorkbenchAgentStore.dispatchImage/dispatchVideo` 排队生成任务，返回 `taskId` 供后续 `generation_get_status` 查询。
- `generation_get_status`：合并画布节点的生成状态（`idle/loading/success/error` 映射为 `idle/running/succeeded/failed`）和工作台任务队列状态，统一格式返回，支持按 `scope`/`taskId`/`nodeIds` 过滤。
- `assets_add`（图片）：调用 `uploadImage` 走图片存储服务，失败时明确抛"图片读取失败"错误而不是静默吞掉。

这一层的存在解释了为什么"生图工作台""视频工作台""素材库"这些与画布无关的功能也能被 Agent 操作——它们不是画布概念，而是挂在同一套工具协议下的站点级能力。

## 4. 数据流全景：以"用户在侧边栏发一句话生成一张图"为例

1. 用户在 `AgentChatComposer` 输入，前端组装 `POST /agent/codex/turn`，带 `prompt`、`threadId`、`conversationId`、`expectedRevision`、`clientId`、附件等。
2. 后端 `codexMutation` 上锁，一致性校验通过后，`session.markConversationRunning` + `setCodexState({busy:true})`，随后异步调用 `runCodexTurn`（不阻塞 HTTP 响应，响应先返回 `{ok:true, threadId}`）。
3. `runCodexTurn` 排进 `codexQueue`，`ensureCodexThread` 确认/恢复线程，`app.startTurn` 发出 `turn/start` JSON-RPC。
4. Codex 模型决定调用 `canvas_generate_image` 工具（MCP 工具调用），走到 `CodexSession.callTool`。
5. `callTool` 识别为非站点工具，`buildCanvasToolRequest` 把它转换成 `{name: "canvas_apply_ops", input: {ops: [...]}}`（含文本节点、配置节点、连线、`run_generation`）。
6. `requestCanvasTool` 通过 SSE `tool_call` 事件推给当前绑定的浏览器标签页，挂起等待。
7. 浏览器 `local-agent-panel.tsx` 的 `tool_call` 监听器收到事件 → `handleToolCall`：因为是写操作且 `confirmTools` 默认关闭，直接 `runToolCall` → `canvasContext.applyOps(ops)`（`use-agent-bridge.ts`）→ React state 更新，画布上出现新节点；其中 `run_generation` 那条 op 单独触发真正的图片生成请求。
8. `postState` 把更新后的画布快照回传给后端，`postToolResult` 回传工具调用结果，唤醒后端挂起的 Promise。
9. `CodexAppClient` 收到 MCP 工具响应，继续模型的下一步；Codex 侧的流式文本/状态事件通过 `agent_event`/`codex_state` SSE 持续推给前端，驱动聊天气泡的实时更新。
10. `turn/completed` 到达后，后端先把 turn 写入补充历史（`codexEventHistory.recordTurn`），再广播终态事件、释放 `boundClientId`、`setCodexState({busy:false})`。

全程浏览器始终是"最终执行者"，Canvas Agent 是"协议翻译与状态仲裁者"，Codex 是"决策者"。

## 5. 安全边界小结

- 网络面：仅监听 `127.0.0.1`；跨域用 token 换 Origin 白名单，不支持匿名或多 Origin 共享同一 Agent。
- 凭证面：本地配置文件严格权限（0600/0700）；`canvas.best` 等托管网站不落地任何本机凭证。
- 沙箱面：Codex 线程的 `approvalPolicy`/`sandbox` 由前端 `permissionMode`（`request`/`automatic`/`full`）驱动，`full` 模式（危险的完全访问）在前端切换时会弹确认对话框（`changePermissionMode`）。
- 内容面：Skill 草稿生成走独立的只读、禁网络、`ephemeral: true` 静默线程，产物过两轮敏感信息过滤（生成前的画布快照清洗 + 生成后的正则/私有值扫描）。
- 交互面：画布写操作有独立于 Codex 沙箱审批之外的可选二次确认（`confirmTools`），且始终保留一步撤销（`agentUndoSnapshot`）。

## 6. 扩展入口一览

| 场景 | 关键文件 |
|---|---|
| 新增一个 canvas_* 工具 | `canvas-agent/src/canvas/schemas.ts`（zod schema + 描述）→ `operations.ts`（如需转换成 apply_ops）或 `session.ts`（如需特殊分派） |
| 新增一个站点级工具（不涉及画布） | `schemas.ts` 加名字 → `session.ts` 的 `SITE_TOOLS` 集合 → 前端 `agent-site-tools.ts` 实现执行逻辑 |
| 修改 Agent 系统提示词 | `canvas-agent/agent-instructions.md`（同时作为 MCP `instructions` 和站点工作空间 `AGENTS.md`） |
| 新增一种 SSE 事件类型 | 后端 `emit`/`emitThread` 调用点 → 前端 `local-agent-panel.tsx` 的 `source.addEventListener` |
| 调整画布操作语义 | 前端 `canvas-agent-ops.ts`（`CanvasAgentOp` 类型 + `applyCanvasAgentOps`）与后端 `canvas/schemas.ts` 的 `canvasOpSchema` 需保持字段同步 |
