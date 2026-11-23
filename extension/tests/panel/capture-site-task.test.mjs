// Durable Capture Site review tasks. The browser and host are synthetic;
// these tests do not launch an agent or navigate a real authenticated site.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG, JIRA_URL, READY, RUN_VIEW, SET_UP, WIKI_URL, captureReview, draftedSave, install,
  sampleRow, saveCapture, settle, starterOffersFor, until, updates,
} from "./harness.mjs";

const ORIGIN = new URL(JIRA_URL).origin;
const ID = "00000000-0000-4000-8000-000000000123";

test("site removal remains available while the persistent review is running", async () => {
  const run = reviewRun();
  const page = await captureReview(JIRA_URL, { intercept: reviewHost(run) });
  await saveCapture(page);
  await until(() => !page.el("capture-site-task-link").hidden && !page.el("remove-site").disabled,
    "the saved site's review and removal controls");
  assert.equal(page.el("remove-site").hidden, false);
  page.el("remove-site").click();
  assert.equal(page.el("remove-site-review").hidden, false);
  assert.equal(page.el("capture-site-task").hidden, true);
  page.el("remove-site-cancel").click();
  assert.equal(page.el("capture-site-task").hidden, false);
  page.el("remove-site").click();
  page.el("remove-site-confirm").click();
  await until(() => /^Removed /.test(page.el("status").textContent), "site removal during review");
  assert.deepEqual(page.state.config.adapters.artifacts, []);
  assert.equal(page.state.config.capture_enabled, false);
  assert.equal(page.el("remove-site").hidden, true);
  assert.equal(updates(page).length, 2);
  assert.equal(page.sent("start_site_draft").length, 1);
});

function reviewRun(origin = ORIGIN, overrides = {}) {
  return {
    ...RUN_VIEW, run_id: ID, kind: "site_draft", capture_review: true,
    url: origin, title: `Capture Site: ${new URL(origin).host}`,
    record_key: { kind: "url", value: origin },
    state: "running", created_at: new Date().toISOString(),
    ...overrides,
  };
}
function reviewHost(run, intercept = () => null) {
  return (request, state) => {
    const reply = intercept(request, state);
    if (reply) return reply;
    if (request.type === "start_site_draft") {
      run.start_request_id = request.request_id;
      return { type: "run_started", existing: false, run };
    }
    if (request.type === "list_runs" && request.kind === "site_draft") return { type: "runs_listed", runs: [run] };
    if (request.type === "get_run" && request.run_id === run.run_id) {
      return { type: "run_fetched", run, stream_text: "", next_offset: 0, more: false };
    }
    return null;
  };
}

for (const flow of ["starter", "draft", "restore"]) {
  test(`${flow} capture starts one persistent review after its initial save`, async () => {
    const url = flow === "draft" ? WIKI_URL : JIRA_URL;
    const origin = new URL(url).origin;
    const run = reviewRun(origin);
    const intercept = reviewHost(run, (request) => {
      if (flow === "restore" && request.type === "get_site_restore") return {
        type: "site_restore_loaded", origin, revision: request.expected_revision,
        adapters: { format: 1, artifacts: [{
          type: "custom.issue", origin, match: [{ path: "/browse/{key:jira_key}" }], id: "custom.issue:{host}/{key}",
        }] },
      };
      return null;
    });
    const page = flow === "draft" ? await draftedSave(url, { intercept }) : await captureReview(url, { intercept });
    assert.equal(page.sent("start_site_draft").length, 0);
    await saveCapture(page);
    await until(() => !page.el("capture-site-task-link").hidden, "the durable task link");
    assert.equal(updates(page).length, 1);
    const [start] = page.sent("start_site_draft");
    assert.equal(page.sent("start_site_draft").length, 1);
    assert.equal(start.review_url, url);
    assert.equal(start.revision, "2");
    assert.equal(start.origin, origin);
    const saveIndex = page.state.requests.findIndex((request) => request.type === "update_config");
    const startIndex = page.state.requests.findIndex((request) => request.type === "start_site_draft");
    assert.ok(saveIndex < startIndex);
    assert.equal(page.el("capture-site-task-status").textContent, "Site Capture in Progress");
    assert.equal(page.el("capture-site-review").hidden, true);
    assert.equal(page.el("capture-site").hidden, true);
    assert.equal(page.el("capture-site-task-link").href, `chrome-extension://test-id/tasks.html#run=${ID}`);
    page.el("capture-site-task-link").dispatch("click", { preventDefault() {} });
    await until(() => page.created.length === 1, "the task view");
    assert.equal(page.created[0].url, `chrome-extension://test-id/tasks.html#run=${ID}`);
    page.navigate("https://other.example/items/1", 2);
    await until(() => page.el("capture-site-task").hidden, "another site's task to hide");
    page.navigate(url, 1);
    await until(() => !page.el("capture-site-task").hidden, "the site's task to return");
    page.close();
    await settle(5);
    assert.equal(page.sent("cancel_run").length, 0);
  });
}

