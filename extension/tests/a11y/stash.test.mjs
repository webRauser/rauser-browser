import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { a11yBrowser } from "../../../scripts/a11y-browser.mjs";
import { ORIGIN, activate, audit, focused, installChrome, routeFixturePages, seedFixtureTheme } from "./fixture.mjs";

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
  await seedFixtureTheme(context, options.colorScheme ?? "light");
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));

  const state = {
    entries, revision: "1", root: "/fixture-home", configured: true, configIssue: null,
    requests: [], hook: null, supportSearch: false, supportPins: false, pinProbes: [], pinEpoch: 0,
    supportReading: false, readingProbes: [], ...options,
  };
  const pins = new Map();
  const pinFor = (id) => pins.get(id) ?? { pin: { pinned: false, version: "b".repeat(64) } };
  state.changePin = (id, pinned) => {
    const previous = pinFor(id).pin;
    if (pinned === previous.pinned) return previous;
    state.pinEpoch += 1;
    const pin = { pinned, version: state.pinEpoch.toString(16).padStart(64, "0") };
    pins.set(id, { pin, previous: previous.version });
    return pin;
  };
  const reading = new Map();
  let readingEpoch = 0;
  state.readingVersion = (id) => reading.get(id) ?? "c".repeat(64);
  state.changeReading = (id, done) => {
    const entry = state.entries.find((saved) => saved.id === id);
    assert.ok(entry);
    if (entry.done !== done) {
      entry.done = done;
      readingEpoch += 1;
      reading.set(id, readingEpoch.toString(16).padStart(64, "0"));
    }
    return state.readingVersion(id);
  };
  const storage = {
    profile: "neutral", log_dir: "logs", pages_dir: "notes", later_dir: "later",
    artifacts_dir: "artifacts", summaries_dir: "summaries", knowledge_base_dir: null,
  };
  await page.exposeFunction("fixtureNativeRequest", async (request) => {
    const envelope = { request_id: request.request_id, protocol_version: request.protocol_version };
    if (request.type === "list_stash" && request.include_reading && !state.supportReading) {
      state.readingProbes.push(request);
      return { ...envelope, type: "error", code: "invalid_request", message: "invalid or unsupported request JSON" };
    }
    if (request.type === "list_stash" && request.search && !state.supportSearch) {
      return { ...envelope, type: "error", code: "invalid_request", message: "invalid or unsupported request JSON" };
    }
    if (request.type === "list_stash" && request.include_pin && !state.supportPins) {
      state.pinProbes.push(request);
      return { ...envelope, type: "error", code: "invalid_request",
        message: state.pinProbeMessage ?? "invalid or unsupported request JSON" };
    }
    state.requests.push(request);
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
      const pinOrder = request.include_pin ? createHash("sha256")
        .update(JSON.stringify([state.root, request.state, request.query, state.pinEpoch])).digest("hex") : undefined;
      if (pinOrder && request.after !== null && request.pin_order !== pinOrder) {
        return { ...envelope, type: "error", code: "conflict", message: "Stash pin order changed. Refresh Stash before loading more." };
      }
      const all = [...state.entries].sort((a, b) =>
        (pinOrder ? Number(pinFor(b.id).pin.pinned) - Number(pinFor(a.id).pin.pinned) : 0) ||
        b.saved_at.localeCompare(a.saved_at) || b.id.localeCompare(a.id));
      const start = request.after === null ? 0 : all.findIndex((entry) => entry.id === request.after) + 1;
      assert.ok(request.after === null || start > 0, "continuation must name a saved entry");
      const query = request.query.toLowerCase();
      const matching = all.slice(start).filter(({ done, title, url }) =>
        (request.state === "all" || done === (request.state === "done")) &&
        [title, url].some((value) => value.toLowerCase().includes(query)));
      const items = matching.slice(0, 20).map((entry) => ({
        ...entry,
        ...(pinOrder ? { pin: pinFor(entry.id).pin } : {}),
        ...(request.include_reading ? { reading_version: state.readingVersion(entry.id) } : {}),
      }));
      const next = matching.length > items.length ? items.at(-1).id : null;
      return { ...envelope, type: "stash_listed", items, next, ...(pinOrder ? { pin_order: pinOrder } : {}) };
    }
    if (request.type === "read_summary") {
      const entry = state.entries.find(({ url }) => url === request.url);
      assert.equal(request.summary_path, entry?.summary?.path);
      return { ...envelope, type: "summary_read", source_url: entry.url, title: entry.title, body: "## Summary\n\nSaved details." };
    }
    const entry = state.entries.find(({ id }) => id === request.id);
    assert.ok(entry);
    assert.equal(request.version, entry.version);
    if (request.type === "set_stash_pin") {
      const { pin, previous } = pinFor(entry.id);
      const replay = request.pin_version === previous && pin.pinned === request.pinned;
      if (!replay && request.pin_version !== pin.version) {
        return { ...envelope, type: "error", code: "conflict", message: "This Stash entry changed. Refresh Stash before continuing." };
      }
      return { ...envelope, type: "stash_pin_set", pin: state.changePin(entry.id, request.pinned) };
    }
    if (request.type === "set_stash_reading") {
      assert.equal(typeof request.done, "boolean");
      if (request.reading_version !== state.readingVersion(entry.id)) {
        return { ...envelope, type: "error", code: "conflict", message: "This Stash entry changed. Refresh Stash before continuing." };
      }
      const reading_version = state.changeReading(entry.id, request.done);
      return { ...envelope, type: "stash_reading_set", done: request.done, reading_version };
    }
    assert.equal(request.type, "complete_stash");
    state.changeReading(entry.id, true);
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
    const fixture = await stashFixture(t, entries, { width: 900, height: 640, supportPins: true });
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
  state.hook = ({ type }) => type === "read_summary" ? openReply.promise : null;
  await detail.getByRole("button", { name: "Open summary" }).click();
  const reader = page.getByRole("dialog");
  await reader.getByRole("status").filter({ hasText: "Loading summary" }).waitFor();
  await page.keyboard.press("Escape");
  await reader.waitFor({ state: "detached" });
  await focused(page, "#stash-open-summary");
  openReply.resolve(null);
  state.hook = null;
  await detail.getByRole("button", { name: "Open summary" }).click();
  await reader.getByText("Saved details.").waitFor();
  assert.equal(await reader.getByRole("link", { name: "Open source" }).getAttribute("href"), newest.url);
  await reader.getByRole("button", { name: "Close summary" }).click();
  await reader.waitFor({ state: "detached" });
  const open = state.requests.find(({ type }) => type === "read_summary");
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

test("Stash distinguishes native summary issues and keeps the original reachable", async (t) => {
  const blocked = item(1, { title: 'Blocked <img src="/unexpected-stash.png">', summary_issue: "conflict" });
  const unavailable = item(2, { summary_issue: "unavailable" });
  const done = item(3, { done: true });
  const fixture = await stashFixture(t, [blocked, unavailable, done]);
  if (!fixture) return;
  const { page, state } = fixture;
  const detail = page.getByRole("region", { name: "Selected saved page" });
  await result(page, /Showing 2 saved pages/);
  for (const [n, entry, label, guidance] of [
    [1, blocked, "Summary blocked", /Review the summary files in your selected home, then refresh Stash/u],
    [2, unavailable, "Summary temporarily unavailable", /Check that your selected home is accessible, then refresh Stash/u],
  ]) {
    await row(page, n).press("Enter");
    await focused(page, "#stash-detail-heading");
    assert.equal(await detail.getByRole("heading").textContent(), entry.title);
    assert.equal(await detail.locator("img").count(), 0);
    assert.equal(await detail.locator(".stash-summary-status").textContent(), label);
    assert.match(await detail.textContent(), guidance);
    assert.equal(await detail.getByRole("link", { name: "Open original" }).getAttribute("href"), entry.url);
    assert.equal(await detail.getByRole("link", { name: "Retry summary" }).count(), 0);
    assert.equal(await detail.getByRole("button", { name: "Open summary" }).count(), 0);
  }

  await filter(page, "Done").click();
  await result(page, /Showing 1 saved page\./);
  assert.equal(await detail.locator(".stash-summary-status").textContent(), "No saved summary");
  assert.equal(await detail.getByRole("link", { name: "Open original" }).getAttribute("href"), done.url);
  assert.equal(await detail.getByRole("link", { name: "Retry summary" }).count(), 0);
  assert.equal(await detail.getByRole("button", { name: "Mark done" }).count(), 0);

  state.hook = ({ type }) => type === "list_stash"
    ? { type: "error", code: "invalid_request", message: "invalid or unsupported request JSON" } : null;
  await refresh(page).click();
  await result(page, /Update the Brauser host and extension together to use Stash.*Showing the previous results/);
  assert.equal(await detail.getByRole("link", { name: "Open original" }).getAttribute("href"), done.url);
});

test("Stash retry opens the saved original and restores focus when a summary arrives", async (t) => {
  const saved = item(2);
  const fixture = await stashFixture(t, [item(1), saved]);
  if (!fixture) return;
  const { page, state } = fixture;
  const detail = page.getByRole("region", { name: "Selected saved page" });
  await result(page, /Showing 2 saved pages/);
  await row(page, 2).press("Enter");
  await focused(page, "#stash-detail-heading");
  assert.equal(await detail.locator(".stash-summary-status").textContent(), "No saved summary");
  const retry = detail.getByRole("link", { name: "Retry summary" });
  assert.equal(await retry.count(), 1, "missing summaries offer a checked retry link");
  assert.equal(await retry.getAttribute("href"), saved.url);
  assert.equal(await retry.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await retry.getAttribute("aria-describedby"), "stash-summary-guidance");
  assert.match(await detail.textContent(), /After the original loads, choose Summarize & log or Save Page in the Brauser side panel/u);
  await audit(t, page, "stash/summary-retry");

  const redirected = new URL("/sign-in", saved.url).href;
  const navigations = [];
  await page.context().route(saved.url, (route) => {
    navigations.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta http-equiv="refresh" content="0;url=/sign-in">' });
  });
  await page.context().route(redirected, (route) => {
    navigations.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture sign-in</title>" });
  });
  await page.evaluate(() => {
    chrome.scripting.executeScript = async () => { window.fixture.actions.push("extract"); return []; };
  });
  await page.keyboard.press("Tab");
  await focused(page, "#stash-open-source");
  await page.keyboard.press("Tab");
  await focused(page, "#stash-retry-summary");
  const newPage = page.context().waitForEvent("page", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  const original = await newPage;
  await original.waitForURL(redirected);
  assert.deepEqual(navigations, [saved.url, redirected]);
  assert.equal(await original.evaluate(() => window.opener === null), true);

  saved.summary = summary({ overview: "An independently saved <b>summary</b>.", read_scope: "partial" });
  await original.close();
  await returnToTab(page);
  await detail.getByRole("button", { name: "Open summary" }).waitFor();
  await focused(page, "#stash-open-summary");
  assert.equal(await row(page, 2).getAttribute("aria-current"), "true");
  assert.equal(await detail.getByRole("heading").textContent(), saved.title);
  assert.equal(await detail.locator(".stash-summary-status").textContent(), "Partial");
  assert.equal(await detail.locator(".stash-overview").textContent(), saved.summary.overview);
  assert.equal(await detail.locator("b").count(), 0);
  assert.equal(await retry.count(), 0);
  assert.equal(await detail.getByRole("link", { name: "Open original" }).getAttribute("href"), saved.url);
  assert.deepEqual(await page.evaluate(() => window.fixture.actions), []);
  assert.deepEqual([...new Set(state.requests.map(({ type }) => type))].sort(), ["get_config", "list_stash"]);
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

test("Stash Pin and Unpin keep keyboard focus and reading status across a later-page reorder", async (t) => {
  const entries = Array.from({ length: 43 }, (_, n) => item(n + 1, { done: n === 42 }));
  const fixture = await stashFixture(t, entries, { supportPins: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await more(page).press("Enter");
  await result(page, /Showing 40 saved pages/);
  await row(page, 38).press("Enter");
  const pin = page.getByRole("button", { name: "Pin", exact: true });
  const gate = Promise.withResolvers();
  state.hook = ({ type }) => type === "set_stash_pin" ? gate.promise : null;
  await pin.press("Enter");
  await result(page, /Pinning the page/);
  await pin.press("Enter");
  // Another copy already committed the same input. The acknowledgement is a replay.
  state.changePin(item(38).id, true);
  gate.resolve(null);
  await result(page, /Pinned.*Showing 40 saved pages/);
  assert.equal(state.requests.filter(({ type }) => type === "set_stash_pin").length, 1);
  const write = state.requests.find(({ type }) => type === "set_stash_pin");
  assert.deepEqual([write.id, write.version, write.pin_version, write.pinned, write.expected_revision],
    [item(38).id, item(38).version, "b".repeat(64), true, "1"]);
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(38).id);
  assert.match(await rows(page).first().textContent(), /Pinned/u);
  assert.match(await page.locator("#stash-detail").textContent(), /To read.*Pinned/u);
  await focused(page, "#stash-pin");

  state.hook = null;
  await page.getByRole("button", { name: "Unpin", exact: true }).press("Enter");
  await result(page, /Unpinned.*Showing 40 saved pages/);
  await focused(page, "#stash-pin");
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(1).id);
  assert.equal(await row(page, 38).getAttribute("aria-current"), "true");
  assert.deepEqual(entries[37], item(38));
  assert.ok(listRequests(state).every(({ include_pin, after, pin_order }) =>
    include_pin === true && (after === null ? pin_order === undefined : typeof pin_order === "string")));
  await filter(page, "Done").click();
  await result(page, /Showing 1 saved page/);
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(43).id);
  assert.equal(await page.getByRole("button", { name: "Mark done" }).count(), 0);
  await page.getByRole("button", { name: "Pin", exact: true }).press("Enter");
  await result(page, /Pinned.*Showing 1 saved page/);
  assert.deepEqual(entries[42], item(43, { done: true }));
  assert.match(await page.locator("#stash-detail").textContent(), /Done.*Pinned/u);
});

test("Stash keeps stale continuation rows and finds a former pinned tail after another tab unpins it", async (t) => {
  const entries = Array.from({ length: 70 }, (_, n) => item(n + 1));
  const fixture = await stashFixture(t, entries, { supportPins: true, width: 900, height: 640 });
  if (!fixture) return;
  const { page, state } = fixture;
  const rowIds = () => rows(page).evaluateAll((buttons) => buttons.map((button) => button.dataset.stashId));
  await result(page, /Showing 20 saved pages/);
  const before = await rowIds();
  state.changePin(item(20).id, true);
  await more(page).press("Enter");
  await result(page, /Could not load more saved pages.*Refresh Stash/);
  assert.deepEqual(await rowIds(), before);
  await focused(page, "#stash-more");

  // Put a much older row at the loaded boundary in the pinned group.
  for (let n = 1; n <= 19; n += 1) state.changePin(item(n).id, true);
  state.changePin(item(20).id, false);
  state.changePin(item(61).id, true);
  await refresh(page).press("Enter");
  await result(page, /Showing 40 saved pages/);
  // Reset the loaded range with the ordinary status controls.
  await filter(page, "All").click();
  await result(page, /Showing 20 saved pages/);
  assert.equal((await rowIds()).at(-1), item(61).id);
  await row(page, 4).press("Enter");
  await focused(page, "#stash-detail-heading");
  state.changePin(item(61).id, false);
  // The first replacement page now ends with an older pinned row. The
  // old timestamp-only check would accept it without finding row 61.
  state.changePin(item(62).id, true);
  await returnToTab(page);
  await result(page, /Showing 70 saved pages/);
  assert.equal((await rowIds())[61], item(61).id);
  assert.equal(new Set(await rowIds()).size, 70);
  assert.equal(await row(page, 4).getAttribute("aria-current"), "true");
  await focused(page, "#stash-detail-heading");
});

test("Stash Pin refreshes after a stale action without moving the displayed row on refusal", async (t) => {
  const fixture = await stashFixture(t, [item(1), item(2)], { supportPins: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 2 saved pages/);
  await row(page, 2).press("Enter");
  state.changePin(item(2).id, true);
  state.changePin(item(2).id, false);
  const gate = Promise.withResolvers();
  state.hook = ({ type }) => type === "list_stash" ? gate.promise : null;
  await page.getByRole("button", { name: "Pin", exact: true }).press("Enter");
  await result(page, /pin changed elsewhere.*Refreshing/i);
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(1).id);
  assert.equal(await row(page, 2).getAttribute("aria-current"), "true");
  gate.resolve(null);
  await result(page, /pin changed elsewhere.*Showing 2 saved pages/i);
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(1).id);
  await focused(page, "#stash-pin");
});

test("Stash Pin falls back only on an older host's exact reply and refuses malformed state", async (t) => {
  const browser = await a11yBrowser(t);
  if (!browser) return;
  t.after(() => browser.close());
  const legacy = await stashFixture(t, [item(1)], {}, browser);
  await result(legacy.page, /Showing 1 saved page/);
  assert.equal(legacy.state.pinProbes.length, 1);
  assert.equal(Object.hasOwn(listRequests(legacy.state)[0], "include_pin"), false);
  assert.equal(await legacy.page.locator("#stash-pin").count(), 0);

  const other = await stashFixture(t, [item(1)], { pinProbeMessage: "A different invalid request." }, browser);
  await result(other.page, /A different invalid request/);
  assert.equal(listRequests(other.state).length, 0);

  const malformed = await stashFixture(t, [item(1)], { supportPins: true, hook: ({ type }) => type === "list_stash"
    ? { type: "stash_listed", items: [item(1, { pin: { pinned: "true", version: "b".repeat(64) } })],
      pin_order: "c".repeat(64), next: null } : null }, browser);
  await result(malformed.page, /Could not load Stash/);
  assert.equal(await rows(malformed.page).count(), 0);
  assert.equal(listRequests(malformed.state).length, 1);
});

const readingWrites = (state) => state.requests.filter(({ type }) => type === "set_stash_reading");
const undoReading = (page) => page.getByRole("button", { name: "Undo", exact: true });
const moveToRead = (page) => page.getByRole("button", { name: "Move to To read", exact: true });
const markDone = (page) => page.getByRole("button", { name: "Mark done", exact: true });
const readingHost = { supportReading: true, supportPins: true, supportSearch: true };

test("Stash reading Undo restores an acknowledged later-page completion by keyboard", async (t) => {
  const entries = Array.from({ length: 22 }, (_, n) => item(n + 1, n === 20 ? { summary: summary() } : {}));
  const saved = structuredClone(entries[20]);
  const fixture = await stashFixture(t, entries, { ...readingHost, width: 640 });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await more(page).press("Enter");
  await result(page, /Showing 22 saved pages/);
  assert.deepEqual(listRequests(state).map(({ after, include_reading }) => [after, include_reading]),
    [[null, true], [item(20).id, true]]);
  await row(page, 21).press("Enter");
  const gate = Promise.withResolvers();
  state.hook = ({ type, done }) => type === "set_stash_reading" && done ? gate.promise : null;
  await markDone(page).press("Enter");
  try {
    await result(page, /Marking the page done/);
    assert.equal(await undoReading(page).count(), 0);
    await markDone(page).press("Enter");
  } finally {
    gate.resolve(null);
  }
  await result(page, /Marked as done.*Showing 21 saved pages.*Undo is available/);
  assert.equal(await row(page, 21).count(), 0);
  assert.equal(await row(page, 22).getAttribute("aria-current"), "true");
  await focused(page, "#stash-detail-heading");
  assert.equal(await page.locator("#stash-undo-title").textContent(), `Mark done for ${saved.title}`);
  await assertNoHorizontalOverflow(page);
  await audit(t, page, "stash/reading-undo");
  const completedVersion = state.readingVersion(saved.id);
  assert.equal(readingWrites(state).length, 1);

  await page.getByText("More filters", { exact: true }).press("Tab");
  await focused(page, "#stash-undo");
  await page.keyboard.press("Enter");
  await result(page, /Completion undone.*Showing 22 saved pages/);
  await focused(page, `#stash-list button[data-stash-id="${item(22).id}"]`);
  assert.equal(await undoReading(page).count(), 0);
  assert.deepEqual(state.entries[20], saved);
  const writes = readingWrites(state);
  assert.deepEqual(writes.map(({ id, version, reading_version, done, expected_revision }) =>
    [id, version, reading_version, done, expected_revision]),
  [[saved.id, saved.version, "c".repeat(64), true, "1"], [saved.id, saved.version, completedVersion, false, "1"]]);
  assert.notEqual(writes[0].request_id, writes[1].request_id);
  assert.ok(listRequests(state).every(({ include_reading }) => include_reading === true));
  await row(page, 21).press("Enter");
  assert.equal(await page.getByRole("link", { name: "Open original" }).getAttribute("href"), saved.url);
  assert.equal(await page.locator(".stash-overview").textContent(), saved.summary.overview);

  await markDone(page).press("Enter");
  await result(page, /Undo is available/);
  await page.reload();
  await result(page, /Showing 20 saved pages/);
  assert.equal(await undoReading(page).count(), 0);
  await filter(page, "Done").press("Enter");
  await result(page, /Showing 1 saved page/);
  await row(page, 21).press("Enter");
  assert.equal(await moveToRead(page).count(), 1);
});

test("Stash reading Move to To read preserves Pin, saved summary, and focus in All", async (t) => {
  const finished = item(2, { done: true, summary: summary() });
  const fixture = await stashFixture(t, [item(1), finished], readingHost);
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 1 saved page/);
  await filter(page, "All").press("Enter");
  await result(page, /Showing 2 saved pages/);
  await row(page, 2).press("Enter");
  await page.getByRole("button", { name: "Pin", exact: true }).press("Enter");
  await result(page, /Pinned.*Showing 2 saved pages/);
  await moveToRead(page).press("Enter");
  await result(page, /Moved to To read.*Showing 2 saved pages/);
  await focused(page, "#stash-complete");
  assert.equal(await row(page, 2).getAttribute("aria-current"), "true");
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), finished.id);
  assert.equal(await row(page, 2).getByText("Pinned", { exact: true }).count(), 1);
  assert.equal(await row(page, 2).getByText("To read", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Unpin", exact: true }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Open original" }).getAttribute("href"), finished.url);
  assert.equal(await page.locator(".stash-overview").textContent(), finished.summary.overview);
  assert.equal(await undoReading(page).count(), 0);
  const [write] = readingWrites(state);
  assert.deepEqual([write.expected_revision, write.id, write.version, write.reading_version, write.done],
    ["1", finished.id, finished.version, "c".repeat(64), false]);
  assert.equal(state.requests.filter(({ type }) => type === "set_stash_pin").length, 1);
});

