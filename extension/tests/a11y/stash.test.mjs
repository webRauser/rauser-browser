import assert from "node:assert/strict";
import test from "node:test";
import { a11yBrowser } from "../../../scripts/a11y-browser.mjs";
import { ORIGIN, activate, audit, focused, installChrome, routeFixturePages } from "./fixture.mjs";

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

async function stashFixture(t, entries, options = {}, sharedBrowser = null) {
  const browser = sharedBrowser ?? await a11yBrowser(t);
  if (!browser) return null;
  if (!sharedBrowser) t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1180, height: options.height ?? 800 },
    colorScheme: options.colorScheme ?? "light",
    serviceWorkers: "block",
  });
  if (sharedBrowser) t.after(() => context.close());
  await routeFixturePages(t, context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));

  const state = { entries, revision: "1", root: "/fixture-home", configured: true, configIssue: null, requests: [], hook: null, ...options };
  const storage = {
    profile: "neutral", log_dir: "logs", pages_dir: "notes", later_dir: "later",
    artifacts_dir: "artifacts", summaries_dir: "summaries", knowledge_base_dir: null,
  };
  await page.exposeFunction("fixtureNativeRequest", async (request) => {
    state.requests.push(request);
    const envelope = { request_id: request.request_id, protocol_version: request.protocol_version };
    if (request.type === "get_config") {
      return {
        ...envelope, type: "config_result", revision: state.revision, config_issue: state.configIssue,
        config: {
          storage: state.configured ? { ...storage, root: state.root } : null, capture_enabled: false, strip_params: [], agent: null,
          summary_vocabulary: { document_types: [], categories: [] }, auto_summary: { enabled: false, dwell_secs: 0 },
          adapters: { format: 1, artifacts: [] },
        },
        agent_status: { state: "not_set_up", harness_version: null, message: null },
        adapter_issue: null, adapter_warnings: [], adopted_state: { issue: null, revision: "missing", warnings: [], full: false },
      };
    }
    if (request.expected_revision !== state.revision) {
      return { ...envelope, type: "error", code: "conflict", message: "configuration changed; refresh Stash and try again" };
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
const rows = (page) => page.locator("#stash-list .stash-row");
const row = (page, n) => page.locator(`#stash-list button[data-stash-id="${item(n).id}"]`);
const filter = (page, name) => page.getByRole("group", { name: "Reading status" }).getByRole("button", { name, exact: true });
const refresh = (page) => page.getByRole("button", { name: "Refresh" });
const more = (page) => page.getByRole("button", { name: "Load more saved pages" });
const listRequests = (state) => state.requests.filter(({ type }) => type === "list_stash");

async function assertNoHorizontalOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
    [...document.querySelectorAll("#stash-preview, #stash-detail, #stash-results-body")]
      .every((pane) => pane.scrollWidth <= pane.clientWidth)), true);
}

async function returnToTab(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
}