test("a failed review start remains visible and retries without saving initial rules again", async () => {
  let starts = 0;
  const run = reviewRun();
  const page = await captureReview(JIRA_URL, { intercept: reviewHost(run, (request) => {
    if (request.type === "start_site_draft" && ++starts === 1) return {
      type: "error", code: "service_unavailable", message: "Set up a harness in settings.",
    };
    return null;
  }) });
  await saveCapture(page);
  assert.equal(page.el("capture-site-area").hidden, false);
  assert.match(page.el("capture-site-task-status").textContent, /Capture saved.*could not start.*Set up a harness/);
  assert.equal(page.el("capture-site-task-retry").hidden, false);
  await until(() => !page.el("capture-site-task-retry").disabled, "retry after capture finishes refreshing");
  page.el("capture-site-task-retry").click();
  await until(() => !page.el("capture-site-task-link").hidden, "the retried task");
  assert.equal(starts, 2);
  assert.equal(updates(page).length, 1);
  assert.equal(page.el("capture-site-task-retry").hidden, true);
});

test("opening a new panel restores a running capture review without starting another", async () => {
  const run = reviewRun();
  const config = structuredClone(SET_UP);
  config.adapters.artifacts = [{
    type: "jira.issue", origin: ORIGIN, match: [{ path: "/browse/{key:jira_key}" }], id: "jira.issue:{host}/{key}",
  }];
  const page = await install({
    tab: { id: 1, url: JIRA_URL, title: "An issue" }, config, agentStatus: READY,
    intercept: reviewHost(run),
  });
  await until(() => !page.el("capture-site-task").hidden, "the restored capture review");
  assert.equal(page.el("capture-site-task-status").textContent, "Site Capture in Progress");
  assert.equal(page.sent("start_site_draft").length, 0);
  assert.ok(page.sent("list_runs").some((request) => request.kind === "site_draft"));
});

test("a capture review terminal result updates the compact status without exposing its report", async () => {
  const run = reviewRun(ORIGIN, {
    state: "failed", finished_at: new Date().toISOString(),
    task_report: '<img src="https://remote.example/pixel"> Browser unavailable.',
  });
  const page = await install({
    tab: { id: 1, url: JIRA_URL, title: "An issue" }, config: {
      ...CONFIG, agent: SET_UP.agent,
      adapters: { format: 1, artifacts: [{
        type: "jira.issue", origin: ORIGIN, match: [{ path: "/browse/{key:jira_key}" }], id: "jira.issue:{host}/{key}",
      }] },
    }, agentStatus: READY,
    intercept: reviewHost(run),
  });
  await until(() => !page.el("capture-site-task").hidden, "the restored failed review");
  assert.equal(page.el("capture-site-task-status").textContent, "Site Capture Needs Attention");
  assert.equal(page.el("capture-site-task-link").hidden, false);
  assert.doesNotMatch(page.el("capture-site-task-status").textContent, /remote\.example|Browser unavailable/);
});


test("a removed site's finished review does not hide Capture Site or claim capture is saved", async () => {
  const run = reviewRun(ORIGIN, { state: "succeeded", finished_at: new Date().toISOString() });
  const page = await install({
    tab: { id: 1, url: JIRA_URL, title: "An issue" }, config: SET_UP, agentStatus: READY,
    intercept: reviewHost(run),
  });
  await until(() => page.sent("list_runs").some((request) => request.kind === "site_draft"), "site history");
  await settle();
  assert.equal(page.el("capture-site-task").hidden, true);
  assert.equal(page.el("capture-site").hidden, false);
  assert.equal(page.el("capture-site").disabled, false);
});

