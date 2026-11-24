// Built side-panel tests: artifact card. Run after build:extension;
// the fake DOM, Chrome, host and shared helpers are in ./harness.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURING, artifact, install, isResponseShape, recognized, until,
} from "./harness.mjs";

test("a transient lookup failure keeps only the current page's activity", async () => {
  let failing = false;
  const page = await install({
    tab: { id: 1, url: "https://docs.example/a", title: "A" },
    config: CAPTURING,
    intercept: (request) => request.type === "get_artifact"
      ? failing ? { type: "error", code: "internal", message: "index busy" } : recognized(artifact("doc:a", "Doc A"))
      : undefined,
  });
  await until(() => page.el("artifact-measures-short").textContent === "1m focused · 1 open", "recorded activity");
  failing = true;
  page.titleChanged("A updated");
  await until(() => /unavailable: index busy/.test(page.el("artifact-status").textContent), "lookup error");
  assert.equal(page.el("artifact-measures-short").textContent, "1m focused · 1 open");
  page.followLink("https://docs.example/b", "B");
  await until(() => page.el("page-title").textContent === "B", "the second page");
  assert.equal(page.el("artifact-card").hidden, true);
  assert.equal(page.el("artifact-measures-short").textContent, "");
});

// --- Artifact card: container and contents -----------------------------------

const INCOMING_SOURCE = {
  artifact_id: "doc:source", artifact_type: "doc", title: "<img src=x onerror=alert(1)> Source",
  url: "http://localhost:8123/docs/source",
};
const INCOMING_TRAIL = { source: INCOMING_SOURCE, transition: "link", last_seen: "2026-10-27" };

test("incoming trail response shapes bound the list and reject unsafe links and unknown transitions", () => {
  const valid = artifact("doc:target", "Target");
  const result = (trails) => isResponseShape(recognized({ ...valid, incoming_trails: trails }));
  assert.equal(result([INCOMING_TRAIL]), true);
  assert.equal(result(Array(5).fill(INCOMING_TRAIL)), true);
  assert.equal(result(Array(6).fill(INCOMING_TRAIL)), false);
  const { incoming_trails: _trails, ...missing } = valid;
  assert.equal(isResponseShape(recognized(missing)), false);
  for (const transition of ["mentions", "co-focused", "within", "forward_back", "invented"]) {
    assert.equal(result([{ ...INCOMING_TRAIL, transition }]), false, transition);
  }
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///tmp/note", "/relative", "not a URL"]) {
    assert.equal(result([{ ...INCOMING_TRAIL, source: { ...INCOMING_SOURCE, url } }]), false, url);
  }
  assert.equal(result([{ ...INCOMING_TRAIL, source: null }]), false);
  assert.equal(result([{ ...INCOMING_TRAIL, last_seen: "<script>" }]), false);
});

test("incoming source links open the local source fixture and clear when the page changes", async () => {
  const target = { ...artifact("doc:target", "Target"), incoming_trails: [INCOMING_TRAIL,
    { ...INCOMING_TRAIL, transition: "form_submit" }] };
  const page = await install({
    tab: { id: 1, url: "http://localhost:8123/docs/target", title: "Target" },
    config: CAPTURING,
    intercept: (request) => request.type === "get_artifact"
      ? recognized(request.url === INCOMING_SOURCE.url ? artifact("doc:source", "Source") : target)
      : undefined,
  });
  await until(() => page.el("artifact-card").hidden === false, "the target card");
  const rows = page.el("artifact-incoming-list").children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].textContent, `Link navigation from ${INCOMING_SOURCE.title} · last recorded 2026-10-27`);
  assert.equal(rows[1].textContent, `Form submission navigation from ${INCOMING_SOURCE.title} · last recorded 2026-10-27`);
  assert.equal(page.el("artifact-incoming-empty").hidden, true);
  const link = rows[0].querySelector("a");
  assert.equal(link.href, INCOMING_SOURCE.url);
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  // The fake DOM has no default anchor action. Follow its explicit URL as
  // Chrome does when the newly opened source tab becomes active.
  page.navigate(link.href, 2);
  await until(() => page.el("artifact-identity").textContent === "doc · doc:source", "the source fixture card");
  assert.equal(page.el("artifact-incoming-list").children.length, 0);
  assert.equal(page.el("artifact-incoming-list").hidden, true);
  assert.equal(page.el("artifact-incoming-empty").hidden, false);
  assert.equal(page.calls("permissions.request"), 0);
  page.navigate("chrome://extensions", 3);
  await until(() => page.el("artifact-card").hidden, "no card on a Chrome page");
  assert.equal(page.el("artifact-incoming-list").children.length, 0);
});

