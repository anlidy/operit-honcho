# Honcho Explore 数据一致性与体验修复计划

状态：**方案已确认，尚未开始实现**  
日期：2026-08-01  
适用范围：`com.operit.honcho` 自动消息持久化、五个 Honcho 工具和 `Honcho 探索` 侧边栏

本文针对真实 `test` Workspace 验收中发现的重复消息、思考/工具中间消息误上传、重复结论、Peer 身份错配、动态记忆破坏提示词前缀缓存、时区错误、缺少筛选与 Peer Card、参与者管理缺失及交互卡顿问题，定义修复边界、数据模型、迁移方式、实施顺序和验收标准。

本轮先完成设计，不在同一变更中修改运行代码或清理线上数据。

## 1. 问题确认

| 优先级 | 问题 | 确认结果 | 当前实现证据 |
| --- | --- | --- | --- |
| P0 | 会话出现大量重复 AI Message | **确认存在，根因需用 Hook 样本最终复现** | 去重 key 包含可能变化的 `timestamp/completedAt`，只保存在 JS 内存；配置刷新、ToolPkg 重载或进程重启后 `seen` 会丢失，服务端写入也没有幂等 key |
| P0 | 思考内容、工具调用和工具结果被当成普通 AI Message 上传 | **确认存在内容边界缺陷；具体 `displayMode` 值仍需 Hook 样本固化** | `message_persisted` 已提供 `displayMode`、变体和模型字段，但 `onChatMessage()` 全部丢弃；`resolveRole()` 仅用 `assistant/agent/ai/model` 宽泛正则，任何 assistant-like 持久记录都会进入 Honcho |
| P0 | Conclusion 大量重复，工具把 Session ID 当成 User Peer | **确认** | `operit_<chat-id>_<hash>` 是 Session ID 格式；工具允许任意 `peer` 字符串并会隐式创建该 Peer，没有校验它是否其实是 Session；重复 Message 还会放大 Honcho 自动提取的 Conclusion |
| P1 | 每轮动态记忆注入降低后续历史前缀缓存复用 | **确认** | 当前只改本轮 `processedInput`，没有持久保存实际 API 内容；下一轮历史恢复为干净用户文本，导致请求在上一轮用户消息的注入点发生前缀分叉 |
| P1 | User/AI Peer 不应要求用户手工配置环境变量 | **确认** | 当前身份来源是 `HONCHO_USER_PEER`、`HONCHO_AI_PEER`，Explore 只能读取，不能管理 |
| P1 | 观察方向应按实际 Peer 和名称动态显示 | **部分确认** | UI 已读取每条 Conclusion 的 `observer_id/observed_id`，并非把文字硬编码为 `user -> operit`；但只显示原始 ID，没有显示名解析，工具侧 `observerAndTarget()` 又固定以 AI Peer 为 observer |
| P1 | Conclusion 缺少 Peer/方向筛选 | **确认** | `list_conclusions` IPC 只有分页参数，API body 固定 `{}`，没有传 `observer_id`、`observed_id` 或 `session_id` filters |
| P1 | 时间没有转换到上海时区 | **确认** | `displayTime()` 仅替换 ISO 字符串中的 `T`，例如 `04:52Z` 被原样显示，而不是 `Asia/Shanghai` 的 `12:52` |
| P2 | 参与者页缺少 Peer Card 预览 | **确认** | 当前 `PeerDto` 只有列表字段，没有 Peer detail/Card IPC，也没有观察者与目标选择 |
| P2 | Session、Message、Conclusion 加载卡顿 | **确认存在结构性延迟，需增加耗时指标量化** | 每次切页先串行请求 `status`；`status` 又等待远端 queue，再请求列表。已有页面缓存也会在每次切换时强制失效和重载 |

## 2. 修复原则

