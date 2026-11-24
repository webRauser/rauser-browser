import assert from "node:assert/strict";
import test from "node:test";
import { install, until } from "./harness.mjs";

test("sidebar Explorer button opens a main-area tab without an agent or extra permission", async () => {
  const page = await install({});
  page.el("open-explorer").click();
  await until(() => page.created.length === 1, "the Explorer tab");
  assert.equal(page.created[0].url, "chrome-extension://test-id/explorer.html");
  assert.equal(page.calls("permissions.request"), 0);
  assert.equal(page.sent("start_run").length, 0);
});

test("sidebar Explorer button focuses the existing Explorer tab", async () => {
  const page = await install({ tasksContexts: [
    { documentUrl: "chrome-extension://test-id/explorer.html", tabId: 7, windowId: 3 },
  ] });
  page.el("open-explorer").click();
  await until(() => page.state.windowUpdates.length === 1, "the Explorer window");
  assert.deepEqual(page.created, []);
  assert.deepEqual(page.state.tabUpdates, [{ tabId: 7, active: true }]);
  assert.deepEqual(page.state.windowUpdates, [{ windowId: 3, focused: true }]);
});

for (const failure of ["getContexts", "create"]) {
  test(`sidebar Explorer launch reports ${failure} failure as a warning without starting work`, async () => {
    const page = await install({});
    const warnings = [];
    page.el("status").classList.toggle = (...args) => warnings.push(args);
    const target = failure === "getContexts" ? chrome.runtime : chrome.tabs;
    target[failure] = async () => { throw new Error("Browser refused the Explorer tab"); };
    page.el("open-explorer").click();
    await until(() => /Could not open Artifact Explorer/.test(page.el("status").textContent), "the Explorer launch warning");
    assert.ok(warnings.some(([name, enabled]) => name === "warning" && enabled === true));
    assert.deepEqual(page.created, []);
    assert.equal(page.calls("permissions.request"), 0);
    for (const type of ["start_run", "start_task", "start_auto_summary", "start_site_draft", "update_config"]) {
      assert.equal(page.sent(type).length, 0, type);
    }
  });
}
