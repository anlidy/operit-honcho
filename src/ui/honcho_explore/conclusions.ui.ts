import type { ComposeDslContext, ComposeNode } from "../../../../types/compose-dsl";
import type {
  ConclusionCleanupPreviewDto,
  ConclusionDuplicateGroupDto,
  ConclusionDuplicateReportDto,
  ConclusionFiltersDto,
  ConclusionLevel,
  ConclusionDto,
  ExplorerPage,
  PeerDto,
} from "../../explorer/types";
import { clipText, displayTime, pageLabel } from "./format.js";

export interface ConclusionWorkspaceProps {
  workspaceId: string;
  activeWorkspace: string;
  page: ExplorerPage<ConclusionDto>;
  peers: PeerDto[];
  userPeerId: string;
  aiPeerId: string;
  draftFilters: ConclusionFiltersDto;
  appliedFilters: ConclusionFiltersDto;
  observerMenuOpen: boolean;
  observedMenuOpen: boolean;
  levelMenuOpen: boolean;
  duplicateReport: ConclusionDuplicateReportDto | null;
  selectedDuplicateGroupKey: string;
  keepConclusionId: string;
  cleanupPreview: ConclusionCleanupPreviewDto | null;
  confirmationText: string;
  busy: boolean;
  notice: string;
  error: string;
  onDraftFiltersChange: (filters: ConclusionFiltersDto) => void;
  onObserverMenuChange: (open: boolean) => void;
  onObservedMenuChange: (open: boolean) => void;
  onLevelMenuChange: (open: boolean) => void;
  onApplyFilters: () => void | Promise<void>;
  onClearFilters: () => void | Promise<void>;
  onPage: (page: number) => void | Promise<void>;
  onScanDuplicates: () => void | Promise<void>;
  onSelectDuplicateGroup: (group: ConclusionDuplicateGroupDto) => void;
  onKeepConclusionChange: (id: string) => void;
  onPrepareCleanup: (group: ConclusionDuplicateGroupDto) => void | Promise<void>;
  onCommitCleanup: () => void | Promise<void>;
  onCancelCleanup: () => void;
  onConfirmationTextChange: (value: string) => void;
}

const LEVELS: Array<{ value: ConclusionLevel | ""; label: string }> = [
  { value: "", label: "全部级别" },
  { value: "explicit", label: "明确结论" },
  { value: "deductive", label: "演绎结论" },
  { value: "inductive", label: "归纳结论" },
  { value: "contradiction", label: "矛盾结论" },
];

function levelLabel(value: ConclusionLevel | undefined): string {
  return LEVELS.find((item) => item.value === (value || ""))?.label || "结论";
}

function peerLabel(peerId: string | undefined, peers: PeerDto[]): string {
  if (!peerId) return "任意参与者";
  const peer = peers.find((item) => item.id === peerId);
  return peer?.display_name ? peer.display_name + " (" + peerId + ")" : peerId;
}

function directionLabel(value: ConclusionDto | ConclusionDuplicateGroupDto): string {
  const observer = value.observer_display_name || value.observer_id || "未知观察者";
  const observed = value.observed_display_name || value.observed_id || "未知对象";
  return observer + " → " + observed;
}

function directionIds(value: ConclusionDto | ConclusionDuplicateGroupDto): string {
  const observer = value.observer_id || "未知";
  const observed = value.observed_id || "未知";
  return observer + " → " + observed;
}

