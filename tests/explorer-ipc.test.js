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
    this.identity = {
      workspaceId: "test",
      userPeerId: "owner",
      aiPeerId: "assistant",
      source: "workspace_metadata",
      schemaVersion: 1,
      revision: 3,
      migrationRequired: false,
    };
    this.peers = new Map([
      ["owner", { id: "owner", workspace_id: "test", metadata: { operit_honcho: { display_name: "Owner" } } }],
      ["assistant", { id: "assistant", workspace_id: "test", metadata: { operit_honcho: { display_name: "Assistant" } } }],
      ["next_owner", { id: "next_owner", workspace_id: "test", metadata: {} }],
      ["next_assistant", { id: "next_assistant", workspace_id: "test", metadata: {} }],
      ["peer-1", { id: "peer-1", workspace_id: "test", metadata: { owner: "kept", operit_honcho: { display_name: "Peer One", archived: false } } }],
    ]);
    this.peerSessions = new Map([["peer-1", [{ id: "session-1", workspace_id: "test" }]]]);
    this.conclusions = [
      {
        id: "conclusion-1",
        content: "Duplicate fact",
        observer_id: "assistant",
        observed_id: "owner",
        session_id: "session-1",
        level: "explicit",
        created_at: "2026-08-01T01:00:00Z",
      },
      {
        id: "conclusion-2",
        content: "  Duplicate   fact  ",
        observer_id: "assistant",
        observed_id: "owner",
        session_id: "session-1",
        level: "explicit",
        created_at: "2026-08-01T02:00:00Z",
      },
      {
        id: "conclusion-3",
        content: "Duplicate fact",
        observer_id: "assistant",
        observed_id: "owner",
        session_id: "session-1",
        level: "explicit",
        created_at: "2026-08-01T03:00:00Z",
      },
      {
        id: "conclusion-4",
        content: "Reverse direction",
        observer_id: "owner",
        observed_id: "assistant",
        level: "deductive",
        created_at: "2026-08-01T04:00:00Z",
      },
    ];
    this.conclusionDeleteErrors = new Map();
  }

  async getWorkspaceIdentityReadOnly() {
    this.calls.push(["identity"]);
    return { ...this.identity };
  }

  async listWorkspaces(page, size, reverse) {
    this.calls.push(["workspaces", page, size, reverse]);
    return { items: [{ id: "test" }], total: 1, page, size, pages: 1 };
  }

  async listPeers(workspace, page, size, reverse, filters) {
    this.calls.push(filters
      ? ["peers", workspace, page, size, reverse, filters]
      : ["peers", workspace, page, size, reverse]);
    if (this.peerError) throw this.peerError;
    const id = filters?.id;
    const items = id
      ? (this.peers.has(id) ? [{ ...this.peers.get(id) }] : [])
      : Array.from(this.peers.values()).map((peer) => ({ ...peer, workspace_id: workspace }));
    return { items, total: items.length, page, size, pages: 1 };
  }

  async getPeerReadOnly(workspace, peerId) {
    this.calls.push(["peer", workspace, peerId]);
    const peer = this.peers.get(peerId);
    if (!peer) throw new HonchoHttpError(404, "missing peer");
    return { ...peer, workspace_id: workspace };
  }

  async createPeer(workspace, peerId, metadata) {
    this.calls.push(["create_peer", workspace, peerId, metadata]);
    const peer = { id: peerId, workspace_id: workspace, metadata };
    this.peers.set(peerId, peer);
    return { ...peer };
  }

  async updatePeerMetadata(workspace, peerId, metadata) {
    this.calls.push(["update_peer", workspace, peerId, metadata]);
    const peer = { ...this.peers.get(peerId), id: peerId, workspace_id: workspace, metadata };
    this.peers.set(peerId, peer);
    return { ...peer };
  }

  async listPeerSessions(workspace, peerId, page, size, reverse, filters) {
    this.calls.push(["peer_sessions", workspace, peerId, page, size, reverse, filters]);
    let items = (this.peerSessions.get(peerId) || []).map((session) => ({ ...session }));
    if (filters?.id) items = items.filter((session) => session.id === filters.id);
    return { items, total: items.length, page, size, pages: items.length ? 1 : 0 };
  }

  async getPeerCardReadOnly(workspace, observerPeerId, targetPeerId) {
    this.calls.push(["peer_card", workspace, observerPeerId, targetPeerId]);
    return [`${observerPeerId} sees ${targetPeerId}`];
  }

  async removePeerFromSession(workspace, sessionId, peerId) {
    this.calls.push(["remove_peer", workspace, sessionId, peerId]);
    this.peerSessions.set(peerId, (this.peerSessions.get(peerId) || []).filter((item) => item.id !== sessionId));
    return { id: sessionId, workspace_id: workspace };
  }

  async listSessions(workspace, page, size, reverse) {
    this.calls.push(["sessions", workspace, page, size, reverse]);
    return emptyPage(size);
  }

  async listMessages(workspace, session, page, size, reverse) {
    this.calls.push(["messages", workspace, session, page, size, reverse]);
    return emptyPage(size);
  }

  async listConclusionsGeneric(workspace, page, size, reverse, filters) {
    this.calls.push(["conclusions", workspace, page, size, reverse, filters]);
    let items = this.conclusions.map((item) => ({ ...item }));
    for (const [key, value] of Object.entries(filters || {})) {
      items = items.filter((item) => item[key] === value);
    }
    const start = (page - 1) * size;
    return {
      items: items.slice(start, start + size),
      total: items.length,
      page,
      size,
      pages: items.length ? Math.ceil(items.length / size) : 0,
    };
  }

  async queryConclusionsGeneric(workspace, query, topK, filters) {
    this.calls.push(["query_conclusions", workspace, query, topK, filters]);
    let items = this.conclusions.filter((item) =>
      item.content.toLowerCase().includes(String(query).toLowerCase())
    );
    for (const [key, value] of Object.entries(filters || {})) {
      items = items.filter((item) => item[key] === value);
    }
    return items.slice(0, topK).map((item) => ({ ...item }));
  }

  async deleteConclusionFor(workspace, id) {
    this.calls.push(["delete_conclusion", workspace, id]);
    const failure = this.conclusionDeleteErrors.get(id);
    if (failure) throw failure;
    this.conclusions = this.conclusions.filter((item) => item.id !== id);
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

  async setWorkspaceIdentity(userPeerId, aiPeerId) {
    this.calls.push(["set_identity", userPeerId, aiPeerId]);
    this.identity = {
      ...this.identity,
      userPeerId,
      aiPeerId,
      revision: this.identity.revision + 1,
      source: "workspace_metadata",
      migrationRequired: false,
    };
    return { ...this.identity };
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
  assert.throws(
    () => parseExplorerRequest({
      op: "commit_identity_update",
      requestId: "1",
      params: { userPeerId: "owner", aiPeerId: "assistant" },
    }),
    /confirmation token is required/i
  );
  assert.throws(
    () => parseExplorerRequest({
      op: "prepare_peer_mutation",
      requestId: "1",
      params: { peerMutation: "set_archived", peerId: "peer-1", archived: "false" },
    }),
    /archived must be a boolean/
  );
  assert.throws(
    () => parseExplorerRequest({
      op: "list_conclusions",
      requestId: "1",
      params: { conclusionLevel: "unknown" },
    }),
    /Unknown conclusionLevel/
  );
  assert.throws(
    () => parseExplorerRequest({
      op: "prepare_conclusion_cleanup",
      requestId: "1",
      params: { keepConclusionId: "same", deleteConclusionIds: ["same"] },
    }),
    /cannot also be deleted/
  );
  assert.throws(
    () => parseExplorerRequest({
      op: "commit_sidecar_clear",
      requestId: "1",
      params: {},
    }),
    /confirmation token is required/i
  );
});

