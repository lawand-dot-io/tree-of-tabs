import {
  ancestorsOf,
  buildTree,
  descendantsOf,
  flatten,
  inferParent,
  planMove,
  releaseChildren,
  sanitize,
} from './tree.js';
import { DEFAULTS, loadSettings, onSettingsChanged } from './settings.js';

// Tree state for every window, keyed by tab id. Sibling order is the native
// tab order, which this worker keeps consistent with the tree.
const state = {
  parents: new Map(), // tabId -> parentId | null
  collapsed: new Set(), // tabIds whose subtree is collapsed
};
let settings = { ...DEFAULTS };
let ready = false;

// Moves we started ourselves, so their onMoved events are not mistaken for
// the user dragging tabs in the tab strip.
const expectedMoves = new Map(); // tabId -> { count, until }
// Where a tab we are about to create should land once onCreated arrives.
const pendingPlacements = new Map(); // tabId -> { targetId, position }
// Tabs we are moving to another window together with their subtrees.
const crossWindowMoves = new Map(); // tabId -> placement | null
// Tabs that a page opened (a link, a middle click, a script), with the tab
// whose page opened them. These become children of that tab. A tab's
// openerTabId is not enough in general: Chrome also sets it, to whatever tab
// is active, for tabs opened from its own interface (an options page, a
// bookmark). Chrome doesn't report links opened from extension pages,
// though, so for those the opener is used (see onCreated).
const openedFrom = new Map(); // tabId -> source tabId

// Blank new tabs (Ctrl+T), for the "Open new tabs as children" setting.
const NEW_TAB_URLS = ['chrome://newtab/', 'chrome://new-tab-page/', 'chrome-search://local-ntp/local-ntp.html'];

// --- Serialization -----------------------------------------------------------
// Every event and command runs one after the other, so each sees the result
// of the previous one and never interleaves with it.

let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task).catch((error) => console.error('[tree-of-tabs]', error));
  queue = run;
  return run;
}

// --- Window helpers ----------------------------------------------------------

async function windowTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  tabs.sort((a, b) => a.index - b.index);
  return {
    tabs,
    order: tabs.filter((t) => !t.pinned).map((t) => t.id),
    pinnedCount: tabs.filter((t) => t.pinned).length,
  };
}

function expectMove(tabId) {
  const entry = expectedMoves.get(tabId) ?? { count: 0 };
  entry.count++;
  entry.until = Date.now() + 3000;
  expectedMoves.set(tabId, entry);
}

function consumeExpectedMove(tabId) {
  const entry = expectedMoves.get(tabId);
  if (!entry) return false;
  if (--entry.count <= 0 || entry.until < Date.now()) expectedMoves.delete(tabId);
  return entry.until >= Date.now();
}

const isDragError = (error) => /dragging/i.test(String(error?.message ?? error));

/**
 * Moves tabs so the unpinned part of the window matches `desired`. Moves one
 * tab at a time from the front, which needs at most one move per tab.
 */
async function applyOrder(windowId, desired) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { order, pinnedCount } = await windowTabs(windowId);
    const present = new Set(order);
    const target = desired.filter((id) => present.has(id));
    const placed = new Set(target);
    for (const id of order) if (!placed.has(id)) target.push(id);

    const current = order.slice();
    let moved = false;
    for (let i = 0; i < target.length; i++) {
      if (current[i] === target[i]) continue;
      const id = target[i];
      expectMove(id);
      try {
        await chrome.tabs.move(id, { index: pinnedCount + i });
      } catch (error) {
        expectedMoves.delete(id);
        // Chrome refuses to move tabs while the user drags one in the tab
        // strip. Try again once the drag is over.
        if (isDragError(error)) return retryLayoutLater(windowId);
        throw error;
      }
      current.splice(current.indexOf(id), 1);
      current.splice(i, 0, id);
      moved = true;
    }
    if (!moved) return;
  }
}

const layoutRetryTimers = new Map(); // windowId -> timer
function retryLayoutLater(windowId) {
  clearTimeout(layoutRetryTimers.get(windowId));
  layoutRetryTimers.set(
    windowId,
    setTimeout(() => {
      layoutRetryTimers.delete(windowId);
      enqueue(() => relayout(windowId));
    }, 300),
  );
}

async function relayout(windowId) {
  const { order } = await windowTabs(windowId);
  await applyOrder(windowId, flatten(buildTree(order, state.parents)));
  await commit(windowId);
}

