import { HonchoApi, JsonRecord } from "./api";
import { configSignature, HonchoConfig, isConfigured, loadConfig, ReasoningLevel } from "./config";
import {
  formatMemoryContext,
  injectMemoryContext,
  MemoryContext,
  sanitizeMemoryContext,
  truncateAtWord,
} from "./format";
import {
  classifyPersistedMessage,
  contentForPersistedMessage,
  legacyKeysFor,
  MessageDecisionReason,
  normalizeMessageContent,
  PersistedMessageInput,
  PersistedRole,
  resolveRole,
  sourceKeyFor,
} from "./message";

export { classifyPersistedMessage, PersistedMessageInput, resolveRole, sourceKeyFor } from "./message";

interface ControllerMetrics {
  queued: number;
  written: number;
  duplicateSkipped: number;
  reconciled: number;
  retryAfterUnknownResult: number;
  acceptedFinal: number;
  skippedIncomplete: number;
  skippedSystem: number;
  skippedUnknownKind: number;
  skippedThinking: number;
  skippedTool: number;
  skippedVariant: number;
}

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
  sourceLedgers: Map<string, Set<string>>;
  legacyLedgers: Map<string, Set<string>>;
  reconciledNamespaces: Set<string>;
  metrics: ControllerMetrics;
  lastWriteError: string;
}

