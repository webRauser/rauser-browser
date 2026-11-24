/** The active tab and the address and title passed to `get_artifact`. */
export interface ArtifactPage {
  url: string;
  title: string;
  tabId: number | undefined;
}

export function samePage(a: ArtifactPage | null, b: ArtifactPage | null): boolean {
  return a !== null && b !== null && a.tabId === b.tabId && a.url === b.url && a.title === b.title;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Return the ID of a bounded refresh hint for the current policy. */
export function outboundPublication(value: unknown, revision: string | null): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const hint = value as Record<string, unknown>;
  if (Object.keys(hint).length !== 3 || !Object.hasOwn(hint, "version") ||
      !Object.hasOwn(hint, "policy_revision") || !Object.hasOwn(hint, "observation_id")) return null;
  const { version, policy_revision, observation_id } = hint;
  return version === 1 && typeof policy_revision === "string" && policy_revision.length > 0 &&
      policy_revision.length <= 128 && policy_revision === revision &&
      typeof observation_id === "string" && observation_id.length === 36 && UUID.test(observation_id)
    ? observation_id : null;
}

/**
 * Whether a `tabs.onUpdated` event can change what the panel shows: only a
 * title, address, or load completion of the tab the panel follows. Other
 * tabs' events (a background tab's unread counter, another page finishing
 * loading) are ignored. Before the panel knows its tab, an active tab may be
 * the one it shows.
 */
export function followsTabUpdate(
  tabId: number,
  changeInfo: { title?: string; url?: string; status?: string },
  tab: { active?: boolean },
  followedTabId: number | null,
): boolean {
  if (followedTabId === null ? tab.active !== true : tabId !== followedTabId) return false;
  return changeInfo.title !== undefined || changeInfo.url !== undefined ||
    changeInfo.status === "complete";
}

/** Whether `tabs.onReplaced` swapped out the tab the panel follows. Chrome
 * can replace the active tab (prerender, Instant) without `onActivated`, and
 * {@link followsTabUpdate} would then ignore the replacement's updates. */
export function followsTabReplacement(
  _addedTabId: number,
  removedTabId: number,
  followedTabId: number | null,
): boolean {
  return followedTabId === null || removedTabId === followedTabId;
}

/** Whether the worker delivered capture records between two status polls:
 * its delivery generation moved. Delivery can change the shown artifact's
 * totals, which {@link ArtifactRefresher} would otherwise not ask about
 * again. Queue length cannot tell: it can be empty before and after. */
export function deliveredSince(previous: number | null, generation: number): boolean {
  return previous !== null && generation !== previous;
}

/**
 * Keeps the artifact card's `get_artifact` requests in step with the page
 * without asking the host more than it must: each request reads the index
 * under the host's exclusive configuration lock, which capture delivery and
 * note saves also wait for. A page whose answer is shown or on its way is
 * not asked again unless the caller forces it (its history changed). Bursts
 * coalesce: at most one request is in flight, followed by at most one more
 * for whichever page is current when it finishes. An answer is shown only
 * while its page and the page/host/config context that asked for it are
 * still current. Call clear when that context changes.
 */
export class ArtifactRefresher<R> {
  private asked: ArtifactPage | null = null;
  private wanted = false;
  private looping = false;
  private generation = 0;
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly fetch: (page: ArtifactPage) => Promise<R>,
    private readonly current: () => ArtifactPage | null,
    private readonly render: (page: ArtifactPage, result: R) => void,
    private readonly fail: (page: ArtifactPage, error: unknown) => void,
  ) {}

  /** Refresh the card for the current page. The promise settles once an
   * answer at least as new as this call has been handled. */
  refresh(force = false): Promise<void> {
    const page = this.current();
    if (!page || (!force && samePage(this.asked, page))) return this.idle();
    this.wanted = true;
    if (!this.looping) this.running = this.loop();
    return this.running;
  }

  /** Discard pending replies across page, configuration and host changes. */
  clear(): void {
    this.generation++;
    this.asked = null;
    this.wanted = false;
  }

  private idle(): Promise<void> {
    return this.looping ? this.running : Promise.resolve();
  }

  private async loop(): Promise<void> {
    this.looping = true;
    try {
      while (this.wanted) {
        this.wanted = false;
        const page = this.current();
        if (!page) {
          this.asked = null;
          return;
        }
        this.asked = page;
        const generation = this.generation;
        const stillCurrent = () => generation === this.generation && samePage(page, this.current());
        try {
          const result = await this.fetch(page);
          if (stillCurrent()) this.render(page, result);
          else if (this.asked === page) this.asked = null;
        } catch (error) {
          // Ask again next time rather than keep a page with no answer.
          if (this.asked === page) this.asked = null;
          if (stillCurrent()) this.fail(page, error);
        }
      }
    } finally {
      this.looping = false;
    }
  }
}
