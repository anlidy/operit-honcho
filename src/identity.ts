function sanitizeLegacyId(value: string, fallback: string, maxLength = 100): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}

export const IDENTITY_NAMESPACE = "operit_honcho";
export const IDENTITY_SCHEMA_VERSION = 1;

export type IdentitySource = "workspace_metadata" | "legacy_config";

export interface WorkspaceIdentity {
  schemaVersion: number;
  revision: number;
  userPeerId: string;
  aiPeerId: string;
  source: IdentitySource;
  migrationRequired: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function peerId(value: unknown, field: string): string {
  const id = String(value || "").trim();
  if (!id || id.length > 512 || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`INVALID_IDENTITY_METADATA: ${field} must be a valid Honcho Peer ID.`);
  }
  return id;
}

function distinct(userPeerId: string, aiPeerId: string): void {
  if (userPeerId === aiPeerId) {
    throw new Error("INVALID_IDENTITY_METADATA: User and AI Peer IDs must be different.");
  }
}

export function legacyWorkspaceIdentity(userPeer: string, aiPeer: string): WorkspaceIdentity {
  const userPeerId = sanitizeLegacyId(userPeer, "user");
  const aiPeerId = sanitizeLegacyId(aiPeer, "operit");
  distinct(userPeerId, aiPeerId);
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    revision: 0,
    userPeerId,
    aiPeerId,
    source: "legacy_config",
    migrationRequired: true,
  };
}

export function workspaceIdentity(
  metadata: unknown,
  legacy: WorkspaceIdentity
): WorkspaceIdentity {
  const root = record(metadata);
  if (!(IDENTITY_NAMESPACE in root)) return legacy;

  const value = record(root[IDENTITY_NAMESPACE]);
  const schemaVersion = Number(value.schema_version);
  const revision = Number(value.revision);
  if (schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    throw new Error(`INVALID_IDENTITY_METADATA: unsupported schema_version ${String(value.schema_version)}.`);
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("INVALID_IDENTITY_METADATA: revision must be a positive integer.");
  }

  const userPeerId = peerId(value.active_user_peer_id, "active_user_peer_id");
  const aiPeerId = peerId(value.active_ai_peer_id, "active_ai_peer_id");
  distinct(userPeerId, aiPeerId);
  return {
    schemaVersion,
    revision,
    userPeerId,
    aiPeerId,
    source: "workspace_metadata",
    migrationRequired: false,
  };
}

export function metadataWithWorkspaceIdentity(
  metadata: unknown,
  userPeerId: string,
  aiPeerId: string,
  previousRevision = 0
): Record<string, unknown> {
  const user = peerId(userPeerId, "active_user_peer_id");
  const ai = peerId(aiPeerId, "active_ai_peer_id");
  distinct(user, ai);
  return {
    ...record(metadata),
    [IDENTITY_NAMESPACE]: {
      ...record(record(metadata)[IDENTITY_NAMESPACE]),
      schema_version: IDENTITY_SCHEMA_VERSION,
      revision: Math.max(0, Math.trunc(previousRevision)) + 1,
      active_user_peer_id: user,
      active_ai_peer_id: ai,
    },
  };
}

export function peerDisplayName(metadata: unknown): string {
  const value = record(record(metadata)[IDENTITY_NAMESPACE]);
  return typeof value.display_name === "string" ? value.display_name.trim().slice(0, 200) : "";
}

export function peerArchived(metadata: unknown): boolean {
  return record(record(metadata)[IDENTITY_NAMESPACE]).archived === true;
}

export function metadataWithPeerProfile(
  metadata: unknown,
  updates: { displayName?: string; archived?: boolean }
): Record<string, unknown> {
  const root = record(metadata);
  const current = record(root[IDENTITY_NAMESPACE]);
  const next: Record<string, unknown> = { ...current };
  if (updates.displayName !== undefined) {
    next.display_name = String(updates.displayName).trim().slice(0, 200);
  }
  if (updates.archived !== undefined) next.archived = updates.archived;
  return { ...root, [IDENTITY_NAMESPACE]: next };
}
