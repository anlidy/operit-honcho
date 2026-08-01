import type { ComposeDslContext, ComposeNode } from "../../../../types/compose-dsl";
import type {
  ExplorerPage,
  PeerCardDto,
  PeerDto,
  PeerMutationKind,
  PeerMutationPreviewDto,
  SessionDto,
  WorkspaceIdentityUpdatePreviewDto,
} from "../../explorer/types";
import { displayTime, pageLabel } from "./format.js";

export interface PeerWorkspaceProps {
  workspaceId: string;
  activeWorkspace: string;
  page: ExplorerPage<PeerDto>;
  selectedPeer: PeerDto | null;
  sessions: ExplorerPage<SessionDto>;
  card: PeerCardDto | null;
  observerPeerId: string;
  observerOptions: PeerDto[];
  observerMenuOpen: boolean;
  showArchived: boolean;
  createOpen: boolean;
  createPeerId: string;
  createDisplayName: string;
  editDisplayName: string;
  mutationPreview: PeerMutationPreviewDto | null;
  identityPreview: WorkspaceIdentityUpdatePreviewDto | null;
  busy: boolean;
  notice: string;
  error: string;
  cardError: string;
  onBack: () => void | Promise<void>;
  onOpenPeer: (peerId: string) => void | Promise<void>;
  onPage: (page: number) => void | Promise<void>;
  onSessionPage: (page: number) => void | Promise<void>;
  onShowArchivedChange: (value: boolean) => void;
  onCreateOpenChange: (value: boolean) => void;
  onCreatePeerIdChange: (value: string) => void;
  onCreateDisplayNameChange: (value: string) => void;
  onEditDisplayNameChange: (value: string) => void;
  onPrepareMutation: (
    mutation: PeerMutationKind,
    values?: { peerId?: string; displayName?: string; archived?: boolean; sessionId?: string }
  ) => void | Promise<void>;
  onCommitMutation: () => void | Promise<void>;
  onCancelMutation: () => void;
  onPrepareRole: (role: "user" | "ai", peerId: string) => void | Promise<void>;
  onCommitRole: () => void | Promise<void>;
  onCancelRole: () => void;
  onObserverMenuChange: (open: boolean) => void;
  onObserverChange: (peerId: string) => void | Promise<void>;
  onRefreshCard: () => void | Promise<void>;
}

function mutationLabel(value: PeerMutationKind): string {
  return {
    create: "创建参与者",
    update_display_name: "修改显示名",
    set_archived: "修改归档状态",
    remove_from_session: "移除会话成员",
  }[value];
}

function peerTitle(peer: PeerDto): string {
  return peer.display_name || peer.id;
}

function roleLabel(peer: PeerDto): string {
  const labels = peer.roles.map((role) => role === "user" ? "当前用户" : "当前 AI");
  return labels.length ? labels.join(" · ") : "未绑定角色";
}

