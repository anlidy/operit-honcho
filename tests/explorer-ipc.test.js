const test = require("node:test");
const assert = require("node:assert/strict");

global.getEnv = () => "";

const { HonchoHttpError } = require("../dist/api");
const { loadConfig } = require("../dist/config");
const { ExplorerService } = require("../dist/explorer/service");
const { parseExplorerRequest } = require("../dist/explorer/validation");

function config(workspace = "test") {
  return {
    ...loadConfig(),
    enabled: true,
    baseUrl: "http://localhost:8000",
    workspace,
  };
}

function status(workspace = "test") {
  return {
    enabled: true,
    configured: true,
    api_key_set: false,
    base_url: "http://localhost:8000",
    workspace,
    user_peer: "user",
    ai_peer: "operit",
    recall_mode: "hybrid",
    observation_mode: "directional",
    session_strategy: "per-chat",
    save_messages: true,
    pending_messages: 2,
    active_writes: 1,
    last_write_error: "",
  };
}

function emptyPage(size = 20) {
  return { items: [], total: 0, page: 1, size, pages: 0 };
}

class FakeApi {
  constructor() {
    this.calls = [];
    this.peerError = null;
    this.queueError = null;
  }

  async listWorkspaces(page, size, reverse) {
    this.calls.push(["workspaces", page, size, reverse]);
    return { items: [{ id: "test" }], total: 1, page, size, pages: 1 };
  }

  async listPeers(workspace, page, size, reverse) {
    this.calls.push(["peers", workspace, page, size, reverse]);
    if (this.peerError) throw this.peerError;
    return { items: [{ id: "peer-1" }], total: 1, page, size, pages: 1 };
  }

  async listSessions(workspace, page, size, reverse) {
    this.calls.push(["sessions", workspace, page, size, reverse]);
    return emptyPage(size);
  }

  async listMessages(workspace, session, page, size, reverse) {
    this.calls.push(["messages", workspace, session, page, size, reverse]);
    return emptyPage(size);
  }

  async listConclusionsGeneric(workspace, page, size, reverse) {
    this.calls.push(["conclusions", workspace, page, size, reverse]);
    return emptyPage(size);
  }

  async getQueueStatus(workspace) {
    this.calls.push(["queue", workspace]);
    if (this.queueError) throw this.queueError;
    return {
      total_work_units: 4,
      completed_work_units: 1,
      in_progress_work_units: 1,
      pending_work_units: 2,
    };
  }
}

test("Explorer request validation enforces operation allowlist and bounded pagination", () => {
  assert.throws(
    () => parseExplorerRequest({ op: "request_url", requestId: "1", params: {} }),
    /Unknown Explorer operation/
  );
  assert.throws(
    () => parseExplorerRequest({ op: "list_peers", requestId: "1", params: { size: 101 } }),
    /size must be an integer/
  );
  assert.throws(
    () => parseExplorerRequest({ op: "list_messages", requestId: "1", params: {} }),
    /sessionId is required/
  );
});

test("Explorer service routes validated paging requests without changing active workspace", async () => {
  const fakeApi = new FakeApi();
  const controller = {
    getConfig: () => config("active"),
    status: () => status("active"),
  };
  const service = new ExplorerService(controller, () => fakeApi);
  const response = await service.handle({
    op: "list_peers",
    requestId: "peer-page",
    workspaceId: "browsing/workspace",
    params: { page: 3, size: 10, reverse: false },
  });

  assert.equal(response.ok, true);
  assert.equal(response.requestId, "peer-page");
  assert.deepEqual(fakeApi.calls[0], ["peers", "browsing/workspace", 3, 10, false]);
  assert.equal(controller.getConfig().workspace, "active");
});

test("Explorer status is available with partial queue errors and never exposes the API key", async () => {
  const fakeApi = new FakeApi();
  fakeApi.queueError = new HonchoHttpError(403, '{"detail":"scope"}');
  const controller = {
    getConfig: () => ({ ...config(), apiKey: "should-not-leak" }),
    status: () => ({ ...status(), api_key_set: true }),
  };
  const service = new ExplorerService(controller, () => fakeApi);
  const response = await service.handle({ op: "status", requestId: "status-1" });

  assert.equal(response.ok, true);
  assert.equal(response.data.api_key_set, true);
  assert.equal(response.data.server_queue_error.code, "PERMISSION_DENIED");
  assert.equal(JSON.stringify(response).includes("should-not-leak"), false);
});

test("Explorer maps scoped-key failures to structured IPC errors", async () => {
  const fakeApi = new FakeApi();
  fakeApi.peerError = new HonchoHttpError(403, '{"detail":"forbidden"}');
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  const response = await service.handle({ op: "list_peers", requestId: "denied", params: {} });

  assert.equal(response.ok, false);
  assert.deepEqual(
    { code: response.error.code, status: response.error.status, retryable: response.error.retryable },
    { code: "PERMISSION_DENIED", status: 403, retryable: false }
  );
});