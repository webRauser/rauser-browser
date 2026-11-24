import { spawn } from "node:child_process";

export const JOINED_OUTBOUND_LINK_TEST = "joined outbound artifact links";
// The case has a 120s budget in worker.test.mjs. Allow time for startup and teardown.
const TIMEOUT_MS = 135_000;
const STOP_GRACE_MS = 5_000;

export async function runJoinedOutboundLinks({ cwd, host, chrome, testHome, signal }, {
  spawnChild = spawn,
  kill = process.kill,
} = {}) {
  signal.throwIfAborted();
  const child = spawnChild(process.execPath, [
    "--test", "--test-isolation=none", "--test-reporter=tap",
    `--test-name-pattern=^${JOINED_OUTBOUND_LINK_TEST}$`, "extension/tests/worker.test.mjs",
  ], {
    cwd,
    env: {
      ...process.env,
      HOME: testHome,
      TMPDIR: testHome,
      BRAUSER_OUTBOUND_LINK_HOST: host,
      CHROME_PATH: chrome,
      BRAUSER_REQUIRE_IPC_TESTS: "1",
      BRAUSER_REQUIRE_A11Y_TESTS: "1",
    },
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });

  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  let stopReason;
  let forceTimer;
  let forced = false;
  const { promise: closed, resolve, reject } = Promise.withResolvers();
  child.once("close", (code, childSignal) => resolve({ code, childSignal }));
  child.once("error", reject);

  function signalGroup(groupSignal) {
    if (!child.pid) return;
    try {
      kill(-child.pid, groupSignal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  function forceStop() {
    if (forced) return;
    signalGroup("SIGKILL");
    forced = true;
  }

  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    // Node runs the case in this process, so Playwright gets SIGTERM and
    // can shut down its separate Chrome group. If Node must be killed,
    // closing its DevTools pipe makes Chrome shut down as well.
    try {
      signalGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        try { forceStop(); } catch (error) { reject(error); }
      }, STOP_GRACE_MS);
    } catch (error) {
      reject(error);
    }
  }

  const interrupt = () => stop(signal.reason);
  const timer = setTimeout(() => stop(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  signal.addEventListener("abort", interrupt, { once: true });
  let passed = false;
  try {
    const { code, childSignal } = await closed;
    if (stopReason) throw stopReason;
    if (childSignal) throw new Error(`Node test terminated by ${childSignal}`);
    if (code !== 0) throw new Error(`Node test exited with code ${code}`);

    const lines = output.split(/\r?\n/u);
    const expected = `ok 1 - ${JOINED_OUTBOUND_LINK_TEST}`;
    if (lines.some((line) => line.startsWith(`${expected} # SKIP`))) {
      throw new Error("The selected case was skipped");
    }
    if (!lines.includes(expected) || !lines.includes("1..1")) {
      throw new Error("Expected one passing result for the selected case");
    }
    passed = true;
  } catch (error) {
    const report = output.trim();
    throw new Error(`${JOINED_OUTBOUND_LINK_TEST}: ${error.message}${report ? `\n${report}` : ""}`, { cause: error });
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    signal.removeEventListener("abort", interrupt);
    // A failed Node runner may have exited without waiting for its host children.
    if (!passed) forceStop();
  }
}