test("a completed review leaves recurring-page capture available", async () => {
  const origin = new URL(WIKI_URL).origin;
  const run = reviewRun(origin, { state: "succeeded", finished_at: new Date().toISOString() });
  const page = await install({
    tab: { id: 1, url: `${origin}/notes/42`, title: "A note" },
    config: {
      ...SET_UP, capture_enabled: true,
      adapters: { format: 1, artifacts: [{
        type: "wiki.pages", origin, match: [{ path: "/pages/{n:int}" }], id: "wiki.pages:{host}/{n}",
      }] },
    },
    patterns: [sampleRow("/notes/{num}", 4)], agentStatus: READY,
    intercept: reviewHost(run),
  });
  await until(() => !page.el("capture-site-task").hidden, "the completed review");
  await until(() => !page.el("capture-site-recurring").hidden, "recurring-page capture after review");
  assert.equal(page.el("capture-site-task-status").textContent, "Site Capture Complete");
});

const { CAPTURE_REVIEW_INTENT_PREFIX } = await import("../../dist/capture-review-intent.js");
function pendingIntent(config, overrides = {}) {
  return {
    version: 1, requestId: "00000000-0000-4000-8000-000000000777", createdAt: Date.now(),
    origin: ORIGIN, url: JIRA_URL, visited: [], links: [],
    beforeRevision: "1", savedRevision: "2", expectedConfig: structuredClone(config),
    ...overrides,
  };
}
const intentsIn = (local) => [...local].filter(([key]) => key.startsWith(CAPTURE_REVIEW_INTENT_PREFIX));
const storedIntent = (intent) => new Map([[CAPTURE_REVIEW_INTENT_PREFIX + intent.requestId, intent]]);
function jiraConfig() {
  return {
    ...structuredClone(CONFIG), capture_enabled: true,
    adapters: { format: 1, artifacts: [{
      type: "jira.issue", origin: ORIGIN, match: [{ path: "/browse/{key:jira_key}" }], id: "jira.issue:{host}/{key}",
    }] },
  };
}

test("closing after the initial save recovers its retained launch intent without saving twice", async () => {
  const local = new Map();
  const page = await captureReview(JIRA_URL, { local, intercept(request, state) {
    if (request.type === "get_config" && state.revision === "2") return new Promise(() => {});
    return null;
  } });
  page.el("capture-site-save").click();
  await until(() => page.state.revision === "2" && page.sent("get_config").length >= 3, "the persisted save before review dispatch");
  assert.equal(intentsIn(local).length, 1, "the intent exists before update_config is sent");
  const intent = structuredClone(intentsIn(local)[0][1]);
  assert.equal(intent.savedRevision, undefined, "recovery must recognize a save whose receipt was interrupted");
  const config = structuredClone(page.state.config);
  page.close();
  await settle(10);
  assert.equal(page.sent("start_site_draft").length, 0);
  const run = reviewRun();
  const reopened = await install({
    tab: { id: 1, url: JIRA_URL, title: "The issue" }, local, config,
    intercept: reviewHost(run, (request, state) => {
      if (request.type === "get_config") state.revision = "2";
      return null;
    }),
  });
  await until(() => !reopened.el("capture-site-task").hidden && !reopened.el("capture-site-task-link").hidden,
    "the recovered capture review");
  assert.equal(reopened.sent("update_config").length, 0);
  assert.equal(reopened.sent("start_site_draft").length, 1);
  assert.equal(reopened.sent("start_site_draft")[0].request_id, intent.requestId);
  assert.equal(reopened.sent("start_site_draft")[0].revision, "2");
  assert.equal(intentsIn(local).length, 0);
});

test("a lost start reply reconciles a finished review before its changed config revision", async () => {
  const config = jiraConfig();
  const intent = pendingIntent(config);
  const local = storedIntent(intent);
  const run = reviewRun(ORIGIN, {
    start_request_id: intent.requestId, state: "succeeded", finished_at: new Date().toISOString(),
  });
  config.adapters.artifacts[0].title = "{title} · Improved";
  const page = await install({
    tab: { id: 1, url: JIRA_URL, title: "The issue" }, local, config,
    intercept: reviewHost(run, (request, state) => {
      if (request.type === "get_config") state.revision = "3";
      return null;
    }),
  });
  await until(() => !page.el("capture-site-task").hidden, "the reconciled completed review");
  assert.equal(page.el("capture-site-task-status").textContent, "Site Capture Complete");
  assert.equal(page.sent("start_site_draft").length, 0, "a completed review must never be launched again");
  assert.ok(page.state.workerRequests.some((r) => r.kind === "capture_review_watch" &&
    r.request_id === intent.requestId && r.run_id === run.run_id), "terminal recovery arms background publication");
  assert.equal(page.sent("update_config").length, 0);
  assert.equal(intentsIn(local).length, 0);
});