test("Stash reading rejects stale Undo after a newer completion and refreshes the current view", async (t) => {
  const fixture = await stashFixture(t, [item(1), item(2)], readingHost);
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 2 saved pages/);
  await markDone(page).press("Enter");
  await result(page, /Undo is available/);
  const id = item(1).id;
  const completedVersion = state.readingVersion(id);
  state.changeReading(id, false);
  const newerVersion = state.changeReading(id, true);
  const gate = Promise.withResolvers();
  state.hook = ({ type }) => type === "list_stash" ? gate.promise : null;
  await undoReading(page).press("Enter");
  try {
    await result(page, /reading state changed elsewhere.*Refreshing Stash/);
    assert.equal(await undoReading(page).count(), 0);
    assert.equal(await row(page, 1).count(), 0);
    assert.equal(await row(page, 2).getAttribute("aria-current"), "true");
    await focused(page, `#stash-list button[data-stash-id="${item(2).id}"]`);
  } finally {
    gate.resolve(null);
  }
  await result(page, /reading state changed elsewhere.*Showing 1 saved page/);
  assert.equal(readingWrites(state)[1].reading_version, completedVersion);
  assert.equal(state.readingVersion(id), newerVersion);
  assert.equal(state.entries[0].done, true);
  await filter(page, "Done").press("Enter");
  await result(page, /Showing 1 saved page/);
  await moveToRead(page).press("Enter");
  await result(page, /Moved to To read.*No pages marked done yet/);
  assert.equal(readingWrites(state)[2].reading_version, newerVersion);
  await focused(page, "#stash-results-heading");
});