export function renderPeerWorkspace(
  ctx: ComposeDslContext,
  props: PeerWorkspaceProps
): ComposeNode[] {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;
  const writable = props.workspaceId === props.activeWorkspace;

  function heading(title: string, subtitle = ""): ComposeNode {
    return UI.Column({ fillMaxWidth: true, spacing: 2, paddingTop: 4 }, [
      UI.Text({ text: title, style: "titleMedium", color: colors.onSurface, fontWeight: "bold" }),
      subtitle ? UI.Text({
        text: subtitle,
        style: "bodySmall",
        color: colors.onSurfaceVariant,
        maxLines: 2,
        overflow: "ellipsis",
        softWrap: true,
      }) : null,
    ].filter(Boolean) as ComposeNode[]);
  }

  function noticeSurface(text: string, isError = false): ComposeNode {
    return UI.Surface(
      {
        fillMaxWidth: true,
        padding: 10,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: isError ? colors.errorContainer : colors.secondaryContainer,
      },
      [UI.Text({
        text,
        style: "bodySmall",
        color: isError ? colors.onErrorContainer : colors.onSecondaryContainer,
        softWrap: true,
      })]
    );
  }

  function mutationConfirmation(): ComposeNode | null {
    const preview = props.mutationPreview;
    if (!preview) return null;
    const changes: string[] = [];
    if (preview.mutation === "create" || preview.mutation === "update_display_name") {
      changes.push(`显示名：${preview.previous_display_name || "未设置"} → ${preview.proposed_display_name || "未设置"}`);
    }
    if (preview.mutation === "set_archived") {
      changes.push(`状态：${preview.previous_archived ? "已归档" : "正常"} → ${preview.proposed_archived ? "已归档" : "正常"}`);
    }
    if (preview.session_id) changes.push(`会话：${preview.session_id}`);
    return UI.Surface(
      {
        fillMaxWidth: true,
        padding: 12,
        spacing: 8,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.tertiaryContainer,
      },
      [UI.Column({ fillMaxWidth: true, spacing: 7 }, [
        UI.Text({ text: `确认${mutationLabel(preview.mutation)}`, style: "titleSmall", color: colors.onTertiaryContainer, fontWeight: "bold" }),
        UI.Text({ text: `工作区：${preview.workspace_id}`, style: "bodySmall", color: colors.onTertiaryContainer, softWrap: true }),
        UI.Text({ text: `参与者 ID：${preview.peer_id}`, style: "bodySmall", color: colors.onTertiaryContainer, softWrap: true }),
        ...changes.map((text, index) => UI.Text({ key: `peer-change-${index}`, text, style: "bodySmall", color: colors.onTertiaryContainer, softWrap: true })),
        UI.Text({ text: preview.impact, style: "bodySmall", color: colors.onTertiaryContainer, softWrap: true }),
        UI.Row({ fillMaxWidth: true, spacing: 8, horizontalArrangement: "end" }, [
          UI.OutlinedButton({ enabled: !props.busy, onClick: props.onCancelMutation }, [
            UI.Text({ text: "取消", style: "labelLarge", color: colors.primary }),
          ]),
          UI.Button({ text: "确认执行", enabled: !props.busy, onClick: props.onCommitMutation }),
        ]),
      ])]
    );
  }

  function identityConfirmation(): ComposeNode | null {
    const preview = props.identityPreview;
    if (!preview || !props.selectedPeer) return null;
    return UI.Surface(
      {
        fillMaxWidth: true,
        padding: 12,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.secondaryContainer,
      },
      [UI.Column({ fillMaxWidth: true, spacing: 7 }, [
        UI.Text({ text: "确认角色变更", style: "titleSmall", color: colors.onSecondaryContainer, fontWeight: "bold" }),
        UI.Text({ text: `工作区：${preview.workspace_id}`, style: "bodySmall", color: colors.onSecondaryContainer }),
        UI.Text({ text: `用户：${preview.previous_user_peer} → ${preview.proposed_user_peer}`, style: "bodySmall", color: colors.onSecondaryContainer, softWrap: true }),
        UI.Text({ text: `AI：${preview.previous_ai_peer} → ${preview.proposed_ai_peer}`, style: "bodySmall", color: colors.onSecondaryContainer, softWrap: true }),
        UI.Text({ text: `revision ${preview.previous_revision} → ${preview.proposed_revision}。只影响之后的新消息与工具调用。`, style: "bodySmall", color: colors.onSecondaryContainer, softWrap: true }),
        UI.Row({ fillMaxWidth: true, spacing: 8, horizontalArrangement: "end" }, [
          UI.OutlinedButton({ enabled: !props.busy, onClick: props.onCancelRole }, [
            UI.Text({ text: "取消", style: "labelLarge", color: colors.primary }),
          ]),
          UI.Button({ text: "确认改绑", enabled: !props.busy, onClick: props.onCommitRole }),
        ]),
      ])]
    );
  }

  if (!props.selectedPeer) {
    const visiblePeers = props.showArchived
      ? props.page.items
      : props.page.items.filter((peer) => !peer.archived);
    const hiddenOnPage = props.page.items.length - visiblePeers.length;
    const nodes: ComposeNode[] = [
      heading("参与者", `${props.workspaceId} 中共 ${props.page.total} 个`),
      UI.Row({ fillMaxWidth: true, height: 44, verticalAlignment: "center", spacing: 8 }, [
        UI.Row({ weight: 1, verticalAlignment: "center", spacing: 6 }, [
          UI.Switch({ checked: props.showArchived, onCheckedChange: props.onShowArchivedChange }),
          UI.Text({ text: "显示已归档", style: "labelMedium", color: colors.onSurfaceVariant }),
        ]),
        writable
          ? UI.OutlinedButton({
              enabled: !props.busy,
              onClick: () => props.onCreateOpenChange(!props.createOpen),
            }, [UI.Text({
              text: props.createOpen ? "收起" : "新建参与者",
              style: "labelLarge",
              color: colors.primary,
            })])
          : UI.Text({ text: "只读", style: "labelMedium", color: colors.tertiary }),
      ]),
    ];

    if (props.createOpen && writable) {
      nodes.push(UI.Surface(
        {
          fillMaxWidth: true,
          padding: 12,
          shape: { type: "rounded", cornerRadius: 8 },
          containerColor: colors.surfaceVariant,
        },
        [UI.Column({ fillMaxWidth: true, spacing: 8 }, [
          UI.Text({ text: "创建参与者", style: "titleSmall", color: colors.onSurface, fontWeight: "bold" }),
          UI.TextField({
            value: props.createPeerId,
            onValueChange: props.onCreatePeerIdChange,
            label: "参与者 ID",
            supportingText: UI.Text({
              text: "创建后不可重命名；仅支持字母、数字、下划线和连字符。",
              style: "bodySmall",
              color: colors.onSurfaceVariant,
            }),
            singleLine: true,
            fillMaxWidth: true,
          }),
          UI.TextField({
            value: props.createDisplayName,
            onValueChange: props.onCreateDisplayNameChange,
            label: "显示名（可选）",
            singleLine: true,
            fillMaxWidth: true,
          }),
          UI.Button({
            text: "预览创建",
            enabled: !props.busy && Boolean(props.createPeerId.trim()),
            onClick: () => props.onPrepareMutation("create", {
              peerId: props.createPeerId,
              displayName: props.createDisplayName,
            }),
          }),
        ])]
      ));
    }
    if (props.notice) nodes.push(noticeSurface(props.notice));
    if (props.error) nodes.push(noticeSurface(props.error, true));
    const confirmation = mutationConfirmation();
    if (confirmation) nodes.push(confirmation);
    if (!visiblePeers.length) {
      nodes.push(UI.Column({ fillMaxWidth: true, horizontalAlignment: "center", padding: 24, spacing: 5 }, [
        UI.Icon({ name: "group", size: 28, tint: colors.onSurfaceVariant }),
        UI.Text({ text: hiddenOnPage ? "当前页参与者均已归档" : "暂无参与者", style: "bodyMedium", color: colors.onSurfaceVariant }),
      ]));
    }
    for (const peer of visiblePeers) {
      nodes.push(UI.Card(
        {
          key: `peer-${peer.id}`,
          fillMaxWidth: true,
          elevation: 0,
          shape: { type: "rounded", cornerRadius: 8 },
          containerColor: colors.surfaceVariant,
        },
        [UI.Row({ fillMaxWidth: true, padding: 12, spacing: 10, verticalAlignment: "center", onClick: () => props.onOpenPeer(peer.id) }, [
          UI.Icon({ name: peer.archived ? "inventory_2" : "person", size: 22, tint: peer.archived ? colors.onSurfaceVariant : colors.primary }),
          UI.Column({ weight: 1, spacing: 3 }, [
            UI.Text({ text: peerTitle(peer), style: "titleSmall", color: colors.onSurface, fontWeight: "bold", maxLines: 2, overflow: "ellipsis", softWrap: true }),
            peer.display_name ? UI.Text({ text: peer.id, style: "labelSmall", color: colors.onSurfaceVariant, maxLines: 1, overflow: "ellipsis" }) : null,
            UI.Text({ text: `${roleLabel(peer)} · ${peer.archived ? "已归档" : "正常"} · ${displayTime(peer.created_at)}`, style: "bodySmall", color: colors.onSurfaceVariant, maxLines: 2, overflow: "ellipsis", softWrap: true }),
          ].filter(Boolean) as ComposeNode[]),
          UI.Icon({ name: "chevron_right", size: 20, tint: colors.onSurfaceVariant }),
        ])]
      ));
    }
    if (props.page.pages > 1) {
      nodes.push(UI.Row({ fillMaxWidth: true, height: 48, horizontalArrangement: "spaceBetween", verticalAlignment: "center" }, [
        UI.IconButton({ icon: "chevron_left", enabled: !props.busy && props.page.page > 1, onClick: () => props.onPage(props.page.page - 1) }),
        UI.Text({ text: pageLabel(props.page.page, props.page.pages, props.page.total), style: "labelMedium", color: colors.onSurfaceVariant }),
        UI.IconButton({ icon: "chevron_right", enabled: !props.busy && props.page.page < props.page.pages, onClick: () => props.onPage(props.page.page + 1) }),
      ]));
    }
    return nodes;
  }

  const peer = props.selectedPeer;
  const nodes: ComposeNode[] = [
    UI.Row({ fillMaxWidth: true, height: 48, verticalAlignment: "center", spacing: 6 }, [
      UI.IconButton({ icon: "arrow_back", enabled: !props.busy, onClick: props.onBack }),
      UI.Column({ weight: 1, spacing: 1 }, [
        UI.Text({ text: peerTitle(peer), style: "titleMedium", color: colors.onSurface, fontWeight: "bold", maxLines: 1, overflow: "ellipsis" }),
        UI.Text({ text: peer.id, style: "labelSmall", color: colors.onSurfaceVariant, maxLines: 1, overflow: "ellipsis" }),
      ]),
      UI.IconButton({ icon: "refresh", enabled: !props.busy, onClick: props.onRefreshCard }),
    ]),
    UI.Row({ fillMaxWidth: true, spacing: 8 }, [
      UI.Surface({ weight: 1, padding: 10, shape: { type: "rounded", cornerRadius: 8 }, containerColor: colors.secondaryContainer }, [
        UI.Column({ spacing: 2 }, [
          UI.Text({ text: roleLabel(peer), style: "labelLarge", color: colors.onSecondaryContainer, maxLines: 2, overflow: "ellipsis" }),
          UI.Text({ text: peer.archived ? "已归档" : "正常", style: "labelSmall", color: colors.onSecondaryContainer }),
        ]),
      ]),
      UI.Surface({ weight: 1, padding: 10, shape: { type: "rounded", cornerRadius: 8 }, containerColor: colors.tertiaryContainer }, [
        UI.Column({ spacing: 2 }, [
          UI.Text({ text: String(props.sessions.total), style: "titleMedium", color: colors.onTertiaryContainer }),
          UI.Text({ text: "关联会话", style: "labelSmall", color: colors.onTertiaryContainer }),
        ]),
      ]),
    ]),
  ];

  if (!writable) nodes.push(noticeSurface("当前正在浏览非活跃工作区，参与者管理保持只读。"));
  if (props.notice) nodes.push(noticeSurface(props.notice));
  if (props.error) nodes.push(noticeSurface(props.error, true));
  const roleConfirmation = identityConfirmation();
  if (roleConfirmation) nodes.push(roleConfirmation);
  const peerConfirmation = mutationConfirmation();
  if (peerConfirmation) nodes.push(peerConfirmation);

  nodes.push(heading("参与者资料", `创建于 ${displayTime(peer.created_at)}`));
  nodes.push(UI.TextField({
    value: props.editDisplayName,
    onValueChange: props.onEditDisplayNameChange,
    label: "显示名",
    readOnly: !writable,
    singleLine: true,
    fillMaxWidth: true,
  }));
  if (writable) {
    nodes.push(UI.Row({ fillMaxWidth: true, spacing: 8 }, [
      UI.Button({
        text: "预览改名",
        enabled: !props.busy && props.editDisplayName.trim() !== peer.display_name,
        onClick: () => props.onPrepareMutation("update_display_name", { displayName: props.editDisplayName }),
      }),
      UI.OutlinedButton({
        enabled: !props.busy && (peer.archived || peer.roles.length === 0),
        onClick: () => props.onPrepareMutation("set_archived", { archived: !peer.archived }),
      }, [UI.Text({ text: peer.archived ? "恢复" : "归档", style: "labelLarge", color: colors.primary })]),
    ]));
    nodes.push(UI.Row({ fillMaxWidth: true, spacing: 8 }, [
      UI.OutlinedButton({ enabled: !props.busy && !peer.roles.includes("user"), onClick: () => props.onPrepareRole("user", peer.id) }, [
        UI.Text({ text: "设为用户", style: "labelLarge", color: colors.primary }),
      ]),
      UI.OutlinedButton({ enabled: !props.busy && !peer.roles.includes("ai"), onClick: () => props.onPrepareRole("ai", peer.id) }, [
        UI.Text({ text: "设为 AI", style: "labelLarge", color: colors.primary }),
      ]),
    ]));
    if (!peer.archived && peer.roles.length) {
      nodes.push(UI.Text({ text: "活跃角色必须先改绑到其他参与者，之后才能归档。", style: "bodySmall", color: colors.onSurfaceVariant, softWrap: true }));
    }
  }

  nodes.push(heading("Peer Card", "Card 具有观察方向，不是参与者的全局字段。"));
  nodes.push(UI.Row({ fillMaxWidth: true, spacing: 8, verticalAlignment: "center" }, [
    UI.Column({ weight: 1, spacing: 4 }, [
      UI.OutlinedButton({
        enabled: !props.busy,
        fillMaxWidth: true,
        onClick: () => props.onObserverMenuChange(!props.observerMenuOpen),
      }, [UI.Text({
        text: `观察者：${props.observerPeerId || "请选择"}`,
        style: "labelLarge",
        color: colors.primary,
        maxLines: 1,
        overflow: "ellipsis",
      })]),
      UI.DropdownMenu(
        { expanded: props.observerMenuOpen, onDismissRequest: () => props.onObserverMenuChange(false) },
        props.observerOptions.map((option) => UI.Surface(
          {
            key: `observer-${option.id}`,
            fillMaxWidth: true,
            padding: 10,
            containerColor: option.id === props.observerPeerId ? colors.primaryContainer : colors.surface,
            onClick: () => props.onObserverChange(option.id),
          },
          [UI.Text({
            text: option.display_name ? `${option.display_name} (${option.id})` : option.id,
            style: "bodyMedium",
            color: option.id === props.observerPeerId ? colors.onPrimaryContainer : colors.onSurface,
            maxLines: 1,
            overflow: "ellipsis",
          })]
        ))
      ),
    ]),
  ]));
  nodes.push(UI.Text({ text: `目标：${peer.id}`, style: "bodySmall", color: colors.onSurfaceVariant, maxLines: 2, overflow: "ellipsis", softWrap: true }));
  if (props.cardError) nodes.push(noticeSurface(props.cardError, true));
  if (!props.card || !props.card.peer_card.length) {
    nodes.push(UI.Column({ fillMaxWidth: true, horizontalAlignment: "center", padding: 18, spacing: 4 }, [
      UI.Icon({ name: "badge", size: 26, tint: colors.onSurfaceVariant }),
      UI.Text({ text: "该方向暂无 Card 条目", style: "bodyMedium", color: colors.onSurfaceVariant }),
    ]));
  } else {
    for (let index = 0; index < props.card.peer_card.length; index += 1) {
      nodes.push(UI.Surface(
        { key: `peer-card-${index}`, fillMaxWidth: true, padding: 10, shape: { type: "rounded", cornerRadius: 6 }, containerColor: colors.surfaceVariant },
        [UI.Text({ text: props.card.peer_card[index], style: "bodyMedium", color: colors.onSurface, softWrap: true })]
      ));
    }
  }

  nodes.push(heading("关联会话", "移除只改变成员关系，不删除参与者、消息、Card 或结论。"));
  if (!props.sessions.items.length) {
    nodes.push(UI.Text({ text: "暂无关联会话", style: "bodyMedium", color: colors.onSurfaceVariant }));
  }
  for (const session of props.sessions.items) {
    nodes.push(UI.Card(
      { key: `peer-session-${session.id}`, fillMaxWidth: true, elevation: 0, shape: { type: "rounded", cornerRadius: 8 }, containerColor: colors.surfaceVariant },
      [UI.Row({ fillMaxWidth: true, padding: 10, spacing: 8, verticalAlignment: "center" }, [
        UI.Column({ weight: 1, spacing: 2 }, [
          UI.Text({ text: session.id, style: "bodyMedium", color: colors.onSurface, maxLines: 2, overflow: "ellipsis", softWrap: true }),
          UI.Text({ text: `${session.is_active === false ? "已停用" : "活跃"} · ${displayTime(session.created_at)}`, style: "labelSmall", color: colors.onSurfaceVariant }),
        ]),
        writable ? UI.IconButton({
          enabled: !props.busy,
          onClick: () => props.onPrepareMutation("remove_from_session", { sessionId: session.id }),
          content: [UI.Icon({ name: "person_remove", size: 20, tint: colors.error, contentDescription: "从会话移除" })],
        }) : null,
      ].filter(Boolean) as ComposeNode[])]
    ));
  }
  if (props.sessions.pages > 1) {
    nodes.push(UI.Row({ fillMaxWidth: true, height: 48, horizontalArrangement: "spaceBetween", verticalAlignment: "center" }, [
      UI.IconButton({ icon: "chevron_left", enabled: !props.busy && props.sessions.page > 1, onClick: () => props.onSessionPage(props.sessions.page - 1) }),
      UI.Text({ text: pageLabel(props.sessions.page, props.sessions.pages, props.sessions.total), style: "labelMedium", color: colors.onSurfaceVariant }),
      UI.IconButton({ icon: "chevron_right", enabled: !props.busy && props.sessions.page < props.sessions.pages, onClick: () => props.onSessionPage(props.sessions.page + 1) }),
    ]));
  }
  return nodes;
}