1. 先停止新增脏数据，再增加管理能力和视觉优化。
2. Peer、Session、Message、Conclusion 使用不同的强类型 ID，不允许工具把 Session ID 当 Peer ID。
3. User/AI 是 Workspace 内的角色绑定，不是写死的 Peer ID，也不是要求用户手工维护的环境变量。
4. Peer ID 在 Honcho 中保持稳定；“修改名称”修改显示名，不伪装成修改远端 ID。
5. 所有远端写操作均通过 main IPC，UI 不接触 API Key。
6. 添加、改名、角色切换、归档、解除绑定、Card 覆盖和重复 Conclusion 清理都必须二次确认。
7. 历史数据不自动删除。先生成修复报告，再由用户明确确认可执行的清理动作。
8. 列表优先显示缓存并后台刷新，不让 queue/status 请求阻塞主要内容。
9. Honcho 默认只接收真实用户输入和最终选中的助手回答；思考、工具、系统状态和中间迭代采用显式拒绝策略。
10. 聊天 UI 与 Honcho 持久化始终使用干净内容；模型实际收到的动态记忆使用插件私有 sidecar 逐字重放，不写入普通 `message.content`。

## 3. P0：Message 写入幂等与重复阻断

### 3.1 当前缺陷

当前 Message 指纹为：

```text
hash(chatId + role + timestamp + completedAt + content)
```

存在以下漏洞：

- 同一条消息被宿主以不同 `completedAt` 重放时会生成不同 key。
- 去重集合只在 `HonchoController` 内存中，main engine 重载后失效。
- 配置签名改变时当前代码主动清空 `seen`。
- Message POST body 没有来源 key，Honcho 无法识别来自 Operit 的重复提交。
- 失败重试发生在客户端，无法区分“服务端已经写入但响应丢失”和“服务端没有写入”。

### 3.2 新的来源标识

扩展 `PersistedMessageInput`，接收宿主已经提供的：

- `sentAt`
- `selectedVariantIndex`
- `provider`
- `modelName`

生成版本化 `source_key`：

```text
operit:v1:<chat-id-hash>:<role>:<sentAt-or-timestamp>:<variant>:<content-hash>:<content-length>
```

约束：

- 不使用 `completedAt` 作为身份字段。
- `timestamp` 只在 `sentAt` 缺失时回退。
- 内容先移除 `<memory-context>` 并统一换行，再计算 hash。
- 每个 Honcho Message 写入 `metadata.operit.source_key`、`metadata.operit.role` 和必要的来源版本；不写模型密钥或完整宿主内部对象。
- 长消息分块时追加稳定 chunk index，例如 `:chunk:1/3`。

### 3.3 跨重载去重

每个 Session 第一次写入前执行一次轻量 reconcile：

1. 反向读取最近 100 条 Message。
2. 收集 `metadata.operit.source_key` 到当前 Session 的内存 ledger。
3. 对旧版本、没有 metadata 的消息，使用 `peer_id + 规范化 content + created_at 时间窗口` 建立保守兼容 key。
4. ledger 命中时跳过 POST，并记录 `duplicate_skipped` 指标。
5. POST 超时或连接中断后，先 reconcile，再决定是否重试，避免“写入成功但响应丢失”造成重复。

这个方案不依赖本地 JS engine 永久存活。Honcho Message metadata 是跨重载的最终来源。

### 3.4 Hook 重放保护

- `seen` 不再因普通配置刷新而清空；只在 Workspace 或身份绑定切换时按 namespace 隔离。
- `inFlight`、`pending` 和 reconcile 使用同一个 `source_key`。
- 同一 Session 仍只允许一个 drain。
- 增加结构化计数：`queued`、`written`、`duplicate_skipped`、`reconciled`、`retry_after_unknown_result`。
- 开发验证时记录 key 的短 hash 和耗时，不记录完整消息内容。

### 3.5 上传内容边界：排除思考与工具消息

当前 `ChatMessageEventPayload` 已包含：

- `displayMode`
- `selectedVariantIndex`
- `provider/modelName`
- `sentAt/completedAt`
- `inputTokens/outputTokens/cachedInputTokens`

但 `src/main.ts` 只向 Controller 传递 Chat、时间、sender、role 和 content。Controller 随后使用 `assistant|agent|ai|model` 或 `user|human|owner` 正则分类，没有检查消息是否为最终可见回答。因此，只要宿主把思考、工具调用、工具结果、进度或中间 agent 记录作为 `message_persisted` 发出，并带有 assistant-like sender/role，它们就会被当作普通 AI Message 上传。真实 Workspace 中出现的思考/工具记录与该代码路径一致。

目标上传白名单：

- 真实用户提交的最终文本。
- 当前选中变体的最终、可见助手回答。

必须排除：