test("Stash refresh keeps a selection from the second page", { timeout: 120_000 }, async (t) => {
  const fixture = await stashFixture(t, Array.from({ length: 23 }, (_, n) => item(n + 1)), { width: 900, height: 640 });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await more(page).click();
  await result(page, /Showing 23 saved pages/);
  await row(page, 21).press("Enter");
  await focused(page, "#stash-detail-heading");
  const anchor = row(page, 13);
  await anchor.evaluate((button) => {
    const pane = document.getElementById("stash-results-body");
    pane.scrollTop += button.getBoundingClientRect().top - pane.getBoundingClientRect().top + 12;
  });
  const scroll = () => anchor.evaluate((button) => {
    const pane = document.getElementById("stash-results-body");
    return { position: pane.scrollTop, offset: button.getBoundingClientRect().top - pane.getBoundingClientRect().top };
  });
  const initial = await scroll();
  assert.ok(initial.position > 0);
  assert.ok(Math.abs(initial.offset + 12) < 1, "the anchor is partially visible");

  await refresh(page).click();
  await result(page, /Showing 23 saved pages/);
  assert.deepEqual(await scroll(), initial);
  assert.equal(await page.locator("#stash-detail h2").textContent(), item(21).title);
  assert.equal(await row(page, 21).getAttribute("aria-current"), "true");
  assert.deepEqual(listRequests(state).map(({ after }) => after), [null, item(20).id, null, item(20).id]);

  await page.getByRole("button", { name: "Mark done" }).focus();
  state.entries[20].summary = summary({ overview: "A summary became available." });
  state.entries.push(item(0), item(-1, { id: "b".repeat(64) }));
  const laterPage = Promise.withResolvers();
  const laterRead = Promise.withResolvers();
  state.hook = (request) => {
    if (request.type !== "list_stash" || request.after === null) return null;
    laterRead.resolve();
    return laterPage.promise;
  };
  await returnToTab(page);
  await laterRead.promise;
  await result(page, /Refreshing Stash/);
  assert.equal(await rows(page).count(), 23, "the first replacement page must not render by itself");
  assert.deepEqual(await scroll(), initial);
  laterPage.resolve(null);
  await result(page, /Showing 25 saved pages/);
  await focused(page, "#stash-complete");
  assert.match(await page.locator("#stash-detail").textContent(), /A summary became available/);
  assert.equal(await row(page, 21).getAttribute("aria-current"), "true");
  const updated = await scroll();
  assert.ok(Math.abs(updated.offset - initial.offset) < 1);
  assert.ok(updated.position > initial.position);
  assert.equal(state.requests.filter(({ type }) => type === "get_config").length, 3);
  assert.deepEqual(listRequests(state).map(({ after }) => after),
    [null, item(20).id, null, item(20).id, null, item(18).id]);
});

test("Stash refresh keeps the loaded tail when a newer save shifts it to the next page", async (t) => {
  const entries = Array.from({ length: 45 }, (_, n) => item(n + 1));
  const fixture = await stashFixture(t, entries, { width: 900, height: 640 });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await more(page).click();
  await result(page, /Showing 40 saved pages/);
  await row(page, 25).press("Enter");

  const pane = page.locator("#stash-results-body");
  await pane.evaluate((body) => { body.scrollTop = body.scrollHeight; });
  const scroll = () => pane.evaluate((body) => {
    const top = body.getBoundingClientRect().top;
    const anchor = [...body.querySelectorAll("[data-stash-id]")].find((button) => button.getBoundingClientRect().bottom > top);
    return {
      id: anchor?.dataset.stashId,
      offset: anchor && anchor.getBoundingClientRect().top - top,
      atBottom: Math.abs(body.scrollHeight - body.clientHeight - body.scrollTop) <= 1,
    };
  });
  const previous = await scroll();
  assert.ok(previous.atBottom && previous.id, "the loaded list is scrolled to its bottom");
  assert.equal(await rows(page).last().getAttribute("data-stash-id"), item(40).id);
  assert.equal(await row(page, 41).count(), 0);

  const requestsBefore = listRequests(state).length;
  state.entries = [item(0), ...entries];
  await refresh(page).click();
  await result(page, /Showing (40|46) saved pages/);
  const updated = await scroll();
  assert.deepEqual({ tailCount: await row(page, 40).count(), anchor: updated.id },
    { tailCount: 1, anchor: previous.id });
  assert.ok(Math.abs(updated.offset - previous.offset) < 1, "the first visible row keeps its offset");
  assert.equal(await row(page, 25).getAttribute("aria-current"), "true");
  assert.deepEqual(listRequests(state).slice(requestsBefore).map(({ after }) => after), [null, item(19).id, item(39).id]);
});

