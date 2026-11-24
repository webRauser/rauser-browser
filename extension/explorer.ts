// A full browser tab over the local captured library. This page starts no
// agent, changes no capture policy, and writes no artifact metadata.
import type { ArtifactRefView, ExplorerArtifact, ExplorerConnection, ExplorerFacet } from "../protocol/ts/generated.js";
import { manifestBuild } from "./build-update.js";
import { initDiag } from "./diag.js";
import {
  ExplorerController, arrivalExplanation, connectionExplanation, emptyExplorerFilters, explorerErrorText, safeExplorerUrl,
  type ExplorerFilters, type ExplorerState,
} from "./explorer-model.js";
import { HostClient, HostError, PROTOCOL_VERSION, UNSUPPORTED_REQUEST_TEXT, newRequestId } from "./native.js";
import { artifactLook, compactDuration } from "./panel-look.js";
import { describe, element } from "./settings.js";
import { readScopeText } from "./summary-text.js";
import { POLICY_STORAGE_KEY, isPolicyLease } from "./model.js";

initDiag("explorer");

const host = new HostClient();
const status = element<HTMLParagraphElement>("explorer-status");
const layout = element<HTMLDivElement>("explorer-layout");
const search = element<HTMLInputElement>("explorer-search");
const source = element<HTMLSelectElement>("explorer-source");
const category = element<HTMLSelectElement>("explorer-category");
const artifactType = element<HTMLSelectElement>("explorer-artifact-type");
const documentType = element<HTMLSelectElement>("explorer-document-type");
const reading = element<HTMLSelectElement>("explorer-reading");
const list = element<HTMLUListElement>("explorer-list");
const map = element<HTMLElement>("explorer-map");
const detail = element<HTMLElement>("explorer-detail");
const more = element<HTMLButtonElement>("explorer-more");
const refresh = element<HTMLButtonElement>("explorer-refresh");
const listView = element<HTMLButtonElement>("explorer-list-view");
const mapView = element<HTMLButtonElement>("explorer-map-view");
const jumpPreview = element<HTMLButtonElement>("explorer-jump-preview");
const count = element<HTMLParagraphElement>("explorer-count");
const empty = element<HTMLParagraphElement>("explorer-empty");
const noMatches = element<HTMLParagraphElement>("explorer-no-matches");
const facetNote = element<HTMLParagraphElement>("explorer-facet-note");

let revision: string | null = null;
let ready = false;
let openingGeneration = 0;
let closed = false;
let view: "list" | "map" = "list";
let bootMessage: string | null = "Waiting for the native host…";
let bootProblem = false;
let renderedList = "";
let renderedDetail = "";
let previewedArtifactId: string | null = null;
let renderedMap = "";
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const rows = new Map<string, HTMLButtonElement>();
const facetKeys = new WeakMap<HTMLSelectElement, string>();

const controller = new ExplorerController({
  explore: (query) => host.call({ type: "explore_artifacts", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(), ...query }, "explore_artifacts_result"),
  context: (artifactId, expectedRevision) => host.call({
    type: "get_artifact_context", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
    expected_revision: expectedRevision, artifact_id: artifactId,
  }, "artifact_context_result"),
}, render);

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function filters(): ExplorerFilters {
  const value = reading.value;
  return {
    query: search.value.trim(), source: source.value, category: category.value,
    artifact_type: artifactType.value, document_type: documentType.value,
    reading: ["limited", "whole", "unknown", "none"].includes(value) ? value as ExplorerFilters["reading"] : "",
  };
}

function setStatus(text: string, problem = false): void {
  status.textContent = text;
  status.classList.toggle("problem", problem);
}

function fillFacet(select: HTMLSelectElement, values: readonly ExplorerFacet[], selected: string, all: string): void {
  const key = JSON.stringify([values, selected]);
  if (facetKeys.get(select) === key) return;
  facetKeys.set(select, key);
  select.replaceChildren(new Option(all, ""));
  for (const facet of values) {
    if (facet.value) select.add(new Option(`${facet.value} (${facet.count})`, facet.value));
  }
  if (selected && !values.some((facet) => facet.value === selected)) select.add(new Option(selected, selected));
  select.value = selected;
}