test("Stash reading keeps the query and coverage filter when a result moves out of Done", async (t) => {
  const matched = item(1, { title: "Quartz notes", done: true, summary: summary({ read_scope: "partial" }) });
  const other = item(2, { title: "Quartz decisions", done: true, summary: summary({ read_scope: "whole" }) });
  const fixture = await stashFixture(t, [matched, other], readingHost);
  if (!fixture) return;
  const { page, state } = fixture;
  state.hook = ({ type, state: view, query, search, include_reading }) => {
    if (type !== "list_stash" || !search) return null;
    assert.equal(include_reading, true);
    const items = state.entries.filter((entry) => entry.done === (view === "done") &&
      entry.title.includes(query) && (!search.coverage || search.coverage === entry.summary.read_scope));
    return {
      type: "stash_listed", next: null, pin_order: "e".repeat(64), search_progress: { revision: "d".repeat(64) },
      items: items.map((entry) => ({ ...entry, pin: { pinned: false, version: "b".repeat(64) },
        reading_version: state.readingVersion(entry.id), search_match: { source: "title" } })),
    };
  };
  await result(page, /No pages to read/);
  await filter(page, "Done").press("Enter");
  await result(page, /Showing 2 saved pages/);
  const search = page.getByRole("searchbox");
  await search.fill("Quartz");
  await result(page, /Showing 2 saved pages/);
  await page.getByText("More filters", { exact: true }).click();
  const coverage = page.getByLabel("Summary coverage");
  await coverage.selectOption("partial");
  await result(page, /Showing 1 saved page/);
  await row(page, 1).press("Enter");
  await moveToRead(page).press("Enter");
  await result(page, /Moved to To read.*No saved pages match this search and filter/);
  assert.equal(await rows(page).count(), 0);
  assert.equal(await filter(page, "Done").getAttribute("aria-pressed"), "true");
  assert.equal(await search.inputValue(), "Quartz");
  assert.equal(await coverage.inputValue(), "partial");
  await focused(page, "#stash-results-heading");
  await filter(page, "To read").press("Enter");
  await result(page, /Showing 1 saved page/);
  assert.equal(await row(page, 1).getAttribute("aria-current"), "true");
  assert.equal(await row(page, 2).count(), 0);
  const { state: view, query, search: facets } = listRequests(state).at(-1);
  assert.deepEqual([view, query, facets.coverage], ["open", "Quartz", "partial"]);
});