- thinking/reasoning/scratchpad。
- tool call 名称与参数、tool result、tool error、权限和执行状态。
- 流式中间片段、进度、内部 agent 消息和系统提示。
- 未选中变体、取消/失败生成和重复 completion 事件。
- `<memory-context>` 及其他仅供模型请求使用的 sidecar 内容。

实现要求：

1. `onChatMessage()` 把完整结构字段传入 `PersistedMessageInput`，在入队前执行独立的 `classifyPersistedMessage()`。
2. 使用真实 Hook 样本建立 `displayMode + roleName + sender + variant` allowlist；不通过正文关键词猜测消息类型。
3. 未知 assistant 子类型默认跳过并计入 `skipped_unknown_kind`，避免再次污染长期记忆；开发诊断只记录结构字段和内容 hash，不记录正文。
4. 分别统计 `skipped_thinking`、`skipped_tool`、`skipped_variant`、`skipped_system` 和 `accepted_final`。
5. 参考 Hermes 的 completed-turn 语义，每轮最多向 Honcho 提交一条干净用户输入和一条最终助手回答；工具参与过程不单独建 Message。

公开 ToolPkg 类型没有枚举 `displayMode` 的具体取值，因此编码前必须在真机采集至少一组纯文本、思考、单工具、多工具、失败工具、重新生成和变体切换样本。样本只保留结构字段，确认后固化为 fixture。

### 3.6 历史重复 Message 的限制

Honcho v3 当前公开 API 没有“删除单条 Message”端点。因此已有重复 Message 不能在原 Session 内安全地逐条物理删除。

本阶段只提供：

- 重复 Message 扫描报告。
- UI 中按 `source_key` 或保守兼容 key 折叠重复项，并显示“重复 N 条”。
- 可选导出唯一消息清单。

“新建干净 Session、重新导入唯一 Message、确认后删除旧 Session”属于高风险迁移，单独立项，不在默认修复中自动执行。

## 4. P0：Conclusion 重复控制与清理

### 4.1 重复来源

Conclusion 需要区分两类：

- **显式创建重复**：`honcho_conclude` 被重复调用，当前创建前不查重。
- **Honcho 自动提取重复**：重复 Message 或相似对话被后台处理后产生多个 explicit/derived Conclusion。

先修 Message 幂等，才能从源头降低第二类重复。不能仅在 UI 隐藏而继续向后台写入重复消息。

### 4.2 显式创建幂等

创建前使用以下作用域生成规范 key：

```text
observer_id + observed_id + session_id + normalized_content
```

- 在同一作用域内发现完全相同内容时返回已有 Conclusion，不再次创建。
- 返回值明确包含 `created: false`、`existing_conclusion_id`。
- 只对完全一致或规范化后完全一致的文本自动判重；语义相似内容不自动删除，避免误伤不同事实。

### 4.3 历史 Conclusion 清理

新增“重复检查”只读报告：

- 精确重复组：scope 与规范化内容均一致。
- 疑似相似组：仅供人工检查，不自动合并。
- 每组保留最早或最新一条由用户选择。
- 删除前弹窗列出删除数量、保留 ID、observer、observed、Session scope。
- 用户输入确认文字后，逐条调用官方 Delete Conclusion API。
- 失败时保留未完成 ID，支持安全重试；不把部分成功显示成全部成功。

## 5. P1：Workspace 级 Peer 身份与参与者管理

### 5.1 身份来源

移除 `HONCHO_USER_PEER` 和 `HONCHO_AI_PEER` 作为长期公开配置入口。新的事实来源存放在当前 Workspace metadata 的命名空间中：

```json
{
  "operit_honcho": {
    "schema_version": 1,
    "revision": 3,
    "active_user_peer_id": "user",
    "active_ai_peer_id": "operit"
  }
}
```

Peer 自身的显示属性存放在 Peer metadata：

```json
{
  "operit_honcho": {
    "display_name": "主人",
    "archived": false
  }
}
```

选择 Workspace 后，main、sandbox 工具和 Explorer 均解析同一份角色绑定。每个 JS engine 可短时缓存，但必须按 `revision` 刷新，不能继续各自从不同默认值推断身份。

### 5.2 兼容迁移

首次发现 Workspace 没有 `operit_honcho` metadata 时：