for (const sameMillisecond of [false, true]) {
  const boundary = sameMillisecond ? "after crossing a millisecond tie" : "on the first replacement page";
  test(`Stash refresh replaces a completed unselected tail ${boundary}`, async (t) => {
    const entries = Array.from({ length: 141 }, (_, n) => item(n + 1));
    if (sameMillisecond) {
      // The native order distinguishes these instants, but Date.parse puts them in the same millisecond.
      const savedAt = entries[19].saved_at;
      entries[19].saved_at = savedAt.replace(".000Z", ".123900Z");
      entries[20].saved_at = savedAt.replace(".000Z", ".123100Z");
    }
    const fixture = await stashFixture(t, entries, { width: 900, height: 640 });
    if (!fixture) return;
    const { page, state } = fixture;
    await result(page, /Showing 20 saved pages/);
    assert.equal(await rows(page).last().getAttribute("data-stash-id"), item(20).id);
    await row(page, 5).press("Enter");
    await focused(page, "#stash-detail-heading");
    const anchor = row(page, 8);
    await anchor.evaluate((button) => {
      const pane = document.getElementById("stash-results-body");
      pane.scrollTop += button.getBoundingClientRect().top - pane.getBoundingClientRect().top + 12;
    });
    const scroll = () => anchor.evaluate((button) => {
      const pane = document.getElementById("stash-results-body");
      return { position: pane.scrollTop, offset: button.getBoundingClientRect().top - pane.getBoundingClientRect().top };
    });
    const previous = await scroll();
    assert.ok(previous.position > 0 && Math.abs(previous.offset + 12) < 1, "the anchor is partially visible");

    const requestsBefore = listRequests(state).length;
    state.entries[19].done = true; // Completion recorded by another tab.
    await returnToTab(page);
    await result(page, /Showing (20|40) saved pages|Showing the previous results/);
    const reads = listRequests(state).slice(requestsBefore);
    const cursors = sameMillisecond ? [null, item(21).id] : [null];
    assert.deepEqual({ tailCount: await row(page, 20).count(), nativeReads: reads.length },
      { tailCount: 0, nativeReads: cursors.length });
    assert.deepEqual(reads.map(({ after }) => after), cursors);
    assert.equal(await row(page, 21).count(), 1);
    assert.equal(await row(page, 5).getAttribute("aria-current"), "true");
    await focused(page, "#stash-detail-heading");
    assert.deepEqual(await scroll(), previous);

    await filter(page, "Done").click();
    await result(page, /Showing 1 saved page/);
    assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(20).id);
  });
}

test("Stash keeps the loaded range on a later read failure and when the page budget is exhausted", { timeout: 120_000 }, async (t) => {
  const entries = Array.from({ length: 23 }, (_, n) => item(n + 1));
  const fixture = await stashFixture(t, entries, { width: 640, height: 640 });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await more(page).click();
  await result(page, /Showing 23 saved pages/);
  await row(page, 21).focus();
  const position = await page.locator("#stash-results-body").evaluate((body) => body.scrollTop);
  assert.ok(position > 0);
  await page.keyboard.press("Enter");
  await focused(page, "#stash-detail-heading");

  const reachedLaterPage = Promise.withResolvers();
  const laterReply = Promise.withResolvers();
  state.entries = [item(0), ...entries];
  state.hook = ({ type, after }) => {
    if (type !== "list_stash" || after === null) return null;
    reachedLaterPage.resolve();
    return laterReply.promise;
  };
  await returnToTab(page);
  await reachedLaterPage.promise;
  assert.equal(await rows(page).count(), 23);
  assert.equal(await row(page, 0).count(), 0);
  laterReply.resolve({ type: "error", code: "internal", message: "A later read failed." });
  await result(page, /Could not refresh Stash.*A later read failed.*Showing the previous results/);
  await focused(page, "#stash-detail-heading");

  state.hook = null;
  const arrivals = Array.from({ length: 121 }, (_, n) => item(n + 100, { saved_at: new Date(Date.UTC(2026, 10, 24, 0, n)).toISOString() }));
  state.entries = [...arrivals, ...entries];
  const requestsBefore = listRequests(state).length;
  await returnToTab(page);
  await result(page, /refresh reached its results limit.*Showing the previous results/);
  assert.equal(listRequests(state).length - requestsBefore, 6);
  assert.equal(await rows(page).count(), 23);
  assert.equal(await row(page, 21).getAttribute("aria-current"), "true");
  await focused(page, "#stash-detail-heading");
  await page.keyboard.press("Shift+Tab");
  await focused(page, "#stash-back");
  await page.keyboard.press("Enter");
  await focused(page, `#stash-list button[data-stash-id="${item(21).id}"]`);
  assert.equal(await page.locator("#stash-results-body").evaluate((body) => body.scrollTop), position);

  await page.keyboard.press("Enter");
  state.entries = [item(0), ...entries.filter((entry) => entry.id !== item(21).id)];
  await returnToTab(page);
  await result(page, /The selected page left this view. Showing 23 saved pages/);
  await focused(page, "#stash-detail-heading");
  assert.equal(await row(page, 22).getAttribute("aria-current"), "true");
  assert.equal(await page.locator("#stash-detail h2").textContent(), item(22).title);
});

