import assert from "node:assert/strict";
import test from "node:test";

const {
  CAPTURE_REVIEW_INTENT_PREFIX, MAX_CAPTURE_REVIEW_INTENTS,
  captureReviewIntents, removeCaptureReviewIntent, reviewIntentMatches, storeCaptureReviewIntent,
} = await import("../dist/capture-review-intent.js");

const CONFIG = { capture_enabled: true, adapters: { format: 1, artifacts: [] } };
function intent(n = 1, changes = {}) {
  return {
    version: 1, requestId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, createdAt: Date.now(),
    origin: "https://tools.example", url: "https://tools.example/docs/123",
    visited: [{ shape: "/docs/{num}", count: 1 }], links: [],
    beforeRevision: "1", expectedConfig: structuredClone(CONFIG),
    ...changes,
  };
}
function storage(entries = new Map()) {
  return {
    entries,
    async get(keys) {
      const names = keys === null ? [...entries.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => entries.has(key)).map((key) => [key, structuredClone(entries.get(key))]));
    },
    async set(values) { for (const [key, value] of Object.entries(values)) entries.set(key, structuredClone(value)); },
    async remove(key) { entries.delete(key); },
  };
}

test("launch intents retain distinct request identities and removal touches only its own key", async () => {
  const area = storage(new Map([["unrelated", { private: "content" }]]));
  const first = intent(1);
  const second = intent(2);
  await storeCaptureReviewIntent(area, first);
  await storeCaptureReviewIntent(area, second);
  assert.deepEqual(await captureReviewIntents(area), [first, second]);
  await removeCaptureReviewIntent(area, first.requestId);
  assert.deepEqual(await captureReviewIntents(area), [second]);
  assert.deepEqual(area.entries.get("unrelated"), { private: "content" });
});

test("recovery requires a changed revision and exactly the originally intended policy", () => {
  const pending = intent();
  assert.equal(reviewIntentMatches(pending, CONFIG, "1"), false);
  assert.equal(reviewIntentMatches(pending, CONFIG, "2"), true);
  assert.equal(reviewIntentMatches(pending, { ...CONFIG, capture_enabled: false }, "2"), false);
  assert.equal(reviewIntentMatches({ ...pending, savedRevision: "2" }, CONFIG, "3"), false);
});

test("malformed or cross-origin stored values cannot become launch intents", async () => {
  const area = storage();
  for (const [index, invalid] of [
    intent(1, { url: "https://elsewhere.example/docs/123" }),
    intent(2, { url: "https://user:password@tools.example/docs/123" }),
    intent(3, { visited: [{ shape: "https://tools.example/secret", count: 1 }] }),
    intent(4, { createdAt: null }),
    intent(5, { requestId: "unsafe" }),
  ].entries()) {
    area.entries.set(CAPTURE_REVIEW_INTENT_PREFIX + invalid.requestId, invalid);
    await assert.rejects(storeCaptureReviewIntent(area, invalid), /invalid/, `case ${index}`);
  }
  assert.deepEqual(await captureReviewIntents(area), []);
});

test("bounded pending intents refuse a new capture while allowing an existing intent to advance", async () => {
  const area = storage();
  for (let n = 1; n <= MAX_CAPTURE_REVIEW_INTENTS; n += 1) {
    const value = intent(n);
    area.entries.set(CAPTURE_REVIEW_INTENT_PREFIX + value.requestId, value);
  }
  await assert.rejects(storeCaptureReviewIntent(area, intent(MAX_CAPTURE_REVIEW_INTENTS + 1)), /Too many pending/);
  await storeCaptureReviewIntent(area, intent(1, { savedRevision: "2" }));
  assert.equal((await captureReviewIntents(area)).length, MAX_CAPTURE_REVIEW_INTENTS);
});
