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

const { loadConfig, isConfigured } = require("../dist/config");
const { HonchoApi, sanitizeId, sessionIdFor } = require("../dist/api");
const { HonchoController, resolveRole } = require("../dist/controller");
const {
  legacyWorkspaceIdentity,
  metadataWithWorkspaceIdentity,
  workspaceIdentity,
} = require("../dist/identity");
const {
  formatMemoryContext,
  injectMemoryContext,
  sanitizeMemoryContext,
  truncateAtWord,
} = require("../dist/format");

test("configuration requires a key or an explicit self-hosted URL", () => {
  configure({ HONCHO_BASE_URL: "", HONCHO_ENABLED: "" });
  assert.equal(isConfigured(loadConfig()), false);

  configure({ HONCHO_API_KEY: "secret", HONCHO_BASE_URL: "" });
  const cloud = loadConfig();
  assert.equal(cloud.baseUrl, "https://api.honcho.dev");
  assert.equal(isConfigured(cloud), true);

  configure();
  assert.equal(isConfigured(loadConfig()), true);
});

test("formatting sanitizes leaked memory blocks and respects budgets", () => {
  const injected = injectMemoryContext("hello", "## Session Summary\nknown fact");
  assert.match(injected, /<memory-context>/);
  assert.equal(sanitizeMemoryContext(injected), "hello");
  assert.match(formatMemoryContext({ summary: "summary", card: ["fact"] }, "relevant"), /User Peer Card/);
  assert.ok(truncateAtWord("one two three four", 12).length <= 12);
});

test("IDs are valid, deterministic, and capped at Honcho's 100 character limit", () => {
  const config = loadConfig();
  const first = sessionIdFor(config, `chat:${"x".repeat(300)}`);
  const second = sessionIdFor(config, `chat:${"x".repeat(299)}y`);
  assert.ok(first.length <= 100);
  assert.ok(second.length <= 100);
  assert.notEqual(first, second);
  assert.equal(sanitizeId(" a peer/id ", "peer"), "a_peer_id");
});

test("workspace identity metadata overrides legacy config and preserves unrelated metadata", () => {
  const legacy = legacyWorkspaceIdentity("legacy user", "legacy ai");
  assert.equal(legacy.source, "legacy_config");
  assert.equal(legacy.migrationRequired, true);

  const metadata = metadataWithWorkspaceIdentity({ owner: "kept" }, "primary_user", "primary_ai", 2);
  const resolved = workspaceIdentity(metadata, legacy);
  assert.equal(metadata.owner, "kept");
  assert.equal(resolved.userPeerId, "primary_user");
  assert.equal(resolved.aiPeerId, "primary_ai");
  assert.equal(resolved.revision, 3);
  assert.equal(resolved.source, "workspace_metadata");
  assert.equal(resolved.migrationRequired, false);
  assert.throws(
    () => metadataWithWorkspaceIdentity({}, "same", "same", 0),
    /must be different/
  );
});

test("REST identity resolution validates metadata peers and never creates custom peers", async () => {
  configure({ HONCHO_USER_PEER: "legacy_user", HONCHO_AI_PEER: "legacy_ai" });
  const requests = [];
  let workspaceMetadata = {
    owner: "kept",
    operit_honcho: {
      schema_version: 1,
      revision: 4,
      active_user_peer_id: "primary_user",
      active_ai_peer_id: "primary_ai",
    },
  };
  const peerMetadata = {
    primary_user: { operit_honcho: { display_name: "Owner" } },
    primary_ai: { operit_honcho: { display_name: "Assistant" } },
    next_user: { operit_honcho: { display_name: "Next Owner" } },
    next_ai: { operit_honcho: { display_name: "Next Assistant" } },
  };
  const transport = async (request) => {
    requests.push(request);
    if (request.method === "POST" && request.url.includes("/v3/workspaces/list")) {
      return {
        statusCode: 200,
        content: JSON.stringify({ items: [{ id: "operit", metadata: workspaceMetadata }], total: 1, page: 1, size: 2, pages: 1 }),
      };
    }
    if (request.method === "POST" && request.url.endsWith("/v3/workspaces")) {
      return { statusCode: 200, content: JSON.stringify({ id: "operit", metadata: workspaceMetadata }) };
    }
    if (request.method === "POST" && request.url.includes("/peers/list")) {
      const id = request.body?.filters?.id;
      const items = peerMetadata[id] ? [{ id, metadata: peerMetadata[id] }] : [];
      return {
        statusCode: 200,
        content: JSON.stringify({ items, total: items.length, page: 1, size: 2, pages: items.length ? 1 : 0 }),
      };
    }
    if (request.method === "PUT" && request.url.endsWith("/v3/workspaces/operit")) {
      workspaceMetadata = request.body.metadata;
      return { statusCode: 200, content: JSON.stringify({ id: "operit", metadata: workspaceMetadata }) };
    }
    return { statusCode: 200, content: "{}" };
  };

  const api = new HonchoApi(loadConfig(), transport);
  const identity = await api.getWorkspaceIdentity();
  assert.equal(identity.userPeerId, "primary_user");
  assert.equal(identity.aiPeerId, "primary_ai");
  assert.equal(identity.revision, 4);
  assert.deepEqual(await api.resolvePeerDetails("user"), { id: "primary_user", displayName: "Owner" });
  const requestCount = requests.length;
  const readOnlyIdentity = await api.getWorkspaceIdentityReadOnly();
  assert.equal(readOnlyIdentity.revision, 4);
  assert.equal(
    requests.slice(requestCount).some((request) => request.url.endsWith("/v3/workspaces")),
    false
  );
  await assert.rejects(() => api.resolvePeerDetails("missing_peer"), /PEER_NOT_FOUND/);
  assert.equal(
    requests.some((request) => request.url.endsWith("/peers") && request.body?.id === "missing_peer"),
    false
  );

  const updated = await api.setWorkspaceIdentity("next_user", "next_ai");
  assert.equal(updated.revision, 5);
  assert.equal(updated.userPeerId, "next_user");
  assert.equal(workspaceMetadata.owner, "kept");
});

