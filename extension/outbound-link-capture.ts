import type {
  OutboundActivitySource, OutboundLinkDraft, OutboundLinkReason, OutboundLinkTarget,
  StageOutboundLinksRequest,
} from "../protocol/ts/generated.js";
import { scanArtifactLinkCandidates, type ArtifactLinkCandidateScan, type ArtifactLinkReason } from "./artifact-link-collector.js";
import { wellFormed } from "./extract.js";
import { captureUrl, localTimestamp } from "./model.js";
import { PROTOCOL_VERSION } from "./native.js";

export interface LinkFrame {
  tabId: number;
  frameId: number;
  documentId: string;
  url: string;
}

export interface SummaryLinkContext {
  top: LinkFrame;
  selected: LinkFrame;
}

const MAX_BYTES = 64 * 1024;
// The host measures its own encoding after adding checked identity and
// names-only provenance, trimming whole targets if this reserve is exceeded.
const HOST_RESERVE_BYTES = 4 * 1024;
const MAX_TARGETS = 100;
const MAX_ANCHORS = 500;
const MAX_URL_BYTES = 8192;
const encoder = new TextEncoder();

const reasons: Record<ArtifactLinkReason, OutboundLinkReason> = {
  document_loading: "document_unavailable",
  document_unrendered: "document_unavailable",
  document_url_unavailable: "document_unavailable",
  dom_unavailable: "document_unavailable",
  anchor_limit: "anchor_limit",
  candidate_limit: "anchor_limit",
  deadline: "deadline",
  traversal_limit: "deadline",
  url_limit: "byte_limit",
  label_limit: "byte_limit",
  result_byte_limit: "byte_limit",
  item_limit: "target_limit",
  matching_unavailable: "policy_changed",
};

const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
const safeUrl = (url: string): boolean =>
  encoder.encode(url).length <= MAX_URL_BYTES && !/\p{Cc}/u.test(url) && captureUrl(url) !== null;

export function linkStageRequest(draft: OutboundLinkDraft): StageOutboundLinksRequest {
  return {
    type: "stage_outbound_links", protocol_version: PROTOCOL_VERSION,
    request_id: draft.observation_id, draft,
  };
}

/** Check exact destination identity before it spends the count or byte budget. */
export function makeLinkDraft(
  scan: ArtifactLinkCandidateScan,
  frame: LinkFrame,
  source: "summary" | OutboundActivitySource,
  revision: string,
  observedAt: Date,
  match: (url: string) => { id: string; type: string } | null,
  sourceUrl = frame.url,
): OutboundLinkDraft | null {
  if (!safeUrl(sourceUrl) || !safeUrl(frame.url)) return null;
  const activity = typeof source === "object";
  const draft: OutboundLinkDraft = {
    observation_id: crypto.randomUUID(),
    source_url: sourceUrl,
    ...(activity ? { activity_source: source } : {}),
    observed_at: localTimestamp(observedAt),
    document_url: frame.url,
    frame_scope: activity ? "top_document" : "selected_document",
    frame_id: frame.frameId,
    policy_revision: revision,
    coverage: {
      state: scan.coverage,
      reason: scan.coverage === "complete" ? null : reasons[scan.reasons[0]!] ?? "document_unavailable",
      anchors_inspected: Math.min(MAX_ANCHORS, scan.anchorsInspected),
    },
    targets: [],
  };
  const partial = (reason: OutboundLinkReason): void => {
    if (draft.coverage.state === "complete") draft.coverage = {
      ...draft.coverage, state: "partial", reason,
    };
  };
  if (scan.coverage !== "unavailable") {
    const targets = new Map<string, OutboundLinkTarget>();
    try {
      for (const candidate of scan.candidates.slice(0, MAX_ANCHORS)) {
        if (!safeUrl(candidate.url)) {
          partial("byte_limit");
          continue;
        }
        const artifact = match(candidate.url);
        if (!artifact) continue;
        const label = candidate.label ? Array.from(wellFormed(candidate.label)).slice(0, 256).join("") : null;
        const prior = targets.get(artifact.id);
        if (prior) {
          if (!prior.label) prior.label = label;
          continue;
        }
        if (targets.size >= MAX_TARGETS) {
          partial("target_limit");
          continue;
        }
        targets.set(artifact.id, {
          url: candidate.url, artifact_id: artifact.id, artifact_type: artifact.type, label,
        });
      }
      for (const target of targets.values()) {
        draft.targets.push(target);
        if (bytes(linkStageRequest(draft)) > MAX_BYTES - HOST_RESERVE_BYTES - 32) {
          draft.targets.pop();
          partial("byte_limit");
        }
      }
    } catch {
      draft.targets = [];
      draft.coverage = { ...draft.coverage, state: "unavailable", reason: "policy_changed" };
    }
  }
  return bytes(linkStageRequest(draft)) <= MAX_BYTES ? draft : null;
}

function sameAddress(a: string, b: string | null | undefined): boolean {
  try { return b != null && new URL(a).href === new URL(b).href; }
  catch { return false; }
}

export async function linkFrameCurrent(frame: LinkFrame): Promise<boolean> {
  const current = await chrome.webNavigation.getFrame?.({ tabId: frame.tabId, frameId: frame.frameId });
  return current?.documentId === frame.documentId && current.documentLifecycle === "active"
    && sameAddress(frame.url, current.url);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Inject only in the exact selected Chrome document. One loading retry is
 * enough; a failed context check can never become a snapshot of its successor. */
export async function readLinkFrame(
  scripting: typeof chrome.scripting,
  frame: LinkFrame,
  current: () => Promise<boolean>,
  wait = delay,
): Promise<ArtifactLinkCandidateScan | null> {
  const attempt = async (): Promise<ArtifactLinkCandidateScan | null> => {
    if (!await current()) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<[]>(resolve => { timer = setTimeout(() => resolve([]), 1500); });
      const results = await Promise.race([
        scripting.executeScript({
          target: { tabId: frame.tabId, documentIds: [frame.documentId] },
          func: scanArtifactLinkCandidates, args: [],
        }),
        expired,
      ]);
      if (!await current()) return null;
      const exact = results.length === 1 ? results[0] : undefined;
      if (!exact) return unavailable(frame, frame.frameId === 0 ? "dom_unavailable" : "document_unrendered");
      if (exact.frameId !== frame.frameId || exact.documentId !== frame.documentId ||
          !exact.result || (exact.result.href !== null && !sameAddress(frame.url, exact.result.href))) return null;
      return exact.result;
    } catch {
      return await current() ? unavailable(frame, "dom_unavailable") : null;
    } finally {
      clearTimeout(timer);
    }
  };
  const scan = await attempt();
  if (!scan?.reasons.includes("document_loading")) return scan;
  await wait(350);
  return attempt();
}

function unavailable(frame: LinkFrame, reason: ArtifactLinkReason): ArtifactLinkCandidateScan {
  return {
    observedAt: Date.now(), href: frame.url,
    scope: frame.frameId === 0 ? "top_document" : "frame_document", readyState: null,
    coverage: "unavailable", reasons: [reason], anchorsInspected: 0, candidates: [],
  };
}
