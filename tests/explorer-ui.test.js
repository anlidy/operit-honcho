const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { clipText, compactJson, displayTime, pageLabel } = require("../dist/ui/honcho_explore/format");
const { renderIdentityManager } = require("../dist/ui/honcho_explore/identity.ui");
const { renderPeerWorkspace } = require("../dist/ui/honcho_explore/peers.ui");
const screen = require("../dist/ui/honcho_explore/index.ui").default;

test("Explorer compiled UI uses QuickJS-resolvable module specifiers", () => {
  const source = fs.readFileSync(
    require.resolve("../dist/ui/honcho_explore/index.ui"),
    "utf8"
  );
  assert.match(source, /require\("\.\/identity\.ui\.js"\)/);
  assert.match(source, /require\("\.\/peers\.ui\.js"\)/);
  const peerSource = fs.readFileSync(
    require.resolve("../dist/ui/honcho_explore/peers.ui"),
    "utf8"
  );
  assert.match(peerSource, /require\("\.\/format\.js"\)/);
});

test("Explorer UI format helpers bound long remote data", () => {
  assert.equal(clipText("  one   two  ", 20), "one two");
  assert.equal(clipText("x".repeat(30), 10), "xxxxxxx...");
  assert.equal(compactJson({ project: "honcho" }), '{"project":"honcho"}');
  assert.equal(displayTime("2026-08-01T04:52:21Z"), "2026-08-01 12:52:21");
  assert.equal(displayTime("2026-08-01T11:00:00.123Z"), "2026-08-01 19:00:00");
  assert.equal(displayTime("2026-08-01T04:52:21"), "2026-08-01 12:52:21");
  assert.equal(displayTime("not-a-time"), "时间未知");
  const originalIntl = global.Intl;
  try {
    global.Intl = undefined;
    assert.equal(displayTime("2026-08-01T04:52:21Z"), "2026-08-01 12:52:21");
  } finally {
    global.Intl = originalIntl;
  }
  assert.equal(pageLabel(2, 5, 81), "2 / 5  ·  81");
});

test("Explorer screen renders a stable sidebar shell before network loading", () => {
  const UI = new Proxy({}, {
    get: (_target, type) => (props = {}, children) => ({
      type: String(type),
      props,
      children: Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [],
    }),
  });
  const refs = new Map();
  const ctx = {
    UI,
    MaterialTheme: {
      colorScheme: new Proxy({}, { get: (_target, key) => String(key) }),
    },
    useState: (_key, initial) => [initial, () => {}],
    useRef: (key, initial) => {
      if (!refs.has(key)) refs.set(key, { current: initial });
      return refs.get(key);
    },
  };

  const root = screen(ctx);
  assert.equal(root.type, "LazyColumn");
  assert.equal(typeof root.props.onLoad, "function");
  assert.ok(root.children.some((node) => node.type === "PrimaryScrollableTabRow"));
  const serialized = JSON.stringify(root, (key, value) => typeof value === "function" ? "[function]" : value);
  assert.match(serialized, /Honcho 探索/);
  assert.match(serialized, /概览/);
  assert.match(serialized, /结论/);
});

test("Explorer identity manager renders the protected revision-bound confirmation", () => {
  const UI = new Proxy({}, {
    get: (_target, type) => (props = {}, children) => ({
      type: String(type),
      props,
      children: Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [],
    }),
  });
  const ctx = {
    UI,
    MaterialTheme: {
      colorScheme: new Proxy({}, { get: (_target, key) => String(key) }),
    },
  };
  const node = renderIdentityManager(ctx, {
    identity: {
      workspace_id: "test",
      user_peer: "legacy_user",
      ai_peer: "legacy_ai",
      source: "legacy_config",
      revision: 0,
      migration_required: true,
    },
    activeWorkspace: "test",
    browsingWorkspace: "test",
    userPeerId: "owner",
    aiPeerId: "assistant",
    preview: {
      workspace_id: "test",
      previous_user_peer: "legacy_user",
      previous_ai_peer: "legacy_ai",
      previous_revision: 0,
      proposed_user_peer: "owner",
      proposed_ai_peer: "assistant",
      proposed_revision: 1,
      confirmation_token: "identity-token",
      expires_at: "2026-08-01T18:00:00Z",
    },
    busy: false,
    notice: "",
    error: "",
    onUserPeerChange: () => {},
    onAiPeerChange: () => {},
    onPrepare: () => {},
    onCommit: () => {},
    onCancel: () => {},
  });
  const serialized = JSON.stringify(node, (key, value) => typeof value === "function" ? "[function]" : value);
  assert.match(serialized, /确认身份变更/);
  assert.match(serialized, /legacy_user.*owner/);
  assert.match(serialized, /rev 0.*→ 1/);
  assert.match(serialized, /只影响之后的新消息与工具调用/);
});

