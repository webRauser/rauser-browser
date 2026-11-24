export interface ArtifactLinkCandidate {
  url: string;
  /** Untrusted, optional rendered text; never a destination title or HTML. */
  label?: string;
}

export type ArtifactLinkReason =
  | "document_loading" | "document_unrendered" | "document_url_unavailable" | "dom_unavailable"
  | "anchor_limit" | "candidate_limit" | "deadline" | "traversal_limit" | "url_limit"
  | "label_limit" | "result_byte_limit" | "item_limit" | "matching_unavailable";

export interface ArtifactLinkCandidateScan {
  /** Actual observed document address, never an expected/caller-supplied URL. */
  href: string | null;
  /** Chrome's executeScript result supplies the exact frameId/documentId. */
  scope: "top_document" | "frame_document" | null;
  readyState: DocumentReadyState | null;
  /** Lazy document.links entries inspected (including excluded AREA entries). */
  anchorsInspected: number;
  candidates: ArtifactLinkCandidate[];
  coverage: "complete" | "partial" | "unavailable";
  reasons: ArtifactLinkReason[];
}

export interface ArtifactLinkScanLimits {
  maxAnchors?: number;
  maxCandidates?: number;
  maxDurationMs?: number;
  maxTraversalSteps?: number;
  maxResultBytes?: number;
}

/** Standalone Chrome executeScript function: no module closures or imports.
 * Reads only this document, including rendered navigation outside the article.
 * Results are ephemeral URL evidence, NOT recognized artifacts. The caller
 * must check URL/document generation and policy before/after this snapshot,
 * match enabled/scoped rules before ANY durable buffering/transport, and bind
 * Chrome's frameId/documentId. The host remains the identity authority.
 *
 * Hard bounds: 500 link entries/candidates, 20,000 traversal steps, 100 ms
 * cooperative deadline, 256 KiB UTF-8 JSON result, 8192-byte URLs and 256-unit
 * labels. Lower test/caller limits cannot raise these ceilings. DOM/layout
 * operations themselves cannot be preempted; no scrolling or loading occurs.
 */
