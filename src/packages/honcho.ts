/* METADATA
{
  "name": "honcho",
  "display_name": {
    "zh": "Honcho 记忆工具",
    "en": "Honcho Memory Tools"
  },
  "description": {
    "zh": "Honcho v3 跨会话记忆、用户建模、搜索、推理与持久结论工具。",
    "en": "Honcho v3 cross-session memory, user modeling, search, reasoning, and persistent conclusions."
  },
  "enabledByDefault": true,
  "env": [
    { "name": "HONCHO_API_KEY", "description": { "zh": "Honcho Cloud API Key。使用自托管服务时可留空。", "en": "Honcho Cloud API key. Optional for self-hosting." }, "required": false },
    { "name": "HONCHO_BASE_URL", "description": { "zh": "自托管 Honcho 地址；云端默认 https://api.honcho.dev。", "en": "Self-hosted Honcho URL; cloud defaults to https://api.honcho.dev." }, "required": false },
    { "name": "HONCHO_ENABLED", "description": { "zh": "总开关，true/false。配置 Key 或 Base URL 时默认开启。", "en": "Master toggle, true/false. Auto-enabled when a key or base URL is set." }, "required": false },
    { "name": "HONCHO_WORKSPACE", "description": { "zh": "Honcho workspace ID，默认 operit。", "en": "Honcho workspace ID, default operit." }, "required": false },
    { "name": "HONCHO_RECALL_MODE", "description": { "zh": "hybrid/context/tools，默认 hybrid。", "en": "hybrid/context/tools, default hybrid." }, "required": false },
    { "name": "HONCHO_OBSERVATION_MODE", "description": { "zh": "directional 或 unified，默认 directional。", "en": "directional or unified, default directional." }, "required": false },
    { "name": "HONCHO_SAVE_MESSAGES", "description": { "zh": "是否保存对话消息，默认 true。", "en": "Persist chat messages, default true." }, "required": false },
    { "name": "HONCHO_SESSION_STRATEGY", "description": { "zh": "per-chat 或 global，默认 per-chat。", "en": "per-chat or global, default per-chat." }, "required": false },
    { "name": "HONCHO_CONTEXT_TOKENS", "description": { "zh": "自动上下文 token 预算，默认 2000。", "en": "Automatic context token budget, default 2000." }, "required": false },
    { "name": "HONCHO_CONTEXT_CADENCE", "description": { "zh": "每隔多少轮刷新基础上下文，默认 1。", "en": "Turns between base context refreshes, default 1." }, "required": false },
    { "name": "HONCHO_DIALECTIC_CADENCE", "description": { "zh": "每隔多少轮执行自动记忆推理，默认 2。", "en": "Turns between automatic dialectic calls, default 2." }, "required": false },
    { "name": "HONCHO_DIALECTIC_REASONING_LEVEL", "description": { "zh": "minimal/low/medium/high/max，默认 low。", "en": "minimal/low/medium/high/max, default low." }, "required": false },
    { "name": "HONCHO_DIALECTIC_MAX_CHARS", "description": { "zh": "自动推理注入字符上限，默认 600。", "en": "Automatic dialectic injection character cap, default 600." }, "required": false },
    { "name": "HONCHO_MESSAGE_MAX_CHARS", "description": { "zh": "单条写入消息字符上限，默认且最大 25000。", "en": "Per-message character cap, default and maximum 25000." }, "required": false },
    { "name": "HONCHO_INJECTION_FREQUENCY", "description": { "zh": "every-turn 或 first-turn，默认 every-turn。", "en": "every-turn or first-turn, default every-turn." }, "required": false }
  ],
  "tools": [
    {
      "name": "honcho_profile",
      "description": { "zh": "读取或覆盖 Peer Card。省略 card 时读取；该调用不使用 LLM。", "en": "Read or overwrite a peer card. Omit card to read; this call does not use an LLM." },
      "parameters": [
        { "name": "peer", "description": { "zh": "user（默认）、ai 或自定义 Peer ID。", "en": "user (default), ai, or a custom peer ID." }, "type": "string", "required": false },
        { "name": "card", "description": { "zh": "用于覆盖 Peer Card 的事实字符串数组。", "en": "Fact strings that replace the peer card." }, "type": "array", "required": false }
      ]
    },
    {
      "name": "honcho_search",
      "description": { "zh": "跨会话混合搜索真实消息，返回原始排序片段，不调用 LLM。", "en": "Hybrid search over actual messages across sessions, returning ranked raw excerpts without an LLM." },
      "parameters": [
        { "name": "query", "description": { "zh": "搜索主题、关键词或自然语言描述。", "en": "Topic, keyword, or natural-language search query." }, "type": "string", "required": true },
        { "name": "max_tokens", "description": { "zh": "返回预算，默认 800，最大 2000。", "en": "Approximate return budget, default 800, maximum 2000." }, "type": "number", "required": false },
        { "name": "peer", "description": { "zh": "user（默认）、ai 或自定义 Peer ID。", "en": "user (default), ai, or a custom peer ID." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "honcho_context",
      "description": { "zh": "读取当前会话摘要、Peer 表征、Peer Card 和最近消息，不调用 LLM。", "en": "Read the current session summary, peer representation, peer card, and recent messages without an LLM." },
      "parameters": [
        { "name": "peer", "description": { "zh": "user（默认）、ai 或自定义 Peer ID。", "en": "user (default), ai, or a custom peer ID." }, "type": "string", "required": false },
        { "name": "chat_id", "description": { "zh": "可选 Operit Chat ID，默认当前聊天。", "en": "Optional Operit chat ID, defaults to the current chat." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "honcho_reasoning",
      "description": { "zh": "让 Honcho dialectic agent 针对 Peer 进行检索和综合推理；该工具会调用 LLM。", "en": "Ask Honcho's dialectic agent to retrieve and synthesize knowledge about a peer; this tool uses an LLM." },
      "parameters": [
        { "name": "query", "description": { "zh": "关于目标 Peer 的自然语言问题。", "en": "Natural-language question about the target peer." }, "type": "string", "required": true },
        { "name": "reasoning_level", "description": { "zh": "minimal/low/medium/high/max，默认使用插件配置。", "en": "minimal/low/medium/high/max; defaults to package configuration." }, "type": "string", "required": false },
        { "name": "peer", "description": { "zh": "user（默认）、ai 或自定义 Peer ID。", "en": "user (default), ai, or a custom peer ID." }, "type": "string", "required": false },
        { "name": "chat_id", "description": { "zh": "可选 Operit Chat ID，默认当前聊天。", "en": "Optional Operit chat ID, defaults to the current chat." }, "type": "string", "required": false }
      ]
    },
    {
      "name": "honcho_conclude",
      "description": { "zh": "创建、列出/搜索或删除持久结论。conclusion、delete_id、list=true 必须且只能提供一个。", "en": "Create, list/search, or delete persistent conclusions. Provide exactly one of conclusion, delete_id, or list=true." },
      "parameters": [
        { "name": "conclusion", "description": { "zh": "要持久保存的事实。", "en": "Fact to persist." }, "type": "string", "required": false },
        { "name": "delete_id", "description": { "zh": "要删除的结论 ID；先通过 list 获取。", "en": "Conclusion ID to delete; obtain it from list first." }, "type": "string", "required": false },
        { "name": "list", "description": { "zh": "设为 true 以列出或搜索结论。", "en": "Set true to list or search conclusions." }, "type": "boolean", "required": false },
        { "name": "query", "description": { "zh": "仅 list=true 时可用的语义查询。", "en": "Semantic query valid only when list=true." }, "type": "string", "required": false },
        { "name": "peer", "description": { "zh": "结论所描述的 Peer。", "en": "Peer the conclusion is about." }, "type": "string", "required": false },
        { "name": "chat_id", "description": { "zh": "可选 Operit Chat ID，默认当前聊天。", "en": "Optional Operit chat ID, defaults to the current chat." }, "type": "string", "required": false }
      ]
    }
  ]
}
*/
import { JsonRecord } from "../api";
import { honchoController } from "../runtime";

