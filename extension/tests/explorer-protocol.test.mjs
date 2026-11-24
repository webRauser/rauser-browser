import assert from "node:assert/strict";
import test from "node:test";
import { isResponseShape } from "../dist/protocol-shape.js";

const artifact = (id = "7", changes = {}) => ({
  artifact_id: `work:work.example/${id}`, artifact_type: "work.item", title: `Release plan ${id}`,
  url: `https://work.example/items/${id}`, source: "work.example", first_seen: "2026-11-01", // timing-ok: Fixed first-seen metadata is used only for response-shape validation, never a wall-clock comparison.
  last_seen: "2026-11-23", focused_seconds: 90, opens: 2, why: null, summary: null, ...changes, // timing-ok: Fixed last-seen metadata is used only for response-shape validation, never a wall-clock comparison.
});
const facets = () => ({ sources: [{ value: "work.example", count: 1 }],
  artifact_types: [{ value: "work.item", count: 1 }], categories: [], document_types: [], truncated: false });
const page = (changes = {}) => ({ snapshot: "a".repeat(64), offset: 0, next_offset: null, ...changes });
const list = (changes = {}) => ({ type: "explore_artifacts_result", protocol_version: 8, request_id: "explore",
  items: [artifact()], facets: facets(), total: 1, library_total: 1, page: page(), ...changes });
const connection = (changes = {}) => ({ artifact: artifact("8"), basis: "same_category", direction: "associated",
  transition: null, last_seen: null, ...changes });
const context = (changes = {}) => ({ type: "artifact_context_result", protocol_version: 8, request_id: "context",
  item: artifact(), connections: [connection()], truncated: false, ...changes });
const without = (value, key) => { const copy = structuredClone(value); delete copy[key]; return copy; };

test("Explorer response guards accept complete lists and legacy or covered summary metadata", () => {
  assert.equal(isResponseShape(list()), true);
  assert.equal(isResponseShape(list({ items: [], total: 0, library_total: 1 })), true);
  const summary = { summarized_at: "2026-11-23T10:00:00Z", document_type: "report", category: "Quality", // timing-ok: This deterministic summary timestamp tests accepted wire shapes; no real-clock freshness is asserted.
    importance: "high", summary_path: "summaries/plan.summary.md", harness: "codex" };
  for (const read_scope of [undefined, "whole", "partial", "page_only"]) {
    const value = { ...summary, ...(read_scope ? { read_scope } : {}) };
    assert.equal(isResponseShape(list({ items: [artifact("7", { summary: value })] })), true);
  }
  assert.equal(isResponseShape(context()), true);
  assert.equal(isResponseShape(context({ item: null, connections: [], truncated: false })), true);
});

test("Explorer response envelopes and nested records require exact keys", () => {
  for (const value of [list(), context()]) {
    for (const key of Object.keys(value)) assert.equal(isResponseShape(without(value, key)), false, key);
    assert.equal(isResponseShape({ ...value, extra: true }), false);
  }
  for (const key of Object.keys(artifact())) {
    assert.equal(isResponseShape(list({ items: [without(artifact(), key)] })), false, `artifact.${key}`);
  }
  for (const key of Object.keys(facets())) {
    assert.equal(isResponseShape(list({ facets: without(facets(), key) })), false, `facets.${key}`);
  }
  for (const key of Object.keys(connection())) {
    assert.equal(isResponseShape(context({ connections: [without(connection(), key)] })), false, `connection.${key}`);
  }
  for (const item of [artifact("7", { extra: true }), artifact("7", { summary: { extra: true } })]) {
    assert.equal(isResponseShape(list({ items: [item] })), false);
  }
  assert.equal(isResponseShape(list({ facets: { ...facets(), extra: true } })), false);
  assert.equal(isResponseShape(context({ connections: [connection({ extra: true })] })), false);
});

test("Explorer guards reject unsafe original links rather than treating host strings as navigation", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/private", "data:text/html,hi", "https://user:secret@work.example/7", "not a URL"]) {
    assert.equal(isResponseShape(list({ items: [artifact("7", { url })] })), false, url);
    assert.equal(isResponseShape(context({ connections: [connection({ artifact: artifact("8", { url }) })] })), false, url);
  }
});