function chips(item: ExplorerArtifact): HTMLElement {
  const group = make("span", "explorer-chips");
  if (item.summary) {
    for (const value of [item.summary.category, item.summary.document_type]) {
      if (value) group.append(make("span", "explorer-chip", value));
    }
    const importanceClass = item.summary.importance === "high" ? "explorer-chip explorer-chip-high" : "explorer-chip";
    group.append(make("span", importanceClass, `${item.summary.importance} importance`));
  } else group.append(make("span", "explorer-chip", "No saved summary"));
  return group;
}

function row(item: ExplorerArtifact): HTMLLIElement {
  const entry = make("li");
  const button = make("button", "explorer-row");
  button.type = "button";
  button.dataset.artifactId = item.artifact_id;
  const file = make("span", "explorer-file");
  file.setAttribute("aria-hidden", "true");
  const content = make("span");
  content.append(
    make("span", "explorer-row-title", item.title || item.artifact_id),
    make("span", "explorer-source", `${item.source || "Source not recorded"} · ${artifactLook(item.artifact_type).label}`),
  );
  if (item.summary?.overview) content.append(make("span", "explorer-overview", item.summary.overview));
  const metadata = make("span", "explorer-row-meta");
  metadata.append(
    make("span", "explorer-meta", `Last recorded ${item.last_seen} · ${compactDuration(item.focused_seconds)} focused`),
    chips(item),
  );
  content.append(metadata);
  button.append(file, content);
  button.addEventListener("click", () => { void controller.select(item); });
  rows.set(item.artifact_id, button);
  entry.append(button);
  return entry;
}

function connectionButton(connection: ExplorerConnection): HTMLButtonElement {
  const button = make("button", `explorer-connection${connection.basis === "same_category" ? " association" : ""}`);
  button.type = "button";
  button.dataset.artifactId = connection.artifact.artifact_id;
  const explanation = connectionExplanation(connection);
  button.append(make("span", "explorer-basis", explanation.label));
  button.append(make("strong", "", connection.artifact.title || connection.artifact.artifact_id));
  button.append(make("span", "explorer-source", connection.artifact.source || "Source not recorded"));
  button.append(make("span", "explorer-explanation", explanation.detail));
  button.addEventListener("click", () => { void controller.select(connection.artifact, true); });
  return button;
}

function renderConnections(state: ExplorerState): HTMLElement[] {
  const nodes: HTMLElement[] = [make("h3", "", "Related artifacts")];
  if (state.contextLoading) nodes.push(make("p", "explorer-hint", "Reading recorded connections…"));
  else if (state.contextError) nodes.push(make("p", "explorer-hint", state.contextError));
  else if (!state.connections.length) nodes.push(make("p", "explorer-hint", "No connections are recorded for this artifact yet."));
  else {
    const links = make("ul", "explorer-connections");
    for (const connection of state.connections) {
      const entry = make("li"); entry.append(connectionButton(connection)); links.append(entry);
    }
    nodes.push(links);
  }
  if (state.connectionsTruncated) nodes.push(make("p", "explorer-hint", "More connections are available than this preview shows."));
  return nodes;
}

function evidenceSource(source: ArtifactRefView, description: string | Node): HTMLLIElement {
  const row = make("li");
  const select = make("button", "explorer-evidence-source");
  select.type = "button";
  const label = make("strong", "", source.title || source.artifact_id);
  const explanation = make("span", "explorer-explanation");
  explanation.append(description);
  select.append(label, explanation);
  select.addEventListener("click", () => {
    void controller.select(source.artifact_id, true).then(() => {
      if (controller.state.selected?.artifact_id === source.artifact_id) detail.querySelector("h2")?.focus();
    });
  });
  row.append(select);
  return row;
}