test("Stash bounds elapsed refresh time and clears the view on a folder refusal", { timeout: 120_000 }, async (t) => {
  const entries = Array.from({ length: 23 }, (_, n) => item(n + 1));
  const fixture = await stashFixture(t, entries);
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await more(page).click();
  await result(page, /Showing 23 saved pages/);
  await row(page, 21).press("Enter");
  await focused(page, "#stash-detail-heading");
  await page.clock.install();

  const stalledRead = Promise.withResolvers();
  const stalledReply = Promise.withResolvers();
  state.hook = ({ type, after }) => {
    if (type !== "list_stash" || after === null) return null;
    stalledRead.resolve();
    return stalledReply.promise;
  };
  await returnToTab(page);
  await stalledRead.promise;
  await page.clock.fastForward(5_100);
  await result(page, /Native host did not respond in time.*Showing the previous results/);
  assert.equal(await rows(page).count(), 23);
  await focused(page, "#stash-detail-heading");
  assert.equal(listRequests(state).length, 4);

  state.hook = ({ type, after }) => type === "list_stash" && after !== null
    ? { type: "error", code: "internal", message: "home folder is unavailable" } : null;
  stalledReply.resolve({ type: "stash_listed", items: [item(99)], next: null });
  await returnToTab(page);
  await result(page, /Could not refresh Stash.*home folder is unavailable/);
  assert.equal(await rows(page).count(), 0);
  assert.equal(await page.getByRole("link", { name: "Open original" }).count(), 0);
  await focused(page, "#stash-refresh");
});

