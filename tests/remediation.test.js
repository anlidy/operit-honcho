const test = require("node:test");
const assert = require("node:assert/strict");

const env = {};
global.getEnv = (key) => env[key] || "";

function configure(overrides = {}) {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, {
    HONCHO_BASE_URL: "http://localhost:8000",
    HONCHO_ENABLED: "true",
    HONCHO_DIALECTIC_CADENCE: "2",
    ...overrides,
  });
}

configure();

const { HonchoApi } = require("../dist/api");
const { loadConfig } = require("../dist/config");
const { HonchoController } = require("../dist/controller");
const { injectMemoryContext } = require("../dist/format");
const { sha256 } = require("../dist/hash");
const {
  analyzeAssistantContent,
  classifyPersistedMessage,
  contentForPersistedMessage,
  sourceKeyFor,
} = require("../dist/message");
const { PromptSidecarStore } = require("../dist/prompt_sidecar");

test("SHA-256 and source identities are deterministic across completion replays", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  const base = {
    chatId: "chat-1",
    sender: "ai",
    content: "final answer",
    sentAt: 100,
    timestamp: 90,
    selectedVariantIndex: 0,
  };
  assert.equal(
    sourceKeyFor({ ...base, completedAt: 200 }, "assistant"),
    sourceKeyFor({ ...base, completedAt: 300 }, "assistant")
  );
  assert.equal(
    sourceKeyFor({ ...base, sentAt: 0 }, "assistant"),
    sourceKeyFor({ ...base, sentAt: 999 }, "assistant")
  );
});

test("message classification accepts final visible turns and rejects streaming or hidden records", () => {
  assert.deepEqual(
    classifyPersistedMessage({ chatId: "c", sender: "user", content: "hello" }),
    { accepted: true, role: "user", reason: "accepted_final" }
  );
  assert.deepEqual(
    classifyPersistedMessage({
      chatId: "c",
      sender: "ai",
      content: "done",
      displayMode: "NORMAL",
      completedAt: 2,
    }),
    { accepted: true, role: "assistant", reason: "accepted_final" }
  );
  assert.equal(classifyPersistedMessage({
    chatId: "c", sender: "ai", content: "partial tool loop", displayMode: "NORMAL", completedAt: 0,
  }).reason, "skipped_incomplete");
  assert.equal(classifyPersistedMessage({
    chatId: "c", sender: "ai", content: "placeholder", displayMode: "HIDDEN_PLACEHOLDER", completedAt: 2,
  }).reason, "skipped_system");
  assert.equal(classifyPersistedMessage({
    chatId: "c", sender: "ai", content: "unknown", displayMode: "FUTURE_KIND", completedAt: 2,
  }).reason, "skipped_unknown_kind");
  assert.equal(classifyPersistedMessage({
    chatId: "c", sender: "ai", content: "<think>only reasoning</think>", displayMode: "NORMAL", completedAt: 2,
  }).reason, "skipped_thinking");
  assert.equal(classifyPersistedMessage({
    chatId: "c", sender: "ai", content: '<tool_X name="read">args</tool_X>', displayMode: "NORMAL", completedAt: 2,
  }).reason, "skipped_tool");
});

test("assistant persistence removes Operit thinking, tool, result, and status markup", () => {
  const content = [
    "<think>private reasoning</think>",
    "Checking the project.",
    '<tool_NVW6 name="read_file"><path>/tmp/a</path></tool_NVW6>',
    '<tool_result_NVW6 name="read_file" status="success"><content>secret output</content></tool_result_NVW6>',
    '<status type="progress">running</status>',
    "<thinking>more private reasoning</thinking>",
    "Final answer.",
  ].join("\n");
  const analysis = analyzeAssistantContent(content);
  assert.equal(analysis.hadThinking, true);
  assert.equal(analysis.hadTool, true);
  assert.equal(analysis.hadSystem, true);
  assert.equal(analysis.content, "Checking the project.\n\nFinal answer.");
  assert.equal(
    contentForPersistedMessage({ chatId: "c", content }, "assistant"),
    analysis.content
  );
  assert.doesNotMatch(analysis.content, /private reasoning|secret output|<tool|<status/i);
});

