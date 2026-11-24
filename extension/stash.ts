import type {
  AnswerReadScope, StashItem, StashListed, StashSearchCoverage, StashSearchMatchSource, StashSearchProgress,
  StashSearchQuery, StashSummaryIssue,
} from "../protocol/ts/generated.js";
import { initDiag } from "./diag.js";
import { safeExplorerUrl } from "./explorer-model.js";
import { wellFormed } from "./extract.js";
import { HostClient, HostError, PROTOCOL_VERSION, UNSUPPORTED_REQUEST_TEXT, newRequestId } from "./native.js";
import { describe, element } from "./settings.js";

initDiag("stash");

const host = new HostClient();
const status = element<HTMLParagraphElement>("stash-status");
const layout = element<HTMLDivElement>("stash-layout");
const search = element<HTMLInputElement>("stash-search");
const contentFilters = element<HTMLDetailsElement>("stash-content-filters");
const sourceFilter = element<HTMLInputElement>("stash-source-filter");
const typeFilter = element<HTMLInputElement>("stash-type-filter");
const coverageFilter = element<HTMLSelectElement>("stash-coverage-filter");
const clearSearchFilters = element<HTMLButtonElement>("stash-clear-search-filters");
const filters = document.querySelectorAll<HTMLButtonElement>("[data-stash-filter]");
const refresh = element<HTMLButtonElement>("stash-refresh");
const results = element<HTMLElement>("stash-results");
const resultsHeading = element<HTMLHeadingElement>("stash-results-heading");
const resultsBody = element<HTMLDivElement>("stash-results-body");
const list = element<HTMLUListElement>("stash-list");
const preview = element<HTMLElement>("stash-preview");
const detail = element<HTMLDivElement>("stash-detail");
const more = element<HTMLButtonElement>("stash-more");
const back = element<HTMLButtonElement>("stash-back");
const rows = new Map<string, HTMLButtonElement>();
const shortSavedDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const coverageLabels: Record<AnswerReadScope, string> = {
  whole: "Whole artifact",
  partial: "Partial",
  page_only: "Page only",
};
const matchLabels: Record<StashSearchMatchSource, string> = {
  title: "Title match",
  source: "Source match",
  summary: "Saved summary match",
  note: "Saved note match",
};
const summaryIssues: Record<StashSummaryIssue, { label: string; guidance: string }> = {
  conflict: {
    label: "Summary blocked",
    guidance: "Review the summary files in your selected home, then refresh Stash.",
  },
  unavailable: {
    label: "Summary temporarily unavailable",
    guidance: "Check that your selected home is accessible, then refresh Stash.",
  },
};

type Reload = "refresh" | "filter" | "first-page";
type Home = { revision: string; root: string };
type SearchFilters = Omit<StashSearchQuery, "revision">;
type ReadContext = { home: Home; generation: number; filter: string; query: string; content: SearchFilters | undefined };
type ReadBudget = { deadline: number; reads: number };
type ScrollPosition = { top: number; anchor: string | undefined; offset: number };

// The native cursor is ordered but isn't a snapshot. Collect a replacement
// off-screen and keep the current view when the bounded prefix is incomplete.
const MAX_REFRESH_READS = 6;
const MAX_REFRESH_MS = 5_000;
const MAX_REFRESH_BYTES = 2 * 1024 * 1024;
class RefreshRangeLimit extends Error {
  constructor() {
    super("The refresh reached its results limit before finding your place.");
  }
}

class SearchFiltersUnavailable extends Error {
  constructor(cause: unknown) {
    super("Update Brauser to use these search filters. Choose Clear search filters to search titles and sources.", { cause });
  }
}

class SearchContinuationChanged extends Error {
  constructor(options?: ErrorOptions) {
    super("The search result page changed.", options);
  }
}

const utf8 = new TextEncoder();

