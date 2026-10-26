// Docked mode: the tree in its own narrow popup window, glued to the side of
// a browser window. Chrome's side panel has a minimum width that extensions
// cannot lower; a popup window can be much narrower.
import { DEFAULTS, loadSettings, onSettingsChanged } from './settings.js';

const PANEL_PATH = 'src/sidepanel/sidepanel.html';

let settings = { ...DEFAULTS };
// mainWindowId -> { dockId, width, restore, applied }
//   width   - last known width of the dock, to tell resizes from moves
//   restore - how to put the browser window back when the dock closes
//   applied - bounds we gave the browser window, so we only restore those
let docks = new Map();
// Browser windows whose dock the user closed; auto-open leaves them alone.
let dismissed = new Set();

let queue = Promise.resolve();
const run = (task) => {
  const next = queue.then(task).catch((error) => console.error('[tab-tree dock]', error));
  queue = next;
  return next;
};

const near = (a, b) => Math.abs(a - b) <= 2;
const getWindow = (id) => chrome.windows.get(id, { populate: false }).catch(() => null);
const isDocked = () => settings.displayMode === 'docked';
const dockOf = (dockId) => [...docks].find(([, entry]) => entry.dockId === dockId)?.[0];

async function save() {
  await chrome.storage.session.set({ docks: [...docks], dockDismissed: [...dismissed] });
}

/** The work area of the display showing most of `bounds`. */
async function workAreaFor(bounds) {
  const displays = await chrome.system.display.getInfo().catch(() => []);
  const cx = bounds.left + bounds.width / 2;
  const cy = bounds.top + bounds.height / 2;
  const hit =
    displays.find(({ workArea: a }) => cx >= a.left && cx < a.left + a.width && cy >= a.top && cy < a.top + a.height) ??
    displays.find((d) => d.isPrimary) ??
    displays[0];
  return hit?.workArea ?? null;
}

/**
 * Works out where the browser window and its dock go. The dock sits just
 * outside the browser window when there is room on screen; otherwise the
 * browser window shrinks to make room.
 */
function layout(main, width, area) {
  const left = settings.dockSide !== 'right';
  let { left: x, width: w } = main;
  if (area) {
    if (left && x - width < area.left) {
      const right = x + w;
      x = area.left + width;
      w = Math.max(200, right - x);
    } else if (!left && x + w + width > area.left + area.width) {
      w = Math.max(200, area.left + area.width - width - x);
    }
  }
  return {
    main: { left: x, top: main.top, width: w, height: main.height },
    dock: { left: left ? x - width : x + w, top: main.top, width, height: main.height },
  };
}

async function updateWindow(id, info) {
  return chrome.windows.update(id, info).catch(() => null);
}

async function openDock(mainId) {
  if (docks.has(mainId)) return;
  let main = await getWindow(mainId);
  if (!main || main.type !== 'normal' || main.incognito) return;

  let restore = null;
  let area = await workAreaFor(main);
  if (main.state === 'maximized' || main.state === 'fullscreen') {
    // A maximized window has no room beside it: unmaximize it and fill the
    // rest of the screen next to the dock instead.
    restore = { state: main.state };
    area = { left: main.left, top: main.top, width: main.width, height: main.height, ...area };
    main = await updateWindow(mainId, { state: 'normal' });
    if (!main) return;
    main = { ...main, left: area.left, top: area.top, width: area.width, height: area.height };
  } else if (main.state === 'minimized') {
    return;
  }

  const target = layout(main, settings.dockWidth, area);
  if (!restore && (target.main.left !== main.left || target.main.width !== main.width)) {
    restore = { left: main.left, width: main.width };
  }
  await updateWindow(mainId, target.main);

  const url = chrome.runtime.getURL(`${PANEL_PATH}?windowId=${mainId}&docked=1`);
  const dock = await chrome.windows.create({ url, type: 'popup', focused: false, ...target.dock });
  // Chrome may clamp the size; lay out again with the width it really used.
  const actual = (await getWindow(dock.id)) ?? dock;
  docks.set(mainId, { dockId: dock.id, width: actual.width, restore, applied: target.main });
  dismissed.delete(mainId);
  await save();
  await sync(mainId);
}

