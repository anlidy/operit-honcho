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