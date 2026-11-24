import type { AnswerReadScope, StashItem } from "../protocol/ts/generated.js";
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

type Reload = "refresh" | "filter";
type Home = { revision: string; root: string };
type ReadContext = { home: Home; generation: number; filter: string; query: string };
type ScrollPosition = { top: number; anchor: string | undefined; offset: number };

// The native cursor is ordered but isn't a snapshot. Collect a replacement
// off-screen and keep the current view when the bounded prefix is incomplete.
const MAX_REFRESH_PAGES = 6;
const MAX_REFRESH_MS = 5_000;
const MAX_REFRESH_BYTES = 2 * 1024 * 1024;
const utf8 = new TextEncoder();

let items: StashItem[] = [];
let selected: StashItem | null = null;
let next: string | null = null;
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

function setError(action: string, error: unknown, keptResults = false): void {
  const suffix = keptResults ? " Showing the previous results." : "";
  if (error instanceof HostError && error.code === "invalid_request" && error.message === UNSUPPORTED_REQUEST_TEXT) {
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
  if (filter === "all") meta.append(make("span", "", item.done ? "Done" : "To read"));
  button.append(make("span", "stash-row-title", item.title), meta);
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
  if (url) {
    const open = make("a", "", "Open original");
    open.id = "stash-open-source";
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    actions.append(open);
    if (summary) actions.append(action("stash-open-summary", "Open summary", () => openSummary(item)));
  }
  if (!item.done) actions.append(action("stash-complete", "Mark done", () => complete(item)));

  const scrollTop = previous?.id === item.id ? detail.scrollTop : 0;
  detail.replaceChildren(make("p", "stash-source", source(item)), heading);
  if (actions.childElementCount) detail.append(actions);
  if (summary) {
    const coverage = summary.read_scope ? coverageLabels[summary.read_scope] : "Coverage unknown";
    detail.append(make("p", "stash-summary-status", coverage));
    if (summary.overview) detail.append(make("p", "stash-overview", summary.overview));
  } else {
    detail.append(make("p", "stash-summary-status", "No saved summary"));
  }
  const context = make("div", "stash-context");
  context.append(metadata(item), timestamp(item.saved_at, "Saved"));
  if (summary) context.append(timestamp(summary.summarized_at, "Summary saved"));
  else if (!item.done) context.append(make("p", "", "Open the original page and use Stash in the side panel to try saving its summary."));
  detail.append(context);

  detail.scrollTop = scrollTop;
  if (hadFocus) {
    const replacement = previous?.id === item.id && focus.id ? document.getElementById(focus.id) : null;
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
  list.hidden = items.length === 0;
  more.hidden = cursor === null;

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
  if (items.length > 0 || next !== null) return `Showing ${items.length} saved ${items.length === 1 ? "page" : "pages"}.`;
  if (query) return "No saved pages match this search and filter.";
  if (filter === "done") return "No pages marked done yet.";
  if (filter === "open") return "No pages to read. Save a page with Stash in the side panel.";
  return "No saved pages yet. Save a page with Stash in the side panel.";
}

function announceResults(query: string, leftView = false): void {
  const message = resultsMessage(query);
  setStatus(leftView ? `The selected page left this view. ${message}` : message);
}

function queryText(): string {
  return wellFormed(search.value.trim().slice(0, search.maxLength));
}

function isCurrent(context: ReadContext): boolean {
  return !closed && context.generation === filterGeneration && context.home === home && queuedReload !== "refresh";
}

function remainingTime(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("The refresh ran out of time.");
  return remaining;
}

function requestPage(context: ReadContext, after: string | null, timeout?: number) {
  return host.call({
    type: "list_stash", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
    expected_revision: context.home.revision, state: context.filter, query: context.query, after,
  }, "stash_listed", timeout);
}

function refuseDuplicates(page: StashItem[], seen: ReadonlyMap<string, unknown> | ReadonlySet<string>): void {
  if (page.some((item) => seen.has(item.id))) throw new Error("The result page changed. Refresh Stash to continue.");
}

async function readPage(context: ReadContext, after: string | null, deadline: number | null = null): Promise<void> {
  const page = await requestPage(context, after, deadline === null ? undefined : remainingTime(deadline));
  if (!isCurrent(context)) return;
  if (after !== null) refuseDuplicates(page.items, rows);
  if (deadline !== null) remainingTime(deadline);
  announceResults(context.query, showItems(page.items, page.next, after === null ? "replace" : "append"));
}

async function replaceLoadedRange(context: ReadContext, deadline: number): Promise<void> {
  const replacement: StashItem[] = [];
  const seen = new Set<string>();
  const previousTail = items.at(-1);
  let cursor: string | null = null;
  let bytes = 0;
  for (let pageNumber = 0; pageNumber < MAX_REFRESH_PAGES; pageNumber += 1) {
    const page = await requestPage(context, cursor, remainingTime(deadline));
    if (!isCurrent(context)) return;
    refuseDuplicates(page.items, seen);
    bytes += utf8.encode(JSON.stringify(page.items)).byteLength;
    if (bytes > MAX_REFRESH_BYTES) break;
    replacement.push(...page.items);
    for (const item of page.items) seen.add(item.id);
    cursor = page.next;

    // Use current anchors: users may move through the existing view while it refreshes.
    const anchors = [selected?.id, focusedRow(), resultsScroll()?.anchor];
    const lastFetched = replacement.at(-1);
    // The native sort can distinguish instants within one millisecond.
    // Keep reading on ties or when either timestamp cannot be parsed.
    const reachedTail = previousTail === undefined || seen.has(previousTail.id) ||
      (lastFetched !== undefined && Date.parse(lastFetched.saved_at) < Date.parse(previousTail.saved_at));
    const reachedRange = reachedTail && replacement.length >= items.length && anchors.every((id) => !id || seen.has(id));
    remainingTime(deadline);
    if (cursor === null || reachedRange) {
      announceResults(context.query, showItems(replacement, cursor, "replace"));
      return;
    }
  }
  throw new Error("The refresh reached its results limit before finding your place.");
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
    if (generation === filterGeneration && queuedReload !== "refresh") {
      setError(failure, error, activeRefreshGeneration === generation && items.length > 0);
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
  const refreshing = reload === "refresh" && previousHome !== null;
  if (reload === "refresh") activeRefreshGeneration = generation;
  void run(refreshing ? "Refreshing Stash…" : "Loading saved pages…", refreshing ? "Could not refresh Stash." : "Could not load Stash.", async () => {
    const deadline = refreshing ? performance.now() + MAX_REFRESH_MS : null;
    if (reload === "refresh" || home === null) {
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
    if (home === null || generation !== filterGeneration || queuedReload === "refresh") return;
    const context = { home, generation, filter, query: queryText() };
    if (deadline !== null && home === previousHome && items.length) await replaceLoadedRange(context, deadline);
    else await readPage(context, null, deadline);
  });
}

function reload(kind: Reload | "return"): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
  if (kind === "refresh" && activeRefreshGeneration === filterGeneration) return;
  // A return can supersede a refresh started before the tab was hidden.
  // Keep one pending reload and retain the need to recheck the home.
  if (kind !== "filter") queuedReload = "refresh";
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
    const leftView = showItems(updated, next, "replace");
    const message = leftView ? "Marked as done. The page moved to Done." : "Marked as done.";
    setStatus(items.length === 0 && next === null ? `${message} ${resultsMessage(queryText())}` : message);
  });
}

function filtersChanged(): void {
  filterGeneration += 1;
  showItems([], null, "reset");
  setStatus("Loading saved pages…");
}

function refreshOnReturn(): void {
  if (!returnPending || document.visibilityState !== "visible") return;
  returnPending = false;
  reload("return");
}

search.addEventListener("input", () => {
  filtersChanged();
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => reload("filter"), 180);
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
refresh.addEventListener("click", () => reload("refresh"));
element<HTMLButtonElement>("stash-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().catch((error: unknown) => setError("Could not open Settings.", error));
});
more.addEventListener("click", () => {
  if (busy || !home || next === null) return;
  const context = { home, generation: filterGeneration, filter, query: queryText() };
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

reload("refresh");