test("REST client initializes resources, chunks messages, and maps context", async () => {
  configure({ HONCHO_MESSAGE_MAX_CHARS: "1000" });
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (request.method === "GET" && request.url.includes("/sessions/") && request.url.includes("/context")) {
      return {
        statusCode: 200,
        content: JSON.stringify({
          summary: { content: "session summary" },
          peer_representation: "user representation",
          peer_card: ["likes concise answers"],
          messages: [
            { peer_id: "user", content: "hello" },
            { peer_id: "operit", content: "hi" },
          ],
        }),
      };
    }
    if (request.method === "GET" && request.url.includes("/peers/operit/context")) {
      return {
        statusCode: 200,
        content: JSON.stringify({ representation: "assistant representation", peer_card: ["helpful"] }),
      };
    }
    if (request.method === "POST" && request.url.includes("/peers/list")) {
      const id = request.body?.filters?.id;
      const items = id === "custom_peer"
        ? [{ id: "custom_peer", metadata: { operit_honcho: { display_name: "Custom" } } }]
        : [];
      return {
        statusCode: 200,
        content: JSON.stringify({ items, total: items.length, page: 1, size: 2, pages: items.length ? 1 : 0 }),
      };
    }
    if (request.method === "POST" && request.url.endsWith("/search")) {
      return {
        statusCode: 200,
        content: JSON.stringify([
          {
            id: "message-1",
            content: "matching memory",
            peer_id: "custom_peer",
            session_id: "session-1",
          },
        ]),
      };
    }
    return { statusCode: 200, content: "{}" };
  };

  const api = new HonchoApi(loadConfig(), transport);
  const sent = await api.addMessage("chat-1", "user", "x".repeat(2501));
  assert.equal(sent, 3);
  const messageRequest = requests.find((request) => request.url.endsWith("/messages"));
  assert.equal(messageRequest.body.messages.length, 3);
  assert.ok(messageRequest.body.messages.every((message) => message.content.length <= 1000));

  const context = await api.getContext("chat-1", "current query");
  assert.equal(context.summary, "session summary");
  assert.equal(context.representation, "user representation");
  assert.deepEqual(context.card, ["likes concise answers"]);
  assert.equal(context.aiRepresentation, "assistant representation");
  assert.equal(context.recentMessages[1].role, "assistant");

  await api.getProfile("custom peer");
  assert.ok(requests.some((request) => request.url.includes("/peers/list") && request.body?.filters?.id === "custom_peer"));
  assert.equal(requests.some((request) => request.url.endsWith("/peers") && request.body?.id === "custom_peer"), false);

  const searchResult = await api.search("memory query", 400, "custom peer");
  const searchRequest = requests.find((request) => request.url.endsWith("/search"));
  assert.deepEqual(searchRequest.body.filters, { peer_id: "custom_peer" });
  assert.match(searchResult, /\[custom_peer · session-1\] matching memory/);
});

class FakeApi {
  constructor() {
    this.messages = [];
    this.contextCalls = 0;
    this.reasonCalls = 0;
    this.failWrites = 0;
  }

  async resolvePeerDetails(peer) {
    return { id: peer === "user" ? "primary_user" : peer, displayName: "Owner" };
  }

  async search() {
    return "matching memory";
  }

  async addMessage(chatId, role, content, sourceKey) {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("temporary failure");
    }
    this.messages.push({ chatId, role, content, sourceKey });
    return 1;
  }

  async getMessageLedger() {
    return {
      sourceKeys: this.messages.map((message) => message.sourceKey).filter(Boolean),
      legacyKeys: [],
    };
  }

  async getContext() {
    this.contextCalls += 1;
    return { summary: "prior session", card: ["prefers direct answers"] };
  }

  async reason() {
    this.reasonCalls += 1;
    return "Current project context";
  }

  status() {
    return { configured: true };
  }
}

