import assert from "node:assert/strict";
import test from "node:test";
import { AxeBuilder } from "@axe-core/playwright";
import { activate, assertAccessible, audit, browserFixture, enterPanelTab, focused, task } from "./fixture.mjs";

for (const pageName of ["panel", "options", "tasks"]) {
  for (const state of ["setup", "configured", "disconnected", "error"]) {
    for (const colorScheme of ["light", "dark"]) {
      test(`${pageName}: ${state}, ${colorScheme}`, async (t) => {
        const page = await browserFixture(t, pageName, state, { colorScheme });
        if (page) await audit(t, page, `${pageName}/${state}/${colorScheme}`);
      });
    }
  }
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
      assert.equal(await page.locator("#task-context").isVisible(), true, "Recent keeps the task's active-page context visible");
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
