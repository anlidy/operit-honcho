export type ExplorerOperation =
  | "status"
  | "identity_status"
  | "prepare_identity_update"
  | "commit_identity_update"
  | "queue_status"
  | "list_workspaces"
  | "list_peers"
  | "get_peer"
  | "list_peer_sessions"
  | "get_peer_card"
  | "prepare_peer_mutation"
  | "commit_peer_mutation"
  | "list_sessions"
  | "list_messages"
  | "list_conclusions"
  | "scan_conclusion_duplicates"
  | "prepare_conclusion_cleanup"
  | "commit_conclusion_cleanup"
  | "sidecar_status"
  | "prepare_sidecar_clear"
  | "commit_sidecar_clear";

export interface ExplorerRequest {
  op: ExplorerOperation;
  requestId: string;
  workspaceId?: string;
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
    conclusionLevel?: ConclusionLevel;
    keepConclusionId?: string;
    deleteConclusionIds?: string[];
    confirmationText?: string;
  };
}

export interface ExplorerError {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
}

export interface ExplorerResponse<T = unknown> {
  ok: boolean;
  requestId: string;
  data?: T;
  error?: ExplorerError;
}

export interface ExplorerPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface WorkspaceDto {
  id: string;
  metadata?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  created_at?: string;
}

export interface PeerDto {
  id: string;
  workspace_id?: string;
  metadata?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  created_at?: string;
  display_name: string;
  archived: boolean;
  roles: Array<"user" | "ai">;
}

export type PeerMutationKind =
  | "create"
  | "update_display_name"
  | "set_archived"
  | "remove_from_session";

export interface PeerCardDto {
  workspace_id: string;
  observer_id: string;
  target_id: string;
  peer_card: string[];
}

export interface PeerMutationPreviewDto {
  mutation: PeerMutationKind;
  workspace_id: string;
  peer_id: string;
  previous_display_name?: string;
  proposed_display_name?: string;
  previous_archived?: boolean;
  proposed_archived?: boolean;
  session_id?: string;
  impact: string;
  confirmation_token: string;
  expires_at: string;
}

export interface PeerMutationResultDto {
  mutation: PeerMutationKind;
  peer?: PeerDto;
  session_id?: string;
  removed?: boolean;
}

export interface SessionDto {
  id: string;
  workspace_id?: string;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  created_at?: string;
}

export interface MessageDto {
  id?: string;
  content?: string;
  peer_id?: string;
  session_id?: string;
  workspace_id?: string;
  metadata?: Record<string, unknown>;
  token_count?: number;
  created_at?: string;
}

export interface ConclusionDto {
  id: string;
  content: string;
  observer_id?: string;
  observer_display_name?: string;
  observed_id?: string;
  observed_display_name?: string;
  session_id?: string | null;
  level?: ConclusionLevel;
  created_at?: string;
}

export type ConclusionLevel = "explicit" | "deductive" | "inductive" | "contradiction";

export interface ConclusionFiltersDto {
  observer_id?: string;
  observed_id?: string;
  session_id?: string;
  level?: ConclusionLevel;
  query?: string;
}

export interface ConclusionDuplicateItemDto {
  id: string;
  created_at?: string;
  level?: ConclusionLevel;
}

export interface ConclusionDuplicateGroupDto {
  group_key: string;
  content: string;
  observer_id: string;
  observer_display_name?: string;
  observed_id: string;
  observed_display_name?: string;
  session_id?: string | null;
  items: ConclusionDuplicateItemDto[];
  earliest_id: string;
  latest_id: string;
}

export interface ConclusionDuplicateReportDto {
  workspace_id: string;
  scanned_count: number;
  duplicate_count: number;
  groups: ConclusionDuplicateGroupDto[];
  truncated: boolean;
}

export interface ConclusionCleanupPreviewDto {
  workspace_id: string;
  group_key: string;
  observer_id: string;
  observed_id: string;
  session_id?: string | null;
  keep_conclusion_id: string;
  delete_conclusion_ids: string[];
  confirmation_phrase: string;
  confirmation_token: string;
  expires_at: string;
}

export interface ConclusionCleanupFailureDto {
  id: string;
  error: string;
}

export interface ConclusionCleanupResultDto {
  workspace_id: string;
  keep_conclusion_id: string;
  deleted_ids: string[];
  failures: ConclusionCleanupFailureDto[];
}

export interface PromptSidecarStatusDto {
  file_count: number;
  total_bytes: number;
  max_bytes: number;
}

export interface PromptSidecarClearPreviewDto extends PromptSidecarStatusDto {
  confirmation_phrase: string;
  confirmation_token: string;
  expires_at: string;
}

export interface PromptSidecarClearResultDto {
  deleted_files: number;
  deleted_bytes: number;
}

export interface QueueStatusDto {
  total_work_units: number;
  completed_work_units: number;
  in_progress_work_units: number;
  pending_work_units: number;
}

export interface WorkspaceIdentityDto {
  workspace_id: string;
  user_peer: string;
  ai_peer: string;
  source: "workspace_metadata" | "legacy_config";
  revision: number;
  migration_required: boolean;
}

export interface WorkspaceIdentityUpdatePreviewDto {
  workspace_id: string;
  previous_user_peer: string;
  previous_ai_peer: string;
  previous_revision: number;
  proposed_user_peer: string;
  proposed_ai_peer: string;
  proposed_revision: number;
  confirmation_token: string;
  expires_at: string;
}

export interface ExplorerStatusDto {
  enabled: boolean;
  configured: boolean;
  api_key_set: boolean;
  base_url: string;
  workspace: string;
  user_peer: string;
  ai_peer: string;
  identity_source: "workspace_metadata" | "legacy_config";
  identity_revision: number;
  identity_migration_required: boolean;
  recall_mode: string;
  observation_mode: string;
  session_strategy: string;
  save_messages: boolean;
  pending_messages: number;
  active_writes: number;
  last_write_error: string;
  server_queue?: QueueStatusDto;
  server_queue_error?: ExplorerError;
}