for (const reason of ["removed", "changed", "expired"]) {
  test(`a ${reason} saved capture request cannot launch against today's configuration`, async () => {
    const expected = jiraConfig();
    const intent = pendingIntent(expected, reason === "expired" ? { createdAt: Date.now() - 25 * 60 * 60_000 } : {});
    const local = storedIntent(intent);
    const config = reason === "removed" ? structuredClone(CONFIG) : structuredClone(expected);
    if (reason === "changed") config.capture_enabled = false;
    const page = await install({
      tab: { id: 1, url: JIRA_URL, title: "The issue" }, local, config,
      intercept(request, state) {
        if (request.type === "get_config") state.revision = reason === "expired" ? "2" : "3";
        return null;
      },
    });
    await until(() => !page.el("capture-site-task-discard").hidden, "the stale request attention state");
    assert.match(page.el("capture-site-task-status").textContent, /needs attention/);
    assert.doesNotMatch(page.el("capture-site-task-status").textContent, /Capture saved/);
    assert.equal(page.sent("start_site_draft").length, 0);
    assert.equal(page.sent("update_config").length, 0);
    if (reason === "removed") assert.equal(page.el("capture-site").hidden, true);
    page.el("capture-site-task-discard").click();
    await until(() => intentsIn(local).length === 0, "explicit stale-intent dismissal");
  });
}

test("a definitely refused initial save cannot leave an intent that duplicates a later successful capture", async () => {
  const local = new Map();
  const run = reviewRun();
  let saves = 0;
  let refusedId;
  const page = await captureReview(JIRA_URL, { local, intercept: reviewHost(run, (request) => {
    if (request.type === "update_config" && ++saves === 1) {
      refusedId = intentsIn(local)[0][1].requestId;
      return { type: "error", code: "conflict", message: "A concurrent capture check refused this save." };
    }
    return null;
  }) });
  page.el("capture-site-save").click();
  await until(() => /Could not capture site/.test(page.el("status").textContent), "the definite save refusal");
  await until(() => !page.el("capture-site-save").disabled, "the next explicit save");
  assert.equal(intentsIn(local).length, 0);
  await saveCapture(page);
  await until(() => !page.el("capture-site-task-link").hidden, "the one automatic review");
  assert.equal(page.sent("start_site_draft").length, 1);
  assert.notEqual(page.sent("start_site_draft")[0].request_id, refusedId);
  assert.equal(intentsIn(local).length, 0);
});

for (const outcome of ["stale", "launch-failed"]) {
  test(`an older completed review cannot hide a newer ${outcome} capture intent`, async () => {
    const config = jiraConfig();
    const intent = pendingIntent(config, outcome === "stale" ? { savedRevision: "outdated" } : {});
    const local = storedIntent(intent);
    const older = reviewRun(ORIGIN, {
      start_request_id: "00000000-0000-4000-8000-000000000555",
      state: "succeeded", finished_at: new Date().toISOString(),
    });
    const page = await install({
      tab: { id: 1, url: JIRA_URL, title: "The issue" }, config, local,
      intercept: reviewHost(older, (request, state) => {
        if (request.type === "get_config") state.revision = "2";
        if (request.type === "start_site_draft") return {
          type: "error", code: "service_unavailable", message: "Fixture review unavailable.",
        };
        return null;
      }),
    });
    await until(() => page.sent("list_runs").filter((request) => request.kind === "site_draft").length >= 2,
      "recovery followed by the ordinary capture history refresh");
    await settle(10);
    assert.match(page.el("capture-site-task-status").textContent,
      outcome === "stale" ? /needs attention/ : /could not start/);
    assert.equal(page.el("capture-site-task-link").hidden, true);
    assert.equal(intentsIn(local).length, 1);
  });
}