1. 读取旧 `HONCHO_USER_PEER/HONCHO_AI_PEER`，只用于一次性迁移。
2. 旧值不存在时回退 `user/operit`。
3. 验证两个 Peer 存在且 ID 不相同。
4. 由 UI 展示迁移预览，用户确认后写入 Workspace metadata。
5. 写入成功后，运行时以 Workspace metadata 为准；旧环境变量只显示弃用提示，不再静默覆盖 UI 选择。

API Key、Base URL 与 Workspace 连接信息仍属于环境配置；只有 User/AI Peer 角色绑定迁出环境变量。

### 5.3 参与者页面操作

Peer 页面改为“显示名 + 原始 ID + 角色 + 状态”的紧凑列表：

- 设置为当前用户。
- 设置为当前 AI。
- 创建 Peer。
- 修改显示名。
- 归档/取消归档。
- 从指定 Session 移除。
- 查看 Peer Card。

所有写操作均显示确认弹窗。弹窗必须展示 Workspace、Peer ID、变更前后值和影响范围。

### 5.4 Honcho API 限制

当前 Honcho v3 API 支持创建 Peer、更新 metadata/configuration 和从 Session 移除 Peer，但没有删除 Workspace Peer 的公开端点；Peer ID 也不能重命名。

因此 UI 语义必须准确：

- “修改名称”只更新 `display_name`，原始 Peer ID 保持不变。
- “归档”隐藏非活跃 Peer，并解除可解除的角色绑定，不声称删除远端数据。
- 活跃 User/AI Peer 在没有先选择替代项时禁止归档。
- “从会话移除”只改变 Session 成员关系，不删除 Workspace Peer、Message、Card 或 Conclusion。
- 不提供假的“永久删除 Peer”按钮。

### 5.5 工具 Peer 解析保护

- 工具省略 `peer` 时使用 Workspace 的 `active_user_peer_id`。
- `peer=user`、`peer=ai/assistant` 解析到当前角色绑定。
- 显式 custom Peer 必须已经存在；只读工具不再隐式创建 Peer。
- 若 `peer` 等于当前或已知 Session ID，返回 `INVALID_PEER_ID`，提示调用方应使用 `chat_id`。
- 每个工具响应增加 `resolved_peer_id` 和可用时的 `resolved_peer_name`，让模型知道实际操作对象。
- 工具描述明确区分 `peer` 与 `chat_id/session_id`，减少模型把 `operit_<chat-id>_<hash>` 传入 Peer 参数。

## 6. P1：观察方向显示与 Conclusion 筛选

### 6.1 动态显示

每条 Conclusion 保留 API 原始字段：

- `observer_id`：形成该结论的观察者。
- `observed_id`：该结论描述的对象。

显示规则：

```text
<observer display name> (<observer id>) -> <observed display name> (<observed id>)
```

窄屏默认显示名称，展开详情后显示完整 ID。找不到 metadata 时回退原始 ID，绝不回退成固定的 `user -> operit`。

工具创建 Conclusion 时也不再由 `observerAndTarget()` 无条件固定 observer。默认值来自当前 AI/User 角色绑定，同时允许受控高级操作显式选择 observer 和 observed。

### 6.2 服务端筛选

扩展 `list_conclusions` 和语义查询参数：

- `observerId`
- `observedId`
- `sessionId`
- `level`
- `query`
- `page/size/reverse`

普通列表调用 `/conclusions/list`，把已选择项放入 body 的 `filters`；语义搜索调用 `/conclusions/query`，同时传 `query/top_k/filters`。参数进入固定 IPC allowlist 并做长度、枚举和组合校验。

UI 使用：

- Observer 下拉菜单。
- Observed 下拉菜单。
- 方向快捷项：“当前 AI -> 当前用户”“当前用户 -> 当前 AI”“任意方向”。
- Session 范围菜单。
- Conclusion level 菜单。
- “应用筛选”和“清除筛选”命令；输入变化时不自动请求。

筛选变化后清空旧分页并回到第 1 页。页面标题同时显示服务端返回的筛选后总数。

## 7. P1：Asia/Shanghai 时间显示

所有 API ISO 时间统一经过一个 formatter：