/**
 * dismiss    - the user turned this dock off, so auto-open skips the window
 * windowGone - the dock window is already closed
 */
async function closeDock(mainId, { dismiss = false, windowGone = false } = {}) {
  const entry = docks.get(mainId);
  if (!entry) return;
  docks.delete(mainId);
  if (dismiss) dismissed.add(mainId);
  await save();
  if (!windowGone) await chrome.windows.remove(entry.dockId).catch(() => {});

  // Give the browser window its space back, unless the user moved it since.
  const main = await getWindow(mainId);
  if (!main || !entry.restore) return;
  if (entry.restore.state) {
    await updateWindow(mainId, { state: entry.restore.state });
  } else if (main.state === 'normal' && near(main.left, entry.applied.left) && near(main.width, entry.applied.width)) {
    await updateWindow(mainId, entry.restore);
  }
}

/** Puts the dock back where it belongs next to its browser window. */
async function sync(mainId) {
  const entry = docks.get(mainId);
  if (!entry) return;
  const [main, dock] = await Promise.all([getWindow(mainId), getWindow(entry.dockId)]);
  if (!main) return closeDock(mainId);
  if (!dock) return closeDock(mainId, { dismiss: true, windowGone: true });

  if (main.state === 'minimized' || main.state === 'fullscreen') {
    if (dock.state !== 'minimized') await updateWindow(entry.dockId, { state: 'minimized' });
    return;
  }
  if (dock.state !== 'normal') await updateWindow(entry.dockId, { state: 'normal' });

  if (main.state === 'maximized') {
    // Maximizing would cover the dock: fill the screen next to it instead.
    const { left, top, width, height } = main;
    const w = entry.width;
    const onRight = settings.dockSide === 'right';
    const mainBounds = { left: onRight ? left : left + w, top, width: width - w, height };
    entry.restore = entry.restore?.state ? entry.restore : { state: 'maximized' };
    entry.applied = mainBounds;
    await save();
    await updateWindow(mainId, { state: 'normal' });
    await updateWindow(mainId, mainBounds);
    await updateWindow(entry.dockId, { left: onRight ? left + width - w : left, top, height });
    return;
  }

  const want = layout(main, entry.width, null).dock;
  if (!near(dock.left, want.left) || !near(dock.top, want.top) || !near(dock.height, want.height)) {
    await updateWindow(entry.dockId, { left: want.left, top: want.top, height: want.height });
  }
}

/** The user resized or moved the dock itself. */
async function dockChanged(mainId) {
  const entry = docks.get(mainId);
  const [main, dock] = await Promise.all([getWindow(mainId), getWindow(entry.dockId)]);
  if (!main || !dock || dock.state !== 'normal' || main.state !== 'normal') return sync(mainId);
  if (!near(dock.width, entry.width)) {
    // A resize: keep the far edge of the browser window where it is and
    // move its near edge to touch the dock.
    entry.width = dock.width;
    await save();
    chrome.storage.sync.set({ dockWidth: dock.width });
    const left = settings.dockSide !== 'right';
    const bounds = left
      ? { left: dock.left + dock.width, width: main.left + main.width - (dock.left + dock.width) }
      : { left: main.left, width: dock.left - main.left };
    if (bounds.width >= 200 && (!near(bounds.left, main.left) || !near(bounds.width, main.width))) {
      await updateWindow(mainId, bounds);
      entry.applied = { ...entry.applied, ...bounds };
      await save();
    }
    return sync(mainId);
  }
  return sync(mainId); // A move: snap back.
}

// Window events can arrive in bursts while a window is dragged.
const timers = new Map();
function debounce(key, task) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => run(task), 60));
}

// Keep the dock and its browser window raised together, so neither ends up
// hidden behind another app.
let lastFocused = chrome.windows.WINDOW_ID_NONE;
let raising = false;
async function focusChanged(windowId) {
  const previous = lastFocused;
  lastFocused = windowId;
  if (raising || windowId === chrome.windows.WINDOW_ID_NONE) return;
  const mainId = docks.has(windowId) ? windowId : dockOf(windowId);
  if (mainId === undefined) return;
  const partner = windowId === mainId ? docks.get(mainId).dockId : mainId;
  if (previous === partner) return;
  raising = true;
  try {
    await updateWindow(partner, { focused: true });
    await updateWindow(windowId, { focused: true });
  } finally {
    setTimeout(() => (raising = false), 300);
  }
  await sync(mainId);
}

