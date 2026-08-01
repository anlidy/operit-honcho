import { ExplorerOperation, ExplorerRequest } from "./types";

const OPERATIONS: ExplorerOperation[] = [
  "status",
  "identity_status",
  "prepare_identity_update",
  "commit_identity_update",
  "queue_status",
  "list_workspaces",
  "list_peers",
  "get_peer",
  "list_peer_sessions",
  "get_peer_card",
  "prepare_peer_mutation",
  "commit_peer_mutation",
  "list_sessions",
  "list_messages",
  "list_conclusions",
];

export class ExplorerValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_REQUEST") {
    super(message);
    this.name = "ExplorerValidationError";
    this.code = code;
  }
}

function optionalPeerId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ExplorerValidationError(name + " must be a string.");
  }
  const id = value.trim();
  if (!id || id.length > 512) {
    throw new ExplorerValidationError(name + " must contain 1 to 512 characters.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new ExplorerValidationError(
      name + " must contain only letters, numbers, underscores, and hyphens."
    );
  }
  return id;
}

function optionalDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 200) {
    throw new ExplorerValidationError("displayName must contain at most 200 characters.");
  }
  return value.trim();
}

function optionalPeerMutation(value: unknown): NonNullable<ExplorerRequest["params"]>["peerMutation"] {
  if (value === undefined || value === null || value === "") return undefined;
  const allowed = ["create", "update_display_name", "set_archived", "remove_from_session"];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ExplorerValidationError("Unknown peerMutation.");
  }
  return value as NonNullable<ExplorerRequest["params"]>["peerMutation"];
}

function optionalToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new ExplorerValidationError("confirmationToken must contain 1 to 256 characters.");
  }
  return value.trim();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExplorerValidationError("Explorer request must be an object.");
  }
  return value as Record<string, unknown>;
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ExplorerValidationError(`${name} must be a string.`);
  }
  const id = value.trim();
  if (!id || id.length > 200) {
    throw new ExplorerValidationError(`${name} must contain 1 to 200 characters.`);
  }
  return id;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ExplorerValidationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function parseExplorerRequest(value: unknown): ExplorerRequest {
  const input = record(value);
  if (typeof input.op !== "string" || !OPERATIONS.includes(input.op as ExplorerOperation)) {
    throw new ExplorerValidationError("Unknown Explorer operation.");
  }
  if (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 128) {
    throw new ExplorerValidationError("requestId must contain 1 to 128 characters.");
  }

  const paramsInput = input.params === undefined ? {} : record(input.params);
  const reverseValue = paramsInput.reverse;
  if (reverseValue !== undefined && typeof reverseValue !== "boolean") {
    throw new ExplorerValidationError("reverse must be a boolean.");
  }
  const params: NonNullable<ExplorerRequest["params"]> = {
    page: optionalInteger(paramsInput.page, "page", 1, 100000),
    size: optionalInteger(paramsInput.size, "size", 1, 100),
    reverse: reverseValue as boolean | undefined,
    sessionId: optionalId(paramsInput.sessionId, "sessionId"),
    peerId: optionalPeerId(paramsInput.peerId, "peerId"),
    observerPeerId: optionalPeerId(paramsInput.observerPeerId, "observerPeerId"),
    targetPeerId: optionalPeerId(paramsInput.targetPeerId, "targetPeerId"),
    displayName: optionalDisplayName(paramsInput.displayName),
    archived: paramsInput.archived === undefined
      ? undefined
      : typeof paramsInput.archived === "boolean"
        ? paramsInput.archived
        : (() => { throw new ExplorerValidationError("archived must be a boolean."); })(),
    peerMutation: optionalPeerMutation(paramsInput.peerMutation),
    userPeerId: optionalPeerId(paramsInput.userPeerId, "userPeerId"),
    aiPeerId: optionalPeerId(paramsInput.aiPeerId, "aiPeerId"),
    confirmationToken: optionalToken(paramsInput.confirmationToken),
  };

  const request: ExplorerRequest = {
    op: input.op as ExplorerOperation,
    requestId: input.requestId.trim(),
    workspaceId: optionalId(input.workspaceId, "workspaceId"),
    params,
  };
  if (request.op === "list_messages" && !request.params?.sessionId) {
    throw new ExplorerValidationError("sessionId is required for list_messages.");
  }
  if (
    (request.op === "get_peer" || request.op === "list_peer_sessions")
    && !request.params?.peerId
  ) {
    throw new ExplorerValidationError("peerId is required for this operation.");
  }
  if (
    request.op === "get_peer_card"
    && (!request.params?.observerPeerId || !request.params?.targetPeerId)
  ) {
    throw new ExplorerValidationError("observerPeerId and targetPeerId are required for get_peer_card.");
  }
  if (request.op === "prepare_peer_mutation" || request.op === "commit_peer_mutation") {
    if (!request.params?.peerMutation || !request.params.peerId) {
      throw new ExplorerValidationError("peerMutation and peerId are required for Peer updates.");
    }
    if (request.params.peerMutation === "update_display_name" && request.params.displayName === undefined) {
      throw new ExplorerValidationError("displayName is required to update a Peer name.");
    }
    if (request.params.peerMutation === "set_archived" && request.params.archived === undefined) {
      throw new ExplorerValidationError("archived is required to update Peer archive state.");
    }
    if (request.params.peerMutation === "remove_from_session" && !request.params.sessionId) {
      throw new ExplorerValidationError("sessionId is required to remove a Peer from a Session.");
    }
  }
  if (
    (request.op === "prepare_identity_update" || request.op === "commit_identity_update")
    && (!request.params?.userPeerId || !request.params?.aiPeerId)
  ) {
    throw new ExplorerValidationError(
      "userPeerId and aiPeerId are required for identity updates."
    );
  }
  if (
    (request.op === "prepare_identity_update" || request.op === "commit_identity_update")
    && request.params?.userPeerId === request.params?.aiPeerId
  ) {
    throw new ExplorerValidationError("User and AI Peer IDs must be different.");
  }
  if (request.op === "commit_identity_update" && !request.params?.confirmationToken) {
    throw new ExplorerValidationError(
      "A confirmation token is required to update Workspace identity.",
      "CONFIRMATION_REQUIRED"
    );
  }
  if (request.op === "commit_peer_mutation" && !request.params?.confirmationToken) {
    throw new ExplorerValidationError(
      "A confirmation token is required to update a Peer.",
      "CONFIRMATION_REQUIRED"
    );
  }
  return request;
}

export function pageOptions(
  request: ExplorerRequest,
  defaults: { size: number; reverse: boolean }
): { page: number; size: number; reverse: boolean } {
  return {
    page: request.params?.page || 1,
    size: request.params?.size || defaults.size,
    reverse: request.params?.reverse ?? defaults.reverse,
  };
}