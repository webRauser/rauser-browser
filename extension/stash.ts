import type { StashItem } from "../protocol/ts/generated.js";
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
const filter = element<HTMLSelectElement>("stash-state");
const refresh = element<HTMLButtonElement>("stash-refresh");
const empty = element<HTMLParagraphElement>("stash-empty");
const list = element<HTMLUListElement>("stash-list");
const detail = element<HTMLDivElement>("stash-detail");
const more = element<HTMLButtonElement>("stash-more");
const jumpPreview = element<HTMLButtonElement>("explorer-jump-preview");
const rows = new Map<string, HTMLButtonElement>();

let items: StashItem[] = [];
let selected: StashItem | null = null;
let next: string | null = null;
let revision: string | null = null;
// A filter change invalidates an in-flight page before the debounce expires.
let filterGeneration = 0;
let debounce: ReturnType<typeof setTimeout> | null = null;
let queuedReload: "refresh" | "filter" | null = null;
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

function setError(action: string, error: unknown): void {
  if (error instanceof HostError && error.code === "invalid_request" && error.message === UNSUPPORTED_REQUEST_TEXT) {
    setStatus("Update the Brauser host and extension together to use Stash.", true);
  } else {
    setStatus(`${action} ${describe(error)}`, true);
  }
}

function timestamp(value: string | null, label: string, tag: "p" | "span" = "p"): HTMLElement {
  const date = value === null ? null : new Date(value);
  const line = make(tag, "explorer-meta");
  if (!date || !Number.isFinite(date.getTime())) {
    line.textContent = `${label} date unavailable`;
    return line;
  }
  const time = make("time", "", date.toLocaleString());
  time.dateTime = date.toISOString();
  line.append(`${label} `, time);
  return line;
}

function source(item: StashItem): string {
  const url = safeExplorerUrl(item.url);
  return url ? new URL(url).hostname : "Source unavailable";
}

function chips(item: StashItem): HTMLElement {
  const group = make("span", "explorer-chips");
  group.append(make("span", "explorer-chip", item.done ? "Done" : "To read"));
  const summary = item.summary;
  if (!summary) {
    group.append(make("span", "explorer-chip", item.done ? "No saved summary" : "Summary needed"));
    return group;
  }
  for (const value of [summary.category, summary.document_type]) {
    if (value) group.append(make("span", "explorer-chip", value));
  }
  if (summary.importance) {
    const style = summary.importance === "high" ? "explorer-chip explorer-chip-high" : "explorer-chip";
    group.append(make("span", style, `${summary.importance} importance`));
  }
  return group;
}

function row(item: StashItem): HTMLLIElement {
  const entry = make("li");
  const button = make("button", "explorer-row");
  button.type = "button";
  button.dataset.stashId = item.id;
  const file = make("span", "explorer-file");
  file.setAttribute("aria-hidden", "true");
  const content = make("span");
  content.append(make("span", "explorer-row-title", item.title), make("span", "explorer-source", source(item)));
  if (item.summary?.overview) content.append(make("span", "explorer-overview", item.summary.overview));
  const metadata = make("span", "explorer-row-meta");
  metadata.append(timestamp(item.saved_at, "Saved", "span"), chips(item));
  content.append(metadata);
  button.append(file, content);
  button.addEventListener("click", () => select(item));
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
  for (const [id, button] of rows) button.setAttribute("aria-pressed", String(item?.id === id));
  const previous = selected;
  selected = item;
  if (JSON.stringify(previous) === JSON.stringify(item)) return;

  const focus = document.activeElement;
  const hadFocus = focus instanceof HTMLElement && detail.contains(focus);
  if (!item && focus === jumpPreview) filter.focus();
  jumpPreview.hidden = item === null;
  if (!item) {
    detail.replaceChildren(make("p", "explorer-empty", "Select a saved page to preview it."));
    if (hadFocus) filter.focus();
    return;
  }

  const heading = make("h2", "", item.title);
  heading.tabIndex = -1;
  const actions = make("div", "explorer-source-actions");
  const url = safeExplorerUrl(item.url);
  if (url) {
    const open = make("a", "", "Open source ↗");
    open.id = "stash-open-source";
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    actions.append(open);
    if (item.summary) actions.append(action("stash-open-summary", "Open summary", () => openSummary(item)));
  }
  if (!item.done) actions.append(action("stash-complete", "Mark done", () => complete(item)));

  detail.replaceChildren(make("p", "explorer-source", source(item)), heading);
  if (actions.childElementCount) detail.append(actions);
  if (item.summary?.overview) detail.append(make("p", "explorer-overview", item.summary.overview));
  const context = make("div", "explorer-detail-context");
  context.append(chips(item), timestamp(item.saved_at, "Saved"));
  if (item.summary) context.append(timestamp(item.summary.summarized_at, "Summary saved"));
  else if (!item.done) context.append(make("p", "explorer-hint", "Open the source and use Stash in the side panel to try saving its summary."));
  detail.append(context);

  if (previous?.id !== item.id) detail.scrollTop = 0;
  if (hadFocus) {
    const replacement = previous?.id === item.id && focus.id ? document.getElementById(focus.id) : null;
    (replacement ?? (previous?.id === item.id ? heading : rows.get(item.id) ?? heading)).focus();
  }
}