/** Applies the display mode: side panel or docked windows. */
async function applyMode() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !isDocked() }).catch(() => {});
  await chrome.sidePanel.setOptions({ enabled: !isDocked() }).catch(() => {});
  if (!isDocked()) {
    for (const mainId of [...docks.keys()]) await closeDock(mainId);
    return;
  }
  for (const mainId of docks.keys()) await sync(mainId);
  if (settings.dockAutoOpen) {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    for (const win of windows) if (!dismissed.has(win.id)) await openDock(win.id);
  }
}

async function init() {
  settings = await loadSettings();
  const stored = await chrome.storage.session.get(['docks', 'dockDismissed']);
  docks = new Map(stored.docks ?? []);
  dismissed = new Set(stored.dockDismissed ?? []);

  // Forget docks that are gone, and close dock windows nobody owns any more
  // (for example ones Chrome restored from the last session).
  const windows = await chrome.windows.getAll({ populate: true });
  const alive = new Set(windows.map((w) => w.id));
  for (const [mainId, entry] of [...docks]) {
    if (!alive.has(mainId) || !alive.has(entry.dockId)) docks.delete(mainId);
  }
  const owned = new Set([...docks.values()].map((e) => e.dockId));
  const panelUrl = chrome.runtime.getURL(PANEL_PATH);
  for (const win of windows) {
    if (!owned.has(win.id) && win.tabs?.some((t) => t.url?.startsWith(panelUrl) && t.url.includes('docked=1'))) {
      await chrome.windows.remove(win.id).catch(() => {});
    }
  }
  await save();
  await applyMode();
}

// Listeners are registered synchronously so events wake the worker.
export function registerDock() {
  chrome.action.onClicked.addListener((tab) =>
    run(async () => {
      if (!isDocked()) return;
      const mainId = docks.has(tab.windowId) ? tab.windowId : (dockOf(tab.windowId) ?? tab.windowId);
      if (docks.has(mainId)) await closeDock(mainId, { dismiss: true });
      else await openDock(mainId);
    }),
  );
  chrome.windows.onCreated.addListener((win) => {
    if (win.type !== 'normal' || !isDocked() || !settings.dockAutoOpen) return;
    // Let the new window settle at its final size first.
    setTimeout(() => run(() => openDock(win.id)), 300);
  });
  chrome.windows.onRemoved.addListener((windowId) =>
    run(async () => {
      if (docks.has(windowId)) return closeDock(windowId);
      const mainId = dockOf(windowId);
      if (mainId !== undefined) return closeDock(mainId, { dismiss: true, windowGone: true });
      if (dismissed.delete(windowId)) await save();
    }),
  );
  chrome.windows.onBoundsChanged.addListener((win) => {
    if (docks.has(win.id)) debounce(win.id, () => sync(win.id));
    const mainId = dockOf(win.id);
    if (mainId !== undefined) debounce(win.id, () => dockChanged(mainId));
  });
  chrome.windows.onFocusChanged.addListener((windowId) => run(() => focusChanged(windowId)));

  onSettingsChanged((next) => {
    const sideChanged = next.dockSide !== settings.dockSide;
    // Turning docked mode on is a fresh start for windows whose dock was closed.
    if (next.displayMode === 'docked' && settings.displayMode !== 'docked') dismissed.clear();
    const modeChanged = sideChanged || next.displayMode !== settings.displayMode || next.dockAutoOpen !== settings.dockAutoOpen;
    settings = next;
    if (!modeChanged) return;
    run(async () => {
      // Switching sides: reopen the docks on the other side.
      if (sideChanged) {
        const open = [...docks.keys()];
        for (const mainId of open) await closeDock(mainId);
        if (isDocked()) for (const mainId of open) await openDock(mainId);
      }
      await applyMode();
    });
  });

  run(init);
}
