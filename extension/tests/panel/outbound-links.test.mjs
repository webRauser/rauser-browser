import assert from "node:assert/strict";
import test from "node:test";
import { storageKey } from "../../brand.ts";
import { ARTICLE_URL, CONFIG, artifact, descendants, install, recognized, settle, until } from "./harness.mjs";

// timing-ok: These timestamps are host evidence, compared to the displayed values, never to the clock.
const FIRST = "2026-11-23T15:01:00-08:00";
// timing-ok: Retained evidence and the latest attempt deliberately have different observation times.
const LATEST = "2026-11-23T15:02:00-08:00";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = (id, label, url = `https://docs.example/items/${id}`) => ({
  target: { artifact_id: `doc:${id}`, artifact_type: "document.page", url, label },
});
const status = (state, { observed_at = FIRST, n = 1, reason = null, anchors_inspected = 3 } = {}) => ({
  observation_id: uuid(n), observed_at, source_kind: "activity", source_event_id: uuid(99),
  coverage: { state, reason, anchors_inspected },
});
const checked = (collection, targets) => ({ collection, snapshot: { status: collection, targets } });
const view = (outbound_links) => ({ ...recognized(artifact("doc:source", "Source")), outbound_links });
const tab = { id: 1, url: ARTICLE_URL, title: "Source" };
const list = (page) => page.el("outbound-links-list");
const links = (page) => descendants(list(page)).filter((node) => node.tagName === "A");
const detail = (page) => page.el("outbound-links");
const coverage = (page) => page.el("outbound-links-coverage");
const retained = (page) => page.el("outbound-links-retained");
const summary = {
  // timing-ok: This summary predates the checked capture fixture; its exact age is irrelevant.
  summarized_at: "2026-11-22T15:00:00-08:00", document_type: "report", category: "work",
  importance: "medium", summary_path: "summaries/source.summary.md", harness: "codex",
  overview: "Saved overview. Model reference: https://model.example/reference",
};

function hint(value, area = "session") {
  for (const listener of chrome.storage.onChanged.registered) {
    listener({ [storageKey("outbound_links_changed_v1")]: { newValue: value } }, area);
  }
}

function publication(n, revision = "1") {
  return { version: 1, policy_revision: revision, observation_id: uuid(n) };
}

test("checked links use literal titles, labels and IDs, even on a summary-only page with no harness", async () => {
  const label = '<img src="https://label.example/pixel">';
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? {
    type: "artifact_result", recognized: false, artifact: null, summary,
    outbound_links: checked(status("complete"), [
      { ...target(1, "Superseded label"), recorded_title: "Recorded <title>" },
      target(2, label), target(3, null, "http://docs.example/items/3"),
      target(4, "Refused scheme", "javascript:void(0)"),
      target(5, "Refused credentials", "https://fixture:placeholder@docs.example/items/5"),
    ]),
  } : undefined });
  await until(() => links(page).length === 3, "host-checked links");
  assert.deepEqual(links(page).map(({ textContent }) => textContent), ["Recorded <title>", label, "doc:3"]);
  assert.deepEqual(links(page).map(({ href }) => href), [
    "https://docs.example/items/1", "https://docs.example/items/2", "http://docs.example/items/3",
  ]);
  assert.ok(links(page).every(({ target, rel }) => target === "_blank" && rel === "noopener noreferrer"));
  assert.match(list(page).textContent, /document\.page/);
  assert.doesNotMatch(list(page).textContent, /Superseded label|Model reference|model\.example/);
  assert.equal(descendants(list(page)).some((element) => element.tagName === "IMG"), false);
  assert.equal(page.el("page-summary-text").textContent, summary.overview);
  assert.match(coverage(page).textContent, /complete.*15:01:00-08:00.*3 anchors inspected/i);
  assert.equal(page.calls("permissions.request"), 0);
  assert.equal(page.sent("start_run").length, 0);
  assert.equal(page.sent("list_runs").length, 0);
  assert.deepEqual(page.created, []);
});

