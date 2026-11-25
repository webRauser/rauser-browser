import assert from "node:assert/strict";
import test from "node:test";
import { AxeBuilder } from "@axe-core/playwright";
import { activate, assertAccessible, audit, browserFixture, enterPanelTab, explorerArtifact, focused, task } from "./fixture.mjs";

for (const pageName of ["panel", "options", "tasks", "explorer"]) {
  for (const state of ["setup", "configured", "disconnected", "error"]) {
    for (const colorScheme of ["light", "dark"]) {
      test(`${pageName}: ${state}, ${colorScheme}`, async (t) => {
        const page = await browserFixture(t, pageName, state, { colorScheme });
        if (page) await audit(t, page, `${pageName}/${state}/${colorScheme}`);
      });
    }
  }
}

for (const colorScheme of ["light", "dark"]) {
  test(`The management directory replaces the empty page view in ${colorScheme}`, async (t) => {
    const page = await browserFixture(t, "panel", "configured", {
      colorScheme, viewport: { width: 320, height: 660 }, runs: [task(1, "running")],
    });
    if (!page) return;
    const directory = page.getByRole("navigation", { name: "Brauser pages" });
    assert.equal(await directory.isVisible(), false);

    // Chrome may return the tab ID without a URL. The extension's top-level
    // context still identifies its own Stash page, including when it has a hash.
    await page.evaluate(() => {
      delete fixture.tab.url;
      chrome.runtime.getContexts = async (filter) => {
        if (filter.tabIds?.[0] !== fixture.tab.id || filter.frameIds?.[0] !== 0) return [];
        return [{ tabId: fixture.tab.id, documentUrl: chrome.runtime.getURL("stash.html#saved") }];
      };
      chrome.tabs.onActivated.fire({ tabId: fixture.tab.id, windowId: 1 });
    });
    await directory.waitFor();
    assert.equal(await directory.getByRole("button").count(), 4);
    const stash = directory.getByRole("button", { name: "Stash" });
    assert.equal(await stash.getAttribute("aria-current"), "page");
    assert.equal(await stash.getByText("Current page").isVisible(), true);
    assert.equal(await page.locator("#page-area").isVisible(), false);
    assert.equal(await page.locator("#page-note").isVisible(), false);
    assert.equal(await page.locator("#task-input").isVisible(), true);
    for (const data of ["Capture on · 0 configured sites", "9 artifacts in library", "0 pages to read", "1 active task"]) {
      await directory.getByText(data, { exact: true }).waitFor();
    }
    assert.equal(await page.evaluate(() => document.querySelector("#page-view").scrollWidth <= document.querySelector("#page-view").clientWidth), true);
    await audit(t, page, `panel/management-directory/${colorScheme}`);
    await page.setViewportSize({ width: 485, height: 760 });
    const settings = await directory.getByRole("button", { name: "Settings" }).boundingBox();
    const explorer = await directory.getByRole("button", { name: "Artifact Explorer" }).boundingBox();
    assert.equal(explorer.y, settings.y, "two cards fit on the first row when the panel is wide enough");
    assert.ok(explorer.x > settings.x);
    await activate(page, "#management-explorer");
    assert.equal(await page.evaluate(() => fixture.actions.includes(chrome.runtime.getURL("explorer.html"))), true);

    // An extension page with the same filename belongs to a different origin.
    await page.evaluate(() => {
      fixture.tab.url = "chrome-extension://another-extension/stash.html";
      chrome.tabs.onUpdated.fire(fixture.tab.id, { url: fixture.tab.url }, fixture.tab);
    });
    await page.locator("#page-unusable").waitFor();
    assert.equal(await directory.isVisible(), false);
    assert.equal(await page.locator("#page-note").isVisible(), true);

    await page.evaluate(() => {
      fixture.tab.url = chrome.runtime.getURL("tasks.html?source=directory#run");
      chrome.tabs.onUpdated.fire(fixture.tab.id, { url: fixture.tab.url }, fixture.tab);
    });
    await directory.getByRole("button", { name: "Tasks" }).and(page.locator('[aria-current="page"]')).waitFor();
    assert.equal(await stash.getAttribute("aria-current"), null);
  });
}

