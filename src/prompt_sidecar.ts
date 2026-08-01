import { sanitizeMemoryContext } from "./format";
import { sha256 } from "./hash";

const SCHEMA_VERSION = 1;
const MAX_RECORDS_PER_CHAT = 256;
const RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_WRITE_INTERVAL_MS = 60 * 60 * 1000;

export interface SidecarStorage {
  read(path: string): Promise<string | null>;
  writeAtomic(path: string, content: string): Promise<void>;
  quarantine(path: string): Promise<void>;
}

interface SidecarRecord {
  clean_content_hash: string;
  memory_block: string;
  created_at: number;
  last_seen_at: number;
}

interface SidecarFile {
  schema_version: 1;
  chat_id_hash: string;
  records: Record<string, SidecarRecord>;
}

export interface PromptTurnLike {
  kind: string;
  content: string;
  toolName?: string;
  [key: string]: unknown;
}

function normalizeTurnContent(value: string): string {
  return sanitizeMemoryContext(String(value || "").replace(/\r\n?/g, "\n"));
}

function canonicalTurn(turn: PromptTurnLike): string {
  return JSON.stringify([
    String(turn.kind || "").toUpperCase(),
    String(turn.toolName || ""),
    normalizeTurnContent(turn.content),
  ]);
}

function turnKey(chatId: string, canonicalPrefix: string): string {
  return sha256(`${SCHEMA_VERSION}\u0000${chatId}\u0000${canonicalPrefix}`);
}

function emptyFile(chatId: string): SidecarFile {
  return {
    schema_version: SCHEMA_VERSION,
    chat_id_hash: sha256(chatId),
    records: {},
  };
}

function parseFile(value: string, chatId: string): SidecarFile {
  const parsed = JSON.parse(value) as Partial<SidecarFile>;
  if (parsed.schema_version !== SCHEMA_VERSION || parsed.chat_id_hash !== sha256(chatId)) {
    throw new Error("Prompt sidecar schema or chat hash mismatch.");
  }
  const records = parsed.records;
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    throw new Error("Prompt sidecar records are invalid.");
  }
  return parsed as SidecarFile;
}

export class PromptSidecarStore {
  private readonly cache = new Map<string, SidecarFile>();
  private readonly loads = new Map<string, Promise<SidecarFile>>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: SidecarStorage,
    private readonly root: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  private path(chatId: string): string {
    return `${this.root}/${sha256(chatId).slice(0, 32)}.json`;
  }

  private async load(chatId: string): Promise<SidecarFile> {
    const cached = this.cache.get(chatId);
    if (cached) return cached;
    const active = this.loads.get(chatId);
    if (active) return active;

    const loading = (async (): Promise<SidecarFile> => {
      const path = this.path(chatId);
      const content = await this.storage.read(path);
      if (!content) return emptyFile(chatId);
      try {
        return parseFile(content, chatId);
      } catch (error) {
        console.log(`[honcho] quarantining corrupt prompt sidecar: ${String(error)}`);
        await this.storage.quarantine(path);
        return emptyFile(chatId);
      }
    })();
    this.loads.set(chatId, loading);
    try {
      const file = await loading;
      this.cache.set(chatId, file);
      return file;
    } finally {
      this.loads.delete(chatId);
    }
  }

  private prune(file: SidecarFile): void {
    const now = this.now();
    const records = Object.entries(file.records)
      .filter(([, record]) => now - Number(record.last_seen_at || record.created_at || 0) <= RECORD_TTL_MS)
      .sort((left, right) => Number(right[1].last_seen_at) - Number(left[1].last_seen_at))
      .slice(0, MAX_RECORDS_PER_CHAT);
    file.records = Object.fromEntries(records);
  }

  private async persist(chatId: string, file: SidecarFile): Promise<void> {
    this.prune(file);
    const path = this.path(chatId);
    const content = JSON.stringify(file);
    const previous = this.writes.get(chatId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.storage.writeAtomic(path, content));
    this.writes.set(chatId, current);
    try {
      await current;
    } finally {
      if (this.writes.get(chatId) === current) this.writes.delete(chatId);
    }
  }