class DurableApi {
  constructor() {
    this.messages = [];
    this.addCalls = 0;
    this.failAfterWrite = false;
  }

  async getMessageLedger() {
    return {
      sourceKeys: this.messages.map((message) => message.sourceKey),
      legacyKeys: [],
    };
  }

  async addMessage(chatId, role, content, sourceKey) {
    this.addCalls += 1;
    if (!this.messages.some((message) => message.sourceKey === sourceKey)) {
      this.messages.push({ chatId, role, content, sourceKey });
    }
    if (this.failAfterWrite) {
      this.failAfterWrite = false;
      throw new Error("response lost after commit");
    }
    return 1;
  }

  status() {
    return { configured: true };
  }
}

function finalAssistant(completedAt = 200) {
  return {
    chatId: "durable-chat",
    sender: "ai",
    roleName: "Operit",
    content: "stable final response",
    timestamp: 90,
    sentAt: 100,
    completedAt,
    displayMode: "NORMAL",
    selectedVariantIndex: 0,
  };
}

test("tool-loop snapshots produce one clean final assistant message", async () => {
  configure();
  const api = new DurableApi();
  const controller = new HonchoController(() => api);
  const base = {
    chatId: "tool-loop-chat",
    sender: "ai",
    roleName: "Operit",
    timestamp: 500,
    sentAt: 600,
    displayMode: "NORMAL",
    selectedVariantIndex: 0,
  };
  controller.queuePersistedMessage({
    ...base,
    completedAt: 0,
    content: "<think>first thought</think>",
  });
  controller.queuePersistedMessage({
    ...base,
    completedAt: 0,
    content: '<think>first thought</think><tool_A name="read">args</tool_A>',
  });
  controller.queuePersistedMessage({
    ...base,
    completedAt: 700,
    content: [
      "<think>first thought</think>",
      '<tool_A name="read">args</tool_A>',
      '<tool_result_A name="read" status="success">output</tool_result_A>',
      "Final visible answer.",
    ].join("\n"),
  });
  await controller.flushAll();

  assert.equal(api.messages.length, 1);
  assert.equal(api.messages[0].content, "Final visible answer.");
  assert.equal(controller.status().skipped_incomplete, 2);
});

test("message metadata reconciliation survives controller reloads and changing completedAt", async () => {
  configure();
  const api = new DurableApi();
  const first = new HonchoController(() => api);
  first.queuePersistedMessage(finalAssistant(200));
  await first.flushAll();
  assert.equal(api.messages.length, 1);

  const reloaded = new HonchoController(() => api);
  reloaded.queuePersistedMessage(finalAssistant(999));
  await reloaded.flushAll();
  assert.equal(api.messages.length, 1);
  const status = reloaded.status();
  assert.equal(status.duplicate_skipped, 1);
  assert.equal(status.reconciled, 1);
});

test("changing the session strategy isolates message reconciliation ledgers", async () => {
  configure({ HONCHO_SESSION_STRATEGY: "per-chat" });
  const buckets = new Map();
  const controller = new HonchoController((config) => {
    const bucket = buckets.get(config.sessionStrategy) || [];
    buckets.set(config.sessionStrategy, bucket);
    return {
      async getMessageLedger() {
        return { sourceKeys: bucket.map((message) => message.sourceKey), legacyKeys: [] };
      },
      async addMessage(chatId, role, content, sourceKey) {
        bucket.push({ chatId, role, content, sourceKey });
        return 1;
      },
      status() {
        return { configured: true };
      },
    };
  });

  controller.queuePersistedMessage(finalAssistant());
  await controller.flushAll();
  env.HONCHO_SESSION_STRATEGY = "global";
  controller.queuePersistedMessage(finalAssistant());
  await controller.flushAll();

  assert.equal(buckets.get("per-chat").length, 1);
  assert.equal(buckets.get("global").length, 1);
});

