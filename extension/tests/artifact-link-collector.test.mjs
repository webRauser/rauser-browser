import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// This prerequisite has no production build/call site yet. Compile the real
// module in memory, then serialize ONLY the injected function, as Chrome does.
const source = readFileSync(new URL("../artifact-link-collector.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports, TextEncoder, URL });
const { scanArtifactLinkCandidates, shapeArtifactLinkCandidates } = exports;
const HREF = "https://source.example/docs/current?mode=view#heading";
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function element(tag, { href, text = "", children = [], style = {}, rect = true, hidden = false } = {}) {
  const node = {
    nodeType: 1, tagName: tag.toUpperCase(), hidden,
    style: { display: "block", visibility: "visible", opacity: "1", contentVisibility: "visible", ...style },
    getAttribute: (name) => name === "href" ? href ?? null : null,
    getClientRects: () => rect ? [{ width: 10, height: 10 }] : [],
    parentElement: null, parentNode: null, nextSibling: null, firstChild: null,
  };
  const nodes = [...(text ? [{ nodeType: 3, nodeValue: text }] : []), ...children];
  nodes.forEach((child, i) => {
    child.parentElement = node;
    child.parentNode = node;
    child.nextSibling = nodes[i + 1] ?? null;
  });
  node.firstChild = nodes[0] ?? null;
  return node;
}
const anchor = (href, text = "", options = {}) => element("a", { href, text, ...options });

function page(links = [], { href = HREF, base = href, readyState = "complete", frame = false, now = () => 0 } = {}) {
  const root = element("html");
  const body = element("body");
  body.parentElement = root;
  for (const link of links) {
    if (!link.parentElement) link.parentElement = body;
  }
  const accessed = [];
  const collection = new Proxy(links, {
    get(target, key) {
      assert.notEqual(key, "length", "must not materialize document.links");
      accessed.push(key);
      return target[key];
    },
  });
  const document = { links: collection, baseURI: base, readyState, documentElement: root, body };
  const window = { location: { href }, getComputedStyle: (node) => node.style };
  window.top = frame ? {} : window;
  // Any accidental network, storage, iframe aggregation or browser action fails.
  const forbidden = () => { throw new Error("forbidden side effect"); };
  const scope = { document, window, URL, TextEncoder, performance: { now }, fetch: forbidden,
    localStorage: new Proxy({}, { get: forbidden }), chrome: new Proxy({}, { get: forbidden }) };
  return { scope, accessed, root, body };
}
const run = ({ scope }, limits = {}) => plain(vm.runInNewContext(
  `(${scanArtifactLinkCandidates})(${JSON.stringify(limits)})`, scope,
));
const urls = (result) => result.candidates.map((candidate) => candidate.url);

test("injected source resolves relative/base links and preserves actual frame href", () => {
  const result = run(page([anchor("../target?a=1#part", "Target"), anchor("//other.example/x")], {
    base: "https://base.example/folder/child/", frame: true,
  }));
  assert.equal(result.href, HREF);
  assert.equal(result.scope, "frame_document");
  assert.equal(result.readyState, "complete");
  assert.equal(result.anchorsInspected, 2);
  assert.deepEqual(urls(result), ["https://base.example/folder/target?a=1#part", "https://other.example/x"]);
  assert.equal(result.candidates[0].label, "Target");
  assert.equal(result.coverage, "complete");
});

test("only direct safe HTTP(S) anchors qualify, with no route or suffix classifier", () => {
  const result = run(page([
    ...["javascript:alert(1)", "data:text/plain,x", "file:///tmp/x", "mailto:a@example.com", "blob:https://source.example/a",
      "https://name:secret@other.example/x", "https://name@other.example/x", "http://[invalid"].map((href) => anchor(href)),
    element("area", { href: "https://other.example/map" }), element("link", { href: "https://other.example/style" }),
    anchor("http://other.example/ordinary"), anchor("https://other.example/file.pdf"), anchor("/settings"),
  ]));
  assert.deepEqual(urls(result), ["http://other.example/ordinary", "https://other.example/file.pdf", "https://source.example/settings"]);
  assert.equal(result.coverage, "complete");
});

test("hidden/unrendered anchors are ignored; offscreen and navigation links remain eligible", () => {
  const fadedParent = element("nav", { style: { opacity: "0" } });
  const faded = anchor("/faded");
  faded.parentElement = fadedParent;
  const result = run(page([
    anchor("/hidden", "", { hidden: true }), anchor("/no-box", "", { rect: false }),
    anchor("/invisible", "", { style: { visibility: "hidden" } }), faded,
    anchor("/nav", "Navigation"), anchor("/offscreen", "Offscreen"),
  ]));
  assert.deepEqual(urls(result), ["https://source.example/nav", "https://source.example/offscreen"]);
});

test("labels are inert bounded rendered text, never HTML, attributes or commands", () => {
  const injected = '<img src=x onerror="throw 1"> [run](javascript:x)';
  const result = run(page([anchor("/target", "", { children: [
    element("script", { text: "do not include" }), element("span", { text: "hidden", style: { display: "none" } }),
    element("span", { text: `  ${injected}\n  label\ud800` }),
  ] })]));
  assert.equal(result.candidates[0].label, `${injected} label\ufffd`);
  assert.equal(result.coverage, "complete");
  const long = run(page([anchor("/long", "😀".repeat(300))]));
  assert.ok([...long.candidates[0].label].length <= 256);
  assert.doesNotMatch(long.candidates[0].label, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  assert.equal(long.coverage, "partial");
  assert.ok(long.reasons.includes("label_limit"));
});

test("exact repeats keep first order and first nonempty label; self fragments are excluded", () => {
  const result = run(page([
    anchor("#other"), anchor("https://source.example/docs/current?mode=view"),
    anchor("/b"), anchor("/a", "First"), anchor("/b", "Second"), anchor("/a", "Ignored"),
  ]));
  assert.deepEqual(result.candidates, [
    { url: "https://source.example/b", label: "Second" }, { url: "https://source.example/a", label: "First" },
  ]);
});

test("successful empty differs from loading, missing and unrendered documents", () => {
  const empty = run(page());
  assert.equal(empty.scope, "top_document");
  assert.equal(empty.coverage, "complete");
  assert.deepEqual(empty.candidates, []);
  const loading = run(page([], { readyState: "loading" }));
  assert.equal(loading.coverage, "unavailable");
  assert.deepEqual(loading.reasons, ["document_loading"]);
  assert.equal(loading.readyState, "loading");
  const missing = page();
  delete missing.scope.document;
  assert.equal(run(missing).coverage, "unavailable");
  const unrendered = page();
  unrendered.root.getClientRects = () => [];
  assert.deepEqual(run(unrendered).reasons, ["document_unrendered"]);
});

test("interactive documents scan once and the collector never reads other frames", () => {
  const fixture = page([anchor("/visible")], { readyState: "interactive" });
  Object.defineProperty(fixture.scope.document, "iframes", { get() { assert.fail("frame aggregation"); } });
  assert.equal(run(fixture).coverage, "complete");
});

test("500 inspected links is a hard bound with honest exact-boundary coverage", () => {
  const fixture = page(Array.from({ length: 501 }, (_, i) => anchor(`/x/${i}`)));
  const capped = run(fixture);
  assert.equal(capped.anchorsInspected, 500);
  assert.equal(capped.candidates.length, 500);
  assert.equal(capped.coverage, "partial");
  assert.ok(capped.reasons.includes("anchor_limit"));
  assert.equal(fixture.accessed.length, 501, "one existence-only lookahead");
  assert.equal(run(page(Array.from({ length: 500 }, (_, i) => anchor(`/x/${i}`)))).coverage, "complete");
});

test("candidate item cap is separate from the 100 recognized-target limit", () => {
  const fixture = page(Array.from({ length: 130 }, (_, i) => anchor(`/navigation/${i}`))
    .concat([anchor("https://target.example/recognized")]));
  const scan = run(fixture);
  assert.equal(scan.candidates.length, 131);
  const shaped = plain(shapeArtifactLinkCandidates(scan, (candidate) => candidate.url.startsWith("https://target.example/")));
  assert.deepEqual(urls(shaped), ["https://target.example/recognized"]);
  assert.equal(shaped.coverage, "complete");
  const capped = run(fixture, { maxCandidates: 3 });
  assert.equal(capped.candidates.length, 3);
  assert.ok(capped.reasons.includes("candidate_limit"));
});

test("cooperative deadline and traversal caps report gaps without pretending empty success", () => {
  let ticks = 0;
  const expired = run(page([anchor("/target")], { now: () => ticks++ }), { maxDurationMs: 1 });
  assert.equal(expired.coverage, "partial");
  assert.ok(expired.reasons.includes("deadline"));
  const deep = anchor("/deep");
  for (let i = 0, node = deep; i < 100; i++) {
    const parent = element("div");
    node.parentElement = parent;
    node = parent;
  }
  const limited = run(page([deep]), { maxTraversalSteps: 5 });
  assert.equal(limited.coverage, "partial");
  assert.ok(limited.reasons.includes("traversal_limit"));
});

test("a DOM failure reports unavailable before scanning, or partial after a prefix", () => {
  const first = anchor("/first");
  const broken = anchor("/broken");
  broken.getClientRects = () => { throw new Error("private page details"); };
  const result = run(page([first, broken]));
  assert.deepEqual(urls(result), ["https://source.example/first"]);
  assert.equal(result.coverage, "partial");
  assert.ok(result.reasons.includes("dom_unavailable"));
  assert.ok(!JSON.stringify(result).includes("private page details"));
});

test("URL limits omit whole destinations, including encoded Unicode expansion", () => {
  const prefix = "https://target.example/";
  const exact = prefix + "a".repeat(8192 - prefix.length);
  const result = run(page([anchor(exact), anchor(exact + "b"), anchor(prefix + "界".repeat(1000)), anchor("/after")]));
  assert.deepEqual(urls(result), [exact, "https://source.example/after"]);
  assert.equal(result.coverage, "partial");
  assert.ok(result.reasons.includes("url_limit"));
});

test("scan result is bounded by UTF-8 JSON bytes including escapes, Unicode and envelope", () => {
  const fixture = page(Array.from({ length: 100 }, (_, i) => anchor(`/x/${i}?q=${"界".repeat(20)}`, '\u0001"\\界😀\ud800'.repeat(50))));
  const scan = run(fixture, { maxResultBytes: 4096 });
  assert.ok(bytes(scan) <= 4096, `${bytes(scan)} bytes`);
  assert.equal(scan.coverage, "partial");
  assert.ok(scan.reasons.includes("result_byte_limit"));
  assert.ok(scan.candidates.length > 0);
  for (const candidate of scan.candidates) assert.ok(Buffer.byteLength(candidate.url) <= 8192);
});

test("unrepresentable actual href is unavailable, never a clipped source URL", () => {
  const href = "https://source.example/" + "a".repeat(9000);
  const result = run(page([anchor("/target")], { href }));
  assert.equal(result.coverage, "unavailable");
  assert.equal(result.href, null);
  assert.deepEqual(result.candidates, []);
});

test("early unavailable results also respect the encoded result cap", () => {
  const href = "https://source.example/" + "x".repeat(7000);
  for (const fixture of [page([], { href, readyState: "loading" }), page([], { href })]) {
    if (fixture.scope.document.readyState === "complete") delete fixture.scope.document;
    const result = run(fixture, { maxResultBytes: 1024 });
    assert.ok(bytes(result) <= 1024, `${bytes(result)} bytes`);
    assert.equal(result.href, null);
    assert.equal(result.coverage, "unavailable");
    assert.ok(result.reasons.includes("result_byte_limit"));
  }
});

test("shaping bounds recognized items only, preserving prefix order and coverage", () => {
  const scan = run(page(Array.from({ length: 105 }, (_, i) => anchor(`/x/${i}`))));
  const shaped = plain(shapeArtifactLinkCandidates(scan, () => true));
  assert.equal(shaped.candidates.length, 100);
  assert.equal(shaped.coverage, "partial");
  assert.ok(shaped.reasons.includes("item_limit"));
  assert.deepEqual(urls(shaped), urls(scan).slice(0, 100));
  const exact = plain(shapeArtifactLinkCandidates(scan, (candidate) => Number(candidate.url.split("/").at(-1)) < 100));
  assert.equal(exact.coverage, "complete");
});

test("shaping reserves caller envelope bytes and measures worst-case JSON exactly", () => {
  const scan = run(page(Array.from({ length: 100 }, (_, i) => anchor(`/x/${i}?q=${"界".repeat(30)}`, '\u0001"\\界😀\ud800'.repeat(30)))));
  const envelope = { request: "synthetic", metadata: '界"\\\u0001'.repeat(1000) };
  const reservedEnvelopeBytes = bytes(envelope);
  const shaped = plain(shapeArtifactLinkCandidates(scan, () => true, { reservedEnvelopeBytes }));
  assert.ok(bytes(shaped) + reservedEnvelopeBytes <= 64 * 1024);
  assert.equal(shaped.coverage, "partial");
  assert.ok(shaped.reasons.includes("result_byte_limit"));
  assert.ok(shaped.candidates.length > 0);
});

test("matching failure never returns raw candidates or an authoritative identity", () => {
  const scan = run(page([anchor("/target")]));
  const shaped = plain(shapeArtifactLinkCandidates(scan, () => { throw new Error("private rules"); }));
  assert.equal(shaped.coverage, "unavailable");
  assert.deepEqual(shaped.candidates, []);
  assert.deepEqual(shaped.reasons, ["matching_unavailable"]);
  assert.ok(!JSON.stringify(shaped).includes("private rules"));
});

test("lowered item/byte caps omit whole candidates and keep later fitting destinations", () => {
  const long = "https://target.example/" + "a".repeat(2000);
  const scan = run(page([anchor(long), anchor("/small"), anchor("/later")]));
  const shaped = plain(shapeArtifactLinkCandidates(scan, () => true, {
    maxItems: 1, maxResultBytes: 1024, reservedEnvelopeBytes: 0,
  }));
  assert.deepEqual(urls(shaped), ["https://source.example/small"]);
  assert.ok(shaped.reasons.includes("result_byte_limit"));
  assert.ok(shaped.reasons.includes("item_limit"));
  assert.ok(bytes(shaped) <= 1024);
  assert.deepEqual(urls(scan), [long, "https://source.example/small", "https://source.example/later"], "shaping does not mutate its scan");
});

test("limits cannot raise hard ceilings; invalid envelope reservations fail closed", () => {
  const scan = run(page(Array.from({ length: 501 }, (_, i) => anchor(`/x/${i}`))), {
    maxAnchors: 9999, maxCandidates: 9999, maxResultBytes: 1e9,
  });
  assert.equal(scan.anchorsInspected, 500);
  assert.equal(scan.candidates.length, 500);
  assert.equal(shapeArtifactLinkCandidates(scan, () => true, { maxItems: 9999 }).candidates.length, 100);
  for (const reservedEnvelopeBytes of [-1, NaN, Infinity, 64 * 1024, 1.5]) {
    assert.throws(() => shapeArtifactLinkCandidates(scan, () => true, { reservedEnvelopeBytes }), /envelope/);
  }
  const empty = shapeArtifactLinkCandidates(run(page()), () => true, { maxItems: 0 });
  assert.equal(empty.coverage, "complete");
});

test("bounded reason codes preserve partial/unavailable coverage through an empty matcher", () => {
  const partial = run(page([anchor("/first"), anchor("/second")]), { maxCandidates: 1 });
  const filtered = plain(shapeArtifactLinkCandidates(partial, () => false));
  assert.equal(filtered.coverage, "partial");
  assert.deepEqual(filtered.candidates, []);
  assert.ok(filtered.reasons.includes("candidate_limit"));
  const unavailable = run(page([], { readyState: "loading" }));
  const shaped = plain(shapeArtifactLinkCandidates(unavailable, () => { assert.fail("must not match unavailable evidence"); }));
  assert.deepEqual(shaped, unavailable);
});

test("label subtrees share a global traversal bound, without unbounded innerText reads", () => {
  const dense = anchor("/dense", "", { children: Array.from({ length: 10000 }, () => element("span")) });
  for (const property of ["innerText", "textContent", "innerHTML"]) {
    Object.defineProperty(dense, property, { get() { assert.fail(`unbounded ${property}`); } });
  }
  const result = run(page([dense, anchor("/after")]), { maxTraversalSteps: 30 });
  assert.deepEqual(urls(result), ["https://source.example/dense"]);
  assert.equal(result.anchorsInspected, 1);
  assert.equal(result.coverage, "partial");
  assert.ok(result.reasons.includes("traversal_limit"));
});

test("deadline expiry after a prefix retains that prefix and never inspects the tail", () => {
  let expired = false;
  const first = anchor("/first");
  first.getAttribute = () => { expired = true; return "/first"; };
  const fixture = page([first, anchor("/never")], { now: () => expired ? 101 : 0 });
  const result = run(fixture);
  assert.deepEqual(urls(result), ["https://source.example/first"]);
  assert.equal(result.coverage, "partial");
  assert.ok(result.reasons.includes("deadline"));
  assert.equal(result.anchorsInspected, 1);
});