1. 使用 `Date` 解析 ISO 8601；没有时区后缀的值按 UTC 处理并记录兼容测试。
2. 优先使用 `Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })`。
3. 若当前 QuickJS runtime 不支持 `Intl` timeZone，则使用 UTC getter 加 `+08:00` 的确定性 fallback。
4. UI 显示 `YYYY-MM-DD HH:mm:ss`，详情可附原始 ISO 值。
5. 无效时间显示“时间未知”，不展示误导性本地值。

基准验收：

```text
2026-08-01T04:52:21Z -> 2026-08-01 12:52:21
```

## 8. P2：Peer Card 预览

Peer Card 是“observer 对 target 的 Card”，不是 Peer 的单一全局字段。详情页必须显式显示方向：

```text
观察者：[Peer 菜单]
目标：  [当前 Peer]
```

第一步实现只读预览：

- 新增 `get_peer_card` API/IPC operation。
- 返回 `observer_id`、`target_id` 和 `peer_card[]`。
- 默认 observer 使用当前 AI Peer，target 使用所点 Peer。
- 支持切换 observer 后手动刷新。
- 空 Card 显示正式空状态，不显示为网络错误。

Card 编辑属于受控写操作：整体覆盖前展示原 Card、新 Card、observer/target 和“将覆盖整个 Card”的确认弹窗。

## 9. P2：交互性能

### 9.1 当前阻塞链路

Session、Peer、Conclusion 或 Message 页面目前均执行：

```text
远端 queue status -> 等待 -> 列表请求 -> 等待 -> 渲染
```

queue status 不应成为所有列表的前置条件。

### 9.2 调整方案

- 将本地连接配置状态与远端 queue status 拆成两个 operation。
- 已知 Workspace 时，列表请求立即发出；状态与列表并行加载。
- queue 只在 Overview 加载，使用 15 秒 TTL，不阻塞其他 Tab。
- 每个 `workspace + operation + filters + page` 建立 UI 缓存，默认 30 秒 stale-while-revalidate。
- 返回 Tab 时先展示缓存；用户明确点击刷新才强制请求。
- 相同 IPC key 的并发请求在 main 合并为一个 Promise。
- Peer 显示名映射按当前页批量复用 Peer 列表，不为每张 Conclusion 卡单独请求。
- Tab 使用独立 loading/error 状态，切换 Conclusion 时不让 Session 列表一起进入 loading。
- 请求增加超时与耗时日志：IPC、HTTP、DTO mapping、render item count。
- 保持服务端分页；Message 30 条、其余 20 条作为初始值，后续根据实测调整。

### 9.3 性能目标

在正常网络下，以真机连续 10 次取 P50/P95：

- 有缓存 Tab 切换首屏：P95 小于 150 ms。
- 无缓存列表首屏：P95 小于 1.5 s，不含 Honcho 服务端明确排队时间。
- Message 详情不因 queue status 增加额外串行 RTT。
- 快速连续切换 Tab 时，过期响应不能覆盖当前页面。
- loading 状态不清空已有列表，不造成整页闪白或布局跳动。

### 9.4 提示词前缀缓存与持久 sidecar

#### 当前缺陷

默认配置使用 `HONCHO_INJECTION_FREQUENCY=every-turn`、`HONCHO_CONTEXT_CADENCE=1` 和 `HONCHO_DIALECTIC_CADENCE=2`。`before_send_to_model` 每轮把动态 `<memory-context>` 追加到当前 `processedInput`，但普通聊天历史只保留干净用户文本。结果是：

```text
第 N 轮 API：   User(N) + Memory(N)
第 N+1 轮历史： User(N) + Assistant(N) + User(N+1) + Memory(N+1)
```

第 N+1 轮缺少第 N 轮曾实际发送的 `Memory(N)`，精确前缀在 `User(N)` 末尾发生分叉。稳定的 system mode marker 只能保护系统提示前缀，不能保证完整历史前缀稳定。

Hermes 的参考实现把当前轮实际 API 内容保存为隐藏 `api_content` sidecar，并在后续请求中逐字重放。当前轮新增的动态尾部仍需首次处理，但已发生过的历史前缀可以继续命中。Operit 插件采用同一不变量，但只使用现有 ToolPkg 能力，不要求修改 Operit 源码。

#### 插件私有 sidecar

不得把 `<memory-context>` 写入普通持久化 `message.content`。聊天 UI、导出、搜索、总结和 Honcho Message 始终使用干净内容。插件在以下私有目录保存模型请求 sidecar：