const REPO = {
  artifact_id: "github.repo:github.com/acme-corp/widgets",
  artifact_type: "github.repo",
  title: "acme-corp/widgets",
  url: "https://github.com/acme-corp/widgets",
};

test("artifact card links a PR to its repository", async () => {
  const pr = { ...artifact("github.pr:github.com/acme-corp/widgets/7", "Fix the thing"), within: REPO };
  const page = await install({
    tab: { id: 1, url: "https://github.com/acme-corp/widgets/pull/7", title: "Fix the thing" },
    config: CAPTURING,
    intercept: (request) => request.type === "get_artifact" ? recognized(pr) : undefined,
  });
  await until(() => page.el("artifact-card").hidden === false, "the artifact card");
  assert.equal(page.el("artifact-within").hidden, false);
  assert.equal(page.el("artifact-within").textContent, "In acme-corp/widgets");
  const link = page.el("artifact-within").querySelector("a");
  assert.equal(link.href, REPO.url);
});

test("repository card lists contained work", async () => {
  const pr = { artifact_id: "github.pr:github.com/acme-corp/widgets/7", artifact_type: "github.pr",
    title: "Fix the thing", url: "https://github.com/acme-corp/widgets/pull/7", focused_seconds: 125 };
  const issue = { artifact_id: "github.issue:github.com/acme-corp/widgets/3", artifact_type: "github.issue",
    title: "Flaky test", url: "https://github.com/acme-corp/widgets/issues/3", focused_seconds: 40 };
  const repo = { ...artifact("github.repo:github.com/acme-corp/widgets", "acme-corp/widgets"), contained: [pr, issue] };
  const page = await install({
    tab: { id: 1, url: REPO.url, title: "acme-corp/widgets" },
    config: CAPTURING,
    intercept: (request) => request.type === "get_artifact" ? recognized(repo) : undefined,
  });
  await until(() => page.el("artifact-card").hidden === false, "the artifact card");
  assert.equal(page.el("artifact-contained").hidden, false);
  assert.equal(page.el("artifact-contained-heading").textContent, "Worked on inside");
  const rows = page.el("artifact-contained-list").children;
  assert.equal(rows.length, 2, "one row per contained artifact");
  const firstLink = rows[0].querySelector("a");
  assert.equal(firstLink.textContent, "Fix the thing · 2 min");
  assert.equal(firstLink.href, pr.url);
  const secondLink = rows[1].querySelector("a");
  assert.equal(secondLink.textContent, "Flaky test · 40 sec");
  assert.equal(secondLink.href, issue.url);
});

test("card hides container rows when absent", async () => {
  const page = await install({
    tab: { id: 1, url: "https://docs.example/a", title: "A" },
    config: CAPTURING,
    intercept: (request) => request.type === "get_artifact" ? recognized(artifact("doc:a", "Doc A")) : undefined,
  });
  await until(() => page.el("artifact-card").hidden === false, "the artifact card");
  assert.equal(page.el("artifact-within").hidden, true);
  assert.equal(page.el("artifact-within").textContent, "");
  assert.equal(page.el("artifact-contained").hidden, true);
  assert.equal(page.el("artifact-contained-list").children.length, 0);
});
