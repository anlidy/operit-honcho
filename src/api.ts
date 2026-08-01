import { HonchoConfig, ReasoningLevel } from "./config";
import { contentOf, MemoryContext, toStringArray } from "./format";
import {
  legacyWorkspaceIdentity,
  metadataWithWorkspaceIdentity,
  peerDisplayName,
  WorkspaceIdentity,
  workspaceIdentity,
} from "./identity";
import {
  legacyKeysFor,
  MessageLedger,
  normalizeMessageContent,
  PersistedRole,
  sourceKeyFromMetadata,
} from "./message";

export type JsonRecord = Record<string, unknown>;

export interface HttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: object;
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
  workspace_id?: string;
  metadata?: JsonRecord;
  token_count?: number;
  created_at?: string;
}

export interface HonchoWorkspace {
  id: string;
  metadata?: JsonRecord;
  configuration?: JsonRecord;
  created_at?: string;
}

export interface HonchoPeer {
  id: string;
  workspace_id?: string;
  metadata?: JsonRecord;
  configuration?: JsonRecord;
  created_at?: string;
}

export interface HonchoSession {
  id: string;
  workspace_id?: string;
  is_active?: boolean;
  metadata?: JsonRecord;
  configuration?: JsonRecord;
  created_at?: string;
}

export interface HonchoPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface HonchoQueueStatus {
  total_work_units: number;
  completed_work_units: number;
  in_progress_work_units: number;
  pending_work_units: number;
  sessions?: JsonRecord | null;
}

export interface Conclusion {
  id: string;
  content: string;
  observer_id?: string;
  observed_id?: string;
  session_id?: string | null;
  level?: "explicit" | "deductive" | "inductive" | "contradiction";
  created_at?: string;
}
export interface ConclusionCreateResult {
  created: boolean;
  conclusion: Conclusion;
}

export interface ResolvedPeer {
  id: string;
  displayName: string;
}

export interface WorkspaceIdentityStatus extends WorkspaceIdentity {
  workspaceId: string;
}


export class HonchoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    const detail = responseBody ? `: ${responseBody.slice(0, 1000)}` : "";
    super(`Honcho HTTP ${status}${detail}`);
    this.name = "HonchoHttpError";
  }
}