test("A note that failed to save remains recoverable below the directory", async (t) => {
  const page = await browserFixture(t, "panel");
  if (!page) return;
  await page.locator("#note-body").fill("Draft note to recover.");
  await page.evaluate(() => {
    fixture.noteSaveError = true;
    fixture.tab.url = chrome.runtime.getURL("options.html");
    chrome.tabs.onUpdated.fire(fixture.tab.id, { url: fixture.tab.url }, fixture.tab);
  });
  await page.getByRole("navigation", { name: "Brauser pages" }).waitFor();
  await page.locator("#note-conflict").waitFor();
  assert.equal(await page.locator("#note-body").isVisible(), false);
  assert.equal(await page.locator("#note-recovery-list textarea").inputValue(), "Draft note to recover.");
});

test("The Tasks card starts showing activity when a harness is configured with the panel open", async (t) => {
  const page = await browserFixture(t, "panel", "setup", { runs: [task(1, "running")] });
  if (!page) return;
  await page.evaluate(() => {
    fixture.tab.url = chrome.runtime.getURL("options.html");
    chrome.tabs.onUpdated.fire(fixture.tab.id, { url: fixture.tab.url }, fixture.tab);
  });
  const activity = page.locator("#management-tasks-data");
  await activity.filter({ hasText: "AI harness not set up" }).waitFor();
  assert.equal(await page.evaluate(() => fixture.requests.some(({ type }) => type === "list_runs")), false);

  await page.evaluate(async () => {
    fixture.config.agent = {
      harness: "codex", binary: "/fixture/codex", version: "1.0", timeout_secs: 600, probed_at: new Date().toISOString(),
    };
    fixture.revision = "2";
    await chrome.storage.local.set({
      brauser_policy_v1: {
        revision: fixture.revision, expires_at: Date.now() + 60_000, capture_enabled: fixture.config.capture_enabled,
        adapters: fixture.config.adapters, auto_summary: fixture.config.auto_summary,
      },
    });
  });
  await activity.filter({ hasText: "1 active task" }).waitFor();
});

test("Explorer browses a paused library without an agent and pages canonical artifacts", async (t) => {
  const page = await browserFixture(t, "explorer");
  if (!page) return;
  assert.equal(await page.evaluate(() => fixture.config.agent), null);
  assert.equal(await page.evaluate(() => fixture.config.capture_enabled), false);
  assert.equal(await page.locator(".explorer-row").count(), 8);
  await activate(page, "#explorer-more");
  await page.waitForFunction(() => document.querySelectorAll(".explorer-row").length === 9);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.artifactId), "document:9", "final paging must transfer focus to the first appended artifact");
  const titles = await page.locator(".explorer-row").allTextContents();
  assert.equal(new Set(titles).size, 9);
  const requests = await page.evaluate(() => fixture.requests);
  assert.ok(requests.some((request) => request.type === "explore_artifacts" && request.page.offset === 8));
  assert.equal(requests.some((request) => ["start_run", "list_runs", "update_config", "check_agent"].includes(request.type)), false);
  const results = await audit(t, page, "explorer/paused-no-agent-paged");
  assert.deepEqual(results.incomplete.filter(({ id }) => id === "aria-prohibited-attr"), [], "the view controls need a permitted named group role");
});

test("The summary reader fills a narrow sidebar in both themes", async (t) => {
  for (const colorScheme of ["light", "dark"]) {
    const page = await browserFixture(t, "panel", "configured", {
      colorScheme, viewport: { width: 288, height: 640 }, summary: explorerArtifact(1).summary,
    });
    if (!page) return;
    await activate(page, "#page-summary-open");
    const reader = page.getByRole("dialog", { name: "Saved fixture title" });
    await reader.getByRole("heading", { name: "Key points" }).waitFor();
    const dimensions = await reader.evaluate((element) => [element.offsetWidth, element.offsetHeight]);
    assert.deepEqual(dimensions, [288, 640]);
    await audit(t, page, `panel/summary-reader-${colorScheme}`);
    await page.keyboard.press("Escape");
    await reader.waitFor({ state: "detached" });
    await focused(page, "#page-summary-open");
  }
});