test("Explorer screen renders a paged session message timeline", () => {
  const UI = new Proxy({}, {
    get: (_target, type) => (props = {}, children) => ({
      type: String(type),
      props,
      children: Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [],
    }),
  });
  const state = {
    tab: "sessions",
    status: { configured: true, workspace: "test" },
    browsingWorkspace: "test",
    selectedSessionId: "session-1",
    messages: {
      items: [{
        id: "message-1",
        content: "Known timeline message",
        peer_id: "user",
        token_count: 4,
        created_at: "2026-08-01T11:00:00.123Z",
      }],
      total: 31,
      page: 1,
      size: 30,
      pages: 2,
    },
    hasLoaded: true,
  };
  const refs = new Map();
  const ctx = {
    UI,
    MaterialTheme: {
      colorScheme: new Proxy({}, { get: (_target, key) => String(key) }),
    },
    useState: (key, initial) => [Object.hasOwn(state, key) ? state[key] : initial, () => {}],
    useRef: (key, initial) => {
      if (!refs.has(key)) refs.set(key, { current: initial });
      return refs.get(key);
    },
  };

  const root = screen(ctx);
  const serialized = JSON.stringify(root, (key, value) => typeof value === "function" ? "[function]" : value);
  assert.match(serialized, /Known timeline message/);
  assert.match(serialized, /session-1/);
  assert.match(serialized, /1 \/ 2  ·  31/);
  assert.match(serialized, /arrow_back/);
  assert.match(serialized, /chevron_right/);
});

test("Explorer Peer detail renders directional Card, roles, Sessions, and confirmation", () => {
  const UI = new Proxy({}, {
    get: (_target, type) => (props = {}, children) => ({
      type: String(type),
      props,
      children: Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [],
    }),
  });
  const ctx = {
    UI,
    MaterialTheme: {
      colorScheme: new Proxy({}, { get: (_target, key) => String(key) }),
    },
  };
  const noop = () => {};
  const nodes = renderPeerWorkspace(ctx, {
    workspaceId: "test",
    activeWorkspace: "test",
    page: { items: [], total: 1, page: 1, size: 20, pages: 1 },
    selectedPeer: {
      id: "owner",
      display_name: "主人",
      archived: false,
      roles: ["user"],
      created_at: "2026-08-01T04:52:21Z",
    },
    sessions: {
      items: [{ id: "session-1", is_active: true }],
      total: 1,
      page: 1,
      size: 20,
      pages: 1,
    },
    card: {
      workspace_id: "test",
      observer_id: "assistant",
      target_id: "owner",
      peer_card: ["prefers direct answers"],
    },
    observerPeerId: "assistant",
    observerOptions: [{ id: "assistant", display_name: "Assistant", archived: false, roles: ["ai"] }],
    observerMenuOpen: false,
    showArchived: false,
    createOpen: false,
    createPeerId: "",
    createDisplayName: "",
    editDisplayName: "主人",
    mutationPreview: {
      mutation: "remove_from_session",
      workspace_id: "test",
      peer_id: "owner",
      session_id: "session-1",
      impact: "只移除 Session 成员关系，不删除历史数据。",
      confirmation_token: "peer-token",
      expires_at: "2026-08-01T18:00:00Z",
    },
    identityPreview: null,
    busy: false,
    notice: "",
    error: "",
    cardError: "",
    onBack: noop,
    onOpenPeer: noop,
    onPage: noop,
    onSessionPage: noop,
    onShowArchivedChange: noop,
    onCreateOpenChange: noop,
    onCreatePeerIdChange: noop,
    onCreateDisplayNameChange: noop,
    onEditDisplayNameChange: noop,
    onPrepareMutation: noop,
    onCommitMutation: noop,
    onCancelMutation: noop,
    onPrepareRole: noop,
    onCommitRole: noop,
    onCancelRole: noop,
    onObserverMenuChange: noop,
    onObserverChange: noop,
    onRefreshCard: noop,
  });
  const serialized = JSON.stringify(nodes, (key, value) => typeof value === "function" ? "[function]" : value);
  assert.match(serialized, /主人/);
  assert.match(serialized, /当前用户/);
  assert.match(serialized, /观察者：assistant/);
  assert.match(serialized, /目标：owner/);
  assert.match(serialized, /prefers direct answers/);
  assert.match(serialized, /session-1/);
  assert.match(serialized, /确认移除会话成员/);
  assert.match(serialized, /不删除历史数据/);
  assert.match(serialized, /person_remove/);
});
