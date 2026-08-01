import { HonchoConfig, ReasoningLevel } from "./config";
import { contentOf, MemoryContext, toStringArray } from "./format";

export type JsonRecord = Record<string, unknown>;

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: JsonRecord;
}

export interface HttpResponse {
  statusCode: number;
  content: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export interface HonchoMessage {
  id?: string;
  content?: string;
  peer_id?: string;
  session_id?: string;
  created_at?: string;
}

export interface Conclusion {
  id: string;
  content: string;
  observer_id?: string;
  observed_id?: string;
  session_id?: string | null;
  created_at?: string;
}

export async function operitHttpTransport(request: HttpRequest): Promise<HttpResponse> {
  const response = await Tools.Net.http({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    responseType: "text",
    follow_redirects: true,
    validateStatus: false,
  });
  return { statusCode: response.statusCode, content: response.content || "" };
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

export function sanitizeId(value: string, fallback: string, maxLength = 100): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  if (cleaned) return cleaned;
  return `${fallback}_${hash(value || fallback)}`.slice(0, maxLength);
}

export function sessionIdFor(config: HonchoConfig, chatId: string): string {
  if (config.sessionStrategy === "global") return sanitizeId(config.workspace, "operit");
  const raw = String(chatId || "default");
  const prefix = "operit_";
  const suffix = `_${hash(raw)}`;
  const visible = sanitizeId(raw, "chat", 100 - prefix.length - suffix.length);
  return `${prefix}${visible}${suffix}`;
}

function queryString(values: Record<string, unknown>): string {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}

function clipQuery(value: string, maxChars: number): string {
  const input = String(value || "").trim();
  return input.length <= maxChars ? input : input.slice(0, maxChars);
}

export class HonchoApi {
  private readonly workspaceId: string;
  private readonly userPeerId: string;
  private readonly aiPeerId: string;
  private workspaceReady = false;
  private readonly peersReady = new Set<string>();
  private readonly sessionsReady = new Set<string>();