let items: StashItem[] = [];
let selected: StashItem | null = null;
let next: string | null = null;
let pinOrder: string | undefined;
let legacyPinHost = false;
let legacySearchHost = false;
let searchProgress: StashSearchProgress | undefined;
let searchCursors = new Set<string>();
let firstPageOffered = false;
let home: Home | null = null;
let filter = "open";
let filterGeneration = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let queuedReload: Reload | null = null;
let activeRefreshGeneration: number | null = null;
let hiddenResultsScroll: ScrollPosition | null = null;
let returnPending = document.visibilityState === "hidden";
let busy = false;
let closed = false;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text: string, problem = false): void {
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("problem", problem);
}

function unsupportedRequest(error: unknown): boolean {
  return error instanceof HostError && error.code === "invalid_request" && error.message === UNSUPPORTED_REQUEST_TEXT;
}

function offerFirstPage(value: boolean): void {
  firstPageOffered = value;
  refresh.textContent = value ? "Reload first page" : "Refresh";
}

function retireContinuation(fallback: HTMLButtonElement): void {
  const hadFocus = document.activeElement === more;
  next = null;
  more.hidden = true;
  if (hadFocus) fallback.focus();
}

function setError(action: string, error: unknown, keptResults = false): void {
  const restart = restartSearch(error);
  if ((keptResults && error instanceof RefreshRangeLimit) || restart) offerFirstPage(true);
  if (error instanceof SearchFiltersUnavailable) retireContinuation(clearSearchFilters);
  const suffix = (keptResults ? " Showing the previous results." : "") +
    (firstPageOffered && (keptResults || restart) ? " Choose Reload first page to continue." : "");
  if (unsupportedRequest(error)) {
    setStatus(`Update the Brauser host and extension together to use Stash.${suffix}`, true);
  } else {
    setStatus(`${action} ${describe(error)}${suffix}`, true);
  }
}

function timestamp(value: string | null, label: string, format: "short" | "full" = "full"): HTMLElement {
  const line = make(format === "short" ? "span" : "p");
  const date = value === null ? null : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) {
    line.textContent = `${label} date unavailable`;
    return line;
  }
  const time = make("time", "", format === "short" ? shortSavedDate.format(date) : date.toLocaleString());
  time.dateTime = date.toISOString();
  line.append(`${label} `, time);
  return line;
}

function source(item: StashItem): string {
  const url = safeExplorerUrl(item.url);
  return url ? new URL(url).hostname : "Source unavailable";
}

function metadata(item: StashItem): HTMLElement {
  const group = make("div", "stash-meta");
  group.append(make("span", "", item.done ? "Done" : "To read"));
  if (item.pin?.pinned) group.append(make("span", "stash-pinned", "Pinned"));
  const summary = item.summary;
  if (!summary) return group;
  for (const value of [summary.category, summary.document_type]) {
    if (value) group.append(make("span", "", value));
  }
  if (summary.importance) group.append(make("span", "", `${summary.importance} importance`));
  return group;
}

function row(item: StashItem): HTMLLIElement {
  const entry = make("li");
  const button = make("button", "stash-row");
  button.type = "button";
  button.dataset.stashId = item.id;
  button.setAttribute("aria-controls", preview.id);
  const meta = make("span", "stash-row-meta");
  meta.append(make("span", "", source(item)), timestamp(item.saved_at, "Saved", "short"));
  const scope = item.summary?.read_scope;
  if (scope === "partial" || scope === "page_only") {
    meta.append(make("span", "stash-row-coverage", coverageLabels[scope]));
  }
  if (item.pin?.pinned) meta.append(make("span", "stash-pinned", "Pinned"));
  if (filter === "all") meta.append(make("span", "", item.done ? "Done" : "To read"));
  button.append(make("span", "stash-row-title", item.title), meta);
  if (item.search_match) {
    const match = make("span", "stash-match");
    match.append(make("span", "stash-match-label", matchLabels[item.search_match.source]));
    if (item.search_match.snippet) match.append(" · ", item.search_match.snippet);
    button.append(match);
  }
  button.addEventListener("click", () => {
    select(item);
    showPane("detail");
    detail.querySelector("h2")?.focus();
  });
  rows.set(item.id, button);
  entry.append(button);
  return entry;
}

function action(id: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = make("button", "", label);
  button.id = id;
  button.type = "button";
  button.setAttribute("aria-disabled", String(busy));
  button.addEventListener("click", onClick);
  return button;
}