```text
ToolPkg.getConfigDir("com.operit.honcho")/prompt-sidecars-v1/
```

使用 `Tools.Files.read/write/move` 按 Chat 分片保存，临时文件写完后原子 move，避免中断留下半个 JSON。记录只保存恢复所需字段：

```json
{
  "schema_version": 1,
  "chat_id_hash": "...",
  "records": {
    "<turn_key>": {
      "clean_content_hash": "...",
      "memory_block": "<memory-context>...</memory-context>",
      "created_at": 1785564953361,
      "last_seen_at": 1785564953361
    }
  }
}
```

不把 API Key、完整 Hook payload 或重复的干净聊天正文写入 sidecar。该目录包含用户画像等敏感内容，文件权限、导出、清除和日志规则按记忆数据处理。

#### 无 Message ID 的稳定 Turn Key

当前 `ChatMessageEventPayload` 没有稳定 Message ID，`PromptTurn.metadata` 也没有承诺持久写回。插件使用规范历史链生成 key：

```text
turn_key = sha256(
  schema_version
  + chat_id
  + previous_chain_key
  + canonical prepared history through this USER turn
)
```

规范化规则：

- 计算前移除已有 `<memory-context>`，统一换行和 `PromptTurn.kind` 表示。
- 链中包含 USER 之前真实存在的 ASSISTANT、TOOL_CALL、TOOL_RESULT 和 SUMMARY turn，但不包含插件新注入块。
- 相同用户文本重复出现时，因为前序链不同而得到不同 key。
- 编辑、重新生成或分支会从变更点生成新链；旧 sidecar 不误配到新分支。
- 历史压缩改变前缀时建立新基线，允许发生一次合理的缓存重建。
- 若运行时未来提供稳定 Message ID，优先使用 `chat_id + message_id + revision`，链式 key 保留为兼容回退。

#### Hook 流程

1. 注册 `PromptHistoryHook(after_prepare_history)`：遍历历史 USER turn，按链式 key 查找 sidecar；`clean_content_hash` 一致时，仅在返回给模型的 `preparedHistory` 中逐字恢复 `content + memory_block`。
2. 注册同逻辑的 `PromptEstimateHistoryHook(after_prepare_history)`：Token 估算必须看到与真实请求相同的历史，否则会低估上下文。
3. `PromptFinalizeHook(before_send_to_model)`：为当前顶层 USER turn 计算 key。存在 sidecar 时直接复用；不存在时检索 Honcho、格式化并在返回 `processedInput` 前持久化。
4. 同一轮的工具循环、Provider 重试和重复 `before_send_to_model` 必须命中同一个 `turn_key`，不得再次检索或改变字节。
5. `message_persisted` 和 Honcho writer 继续读取干净内容，任何 sidecar block 在上传前仍由 `sanitizeMemoryContext()` 二次清除。
6. sidecar 读取、解析或写入失败时 fail-open：本轮跳过注入或只使用已在内存中的稳定副本，不阻塞原始聊天。

核心验收不变量：

```text
request(N) 中 User(N) 的序列化 API 内容
==
request(N+1) 历史中 User(N) 的序列化 API 内容
```

#### 生命周期与容量

- 每个 Chat 单独串行写入；相同文件请求合并，禁止并发覆盖。
- 保留最近活跃记录并设置总字节上限；超过上限时先清理长期未见且已不在活跃历史中的 sidecar。
- Chat 删除事件当前不可用，因此使用 `last_seen_at + TTL + LRU` 回收，不无限增长。
- 应用重载后从私有文件恢复；损坏文件隔离为 `.corrupt` 并重新建库，不把损坏 JSON 覆盖回正常文件。
- 清除插件记忆时必须同时提供 sidecar 清理操作；卸载插件后不应在普通聊天数据库留下内部记忆块。

这个方案保护已经发生过的历史前缀，但不会让当前轮新检索的动态尾部凭空命中，也不会消除新增上下文的 Token 占用。`cachedInputTokens` 用于实测命中改善，不能把“前缀稳定”误报成“零额外成本”。

## 10. UI 确认弹窗规范

所有受控写操作使用同一确认状态模型：

