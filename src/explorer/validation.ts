import { ExplorerOperation, ExplorerRequest } from "./types";

const OPERATIONS: ExplorerOperation[] = [
  "status",
  "list_workspaces",
  "list_peers",
  "list_sessions",
  "list_messages",
  "list_conclusions",
];

export class ExplorerValidationError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "ExplorerValidationError";
  }
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