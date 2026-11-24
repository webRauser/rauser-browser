import assert from "node:assert/strict";
import test from "node:test";
import { a11yBrowser } from "../../../scripts/a11y-browser.mjs";
import { ORIGIN, audit, focused, installChrome, routeFixturePages } from "./fixture.mjs";

const item = (n, overrides = {}) => ({
  id: n.toString(16).padStart(64, "0"), version: "a".repeat(64),
  title: `Saved page ${n}`, url: `https://work.example.test/article/${n}`,
  saved_at: new Date(Date.UTC(2026, 10, 23, 0, -n)).toISOString(),
  done: false, summary: null, ...overrides,
});
const summary = (overrides = {}) => ({
  path: "summaries/synthetic-page.summary.md", document_type: "Decision", category: "Quality",
  importance: "high", summarized_at: item(0).saved_at, overview: "A saved overview with <b>literal markup</b>.",
  ...overrides,
});

async function stashFixture(t, entries, options = {}) {
  const browser = await a11yBrowser(t);
  if (!browser) return null;
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1180, height: 800 },
    colorScheme: options.colorScheme ?? "light",
    serviceWorkers: "block",
  });
  await routeFixturePages(t, context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));

  const state = { entries, revision: "1", configured: true, configIssue: null, requests: [], hook: null, ...options };
  const storage = {
    root: "/fixture-home", profile: "neutral", log_dir: "logs", pages_dir: "notes", later_dir: "later",
    artifacts_dir: "artifacts", summaries_dir: "summaries", knowledge_base_dir: null,
  };
  await page.exposeFunction("fixtureNativeRequest", async (request) => {
    state.requests.push(request);
    const envelope = { request_id: request.request_id, protocol_version: request.protocol_version };
    if (request.type === "get_config") {
      return {
        ...envelope, type: "config_result", revision: state.revision, config_issue: state.configIssue,
        config: {
          storage: state.configured ? storage : null, capture_enabled: false, strip_params: [], agent: null,
          summary_vocabulary: { document_types: [], categories: [] }, auto_summary: { enabled: false, dwell_secs: 0 },
          adapters: { format: 1, artifacts: [] },
        },
        agent_status: { state: "not_set_up", harness_version: null, message: null },
        adapter_issue: null, adapter_warnings: [], adopted_state: { issue: null, revision: "missing", warnings: [], full: false },
      };
    }
    if (request.expected_revision !== state.revision) {
      return { ...envelope, type: "error", code: "conflict", message: "Configuration changed. Refresh Stash and try again." };
    }
    const override = await state.hook?.(request);
    if (override) return { ...envelope, ...override };
    if (request.type === "list_stash") {
      const all = [...state.entries].sort((a, b) => b.saved_at.localeCompare(a.saved_at) || b.id.localeCompare(a.id));
      const start = request.after === null ? 0 : all.findIndex((entry) => entry.id === request.after) + 1;
      assert.ok(request.after === null || start > 0, "continuation must name a saved entry");
      const query = request.query.toLowerCase();
      const matching = all.slice(start).filter(({ done, title, url }) =>
        (request.state === "all" || done === (request.state === "done")) &&
        [title, url].some((value) => value.toLowerCase().includes(query)));
      const items = matching.slice(0, 20);
      return { ...envelope, type: "stash_listed", items, next: matching.length > items.length ? items.at(-1).id : null };
    }
    if (request.type === "open_summary") {
      const entry = state.entries.find(({ url }) => url === request.url);
      assert.equal(request.summary_path, entry?.summary?.path);
      return { ...envelope, type: "summary_opened", relative_path: request.summary_path };
    }
    assert.equal(request.type, "complete_stash");
    const entry = state.entries.find(({ id }) => id === request.id);
    assert.ok(entry);
    assert.equal(request.version, entry.version);
    entry.done = true;
    return { ...envelope, type: "stash_completed" };
  });
  await page.addInitScript(installChrome, { state: "configured", pageName: "stash", runs: [], bridge: true });
  await page.goto(`${ORIGIN}/stash.html`);
  return { page, state };
}

const result = (page, text) => page.getByRole("status").filter({ hasText: text }).waitFor();
const rows = (page) => page.locator("#stash-list .explorer-row");

