# AGENTS.md

本文件适用于 `/root/workspace/operit-honcho` 及其全部子目录。后续编码代理在修改仓库前必须先阅读本文件、`docs/ARCHITECTURE.md` 和与任务相关的计划文档。

## 1. 项目目标

本仓库维护 `com.operit.honcho` Operit ToolPkg，提供：

- Honcho v3 消息持久化与跨会话记忆。
- 自动 Context/dialectic 注入。
- Hermes 兼容的五个 Honcho 工具。
- 计划中的 Operit 主侧边栏 `Honcho Explore` 面板。

保持插件在 Honcho 故障时 fail-open，不得让记忆服务错误阻塞正常聊天。

## 2. 先读资料

开始工作前按顺序阅读：

1. `docs/ARCHITECTURE.md`
2. `README.md`
3. UI 任务额外阅读 `docs/EXPLORE_UI_PLAN.md`
4. Operit ToolPkg 类型：`/root/workspace/types/toolpkg.d.ts`
5. Compose UI 任务额外阅读 `/root/workspace/types/compose-dsl.d.ts`

正式开始新的 Sandbox Package/ToolPkg 开发任务前，按 `SandboxPackage_DEV` Skill 更新本地 guide、types 和 examples。接口以最新类型和示例为准，不凭记忆猜测。

Honcho API 路径、分页和字段以实现时最新 v3 OpenAPI 为准：

- `https://honcho.dev/docs/llms.txt`
- `https://honcho.dev/docs/v3/api-reference/`

## 3. 常用命令

```bash
cd /root/workspace/operit-honcho
npm test
npm run pack
```

- `npm test`：清理、TypeScript 编译、METADATA 恢复和 Node tests。
- `npm run pack`：重复测试并生成 `build/operit-honcho-0.1.0.toolpkg`。
- 不手工编辑 `dist/` 或 `build/`。
- 不提交 `dist/`、`build/`、`node_modules/`、日志或 `.toolpkg` 产物。

## 4. 当前模块边界

- `src/config.ts`：只负责环境变量解析、默认值和配置签名。
- `src/api.ts`：只负责 Honcho REST、DTO 映射和服务端约束。
- `src/controller.ts`：负责每 Chat 状态、自动注入、写队列、去重和工具操作语义。
- `src/format.ts`：负责 memory block 清理、格式化和预算。
- `src/main.ts`：只做 ToolPkg 注册、Hook/IPC 入口和 fail-open 边界。
- `src/runtime.ts`：在每个 main/sandbox 执行上下文内提供 Controller 入口；实例不跨 JS engine 共享。
- `src/packages/honcho.ts`：只保留 METADATA、参数规范化和五个工具导出。
- `src/explorer/`：未来 Explorer 领域服务、IPC DTO 和校验。
- `src/ui/honcho_explore/`：未来 Compose DSL UI 和纯 UI 状态。

不要把 HTTP 路径拼接放进 UI，不要把 Compose Node 构造放进 API/Controller，也不要让子包工具复制 Controller 逻辑。

## 5. 配置规则

插件通过 Operit `getEnv()` 读取 `HONCHO_*`，不读取仓库 `.env` 或 JSON 配置文件。

最小配置：

```text
HONCHO_API_KEY=<key>
HONCHO_WORKSPACE=<workspace>
```

要求：

- 不在源码、测试、文档、命令输出或 Git 中写入真实 API Key。
- 测试 fixture 只能使用明显的假值，例如 `test-key`。
- UI 不得显示、缓存或通过 IPC 返回 API Key。
- 日志不得输出 Authorization header。
- 配置改变后沿用 Controller 的签名刷新机制。
- 浏览 Workspace 与 Hook 的活跃 Workspace 必须区分，不能因 UI 浏览而静默改变写入目标。

## 6. Honcho 领域规则

- Session ID 最长 100 字符，继续使用确定性 sanitize + hash 规则。
- Cloud 单条 Message 内容最长 25,000 字符，超限必须分块。
- 所有路径 ID 使用 `encodeURIComponent`。
- 只读列表/详情操作不得隐式创建 Workspace、Peer 或 Session。
- 现有五工具可以保留 get-or-create 语义；Explorer 通用浏览 API 必须分离。
- Workspace Message Search 按发送者过滤时使用 `filters.peer_id`，不要使用 `peer_perspective`。
- Conclusion 的 observer、observed 和 session scope 必须显式建模。
- `401`、`403`、`404` 和可重试网络错误应保持可区分。

## 7. 消息与注入规则

- 只保存 `message_persisted` 的完成消息。
- 写入异步执行，不 await 在聊天 Hook 上。
- 保持 `seen` + `inFlight` 双重去重。
- 同一 Chat 只允许一个 drain；失败项成功前不得从队列永久移除。
- 从消息内容和用户输入中移除已有 `<memory-context>`。
- 不修改持久化聊天内容，只修改本次 `processedInput`。
- 系统提示只使用稳定、短小的模式标记。
- Context 和 dialectic 请求失败时复用可用缓存或跳过注入。