export async function operitHttpTransport(request: HttpRequest): Promise<HttpResponse> {
  const response = await Tools.Net.http({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    responseType: "text",
    connect_timeout: 15000,
    read_timeout: 60000,
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

function parsePage<T>(value: unknown): HonchoPage<T> {
  const page = asRecord(value);
  const number = (key: string, fallback: number): number => {
    const parsed = Number(page[key]);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
  };
  return {
    items: Array.isArray(page.items) ? (page.items as T[]) : [],
    total: number("total", 0),
    page: Math.max(1, number("page", 1)),
    size: Math.max(1, number("size", 20)),
    pages: number("pages", 0),
  };
}

function pageParams(page: number, size: number, reverse: boolean): Record<string, unknown> {
  return {
    page: Math.max(1, Math.trunc(page)),
    size: Math.max(1, Math.min(100, Math.trunc(size))),
    reverse,
  };
}

export class HonchoApi {
  private readonly workspaceId: string;
  private userPeerId: string;
  private aiPeerId: string;
  private identity: WorkspaceIdentity;
  private workspaceReady = false;
  private workspaceRefreshAt = 0;
  private workspacePromise: Promise<void> | null = null;
  private workspaceMetadata: JsonRecord = {};
  private readonly peersReady = new Set<string>();
  private readonly peerDetails = new Map<string, HonchoPeer>();
  private readonly sessionsReady = new Set<string>();

  constructor(
    readonly config: HonchoConfig,
    private readonly transport: HttpTransport = operitHttpTransport
  ) {
    this.workspaceId = sanitizeId(config.workspace, "operit");
    this.identity = legacyWorkspaceIdentity(config.userPeer, config.aiPeer);
    this.userPeerId = this.identity.userPeerId;
    this.aiPeerId = this.identity.aiPeerId;
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
    body?: object
  ): Promise<T> {
    const startedAt = Date.now();
    let response: HttpResponse;
    try {
      response = await this.transport({
        method,
        url: `${this.config.baseUrl}${path}`,
        headers: this.headers(),
        body,
      });
    } catch (error) {
      console.log(`[honcho] http method=${method} duration_ms=${Date.now() - startedAt} status=network_error`);
      throw error;
    }
    console.log(
      `[honcho] http method=${method} duration_ms=${Date.now() - startedAt} status=${response.statusCode}`
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new HonchoHttpError(response.statusCode, response.content || "");
    }
    if (!response.content.trim()) return undefined as T;
    try {
      return JSON.parse(response.content) as T;
    } catch (error) {
      throw new Error(`Honcho returned invalid JSON: ${String(error)}`);
    }
  }

  private workspacePath(path = ""): string {
    return this.workspacePathFor(this.workspaceId, path);
  }

  private workspacePathFor(workspaceId: string, path = ""): string {
    return `/v3/workspaces/${encodeURIComponent(String(workspaceId).trim())}${path}`;
  }

  async listWorkspaces(
    page = 1,
    size = 20,
    reverse = false,
    filters?: JsonRecord
  ): Promise<HonchoPage<HonchoWorkspace>> {
    const result = await this.request<unknown>(
      "POST",
      `/v3/workspaces/list${queryString(pageParams(page, size, reverse))}`,
      filters ? { filters } : {}
    );
    return parsePage<HonchoWorkspace>(result);
  }

  async listPeers(
    workspaceId: string,
    page = 1,
    size = 20,
    reverse = true,
    filters?: JsonRecord
  ): Promise<HonchoPage<HonchoPeer>> {
    const result = await this.request<unknown>(
      "POST",
      `${this.workspacePathFor(workspaceId, "/peers/list")}${queryString(pageParams(page, size, reverse))}`,
      filters ? { filters } : {}
    );
    return parsePage<HonchoPeer>(result);
  }

  async getPeerReadOnly(workspaceId: string, peerId: string): Promise<HonchoPeer> {
    const page = await this.listPeers(workspaceId, 1, 2, false, { id: peerId });
    const peer = page.items.find((item) => item.id === peerId);
    if (!peer) throw new HonchoHttpError(404, `Peer ${peerId} was not found.`);
    return peer;
  }

  async createPeer(
    workspaceId: string,
    peerId: string,
    metadata: JsonRecord = {}
  ): Promise<HonchoPeer> {
    const peer = await this.request<HonchoPeer>(
      "POST",
      this.workspacePathFor(workspaceId, "/peers"),
      { id: peerId, metadata }
    );
    if (workspaceId === this.workspaceId) this.rememberPeer(peer);
    return peer;
  }

  async updatePeerMetadata(
    workspaceId: string,
    peerId: string,
    metadata: JsonRecord
  ): Promise<HonchoPeer> {
    const peer = await this.request<HonchoPeer>(
      "PUT",
      this.workspacePathFor(workspaceId, `/peers/${encodeURIComponent(peerId)}`),
      { metadata }
    );
    if (workspaceId === this.workspaceId) this.rememberPeer(peer);
    return peer;
  }

  async listPeerSessions(
    workspaceId: string,
    peerId: string,
    page = 1,
    size = 20,
    reverse = true,
    filters?: JsonRecord
  ): Promise<HonchoPage<HonchoSession>> {
    const path = this.workspacePathFor(
      workspaceId,
      `/peers/${encodeURIComponent(peerId)}/sessions`
    );
    const result = await this.request<unknown>(
      "POST",
      `${path}${queryString(pageParams(page, size, reverse))}`,
      filters ? { filters } : {}
    );
    return parsePage<HonchoSession>(result);
  }

  async getPeerCardReadOnly(
    workspaceId: string,
    observerPeerId: string,
    targetPeerId: string
  ): Promise<string[]> {
    const result = asRecord(await this.request<unknown>(
      "GET",
      this.workspacePathFor(
        workspaceId,
        `/peers/${encodeURIComponent(observerPeerId)}/card${queryString({ target: targetPeerId })}`
      )
    ));
    return toStringArray(result.peer_card);
  }

  async removePeerFromSession(
    workspaceId: string,
    sessionId: string,
    peerId: string
  ): Promise<HonchoSession> {
    return this.request<HonchoSession>(
      "DELETE",
      this.workspacePathFor(
        workspaceId,
        `/sessions/${encodeURIComponent(sessionId)}/peers`
      ),
      [peerId]
    );
  }

  async listSessions(
    workspaceId: string,
    page = 1,
    size = 20,
    reverse = true
  ): Promise<HonchoPage<HonchoSession>> {
    const result = await this.request<unknown>(
      "POST",
      `${this.workspacePathFor(workspaceId, "/sessions/list")}${queryString(pageParams(page, size, reverse))}`,
      {}
    );
    return parsePage<HonchoSession>(result);
  }

  async listMessages(
    workspaceId: string,
    sessionId: string,
    page = 1,
    size = 30,
    reverse = false
  ): Promise<HonchoPage<HonchoMessage>> {
    const path = this.workspacePathFor(
      workspaceId,
      `/sessions/${encodeURIComponent(String(sessionId).trim())}/messages/list`
    );
    const result = await this.request<unknown>(
      "POST",
      `${path}${queryString(pageParams(page, size, reverse))}`,
      {}
    );
    return parsePage<HonchoMessage>(result);
  }

  async listConclusionsGeneric(
    workspaceId: string,
    page = 1,
    size = 20,
    reverse = false,
    filters?: JsonRecord
  ): Promise<HonchoPage<Conclusion>> {
    const result = await this.request<unknown>(
      "POST",
      `${this.workspacePathFor(workspaceId, "/conclusions/list")}${queryString(
        pageParams(page, size, reverse)
      )}`,
      filters && Object.keys(filters).length ? { filters } : {}
    );
    return parsePage<Conclusion>(result);
  }

  async queryConclusionsGeneric(
    workspaceId: string,
    query: string,
    topK = 20,
    filters?: JsonRecord
  ): Promise<Conclusion[]> {
    return this.request<Conclusion[]>(
      "POST",
      this.workspacePathFor(workspaceId, "/conclusions/query"),
      {
        query: clipQuery(query, 4000),
        top_k: Math.max(1, Math.min(100, Math.trunc(topK))),
        ...(filters && Object.keys(filters).length ? { filters } : {}),
      }
    );
  }

  async deleteConclusionFor(workspaceId: string, id: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      this.workspacePathFor(workspaceId, `/conclusions/${encodeURIComponent(id)}`)
    );
  }

  async getQueueStatus(workspaceId: string): Promise<HonchoQueueStatus> {
    return this.request<HonchoQueueStatus>(
      "GET",
      this.workspacePathFor(workspaceId, "/queue/status")
    );
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

  private applyIdentity(next: WorkspaceIdentity): void {
    const changed = next.revision !== this.identity.revision
      || next.userPeerId !== this.userPeerId
      || next.aiPeerId !== this.aiPeerId
      || next.source !== this.identity.source;
    this.identity = next;
    this.userPeerId = next.userPeerId;
    this.aiPeerId = next.aiPeerId;
    if (changed) {
      this.peersReady.clear();
      this.peerDetails.clear();
      this.sessionsReady.clear();
    }
  }

  private rememberPeer(peer: HonchoPeer): HonchoPeer {
    this.peersReady.add(peer.id);
    this.peerDetails.set(peer.id, peer);
    return peer;
  }

  private async findPeer(peerId: string): Promise<HonchoPeer | null> {
    const cached = this.peerDetails.get(peerId);
    if (cached) return cached;
    const page = await this.listPeers(this.workspaceId, 1, 2, false, { id: peerId });
    const peer = page.items.find((item) => item.id === peerId) || null;
    return peer ? this.rememberPeer(peer) : null;
  }

  private async requireExistingPeer(peerId: string): Promise<HonchoPeer> {
    const peer = await this.findPeer(peerId);
    if (!peer) {
      throw new Error(`PEER_NOT_FOUND: Peer ${peerId} does not exist in Workspace ${this.workspaceId}.`);
    }
    return peer;
  }

  async getWorkspaceIdentityReadOnly(): Promise<WorkspaceIdentityStatus> {
    const page = await this.listWorkspaces(1, 2, false, { id: this.workspaceId });
    const workspace = page.items.find((item) => item.id === this.workspaceId);
    if (!workspace) {
      throw new HonchoHttpError(404, `Workspace ${this.workspaceId} was not found.`);
    }
    const identity = workspaceIdentity(
      workspace.metadata,
      legacyWorkspaceIdentity(this.config.userPeer, this.config.aiPeer)
    );
    const [user, ai] = await Promise.all([
      this.findPeer(identity.userPeerId),
      this.findPeer(identity.aiPeerId),
    ]);
    if (!user || !ai) {
      throw new Error("INVALID_IDENTITY_METADATA: configured User and AI Peers must already exist.");
    }
    return { ...identity, workspaceId: this.workspaceId };
  }

  async ensureWorkspace(): Promise<void> {
    if (this.workspaceReady && Date.now() < this.workspaceRefreshAt) return;
    if (this.workspacePromise) return this.workspacePromise;

    const refresh = async (): Promise<void> => {
      const workspace = await this.request<HonchoWorkspace>("POST", "/v3/workspaces", { id: this.workspaceId });
      this.workspaceMetadata = asRecord(workspace?.metadata);
      const next = workspaceIdentity(
        this.workspaceMetadata,
        legacyWorkspaceIdentity(this.config.userPeer, this.config.aiPeer)
      );
      this.applyIdentity(next);

      if (next.source === "workspace_metadata") {
        const [user, ai] = await Promise.all([
          this.requireExistingPeer(next.userPeerId),
          this.requireExistingPeer(next.aiPeerId),
        ]);
        this.rememberPeer(user);
        this.rememberPeer(ai);
      } else {
        const [user, ai] = await Promise.all([
          this.request<HonchoPeer>("POST", this.workspacePath("/peers"), { id: next.userPeerId }),
          this.request<HonchoPeer>("POST", this.workspacePath("/peers"), { id: next.aiPeerId }),
        ]);
        this.rememberPeer({ ...user, id: user?.id || next.userPeerId });
        this.rememberPeer({ ...ai, id: ai?.id || next.aiPeerId });
      }
      this.workspaceReady = true;
      this.workspaceRefreshAt = Date.now() + 15000;
    };

    this.workspacePromise = refresh();
    try {
      await this.workspacePromise;
    } finally {
      this.workspacePromise = null;
    }
  }

  async getWorkspaceIdentity(): Promise<WorkspaceIdentityStatus> {
    await this.ensureWorkspace();
    return { ...this.identity, workspaceId: this.workspaceId };
  }

  async setWorkspaceIdentity(userPeerId: string, aiPeerId: string): Promise<WorkspaceIdentityStatus> {
    await this.ensureWorkspace();
    const metadata = metadataWithWorkspaceIdentity(
      this.workspaceMetadata,
      userPeerId,
      aiPeerId,
      this.identity.revision
    );
    await Promise.all([
      this.requireExistingPeer(String(userPeerId).trim()),
      this.requireExistingPeer(String(aiPeerId).trim()),
    ]);
    const workspace = await this.request<HonchoWorkspace>(
      "PUT",
      this.workspacePath(),
      { metadata }
    );
    this.workspaceMetadata = asRecord(workspace?.metadata || metadata);
    this.applyIdentity(workspaceIdentity(
      this.workspaceMetadata,
      legacyWorkspaceIdentity(this.config.userPeer, this.config.aiPeer)
    ));
    this.workspaceReady = true;
    this.workspaceRefreshAt = Date.now() + 15000;
    return { ...this.identity, workspaceId: this.workspaceId };
  }

  async ensureSession(chatId: string): Promise<string> {
    await this.ensureWorkspace();
    const sessionId = sessionIdFor(this.config, chatId);
    if (this.sessionsReady.has(sessionId)) return sessionId;
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
    if (/^operit_.+_[0-9a-f]{8}$/i.test(String(peer || "").trim())) {
      throw new Error(
        "INVALID_PEER_ID: peer looks like an Operit Session ID; pass it as chat_id instead."
      );
    }
    return sanitizeId(peer, "peer");
  }

  async resolvePeerDetails(peer = "user"): Promise<ResolvedPeer> {
    await this.ensureWorkspace();
    const id = this.resolvePeer(peer);
    const detail = await this.requireExistingPeer(id);
    return { id, displayName: peerDisplayName(detail.metadata) };
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

  async addMessage(
    chatId: string,
    role: PersistedRole,
    content: string,
    sourceKey = "",
    source?: { sentAt?: number; variantIndex?: number }
  ): Promise<number> {
    const sessionId = await this.ensureSession(chatId);
    const peerId = role === "assistant" ? this.aiPeerId : this.userPeerId;
    const chunks = this.chunks(content);
    const messages = chunks.map((chunk, index) => {
      const chunkSourceKey = chunks.length > 1
        ? `${sourceKey}:chunk:${index + 1}/${chunks.length}`
        : sourceKey;
      const metadata = sourceKey
        ? {
            operit: {
              schema_version: 1,
              source_key: chunkSourceKey,
              source_message_key: sourceKey,
              role,
              sent_at: Math.max(0, Math.trunc(Number(source?.sentAt || 0))),
              variant_index: Math.max(0, Math.trunc(Number(source?.variantIndex || 0))),
            },
          }
        : undefined;
      return { content: chunk, peer_id: peerId, metadata };
    });
    if (!messages.length) return 0;
    await this.request("POST", this.workspacePath(`/sessions/${encodeURIComponent(sessionId)}/messages`), {
      messages,
    });
    return messages.length;
  }

  async getMessageLedger(chatId: string, limit = 100): Promise<MessageLedger> {
    const sessionId = await this.ensureSession(chatId);
    const result = await this.listMessages(
      this.workspaceId,
      sessionId,
      1,
      Math.max(1, Math.min(100, Math.trunc(limit))),
      true
    );
    const sourceKeys = new Set<string>();
    const legacyKeys = new Set<string>();
    for (const message of result.items) {
      const sourceKey = sourceKeyFromMetadata(message.metadata);
      if (sourceKey) sourceKeys.add(sourceKey);

      const role: PersistedRole | null = message.peer_id === this.aiPeerId
        ? "assistant"
        : message.peer_id === this.userPeerId
          ? "user"
          : null;
      const createdAt = Date.parse(String(message.created_at || ""));
      if (!role || !Number.isFinite(createdAt)) continue;
      for (const key of legacyKeysFor(role, String(message.content || ""), createdAt)) {
        legacyKeys.add(key);
      }
    }
    return { sourceKeys: Array.from(sourceKeys), legacyKeys: Array.from(legacyKeys) };
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
    await this.requireExistingPeer(target);
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
    await this.requireExistingPeer(target);
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
    await this.requireExistingPeer(target);
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
    await this.requireExistingPeer(peerId);
    const charBudget = Math.max(200, Math.min(2000, maxTokens) * 4);
    const limit = Math.max(3, Math.min(20, Math.floor(charBudget / 300)));
    const messages = await this.request<HonchoMessage[]>("POST", this.workspacePath("/search"), {
      query: clipQuery(query, 4000),
      filters: { peer_id: peerId },
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
    await this.requireExistingPeer(target);
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
    await this.requireExistingPeer(target);
    return this.request<Conclusion[]>("POST", this.workspacePath("/conclusions"), {
      conclusions: [{
        content: String(content || "").trim(),
        observer_id: observer,
        observed_id: target,
        session_id: sessionId,
      }],
    });
  }

  async createConclusionIdempotent(
    chatId: string,
    content: string,
    peer = "user"
  ): Promise<ConclusionCreateResult> {
    const cleanContent = normalizeMessageContent(content);
    const sessionId = await this.ensureSession(chatId);
    const { observer, target } = this.observerAndTarget(peer);
    await this.requireExistingPeer(target);
    const filters = { observer_id: observer, observed_id: target, session_id: sessionId };
    const page = asRecord(
      await this.request<unknown>(
        "POST",
        this.workspacePath(`/conclusions/list${queryString({ size: 100, reverse: false })}`),
        { filters }
      )
    );
    const existing = (Array.isArray(page.items) ? page.items : [])
      .map((item) => asRecord(item) as unknown as Conclusion)
      .find((item) => normalizeMessageContent(item.content) === cleanContent);
    if (existing) return { created: false, conclusion: existing };

    const created = await this.request<Conclusion[]>(
      "POST",
      this.workspacePath("/conclusions"),
      {
        conclusions: [{
          content: cleanContent,
          observer_id: observer,
          observed_id: target,
          session_id: sessionId,
        }],
      }
    );
    const conclusion = created?.[0];
    if (!conclusion) throw new Error("Honcho did not return the created conclusion.");
    return { created: true, conclusion };
  }

  async deleteConclusion(id: string): Promise<void> {
    await this.ensureWorkspace();
    await this.deleteConclusionFor(this.workspaceId, id);
  }

  async listConclusions(query = "", peer = "user", limit = 20): Promise<Conclusion[]> {
    await this.ensureWorkspace();
    const { observer, target } = this.observerAndTarget(peer);
    await this.requireExistingPeer(target);
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
      identity_source: this.identity.source,
      identity_revision: this.identity.revision,
      identity_migration_required: this.identity.migrationRequired,
      recall_mode: this.config.recallMode,
      observation_mode: this.config.observationMode,
      session_strategy: this.config.sessionStrategy,
      save_messages: this.config.saveMessages,
      api_key_set: Boolean(this.config.apiKey),
    };
  }
}