test("Stash pages, searches, and preserves revision-bound actions for saved and completed pages", async (t) => {
  const title = "Newest <img src=x onerror=alert(1)> saved page";
  const newest = item(1, { title, summary: summary() });
  const unfinished = item(2, { title: "Unfinished source", url: "https://other.example.test/read" });
  const entries = [item(22, { done: true }), item(21), ...Array.from({ length: 18 }, (_, n) => item(n + 3)), unfinished, newest];
  const fixture = await stashFixture(t, entries, { width: 900 });
  if (!fixture) return;
  const { page, state } = fixture;
  const detail = page.getByRole("region", { name: "Selected saved page" });
  await result(page, /Showing 20 saved pages/);
  assert.equal(await filter(page, "To read").getAttribute("aria-pressed"), "true");
  assert.equal(await rows(page).count(), 20);
  assert.equal(await rows(page).first().locator(".stash-row-title").textContent(), title);
  assert.doesNotMatch(await rows(page).first().textContent(), /Quality|literal markup/u);
  assert.equal(await detail.locator("img, b").count(), 0);
  assert.equal(await detail.locator(".stash-overview").textContent(), newest.summary.overview);
  assert.match(await detail.textContent(), /work\.example\.test.*Quality.*Decision.*high importance/u);
  assert.deepEqual(await detail.locator("time").evaluateAll((nodes) => nodes.map((node) => node.dateTime)), [newest.saved_at, newest.summary.summarized_at]);
  const source = detail.getByRole("link", { name: "Open original" });
  assert.equal(await source.getAttribute("href"), newest.url);
  assert.equal(await source.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await source.getAttribute("target"), "_blank");
  await rows(page).first().press("Enter");
  await focused(page, "#stash-detail-heading");
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

  const loadMore = more(page);
  await loadMore.focus();
  state.hook = ({ type, after }) => type === "list_stash" && after ? { type: "stash_listed", items: [newest], next: null } : null;
  await loadMore.press("Enter");
  await result(page, /Could not load more saved pages.*result page changed/);
  assert.equal(await rows(page).count(), 20);
  await focused(page, "#stash-more");
  state.hook = null;
  await loadMore.press("Enter");
  await result(page, /Showing 21 saved pages/);
  await focused(page, `#stash-list button[data-stash-id="${item(21).id}"]`);
  assert.deepEqual(state.requests.filter(({ type }) => type === "list_stash").map(({ state, query, after }) => [state, query, after]),
    [["open", "", null], ["open", "", item(20).id], ["open", "", item(20).id]]);
  assert.equal(await loadMore.isVisible(), false);

  await detail.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Marked as done/);
  await focused(page, "#stash-detail-heading");
  assert.equal(await row(page, 2).getAttribute("aria-current"), "true");
  assert.equal(await rows(page).count(), 20);
  assert.match(await detail.textContent(), /No saved summary/u);
  assert.equal(await detail.getByRole("button", { name: "Open summary" }).count(), 0);
  const complete = state.requests.find(({ type }) => type === "complete_stash");
  assert.deepEqual([complete.id, complete.version, complete.expected_revision], [newest.id, newest.version, "1"]);
  await filter(page, "Done").click();
  await result(page, /Showing 2 saved pages/);
  assert.equal(await filter(page, "Done").getAttribute("aria-pressed"), "true");
  assert.equal(await rows(page).first().locator(".stash-row-title").textContent(), title);
  assert.equal(await detail.getByRole("button", { name: "Mark done" }).count(), 0);

  await filter(page, "All").click();
  await result(page, /Showing 20 saved pages/);
  assert.match(await rows(page).first().textContent(), /Done$/u);
  assert.match(await rows(page).nth(1).textContent(), /To read$/u);
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
  assert.equal(await rows(page).first().locator(".stash-row-title").textContent(), beta.title);
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
  await returnToTab(page);
  await result(page, /Refreshing Stash/);
  await refreshReached.promise;
  assert.equal(await search.inputValue(), "Beta");
  assert.equal(await rows(page).count(), 0, "the prior revision must clear before reading the new one");
  assert.equal(await page.locator("#stash-detail h2").count(), 0);
  await focused(page, "#stash-refresh");
  const current = state.requests.at(-1);
  assert.deepEqual([current.expected_revision, current.state, current.query, current.after], ["2", "open", "Beta", null]);
  refreshing.resolve({ type: "stash_listed", items: [beta], next: null });
  await result(page, /Showing 1 saved page\./);
  assert.match(await page.locator("#stash-detail").textContent(), /Summary arrived while this tab was away/);

  // A real return must recheck the selected home even if a refresh that
  // started before the tab was hidden still owes a reply.
  const earlierRead = Promise.withResolvers();
  const earlierReply = Promise.withResolvers();
  const otherHomeRead = Promise.withResolvers();
  const otherHomeReply = Promise.withResolvers();
  let reads = 0;
  state.hook = ({ type }) => {
    if (type !== "list_stash") return null;
    reads += 1;
    if (reads === 1) {
      earlierRead.resolve();
      return earlierReply.promise;
    }
    otherHomeRead.resolve();
    return otherHomeReply.promise;
  };
  await refresh(page).click();
  await earlierRead.promise;
  await page.evaluate(() => {
    window.expiredRefreshRendered = false;
    new MutationObserver((records) => {
      if (records.some(({ addedNodes }) => Array.from(addedNodes).some((node) =>
        node.textContent.includes("An expired refresh reply.")))) window.expiredRefreshRendered = true;
    }).observe(document.getElementById("stash-detail"), { childList: true });
  });
  state.root = "/other-fixture-home";
  await returnToTab(page);
  const expired = { ...beta, summary: summary({ overview: "An expired refresh reply." }) };
  earlierReply.resolve({ type: "stash_listed", items: [expired], next: null });
  await otherHomeRead.promise;
  assert.equal(await rows(page).count(), 0);
  assert.equal(await page.evaluate(() => window.expiredRefreshRendered), false);
  assert.equal(state.requests.filter(({ type }) => type === "get_config").length, 4);
  otherHomeReply.resolve({ type: "stash_listed", items: [beta], next: null });
  await result(page, /Showing 1 saved page\./);
  await page.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Marked as done/);
  assert.equal(state.requests.at(-1).expected_revision, "2");
});