## 8. ToolPkg 与 METADATA

`src/packages/honcho.ts` 顶部 `/* METADATA ... */` 是 Operit 发现工具的必要内容。

TypeScript 会移除该注释，因此：

- 保留 `scripts/preserve-metadata.mjs`。
- 修改工具名或顺序时同步修改 METADATA 校验。
- 工具函数直接返回 `Promise<JsonRecord>`。
- 不依赖 detached `complete()` 回调返回结果。
- 子包工具捕获错误并返回 `{ success: false, error }`。

每次打包后检查 `.toolpkg` 至少包含：

```text
manifest.json
dist/main.js
dist/packages/honcho.js
```

并确认 `dist/packages/honcho.js` 中仍有 METADATA。

## 9. Explore UI 规则

实现 UI 前先阅读 `docs/EXPLORE_UI_PLAN.md`。核心约束：

- Explore 作为现有 ToolPkg 的 `compose_dsl` UI route 实现，不创建第二套鉴权客户端。
- 使用 `ToolPkg.registerNavigationEntry`，`surface` 为 `main_sidebar_plugins`。
- UI 与 main 是不同 JS engine；共享状态和 API 调用必须走 `ToolPkg.ipc`。
- IPC 只允许固定 operation allowlist 和 JSON 可序列化 DTO。
- API Key 只留在 main。
- 初次加载使用 `hasLoaded + inFlight` guard，不假设存在 React `useEffect`。
- 网络请求使用 request ID，过时响应不得覆盖新状态。
- Peer、Session、Message 和 Conclusion 列表必须服务端分页。
- 大列表使用 `LazyColumn`，不要一次拉取全部数据。
- Search 由用户明确提交，不在每个字符变化时请求网络。
- Loading、Empty、Error、Permission Denied 和 Partial Data 必须有页面内状态。
- Toast 只用于短反馈，不代替错误页面。

视觉要求：

- 使用 Operit `MaterialTheme` 和现有 Compose DSL 组件。
- 面板是紧凑工作台，不做营销 Hero。
- 主导航用 Tabs，模式/范围用 segmented control，熟悉命令用图标按钮。
- Card 只用于单个重复实体或明确工具，不嵌套 Card，圆角不超过 8dp。
- 长 ID、长单词和消息必须换行或省略，不得溢出或遮挡。
- toolbar、tabs、icon buttons、loading placeholders 使用稳定尺寸。
- 删除等危险操作必须二次确认。

## 10. 测试要求

测试强度随改动范围增加。

### 修改配置、格式或单个 API 方法

- 增加或更新对应 mocked transport 测试。
- 运行 `npm test`。

### 修改 Controller、Hook、IPC 或共享契约

- 覆盖成功、失败、重试、去重和配置刷新。
- 验证旧五工具和 Hook 注册不回归。
- 运行 `npm test` 和 `npm run pack`。

### 修改 Explore UI

- 测试纯 format/state/helper。
- 测试 IPC operation、参数校验和错误 DTO。
- 使用 Operit `debug_install_toolpkg` 真机安装。
- 验证主侧边栏入口、首次加载、刷新、返回、分页和错误重试。
- 在手机竖屏、横屏和可用宽屏上截图检查文字溢出、重叠、空白和布局跳动。

### 真实 Honcho 验证

- 只使用明确的 `test` Workspace。
- API Key 只通过临时进程环境或 Operit 已授权环境注入。
- 不把 Key 放进脚本文件。
- 创建的临时 Conclusion 等数据在测试结束后清理。
- Search 必须用已知 Message 做真实命中验证。

## 11. Git 与发布

- 工作树可能已有用户改动，禁止回滚不属于当前任务的内容。
- 不使用 `git reset --hard` 或 `git checkout --` 清理工作树。
- 提交前运行 `git diff --check`、测试和必要的打包。
- 提交前使用 `rg -n 'hch-v3-[A-Za-z0-9]{20,}'` 等规则扫描凭据，确认仓库没有真实密钥。
- 提交保持单一目的，文档、修复和 UI 阶段可以分开提交。
- 推送前确认 `main` 与 `origin/main` 的关系。
- 发布版本时同步更新 `manifest.json`、`package.json`、README、产物名、tag 和 Release notes。

## 12. 完成定义

代码任务不能只停留在实现。至少满足：

- TypeScript 编译通过。
- 相关自动测试通过。
- `git diff --check` 通过。
- ToolPkg 结构和 METADATA 校验通过。
- 涉及宿主能力时完成 Operit 调试安装验证。
- 涉及真实 API 契约时完成 `test` Workspace 最小验证。
- 文档与实际行为一致。
- 未提交密钥、生成目录或临时文件。

当前下一阶段是 `docs/EXPLORE_UI_PLAN.md` 的 Phase 1：只读 Explorer API、DTO、IPC、主侧边栏入口和基础列表。