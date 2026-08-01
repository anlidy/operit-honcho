import type { ComposeColor, ComposeDslContext, ComposeNode } from "../../../../types/compose-dsl";
import type {
  ConclusionDto,
  ConclusionCleanupPreviewDto,
  ConclusionCleanupResultDto,
  ConclusionDuplicateGroupDto,
  ConclusionDuplicateReportDto,
  ConclusionFiltersDto,
  ExplorerError,
  ExplorerOperation,
  ExplorerPage,
  ExplorerResponse,
  ExplorerStatusDto,
  MessageDto,
  PeerCardDto,
  PeerDto,
  PeerMutationKind,
  PeerMutationPreviewDto,
  PeerMutationResultDto,
  QueueStatusDto,
  PromptSidecarClearPreviewDto,
  PromptSidecarClearResultDto,
  PromptSidecarStatusDto,
  SessionDto,
  WorkspaceDto,
  WorkspaceIdentityDto,
  WorkspaceIdentityUpdatePreviewDto,
} from "../../explorer/types";
import { clipText, compactJson, displayTime, pageLabel } from "./format";
import { renderIdentityManager } from "./identity.ui.js";
import { renderPeerWorkspace } from "./peers.ui.js";
import { renderConclusionWorkspace } from "./conclusions.ui.js";

type ExplorerTab = "overview" | "peers" | "sessions" | "conclusions";

const TABS: Array<{ id: ExplorerTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "peers", label: "参与者" },
  { id: "sessions", label: "会话" },
  { id: "conclusions", label: "结论" },
];

function emptyPage<T>(size = 20): ExplorerPage<T> {
  return { items: [], total: 0, page: 1, size, pages: 0 };
}

function uiError(error: unknown): ExplorerError {
  const rawMessage = error instanceof Error
    ? error.message
    : error && typeof error === "object" && !Array.isArray(error) && (error as Partial<ExplorerError>).message
      ? String((error as Partial<ExplorerError>).message)
      : String(error || "未知错误");
  if (rawMessage.includes("ToolPkg.ipc channel is not registered")) {
    return {
      code: "IPC_UNAVAILABLE",
      message: "Honcho Explorer 服务尚未就绪，请稍后重试。",
      retryable: true,
    };
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const candidate = error as Partial<ExplorerError>;
    if (candidate.message) {
      return {
        code: String(candidate.code || "EXPLORER_ERROR"),
        message: String(candidate.message),
        status: candidate.status,
        retryable: candidate.retryable,
      };
    }
  }
  return {
    code: "EXPLORER_ERROR",
    message: rawMessage,
    retryable: true,
  };
}

function errorTitle(code: string): string {
  const titles: Record<string, string> = {
    AUTHENTICATION_REQUIRED: "需要认证",
    PERMISSION_DENIED: "权限不足",
    NOT_FOUND: "数据不存在",
    RATE_LIMITED: "请求过于频繁",
    HONCHO_HTTP_ERROR: "Honcho 服务错误",
    NETWORK_ERROR: "网络连接失败",
    INVALID_REQUEST: "请求参数无效",
    IPC_UNAVAILABLE: "服务尚未就绪",
    ACTIVE_WORKSPACE_REQUIRED: "只能修改活跃工作区",
    PEER_NOT_FOUND: "参与者不存在",
    CONFIRMATION_REQUIRED: "需要重新确认",
    CONFIRMATION_MISMATCH: "确认内容不匹配",
    IDENTITY_CONFLICT: "身份绑定已变化",
    PEER_ALREADY_EXISTS: "参与者已存在",
    PEER_SESSION_NOT_FOUND: "会话成员关系不存在",
    ACTIVE_PEER_ARCHIVE_FORBIDDEN: "活跃角色不能归档",
    PEER_CONFLICT: "参与者资料已变化",
    CONCLUSION_CONFLICT: "结论重复组已变化",
    CONFIRMATION_TEXT_REQUIRED: "需要输入确认文字",
    CONFIRMATION_TEXT_MISMATCH: "确认文字不匹配",
    SIDECAR_UNAVAILABLE: "Sidecar 管理不可用",
    SIDECAR_CONFLICT: "Sidecar 数据已变化",
    STALE_RESPONSE: "响应已过期",
    EXPLORER_ERROR: "加载失败",
  };
  return titles[code] || "加载失败";
}

function recallModeLabel(value: string): string {
  return { hybrid: "混合召回", context: "上下文召回", tools: "工具召回" }[value] || value;
}

function sessionStrategyLabel(value: string): string {
  return { "per-chat": "独立会话", global: "全局会话" }[value] || value;
}

function normalizedConclusionFilters(value: ConclusionFiltersDto): ConclusionFiltersDto {
  const text = (input: string | undefined): string | undefined => {
    const trimmed = String(input || "").trim();
    return trimmed || undefined;
  };
  return {
    observer_id: text(value.observer_id),
    observed_id: text(value.observed_id),
    session_id: text(value.session_id),
    level: value.level,
    query: text(value.query),
  };
}