test("publication refresh retains the original partial timestamp on unavailable, then clears on complete empty", async () => {
  let outbound = checked(status("partial", { reason: "anchor_limit" }), [target(1, "Earlier partial target")]);
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? view(outbound) : undefined });
  await until(() => links(page).length === 1, "the partial list");
  await settle();
  const before = page.sent("get_artifact").length;
  assert.match(coverage(page).textContent, /partial.*anchor limit reached/i);
  outbound = { ...outbound, collection: status("unavailable", { observed_at: LATEST, n: 2, reason: "document_changed" }) };
  for (const invalid of [null, [], { ...publication(2), version: 2 }, { ...publication(2), observation_id: "short" },
    { ...publication(2), policy_revision: "" }, publication(2, "x".repeat(129)), publication(2, "2"),
    { ...publication(2), label: "Do not render this" }]) hint(invalid);
  hint(publication(2), "local");
  await settle();
  assert.equal(page.sent("get_artifact").length, before);
  hint(publication(2));
  hint(publication(2));
  await until(() => /unavailable/i.test(coverage(page).textContent), "unavailable latest collection");
  assert.match(coverage(page).textContent, /15:02:00-08:00.*document changed/i);
  assert.match(retained(page).textContent, /partial.*15:01:00-08:00/i);
  assert.deepEqual(links(page).map((link) => link.textContent), ["Earlier partial target"]);
  assert.equal(page.sent("get_artifact").length, before + 1);

  outbound = checked(status("complete", { observed_at: LATEST, n: 3 }), []);
  hint(publication(3));
  await until(() => /no outbound artifact links found/i.test(page.el("outbound-links-empty").textContent), "complete empty list");
  assert.equal(retained(page).hidden, true);
  assert.equal(links(page).length, 0);
});

test("legacy absence, unavailable without a list, and partial empty use distinct messages", async () => {
  let outbound;
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? view(outbound) : undefined });
  await until(() => !detail(page).hidden, "legacy evidence state");
  assert.match(coverage(page).textContent, /links were not collected/i);
  assert.equal(page.el("outbound-links-empty").hidden, true);

  outbound = { collection: status("unavailable", { reason: "restricted_frame" }), snapshot: null };
  hint(publication(1));
  await until(() => /unavailable/i.test(coverage(page).textContent), "unavailable without a snapshot");
  assert.match(page.el("outbound-links-empty").textContent, /no usable link list/i);
  assert.equal(retained(page).hidden, true);

  outbound = checked(status("partial", { n: 2, reason: "deadline" }), []);
  hint(publication(2));
  await until(() => /partial/i.test(coverage(page).textContent), "empty partial snapshot");
  assert.match(page.el("outbound-links-empty").textContent, /no links found in the inspected portion/i);
});

function deferred() {
  let release;
  const reply = new Promise((resolve) => { release = resolve; });
  return { reply, release };
}

const withTarget = (label) => view(checked(status("complete"), [target(1, label)]));

test("publication hints during a pending read coalesce into one follow-up host read", async () => {
  let reply = withTarget("Initial");
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? reply : undefined });
  await until(() => list(page).textContent.includes("Initial"), "the initial list");
  await settle();
  const before = page.sent("get_artifact").length;
  const pending = deferred();
  reply = pending.reply;
  hint(publication(2));
  hint(publication(3));
  hint(publication(4));
  assert.equal(page.sent("get_artifact").length, before + 1);
  await settle();
  reply = withTarget("Fresh host result");
  pending.release(withTarget("Earlier host result"));
  await until(() => list(page).textContent.includes("Fresh host result"), "the trailing lookup");
  assert.equal(page.sent("get_artifact").length, before + 2);
});