test("controller injects context, resolves roles, and deduplicates persisted messages", async () => {
  configure();
  const fake = new FakeApi();
  const controller = new HonchoController(() => fake);

  assert.equal(resolveRole("assistant", ""), "assistant");
  assert.equal(resolveRole("", "human"), "user");
  assert.equal(resolveRole("system", ""), null);

  const input = await controller.injectForPrompt("chat-1", "Continue the project");
  assert.match(input, /prior session/);
  assert.match(input, /Current project context/);
  assert.equal(fake.contextCalls, 1);
  assert.equal(fake.reasonCalls, 1);

  const persisted = {
    chatId: "chat-1",
    roleName: "user",
    content: `${input}`,
    timestamp: 10,
    completedAt: 11,
  };
  controller.queuePersistedMessage(persisted);
  controller.queuePersistedMessage(persisted);
  await controller.flushAll();
  assert.equal(fake.messages.length, 1);
  assert.equal(fake.messages[0].content, "Continue the project");
});

test("controller tool responses report the resolved Workspace peer", async () => {
  configure();
  const controller = new HonchoController(() => new FakeApi());
  const result = await controller.call("search", { query: "memory", peer: "user" });
  assert.equal(result.resolved_peer_id, "primary_user");
  assert.equal(result.resolved_peer_name, "Owner");
  assert.equal(result.result, "matching memory");
});

test("failed writes remain queued and can be retried without blocking later messages", async () => {
  configure();
  const fake = new FakeApi();
  fake.failWrites = 2;
  const controller = new HonchoController(() => fake);

  controller.queuePersistedMessage({
    chatId: "retry-chat",
    roleName: "user",
    content: "first",
    timestamp: 1,
  });
  await controller.flushAll();
  let status = await controller.call("status", {});
  assert.equal(status.pending_messages, 1);

  controller.queuePersistedMessage({
    chatId: "retry-chat",
    roleName: "assistant",
    content: "second",
    timestamp: 2,
    completedAt: 3,
    displayMode: "NORMAL",
  });
  await controller.flushAll();
  status = await controller.call("status", {});
  assert.equal(status.pending_messages, 0);
  assert.deepEqual(fake.messages.map((message) => message.content).sort(), ["first", "second"]);
});

test("compiled subpackage tools return structured errors when Honcho is not configured", async () => {
  configure({ HONCHO_BASE_URL: "", HONCHO_ENABLED: "", HONCHO_API_KEY: "" });
  const tools = require("../dist/packages/honcho");
  const result = await tools.honcho_profile({});
  assert.equal(result.success, false);
  assert.match(result.error, /not configured/i);
});

test("ToolPkg main registers IPC at module load and installs hooks without rebinding it", () => {
  configure();
  const registered = {};
  let ipcRegistrations = 0;
  global.ToolPkg = {
    registerUiRoute: (definition) => { registered.ui = definition; },
    registerNavigationEntry: (definition) => { registered.navigation = definition; },
    registerChatMessageHook: (definition) => { registered.chat = definition; },
    registerPromptHistoryHook: (definition) => { registered.history = definition; },
    registerPromptEstimateHistoryHook: (definition) => { registered.estimateHistory = definition; },
    registerSystemPromptComposeHook: (definition) => { registered.system = definition; },
    registerPromptFinalizeHook: (definition) => { registered.finalize = definition; },
    registerAppLifecycleHook: (definition) => { registered.lifecycle = definition; },
    ipc: {
      on: (channel, handler) => {
        ipcRegistrations += 1;
        registered.ipc = { channel, handler };
        return () => {};
      },
    },
  };

  const main = require("../dist/main");
  assert.equal(ipcRegistrations, 1);
  assert.equal(main.registerToolPkg(), true);
  assert.equal(ipcRegistrations, 1);
  assert.equal(registered.chat.id, "honcho_message_persisted");
  assert.equal(registered.history.id, "honcho_restore_memory_history");
  assert.equal(registered.estimateHistory.id, "honcho_restore_memory_estimate_history");
  assert.equal(registered.finalize.id, "honcho_memory_context");
  assert.equal(registered.lifecycle.event, "application_on_terminate");
  assert.equal(registered.ipc.channel, "honcho.explorer.request");
  assert.equal(registered.ui.id, "honcho_explore");
  assert.equal(registered.ui.runtime, "compose_dsl");
  assert.equal(registered.ui.keepAlive, undefined);
  assert.equal(registered.navigation.surface, "main_sidebar_plugins");
  assert.equal(registered.navigation.route, registered.ui.route);

  const result = registered.system.function({
    eventName: "after_compose_system_prompt",
    eventPayload: { stage: "after_compose_system_prompt", functionType: "CHAT", systemPrompt: "base" },
  });
  assert.match(result.systemPrompt, /Honcho memory is active in hybrid mode/);
});