interface PendingMessage {
  dedupeKey: string;
  sourceKey: string;
  namespace: string;
  chatId: string;
  role: PersistedRole;
  content: string;
  identityTime: number;
  sentAt: number;
  variantIndex: number;
  api: HonchoApi;
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
    sourceLedgers: new Map<string, Set<string>>(),
    legacyLedgers: new Map<string, Set<string>>(),
    reconciledNamespaces: new Set<string>(),
    metrics: {
      queued: 0,
      written: 0,
      duplicateSkipped: 0,
      reconciled: 0,
      retryAfterUnknownResult: 0,
      acceptedFinal: 0,
      skippedIncomplete: 0,
      skippedSystem: 0,
      skippedUnknownKind: 0,
      skippedThinking: 0,
      skippedTool: 0,
      skippedVariant: 0,
    },
    lastWriteError: "",
  };
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

  private writeNamespace(config: HonchoConfig): string {
    const status = this.api.status();
    return [
      config.baseUrl,
      config.workspace,
      String(status.user_peer || config.userPeer),
      String(status.ai_peer || config.aiPeer),
      String(status.identity_revision || 0),
      config.sessionStrategy,
    ].join("\u0000");
  }

  private bumpDecision(state: ChatState, reason: MessageDecisionReason): void {
    if (reason === "accepted_final") state.metrics.acceptedFinal += 1;
    if (reason === "skipped_incomplete") state.metrics.skippedIncomplete += 1;
    if (reason === "skipped_thinking") state.metrics.skippedThinking += 1;
    if (reason === "skipped_tool") state.metrics.skippedTool += 1;
    if (reason === "skipped_system") state.metrics.skippedSystem += 1;
    if (reason === "skipped_unknown_kind") state.metrics.skippedUnknownKind += 1;
  }

  private ledger(state: ChatState, namespace: string, legacy = false): Set<string> {
    const ledgers = legacy ? state.legacyLedgers : state.sourceLedgers;
    let ledger = ledgers.get(namespace);
    if (!ledger) {
      ledger = new Set<string>();
      ledgers.set(namespace, ledger);
    }
    return ledger;
  }

  private async reconcile(state: ChatState, item: PendingMessage, force = false): Promise<void> {
    if (!force && state.reconciledNamespaces.has(item.namespace)) return;
    try {
      const snapshot = await item.api.getMessageLedger(item.chatId, 100);
      const sourceLedger = this.ledger(state, item.namespace);
      const legacyLedger = this.ledger(state, item.namespace, true);
      for (const key of snapshot.sourceKeys) sourceLedger.add(key);
      for (const key of snapshot.legacyKeys) legacyLedger.add(key);
      state.reconciledNamespaces.add(item.namespace);
      state.metrics.reconciled += 1;
    } catch (error) {
      console.log(`[honcho] message reconcile failed: ${String(error)}`);
    }
  }

  private ledgerHas(state: ChatState, item: PendingMessage): boolean {
    if (this.ledger(state, item.namespace).has(item.sourceKey)) return true;
    const legacy = this.ledger(state, item.namespace, true);
    return legacyKeysFor(item.role, item.content, item.identityTime).some((key) => legacy.has(key));
  }

  queuePersistedMessage(input: PersistedMessageInput): void {
    const config = this.refreshConfig();
    if (!isConfigured(config) || !config.saveMessages) return;
    const chatId = String(input.chatId || "default");
    const state = this.chat(chatId);
    const classification = classifyPersistedMessage(input);
    this.bumpDecision(state, classification.reason);
    const content = classification.role
      ? contentForPersistedMessage(input, classification.role)
      : normalizeMessageContent(input.content || "");
    if (!classification.accepted || !classification.role || !content) return;

    const sourceKey = sourceKeyFor(input, classification.role, content);
    const namespace = this.writeNamespace(config);
    const dedupeKey = `${namespace}\u0000${sourceKey}`;
    if (state.seen.has(dedupeKey) || state.inFlight.has(dedupeKey)) {
      state.metrics.duplicateSkipped += 1;
      return;
    }
    state.pending.push({
      dedupeKey,
      sourceKey,
      namespace,
      chatId,
      role: classification.role,
      content,
      identityTime: Math.max(0, Math.trunc(Number(input.timestamp || input.sentAt || 0))),
      sentAt: Math.max(0, Math.trunc(Number(input.sentAt || 0))),
      variantIndex: Math.max(0, Math.trunc(Number(input.selectedVariantIndex || 0))),
      api: this.api,
    });
    state.inFlight.add(dedupeKey);
    state.metrics.queued += 1;
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
          await this.reconcile(state, item);
          if (this.ledgerHas(state, item)) {
            state.metrics.duplicateSkipped += 1;
            this.remember(state, item.dedupeKey);
            state.inFlight.delete(item.dedupeKey);
            continue;
          }
          let lastError: unknown = null;
          let sent = false;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await item.api.addMessage(item.chatId, item.role, item.content, item.sourceKey, {
                sentAt: item.sentAt,
                variantIndex: item.variantIndex,
              });
              sent = true;
              break;
            } catch (error) {
              lastError = error;
              await this.reconcile(state, item, true);
              if (this.ledgerHas(state, item)) {
                sent = true;
                break;
              }
              if (attempt === 0) state.metrics.retryAfterUnknownResult += 1;
            }
          }
          if (!sent) {
            state.lastWriteError = String(lastError || "Unknown Honcho write error");
            state.pending.push(item);
            continue;
          }
          this.ledger(state, item.namespace).add(item.sourceKey);
          for (const key of legacyKeysFor(item.role, item.content, item.identityTime)) {
            this.ledger(state, item.namespace, true).add(key);
          }
          this.remember(state, item.dedupeKey);
          state.inFlight.delete(item.dedupeKey);
          state.metrics.written += 1;
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

  status(): JsonRecord {
    this.refreshConfig();
    const states = Array.from(this.chats.values());
    const pending = states.reduce((sum, state) => sum + state.pending.length, 0);
    const writing = states.filter((state) => state.flushPromise !== null).length;
    const lastWriteError = states.map((state) => state.lastWriteError).find(Boolean) || "";
    const metric = (key: keyof ControllerMetrics): number =>
      states.reduce((sum, state) => sum + state.metrics[key], 0);
    return {
      ...this.api.status(),
      pending_messages: pending,
      active_writes: writing,
      last_write_error: lastWriteError,
      queued: metric("queued"),
      written: metric("written"),
      duplicate_skipped: metric("duplicateSkipped"),
      reconciled: metric("reconciled"),
      retry_after_unknown_result: metric("retryAfterUnknownResult"),
      accepted_final: metric("acceptedFinal"),
      skipped_incomplete: metric("skippedIncomplete"),
      skipped_thinking: metric("skippedThinking"),
      skipped_tool: metric("skippedTool"),
      skipped_variant: metric("skippedVariant"),
      skipped_system: metric("skippedSystem"),
      skipped_unknown_kind: metric("skippedUnknownKind"),
    };
  }

  async call(operation: string, params: JsonRecord): Promise<JsonRecord> {
    const config = this.refreshConfig();
    if (operation === "status") return this.status();
    if (!isConfigured(config)) {
      throw new Error("Honcho is not configured. Set HONCHO_API_KEY, or HONCHO_BASE_URL for self-hosting, and enable the package.");
    }
    const chatId = String(params.chatId || params.chat_id || "default");
    const peer = String(params.peer || "user");
    const resolvedPeer = await this.api.resolvePeerDetails(peer);
    const resolved = {
      resolved_peer_id: resolvedPeer.id,
      ...(resolvedPeer.displayName ? { resolved_peer_name: resolvedPeer.displayName } : {}),
    };

    if (operation === "profile") {
      const card = Array.isArray(params.card) ? params.card.map(String) : null;
      const result = card ? await this.api.setProfile(card, resolvedPeer.id) : await this.api.getProfile(resolvedPeer.id);
      return result.length
        ? { ...resolved, result, card: result }
        : {
            ...resolved,
            result: "No profile facts available yet.",
            hint: "This is not an error. Honcho builds peer cards over time from observed conversation.",
          };
    }
    if (operation === "search") {
      const query = String(params.query || "").trim();
      if (!query) throw new Error("Missing required parameter: query");
      const maxTokens = Number(params.max_tokens || 800);
      const result = await this.api.search(query, maxTokens, resolvedPeer.id);
      return { ...resolved, result: result || "No relevant context found." };
    }
    if (operation === "context") {
      const context = await this.api.getContext(chatId, String(params.query || ""), resolvedPeer.id);
      const recent = context.recentMessages?.slice(-5).map((item) => `  [${item.role}] ${item.content.slice(0, 200)}`).join("\n");
      const result = [formatMemoryContext(context), recent ? `## Recent messages\n${recent}` : ""]
        .filter(Boolean)
        .join("\n\n");
      return { ...resolved, result: result || "No context available yet.", context };
    }
    if (operation === "reasoning") {
      const query = String(params.query || "").trim();
      if (!query) throw new Error("Missing required parameter: query");
      const requested = String(params.reasoning_level || config.dialecticReasoningLevel) as ReasoningLevel;
      const allowed: ReasoningLevel[] = ["minimal", "low", "medium", "high", "max"];
      const level = allowed.includes(requested) ? requested : config.dialecticReasoningLevel;
      const result = await this.api.reason(chatId, query, level, resolvedPeer.id);
      return { ...resolved, result: result || "No result from Honcho." };
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
        const conclusions = await this.api.listConclusions(String(params.query || ""), resolvedPeer.id, 20);
        return { ...resolved, conclusions };
      }
      if (deleteId) {
        await this.api.deleteConclusion(deleteId);
        return { ...resolved, result: `Conclusion ${deleteId} deleted.` };
      }
      const outcome = await this.api.createConclusionIdempotent(chatId, conclusion, resolvedPeer.id);
      return {
        ...resolved,
        result: outcome.created
          ? `Conclusion saved for ${resolvedPeer.id}: ${conclusion}`
          : `Conclusion already exists for ${resolvedPeer.id}: ${conclusion}`,
        created: outcome.created,
        existing_conclusion_id: outcome.created ? undefined : outcome.conclusion.id,
        conclusions: [outcome.conclusion],
      };
    }
    throw new Error(`Unknown Honcho operation: ${operation}`);
  }
}