test("a publication while the same tab is settling still refreshes its checked evidence", async () => {
  let reply = withTarget("Initial");
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? reply : undefined });
  await until(() => list(page).textContent.includes("Initial"), "the initial list");
  await settle();
  const before = page.sent("get_artifact").length;
  reply = withTarget("Published while the tab settled");
  page.tabUpdated({ status: "complete" });
  hint(publication(2));
  await until(() => list(page).textContent.includes("Published while the tab settled"), "the tab's refreshed list");
  assert.equal(page.sent("get_artifact").length, before + 1);
});

test("a publication with no configured home cannot load or reveal link evidence", async () => {
  const page = await install({ tab, config: { ...CONFIG, storage: null }, intercept: (request) => request.type === "get_artifact" ? withTarget("Unexpected") : undefined });
  await until(() => page.el("page-title").textContent === tab.title, "the current page");
  hint(publication(2));
  await settle();
  assert.equal(page.sent("get_artifact").length, 0);
  assert.equal(detail(page).hidden, true);
});

test("a reply from a previous tab cannot appear even when its URL and title match", async () => {
  let reply = withTarget("Original list");
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? reply : undefined });
  await until(() => links(page).length === 1, "the original list");
  await settle();
  const before = page.sent("get_artifact").length;
  const previous = deferred();
  const current = deferred();
  reply = previous.reply;
  hint(publication(2));
  await settle();
  detail(page).open = true;
  page.navigate(tab.url, 2);
  await until(() => detail(page).hidden, "the old tab's link evidence to clear");
  assert.equal(detail(page).open, false);
  reply = current.reply;
  previous.release(withTarget("Stale tab result"));
  await until(() => page.sent("get_artifact").length === before + 2, "the new tab's lookup");
  assert.equal(links(page).length, 0);
  current.release(withTarget("Current tab result"));
  await until(() => list(page).textContent.includes("Current tab result"), "the current tab's links");
  page.followLink("chrome://version", "Chrome");
  await until(() => detail(page).hidden, "the new non-web tab to clear link evidence");
  assert.equal(links(page).length, 0);
});

for (const change of ["home", "revision"]) {
  test(`a ${change} change immediately blocks pending replies and out-of-scope hints`, async () => {
    let reply = withTarget("Previous config");
    const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? reply : undefined });
    await until(() => links(page).length === 1, "the original list");
    await settle();
    const before = page.sent("get_artifact").length;
    const previous = deferred();
    const current = deferred();
    reply = previous.reply;
    hint(publication(2));
    await settle();
    page.state.revision = "2";
    if (change === "home") page.state.config.storage.root = "/new-fixture-home";
    page.policyChanged();
    hint(publication(3));
    hint(publication(4, "2"));
    assert.equal(detail(page).hidden, true);
    assert.equal(page.sent("get_artifact").length, before + 1);
    reply = current.reply;
    previous.release(withTarget("Stale config result"));
    await until(() => page.sent("get_artifact").length === before + 2, "the refreshed config's lookup");
    assert.equal(links(page).length, 0);
    current.release(withTarget("Current config result"));
    await until(() => list(page).textContent.includes("Current config result"), "the current config's links");
    hint(publication(5));
    assert.equal(page.sent("get_artifact").length, before + 2);
  });
}

test("host exit invalidates checked evidence and a pending reply before the next port answers", async () => {
  let reply = withTarget("Previous connection");
  const page = await install({ tab, intercept: (request) => request.type === "get_artifact" ? reply : undefined });
  await until(() => links(page).length === 1, "the original list");
  await settle();
  const previous = deferred();
  const current = deferred();
  reply = previous.reply;
  hint(publication(2));
  await settle();
  page.hostExits();
  assert.match(coverage(page).textContent, /could not load/i);
  assert.equal(links(page).length, 0);
  reply = current.reply;
  hint(publication(3));
  previous.release(withTarget("Late reply from the closed port"));
  await until(() => page.state.ports.length === 2, "the new host port");
  assert.equal(links(page).length, 0);
  current.release(withTarget("Current connection"));
  await until(() => list(page).textContent.includes("Current connection"), "the new host's reply");
});