  async restoreHistory(chatId: string, turns: PromptTurnLike[]): Promise<PromptTurnLike[]> {
    try {
      const file = await this.load(chatId);
      const restored: PromptTurnLike[] = [];
      const prefix: string[] = [];
      let shouldPersistTouch = false;
      for (const turn of turns) {
        const cleanContent = normalizeTurnContent(turn.content);
        const cleanTurn = { ...turn, content: cleanContent };
        prefix.push(canonicalTurn(cleanTurn));
        if (String(turn.kind).toUpperCase() !== "USER") {
          restored.push(turn);
          continue;
        }

        const record = file.records[turnKey(chatId, prefix.join("\n"))];
        if (!record || record.clean_content_hash !== sha256(cleanContent)) {
          restored.push(turn);
          continue;
        }
        const now = this.now();
        if (now - record.last_seen_at >= TOUCH_WRITE_INTERVAL_MS) {
          record.last_seen_at = now;
          shouldPersistTouch = true;
        }
        restored.push({ ...cleanTurn, content: `${cleanContent}${record.memory_block}` });
      }
      if (shouldPersistTouch) await this.persist(chatId, file);
      return restored;
    } catch (error) {
      console.log(`[honcho] prompt sidecar history restore failed: ${String(error)}`);
      return turns;
    }
  }

  async injectCurrent(
    chatId: string,
    preparedHistory: PromptTurnLike[],
    input: string,
    inject: (cleanInput: string) => Promise<string | null>
  ): Promise<string | null> {
    const cleanInput = normalizeTurnContent(input);
    if (!cleanInput) return null;
    try {
      const file = await this.load(chatId);
      const currentTurn: PromptTurnLike = { kind: "USER", content: cleanInput };
      const canonical = [...preparedHistory, currentTurn].map((turn) =>
        canonicalTurn({ ...turn, content: normalizeTurnContent(turn.content) })
      );
      const key = turnKey(chatId, canonical.join("\n"));
      const cleanHash = sha256(cleanInput);
      const existing = file.records[key];
      if (existing?.clean_content_hash === cleanHash) {
        existing.last_seen_at = this.now();
        return `${cleanInput}${existing.memory_block}`;
      }

      const injected = await inject(cleanInput);
      if (!injected || !injected.startsWith(cleanInput) || injected === cleanInput) return injected;
      const record: SidecarRecord = {
        clean_content_hash: cleanHash,
        memory_block: injected.slice(cleanInput.length),
        created_at: this.now(),
        last_seen_at: this.now(),
      };
      file.records[key] = record;
      try {
        await this.persist(chatId, file);
      } catch (error) {
        delete file.records[key];
        throw error;
      }
      return injected;
    } catch (error) {
      console.log(`[honcho] prompt sidecar injection failed: ${String(error)}`);
      return null;
    }
  }
}

class ToolPkgSidecarStorage implements SidecarStorage {
  private tempSequence = 0;
  private directoryReady = false;

  constructor(private readonly root: string) {}

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    const result = await Tools.Files.mkdir(this.root, true);
    if (!result.successful) throw new Error(`Cannot create prompt sidecar directory: ${result.details}`);
    this.directoryReady = true;
  }

  async read(path: string): Promise<string | null> {
    await this.ensureDirectory();
    const exists = await Tools.Files.exists(path);
    if (!exists.exists) return null;
    return (await Tools.Files.read(path)).content;
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    await this.ensureDirectory();
    this.tempSequence += 1;
    const temp = `${path}.tmp-${Date.now()}-${this.tempSequence}`;
    const written = await Tools.Files.write(temp, content, false);
    if (!written.successful) throw new Error(`Cannot write prompt sidecar: ${written.details}`);
    const moved = await Tools.Files.move(temp, path);
    if (!moved.successful) {
      await Tools.Files.deleteFile(temp);
      throw new Error(`Cannot replace prompt sidecar: ${moved.details}`);
    }
  }

  async quarantine(path: string): Promise<void> {
    const exists = await Tools.Files.exists(path);
    if (!exists.exists) return;
    const moved = await Tools.Files.move(path, `${path}.corrupt-${Date.now()}`);
    if (!moved.successful) throw new Error(`Cannot quarantine prompt sidecar: ${moved.details}`);
  }
}

export function createToolPkgPromptSidecarStore(): PromptSidecarStore {
  const base = ToolPkg.getConfigDir("com.operit.honcho").replace(/\/+$/, "");
  const root = `${base}/prompt-sidecars-v1`;
  return new PromptSidecarStore(new ToolPkgSidecarStorage(root), root);
}