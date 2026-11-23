// Built side-panel tests for removing a configured site without deleting history.
import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG, install, noteLoaded, settle, until, updates } from "./harness.mjs";

const ORIGIN = "https://work.example";
const URL = `${ORIGIN}/items/7`;
const item = (origin = ORIGIN, type = "work.item") => ({
  type, origin, match: [{ path: "/items/{id:int}" }], id: "work:{host}/{id}",
});

async function configured({ artifacts = [item()], captureEnabled = true, ...options } = {}) {
  const config = structuredClone(CONFIG);
  config.adapters.artifacts = artifacts;
  config.capture_enabled = captureEnabled;
  const page = await install({ tab: { id: 1, url: URL, title: "Item 7" }, config, ...options });
  await noteLoaded(page);
  await until(() => !page.el("remove-site").disabled, "site controls to settle");
  return page;
}

function review(page) {
  const remove = page.el("remove-site");
  assert.ok(remove, "configured sites offer Remove site in the panel");
  assert.equal(remove.hidden, false);
  assert.equal(remove.disabled, false);
  remove.click();
  assert.equal(page.el("remove-site-review").hidden, false);
}

test("configured sites offer an origin-specific removal review without writing", async () => {
  const page = await configured();
  review(page);
  assert.match(page.el("remove-site-heading").textContent, /work\.example/);
  assert.match(page.el("remove-site-description").textContent, /notes.*summaries.*history/i);
  assert.match(page.el("remove-site-description").textContent, /keep|remain/i);
  assert.equal(updates(page).length, 0);
  page.el("remove-site-cancel").click();
  assert.equal(page.el("remove-site-review").hidden, true);
  assert.equal(page.el("remove-site").focused, true);
  assert.equal(updates(page).length, 0);
});

for (const captureEnabled of [true, false]) {
  test(`removing a site removes all its rules, preserves other sites and ${captureEnabled ? "keeps capture on" : "keeps capture paused"}`, async () => {
    const other = item("https://other.example");
    const page = await configured({ artifacts: [item(), other, item(ORIGIN, "work.issue")], captureEnabled });
    review(page);
    page.el("remove-site-confirm").click();
    await until(() => /^Removed /.test(page.el("status").textContent), "site removal");
    await until(() => !page.el("note-body").disabled, "note identity reload");
    assert.equal(updates(page).length, 1);
    assert.equal(updates(page)[0].expected_revision, "1");
    assert.deepEqual(page.state.config.adapters.artifacts, [other]);
    assert.equal(page.state.config.capture_enabled, captureEnabled);
    assert.deepEqual(page.state.config.strip_params, CONFIG.strip_params);
    assert.equal(page.el("remove-site-review").hidden, true);
    assert.equal(page.el("remove-site").hidden, true);
    assert.equal(page.el("capture-site").hidden, false);
    assert.equal(page.calls("permissions.remove"), 0);
    const published = page.state.workerRequests.filter((request) => request.kind === "install_policy").at(-1);
    assert.deepEqual(published.lease.adapters.artifacts, [other]);
  });
}

test("removing the final site disables capture and flushes the note before changing identity", async () => {
  const page = await configured();
  page.el("note-body").value = "Keep this note";
  page.el("note-body").dispatch("input");
  review(page);
  page.el("remove-site-confirm").click();
  await until(() => /^Removed /.test(page.el("status").textContent), "last site removal");
  await until(() => !page.el("note-body").disabled, "note reload");
  assert.deepEqual(page.state.config.adapters.artifacts, []);
  assert.equal(page.state.config.capture_enabled, false);
  const requests = page.state.requests;
  const save = requests.findIndex((request) => request.type === "save_note");
  const update = requests.findIndex((request) => request.type === "update_config");
  assert.ok(save >= 0 && save < update);
  assert.equal(requests[save].body, "Keep this note");
  assert.ok(requests.slice(update + 1).some((request) => request.type === "load_note"));
  assert.equal(requests.some((request) => /delete|forget|rekey/.test(request.type)), false);
});

test("removal is available on an unmatched page of a configured site", async () => {
  const page = await configured({ tab: { id: 1, url: `${ORIGIN}/settings`, title: "Settings" } });
  review(page);
  page.el("remove-site-confirm").click();
  await until(() => /^Removed /.test(page.el("status").textContent), "unmatched page site removal");
  assert.deepEqual(page.state.config.adapters.artifacts, []);
});

test("navigation dismisses removal without writing", async () => {
  const page = await configured();
  review(page);
  page.navigate("https://other.example/items/8", 2);
  await until(() => page.el("remove-site-review").hidden, "navigation to close removal");
  page.el("remove-site-confirm").click();
  await settle();
  assert.equal(updates(page).length, 0);
});

test("a concurrent settings save refuses a stale removal review", async () => {
  const page = await configured();
  review(page);
  page.state.revision = "2";
  page.state.config.strip_params = ["tracking"];
  page.el("remove-site-confirm").click();
  await until(() => /Settings changed/.test(page.el("status").textContent), "stale removal refusal");
  assert.equal(updates(page).length, 0);
  assert.deepEqual(page.state.config.adapters.artifacts, [item()]);
  assert.deepEqual(page.state.config.strip_params, ["tracking"]);
});

test("removal rechecks the active page before Chrome delivers navigation", async () => {
  const page = await configured();
  review(page);
  page.state.tab.url = "https://other.example/items/8";
  page.el("remove-site-confirm").click();
  await until(() => /active page changed/i.test(page.el("status").textContent), "active-page removal refusal");
  assert.equal(updates(page).length, 0);
});

test("failed removal keeps the site configured and reports the host error", async () => {
  const page = await configured({ intercept(request) {
    if (request.type === "update_config") return { type: "error", code: "internal", message: "Disk unavailable" };
  } });
  review(page);
  page.el("remove-site-confirm").click();
  await until(() => /Could not remove site.*Disk unavailable/.test(page.el("status").textContent), "removal failure");
  assert.deepEqual(page.state.config.adapters.artifacts, [item()]);
});

test("committed removal with unverified status reports the saved state", async () => {
  const page = await configured({ intercept(request, state) {
    if (request.type === "get_config" && state.revision !== "1") {
      return { type: "error", code: "internal", message: "Cannot refresh" };
    }
  } });
  review(page);
  page.el("remove-site-confirm").click();
  await until(() => /Site removed, but/.test(page.el("status").textContent), "committed removal warning");
  assert.deepEqual(page.state.config.adapters.artifacts, []);
  assert.equal(updates(page).length, 1);
  assert.ok(page.state.workerRequests.some((request) => request.kind === "suspend_policy"));
});