| 操作 | 弹窗必须展示 | 附加约束 |
| --- | --- | --- |
| 创建 Peer | Workspace、Peer ID、显示名 | ID 创建后不可改名 |
| 修改显示名 | Peer ID、旧名称、新名称 | 只改 metadata |
| 设置 User/AI | 原绑定、新绑定、影响的新消息范围 | User 与 AI 不能相同 |
| 归档 Peer | Peer ID、角色、关联 Session 提示 | 活跃角色必须先替换 |
| 从 Session 移除 | Peer、Session ID | 不删除历史数据 |
| 覆盖 Peer Card | observer、target、旧/新条目数 | 明确“整体覆盖” |
| 清理 Conclusion | 保留 ID、删除 ID 列表、数量 | 输入确认文字，支持部分失败恢复 |

弹窗确认期间禁用重复提交；请求完成前按钮显示稳定 loading；成功后只失效相关缓存。

## 11. 实施顺序

### 阶段 A：阻止新增重复数据

- 捕获完整 Hook 身份字段和复现样本。
- 建立最终用户/助手 Message allowlist，阻断 thinking、tool、中间状态和未选中变体。
- 实现 Message `source_key`、metadata、reconcile 和未知结果重试保护。
- 实现显式 Conclusion 精确幂等。
- 增加 duplicate counters 和 mocked transport 测试。

完成标志：同一用户/AI 最终消息在 Hook 重放、配置刷新、main 重载和“服务端已写入但响应丢失”四种场景下均只产生一份 Message；思考、工具调用、工具结果和中间迭代不增加 Honcho Message。

### 阶段 B：统一 Peer 身份

- Workspace metadata identity schema。
- 旧环境变量一次性迁移。
- main 与 sandbox 工具统一解析角色绑定。
- custom Peer 存在性和 Session-ID 误用校验。

完成标志：UI、自动 Hook 和五个工具报告相同的 User/AI Peer；工具不再创建 Session-shaped Peer。

### 阶段 C：参与者管理与 Card

- Peer 详情、创建、显示名、角色绑定、归档和 Session 移除。
- Peer Card 方向选择与预览。
- 全部确认弹窗和写后缓存失效。

完成标志：不修改环境变量即可在 UI 完成角色管理，并且重启后仍保持一致。

### 阶段 D：Conclusion 方向、筛选与清理

- 显示名解析和真实 observer/observed 展示。
- 服务端 filters、语义搜索和分页。
- 重复报告与确认删除。

完成标志：可按 Peer、方向、Session、level 筛选；历史精确重复 Conclusion 可审阅并安全清理。

### 阶段 E：时间与性能

- `Asia/Shanghai` formatter 和真机 runtime fallback 测试。
- status/queue 解耦、并行请求、TTL 缓存、请求合并和性能指标。
- 实现插件私有 prompt sidecar、History/Estimate Hook 和每轮检索合并。
- 使用 `cachedInputTokens` 和序列化请求 fixture 验证历史前缀稳定。

完成标志：截图时间与上海时区一致，真机 P95 达到第 9.3 节目标；应用重载后仍能逐字恢复历史 sidecar，同一轮重试不重复检索，后续请求保留上一轮完整 API 前缀。

## 12. 代码影响范围

| 文件/模块 | 预计修改 |
| --- | --- |
| `src/main.ts` | 传递完整 Hook 字段；注册 Message 分类、History/Estimate Hook；扩展 Explorer IPC |
| `src/config.ts` | User/AI env 迁移兼容，不再作为最终身份来源 |
| `src/api.ts` | Message metadata/reconcile、Workspace/Peer update、Card、Conclusion filters |
| `src/controller.ts` | Message allowlist、持久幂等 ledger、身份解析、工具防误用、重复指标 |
| `src/prompt_sidecar.ts` | 私有分片存储、链式 turn key、原子写入、历史恢复、TTL/LRU 和 fail-open |
| `src/explorer/types.ts` | identity、Peer detail/Card、filters、写操作 DTO |
| `src/explorer/validation.ts` | 新 operation、ID、filter 与确认参数校验 |
| `src/explorer/service.ts` | 通用 Peer 管理、身份 metadata、请求合并与缓存 |
| `src/ui/honcho_explore/` | Peer detail、确认弹窗、筛选、时区、独立加载状态与缓存 |
| `src/packages/honcho.ts` | 移除公开 Peer env、澄清 peer/chat_id、返回 resolved Peer |
| `tests/` | Message 类型过滤、重放/重载/未知结果、sidecar 前缀、身份迁移、筛选、Card、时区、竞态和缓存测试 |

