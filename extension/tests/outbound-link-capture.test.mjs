import assert from "node:assert/strict";
import test from "node:test";
import { autoSummarizeTab, readTab, summarizeTab } from "../dist/summarize.js";
import { linkStageRequest, makeLinkDraft, readLinkFrame } from "../dist/outbound-link-capture.js";

test("only distinct recognized identities consume the retained target quota", () => {
  const documentUrl = "https://work.example/items/1";
  const candidates = Array.from({ length: 150 }, (_, i) => ({ url: `https://other.example/${i}` }));
  candidates.push({ url: "https://work.example/items/2?mode=first", label: "Example" });
  candidates.push({ url: "https://work.example/items/2?mode=second" });
  const draft = makeLinkDraft({ href: documentUrl, scope: "top_document", readyState: "complete",
    anchorsInspected: candidates.length, candidates, coverage: "complete", reasons: [] }, {
    url: documentUrl, frameId: 0, documentId: "selected", tabId: 1,
  }, "summary", "revision", new Date(0),
  (url) => url.startsWith("https://work.example/items/2?") ? { id: "example/2", type: "example.item" } : null);
  assert.equal(draft.coverage.state, "complete");
  assert.deepEqual(draft.targets, [{ artifact_id: "example/2", artifact_type: "example.item",
    url: candidates[150].url, label: "Example" }]);
});

test("encoded staging budget retains whole Unicode and escaped targets", () => {
  const url = "https://work.example/items/1";
  const candidates = Array.from({ length: 160 }, (_, index) => ({
    url: index < 130
      ? `https://irrelevant.example/${index}?${"x".repeat(7900)}`
      : `https://work.example/items/${index}?${"x".repeat(7900)}`,
    label: '😀"\\'.repeat(90),
  }));
  const frame = { url, frameId: 0, documentId: "d", tabId: 1 };
  const scan = { href: url, scope: "top_document", readyState: "complete", observedAt: Date.now(),
    anchorsInspected: candidates.length, candidates, coverage: "complete", reasons: [] };
  const draft = makeLinkDraft(scan, frame, "summary", "current", new Date(),
    (raw) => raw.startsWith("https://work.example/") ? { id: raw.split("?")[0], type: "document" } : null);
  assert.equal(draft.coverage.reason, "byte_limit");
  assert.ok(draft.targets.length > 0);
  assert.ok(draft.targets.every(target => candidates.find(candidate => candidate.url === target.url)));
  assert.ok(Buffer.byteLength(JSON.stringify(linkStageRequest(draft)), "utf8") <= 64 * 1024);
});

test("a loading selected frame retries once, and a replaced document cannot contribute", async () => {
  const url = "https://work.example/items/1";
  const frame = { url, frameId: 4, documentId: "readable", tabId: 21 };
  const scan = { href: url, scope: "frame_document", readyState: "loading", observedAt: Date.now(),
    anchorsInspected: 0, candidates: [], coverage: "unavailable", reasons: ["document_loading"] };
  let reads = 0;
  let waits = 0;
  let current = true;
  const read = (nextId) => ({
    async executeScript({ target }) {
      assert.deepEqual(target, { tabId: 21, documentIds: ["readable"] });
      reads++;
      return [{ frameId: 4, documentId: reads === 1 ? "readable" : nextId, result: reads === 1
        ? scan : { ...scan, coverage: "complete", reasons: [], readyState: "complete" } }];
    },
  });
  const ready = await readLinkFrame(read("readable"), frame, async () => current, async () => { waits++; });
  assert.equal(waits, 1);
  assert.equal(reads, 2);
  assert.equal(ready.coverage, "complete");
  reads = 0;
  assert.equal(await readLinkFrame(read("replacement"), frame, async () => current, async () => {}), null);
  reads = 0;
  assert.equal(await readLinkFrame(read("readable"), frame, async () => current, async () => { current = false; }), null);
  assert.equal(reads, 1);
});

test("only summaries request the selected readable frame and forward its opaque token", async () => {
  const top = { frameId: 0, documentId: "top", result: {
    href: "https://source.example/page", title: "Shell", content: "Menu",
    selection: "Highlight from the shell", readable: false,
  } };
  const child = { frameId: 7, documentId: "chosen", result: {
    href: "https://content.example/reader", title: "Reader", content: "A longer readable document.",
    selection: null, readable: true, truncated: true,
  } };
  const frameContext = ({ frameId, documentId, result }) => ({ frameId, documentId, url: result.href, tabId: 33 });
  const requests = [];
  const staged = [];
  const token = "044:" + crypto.randomUUID();
  const deps = {
    scripting: { async executeScript(options) { return options.files ? [] : [top, child]; } },
    storage: { async set() {} },
    stageLinks: async context => {
      staged.push(context);
      return token;
    },
    host: {
      async call(request) { requests.push(request); return { type: "run_started", run: {}, existing: false }; },
      async callAny(request) { requests.push(request); return { type: "run_started", run: {}, existing: false }; },
    },
    now: () => new Date(),
  };
  const tab = { id: 33, url: top.result.href, title: "Shell" };
  const prior = globalThis.chrome;
  globalThis.chrome = {
    webNavigation: { async getFrame({ frameId }) {
      const frame = frameId === 0 ? top : child;
      return { documentId: frame.documentId, url: frame.result.href, documentLifecycle: "active" };
    } },
  };
  try {
    const page = await readTab(tab, deps);
    assert.equal(page.content, child.result.content);
    assert.equal(page.selection, top.result.selection);
    assert.equal(staged.length, 0);
    assert.equal(requests.length, 0);

    await summarizeTab(tab, deps);
    assert.equal(await autoSummarizeTab(tab, deps), "started");
    assert.deepEqual(staged, Array.from({ length: 2 }, () => ({
      top: frameContext(top), selected: frameContext(child),
    })));
    assert.deepEqual(requests.map(({ type, outbound_links_stage, capture_truncated, url }) =>
      [type, outbound_links_stage, capture_truncated, url]),
    [["start_run", token, true, tab.url], ["start_auto_summary", token, true, tab.url]]);
  } finally {
    if (prior === undefined) delete globalThis.chrome;
    else globalThis.chrome = prior;
  }
});
