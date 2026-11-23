// A private, purpose-bound launch receipt. The intent is written before
// update_config, so closing Chrome between its save and start_site_draft
// cannot lose the requested review. It never authorizes another config save.
import type { ConfigSnapshot, ShapeCount } from "../protocol/ts/generated.js";
import { storageKey } from "./brand.js";
import { canonicalJson } from "./capture-site-handoff.js";
import { httpOrigin, isUrlShape } from "./site-patterns.js";

export const CAPTURE_REVIEW_INTENT_PREFIX = storageKey("capture_review_intent_v1:");
export const MAX_CAPTURE_REVIEW_INTENTS = 64;
export const CAPTURE_REVIEW_INTENT_TTL_MS = 24 * 60 * 60_000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CaptureReviewIntent {
  version: 1;
  requestId: string;
  createdAt: number;
  origin: string;
  url: string;
  visited: ShapeCount[];
  links: ShapeCount[];
  beforeRevision: string;
  expectedConfig: ConfigSnapshot;
  savedRevision?: string;
}

function table(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapes(value: unknown): value is ShapeCount[] {
  return Array.isArray(value) && value.length <= 128 && value.every((row) =>
    table(row) && typeof row.shape === "string" && isUrlShape(row.shape) &&
    Number.isInteger(row.count) && (row.count as number) >= 1 && (row.count as number) <= 1_000_000);
}

function valid(value: unknown, requestId: string): value is CaptureReviewIntent {
  if (!table(value) || value.version !== 1 || value.requestId !== requestId || !REQUEST_ID.test(requestId) ||
      typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) || value.createdAt <= 0 ||
      typeof value.origin !== "string" || httpOrigin(value.origin) !== value.origin ||
      typeof value.url !== "string" || value.url.length > 8_192 || httpOrigin(value.url) !== value.origin ||
      typeof value.beforeRevision !== "string" || !value.beforeRevision || value.beforeRevision.length > 128 ||
      !(value.savedRevision === undefined || (typeof value.savedRevision === "string" &&
        value.savedRevision.length > 0 && value.savedRevision.length <= 128)) ||
      !table(value.expectedConfig) || !table(value.expectedConfig.adapters) ||
      !Array.isArray(value.expectedConfig.adapters.artifacts)) return false;
  return shapes(value.visited) && shapes(value.links);
}

export async function storeCaptureReviewIntent(area: ChromeStorageArea, intent: CaptureReviewIntent): Promise<void> {
  if (!valid(intent, intent.requestId)) throw new Error("The site capture review request is invalid.");
  const key = CAPTURE_REVIEW_INTENT_PREFIX + intent.requestId;
  const entries = await area.get(null);
  if (!(key in entries) && Object.entries(entries).filter(([name, value]) => name.startsWith(CAPTURE_REVIEW_INTENT_PREFIX) &&
      valid(value, name.slice(CAPTURE_REVIEW_INTENT_PREFIX.length))).length >= MAX_CAPTURE_REVIEW_INTENTS) {
    throw new Error("Too many pending site reviews. Dismiss an old review request before capturing another site.");
  }
  await area.set({ [key]: intent });
}

export async function captureReviewIntents(area: ChromeStorageArea): Promise<CaptureReviewIntent[]> {
  const values = await area.get(null);
  return Object.entries(values).flatMap(([key, value]) => {
    if (!key.startsWith(CAPTURE_REVIEW_INTENT_PREFIX)) return [];
    return valid(value, key.slice(CAPTURE_REVIEW_INTENT_PREFIX.length)) ? [value] : [];
  });
}

export async function removeCaptureReviewIntent(area: ChromeStorageArea, requestId: string): Promise<void> {
  if (REQUEST_ID.test(requestId)) await area.remove?.(CAPTURE_REVIEW_INTENT_PREFIX + requestId);
}

/** Recovery recognizes exactly the saved policy; it never rebases a stale
 * review request on an edited, paused, removed or replaced configuration. */
export function reviewIntentMatches(intent: CaptureReviewIntent, config: ConfigSnapshot, revision: string): boolean {
  return revision !== intent.beforeRevision &&
    (intent.savedRevision === undefined || intent.savedRevision === revision) &&
    canonicalJson(intent.expectedConfig) === canonicalJson(config);
}
