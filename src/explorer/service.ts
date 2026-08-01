import {
  Conclusion,
  HonchoApi,
  HonchoHttpError,
  HonchoMessage,
  HonchoPage,
  HonchoPeer,
  HonchoQueueStatus,
  HonchoSession,
  HonchoWorkspace,
  JsonRecord,
  WorkspaceIdentityStatus,
} from "../api";
import { configSignature, HonchoConfig, isConfigured } from "../config";
import { metadataWithPeerProfile, peerArchived, peerDisplayName } from "../identity";
import { buildConclusionDuplicateGroups } from "./conclusions";
import {
  ConclusionCleanupPreviewDto,
  ConclusionCleanupResultDto,
  ConclusionDuplicateGroupDto,
  ConclusionDuplicateReportDto,
  ConclusionDto,
  ConclusionFiltersDto,
  ExplorerError,
  ExplorerPage,
  ExplorerRequest,
  ExplorerResponse,
  ExplorerStatusDto,
  MessageDto,
  PeerCardDto,
  PeerDto,
  PeerMutationKind,
  PeerMutationPreviewDto,
  PeerMutationResultDto,
  PromptSidecarClearPreviewDto,
  PromptSidecarClearResultDto,
  PromptSidecarStatusDto,
  QueueStatusDto,
  SessionDto,
  WorkspaceDto,
  WorkspaceIdentityDto,
  WorkspaceIdentityUpdatePreviewDto,
} from "./types";
import { ExplorerValidationError, pageOptions, parseExplorerRequest } from "./validation";

interface ExplorerController {
  getConfig(): HonchoConfig;
  status(): JsonRecord;
}

interface ExplorerApi {
  getWorkspaceIdentityReadOnly(): Promise<WorkspaceIdentityStatus>;
  getPeerReadOnly(workspaceId: string, peerId: string): Promise<HonchoPeer>;
  createPeer(workspaceId: string, peerId: string, metadata?: JsonRecord): Promise<HonchoPeer>;
  updatePeerMetadata(workspaceId: string, peerId: string, metadata: JsonRecord): Promise<HonchoPeer>;
  listWorkspaces(page: number, size: number, reverse: boolean): Promise<HonchoPage<HonchoWorkspace>>;
  listPeers(
    workspaceId: string,
    page: number,
    size: number,
    reverse: boolean,
    filters?: JsonRecord
  ): Promise<HonchoPage<HonchoPeer>>;
  listSessions(workspaceId: string, page: number, size: number, reverse: boolean): Promise<HonchoPage<HonchoSession>>;
  listPeerSessions(
    workspaceId: string,
    peerId: string,
    page: number,
    size: number,
    reverse: boolean,
    filters?: JsonRecord
  ): Promise<HonchoPage<HonchoSession>>;
  getPeerCardReadOnly(workspaceId: string, observerPeerId: string, targetPeerId: string): Promise<string[]>;
  removePeerFromSession(workspaceId: string, sessionId: string, peerId: string): Promise<HonchoSession>;
  listMessages(
    workspaceId: string,
    sessionId: string,
    page: number,
    size: number,
    reverse: boolean
  ): Promise<HonchoPage<HonchoMessage>>;
  listConclusionsGeneric(
    workspaceId: string,
    page: number,
    size: number,
    reverse: boolean,
    filters?: JsonRecord
  ): Promise<HonchoPage<Conclusion>>;
  queryConclusionsGeneric(
    workspaceId: string,
    query: string,
    topK: number,
    filters?: JsonRecord
  ): Promise<Conclusion[]>;
  deleteConclusionFor(workspaceId: string, id: string): Promise<void>;
  getQueueStatus(workspaceId: string): Promise<HonchoQueueStatus>;
  setWorkspaceIdentity(userPeerId: string, aiPeerId: string): Promise<WorkspaceIdentityStatus>;
}

interface PendingIdentityUpdate {
  configSignature: string;
  workspaceId: string;
  userPeerId: string;
  aiPeerId: string;
  previousUserPeerId: string;
  previousAiPeerId: string;
  previousRevision: number;
  expiresAt: number;
}

interface PendingPeerMutation {
  configSignature: string;
  workspaceId: string;
  mutation: PeerMutationKind;
  peerId: string;
  displayName?: string;
  archived?: boolean;
  sessionId?: string;
  previousDisplayName?: string;
  previousArchived?: boolean;
  expiresAt: number;
}

interface PendingConclusionCleanup {
  configSignature: string;
  workspaceId: string;
  groupKey: string;
  filters: JsonRecord;
  keepConclusionId: string;
  deleteConclusionIds: string[];
  confirmationPhrase: string;
  expiresAt: number;
}

interface PendingSidecarClear {
  fileCount: number;
  totalBytes: number;
  confirmationPhrase: string;
  expiresAt: number;
}

interface SidecarMaintenance {
  status(): Promise<PromptSidecarStatusDto>;
  clear(): Promise<PromptSidecarClearResultDto>;
}

interface ReadCacheEntry {
  workspaceId: string;
  operation: string;
  expiresAt: number;
  value: unknown;
}

const IDENTITY_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const PEER_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const CONCLUSION_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const SIDECAR_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const EXPLORER_READ_CACHE_TTL_MS = 30 * 1000;
const MAX_CONCLUSION_SCAN_ITEMS = 5000;

type ApiFactory = (config: HonchoConfig) => ExplorerApi;

function stringValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function errorFrom(error: unknown): ExplorerError {
  if (error instanceof ExplorerValidationError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof HonchoHttpError) {
    const code = error.status === 401
      ? "AUTHENTICATION_REQUIRED"
      : error.status === 403
        ? "PERMISSION_DENIED"
        : error.status === 404
          ? "NOT_FOUND"
          : error.status === 429
            ? "RATE_LIMITED"
            : "HONCHO_HTTP_ERROR";
    return {
      code,
      message: error.message,
      status: error.status,
      retryable: error.status === 429 || error.status >= 500,
    };
  }
  const message = error instanceof Error ? error.message : String(error || "Unknown Explorer error");
  return { code: "NETWORK_ERROR", message, retryable: true };
}

function requestIdFrom(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid-request";
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.trim()
    ? requestId.trim().slice(0, 128)
    : "invalid-request";
}

function resultItemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items.length;
  if (Array.isArray(record.groups)) return record.groups.length;
  return 0;
}

function statusDto(value: JsonRecord): ExplorerStatusDto {
  return {
    enabled: booleanValue(value.enabled),
    configured: booleanValue(value.configured),
    api_key_set: booleanValue(value.api_key_set),
    base_url: stringValue(value.base_url),
    workspace: stringValue(value.workspace),
    user_peer: stringValue(value.user_peer),
    ai_peer: stringValue(value.ai_peer),
    identity_source: value.identity_source === "workspace_metadata" ? "workspace_metadata" : "legacy_config",
    identity_revision: numberValue(value.identity_revision),
    identity_migration_required: booleanValue(value.identity_migration_required),
    recall_mode: stringValue(value.recall_mode),
    observation_mode: stringValue(value.observation_mode),
    session_strategy: stringValue(value.session_strategy),
    save_messages: booleanValue(value.save_messages),
    pending_messages: numberValue(value.pending_messages),
    active_writes: numberValue(value.active_writes),
    last_write_error: stringValue(value.last_write_error),
  };
}

function identityStatusDto(value: WorkspaceIdentityStatus): WorkspaceIdentityDto {
  return {
    workspace_id: value.workspaceId,
    user_peer: value.userPeerId,
    ai_peer: value.aiPeerId,
    source: value.source,
    revision: value.revision,
    migration_required: value.migrationRequired,
  };
}

function peerDto(
  value: HonchoPeer,
  activeWorkspace: string,
  userPeerId: string,
  aiPeerId: string
): PeerDto {
  const roles: Array<"user" | "ai"> = [];
  if (value.workspace_id === activeWorkspace || !value.workspace_id) {
    if (value.id === userPeerId) roles.push("user");
    if (value.id === aiPeerId) roles.push("ai");
  }
  return {
    id: value.id,
    workspace_id: value.workspace_id,
    metadata: value.metadata,
    configuration: value.configuration,
    created_at: value.created_at,
    display_name: peerDisplayName(value.metadata),
    archived: peerArchived(value.metadata),
    roles,
  };
}

function peerPageDto(
  value: HonchoPage<HonchoPeer>,
  activeWorkspace: string,
  userPeerId: string,
  aiPeerId: string
): ExplorerPage<PeerDto> {
  return {
    ...value,
    items: value.items.map((peer) => peerDto(peer, activeWorkspace, userPeerId, aiPeerId)),
  };
}

function queueStatusDto(value: HonchoQueueStatus): QueueStatusDto {
  return {
    total_work_units: numberValue(value.total_work_units),
    completed_work_units: numberValue(value.completed_work_units),
    in_progress_work_units: numberValue(value.in_progress_work_units),
    pending_work_units: numberValue(value.pending_work_units),
  };
}

function conclusionFilterValues(request: ExplorerRequest): ConclusionFiltersDto {
  return {
    observer_id: request.params?.observerPeerId,
    observed_id: request.params?.targetPeerId,
    session_id: request.params?.sessionId,
    level: request.params?.conclusionLevel,
    query: request.params?.query,
  };
}

function conclusionApiFilters(filters: ConclusionFiltersDto): JsonRecord {
  const result: JsonRecord = {};
  if (filters.observer_id) result.observer_id = filters.observer_id;
  if (filters.observed_id) result.observed_id = filters.observed_id;
  if (filters.session_id) result.session_id = filters.session_id;
  if (filters.level) result.level = filters.level;
  return result;
}

function conclusionDto(value: Conclusion, names: Map<string, string>): ConclusionDto {
  const observerId = stringValue(value.observer_id);
  const observedId = stringValue(value.observed_id);
  return {
    id: stringValue(value.id),
    content: stringValue(value.content),
    observer_id: observerId || undefined,
    observer_display_name: names.get(observerId) || undefined,
    observed_id: observedId || undefined,
    observed_display_name: names.get(observedId) || undefined,
    session_id: value.session_id,
    level: value.level,
    created_at: value.created_at,
  };
}

