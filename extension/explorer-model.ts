// Explorer's read-only query/selection state. Requests bind the home revision;
// generations prevent old replies from crossing a filter or selection change.
import type {
  ArtifactContextResult, ExploreArtifactsRequest, ExploreArtifactsResult, ExplorerArtifact,
  ExplorerConnection, ExplorerFacets, ExplorerReadingFilter, IncomingTrailView, LinkedFromView, RecentPageInfo,
} from "../protocol/ts/generated.js";

export const EXPLORER_PAGE_SIZE = 8;

export interface ExplorerFilters {
  query: string;
  source: string;
  artifact_type: string;
  category: string;
  document_type: string;
  reading: "" | ExplorerReadingFilter;
}

export function emptyExplorerFilters(): ExplorerFilters {
  return { query: "", source: "", artifact_type: "", category: "", document_type: "", reading: "" };
}

export type ExplorerQuery = Omit<ExploreArtifactsRequest, "type" | "protocol_version" | "request_id">;

export interface ExplorerTransport {
  explore(query: ExplorerQuery): Promise<ExploreArtifactsResult>;
  context(artifactId: string, revision: string): Promise<ArtifactContextResult>;
}

export interface ExplorerState {
  filters: ExplorerFilters;
  items: ExplorerArtifact[];
  facets: ExplorerFacets;
  total: number;
  libraryTotal: number;
  page: RecentPageInfo | null;
  selected: ExplorerArtifact | null;
  connections: ExplorerConnection[];
  linkedFrom: LinkedFromView | undefined;
  arrivedVia: IncomingTrailView[] | undefined;
  connectionsTruncated: boolean;
  outsideFilters: boolean;
  loading: boolean;
  moreLoading: boolean;
  contextLoading: boolean;
  error: string | null;
  contextError: string | null;
}

function initialState(filters = emptyExplorerFilters()): ExplorerState {
  return {
    filters, items: [], facets: { sources: [], artifact_types: [], categories: [], document_types: [], truncated: false },
    total: 0, libraryTotal: 0, page: null, selected: null, connections: [], connectionsTruncated: false,
    linkedFrom: undefined, arrivedVia: undefined,
    outsideFilters: false, loading: false, moreLoading: false, contextLoading: false, error: null, contextError: null,
  };
}