UI 复杂度继续增长前，应将当前 `index.ui.ts` 拆分为 peers、sessions、conclusions、state、components 和 format，避免把身份管理与危险操作堆在单文件中。

## 13. 测试与验收矩阵

### 自动测试

- 完全相同 Hook 重放只写一次。
- `completedAt` 改变但 source identity 相同仍只写一次。
- thinking、reasoning、tool call/result、进度和未选中变体均不进入写队列。
- 纯文本与工具参与后的最终助手回答各只接受一次。
- main 重载后从 Message metadata reconcile 并跳过重复。
- POST 成功但客户端收到超时后不二次写入。
- 长消息各 chunk key 稳定且不互相冲突。
- 同 scope 同内容 Conclusion 不重复创建。
- Session ID 传入 `peer` 返回 `INVALID_PEER_ID`，且不创建 Peer。
- Workspace identity 迁移后 main/sandbox/UI 解析一致。
- 修改显示名不改变 Peer ID。
- Conclusion filters 正确进入 body，不在 UI 本地伪筛选总量。
- observer/observed 使用真实 DTO 并解析显示名。
- ISO UTC 时间转换到 `Asia/Shanghai`。
- Tab 缓存、请求合并、过期响应丢弃和独立 loading 状态。
- 相同顶层用户轮次的工具循环和 Provider 重试只检索一次，并逐字复用同一 sidecar。
- `request(N+1)` 历史中的 `User(N)` 与 `request(N)` 实际发送内容逐字相同。
- 重复用户文本、编辑、分支和 Summary 压缩不会把 sidecar 关联到错误 turn。
- Prompt Estimate 与真实请求恢复相同 sidecar；私有文件损坏时 fail-open。
- main 重载后从插件私有目录恢复 sidecar，不修改普通聊天 `content`。
- 所有写操作未经 confirm token 时被 IPC 拒绝。

### 真机与真实 `test` Workspace

1. 连续重放同一轮用户和 AI 完成事件，Message 数各只增加 1。
2. 关闭并重开 ToolPkg 后再次重放，Message 数不增加。
3. 开启思考并完成单工具、多工具和失败工具会话，Honcho 只新增干净用户输入和最终助手回答。
4. 连续完成至少三轮对话并重启 ToolPkg，捕获请求确认历史 sidecar 逐字恢复；记录 `cachedInputTokens` 与修复前基线。
5. 五个工具省略 Peer 时均返回 UI 当前绑定的 User Peer。
6. 创建、改名、设置角色、归档均出现确认弹窗，重启后状态保留。
7. Peer Card 可按 observer/target 预览。
8. Conclusion 卡片显示真实名称和方向，四类筛选组合与 API 结果一致。
9. `2026-08-01T04:52:21Z` 显示为 `2026-08-01 12:52:21`。
10. 历史重复扫描先只读预览；确认清理后只删除选中的 Conclusion。
11. 记录无缓存和有缓存场景各 10 次耗时，满足性能目标。
12. 禁网、401、403、429、sidecar 文件损坏和部分删除失败均有可恢复状态。

## 14. 不可误报为完成的事项

- 没有 Hook 真实重放样本和重载测试，不得声称 Message 重复已根治。
- 没有真实 `displayMode/roleName/sender/variant` 样本，不得声称思考和工具消息过滤完整。
- 只在 UI 折叠重复项，不等于服务端数据已清理。
- Peer 归档或从 Session 移除，不等于永久删除 Peer。
- 修改 `display_name`，不等于修改 Honcho Peer ID。
- 仅显示 `user -> operit` 的某批真实数据，不代表 UI 方向被硬编码；验收必须构造反向和自观察数据。
- sidecar 能保持历史前缀，不代表当前轮新增动态记忆可以命中缓存，也不代表没有额外 Token。
- 只在进程内复用 sidecar、但重载后丢失，不得声称已实现缓存安全的持久重放。
- 没有真实 `test` Workspace 过滤结果和真机耗时数据，不得声称筛选与性能通过。