  constructor(
    readonly config: HonchoConfig,
    private readonly transport: HttpTransport = operitHttpTransport
  ) {
    this.workspaceId = sanitizeId(config.workspace, "operit");
    this.userPeerId = sanitizeId(config.userPeer, "user");
    this.aiPeerId = sanitizeId(config.aiPeer, "operit");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private async request<T>(
    method: HttpRequest["method"],
    path: string,
    body?: JsonRecord
  ): Promise<T> {
    const response = await this.transport({
      method,
      url: `${this.config.baseUrl}${path}`,
      headers: this.headers(),
      body,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = response.content ? `: ${response.content.slice(0, 1000)}` : "";
      throw new Error(`Honcho HTTP ${response.statusCode}${detail}`);
    }
    if (!response.content.trim()) return undefined as T;
    try {
      return JSON.parse(response.content) as T;
    } catch (error) {
      throw new Error(`Honcho returned invalid JSON: ${String(error)}`);
    }
  }

  private workspacePath(path = ""): string {
    return `/v3/workspaces/${encodeURIComponent(this.workspaceId)}${path}`;
  }

  private observationPeers(): JsonRecord {
    if (this.config.observationMode === "unified") {
      return {
        [this.userPeerId]: { observe_me: true, observe_others: false },
        [this.aiPeerId]: { observe_me: false, observe_others: true },
      };
    }
    return {
      [this.userPeerId]: { observe_me: true, observe_others: true },
      [this.aiPeerId]: { observe_me: true, observe_others: true },
    };
  }

  async ensureWorkspace(): Promise<void> {
    if (this.workspaceReady) return;
    await this.request("POST", "/v3/workspaces", { id: this.workspaceId });
    await Promise.all([
      this.request("POST", this.workspacePath("/peers"), { id: this.userPeerId }),
      this.request("POST", this.workspacePath("/peers"), { id: this.aiPeerId }),
    ]);
    this.peersReady.add(this.userPeerId);
    this.peersReady.add(this.aiPeerId);
    this.workspaceReady = true;
  }

  private async ensurePeer(peerId: string): Promise<void> {
    await this.ensureWorkspace();
    if (this.peersReady.has(peerId)) return;
    await this.request("POST", this.workspacePath("/peers"), { id: peerId });
    this.peersReady.add(peerId);
  }

  async ensureSession(chatId: string): Promise<string> {
    const sessionId = sessionIdFor(this.config, chatId);
    if (this.sessionsReady.has(sessionId)) return sessionId;
    await this.ensureWorkspace();
    await this.request("POST", this.workspacePath("/sessions"), {
      id: sessionId,
      peers: this.observationPeers(),
    });
    this.sessionsReady.add(sessionId);
    return sessionId;
  }

  resolvePeer(peer = "user"): string {
    const value = String(peer || "user").trim().toLowerCase();
    if (value === "user") return this.userPeerId;
    if (value === "ai" || value === "assistant") return this.aiPeerId;
    return sanitizeId(peer, "peer");
  }

  private observerAndTarget(peer = "user"): { observer: string; target: string } {
    const target = this.resolvePeer(peer);
    return { observer: this.aiPeerId, target };
  }

  private chunks(content: string): string[] {
    const max = this.config.messageMaxChars;
    const clean = String(content || "").trim();
    if (!clean) return [];
    if (clean.length <= max) return [clean];
    const chunks: string[] = [];
    let offset = 0;
    while (offset < clean.length) {
      const suffix = offset === 0 ? "" : "[continued] ";
      const room = Math.max(1, max - suffix.length);
      chunks.push(`${suffix}${clean.slice(offset, offset + room)}`);
      offset += room;
    }
    return chunks;
  }

  async addMessage(chatId: string, role: "user" | "assistant", content: string): Promise<number> {
    const sessionId = await this.ensureSession(chatId);
    const peerId = role === "assistant" ? this.aiPeerId : this.userPeerId;
    const messages = this.chunks(content).map((chunk) => ({ content: chunk, peer_id: peerId }));
    if (!messages.length) return 0;
    await this.request("POST", this.workspacePath(`/sessions/${encodeURIComponent(sessionId)}/messages`), {
      messages,
    });
    return messages.length;
  }

  private parseContext(sessionValue: unknown, aiValue: unknown): MemoryContext {
    const session = asRecord(sessionValue);
    const ai = asRecord(aiValue);
    const summary = contentOf(session.summary);
    const representation = contentOf(session.representation || session.peer_representation);
    const card = toStringArray(session.peer_card || session.card);
    const aiRepresentation = contentOf(ai.representation || ai.peer_representation);
    const aiCard = toStringArray(ai.peer_card || ai.card);
    const rawMessages = Array.isArray(session.messages) ? session.messages : [];
    const recentMessages = rawMessages
      .map((item) => asRecord(item))
      .map((item) => ({
        role: String(item.peer_id || item.role || "unknown") === this.aiPeerId ? "assistant" : "user",
        content: String(item.content || ""),
      }))
      .filter((item) => item.content);
    return { summary, representation, card, aiRepresentation, aiCard, recentMessages };
  }

  async getContext(chatId: string, query = "", peer = "user"): Promise<MemoryContext> {
    const sessionId = await this.ensureSession(chatId);
    const { observer, target } = this.observerAndTarget(peer);
    await this.ensurePeer(target);
    const sessionPath = this.workspacePath(
      `/sessions/${encodeURIComponent(sessionId)}/context${queryString({
        tokens: this.config.contextTokens,
        summary: true,
        search_query: clipQuery(query, 4000),
        peer_target: target,
        peer_perspective: observer,
      })}`
    );
    const aiPath = this.workspacePath(
      `/peers/${encodeURIComponent(this.aiPeerId)}/context${queryString({ target: this.aiPeerId })}`
    );
    const [session, ai] = await Promise.all([
      this.request<unknown>("GET", sessionPath),
      this.request<unknown>("GET", aiPath),
    ]);
    return this.parseContext(session, ai);
  }

  async getProfile(peer = "user"): Promise<string[]> {
    await this.ensureWorkspace();
    const { observer, target } = this.observerAndTarget(peer);
    await this.ensurePeer(target);
    const result = asRecord(
      await this.request<unknown>(
        "GET",
        this.workspacePath(`/peers/${encodeURIComponent(observer)}/card${queryString({ target })}`)
      )
    );
    return toStringArray(result.peer_card);
  }

  async setProfile(card: string[], peer = "user"): Promise<string[]> {
    await this.ensureWorkspace();
    const { observer, target } = this.observerAndTarget(peer);
    await this.ensurePeer(target);
    const result = asRecord(
      await this.request<unknown>(
        "PUT",
        this.workspacePath(`/peers/${encodeURIComponent(observer)}/card${queryString({ target })}`),
        { peer_card: card.map(String).map((item) => item.trim()).filter(Boolean) }
      )
    );
    return toStringArray(result.peer_card);
  }

  async search(query: string, maxTokens = 800, peer = "user"): Promise<string> {
    await this.ensureWorkspace();
    const peerId = this.resolvePeer(peer);
    await this.ensurePeer(peerId);
    const charBudget = Math.max(200, Math.min(2000, maxTokens) * 4);
    const limit = Math.max(3, Math.min(20, Math.floor(charBudget / 300)));
    const messages = await this.request<HonchoMessage[]>("POST", this.workspacePath("/search"), {
      query: clipQuery(query, 4000),
      filters: { peer_perspective: peerId },
      limit,
    });
    const lines: string[] = [];
    let used = 0;
    for (const message of messages || []) {
      const content = String(message.content || "").trim();
      if (!content) continue;
      const author = message.peer_id === this.aiPeerId ? "assistant" : message.peer_id || "unknown";
      const label = `[${author}${message.session_id ? ` · ${message.session_id}` : ""}] `;
      const entry = `${label}${content.slice(0, 1200)}`;
      const remaining = charBudget - used - (lines.length ? 2 : 0);
      if (remaining <= 0) break;
      lines.push(entry.slice(0, remaining));
      used += Math.min(entry.length, remaining) + (lines.length > 1 ? 2 : 0);
    }
    return lines.join("\n\n");
  }

  async reason(
    chatId: string,
    query: string,
    reasoningLevel: ReasoningLevel = this.config.dialecticReasoningLevel,
    peer = "user"
  ): Promise<string> {
    const sessionId = await this.ensureSession(chatId);
    const { observer, target } = this.observerAndTarget(peer);
    await this.ensurePeer(target);
    const result = asRecord(
      await this.request<unknown>("POST", this.workspacePath(`/peers/${encodeURIComponent(observer)}/chat`), {
        session_id: sessionId,
        target,
        query: clipQuery(query, 10000),
        stream: false,
        reasoning_level: reasoningLevel,
      })
    );
    return contentOf(result.content);
  }

  async createConclusion(chatId: string, content: string, peer = "user"): Promise<Conclusion[]> {
    const sessionId = await this.ensureSession(chatId);
    const { observer, target } = this.observerAndTarget(peer);
    await this.ensurePeer(target);
    return this.request<Conclusion[]>("POST", this.workspacePath("/conclusions"), {
      conclusions: [{
        content: String(content || "").trim(),
        observer_id: observer,
        observed_id: target,
        session_id: sessionId,
      }],
    });
  }

  async deleteConclusion(id: string): Promise<void> {
    await this.ensureWorkspace();
    await this.request<void>("DELETE", this.workspacePath(`/conclusions/${encodeURIComponent(id)}`));
  }

  async listConclusions(query = "", peer = "user", limit = 20): Promise<Conclusion[]> {
    await this.ensureWorkspace();
    const { observer, target } = this.observerAndTarget(peer);
    await this.ensurePeer(target);
    const filters = { observer_id: observer, observed_id: target };
    if (query.trim()) {
      return this.request<Conclusion[]>("POST", this.workspacePath("/conclusions/query"), {
        query: clipQuery(query, 4000),
        top_k: Math.max(1, Math.min(100, limit)),
        filters,
      });
    }
    const page = asRecord(
      await this.request<unknown>(
        "POST",
        this.workspacePath(`/conclusions/list${queryString({ size: Math.max(1, Math.min(100, limit)) })}`),
        { filters }
      )
    );
    return Array.isArray(page.items) ? (page.items as unknown[]).map((item) => asRecord(item) as unknown as Conclusion) : [];
  }

  status(): JsonRecord {
    return {
      enabled: this.config.enabled,
      configured: this.config.enabled && Boolean(
        this.config.apiKey || this.config.baseUrl !== "https://api.honcho.dev"
      ),

      base_url: this.config.baseUrl,
      workspace: this.workspaceId,
      user_peer: this.userPeerId,
      ai_peer: this.aiPeerId,
      recall_mode: this.config.recallMode,
      save_messages: this.config.saveMessages,
      api_key_set: Boolean(this.config.apiKey),
    };
  }
}