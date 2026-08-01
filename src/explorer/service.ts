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
} from "../api";
import { configSignature, HonchoConfig, isConfigured } from "../config";
import {
  ConclusionDto,
  ExplorerError,
  ExplorerPage,
  ExplorerRequest,
  ExplorerResponse,
  ExplorerStatusDto,
  MessageDto,
  PeerDto,
  SessionDto,
  WorkspaceDto,
} from "./types";
import { ExplorerValidationError, pageOptions, parseExplorerRequest } from "./validation";

interface ExplorerController {
  getConfig(): HonchoConfig;
  status(): JsonRecord;
}

interface ExplorerApi {
  listWorkspaces(page: number, size: number, reverse: boolean): Promise<HonchoPage<HonchoWorkspace>>;
  listPeers(workspaceId: string, page: number, size: number, reverse: boolean): Promise<HonchoPage<HonchoPeer>>;
  listSessions(workspaceId: string, page: number, size: number, reverse: boolean): Promise<HonchoPage<HonchoSession>>;
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
    reverse: boolean
  ): Promise<HonchoPage<Conclusion>>;
  getQueueStatus(workspaceId: string): Promise<HonchoQueueStatus>;
}

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

function statusDto(value: JsonRecord): ExplorerStatusDto {
  return {
    enabled: booleanValue(value.enabled),
    configured: booleanValue(value.configured),
    api_key_set: booleanValue(value.api_key_set),
    base_url: stringValue(value.base_url),
    workspace: stringValue(value.workspace),
    user_peer: stringValue(value.user_peer),
    ai_peer: stringValue(value.ai_peer),
    recall_mode: stringValue(value.recall_mode),
    observation_mode: stringValue(value.observation_mode),
    session_strategy: stringValue(value.session_strategy),
    save_messages: booleanValue(value.save_messages),
    pending_messages: numberValue(value.pending_messages),
    active_writes: numberValue(value.active_writes),
    last_write_error: stringValue(value.last_write_error),
  };
}

export class ExplorerService {
  private api: ExplorerApi | null = null;
  private signature = "";

  constructor(
    private readonly controller: ExplorerController,
    private readonly apiFactory: ApiFactory = (config) => new HonchoApi(config)
  ) {}

  private currentApi(config: HonchoConfig): ExplorerApi {
    const signature = configSignature(config);
    if (!this.api || signature !== this.signature) {
      this.api = this.apiFactory(config);
      this.signature = signature;
    }
    return this.api;
  }

  private workspaceFor(request: ExplorerRequest, localStatus: ExplorerStatusDto): string {
    return request.workspaceId || localStatus.workspace;
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

    if (request.op === "status") {
      if (localStatus.configured) {
        try {
          const queue = await api.getQueueStatus(localStatus.workspace);
          localStatus.server_queue = {
            total_work_units: numberValue(queue.total_work_units),
            completed_work_units: numberValue(queue.completed_work_units),
            in_progress_work_units: numberValue(queue.in_progress_work_units),
            pending_work_units: numberValue(queue.pending_work_units),
          };
        } catch (error) {
          localStatus.server_queue_error = errorFrom(error);
        }
      }
      return localStatus;
    }

    this.requireConfigured(config);
    const workspaceId = this.workspaceFor(request, localStatus);
    if (!workspaceId) throw new ExplorerValidationError("workspaceId is required.");

    if (request.op === "list_workspaces") {
      const options = pageOptions(request, { size: 20, reverse: false });
      return api.listWorkspaces(options.page, options.size, options.reverse) as Promise<
        ExplorerPage<WorkspaceDto>
      >;
    }
    if (request.op === "list_peers") {
      const options = pageOptions(request, { size: 20, reverse: true });
      return api.listPeers(workspaceId, options.page, options.size, options.reverse) as Promise<
        ExplorerPage<PeerDto>
      >;
    }
    if (request.op === "list_sessions") {
      const options = pageOptions(request, { size: 20, reverse: true });
      return api.listSessions(workspaceId, options.page, options.size, options.reverse) as Promise<
        ExplorerPage<SessionDto>
      >;
    }
    if (request.op === "list_messages") {
      const options = pageOptions(request, { size: 30, reverse: false });
      return api.listMessages(
        workspaceId,
        request.params?.sessionId || "",
        options.page,
        options.size,
        options.reverse
      ) as Promise<ExplorerPage<MessageDto>>;
    }
    if (request.op === "list_conclusions") {
      const options = pageOptions(request, { size: 20, reverse: false });
      return api.listConclusionsGeneric(
        workspaceId,
        options.page,
        options.size,
        options.reverse
      ) as Promise<ExplorerPage<ConclusionDto>>;
    }
    throw new ExplorerValidationError("Unknown Explorer operation.");
  }

  async handle(value: unknown): Promise<ExplorerResponse> {
    const fallbackRequestId = requestIdFrom(value);
    try {
      const request = parseExplorerRequest(value);
      const data = await this.execute(request);
      return { ok: true, requestId: request.requestId, data };
    } catch (error) {
      return { ok: false, requestId: fallbackRequestId, error: errorFrom(error) };
    }
  }
}