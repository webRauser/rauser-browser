// Invoked by the opt-in case in worker.test.mjs using its registered Chrome events.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { a11yBrowser } from "../../scripts/a11y-browser.mjs";
import { ipcDenied } from "../../scripts/tests/ipc-guard.mjs";
import { storageKey } from "../dist/brand.js";
import { PROTOCOL_VERSION } from "../dist/native.js";
import { localTimestamp } from "../dist/model.js";
import { leaseFor } from "../dist/settings.js";
import { activate, focused, installChrome, ORIGIN, routeFixturePages } from "./a11y/fixture.mjs";

const WORK = "https://work.example.test";
const SOURCE = `${WORK}/items/1`;
const RECORDED = `${WORK}/items/2`;
const UNVISITED = "https://docs.example.test/pages/3";
const REMOVED_VALUE = "fixture-qualifying-value";
const ORIGINAL_TARGET = `${UNVISITED}?utm_gate=${REMOVED_VALUE}#rendered`;
const UNKNOWN = "https://unknown.example.test/never-follow";
const TAB = 1;
const HOUR = 60 * 60_000;
const LINK_QUEUE = storageKey("outbound_link_queue_v1");
const LINK_HINT = storageKey("outbound_links_changed_v1");
const DELIVERED = storageKey("delivered_batches_v1");
const runFile = promisify(execFile);
const HANG_GUARD_MS = 30_000;

