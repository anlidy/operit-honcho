import type { ComposeColor, ComposeDslContext, ComposeNode } from "../../../../types/compose-dsl";
import type {
  ConclusionDto,
  ExplorerError,
  ExplorerOperation,
  ExplorerPage,
  ExplorerResponse,
  ExplorerStatusDto,
  MessageDto,
  PeerDto,
  SessionDto,
  WorkspaceDto,
} from "../../explorer/types";
import { clipText, compactJson, displayTime, pageLabel } from "./format";

type ExplorerTab = "overview" | "peers" | "sessions" | "conclusions";

const TABS: Array<{ id: ExplorerTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "peers", label: "Peers" },
  { id: "sessions", label: "Sessions" },
  { id: "conclusions", label: "Conclusions" },
];

function emptyPage<T>(size = 20): ExplorerPage<T> {
  return { items: [], total: 0, page: 1, size, pages: 0 };
}

function uiError(error: unknown): ExplorerError {
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
    message: error instanceof Error ? error.message : String(error || "Unknown Explorer error"),
    retryable: true,
  };
}

export default function honchoExploreScreen(ctx: ComposeDslContext): ComposeNode {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;
  const [tab, setTab] = ctx.useState<ExplorerTab>("tab", "overview");
  const [status, setStatus] = ctx.useState<ExplorerStatusDto | null>("status", null);
  const [browsingWorkspace, setBrowsingWorkspace] = ctx.useState("browsingWorkspace", "");
  const [workspaces, setWorkspaces] = ctx.useState<ExplorerPage<WorkspaceDto>>(
    "workspaces",
    emptyPage<WorkspaceDto>()
  );
  const [peers, setPeers] = ctx.useState<ExplorerPage<PeerDto>>("peers", emptyPage<PeerDto>());
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
    params?: { page?: number; size?: number; reverse?: boolean; sessionId?: string }
  ): Promise<T> {
    requestSequence.current += 1;
    const requestId = `explore-${Date.now()}-${requestSequence.current}`;
    const response = await ToolPkg.ipc.call<unknown, ExplorerResponse<T>>(
      "honcho.explorer.request",
      { op, requestId, workspaceId, params },
      { targetRuntime: "main" }
    );
    if (!response || response.requestId !== requestId) {
      throw { code: "STALE_RESPONSE", message: "Explorer returned an invalid response.", retryable: true };
    }
    if (!response.ok) throw response.error || { code: "EXPLORER_ERROR", message: "Explorer request failed." };
    return response.data as T;
  }

  async function load(targetTab: ExplorerTab, workspace = "", page = 1): Promise<void> {
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
        setHasLoaded(true);
        return;
      }

      if (targetTab === "overview") {
        const results = await Promise.allSettled([
          remote<ExplorerPage<WorkspaceDto>>("list_workspaces", undefined, { page: 1, size: 20 }),
          remote<ExplorerPage<PeerDto>>("list_peers", targetWorkspace, { page: 1, size: 5, reverse: true }),
          remote<ExplorerPage<SessionDto>>("list_sessions", targetWorkspace, {
            page: 1,
            size: 5,
            reverse: true,
          }),
        ]);
        if (version !== loadVersion.current) return;
        if (results[0].status === "fulfilled") setWorkspaces(results[0].value);
        if (results[1].status === "fulfilled") setPeers(results[1].value);
        if (results[2].status === "fulfilled") setSessions(results[2].value);
        const failures = results
          .filter((result) => result.status === "rejected")
          .map((result) => uiError((result as PromiseRejectedResult).reason));
        if (failures.length) {
          setPartialNotice(failures.some((item) => item.code === "PERMISSION_DENIED")
            ? "Some data is hidden by the current API key scope."
            : "Some overview data could not be loaded.");
        }
      } else if (targetTab === "peers") {
        setPeers(await remote("list_peers", targetWorkspace, { page, size: 20, reverse: true }));
      } else if (targetTab === "sessions") {
        setSessions(await remote("list_sessions", targetWorkspace, { page, size: 20, reverse: true }));
      } else {
        setConclusions(await remote("list_conclusions", targetWorkspace, {
          page,
          size: 20,
          reverse: false,
        }));
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

  async function loadMessages(sessionId: string, page = 1): Promise<void> {
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
        { page, size: 30, reverse: false, sessionId }
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
    return load(nextTab, browsingWorkspace, 1);
  }

  function selectWorkspace(workspaceId: string): Promise<void> {
    setSelectedSessionId("");
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
        UI.Text({ text: `No ${label}`, style: "bodyMedium", color: colors.onSurfaceVariant }),
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
              UI.Text({ text: "Honcho is not configured", style: "titleMedium", color: colors.onErrorContainer }),
              UI.Text({
                text: "Set HONCHO_API_KEY and HONCHO_WORKSPACE, or configure HONCHO_BASE_URL for self-hosting.",
                style: "bodySmall",
                color: colors.onErrorContainer,
                softWrap: true,
              }),
            ]),
          ]
        ),
      ];
    }

    const queue = status.server_queue;
    const nodes: ComposeNode[] = [
      sectionTitle("Runtime", "Connection, active peers, and write pipeline"),
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
            UI.Text({ text: "Local pending", style: "labelSmall", color: colors.onSecondaryContainer }),
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
            UI.Text({ text: "Server pending", style: "labelSmall", color: colors.onTertiaryContainer }),
          ])]
        ),
      ]),
      UI.Text({
        text: `${status.user_peer} → ${status.ai_peer}  ·  ${status.recall_mode}  ·  ${status.session_strategy}`,
        style: "bodySmall",
        color: colors.onSurfaceVariant,
        maxLines: 2,
        overflow: "ellipsis",
      }),
      sectionTitle("Workspaces", `${workspaces.total} visible to this API key`),
    ];

    if (!workspaces.items.length) {
      nodes.push(emptyState("workspaces"));
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
                      text: workspace.id === status.workspace ? "Active workspace" : displayTime(workspace.created_at),
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

    nodes.push(sectionTitle("Recent peers", `${peers.total} total`));
    for (const peer of peers.items) {
      nodes.push(entityCard(peer.id, [
        UI.Text({ text: displayTime(peer.created_at), style: "labelSmall", color: colors.onSurfaceVariant }),
      ], `overview-peer-${peer.id}`));
    }
    if (!peers.items.length) nodes.push(emptyState("peers"));

    nodes.push(sectionTitle("Recent sessions", `${sessions.total} total`));
    for (const session of sessions.items) {
      nodes.push(entityCard(session.id, [
        UI.Text({
          text: `${session.is_active === false ? "Inactive" : "Active"}  ·  ${displayTime(session.created_at)}`,
          style: "labelSmall",
          color: colors.onSurfaceVariant,
        }),
      ], `overview-session-${session.id}`, () => openSession(session.id)));
    }
    if (!sessions.items.length) nodes.push(emptyState("sessions"));
    return nodes;
  }

  function renderPeers(): ComposeNode[] {
    const nodes: ComposeNode[] = [sectionTitle("Peers", `${peers.total} in ${browsingWorkspace}`)];
    if (!peers.items.length) nodes.push(emptyState("peers"));
    for (const peer of peers.items) {
      nodes.push(entityCard(peer.id, [
        UI.Text({ text: displayTime(peer.created_at), style: "labelSmall", color: colors.onSurfaceVariant }),
        metadataLine(peer.metadata),
      ].filter(Boolean) as ComposeNode[], `peer-${peer.id}`));
    }
    const pagination = pager(peers, (page) => load("peers", browsingWorkspace, page));
    if (pagination) nodes.push(pagination);
    return nodes;
  }

  function renderMessages(): ComposeNode[] {
    const nodes: ComposeNode[] = [
      UI.Row({ fillMaxWidth: true, height: 48, verticalAlignment: "center", spacing: 6 }, [
        UI.IconButton({ icon: "arrow_back", enabled: !loading, onClick: closeSession }),
        UI.Column({ weight: 1, spacing: 1 }, [
          UI.Text({ text: "Messages", style: "titleMedium", color: colors.onSurface, fontWeight: "bold" }),
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
    if (!messages.items.length) nodes.push(emptyState("messages"));
    for (const message of messages.items) {
      const details = [displayTime(message.created_at), `${message.token_count || 0} tokens`].join("  ·  ");
      nodes.push(entityCard(message.peer_id || "Unknown peer", [
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
    const nodes: ComposeNode[] = [sectionTitle("Sessions", `${sessions.total} in ${browsingWorkspace}`)];
    if (!sessions.items.length) nodes.push(emptyState("sessions"));
    for (const session of sessions.items) {
      nodes.push(entityCard(session.id, [
        UI.Text({
          text: `${session.is_active === false ? "Inactive" : "Active"}  ·  ${displayTime(session.created_at)}`,
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
    const nodes: ComposeNode[] = [sectionTitle("Conclusions", `${conclusions.total} in ${browsingWorkspace}`)];
    if (!conclusions.items.length) nodes.push(emptyState("conclusions"));
    for (const conclusion of conclusions.items) {
      const scope = [conclusion.observer_id, conclusion.observed_id]
        .filter(Boolean)
        .join(" → ");
      nodes.push(entityCard(clipText(conclusion.content, 220), [
        UI.Text({
          text: `${conclusion.level || "explicit"}${scope ? `  ·  ${scope}` : ""}`,
          style: "bodySmall",
          color: colors.onSurfaceVariant,
          maxLines: 2,
          overflow: "ellipsis",
        }),
        UI.Text({ text: displayTime(conclusion.created_at), style: "labelSmall", color: colors.onSurfaceVariant }),
      ], `conclusion-${conclusion.id}`));
    }
    const pagination = pager(conclusions, (page) => load("conclusions", browsingWorkspace, page));
    if (pagination) nodes.push(pagination);
    return nodes;
  }

  function refreshCurrent(): Promise<void> {
    if (tab === "sessions" && selectedSessionId) {
      return loadMessages(selectedSessionId, messages.page || 1);
    }
    const page = tab === "peers"
      ? peers.page
      : tab === "sessions"
        ? sessions.page
        : tab === "conclusions"
          ? conclusions.page
          : 1;
    return load(tab, browsingWorkspace, page);
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
          UI.Text({ text: "Honcho Explore", style: "titleLarge", color: colors.onSurface, fontWeight: "bold" }),
          UI.Text({
            text: status?.configured ? "Connected" : "Configuration required",
            style: "labelSmall",
            color: status?.configured ? colors.primary : colors.error,
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
        text: browsingWorkspace || status?.workspace || "No workspace",
        style: "labelLarge",
        color: colors.onSurface,
        maxLines: 1,
        overflow: "ellipsis",
        weight: 1,
      }),
      browsingWorkspace && status?.workspace && browsingWorkspace !== status.workspace
        ? UI.Text({ text: "Browsing", style: "labelSmall", color: colors.tertiary })
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
        UI.Text({ text: error.code.replace(/_/g, " "), style: "titleSmall", color: colors.onErrorContainer, fontWeight: "bold" }),
        UI.Text({ text: clipText(error.message, 500), style: "bodySmall", color: colors.onErrorContainer, softWrap: true }),
        UI.Button({ text: "Retry", enabled: !loading, onClick: refreshCurrent }),
      ])]
    ));
  } else if (loading && !hasLoaded) {
    items.push(UI.Column(
      { fillMaxWidth: true, horizontalAlignment: "center", padding: 32, spacing: 8 },
      [UI.CircularProgressIndicator({}), UI.Text({ text: "Loading Honcho...", color: colors.onSurfaceVariant })]
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