/** Only explicit links to credential-free HTTP(S) sources leave this page. */
export function safeExplorerUrl(value: string): string | null {
  if (value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function matchesExplorerFilters(item: ExplorerArtifact, filters: ExplorerFilters): boolean {
  const summary = item.summary;
  if (filters.source && item.source !== filters.source) return false;
  if (filters.artifact_type && item.artifact_type !== filters.artifact_type) return false;
  if (filters.category && summary?.category !== filters.category) return false;
  if (filters.document_type && summary?.document_type !== filters.document_type) return false;
  if (filters.reading === "none" && summary !== null) return false;
  if (filters.reading === "unknown" && (!summary || summary.read_scope !== undefined)) return false;
  if (filters.reading === "whole" && summary?.read_scope !== "whole") return false;
  if (filters.reading === "limited" && summary?.read_scope !== "partial" && summary?.read_scope !== "page_only") return false;
  const tokens = filters.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const text = [item.title, item.source, summary?.overview ?? "", item.why ?? ""].join("\n").toLowerCase();
  return tokens.every((token) => text.includes(token));
}

export function explorerErrorText(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  if (value?.code === "invalid_request" && value.message === "invalid or unsupported request JSON") {
    return "Update the Brauser host and extension together to use Artifact Explorer.";
  }
  if (value?.code === "conflict") return "The captured library changed. Refresh Explorer to continue.";
  const message = typeof value?.message === "string" ? value.message : String(error);
  return `Could not read the captured library: ${message}`;
}

/** Response-shape checks validate fields; this checks the continuation contract. */
export function validateExplorerPage(result: ExploreArtifactsResult, offset: number, snapshot?: string): void {
  const page = result.page;
  if (result.items.length > EXPLORER_PAGE_SIZE || !/^[a-f0-9]{64}$/.test(page.snapshot) || page.offset !== offset ||
    (snapshot !== undefined && page.snapshot !== snapshot) ||
    result.total < offset + result.items.length || result.library_total < result.total ||
    new Set(result.items.map((item) => item.artifact_id)).size !== result.items.length ||
    (page.next_offset === null ? offset + result.items.length !== result.total
      : result.items.length === 0 || page.next_offset !== offset + result.items.length || page.next_offset >= result.total)) {
    throw new Error("The captured library page changed. Refresh Explorer to continue.");
  }
}

const TRANSITIONS: Readonly<Record<string, string>> = {
  link: "link navigation", typed: "address navigation", auto_bookmark: "bookmark navigation",
  auto_subframe: "automatic frame navigation", manual_subframe: "manual frame navigation",
  generated: "generated navigation", start_page: "start-page navigation", form_submit: "form submission",
  reload: "reload", keyword: "keyword navigation", keyword_generated: "generated keyword navigation",
};

export function arrivalExplanation(trail: IncomingTrailView): string {
  return `Recorded ${TRANSITIONS[trail.transition] ?? "navigation"} · last recorded ${trail.last_seen}`;
}

export function connectionExplanation(connection: ExplorerConnection): { label: string; detail: string } {
  switch (connection.basis) {
    case "navigation": {
      const label = connection.direction === "incoming" ? "Navigated here from" : "Navigated from here to";
      const observed = TRANSITIONS[connection.transition ?? ""] ?? "navigation";
      return { label, detail: `Recorded ${observed}${connection.last_seen ? ` · last recorded ${connection.last_seen}` : ""}.` };
    }
    case "title_mention": return {
      label: "Title mention",
      detail: connection.direction === "incoming"
        ? "The related artifact's recorded title mentions the selected artifact."
        : "The selected artifact's recorded title mentions this related artifact.",
    };
    case "container": return {
      label: connection.direction === "incoming" ? "Contains" : "Within",
      detail: "Recorded artifact containment.",
    };
    case "same_category": return {
      label: "Same saved category",
      detail: `Shares the saved category ${connection.artifact.summary?.category ?? ""}. This is an association, not a recorded link.`,
    };
  }
}

export class ExplorerController {
  state: ExplorerState = initialState();
  private generation = 0;
  private detailGeneration = 0;
  private revision: string | null = null;
  private disposed = false;

  constructor(private readonly transport: ExplorerTransport, private readonly changed: (state: ExplorerState) => void) {}

  clear(): void {
    this.generation += 1;
    this.detailGeneration += 1;
    this.revision = null;
    this.state = initialState({ ...this.state.filters });
    this.emit();
  }

  async load(revision: string, filters: ExplorerFilters): Promise<void> {
    const generation = ++this.generation;
    this.detailGeneration += 1;
    this.revision = revision;
    this.state = { ...initialState({ ...filters }), loading: true };
    this.emit();
    try {
      const result = await this.transport.explore(this.query({ offset: 0 }));
      if (!this.current(generation)) return;
      validateExplorerPage(result, 0);
      Object.assign(this.state, {
        items: result.items, facets: result.facets, total: result.total,
        libraryTotal: result.library_total, page: result.page, loading: false,
      });
      this.emit();
      if (result.items[0]) await this.select(result.items[0]);
    } catch (error) {
      if (this.current(generation)) {
        this.state.loading = false;
        this.state.error = explorerErrorText(error);
        this.emit();
      }
    }
  }

  async more(): Promise<void> {
    const previous = this.state.page;
    if (this.state.loading || this.state.moreLoading || !previous || previous.next_offset === null || !this.revision) return;
    const generation = this.generation;
    this.state.moreLoading = true;
    this.state.error = null;
    this.emit();
    try {
      const result = await this.transport.explore(this.query({ offset: previous.next_offset, snapshot: previous.snapshot }));
      if (!this.current(generation)) return;
      validateExplorerPage(result, previous.next_offset, previous.snapshot);
      const ids = new Set(this.state.items.map((item) => item.artifact_id));
      if (result.items.some((item) => ids.has(item.artifact_id))) throw new Error("Duplicate artifact in a continuation. Refresh Explorer to continue.");
      this.state.items = [...this.state.items, ...result.items];
      this.state.page = result.page;
      this.state.moreLoading = false;
      this.emit();
    } catch (error) {
      if (this.current(generation)) {
        this.state.moreLoading = false;
        this.state.page = null;
        this.state.error = explorerErrorText(error);
        this.emit();
      }
    }
  }

  async select(item: ExplorerArtifact | string, fromConnection = false): Promise<void> {
    if (!this.revision || this.disposed) return;
    const artifactId = typeof item === "string" ? item : item.artifact_id;
    const selected = typeof item === "string"
      ? this.state.items.find((candidate) => candidate.artifact_id === item) ?? null : item;
    const generation = this.generation;
    const detailGeneration = ++this.detailGeneration;
    Object.assign(this.state, {
      selected, connections: [], connectionsTruncated: false,
      linkedFrom: undefined, arrivedVia: undefined,
      outsideFilters: fromConnection && selected !== null && !matchesExplorerFilters(selected, this.state.filters),
      contextLoading: true, contextError: null,
    });
    this.emit();
    try {
      const result = await this.transport.context(artifactId, this.revision);
      if (!this.current(generation) || detailGeneration !== this.detailGeneration) return;
      if (result.item !== null && result.item.artifact_id !== artifactId) throw new Error("Artifact context did not match the selected artifact.");
      if (result.item !== null && !fromConnection && !matchesExplorerFilters(result.item, this.state.filters)) {
        Object.assign(this.state, {
          selected: null, connections: [], connectionsTruncated: false, contextLoading: false, outsideFilters: false,
          contextError: "This artifact changed and no longer matches the current filters. Refresh Explorer to continue.",
        });
        this.emit();
        return;
      }
      Object.assign(this.state, {
        selected: result.item, connections: result.connections, connectionsTruncated: result.truncated,
        linkedFrom: result.linked_from, arrivedVia: result.arrived_via,
        contextLoading: false,
        contextError: result.item === null ? "This artifact is no longer in the captured library. Refresh Explorer." : null,
        outsideFilters: result.item !== null && fromConnection && !matchesExplorerFilters(result.item, this.state.filters),
      });
      this.emit();
    } catch (error) {
      if (this.current(generation) && detailGeneration === this.detailGeneration) {
        this.state.contextLoading = false;
        this.state.contextError = explorerErrorText(error);
        this.state.connections = [];
        this.emit();
      }
    }
  }

  dispose(): void { this.disposed = true; this.generation += 1; this.detailGeneration += 1; }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private emit(): void { if (!this.disposed) this.changed(this.state); }
  private query(page: ExploreArtifactsRequest["page"]): ExplorerQuery {
    const filters = this.state.filters;
    return {
      expected_revision: this.revision!, query: filters.query.trim() || null, source: filters.source || null,
      artifact_type: filters.artifact_type || null, category: filters.category || null,
      document_type: filters.document_type || null, reading: filters.reading || null,
      limit: EXPLORER_PAGE_SIZE, page,
    };
  }
}