test("Explorer guards enforce row, facet and nested scalar bounds", () => {
  const items = Array.from({ length: 8 }, (_, i) => artifact(String(i)));
  assert.equal(isResponseShape(list({ items, total: 8, library_total: 8 })), true);
  assert.equal(isResponseShape(list({ items: [...items, artifact("9")], total: 9, library_total: 9 })), false);
  const connections = Array.from({ length: 8 }, (_, i) => connection({ artifact: artifact(String(i + 10)) }));
  assert.equal(isResponseShape(context({ connections })), true);
  assert.equal(isResponseShape(context({ connections: [...connections, connection()] })), false);
  for (const key of ["sources", "artifact_types", "categories", "document_types"]) {
    const values = Array.from({ length: 64 }, (_, i) => ({ value: `value-${i}`, count: 1 }));
    assert.equal(isResponseShape(list({ facets: { ...facets(), [key]: values } })), true, key);
    assert.equal(isResponseShape(list({ facets: { ...facets(), [key]: [...values, { value: "overflow", count: 1 }] } })), false, key);
  }
  for (const count of [-1, 1.5, 0x100000000, Number.NaN]) {
    assert.equal(isResponseShape(list({ items: [artifact("7", { opens: count })] })), false);
    assert.equal(isResponseShape(list({ facets: { ...facets(), categories: [{ value: "Quality", count }] } })), false);
  }
  assert.equal(isResponseShape(list({ items: [artifact("7", { title: "a".repeat(2049) })] })), false);
  assert.equal(isResponseShape(list({ items: [artifact("7", { why: "a".repeat(501) })] })), false);
  assert.equal(isResponseShape(list({ items: [artifact("7", { first_seen: "yesterday" })] })), false);
});

test("Explorer guards accept unknown sources and count label bounds as Unicode characters", () => {
  assert.equal(isResponseShape(list({ items: [artifact("7", { source: "" })] })), true);
  assert.equal(isResponseShape(list({ facets: { ...facets(), categories: [{ value: "😀".repeat(64), count: 1 }] } })), true);
  assert.equal(isResponseShape(list({ facets: { ...facets(), categories: [{ value: "😀".repeat(65), count: 1 }] } })), false);
});

test("Explorer guards reject duplicate identities and contradictory page totals", () => {
  assert.equal(isResponseShape(list({ items: [artifact(), artifact()], total: 2, library_total: 2 })), false);
  assert.equal(isResponseShape(context({ connections: [connection(), connection()] })), false);
  assert.equal(isResponseShape(context({ connections: [connection({ artifact: artifact() })] })), false);
  assert.equal(isResponseShape(list({ total: 2, library_total: 1 })), false);
  assert.equal(isResponseShape(list({ page: page({ next_offset: 1 }) })), false);
  assert.equal(isResponseShape(list({ total: 2, library_total: 2 })), false);
  assert.equal(isResponseShape(list({ total: 2, library_total: 2, page: page({ next_offset: 1 }) })), true);
  assert.equal(isResponseShape(list({ page: page({ offset: 1 }) })), false);
  assert.equal(isResponseShape(list({ page: page({ snapshot: "short" }) })), false);
  assert.equal(isResponseShape(list({ page: { ...page(), extra: true } })), false);
  assert.equal(isResponseShape(list({ facets: { ...facets(), sources: [{ value: "work.example", count: 1 }, { value: "work.example", count: 1 }] } })), false);
});

test("Explorer guards preserve relationship meaning and uncertainty", () => {
  const recorded = { direction: "incoming", last_seen: "2026-11-22" }; // timing-ok: The recorded-edge date is static protocol fixture data, not compared with the real clock.
  for (const basis of ["container", "title_mention"]) {
    assert.equal(isResponseShape(context({ connections: [connection({ ...recorded, basis })] })), true);
  }
  assert.equal(isResponseShape(context({ connections: [connection({ ...recorded, basis: "navigation", transition: "link" })] })), true);
  for (const invalid of [
    { direction: "incoming" }, { transition: "link" }, { last_seen: "2026-11-22" }, { basis: "fixes" }, // timing-ok: This fixed invalid association date exercises the null-date rule only, independent of the real clock.
    { ...recorded, basis: "navigation", transition: "forward_back" },
    { ...recorded, basis: "navigation", transition: null },
    { ...recorded, basis: "title_mention", transition: "link" },
    { ...recorded, basis: "container", last_seen: null },
  ]) assert.equal(isResponseShape(context({ connections: [connection(invalid)] })), false, JSON.stringify(invalid));
  assert.equal(isResponseShape(context({ item: null })), false);
  assert.equal(isResponseShape(context({ item: null, connections: [], truncated: true })), false);
});
