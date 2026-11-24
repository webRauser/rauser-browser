/** The sidebar launches a normal main-area browser tab, reusing one when open. */
type BrowserTabs = Pick<ChromeApi, "runtime" | "tabs" | "windows">;

export function openExplorerPage(chromeApi: BrowserTabs): Promise<void> {
  return openLibraryPage(chromeApi, "explorer.html");
}

export function openStashPage(chromeApi: BrowserTabs): Promise<void> {
  return openLibraryPage(chromeApi, "stash.html");
}

async function openLibraryPage(chromeApi: BrowserTabs, page: string): Promise<void> {
  const url = chromeApi.runtime.getURL(page);
  const contexts = await chromeApi.runtime.getContexts({ contextTypes: ["TAB"] });
  const open = contexts.find((context) => context.documentUrl?.split(/[?#]/, 1)[0] === url);
  if (!open) {
    await chromeApi.tabs.create({ url });
    return;
  }
  try { await chromeApi.tabs.update(open.tabId, { active: true }); }
  catch { await chromeApi.tabs.create({ url }); return; }
  await chromeApi.windows.update(open.windowId, { focused: true });
}
