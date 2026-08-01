const test = require("node:test");
const assert = require("node:assert/strict");

const { clipText, compactJson, displayTime, pageLabel } = require("../dist/ui/honcho_explore/format");
const screen = require("../dist/ui/honcho_explore/index.ui").default;

test("Explorer UI format helpers bound long remote data", () => {
  assert.equal(clipText("  one   two  ", 20), "one two");
  assert.equal(clipText("x".repeat(30), 10), "xxxxxxx...");
  assert.equal(compactJson({ project: "honcho" }), '{"project":"honcho"}');
  assert.equal(displayTime("2026-08-01T11:00:00.123Z"), "2026-08-01 11:00:00Z");
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
