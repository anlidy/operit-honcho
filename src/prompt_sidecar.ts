import { sanitizeMemoryContext } from "./format";
import { sha256 } from "./hash";

const SCHEMA_VERSION = 1;
const MAX_RECORDS_PER_CHAT = 256;
const RECORD_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_WRITE_INTERVAL_MS = 60 * 60 * 1000;
export const PROMPT_SIDECAR_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const PROMPT_SIDECAR_MAX_FILE_BYTES = 1024 * 1024;

export interface SidecarStorageEntry {
  path: string;
  size: number;
  lastModified: number;
}

export interface PromptSidecarStatistics {
  fileCount: number;
  totalBytes: number;
  maxBytes: number;
}

export interface PromptSidecarLimits {
  maxRecordsPerChat: number;
  recordTtlMs: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export interface SidecarStorage {
  read(path: string): Promise<string | null>;
  writeAtomic(path: string, content: string): Promise<void>;
  quarantine(path: string): Promise<void>;
  list?(root: string): Promise<SidecarStorageEntry[]>;
  remove?(path: string): Promise<void>;
  clear?(root: string): Promise<void>;
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export class PromptSidecarStore {
  private readonly cache = new Map<string, SidecarFile>();
  private readonly loads = new Map<string, Promise<SidecarFile>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly injections = new Map<string, Promise<string | null>>();
  private limitEnforcement: Promise<void> = Promise.resolve();
  private readonly limits: PromptSidecarLimits;

  constructor(
    private readonly storage: SidecarStorage,
    private readonly root: string,
    private readonly now: () => number = () => Date.now(),
    limits: Partial<PromptSidecarLimits> = {}
  ) {
    this.limits = {
      maxRecordsPerChat: limits.maxRecordsPerChat || MAX_RECORDS_PER_CHAT,
      recordTtlMs: limits.recordTtlMs || RECORD_TTL_MS,
      maxTotalBytes: limits.maxTotalBytes || PROMPT_SIDECAR_MAX_TOTAL_BYTES,
      maxFileBytes: limits.maxFileBytes || PROMPT_SIDECAR_MAX_FILE_BYTES,
    };
  }

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

  private prune(file: SidecarFile, requiredRecordKey?: string): void {
    const now = this.now();
    const source = file.records;
    const records = Object.entries(source)
      .filter(([, record]) => now - Number(record.last_seen_at || record.created_at || 0) <= this.limits.recordTtlMs)
      .sort((left, right) => Number(right[1].last_seen_at) - Number(left[1].last_seen_at))
      .slice(0, this.limits.maxRecordsPerChat);
    if (requiredRecordKey && source[requiredRecordKey]
      && !records.some(([key]) => key === requiredRecordKey)) {
      if (records.length >= this.limits.maxRecordsPerChat) records.pop();
      records.unshift([requiredRecordKey, source[requiredRecordKey]]);
    }
    file.records = Object.fromEntries(records);
  }

  private serialize(file: SidecarFile, requiredRecordKey?: string): string {
    const candidate: SidecarFile = { ...file, records: { ...file.records } };
    this.prune(candidate, requiredRecordKey);
    let content = JSON.stringify(candidate);
    if (utf8ByteLength(content) <= this.limits.maxFileBytes) {
      file.records = candidate.records;
      return content;
    }

    const records = Object.entries(candidate.records)
      .sort((left, right) => Number(right[1].last_seen_at) - Number(left[1].last_seen_at));
    while (records.length > 1 && utf8ByteLength(content) > this.limits.maxFileBytes) {
      let removalIndex = records.length - 1;
      while (removalIndex >= 0 && records[removalIndex][0] === requiredRecordKey) {
        removalIndex -= 1;
      }
      if (removalIndex < 0) break;
      records.splice(removalIndex, 1);
      candidate.records = Object.fromEntries(records);
      content = JSON.stringify(candidate);
    }
    if (utf8ByteLength(content) > this.limits.maxFileBytes) {
      throw new Error("Prompt sidecar file exceeds the " + this.limits.maxFileBytes + " byte limit.");
    }
    if (requiredRecordKey && !candidate.records[requiredRecordKey]) {
      throw new Error("Prompt sidecar record could not be retained within the file limit.");
    }
    file.records = candidate.records;
    return content;
  }

  private forgetPath(path: string): void {
    for (const chatId of this.cache.keys()) {
      if (this.path(chatId) === path) this.cache.delete(chatId);
    }
  }

  private async enforceTotalLimit(activePath: string): Promise<void> {
    if (!this.storage.list || !this.storage.remove) return;
    const entries = await this.storage.list(this.root);
    let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
    if (total <= this.limits.maxTotalBytes) return;

    const activePaths = new Set(Array.from(this.writes.keys()).map((chatId) => this.path(chatId)));
    const candidates = entries
      .filter((entry) => entry.path !== activePath && !activePaths.has(entry.path))
      .sort((left, right) => {
        const leftCorrupt = left.path.includes(".corrupt-") ? 0 : 1;
        const rightCorrupt = right.path.includes(".corrupt-") ? 0 : 1;
        return leftCorrupt - rightCorrupt || left.lastModified - right.lastModified;
      });
    for (const entry of candidates) {
      if (total <= this.limits.maxTotalBytes) break;
      await this.storage.remove(entry.path);
      this.forgetPath(entry.path);
      total -= Math.max(0, entry.size);
    }
    if (total > this.limits.maxTotalBytes) {
      if (Array.from(activePaths).some((path) => path !== activePath)) return;
      await this.storage.remove(activePath);
      this.forgetPath(activePath);
      throw new Error(
        `Prompt sidecar exceeds the ${this.limits.maxTotalBytes} byte storage limit.`
      );
    }
  }

  private async persist(chatId: string, file: SidecarFile, requiredRecordKey?: string): Promise<void> {
    const path = this.path(chatId);
    const previous = this.writes.get(chatId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      const content = this.serialize(file, requiredRecordKey);
      return this.storage.writeAtomic(path, content);
    });
    this.writes.set(chatId, current);
    try {
      await current;
      const enforcement = this.limitEnforcement
        .catch(() => undefined)
        .then(() => this.enforceTotalLimit(path));
      this.limitEnforcement = enforcement;
      await enforcement;
    } finally {
      if (this.writes.get(chatId) === current) this.writes.delete(chatId);
    }
  }

  async statistics(): Promise<PromptSidecarStatistics> {
    if (this.storage.list) {
      const entries = await this.storage.list(this.root);
      return {
        fileCount: entries.length,
        totalBytes: entries.reduce((sum, entry) => sum + Math.max(0, entry.size), 0),
        maxBytes: this.limits.maxTotalBytes,
      };
    }
    const contents = Array.from(this.cache.values()).map((file) => JSON.stringify(file));
    return {
      fileCount: contents.length,
      totalBytes: contents.reduce((sum, content) => sum + utf8ByteLength(content), 0),
      maxBytes: this.limits.maxTotalBytes,
    };
  }

  async clearAll(): Promise<PromptSidecarStatistics> {
    await Promise.all(Array.from(this.injections.values()).map((value) => value.catch(() => null)));
    await Promise.all(Array.from(this.writes.values()).map((write) => write.catch(() => undefined)));
    await this.limitEnforcement.catch(() => undefined);
    const before = await this.statistics();
    if (this.storage.clear) {
      await this.storage.clear(this.root);
    } else if (this.storage.list && this.storage.remove) {
      const entries = await this.storage.list(this.root);
      for (const entry of entries) await this.storage.remove(entry.path);
    } else {
      throw new Error("Prompt sidecar storage does not support clearing files.");
    }
    this.cache.clear();
    this.loads.clear();
    this.writes.clear();
    this.injections.clear();
    return before;
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
      const injectionKey = chatId + "\u0000" + key;
      const active = this.injections.get(injectionKey);
      if (active) return await active;
      const existing = file.records[key];
      if (existing?.clean_content_hash === cleanHash) {
        existing.last_seen_at = this.now();
        return `${cleanInput}${existing.memory_block}`;
      }

      const pending = (async (): Promise<string | null> => {
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
          await this.persist(chatId, file, key);
        } catch (error) {
          delete file.records[key];
          throw error;
        }
        return injected;
      })();
      this.injections.set(injectionKey, pending);
      try {
        return await pending;
      } finally {
        if (this.injections.get(injectionKey) === pending) this.injections.delete(injectionKey);
      }
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

  async list(root: string): Promise<SidecarStorageEntry[]> {
    await this.ensureDirectory();
    const listing = await Tools.Files.list(root);
    return listing.entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => ({
        path: `${root}/${entry.name}`,
        size: Number(entry.size || 0),
        lastModified: Date.parse(entry.lastModified) || 0,
      }));
  }

  async remove(path: string): Promise<void> {
    const removed = await Tools.Files.deleteFile(path);
    if (!removed.successful) throw new Error(`Cannot delete prompt sidecar: ${removed.details}`);
  }

  async clear(root: string): Promise<void> {
    const exists = await Tools.Files.exists(root);
    if (exists.exists) {
      const removed = await Tools.Files.deleteFile(root, true);
      if (!removed.successful) throw new Error(`Cannot clear prompt sidecars: ${removed.details}`);
    }
    this.directoryReady = false;
  }
}

export function createToolPkgPromptSidecarStore(): PromptSidecarStore {
  const base = ToolPkg.getConfigDir("com.operit.honcho").replace(/\/+$/, "");
  const root = `${base}/prompt-sidecars-v1`;
  return new PromptSidecarStore(new ToolPkgSidecarStorage(root), root);
}