export function renderConclusionWorkspace(
  ctx: ComposeDslContext,
  props: ConclusionWorkspaceProps
): ComposeNode[] {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;
  const writable = props.workspaceId === props.activeWorkspace;
  const selectedGroup = props.duplicateReport?.groups.find(
    (group) => group.group_key === props.selectedDuplicateGroupKey
  ) || null;

  function noticeSurface(text: string, isError = false): ComposeNode {
    return UI.Surface({
      fillMaxWidth: true,
      padding: 10,
      shape: { type: "rounded", cornerRadius: 8 },
      containerColor: isError ? colors.errorContainer : colors.secondaryContainer,
    }, [UI.Text({
      text,
      style: "bodySmall",
      color: isError ? colors.onErrorContainer : colors.onSecondaryContainer,
      softWrap: true,
    })]);
  }

  function peerMenu(
    expanded: boolean,
    selectedId: string | undefined,
    onDismiss: () => void,
    onSelect: (id: string) => void
  ): ComposeNode {
    const options: Array<PeerDto | null> = [null, ...props.peers];
    return UI.DropdownMenu({ expanded, onDismissRequest: onDismiss }, options.map((peer, index) => {
      const id = peer?.id || "";
      return UI.Surface({
        key: "conclusion-peer-option-" + (id || index),
        fillMaxWidth: true,
        padding: 10,
        containerColor: id === (selectedId || "") ? colors.primaryContainer : colors.surface,
        onClick: () => onSelect(id),
      }, [UI.Text({
        text: peer ? peerLabel(peer.id, props.peers) : "任意参与者",
        style: "bodyMedium",
        color: id === (selectedId || "") ? colors.onPrimaryContainer : colors.onSurface,
        maxLines: 1,
        overflow: "ellipsis",
      })]);
    }));
  }

  const nodes: ComposeNode[] = [
    UI.Column({ fillMaxWidth: true, spacing: 2, paddingTop: 4 }, [
      UI.Text({ text: "结论", style: "titleMedium", color: colors.onSurface, fontWeight: "bold" }),
      UI.Text({
        text: props.workspaceId + " 中共 " + props.page.total + " 条",
        style: "bodySmall",
        color: colors.onSurfaceVariant,
      }),
    ]),
    UI.Surface({
      fillMaxWidth: true,
      padding: 10,
      shape: { type: "rounded", cornerRadius: 8 },
      containerColor: colors.surfaceVariant,
    }, [UI.Column({ fillMaxWidth: true, spacing: 8 }, [
      UI.TextField({
        value: props.draftFilters.query || "",
        onValueChange: (value) => props.onDraftFiltersChange({ ...props.draftFilters, query: value }),
        label: "语义搜索",
        singleLine: true,
        fillMaxWidth: true,
      }),
      UI.Row({ fillMaxWidth: true, spacing: 5 }, [
        UI.FilterChip({
          selected: !props.draftFilters.observer_id && !props.draftFilters.observed_id,
          onClick: () => props.onDraftFiltersChange({
            ...props.draftFilters,
            observer_id: undefined,
            observed_id: undefined,
          }),
          label: UI.Text({ text: "任意", style: "labelSmall" }),
        }),
        UI.FilterChip({
          selected: props.draftFilters.observer_id === props.aiPeerId
            && props.draftFilters.observed_id === props.userPeerId,
          enabled: Boolean(props.aiPeerId && props.userPeerId),
          onClick: () => props.onDraftFiltersChange({
            ...props.draftFilters,
            observer_id: props.aiPeerId,
            observed_id: props.userPeerId,
          }),
          label: UI.Text({ text: "AI → 用户", style: "labelSmall" }),
        }),
        UI.FilterChip({
          selected: props.draftFilters.observer_id === props.userPeerId
            && props.draftFilters.observed_id === props.aiPeerId,
          enabled: Boolean(props.aiPeerId && props.userPeerId),
          onClick: () => props.onDraftFiltersChange({
            ...props.draftFilters,
            observer_id: props.userPeerId,
            observed_id: props.aiPeerId,
          }),
          label: UI.Text({ text: "用户 → AI", style: "labelSmall" }),
        }),
      ]),
      UI.Row({ fillMaxWidth: true, spacing: 6 }, [
        UI.Column({ weight: 1, spacing: 2 }, [
          UI.OutlinedButton({
            fillMaxWidth: true,
            enabled: !props.busy,
            onClick: () => props.onObserverMenuChange(!props.observerMenuOpen),
          }, [UI.Text({
            text: "观察：" + peerLabel(props.draftFilters.observer_id, props.peers),
            style: "labelSmall",
            color: colors.primary,
            maxLines: 1,
            overflow: "ellipsis",
          })]),
          peerMenu(
            props.observerMenuOpen,
            props.draftFilters.observer_id,
            () => props.onObserverMenuChange(false),
            (id) => {
              props.onObserverMenuChange(false);
              props.onDraftFiltersChange({ ...props.draftFilters, observer_id: id || undefined });
            }
          ),
        ]),
        UI.Column({ weight: 1, spacing: 2 }, [
          UI.OutlinedButton({
            fillMaxWidth: true,
            enabled: !props.busy,
            onClick: () => props.onObservedMenuChange(!props.observedMenuOpen),
          }, [UI.Text({
            text: "对象：" + peerLabel(props.draftFilters.observed_id, props.peers),
            style: "labelSmall",
            color: colors.primary,
            maxLines: 1,
            overflow: "ellipsis",
          })]),
          peerMenu(
            props.observedMenuOpen,
            props.draftFilters.observed_id,
            () => props.onObservedMenuChange(false),
            (id) => {
              props.onObservedMenuChange(false);
              props.onDraftFiltersChange({ ...props.draftFilters, observed_id: id || undefined });
            }
          ),
        ]),
      ]),
      UI.TextField({
        value: props.draftFilters.session_id || "",
        onValueChange: (value) => props.onDraftFiltersChange({ ...props.draftFilters, session_id: value }),
        label: "会话 ID",
        singleLine: true,
        fillMaxWidth: true,
      }),
      UI.Column({ fillMaxWidth: true, spacing: 2 }, [
        UI.OutlinedButton({
          fillMaxWidth: true,
          enabled: !props.busy,
          onClick: () => props.onLevelMenuChange(!props.levelMenuOpen),
        }, [UI.Text({
          text: levelLabel(props.draftFilters.level),
          style: "labelLarge",
          color: colors.primary,
        })]),
        UI.DropdownMenu(
          { expanded: props.levelMenuOpen, onDismissRequest: () => props.onLevelMenuChange(false) },
          LEVELS.map((option) => UI.Surface({
            key: "conclusion-level-" + (option.value || "all"),
            fillMaxWidth: true,
            padding: 10,
            containerColor: option.value === (props.draftFilters.level || "")
              ? colors.primaryContainer
              : colors.surface,
            onClick: () => {
              props.onLevelMenuChange(false);
              props.onDraftFiltersChange({
                ...props.draftFilters,
                level: option.value || undefined,
              });
            },
          }, [UI.Text({ text: option.label, style: "bodyMedium", color: colors.onSurface })]))
        ),
      ]),
      UI.Row({ fillMaxWidth: true, spacing: 8, horizontalArrangement: "end" }, [
        UI.OutlinedButton({ enabled: !props.busy, onClick: props.onClearFilters }, [
          UI.Text({ text: "清除", style: "labelLarge", color: colors.primary }),
        ]),
        UI.Button({ text: "应用筛选", enabled: !props.busy, onClick: props.onApplyFilters }),
      ]),
    ])]),
  ];

  if (props.notice) nodes.push(noticeSurface(props.notice));
  if (props.error) nodes.push(noticeSurface(props.error, true));
  if (!props.page.items.length) {
    nodes.push(UI.Column({ fillMaxWidth: true, horizontalAlignment: "center", padding: 24, spacing: 5 }, [
      UI.Icon({ name: "inbox", size: 28, tint: colors.onSurfaceVariant }),
      UI.Text({ text: "当前筛选没有结论", style: "bodyMedium", color: colors.onSurfaceVariant }),
    ]));
  }
  for (const conclusion of props.page.items) {
    nodes.push(UI.Card({
      key: "conclusion-" + conclusion.id,
      fillMaxWidth: true,
      elevation: 0,
      shape: { type: "rounded", cornerRadius: 8 },
      containerColor: colors.surfaceVariant,
    }, [UI.Column({ fillMaxWidth: true, padding: 12, spacing: 5 }, [
      UI.Text({
        text: clipText(conclusion.content, 300),
        style: "titleSmall",
        color: colors.onSurface,
        fontWeight: "bold",
        maxLines: 5,
        overflow: "ellipsis",
        softWrap: true,
      }),
      UI.Text({
        text: directionLabel(conclusion),
        style: "bodySmall",
        color: colors.primary,
        maxLines: 2,
        overflow: "ellipsis",
        softWrap: true,
      }),
      directionLabel(conclusion) !== directionIds(conclusion)
        ? UI.Text({
            text: directionIds(conclusion),
            style: "labelSmall",
            color: colors.onSurfaceVariant,
            maxLines: 2,
            overflow: "ellipsis",
            softWrap: true,
          })
        : null,
      UI.Text({
        text: levelLabel(conclusion.level)
          + (conclusion.session_id ? " · " + conclusion.session_id : "")
          + " · " + displayTime(conclusion.created_at),
        style: "labelSmall",
        color: colors.onSurfaceVariant,
        maxLines: 2,
        overflow: "ellipsis",
        softWrap: true,
      }),
    ].filter(Boolean) as ComposeNode[])]));
  }
  if (!props.appliedFilters.query && props.page.pages > 1) {
    nodes.push(UI.Row({
      fillMaxWidth: true,
      height: 48,
      horizontalArrangement: "spaceBetween",
      verticalAlignment: "center",
    }, [
      UI.IconButton({
        icon: "chevron_left",
        enabled: !props.busy && props.page.page > 1,
        onClick: () => props.onPage(props.page.page - 1),
      }),
      UI.Text({
        text: pageLabel(props.page.page, props.page.pages, props.page.total),
        style: "labelMedium",
        color: colors.onSurfaceVariant,
      }),
      UI.IconButton({
        icon: "chevron_right",
        enabled: !props.busy && props.page.page < props.page.pages,
        onClick: () => props.onPage(props.page.page + 1),
      }),
    ]));
  }

  nodes.push(UI.HorizontalDivider({ color: colors.outlineVariant }));
  nodes.push(UI.Row({ fillMaxWidth: true, height: 44, verticalAlignment: "center", spacing: 8 }, [
    UI.Column({ weight: 1, spacing: 1 }, [
      UI.Text({ text: "精确重复检查", style: "titleSmall", color: colors.onSurface, fontWeight: "bold" }),
      UI.Text({
        text: props.duplicateReport
          ? "发现 " + props.duplicateReport.duplicate_count + " 条可审阅重复"
          : "只读取当前筛选范围",
        style: "labelSmall",
        color: colors.onSurfaceVariant,
      }),
    ]),
    UI.OutlinedButton({ enabled: !props.busy, onClick: props.onScanDuplicates }, [
      UI.Row({ spacing: 5, verticalAlignment: "center" }, [
        UI.Icon({ name: "fact_check", size: 18, tint: colors.primary }),
        UI.Text({ text: "扫描", style: "labelLarge", color: colors.primary }),
      ]),
    ]),
  ]));

  if (props.duplicateReport?.truncated) {
    nodes.push(noticeSurface("扫描达到 5000 条安全上限；报告可能不是完整集合。"));
  }
  if (props.duplicateReport && !props.duplicateReport.groups.length) {
    nodes.push(UI.Text({ text: "当前范围未发现精确重复组", style: "bodyMedium", color: colors.onSurfaceVariant }));
  }
  for (const group of props.duplicateReport?.groups || []) {
    const selected = group.group_key === props.selectedDuplicateGroupKey;
    nodes.push(UI.Card({
      key: "duplicate-" + group.group_key,
      fillMaxWidth: true,
      elevation: 0,
      shape: { type: "rounded", cornerRadius: 8 },
      border: selected ? { width: 1, color: colors.primary } : undefined,
      containerColor: selected ? colors.primaryContainer : colors.surfaceVariant,
    }, [UI.Column({ fillMaxWidth: true, padding: 10, spacing: 5 }, [
      UI.Text({
        text: clipText(group.content, 220),
        style: "bodyMedium",
        color: selected ? colors.onPrimaryContainer : colors.onSurface,
        maxLines: 4,
        overflow: "ellipsis",
        softWrap: true,
      }),
      UI.Text({
        text: directionLabel(group) + " · 共 " + group.items.length + " 条",
        style: "labelSmall",
        color: colors.onSurfaceVariant,
        maxLines: 2,
        overflow: "ellipsis",
      }),
      UI.OutlinedButton({ enabled: !props.busy, onClick: () => props.onSelectDuplicateGroup(group) }, [
        UI.Text({ text: selected ? "正在审阅" : "审阅保留项", style: "labelLarge", color: colors.primary }),
      ]),
    ])]));
  }

  if (selectedGroup) {
    nodes.push(UI.Surface({
      fillMaxWidth: true,
      padding: 10,
      shape: { type: "rounded", cornerRadius: 8 },
      containerColor: colors.secondaryContainer,
    }, [UI.Column({ fillMaxWidth: true, spacing: 6 }, [
      UI.Text({ text: "选择保留项", style: "titleSmall", color: colors.onSecondaryContainer, fontWeight: "bold" }),
      ...selectedGroup.items.map((item) => UI.Surface({
        key: "keep-conclusion-" + item.id,
        fillMaxWidth: true,
        padding: 8,
        shape: { type: "rounded", cornerRadius: 6 },
        containerColor: item.id === props.keepConclusionId ? colors.primaryContainer : colors.surface,
        onClick: () => props.onKeepConclusionChange(item.id),
      }, [UI.Row({ fillMaxWidth: true, spacing: 7, verticalAlignment: "center" }, [
        UI.Icon({
          name: item.id === props.keepConclusionId ? "radio_button_checked" : "radio_button_unchecked",
          size: 18,
          tint: colors.primary,
        }),
        UI.Column({ weight: 1, spacing: 1 }, [
          UI.Text({ text: item.id, style: "labelMedium", color: colors.onSurface, maxLines: 1, overflow: "ellipsis" }),
          UI.Text({
            text: displayTime(item.created_at)
              + (item.id === selectedGroup.earliest_id ? " · 最早" : "")
              + (item.id === selectedGroup.latest_id ? " · 最新" : ""),
            style: "labelSmall",
            color: colors.onSurfaceVariant,
          }),
        ]),
      ])])),
      writable
        ? UI.Button({
            text: "预览清理 " + Math.max(0, selectedGroup.items.length - 1) + " 条",
            enabled: !props.busy && Boolean(props.keepConclusionId),
            onClick: () => props.onPrepareCleanup(selectedGroup),
          })
        : UI.Text({ text: "非活跃工作区仅支持只读扫描", style: "bodySmall", color: colors.onSecondaryContainer }),
    ])]));
  }

  if (props.cleanupPreview) {
    const preview = props.cleanupPreview;
    nodes.push(UI.Surface({
      fillMaxWidth: true,
      padding: 12,
      shape: { type: "rounded", cornerRadius: 8 },
      containerColor: colors.errorContainer,
    }, [UI.Column({ fillMaxWidth: true, spacing: 7 }, [
      UI.Text({ text: "确认删除重复结论", style: "titleSmall", color: colors.onErrorContainer, fontWeight: "bold" }),
      UI.Text({ text: "工作区：" + preview.workspace_id, style: "bodySmall", color: colors.onErrorContainer }),
      UI.Text({ text: "保留：" + preview.keep_conclusion_id, style: "bodySmall", color: colors.onErrorContainer, softWrap: true }),
      UI.Text({
        text: "删除：" + preview.delete_conclusion_ids.join(", "),
        style: "bodySmall",
        color: colors.onErrorContainer,
        maxLines: 4,
        overflow: "ellipsis",
        softWrap: true,
      }),
      UI.TextField({
        value: props.confirmationText,
        onValueChange: props.onConfirmationTextChange,
        label: "输入 " + preview.confirmation_phrase,
        singleLine: true,
        fillMaxWidth: true,
      }),
      UI.Row({ fillMaxWidth: true, spacing: 8, horizontalArrangement: "end" }, [
        UI.OutlinedButton({ enabled: !props.busy, onClick: props.onCancelCleanup }, [
          UI.Text({ text: "取消", style: "labelLarge", color: colors.primary }),
        ]),
        UI.Button({
          text: "确认删除",
          enabled: !props.busy && props.confirmationText === preview.confirmation_phrase,
          onClick: props.onCommitCleanup,
        }),
      ]),
    ])]));
  }

  return nodes;
}