export function scanArtifactLinkCandidates(limits: ArtifactLinkScanLimits = {}): ArtifactLinkCandidateScan {
  const bounded = (value: number | undefined, fallback: number, min = 0): number =>
    value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(fallback, Math.floor(value))) : fallback;
  const maxAnchors = bounded(limits.maxAnchors, 500);
  const maxCandidates = bounded(limits.maxCandidates, 500);
  const maxDurationMs = bounded(limits.maxDurationMs, 100);
  const maxSteps = bounded(limits.maxTraversalSteps, 20_000);
  const maxBytes = bounded(limits.maxResultBytes, 256 * 1024, 1024);
  const encoder = new TextEncoder();
  const encoded = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
  const result: ArtifactLinkCandidateScan = { href: null, scope: null, readyState: null, anchorsInspected: 0,
    candidates: [], coverage: "unavailable", reasons: [] };
  const reason = (value: ArtifactLinkReason): void => {
    if (!result.reasons.includes(value)) result.reasons.push(value);
    if (result.coverage === "complete") result.coverage = "partial";
  };
  // Reserve all possible reason strings and the longest coverage/count fields
  // up front. Candidate JSON sizes + commas then give an exact additive bound.
  const possibleReasons: ArtifactLinkReason[] = ["document_loading", "document_unrendered", "document_url_unavailable",
    "dom_unavailable", "anchor_limit", "candidate_limit", "deadline", "traversal_limit", "url_limit", "label_limit", "result_byte_limit"];
  try {
    const started = performance.now();
    const href = window.location.href;
    if (typeof href !== "string" || href.length > 8192 || encoder.encode(href).length > 8192) {
      reason("document_url_unavailable");
      return result;
    }
    const source = new URL(href);
    if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) {
      reason("document_url_unavailable");
      return result;
    }
    result.href = href;
    result.scope = window.top === window ? "top_document" : "frame_document";
    result.readyState = document.readyState;
    if (document.readyState === "loading") {
      reason("document_loading");
      return result;
    }
    if (!document.documentElement || !document.body || document.documentElement.getClientRects().length === 0) {
      reason("document_unrendered");
      return result;
    }
    const base = document.baseURI;
    if (typeof base !== "string" || base.length > 8192 || encoder.encode(base).length > 8192) {
      reason("document_url_unavailable");
      return result;
    }
    source.hash = "";
    let usedBytes = encoded({ ...result, anchorsInspected: 500, coverage: "unavailable", reasons: possibleReasons });
    if (usedBytes > maxBytes) {
      result.href = null;
      reason("result_byte_limit");
      return result;
    }
    result.coverage = "complete";
    let steps = 0;
    let stopped = false;
    const step = (): boolean => {
      if (performance.now() - started >= maxDurationMs) {
        reason("deadline");
        stopped = true;
      } else if (steps >= maxSteps) {
        reason("traversal_limit");
        stopped = true;
      }
      steps += 1;
      return !stopped;
    };
    const hiddenStyle = (node: Element): boolean => {
      const style = window.getComputedStyle(node);
      return style.display === "none" || style.opacity === "0" || style.contentVisibility === "hidden";
    };
    const excluded = (node: Element): boolean =>
      ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName.toUpperCase()) ||
      !!(node as HTMLElement).hidden || hiddenStyle(node);
    const visible = (node: Element): boolean => {
      const visibility = window.getComputedStyle(node).visibility;
      return visibility !== "hidden" && visibility !== "collapse";
    };
    const hasBox = (node: Element): boolean => {
      const box = node.getClientRects()[0];
      return !!box && box.width > 0 && box.height > 0 && visible(node);
    };
    const rendered = (anchor: Element): boolean => {
      for (let node: Element | null = anchor; node; node = node.parentElement) {
        if (!step()) return false;
        if (excluded(node)) return false;
      }
      if (hasBox(anchor)) return true;
      // display:contents, absolutely positioned children and visibility
      // overrides can render clickable descendants without an anchor box.
      // Share the global traversal/deadline budget, including Range probes of
      // short text prefixes (never one range over an unbounded subtree).
      let node: Node | null = anchor.firstChild;
      while (node) {
        if (!step()) return false;
        let descend = true;
        if (node.nodeType === 1) {
          descend = !excluded(node as Element);
          if (descend && hasBox(node as Element)) return true;
        } else if (node.nodeType === 3 && node.parentElement && visible(node.parentElement)) {
          const length = node.nodeValue?.length ?? 0;
          const range = document.createRange();
          for (let offset = 0; offset < Math.min(length, 1024); offset += 256) {
            if (!step()) return false;
            range.setStart(node, offset);
            range.setEnd(node, Math.min(length, offset + 256));
            const boxes = range.getClientRects();
            for (let index = 0; index < 256; index += 1) {
              if (!step()) return false;
              const box = boxes[index];
              if (!box) break;
              if (box.width > 0 && box.height > 0) return true;
              if (index === 255 && boxes[index + 1]) reason("traversal_limit");
            }
          }
          if (length > 1024) reason("traversal_limit");
        }
        if (descend && node.firstChild) {
          node = node.firstChild;
          continue;
        }
        while (node && node !== anchor && !node.nextSibling) {
          if (!step()) return false;
          node = node.parentNode;
        }
        if (!node || node === anchor) break;
        node = node.nextSibling;
      }
      return false;
    };
    const label = (anchor: Element): string | undefined => {
      // Never read unbounded innerText/textContent or clone the document. Walk
      // only a bounded prefix of this anchor's rendered text; labels are optional.
      let text = "";
      let readChars = 0;
      let node: Node | null = anchor.firstChild;
      while (node) {
        if (!step()) break;
        let descend = true;
        if (node.nodeType === 1) {
          const element = node as Element;
          descend = !excluded(element);
        } else if (node.nodeType === 3) {
          const visibility = node.parentElement && window.getComputedStyle(node.parentElement).visibility;
          if (visibility !== "hidden" && visibility !== "collapse") {
            const raw = node.nodeValue ?? "";
            const part = raw.slice(0, 1024 - readChars);
            readChars += part.length;
            text = (text + part).replace(/\s+/g, " ").trimStart();
            if (text.length > 256 || raw.length > part.length || readChars >= 1024) {
              reason("label_limit");
              break;
            }
          }
        }
        if (descend && node.firstChild) {
          node = node.firstChild;
          continue;
        }
        while (node && node !== anchor && !node.nextSibling) {
          if (!step()) break;
          node = node.parentNode;
        }
        if (stopped || !node || node === anchor) break;
        node = node.nextSibling;
      }
      // Same whole-surrogate convention as extract.ts; JSON lone-surrogate
      // escapes are rejected by serde_json. Never cut a paired surrogate.
      let end = Math.min(256, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
      const value = text.slice(0, end).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD").trim();
      return value || undefined;
    };
    const seen = new Map<string, ArtifactLinkCandidate>();
    // Lazy indexed access avoids querySelectorAll/length materializing a dense
    // page. document.links includes AREA, which is inspected but never retained.
    const anchors = document.links;
    let index = 0;
    for (; index < maxAnchors; index += 1) {
      if (!step()) break;
      const anchor = anchors[index];
      if (!anchor) break;
      result.anchorsInspected += 1;
      if (anchor.tagName !== "A" || !rendered(anchor)) {
        if (stopped) break;
        continue;
      }
      const raw = anchor.getAttribute("href");
      if (raw === null) continue;
      if (raw.length > 8192) {
        reason("url_limit");
        continue;
      }
      let destination: URL;
      try { destination = new URL(raw, base); } catch { continue; }
      if ((destination.protocol !== "http:" && destination.protocol !== "https:") || destination.username || destination.password) continue;
      const url = destination.href;
      if (encoder.encode(url).length > 8192) {
        reason("url_limit");
        continue;
      }
      destination.hash = "";
      if (destination.href === source.href) continue;
      const existing = seen.get(url);
      if (existing?.label) continue;
      const value = label(anchor);
      const candidate: ArtifactLinkCandidate = { url, ...(value ? { label: value } : {}) };
      const addedBytes = encoded(candidate) - (existing ? encoded(existing) : 0) + (!existing && result.candidates.length ? 1 : 0);
      if (usedBytes + addedBytes > maxBytes) {
        reason("result_byte_limit");
      } else if (existing) {
        if (value) existing.label = value;
        usedBytes += addedBytes;
      } else if (result.candidates.length >= maxCandidates) {
        reason("candidate_limit");
      } else {
        result.candidates.push(candidate);
        seen.set(url, candidate);
        usedBytes += addedBytes;
      }
      if (stopped) break;
    }
    // Existence-only lookahead does not inspect the next entry's properties.
    if (!stopped && index === maxAnchors && anchors[index]) reason("anchor_limit");
  } catch {
    // No page strings, exception messages or raw href lists enter diagnostics.
    result.coverage = result.anchorsInspected ? "partial" : "unavailable";
    reason("dom_unavailable");
  } finally {
    // Early loading/DOM-failure returns must obey the same envelope cap even
    // when the actual document URL alone is larger than a lowered budget.
    if (encoded(result) > maxBytes) {
      result.href = null;
      result.candidates = [];
      result.coverage = "unavailable";
      reason("result_byte_limit");
    }
  }
  return result;
}

