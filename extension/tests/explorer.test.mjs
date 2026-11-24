import assert from "node:assert/strict";
import test from "node:test";

const {
  ExplorerController, emptyExplorerFilters, explorerErrorText, matchesExplorerFilters,
  safeExplorerUrl, validateExplorerPage, connectionExplanation,
} = await import("../dist/explorer-model.js");

const SNAPSHOT = "a".repeat(64);
const item = (id, overrides = {}) => ({
  artifact_id: `doc:${id}`, artifact_type: "work.doc", title: `Document ${id}`,
  url: `https://work.example/docs/${id}`, source: "work.example", first_seen: "2026-11-01", last_seen: "2026-11-23", // timing-ok: Deterministic artifact dates travel through injected query/context replies; no real-clock age is asserted.
  focused_seconds: 60, opens: 2, why: null, summary: null, ...overrides,
});
const summary = (overrides = {}) => ({
  summarized_at: "2026-11-22T12:00:00Z", document_type: "Decision", category: "Quality", // timing-ok: Fixed stored-summary metadata exercises filtering and paging snapshots, never real-clock freshness.
  importance: "medium", summary_path: "summaries/synthetic.md", harness: "codex", ...overrides,
});
const page = (items, { offset = 0, next = null, total = items.length, snapshot = SNAPSHOT } = {}) => ({
  type: "explore_artifacts_result", protocol_version: 8, request_id: "fixture", items,
  facets: { sources: [{ value: "work.example", count: total }], artifact_types: [], categories: [], document_types: [], truncated: false },
  total, library_total: total, page: { offset, next_offset: next, snapshot },
});
const context = (selected, connections = []) => ({ type: "artifact_context_result", protocol_version: 8, request_id: "fixture", item: selected, connections, truncated: false });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("safe source URLs refuse non-web schemes, credentials and malformed addresses", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///tmp/doc", "not a url", "https://name:secret@work.example/doc"]) {
    assert.equal(safeExplorerUrl(url), null, url);
  }
  assert.equal(safeExplorerUrl("https://work.example/doc?q=1#part"), "https://work.example/doc?q=1#part");
});

test("existing metadata filters keep saved categories, types and reported reading distinct", () => {
  const a = item("a", { title: "RÉSUMÉ", why: "release review", summary: summary({ overview: "Launch evidence", read_scope: "partial" }) });
  assert.equal(matchesExplorerFilters(a, { ...emptyExplorerFilters(), query: "résumé", category: "Quality", document_type: "Decision", reading: "limited" }), true);
  assert.equal(matchesExplorerFilters(a, { ...emptyExplorerFilters(), query: "RÉSUMÉ evidence review work.example" }), true, "tokens may match separate recorded fields");
  for (const filters of [{ category: "Operations" }, { source: "other.example" }, { artifact_type: "jira.issue" }, { reading: "whole" }, { query: "not present" }]) {
    assert.equal(matchesExplorerFilters(a, { ...emptyExplorerFilters(), ...filters }), false);
  }
  assert.equal(matchesExplorerFilters(item("b"), { ...emptyExplorerFilters(), reading: "none" }), true);
  assert.equal(matchesExplorerFilters(item("b"), { ...emptyExplorerFilters(), reading: "unknown" }), false);
  assert.equal(matchesExplorerFilters(item("c", { summary: summary() }), { ...emptyExplorerFilters(), reading: "unknown" }), true);
});

test("continuations reject changed snapshots, offsets, duplicates and false completeness", () => {
  validateExplorerPage(page([item("a")]), 0);
  for (const result of [page([item("a")], { offset: 1 }), page([], { next: 1, total: 2 }), page([item("a"), item("a")]), page([item("a")], { total: 2 })]) {
    assert.throws(() => validateExplorerPage(result, 0));
  }
  assert.throws(() => validateExplorerPage(page([item("a")], { snapshot: "b".repeat(64) }), 0, SNAPSHOT));
});

test("old hosts and changed-library errors give recovery advice without implying empty results", () => {
  assert.match(explorerErrorText({ code: "invalid_request", message: "invalid or unsupported request JSON" }), /host and extension together/i);
  assert.match(explorerErrorText({ code: "conflict", message: "revision changed" }), /Refresh Explorer/i);
});

test("list filters are sent to the host before paging and each row appears once", async () => {
  const queries = [];
  const a = item("a", { summary: summary({ overview: "Launch evidence" }) }), b = item("b", { summary: summary({ overview: "Launch evidence" }) }), c = item("c", { summary: summary({ overview: "Launch evidence" }) });
  const controller = new ExplorerController({
    async explore(query) { queries.push(query); return query.page.offset === 0 ? page([a, b], { total: 3, next: 2 }) : page([c], { offset: 2, total: 3 }); },
    async context(id) { return context([a, b, c].find((a) => a.artifact_id === id)); },
  }, () => {});
  await controller.load("revision", { ...emptyExplorerFilters(), category: "Quality", query: "launch" });
  assert.equal(queries[0].expected_revision, "revision");
  assert.equal(queries[0].category, "Quality");
  assert.equal(queries[0].query, "launch");
  await controller.more();
  assert.deepEqual(queries[1].page, { offset: 2, snapshot: SNAPSHOT });
  assert.deepEqual(controller.state.items.map((a) => a.artifact_id), ["doc:a", "doc:b", "doc:c"]);
  assert.equal(controller.state.page.next_offset, null);
});