test("Stash reading never offers Undo after an invalid acknowledgement or changed configuration", async (t) => {
  const fixture = await stashFixture(t, [item(1)], readingHost);
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 1 saved page/);
  for (const reply of [
    { done: true, reading_version: "invalid" },
    { done: false, reading_version: "d".repeat(64) },
    { done: true, reading_version: "c".repeat(64) },
  ]) {
    const before = readingWrites(state).length;
    state.hook = ({ type }) => type === "set_stash_reading" ? { type: "stash_reading_set", ...reply } : null;
    await markDone(page).press("Enter");
    await result(page, /Could not mark the page done/);
    assert.equal(readingWrites(state).length, before + 1);
    assert.equal(await undoReading(page).count(), 0);
    assert.equal(await rows(page).count(), 1);
    await focused(page, "#stash-complete");
  }
  state.revision = "2";
  await markDone(page).press("Enter");
  await result(page, /Could not mark the page done.*refresh Stash and try again/);
  await focused(page, "#stash-refresh");
  assert.equal(await rows(page).count(), 0);
  assert.equal(await undoReading(page).count(), 0);
  assert.equal(state.entries[0].done, false);
});

test("Stash reading rejects a row that omits the accepted reading version", async (t) => {
  const saved = item(1, { pin: { pinned: false, version: "b".repeat(64) } });
  const fixture = await stashFixture(t, [saved], { ...readingHost, hook: ({ type }) => type === "list_stash"
    ? { type: "stash_listed", items: [saved], pin_order: "c".repeat(64), next: null } : null });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Could not load Stash.*result page changed/);
  assert.equal(await rows(page).count(), 0);
  assert.equal(await markDone(page).count(), 0);
  assert.equal(listRequests(state).length, 1);
  assert.equal(listRequests(state)[0].include_reading, true);
});

