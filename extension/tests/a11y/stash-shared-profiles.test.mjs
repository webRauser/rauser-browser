// Required by the Linux Accessibility job with the compiled extension and a
// scripted native host. Two disposable Chrome profiles keep separate ports.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { chromePath, launchOptions } from "../../../scripts/a11y-browser.mjs";
import { PROTOCOL_VERSION } from "../../dist/native.js";
import { installChrome, ORIGIN, routeFixturePages } from "./fixture.mjs";

const URL = "https://example.test/articles/shared-reading";
const TITLE = "Shared reading fixture";
const HOST = path.resolve("target/stash-browser/debug/brauser");
const MAX_FRAME = 1024 * 1024;
const LITTLE_ENDIAN = endianness() === "LE";
const REQUESTS = new Set(["hello", "get_config", "stash_page", "list_stash", "set_stash_reading"]);
const runFile = promisify(execFile);

async function startHost(dir, home, settings, cleanup) {
  await mkdir(dir, { mode: 0o700 });
  const config = path.join(dir, "config.toml");
  await writeFile(config, settings, { mode: 0o600 });
  // A clean environment and a confirmed scripted config keep every native
  // action in the fixture. No harness, platform opener or service is needed.
  const options = { cwd: dir, env: { HOME: dir, CFFIXED_USER_HOME: dir, BRAUSER_TEST_CONFIG_PATH: config } };
  const inspect = async (argument) =>
    (await runFile(HOST, [argument], { ...options, timeout: 10_000 })).stdout.trim();
  assert.match(await inspect("--version"), / \(scripted dialogs\)$/u);
  assert.equal(await inspect("--config-path"), config);

  const child = spawn(HOST, ["serve"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  // Also observe early spawn failure before the cleanup hook awaits it.
  void closed.catch(() => {});
  child.stdin.on("error", () => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  cleanup.push(async () => {
    child.stdin.end();
    const kill = setTimeout(() => child.kill("SIGKILL"), 4_000);
    try {
      assert.deepEqual(await closed, [0, null], stderr || "Scripted native host did not exit cleanly");
    } finally {
      clearTimeout(kill);
    }
  });

  const frames = child.stdout[Symbol.asyncIterator]();
  let unread = Buffer.alloc(0);
  async function take(length) {
    while (unread.length < length) {
      const chunk = await frames.next();
      assert.equal(chunk.done, false, stderr || "Scripted native host ended before its reply");
      unread = Buffer.concat([unread, chunk.value]);
    }
    const bytes = unread.subarray(0, length);
    unread = unread.subarray(length);
    return bytes;
  }

  const mutations = [];
  // A profile can issue several list and write requests during a redraw.
  // Serialize them through its one real native pipe.
  let pending = Promise.resolve();
  function request(message) {
    const result = pending.then(async () => {
      assert.ok(REQUESTS.has(message.type), `Unexpected Stash fixture request ${message.type}`);
      if (message.type === "stash_page") assert.equal(message.url, URL);
      const body = Buffer.from(JSON.stringify(message));
      assert.ok(body.length <= MAX_FRAME);
      const header = Buffer.alloc(4);
      if (LITTLE_ENDIAN) header.writeUInt32LE(body.length);
      else header.writeUInt32BE(body.length);
      await new Promise((resolve, reject) =>
        child.stdin.write(Buffer.concat([header, body]), (error) => error ? reject(error) : resolve()));
      const length = await take(4);
      const size = LITTLE_ENDIAN ? length.readUInt32LE() : length.readUInt32BE();
      assert.ok(size > 0 && size <= MAX_FRAME, "Invalid native reply size");
      const response = JSON.parse((await take(size)).toString("utf8"));
      assert.equal(response.request_id, message.request_id);
      assert.equal(response.protocol_version, PROTOCOL_VERSION);
      if (message.type === "set_stash_reading") mutations.push({ message, response });
      return response;
    });
    pending = result;
    void result.catch(() => {});
    return result;
  }

  const call = (type, fields = {}) => request({
    type, protocol_version: PROTOCOL_VERSION, request_id: randomUUID(), ...fields,
  });
  const hello = await call("hello");
  assert.equal(hello.type, "hello_result");
  assert.equal(hello.configured, true);
  const settingsReply = await call("get_config");
  assert.equal(settingsReply.type, "config_result");
  assert.equal(settingsReply.config.storage.root, home);
  return { call, request, revision: settingsReply.revision, mutations, pid: child.pid };
}

async function profilePage(t, profile, host, cleanup) {
  const context = await chromium.launchPersistentContext(profile, {
    ...launchOptions(chromePath()),
    timeout: 15_000,
    viewport: { width: 480, height: 860 },
    serviceWorkers: "block",
    env: { HOME: profile, CFFIXED_USER_HOME: profile, XDG_CONFIG_HOME: profile, PATH: "/usr/bin:/bin" },
    args: ["--no-sandbox", "--enable-automation", "--disable-extensions",
      "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
  });
  cleanup.push(() => context.close());
  await routeFixturePages(t, context);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(10_000);
  const devtools = await context.newCDPSession(page);
  const { arguments: browserArgs } = await devtools.send("Browser.getBrowserCommandLine");
  assert.ok(browserArgs.includes(`--user-data-dir=${profile}`), "Expected a dedicated on-disk profile");
  assert.ok(browserArgs.some((argument) => argument.startsWith("--headless")));
  assert.ok(!browserArgs.includes("--incognito"));
  await devtools.detach();

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));
  await page.exposeFunction("fixtureNativeRequest", host.request);
  await page.addInitScript(installChrome, {
    state: "configured", runs: [], pageUrl: URL, pageTitle: TITLE, pageName: "stash", bridge: true,
  });
  await page.goto(`${ORIGIN}/stash.html`);
  return page;
}

test("two Chrome profiles share Stash reading state through the native host", { timeout: 120_000 }, async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "brauser-stash-browser-")));
  const cleanup = [];
  t.after(async () => {
    const results = await Promise.allSettled(cleanup.reverse().map((close) => close()));
    await rm(temp, { recursive: true, force: true });
    const errors = results.filter(({ status }) => status === "rejected").map(({ reason }) => reason);
    if (errors.length > 0) throw new AggregateError(errors, "Could not close disposable Stash fixtures");
  });

  const home = path.join(temp, "home");
  await mkdir(home, { mode: 0o700 });
  const { dev, ino } = await stat(home, { bigint: true });
  const identity = [dev, ino].map((value) => value.toString(16).padStart(16, "0")).join(":");
  const settings = `root_picker_confirmed = true
root_identity = "unix:${identity}"
capture_enabled = false

[storage]
root = ${JSON.stringify(home)}
profile = "neutral"
log_dir = "logs"
pages_dir = "notes"
later_dir = "later"
artifacts_dir = "artifacts"
summaries_dir = "summaries"
`;
  const firstHost = await startHost(path.join(temp, "host-1"), home, settings, cleanup);
  const secondHost = await startHost(path.join(temp, "host-2"), home, settings, cleanup);
  assert.notEqual(firstHost.pid, secondHost.pid);
  const saved = await firstHost.call("stash_page", { expected_revision: firstHost.revision, url: URL, title: TITLE });
  assert.equal(saved.type, "stash_page_result");
  const first = await profilePage(t, path.join(temp, "chrome-1"), firstHost, cleanup);
  const second = await profilePage(t, path.join(temp, "chrome-2"), secondHost, cleanup);

  const row = (page) => page.locator(".stash-row").filter({ hasText: TITLE });
  const button = (page, name) => page.getByRole("button", { name, exact: true });
  const markDone = async (page) => {
    await row(page).click();
    await page.locator("#stash-complete").click();
    await button(page, "Undo").waitFor();
  };
  const reopenFromDone = async (page) => {
    await button(page, "Done").click();
    await row(page).click();
    await button(page, "Move to To read").click();
    await row(page).waitFor({ state: "hidden" });
    await button(page, "To read").click();
    await row(page).waitFor();
  };

  await markDone(first);
  const original = firstHost.mutations[0];
  assert.match(original.message.id, /^[a-f0-9]{64}$/u);
  const marker = path.join(home, "later", `${original.message.id}.done.md`);
  const doneReceipt = await readFile(marker);
  await button(first, "Undo").click();
  await row(first).waitFor();
  await markDone(first);
  const staleBasis = firstHost.mutations[2].response.reading_version;

  await reopenFromDone(second);
  await markDone(second);
  await button(first, "Undo").click();
  await first.locator("#stash-status").filter({ hasText: "The reading state changed elsewhere." }).waitFor();
  await button(first, "Undo").waitFor({ state: "hidden" });
  assert.equal(firstHost.mutations[3].message.reading_version, staleBasis);
  assert.equal(firstHost.mutations[3].response.code, "conflict");

  // Both can read the newer completion. Reopen it again from the second
  // profile and have the first observe the shared To read state on refresh.
  await button(first, "Done").click();
  await row(first).waitFor();
  await reopenFromDone(second);
  await button(first, "To read").click();
  await row(first).waitFor();

  const outcomes = (host) => host.mutations.map(({ response }) => [response.type, response.done]);
  assert.deepEqual(outcomes(firstHost), [
    ["stash_reading_set", true], ["stash_reading_set", false], ["stash_reading_set", true], ["error", undefined],
  ]);
  assert.deepEqual(outcomes(secondHost), [
    ["stash_reading_set", false], ["stash_reading_set", true], ["stash_reading_set", false],
  ]);
  assert.deepEqual(await readFile(marker), doneReceipt);
});