/** Applies a planMove() to the state and the tab strip. */
async function applyMove(windowId, ids, targetId, position) {
  const { order } = await windowTabs(windowId);
  const plan = planMove(order, state.parents, { ids, targetId, position, collapsed: state.collapsed });
  if (!plan) return false;
  // Tabs whose onCreated is still queued are left for that handler.
  for (const [id, parent] of plan.parents) if (state.parents.has(id)) state.parents.set(id, parent);
  await applyOrder(windowId, plan.order);
  return true;
}

function releaseTab(tabId, order) {
  // With 'closeAll' the children of a closed tab are closing too; a tab that
  // is pinned or moved to another window stays open, so its children stay
  // and the first one takes its place.
  const mode = settings.onCloseParent === 'promoteAll' ? 'promoteAll' : 'promoteFirst';
  for (const [id, parent] of releaseChildren(order, state.parents, tabId, mode)) {
    state.parents.set(id, parent);
  }
}

// --- Persistence and notifications ------------------------------------------

async function persist() {
  await chrome.storage.session.set({
    tree: { parents: [...state.parents], collapsed: [...state.collapsed] },
  });
}

/** Saves state, repairs anything inconsistent and tells open panels. */
async function commit(windowId) {
  if (windowId !== undefined) {
    const { order } = await windowTabs(windowId).catch(() => ({ order: [] }));
    for (const [id, parent] of sanitize(order, state.parents)) state.parents.set(id, parent);
  }
  await persist();
  scheduleSnapshot();
  chrome.runtime.sendMessage({ type: 'tree-changed', windowId }).catch(() => {});
}

// Tab ids change when the browser restarts, so the tree is also saved per
// window as a list of URLs with parent indexes, and matched back on startup.
let snapshotTimer = null;
function scheduleSnapshot() {
  if (!ready) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => enqueue(saveSnapshot), 1000);
}

async function saveSnapshot() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const { snapshots = [] } = await chrome.storage.local.get('snapshots');
  const byWindow = new Map(snapshots.map((s) => [s.windowId, s]));
  for (const win of windows) {
    if (win.incognito) continue;
    const tabs = win.tabs.filter((t) => !t.pinned).sort((a, b) => a.index - b.index);
    const indexOf = new Map(tabs.map((t, i) => [t.id, i]));
    byWindow.set(win.id, {
      windowId: win.id,
      savedAt: Date.now(),
      tabs: tabs.map((t) => ({
        id: t.id,
        url: t.pendingUrl || t.url || '',
        parent: indexOf.get(state.parents.get(t.id)) ?? -1,
        collapsed: state.collapsed.has(t.id),
      })),
    });
  }
  const kept = [...byWindow.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, 12);
  await chrome.storage.local.set({ snapshots: kept });
}

async function restoreFromSnapshot() {
  const { snapshots = [] } = await chrome.storage.local.get('snapshots');
  if (!snapshots.length) return;
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const used = new Set();
  for (const win of windows) {
    const tabs = win.tabs.filter((t) => !t.pinned).sort((a, b) => a.index - b.index);
    if (!tabs.length) continue;
    const ids = new Set(tabs.map((t) => t.id));
    let best = null;
    let bestScore = 0;
    let byId = false;
    for (const snap of snapshots) {
      if (used.has(snap)) continue;
      const length = Math.max(snap.tabs.length, tabs.length);
      const idScore = snap.tabs.filter((s) => ids.has(s.id)).length / length;
      const urlScore =
        snap.tabs.filter((s, i) => tabs[i] && s.url === (tabs[i].pendingUrl || tabs[i].url)).length / length;
      const score = Math.max(idScore, urlScore);
      if (score > bestScore) [best, bestScore, byId] = [snap, score, idScore >= urlScore];
    }
    if (!best || bestScore < 0.5) continue;
    used.add(best);
    // Same session (the extension was reloaded): tab ids are still valid.
    // New session: line tabs up by position and URL.
    const idAt = (i) => (byId ? best.tabs[i]?.id : tabs[i]?.id);
    best.tabs.forEach((snap, i) => {
      const id = idAt(i);
      if (!ids.has(id)) return;
      if (!byId && snap.url !== (tabs[i].pendingUrl || tabs[i].url)) return;
      const parentId = snap.parent >= 0 ? idAt(snap.parent) : null;
      state.parents.set(id, ids.has(parentId) ? parentId : null);
      if (snap.collapsed) state.collapsed.add(id);
    });
  }
}