test("Stash reading preserves repair guidance from an occupied file", async (t) => {
  const fixture = await stashFixture(t, [item(1)], readingHost);
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 1 saved page/);
  state.hook = ({ type }) => type === "set_stash_reading" ? {
    type: "error", code: "conflict",
    message: "An unrelated or edited file occupies this Stash entry's name. Move it aside and try again.",
  } : null;
  await markDone(page).press("Enter");
  await result(page, /Could not mark the page done.*Move it aside and try again/);
  assert.equal(readingWrites(state).length, 1);
  assert.equal(listRequests(state).length, 1);
  assert.equal(await rows(page).count(), 1);
  await focused(page, "#stash-complete");
});

test("Stash reading preserves legacy completion when the host refuses the opt-in", async (t) => {
  const fixture = await stashFixture(t, [item(1)], { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 1 saved page/);
  assert.deepEqual(state.readingProbes.map(({ include_reading, include_pin, after }) =>
    [include_reading, include_pin, after]), [[true, true, null]]);
  assert.equal(await page.getByRole("button", { name: "Pin", exact: true }).count(), 1);
  await markDone(page).press("Enter");
  await result(page, /Marked as done/);
  assert.equal(await undoReading(page).count(), 0);
  await filter(page, "Done").press("Enter");
  await result(page, /Showing 1 saved page/);
  assert.equal(await moveToRead(page).count(), 0);
  assert.equal(state.requests.filter(({ type }) => type === "complete_stash").length, 1);
  assert.equal(readingWrites(state).length, 0);
  assert.ok(listRequests(state).every((request) => !Object.hasOwn(request, "include_reading")));
});

test("Stash can deliberately reload its first page after a completed tail and unrelated pin exhaust refresh", async (t) => {
  const entries = Array.from({ length: 141 }, (_, n) => item(n + 1));
  const fixture = await stashFixture(t, entries, { supportPins: true, width: 900 });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  const search = page.getByRole("searchbox");
  const restart = page.getByRole("button", { name: "Reload first page", exact: true });
  assert.equal(await restart.count(), 0);
  await search.fill("saved page");
  await result(page, /Showing 20 saved pages/);
  await row(page, 5).press("Enter");
  await focused(page, "#stash-detail-heading");
  assert.equal(await rows(page).last().getAttribute("data-stash-id"), item(20).id);

  const before = listRequests(state).length;
  entries[19].done = true;
  state.changePin(item(136).id, true);
  await returnToTab(page);
  await result(page, /refresh reached its results limit.*Showing the previous results/);
  assert.equal(listRequests(state).length - before, 6);
  assert.equal(await row(page, 20).count(), 1);
  assert.equal(await row(page, 5).getAttribute("aria-current"), "true");
  await focused(page, "#stash-detail-heading");

  state.hook = ({ type, after }) => type === "list_stash" && after === null
    ? { type: "error", code: "internal", message: "The first page could not be read." } : null;
  await restart.press("Enter");
  await result(page, /first page could not be read.*Showing the previous results/);
  assert.equal(await row(page, 20).count(), 1);
  assert.equal(await row(page, 5).getAttribute("aria-current"), "true");
  await focused(page, "#stash-refresh");

  state.hook = null;
  const restartBefore = listRequests(state).length;
  await restart.press("Enter");
  await result(page, /Showing 20 saved pages/);
  assert.deepEqual(listRequests(state).slice(restartBefore).map(({ state, query, after, include_pin }) =>
    [state, query, after, include_pin]), [["open", "saved page", null, true]]);
  assert.equal(await rows(page).first().getAttribute("data-stash-id"), item(136).id);
  assert.equal(await row(page, 20).count(), 0);
  assert.equal(await row(page, 5).getAttribute("aria-current"), "true");
  assert.equal(await search.inputValue(), "saved page");
  assert.equal(await filter(page, "To read").getAttribute("aria-pressed"), "true");
  assert.equal(await restart.count(), 0);
  await focused(page, "#stash-refresh");
  await more(page).press("Enter");
  await result(page, /Showing 40 saved pages/);
  assert.equal(await restart.count(), 0);
});

test("Stash continues an empty bounded search and restarts after a stale result", async (t) => {
  const first = item(1);
  const second = item(2, { url: "https://work.example.test/saved-note" });
  const fixture = await stashFixture(t, [first, second], { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  const revision = "d".repeat(64);
  const order = "e".repeat(64);
  const snippet = "A note mentions <img src=about:blank> quartz.";
  const searchPage = (items, next, limited_by) => ({
    type: "stash_listed", items, next, pin_order: order,
    search_progress: { revision, ...(limited_by ? { limited_by } : {}) },
  });
  const pinned = (entry, search_match) => ({
    ...entry, pin: { pinned: false, version: "b".repeat(64) }, search_match,
  });
  await result(page, /Showing 2 saved pages/);
  state.hook = ({ type, search, query, after, pin_order }) => {
    if (type !== "list_stash" || !search || query !== "quartz") return null;
    if (!after) return searchPage([], first.id, "files");
    assert.equal(search.revision, revision);
    assert.equal(pin_order, order);
    if (after === first.id) {
      return searchPage([pinned(second, { source: "note", snippet })], second.id, "elapsed");
    }
    return { type: "error", code: "conflict", message: "Stash results changed. Restart the search to continue." };
  };
  const search = page.getByRole("searchbox");
  await search.fill("quartz");
  await result(page, /Found 0 matches so far.*Search paused/);
  await page.getByText("More filters", { exact: true }).click();
  const source = page.getByLabel("Source domain");
  await source.fill("work.example.test");
  await source.press("Tab");
  await result(page, /Found 0 matches so far.*Search paused/);
  assert.equal(await rows(page).count(), 0);
  const moreSearch = page.getByRole("button", { name: "Continue search" });
  await moreSearch.press("Enter");
  await result(page, /Found 1 match so far/);
  assert.equal(await rows(page).count(), 1);
  assert.match(await row(page, 2).textContent(), /Saved note match.*<img src=about:blank> quartz/);
  assert.equal(await row(page, 2).locator("img").count(), 0);
  await focused(page, `#stash-list button[data-stash-id="${second.id}"]`);
  await moreSearch.press("Enter");
  await result(page, /Restart the search to continue.*Showing the previous results/);
  assert.equal(await rows(page).count(), 1);
  assert.equal(await moreSearch.count(), 0, "a stale search cursor can no longer be retried");
  await focused(page, "#stash-refresh");
  await page.getByRole("button", { name: "Reload first page" }).click();
  await result(page, /Found 0 matches so far/);
  assert.equal(await search.inputValue(), "quartz");
  assert.equal(await source.inputValue(), "work.example.test");
  assert.equal(listRequests(state).at(-1).search.source_host, "work.example.test");
});

test("Stash applies source, document type and coverage together across a filter-only request", async (t) => {
  const entry = item(1, { summary: summary({ read_scope: "partial" }) });
  const fixture = await stashFixture(t, [entry], { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 1 saved page/);
  state.hook = (request) => {
    if (request.type !== "list_stash" || !request.search) return null;
    return {
      type: "stash_listed", next: null, pin_order: "e".repeat(64),
      search_progress: { revision: "d".repeat(64) },
      items: [{ ...entry, pin: { pinned: false, version: "b".repeat(64) } }],
    };
  };
  await page.getByText("More filters", { exact: true }).click();
  const source = page.getByLabel("Source domain");
  await source.fill("work.example.test");
  await source.press("Tab");
  await page.getByLabel("Document type").fill("Decision");
  await page.getByLabel("Summary coverage").selectOption("partial");
  await page.waitForFunction(() => document.querySelector("#stash-status")?.textContent === "Showing 1 saved page.");
  assert.deepEqual(listRequests(state).at(-1).search, {
    source_host: "work.example.test", document_type: "Decision", coverage: "partial",
  });
  assert.equal(await row(page, 1).locator(".stash-match").count(), 0);
});

test("Stash keeps rejected search filters until the user clears them for an older host", async (t) => {
  const entry = item(1, { summary: summary({ read_scope: "partial" }) });
  const fixture = await stashFixture(t, [entry, item(2)], { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 2 saved pages/);
  state.hook = ({ type, search, query }) => {
    if (type !== "list_stash" || !search) return null;
    return {
      type: "stash_listed", next: null, pin_order: "e".repeat(64), search_progress: { revision: "d".repeat(64) },
      items: [{ ...entry, pin: { pinned: false, version: "b".repeat(64) },
        ...(query ? { search_match: { source: "title" } } : {}) }],
    };
  };
  await page.getByText("More filters", { exact: true }).click();
  const search = page.getByRole("searchbox");
  const source = page.getByLabel("Source domain");
  const type = page.getByLabel("Document type");
  const coverage = page.getByLabel("Summary coverage");
  await source.fill("work.example.test");
  await type.fill("Decision");
  await coverage.selectOption("partial");
  await search.fill("saved page");
  await result(page, /Showing 1 saved page\./);
  assert.equal(await row(page, 1).getAttribute("aria-current"), "true");

  const before = listRequests(state).length;
  state.supportSearch = false;
  await refresh(page).click();
  await result(page, /Showing the previous results/);
  assert.equal(await listRequests(state).length, before, "the rejected facets must not trigger a legacy list");
  assert.equal(await source.isVisible(), true, "the rejected filters remain visible");
  assert.equal(await source.inputValue(), "work.example.test");
  assert.equal(await type.inputValue(), "Decision");
  assert.equal(await coverage.inputValue(), "partial");
  assert.equal(await rows(page).count(), 1);
  assert.equal(await row(page, 1).getAttribute("aria-current"), "true");

  await refresh(page).click();
  await result(page, /Showing the previous results/);
  assert.equal(await listRequests(state).length, before, "refresh must still respect the retained filters");
  assert.equal(await coverage.inputValue(), "partial");
  await page.getByRole("button", { name: "Clear search filters", exact: true }).press("Enter");
  await result(page, /Showing 2 saved pages.*This host searches titles and sources/);
  assert.equal(await source.isVisible(), false);
  assert.equal(await search.inputValue(), "saved page");
  await focused(page, "#stash-search");
  const legacy = listRequests(state).at(-1);
  assert.equal(legacy.query, "saved page");
  assert.equal(Object.hasOwn(legacy, "search"), false);
});

test("Stash gives refresh its own search chain and retires a cursor cycle with keyboard recovery", async (t) => {
  const entries = Array.from({ length: 21 }, (_, index) => item(index + 1));
  const fixture = await stashFixture(t, entries, { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  const [firstCursor, secondCursor] = entries.slice(-2).map(({ id }) => id);
  const pinned = (entry) => ({
    ...entry, pin: { pinned: false, version: "b".repeat(64) }, search_match: { source: "title" },
  });
  const searchPage = (items, next, limited_by) => ({
    type: "stash_listed", items: items.map(pinned), next, pin_order: "e".repeat(64),
    search_progress: { revision: "d".repeat(64), ...(limited_by ? { limited_by } : {}) },
  });
  state.hook = ({ type, search, after }) => {
    if (type !== "list_stash" || !search) return null;
    if (after === null) return searchPage(entries.slice(0, 20), firstCursor);
    if (after === firstCursor) return searchPage(entries.slice(-1), secondCursor, "files");
    assert.equal(after, secondCursor);
    return searchPage([], firstCursor, "files");
  };
  const search = page.getByRole("searchbox");
  await search.fill("saved page");
  await result(page, /Showing 20 saved pages/);
  await more(page).press("Enter");
  await result(page, /Found 21 matches so far/);
  await row(page, 21).press("Enter");
  await focused(page, "#stash-detail-heading");

  const before = listRequests(state).length;
  await returnToTab(page);
  await result(page, /Found 21 matches so far/);
  assert.deepEqual(listRequests(state).slice(before).map(({ after }) => after), [null, firstCursor]);
  assert.equal(await row(page, 21).getAttribute("aria-current"), "true");
  await focused(page, "#stash-detail-heading");

  const continueSearch = page.getByRole("button", { name: "Continue search" });
  await continueSearch.press("Enter");
  await result(page, /Showing the previous results.*Reload first page/);
  assert.equal(await continueSearch.count(), 0);
  assert.equal(await rows(page).count(), 21);
  assert.equal(await row(page, 21).getAttribute("aria-current"), "true");
  assert.equal(await search.inputValue(), "saved page");
  await focused(page, "#stash-refresh");

  await page.getByRole("button", { name: "Reload first page" }).press("Enter");
  await result(page, /Showing 20 saved pages/);
  await more(page).press("Enter");
  await result(page, /Found 21 matches so far/);
});

test("Stash reports incomplete saved content with valid results and across continuation", async (t) => {
  const first = item(1, { title: "First quartz page" });
  const second = item(2, { title: "Second quartz page" });
  const fixture = await stashFixture(t, [first, second], { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 2 saved pages/);
  state.hook = ({ type, search, query, after }) => {
    if (type !== "list_stash" || !search) return null;
    const matched = after === null ? first : second;
    return {
      type: "stash_listed", next: query === "quartz" && after === null ? first.id : null,
      pin_order: "e".repeat(64),
      search_progress: {
        revision: "d".repeat(64),
        ...(after === null ? { notes_unavailable: true } : {}),
        ...(query === "missing" ? { summaries_unavailable: true } : {}),
        ...(query === "quartz" && after === null ? { limited_by: "files" } : {}),
      },
      items: query === "quartz" ? [{
        ...matched, pin: { pinned: false, version: "b".repeat(64) }, search_match: { source: "title" },
      }] : [],
    };
  };
  const search = page.getByRole("searchbox");
  await search.fill("quartz");
  await result(page, /Found 1 match so far.*Some saved notes could not be checked/);
  await page.getByRole("button", { name: "Continue search" }).press("Enter");
  await result(page, /Showing 2 saved pages.*Some saved notes could not be checked/);
  assert.equal(await rows(page).count(), 2);
  await focused(page, `#stash-list button[data-stash-id="${second.id}"]`);
  await search.fill("missing");
  await result(page, /No matches in the pages checked.*Some saved summaries and notes could not be checked/);
  await search.fill("");
  await page.waitForFunction(() => document.querySelector("#stash-status")?.textContent === "Showing 2 saved pages.");
});

test("Stash preserves the accepted queue while an older host refuses the first additional facet", async (t) => {
  const entries = Array.from({ length: 21 }, (_, index) => item(index + 1));
  const fixture = await stashFixture(t, entries, { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 20 saved pages/);
  await row(page, 3).press("Enter");
  const ids = () => rows(page).evaluateAll((buttons) => buttons.map((button) => button.dataset.stashId));
  const accepted = await ids();
  const before = listRequests(state).length;
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  state.hook = ({ type, search }) => {
    if (type !== "list_stash" || !search) return null;
    started.resolve();
    return reply.promise;
  };
  await page.getByText("More filters", { exact: true }).click();
  const coverage = page.getByLabel("Summary coverage");
  await coverage.focus();
  await coverage.selectOption("partial");
  await started.promise;
  try {
    assert.deepEqual(await ids(), accepted, "the first facet trial keeps the accepted rows");
    assert.equal(await row(page, 3).getAttribute("aria-current"), "true");
    assert.equal(await more(page).count(), 0, "the ordinary cursor is incompatible with the trial scope");
    await focused(page, "#stash-coverage-filter");
    await result(page, /Showing the previous results/);
  } finally {
    reply.resolve({ type: "error", code: "invalid_request", message: "invalid or unsupported request JSON" });
  }

  await result(page, /Update Brauser to use these search filters.*Showing the previous results/);
  assert.deepEqual(await ids(), accepted);
  assert.equal(await row(page, 3).getAttribute("aria-current"), "true");
  assert.equal(await coverage.inputValue(), "partial");
  assert.equal(await filter(page, "To read").getAttribute("aria-pressed"), "true");
  assert.equal(await more(page).count(), 0);
  await focused(page, "#stash-coverage-filter");
  assert.deepEqual(listRequests(state).slice(before).map(({ state, search, after }) => ({ state, search, after })),
    [{ state: "open", search: { coverage: "partial" }, after: null }]);

  await page.getByRole("button", { name: "Clear search filters", exact: true }).press("Enter");
  await result(page, /Showing 20 saved pages/);
  assert.deepEqual(await ids(), accepted);
  assert.equal(await more(page).count(), 1);
  assert.equal(Object.hasOwn(listRequests(state).at(-1), "search"), false);
  await focused(page, "#stash-search");
});

test("Stash keeps the previous queue until the current query and facet trial is accepted", async (t) => {
  const matched = item(3, { title: "Current text", summary: summary({ read_scope: "partial" }) });
  const fixture = await stashFixture(t, [item(1), item(2), matched], { supportPins: true, supportSearch: true });
  if (!fixture) return;
  const { page, state } = fixture;
  await result(page, /Showing 3 saved pages/);
  await row(page, 3).press("Enter");
  const firstRead = Promise.withResolvers();
  const firstReply = Promise.withResolvers();
  const currentRead = Promise.withResolvers();
  const currentReply = Promise.withResolvers();
  state.hook = ({ type, search, query }) => {
    if (type !== "list_stash" || !search) return null;
    if (!query) {
      firstRead.resolve();
      return firstReply.promise;
    }
    assert.equal(query, "Current");
    currentRead.resolve();
    return currentReply.promise;
  };
  const pageReply = (items) => ({
    type: "stash_listed", items, next: null, pin_order: "e".repeat(64), search_progress: { revision: "d".repeat(64) },
  });
  t.after(() => {
    firstReply.resolve(pageReply([]));
    currentReply.resolve(pageReply([]));
  });
  await page.getByText("More filters", { exact: true }).click();
  const coverage = page.getByLabel("Summary coverage");
  await coverage.selectOption("partial");
  await firstRead.promise;
  const search = page.getByRole("searchbox");
  await search.fill("Current");
  firstReply.resolve(pageReply([]));
  await currentRead.promise;
  assert.equal(await rows(page).count(), 3, "the old query's reply cannot replace the accepted queue");
  assert.equal(await row(page, 3).getAttribute("aria-current"), "true");
  await focused(page, "#stash-search");
  await result(page, /Showing the previous results/);
  currentReply.resolve(pageReply([{ ...matched, pin: { pinned: false, version: "b".repeat(64) },
    search_match: { source: "title" } }]));
  await result(page, /Showing 1 saved page/);
  assert.equal(await rows(page).count(), 1);
  assert.equal(await row(page, 3).getAttribute("aria-current"), "true");
  assert.equal(await page.getByRole("status").textContent(), "Showing 1 saved page.");
  assert.equal(await coverage.inputValue(), "partial");
  await focused(page, "#stash-search");
});