function originalLink(id: string, label: string, url: string): HTMLAnchorElement {
  const link = make("a", "", label);
  link.id = id;
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function select(item: StashItem | null): void {
  if (selected) rows.get(selected.id)?.removeAttribute("aria-current");
  if (item) rows.get(item.id)?.setAttribute("aria-current", "true");
  const previous = selected;
  selected = item;
  if (JSON.stringify(previous) === JSON.stringify(item)) return;

  const focus = document.activeElement;
  const hadFocus = focus instanceof HTMLElement && preview.contains(focus);
  preview.hidden = item === null;
  if (!item) {
    if (hadFocus) returnToResults();
    else showPane("results");
    detail.replaceChildren();
    return;
  }

  const heading = make("h2", "", item.title);
  heading.id = "stash-detail-heading";
  heading.tabIndex = -1;
  const actions = make("div", "stash-actions");
  const summary = item.summary;
  const url = safeExplorerUrl(item.url);
  const issue = item.summary_issue ? summaryIssues[item.summary_issue] : null;
  const canRetry = url !== null && !summary && !issue && !item.done;
  if (url) {
    actions.append(originalLink("stash-open-source", "Open original", url));
    if (summary) actions.append(action("stash-open-summary", "Open summary", () => openSummary(item)));
    else if (canRetry) {
      const retry = originalLink("stash-retry-summary", "Retry summary", url);
      retry.setAttribute("aria-describedby", "stash-summary-guidance");
      actions.append(retry);
    }
  }
  if (item.pin) actions.append(action("stash-pin", item.pin.pinned ? "Unpin" : "Pin", () => changePin(item)));
  if (!item.done) actions.append(action("stash-complete", "Mark done", () => complete(item)));

  const scrollTop = previous?.id === item.id ? detail.scrollTop : 0;
  detail.replaceChildren(make("p", "stash-source", source(item)), heading);
  if (actions.childElementCount) detail.append(actions);
  if (summary) {
    const coverage = summary.read_scope ? coverageLabels[summary.read_scope] : "Coverage unknown";
    detail.append(make("p", "stash-summary-status", coverage));
    if (summary.overview) detail.append(make("p", "stash-overview", summary.overview));
  } else {
    detail.append(make("p", "stash-summary-status", issue?.label ?? "No saved summary"));
  }
  const context = make("div", "stash-context");
  context.append(metadata(item), timestamp(item.saved_at, "Saved"));
  if (summary) context.append(timestamp(summary.summarized_at, "Summary saved"));
  else if (issue) context.append(make("p", "", issue.guidance));
  else if (canRetry) {
    const guidance = make("p", "", "Retry summary opens the original in a new tab. After the original loads, choose Summarize & log or Save Page in the Brauser side panel.");
    guidance.id = "stash-summary-guidance";
    context.append(guidance);
  }
  detail.append(context);

  detail.scrollTop = scrollTop;
  if (hadFocus) {
    const focusId = focus.id === "stash-retry-summary" && summary ? "stash-open-summary" : focus.id;
    const replacement = previous?.id === item.id && focusId ? document.getElementById(focusId) : null;
    (replacement ?? heading).focus({ preventScroll: replacement !== null });
  }
}

function resultsScroll(): ScrollPosition | null {
  if (!resultsBody.getClientRects().length) return hiddenResultsScroll;
  const top = resultsBody.getBoundingClientRect().top;
  for (const [id, button] of rows) {
    const bounds = button.getBoundingClientRect();
    if (bounds.bottom > top) return { top: resultsBody.scrollTop, anchor: id, offset: bounds.top - top };
  }
  return { top: resultsBody.scrollTop, anchor: undefined, offset: 0 };
}

function restoreResultsScroll(position: ScrollPosition | null): void {
  if (!resultsBody.getClientRects().length) {
    hiddenResultsScroll = position;
    return;
  }
  hiddenResultsScroll = null;
  const anchor = position?.anchor ? rows.get(position.anchor) : null;
  resultsBody.scrollTop = position?.top ?? 0;
  if (position && anchor) {
    resultsBody.scrollTop += anchor.getBoundingClientRect().top - resultsBody.getBoundingClientRect().top - position.offset;
  }
}

function showPane(pane: "results" | "detail"): void {
  if (layout.dataset.view === pane) return;
  const position = resultsScroll();
  layout.dataset.view = pane;
  if (position) restoreResultsScroll(position);
}

function returnToResults(): void {
  showPane("results");
  (rows.get(selected?.id ?? "") ?? resultsHeading).focus();
}

function focusedRow(): string | undefined {
  const focus = document.activeElement;
  return focus instanceof HTMLButtonElement && list.contains(focus) ? focus.dataset.stashId : undefined;
}

function showItems(page: StashItem[], cursor: string | null, mode: "replace" | "append" | "reset"): boolean {
  const focus = document.activeElement;
  const rowId = focusedRow();
  const position = mode === "replace" ? resultsScroll() : null;
  const previousItems = items;
  const selectedIndex = items.findIndex((item) => item.id === selected?.id);
  if (mode !== "append") {
    list.replaceChildren();
    rows.clear();
  }
  for (const item of page) list.append(row(item));
  items = mode === "append" ? [...items, ...page] : page;
  next = cursor;
  if (mode === "reset") {
    pinOrder = undefined;
    searchProgress = undefined;
    searchCursors.clear();
    offerFirstPage(false);
  }
  list.hidden = items.length === 0;
  more.hidden = cursor === null;
  more.textContent = searchProgress?.limited_by ? "Continue search" : "Load more saved pages";

  const retained = items.find((item) => item.id === selected?.id);
  const leftView = mode === "replace" && selected !== null && retained === undefined;
  let nearby = items[Math.min(Math.max(0, selectedIndex), items.length - 1)];
  if (leftView && selectedIndex >= 0) {
    const neighbors = [...previousItems.slice(selectedIndex + 1), ...previousItems.slice(0, selectedIndex).reverse()];
    const neighbor = neighbors.find((item) => rows.has(item.id));
    nearby = items.find((item) => item.id === neighbor?.id) ?? nearby;
  }
  select(retained ?? nearby ?? null);

  if (mode !== "append") restoreResultsScroll(position);
  if (rowId && mode !== "append") {
    (rows.get(rowId) ?? rows.get(selected?.id ?? "") ?? resultsHeading).focus({ preventScroll: rows.has(rowId) });
  }
  if (focus === more && mode === "append" && page[0]) rows.get(page[0].id)?.focus();
  else if (focus === more && cursor === null) (rows.get(selected?.id ?? "") ?? resultsHeading).focus();
  return leftView;
}

function resultsMessage(query: string): string {
  if (searchProgress?.limited_by) {
    const shown = `Found ${items.length} ${items.length === 1 ? "match" : "matches"} so far.`;
    return `${shown} Search paused before checking every saved page. ${next === null ? "Choose Reload first page to retry." : "Choose Continue search to check more."}`;
  }
  if (items.length > 0 || next !== null) return `Showing ${items.length} saved ${items.length === 1 ? "page" : "pages"}.`;
  if (query || searchFilters()) return "No saved pages match this search and filter.";
  if (filter === "done") return "No pages marked done yet.";
  if (filter === "open") return "No pages to read. Save a page with Stash in the side panel.";
  return "No saved pages yet. Save a page with Stash in the side panel.";
}

function announceResults(query: string, leftView = false): void {
  const message = resultsMessage(query);
  const scope = legacySearchHost && query ? " This host searches titles and sources. Update Brauser to search saved summaries and notes." : "";
  setStatus(`${leftView ? "The selected page left this view. " : ""}${message}${scope}`);
}

function queryText(): string {
  return wellFormed(search.value.trim().slice(0, search.maxLength));
}

function searchFilters(): SearchFilters | undefined {
  const source_host = wellFormed(sourceFilter.value.trim());
  const document_type = wellFormed(typeFilter.value.trim());
  const coverage = coverageFilter.value as StashSearchCoverage | "";
  return source_host || document_type || coverage ? {
    ...(source_host ? { source_host } : {}),
    ...(document_type ? { document_type } : {}),
    ...(coverage ? { coverage } : {}),
  } : undefined;
}

function readContext(home: Home): ReadContext {
  return { home, generation: filterGeneration, filter, query: queryText(), content: searchFilters() };
}

function updateSearchControls(): void {
  const rejected = legacySearchHost && searchFilters() !== undefined;
  const hidden = home === null || (legacySearchHost && !rejected);
  const focus = document.activeElement;
  if ((hidden && contentFilters.contains(focus)) || (!rejected && focus === clearSearchFilters)) search.focus();
  contentFilters.hidden = hidden;
  clearSearchFilters.hidden = !rejected;
  if (rejected) contentFilters.open = true;
  search.placeholder = legacySearchHost ? "Search titles or sources" : "Search saved pages";
}

function restartSearch(error: unknown): boolean {
  return error instanceof SearchContinuationChanged || (error instanceof HostError && error.code === "conflict" &&
    (error.message === "Stash results changed. Restart the search to continue." ||
      (searchProgress !== undefined && error.message === "Stash pin order changed. Refresh Stash before loading more.")));
}

function rechecksHome(reload: Reload | null): boolean {
  return reload === "refresh" || reload === "first-page";
}

function isCurrent(context: ReadContext): boolean {
  return !closed && context.generation === filterGeneration && context.home === home && !rechecksHome(queuedReload);
}

function remainingTime(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("The refresh ran out of time.");
  return remaining;
}

async function requestPage(
  context: ReadContext, after: string | null, order: string | undefined, revision: string | undefined, budget: ReadBudget | null,
) {
  const call = (includePin: boolean, includeSearch: boolean) => {
    if (budget) {
      if (budget.reads <= 0) throw new RefreshRangeLimit();
      budget.reads -= 1;
    }
    return host.call({
      type: "list_stash", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      expected_revision: context.home.revision, state: context.filter, query: context.query, after,
      ...(includePin ? { include_pin: true, ...(order ? { pin_order: order } : {}) } : {}),
      ...(includeSearch ? { search: { ...context.content, ...(revision ? { revision } : {}) } } : {}),
    }, "stash_listed", budget ? remainingTime(budget.deadline) : undefined);
  };

  let includePin = after === null ? !legacyPinHost : order !== undefined;
  let includeSearch = after === null
    ? context.content !== undefined || (!legacySearchHost && Boolean(context.query))
    : revision !== undefined;
  let page;
  for (;;) {
    try {
      page = await call(includePin, includeSearch);
      break;
    } catch (error) {
      // Opt-ins can only change on the first page. An older host may support Pin but not search.
      if (!unsupportedRequest(error) || !isCurrent(context)) throw error;
      if (after !== null) {
        if (includeSearch) throw new SearchContinuationChanged({ cause: error });
        throw error;
      }
      if (includeSearch) {
        includeSearch = false;
        legacySearchHost = true;
        updateSearchControls();
        if (context.content) throw new SearchFiltersUnavailable(error);
      } else if (includePin) {
        includePin = false;
        legacyPinHost = true;
      } else throw error;
    }
  }
  if (includePin !== (page.pin_order !== undefined) || (after !== null && page.pin_order !== order) ||
    includeSearch !== (page.search_progress !== undefined) ||
    (after !== null && page.search_progress?.revision !== revision) ||
    (after !== null && page.next === after) ||
    (includeSearch && page.items.some((item) => Boolean(item.search_match) !== Boolean(context.query)))) {
    if (after !== null && includeSearch) throw new SearchContinuationChanged();
    throw new Error("The result page changed. Refresh Stash to continue.");
  }
  if (includeSearch && legacySearchHost && isCurrent(context)) {
    legacySearchHost = false;
    updateSearchControls();
  }
  return page;
}

function checkPageProgress(
  page: StashListed, seen: ReadonlyMap<string, unknown> | ReadonlySet<string> | null, cursors: Set<string>,
): void {
  const duplicate = page.items.some((item) => seen?.has(item.id));
  if (!page.search_progress) {
    if (duplicate) throw new Error("The result page changed. Refresh Stash to continue.");
    return;
  }
  if (duplicate || (page.next !== null && cursors.has(page.next))) throw new SearchContinuationChanged();
  // A limited page can advance the cursor without adding a row.
  if (page.next !== null) cursors.add(page.next);
}

async function readPage(context: ReadContext, after: string | null, deadline: number | null = null): Promise<void> {
  const budget = deadline === null ? null : { deadline, reads: MAX_REFRESH_READS };
  const cursors = after === null ? new Set<string>() : searchCursors;
  try {
    const page = await requestPage(
      context, after, after === null ? undefined : pinOrder, after === null ? undefined : searchProgress?.revision, budget,
    );
    if (!isCurrent(context)) return;
    if (deadline !== null) remainingTime(deadline);
    checkPageProgress(page, after === null ? null : rows, cursors);
    searchCursors = cursors;
    pinOrder = page.pin_order;
    searchProgress = page.search_progress;
    offerFirstPage(Boolean(searchProgress?.limited_by && page.next === null));
    announceResults(context.query, showItems(page.items, page.next, after === null ? "replace" : "append"));
  } catch (error) {
    if (after !== null && searchProgress !== undefined && isCurrent(context) && restartSearch(error)) {
      offerFirstPage(true);
      retireContinuation(refresh);
    }
    throw error;
  }
}

function passedTail(last: StashItem, previous: StashItem): boolean {
  if (last.pin?.pinned !== previous.pin?.pinned) return previous.pin?.pinned === true;
  // The native sort can distinguish instants within one millisecond.
  // Keep reading on ties or when either timestamp cannot be parsed.
  return Date.parse(last.saved_at) < Date.parse(previous.saved_at);
}

async function replaceLoadedRange(context: ReadContext, deadline: number): Promise<void> {
  const replacement: StashItem[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  const previousTail = items.at(-1);
  let cursor: string | null = null;
  let order: string | undefined;
  let progress: StashSearchProgress | undefined;
  let bytes = 0;
  const budget = { deadline, reads: MAX_REFRESH_READS };
  while (budget.reads > 0) {
    const page = await requestPage(context, cursor, order, progress?.revision, budget);
    if (!isCurrent(context)) return;
    checkPageProgress(page, seen, cursors);
    bytes += utf8.encode(JSON.stringify(page.items)).byteLength;
    if (bytes > MAX_REFRESH_BYTES) break;
    replacement.push(...page.items);
    for (const item of page.items) seen.add(item.id);
    cursor = page.next;
    order = page.pin_order;
    progress = page.search_progress;

    // Use current anchors: users may move through the existing view while it refreshes.
    const anchors = [selected?.id, focusedRow(), resultsScroll()?.anchor];
    const lastFetched = replacement.at(-1);
    // A pin change can move an unseen former tail into either group.
    // Crossing its old position proves absence only in the same pin order.
    const reachedTail = previousTail === undefined || seen.has(previousTail.id) ||
      (lastFetched !== undefined && order === pinOrder && passedTail(lastFetched, previousTail));
    const reachedRange = reachedTail && replacement.length >= items.length && anchors.every((id) => !id || seen.has(id));
    remainingTime(deadline);
    if (cursor === null || reachedRange) {
      pinOrder = order;
      searchProgress = progress;
      searchCursors = cursors;
      offerFirstPage(Boolean(searchProgress?.limited_by && cursor === null));
      announceResults(context.query, showItems(replacement, cursor, "replace"));
      return;
    }
    if (progress?.limited_by) break;
  }
  throw new RefreshRangeLimit();
}

function setBusy(value: boolean): void {
  busy = value;
  for (const button of [more, ...detail.querySelectorAll("button")]) {
    button.setAttribute("aria-disabled", String(value));
  }
}

function setHome(current: Home | null): void {
  if (current?.revision === home?.revision && current?.root === home?.root) return;
  home = current;
  legacyPinHost = false;
  legacySearchHost = false;
  updateSearchControls();
  if (layout.contains(document.activeElement)) refresh.focus();
  showItems([], null, "reset");
  layout.hidden = home === null;
}

function lostHome(error: unknown): boolean {
  // The native protocol shares conflict and internal codes with ordinary page
  // failures. Only its configuration/folder refusals invalidate this scope.
  return error instanceof HostError && (
    error.code === "invalid_config" || error.code === "not_configured" ||
    (error.code === "conflict" && error.message === "configuration changed; refresh Stash and try again") ||
    (error.code === "internal" && error.message === "home folder is unavailable")
  );
}

async function run(message: string, failure: string, work: () => Promise<void>): Promise<void> {
  const generation = filterGeneration;
  setBusy(true);
  setStatus(message);
  try {
    await work();
  } catch (error) {
    if (closed) return;
    if (lostHome(error)) setHome(null);
    if (generation === filterGeneration && !rechecksHome(queuedReload)) {
      const retained = activeRefreshGeneration === generation || restartSearch(error) || error instanceof SearchFiltersUnavailable;
      setError(failure, error, retained && items.length > 0);
    }
  } finally {
    activeRefreshGeneration = null;
    setBusy(false);
    startReload();
  }
}

function startReload(): void {
  if (closed || busy || debounce !== null || queuedReload === null) return;
  const reload = queuedReload;
  queuedReload = null;
  const generation = filterGeneration;
  const previousHome = home;
  const recheck = rechecksHome(reload);
  const refreshing = recheck && previousHome !== null;
  if (recheck) activeRefreshGeneration = generation;
  void run(refreshing ? "Refreshing Stash…" : "Loading saved pages…", refreshing ? "Could not refresh Stash." : "Could not load Stash.", async () => {
    const deadline = refreshing ? performance.now() + MAX_REFRESH_MS : null;
    if (recheck || home === null) {
      const config = await host.call({
        type: "get_config", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      }, "config_result", deadline === null ? undefined : remainingTime(deadline));
      if (closed) return;
      const storage = config.config.storage;
      setHome(config.config_issue || !storage ? null : { revision: config.revision, root: storage.root });
      if (generation !== filterGeneration) return;
      if (config.config_issue) setStatus("Brauser settings need repair. Open Settings, then refresh Stash.", true);
      else if (home === null) setStatus("Choose a home folder in Settings to use Stash.");
    }
    if (home === null || generation !== filterGeneration || rechecksHome(queuedReload)) return;
    const context = readContext(home);
    if (reload !== "first-page" && deadline !== null && home === previousHome && items.length) {
      await replaceLoadedRange(context, deadline);
    }
    else await readPage(context, null, deadline);
  });
}

function reload(kind: Reload | "return"): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
  if (rechecksHome(kind === "return" ? null : kind) && activeRefreshGeneration === filterGeneration) return;
  // A return can supersede a refresh started before the tab was hidden.
  // Keep one pending reload and retain the need to recheck the home.
  if (kind !== "filter") queuedReload = kind === "return" ? "refresh" : kind;
  else queuedReload ??= "filter";
  startReload();
}

function openSummary(item: StashItem): void {
  const summary = item.summary;
  if (busy || !home || !summary) return;
  const expectedRevision = home.revision;
  const generation = filterGeneration;
  void run("Opening the saved summary…", "Could not open the saved summary.", async () => {
    await host.call({
      type: "open_summary", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      url: item.url, summary_path: summary.path, expected_revision: expectedRevision,
    }, "summary_opened");
    if (!closed && generation === filterGeneration) setStatus("Opened the saved summary.");
  });
}

function changePin(item: StashItem): void {
  if (busy || !home || !item.pin) return;
  const context = readContext(home);
  const pinVersion = item.pin.version;
  const pinned = !item.pin.pinned;
  void run(pinned ? "Pinning the page…" : "Unpinning the page…", "Could not change the pin.", async () => {
    let message = pinned ? "Pinned." : "Unpinned.";
    try {
      const applied = await host.call({
        type: "set_stash_pin", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
        expected_revision: context.home.revision, id: item.id, version: item.version,
        pin_version: pinVersion, pinned,
      }, "stash_pin_set");
      if (applied.pin.pinned !== pinned) throw new Error("The native reply did not confirm the requested pin.");
    } catch (error) {
      if (!(error instanceof HostError) || error.code !== "conflict" || lostHome(error)) throw error;
      message = "The pin changed elsewhere.";
    }
    if (!isCurrent(context)) return;
    activeRefreshGeneration = context.generation;
    setStatus(`${message} Refreshing Stash…`);
    try {
      await replaceLoadedRange(context, performance.now() + MAX_REFRESH_MS);
    } catch (error) {
      if (lostHome(error)) throw error;
      if (isCurrent(context)) setError(`${message} Could not refresh Stash.`, error, true);
      return;
    }
    if (isCurrent(context)) setStatus(`${message} ${status.textContent ?? ""}`);
  });
}

function complete(item: StashItem): void {
  if (busy || !home || item.done) return;
  const expectedRevision = home.revision;
  const generation = filterGeneration;
  void run("Marking the page done…", "Could not mark the page done.", async () => {
    await host.call({
      type: "complete_stash", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      expected_revision: expectedRevision, id: item.id, version: item.version,
    }, "stash_completed");
    if (closed || generation !== filterGeneration) return;
    const updated = filter === "open" ? items.filter((saved) => saved.id !== item.id)
      : items.map((saved) => saved.id === item.id ? { ...saved, done: true } : saved);
    const restart = searchProgress !== undefined && next !== null;
    if (restart) searchProgress = undefined;
    const leftView = showItems(updated, restart ? null : next, "replace");
    const message = leftView ? "Marked as done. The page moved to Done." : "Marked as done.";
    if (restart) {
      offerFirstPage(true);
      setStatus(`${message} Choose Reload first page to continue this search.`);
    } else {
      setStatus(items.length === 0 && next === null ? `${message} ${resultsMessage(queryText())}` : message);
    }
  });
}

function filtersChanged(): void {
  filterGeneration += 1;
  updateSearchControls();
  if (!legacySearchHost || !searchFilters()) showItems([], null, "reset");
  setStatus("Loading saved pages…");
}

function refreshOnReturn(): void {
  if (!returnPending || document.visibilityState !== "visible") return;
  returnPending = false;
  reload("return");
}

function updateSearch(): void {
  filtersChanged();
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => reload("filter"), 180);
}
search.addEventListener("input", updateSearch);
sourceFilter.addEventListener("change", () => { filtersChanged(); reload("filter"); });
typeFilter.addEventListener("change", () => { filtersChanged(); reload("filter"); });
coverageFilter.addEventListener("change", () => { filtersChanged(); reload("filter"); });
clearSearchFilters.addEventListener("click", () => {
  sourceFilter.value = "";
  typeFilter.value = "";
  coverageFilter.value = "";
  filtersChanged();
  reload("filter");
});
for (const button of filters) {
  button.addEventListener("click", () => {
    const value = button.dataset.stashFilter;
    if (!value || value === filter) return;
    filter = value;
    for (const control of filters) control.setAttribute("aria-pressed", String(control === button));
    filtersChanged();
    reload("filter");
  });
}
refresh.addEventListener("click", () => reload(firstPageOffered ? "first-page" : "refresh"));
element<HTMLButtonElement>("stash-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().catch((error: unknown) => setError("Could not open Settings.", error));
});
more.addEventListener("click", () => {
  if (busy || !home || next === null) return;
  const context = readContext(home);
  const after = next;
  void run("Loading more saved pages…", "Could not load more saved pages.", () => readPage(context, after));
});
back.addEventListener("click", returnToResults);
results.addEventListener("focusin", () => showPane("results"));
preview.addEventListener("focusin", () => showPane("detail"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") returnPending = true;
  else refreshOnReturn();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) refreshOnReturn(); });
window.addEventListener("pagehide", (event) => {
  if (event.persisted) {
    returnPending = true;
    return;
  }
  closed = true;
  if (debounce !== null) clearTimeout(debounce);
  host.disconnect();
});

host.onHostExit(() => {
  legacyPinHost = false;
  legacySearchHost = false;
  updateSearchControls();
});
reload("refresh");