test("Stash keeps setup, empty results, conflicts, and unsafe navigation distinct", async (t) => {
  const unsafe = item(1, { url: "https://name:secret@work.example.test/article" });
  const fixture = await stashFixture(t, [], { configured: false });
  if (!fixture) return;
  const { page, state } = fixture;
  const refreshButton = refresh(page);
  await result(page, /Choose a home folder/);
  assert.equal(await page.locator("#stash-layout").isVisible(), false);
  assert.deepEqual(state.requests.map(({ type }) => type), ["get_config"]);
  await page.getByRole("button", { name: "Settings" }).click();
  assert.deepEqual(await page.evaluate(() => window.fixture.actions), ["settings"]);
  state.configured = true;
  const firstRead = Promise.withResolvers();
  const firstReply = Promise.withResolvers();
  state.hook = ({ type }) => {
    if (type !== "list_stash") return null;
    firstRead.resolve();
    return firstReply.promise;
  };
  await refreshButton.click();
  await firstRead.promise;
  await result(page, /Loading saved pages/);
  assert.equal(await rows(page).count(), 0);
  firstReply.resolve(null);
  await result(page, /No pages to read/);
  state.hook = null;
  state.entries = [item(2)];
  await refreshButton.click();
  await result(page, /Showing 1 saved page\./);
  state.hook = ({ type }) => type === "complete_stash"
    ? { type: "error", code: "conflict", message: "The saved page changed." } : null;
  await page.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Could not mark the page done.*The saved page changed/);
  assert.equal(await rows(page).count(), 1);
  assert.equal(state.entries[0].done, false);
  await focused(page, "#stash-complete");

  state.hook = null;
  state.revision = "2";
  await page.getByRole("button", { name: "Mark done" }).click();
  await result(page, /Could not mark the page done.*refresh Stash and try again/);
  assert.equal(await rows(page).count(), 0);
  assert.equal(state.entries[0].done, false);
  await focused(page, "#stash-refresh");

  state.entries = [unsafe];
  await refreshButton.click();
  await result(page, /Could not load Stash/);
  assert.equal(await page.getByRole("link", { name: "Open original" }).count(), 0);
  assert.equal(await rows(page).count(), 0);
});

test("Stash shows saved summary coverage from native replies", { timeout: 120_000 }, async (t) => {
  const browser = await a11yBrowser(t);
  if (!browser) return;
  t.after(() => browser.close());
  const overview = "LongSummaryText".repeat(140) + ' <img src="/unexpected-preview.png"> <b>literal markup</b>';
  const entries = [
    { saved: item(1, { summary: summary({ overview, read_scope: "whole" }) }), label: "Whole artifact" },
    { saved: item(2, { summary: summary({ overview, read_scope: "partial" }) }), label: "Partial", limited: true },
    { saved: item(3, { summary: summary({ overview, read_scope: "page_only" }) }), label: "Page only", limited: true },
    { saved: item(4, { summary: summary({ overview }) }), label: "Coverage unknown" },
    { saved: item(5), label: "No saved summary" },
  ];
  for (const { width, colorScheme } of [{ width: 320, colorScheme: "dark" }, { width: 1200, colorScheme: "light" }]) {
    await t.test(`${width}px in ${colorScheme}`, async (t) => {
      const { page, state } = await stashFixture(t, entries.map(({ saved }) => saved), { width, colorScheme }, browser);
      await result(page, /Showing 5 saved pages/);
      const detail = page.getByRole("region", { name: "Selected saved page" });
      for (const { saved, label, limited = false } of entries) {
        const rowSelector = `#stash-list button[data-stash-id="${saved.id}"]`;
        const button = page.locator(rowSelector);
        await activate(page, rowSelector);
        await focused(page, "#stash-detail-heading");
        assert.equal(await detail.getByText(label, { exact: true }).count(), 1, `Missing preview label: ${label}`);
        assert.equal(await detail.locator("img, b").count(), 0);
        if (saved.summary) {
          assert.equal(await detail.locator(".stash-overview").textContent(), overview);
          assert.equal(await detail.getByRole("button", { name: "Open summary" }).isVisible(), true);
        } else {
          assert.equal(await detail.locator(".stash-overview").count(), 0);
          assert.equal(await detail.getByRole("button", { name: "Open summary" }).count(), 0);
        }
        assert.deepEqual(await detail.locator("time").evaluateAll((nodes) => nodes.map((node) => node.dateTime)),
          saved.summary ? [saved.saved_at, saved.summary.summarized_at] : [saved.saved_at]);
        await assertNoHorizontalOverflow(page);

        await page.keyboard.press("Tab");
        await focused(page, "#stash-open-source");
        assert.equal(await detail.getByRole("link", { name: "Open original" }).getAttribute("href"), saved.url);
        await page.keyboard.press("Shift+Tab");
        await focused(page, "#stash-back");
        await page.keyboard.press("Enter");
        await focused(page, rowSelector);
        await assertNoHorizontalOverflow(page);

        assert.equal(await button.getByText(label, { exact: true }).count(), Number(limited));
        assert.doesNotMatch(await button.textContent(), /LongSummaryText|Quality|Decision/u);
        const shortDate = await page.evaluate((date) =>
          new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(date)),
        saved.saved_at);
        assert.deepEqual(await button.locator("time").evaluateAll((nodes) => nodes.map((node) => [node.dateTime, node.textContent])),
          [[saved.saved_at, shortDate]]);
      }
      state.entries = [item(6, { summary: summary({ read_scope: "unknown" }) })];
      await refresh(page).click();
      await result(page, /Native host protocol response is invalid.*Showing the previous results/);
      assert.equal(await rows(page).count(), entries.length);
    });
  }
});

