export type ExplorerOperation =
  | "status"
  | "list_workspaces"
  | "list_peers"
  | "list_sessions"
  | "list_messages"
  | "list_conclusions";

export interface ExplorerRequest {
  op: ExplorerOperation;
  requestId: string;
  workspaceId?: string;
  params?: {
    page?: number;
    size?: number;
    reverse?: boolean;
    sessionId?: string;
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
  observed_id?: string;
  session_id?: string | null;
  level?: "explicit" | "deductive" | "inductive" | "contradiction";
  created_at?: string;
}

export interface QueueStatusDto {
  total_work_units: number;
  completed_work_units: number;
  in_progress_work_units: number;
  pending_work_units: number;
}

export interface ExplorerStatusDto {
  enabled: boolean;
  configured: boolean;
  api_key_set: boolean;
  base_url: string;
  workspace: string;
  user_peer: string;
  ai_peer: string;
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
