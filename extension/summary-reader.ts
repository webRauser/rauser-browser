// One in-page reader for every saved-summary action. The host selects the
// file and source. Markdown controls formatting only through locally created
// elements, and only explicit HTTP(S) links can navigate out of the reader.
import type { Token } from "markdown-it";
import MarkdownIt from "./vendor/markdown-it.js";
import { safeExplorerUrl } from "./explorer-model.js";
import { HostError, PROTOCOL_VERSION, UNSUPPORTED_REQUEST_TEXT, newRequestId, type HostClient } from "./native.js";

const markdown = new MarkdownIt({ html: false, linkify: false });
const formatting = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li",
  "em", "strong", "s", "table", "thead", "tbody", "tr", "th", "td",
]);

function externalLink(link: HTMLAnchorElement, href: string): void {
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
}

function writeTokens(root: HTMLElement, tokens: Token[]): void {
  const stack = [root];
  for (const token of tokens) {
    if (token.hidden) continue;
    const parent = stack[stack.length - 1]!;
    if (token.type === "inline") {
      writeTokens(parent, token.children ?? []);
    } else if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else if (token.nesting === 1) {
      const href = token.type === "link_open" ? safeExplorerUrl(String(token.attrGet("href") ?? "")) : null;
      const child = href ? document.createElement("a") :
        document.createElement(formatting.has(token.tag) ? token.tag : "span");
      if (href) externalLink(child as HTMLAnchorElement, href);
      const start = token.type === "ordered_list_open" ? token.attrGet("start") : null;
      if (start !== null) child.setAttribute("start", String(start));
      parent.append(child);
      stack.push(child);
    } else if (token.type === "fence" || token.type === "code_block") {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = token.content;
      pre.append(code);
      parent.append(pre);
    } else if (token.type === "code_inline") {
      const code = document.createElement("code");
      code.textContent = token.content;
      parent.append(code);
    } else if (token.type === "hardbreak" || token.type === "hr") {
      parent.append(document.createElement(token.type === "hr" ? "hr" : "br"));
    } else {
      parent.append(token.type === "softbreak" ? "\n" : token.content);
    }
  }
}

let activeReader: HTMLDialogElement | null = null;

export function closeSummaryReader(): void {
  const drawer = activeReader;
  if (!drawer) return;
  drawer.close();
  drawer.remove();
  activeReader = null;
}

interface SummarySelection {
  url: string;
  path: string | null;
  title?: string | undefined;
  revision?: string | null | undefined;
}

export async function openSummaryReader(host: Pick<HostClient, "call">, selection: SummarySelection): Promise<void> {
  closeSummaryReader();
  const drawer = document.createElement("dialog");
  drawer.className = "summary-reader";
  drawer.setAttribute("aria-labelledby", "summary-reader-title");

  const header = document.createElement("header");
  const heading = document.createElement("h1");
  heading.id = "summary-reader-title";
  heading.textContent = selection.title || "Saved summary";
  heading.title = heading.textContent;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "summary-reader-close";
  close.setAttribute("aria-label", "Close summary");
  close.setAttribute("autofocus", "");
  close.addEventListener("click", () => drawer.close());
  const source = document.createElement("a");
  source.className = "summary-reader-source";
  source.textContent = "Open source";
  source.hidden = true;
  header.append(heading, close, source);

  const content = document.createElement("div");
  content.className = "summary-reader-content";
  content.tabIndex = 0;
  content.setAttribute("role", "region");
  content.setAttribute("aria-label", "Summary text");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Loading summary…";
  content.append(status);
  drawer.append(header, content);

  // Chrome handles Escape, trapping focus and returning it to the opening
  // control. A pointer starting and ending on the backdrop also dismisses.
  let pressedBackdrop = false;
  drawer.addEventListener("pointerdown", (event) => { pressedBackdrop = event.target === drawer; });
  drawer.addEventListener("click", (event) => {
    if (pressedBackdrop && event.target === drawer) drawer.close();
  });
  drawer.addEventListener("close", () => {
    drawer.remove();
    if (activeReader === drawer) activeReader = null;
  });
  document.body.append(drawer);
  activeReader = drawer;
  drawer.showModal();

  try {
    const summary = await host.call({
      type: "read_summary", protocol_version: PROTOCOL_VERSION, request_id: newRequestId(),
      url: selection.url, summary_path: selection.path,
      ...(selection.revision ? { expected_revision: selection.revision } : {}),
    }, "summary_read");
    if (!drawer.open) return;
    if (summary.title.trim()) {
      heading.textContent = summary.title;
      heading.title = summary.title;
    }
    const href = safeExplorerUrl(summary.source_url);
    if (href) {
      externalLink(source, href);
      source.hidden = false;
    }
    if (!summary.body.trim()) {
      status.textContent = "This summary has no text.";
      return;
    }
    const article = document.createElement("article");
    writeTokens(article, markdown.parse(summary.body, {}));
    content.replaceChildren(article);
  } catch (error) {
    if (!drawer.open) return;
    const detail = error instanceof HostError && error.code === "invalid_request" && error.message === UNSUPPORTED_REQUEST_TEXT
      ? "Update the Brauser native host to read saved summaries here."
      : error instanceof Error ? error.message : String(error);
    status.textContent = `Could not read the summary. ${detail}`;
  }
}