async function until(label, check) {
  const deadline = performance.now() + HANG_GUARD_MS;
  do {
    const value = check();
    if (value) return value;
    // timing-ok: Polling backoff only. The predicate determines when to continue.
    await delay(20);
  } while (performance.now() < deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

async function nativeFixture(t) {
  assert.notEqual(process.platform, "win32", "This explicit fixture uses a Unix picked-folder identity");
  const binary = process.env.BRAUSER_OUTBOUND_LINK_HOST;
  assert.ok(path.isAbsolute(binary), "BRAUSER_OUTBOUND_LINK_HOST must be an absolute scripted debug host path");
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "brauser-outbound-")));
  const children = new Set();
  t.after(async () => {
    await Promise.allSettled(children);
    await rm(temp, { recursive: true, force: true });
  });
  const home = path.join(temp, "home");
  const support = path.join(temp, "support");
  const logs = path.join(temp, "diagnostics");
  const userHome = path.join(temp, "user");
  await Promise.all([home, support, logs, userHome].map((dir) => mkdir(dir)));
  assert.deepEqual(await readdir(home), []);
  const config = path.join(support, "config.toml");
  const { dev, ino } = await stat(home, { bigint: true });
  const identity = [dev, ino].map((value) => value.toString(16).padStart(16, "0")).join(":");
  await writeFile(config, `root_picker_confirmed = true
root_identity = "unix:${identity}"
capture_enabled = true

[storage]
root = ${JSON.stringify(home)}
profile = "neutral"
log_dir = "logs"
pages_dir = "notes"
later_dir = "later"
artifacts_dir = "artifacts"
summaries_dir = "summaries"

[adapters]
format = 1

[[artifacts]]
type = "work.item"
origin = "${WORK}"
match = [{ path = "/items/{id:int}" }]
id = "work:{host}/{id}"

[[artifacts]]
type = "doc.page"
origin = "https://docs.example.test"
match = [{ path = "/pages/{id:int}", query = { utm_gate = "${REMOVED_VALUE}" } }]
id = "doc:{host}/{id}"
`);
  // Do not inherit service spawning, real support paths, or any harness settings.
  const options = { env: { HOME: userHome, BRAUSER_TEST_CONFIG_PATH: config, BRAUSER_LOG_DIR: logs },
    timeout: HANG_GUARD_MS, killSignal: "SIGKILL" };
  assert.match((await runFile(binary, ["--version"], options)).stdout.trim(), / \(scripted dialogs\)$/u);
  assert.equal((await runFile(binary, ["--config-path"], options)).stdout.trim(), config);

  const readable = ["hello", "get_config", "get_artifact", "load_note", "list_artifacts", "list_task_folders", "list_task_commands"];
  const writable = ["stage_outbound_links", "record_batch", "publish_outbound_links"];
  async function request(message, from) {
    assert.ok((from === "panel" ? readable : [...readable, ...writable]).includes(message.type),
      `Unexpected fixture request from ${from}: ${message.type}`);
    const json = Buffer.from(JSON.stringify(message));
    const length = Buffer.alloc(4);
    const littleEndian = endianness() === "LE";
    if (littleEndian) length.writeUInt32LE(json.length);
    else length.writeUInt32BE(json.length);
    const responseFrame = new Promise((resolve, reject) => {
      const child = execFile(binary, ["serve"], { ...options, encoding: "buffer", maxBuffer: 1024 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      // The callback still waits for process exit if its stdin closes early.
      child.stdin.on("error", () => child.kill());
      child.stdin.end(Buffer.concat([length, json]));
    });
    children.add(responseFrame);
    const frame = await responseFrame.finally(() => children.delete(responseFrame));
    assert.ok(frame.length >= 4, `Missing native response frame for ${message.type}`);
    assert.equal(littleEndian ? frame.readUInt32LE() : frame.readUInt32BE(), frame.length - 4);
    const response = JSON.parse(frame.subarray(4).toString());
    assert.equal(response.protocol_version, PROTOCOL_VERSION);
    assert.equal(response.request_id, message.request_id);
    return response;
  }

  const call = (type, fields = {}) => request({ type, protocol_version: PROTOCOL_VERSION,
    request_id: crypto.randomUUID(), ...fields }, "test");
  const files = async (folder) => (await readdir(path.join(home, folder), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  return { request, call, files, support };
}

function checkedMarker(text, id) {
  const key = createHash("sha256").update(`links_to:${id}`).digest("hex");
  const markers = text.split("\n").filter((line) => line.includes(`:visit id=${key} `));
  assert.equal(markers.length, 1, `One checked marker for ${id}`);
  const [, data, stripped] = markers[0].match(/ kind=links_to data=([a-f0-9]+) stripped=([a-f0-9]+) -->$/u) ?? [];
  assert.ok(data, "Expected a complete links_to marker");
  return { value: JSON.parse(Buffer.from(data, "hex").toString()),
    provenance: JSON.parse(Buffer.from(stripped, "hex").toString()) };
}

export async function joinedOutboundLinks(t, worker) {
  if (await ipcDenied(t, "child-pipe")) return;
  const browser = await a11yBrowser(t);
  if (!browser) return;
  t.after(() => browser.close());
  const host = await nativeFixture(t);
  const context = await browser.newContext({ viewport: { width: 280, height: 740 }, serviceWorkers: "block" });
  let sourceHtml;
  const sourceRequests = [];
  await routeFixturePages(t, context, (url, request) => {
    if (url.href !== SOURCE || !request.isNavigationRequest()) return undefined;
    sourceRequests.push(url.href);
    return sourceHtml;
  });
  const sourcePage = await context.newPage();
  const devtools = await context.newCDPSession(sourcePage);
  const panel = await context.newPage();
  const pageErrors = [];
  for (const page of [sourcePage, panel]) page.on("pageerror", (error) => pageErrors.push(error.message));
  t.after(() => assert.deepEqual(pageErrors, []));

  const actualNow = Date.now;
  // Stay several hours behind the host. Freeze a source hour only after collection.
  const firstHour = Math.floor(actualNow() / HOUR) * HOUR - 6 * HOUR;
  let now = firstHour + 10 * 60_000;
  Date.now = () => now;
  t.after(() => { Date.now = actualNow; });
  await sourcePage.clock.setFixedTime(now);

  const config = await host.call("get_config");
  assert.equal(config.type, "config_result");
  assert.equal(config.config_issue, null);
  assert.equal(config.adapter_issue, null);
  assert.equal(config.config.agent, null);
  await worker.send({ kind: "install_policy", lease: leaseFor(config.config, config.revision) });

  // Seed only the independently recorded destination. Its measures and file
  // bytes are the baseline for checking side effects of the source scans.
  const seedHour = new Date(firstHour - HOUR);
  seedHour.setMinutes(0, 0, 0);
  const seeded = await host.call("record_batch", { batch_id: crypto.randomUUID(), overflow: null, events: [{
    kind: "activity", visit: null, activity: { event_id: crypto.randomUUID(), url: RECORDED,
      artifact_id: "work:work.example.test/2", artifact_type: "work.item", title: "Recorded destination title",
      occurred_at: localTimestamp(seedHour), incognito: false, opens: 1,
      focused_seconds: 60, background_seconds: 0, modes: [], trails: [], refs: [] },
  }] });
  assert.equal(seeded.results[0].outcome, "persisted", JSON.stringify(seeded.results[0]));
  const recent = () => host.call("list_artifacts", { artifact_type: null, title_query: null, limit: 32 });
  const recordedRows = (await recent()).items;
  assert.deepEqual(recordedRows.map(({ url }) => url), [RECORDED]);
  const [recordedFile] = await host.files("artifacts");
  const recordedBytes = await readFile(recordedFile, "utf8");
  assert.equal((await host.call("get_artifact", { url: UNVISITED, title: null })).recognized, false,
    "The removed query value must be necessary for recognition");
  const unvisitedBefore = await host.call("get_artifact", { url: ORIGINAL_TARGET, title: null });
  assert.equal(unvisitedBefore.recognized, true);
  assert.deepEqual([unvisitedBefore.artifact.opens, unvisitedBefore.artifact.days_opened,
    unvisitedBefore.artifact.focused_seconds, unvisitedBefore.artifact.background_seconds], [0, 0, 0, 0]);

  const stages = [];
  const batches = [];
  const publications = [];
  const panelDetails = [];
  const transportErrors = [];
  const firstPublish = Promise.withResolvers();
  let panelStarted = false;
  t.after(() => firstPublish.resolve(false));
  t.after(() => assert.deepEqual(transportErrors, []));
  let frame;
  worker.connect({
    getFrame: async ({ tabId, frameId }) => tabId === frame?.tabId && frameId === 0 ? frame : null,
    async inject({ target, func, args }) {
      assert.deepEqual(target, { tabId: frame.tabId, documentIds: [frame.documentId] });
      assert.equal(func.name, "scanArtifactLinkCandidates");
      const { documentId } = frame;
      const result = await sourcePage.evaluate(`(${func.toString()})(...${JSON.stringify(args)})`);
      assert.equal(result.observedAt, now);
      return [{ frameId: 0, documentId, result }];
    },
    transport(request, port) {
      void (async () => {
        const entry = { request };
        let lose = false;
        if (request.type === "publish_outbound_links") {
          publications.push(entry);
          lose = publications.length === 1;
          if (lose && !await firstPublish.promise) {
            port.drop();
            return;
          }
        }
        const response = await host.request(request, "worker");
        entry.response = response;
        if (request.type === "stage_outbound_links") stages.push(entry);
        if (request.type === "record_batch") batches.push(entry);
        if (lose) {
          if (!port.closed) port.drop();
        } else port.reply(response);
      })().catch((error) => {
        transportErrors.push(error.message);
        port.drop();
      });
    },
  });
  await panel.exposeFunction("fixtureNativeRequest", async (request) => {
    try {
      const reply = await host.request(request, "panel");
      if (request.type === "get_artifact") panelDetails.push(reply);
      return reply;
    } catch (error) {
      transportErrors.push(error.message);
      throw error;
    }
  });
  await panel.exposeFunction("fixtureWorkerMessage", async (message) => {
    try {
      const value = await worker.send(message);
      if (message.kind === "sync_now") panelStarted = true;
      return { ok: true, value, error: null };
    }
    catch (error) { return { ok: false, value: null, error: error.message }; }
  });
  await panel.addInitScript(installChrome, { pageName: "panel", state: "configured", pageUrl: "about:blank",
    pageTitle: "Source fixture", runs: [], bridge: true });
  await panel.goto(`${ORIGIN}/panel.html`);
  try {
    await until("panel startup to reach the real worker and native host", () => {
      if (transportErrors.length || pageErrors.length) assert.fail(JSON.stringify({ transportErrors, pageErrors }));
      return panelStarted;
    });
  } catch (error) {
    const details = await panel.evaluate(() => ({ requests: window.fixture?.requests.map(({ type }) => type),
      status: document.querySelector("#status")?.textContent }));
    throw new Error(`Panel startup failed: ${JSON.stringify(details)}`, { cause: error });
  }

  async function collect(html, state) {
    sourceHtml = `<!doctype html><meta http-equiv="x-dns-prefetch-control" content="off"><title>Source fixture</title>${html}`;
    await sourcePage.clock.setFixedTime(now);
    await sourcePage.goto(SOURCE, { waitUntil: "load" });
    const { frameTree } = await devtools.send("Page.getFrameTree");
    // Back the mock Chrome documentId with Chromium's actual navigation identity.
    const documentId = frameTree.frame.loaderId;
    assert.ok(documentId && documentId !== frame?.documentId);
    // Each attempt is an open in a distinct tab of the same source artifact.
    // Recommitting the same artifact in the same tab need not create an activity total.
    const tabId = TAB + stages.length;
    frame = { tabId, url: SOURCE, documentId, documentLifecycle: "active" };
    const tab = { id: tabId, windowId: 1, incognito: false, status: "loading", url: SOURCE, title: "Source fixture" };
    const reads = worker.tabReads();
    worker.tabs.set(tabId, tab);
    worker.onCommitted({ ...frame, frameId: 0, timeStamp: now, transitionType: "link" });
    await until("navigation to reach its readiness check", () => worker.tabReads() >= reads + 2);
    tab.status = "complete";
    worker.onTabUpdated(tabId, { status: "complete" }, tab);
    const { request, response } = await until(`the ${state} host stage`, () => stages.find(({ request: { draft } }) =>
      Date.parse(draft.observed_at) === now));
    assert.equal(request.draft.coverage.state, state);
    assert.equal(response.type, "outbound_links_staged");
    assert.equal(response.observation_id, request.draft.observation_id);
    assert.ok(response.stage_token, response.reason);
    await until("the persisted worker stage token", () => worker.values.get(LINK_QUEUE)?.items.some(({ token }) =>
      token === response.stage_token));
    return { draft: request.draft, token: response.stage_token };
  }

  async function freeze() {
    now = (Math.floor(now / HOUR) + 1) * HOUR + 10 * 60_000;
    await sourcePage.clock.setFixedTime(now);
    return { sync: worker.send({ kind: "sync_now" }) };
  }

  async function mirrorHint(draft) {
    const hint = worker.sessionValues.get(LINK_HINT);
    assert.deepEqual(hint, { version: 1, policy_revision: config.revision, observation_id: draft.observation_id });
    const prior = panelDetails.length;
    await panel.evaluate(({ key, hint }) => chrome.storage.session.set({ [key]: hint }), { key: LINK_HINT, hint });
    const result = await until("the hint-triggered native artifact detail", () => panelDetails.slice(prior).find((reply) =>
      reply.outbound_links?.collection.observation_id === hint.observation_id));
    assert.equal(result.type, "artifact_result");
    return result.outbound_links;
  }

  const partial = await collect(`<a href="${ORIGINAL_TARGET}">Unvisited destination</a>
    <a href="${RECORDED}">Captured label for recorded destination</a>
    <a href="${UNKNOWN}">Unknown site</a><a href="${UNVISITED}">Missing required query</a>
    <a href="/${"x".repeat(8192)}">Oversized address</a>`, "partial");
  assert.deepEqual(partial.draft.coverage, { state: "partial", reason: "byte_limit", anchors_inspected: 5 });
  assert.deepEqual(partial.draft.targets.map(({ url }) => url), [ORIGINAL_TARGET, RECORDED]);
  const slotPath = path.join(host.support, "outbound-link-stages-v1", `${partial.token.split(":")[0]}.json`);
  const staged = await readFile(slotPath, "utf8");
  assert.ok(staged.includes(UNVISITED) && staged.includes("utm_gate"));
  assert.ok(!staged.includes(REMOVED_VALUE) && !staged.includes(UNKNOWN) && !staged.includes("#rendered"));
  assert.ok(!JSON.stringify(worker.values.get(LINK_QUEUE)).includes(REMOVED_VALUE));

  const { sync } = await freeze();
  const initial = await until("the blocked publication request after source acceptance", () => publications[0]);
  const batch = batches[0];
  const source = batch.request.events[0].activity;
  assert.equal(source.url, SOURCE);
  assert.deepEqual(partial.draft.activity_source, { event_id: source.event_id, occurred_at: source.occurred_at });
  assert.equal(batch.response.results[0].event_id, source.event_id);
  assert.equal(batch.response.results[0].outcome, "persisted");
  assert.equal(worker.sessionValues.get(LINK_HINT), undefined);
  const log = (await host.files("logs")).find((file) => file.endsWith(batch.response.results[0].relative_path));
  const before = await readFile(log, "utf8");
  assert.ok(before.includes(createHash("sha256").update(source.event_id).digest("hex")));
  assert.ok(!before.includes("kind=links_to"));

  await panel.evaluate(({ url, id }) => {
    fixture.tab.url = url;
    chrome.tabs.onActivated.fire({ tabId: id, windowId: 1 });
  }, { url: SOURCE, id: TAB });
  await panel.locator("#outbound-links-state").filter({ hasText: "Not collected" }).waitFor();
  assert.equal(panelDetails.at(-1).artifact.artifact_id, "work:work.example.test/1");
  assert.equal(panelDetails.at(-1).outbound_links, undefined);
  firstPublish.resolve(true);
  await sync;
  assert.equal(initial.response?.outcome, "persisted");
  assert.equal(worker.sessionValues.get(LINK_HINT), undefined, "A lost receipt cannot emit the hint");
  assert.equal(worker.values.get(DELIVERED), 1);
  const checkedText = await readFile(log, "utf8");
  const checked = checkedMarker(checkedText, partial.draft.observation_id);
  assert.equal(checked.value.observation.source.event_id, source.event_id);
  assert.equal(checked.value.observation.observed_at, partial.draft.observed_at);
  assert.deepEqual(checked.value.observation.targets.map(({ url }) => url), [UNVISITED, RECORDED]);
  assert.deepEqual(checked.provenance.targets, [["utm_gate"], []]);
  assert.ok(!JSON.stringify(checked).includes(REMOVED_VALUE));
  const frozen = JSON.parse(await readFile(slotPath, "utf8")).frozen;
  assert.match(frozen.source_fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(frozen.observation_digest, /^[0-9a-f]{64}$/u);

  now += 65_000;
  await sourcePage.clock.setFixedTime(now);
  await worker.send({ kind: "sync_now" });
  const replay = publications[1];
  assert.deepEqual(replay.request, initial.request);
  assert.equal(replay.response.outcome, "suppressed");
  assert.equal(replay.response.reason, "duplicate_event");
  assert.equal(await readFile(log, "utf8"), checkedText);
  assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")).frozen, frozen);
  assert.equal(worker.values.get(DELIVERED), 1);
  const initialView = await mirrorHint(partial.draft);
  assert.deepEqual(initialView.collection, initialView.snapshot.status);
  assert.equal(initialView.collection.observed_at, partial.draft.observed_at);
  assert.deepEqual(initialView.snapshot.targets.map(({ target, recorded_title }) => [target.url, recorded_title]),
    [[UNVISITED, undefined], [RECORDED, "Recorded destination title"]]);
  const disclosure = panel.locator("#outbound-links > summary");
  await activate(panel, disclosure);
  const links = panel.locator("#outbound-links-list a");
  await panel.keyboard.press("Tab");
  const unvisited = panel.getByRole("link", { name: "Unvisited destination", exact: true });
  assert.equal(await unvisited.getAttribute("href"), UNVISITED);
  assert.equal(await unvisited.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")), true);
  assert.ok(await panel.getByRole("link", { name: "Recorded destination title" }).isVisible());
  const [sourceFile] = (await host.files("artifacts")).filter((file) => file !== recordedFile);
  const markdown = async () => (await readFile(sourceFile, "utf8")).split("## Outbound artifact links")[1];
  assert.ok((await markdown()).includes(partial.draft.observed_at));
  assert.ok((await markdown()).includes(UNVISITED));

  const later = await collect("<style>html { display: none }</style><p>Unrendered document</p>", "unavailable");
  await (await freeze()).sync;
  const unavailable = await mirrorHint(later.draft);
  assert.deepEqual(unavailable.snapshot, initialView.snapshot);
  assert.deepEqual(unavailable.collection.coverage, { state: "unavailable", reason: "document_unavailable", anchors_inspected: 0 });
  const collectionTime = panel.locator("#outbound-links-coverage time");
  const retainedTime = panel.locator("#outbound-links-retained time");
  await retainedTime.waitFor();
  assert.equal(await collectionTime.getAttribute("datetime"), later.draft.observed_at);
  assert.equal(await retainedTime.getAttribute("datetime"), partial.draft.observed_at);
  assert.match(await panel.locator("#outbound-links-coverage").innerText(), /Document was unavailable/u);
  await focused(panel, "#outbound-links-list a[href='https://docs.example.test/pages/3']");
  assert.ok((await markdown()).includes(`Showing the partial list observed at ${partial.draft.observed_at}`));

  const empty = await collect("<p>This rendered source has no links.</p>", "complete");
  await (await freeze()).sync;
  const cleared = await mirrorHint(empty.draft);
  assert.deepEqual(cleared.snapshot, { status: cleared.collection, targets: [] });
  assert.deepEqual(cleared.collection.coverage, { state: "complete", reason: null, anchors_inspected: 0 });
  await panel.locator("#outbound-links-empty").filter({ hasText: "No outbound artifact links found." }).waitFor();
  assert.equal(await links.count(), 0);
  assert.ok(!(await markdown()).includes(UNVISITED));
  assert.match(await markdown(), /No outbound artifact links were retained\./u);

  const finalRows = (await recent()).items;
  assert.deepEqual(finalRows.filter(({ url }) => url !== SOURCE), recordedRows);
  const unvisitedAfter = await host.call("get_artifact", { url: ORIGINAL_TARGET, title: null });
  assert.deepEqual(unvisitedAfter.artifact, unvisitedBefore.artifact);
  assert.equal(unvisitedAfter.outbound_links, undefined);
  assert.deepEqual(await host.files("artifacts"), [recordedFile, sourceFile].sort());
  assert.equal(await readFile(recordedFile, "utf8"), recordedBytes);
  const logFiles = await host.files("logs");
  const dailyLogs = logFiles.filter((file) => file.endsWith(".md"));
  assert.deepEqual((await host.files("")).filter((file) => file.endsWith(".md")),
    [...dailyLogs, recordedFile, sourceFile].sort());
  const allLogs = (await Promise.all(dailyLogs.map((file) => readFile(file, "utf8")))).join("\n");
  assert.equal(allLogs.match(/ kind=links_to /gu)?.length, 3);
  for (const { draft } of [later, empty]) {
    const { observation } = checkedMarker(allLogs, draft.observation_id).value;
    assert.equal(observation.source.url, SOURCE);
    assert.equal(observation.source.event_id, draft.activity_source.event_id);
    assert.equal(observation.source.occurred_at, draft.activity_source.occurred_at);
    assert.equal(observation.observed_at, draft.observed_at);
    assert.deepEqual(observation.coverage, draft.coverage);
    assert.deepEqual(observation.targets, []);
  }
  assert.deepEqual(sourceRequests, [SOURCE, SOURCE, SOURCE]);
  assert.deepEqual(await panel.evaluate(() => fixture.actions), []);
  assert.deepEqual(batches.flatMap(({ request }) => request.events.map(({ activity }) => activity.url)),
    [SOURCE, SOURCE, SOURCE]);
  assert.equal(worker.values.get(DELIVERED), 3);
  await panel.close();
  t.diagnostic(JSON.stringify({ source_event: source.event_id, source_at: source.occurred_at,
    partial: initialView.collection, replay: replay.response.reason, unavailable: unavailable.collection,
    complete_empty: cleared.collection, delivered_batches: worker.values.get(DELIVERED) }));
}
