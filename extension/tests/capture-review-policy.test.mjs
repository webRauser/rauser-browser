import assert from "node:assert/strict";
import test from "node:test";
const { CAPTURE_REVIEW_POLICY_KEY, CaptureReviewPolicy } = await import("../dist/capture-review-policy.js");
const ID = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000777";
const OTHER = "00000000-0000-4000-8000-000000000999";
function run(state = "running", extra = {}) {
  return { run_id: ID, start_request_id: REQUEST, kind: "site_draft", capture_review: true, state, ...extra };
}
function setup(entries = new Map()) {
  const state = { now: 1_000_000, lists: 0, gets: 0, publications: 0, schedules: [], runs: [], complete: true, failure: null };
  const deps = {
    storage: {
      async get(key) { return entries.has(key) ? { [key]: structuredClone(entries.get(key)) } : {}; },
      async set(values) { for (const [key, value] of Object.entries(values)) entries.set(key, structuredClone(value)); },
    },
    now: () => state.now,
    async list() { state.lists++; return { runs: state.runs, complete: state.complete }; },
    async get(id) { state.gets++; return state.runs.find((item) => item.run_id === id) ?? null; },
    async refreshPolicy() { state.publications++; if (state.failure) throw state.failure; },
    async schedule(needed) { state.schedules.push(needed); },
  };
  return { state, entries, deps, monitor: new CaptureReviewPolicy(deps) };
}

test("pre-start arming persists correlation without host I/O; worker restart refreshes a fast completed review", async () => {
  const { state, entries, deps, monitor } = setup();
  await monitor.arm(REQUEST);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches[0].request_id, REQUEST);
  assert.equal(state.lists, 0);
  assert.equal(state.publications, 0);
  const resumed = new CaptureReviewPolicy(deps);
  await resumed.resume();
  assert.equal(state.schedules.at(-1), true);
  assert.equal(state.lists, 0, "resume alone does not wake a service");
  state.runs = [run("succeeded")];
  await resumed.poll();
  assert.equal(state.publications, 1);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 0);
  assert.equal(state.schedules.at(-1), false);
  await resumed.arm(REQUEST, ID);
  await resumed.poll();
  assert.equal(state.publications, 1, "rediscovering retained history does not repeat publication");
});

for (const outcome of ["failed", "canceled"]) {
  test(`a ${outcome} review leaves the current lease untouched`, async () => {
    const { state, entries, monitor } = setup();
    await monitor.arm(REQUEST);
    state.runs = [run(outcome)];
    await monitor.poll();
    assert.equal(state.publications, 0);
    assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 0);
  });
}

test("a known active review is watched by ID and refreshes only after successful completion", async () => {
  const { state, monitor } = setup();
  await monitor.arm(REQUEST, ID);
  state.runs = [run()];
  await monitor.poll();
  assert.equal(state.lists, 0);
  assert.equal(state.gets, 1);
  assert.equal(state.publications, 0);
  state.runs = [run("succeeded")];
  await monitor.poll();
  assert.equal(state.publications, 1);
});

test("a failed policy refresh keeps the durable watch for the next alarm", async () => {
  const { state, entries, monitor } = setup();
  await monitor.arm(REQUEST, ID);
  state.runs = [run("succeeded")];
  state.failure = new Error("Fixture host unavailable");
  await assert.rejects(monitor.poll(), /Fixture/);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 1);
  state.failure = null;
  await monitor.poll();
  assert.equal(state.publications, 2);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 0);
});

test("unrelated runs, incomplete history and a mismatched known response never publish policy", async () => {
  const { state, entries, monitor } = setup();
  await monitor.arm(REQUEST);
  state.runs = [run("succeeded", { start_request_id: OTHER })];
  await monitor.poll();
  assert.equal(state.publications, 0);
  state.complete = false;
  await assert.rejects(monitor.poll(), /incomplete/);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 1);
  await monitor.arm(REQUEST, ID);
  await assert.rejects(monitor.poll(), /different/);
  assert.equal(state.publications, 0);
});

test("watch expiry stops service retries even while history is unavailable", async () => {
  const { state, entries, monitor } = setup();
  await monitor.arm(REQUEST);
  state.now += 25 * 60 * 60_000;
  state.complete = false;
  await monitor.poll();
  assert.equal(state.lists, 0);
  assert.equal(state.schedules.at(-1), false);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 0);
});


test("an explicit retry can rearm an original request whose earlier start never reached the service", async () => {
  const { state, entries, monitor } = setup();
  await monitor.arm(REQUEST);
  state.now += 3 * 60_000;
  await monitor.poll();
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 0);
  await monitor.arm(REQUEST);
  assert.equal(entries.get(CAPTURE_REVIEW_POLICY_KEY).watches.length, 1);
  state.runs = [run("succeeded")];
  await monitor.poll();
  assert.equal(state.publications, 1);
});
