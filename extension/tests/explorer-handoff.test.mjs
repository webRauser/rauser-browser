import assert from "node:assert/strict";
import test from "node:test";
const { openExplorerPage } = await import("../dist/explorer-handoff.js");

function chromeFor(contexts = [], closed = false) {
  const calls = { created: [], updated: [], windows: [] };
  return { calls, runtime: { getURL: (path) => `chrome-extension://test/${path}`, getContexts: async () => contexts },
    tabs: { async create(value) { calls.created.push(value); }, async update(id, value) { if (closed) throw new Error("Closed"); calls.updated.push({ id, ...value }); } },
    windows: { async update(id, value) { calls.windows.push({ id, ...value }); } } };
}
test("Explorer opens in the main browser area as an extension tab", async () => {
  const chrome = chromeFor(); await openExplorerPage(chrome);
  assert.deepEqual(chrome.calls.created, [{ url: "chrome-extension://test/explorer.html" }]);
});
test("Explorer reuses its existing tab and preserves its current view", async () => {
  const chrome = chromeFor([{ documentUrl: "chrome-extension://test/explorer.html#existing", tabId: 7, windowId: 3 }]);
  await openExplorerPage(chrome);
  assert.deepEqual(chrome.calls.updated, [{ id: 7, active: true }]);
  assert.deepEqual(chrome.calls.windows, [{ id: 3, focused: true }]);
  assert.equal(chrome.calls.created.length, 0);
});
test("Explorer refuses prefix lookalikes and recovers an existing tab that closed", async () => {
  const wrong = chromeFor([{ documentUrl: "chrome-extension://test/explorer.html-other", tabId: 7, windowId: 3 }]);
  await openExplorerPage(wrong); assert.equal(wrong.calls.created.length, 1);
  const closed = chromeFor([{ documentUrl: "chrome-extension://test/explorer.html", tabId: 7, windowId: 3 }], true);
  await openExplorerPage(closed); assert.equal(closed.calls.created.length, 1);
});
