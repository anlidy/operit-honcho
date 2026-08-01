import type { ComposeDslContext, ComposeNode } from "../../../../types/compose-dsl";
import type {
  WorkspaceIdentityDto,
  WorkspaceIdentityUpdatePreviewDto,
} from "../../explorer/types";

interface IdentityManagerProps {
  identity: WorkspaceIdentityDto | null;
  activeWorkspace: string;
  browsingWorkspace: string;
  userPeerId: string;
  aiPeerId: string;
  preview: WorkspaceIdentityUpdatePreviewDto | null;
  busy: boolean;
  notice: string;
  error: string;
  onUserPeerChange(value: string): void;
  onAiPeerChange(value: string): void;
  onPrepare(): void | Promise<void>;
  onCommit(): void | Promise<void>;
  onCancel(): void;
}

export function renderIdentityManager(
  ctx: ComposeDslContext,
  props: IdentityManagerProps
): ComposeNode {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;
  const canEdit = Boolean(
    props.identity
    && props.activeWorkspace
    && props.browsingWorkspace === props.activeWorkspace
  );
  const changed = Boolean(
    props.identity
    && (
      props.userPeerId.trim() !== props.identity.user_peer
      || props.aiPeerId.trim() !== props.identity.ai_peer
      || props.identity.migration_required
    )
  );
  const content: ComposeNode[] = [
    UI.Row({ fillMaxWidth: true, verticalAlignment: "center", spacing: 8 }, [
      UI.Icon({ name: "manage_accounts", size: 20, tint: colors.primary }),
      UI.Column({ weight: 1, spacing: 1 }, [
        UI.Text({
          text: "身份绑定",
          style: "titleMedium",
          color: colors.onSurface,
          fontWeight: "bold",
        }),
        UI.Text({
          text: props.identity
            ? (props.identity.source === "workspace_metadata"
              ? "Workspace metadata · rev " + props.identity.revision
              : "旧环境变量 · 尚未迁移")
            : "正在读取 Workspace identity",
          style: "labelSmall",
          color: colors.onSurfaceVariant,
        }),
      ]),
    ]),
  ];

  if (!props.identity) {
    content.push(props.error
      ? UI.Text({
          text: props.error,
          style: "bodySmall",
          color: colors.error,
          softWrap: true,
        })
      : UI.LinearProgressIndicator({ fillMaxWidth: true }));
    return UI.Column({ fillMaxWidth: true, spacing: 10, paddingTop: 6 }, content);
  }

  if (!canEdit) {
    content.push(UI.Surface(
      {
        fillMaxWidth: true,
        padding: 10,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.secondaryContainer,
      },
      [UI.Text({
        text: "当前正在浏览其他 Workspace。角色绑定只能在活跃 Hook Workspace "
          + props.activeWorkspace + " 中修改。",
        style: "bodySmall",
        color: colors.onSecondaryContainer,
        softWrap: true,
      })]
    ));
    return UI.Column({ fillMaxWidth: true, spacing: 10, paddingTop: 6 }, content);
  }

  content.push(
    UI.TextField({
      key: "identity-user-peer",
      fillMaxWidth: true,
      value: props.userPeerId,
      label: "User Peer ID",
      singleLine: true,
      enabled: !props.busy,
      onValueChange: props.onUserPeerChange,
    }),
    UI.TextField({
      key: "identity-ai-peer",
      fillMaxWidth: true,
      value: props.aiPeerId,
      label: "AI Peer ID",
      singleLine: true,
      enabled: !props.busy,
      onValueChange: props.onAiPeerChange,
    })
  );

  if (props.identity.migration_required) {
    content.push(UI.Surface(
      {
        fillMaxWidth: true,
        padding: 10,
        shape: { type: "rounded", cornerRadius: 8 },
        containerColor: colors.tertiaryContainer,
      },
      [UI.Text({
        text: "迁移会把当前 User/AI 绑定写入 Workspace metadata。旧环境变量之后不再覆盖该绑定。",
        style: "bodySmall",
        color: colors.onTertiaryContainer,
        softWrap: true,
      })]
    ));
  }

  if (props.error) {
    content.push(UI.Text({
      text: props.error,
      style: "bodySmall",
      color: colors.error,
      softWrap: true,
    }));
  }
  if (props.notice) {
    content.push(UI.Text({
      text: props.notice,
      style: "bodySmall",
      color: colors.primary,
      softWrap: true,
    }));
  }

  if (!props.preview) {
    content.push(UI.Button({
      text: props.identity.migration_required ? "预览迁移" : "预览角色变更",
      enabled: !props.busy && changed,
      onClick: props.onPrepare,
      shape: { type: "rounded", cornerRadius: 8 },
    }));
  } else {
    content.push(UI.OutlinedCard(
      {
        key: "identity-confirmation",
        fillMaxWidth: true,
        shape: { type: "rounded", cornerRadius: 8 },
        border: { width: 1, color: colors.primary },
      },
      [UI.Column({ fillMaxWidth: true, padding: 12, spacing: 8 }, [
        UI.Text({
          text: "确认身份变更",
          style: "titleSmall",
          color: colors.onSurface,
          fontWeight: "bold",
        }),
        UI.Text({
          text: "Workspace: " + props.preview.workspace_id,
          style: "bodySmall",
          color: colors.onSurfaceVariant,
          softWrap: true,
        }),
        UI.Text({
          text: "User: " + props.preview.previous_user_peer + " → "
            + props.preview.proposed_user_peer,
          style: "bodySmall",
          color: colors.onSurface,
          softWrap: true,
        }),
        UI.Text({
          text: "AI: " + props.preview.previous_ai_peer + " → "
            + props.preview.proposed_ai_peer,
          style: "bodySmall",
          color: colors.onSurface,
          softWrap: true,
        }),
        UI.Text({
          text: "rev " + props.preview.previous_revision + " → "
            + props.preview.proposed_revision + "。变更只影响之后的新消息与工具调用。",
          style: "bodySmall",
          color: colors.onSurfaceVariant,
          softWrap: true,
        }),
        UI.Row({ fillMaxWidth: true, horizontalArrangement: "end", spacing: 8 }, [
          UI.OutlinedButton({
            enabled: !props.busy,
            onClick: props.onCancel,
            shape: { type: "rounded", cornerRadius: 8 },
          }, [UI.Text({ text: "取消", style: "labelLarge" })]),
          UI.Button({
            text: props.busy ? "正在保存" : "确认保存",
            enabled: !props.busy,
            onClick: props.onCommit,
            shape: { type: "rounded", cornerRadius: 8 },
          }),
        ]),
      ])]
    ));
  }

  return UI.Column({ fillMaxWidth: true, spacing: 10, paddingTop: 6 }, content);
}