test("Explorer binds saved-summary opening to the library being browsed", async (t) => {
  const page = await browserFixture(t, "explorer");
  if (!page) return;
  await page.evaluate(() => { fixture.revision = "2"; });
  await page.locator("#explorer-open-summary").click();
  await page.getByRole("dialog").getByRole("status").filter({ hasText: /changed|refresh/i }).waitFor();
  const request = await page.evaluate(() => fixture.requests.find((entry) => entry.type === "read_summary"));
  assert.equal(request.expected_revision, "1");
  assert.equal(await page.evaluate(() => fixture.actions.includes("summary-read")), false);
});

test("Explorer clears a filtered preview when newly saved metadata no longer matches", async (t) => {
  const page = await browserFixture(t, "explorer");
  if (!page) return;
  await page.locator("#explorer-category").selectOption("Quality");
  await page.waitForFunction(() => document.querySelectorAll(".explorer-row").length === 5);
  await page.locator("#explorer-detail h2").filter({ hasText: "Release evidence 1" }).waitFor();
  await page.evaluate(() => { fixture.explorerItems[0].summary.category = "Operations"; });
  await page.locator('.explorer-row[data-artifact-id="document:1"]').click();
  await page.waitForFunction(() => !document.getElementById("explorer-detail").textContent.includes("Release evidence 1"));
  assert.match(await page.locator("#explorer-detail").textContent(), /changed|refresh/i);
  assert.equal(await page.locator(".explorer-connection").count(), 0);
  assert.equal(await page.locator("#explorer-map-view").isDisabled(), true);
});

test("Explorer filters reconcile the preview and distinguish intentional navigation beyond filters", async (t) => {
  const page = await browserFixture(t, "explorer");
  if (!page) return;
  await page.locator("#explorer-category").selectOption("Operations");
  await page.waitForFunction(() => document.querySelectorAll(".explorer-row").length === 4);
  await page.locator("#explorer-detail h2").filter({ hasText: "Release evidence 2" }).waitFor();
  await page.locator("#explorer-category").selectOption("Quality");
  await page.waitForFunction(() => document.querySelectorAll(".explorer-row").length === 5);
  await page.locator("#explorer-detail h2").filter({ hasText: "Release evidence 1" }).waitFor();
  await page.locator('.explorer-connection[data-artifact-id="document:2"]').first().click();
  await page.locator("#explorer-detail h2").filter({ hasText: "Release evidence 2" }).waitFor();
  assert.match(await page.locator("#explorer-detail").textContent(), /outside|beyond/i);
  assert.equal(await page.locator(".explorer-row").count(), 5, "related navigation must not silently clear the category filter");
  await page.locator("#explorer-map-view").click();
  await page.locator("#explorer-map").waitFor();
  assert.ok(await page.locator("#explorer-map button").count() > 0);
  await audit(t, page, "explorer/connections-beyond-filters");
  await page.locator("#explorer-list-view").click();
  await page.locator("#explorer-search").fill("no matching captured artifact");
  await page.waitForFunction(() => document.querySelectorAll(".explorer-row").length === 0);
  assert.doesNotMatch(await page.locator("#explorer-detail").textContent(), /Release evidence 2/);
  assert.equal(await page.locator(".explorer-connection").count(), 0);
  await audit(t, page, "explorer/no-match-clears-preview");
});