async function checkKeyboardJourney(page, width) {
  const results = page.getByRole("region", { name: "Saved pages" });
  const detail = page.getByRole("region", { name: "Selected saved page" });
  const narrow = width <= 768;
  assert.equal(await results.isVisible(), true);
  assert.equal(await detail.isVisible(), !narrow);
  await row(page, 2).focus();
  await page.keyboard.press("Enter");
  await focused(page, "#stash-detail-heading");
  assert.equal(await results.isVisible(), !narrow);
  assert.equal(await detail.isVisible(), true);
  await page.keyboard.press("Tab");
  await focused(page, "#stash-open-source");
  await page.keyboard.press("Shift+Tab");
  await focused(page, "#stash-back");
  await page.keyboard.press("Enter");
  await focused(page, `#stash-list button[data-stash-id="${item(2).id}"]`);
  assert.equal(await results.isVisible(), true);
  assert.equal(await detail.isVisible(), !narrow);
}

test("Stash reflows and supports direct keyboard navigation in both themes", async (t) => {
  const browser = await a11yBrowser(t);
  if (!browser) return;
  t.after(() => browser.close());
  for (const width of [320, 640, 900, 1200]) {
    for (const colorScheme of ["light", "dark"]) {
      await t.test(`${width}px in ${colorScheme}`, async (t) => {
        const entry = item(2, { title: "LongArtifactTitle".repeat(17), summary: summary() });
        const { page } = await stashFixture(t, [item(1), entry], { width, colorScheme }, browser);
        await result(page, /Showing 2 saved pages/);
        await checkKeyboardJourney(page, width);
        assert.equal(await row(page, 2).getAttribute("aria-current"), "true");
        assert.equal(await filter(page, "To read").isVisible(), true);
        assert.equal(await filter(page, "Done").isVisible(), true);
        assert.equal(await filter(page, "All").isVisible(), true);
        assert.equal(await page.getByRole("searchbox").isVisible(), true);
        assert.equal(await refresh(page).isVisible(), true);
        assert.equal(await page.getByRole("button", { name: "Settings" }).isVisible(), true);
        await audit(t, page, `stash/${width}/${colorScheme}/results`);
        await page.keyboard.press("Enter");
        await focused(page, "#stash-detail-heading");
        assert.equal(await page.locator("#stash-detail h2").textContent(), entry.title);
        await assertNoHorizontalOverflow(page);
        await audit(t, page, `stash/${width}/${colorScheme}/detail`);
      });
    }
  }
});

test("Stash keeps focused detail when a 1280px viewport reflows to its 400% zoom equivalent", async (t) => {
  const fixture = await stashFixture(t, [item(1), item(2, { title: "LongArtifactTitle".repeat(17) })], { width: 1280 });
  if (!fixture) return;
  const { page } = fixture;
  await result(page, /Showing 2 saved pages/);
  await row(page, 2).press("Enter");
  await focused(page, "#stash-detail-heading");
  await page.setViewportSize({ width: 320, height: 200 });
  assert.equal(await page.evaluate(() => innerWidth), 320);
  await focused(page, "#stash-detail-heading");
  assert.equal(await page.locator("#stash-results").isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press("Shift+Tab");
  await focused(page, "#stash-back");
  await page.keyboard.press("Enter");
  await focused(page, `#stash-list button[data-stash-id="${item(2).id}"]`);
});
