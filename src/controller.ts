import { HonchoApi, JsonRecord } from "./api";
import { configSignature, HonchoConfig, isConfigured, loadConfig, ReasoningLevel } from "./config";
import {
  formatMemoryContext,
  injectMemoryContext,
  MemoryContext,
  sanitizeMemoryContext,
  truncateAtWord,
} from "./format";

interface ChatState {
  turn: number;
  firstInjected: boolean;
  lastContextTurn: number;
  lastDialecticTurn: number;
  context: MemoryContext;
  dialectic: string;
  pending: PendingMessage[];
  flushPromise: Promise<void> | null;
  flushAgain: boolean;
  seen: Set<string>;
  inFlight: Set<string>;
  seenOrder: string[];
  lastWriteError: string;
}

interface PendingMessage {
  fingerprint: string;
  chatId: string;
  role: "user" | "assistant";
  content: string;
  api: HonchoApi;
}

export interface PersistedMessageInput {
  chatId: string;
  roleName?: string;
  sender?: string;
  content: string;
  timestamp?: number;
  completedAt?: number;
}

type ApiFactory = (config: HonchoConfig) => HonchoApi;

function emptyState(): ChatState {
  return {
    turn: 0,
    firstInjected: false,
    lastContextTurn: -999999,
    lastDialecticTurn: -999999,
    context: {},
    dialectic: "",
    pending: [],
    flushPromise: null,
    flushAgain: false,
    seen: new Set<string>(),
    inFlight: new Set<string>(),
    seenOrder: [],
    lastWriteError: "",
  };
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function resolveRole(roleName = "", sender = ""): "user" | "assistant" | null {
  const role = `${roleName} ${sender}`.trim().toLowerCase();
  if (/assistant|agent|ai|model/.test(role)) return "assistant";
  if (/user|human|owner/.test(role)) return "user";
  return null;
}

export class HonchoController {
  private signature = "";
  private config: HonchoConfig = loadConfig();
  private api: HonchoApi;
  private readonly chats = new Map<string, ChatState>();

  constructor(private readonly apiFactory: ApiFactory = (config) => new HonchoApi(config)) {
    this.api = this.apiFactory(this.config);
    this.signature = configSignature(this.config);
  }

  private refreshConfig(): HonchoConfig {
    const next = loadConfig();
    const nextSignature = configSignature(next);
    if (nextSignature !== this.signature) {
      this.config = next;
      this.signature = nextSignature;
      this.api = this.apiFactory(next);
      for (const state of this.chats.values()) {
        state.turn = 0;
        state.firstInjected = false;
        state.lastContextTurn = -999999;
        state.lastDialecticTurn = -999999;
        state.context = {};
        state.dialectic = "";
        state.seen.clear();
        state.seenOrder = [];
      }
    }
    return this.config;
  }

  private chat(chatId: string): ChatState {
    const key = String(chatId || "default");
    let state = this.chats.get(key);
    if (!state) {
      state = emptyState();
      this.chats.set(key, state);
    }
    return state;
  }

  getConfig(): HonchoConfig {
    return this.refreshConfig();
  }

  isActive(): boolean {
    return isConfigured(this.refreshConfig());
  }

  systemPromptHeader(): string {
    const config = this.refreshConfig();
    if (!isConfigured(config)) return "";
    const marker = "<honcho-memory-mode>";
    if (config.recallMode === "context") {
      return `${marker}Honcho memory is active in context-injection mode. Relevant memory is injected automatically.</honcho-memory-mode>`;
    }
    if (config.recallMode === "tools") {
      return `${marker}Honcho memory is active in tools-only mode. Use the honcho memory tools when prior context is needed.</honcho-memory-mode>`;
    }
    return `${marker}Honcho memory is active in hybrid mode. Relevant context is injected automatically and Honcho memory tools are available.</honcho-memory-mode>`;
  }

  private automaticReasoningQuery(state: ChatState, input: string): string {
    if (!formatMemoryContext(state.context)) {
      return (
        "Who is this person? What are their preferences, goals, and working style? " +
        "Focus on facts that would help an AI assistant be immediately useful."
      );
    }
    return (
      "Given what has been discussed in this session, what context about this user is most relevant " +
      `to the current conversation? Prioritize active context. Latest request: ${input.slice(0, 4000)}`
    );
  }

  async injectForPrompt(chatId: string, input: string): Promise<string | null> {
    const config = this.refreshConfig();
    if (!isConfigured(config) || config.recallMode === "tools") return null;
    const cleanInput = sanitizeMemoryContext(input);
    if (!cleanInput) return null;

    const state = this.chat(chatId);
    state.turn += 1;
    if (config.injectionFrequency === "first-turn" && state.firstInjected) return null;

    if (state.turn - state.lastContextTurn >= config.contextCadence) {
      try {
        state.context = await this.api.getContext(chatId, cleanInput, "user");
        state.lastContextTurn = state.turn;
      } catch (error) {
        console.log(`[honcho] context refresh failed: ${String(error)}`);
      }
    }

    if (state.turn - state.lastDialecticTurn >= config.dialecticCadence) {
      try {
        const query = this.automaticReasoningQuery(state, cleanInput);
        const result = await this.api.reason(chatId, query, config.dialecticReasoningLevel, "user");
        state.dialectic = truncateAtWord(result, config.dialecticMaxChars);
        state.lastDialecticTurn = state.turn;
      } catch (error) {
        console.log(`[honcho] dialectic refresh failed: ${String(error)}`);
      }
    }

    const context = truncateAtWord(
      formatMemoryContext(state.context, state.dialectic),
      config.contextTokens * 4
    );
    if (!context) return null;
    state.firstInjected = true;
    return injectMemoryContext(cleanInput, context);
  }

  queuePersistedMessage(input: PersistedMessageInput): void {
    const config = this.refreshConfig();
    if (!isConfigured(config) || !config.saveMessages) return;
    const role = resolveRole(input.roleName, input.sender);
    const content = sanitizeMemoryContext(input.content || "");
    if (!role || !content) return;

    const chatId = String(input.chatId || "default");
    const state = this.chat(chatId);
    const key = fingerprint(
      `${chatId}\u0000${role}\u0000${input.timestamp || 0}\u0000${input.completedAt || 0}\u0000${content}`
    );
    if (state.seen.has(key) || state.inFlight.has(key)) return;
    state.pending.push({ fingerprint: key, chatId, role, content, api: this.api });
    state.inFlight.add(key);
    state.flushAgain = true;
    void this.flushChat(chatId);
  }

  private remember(state: ChatState, value: string): void {
    state.seen.add(value);
    state.seenOrder.push(value);
    while (state.seenOrder.length > 500) {
      const oldest = state.seenOrder.shift();
      if (oldest) state.seen.delete(oldest);
    }
  }

  async flushChat(chatId: string): Promise<void> {
    const state = this.chat(chatId);
    if (state.flushPromise) return state.flushPromise;
    state.flushAgain = true;

    const drain = async (): Promise<void> => {
      do {
        state.flushAgain = false;
        const batchSize = state.pending.length;
        for (let index = 0; index < batchSize; index += 1) {
          const item = state.pending.shift();
          if (!item) break;
          let lastError: unknown = null;
          let sent = false;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await item.api.addMessage(item.chatId, item.role, item.content);
              sent = true;
              break;
            } catch (error) {
              lastError = error;
            }
          }
          if (!sent) {
            state.lastWriteError = String(lastError || "Unknown Honcho write error");
            state.pending.push(item);
            continue;
          }
          this.remember(state, item.fingerprint);
          state.inFlight.delete(item.fingerprint);
          state.lastWriteError = "";
        }
      } while (state.flushAgain);
    };

    state.flushPromise = drain();
    try {
      await state.flushPromise;
    } finally {
      state.flushPromise = null;
      if (state.flushAgain) void this.flushChat(chatId);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all(Array.from(this.chats.keys()).map((chatId) => this.flushChat(chatId)));
  }

  async call(operation: string, params: JsonRecord): Promise<JsonRecord> {
    const config = this.refreshConfig();
    if (!isConfigured(config)) {
      throw new Error("Honcho is not configured. Set HONCHO_API_KEY, or HONCHO_BASE_URL for self-hosting, and enable the package.");
    }
    const chatId = String(params.chatId || params.chat_id || "default");
    const peer = String(params.peer || "user");

    if (operation === "status") {
      const queue = Array.from(this.chats.values()).reduce((sum, state) => sum + state.pending.length, 0);
      return { ...this.api.status(), pending_messages: queue };
    }
    if (operation === "profile") {
      const card = Array.isArray(params.card) ? params.card.map(String) : null;
      const result = card ? await this.api.setProfile(card, peer) : await this.api.getProfile(peer);
      return result.length
        ? { result, card: result }
        : {
            result: "No profile facts available yet.",
            hint: "This is not an error. Honcho builds peer cards over time from observed conversation.",
          };
    }
    if (operation === "search") {
      const query = String(params.query || "").trim();
      if (!query) throw new Error("Missing required parameter: query");
      const maxTokens = Number(params.max_tokens || 800);
      const result = await this.api.search(query, maxTokens, peer);
      return { result: result || "No relevant context found." };
    }
    if (operation === "context") {
      const context = await this.api.getContext(chatId, String(params.query || ""), peer);
      const recent = context.recentMessages?.slice(-5).map((item) => `  [${item.role}] ${item.content.slice(0, 200)}`).join("\n");
      const result = [formatMemoryContext(context), recent ? `## Recent messages\n${recent}` : ""]
        .filter(Boolean)
        .join("\n\n");
      return { result: result || "No context available yet.", context };
    }
    if (operation === "reasoning") {
      const query = String(params.query || "").trim();
      if (!query) throw new Error("Missing required parameter: query");
      const requested = String(params.reasoning_level || config.dialecticReasoningLevel) as ReasoningLevel;
      const allowed: ReasoningLevel[] = ["minimal", "low", "medium", "high", "max"];
      const level = allowed.includes(requested) ? requested : config.dialecticReasoningLevel;
      const result = await this.api.reason(chatId, query, level, peer);
      return { result: result || "No result from Honcho." };
    }
    if (operation === "conclude") {
      const conclusion = String(params.conclusion || "").trim();
      const deleteId = String(params.delete_id || "").trim();
      const list = params.list === true;
      if ([Boolean(conclusion), Boolean(deleteId), list].filter(Boolean).length !== 1) {
        throw new Error("Exactly one of conclusion, delete_id, or list must be provided.");
      }
      if (params.query && !list) throw new Error("query is only valid when list is true.");
      if (list) {
        const conclusions = await this.api.listConclusions(String(params.query || ""), peer, 20);
        return { conclusions };
      }
      if (deleteId) {
        await this.api.deleteConclusion(deleteId);
        return { result: `Conclusion ${deleteId} deleted.` };
      }
      const created = await this.api.createConclusion(chatId, conclusion, peer);
      return { result: `Conclusion saved for ${peer}: ${conclusion}`, conclusions: created };
    }
    throw new Error(`Unknown Honcho operation: ${operation}`);
  }
}