test("a late query cannot replace a newer filtered library or selected artifact", async () => {
  const old = deferred();
  const a = item("a", { title: "Old result" }), b = item("b", { title: "New result" });
  const controller = new ExplorerController({
    explore: (q) => q.query === "old" ? old.promise : Promise.resolve(page([b])),
    context: async () => context(b),
  }, () => {});
  const pending = controller.load("revision", { ...emptyExplorerFilters(), query: "old" });
  await controller.load("revision", { ...emptyExplorerFilters(), query: "new" });
  old.resolve(page([a])); await pending;
  assert.deepEqual(controller.state.items.map((a) => a.artifact_id), ["doc:b"]);
  assert.equal(controller.state.selected.artifact_id, "doc:b");
});

test("empty filtered results clear the inspector and stale detail cannot return", async () => {
  const detail = deferred();
  const a = item("a");
  const controller = new ExplorerController({
    explore: async (q) => q.query ? page([]) : page([a]), context: () => detail.promise,
  }, () => {});
  const opening = controller.load("revision", emptyExplorerFilters()); await flush();
  assert.equal(controller.state.selected.artifact_id, "doc:a");
  await controller.load("revision", { ...emptyExplorerFilters(), query: "no match" });
  detail.resolve(context(a)); await opening;
  assert.equal(controller.state.selected, null);
  assert.deepEqual(controller.state.connections, []);
});

test("library invalidation clears backlink and arrival sections and discards an old detail reply", async () => {
  const a = item("a");
  const b = item("b");
  const old = deferred();
  const evidence = {
    linked_from: { items: [{ source: a }], truncated: false },
    arrived_via: [{ source: a }],
  };
  const controller = new ExplorerController({
    explore: async () => page([b]),
    async context(id, revision) {
      if (revision === "old" && id === a.artifact_id) return old.promise;
      return { ...context(b), ...(revision === "old" ? evidence : {}) };
    },
  }, () => {});
  await controller.load("old", emptyExplorerFilters());
  assert.equal(controller.state.linkedFrom.items[0].source.artifact_id, a.artifact_id);
  assert.equal(controller.state.arrivedVia[0].source.artifact_id, a.artifact_id);
  const pending = controller.select(a.artifact_id, true);
  assert.equal(controller.state.linkedFrom, undefined);
  assert.equal(controller.state.arrivedVia, undefined);
  controller.clear();
  await controller.load("new", emptyExplorerFilters());
  old.resolve({ ...context(a), ...evidence });
  await pending;
  assert.equal(controller.state.selected.artifact_id, b.artifact_id);
  assert.equal(controller.state.linkedFrom, undefined);
  assert.equal(controller.state.arrivedVia, undefined);
});

test("a late context reply cannot replace a later selection", async () => {
  const late = deferred(), a = item("a"), b = item("b");
  const controller = new ExplorerController({ explore: async () => page([a, b]), context: (id) => id === "doc:a" ? late.promise : Promise.resolve(context(b)) }, () => {});
  const loading = controller.load("revision", emptyExplorerFilters()); await flush();
  await controller.select(b);
  late.resolve(context(a)); await loading;
  assert.equal(controller.state.selected.artifact_id, "doc:b");
});

test("explicit relationship traversal can leave filters with an honest notice", async () => {
  const a = item("a", { summary: summary() }), b = item("b", { summary: summary({ category: "Operations" }) });
  const controller = new ExplorerController({ explore: async () => page([a]), context: async (id) => context(id === "doc:a" ? a : b) }, () => {});
  await controller.load("revision", { ...emptyExplorerFilters(), category: "Quality" });
  await controller.select(b, true);
  assert.equal(controller.state.outsideFilters, true);
  assert.equal(controller.state.selected.artifact_id, "doc:b");
  await controller.load("revision", { ...emptyExplorerFilters(), category: "Quality" });
  assert.equal(controller.state.outsideFilters, false);
  assert.equal(controller.state.selected.artifact_id, "doc:a");
});

test("ordinary selection clears a refreshed artifact that no longer matches its filter", async () => {
  const delayed = deferred();
  const listed = item("a", { summary: summary() });
  const changed = item("a", { summary: summary({ category: "Operations" }) });
  const controller = new ExplorerController({ explore: async () => page([listed]), context: () => delayed.promise }, () => {});
  const loading = controller.load("revision", { ...emptyExplorerFilters(), category: "Quality" });
  await flush();
  assert.equal(controller.state.selected.artifact_id, "doc:a");
  delayed.resolve(context(changed)); await loading;
  assert.equal(controller.state.selected, null);
  assert.deepEqual(controller.state.connections, []);
  assert.match(controller.state.contextError, /no longer matches.*Refresh Explorer/i);
});

test("a stale continuation preserves rows and requires a fresh snapshot", async () => {
  const controller = new ExplorerController({
    explore: async (q) => { if (q.page.offset) throw { code: "conflict", message: "changed" }; return page([item("a")], { total: 2, next: 1 }); },
    context: async () => context(item("a")),
  }, () => {});
  await controller.load("revision", emptyExplorerFilters()); await controller.more();
  assert.equal(controller.state.items.length, 1);
  assert.equal(controller.state.page, null);
  assert.match(controller.state.error, /Refresh Explorer/);
});

test("recorded and associated connections retain distinct meaning", () => {
  const related = item("a", { summary: summary() });
  assert.match(connectionExplanation({ artifact: related, basis: "same_category", direction: "associated", transition: null, last_seen: null }).label, /category/i);
  assert.match(connectionExplanation({ artifact: related, basis: "navigation", direction: "incoming", transition: "link", last_seen: "2026-11-20" }).detail, /2026-11-20/); // timing-ok: The expected label repeats the injected recorded date literally; it does not consult the real clock.
  assert.match(connectionExplanation({ artifact: related, basis: "title_mention", direction: "outgoing", transition: null, last_seen: null }).label, /title/i);
});
