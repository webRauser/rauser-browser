/** The sidebar launches a normal main-area browser tab, reusing one when open. */
export async function openExplorerPage(chromeApi: Pick<ChromeApi, "runtime" | "tabs" | "windows">): Promise<void> {
  const url = chromeApi.runtime.getURL("explorer.html");
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
