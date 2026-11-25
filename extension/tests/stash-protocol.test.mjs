import assert from "node:assert/strict";
import test from "node:test";
import { isResponseShape } from "../dist/protocol-shape.js";

const common = { protocol_version: 8, request_id: "stash" };
const id = "1".repeat(64);
const entry = {
  id, version: "2".repeat(64), title: "Saved article", url: "https://example.com/article",
  saved_at: "2026-11-23T10:00:00Z", done: false, summary: null, // timing-ok: Fixed wire metadata is never compared to the current time.
};
const summary = {
  path: "summaries/article-aaaaaaaa.summary.md", overview: "Example summary", category: "Research",
  document_type: "Article", importance: "medium", summarized_at: null,
};
const list = (items, next = null) => ({ ...common, type: "stash_listed", items, next });

test("Stash replies require correlated typed fields", () => {
  assert.equal(isResponseShape({ ...common, type: "stash_completed" }), true);
  assert.equal(isResponseShape({ ...common, type: "stash_completed", other: true }), false);
  assert.equal(isResponseShape({ ...common, type: "stash_page_result", already_saved: false, needs_summary: true }), true);
  assert.equal(isResponseShape({ ...common, type: "stash_page_result", already_saved: "false", needs_summary: true }), false);
  assert.equal(isResponseShape(list([entry, { ...entry, id: "3".repeat(64), summary }])), true);
});

test("Stash validates the optional listed reading version and exact reading acknowledgement", () => {
  const reading_version = "d".repeat(64);
  const acknowledged = { ...common, type: "stash_reading_set", done: false, reading_version };
  assert.equal(isResponseShape(list([entry])), true);
  assert.equal(isResponseShape(list([{ ...entry, reading_version }])), true);
  assert.equal(isResponseShape(acknowledged), true);
  assert.equal(isResponseShape({ ...acknowledged, done: true }), true);
  for (const malformed of [null, undefined, true, "d".repeat(63), "D".repeat(64), reading_version + "\n"]) {
    assert.equal(isResponseShape(list([{ ...entry, reading_version: malformed }])), false);
    assert.equal(isResponseShape({ ...acknowledged, reading_version: malformed }), false);
  }
  assert.equal(isResponseShape({ ...acknowledged, done: "false" }), false);
  assert.equal(isResponseShape({ ...acknowledged, id }), false);
  assert.equal(isResponseShape({ ...common, type: "stash_reading_set", reading_version }), false);
});

test("Stash summary reading scope accepts omission and only known values", () => {
  const accepts = (metadata) => isResponseShape(list([{ ...entry, summary: metadata }]));
  assert.equal(accepts(summary), true);
  for (const read_scope of ["whole", "partial", "page_only"]) {
    assert.equal(accepts({ ...summary, read_scope }), true, read_scope);
  }
  for (const read_scope of [null, "unknown", "Whole", true, undefined]) {
    assert.equal(accepts({ ...summary, read_scope }), false, String(read_scope));
  }
  assert.equal(accepts({ ...summary, read_scope: "whole", other: true }), false);
});

test("Stash lists accept omitted pin support and validate pin state and its own version", () => {
  const pin = { pinned: false, version: "b".repeat(64) };
  const pinOrder = "c".repeat(64);
  const withOrder = (items, pin_order = pinOrder) => ({ ...list(items), pin_order });
  const accepts = (value) => isResponseShape(withOrder([{ ...entry, pin: value }]));
  assert.equal(isResponseShape(list([entry])), true);
  assert.equal(accepts(pin), true);
  assert.equal(accepts({ ...pin, pinned: true }), true);
  for (const value of [
    null, undefined, true, {}, { pinned: true }, { version: pin.version },
    { ...pin, version: "A".repeat(64) }, { ...pin, version: "../pin" },
    { ...pin, version: pin.version + "\n" },
    { ...pin, pinned: "false" }, { ...pin, path: "stash-pins.owner" },
  ]) {
    assert.equal(accepts(value), false);
  }
  assert.equal(isResponseShape(withOrder([])), true);
  assert.equal(isResponseShape(withOrder([entry])), false);
  assert.equal(isResponseShape(list([{ ...entry, pin }])), false);
  assert.equal(isResponseShape(withOrder([{ ...entry, pin }], "wrong-order")), false);
  const updated = { ...common, type: "stash_pin_set", pin };
  assert.equal(isResponseShape(updated), true);
  assert.equal(isResponseShape({ ...updated, pin: null }), false);
  assert.equal(isResponseShape({ ...updated, pin: { ...pin, pinned: 1 } }), false);
  assert.equal(isResponseShape({ ...updated, extra: true }), false);
});

