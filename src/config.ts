export type RecallMode = "hybrid" | "context" | "tools";
export type ObservationMode = "directional" | "unified";
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export type InjectionFrequency = "every-turn" | "first-turn";

export interface HonchoConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  workspace: string;
  userPeer: string;
  aiPeer: string;
  recallMode: RecallMode;
  observationMode: ObservationMode;
  saveMessages: boolean;
  sessionStrategy: "per-chat" | "global";
  contextTokens: number;
  contextCadence: number;
  dialecticCadence: number;
  dialecticReasoningLevel: ReasoningLevel;
  dialecticMaxChars: number;
  messageMaxChars: number;
  injectionFrequency: InjectionFrequency;
}

export const ENV = {
  enabled: "HONCHO_ENABLED",
  apiKey: "HONCHO_API_KEY",
  baseUrl: "HONCHO_BASE_URL",
  workspace: "HONCHO_WORKSPACE",
  userPeer: "HONCHO_USER_PEER",
  aiPeer: "HONCHO_AI_PEER",
  recallMode: "HONCHO_RECALL_MODE",
  observationMode: "HONCHO_OBSERVATION_MODE",
  saveMessages: "HONCHO_SAVE_MESSAGES",
  sessionStrategy: "HONCHO_SESSION_STRATEGY",
  contextTokens: "HONCHO_CONTEXT_TOKENS",
  contextCadence: "HONCHO_CONTEXT_CADENCE",
  dialecticCadence: "HONCHO_DIALECTIC_CADENCE",
  dialecticReasoningLevel: "HONCHO_DIALECTIC_REASONING_LEVEL",
  dialecticMaxChars: "HONCHO_DIALECTIC_MAX_CHARS",
  messageMaxChars: "HONCHO_MESSAGE_MAX_CHARS",
  injectionFrequency: "HONCHO_INJECTION_FREQUENCY",
} as const;

function read(key: string): string {
  if (typeof getEnv !== "function") return "";
  const value = getEnv(key);
  return value == null ? "" : String(value).trim();
}

function bool(key: string, fallback: boolean): boolean {
  const value = read(key).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function int(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(read(key), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function choice<T extends string>(key: string, values: readonly T[], fallback: T): T {
  const value = read(key) as T;
  return values.includes(value) ? value : fallback;
}
export const DEFAULT_BASE_URL = "https://api.honcho.dev";

export function loadConfig(): HonchoConfig {
  const apiKey = read(ENV.apiKey);
  const configuredBaseUrl = read(ENV.baseUrl);
  const baseUrl = (configuredBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const enabledRaw = read(ENV.enabled).toLowerCase();
  const enabled = enabledRaw
    ? bool(ENV.enabled, false)
    : Boolean(apiKey || configuredBaseUrl);


  return {
    enabled,
    apiKey,
    baseUrl,
    workspace: read(ENV.workspace) || "operit",
    userPeer: read(ENV.userPeer) || "user",
    aiPeer: read(ENV.aiPeer) || "operit",
    recallMode: choice(ENV.recallMode, ["hybrid", "context", "tools"] as const, "hybrid"),
    observationMode: choice(ENV.observationMode, ["directional", "unified"] as const, "directional"),
    saveMessages: bool(ENV.saveMessages, true),
    sessionStrategy: choice(ENV.sessionStrategy, ["per-chat", "global"] as const, "per-chat"),
    contextTokens: int(ENV.contextTokens, 2000, 200, 100000),
    contextCadence: int(ENV.contextCadence, 1, 1, 1000),
    dialecticCadence: int(ENV.dialecticCadence, 2, 1, 1000),
    dialecticReasoningLevel: choice(
      ENV.dialecticReasoningLevel,
      ["minimal", "low", "medium", "high", "max"] as const,
      "low"
    ),
    dialecticMaxChars: int(ENV.dialecticMaxChars, 600, 0, 20000),
    messageMaxChars: int(ENV.messageMaxChars, 25000, 1000, 25000),
    injectionFrequency: choice(
      ENV.injectionFrequency,
      ["every-turn", "first-turn"] as const,
      "every-turn"
    ),
  };
}

export function configSignature(config: HonchoConfig): string {
  return JSON.stringify(config);
}

export function isConfigured(config: HonchoConfig): boolean {
  return config.enabled && Boolean(config.apiKey || config.baseUrl !== DEFAULT_BASE_URL);
}
