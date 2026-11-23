// Capture-review publication must reach the worker even with no panel open.
// This ledger holds correlation IDs and deadlines only; no URLs or agent text.
import type { RunView } from "../protocol/ts/generated.js";
import { BINARY_NAME, storageKey } from "./brand.js";
import { isTerminal } from "./run-card.js";

export const CAPTURE_REVIEW_POLICY_KEY = storageKey("capture_review_policy_v1");
export const CAPTURE_REVIEW_POLICY_ALARM = `${BINARY_NAME}-capture-review-policy`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DISCOVERY_MS = 2 * 60_000;
const WATCH_MS = 24 * 60 * 60_000;
const MAX_WATCHES = 64;
const MAX_HANDLED = 1024;

interface Watch { request_id: string; run_id?: string; discover_until: number; until: number }
interface Ledger { version: 1; watches: Watch[]; handled: string[] }
function empty(): Ledger { return { version: 1, watches: [], handled: [] }; }
function valid(value: unknown): value is Ledger {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Ledger;
  return row.version === 1 && Array.isArray(row.watches) && row.watches.length <= MAX_WATCHES &&
    row.watches.every((watch) => typeof watch === "object" && watch !== null &&
      typeof watch.request_id === "string" && UUID.test(watch.request_id) &&
      (watch.run_id === undefined || (typeof watch.run_id === "string" && UUID.test(watch.run_id))) &&
      Number.isFinite(watch.discover_until) && Number.isFinite(watch.until) && watch.until >= watch.discover_until) &&
    Array.isArray(row.handled) && row.handled.length <= MAX_HANDLED &&
    row.handled.every((id) => typeof id === "string" && UUID.test(id));
}

export interface CaptureReviewPolicyDeps {
  storage: ChromeStorageArea;
  now(): number;
  list(): Promise<{ runs: RunView[]; complete: boolean }>;
  get(runId: string): Promise<RunView | null>;
  /** The existing host-read/worker-policy publication path, with its pause,
   * removal, ownership and latest-config guards intact. */
  refreshPolicy(): Promise<void>;
  schedule(needed: boolean): Promise<void>;
}

export class CaptureReviewPolicy {
  private sequence: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: CaptureReviewPolicyDeps) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(work, work);
    this.sequence = result.catch(() => undefined);
    return result;
  }

  private async read(): Promise<Ledger> {
    const value = (await this.deps.storage.get(CAPTURE_REVIEW_POLICY_KEY))[CAPTURE_REVIEW_POLICY_KEY];
    if (value === undefined) return empty();
    if (!valid(value)) throw new Error("Site review policy monitoring is unavailable.");
    return value;
  }

  private async save(state: Ledger): Promise<void> {
    state.handled = state.handled.slice(-MAX_HANDLED);
    if (!valid(state)) throw new Error("Too many pending site reviews to monitor.");
    await this.deps.storage.set({ [CAPTURE_REVIEW_POLICY_KEY]: state });
    await this.deps.schedule(state.watches.length > 0);
  }

  /** Awaited before start_site_draft, so a lost reply or closed panel cannot
   * lose a successful publication. Known restored runs can attach their ID. */
  arm(requestId: string, runId?: string): Promise<void> {
    return this.serial(async () => {
      if (!UUID.test(requestId) || (runId !== undefined && !UUID.test(runId))) throw new Error("Invalid site review identity.");
      const state = await this.read();
      if (state.handled.includes(requestId)) return;
      const known = state.watches.find((watch) => watch.request_id === requestId);
      if (known) {
        if (runId !== undefined) {
          if (known.run_id !== undefined && known.run_id !== runId) throw new Error("Site review identity changed.");
          known.run_id = runId;
        }
      } else {
        const now = this.deps.now();
        state.watches.push({ request_id: requestId, ...(runId ? { run_id: runId } : {}),
          discover_until: now + DISCOVERY_MS, until: now + WATCH_MS });
      }
      await this.save(state);
    });
  }

  /** Worker activation restores only the alarm; it never starts an idle
   * service when there is no saved watch. */
  resume(): Promise<void> {
    return this.serial(async () => {
      if ((await this.deps.storage.get(CAPTURE_REVIEW_POLICY_KEY))[CAPTURE_REVIEW_POLICY_KEY] === undefined) return;
      await this.deps.schedule((await this.read()).watches.length > 0);
    });
  }

  poll(): Promise<void> {
    return this.serial(async () => {
      const state = await this.read();
      if (!state.watches.length) return this.deps.schedule(false);
      const now = this.deps.now();
      // Expiration happens before host I/O, so even an unavailable service
      // cannot keep waking forever after this bounded watch ends.
      const expired = state.watches.filter((watch) => watch.until < now);
      state.watches = state.watches.filter((watch) => watch.until >= now);
      for (const watch of expired) if (!state.handled.includes(watch.request_id)) state.handled.push(watch.request_id);
      if (!state.watches.length) return this.save(state);
      const discovery = state.watches.some((watch) => watch.run_id === undefined);
      const history = discovery ? await this.deps.list() : { runs: [], complete: true };
      if (!history.complete) throw new Error("Site review history is incomplete; policy monitoring will retry.");
      const finished = new Set<string>();
      const completed = new Set<string>();
      let published = false;
      for (const watch of state.watches) {
        let run = history.runs.find((candidate) => candidate.kind === "site_draft" && candidate.capture_review === true &&
          candidate.start_request_id === watch.request_id);
        if (!run && watch.run_id !== undefined) run = await this.deps.get(watch.run_id) ?? undefined;
        if (run) {
          if (run.kind !== "site_draft" || run.capture_review !== true || run.start_request_id !== watch.request_id ||
              (watch.run_id !== undefined && run.run_id !== watch.run_id)) {
            throw new Error("The service returned a different site review.");
          }
          watch.run_id = run.run_id;
          if (isTerminal(run)) {
            finished.add(watch.request_id);
            completed.add(watch.request_id);
            if (run.state === "succeeded") published = true;
          }
        } else if (watch.run_id !== undefined || watch.discover_until < now) {
          finished.add(watch.request_id); // A missing run supplies no finish to act on.
        }
      }
      // A failed refresh retains every watch, including successful runs,
      // until the existing policy path has really published the new lease.
      if (published) await this.deps.refreshPolicy();
      state.watches = state.watches.filter((watch) => !finished.has(watch.request_id));
      for (const requestId of completed) if (!state.handled.includes(requestId)) state.handled.push(requestId);
      await this.save(state);
    });
  }
}
