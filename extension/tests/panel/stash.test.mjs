import assert from "node:assert/strict";
import test from "node:test";
import { ARTICLE_URL, WARNING_SEEN_KEY, install, startsRun, summarizePanel, until } from "./harness.mjs";

const pageTab = { id: 1, url: ARTICLE_URL, title: "Saved article" };
const saved = (needsSummary, alreadySaved = false) => ({
  type: "stash_page_result", already_saved: alreadySaved, needs_summary: needsSummary,
});

test("Stash reuses an owned summary without reading the page or starting an agent", async () => {
  const panel = await install({
    tab: pageTab,
    intercept: (request) => request.type === "stash_page" ? saved(false, true) : null,
  });
  await until(() => !panel.el("stash-page").disabled, "the Stash action");
  panel.el("stash-page").click();
  await until(() => panel.el("stash-status").textContent === "Already in Stash.", "the existing entry confirmation");
  const [request] = panel.sent("stash_page");
  assert.equal(request.expected_revision, "1");
  assert.equal(request.url, ARTICLE_URL);
  assert.equal(request.title, pageTab.title);
  assert.equal(panel.sent("start_run").length, 0);
  assert.equal(panel.state.injections.length, 0);
});

test("Stash requests a summary through the normal run workflow after the host saves the entry", async () => {
  const panel = await summarizePanel({
    local: new Map([[WARNING_SEEN_KEY, true]]),
    intercept: (request) => request.type === "stash_page" ? saved(true) : startsRun(request),
  });
  await until(() => !panel.el("stash-page").disabled, "the Stash action");
  panel.el("stash-page").click();
  await until(() => /Follow the summary in Activity/.test(panel.el("stash-status").textContent), "the summary notice");
  assert.deepEqual(
    panel.state.requests.filter(({ type }) => type === "stash_page" || type === "start_run").map(({ type }) => type),
    ["stash_page", "start_run"],
  );
  assert.equal(panel.sent("start_run")[0].url, ARTICLE_URL);
  await until(() => /Queued/.test(panel.el("run-area").textContent), "the ordinary summary run card");
});

test("Stash acknowledges a saved source and explains how to retry when the harness is missing", async () => {
  const panel = await install({
    tab: pageTab,
    intercept: (request) => request.type === "stash_page" ? saved(true) : null,
  });
  await until(() => !panel.el("stash-page").disabled, "the Stash action");
  panel.el("stash-page").click();
  await until(() => /Saved to Stash.*summary harness/.test(panel.el("stash-status").textContent), "the retry instruction");
  assert.equal(panel.sent("start_run").length, 0);
});

test("Open Brauser Stash focuses its own main-area tab", async () => {
  const panel = await install({ tasksContexts: [
    { documentUrl: "chrome-extension://test-id/explorer.html", tabId: 5, windowId: 2 },
    { documentUrl: "chrome-extension://test-id/stash.html", tabId: 7, windowId: 3 },
  ] });
  panel.el("open-stash").click();
  await until(() => panel.state.windowUpdates.length === 1, "the Stash window");
  assert.deepEqual(panel.created, []);
  assert.deepEqual(panel.state.tabUpdates, [{ tabId: 7, active: true }]);
  assert.deepEqual(panel.state.windowUpdates, [{ windowId: 3, focused: true }]);
  assert.equal(panel.sent("start_run").length, 0);
});

test("Open Brauser Stash opens a tab when its page is closed", async () => {
  const panel = await install({});
  panel.el("open-stash").click();
  await until(() => panel.created.length === 1, "the new Stash tab");
  assert.equal(panel.created[0].url, "chrome-extension://test-id/stash.html");
  assert.equal(panel.calls("permissions.request"), 0);
});