test("Explorer Peer detail and Card preserve direction and active roles", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => ({ ...status(), user_peer: "owner", ai_peer: "assistant" }) },
    () => fakeApi
  );

  const detail = await service.handle({
    op: "get_peer",
    requestId: "peer-detail",
    workspaceId: "test",
    params: { peerId: "owner" },
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.data.display_name, "Owner");
  assert.deepEqual(detail.data.roles, ["user"]);

  const inactive = await service.handle({
    op: "get_peer",
    requestId: "peer-inactive",
    workspaceId: "archive",
    params: { peerId: "owner" },
  });
  assert.deepEqual(inactive.data.roles, []);

  const card = await service.handle({
    op: "get_peer_card",
    requestId: "peer-card",
    workspaceId: "test",
    params: { observerPeerId: "assistant", targetPeerId: "owner" },
  });
  assert.equal(card.ok, true);
  assert.deepEqual(card.data, {
    workspace_id: "test",
    observer_id: "assistant",
    target_id: "owner",
    peer_card: ["assistant sees owner"],
  });
});

test("Explorer Peer mutations require confirmation and preserve unrelated metadata", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => ({ ...status(), user_peer: "owner", ai_peer: "assistant" }) },
    () => fakeApi
  );

  const prepared = await service.handle({
    op: "prepare_peer_mutation",
    requestId: "prepare-name",
    workspaceId: "test",
    params: { peerMutation: "update_display_name", peerId: "peer-1", displayName: "Renamed" },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.data.previous_display_name, "Peer One");
  assert.match(prepared.data.confirmation_token, /^peer-/);

  const committed = await service.handle({
    op: "commit_peer_mutation",
    requestId: "commit-name",
    workspaceId: "test",
    params: {
      peerMutation: "update_display_name",
      peerId: "peer-1",
      displayName: "Renamed",
      confirmationToken: prepared.data.confirmation_token,
    },
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.data.peer.id, "peer-1");
  assert.equal(committed.data.peer.display_name, "Renamed");
  assert.equal(committed.data.peer.metadata.owner, "kept");

  const reused = await service.handle({
    op: "commit_peer_mutation",
    requestId: "reuse-name",
    workspaceId: "test",
    params: {
      peerMutation: "update_display_name",
      peerId: "peer-1",
      displayName: "Renamed",
      confirmationToken: prepared.data.confirmation_token,
    },
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, "CONFIRMATION_REQUIRED");

  const protectedArchive = await service.handle({
    op: "prepare_peer_mutation",
    requestId: "archive-owner",
    workspaceId: "test",
    params: { peerMutation: "set_archived", peerId: "owner", archived: true },
  });
  assert.equal(protectedArchive.ok, false);
  assert.equal(protectedArchive.error.code, "ACTIVE_PEER_ARCHIVE_FORBIDDEN");

  const conflictPreview = await service.handle({
    op: "prepare_peer_mutation",
    requestId: "prepare-conflict",
    workspaceId: "test",
    params: { peerMutation: "set_archived", peerId: "peer-1", archived: true },
  });
  fakeApi.peers.get("peer-1").metadata.operit_honcho.display_name = "Changed elsewhere";
  const conflict = await service.handle({
    op: "commit_peer_mutation",
    requestId: "commit-conflict",
    workspaceId: "test",
    params: {
      peerMutation: "set_archived",
      peerId: "peer-1",
      archived: true,
      confirmationToken: conflictPreview.data.confirmation_token,
    },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, "PEER_CONFLICT");
});

test("Explorer creates Peers and removes only their Session membership", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );

  const createPreview = await service.handle({
    op: "prepare_peer_mutation",
    requestId: "prepare-create",
    params: { peerMutation: "create", peerId: "new-peer", displayName: "New Peer" },
  });
  const created = await service.handle({
    op: "commit_peer_mutation",
    requestId: "commit-create",
    params: {
      peerMutation: "create",
      peerId: "new-peer",
      displayName: "New Peer",
      confirmationToken: createPreview.data.confirmation_token,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.peer.display_name, "New Peer");

  const removePreview = await service.handle({
    op: "prepare_peer_mutation",
    requestId: "prepare-remove",
    params: { peerMutation: "remove_from_session", peerId: "peer-1", sessionId: "session-1" },
  });
  const removed = await service.handle({
    op: "commit_peer_mutation",
    requestId: "commit-remove",
    params: {
      peerMutation: "remove_from_session",
      peerId: "peer-1",
      sessionId: "session-1",
      confirmationToken: removePreview.data.confirmation_token,
    },
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.data.removed, true);
  assert.ok(fakeApi.peers.has("peer-1"));
  assert.equal(fakeApi.peerSessions.get("peer-1").length, 0);
});

test("Explorer identity updates require an active-Workspace single-use confirmation", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );

  const browsingResponse = await service.handle({
    op: "prepare_identity_update",
    requestId: "wrong-workspace",
    workspaceId: "other",
    params: { userPeerId: "next_owner", aiPeerId: "next_assistant" },
  });
  assert.equal(browsingResponse.ok, false);
  assert.equal(browsingResponse.error.code, "ACTIVE_WORKSPACE_REQUIRED");

  const prepared = await service.handle({
    op: "prepare_identity_update",
    requestId: "prepare",
    workspaceId: "test",
    params: { userPeerId: "next_owner", aiPeerId: "next_assistant" },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.data.previous_revision, 3);
  assert.equal(prepared.data.proposed_revision, 4);
  assert.match(prepared.data.confirmation_token, /^identity-/);

  const committed = await service.handle({
    op: "commit_identity_update",
    requestId: "commit",
    workspaceId: "test",
    params: {
      userPeerId: "next_owner",
      aiPeerId: "next_assistant",
      confirmationToken: prepared.data.confirmation_token,
    },
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.data.user_peer, "next_owner");
  assert.equal(committed.data.ai_peer, "next_assistant");
  assert.equal(committed.data.revision, 4);
  assert.deepEqual(
    fakeApi.calls.find((call) => call[0] === "set_identity"),
    ["set_identity", "next_owner", "next_assistant"]
  );

  const reused = await service.handle({
    op: "commit_identity_update",
    requestId: "reuse",
    workspaceId: "test",
    params: {
      userPeerId: "next_owner",
      aiPeerId: "next_assistant",
      confirmationToken: prepared.data.confirmation_token,
    },
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, "CONFIRMATION_REQUIRED");
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

test("Explorer exposes resolved Workspace identity without leaking connection secrets", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  const response = await service.handle({ op: "identity_status", requestId: "identity-1" });

  assert.equal(response.ok, true);
  assert.deepEqual(response.data, {
    workspace_id: "test",
    user_peer: "owner",
    ai_peer: "assistant",
    source: "workspace_metadata",
    revision: 3,
    migration_required: false,
  });
});

test("Explorer local status never waits for queue and never exposes the API key", async () => {
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
  assert.equal(response.data.server_queue_error, undefined);
  assert.equal(fakeApi.calls.some((call) => call[0] === "queue"), false);
  assert.equal(JSON.stringify(response).includes("should-not-leak"), false);

  const queueResponse = await service.handle({ op: "queue_status", requestId: "queue-1" });
  assert.equal(queueResponse.ok, false);
  assert.equal(queueResponse.error.code, "PERMISSION_DENIED");
});

test("Explorer queue status coalesces concurrent requests and caches the result", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  const [first, second] = await Promise.all([
    service.handle({ op: "queue_status", requestId: "queue-a" }),
    service.handle({ op: "queue_status", requestId: "queue-b" }),
  ]);
  const third = await service.handle({ op: "queue_status", requestId: "queue-c" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, true);
  assert.equal(first.data.pending_work_units, 2);
  assert.equal(fakeApi.calls.filter((call) => call[0] === "queue").length, 1);
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

test("Explorer Conclusion reads map filters, semantic queries, and Peer display names", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  const filters = {
    observerPeerId: "assistant",
    targetPeerId: "owner",
    sessionId: "session-1",
    conclusionLevel: "explicit",
  };
  const listed = await service.handle({
    op: "list_conclusions",
    requestId: "conclusion-list",
    workspaceId: "test",
    params: filters,
  });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.total, 3);
  assert.equal(listed.data.items[0].observer_display_name, "Assistant");
  assert.equal(listed.data.items[0].observed_display_name, "Owner");
  assert.ok(fakeApi.calls.some((call) => call[0] === "conclusions"
    && JSON.stringify(call[5]) === JSON.stringify({
      observer_id: "assistant",
      observed_id: "owner",
      session_id: "session-1",
      level: "explicit",
    })));

  const queried = await service.handle({
    op: "list_conclusions",
    requestId: "conclusion-query",
    workspaceId: "test",
    params: { ...filters, query: "duplicate", size: 2 },
  });
  assert.equal(queried.ok, true);
  assert.equal(queried.data.items.length, 2);
  assert.equal(queried.data.page, 1);
  assert.ok(fakeApi.calls.some((call) => call[0] === "query_conclusions"
    && call[2] === "duplicate"
    && call[3] === 2));
});

test("Explorer Conclusion cleanup is filter-bound, single-use, and reports partial failure", async () => {
  const fakeApi = new FakeApi();
  fakeApi.conclusionDeleteErrors.set("conclusion-3", new HonchoHttpError(503, "temporary"));
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  const filters = {
    observerPeerId: "assistant",
    targetPeerId: "owner",
    sessionId: "session-1",
    conclusionLevel: "explicit",
  };
  const report = await service.handle({
    op: "scan_conclusion_duplicates",
    requestId: "scan",
    workspaceId: "test",
    params: filters,
  });
  assert.equal(report.ok, true);
  assert.equal(report.data.scanned_count, 3);
  assert.equal(report.data.duplicate_count, 2);
  assert.equal(report.data.groups[0].earliest_id, "conclusion-1");
  assert.equal(report.data.groups[0].latest_id, "conclusion-3");

  const prepared = await service.handle({
    op: "prepare_conclusion_cleanup",
    requestId: "prepare-cleanup",
    workspaceId: "test",
    params: {
      ...filters,
      keepConclusionId: "conclusion-1",
      deleteConclusionIds: ["conclusion-2", "conclusion-3"],
    },
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.data.confirmation_phrase, "DELETE 2");

  const mistyped = await service.handle({
    op: "commit_conclusion_cleanup",
    requestId: "mistyped-cleanup",
    workspaceId: "test",
    params: {
      keepConclusionId: "conclusion-1",
      deleteConclusionIds: ["conclusion-2", "conclusion-3"],
      confirmationToken: prepared.data.confirmation_token,
      confirmationText: "DELETE 1",
    },
  });
  assert.equal(mistyped.ok, false);
  assert.equal(mistyped.error.code, "CONFIRMATION_TEXT_MISMATCH");

  const committed = await service.handle({
    op: "commit_conclusion_cleanup",
    requestId: "commit-cleanup",
    workspaceId: "test",
    params: {
      keepConclusionId: "conclusion-1",
      deleteConclusionIds: ["conclusion-2", "conclusion-3"],
      confirmationToken: prepared.data.confirmation_token,
      confirmationText: "DELETE 2",
    },
  });
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.data.deleted_ids, ["conclusion-2"]);
  assert.equal(committed.data.failures.length, 1);
  assert.equal(committed.data.failures[0].id, "conclusion-3");
  assert.ok(fakeApi.conclusions.some((item) => item.id === "conclusion-1"));

  const reused = await service.handle({
    op: "commit_conclusion_cleanup",
    requestId: "reuse-cleanup",
    workspaceId: "test",
    params: {
      keepConclusionId: "conclusion-1",
      deleteConclusionIds: ["conclusion-2", "conclusion-3"],
      confirmationToken: prepared.data.confirmation_token,
      confirmationText: "DELETE 2",
    },
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.error.code, "CONFIRMATION_REQUIRED");
});

test("Explorer read cache coalesces matching requests and honors forceRefresh", async () => {
  const fakeApi = new FakeApi();
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  await Promise.all([
    service.handle({ op: "list_sessions", requestId: "sessions-a", params: { page: 1 } }),
    service.handle({ op: "list_sessions", requestId: "sessions-b", params: { page: 1 } }),
  ]);
  await service.handle({ op: "list_sessions", requestId: "sessions-c", params: { page: 1 } });
  await service.handle({
    op: "list_sessions",
    requestId: "sessions-refresh",
    params: { page: 1, forceRefresh: true },
  });
  assert.equal(fakeApi.calls.filter((call) => call[0] === "sessions").length, 2);
});

test("Explorer sidecar maintenance requires a stable typed confirmation", async () => {
  const fakeApi = new FakeApi();
  let current = { file_count: 3, total_bytes: 2048, max_bytes: 8192 };
  const maintenance = {
    status: async () => ({ ...current }),
    clear: async () => {
      const result = { deleted_files: current.file_count, deleted_bytes: current.total_bytes };
      current = { ...current, file_count: 0, total_bytes: 0 };
      return result;
    },
  };
  const service = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi,
    maintenance
  );
  const statusResult = await service.handle({ op: "sidecar_status", requestId: "sidecar-status" });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.data.total_bytes, 2048);
  const prepared = await service.handle({ op: "prepare_sidecar_clear", requestId: "sidecar-prepare" });
  assert.equal(prepared.data.confirmation_phrase, "CLEAR SIDECARS");
  const cleared = await service.handle({
    op: "commit_sidecar_clear",
    requestId: "sidecar-clear",
    params: {
      confirmationToken: prepared.data.confirmation_token,
      confirmationText: "CLEAR SIDECARS",
    },
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.data, { deleted_files: 3, deleted_bytes: 2048 });

  const unavailable = new ExplorerService(
    { getConfig: () => config(), status: () => status() },
    () => fakeApi
  );
  const missing = await unavailable.handle({ op: "sidecar_status", requestId: "sidecar-missing" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "SIDECAR_UNAVAILABLE");
});