function renderLinkEvidence(state: ExplorerState): HTMLElement[] {
  const backlinks = make("section", "explorer-related");
  backlinks.append(make("h3", "", "Linked from"));
  if (state.linkedFrom === undefined) {
    backlinks.append(make("p", "explorer-hint", "Link history is unavailable."));
  } else if (!state.linkedFrom.items.length) {
    backlinks.append(make("p", "explorer-hint", "No links to this artifact recorded in this library."));
  } else {
    backlinks.append(make("p", "explorer-hint", "Previously observed links to this artifact."));
    const list = make("ul", "explorer-connections");
    for (const item of state.linkedFrom.items) {
      const observed = make("time", "", item.observed_at.replace("T", " "));
      observed.dateTime = item.observed_at;
      const scope = item.frame_scope === "top_document" ? "top document" : "selected document";
      const coverage = item.coverage.state === "partial" ? " · partial scan" : "";
      const description = document.createDocumentFragment();
      description.append("Observed ", observed, ` · ${scope}${coverage}`);
      list.append(evidenceSource(item.source, description));
    }
    backlinks.append(list);
  }
  if (state.linkedFrom?.truncated) {
    backlinks.append(make("p", "explorer-hint", "More recorded sources are available than this preview shows."));
  }

  const arrival = make("section", "explorer-related");
  arrival.append(make("h3", "", "Arrived via"));
  if (state.arrivedVia === undefined) {
    arrival.append(make("p", "explorer-hint", "Recorded navigation is unavailable."));
  } else if (!state.arrivedVia.length) {
    arrival.append(make("p", "explorer-hint", "No known incoming source recorded."));
  } else {
    arrival.append(make("p", "explorer-hint", "Recorded navigation from recognized artifacts."));
    const list = make("ul", "explorer-connections");
    list.append(...state.arrivedVia.map((trail) => evidenceSource(trail.source, arrivalExplanation(trail))));
    arrival.append(list);
  }
  return [backlinks, arrival];
}

async function openSummary(item: ExplorerArtifact, button: HTMLButtonElement): Promise<void> {
  const expectedRevision = revision;
  if (!item.summary || expectedRevision === null || closed || button.getAttribute("aria-disabled") === "true") return;
  button.setAttribute("aria-disabled", "true");
  try {
    await host.call({
      type: "open_summary", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      url: item.url, summary_path: item.summary.summary_path, expected_revision: expectedRevision,
    }, "summary_opened");
    if (!closed && controller.state.selected?.artifact_id === item.artifact_id) setStatus("Opened the saved summary.");
  } catch (error) {
    if (!closed && controller.state.selected?.artifact_id === item.artifact_id) setStatus(`Could not open the saved summary: ${describe(error)}`, true);
  } finally { button.setAttribute("aria-disabled", "false"); }
}

function renderDetail(state: ExplorerState): void {
  const key = JSON.stringify([state.selected, state.connections, state.contextLoading, state.contextError,
    state.connectionsTruncated, state.outsideFilters, state.linkedFrom, state.arrivedVia]);
  if (key === renderedDetail) return;
  renderedDetail = key;
  const focused = document.activeElement;
  const ownedFocus = focused instanceof HTMLElement && detail.contains(focused);
  const focusedId = ownedFocus ? focused.id : "";
  detail.replaceChildren();
  const item = state.selected;
  const selectionChanged = previewedArtifactId !== (item?.artifact_id ?? null);
  previewedArtifactId = item?.artifact_id ?? null;
  if (!item) {
    detail.append(make("p", "explorer-empty", state.contextLoading ? "Reading recorded context…" :
      state.contextError ?? "Select an artifact to inspect its saved context and connections."));
    if (ownedFocus) search.focus();
    return;
  }
  detail.append(make("p", "explorer-source", `${item.source || "Source not recorded"} · ${artifactLook(item.artifact_type).label}`));
  const heading = make("h2", "", item.title || item.artifact_id);
  heading.tabIndex = -1;
  detail.append(heading);
  if (state.outsideFilters) detail.append(make("p", "explorer-outside", "You followed a connection to an artifact outside the current filters. The list keeps your filters."));
  const actions = make("div", "explorer-source-actions");
  const url = safeExplorerUrl(item.url);
  if (url) {
    const original = make("a", "", "Open original source ↗");
    original.id = "explorer-open-source";
    original.href = url; original.target = "_blank"; original.rel = "noopener noreferrer";
    actions.append(original);
  }
  const summaryButton = make("button", "", "Open saved summary");
  summaryButton.type = "button"; summaryButton.id = "explorer-open-summary";
  summaryButton.hidden = item.summary === null || url === null;
  summaryButton.addEventListener("click", () => { void openSummary(item, summaryButton); });
  actions.append(summaryButton);
  if (url) detail.append(actions);
  if (item.summary?.overview) detail.append(make("p", "explorer-overview", item.summary.overview));
  const context = make("div", "explorer-detail-context");
  context.append(chips(item), make("p", "explorer-meta", `First recorded ${item.first_seen} · last recorded ${item.last_seen}`));
  if (item.summary) {
    context.append(
      make("p", "explorer-meta", `Summary saved ${new Date(item.summary.summarized_at).toLocaleString()}`),
      make("p", "explorer-meta", readScopeText(item.summary.read_scope) ?? "Reading coverage was not recorded for this saved summary."),
    );
  }
  if (item.why) context.append(make("p", "explorer-why", `Saved context: ${item.why}`));
  const related = make("div", "explorer-related");
  related.append(...renderConnections(state));
  detail.append(context);
  if (!state.contextLoading) detail.append(...renderLinkEvidence(state));
  detail.append(related);
  if (selectionChanged) detail.scrollTop = 0;
  if (ownedFocus) {
    const replacement = focusedId ? document.getElementById(focusedId) : null;
    if (replacement instanceof HTMLElement && detail.contains(replacement) && !replacement.hidden) replacement.focus();
    else heading.focus();
  }
}

