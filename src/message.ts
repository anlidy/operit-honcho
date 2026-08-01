import { sanitizeMemoryContext } from "./format";
import { sha256 } from "./hash";

export type PersistedRole = "user" | "assistant";
export type MessageDecisionReason =
  | "accepted_final"
  | "skipped_incomplete"
  | "skipped_thinking"
  | "skipped_tool"
  | "skipped_system"
  | "skipped_unknown_kind";

export interface PersistedMessageInput {
  chatId: string;
  roleName?: string;
  sender?: string;
  content: string;
  timestamp?: number;
  completedAt?: number;
  sentAt?: number;
  displayMode?: string;
  selectedVariantIndex?: number;
  provider?: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  isFavorite?: boolean;
}

export interface MessageClassification {
  accepted: boolean;
  role: PersistedRole | null;
  reason: MessageDecisionReason;
}

export interface MessageLedger {
  sourceKeys: string[];
  legacyKeys: string[];
}

export interface AssistantContentAnalysis {
  content: string;
  hadThinking: boolean;
  hadTool: boolean;
  hadSystem: boolean;
}

const THINKING_TAG_PATTERN = "think(?:ing)?|search";
const TOOL_RESULT_TAG_PATTERN = "tool_result(?:_[A-Za-z0-9_]+)?";
const TOOL_CALL_TAG_PATTERN = "(?!tool_result(?:_|\\b))tool(?:_[A-Za-z0-9_]+)?";
const SYSTEM_TAG_PATTERN = "status|meta";

export function normalizeMessageContent(value: string): string {
  return sanitizeMemoryContext(String(value || "").replace(/\r\n?/g, "\n"));
}

function containsMarkupBlock(value: string, namePattern: string): boolean {
  return new RegExp("<(?:" + namePattern + ")\\b", "i").test(value);
}

function removeMarkupBlocks(value: string, namePattern: string): string {
  const paired = new RegExp(
    "<(" + namePattern + ")\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>",
    "gi"
  );
  const selfClosing = new RegExp("<(?:" + namePattern + ")\\b[^>]*/\\s*>", "gi");
  const unclosed = new RegExp("<(?:" + namePattern + ")\\b[^>]*>[\\s\\S]*$", "gi");
  return value.replace(paired, "").replace(selfClosing, "").replace(unclosed, "");
}

export function analyzeAssistantContent(value: string): AssistantContentAnalysis {
  const normalized = normalizeMessageContent(value);
  const hadThinking = containsMarkupBlock(normalized, THINKING_TAG_PATTERN);
  const hadTool =
    containsMarkupBlock(normalized, TOOL_RESULT_TAG_PATTERN) ||
    containsMarkupBlock(normalized, TOOL_CALL_TAG_PATTERN);
  const hadSystem = containsMarkupBlock(normalized, SYSTEM_TAG_PATTERN);

  const content = [
    THINKING_TAG_PATTERN,
    TOOL_RESULT_TAG_PATTERN,
    TOOL_CALL_TAG_PATTERN,
    SYSTEM_TAG_PATTERN,
  ].reduce((current, pattern) => removeMarkupBlocks(current, pattern), normalized)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { content, hadThinking, hadTool, hadSystem };
}

export function contentForPersistedMessage(
  input: PersistedMessageInput,
  role: PersistedRole
): string {
  return role === "assistant"
    ? analyzeAssistantContent(input.content).content
    : normalizeMessageContent(input.content);
}

export function resolveRole(roleName = "", sender = ""): PersistedRole | null {
  const senderValue = sender.trim().toLowerCase();
  if (senderValue === "user" || senderValue === "human" || senderValue === "owner") return "user";
  if (senderValue === "ai" || senderValue === "assistant" || senderValue === "model") return "assistant";

  if (senderValue) return null;
  const roleValue = roleName.trim().toLowerCase();
  if (roleValue === "user" || roleValue === "human" || roleValue === "owner") return "user";
  if (roleValue === "ai" || roleValue === "assistant" || roleValue === "model") return "assistant";
  return null;
}

export function classifyPersistedMessage(input: PersistedMessageInput): MessageClassification {
  const role = resolveRole(input.roleName, input.sender);
  if (!role) return { accepted: false, role: null, reason: "skipped_unknown_kind" };

  const mode = String(input.displayMode || "").trim().toUpperCase();
  if (mode === "HIDDEN_PLACEHOLDER") {
    return { accepted: false, role, reason: "skipped_system" };
  }
  if (mode && mode !== "NORMAL") {
    return { accepted: false, role, reason: "skipped_unknown_kind" };
  }
  if (role === "assistant" && mode !== "NORMAL") {
    return { accepted: false, role, reason: "skipped_unknown_kind" };
  }
  if (role === "assistant" && Number(input.completedAt || 0) <= 0) {
    return { accepted: false, role, reason: "skipped_incomplete" };
  }
  if (role === "assistant") {
    const analysis = analyzeAssistantContent(input.content);
    if (!analysis.content) {
      if (analysis.hadTool) return { accepted: false, role, reason: "skipped_tool" };
      if (analysis.hadThinking) return { accepted: false, role, reason: "skipped_thinking" };
      if (analysis.hadSystem) return { accepted: false, role, reason: "skipped_system" };
      return { accepted: false, role, reason: "skipped_unknown_kind" };
    }
  }
  return { accepted: true, role, reason: "accepted_final" };
}

export function sourceKeyFor(
  input: PersistedMessageInput,
  role: PersistedRole,
  content = contentForPersistedMessage(input, role)
): string {
  const chatHash = sha256(String(input.chatId || "default")).slice(0, 16);
  const contentHash = sha256(content).slice(0, 24);
  const identityTime = Math.max(0, Math.trunc(Number(input.timestamp || input.sentAt || 0)));
  const variant = Math.max(0, Math.trunc(Number(input.selectedVariantIndex || 0)));
  return `operit:v1:${chatHash}:${role}:${identityTime}:${variant}:${contentHash}:${content.length}`;
}

export function legacyKeysFor(role: PersistedRole, content: string, timestamp: number): string[] {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return [];
  const minute = Math.floor(timestamp / 60000);
  const contentHash = sha256(normalizeMessageContent(content)).slice(0, 24);
  return [-1, 0, 1].map((offset) => `legacy:v1:${role}:${minute + offset}:${contentHash}`);
}

export function sourceKeyFromMetadata(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const root = metadata as Record<string, unknown>;
  const operit = root.operit;
  if (!operit || typeof operit !== "object" || Array.isArray(operit)) return "";
  const value = operit as Record<string, unknown>;
  return String(value.source_message_key || value.source_key || "").trim();
}