function showItems(page: StashItem[], cursor: string | null, append = false): void {
  const focus = document.activeElement;
  const focusedRow = focus instanceof HTMLButtonElement && list.contains(focus) ? focus.dataset.stashId : null;
  if (!append) {
    list.replaceChildren();
    rows.clear();
  }
  for (const item of page) list.append(row(item));
  items = append ? [...items, ...page] : page;
  next = cursor;
  list.hidden = items.length === 0;
  select(items.find((item) => item.id === selected?.id) ?? items[0] ?? null);
  if (focusedRow && !append) (rows.get(focusedRow) ?? list.querySelector("button") ?? filter).focus();
  const first = page[0];
  if (focus === more && append && first) rows.get(first.id)?.focus();
  else if (focus === more && cursor === null) filter.focus();
  more.hidden = cursor === null;
}

function announceResults(query: string): void {
  empty.hidden = items.length > 0 || next !== null;
  if (!empty.hidden) {
    if (query) empty.textContent = "No saved pages match this search and filter.";
    else if (filter.value === "done") empty.textContent = "No pages marked done yet.";
    else if (filter.value === "open") empty.textContent = "No pages to read. Save a page with Stash in the side panel.";
    else empty.textContent = "No saved pages yet. Save a page with Stash in the side panel.";
  }
  setStatus(empty.hidden ? `Showing ${items.length} saved ${items.length === 1 ? "page" : "pages"}.` : empty.textContent ?? "");
}

function queryText(): string {
  return wellFormed(search.value.trim().slice(0, search.maxLength));
}

async function readPage(expectedRevision: string, after: string | null, generation: number): Promise<void> {
  const query = queryText();
  const page = await host.call({
    type: "list_stash", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
    expected_revision: expectedRevision, state: filter.value, query, after,
  }, "stash_listed");
  if (closed || generation !== filterGeneration) return;
  if (after !== null && page.items.some((item) => rows.has(item.id))) {
    throw new Error("The result page changed. Refresh Stash to continue.");
  }
  showItems(page.items, page.next, after !== null);
  announceResults(query);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const button of [more, ...Array.from(detail.querySelectorAll("button"))]) {
    button.setAttribute("aria-disabled", String(value));
  }
}

async function run(message: string, failure: string, work: () => Promise<void>): Promise<void> {
  const generation = filterGeneration;
  setBusy(true);
  setStatus(message);
  empty.hidden = true;
  try {
    await work();
  } catch (error) {
    if (!closed && generation === filterGeneration) setError(failure, error);
  } finally {
    setBusy(false);
    startReload();
  }
}

function startReload(): void {
  if (closed || busy || debounce !== null || queuedReload === null) return;
  const reload = queuedReload;
  queuedReload = null;
  const generation = filterGeneration;
  void run(reload === "refresh" && revision !== null ? "Refreshing Stash…" : "Loading saved pages…", "Could not load Stash.", async () => {
    if (reload === "refresh" || revision === null) {
      const config = await host.call({
        type: "get_config", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      }, "config_result");
      if (closed) return;
      const currentRevision = config.config_issue || !config.config.storage ? null : config.revision;
      if (currentRevision !== revision) showItems([], null);
      revision = currentRevision;
      if (revision === null && layout.contains(document.activeElement)) refresh.focus();
      layout.hidden = revision === null;
      if (config.config_issue) setStatus("Brauser settings need repair. Open Settings, then refresh Stash.", true);
      else if (revision === null) setStatus("Choose a home folder in Settings to use Stash.");
    }
    if (revision !== null && generation === filterGeneration) await readPage(revision, null, generation);
  });
}

function reload(refreshConfig: boolean): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
  // Collapse queued reads while an action is in flight. Re-read the home
  // revision if any of those reads requested a refresh.
  if (refreshConfig || queuedReload !== "refresh") queuedReload = refreshConfig ? "refresh" : "filter";
  startReload();
}

function openSummary(item: StashItem): void {
  const expectedRevision = revision;
  const summary = item.summary;
  if (busy || !expectedRevision || !summary) return;
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
  const expectedRevision = revision;
  if (busy || !expectedRevision || item.done) return;
  const generation = filterGeneration;
  void run("Marking the page done…", "Could not mark the page done.", async () => {
    await host.call({
      type: "complete_stash", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      expected_revision: expectedRevision, id: item.id, version: item.version,
    }, "stash_completed");
    if (closed || generation !== filterGeneration) return;
    const updated = filter.value === "open" ? items.filter((saved) => saved.id !== item.id)
      : items.map((saved) => saved.id === item.id ? { ...saved, done: true } : saved);
    showItems(updated, next);
    announceResults(queryText());
    setStatus("Marked as done. Find the page in the Done filter.");
  });
}

function filtersChanged(): void {
  filterGeneration += 1;
  showItems([], null);
  empty.hidden = true;
  setStatus("Loading saved pages…");
}

search.addEventListener("input", () => {
  filtersChanged();
  if (debounce !== null) clearTimeout(debounce);
  debounce = setTimeout(() => reload(false), 180);
});
filter.addEventListener("change", () => { filtersChanged(); reload(false); });
refresh.addEventListener("click", () => reload(true));
element<HTMLButtonElement>("stash-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().catch((error: unknown) => setError("Could not open Settings.", error));
});
more.addEventListener("click", () => {
  const expectedRevision = revision;
  const after = next;
  if (busy || !expectedRevision || after === null) return;
  const generation = filterGeneration;
  void run("Loading more saved pages…", "Could not load more saved pages.", () => readPage(expectedRevision, after, generation));
});
jumpPreview.addEventListener("click", () => detail.querySelector("h2")?.focus());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reload(true); });
window.addEventListener("pageshow", (event) => { if (event.persisted) reload(true); });
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  closed = true;
  if (debounce !== null) clearTimeout(debounce);
  host.disconnect();
});

reload(true);