test("Stash summary issues are optional, typed, and exclude a summary or run request", () => {
  const saved = { ...common, type: "stash_page_result", already_saved: false, needs_summary: false };
  assert.equal(isResponseShape(saved), true);
  assert.equal(isResponseShape(list([entry])), true);
  for (const summary_issue of ["conflict", "unavailable"]) {
    assert.equal(isResponseShape({ ...saved, summary_issue }), true, summary_issue);
    assert.equal(isResponseShape(list([{ ...entry, summary_issue }])), true, summary_issue);
    assert.equal(isResponseShape({ ...saved, summary_issue, needs_summary: true }), false);
    assert.equal(isResponseShape(list([{ ...entry, summary_issue, summary }])), false);
  }
  for (const summary_issue of [null, "missing", "/example/summary.md", true, undefined]) {
    assert.equal(isResponseShape({ ...saved, summary_issue }), false);
    assert.equal(isResponseShape(list([{ ...entry, summary_issue }])), false);
  }
  assert.equal(isResponseShape({ ...saved, summary_issue: "conflict", other: true }), false);
  assert.equal(isResponseShape(list([{ ...entry, summary_issue: "conflict", other: true }])), false);
});

test("Stash rejects unsafe navigation, duplicate rows and inconsistent page continuations", () => {
  for (const url of ["javascript:alert(1)", "https://user@example.com/", "file:///example.md"]) {
    assert.equal(isResponseShape(list([{ ...entry, url }])), false);
  }
  assert.equal(isResponseShape(list([{ ...entry, summary: { ...summary, path: "summaries/../example.summary.md" } }])), false);
  assert.equal(isResponseShape(list([entry, entry])), false);
  assert.equal(isResponseShape(list([entry], id)), false);
  const page = Array.from({ length: 20 }, (_, n) => ({ ...entry, id: n.toString(16).padStart(64, "0") }));
  assert.equal(isResponseShape(list(page, page.at(-1).id)), true);
  assert.equal(isResponseShape(list(page, id)), false);
  assert.equal(isResponseShape(list([...page, entry])), false);
});

test("Stash validates budgeted search continuations and literal match snippets", () => {
  const revision = "a".repeat(64);
  const limited = { revision, limited_by: "files" };
  const searched = (items, next = null, search_progress = limited) => ({
    ...list(items, next), search_progress,
  });
  assert.equal(isResponseShape(searched([], id)), true);
  assert.equal(isResponseShape(searched([], id, { revision })), false);
  assert.equal(isResponseShape(searched([], "not-an-entry-id")), false);
  for (const limited_by of [null, "other", 1]) {
    assert.equal(isResponseShape(searched([], id, { revision, limited_by })), false);
  }
  assert.equal(isResponseShape(searched([], id, { ...limited, extra: 1 })), false);
  assert.equal(isResponseShape(searched([], id, { ...limited, notes_unavailable: true })), true);
  assert.equal(isResponseShape(searched([], id, { ...limited, notes_unavailable: "true" })), false);
  assert.equal(isResponseShape(searched([], id, { ...limited, summaries_unavailable: true })), true);
  assert.equal(isResponseShape(searched([], id, { ...limited, summaries_unavailable: null })), false);
  const note = { ...entry, search_match: { source: "note", snippet: "<img src=about:blank> words" } };
  assert.equal(isResponseShape(searched([note])), true);
  assert.equal(isResponseShape(list([note])), false);
  for (const search_match of [
    { source: "title", snippet: "extra" }, { source: "summary" },
    { source: "note", snippet: "x".repeat(161) }, { source: "note", snippet: "bad\u202e" },
    { source: "note", snippet: "" }, { source: "unknown", snippet: "x" },
  ]) {
    assert.equal(isResponseShape(searched([{ ...entry, search_match }])), false);
  }
});