test("Explorer renders hostile captured text literally and keeps unknown reading separate from unsummarized", async (t) => {
  const hostile = explorerArtifact(1, { title: '<img src="https://untrusted.invalid/x" onerror="alert(1)">' });
  const legacy = explorerArtifact(2);
  delete legacy.summary.read_scope;
  const page = await browserFixture(t, "explorer", "configured", {
    explorerItems: [hostile, legacy, explorerArtifact(3, { summary: null })],
  });
  if (!page) return;
  assert.ok((await page.locator(".explorer-row").first().textContent()).includes("<img"));
  assert.equal(await page.locator("#explorer-list img, #explorer-detail img").count(), 0);
  await page.locator("#explorer-reading").selectOption("unknown");
  await page.waitForFunction(() => document.querySelectorAll(".explorer-row").length === 1);
  await page.locator("#explorer-detail h2").filter({ hasText: "Release evidence 2" }).waitFor();
  await page.locator("#explorer-reading").selectOption("none");
  await page.locator("#explorer-detail h2").filter({ hasText: "Release evidence 3" }).waitFor();
  assert.equal(await page.locator("#explorer-open-summary").isVisible(), false);
  await audit(t, page, "explorer/unsummarized");
});

test("Explorer exposes an empty captured library without fabricating examples", async (t) => {
  const page = await browserFixture(t, "explorer", "configured", { explorerItems: [] });
  if (!page) return;
  assert.equal(await page.locator(".explorer-row").count(), 0);
  await page.locator("#explorer-empty").waitFor();
  assert.equal(await page.locator(".explorer-connection").count(), 0);
  await audit(t, page, "explorer/empty-library");
});

