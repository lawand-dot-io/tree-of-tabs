// When full screen closes the side panel, mark the toolbar button so the tree
// is one click away afterwards. Chrome only lets extensions open the side
// panel in response to a click or shortcut, so it can't come back by itself
// (https://issues.chromium.org/issues/578117954). Panels the user closed
// themselves leave no mark.

const KEY = 'reopenWindows';
const TITLE = 'Show the tab tree again (it was hidden for full screen)';

// Windows whose panel was closed by full screen, kept across worker restarts.
let marked = null;
const load = () => (marked ??= chrome.storage.session.get(KEY).then((stored) => new Set(stored[KEY] ?? [])));
const save = async () => chrome.storage.session.set({ [KEY]: [...(await load())] });

// Badges and titles are set per tab: Chrome has no per-window badge.
async function showOnTab(tabId, on) {
  const title = on ? TITLE : chrome.runtime.getManifest().action.default_title;
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: on ? '•' : '' }),
    chrome.action.setTitle({ tabId, title }),
  ]).catch(() => {});
}

export async function markForReopen(windowId) {
  (await load()).add(windowId);
  await save();
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (tab) await showOnTab(tab.id, true);
}

export async function clearReopen(windowId) {
  if (!(await load()).delete(windowId)) return;
  await save();
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(tabs.map((tab) => showOnTab(tab.id, false)));
}

// Listeners are registered synchronously so events wake the worker.
export function registerReopenBadge() {
  chrome.action.setBadgeBackgroundColor({ color: '#0b57d0' }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' }).catch(() => {});
  // Carry the mark to whichever tab becomes active in a marked window, and
  // drop it from tabs that end up in other windows.
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    showOnTab(tabId, (await load()).has(windowId));
  });
  // A brand new tab can lose its badge while it loads its first page, so
  // apply the mark again as the active tab loads.
  chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
    if (change.status && tab.active && (await load()).has(tab.windowId)) showOnTab(tabId, true);
  });
  chrome.windows.onRemoved.addListener(async (windowId) => {
    if ((await load()).delete(windowId)) await save();
  });
}