test("Stash uses Explorer rows, pages, and revision-bound actions for saved and completed pages", async (t) => {
  const title = "Newest <img src=x onerror=alert(1)> saved page";
  const newest = item(1, { title, summary: summary() });
  const unfinished = item(2, { title: "Unfinished source", url: "https://other.example.test/read" });
  const entries = [item(22, { done: true }), item(21), ...Array.from({ length: 18 }, (_, n) => item(n + 3)), unfinished, newest];
  const fixture = await stashFixture(t, entries, { width: 640 });
  if (!fixture) return;
  const { page, state } = fixture;
  const detail = page.getByRole("region", { name: "Selected saved page" });
  const filter = page.getByLabel("Reading status");
  await result(page, /Showing 20 saved pages/);
  assert.equal(await filter.inputValue(), "open");
  assert.equal(await rows(page).count(), 20);
  assert.equal(await rows(page).first().locator(".explorer-row-title").textContent(), title);
  assert.equal(await detail.locator("img, b").count(), 0);
  assert.equal(await detail.locator(".explorer-overview").textContent(), newest.summary.overview);
  assert.match(await detail.textContent(), /work\.example\.test.*Quality.*Decision.*high importance/u);
  assert.deepEqual(await detail.locator("time").evaluateAll((nodes) => nodes.map((node) => node.dateTime)), [newest.saved_at, newest.summary.summarized_at]);
  const source = detail.getByRole("link", { name: /Open source/ });
  assert.equal(await source.getAttribute("href"), newest.url);
  assert.equal(await source.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await source.getAttribute("target"), "_blank");
  await page.getByRole("button", { name: "Go to selected page" }).click();
  await focused(page, "#stash-detail h2");
  const openReply = Promise.withResolvers();
  state.hook = ({ type }) => type === "open_summary" ? openReply.promise : null;
  await detail.getByRole("button", { name: "Open summary" }).click();
  await result(page, /Opening the saved summary/);
  await rows(page).nth(1).click();
  openReply.resolve(null);
  await result(page, /Opened the saved summary/);
  state.hook = null;
  const open = state.requests.find(({ type }) => type === "open_summary");
  assert.deepEqual([open.url, open.summary_path, open.expected_revision], [newest.url, newest.summary.path, "1"]);
  await rows(page).first().click();

  const more = page.getByRole("button", { name: "Load more saved pages" });
  await more.focus();
  state.hook = ({ type, after }) => type === "list_stash" && after ? { type: "stash_listed", items: [newest], next: null } : null;
  await more.press("Enter");
  await result(page, /Could not load more saved pages.*result page changed/);
  assert.equal(await rows(page).count(), 20);
  await focused(page, "#stash-more");
  state.hook = null;
  await more.press("Enter");
  await result(page, /Showing 21 saved pages/);
  await focused(page, `#stash-list button[data-stash-id="${item(21).id}"]`);
  assert.deepEqual(state.requests.filter(({ type }) => type === "list_stash").map(({ state, query, after }) => [state, query, after]),
    [["open", "", null], ["open", "", item(20).id], ["open", "", item(20).id]]);
  assert.equal(await more.isVisible(), false);

  await detail.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Marked as done/);
  await focused(page, `#stash-list button[data-stash-id="${unfinished.id}"]`);
  assert.equal(await rows(page).count(), 20);
  assert.match(await detail.textContent(), /Summary needed/u);
  assert.equal(await detail.getByRole("button", { name: "Open summary" }).count(), 0);
  const complete = state.requests.find(({ type }) => type === "complete_stash");
  assert.deepEqual([complete.id, complete.version, complete.expected_revision], [newest.id, newest.version, "1"]);
  await filter.selectOption("done");
  await result(page, /Showing 2 saved pages/);
  assert.equal(await rows(page).first().locator(".explorer-row-title").textContent(), title);
  assert.equal(await detail.getByRole("button", { name: "Mark done" }).count(), 0);

  await filter.selectOption("all");
  const search = page.getByRole("searchbox");
  await search.fill("other.example.test");
  await result(page, /Showing 1 saved page\./);
  assert.equal(await detail.getByRole("heading").textContent(), unfinished.title);
  assert.deepEqual(state.requests.filter(({ type }) => type === "list_stash").at(-1).query, "other.example.test");
  await search.fill("missing title");
  await result(page, /No saved pages match this search and filter/);
  assert.equal(await rows(page).count(), 0);
});

