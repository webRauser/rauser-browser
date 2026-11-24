import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runJoinedOutboundLinks } from "../smoke-joined-outbound-links.mjs";

const PASS = "TAP version 13\nok 1 - joined outbound artifact links\n1..1\n";

function fixture(t) {
  const abort = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 1234, stdout: new PassThrough() });
  const spawnChild = t.mock.fn(() => child);
  const kill = t.mock.fn();
  const options = {
    cwd: "/fixtures/brauser checkout",
    host: "/fixtures/Scripted Host/brauser",
    chrome: "/fixtures/Chromium.app/Contents/MacOS/Chromium",
    testHome: "/fixtures/isolated home",
    signal: abort.signal,
  };
  const run = () => runJoinedOutboundLinks(options, { spawnChild, kill });
  const close = (output, code = 0, signal = null) => {
    child.stdout.end(output);
    child.emit("close", code, signal);
  };
  return { abort, child, spawnChild, kill, options, run, close };
}

test("runs just the joined case in the checkout with the validated executables and child-only environment", async (t) => {
  const { options, run, close, abort, spawnChild, kill } = fixture(t);
  const originalEnv = { ...process.env };
  const done = run();
  close(PASS);
  await done;
  assert.equal(spawnChild.mock.callCount(), 1);
  assert.deepEqual(spawnChild.mock.calls[0].arguments, [process.execPath, [
    "--test", "--test-isolation=none", "--test-reporter=tap",
    "--test-name-pattern=^joined outbound artifact links$", "extension/tests/worker.test.mjs",
  ], {
    cwd: options.cwd,
    env: {
      ...originalEnv,
      HOME: options.testHome,
      TMPDIR: options.testHome,
      BRAUSER_OUTBOUND_LINK_HOST: options.host,
      CHROME_PATH: options.chrome,
      BRAUSER_REQUIRE_IPC_TESTS: "1",
      BRAUSER_REQUIRE_A11Y_TESTS: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  }]);
  assert.deepEqual({ ...process.env }, originalEnv);
  abort.abort();
  assert.equal(kill.mock.callCount(), 0);
});

for (const [label, tap, expected] of [
  ["skipped", "ok 1 - joined outbound artifact links # SKIP blocked by sandbox\n1..1\n", /was skipped[\s\S]*blocked by sandbox/u],
  ["missing", "1..0\n# pass 0\n", /Expected one passing result/u],
  ["unrelated", "ok 1 - joined outbound artifact links extra\n1..1\n", /Expected one passing result/u],
  ["duplicate", "ok 1 - joined outbound artifact links\nok 2 - joined outbound artifact links\n1..2\n", /Expected one passing result/u],
]) {
  test(`rejects a ${label} result even when Node exits zero`, async (t) => {
    const { run, close } = fixture(t);
    const done = run();
    close(tap);
    await assert.rejects(done, expected);
  });
}

test("rejects a failing or signalled child even if it printed a pass", async (t) => {
  const failed = fixture(t);
  const failedDone = failed.run();
  failed.close(PASS, 1);
  await assert.rejects(failedDone, /Node test exited with code 1/u);
  assert.deepEqual(failed.kill.mock.calls.map(({ arguments: args }) => args), [[-1234, "SIGKILL"]]);

  const signalled = fixture(t);
  const signalledDone = signalled.run();
  signalled.close(PASS, null, "SIGKILL");
  await assert.rejects(signalledDone, /Node test terminated by SIGKILL/u);
  assert.deepEqual(signalled.kill.mock.calls.map(({ arguments: args }) => args), [[-1234, "SIGKILL"]]);
});

test("rejects a spawn failure without attempting to signal a missing process group", async (t) => {
  const { child, run, kill } = fixture(t);
  child.pid = undefined;
  const done = run();
  child.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(done, /spawn ENOENT/u);
  assert.equal(kill.mock.callCount(), 0);
});

test("a timeout sends TERM and then KILL only to the fixture group and waits for close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { run, close, kill } = fixture(t);
  let settled = false;
  const done = run().finally(() => { settled = true; });
  t.mock.timers.tick(135_000);
  assert.deepEqual(kill.mock.calls.map(({ arguments: args }) => args), [[-1234, "SIGTERM"]]);
  t.mock.timers.tick(5_000);
  assert.deepEqual(kill.mock.calls.map(({ arguments: args }) => args), [[-1234, "SIGTERM"], [-1234, "SIGKILL"]]);
  await Promise.resolve();
  assert.equal(settled, false);
  close("", null, "SIGKILL");
  await assert.rejects(done, /Timed out after 135s/u);
  assert.equal(kill.mock.callCount(), 2);
});

test("an interruption cancels the fixture and clears both timers after child close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { abort, run, close, kill } = fixture(t);
  const done = run();
  abort.abort(new Error("Smoke run interrupted"));
  close(PASS);
  await assert.rejects(done, /Smoke run interrupted/u);
  t.mock.timers.tick(140_000);
  assert.deepEqual(kill.mock.calls.map(({ arguments: args }) => args), [[-1234, "SIGTERM"], [-1234, "SIGKILL"]]);
});

test("an already interrupted smoke starts no fixture", async (t) => {
  const { abort, run, spawnChild } = fixture(t);
  abort.abort(new Error("Smoke run interrupted"));
  await assert.rejects(run(), /Smoke run interrupted/u);
  assert.equal(spawnChild.mock.callCount(), 0);
});
