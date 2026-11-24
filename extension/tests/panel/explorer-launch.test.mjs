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