/** Waits until session restore stops adding tabs, for at most ~10 seconds. */
async function waitForStableTabs() {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const count = (await chrome.tabs.query({})).length;
    if (count === last) return;
    last = count;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function init() {
  settings = await loadSettings();
  const { tree } = await chrome.storage.session.get('tree');
  if (tree) {
    state.parents = new Map(tree.parents);
    state.collapsed = new Set(tree.collapsed);
  } else if ((await chrome.storage.local.get('snapshots')).snapshots?.length) {
    // Browser startup or extension reload: rebuild the tree from the snapshot.
    await waitForStableTabs();
    await restoreFromSnapshot();
  }

  // Reconcile with the tabs that actually exist.
  const tabs = await chrome.tabs.query({});
  const alive = new Set(tabs.map((t) => t.id));
  for (const id of state.parents.keys()) if (!alive.has(id)) state.parents.delete(id);
  for (const id of state.collapsed) if (!alive.has(id)) state.collapsed.delete(id);
  for (const tab of tabs) {
    if (!state.parents.has(tab.id) || tab.pinned) state.parents.set(tab.id, null);
  }
  for (const windowId of new Set(tabs.map((t) => t.windowId))) {
    const { order } = await windowTabs(windowId);
    for (const [id, parent] of sanitize(order, state.parents)) state.parents.set(id, parent);
  }
  if (settings.disableCollapsing) state.collapsed.clear();
  ready = true;
  await commit();
}

// --- Tab events --------------------------------------------------------------

const isNewTabPage = (tab) => NEW_TAB_URLS.includes(tab.pendingUrl || tab.url);

async function onCreated(createdTab, latest) {
  if (state.parents.has(createdTab.id)) return; // Already picked up during init.
  state.parents.set(createdTab.id, null);
  const tab = { ...createdTab, ...(await latest) };
  const { tabs, order } = await windowTabs(tab.windowId);
  if (!order.includes(tab.id)) return commit(tab.windowId); // Pinned, or already gone.

  let placement = pendingPlacements.get(tab.id);
  pendingPlacements.delete(tab.id);
  const source = openedFrom.get(tab.id);
  openedFrom.delete(tab.id);
  const opener = tab.openerTabId;
  const openerIsExtensionPage = tabs.find((t) => t.id === opener)?.url?.startsWith('chrome-extension://');
  if (!placement && source !== undefined && order.includes(source)) {
    placement = childPlacement(source);
  } else if (!placement && openerIsExtensionPage && !isNewTabPage(tab) && order.includes(opener)) {
    // A link on an extension page, which Chrome doesn't report as opened by
    // a page. Tabs opened in other ways while one is active nest here too.
    placement = childPlacement(opener);
  } else if (!placement && settings.newTabAsChild && isNewTabPage(tab) && order.includes(opener)) {
    // Ctrl+T with "Open new tabs as children" on.
    placement = childPlacement(opener);
  }

  if (placement) {
    await applyMove(tab.windowId, [tab.id], placement.targetId, placement.position);
  } else {
    state.parents.set(tab.id, inferParent(order, state.parents, tab.id));
  }
  await commit(tab.windowId);
}

const childPlacement = (parentId) => ({
  targetId: parentId,
  position: settings.childPosition === 'first' ? 'firstChild' : 'inside',
});

/**
 * Chrome reports that a page opened a tab right around onCreated, in either
 * order. If onCreated already placed the tab, nest it under its source now.
 */
async function onOpenedFromPage(tabId, sourceId) {
  // Not created yet: leave the entry for onCreated, which places it.
  if (!state.parents.has(tabId)) return;
  openedFrom.delete(tabId);
  if (state.parents.get(tabId) === sourceId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned) return;
  const { order } = await windowTabs(tab.windowId);
  if (!order.includes(sourceId)) return; // Opened from a pinned tab or another window.
  const { targetId, position } = childPlacement(sourceId);
  if (await applyMove(tab.windowId, [tabId], targetId, position)) await commit(tab.windowId);
}

// When Chrome closes several tabs in one go ("Close other tabs", closing a
// multi-selection), it reports them all at the same moment. Those are exactly
// the tabs the user meant to close, so no extra branches close with them.
// (Closing from the tree works out the branches itself, in closeTabs.)
const removalTimes = [];
function noteRemoval() {
  const now = Date.now();
  while (removalTimes.length && removalTimes[0] < now - 5000) removalTimes.shift();
  removalTimes.push(now);
  return now;
}
const closedWithOthers = (at) => removalTimes.filter((t) => Math.abs(t - at) <= 50).length > 1;

async function onRemoved(tabId, { windowId, isWindowClosing }, removedAt) {
  if (!state.parents.has(tabId)) return;
  if (isWindowClosing) {
    // Keep the last snapshot of the window so it can be restored later.
    state.parents.delete(tabId);
    state.collapsed.delete(tabId);
    return persist();
  }
  const { order } = await windowTabs(windowId);
  const wasCollapsed = state.collapsed.has(tabId);
  const closesBranch = settings.onCloseParent === 'closeAll' || (wasCollapsed && settings.closeCollapsedTree);
  if (closesBranch && !closedWithOthers(removedAt)) {
    const tree = buildTree([tabId, ...order], state.parents);
    const descendants = descendantsOf(tree, tabId);
    if (descendants.length) chrome.tabs.remove(descendants).catch(() => {});
  }
  releaseTab(tabId, order);
  state.parents.delete(tabId);
  state.collapsed.delete(tabId);
  await commit(windowId);
}

async function onMoved(tabId, { windowId }) {
  if (consumeExpectedMove(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned) return;
  // The user moved the tab in the native tab strip: work out its new parent
  // from its neighbours and pull its subtree along behind it.
  const { order } = await windowTabs(windowId);
  if (!state.parents.has(tabId)) state.parents.set(tabId, null);
  state.parents.set(tabId, inferParent(order, state.parents, tabId));
  await applyOrder(windowId, flatten(buildTree(order, state.parents)));
  await commit(windowId);
}

async function onUpdated(tabId, change, tab) {
  if (change.pinned === undefined) return;
  const { order } = await windowTabs(tab.windowId);
  if (change.pinned) {
    releaseTab(tabId, order);
    state.parents.set(tabId, null);
    state.collapsed.delete(tabId);
  } else {
    state.parents.set(tabId, inferParent(order, state.parents, tabId));
  }
  await commit(tab.windowId);
}

async function onActivated({ tabId, windowId }) {
  if (!settings.autoExpandOnActivate) return;
  let changed = false;
  for (const id of ancestorsOf(state.parents, tabId)) {
    if (state.collapsed.delete(id)) changed = true;
  }
  if (changed) await commit(windowId);
}

async function onDetached(tabId, { oldWindowId }) {
  if (crossWindowMoves.has(tabId)) return; // Its subtree travels with it.
  const { order } = await windowTabs(oldWindowId);
  releaseTab(tabId, order);
  state.parents.set(tabId, null);
  await commit(oldWindowId);
}

async function onAttached(tabId, { newWindowId }) {
  if (crossWindowMoves.has(tabId)) {
    const placement = crossWindowMoves.get(tabId);
    crossWindowMoves.delete(tabId);
    if (placement) await applyMove(newWindowId, [tabId], placement.targetId, placement.position);
  } else {
    const { order } = await windowTabs(newWindowId);
    state.parents.set(tabId, inferParent(order, state.parents, tabId));
  }
  await commit(newWindowId);
}

async function onReplaced(addedId, removedId) {
  // Prerendering swaps tab ids; carry the tree position over.
  for (const [id, parent] of state.parents) if (parent === removedId) state.parents.set(id, addedId);
  state.parents.set(addedId, state.parents.get(removedId) ?? null);
  state.parents.delete(removedId);
  if (state.collapsed.delete(removedId)) state.collapsed.add(addedId);
  const tab = await chrome.tabs.get(addedId).catch(() => null);
  await commit(tab?.windowId);
}

// --- Commands from the side panel -------------------------------------------

async function subtreeOf(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const { order } = await windowTabs(tab.windowId);
  const tree = buildTree(order, state.parents);
  return { tab, order, tree, descendants: descendantsOf(tree, tabId) };
}

async function moveTabs({ ids, sourceWindowId, windowId, targetId, position }) {
  const tabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  const pinned = tabs.filter((t) => t.pinned);
  const unpinned = tabs.filter((t) => !t.pinned).map((t) => t.id);
  // Pinned tabs dropped into the tree are simply unpinned.
  for (const tab of pinned) await chrome.tabs.update(tab.id, { pinned: false });
  if (!unpinned.length) return;
  if (sourceWindowId !== undefined && sourceWindowId !== windowId) {
    return moveTreesToWindow(unpinned, windowId, { targetId, position });
  }
  if (await applyMove(windowId, unpinned, targetId, position)) await commit(windowId);
}

/** Moves tabs with their subtrees to another window, or a new one. */
async function moveTreesToWindow(ids, windowId, placement) {
  const first = await chrome.tabs.get(ids[0]);
  const { order } = await windowTabs(first.windowId);
  const tree = buildTree(order, state.parents);
  const selected = new Set(ids);
  const isTop = (id) => selected.has(id) && !ancestorsOf(tree.parentOf, id).some((a) => selected.has(a));
  const tops = flatten(tree).filter(isTop);
  if (!tops.length) return;
  const all = tops.flatMap((id) => [id, ...descendantsOf(tree, id)]);

  // The first tree goes where it was dropped, the others follow it in order.
  tops.forEach((id, i) => {
    crossWindowMoves.set(id, i === 0 ? placement : { targetId: tops[i - 1], position: 'afterTree' });
    state.parents.set(id, null);
  });
  for (const id of all) if (!crossWindowMoves.has(id)) crossWindowMoves.set(id, null);

  try {
    let rest = all;
    if (windowId === null) {
      const win = await chrome.windows.create({ tabId: all[0], focused: true });
      windowId = win.id;
      rest = all.slice(1);
    }
    if (rest.length) await chrome.tabs.move(rest, { windowId, index: -1 });
  } catch (error) {
    for (const id of all) crossWindowMoves.delete(id);
    throw error;
  }
  await commit(first.windowId);
}

/** With collapsing turned off, every tree is expanded and stays that way. */
async function expandEverything() {
  if (!state.collapsed.size) return;
  state.collapsed.clear();
  await commit();
}

async function setCollapsed(tabId, collapsed) {
  if (collapsed && settings.disableCollapsing) return;
  if (collapsed) state.collapsed.add(tabId);
  else state.collapsed.delete(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  // Collapsing a tree that holds the active tab moves focus to its root.
  if (collapsed) {
    const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    if (active && ancestorsOf(state.parents, active.id).includes(tabId)) {
      await chrome.tabs.update(tabId, { active: true });
    }
  }
  await commit(tab.windowId);
}

async function setAllCollapsed(windowId, collapsed) {
  if (collapsed && settings.disableCollapsing) return;
  const { order } = await windowTabs(windowId);
  const tree = buildTree(order, state.parents);
  for (const id of order) {
    if (collapsed && tree.children.get(id).length) state.collapsed.add(id);
    else state.collapsed.delete(id);
  }
  if (collapsed) {
    const [active] = await chrome.tabs.query({ windowId, active: true });
    const root = active && [active.id, ...ancestorsOf(tree.parentOf, active.id)].pop();
    if (root !== undefined && root !== active.id) await chrome.tabs.update(root, { active: true });
  }
  await commit(windowId);
}

async function newChildTab(parentId, url) {
  const { tab, order, descendants } = await subtreeOf(parentId);
  const pinnedCount = (await chrome.tabs.query({ windowId: tab.windowId, pinned: true })).length;
  const last = descendants.length ? descendants[descendants.length - 1] : parentId;
  const created = await chrome.tabs.create({
    windowId: tab.windowId,
    index: pinnedCount + order.indexOf(last) + 1,
    url,
    active: true,
  });
  pendingPlacements.set(created.id, childPlacement(parentId));
}

/**
 * Closes tabs for the tree, together with any branches that close with their
 * parent (see onRemoved). With "keep the window open" on, a window that
 * would lose all its tabs gets a new tab first.
 */
async function closeTabs(ids) {
  const tabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  if (!tabs.length) return;
  const closing = new Set(tabs.map((t) => t.id));
  for (const windowId of new Set(tabs.map((t) => t.windowId))) {
    const { tabs: all, order } = await windowTabs(windowId);
    const tree = buildTree(order, state.parents);
    for (const id of [...closing]) {
      const closesBranch =
        settings.onCloseParent === 'closeAll' || (state.collapsed.has(id) && settings.closeCollapsedTree);
      if (closesBranch && tree.children.has(id)) descendantsOf(tree, id).forEach((d) => closing.add(d));
    }
    if (settings.keepWindowOnLastTab && all.every((t) => closing.has(t.id))) {
      await chrome.tabs.create({ windowId, active: true });
    }
  }
  await chrome.tabs.remove([...closing]).catch(() => {});
}

/** Duplicates land right after the original's tree, as its next sibling. */
async function duplicateTabs(ids) {
  for (const id of ids) {
    const copy = await chrome.tabs.duplicate(id).catch(() => null);
    if (copy) pendingPlacements.set(copy.id, { targetId: id, position: 'afterTree' });
  }
}

async function openUrlAt({ windowId, url, targetId, position }) {
  const created = await chrome.tabs.create({ windowId, url, active: true });
  pendingPlacements.set(created.id, { targetId, position });
}

async function indent(tabId) {
  const { tab, tree } = await subtreeOf(tabId);
  const parent = tree.parentOf.get(tabId);
  const siblings = parent === null ? tree.roots : tree.children.get(parent);
  const previous = siblings[siblings.indexOf(tabId) - 1];
  if (previous === undefined) return;
  state.collapsed.delete(previous);
  if (await applyMove(tab.windowId, [tabId], previous, 'inside')) await commit(tab.windowId);
}

async function outdent(tabId) {
  const { tab, tree } = await subtreeOf(tabId);
  const parent = tree.parentOf.get(tabId);
  if (parent === null) return;
  if (await applyMove(tab.windowId, [tabId], parent, 'afterTree')) await commit(tab.windowId);
}

async function handleMessage(message) {
  switch (message.type) {
    case 'get-tree':
      return { parents: [...state.parents], collapsed: [...state.collapsed] };
    case 'set-collapsed':
      return setCollapsed(message.tabId, message.collapsed);
    case 'set-all-collapsed':
      return setAllCollapsed(message.windowId, message.collapsed);
    case 'move':
      return moveTabs(message);
    case 'move-to-new-window':
      return moveTreesToWindow(message.ids, null, { targetId: null, position: 'end' });
    case 'new-child-tab':
      return newChildTab(message.tabId, message.url);
    case 'open-url':
      return openUrlAt(message);
    case 'duplicate':
      return duplicateTabs(message.ids);
    case 'indent':
      return indent(message.tabId);
    case 'outdent':
      return outdent(message.tabId);
    case 'close-tabs':
      return closeTabs(message.ids);
    case 'close-tree':
    case 'close-children': {
      const { descendants } = await subtreeOf(message.tabId);
      return closeTabs(message.type === 'close-tree' ? [message.tabId, ...descendants] : descendants);
    }
  }
}

// --- Wiring --------------------------------------------------------------------
// Listeners must be registered synchronously so events wake the worker.

const on = (event, handler) => event.addListener((...args) => enqueue(() => handler(...args)));
chrome.tabs.onCreated.addListener((tab) => {
  // The opener matters for links on extension pages and for Ctrl+T tabs with
  // "Open new tabs as children" on. onCreated can fire before Chrome sets
  // openerTabId, so read the tab
  // again right away: Chrome forgets openers once tabs get moved, so waiting
  // for the queue could be too late.
  const latest = tab.openerTabId === undefined ? chrome.tabs.get(tab.id).catch(() => null) : null;
  enqueue(() => onCreated(tab, latest));
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ tabId, sourceTabId }) => {
  // Recorded right away so a queued onCreated for this tab can use it.
  openedFrom.set(tabId, sourceTabId);
  enqueue(() => onOpenedFromPage(tabId, sourceTabId));
});
chrome.tabs.onRemoved.addListener((tabId, info) => {
  const removedAt = noteRemoval();
  enqueue(() => onRemoved(tabId, info, removedAt));
});
on(chrome.tabs.onMoved, onMoved);
on(chrome.tabs.onUpdated, onUpdated);
on(chrome.tabs.onActivated, onActivated);
on(chrome.tabs.onDetached, onDetached);
on(chrome.tabs.onAttached, onAttached);
on(chrome.tabs.onReplaced, onReplaced);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  enqueue(() => handleMessage(message)).then(sendResponse);
  return true;
});

onSettingsChanged((next) => {
  settings = next;
  if (settings.disableCollapsing) enqueue(expandEverything);
});

// Clicking the toolbar button toggles the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

enqueue(init);