function displayBytes(value: number): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return Math.trunc(bytes) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export default function honchoExploreScreen(ctx: ComposeDslContext): ComposeNode {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;
  const [tab, setTab] = ctx.useState<ExplorerTab>("tab", "overview");
  const [status, setStatus] = ctx.useState<ExplorerStatusDto | null>("status", null);
  const [identity, setIdentity] = ctx.useState<WorkspaceIdentityDto | null>("identity", null);
  const [identityUserPeer, setIdentityUserPeer] = ctx.useState("identityUserPeer", "");
  const [identityAiPeer, setIdentityAiPeer] = ctx.useState("identityAiPeer", "");
  const [identityPreview, setIdentityPreview] = ctx.useState<WorkspaceIdentityUpdatePreviewDto | null>(
    "identityPreview",
    null
  );
  const [identityBusy, setIdentityBusy] = ctx.useState("identityBusy", false);
  const [identityNotice, setIdentityNotice] = ctx.useState("identityNotice", "");
  const [identityError, setIdentityError] = ctx.useState("identityError", "");
  const [browsingWorkspace, setBrowsingWorkspace] = ctx.useState("browsingWorkspace", "");
  const [workspaces, setWorkspaces] = ctx.useState<ExplorerPage<WorkspaceDto>>(
    "workspaces",
    emptyPage<WorkspaceDto>()
  );
  const [peers, setPeers] = ctx.useState<ExplorerPage<PeerDto>>("peers", emptyPage<PeerDto>());
  const [selectedPeer, setSelectedPeer] = ctx.useState<PeerDto | null>("selectedPeer", null);
  const [peerSessions, setPeerSessions] = ctx.useState<ExplorerPage<SessionDto>>(
    "peerSessions",
    emptyPage<SessionDto>()
  );
  const [peerCard, setPeerCard] = ctx.useState<PeerCardDto | null>("peerCard", null);
  const [peerCardObserver, setPeerCardObserver] = ctx.useState("peerCardObserver", "");
  const [peerObserverMenuOpen, setPeerObserverMenuOpen] = ctx.useState("peerObserverMenuOpen", false);
  const [showArchivedPeers, setShowArchivedPeers] = ctx.useState("showArchivedPeers", false);
  const [peerCreateOpen, setPeerCreateOpen] = ctx.useState("peerCreateOpen", false);
  const [peerCreateId, setPeerCreateId] = ctx.useState("peerCreateId", "");
  const [peerCreateDisplayName, setPeerCreateDisplayName] = ctx.useState("peerCreateDisplayName", "");
  const [peerEditDisplayName, setPeerEditDisplayName] = ctx.useState("peerEditDisplayName", "");
  const [peerMutationPreview, setPeerMutationPreview] = ctx.useState<PeerMutationPreviewDto | null>(
    "peerMutationPreview",
    null
  );
  const [peerBusy, setPeerBusy] = ctx.useState("peerBusy", false);
  const [peerNotice, setPeerNotice] = ctx.useState("peerNotice", "");
  const [peerError, setPeerError] = ctx.useState("peerError", "");
  const [peerCardError, setPeerCardError] = ctx.useState("peerCardError", "");
  const [sessions, setSessions] = ctx.useState<ExplorerPage<SessionDto>>(
    "sessions",
    emptyPage<SessionDto>()
  );
  const [selectedSessionId, setSelectedSessionId] = ctx.useState("selectedSessionId", "");
  const [messages, setMessages] = ctx.useState<ExplorerPage<MessageDto>>(
    "messages",
    emptyPage<MessageDto>(30)
  );
  const [conclusions, setConclusions] = ctx.useState<ExplorerPage<ConclusionDto>>(
    "conclusions",
    emptyPage<ConclusionDto>()
  );
  const [conclusionPeers, setConclusionPeers] = ctx.useState<ExplorerPage<PeerDto>>(
    "conclusionPeers",
    emptyPage<PeerDto>(100)
  );
  const [conclusionDraftFilters, setConclusionDraftFilters] = ctx.useState<ConclusionFiltersDto>(
    "conclusionDraftFilters",
    {}
  );
  const [conclusionFilters, setConclusionFilters] = ctx.useState<ConclusionFiltersDto>(
    "conclusionFilters",
    {}
  );
  const [conclusionObserverMenuOpen, setConclusionObserverMenuOpen] = ctx.useState(
    "conclusionObserverMenuOpen",
    false
  );
  const [conclusionObservedMenuOpen, setConclusionObservedMenuOpen] = ctx.useState(
    "conclusionObservedMenuOpen",
    false
  );
  const [conclusionLevelMenuOpen, setConclusionLevelMenuOpen] = ctx.useState(
    "conclusionLevelMenuOpen",
    false
  );
  const [conclusionDuplicateReport, setConclusionDuplicateReport] =
    ctx.useState<ConclusionDuplicateReportDto | null>("conclusionDuplicateReport", null);
  const [selectedDuplicateGroupKey, setSelectedDuplicateGroupKey] = ctx.useState(
    "selectedDuplicateGroupKey",
    ""
  );
  const [keepConclusionId, setKeepConclusionId] = ctx.useState("keepConclusionId", "");
  const [conclusionCleanupPreview, setConclusionCleanupPreview] =
    ctx.useState<ConclusionCleanupPreviewDto | null>("conclusionCleanupPreview", null);
  const [conclusionConfirmationText, setConclusionConfirmationText] = ctx.useState(
    "conclusionConfirmationText",
    ""
  );
  const [conclusionBusy, setConclusionBusy] = ctx.useState("conclusionBusy", false);
  const [conclusionNotice, setConclusionNotice] = ctx.useState("conclusionNotice", "");
  const [conclusionError, setConclusionError] = ctx.useState("conclusionError", "");
  const [sidecarStatus, setSidecarStatus] = ctx.useState<PromptSidecarStatusDto | null>(
    "sidecarStatus",
    null
  );
  const [sidecarClearPreview, setSidecarClearPreview] =
    ctx.useState<PromptSidecarClearPreviewDto | null>("sidecarClearPreview", null);
  const [sidecarConfirmationText, setSidecarConfirmationText] = ctx.useState(
    "sidecarConfirmationText",
    ""
  );
  const [sidecarBusy, setSidecarBusy] = ctx.useState("sidecarBusy", false);
  const [sidecarNotice, setSidecarNotice] = ctx.useState("sidecarNotice", "");
  const [sidecarError, setSidecarError] = ctx.useState("sidecarError", "");
  const [loading, setLoading] = ctx.useState("loading", false);
  const [hasLoaded, setHasLoaded] = ctx.useState("hasLoaded", false);
  const [error, setError] = ctx.useState<ExplorerError | null>("error", null);
  const [partialNotice, setPartialNotice] = ctx.useState("partialNotice", "");
  const requestSequence = ctx.useRef("requestSequence", 0);
  const loadVersion = ctx.useRef("loadVersion", 0);
  const loadGuard = ctx.useRef("loadGuard", false);

  async function remote<T>(
    op: ExplorerOperation,
    workspaceId?: string,
    params?: {
      page?: number;
      size?: number;
      reverse?: boolean;
      sessionId?: string;
      peerId?: string;
      observerPeerId?: string;
      targetPeerId?: string;
      displayName?: string;
      archived?: boolean;
      peerMutation?: PeerMutationKind;
      userPeerId?: string;
      aiPeerId?: string;
      confirmationToken?: string;
      forceRefresh?: boolean;
      query?: string;
      conclusionLevel?: ConclusionFiltersDto["level"];
      keepConclusionId?: string;
      deleteConclusionIds?: string[];
      confirmationText?: string;
    }
  ): Promise<T> {
    requestSequence.current += 1;
    const requestId = `explore-${Date.now()}-${requestSequence.current}`;
    const response = await ToolPkg.ipc.call<unknown, ExplorerResponse<T>>(
      "honcho.explorer.request",
      { op, requestId, workspaceId, params },
      { targetRuntime: "main" }
    );
    if (!response || response.requestId !== requestId) {
      throw { code: "STALE_RESPONSE", message: "Explorer 返回了无效响应。", retryable: true };
    }
    if (!response.ok) throw response.error || { code: "EXPLORER_ERROR", message: "Explorer 请求失败。" };
    return response.data as T;
  }

  async function load(
    targetTab: ExplorerTab,
    workspace = "",
    page = 1,
    forceRefresh = false,
    conclusionFilterOverride?: ConclusionFiltersDto
  ): Promise<void> {
    loadVersion.current += 1;
    const version = loadVersion.current;
    setLoading(true);
    setError(null);
    setPartialNotice("");

    try {
      const nextStatus = await remote<ExplorerStatusDto>("status");
      if (version !== loadVersion.current) return;
      setStatus(nextStatus);
      const targetWorkspace = workspace || browsingWorkspace || nextStatus.workspace;
      if (targetWorkspace !== browsingWorkspace) setBrowsingWorkspace(targetWorkspace);

      if (!nextStatus.configured) {
        if (targetTab === "overview") {
          try {
            setSidecarStatus(await remote<PromptSidecarStatusDto>("sidecar_status"));
            setSidecarError("");
          } catch (sidecarFailure) {
            setSidecarError(uiError(sidecarFailure).message);
          }
        }
        setHasLoaded(true);
        return;
      }

      if (targetTab === "overview") {
        const results = await Promise.allSettled([
          remote<WorkspaceIdentityDto>("identity_status"),
          remote<QueueStatusDto>("queue_status", targetWorkspace),
          remote<ExplorerPage<WorkspaceDto>>("list_workspaces", undefined, {
            page: 1, size: 20, forceRefresh,
          }),
          remote<ExplorerPage<PeerDto>>("list_peers", targetWorkspace, {
            page: 1, size: 5, reverse: true, forceRefresh,
          }),
          remote<ExplorerPage<SessionDto>>("list_sessions", targetWorkspace, {
            page: 1,
            size: 5,
            reverse: true,
            forceRefresh,
          }),
          remote<PromptSidecarStatusDto>("sidecar_status"),
        ]);
        if (version !== loadVersion.current) return;
        const identityResult = results[0] as PromiseSettledResult<WorkspaceIdentityDto>;
        const queueResult = results[1] as PromiseSettledResult<QueueStatusDto>;
        const workspaceResult = results[2] as PromiseSettledResult<ExplorerPage<WorkspaceDto>>;
        const peerResult = results[3] as PromiseSettledResult<ExplorerPage<PeerDto>>;
        const sessionResult = results[4] as PromiseSettledResult<ExplorerPage<SessionDto>>;
        const sidecarResult = results[5] as PromiseSettledResult<PromptSidecarStatusDto>;
        const nextStatusWithQueue: ExplorerStatusDto = { ...nextStatus };
        if (identityResult.status === "fulfilled") {
          setIdentity(identityResult.value);
          setIdentityUserPeer(identityResult.value.user_peer);
          setIdentityAiPeer(identityResult.value.ai_peer);
          setIdentityPreview(null);
          setIdentityError("");
          nextStatusWithQueue.user_peer = identityResult.value.user_peer;
          nextStatusWithQueue.ai_peer = identityResult.value.ai_peer;
          nextStatusWithQueue.identity_source = identityResult.value.source;
          nextStatusWithQueue.identity_revision = identityResult.value.revision;
          nextStatusWithQueue.identity_migration_required = identityResult.value.migration_required;
        } else {
          setIdentityError(uiError(identityResult.reason).message);
        }
        if (queueResult.status === "fulfilled") {
          nextStatusWithQueue.server_queue = queueResult.value;
        } else {
          nextStatusWithQueue.server_queue_error = uiError(queueResult.reason);
        }
        setStatus(nextStatusWithQueue);
        if (workspaceResult.status === "fulfilled") setWorkspaces(workspaceResult.value);
        if (peerResult.status === "fulfilled") setPeers(peerResult.value);
        if (sessionResult.status === "fulfilled") setSessions(sessionResult.value);
        if (sidecarResult.status === "fulfilled") {
          setSidecarStatus(sidecarResult.value);
          setSidecarError("");
        } else {
          setSidecarError(uiError(sidecarResult.reason).message);
        }
        const failures = [identityResult, workspaceResult, peerResult, sessionResult, sidecarResult]
          .filter((result) => result.status === "rejected")
          .map((result) => uiError((result as PromiseRejectedResult).reason));
        if (failures.length) {
          setPartialNotice(failures.some((item) => item.code === "PERMISSION_DENIED")
            ? "当前 API Key 权限有限，部分数据不可见。"
            : "部分概览数据加载失败。");
        }
      } else if (targetTab === "peers") {
        const peerPage = await remote<ExplorerPage<PeerDto>>(
          "list_peers",
          targetWorkspace,
          { page, size: 20, reverse: true, forceRefresh }
        );
        setPeers(peerPage);
        if (targetWorkspace === nextStatus.workspace) {
          try {
            const nextIdentity = await remote<WorkspaceIdentityDto>("identity_status");
            if (version !== loadVersion.current) return;
            setIdentity(nextIdentity);
            setIdentityUserPeer(nextIdentity.user_peer);
            setIdentityAiPeer(nextIdentity.ai_peer);
            if (!peerCardObserver) setPeerCardObserver(nextIdentity.ai_peer);
          } catch (identityFailure) {
            setPeerError(uiError(identityFailure).message);
          }
        }
      } else if (targetTab === "sessions") {
        setSessions(await remote("list_sessions", targetWorkspace, {
          page, size: 20, reverse: true, forceRefresh,
        }));
      } else {
        const filters = conclusionFilterOverride || conclusionFilters;
        const [conclusionPage, peerPage] = await Promise.all([
          remote<ExplorerPage<ConclusionDto>>("list_conclusions", targetWorkspace, {
            page: filters.query ? 1 : page,
            size: 20,
            reverse: true,
            observerPeerId: filters.observer_id,
            targetPeerId: filters.observed_id,
            sessionId: filters.session_id,
            conclusionLevel: filters.level,
            query: filters.query,
            forceRefresh,
          }),
          remote<ExplorerPage<PeerDto>>("list_peers", targetWorkspace, {
            page: 1, size: 100, reverse: false, forceRefresh,
          }),
        ]);
        if (version !== loadVersion.current) return;
        setConclusions(conclusionPage);
        setConclusionPeers(peerPage);
      }
      if (version === loadVersion.current) setHasLoaded(true);
    } catch (caught) {
      if (version === loadVersion.current) {
        setError(uiError(caught));
        setHasLoaded(true);
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }

  async function loadMessages(sessionId: string, page = 1, forceRefresh = false): Promise<void> {
    loadVersion.current += 1;
    const version = loadVersion.current;
    setLoading(true);
    setError(null);
    setPartialNotice("");
    try {
      const nextStatus = await remote<ExplorerStatusDto>("status");
      if (version !== loadVersion.current) return;
      setStatus(nextStatus);
      if (!nextStatus.configured) {
        setHasLoaded(true);
        return;
      }
      const workspaceId = browsingWorkspace || nextStatus.workspace;
      const pageResult = await remote<ExplorerPage<MessageDto>>(
        "list_messages",
        workspaceId,
        { page, size: 30, reverse: false, sessionId, forceRefresh }
      );
      if (version !== loadVersion.current) return;
      setMessages(pageResult);
      setHasLoaded(true);
    } catch (caught) {
      if (version === loadVersion.current) {
        setError(uiError(caught));
        setHasLoaded(true);
      }
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }

  function switchTab(nextTab: ExplorerTab): Promise<void> {
    setTab(nextTab);
    if (nextTab === "sessions" && selectedSessionId) {
      return loadMessages(selectedSessionId, messages.page || 1);
    }
    if (nextTab !== "sessions") setSelectedSessionId("");
    if (nextTab !== "peers") {
      setSelectedPeer(null);
      setPeerMutationPreview(null);
      setIdentityPreview(null);
    }
    const page = nextTab === "peers"
      ? peers.page
      : nextTab === "sessions"
        ? sessions.page
        : nextTab === "conclusions"
          ? conclusions.page
          : 1;
    return load(nextTab, browsingWorkspace, page || 1);
  }

  function selectWorkspace(workspaceId: string): Promise<void> {
    setSelectedSessionId("");
    setSelectedPeer(null);
    setPeerMutationPreview(null);
    setIdentityPreview(null);
    setBrowsingWorkspace(workspaceId);
    return load(tab, workspaceId, 1);
  }

  function openSession(sessionId: string): Promise<void> {
    setTab("sessions");
    setSelectedSessionId(sessionId);
    return loadMessages(sessionId, 1);
  }

  function closeSession(): Promise<void> {
    setSelectedSessionId("");
    return load("sessions", browsingWorkspace, sessions.page || 1);
  }

  async function refreshPeerCard(observerId = peerCardObserver, forceRefresh = false): Promise<void> {
    if (!selectedPeer || !observerId) return;
    setPeerBusy(true);
    setPeerCardError("");
    try {
      const value = await remote<PeerCardDto>("get_peer_card", browsingWorkspace, {
        observerPeerId: observerId,
        targetPeerId: selectedPeer.id,
        forceRefresh,
      });
      setPeerCardObserver(observerId);
      setPeerCard(value);
    } catch (caught) {
      setPeerCard(null);
      setPeerCardError(uiError(caught).message);
    } finally {
      setPeerBusy(false);
    }
  }

  async function loadPeerDetail(
    peerId: string,
    observerOverride = "",
    sessionPage = 1,
    forceRefresh = false
  ): Promise<void> {
    const workspaceId = browsingWorkspace || status?.workspace || "";
    if (!workspaceId) return;
    const observerId = observerOverride
      || peerCardObserver
      || identity?.ai_peer
      || status?.ai_peer
      || "";
    setPeerBusy(true);
    setPeerError("");
    setPeerCardError("");
    setPeerNotice("");
    setPeerMutationPreview(null);
    setIdentityPreview(null);
    try {
      const [detail, related] = await Promise.all([
        remote<PeerDto>("get_peer", workspaceId, { peerId, forceRefresh }),
        remote<ExplorerPage<SessionDto>>("list_peer_sessions", workspaceId, {
          peerId,
          page: sessionPage,
          size: 20,
          reverse: true,
          forceRefresh,
        }),
      ]);
      setSelectedPeer(detail);
      setPeerEditDisplayName(detail.display_name);
      setPeerSessions(related);
      if (observerId) {
        setPeerCardObserver(observerId);
        try {
          setPeerCard(await remote<PeerCardDto>("get_peer_card", workspaceId, {
            observerPeerId: observerId,
            targetPeerId: peerId,
            forceRefresh,
          }));
        } catch (cardFailure) {
          setPeerCard(null);
          setPeerCardError(uiError(cardFailure).message);
        }
      } else {
        setPeerCard(null);
        setPeerCardError("当前工作区没有可用的 Card 观察者。");
      }
    } catch (caught) {
      setPeerError(uiError(caught).message);
    } finally {
      setPeerBusy(false);
    }
  }

  function closePeer(): void {
    setSelectedPeer(null);
    setPeerSessions(emptyPage<SessionDto>());
    setPeerCard(null);
    setPeerMutationPreview(null);
    setIdentityPreview(null);
    setPeerNotice("");
    setPeerError("");
    setPeerCardError("");
  }

  async function preparePeerMutation(
    mutation: PeerMutationKind,
    values: { peerId?: string; displayName?: string; archived?: boolean; sessionId?: string } = {}
  ): Promise<void> {
    const peerId = values.peerId || selectedPeer?.id || "";
    setPeerBusy(true);
    setPeerError("");
    setPeerNotice("");
    setIdentityPreview(null);
    try {
      setPeerMutationPreview(await remote<PeerMutationPreviewDto>(
        "prepare_peer_mutation",
        status?.workspace,
        {
          peerMutation: mutation,
          peerId: peerId.trim(),
          displayName: values.displayName?.trim(),
          archived: values.archived,
          sessionId: values.sessionId,
        }
      ));
    } catch (caught) {
      setPeerError(uiError(caught).message);
    } finally {
      setPeerBusy(false);
    }
  }

  async function commitPeerMutation(): Promise<void> {
    if (!peerMutationPreview || !status) return;
    const preview = peerMutationPreview;
    setPeerBusy(true);
    setPeerError("");
    setPeerNotice("");
    try {
      const result = await remote<PeerMutationResultDto>(
        "commit_peer_mutation",
        status.workspace,
        {
          peerMutation: preview.mutation,
          peerId: preview.peer_id,
          displayName: preview.mutation === "create" || preview.mutation === "update_display_name"
            ? preview.proposed_display_name
            : undefined,
          archived: preview.mutation === "set_archived" ? preview.proposed_archived : undefined,
          sessionId: preview.session_id,
          confirmationToken: preview.confirmation_token,
        }
      );
      setPeerMutationPreview(null);
      setPeerCreateOpen(false);
      setPeerCreateId("");
      setPeerCreateDisplayName("");
      const successNotice = preview.mutation === "remove_from_session"
        ? "已移除会话成员关系，远端历史数据保持不变。"
        : "参与者变更已保存。";
      if (result.peer) {
        setSelectedPeer(result.peer);
        setPeerEditDisplayName(result.peer.display_name);
      }
      const refreshed = await remote<ExplorerPage<PeerDto>>(
        "list_peers",
        status.workspace,
        { page: peers.page || 1, size: 20, reverse: true }
      );
      setPeers(refreshed);
      await loadPeerDetail(preview.peer_id, peerCardObserver || status.ai_peer);
      setPeerNotice(successNotice);
      await ctx.showToast("Honcho 参与者变更已保存");
    } catch (caught) {
      setPeerMutationPreview(null);
      setPeerError(uiError(caught).message);
    } finally {
      setPeerBusy(false);
    }
  }

  async function preparePeerRole(role: "user" | "ai", peerId: string): Promise<void> {
    if (!status) return;
    setPeerBusy(true);
    setPeerError("");
    setPeerNotice("");
    setPeerMutationPreview(null);
    try {
      const current = identity || await remote<WorkspaceIdentityDto>("identity_status");
      const userPeerId = role === "user" ? peerId : current.user_peer;
      const aiPeerId = role === "ai" ? peerId : current.ai_peer;
      setIdentityPreview(await remote<WorkspaceIdentityUpdatePreviewDto>(
        "prepare_identity_update",
        status.workspace,
        { userPeerId, aiPeerId }
      ));
    } catch (caught) {
      setPeerError(uiError(caught).message);
    } finally {
      setPeerBusy(false);
    }
  }

  async function prepareIdentityUpdate(): Promise<void> {
    if (!status || !identity) return;
    setIdentityBusy(true);
    setIdentityError("");
    setIdentityNotice("");
    try {
      const preview = await remote<WorkspaceIdentityUpdatePreviewDto>(
        "prepare_identity_update",
        status.workspace,
        {
          userPeerId: identityUserPeer.trim(),
          aiPeerId: identityAiPeer.trim(),
        }
      );
      setIdentityPreview(preview);
    } catch (caught) {
      setIdentityError(uiError(caught).message);
    } finally {
      setIdentityBusy(false);
    }
  }

  async function commitIdentityUpdate(): Promise<void> {
    if (!status || !identityPreview) return;
    setIdentityBusy(true);
    setIdentityError("");
    setIdentityNotice("");
    try {
      const updated = await remote<WorkspaceIdentityDto>(
        "commit_identity_update",
        status.workspace,
        {
          userPeerId: identityPreview.proposed_user_peer,
          aiPeerId: identityPreview.proposed_ai_peer,
          confirmationToken: identityPreview.confirmation_token,
        }
      );
      setIdentity(updated);
      setIdentityUserPeer(updated.user_peer);
      setIdentityAiPeer(updated.ai_peer);
      setIdentityPreview(null);
      setIdentityNotice("身份绑定已保存。main 与 sandbox 会在下一次刷新窗口内读取新 revision。");
      setStatus({
        ...status,
        user_peer: updated.user_peer,
        ai_peer: updated.ai_peer,
        identity_source: updated.source,
        identity_revision: updated.revision,
        identity_migration_required: updated.migration_required,
      });
      setPeers({
        ...peers,
        items: peers.items.map((peer) => ({
          ...peer,
          roles: [
            ...(peer.id === updated.user_peer ? ["user" as const] : []),
            ...(peer.id === updated.ai_peer ? ["ai" as const] : []),
          ],
        })),
      });
      if (selectedPeer) {
        setSelectedPeer({
          ...selectedPeer,
          roles: [
            ...(selectedPeer.id === updated.user_peer ? ["user" as const] : []),
            ...(selectedPeer.id === updated.ai_peer ? ["ai" as const] : []),
          ],
        });
        setPeerNotice("角色绑定已保存。之后的新消息与工具调用会使用新角色。");
      }
      await ctx.showToast("Honcho 身份绑定已保存");
    } catch (caught) {
      setIdentityPreview(null);
      setIdentityError(uiError(caught).message);
    } finally {
      setIdentityBusy(false);
    }
  }

  function resetConclusionCleanup(): void {
    setConclusionDuplicateReport(null);
    setSelectedDuplicateGroupKey("");
    setKeepConclusionId("");
    setConclusionCleanupPreview(null);
    setConclusionConfirmationText("");
  }

  async function applyConclusionFilters(): Promise<void> {
    const next = normalizedConclusionFilters(conclusionDraftFilters);
    setConclusionDraftFilters(next);
    setConclusionFilters(next);
    setConclusionNotice("");
    setConclusionError("");
    resetConclusionCleanup();
    await load("conclusions", browsingWorkspace, 1, true, next);
  }

  async function clearConclusionFilters(): Promise<void> {
    const next: ConclusionFiltersDto = {};
    setConclusionDraftFilters(next);
    setConclusionFilters(next);
    setConclusionNotice("");
    setConclusionError("");
    resetConclusionCleanup();
    await load("conclusions", browsingWorkspace, 1, true, next);
  }

  async function scanConclusionDuplicates(): Promise<void> {
    const workspaceId = browsingWorkspace || status?.workspace || "";
    if (!workspaceId) return;
    setConclusionBusy(true);
    setConclusionError("");
    setConclusionNotice("");
    setConclusionCleanupPreview(null);
    setConclusionConfirmationText("");
    try {
      const report = await remote<ConclusionDuplicateReportDto>(
        "scan_conclusion_duplicates",
        workspaceId,
        {
          observerPeerId: conclusionFilters.observer_id,
          targetPeerId: conclusionFilters.observed_id,
          sessionId: conclusionFilters.session_id,
          conclusionLevel: conclusionFilters.level,
          forceRefresh: true,
        }
      );
      setConclusionDuplicateReport(report);
      setSelectedDuplicateGroupKey("");
      setKeepConclusionId("");
      setConclusionNotice(
        (conclusionFilters.query ? "语义搜索文字不参与精确重复扫描。" : "")
        + "已扫描 " + report.scanned_count + " 条结论。"
      );
    } catch (caught) {
      setConclusionError(uiError(caught).message);
    } finally {
      setConclusionBusy(false);
    }
  }

  function selectConclusionDuplicateGroup(group: ConclusionDuplicateGroupDto): void {
    setSelectedDuplicateGroupKey(group.group_key);
    setKeepConclusionId(group.earliest_id);
    setConclusionCleanupPreview(null);
    setConclusionConfirmationText("");
    setConclusionError("");
  }

  async function prepareConclusionCleanup(group: ConclusionDuplicateGroupDto): Promise<void> {
    const deleteConclusionIds = group.items
      .map((item) => item.id)
      .filter((id) => id !== keepConclusionId);
    if (!keepConclusionId || !deleteConclusionIds.length) return;
    setConclusionBusy(true);
    setConclusionError("");
    setConclusionNotice("");
    try {
      const preview = await remote<ConclusionCleanupPreviewDto>(
        "prepare_conclusion_cleanup",
        browsingWorkspace,
        {
          keepConclusionId,
          deleteConclusionIds,
          observerPeerId: conclusionFilters.observer_id,
          targetPeerId: conclusionFilters.observed_id,
          sessionId: conclusionFilters.session_id,
          conclusionLevel: conclusionFilters.level,
        }
      );
      setConclusionCleanupPreview(preview);
      setConclusionConfirmationText("");
    } catch (caught) {
      setConclusionError(uiError(caught).message);
    } finally {
      setConclusionBusy(false);
    }
  }

  async function commitConclusionCleanup(): Promise<void> {
    const preview = conclusionCleanupPreview;
    if (!preview) return;
    setConclusionBusy(true);
    setConclusionError("");
    setConclusionNotice("");
    try {
      const result = await remote<ConclusionCleanupResultDto>(
        "commit_conclusion_cleanup",
        preview.workspace_id,
        {
          keepConclusionId: preview.keep_conclusion_id,
          deleteConclusionIds: preview.delete_conclusion_ids,
          confirmationToken: preview.confirmation_token,
          confirmationText: conclusionConfirmationText,
        }
      );
      setConclusionCleanupPreview(null);
      setConclusionConfirmationText("");
      const cleanupNotice = result.failures.length
        ? "已删除 " + result.deleted_ids.length + " 条；失败 "
          + clipText(result.failures.map((item) => item.id).join(", "), 320)
          + "。可重新扫描后重试。"
        : "已删除 " + result.deleted_ids.length + " 条重复结论。";
      await load("conclusions", browsingWorkspace, 1, true, conclusionFilters);
      await scanConclusionDuplicates();
      setConclusionNotice(cleanupNotice);
      await ctx.showToast("Honcho 重复结论清理已执行");
    } catch (caught) {
      setConclusionCleanupPreview(null);
      setConclusionConfirmationText("");
      setConclusionError(uiError(caught).message);
    } finally {
      setConclusionBusy(false);
    }
  }

  async function prepareSidecarClear(): Promise<void> {
    setSidecarBusy(true);
    setSidecarError("");
    setSidecarNotice("");
    try {
      setSidecarClearPreview(await remote<PromptSidecarClearPreviewDto>("prepare_sidecar_clear"));
      setSidecarConfirmationText("");
    } catch (caught) {
      setSidecarClearPreview(null);
      setSidecarConfirmationText("");
      setSidecarError(uiError(caught).message);
    } finally {
      setSidecarBusy(false);
    }
  }

  async function commitSidecarClear(): Promise<void> {
    const preview = sidecarClearPreview;
    if (!preview) return;
    setSidecarBusy(true);
    setSidecarError("");
    setSidecarNotice("");
    try {
      const result = await remote<PromptSidecarClearResultDto>("commit_sidecar_clear", undefined, {
        confirmationToken: preview.confirmation_token,
        confirmationText: sidecarConfirmationText,
      });
      setSidecarClearPreview(null);
      setSidecarConfirmationText("");
      setSidecarNotice(
        "已清除 " + result.deleted_files + " 个 sidecar 文件（" + result.deleted_bytes + " 字节）。"
      );
      setSidecarStatus(await remote<PromptSidecarStatusDto>("sidecar_status"));
      await ctx.showToast("Honcho Prompt sidecar 已清除");
    } catch (caught) {
      setSidecarClearPreview(null);
      setSidecarConfirmationText("");
      setSidecarError(uiError(caught).message);
    } finally {
      setSidecarBusy(false);
    }
  }

  function sectionTitle(title: string, subtitle = ""): ComposeNode {
    return UI.Column({ fillMaxWidth: true, spacing: 2, paddingTop: 6 }, [
      UI.Text({ text: title, style: "titleMedium", color: colors.onSurface, fontWeight: "bold" }),
      subtitle
        ? UI.Text({
            text: subtitle,
            style: "bodySmall",
            color: colors.onSurfaceVariant,
            maxLines: 2,
            overflow: "ellipsis",
          })
        : null,
    ].filter(Boolean) as ComposeNode[]);
  }

  function metadataLine(value: unknown): ComposeNode | null {
    const text = compactJson(value);
    return text
      ? UI.Text({
          text,
          style: "bodySmall",
          color: colors.onSurfaceVariant,
          maxLines: 2,
          overflow: "ellipsis",
          softWrap: true,
        })
      : null;
  }

  function entityCard(
    id: string,
    lines: ComposeNode[],
    key: string,
    onClick?: () => void | Promise<void>
  ): ComposeNode {
    return UI.Card(
      {
        key,
        fillMaxWidth: true,
        shape: { type: "rounded", cornerRadius: 8 },
        elevation: 0,
        containerColor: colors.surfaceVariant,
      },
      [
        UI.Row({ fillMaxWidth: true, onClick }, [
          UI.Column({ fillMaxWidth: true, padding: 12, spacing: 5 }, [
            UI.Text({
              text: id,
              style: "titleSmall",
              color: colors.onSurface,
              fontWeight: "bold",
              maxLines: 2,
              overflow: "ellipsis",
              softWrap: true,
            }),
            ...lines,
          ]),
        ]),
      ]
    );
  }

  function emptyState(label: string): ComposeNode {
    return UI.Column(
      { fillMaxWidth: true, horizontalAlignment: "center", padding: 28, spacing: 6 },
      [
        UI.Icon({ name: "inbox", size: 28, tint: colors.onSurfaceVariant }),
        UI.Text({ text: `暂无${label}`, style: "bodyMedium", color: colors.onSurfaceVariant }),
      ]
    );
  }

  function pager(page: ExplorerPage<unknown>, onPage: (page: number) => Promise<void>): ComposeNode | null {
    if (page.pages <= 1) return null;
    return UI.Row(
      {
        fillMaxWidth: true,
        height: 48,
        horizontalArrangement: "spaceBetween",
        verticalAlignment: "center",
      },
      [
        UI.IconButton({
          icon: "chevron_left",
          enabled: !loading && page.page > 1,
          onClick: () => onPage(page.page - 1),
        }),
        UI.Text({
          text: pageLabel(page.page, page.pages, page.total),
          style: "labelMedium",
          color: colors.onSurfaceVariant,
        }),
        UI.IconButton({
          icon: "chevron_right",
          enabled: !loading && page.page < page.pages,
          onClick: () => onPage(page.page + 1),
        }),
      ]
    );
  }

  function renderSidecarMaintenance(): ComposeNode[] {
    const nodes: ComposeNode[] = [
      UI.HorizontalDivider({ color: colors.outlineVariant }),
      sectionTitle("Prompt sidecar", "插件私有模型请求历史"),
    ];
    if (sidecarError) {
      nodes.push(UI.Surface({
        fillMaxWidth: true,
        padding: 10,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.errorContainer,
      }, [UI.Text({
        text: sidecarError,
        style: "bodySmall",
        color: colors.onErrorContainer,
        softWrap: true,
      })]));
    }
    if (sidecarNotice) {
      nodes.push(UI.Surface({
        fillMaxWidth: true,
        padding: 10,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.secondaryContainer,
      }, [UI.Text({
        text: sidecarNotice,
        style: "bodySmall",
        color: colors.onSecondaryContainer,
        softWrap: true,
      })]));
    }
    nodes.push(UI.Surface({
      fillMaxWidth: true,
      padding: 10,
      shape: { type: "rounded", cornerRadius: 8 },
      containerColor: colors.surfaceVariant,
    }, [UI.Row({ fillMaxWidth: true, spacing: 8, verticalAlignment: "center" }, [
      UI.Icon({ name: "history", size: 20, tint: colors.primary }),
      UI.Column({ weight: 1, spacing: 2 }, [
        UI.Text({
          text: sidecarStatus
            ? sidecarStatus.file_count + " 个文件 · " + displayBytes(sidecarStatus.total_bytes)
            : "状态不可用",
          style: "bodyMedium",
          color: colors.onSurface,
        }),
        sidecarStatus
          ? UI.Text({
              text: "容量上限 " + displayBytes(sidecarStatus.max_bytes),
              style: "labelSmall",
              color: colors.onSurfaceVariant,
            })
          : null,
      ].filter(Boolean) as ComposeNode[]),
      UI.OutlinedButton({
        enabled: !sidecarBusy && Boolean(sidecarStatus?.file_count),
        onClick: prepareSidecarClear,
      }, [UI.Row({ spacing: 5, verticalAlignment: "center" }, [
        UI.Icon({ name: "delete_sweep", size: 18, tint: colors.error }),
        UI.Text({ text: "清除", style: "labelLarge", color: colors.error }),
      ])]),
    ])]));

    if (sidecarClearPreview) {
      nodes.push(UI.Surface({
        fillMaxWidth: true,
        padding: 12,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.errorContainer,
      }, [UI.Column({ fillMaxWidth: true, spacing: 7 }, [
        UI.Text({
          text: "确认清除 Prompt sidecar",
          style: "titleSmall",
          color: colors.onErrorContainer,
          fontWeight: "bold",
        }),
        UI.Text({
          text: sidecarClearPreview.file_count + " 个文件 · " + displayBytes(sidecarClearPreview.total_bytes),
          style: "bodySmall",
          color: colors.onErrorContainer,
        }),
        UI.TextField({
          value: sidecarConfirmationText,
          onValueChange: setSidecarConfirmationText,
          label: "输入 " + sidecarClearPreview.confirmation_phrase,
          singleLine: true,
          fillMaxWidth: true,
        }),
        UI.Row({ fillMaxWidth: true, spacing: 8, horizontalArrangement: "end" }, [
          UI.OutlinedButton({
            enabled: !sidecarBusy,
            onClick: () => {
              setSidecarClearPreview(null);
              setSidecarConfirmationText("");
            },
          }, [UI.Text({ text: "取消", style: "labelLarge", color: colors.primary })]),
          UI.Button({
            text: "确认清除",
            enabled: !sidecarBusy
              && sidecarConfirmationText === sidecarClearPreview.confirmation_phrase,
            onClick: commitSidecarClear,
          }),
        ]),
      ])]));
    }
    return nodes;
  }

  function renderOverview(): ComposeNode[] {
    if (!status) return [];
    if (!status.configured) {
      return [
        UI.Card(
          {
            fillMaxWidth: true,
            shape: { type: "rounded", cornerRadius: 8 },
            elevation: 0,
            containerColor: colors.errorContainer,
          },
          [
            UI.Column({ fillMaxWidth: true, padding: 14, spacing: 7 }, [
              UI.Text({ text: "Honcho 尚未配置", style: "titleMedium", color: colors.onErrorContainer }),
              UI.Text({
                text: "请设置 HONCHO_API_KEY 和 HONCHO_WORKSPACE；使用自托管服务时也可设置 HONCHO_BASE_URL。",
                style: "bodySmall",
                color: colors.onErrorContainer,
                softWrap: true,
              }),
            ]),
          ]
        ),
        ...renderSidecarMaintenance(),
      ];
    }

    const queue = status.server_queue;
    const nodes: ComposeNode[] = [
      sectionTitle("运行状态", "连接配置、参与者与写入队列"),
      UI.Row({ fillMaxWidth: true, spacing: 8 }, [
        UI.Surface(
          {
            weight: 1,
            padding: 10,
            shape: { type: "rounded", cornerRadius: 8 },
            containerColor: colors.secondaryContainer,
          },
          [UI.Column({ spacing: 2 }, [
            UI.Text({ text: String(status.pending_messages), style: "titleLarge", color: colors.onSecondaryContainer }),
            UI.Text({ text: "本地待写", style: "labelSmall", color: colors.onSecondaryContainer }),
          ])]
        ),
        UI.Surface(
          {
            weight: 1,
            padding: 10,
            shape: { type: "rounded", cornerRadius: 8 },
            containerColor: colors.tertiaryContainer,
          },
          [UI.Column({ spacing: 2 }, [
            UI.Text({ text: String(queue?.pending_work_units || 0), style: "titleLarge", color: colors.onTertiaryContainer }),
            UI.Text({ text: "服务端待处理", style: "labelSmall", color: colors.onTertiaryContainer }),
          ])]
        ),
      ]),
      UI.Text({
        text: `${status.user_peer} → ${status.ai_peer}  ·  ${status.identity_source === "workspace_metadata" ? `身份 rev ${status.identity_revision}` : "身份待迁移"}  ·  ${recallModeLabel(status.recall_mode)}  ·  ${sessionStrategyLabel(status.session_strategy)}`,
        style: "bodySmall",
        color: colors.onSurfaceVariant,
        maxLines: 2,
        overflow: "ellipsis",
      }),
      sectionTitle("工作区", `当前密钥可见 ${workspaces.total} 个`),
    ];

    nodes.splice(nodes.length - 1, 0, renderIdentityManager(ctx, {
      identity,
      activeWorkspace: status.workspace,
      browsingWorkspace,
      userPeerId: identityUserPeer,
      aiPeerId: identityAiPeer,
      preview: identityPreview,
      busy: identityBusy,
      notice: identityNotice,
      error: identityError,
      onUserPeerChange: (value) => {
        setIdentityUserPeer(value);
        setIdentityPreview(null);
        setIdentityNotice("");
        setIdentityError("");
      },
      onAiPeerChange: (value) => {
        setIdentityAiPeer(value);
        setIdentityPreview(null);
        setIdentityNotice("");
        setIdentityError("");
      },
      onPrepare: prepareIdentityUpdate,
      onCommit: commitIdentityUpdate,
      onCancel: () => {
        setIdentityPreview(null);
        setIdentityError("");
      },
    }));

    if (!workspaces.items.length) {
      nodes.push(emptyState("工作区"));
    } else {
      for (const workspace of workspaces.items) {
        const selected = workspace.id === browsingWorkspace;
        nodes.push(
          UI.Card(
            {
              key: `workspace-${workspace.id}`,
              fillMaxWidth: true,
              elevation: 0,
              shape: { type: "rounded", cornerRadius: 8 },
              border: selected ? { width: 1, color: colors.primary } : undefined,
              containerColor: selected ? colors.primaryContainer : colors.surfaceVariant,
            },
            [
              UI.Row(
                {
                  fillMaxWidth: true,
                  padding: 12,
                  verticalAlignment: "center",
                  spacing: 8,
                  onClick: () => selectWorkspace(workspace.id),
                },
                [
                  UI.Icon({ name: selected ? "database" : "storage", size: 20, tint: selected ? colors.primary : colors.onSurfaceVariant }),
                  UI.Column({ weight: 1, spacing: 2 }, [
                    UI.Text({
                      text: workspace.id,
                      style: "titleSmall",
                      color: selected ? colors.onPrimaryContainer : colors.onSurface,
                      maxLines: 2,
                      overflow: "ellipsis",
                    }),
                    UI.Text({
                      text: workspace.id === status.workspace ? "当前活跃工作区" : displayTime(workspace.created_at),
                      style: "labelSmall",
                      color: colors.onSurfaceVariant,
                    }),
                  ]),
                ]
              ),
            ]
          )
        );
      }
    }

    nodes.push(sectionTitle("最近参与者", `共 ${peers.total} 个`));
    for (const peer of peers.items) {
      nodes.push(entityCard(peer.id, [
        UI.Text({ text: displayTime(peer.created_at), style: "labelSmall", color: colors.onSurfaceVariant }),
      ], `overview-peer-${peer.id}`));
    }
    if (!peers.items.length) nodes.push(emptyState("参与者"));

    nodes.push(sectionTitle("最近会话", `共 ${sessions.total} 个`));
    for (const session of sessions.items) {
      nodes.push(entityCard(session.id, [
        UI.Text({
          text: `${session.is_active === false ? "已停用" : "活跃"}  ·  ${displayTime(session.created_at)}`,
          style: "labelSmall",
          color: colors.onSurfaceVariant,
        }),
      ], `overview-session-${session.id}`, () => openSession(session.id)));
    }
    if (!sessions.items.length) nodes.push(emptyState("会话"));
    nodes.push(...renderSidecarMaintenance());
    return nodes;
  }

  function renderPeers(): ComposeNode[] {
    const observerOptions: PeerDto[] = [...peers.items];
    for (const peerId of [identity?.ai_peer, identity?.user_peer, peerCardObserver]) {
      if (peerId && !observerOptions.some((peer) => peer.id === peerId)) {
        observerOptions.push({
          id: peerId,
          display_name: "",
          archived: false,
          roles: [
            ...(peerId === identity?.user_peer ? ["user" as const] : []),
            ...(peerId === identity?.ai_peer ? ["ai" as const] : []),
          ],
        });
      }
    }
    return renderPeerWorkspace(ctx, {
      workspaceId: browsingWorkspace,
      activeWorkspace: status?.workspace || "",
      page: peers,
      selectedPeer,
      sessions: peerSessions,
      card: peerCard,
      observerPeerId: peerCardObserver,
      observerOptions,
      observerMenuOpen: peerObserverMenuOpen,
      showArchived: showArchivedPeers,
      createOpen: peerCreateOpen,
      createPeerId: peerCreateId,
      createDisplayName: peerCreateDisplayName,
      editDisplayName: peerEditDisplayName,
      mutationPreview: peerMutationPreview,
      identityPreview,
      busy: peerBusy || identityBusy,
      notice: peerNotice,
      error: peerError,
      cardError: peerCardError,
      onBack: closePeer,
      onOpenPeer: loadPeerDetail,
      onPage: (page) => load("peers", browsingWorkspace, page),
      onSessionPage: (page) => selectedPeer
        ? loadPeerDetail(selectedPeer.id, peerCardObserver, page)
        : Promise.resolve(),
      onShowArchivedChange: setShowArchivedPeers,
      onCreateOpenChange: (value) => {
        setPeerCreateOpen(value);
        setPeerMutationPreview(null);
        setPeerError("");
        setPeerNotice("");
      },
      onCreatePeerIdChange: (value) => {
        setPeerCreateId(value);
        setPeerMutationPreview(null);
      },
      onCreateDisplayNameChange: (value) => {
        setPeerCreateDisplayName(value);
        setPeerMutationPreview(null);
      },
      onEditDisplayNameChange: (value) => {
        setPeerEditDisplayName(value);
        setPeerMutationPreview(null);
      },
      onPrepareMutation: preparePeerMutation,
      onCommitMutation: commitPeerMutation,
      onCancelMutation: () => setPeerMutationPreview(null),
      onPrepareRole: preparePeerRole,
      onCommitRole: commitIdentityUpdate,
      onCancelRole: () => setIdentityPreview(null),
      onObserverMenuChange: setPeerObserverMenuOpen,
      onObserverChange: async (peerId) => {
        setPeerObserverMenuOpen(false);
        setPeerCardObserver(peerId);
        await refreshPeerCard(peerId);
      },
      onRefreshCard: () => selectedPeer
        ? loadPeerDetail(selectedPeer.id, peerCardObserver, peerSessions.page || 1, true)
        : Promise.resolve(),
    });
  }

  function renderMessages(): ComposeNode[] {
    const nodes: ComposeNode[] = [
      UI.Row({ fillMaxWidth: true, height: 48, verticalAlignment: "center", spacing: 6 }, [
        UI.IconButton({ icon: "arrow_back", enabled: !loading, onClick: closeSession }),
        UI.Column({ weight: 1, spacing: 1 }, [
          UI.Text({ text: "消息", style: "titleMedium", color: colors.onSurface, fontWeight: "bold" }),
          UI.Text({
            text: selectedSessionId,
            style: "labelSmall",
            color: colors.onSurfaceVariant,
            maxLines: 1,
            overflow: "ellipsis",
          }),
        ]),
        UI.Text({ text: String(messages.total), style: "labelMedium", color: colors.onSurfaceVariant }),
      ]),
    ];
    if (!messages.items.length) nodes.push(emptyState("消息"));
    for (const message of messages.items) {
      const details = [displayTime(message.created_at), `${message.token_count || 0} 个 token`].join("  ·  ");
      nodes.push(entityCard(message.peer_id || "未知参与者", [
        UI.Text({
          text: message.content || "",
          style: "bodyMedium",
          color: colors.onSurface,
          maxLines: 8,
          overflow: "ellipsis",
          softWrap: true,
        }),
        UI.Text({ text: details, style: "labelSmall", color: colors.onSurfaceVariant }),
        message.id
          ? UI.Text({
              text: message.id,
              style: "labelSmall",
              color: colors.onSurfaceVariant,
              maxLines: 1,
              overflow: "ellipsis",
            })
          : null,
      ].filter(Boolean) as ComposeNode[], `message-${message.id || message.created_at || nodes.length}`));
    }
    const pagination = pager(messages, (page) => loadMessages(selectedSessionId, page));
    if (pagination) nodes.push(pagination);
    return nodes;
  }

  function renderSessions(): ComposeNode[] {
    if (selectedSessionId) return renderMessages();
    const nodes: ComposeNode[] = [sectionTitle("会话", `${browsingWorkspace} 中共 ${sessions.total} 个`)];
    if (!sessions.items.length) nodes.push(emptyState("会话"));
    for (const session of sessions.items) {
      nodes.push(entityCard(session.id, [
        UI.Text({
          text: `${session.is_active === false ? "已停用" : "活跃"}  ·  ${displayTime(session.created_at)}`,
          style: "labelSmall",
          color: session.is_active === false ? colors.onSurfaceVariant : colors.primary,
        }),
        metadataLine(session.metadata),
      ].filter(Boolean) as ComposeNode[], `session-${session.id}`, () => openSession(session.id)));
    }
    const pagination = pager(sessions, (page) => load("sessions", browsingWorkspace, page));
    if (pagination) nodes.push(pagination);
    return nodes;
  }

  function renderConclusions(): ComposeNode[] {
    const activeIdentity = browsingWorkspace === status?.workspace;
    return renderConclusionWorkspace(ctx, {
      workspaceId: browsingWorkspace,
      activeWorkspace: status?.workspace || "",
      page: conclusions,
      peers: conclusionPeers.items,
      userPeerId: activeIdentity ? (identity?.user_peer || status?.user_peer || "") : "",
      aiPeerId: activeIdentity ? (identity?.ai_peer || status?.ai_peer || "") : "",
      draftFilters: conclusionDraftFilters,
      appliedFilters: conclusionFilters,
      observerMenuOpen: conclusionObserverMenuOpen,
      observedMenuOpen: conclusionObservedMenuOpen,
      levelMenuOpen: conclusionLevelMenuOpen,
      duplicateReport: conclusionDuplicateReport,
      selectedDuplicateGroupKey,
      keepConclusionId,
      cleanupPreview: conclusionCleanupPreview,
      confirmationText: conclusionConfirmationText,
      busy: conclusionBusy || loading,
      notice: conclusionNotice,
      error: conclusionError,
      onDraftFiltersChange: (filters) => {
        setConclusionDraftFilters(filters);
        setConclusionCleanupPreview(null);
        setConclusionConfirmationText("");
      },
      onObserverMenuChange: setConclusionObserverMenuOpen,
      onObservedMenuChange: setConclusionObservedMenuOpen,
      onLevelMenuChange: setConclusionLevelMenuOpen,
      onApplyFilters: applyConclusionFilters,
      onClearFilters: clearConclusionFilters,
      onPage: (page) => load("conclusions", browsingWorkspace, page, false, conclusionFilters),
      onScanDuplicates: scanConclusionDuplicates,
      onSelectDuplicateGroup: selectConclusionDuplicateGroup,
      onKeepConclusionChange: (id) => {
        setKeepConclusionId(id);
        setConclusionCleanupPreview(null);
        setConclusionConfirmationText("");
      },
      onPrepareCleanup: prepareConclusionCleanup,
      onCommitCleanup: commitConclusionCleanup,
      onCancelCleanup: () => {
        setConclusionCleanupPreview(null);
        setConclusionConfirmationText("");
      },
      onConfirmationTextChange: setConclusionConfirmationText,
    });
  }

  function refreshCurrent(): Promise<void> {
    if (tab === "peers" && selectedPeer) {
      return loadPeerDetail(selectedPeer.id, peerCardObserver, peerSessions.page || 1, true);
    }
    if (tab === "sessions" && selectedSessionId) {
      return loadMessages(selectedSessionId, messages.page || 1, true);
    }
    const page = tab === "peers"
      ? peers.page
      : tab === "sessions"
        ? sessions.page
        : tab === "conclusions"
          ? conclusions.page
          : 1;
    return load(tab, browsingWorkspace, page, true);
  }

  const selectedTabIndex = Math.max(0, TABS.findIndex((item) => item.id === tab));
  const items: ComposeNode[] = [
    UI.Row(
      {
        key: "app-bar",
        fillMaxWidth: true,
        height: 52,
        verticalAlignment: "center",
        horizontalArrangement: "spaceBetween",
      },
      [
        UI.Column({ weight: 1, spacing: 1 }, [
          UI.Text({ text: "Honcho 探索", style: "titleLarge", color: colors.onSurface, fontWeight: "bold" }),
          UI.Text({
            text: status ? (status.configured ? "已连接" : "需要配置") : "正在连接",
            style: "labelSmall",
            color: !status ? colors.onSurfaceVariant : status.configured ? colors.primary : colors.error,
          }),
        ]),
        UI.IconButton({
          icon: loading ? "hourglass_top" : "refresh",
          enabled: !loading,
          onClick: refreshCurrent,
        }),
      ]
    ),
    UI.Row({
      key: "workspace-bar",
      fillMaxWidth: true,
      height: 40,
      verticalAlignment: "center",
      spacing: 8,
    }, [
      UI.Icon({ name: "database", size: 18, tint: colors.primary }),
      UI.Text({
        text: browsingWorkspace || status?.workspace || "暂无工作区",
        style: "labelLarge",
        color: colors.onSurface,
        maxLines: 1,
        overflow: "ellipsis",
        weight: 1,
      }),
      browsingWorkspace && status?.workspace && browsingWorkspace !== status.workspace
        ? UI.Text({ text: "浏览中", style: "labelSmall", color: colors.tertiary })
        : null,
    ].filter(Boolean) as ComposeNode[]),
    UI.PrimaryScrollableTabRow({
      key: "tabs",
      selectedTabIndex,
      fillMaxWidth: true,
      edgePadding: 0,
      tabs: TABS.map((item) => UI.Tab(
        { selected: item.id === tab, onClick: () => switchTab(item.id), height: 44 },
        [UI.Text({ text: item.label, style: "labelLarge", color: item.id === tab ? colors.primary : colors.onSurfaceVariant })]
      )),
    }),
  ];

  if (partialNotice) {
    items.push(UI.Surface(
      { fillMaxWidth: true, padding: 10, shape: { type: "rounded", cornerRadius: 8 }, containerColor: colors.secondaryContainer },
      [UI.Text({ text: partialNotice, style: "bodySmall", color: colors.onSecondaryContainer, softWrap: true })]
    ));
  }

  if (error) {
    items.push(UI.Card(
      { fillMaxWidth: true, elevation: 0, shape: { type: "rounded", cornerRadius: 8 }, containerColor: colors.errorContainer },
      [UI.Column({ fillMaxWidth: true, padding: 14, spacing: 8 }, [
        UI.Text({ text: errorTitle(error.code), style: "titleSmall", color: colors.onErrorContainer, fontWeight: "bold" }),
        UI.Text({ text: clipText(error.message, 500), style: "bodySmall", color: colors.onErrorContainer, softWrap: true }),
        UI.Button({ text: "重试", enabled: !loading, onClick: refreshCurrent }),
      ])]
    ));
  }
  if (loading && !hasLoaded) {
    items.push(UI.Column(
      { fillMaxWidth: true, horizontalAlignment: "center", padding: 32, spacing: 8 },
      [UI.CircularProgressIndicator({}), UI.Text({ text: "正在加载 Honcho...", color: colors.onSurfaceVariant })]
    ));
  } else if (tab === "overview") {
    items.push(...renderOverview());
  } else if (tab === "peers") {
    items.push(...renderPeers());
  } else if (tab === "sessions") {
    items.push(...renderSessions());
  } else {
    items.push(...renderConclusions());
  }

  if (loading && hasLoaded) {
    items.push(UI.LinearProgressIndicator({ fillMaxWidth: true }));
  }

  return UI.LazyColumn(
    {
      fillMaxSize: true,
      spacing: 10,
      padding: { horizontal: 12, vertical: 8 },
      onLoad: async () => {
        if (hasLoaded || loadGuard.current) return;
        loadGuard.current = true;
        try {
          await load(tab, browsingWorkspace, 1);
        } finally {
          loadGuard.current = false;
        }
      },
    },
    items
  );
}