test("an unknown write result reconciles before retrying", async () => {
  configure();
  const api = new DurableApi();
  api.failAfterWrite = true;
  const controller = new HonchoController(() => api);
  controller.queuePersistedMessage(finalAssistant());
  await controller.flushAll();

  assert.equal(api.messages.length, 1);
  assert.equal(api.addCalls, 1);
  assert.equal(controller.status().pending_messages, 0);
});

test("Honcho message writes include stable per-chunk source metadata", async () => {
  configure({ HONCHO_MESSAGE_MAX_CHARS: "1000" });
  const requests = [];
  const api = new HonchoApi(loadConfig(), async (request) => {
    requests.push(request);
    return { statusCode: 200, content: request.url.includes("/messages/list") ? "{\"items\":[]}" : "{}" };
  });
  await api.addMessage("chat", "assistant", "x".repeat(2200), "operit:v1:source", {
    sentAt: 123,
    variantIndex: 2,
  });
  const request = requests.find((item) => item.url.endsWith("/messages"));
  assert.equal(request.body.messages.length, 3);
  assert.deepEqual(
    request.body.messages.map((message) => message.metadata.operit.source_key),
    [
      "operit:v1:source:chunk:1/3",
      "operit:v1:source:chunk:2/3",
      "operit:v1:source:chunk:3/3",
    ]
  );
  assert.ok(request.body.messages.every((message) =>
    message.metadata.operit.source_message_key === "operit:v1:source"
  ));
});

test("explicit conclusions are exact-idempotent within observer, observed, and session scope", async () => {
  configure();
  const requests = [];
  let listed = [{
    id: "existing",
    content: "Known fact",
    observer_id: "operit",
    observed_id: "user",
  }];
  const api = new HonchoApi(loadConfig(), async (request) => {
    requests.push(request);
    if (request.url.includes("/conclusions/list")) {
      return { statusCode: 200, content: JSON.stringify({ items: listed }) };
    }
    if (request.url.endsWith("/conclusions")) {
      return { statusCode: 200, content: JSON.stringify([{ id: "created", ...request.body.conclusions[0] }]) };
    }
    return { statusCode: 200, content: "{}" };
  });

  const existing = await api.createConclusionIdempotent("chat", "  Known fact\n", "user");
  assert.equal(existing.created, false);
  assert.equal(existing.conclusion.id, "existing");

  listed = [];
  const created = await api.createConclusionIdempotent("chat", "New fact", "user");
  assert.equal(created.created, true);
  assert.equal(created.conclusion.id, "created");
  assert.throws(
    () => api.resolvePeer("operit_chat_1234abcd"),
    /INVALID_PEER_ID/
  );
  assert.equal(requests.filter((request) => request.url.endsWith("/conclusions")).length, 1);
});

class MemorySidecarStorage {
  constructor() {
    this.files = new Map();
    this.modified = new Map();
    this.quarantined = [];
    this.failWrites = false;
    this.clock = 0;
  }

  async read(path) {
    return this.files.get(path) || null;
  }

  async writeAtomic(path, content) {
    if (this.failWrites) throw new Error("disk full");
    this.files.set(path, content);
    this.clock += 1;
    this.modified.set(path, this.clock);
  }

  async quarantine(path) {
    this.quarantined.push(path);
    this.files.delete(path);
    this.modified.delete(path);
  }

  async list(root) {
    return Array.from(this.files.entries())
      .filter(([path]) => path.startsWith(root + "/"))
      .map(([path, content]) => ({
        path,
        size: Buffer.byteLength(content, "utf8"),
        lastModified: this.modified.get(path) || 0,
      }));
  }

  async remove(path) {
    this.files.delete(path);
    this.modified.delete(path);
  }

  async clear(root) {
    for (const path of Array.from(this.files.keys())) {
      if (path.startsWith(root + "/")) await this.remove(path);
    }
  }
}

