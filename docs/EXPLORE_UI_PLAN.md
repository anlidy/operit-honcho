# Operit Honcho Explore 侧边栏实施计划

状态：**计划中，尚未实现 UI 运行时代码**。

本文规划在现有 `com.operit.honcho` ToolPkg 内增加 Operit 主侧边栏 Explore 面板，目标是在移动端可用的 Compose DSL 界面中复现 Honcho 官方 Explore 的核心管理和诊断能力。

官方参考：

- [Honcho Dashboard documentation](https://honcho.dev/docs/v3/documentation/reference/platform)
- [Honcho Explore dashboard](https://app.honcho.dev/explore)（需要登录）
- [Honcho v3 API Reference](https://honcho.dev/docs/v3/api-reference/introduction)
- 本地 Operit ToolPkg Guide 与 `worldbook.toolpkg` Compose DSL 示例

## 1. 架构决定

### 1.1 UI 放在现有 ToolPkg，而不是建立第二个包

侧边栏将作为同一个 `com.operit.honcho` ToolPkg 的 UI route 和 navigation entry 实现。

原因：

- 复用同一组 `HONCHO_*` 环境变量。
- 复用现有 `HonchoApi`、ID 规范和错误处理。
- 自动 Hook、五个工具和 Explore 面板不会产生协议漂移。
- 安装、启用、版本和发布只维护一个产物。
- API Key 只在 main 上下文中使用，UI 不需要持有或传递密钥。

它在用户体验上仍是一个独立的“Honcho Explore”侧边栏面板，但在工程上属于现有包。

### 1.2 UI 通过 IPC 调用 main

Operit ToolPkg 的 `main` 与每个 Compose DSL UI route 使用不同 JS engine。模块顶层变量不会跨上下文共享，因此 UI 不直接导入并操作 main 中的 Controller 实例。

计划链路：

```text
Compose DSL UI
  -> ToolPkg.ipc.call("honcho.explorer.request", payload)
  -> main IPC handler
  -> ExplorerService / HonchoApi
  -> Honcho v3 REST API
  -> JSON DTO
  -> UI state
```

IPC 只传输普通 JSON。错误统一返回结构化对象，UI 不解析异常堆栈。

## 2. 目标与边界

### 2.1 第一版目标

- 从 Operit 主侧边栏直接进入 `Honcho Explore`。
- 展示当前连接状态、活跃 Workspace 和处理队列概况。
- 浏览 Workspace、Peer、Session、Message 和 Conclusion。
- 支持 Workspace、Peer、Session 和 Conclusion 范围的搜索。
- 查看 Peer Card、Representation、Session Context 和 Session Summary。
- 调用 Peer Chat/dialectic 进行诊断。
- 创建和删除 Conclusion。
- 在 Session 中添加测试 Message。
- 支持分页、刷新、空状态、错误重试和加载状态。
- 不影响现有自动记忆 Hook 和五个工具。

### 2.2 第一版不做

- 不复制 Honcho Cloud 的 Billing、成员、API Key 和实例升级页面。
- 不在 UI 中显示完整 API Key。
- 不实现 Honcho 后端未提供的 Message/Conclusion 任意编辑能力。
- 不默认允许批量删除 Workspace、Session 或生产数据。
- 不把远程数据同步到本地数据库。
- 不在输入过程中自动发起搜索；由用户明确提交搜索，避免竞态和额外费用。

## 3. 官方 Explore 功能映射

| 官方区域 | Operit 面板实现 | 第一版优先级 |
| --- | --- | --- |
| Explore Workspace 列表 | Workspace 选择器与概览列表 | P1 |
| Workspace Dashboard | 统计、Peer/Session 最近项、队列状态 | P0 |
| Peer 列表和详情 | Peer 列表、Card、Representation、Metadata、Sessions | P0 |
| Peer Message Search | Peer 范围消息搜索 | P0 |
| Peer Chat | 查询 Representation，可选 Session scope | P1 |
| Session 列表和详情 | Session 列表、Peers、Metadata、消息时间线 | P0 |
| Session Message Search | Session 范围消息搜索 | P0 |
| Session Context | token 可调的 Context 预览 | P0 |
| Session Peer Config | 观察配置查看；编辑放到 P2 | P1/P2 |
| Conclusions | 列表、语义搜索、创建、删除 | P0 |
| Workspace Config | Metadata/配置查看；编辑放到 P2 | P1/P2 |
| API Playground | 不复制；以 Explore 操作为主 | 不做 |
| Webhooks/Members/Billing | Cloud 管理能力，不属于记忆 Explore | 不做 |

P0 表示首个可用版本必须完成，P1 表示功能对齐增强，P2 表示受保护的管理操作。

## 4. 信息架构

### 4.1 主入口

在 `src/main.ts` 注册：

```ts
ToolPkg.registerUiRoute({
  id: "honcho_explore",
  route: "toolpkg:com.operit.honcho:ui:honcho_explore",
  runtime: "compose_dsl",
  screen: honchoExploreScreen,
  keepAlive: true,
  title: { zh: "Honcho Explore", en: "Honcho Explore" },
});

ToolPkg.registerNavigationEntry({
  id: "honcho_explore_sidebar",
  route: "toolpkg:com.operit.honcho:ui:honcho_explore",
  surface: "main_sidebar_plugins",
  title: { zh: "Honcho Explore", en: "Honcho Explore" },
  icon: Icons.Book,
  order: 220,
});
```

同时可选注册 `toolbox` 入口，方便从工具箱打开同一路由，但主入口是 `main_sidebar_plugins`。

### 4.2 顶层结构

面板使用紧凑的工作台布局，不使用营销式 Hero，也不把页面区段做成层层嵌套卡片。

```text
Top App Bar
  Honcho Explore | connection status | refresh

Workspace Bar
  active workspace selector | queue indicator | search

Primary Tabs
  Overview | Peers | Sessions | Conclusions

Content
  list / detail / search results / loading / error / empty state
```

主导航使用 Tab；模式和范围使用 segmented control；刷新、搜索、返回、删除等使用 Material/Lucide 等价图标按钮并提供可访问标签。

### 4.3 Overview

展示：

- 连接状态、Base URL 主机名、配置是否完整。
- 当前活跃 Workspace。
- User Peer、AI Peer、recall mode、session strategy。
- Peer 数、Session 数、待处理/处理中任务数。
- 最近 Peer 和最近 Session 的紧凑列表。
- Controller 本地待写消息数和最近写入错误。

不显示 API Key，只显示“已配置/未配置”。

### 4.4 Peers

列表行包含：

- Peer ID。
- Metadata 摘要。
- 关联 Session 数。
- 配置/观察状态摘要。

Peer Detail 使用内部 Tab：

- `Profile`：Peer Card、Representation、Metadata、Configuration。
- `Sessions`：该 Peer 参与的 Session。
- `Search`：跨 Session 的 Peer Message Search。
- `Chat`：查询 Peer Representation，可选 Session scope 和 reasoning level。
- `Conclusions`：以该 Peer 为 observed/observer 的 Conclusion。

Peer Card 可在明确进入编辑态后整体保存。保存前显示“覆盖整个 Card”的提示，避免误以为是追加。

### 4.5 Sessions

列表行包含：

- Session ID。
- 创建/更新时间。
- Peer 数、Message 数或可取得的摘要指标。
- Metadata 摘要。

Session Detail 使用内部 Tab：

- `Messages`：按时间排列的消息列表，可按 Peer 过滤，支持分页和添加测试消息。
- `Search`：只搜索当前 Session。
- `Peers`：成员和 Session-Peer Configuration。
- `Context`：token 上限输入、Summary、Representation、Card 和最近消息预览。
- `Summaries`：可用 Summary 列表。
- `Metadata`：Session metadata/configuration。

消息气泡仅表达 author 和内容，不模仿聊天应用的大面积装饰；重点是扫描时间、Peer、ID 和原始内容。

### 4.6 Conclusions

顶层 Conclusion 页面提供：

- 普通分页列表，默认按最近时间排序。
- 语义搜索。
- Observer、Observed、Session 过滤。
- 创建 Conclusion。
- 单条删除，必须二次确认。
- 展示 Conclusion ID、content、observer、observed、session 和时间。

当前工具语义默认 `AI Peer -> User Peer`。Explore 页面需要支持通用过滤，不能强制套用工具的 observer/target 默认值。

### 4.7 Search

搜索使用范围选择：

- Workspace Messages
- Peer Messages
- Session Messages
- Conclusions

流程：

1. 用户选择 scope。
2. 输入 query。
3. 点击搜索图标或提交按钮。
4. UI 为该请求生成递增 request ID。
5. 只应用最后一次请求的结果，防止慢请求覆盖新结果。
6. 结果行可跳转到对应 Peer、Session 或 Conclusion 详情。

## 5. 计划目录

```text
src/
├── api.ts
├── controller.ts
├── main.ts
├── explorer/
│   ├── service.ts               # Explorer 领域操作、权限和 DTO 映射
│   ├── types.ts                 # IPC request/response 与 UI DTO
│   └── validation.ts            # op、分页、过滤和危险操作校验
└── ui/
    └── honcho_explore/
        ├── index.ui.ts           # Screen、路由状态和主布局
        ├── components.ts         # App bar、tabs、rows、empty/error/loading
        ├── overview.ts           # Overview renderer/actions
        ├── peers.ts              # Peer list/detail utilities
        ├── sessions.ts           # Session list/detail/messages/context
        ├── conclusions.ts        # Conclusion list/search/create/delete
        ├── search.ts             # 跨域 Search UI
        ├── state.ts              # 纯状态 reducer/helper
        └── format.ts             # 时间、ID、内容和错误显示

tests/
├── core.test.js
├── explorer-api.test.js
├── explorer-ipc.test.js
└── explorer-ui.test.js
```

文件可在实现时按实际复杂度合并，但不得把 API、IPC、状态和 2,000 行以上 UI 全部堆入 `index.ui.ts`。

## 6. 数据访问设计

### 6.1 扩展 `HonchoApi`

新增面向 Explore 的通用方法：

```text
Workspace
  listWorkspaces, getWorkspace, createWorkspace, updateWorkspace
  getQueueStatus

Peer
  listPeers, getPeer, createPeer, updatePeer
  getPeerSessions, getPeerRepresentation
  searchPeer, chatPeer

Session
  listSessions, getSession, createSession, updateSession
  deleteSession
  listSessionPeers, addSessionPeers, removeSessionPeers
  getSessionPeerConfig, setSessionPeerConfig
  listMessages, getMessage, addMessages
  searchSession, getSessionContext, listSessionSummaries

Conclusion
  listConclusionsGeneric, queryConclusionsGeneric
  createConclusionsGeneric, deleteConclusion
```

所有路径、分页字段和响应结构必须以实现时最新 Honcho OpenAPI 为准，不凭旧 SDK 记忆猜测。

### 6.2 分离工具语义与 Explore 语义

现有 `getProfile/search/reason/listConclusions` 带有 Operit 默认 Peer 和观察方向语义，继续服务五个工具。

Explorer 使用更通用的方法：

- 显式接收 workspace、peer、session、observer、observed。
- 不静默创建只读操作所查询的资源。
- 不把“列表不存在”转换成自动创建。
- 返回原始 ID、时间、metadata 和分页信息。

这可以避免打开 UI 时意外创建 Peer 或 Session。

### 6.3 IPC 契约

建议只注册一个受控 RPC channel：

```ts
interface ExplorerRequest {
  op: ExplorerOperation;
  requestId: string;
  workspaceId?: string;
  params?: Record<string, JsonValue>;
}

interface ExplorerResponse<T = JsonValue> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
  };
}
```

`ExplorerOperation` 使用固定字符串联合类型，不允许 UI 传任意 URL、HTTP method 或 headers。

main 注册：

```ts
ToolPkg.ipc.on("honcho.explorer.request", handleExplorerRequest);
```

UI 调用：

```ts
const response = await ToolPkg.ipc.call("honcho.explorer.request", request);
```

### 6.4 配置与 Workspace 选择

- Hook 写入目标始终由 `HONCHO_WORKSPACE` 决定。
- Explore 可以浏览 API Key 权限范围内的其他 Workspace。
- 仅浏览其他 Workspace不会修改 Hook 的活跃 Workspace。
- “设为活跃 Workspace”是独立明确操作，写入 `HONCHO_WORKSPACE` 后由 Controller 的配置签名机制热刷新。
- scoped key 无权列出全部 Workspace 时，UI 回退到当前配置 Workspace，不把权限错误显示成“没有数据”。

## 7. 状态、分页与并发

### 7.1 UI state

Compose DSL UI 使用 `ctx.useState`、`ctx.useRef` 和 `ctx.useMemo`。计划状态至少包括：

- 当前顶层 Tab 和 detail view stack。
- active/browsing workspace。
- Peer/Session/Conclusion 分页状态。
- search scope、query 和 filters。
- 每个请求的 loading/error/requestId。
- destructive action confirmation state。
- 已加载详情缓存和手动刷新版本。

Compose DSL 没有 React `useEffect` 语义。初次加载采用 `hasLoaded + inFlight` guard，在 render 中触发一次受控异步加载，沿用 Operit 内置 ToolPkg 的成熟模式。

### 7.2 分页

- 不一次性拉取全量消息和 Session。
- 默认 page size 为 20；Message 可为 30。
- 保留服务端 cursor/page/hasMore，不根据当前数组长度猜测总数。
- 切换 Workspace 或过滤器时清空旧分页状态。
- “加载更多”使用固定高度按钮/进度位，避免列表跳动。

### 7.3 缓存与刷新

- 只在 UI 实例内缓存列表和详情，不写本地磁盘。
- 返回列表时保留短期缓存；点击刷新强制重新请求。
- 发生创建/删除后，只失效相关列表和计数。
- main 可维护很短的 queue/status 缓存，但不能缓存 API Key 或把跨 Workspace 数据混用。

## 8. 视觉与交互规范

- 使用 Operit Compose DSL 和 MaterialTheme，不自行硬编码整套品牌色。
- 主色之外同时使用中性色、成功色和错误色，避免单一蓝紫色界面。
- 页面区段保持无框，Card 只用于单个重复实体或明确工具区域，不嵌套 Card。
- Card 圆角不超过 8dp；紧凑列表优先使用 divider 和选中态。
- 使用 `IconButton` 表达刷新、搜索、返回、复制、删除等熟悉命令。
- 所有危险操作需要文字确认区，不只依赖红色图标。
- 标题尺寸适合侧边栏，不使用 Hero 字号。
- ID、长单词和 Message 内容必须换行或省略，不得溢出。
- 固定 toolbar、tab、icon button 和 loading placeholder 尺寸，避免动态内容导致布局位移。
- Loading、Empty、Error、Partial Data 和 Permission Denied 都是正式状态，不用 Toast 代替页面状态。
- Toast 仅用于短暂操作反馈，例如复制成功或保存成功。

## 9. 安全与权限

- API Key 只通过 main 中的 `HonchoApi` 使用。
- UI 不回传、记录或展示 Key，只显示 `api_key_set: true/false`。
- 日志和错误信息不得包含 Authorization header。
- 删除 Session、Workspace 等高风险能力默认不在 P0 开放。
- Conclusion 删除采用两步确认，并在成功后清除确认状态。
- 所有 ID 在进入 URL 前编码，所有分页和 token 数值做上下限校验。
- scoped key 的 `401/403/404` 分开映射，便于判断认证、权限和不存在。
- 真实 API 测试只使用 `test` Workspace，并清理临时 Conclusion 等可删除数据。

## 10. 实施阶段

### Phase 0：文档与边界

状态：**已完成**。

- 当前架构文档。
- 仓库 `AGENTS.md`。
- Explore UI 功能映射、技术方案和验收标准。

### Phase 1：只读基础链路

- 增加 Explorer DTO 和 API 分页响应类型。
- 实现 status、Workspace、Peer、Session、Message、Conclusion 只读方法。
- 注册 `honcho.explorer.request` IPC。
- 注册 UI route 和 `main_sidebar_plugins` 入口。
- 完成 Overview、Peer list、Session list、Conclusion list。
- 增加 mocked transport 和 IPC 契约测试。

完成标志：侧边栏能在 `test` Workspace 浏览真实 Peer、Session、Message 和 Conclusion。

### Phase 2：详情与搜索

- Peer Profile/Representation/Sessions/Search。
- Session Messages/Peers/Context/Summaries/Search。
- Workspace Message Search。
- Conclusion semantic search 和过滤。
- 分页、请求竞态保护、空状态和权限错误。

完成标志：覆盖 Honcho 官方 Explore 的核心只读诊断路径。

### Phase 3：受控写操作

- 创建 Peer/Session。
- Session 添加 Peer、添加测试 Message。
- Peer Card 编辑。
- Conclusion 创建和删除。
- 可选“设为活跃 Workspace”。
- 明确确认状态、写后缓存失效和操作审计日志。

完成标志：在 `test` Workspace 完成创建、查看、搜索、删除的闭环。

### Phase 4：Peer Chat 与配置工具

- Peer Chat/dialectic，支持 Session scope 和 reasoning level。
- Workspace metadata/config 查看与受控编辑。
- Peer config、Session-Peer config 查看与受控编辑。
- Queue status 和诊断提示。

完成标志：达到官方 Peer/Session utilities 的主要效果。

### Phase 5：体验、验证与发布

- 中英文 i18n。
- 手机竖屏、横屏和宽屏布局检查。
- 大量 Message、长 ID、长单词和错误响应压力测试。
- 调试安装、路由入口和重载验证。
- 真实 Honcho `test` Workspace 端到端验证。
- 更新版本、README、截图、Git commit 和 GitHub Release 准备。

## 11. 测试策略

### 单元测试

- 每个新 API 方法的 method/path/body/query 映射。
- 分页、空数组、缺字段和错误响应解析。
- Explorer operation allowlist 和参数校验。
- DTO 不包含 API Key 或 Authorization。
- UI format/reducer/filter helper。

### 集成测试

- UI IPC -> main handler -> mocked transport。
- 配置热刷新后请求切换 Workspace。
- scoped key 权限错误映射。
- 创建/删除后缓存失效。
- 旧五工具与 Hook 注册不回归。

### 真机验证

- `debug_install_toolpkg` 后主侧边栏出现 `Honcho Explore`。
- 首次打开、返回、再次打开和 keepAlive 行为正确。
- `test` Workspace 的 Peer、Session 和 Message 可见。
- 搜索能定位已知测试消息。
- Context、Reasoning 和 Conclusion 操作结果与直接 API 一致。
- 禁网/错误 Key 时页面显示可重试错误，聊天仍 fail-open。
- 截图检查无文字溢出、重叠、空白列表和不稳定布局。

## 12. 验收标准

第一版 Explore 面板只有同时满足以下条件才算完成：

- 主侧边栏入口可发现、可打开、可重复进入。
- 未配置时显示配置状态和所需变量，不崩溃。
- 正确读取当前 Workspace，且不会因浏览操作改变 Hook 写入目标。
- Peer、Session、Message、Conclusion 均可分页浏览。
- Workspace/Peer/Session Message Search 和 Conclusion Search 返回真实结果。
- Peer Card、Representation、Session Context、Summary 可查看。
- Conclusion 创建与删除有明确结果和确认流程。
- 所有网络错误结构化展示并可重试。
- API Key 不进入 UI state、日志、Git 或测试 fixture。
- 原有 8 项测试继续通过，并增加 Explore API/IPC/UI 测试。
- `npm run pack`、ZIP 校验和 Operit 调试安装通过。
- 在真实 `test` Workspace 完成端到端验证。

## 13. 主要风险

| 风险 | 应对 |
| --- | --- |
| Honcho API 分页/过滤字段版本变化 | 以最新 OpenAPI 为准，集中 DTO 映射并做契约测试 |
| UI 与 main 状态误认为共享 | 所有跨上下文数据走 `ToolPkg.ipc` |
| Compose DSL 缺少 effect/cancel API | 使用 inFlight guard 和 requestId 丢弃过时结果 |
| 大量消息导致性能问题 | 服务端分页、固定 page size、LazyColumn |
| scoped key 无法列出 Workspace | 回退当前 Workspace并显示权限说明 |
| 浏览其他 Workspace误改自动写入目标 | browsing workspace 与 active workspace 分离 |
| 写操作误删生产数据 | P0 只读，危险操作延后并二次确认 |
| UI 直接复用五工具导致信息不足 | 新增 Explorer 通用 API/IPC，不扭曲现有工具语义 |

## 14. 实施顺序结论

下一次进入编码阶段时，从 Phase 1 开始，不先做视觉壳。第一步应打通真实数据的只读 API、DTO 和 IPC，再注册最小侧边栏路由；只有 Overview、Peer、Session 和 Conclusion 列表真实可用后，才扩展详情、搜索和写操作。