function renderMap(state: ExplorerState): void {
  const key = JSON.stringify([view, state.selected, state.connections, state.contextLoading, state.contextError]);
  if (key === renderedMap) return;
  renderedMap = key;
  const hadFocus = document.activeElement instanceof HTMLElement && map.contains(document.activeElement);
  map.replaceChildren();
  if (view !== "map" || !state.selected) return;
  const center = make("div", "explorer-map-center");
  center.append(make("span", "explorer-kicker", "Selected artifact"), make("strong", "", state.selected.title || state.selected.artifact_id));
  map.append(center);
  const neighbors = make("ul", "explorer-map-neighbors");
  for (const connection of state.connections) {
    const entry = make("li"); entry.append(connectionButton(connection)); neighbors.append(entry);
  }
  map.append(neighbors);
  if (state.contextLoading) map.append(make("p", "explorer-hint", "Reading recorded connections…"));
  else if (state.contextError) map.append(make("p", "explorer-hint", state.contextError));
  else if (!state.connections.length) map.append(make("p", "explorer-hint", "No recorded connections to show."));
  map.append(make("p", "explorer-map-note", "Solid borders mark recorded evidence. Dashed borders mark a shared saved category. The same connections remain available in the preview."));
  if (hadFocus) detail.querySelector("h2")?.focus();
}

function render(state: ExplorerState): void {
  if (closed) return;
  const pagerHadFocus = document.activeElement === more;
  let firstAppended: HTMLButtonElement | null = null;
  layout.hidden = !ready;
  if (bootMessage !== null) setStatus(bootMessage, bootProblem);
  else if (state.error) setStatus(state.error, true);
  else if (state.loading) setStatus("Loading captured artifacts…");
  else if (state.moreLoading) setStatus("Loading more artifacts…");
  else setStatus(`Showing ${state.items.length} of ${state.total} matching artifact${state.total === 1 ? "" : "s"}.`);
  fillFacet(source, state.facets.sources, state.filters.source, "All sources");
  fillFacet(category, state.facets.categories, state.filters.category, "All categories");
  fillFacet(artifactType, state.facets.artifact_types, state.filters.artifact_type, "All artifact types");
  fillFacet(documentType, state.facets.document_types, state.filters.document_type, "All document types");
  facetNote.hidden = !state.facets.truncated;
  count.textContent = `${state.libraryTotal} in library`;
  const key = state.items.map((item) => item.artifact_id).join("\n");
  if (key !== renderedList) {
    const previousCount = rows.size;
    const previousIds = [...rows.keys()];
    const appending = previousCount > 0 && previousIds.every((id, index) => state.items[index]?.artifact_id === id);
    if (!appending) { list.replaceChildren(); rows.clear(); }
    for (const item of state.items.slice(appending ? previousCount : 0)) list.append(row(item));
    if (appending) firstAppended = rows.get(state.items[previousCount]?.artifact_id ?? "") ?? null;
    renderedList = key;
  }
  for (const [id, button] of rows) button.setAttribute("aria-pressed", String(state.selected?.artifact_id === id));
  empty.hidden = !ready || state.loading || !!state.error || state.libraryTotal !== 0;
  noMatches.hidden = !ready || state.loading || !!state.error || state.libraryTotal === 0 || state.total !== 0;
  const mapShown = view === "map" && state.selected !== null;
  if (state.selected === null && document.activeElement === jumpPreview) search.focus();
  jumpPreview.hidden = state.selected === null;
  list.hidden = mapShown || state.items.length === 0;
  map.hidden = !mapShown;
  mapView.disabled = state.selected === null;
  mapView.setAttribute("aria-pressed", String(mapShown));
  listView.setAttribute("aria-pressed", String(!mapShown));
  const hideMore = mapShown || state.page?.next_offset == null;
  // Hiding a focused native button moves Chrome's focus to the body. Move it
  // before hiding, and only if the user has not focused something else.
  if (hideMore && pagerHadFocus) {
    if (firstAppended && !mapShown) firstAppended.focus();
    else if (state.error) refresh.focus();
  }
  more.hidden = hideMore;
  more.setAttribute("aria-disabled", String(state.moreLoading));
  renderDetail(state);
  renderMap(state);
}