for (const colorScheme of ["light", "dark"]) {
  test(`Explorer keeps controls and preview reachable at wide and narrow widths in ${colorScheme}`, async (t) => {
    const longTitle = "UnbrokenArtifactTitle".repeat(10);
    const page = await browserFixture(t, "explorer", "configured", {
      colorScheme,
      viewport: { width: 1200, height: 720 },
      explorerItems: [explorerArtifact(1, { title: longTitle }), ...Array.from({ length: 8 }, (_, n) => explorerArtifact(n + 2))],
    });
    if (!page) return;
    const body = page.locator(".explorer-results-body");
    assert.equal(await body.evaluate((node) => node.scrollHeight > node.clientHeight), true);
    await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    assert.equal(await page.locator("#explorer-search").evaluate((node) => node.getBoundingClientRect().top >= 0), true);
    assert.equal(await page.locator("#explorer-jump-preview").isVisible(), false);
    await page.setViewportSize({ width: 320, height: 640 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await activate(page, "#explorer-jump-preview", "Enter");
    await focused(page, "#explorer-detail h2");
    assert.equal(await page.locator("#explorer-detail h2").textContent(), longTitle);
    await audit(t, page, `explorer/narrow-preview/${colorScheme}`);
  });
}

test("adapter repair exposes preserved values, match preview and keyboard cancellation", async (t) => {
  const page = await browserFixture(t, "options", "adapter-repair");
  if (!page) return;
  const open = page.locator("#repair-adapters");
  await open.click();
  const original = page.locator("#adapter-repair-original");
  await original.waitFor();
  assert.equal(await original.getAttribute("readonly"), "");
  assert.match(await original.inputValue(), /future_mode/);
  const replacement = JSON.stringify({ format: 1, artifacts: [{
    type: "work.item", origin: "https://work.example", match: [{ path: "/items/{id:int}" }], id: "work.item:{host}/{id}",
  }] });
  await page.locator("#adapter-repair-json").fill(replacement);
  await page.locator("#adapter-repair-url").fill("https://work.example/items/42");
  await page.locator("#adapter-repair-preview").getByText(/Example:.*work.item:work.example\/42/).waitFor();
  assert.equal(await page.locator("#adapter-repair-save").isEnabled(), true);
  await audit(t, page, "options/adapter-repair");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#adapter-repair").isVisible(), false);
  assert.equal(await open.evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.locator("#adapter-repair-json").fill(replacement);
  await page.locator("#adapter-repair-save").click();
  await page.locator("#status").filter({ hasText: /Adapter document replaced/ }).waitFor();
  assert.equal(await page.locator("#adapter-repair").isVisible(), false);
  assert.equal(await page.locator("#new-adapter").evaluate((node) => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.fixture.config.capture_enabled), true);
  assert.equal(await page.evaluate(() => window.fixture.requests.filter(({ type }) => type === "replace_adapters").length), 1);
  await audit(t, page, "options/adapter-repaired");
});

test("Tasks listbox keeps named groups and valid children through filtering", async (t) => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const page = await browserFixture(t, "tasks", "configured", { runs: [
    task(1, "running"),
    { ...task(2), created_at: today.toISOString() },
    { ...task(3), created_at: yesterday.toISOString() },
  ] });
  if (!page) return;
  const list = page.getByRole("listbox", { name: "Tasks", exact: true });
  for (const name of ["Running", "Today", "Yesterday"]) {
    assert.equal(await list.getByRole("group", { name, exact: true }).getByRole("option").count(), 1);
  }
  assert.equal(await list.getByRole("heading").count(), 0, "group labels must not add heading children to the listbox");
  const grouped = await audit(t, page, "tasks/named-groups");
  assert.ok(grouped.passes.some(({ id, nodes }) => id === "aria-required-children" && nodes.some(({ target }) => target.includes("#tasks-list"))), "the populated listbox's child roles must be checked and pass");
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("no matching task");
  await page.getByText("No tasks match.", { exact: true }).waitFor();
  assert.equal(await list.isVisible(), false, "an empty listbox must not be exposed");
  assert.equal(await page.locator("#tasks-detail").isVisible(), true);
  assert.equal(await list.getByRole("option").count(), 0);
  await audit(t, page, "tasks/filtered-empty");
  await page.getByRole("searchbox", { name: "Search tasks" }).fill("");
  assert.equal(await list.isVisible(), true);
  assert.equal(await list.getByRole("option").count(), 3);
  await audit(t, page, "tasks/filter-cleared");
});

for (const state of ["disconnected", "error"]) {
  test(`Tasks ${state} warning stays readable when the theme changes`, async (t) => {
    const page = await browserFixture(t, "tasks", state);
    if (!page) return;
    for (const colorScheme of ["light", "dark", "light"]) {
      await page.emulateMedia({ colorScheme });
      // An implicit browser canvas is transparent to contrast checkers. The
      // product must paint an opaque, theme-aware background for its text.
      const background = await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);
      assert.match(background, /^rgb\(/, `expected an opaque ${colorScheme} canvas, got ${background}`);
      const results = await audit(t, page, `tasks/${state}/theme-change/${colorScheme}`);
      assert.ok(results.passes.some(({ id, nodes }) => id === "color-contrast" && nodes.some(({ target }) => target.includes("#tasks-status"))), "the warning's contrast must be measured and pass");
    }
  });
}

for (const colorScheme of ["light", "dark"]) {
  test(`panel ${colorScheme}: the redesigned header and page card have measured, passing contrast`, async (t) => {
    const page = await browserFixture(t, "panel", "configured", { colorScheme });
    if (!page) return;
    // The design's raised and inset surfaces stay solid behind text, so axe measures
    // every pair instead of leaving it for manual review.
    const background = await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);
    assert.match(background, /^rgb\(/, `expected an opaque ${colorScheme} canvas, got ${background}`);
    const results = await audit(t, page, `panel/redesign/${colorScheme}`);
    assert.deepEqual(results.incomplete.filter(({ id }) => id === "color-contrast").flatMap(({ nodes }) => nodes.map(({ target }) => target)), [],
      "no panel text may sit on a surface axe cannot measure");
    const measured = results.passes.find(({ id }) => id === "color-contrast")?.nodes.map(({ target }) => String(target)) ?? [];
    for (const selector of ["#capture-pill-label", "#page-title", "#page-url", ".brand-mark"]) {
      assert.ok(measured.some((target) => target.includes(selector)), `${selector} contrast must be measured and pass`);
    }
    // Run is an icon-only button, which axe's text check skips: its arrow
    // (drawn in currentColor) needs 3:1 against the button (WCAG 1.4.11).
    const ratio = await page.locator("#task-run").evaluate((button) => {
      const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = (value) => {
        const [r, g, b] = rgb(value).map((channel) => {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const style = getComputedStyle(button);
      if (!/^rgb\(/.test(style.backgroundColor)) return 0;
      const [a, b] = [luminance(style.color), luminance(style.backgroundColor)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    assert.ok(ratio >= 3, `the Run arrow's contrast is ${ratio.toFixed(2)}:1, below 3:1`);
  });
}

async function shellPositions(page) {
  return page.evaluate(() => Object.fromEntries([".panel-header", ".panel-tabs", ".composer-dock"].map((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return [selector, { y: rect.y, height: rect.height }];
  })));
}

function assertStableShell(before, after) {
  for (const selector of Object.keys(before)) {
    for (const dimension of ["y", "height"]) {
      assert.ok(Math.abs(before[selector][dimension] - after[selector][dimension]) <= 1,
        `${selector} ${dimension} shifted: ${JSON.stringify({ before, after })}`);
    }
  }
}

async function assertFitsViewport(page, popover = null) {
  const layout = await page.evaluate((id) => {
    const rect = id ? document.getElementById(id).getBoundingClientRect() : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      popover: rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    };
  }, popover);
  assert.ok(layout.width <= layout.viewport.width, `horizontal overflow: ${JSON.stringify(layout)}`);
  if (layout.popover) {
    assert.ok(layout.popover.left >= 0 && layout.popover.right <= layout.viewport.width &&
      layout.popover.top >= 0 && layout.popover.bottom <= layout.viewport.height,
    `popover exceeds the viewport: ${JSON.stringify(layout)}`);
  }
}

for (const viewport of [{ width: 320, height: 640 }, { width: 420, height: 800 }]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`sidebar zones stay fixed at ${viewport.width}×${viewport.height}, ${colorScheme}`, async (t) => {
      const page = await browserFixture(t, "panel", "configured", { colorScheme, viewport });
      if (!page) return;
      await page.locator("#task-run:enabled").waitFor();
      const [form, options, tasks, activity] = await Promise.all(
        ["#task-form", "#task-options-open", "#task-open", "#activity-open"].map((selector) => page.locator(selector).boundingBox()),
      );
      assert.ok(form && options && tasks && activity);
      assert.ok(Math.abs(options.y - tasks.y) <= 1 && Math.abs(tasks.y - activity.y) <= 1, "footer buttons share one row");
      assert.ok(options.x + options.width <= tasks.x && tasks.x + tasks.width <= activity.x, "Tasks sits between Options and Activity");
      const gap = tasks.y - (form.y + form.height);
      assert.ok(gap >= 0 && gap <= 10, `unexpected gap below the composer: ${gap}px`);
      const before = await shellPositions(page);
      assert.equal(await page.locator("#task-options").isVisible(), false);
      assert.equal(await page.locator("#panel-activity").isVisible(), false);
      await assertFitsViewport(page);
      await page.evaluate(() => {
        fixture.tab.title = "A long corporate knowledge page title with a deliberately unbroken identifier " + "x".repeat(160);
        chrome.tabs.onUpdated.fire(fixture.tab.id, { title: fixture.tab.title }, fixture.tab);
      });
      await page.locator("#page-title").filter({ hasText: "unbroken identifier" }).waitFor();
      assertStableShell(before, await shellPositions(page));
      await page.evaluate(() => {
        const now = new Date().toISOString();
        const run = document.createElement("div");
        run.className = "run-card";
        run.dataset.state = "running";
        for (const [className, text] of [
          ["run-card-title", "Layout check"], ["run-card-state", "Running"],
          ["run-card-stream", "A long retained output line\n".repeat(200)],
        ]) {
          const line = document.createElement(className === "run-card-stream" ? "pre" : "p");
          line.className = className;
          line.textContent = text;
          if (className === "run-card-stream") {
            line.tabIndex = 0;
            line.setAttribute("role", "region");
            line.setAttribute("aria-label", "Agent output");
          }
          run.append(line);
        }
        document.querySelector("#run-area").append(run);
        fixture.recentItems = [{
          artifact_id: "confluence:report", artifact_type: "confluence.page",
          title: "A knowledge page with enough detail in its title to wrap across two lines on a narrow sidebar",
          url: "https://knowledge.example/pages/42", local_date: now.slice(0, 10),
          focused_seconds: 720, background_seconds: 0, opens: 3,
          why: "Preparing a review with a long reference " + "r".repeat(120),
          summary: {
            summarized_at: now, document_type: "report", category: "Release planning",
            importance: "high", summary_path: "summaries/report.md", harness: "codex",
            overview: "A concise overview of the decisions and work still needed.", read_scope: "page_only",
          },
        }];
      });
      await page.locator("#summary-activity-label").filter({ hasText: "Layout check" }).waitFor({ state: "attached" });
      assertStableShell(before, await shellPositions(page));
      await enterPanelTab(page, "tab-recent");
      const recent = page.locator("#recent-list .recent-row");
      await recent.getByText("High importance", { exact: true }).waitFor();
      await recent.getByText("Agent read: browser page only", { exact: true }).waitFor();
      assert.equal(await recent.getByText("Release planning", { exact: true }).isVisible(), true);
      assert.equal(await recent.getByRole("button", { name: /^Open summary:/ }).isVisible(), true);
      assert.equal(await page.locator("#page-area").isVisible(), false);
      assert.equal(await page.locator("#task-open").isVisible(), true, "Tasks stays available on Recent");
      assertStableShell(before, await shellPositions(page));
      await assertFitsViewport(page);
      await audit(t, page, `panel/recent-metadata/${viewport.width}/${colorScheme}`);
      await enterPanelTab(page, "tab-page");
      await activate(page, "#task-options-open");
      assert.equal(await page.locator("#task-options").isVisible(), true);
      await assertFitsViewport(page, "task-options");
      assertStableShell(before, await shellPositions(page));
      await audit(t, page, `panel/options/${viewport.width}/${colorScheme}`);
      await page.keyboard.press("Escape");
      await focused(page, "#task-options-open");
      assert.equal(await page.locator("#task-options").isVisible(), false);
      await activate(page, "#activity-open");
      await activate(page, "#summary-activity-label");
      await assertFitsViewport(page, "panel-activity");
      assertStableShell(before, await shellPositions(page));
      await audit(t, page, `panel/activity/${viewport.width}/${colorScheme}`);
      // Clicking the page outside a native auto popover light-dismisses it.
      await page.locator("#tab-page").click();
      assert.equal(await page.locator("#panel-activity").isVisible(), false);
      assertStableShell(before, await shellPositions(page));
    });
  }
}

test("the narrow footer shows the Activity warning beside a running task count", async (t) => {
  const page = await browserFixture(t, "panel", "configured", {
    viewport: { width: 320, height: 640 },
    runs: [task(1, "running")],
    workerStatus: { overflow_count: 1 },
  });
  if (!page) return;
  const taskButton = page.getByRole("button", { name: "Tasks · 1 running ↗", exact: true });
  await taskButton.waitFor();
  assert.equal(await taskButton.getAttribute("title"), "Tasks · 1 running ↗");
  assert.equal((await taskButton.locator("#task-open-state").boundingBox()).width, 1);
  const activity = page.locator('#activity-open[data-tone="warning"]');
  await activity.waitFor();
  const { clientWidth, scrollWidth } = await activity.evaluate((button) => ({
    clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
  }));
  assert.ok(scrollWidth <= clientWidth, `the Activity warning needs ${scrollWidth}px and has ${clientWidth}px`);
  await assertFitsViewport(page);
});

test("a seeded serious violation fails the same gate used for every state", async (t) => {
  const page = await browserFixture(t, "panel");
  if (!page) return;
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "seeded-unlabelled-button";
    document.querySelector("main").append(button);
  });
  const results = await new AxeBuilder({ page }).analyze();
  assert.ok(results.violations.some(({ id, nodes }) => id === "button-name" && nodes.some(({ target }) => target.includes("#seeded-unlabelled-button"))));
  assert.throws(() => assertAccessible(results));
});