test("Stash preserves search on return and ignores an older search reply", { timeout: 120_000 }, async (t) => {
  const alpha = item(1, { title: "Alpha notes" });
  const beta = item(2, { title: "Beta notes" });
  const fixture = await stashFixture(t, [alpha, beta]);
  if (!fixture) return;
  const { page, state } = fixture;
  const search = page.getByRole("searchbox");
  await result(page, /Showing 2 saved pages/);
  const alphaReply = Promise.withResolvers();
  const alphaRead = Promise.withResolvers();
  const betaReply = Promise.withResolvers();
  const betaRead = Promise.withResolvers();
  state.hook = (request) => {
    if (request.type === "list_stash" && request.query === "Alpha") {
      alphaRead.resolve();
      return alphaReply.promise;
    }
    if (request.type === "list_stash" && request.query === "Beta") {
      betaRead.resolve();
      return betaReply.promise;
    }
    return null;
  };
  await search.fill("Alpha");
  await alphaRead.promise;
  await search.fill("Beta");
  alphaReply.resolve({ type: "stash_listed", items: [alpha], next: null });
  await betaRead.promise;
  assert.equal(await rows(page).count(), 0, "the superseded Alpha reply must never populate the list");
  betaReply.resolve({ type: "stash_listed", items: [beta], next: null });
  await result(page, /Showing 1 saved page\./);
  assert.equal(await rows(page).first().locator(".explorer-row-title").textContent(), beta.title);
  await rows(page).first().focus();

  const refreshing = Promise.withResolvers();
  const refreshReached = Promise.withResolvers();
  state.revision = "2";
  beta.summary = summary({ overview: "Summary arrived while this tab was away." });
  state.hook = (request) => {
    if (request.type !== "list_stash") return null;
    refreshReached.resolve();
    return refreshing.promise;
  };
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await result(page, /Refreshing Stash/);
  await refreshReached.promise;
  assert.equal(await search.inputValue(), "Beta");
  const current = state.requests.at(-1);
  assert.deepEqual([current.expected_revision, current.state, current.query, current.after], ["2", "open", "Beta", null]);
  refreshing.resolve({ type: "stash_listed", items: [beta], next: null });
  await result(page, /Showing 1 saved page\./);
  assert.match(await page.locator("#stash-detail").textContent(), /Summary arrived while this tab was away/);
  await page.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Marked as done/);
  assert.equal(state.requests.at(-1).expected_revision, "2");
});

test("Stash keeps setup, empty results, conflicts, and unsafe navigation distinct", async (t) => {
  const unsafe = item(1, { url: "https://name:secret@work.example.test/article" });
  const fixture = await stashFixture(t, [], { configured: false });
  if (!fixture) return;
  const { page, state } = fixture;
  const refresh = page.getByRole("button", { name: "Refresh" });
  await result(page, /Choose a home folder/);
  assert.equal(await page.locator("#stash-layout").isVisible(), false);
  assert.deepEqual(state.requests.map(({ type }) => type), ["get_config"]);
  state.configured = true;
  await refresh.click();
  await result(page, /No pages to read/);
  state.entries = [item(2)];
  await refresh.click();
  await result(page, /Showing 1 saved page\./);
  state.revision = "2";
  await page.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Could not mark the page done.*Refresh Stash and try again/);
  assert.equal(await rows(page).count(), 1);
  assert.equal(state.entries[0].done, false);
  await focused(page, "#stash-complete");

  state.entries = [unsafe];
  await refresh.click();
  await result(page, /Could not load Stash/);
  assert.equal(await page.getByRole("link", { name: /Open source/ }).count(), 0);
  assert.equal(await page.locator("#stash-empty").isVisible(), false);
});

for (const [width, colorScheme] of [[1200, "light"], [320, "dark"]]) {
  test(`Stash is readable and accessible at ${width}px in ${colorScheme} mode`, async (t) => {
    const entry = item(1, { title: "LongArtifactTitle".repeat(17), summary: summary() });
    const fixture = await stashFixture(t, [entry], { width, colorScheme });
    if (!fixture) return;
    const { page } = fixture;
    await result(page, /Showing 1 saved page\./);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await audit(t, page, `stash/${width}/${colorScheme}`);
  });
}
