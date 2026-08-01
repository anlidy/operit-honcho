const test = require("node:test");
const assert = require("node:assert/strict");

const env = {
  HONCHO_BASE_URL: "http://localhost:8000",
  HONCHO_ENABLED: "true",
  HONCHO_WORKSPACE: "active",
};
global.getEnv = (key) => env[key] || "";

const { loadConfig } = require("../dist/config");
const { HonchoApi, HonchoHttpError } = require("../dist/api");

function page(items, overrides = {}) {
  return JSON.stringify({ items, total: items.length, page: 1, size: 20, pages: 1, ...overrides });
}

test("Explorer API uses read-only v3 list endpoints and server pagination", async () => {
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (request.url.includes("/workspaces/list")) {
      return { statusCode: 200, content: page([{ id: "space/id", created_at: "2026-01-01T00:00:00Z" }]) };
    }
    if (request.url.includes("/peers/list")) {
      return { statusCode: 200, content: page([{ id: "peer-1", workspace_id: "space/id" }], { total: 25, pages: 2 }) };
    }
    if (request.url.includes("/sessions/") && request.url.includes("/messages/list")) {
      return { statusCode: 200, content: page([{ id: "message-1", content: "hello" }]) };
    }
    if (request.url.includes("/sessions/list")) {
      return { statusCode: 200, content: page([{ id: "session/id", is_active: true }]) };
    }
    if (request.url.includes("/conclusions/list")) {
      return { statusCode: 200, content: page([{ id: "conclusion-1", content: "known" }]) };
    }
    if (request.url.endsWith("/queue/status")) {
      return {
        statusCode: 200,
        content: JSON.stringify({
          total_work_units: 3,
          completed_work_units: 1,
          in_progress_work_units: 1,
          pending_work_units: 1,
        }),
      };
    }
    return { statusCode: 404, content: "not found" };
  };

  const api = new HonchoApi(loadConfig(), transport);
  const workspaces = await api.listWorkspaces(2, 10, false);
  const peers = await api.listPeers("space/id", 2, 20, true);
  const sessions = await api.listSessions("space/id", 1, 20, true);
  const messages = await api.listMessages("space/id", "session/id", 1, 30, false);
  const conclusions = await api.listConclusionsGeneric("space/id", 1, 20, false);
  const queue = await api.getQueueStatus("space/id");

  assert.equal(workspaces.items[0].id, "space/id");
  assert.equal(peers.total, 25);
  assert.equal(sessions.items[0].id, "session/id");
  assert.equal(messages.items[0].content, "hello");
  assert.equal(conclusions.items[0].id, "conclusion-1");
  assert.equal(queue.pending_work_units, 1);

  assert.ok(requests.some((request) =>
    request.method === "POST" &&
    request.url === "http://localhost:8000/v3/workspaces/list?page=2&size=10&reverse=false" &&
    JSON.stringify(request.body) === "{}"
  ));
  assert.ok(requests.some((request) =>
    request.url.includes("/v3/workspaces/space%2Fid/peers/list?page=2&size=20&reverse=true")
  ));
  assert.ok(requests.some((request) =>
    request.url.includes("/sessions/session%2Fid/messages/list?page=1&size=30&reverse=false")
  ));
  assert.ok(requests.some((request) => request.method === "GET" && request.url.endsWith("/queue/status")));
  assert.equal(requests.some((request) => request.url.includes("/v3/workspaces/space%2Fid") && !request.url.includes("/list") && request.method === "POST"), false);
});

test("Honcho HTTP errors retain status for Explorer error mapping", async () => {
  const api = new HonchoApi(loadConfig(), async () => ({ statusCode: 403, content: '{"detail":"scoped key"}' }));
  await assert.rejects(
    () => api.listPeers("test", 1, 20, true),
    (error) => error instanceof HonchoHttpError && error.status === 403 && /scoped key/.test(error.message)
  );
});