export interface ArtifactLinkShapeLimits {
  maxItems?: number;
  maxResultBytes?: number;
  /** UTF-8 JSON bytes reserved for the eventual caller's observation envelope.
   * Include all additional keys, values, braces, commas and identity metadata.
   * The default leaves 4 KiB; the caller must measure its actual envelope and
   * recheck the complete <=64 KiB message after adding host-contract fields. */
  reservedEnvelopeBytes?: number;
}

/** Pure second stage. Only a current enabled/scoped capture-rule match should
 * return true. Matching precedes the 100-item quota; navigation cannot spend
 * that quota. Exact URL repeats are removed by the scan; artifact-identity
 * deduplication and self-identity exclusion still belong to the host/caller.
 * This result is still candidates, with no asserted artifact IDs. */
export function shapeArtifactLinkCandidates(
  scan: ArtifactLinkCandidateScan,
  matches: (candidate: Readonly<ArtifactLinkCandidate>) => boolean,
  limits: ArtifactLinkShapeLimits = {},
): ArtifactLinkCandidateScan {
  const bounded = (value: number | undefined, fallback: number, min = 0): number =>
    value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(fallback, Math.floor(value))) : fallback;
  const maxItems = bounded(limits.maxItems, 100);
  const maxBytes = bounded(limits.maxResultBytes, 64 * 1024, 1024);
  const reserve = limits.reservedEnvelopeBytes ?? 4096;
  if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve > maxBytes - 1024) {
    throw new RangeError("Observation envelope leaves insufficient candidate space");
  }
  const encoder = new TextEncoder();
  const encoded = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;
  const result: ArtifactLinkCandidateScan = { ...scan, candidates: [], reasons: [...scan.reasons] };
  const reason = (value: ArtifactLinkReason): void => {
    if (!result.reasons.includes(value)) result.reasons.push(value);
    if (result.coverage === "complete") result.coverage = "partial";
  };
  let usedBytes = encoded({ ...result, coverage: "unavailable",
    reasons: [...result.reasons, "item_limit", "result_byte_limit", "matching_unavailable"] });
  if (usedBytes + reserve > maxBytes) {
    result.href = null;
    result.coverage = "unavailable";
    reason("result_byte_limit");
    return result;
  }
  if (scan.coverage === "unavailable") return result;
  try {
    for (let index = 0; index < Math.min(scan.candidates.length, 500); index += 1) {
      const candidate = scan.candidates[index]!;
      if (!matches(candidate)) continue;
      if (result.candidates.length >= maxItems) {
        reason("item_limit");
        continue;
      }
      const addedBytes = encoded(candidate) + (result.candidates.length ? 1 : 0);
      if (usedBytes + addedBytes + reserve > maxBytes) {
        reason("result_byte_limit");
        continue;
      }
      result.candidates.push({ ...candidate });
      usedBytes += addedBytes;
    }
    if (scan.candidates.length > 500) reason("candidate_limit");
  } catch {
    result.candidates = [];
    result.coverage = "unavailable";
    result.reasons = ["matching_unavailable"];
  }
  return result;
}