export class ExplorerService {
  private api: ExplorerApi | null = null;
  private signature = "";
  private readonly queueCache = new Map<string, { expiresAt: number; value: QueueStatusDto }>();
  private readonly queueInFlight = new Map<string, Promise<QueueStatusDto>>();
  private readonly identityConfirmations = new Map<string, PendingIdentityUpdate>();
  private identityConfirmationSequence = 0;
  private readonly peerConfirmations = new Map<string, PendingPeerMutation>();
  private peerConfirmationSequence = 0;
  private readonly conclusionConfirmations = new Map<string, PendingConclusionCleanup>();
  private conclusionConfirmationSequence = 0;
  private readonly sidecarConfirmations = new Map<string, PendingSidecarClear>();
  private sidecarConfirmationSequence = 0;
  private readonly readCache = new Map<string, ReadCacheEntry>();
  private readonly readInFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly controller: ExplorerController,
    private readonly apiFactory: ApiFactory = (config) => new HonchoApi(config),
    private readonly sidecarMaintenance?: SidecarMaintenance
  ) {}

  private currentApi(config: HonchoConfig): ExplorerApi {
    const signature = configSignature(config);
    if (!this.api || signature !== this.signature) {
      this.api = this.apiFactory(config);
      this.signature = signature;
      this.queueCache.clear();
      this.queueInFlight.clear();
      this.identityConfirmations.clear();
      this.peerConfirmations.clear();
      this.conclusionConfirmations.clear();
      this.readCache.clear();
      this.readInFlight.clear();
    }
    return this.api;
  }

  private queueStatus(
    api: ExplorerApi,
    config: HonchoConfig,
    workspaceId: string
  ): Promise<QueueStatusDto> {
    const key = `${configSignature(config)}\u0000${workspaceId}`;
    const now = Date.now();
    const cached = this.queueCache.get(key);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

    const active = this.queueInFlight.get(key);
    if (active) return active;

    const request = api.getQueueStatus(workspaceId)
      .then((value) => {
        const mapped = queueStatusDto(value);
        this.queueCache.set(key, { expiresAt: Date.now() + 15000, value: mapped });
        return mapped;
      })
      .finally(() => {
        this.queueInFlight.delete(key);
      });
    this.queueInFlight.set(key, request);
    return request;
  }

  private readCacheKey(
    config: HonchoConfig,
    request: ExplorerRequest,
    workspaceId: string
  ): string {
    const params = { ...(request.params || {}) };
    delete params.forceRefresh;
    return JSON.stringify([configSignature(config), workspaceId, request.op, params]);
  }

  private cachedRead<T>(
    config: HonchoConfig,
    request: ExplorerRequest,
    workspaceId: string,
    load: () => Promise<T>
  ): Promise<T> {
    const key = this.readCacheKey(config, request, workspaceId);
    const now = Date.now();
    const cached = this.readCache.get(key);
    if (!request.params?.forceRefresh && cached && cached.expiresAt > now) {
      return Promise.resolve(cached.value as T);
    }
    const active = this.readInFlight.get(key);
    if (active) return active as Promise<T>;

    const pending = load()
      .then((value) => {
        this.readCache.set(key, {
          workspaceId,
          operation: request.op,
          expiresAt: Date.now() + EXPLORER_READ_CACHE_TTL_MS,
          value,
        });
        return value;
      })
      .finally(() => this.readInFlight.delete(key));
    this.readInFlight.set(key, pending as Promise<unknown>);
    return pending;
  }

  private invalidateReadCache(workspaceId: string, operations?: string[]): void {
    for (const [key, entry] of this.readCache.entries()) {
      if (entry.workspaceId !== workspaceId && entry.operation !== "list_workspaces") continue;
      if (!operations || operations.includes(entry.operation)) this.readCache.delete(key);
    }
  }

  private workspaceFor(request: ExplorerRequest, localStatus: ExplorerStatusDto): string {
    return request.workspaceId || localStatus.workspace;
  }

  private activeWorkspaceForIdentity(
    request: ExplorerRequest,
    localStatus: ExplorerStatusDto
  ): string {
    const workspaceId = this.workspaceFor(request, localStatus);
    if (!workspaceId || workspaceId !== localStatus.workspace) {
      throw new ExplorerValidationError(
        "Workspace identity can only be changed for the active Hook Workspace.",
        "ACTIVE_WORKSPACE_REQUIRED"
      );
    }
    return workspaceId;
  }

  private async requirePeer(
    api: ExplorerApi,
    workspaceId: string,
    peerId: string
  ): Promise<HonchoPeer> {
    const page = await api.listPeers(workspaceId, 1, 2, false, { id: peerId });
    const peer = page.items.find((item) => item.id === peerId);
    if (!peer) {
      throw new ExplorerValidationError(
        "Peer " + peerId + " does not exist in Workspace " + workspaceId + ".",
        "PEER_NOT_FOUND"
      );
    }
    return peer;
  }

  private async findPeer(
    api: ExplorerApi,
    workspaceId: string,
    peerId: string
  ): Promise<HonchoPeer | null> {
    const page = await api.listPeers(workspaceId, 1, 2, false, { id: peerId });
    return page.items.find((peer) => peer.id === peerId) || null;
  }

  private cleanupIdentityConfirmations(now: number): void {
    for (const [token, pending] of this.identityConfirmations.entries()) {
      if (pending.expiresAt <= now) this.identityConfirmations.delete(token);
    }
  }

  private cleanupPeerConfirmations(now: number): void {
    for (const [token, pending] of this.peerConfirmations.entries()) {
      if (pending.expiresAt <= now) this.peerConfirmations.delete(token);
    }
  }

  private activeWorkspaceForPeerManagement(
    request: ExplorerRequest,
    localStatus: ExplorerStatusDto
  ): string {
    const workspaceId = this.workspaceFor(request, localStatus);
    if (!workspaceId || workspaceId !== localStatus.workspace) {
      throw new ExplorerValidationError(
        "Peer management is only available for the active Hook Workspace.",
        "ACTIVE_WORKSPACE_REQUIRED"
      );
    }
    return workspaceId;
  }

  private async requirePeerSession(
    api: ExplorerApi,
    workspaceId: string,
    peerId: string,
    sessionId: string
  ): Promise<void> {
    const page = await api.listPeerSessions(workspaceId, peerId, 1, 2, false, { id: sessionId });
    if (!page.items.some((session) => session.id === sessionId)) {
      throw new ExplorerValidationError(
        `Peer ${peerId} is not attached to Session ${sessionId}.`,
        "PEER_SESSION_NOT_FOUND"
      );
    }
  }

  private async assertArchiveAllowed(
    api: ExplorerApi,
    peerId: string,
    archived: boolean
  ): Promise<void> {
    if (!archived) return;
    const identity = await api.getWorkspaceIdentityReadOnly();
    if (peerId === identity.userPeerId || peerId === identity.aiPeerId) {
      throw new ExplorerValidationError(
        "An active User or AI Peer cannot be archived before its role is reassigned.",
        "ACTIVE_PEER_ARCHIVE_FORBIDDEN"
      );
    }
  }

  private async preparePeerMutation(
    request: ExplorerRequest,
    api: ExplorerApi,
    config: HonchoConfig,
    localStatus: ExplorerStatusDto
  ): Promise<PeerMutationPreviewDto> {
    const workspaceId = this.activeWorkspaceForPeerManagement(request, localStatus);
    const mutation = request.params?.peerMutation as PeerMutationKind;
    const peerId = request.params?.peerId || "";
    const displayName = request.params?.displayName;
    const archived = request.params?.archived;
    const sessionId = request.params?.sessionId;
    const existing = await this.findPeer(api, workspaceId, peerId);

    if (mutation === "create" && existing) {
      throw new ExplorerValidationError(`Peer ${peerId} already exists.`, "PEER_ALREADY_EXISTS");
    }
    if (mutation !== "create" && !existing) {
      throw new ExplorerValidationError(`Peer ${peerId} does not exist.`, "PEER_NOT_FOUND");
    }
    if (mutation === "set_archived") await this.assertArchiveAllowed(api, peerId, archived === true);
    if (mutation === "remove_from_session") {
      await this.requirePeerSession(api, workspaceId, peerId, sessionId || "");
    }

    const now = Date.now();
    this.cleanupPeerConfirmations(now);
    while (this.peerConfirmations.size >= 64) {
      const oldest = this.peerConfirmations.keys().next().value;
      if (typeof oldest !== "string") break;
      this.peerConfirmations.delete(oldest);
    }
    this.peerConfirmationSequence += 1;
    const token = [
      "peer",
      now.toString(36),
      this.peerConfirmationSequence.toString(36),
      Math.floor(Math.random() * 0x100000000).toString(36),
    ].join("-");
    const expiresAt = now + PEER_CONFIRMATION_TTL_MS;
    const previousDisplayName = existing ? peerDisplayName(existing.metadata) : undefined;
    const previousArchived = existing ? peerArchived(existing.metadata) : undefined;
    this.peerConfirmations.set(token, {
      configSignature: configSignature(config),
      workspaceId,
      mutation,
      peerId,
      displayName,
      archived,
      sessionId,
      previousDisplayName,
      previousArchived,
      expiresAt,
    });
    const impacts: Record<PeerMutationKind, string> = {
      create: "创建后 Peer ID 不可重命名，角色不会自动改变。",
      update_display_name: "只更新 Operit 显示名，不改变 Peer ID 或历史数据。",
      set_archived: archived ? "归档后从默认参与者视图隐藏，不删除远端数据。" : "恢复后重新显示该 Peer。",
      remove_from_session: "只移除 Session 成员关系，不删除 Peer、Message、Card 或 Conclusion。",
    };
    return {
      mutation,
      workspace_id: workspaceId,
      peer_id: peerId,
      previous_display_name: previousDisplayName,
      proposed_display_name: mutation === "create" || mutation === "update_display_name" ? (displayName || "") : undefined,
      previous_archived: previousArchived,
      proposed_archived: mutation === "create" ? false : mutation === "set_archived" ? archived : previousArchived,
      session_id: sessionId,
      impact: impacts[mutation],
      confirmation_token: token,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  private peerMutationMatches(request: ExplorerRequest, pending: PendingPeerMutation): boolean {
    return pending.mutation === request.params?.peerMutation
      && pending.peerId === request.params?.peerId
      && pending.displayName === request.params?.displayName
      && pending.archived === request.params?.archived
      && pending.sessionId === request.params?.sessionId;
  }

  private async commitPeerMutation(
    request: ExplorerRequest,
    api: ExplorerApi,
    config: HonchoConfig,
    localStatus: ExplorerStatusDto
  ): Promise<PeerMutationResultDto> {
    const workspaceId = this.activeWorkspaceForPeerManagement(request, localStatus);
    const token = request.params?.confirmationToken || "";
    const pending = this.peerConfirmations.get(token);
    this.peerConfirmations.delete(token);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new ExplorerValidationError(
        "The Peer confirmation expired or was already used. Prepare the change again.",
        "CONFIRMATION_REQUIRED"
      );
    }
    if (
      pending.configSignature !== configSignature(config)
      || pending.workspaceId !== workspaceId
      || !this.peerMutationMatches(request, pending)
    ) {
      throw new ExplorerValidationError(
        "The Peer confirmation does not match this update.",
        "CONFIRMATION_MISMATCH"
      );
    }

    const current = await this.findPeer(api, workspaceId, pending.peerId);
    if (pending.mutation === "create") {
      if (current) throw new ExplorerValidationError("Peer was created after confirmation.", "PEER_CONFLICT");
      const created = await api.createPeer(
        workspaceId,
        pending.peerId,
        metadataWithPeerProfile({}, { displayName: pending.displayName || "", archived: false })
      );
      return {
        mutation: pending.mutation,
        peer: peerDto(created, workspaceId, localStatus.user_peer, localStatus.ai_peer),
      };
    }
    if (!current) throw new ExplorerValidationError("Peer no longer exists.", "PEER_CONFLICT");
    if (
      peerDisplayName(current.metadata) !== pending.previousDisplayName
      || peerArchived(current.metadata) !== pending.previousArchived
    ) {
      throw new ExplorerValidationError("Peer metadata changed after confirmation.", "PEER_CONFLICT");
    }

    if (pending.mutation === "update_display_name") {
      const updated = await api.updatePeerMetadata(
        workspaceId,
        pending.peerId,
        metadataWithPeerProfile(current.metadata, { displayName: pending.displayName || "" })
      );
      return {
        mutation: pending.mutation,
        peer: peerDto(updated, workspaceId, localStatus.user_peer, localStatus.ai_peer),
      };
    }
    if (pending.mutation === "set_archived") {
      await this.assertArchiveAllowed(api, pending.peerId, pending.archived === true);
      const updated = await api.updatePeerMetadata(
        workspaceId,
        pending.peerId,
        metadataWithPeerProfile(current.metadata, { archived: pending.archived === true })
      );
      return {
        mutation: pending.mutation,
        peer: peerDto(updated, workspaceId, localStatus.user_peer, localStatus.ai_peer),
      };
    }

    await this.requirePeerSession(api, workspaceId, pending.peerId, pending.sessionId || "");
    await api.removePeerFromSession(workspaceId, pending.sessionId || "", pending.peerId);
    return {
      mutation: pending.mutation,
      session_id: pending.sessionId,
      removed: true,
    };
  }

  private async peerNamesFor(
    api: ExplorerApi,
    workspaceId: string,
    peerIds: string[]
  ): Promise<Map<string, string>> {
    const wanted = new Set(peerIds.filter(Boolean));
    const names = new Map<string, string>();
    if (!wanted.size) return names;
    const page = await api.listPeers(workspaceId, 1, 100, false);
    for (const peer of page.items) {
      if (!wanted.has(peer.id)) continue;
      const displayName = peerDisplayName(peer.metadata);
      if (displayName) names.set(peer.id, displayName);
    }
    return names;
  }

  private async conclusionPage(
    request: ExplorerRequest,
    api: ExplorerApi,
    workspaceId: string
  ): Promise<ExplorerPage<ConclusionDto>> {
    const options = pageOptions(request, { size: 20, reverse: true });
    const filters = conclusionFilterValues(request);
    const apiFilters = conclusionApiFilters(filters);
    let page: HonchoPage<Conclusion>;
    if (filters.query) {
      const items = await api.queryConclusionsGeneric(
        workspaceId,
        filters.query,
        options.size,
        apiFilters
      );
      page = {
        items,
        total: items.length,
        page: 1,
        size: options.size,
        pages: items.length ? 1 : 0,
      };
    } else {
      page = await api.listConclusionsGeneric(
        workspaceId,
        options.page,
        options.size,
        options.reverse,
        apiFilters
      );
    }
    const names = await this.peerNamesFor(
      api,
      workspaceId,
      page.items.flatMap((item) => [stringValue(item.observer_id), stringValue(item.observed_id)])
    );
    return { ...page, items: page.items.map((item) => conclusionDto(item, names)) };
  }

  private async scanConclusionReport(
    api: ExplorerApi,
    workspaceId: string,
    filters: JsonRecord = {}
  ): Promise<ConclusionDuplicateReportDto> {
    const conclusions: Conclusion[] = [];
    let pageNumber = 1;
    let pages = 1;
    let total = 0;
    while (pageNumber <= pages && conclusions.length < MAX_CONCLUSION_SCAN_ITEMS) {
      const page = await api.listConclusionsGeneric(workspaceId, pageNumber, 100, false, filters);
      total = page.total;
      pages = Math.max(page.pages, 1);
      conclusions.push(...page.items.slice(0, MAX_CONCLUSION_SCAN_ITEMS - conclusions.length));
      if (!page.items.length) break;
      pageNumber += 1;
    }
    const groups = buildConclusionDuplicateGroups(conclusions);
    const names = await this.peerNamesFor(
      api,
      workspaceId,
      groups.flatMap((group) => [group.observer_id, group.observed_id])
    );
    const enriched: ConclusionDuplicateGroupDto[] = groups.map((group) => ({
      ...group,
      observer_display_name: names.get(group.observer_id) || undefined,
      observed_display_name: names.get(group.observed_id) || undefined,
    }));
    return {
      workspace_id: workspaceId,
      scanned_count: conclusions.length,
      duplicate_count: enriched.reduce((sum, group) => sum + group.items.length - 1, 0),
      groups: enriched,
      truncated: total > conclusions.length || pageNumber <= pages,
    };
  }

  private cleanupConclusionConfirmations(now: number): void {
    for (const [token, pending] of this.conclusionConfirmations.entries()) {
      if (pending.expiresAt <= now) this.conclusionConfirmations.delete(token);
    }
  }

  private async prepareConclusionCleanup(
    request: ExplorerRequest,
    api: ExplorerApi,
    config: HonchoConfig,
    localStatus: ExplorerStatusDto
  ): Promise<ConclusionCleanupPreviewDto> {
    const workspaceId = this.activeWorkspaceForPeerManagement(request, localStatus);
    const keepConclusionId = request.params?.keepConclusionId || "";
    const deleteConclusionIds = [...(request.params?.deleteConclusionIds || [])].sort();
    const filters = conclusionApiFilters(conclusionFilterValues(request));
    const report = await this.scanConclusionReport(api, workspaceId, filters);
    const selectedIds = [keepConclusionId, ...deleteConclusionIds];
    const group = report.groups.find((candidate) => {
      const ids = new Set(candidate.items.map((item) => item.id));
      return selectedIds.length === ids.size && selectedIds.every((id) => ids.has(id));
    });
    if (!group) {
      throw new ExplorerValidationError(
        "The selected Conclusions are no longer members of the same exact duplicate group.",
        "CONCLUSION_CONFLICT"
      );
    }

    const now = Date.now();
    this.cleanupConclusionConfirmations(now);
    while (this.conclusionConfirmations.size >= 64) {
      const oldest = this.conclusionConfirmations.keys().next().value;
      if (typeof oldest !== "string") break;
      this.conclusionConfirmations.delete(oldest);
    }
    this.conclusionConfirmationSequence += 1;
    const token = [
      "conclusion",
      now.toString(36),
      this.conclusionConfirmationSequence.toString(36),
      Math.floor(Math.random() * 0x100000000).toString(36),
    ].join("-");
    const confirmationPhrase = "DELETE " + deleteConclusionIds.length;
    const expiresAt = now + CONCLUSION_CONFIRMATION_TTL_MS;
    this.conclusionConfirmations.set(token, {
      configSignature: configSignature(config),
      workspaceId,
      groupKey: group.group_key,
      filters,
      keepConclusionId,
      deleteConclusionIds,
      confirmationPhrase,
      expiresAt,
    });
    return {
      workspace_id: workspaceId,
      group_key: group.group_key,
      observer_id: group.observer_id,
      observed_id: group.observed_id,
      session_id: group.session_id,
      keep_conclusion_id: keepConclusionId,
      delete_conclusion_ids: deleteConclusionIds,
      confirmation_phrase: confirmationPhrase,
      confirmation_token: token,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  private async commitConclusionCleanup(
    request: ExplorerRequest,
    api: ExplorerApi,
    config: HonchoConfig,
    localStatus: ExplorerStatusDto
  ): Promise<ConclusionCleanupResultDto> {
    const workspaceId = this.activeWorkspaceForPeerManagement(request, localStatus);
    const token = request.params?.confirmationToken || "";
    const pending = this.conclusionConfirmations.get(token);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.conclusionConfirmations.delete(token);
      throw new ExplorerValidationError(
        "The Conclusion cleanup confirmation expired or was already used.",
        "CONFIRMATION_REQUIRED"
      );
    }
    const deleteConclusionIds = [...(request.params?.deleteConclusionIds || [])].sort();
    if (
      pending.configSignature !== configSignature(config)
      || pending.workspaceId !== workspaceId
      || pending.keepConclusionId !== request.params?.keepConclusionId
      || JSON.stringify(pending.deleteConclusionIds) !== JSON.stringify(deleteConclusionIds)
    ) {
      throw new ExplorerValidationError(
        "The Conclusion cleanup confirmation does not match this request.",
        "CONFIRMATION_MISMATCH"
      );
    }
    if (request.params?.confirmationText !== pending.confirmationPhrase) {
      throw new ExplorerValidationError(
        "The typed confirmation text does not match the cleanup preview.",
        "CONFIRMATION_TEXT_MISMATCH"
      );
    }
    this.conclusionConfirmations.delete(token);

    const report = await this.scanConclusionReport(api, workspaceId, pending.filters);
    const group = report.groups.find((candidate) => candidate.group_key === pending.groupKey);
    const currentIds = new Set(group?.items.map((item) => item.id) || []);
    if (!group || ![pending.keepConclusionId, ...pending.deleteConclusionIds].every((id) => currentIds.has(id))) {
      throw new ExplorerValidationError(
        "The duplicate group changed after confirmation. Scan and prepare cleanup again.",
        "CONCLUSION_CONFLICT"
      );
    }

    const deletedIds: string[] = [];
    const failures: ConclusionCleanupResultDto["failures"] = [];
    for (const id of pending.deleteConclusionIds) {
      try {
        await api.deleteConclusionFor(workspaceId, id);
        deletedIds.push(id);
      } catch (error) {
        const mapped = errorFrom(error);
        failures.push({ id, error: (mapped.code + ": " + mapped.message).slice(0, 500) });
      }
    }
    if (deletedIds.length) this.invalidateReadCache(workspaceId, ["list_conclusions"]);
    return {
      workspace_id: workspaceId,
      keep_conclusion_id: pending.keepConclusionId,
      deleted_ids: deletedIds,
      failures,
    };
  }

  private requireSidecarMaintenance(): SidecarMaintenance {
    if (!this.sidecarMaintenance) {
      throw new ExplorerValidationError("Prompt sidecar maintenance is unavailable.", "SIDECAR_UNAVAILABLE");
    }
    return this.sidecarMaintenance;
  }

  private async prepareSidecarClear(): Promise<PromptSidecarClearPreviewDto> {
    const maintenance = this.requireSidecarMaintenance();
    const status = await maintenance.status();
    const now = Date.now();
    for (const [token, pending] of this.sidecarConfirmations.entries()) {
      if (pending.expiresAt <= now) this.sidecarConfirmations.delete(token);
    }
    while (this.sidecarConfirmations.size >= 64) {
      const oldest = this.sidecarConfirmations.keys().next().value;
      if (typeof oldest !== "string") break;
      this.sidecarConfirmations.delete(oldest);
    }
    this.sidecarConfirmationSequence += 1;
    const token = [
      "sidecar",
      now.toString(36),
      this.sidecarConfirmationSequence.toString(36),
      Math.floor(Math.random() * 0x100000000).toString(36),
    ].join("-");
    const confirmationPhrase = "CLEAR SIDECARS";
    const expiresAt = now + SIDECAR_CONFIRMATION_TTL_MS;
    this.sidecarConfirmations.set(token, {
      fileCount: status.file_count,
      totalBytes: status.total_bytes,
      confirmationPhrase,
      expiresAt,
    });
    return {
      ...status,
      confirmation_phrase: confirmationPhrase,
      confirmation_token: token,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  private async commitSidecarClear(request: ExplorerRequest): Promise<PromptSidecarClearResultDto> {
    const token = request.params?.confirmationToken || "";
    const pending = this.sidecarConfirmations.get(token);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.sidecarConfirmations.delete(token);
      throw new ExplorerValidationError(
        "The prompt sidecar confirmation expired or was already used.",
        "CONFIRMATION_REQUIRED"
      );
    }
    if (request.params?.confirmationText !== pending.confirmationPhrase) {
      throw new ExplorerValidationError(
        "The typed confirmation text does not match the sidecar preview.",
        "CONFIRMATION_TEXT_MISMATCH"
      );
    }
    this.sidecarConfirmations.delete(token);
    const maintenance = this.requireSidecarMaintenance();
    const current = await maintenance.status();
    if (current.file_count !== pending.fileCount || current.total_bytes !== pending.totalBytes) {
      throw new ExplorerValidationError(
        "Prompt sidecar storage changed after confirmation. Prepare the clear operation again.",
        "SIDECAR_CONFLICT"
      );
    }
    return maintenance.clear();
  }

  private async prepareIdentityUpdate(
    request: ExplorerRequest,
    api: ExplorerApi,
    config: HonchoConfig,
    localStatus: ExplorerStatusDto
  ): Promise<WorkspaceIdentityUpdatePreviewDto> {
    const workspaceId = this.activeWorkspaceForIdentity(request, localStatus);
    const userPeerId = request.params?.userPeerId || "";
    const aiPeerId = request.params?.aiPeerId || "";
    const current = await api.getWorkspaceIdentityReadOnly();
    if (current.workspaceId !== workspaceId) {
      throw new ExplorerValidationError(
        "Workspace identity response did not match the active Workspace.",
        "IDENTITY_CONFLICT"
      );
    }
    await Promise.all([
      this.requirePeer(api, workspaceId, userPeerId),
      this.requirePeer(api, workspaceId, aiPeerId),
    ]);

    const now = Date.now();
    this.cleanupIdentityConfirmations(now);
    while (this.identityConfirmations.size >= 64) {
      const oldest = this.identityConfirmations.keys().next().value;
      if (typeof oldest !== "string") break;
      this.identityConfirmations.delete(oldest);
    }
    this.identityConfirmationSequence += 1;
    const token = [
      "identity",
      now.toString(36),
      this.identityConfirmationSequence.toString(36),
      Math.floor(Math.random() * 0x100000000).toString(36),
    ].join("-");
    const expiresAt = now + IDENTITY_CONFIRMATION_TTL_MS;
    this.identityConfirmations.set(token, {
      configSignature: configSignature(config),
      workspaceId,
      userPeerId,
      aiPeerId,
      previousUserPeerId: current.userPeerId,
      previousAiPeerId: current.aiPeerId,
      previousRevision: current.revision,
      expiresAt,
    });
    return {
      workspace_id: workspaceId,
      previous_user_peer: current.userPeerId,
      previous_ai_peer: current.aiPeerId,
      previous_revision: current.revision,
      proposed_user_peer: userPeerId,
      proposed_ai_peer: aiPeerId,
      proposed_revision: current.revision + 1,
      confirmation_token: token,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  private async commitIdentityUpdate(
    request: ExplorerRequest,
    api: ExplorerApi,
    config: HonchoConfig,
    localStatus: ExplorerStatusDto
  ): Promise<WorkspaceIdentityDto> {
    const workspaceId = this.activeWorkspaceForIdentity(request, localStatus);
    const userPeerId = request.params?.userPeerId || "";
    const aiPeerId = request.params?.aiPeerId || "";
    const token = request.params?.confirmationToken || "";
    const pending = this.identityConfirmations.get(token);
    this.identityConfirmations.delete(token);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new ExplorerValidationError(
        "The identity confirmation expired or was already used. Prepare the change again.",
        "CONFIRMATION_REQUIRED"
      );
    }
    if (
      pending.configSignature !== configSignature(config)
      || pending.workspaceId !== workspaceId
      || pending.userPeerId !== userPeerId
      || pending.aiPeerId !== aiPeerId
    ) {
      throw new ExplorerValidationError(
        "The identity confirmation does not match this update.",
        "CONFIRMATION_MISMATCH"
      );
    }

    const current = await api.getWorkspaceIdentityReadOnly();
    if (
      current.revision !== pending.previousRevision
      || current.userPeerId !== pending.previousUserPeerId
      || current.aiPeerId !== pending.previousAiPeerId
    ) {
      throw new ExplorerValidationError(
        "Workspace identity changed after confirmation. Refresh and prepare the change again.",
        "IDENTITY_CONFLICT"
      );
    }
    return identityStatusDto(await api.setWorkspaceIdentity(userPeerId, aiPeerId));
  }

  private requireConfigured(config: HonchoConfig): void {
    if (!isConfigured(config)) {
      throw new ExplorerValidationError(
        "Honcho is not configured. Set HONCHO_API_KEY, or HONCHO_BASE_URL for self-hosting."
      );
    }
  }

  private async execute(request: ExplorerRequest): Promise<unknown> {
    const config = this.controller.getConfig();
    const localStatus = statusDto(this.controller.status());
    const api = this.currentApi(config);

    if (request.op === "status") return localStatus;
    if (request.op === "sidecar_status") {
      return this.requireSidecarMaintenance().status();
    }
    if (request.op === "prepare_sidecar_clear") return this.prepareSidecarClear();
    if (request.op === "commit_sidecar_clear") return this.commitSidecarClear(request);

    this.requireConfigured(config);
    if (request.op === "identity_status") {
      return identityStatusDto(await api.getWorkspaceIdentityReadOnly());
    }
    if (request.op === "prepare_identity_update") {
      return this.prepareIdentityUpdate(request, api, config, localStatus);
    }
    if (request.op === "commit_identity_update") {
      const result = await this.commitIdentityUpdate(request, api, config, localStatus);
      this.invalidateReadCache(result.workspace_id);
      return result;
    }
    if (request.op === "prepare_peer_mutation") {
      return this.preparePeerMutation(request, api, config, localStatus);
    }
    if (request.op === "commit_peer_mutation") {
      const result = await this.commitPeerMutation(request, api, config, localStatus);
      this.invalidateReadCache(this.workspaceFor(request, localStatus));
      return result;
    }
    if (request.op === "prepare_conclusion_cleanup") {
      return this.prepareConclusionCleanup(request, api, config, localStatus);
    }
    if (request.op === "commit_conclusion_cleanup") {
      return this.commitConclusionCleanup(request, api, config, localStatus);
    }
    const workspaceId = this.workspaceFor(request, localStatus);
    if (!workspaceId) throw new ExplorerValidationError("workspaceId is required.");

    if (request.op === "queue_status") {
      return this.queueStatus(api, config, workspaceId);
    }

    if (request.op === "list_workspaces") {
      const options = pageOptions(request, { size: 20, reverse: false });
      return this.cachedRead(config, request, "*", () =>
        api.listWorkspaces(options.page, options.size, options.reverse) as Promise<ExplorerPage<WorkspaceDto>>
      );
    }
    if (request.op === "list_peers") {
      const options = pageOptions(request, { size: 20, reverse: true });
      const active = workspaceId === localStatus.workspace;
      return this.cachedRead(config, request, workspaceId, async () => peerPageDto(
        await api.listPeers(workspaceId, options.page, options.size, options.reverse),
        localStatus.workspace,
        active ? localStatus.user_peer : "",
        active ? localStatus.ai_peer : ""
      ));
    }
    if (request.op === "get_peer") {
      const active = workspaceId === localStatus.workspace;
      return this.cachedRead(config, request, workspaceId, async () => peerDto(
        await api.getPeerReadOnly(workspaceId, request.params?.peerId || ""),
        localStatus.workspace,
        active ? localStatus.user_peer : "",
        active ? localStatus.ai_peer : ""
      ));
    }
    if (request.op === "list_peer_sessions") {
      const options = pageOptions(request, { size: 20, reverse: true });
      return this.cachedRead(config, request, workspaceId, () => api.listPeerSessions(
        workspaceId,
        request.params?.peerId || "",
        options.page,
        options.size,
        options.reverse
      ) as Promise<ExplorerPage<SessionDto>>);
    }
    if (request.op === "get_peer_card") {
      const observerPeerId = request.params?.observerPeerId || "";
      const targetPeerId = request.params?.targetPeerId || "";
      return this.cachedRead(config, request, workspaceId, async () => {
        await Promise.all([
          this.requirePeer(api, workspaceId, observerPeerId),
          this.requirePeer(api, workspaceId, targetPeerId),
        ]);
        const result: PeerCardDto = {
          workspace_id: workspaceId,
          observer_id: observerPeerId,
          target_id: targetPeerId,
          peer_card: await api.getPeerCardReadOnly(workspaceId, observerPeerId, targetPeerId),
        };
        return result;
      });
    }
    if (request.op === "list_sessions") {
      const options = pageOptions(request, { size: 20, reverse: true });
      return this.cachedRead(config, request, workspaceId, () =>
        api.listSessions(workspaceId, options.page, options.size, options.reverse) as Promise<ExplorerPage<SessionDto>>
      );
    }
    if (request.op === "list_messages") {
      const options = pageOptions(request, { size: 30, reverse: false });
      return this.cachedRead(config, request, workspaceId, () => api.listMessages(
        workspaceId,
        request.params?.sessionId || "",
        options.page,
        options.size,
        options.reverse
      ) as Promise<ExplorerPage<MessageDto>>);
    }
    if (request.op === "list_conclusions") {
      return this.cachedRead(config, request, workspaceId, () =>
        this.conclusionPage(request, api, workspaceId)
      );
    }
    if (request.op === "scan_conclusion_duplicates") {
      return this.scanConclusionReport(
        api,
        workspaceId,
        conclusionApiFilters(conclusionFilterValues(request))
      );
    }
    throw new ExplorerValidationError("Unknown Explorer operation.");
  }

  async handle(value: unknown): Promise<ExplorerResponse> {
    const fallbackRequestId = requestIdFrom(value);
    const startedAt = Date.now();
    let operation = "invalid_request";
    try {
      const request = parseExplorerRequest(value);
      operation = request.op;
      const data = await this.execute(request);
      console.log(
        "[honcho] explorer op=" + request.op
        + " duration_ms=" + (Date.now() - startedAt)
        + " items=" + resultItemCount(data)
      );
      return { ok: true, requestId: request.requestId, data };
    } catch (error) {
      console.log(
        "[honcho] explorer op=" + operation
        + " duration_ms=" + (Date.now() - startedAt)
        + " status=failed"
      );
      return { ok: false, requestId: fallbackRequestId, error: errorFrom(error) };
    }
  }
}