function currentChatId(): string {
  if (typeof getChatId !== "function") return "default";
  return String(getChatId() || "default");
}

function normalized(params: JsonRecord = {}): JsonRecord {
  const result: JsonRecord = { ...params };
  if (!result.chatId && !result.chat_id) result.chat_id = currentChatId();
  if (typeof result.list === "string") {
    result.list = ["1", "true", "yes", "on"].includes(result.list.toLowerCase());
  }
  if (typeof result.card === "string") {
    try {
      const parsed = JSON.parse(result.card);
      if (Array.isArray(parsed)) result.card = parsed;
    } catch (_error) {
      result.card = [result.card];
    }
  }
  return result;
}

async function run(operation: string, params: JsonRecord = {}): Promise<JsonRecord> {
  try {
    const result = await honchoController.call(operation, normalized(params));
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function honcho_profile(params: JsonRecord = {}): Promise<JsonRecord> {
  return run("profile", params);
}

export function honcho_search(params: JsonRecord = {}): Promise<JsonRecord> {
  return run("search", params);
}

export function honcho_context(params: JsonRecord = {}): Promise<JsonRecord> {
  return run("context", params);
}

export function honcho_reasoning(params: JsonRecord = {}): Promise<JsonRecord> {
  return run("reasoning", params);
}

export function honcho_conclude(params: JsonRecord = {}): Promise<JsonRecord> {
  return run("conclude", params);
}