test("an interrupted pre-save intent must be dismissed before another capture can save or launch", async () => {
  const local = new Map();
  const run = reviewRun();
  const page = await captureReview(JIRA_URL, { local, intercept: reviewHost(run) });
  // Another panel can leave this after the current review has already
  // opened; the save-time check must protect this fast-click race too.
  const expected = {
    ...structuredClone(CONFIG), capture_enabled: true,
    adapters: { format: 1, artifacts: starterOffersFor(ORIGIN, []).map((offer) => offer.adapter) },
  };
  const old = pendingIntent(expected);
  delete old.savedRevision;
  local.set(CAPTURE_REVIEW_INTENT_PREFIX + old.requestId, old);
  page.el("capture-site-save").click();
  await until(() => /Dismiss this request, then capture/.test(page.el("capture-site-task-status").textContent),
    "the earlier interrupted request to be recovered");
  assert.equal(page.sent("update_config").length, 0);
  assert.equal(page.sent("start_site_draft").length, 0);
  assert.equal(page.el("capture-site").hidden, true);
  assert.equal(page.el("capture-site-review").hidden, true);
  assert.equal(intentsIn(local).length, 1);
  assert.equal(intentsIn(local)[0][1].requestId, old.requestId, "the blocked attempt does not replace or clean up the earlier request");
  page.el("capture-site-task-discard").click();
  await until(() => intentsIn(local).length === 0 && !page.el("capture-site").hidden, "the old request to be dismissed");
  page.el("capture-site").click();
  await until(() => !page.el("capture-site-save").disabled, "the fresh capture review");
  await saveCapture(page);
  await until(() => !page.el("capture-site-task-link").hidden, "the fresh capture's only review task");
  assert.equal(page.sent("update_config").length, 1);
  assert.equal(page.sent("start_site_draft").length, 1);
  assert.notEqual(page.sent("start_site_draft")[0].request_id, old.requestId);
  assert.deepEqual(updates(page)[0].config, expected, "even the same intended policy cannot revive the earlier request");
  assert.equal(intentsIn(local).length, 0);
});


test("capture awaits the worker's durable policy watch before dispatching the review", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const run = reviewRun();
  const page = await captureReview(JIRA_URL, {
    intercept: reviewHost(run),
    workerReply: (request) => request.kind === "capture_review_watch" ? held : undefined,
  });
  page.el("capture-site-save").click();
  await until(() => page.state.workerRequests.some((r) => r.kind === "capture_review_watch"), "the policy watch to arm");
  await settle(5);
  assert.equal(updates(page).length, 1);
  assert.equal(page.sent("start_site_draft").length, 0, "no native run can finish before its background watch exists");
  const watch = page.state.workerRequests.find((r) => r.kind === "capture_review_watch");
  assert.equal(watch.request_id, intentsIn(page.state.local)[0][1].requestId);
  release({ ok: true, value: true });
  await until(() => page.sent("start_site_draft").length === 1, "the watched native start");
  assert.equal(page.sent("start_site_draft")[0].request_id, watch.request_id);
  page.close();
  assert.equal(page.sent("cancel_run").length, 0);
});

test("a policy-watch persistence failure keeps the review retryable without starting an unwatched run", async () => {
  const page = await captureReview(JIRA_URL, {
    intercept: reviewHost(reviewRun()),
    workerReply: (request) => request.kind === "capture_review_watch"
      ? { ok: false, value: null, error: "Fixture policy monitoring unavailable." } : undefined,
  });
  await saveCapture(page);
  assert.equal(page.sent("start_site_draft").length, 0);
  assert.match(page.el("capture-site-task-status").textContent, /could not start.*monitoring unavailable/);
  assert.equal(intentsIn(page.state.local).length, 1);
});

test("background review publication reloads the open panel's host policy and installs its new revision", async () => {
  const run = reviewRun();
  const page = await captureReview(JIRA_URL, { intercept: reviewHost(run) });
  await saveCapture(page);
  await until(() => !page.el("capture-site-task-link").hidden, "the started review");
  const beforeReads = page.sent("get_config").length;
  page.state.revision = "3";
  page.state.config.adapters.artifacts[0].match.push({ path: "/reviewed/{key:jira_key}" });
  run.state = "succeeded";
  run.finished_at = new Date().toISOString();
  const { leaseFor } = await import("../../dist/settings.js");
  page.policyChanged(leaseFor(page.state.config, "3"));
  await until(() => page.state.workerRequests.some((request) => request.kind === "install_policy" && request.lease.revision === "3"),
    "the panel to reload the worker's newly published policy");
  assert.ok(page.sent("get_config").length > beforeReads);
  const installed = page.state.workerRequests.filter((request) => request.kind === "install_policy").at(-1).lease;
  assert.ok(installed.adapters.artifacts[0].match.some((rule) => rule.path === "/reviewed/{key:jira_key}"));
  assert.equal(page.sent("update_config").length, 1, "the panel never rewrites the host's published review result");
  assert.equal(page.sent("start_site_draft").length, 1);
});