async function loadFilters(): Promise<void> {
  if (!ready || revision === null || closed) return;
  view = "list";
  bootMessage = null;
  await controller.load(revision, filters());
}

async function initialize(): Promise<void> {
  const generation = ++openingGeneration;
  ready = false; revision = null; bootProblem = false; bootMessage = "Waiting for the native host…";
  controller.clear();
  try {
    const build = manifestBuild(chrome.runtime.getManifest());
    const validBuild = build !== null && /^[0-9A-Za-z .+()_-]{1,128}$/.test(build) ? build : null;
    try {
      await host.call({ type: "hello", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(), ...(validBuild ? { extension_build: validBuild } : {}) }, "hello_result");
    } catch (error) {
      if (!(validBuild && error instanceof HostError && error.code === "invalid_request" && error.message === UNSUPPORTED_REQUEST_TEXT)) throw error;
      await host.call({ type: "hello", protocol_version: PROTOCOL_VERSION, request_id: newRequestId() }, "hello_result");
    }
    const response = await host.call({ type: "get_config", protocol_version: PROTOCOL_VERSION, request_id: newRequestId() }, "config_result");
    if (closed || generation !== openingGeneration) return;
    if (response.config_issue) {
      bootMessage = "Brauser settings need repair. Open Settings to repair them, then refresh Explorer."; bootProblem = true; render(controller.state); return;
    }
    if (!response.config.storage) {
      bootMessage = "Choose a home folder in Settings to browse captured artifacts."; render(controller.state); return;
    }
    revision = response.revision; ready = true; bootMessage = null;
    await loadFilters();
  } catch (error) {
    if (!closed && generation === openingGeneration) {
      bootMessage = explorerErrorText(error); bootProblem = true; render(controller.state);
    }
  }
}

function invalidateLibrary(message: string): void {
  openingGeneration += 1;
  ready = false;
  revision = null;
  bootProblem = true;
  bootMessage = message;
  controller.clear();
}

host.onHostExit(() => {
  if (!closed) invalidateLibrary("Artifact history is unavailable because the native host disconnected. Refresh Explorer to continue.");
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (closed || area !== "local" || !(POLICY_STORAGE_KEY in changes)) return;
  const lease = changes[POLICY_STORAGE_KEY]!.newValue;
  if (!isPolicyLease(lease)) invalidateLibrary("Settings changed. Refresh Explorer to continue.");
  else if (lease.revision !== revision) void initialize();
});

refresh.addEventListener("click", () => { void initialize(); });
element<HTMLButtonElement>("explorer-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().catch((error: unknown) => setStatus(`Could not open settings: ${describe(error)}`, true));
});
search.addEventListener("input", () => {
  // Invalidate immediately: an older query/detail must not reappear during debounce.
  if (searchTimer !== null) clearTimeout(searchTimer);
  controller.clear();
  searchTimer = setTimeout(() => { searchTimer = null; void loadFilters(); }, 180);
});
for (const select of [source, category, artifactType, documentType, reading]) select.addEventListener("change", () => { void loadFilters(); });
more.addEventListener("click", () => {
  const oldCount = controller.state.items.length;
  const focused = document.activeElement === more;
  void controller.more().then(() => {
    if (focused && document.activeElement === more) rows.get(controller.state.items[oldCount]?.artifact_id ?? "")?.focus();
  });
});
listView.addEventListener("click", () => { view = "list"; render(controller.state); });
mapView.addEventListener("click", () => { view = "map"; render(controller.state); });
jumpPreview.addEventListener("click", () => { detail.querySelector("h2")?.focus(); });
window.addEventListener("pagehide", () => {
  closed = true; openingGeneration += 1; controller.dispose(); host.disconnect();
  if (searchTimer !== null) clearTimeout(searchTimer);
});

// Defaults are also the clear state used before setup or after a failed read.
controller.state.filters = emptyExplorerFilters();
void initialize();
