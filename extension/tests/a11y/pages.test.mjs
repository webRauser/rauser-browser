import assert from "node:assert/strict";
import test from "node:test";
import { AxeBuilder } from "@axe-core/playwright";
import { activate, assertAccessible, audit, browserFixture, explorerArtifact, task } from "./fixture.mjs";

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

test("Explorer binds saved-summary opening to the library being browsed", async (t) => {
  const page = await browserFixture(t, "explorer");
  if (!page) return;
  await page.evaluate(() => { fixture.revision = "2"; });
  await page.locator("#explorer-open-summary").click();
  await page.locator("#explorer-status").filter({ hasText: /changed|refresh/i }).waitFor();
  const request = await page.evaluate(() => fixture.requests.find((entry) => entry.type === "open_summary"));
  assert.equal(request.expected_revision, "1");
  assert.equal(await page.evaluate(() => fixture.actions.includes("summary-open")), false);
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
    // The design's glass surfaces stay solid behind text, so axe measures
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