test("prompt sidecars persist exact API user content and restore it after reload", async () => {
  const storage = new MemorySidecarStorage();
  const history = [{ kind: "SYSTEM", content: "stable system" }];
  let fetches = 0;
  const firstStore = new PromptSidecarStore(storage, "/sidecars", () => 1000);
  const firstRequest = await firstStore.injectCurrent("chat", history, "hello", async (clean) => {
    fetches += 1;
    return injectMemoryContext(clean, "remembered context");
  });
  assert.match(firstRequest, /remembered context/);

  const retry = await firstStore.injectCurrent("chat", history, "hello", async () => {
    fetches += 1;
    return null;
  });
  assert.equal(retry, firstRequest);
  assert.equal(fetches, 1);

  const reloadedStore = new PromptSidecarStore(storage, "/sidecars", () => 2000);
  const restored = await reloadedStore.restoreHistory("chat", [
    ...history,
    { kind: "USER", content: "hello" },
    { kind: "ASSISTANT", content: "response" },
  ]);
  assert.equal(restored[1].content, firstRequest);
  assert.equal(restored[2].content, "response");
});

test("prompt sidecars fail open on corrupt files and do not inject when persistence fails", async () => {
  const corrupt = new MemorySidecarStorage();
  corrupt.files.set("/sidecars/" + sha256("chat").slice(0, 32) + ".json", "{bad json");
  const corruptStore = new PromptSidecarStore(corrupt, "/sidecars");
  const untouched = [{ kind: "USER", content: "clean" }];
  assert.deepEqual(await corruptStore.restoreHistory("chat", untouched), untouched);
  assert.equal(corrupt.quarantined.length, 1);

  const failing = new MemorySidecarStorage();
  failing.failWrites = true;
  const failingStore = new PromptSidecarStore(failing, "/sidecars");
  const result = await failingStore.injectCurrent("chat", [], "hello", async (clean) =>
    injectMemoryContext(clean, "must persist first")
  );
  assert.equal(result, null);
});

test("prompt sidecars merge concurrent retries for the same turn", async () => {
  const storage = new MemorySidecarStorage();
  const store = new PromptSidecarStore(storage, "/sidecars", () => 1000);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  const inject = async (clean) => {
    fetches += 1;
    await gate;
    return injectMemoryContext(clean, "shared memory");
  };

  const first = store.injectCurrent("chat", [], "hello", inject);
  await Promise.resolve();
  const second = store.injectCurrent("chat", [], "hello", inject);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(fetches, 1);
  assert.equal(firstResult, secondResult);
  assert.match(firstResult, /shared memory/);
});

test("prompt sidecars enforce byte limits, evict old files, and clear private storage", async () => {
  const storage = new MemorySidecarStorage();
  let now = 1000;
  const store = new PromptSidecarStore(storage, "/sidecars", () => now, {
    maxTotalBytes: 800,
    maxFileBytes: 700,
  });
  const memory = "x".repeat(80);
  assert.ok(await store.injectCurrent("old-chat", [], "old", async (clean) =>
    injectMemoryContext(clean, memory)
  ));
  now = 2000;
  assert.ok(await store.injectCurrent("new-chat", [], "new", async (clean) =>
    injectMemoryContext(clean, memory)
  ));

  const oldPath = "/sidecars/" + sha256("old-chat").slice(0, 32) + ".json";
  const newPath = "/sidecars/" + sha256("new-chat").slice(0, 32) + ".json";
  const statistics = await store.statistics();
  assert.equal(storage.files.has(oldPath), false);
  assert.equal(storage.files.has(newPath), true);
  assert.equal(statistics.fileCount, 1);
  assert.ok(statistics.totalBytes <= 800);

  const cleared = await store.clearAll();
  assert.equal(cleared.fileCount, 1);
  assert.equal((await store.statistics()).fileCount, 0);
});

test("prompt sidecars refuse an injection that cannot fit the per-file limit", async () => {
  const storage = new MemorySidecarStorage();
  const store = new PromptSidecarStore(storage, "/sidecars", () => 1000, {
    maxTotalBytes: 1024,
    maxFileBytes: 180,
  });
  const result = await store.injectCurrent("chat", [], "hello", async (clean) =>
    injectMemoryContext(clean, "x".repeat(500))
  );
  assert.equal(result, null);
  assert.equal(storage.files.size, 0);
});