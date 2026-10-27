import { buildTree, descendantsOf } from '../tree.js';
import { DEFAULTS, loadSettings, onSettingsChanged } from '../settings.js';
import { icon } from './icons.js';

const DRAG_TYPE = 'application/x-tree-of-tabs';

const pinnedEl = document.getElementById('pinned');
const scroller = document.getElementById('scroller');
const treeEl = document.getElementById('tree');
const newTabEl = document.getElementById('new-tab');
const dropLine = document.getElementById('drop-line');
const menuEl = document.getElementById('menu');

let windowId;
let settings = { ...DEFAULTS };
let tabsById = new Map();
let collapsed = new Set();
let groups = new Map();
let tree = buildTree([], new Map());
// Rows currently shown: { id, partner, kids, depth, hasChildren, collapsed, hidden }.
// A split view (two tabs Chrome shows side by side) is one row: `id` is its
// first tab and `partner` the second, which the worker keeps as the first
// tab's first child. `kids` are the row's children, without the partner.
let visible = [];
let activeId = null;
let focusedId = null;
let drag = null;

const rowEls = new Map(); // row id -> element
const rowIdOf = new Map(); // tab id -> id of the row showing it
const pinnedEls = new Map();

const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);
// Tab actions race with tabs closing, or being dragged in the tab strip, so a
// failed call just means the tab is gone or busy: nothing to report.
const quietly = (promise) => promise.catch(() => {});

// --- Data --------------------------------------------------------------------

let generation = 0;
async function refresh() {
  const current = ++generation;
  const [tabs, state, groupList] = await Promise.all([
    chrome.tabs.query({ windowId }).catch(() => null),
    send({ type: 'get-tree' }),
    chrome.tabGroups.query({ windowId }).catch(() => []),
  ]);
  // No tabs means the window is closing; keep what is shown until then.
  if (current !== generation || !tabs) return;
  tabs.sort((a, b) => a.index - b.index);
  tabsById = new Map(tabs.map((t) => [t.id, t]));
  collapsed = new Set(state?.collapsed ?? []);
  groups = new Map(groupList.map((g) => [g.id, g]));
  const order = tabs.filter((t) => !t.pinned).map((t) => t.id);
  tree = buildTree(order, new Map(state?.parents ?? []));
  render(tabs.filter((t) => t.pinned));
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refresh();
  });
}

// --- Rendering ---------------------------------------------------------------

function render(pinnedTabs) {
  visible = [];
  const walk = (id, depth) => {
    const all = tree.children.get(id);
    const partner = splitPartner(id, all[0]);
    const kids = partner === null ? all : all.slice(1);
    const isCollapsed = kids.length > 0 && collapsed.has(id) && !settings.disableCollapsing;
    const hidden = isCollapsed ? descendantsOf(tree, id).length - (partner === null ? 0 : 1) : 0;
    visible.push({ id, partner, kids, depth, hasChildren: kids.length > 0, collapsed: isCollapsed, hidden });
    if (!isCollapsed) for (const kid of kids) walk(kid, depth + 1);
  };
  tree.roots.forEach((id) => walk(id, 0));
  markGroupRuns();

  renderPinned(pinnedTabs);
  renderRows();

  const active = [...tabsById.values()].find((t) => t.active);
  if (active && active.id !== activeId) {
    activeId = active.id;
    (rowEls.get(rowIdOf.get(activeId)) ?? pinnedEls.get(activeId))?.scrollIntoView({ block: 'nearest' });
  }
  if (focusedId === null || !rowEls.has(focusedId)) focusedId = rowIdOf.get(activeId) ?? activeId;
  for (const [id, el] of rowEls) el.tabIndex = id === focusedId ? 0 : -1;
}

/** A tab's split view (two tabs shown side by side), or null. */
const splitOf = (tab) => ((tab?.splitViewId ?? -1) === -1 ? null : tab.splitViewId);

/**
 * Whether the user selected this tab (Ctrl/Cmd+click or Shift+click). Chrome
 * also marks the other half of the active split view as highlighted, but
 * that isn't a selection: actions on the active tab shouldn't reach it.
 */
function isSelected(tab) {
  if (!tab?.highlighted || tab.active) return !!tab?.highlighted;
  const split = splitOf(tab);
  return split === null || split !== splitOf([...tabsById.values()].find((t) => t.active));
}

/** `first` when it is the other half of `id`'s split view, else null. */
function splitPartner(id, first) {
  const split = splitOf(tabsById.get(id));
  return first !== undefined && split !== null && split === splitOf(tabsById.get(first)) ? first : null;
}

/** The tabs a row shows: one, or both halves of a split view. */
const tabsOfRow = (row) => (row.partner === null ? [row.id] : [row.id, row.partner]);

/**
 * Each run of rows in the same tab group gets one continuous colored line.
 * It takes the place of the guide line just left of the run's shallowest
 * tabs, or runs along the leading edge when those are top-level tabs.
 */
function markGroupRuns() {
  const groupOf = (row) => (row && groups.has(tabsById.get(row.id)?.groupId) ? tabsById.get(row.id).groupId : null);
  let start = 0;
  for (let i = 0; i <= visible.length; i++) {
    if (i < visible.length && groupOf(visible[i]) === groupOf(visible[start])) continue;
    const run = visible.slice(start, i);
    const level = Math.min(...run.map((row) => row.depth));
    run.forEach((row, k) => Object.assign(row, { groupLevel: level, groupFirst: k === 0, groupLast: k === run.length - 1 }));
    start = i;
  }
}

function syncChildren(container, elements) {
  let cursor = container.firstElementChild;
  for (const el of elements) {
    if (el !== cursor) container.insertBefore(el, cursor);
    else cursor = cursor.nextElementSibling;
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

function renderRows() {
  const used = new Set();
  rowIdOf.clear();
  const elements = visible.map((row) => {
    let el = rowEls.get(row.id);
    if (!el) rowEls.set(row.id, (el = createRow(row.id)));
    updateRow(el, tabsById.get(row.id), row);
    used.add(row.id);
    for (const id of tabsOfRow(row)) rowIdOf.set(id, row.id);
    return el;
  });
  for (const id of rowEls.keys()) if (!used.has(id)) rowEls.delete(id);
  syncChildren(treeEl, elements);
}

function createRow(id) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = id;
  el.draggable = true;
  el.setAttribute('role', 'treeitem');
  el.innerHTML = `<button class="twisty" tabindex="-1">${icon('chevron')}</button>`;
  el.append(createPart(id));
  return el;
}

/** One tab's part of a row: the whole row, or one half of a split view's row. */
function createPart(id, { partner = false } = {}) {
  const part = document.createElement('span');
  part.className = partner ? 'part partner' : 'part';
  part.dataset.tabId = id;
  part.innerHTML = `
    <span class="icon">
      <img class="favicon" alt="" draggable="false">
      <span class="fallback-icon">${icon('globe')}</span>
      <span class="spinner"></span>
    </span>
    <span class="title"></span>
    ${partner ? '' : '<span class="badge"></span>'}
    <button class="tab-button audio" tabindex="-1"></button>
    <button class="tab-button close" tabindex="-1" aria-label="Close tab">${icon('close')}</button>`;
  const iconEl = part.querySelector('.icon');
  part.querySelector('.favicon').addEventListener('error', () => iconEl.classList.add('no-favicon'));
  return part;
}

function faviconUrl(tab) {
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) return tab.favIconUrl;
  const page = tab.pendingUrl || tab.url;
  if (!page) return '';
  // Chrome's own favicon cache; also covers chrome:// pages and discarded tabs.
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', page);
  url.searchParams.set('size', '32');
  return url.href;
}

function setFavicon(container, tab) {
  const img = container.querySelector('.favicon');
  const src = faviconUrl(tab);
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    container.classList.toggle('no-favicon', !src);
    if (src) img.src = src;
    else img.removeAttribute('src');
  }
}

function tabTitle(tab) {
  return tab.title || tab.pendingUrl || tab.url || 'New Tab';
}

function updateRow(el, tab, row) {
  if (!tab) return;
  const partner = row.partner === null ? null : tabsById.get(row.partner);
  el.style.setProperty('--depth', row.depth);
  el.classList.toggle('split', !!partner);
  // A split view's row is highlighted lightly while either half is in view,
  // and the half in focus gets the active color (see .part.active).
  el.classList.toggle('active', tab.active && !partner);
  el.classList.toggle('split-active', !!partner && (tab.active || partner.active));
  el.classList.toggle('highlighted', [tab, partner].some((t) => t && isSelected(t) && !t.active));
  el.classList.toggle('has-children', row.hasChildren);
  el.classList.toggle('collapsed', row.collapsed);
  el.classList.toggle('dragging', !!drag?.blocked.has(tab.id));
  el.setAttribute('aria-level', row.depth + 1);
  el.setAttribute('aria-selected', tab.active || !!partner?.active);
  if (row.hasChildren) el.setAttribute('aria-expanded', !row.collapsed);
  else el.removeAttribute('aria-expanded');
  const twisty = el.querySelector('.twisty');
  twisty.title = row.collapsed ? 'Expand' : 'Collapse';
  twisty.setAttribute('aria-label', twisty.title);

  const [part] = el.getElementsByClassName('part');
  updatePart(part, tab);
  part.querySelector('.badge').textContent = row.hidden;
  let partnerPart = el.querySelector('.partner');
  if (partner && partnerPart?.dataset.tabId !== String(partner.id)) {
    partnerPart?.remove();
    el.append((partnerPart = createPart(partner.id, { partner: true })));
  } else if (!partner) {
    partnerPart?.remove();
  }
  if (partner) updatePart(partnerPart, partner);

  const group = groups.get(tab.groupId);
  if (group) {
    el.dataset.groupColor = group.color;
    el.style.setProperty('--group-color', `var(--group-${group.color})`);
    el.style.setProperty('--group-level', row.groupLevel);
  } else {
    delete el.dataset.groupColor;
  }
  el.classList.toggle('group-first', !!group && row.groupFirst);
  el.classList.toggle('group-last', !!group && row.groupLast);
}

function updatePart(part, tab) {
  part.classList.toggle('active', tab.active);
  part.classList.toggle('loading', tab.status === 'loading');
  part.classList.toggle('discarded', !!tab.discarded);
  part.classList.toggle('audible', !!tab.audible);
  part.classList.toggle('muted', !!tab.mutedInfo?.muted);

  const title = tabTitle(tab);
  const titleEl = part.querySelector('.title');
  if (titleEl.textContent !== title) titleEl.textContent = title;
  part.title = tab.url && tab.url !== title ? `${title}\n${tab.url}` : title;
  setFavicon(part.querySelector('.icon'), tab);

  const audio = part.querySelector('.audio');
  const muted = !!tab.mutedInfo?.muted;
  const audioKey = muted ? 'off' : 'on';
  if (audio.dataset.state !== audioKey) {
    audio.dataset.state = audioKey;
    audio.innerHTML = icon(muted ? 'volumeOff' : 'volumeUp');
    audio.setAttribute('aria-label', muted ? 'Unmute tab' : 'Mute tab');
  }
}

function renderPinned(pinnedTabs) {
  const used = new Set();
  const elements = pinnedTabs.map((tab) => {
    let el = pinnedEls.get(tab.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pinned-tab';
      el.dataset.id = tab.id;
      el.draggable = true;
      el.setAttribute('role', 'listitem');
      el.innerHTML = `
        <span class="icon">
          <img class="favicon" alt="" draggable="false">
          <span class="fallback-icon">${icon('globe')}</span>
          <span class="spinner"></span>
        </span>
        <span class="audio-dot" hidden></span>`;
      const iconEl = el.querySelector('.icon');
      el.querySelector('.favicon').addEventListener('error', () => iconEl.classList.add('no-favicon'));
      pinnedEls.set(tab.id, el);
    }
    el.classList.toggle('active', tab.active);
    el.classList.toggle('loading', tab.status === 'loading');
    el.title = tabTitle(tab);
    el.querySelector('.audio-dot').hidden = !tab.audible || !!tab.mutedInfo?.muted;
    setFavicon(el.querySelector('.icon'), tab);
    used.add(tab.id);
    return el;
  });
  for (const id of pinnedEls.keys()) if (!used.has(id)) pinnedEls.delete(id);
  syncChildren(pinnedEl, elements);
}

// --- Tab actions -------------------------------------------------------------

const rowOf = (target) => target.closest?.('.tab, .pinned-tab');
const idOf = (el) => Number(el.dataset.id);
const rowInfo = (id) => visible.find((r) => r.id === id);
/** The tab under the pointer: its half of a split view's row, or the row's tab. */
const tabIdAt = (target, el) => Number(target.closest?.('.part')?.dataset.tabId ?? el.dataset.id);
/** In a split view's row, the half in focus, if any; otherwise the first one. */
function focusedTabOf(rowId) {
  const row = rowInfo(rowId);
  return row?.partner != null && tabsById.get(row.partner)?.active ? row.partner : rowId;
}

function activate(id) {
  quietly(chrome.tabs.update(id, { active: true }));
}

// Closing goes through the worker, which knows which branches close along
// and whether the window must be kept open.
function closeTab(id) {
  send({ type: 'close-tabs', ids: [id] });
}

function toggleCollapsed(id) {
  if (settings.disableCollapsing) return;
  const isCollapsed = collapsed.has(id);
  // Update right away so the click feels instant; the worker confirms.
  if (isCollapsed) collapsed.delete(id);
  else collapsed.add(id);
  render([...tabsById.values()].filter((t) => t.pinned));
  send({ type: 'set-collapsed', tabId: id, collapsed: !isCollapsed });
}

function toggleMuted(id) {
  const tab = tabsById.get(id);
  quietly(chrome.tabs.update(id, { muted: !tab?.mutedInfo?.muted }));
}

/** Ctrl/Cmd+click: add a tab to, or remove it from, the multi-selection. */
function toggleHighlighted(id) {
  const tabs = [...tabsById.values()];
  const active = tabs.find((t) => t.active);
  if (!active || id === active.id) return;
  const selected = new Set(tabs.filter(isSelected).map((t) => t.id));
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  highlight(active, [...selected]);
}

/** Shift+click: select every visible tab between the active tab and this one. */
function selectRange(id) {
  const active = [...tabsById.values()].find((t) => t.active);
  const ids = visible.map((r) => r.id);
  const from = ids.indexOf(rowIdOf.get(active?.id));
  const to = ids.indexOf(rowIdOf.get(id));
  if (from === -1 || to === -1) return activate(id);
  highlight(active, visible.slice(Math.min(from, to), Math.max(from, to) + 1).flatMap(tabsOfRow));
}

function highlight(active, ids) {
  // The first index becomes the active tab, so keep the current one first.
  const indexes = [active.index, ...ids.filter((x) => x !== active.id).map((x) => tabsById.get(x).index)];
  quietly(chrome.tabs.highlight({ windowId, tabs: indexes }));
}

/** Selected tabs a tab action applies to: the selection, if the tab is in it, or just the tab. */
function selectedIdsFor(id) {
  const tab = tabsById.get(id);
  const selected = visible.flatMap(tabsOfRow).map((x) => tabsById.get(x)).filter(isSelected);
  return isSelected(tab) && selected.length > 1 ? selected.map((t) => t.id) : [id];
}

/** Rows a tree action (drag, move, close others) applies to, by row id. */
function selectedRowsFor(rowId) {
  const selected = visible.filter((r) => tabsOfRow(r).some((x) => isSelected(tabsById.get(x))));
  return selected.some((r) => r.id === rowId) && selected.length > 1 ? selected.map((r) => r.id) : [rowId];
}

function newTab() {
  quietly(chrome.tabs.create({ windowId }));
}

/** A new tab under the active one, like middle-clicking Tree Style Tab's new tab button. */
function newChildOfActive() {
  const active = [...tabsById.values()].find((t) => t.active);
  if (!active || active.pinned) return newTab(); // Pinned tabs have no children.
  send({ type: 'new-child-tab', tabId: active.id });
}

// --- Pointer and keyboard ----------------------------------------------------

function onPointerDown(event) {
  const el = rowOf(event.target);
  if (!el || event.target.closest('button')) return;
  const id = tabIdAt(event.target, el);
  if (event.button === 1) {
    event.preventDefault(); // No autoscroll on middle click.
    return;
  }
  if (event.button !== 0) return;
  if (event.ctrlKey || event.metaKey) return toggleHighlighted(id);
  if (event.shiftKey) return selectRange(id);
  // Keep a multi-selection alive so it can be dragged; activate on click.
  const tab = tabsById.get(id);
  const multi = [...tabsById.values()].filter(isSelected).length > 1;
  if (!(multi && isSelected(tab))) activate(id);
}

function onClick(event) {
  const el = rowOf(event.target);
  if (!el) return;
  const id = tabIdAt(event.target, el);
  const button = event.target.closest('button');
  if (button?.classList.contains('twisty')) return toggleCollapsed(idOf(el));
  if (button?.classList.contains('close')) return closeTab(id);
  if (button?.classList.contains('audio')) return toggleMuted(id);
  if (event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tab = tabsById.get(id);
  if (tab && !tab.active) activate(id);
}

function onAuxClick(event) {
  const el = rowOf(event.target);
  if (el && event.button === 1) {
    event.preventDefault();
    closeTab(tabIdAt(event.target, el));
  }
}

for (const container of [treeEl, pinnedEl]) {
  container.addEventListener('mousedown', onPointerDown);
  container.addEventListener('click', onClick);
  container.addEventListener('auxclick', onAuxClick);
  container.addEventListener('contextmenu', (event) => {
    const el = rowOf(event.target);
    if (!el) return;
    event.preventDefault();
    openTabMenu(idOf(el), event.clientX, event.clientY, tabIdAt(event.target, el));
  });
}

// Left click: a new tree. Middle click: a new child of the current tab.
newTabEl.addEventListener('click', newTab);
newTabEl.addEventListener('mousedown', (event) => {
  if (event.button === 1) event.preventDefault(); // No autoscroll on middle click.
});
newTabEl.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  newChildOfActive();
});
// Right-click offers both, since many trackpads have no middle click.
newTabEl.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  openMenu(newTabMenuItems(), event.clientX, event.clientY);
});
newTabEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') newTab();
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    const rect = newTabEl.getBoundingClientRect();
    openMenu(newTabMenuItems(), rect.left + 24, rect.bottom);
  }
});

// Double-click on empty space opens a new tab, like the tab strip.
scroller.addEventListener('dblclick', (event) => {
  if (event.target === scroller || event.target === treeEl) newTab();
});
scroller.addEventListener('contextmenu', (event) => {
  if (event.target !== scroller && event.target !== treeEl) return;
  event.preventDefault();
  openMenu(windowMenuItems(), event.clientX, event.clientY);
});

function focusRow(id) {
  const el = rowEls.get(id);
  if (!el) return;
  for (const other of rowEls.values()) other.tabIndex = -1;
  el.tabIndex = 0;
  el.focus();
  focusedId = id;
}

treeEl.addEventListener('focusin', (event) => {
  const el = rowOf(event.target);
  if (el) focusedId = idOf(el);
});

treeEl.addEventListener('keydown', (event) => {
  const el = rowOf(event.target);
  if (!el) return;
  const id = idOf(el);
  const index = visible.findIndex((r) => r.id === id);
  const row = visible[index];
  const handled = () => event.preventDefault();
  switch (event.key) {
    case 'ArrowDown':
      handled();
      if (visible[index + 1]) focusRow(visible[index + 1].id);
      break;
    case 'ArrowUp':
      handled();
      if (visible[index - 1]) focusRow(visible[index - 1].id);
      break;
    case 'Home':
      handled();
      if (visible.length) focusRow(visible[0].id);
      break;
    case 'End':
      handled();
      if (visible.length) focusRow(visible[visible.length - 1].id);
      break;
    case 'ArrowRight':
      handled();
      if (row.collapsed) toggleCollapsed(id);
      else if (row.hasChildren) focusRow(row.kids[0]);
      break;
    case 'ArrowLeft': {
      handled();
      const parent = tree.parentOf.get(id);
      if (row.hasChildren && !row.collapsed && !settings.disableCollapsing) toggleCollapsed(id);
      else if (parent !== null) focusRow(parent);
      break;
    }
    case 'Enter':
    case ' ':
      handled();
      // In a split view's row, switch to the other half.
      activate(row.partner !== null && tabsById.get(id)?.active ? row.partner : id);
      break;
    case 'Delete':
    case 'Backspace':
      handled();
      closeTab(focusedTabOf(id));
      break;
    case 'ContextMenu':
    case 'F10': {
      if (event.key === 'F10' && !event.shiftKey) break;
      handled();
      const rect = el.getBoundingClientRect();
      openTabMenu(id, rect.left + 24, rect.bottom, focusedTabOf(id));
      break;
    }
  }
});

// --- Context menu ------------------------------------------------------------

/**
 * The menu for a row (`id`), opened on one of its tabs (`tabId`: the row's
 * tab, or one half of a split view). Tab actions apply to that tab; tree
 * actions to the whole row, so a split view always stays together.
 */
function tabMenuItems(id, tabId = id) {
  const tab = tabsById.get(tabId);
  if (!tab) return [];
  const row = rowInfo(id);
  const hasChildren = !tab.pinned && (row?.kids.length ?? 0) > 0;
  const parent = tab.pinned ? null : tree.parentOf.get(id);
  // A split view's partner is part of its head's row, not a sibling of its own.
  const partners = new Set(visible.map((r) => r.partner));
  const siblings = (parent === null || parent === undefined ? tree.roots : tree.children.get(parent)).filter(
    (x) => !partners.has(x),
  );
  const ids = selectedIdsFor(tabId);
  const many = ids.length > 1;
  const rows = tab.pinned ? [tabId] : selectedRowsFor(id);
  const rowTabs = rows.flatMap((x) => (rowInfo(x) ? tabsOfRow(rowInfo(x)) : [x]));
  // Both halves of a split view pin together: Chrome keeps them in one place.
  const pinIds = [...new Set(ids.flatMap((x) => (rowIdOf.has(x) ? tabsOfRow(rowInfo(rowIdOf.get(x))) : [x])))];
  // Like Chrome's "Close other tabs" and "Close tabs to the right", pinned tabs stay.
  const last = Math.max(...rowTabs.map((x) => tabsById.get(x)?.index ?? -1));
  const others = [...tabsById.values()].filter((t) => !t.pinned && !rowTabs.includes(t.id)).map((t) => t.id);
  const below = others.filter((x) => tabsById.get(x).index > last);
  return [
    { label: 'New tab as child', action: () => send({ type: 'new-child-tab', tabId: id }), hidden: tab.pinned },
    { label: 'New tab', action: newTab },
    'separator',
    { label: 'Reload', action: () => ids.forEach((x) => quietly(chrome.tabs.reload(x))) },
    { label: 'Duplicate', action: () => send({ type: 'duplicate', ids }) },
    {
      label: tab.pinned ? 'Unpin' : 'Pin',
      action: () => pinIds.forEach((x) => quietly(chrome.tabs.update(x, { pinned: !tab.pinned }))),
    },
    {
      // Only these tabs: Chrome's own "Mute site" mutes every tab of the site.
      label: `${tab.mutedInfo?.muted ? 'Unmute' : 'Mute'} ${many ? 'tabs' : 'tab'}`,
      action: () => ids.forEach((x) => quietly(chrome.tabs.update(x, { muted: !tab.mutedInfo?.muted }))),
    },
    'separator',
    {
      label: row?.collapsed ? 'Expand tree' : 'Collapse tree',
      action: () => toggleCollapsed(id),
      hidden: !hasChildren || settings.disableCollapsing,
    },
    ...collapseAllItems(),
    {
      label: 'Indent',
      action: () => send({ type: 'indent', tabId: id }),
      hidden: tab.pinned,
      disabled: siblings?.indexOf(id) <= 0,
    },
    {
      label: 'Outdent',
      action: () => send({ type: 'outdent', tabId: id }),
      hidden: tab.pinned,
      disabled: parent === null,
    },
    {
      label: rows.length > 1 ? 'Move tabs to new window' : hasChildren ? 'Move tree to new window' : 'Move to new window',
      action: () => send({ type: 'move-to-new-window', ids: rows }),
      hidden: tab.pinned,
    },
    'separator',
    { label: 'Close children', action: () => send({ type: 'close-children', tabId: id }), hidden: !hasChildren },
    { label: 'Close tree', action: () => send({ type: 'close-tree', tabId: id }), hidden: !hasChildren },
    { label: many ? 'Close tabs' : 'Close', action: () => send({ type: 'close-tabs', ids }) },
    {
      label: 'Close other tabs',
      action: () => send({ type: 'close-tabs', ids: others, keep: rowTabs }),
      disabled: !others.length,
    },
    {
      label: 'Close tabs below',
      action: () => send({ type: 'close-tabs', ids: below, keep: rowTabs }),
      disabled: !below.length,
    },
    'separator',
    { label: 'Settings', action: () => chrome.runtime.openOptionsPage() },
  ];
}

function collapseAllItems() {
  const hidden = settings.disableCollapsing;
  return [
    { label: 'Collapse all', action: () => send({ type: 'set-all-collapsed', windowId, collapsed: true }), hidden },
    { label: 'Expand all', action: () => send({ type: 'set-all-collapsed', windowId, collapsed: false }), hidden },
  ];
}

function newTabMenuItems() {
  return [
    { label: 'New tab', action: newTab },
    { label: 'New tab under the current tab', action: newChildOfActive },
  ];
}

function windowMenuItems() {
  return [
    { label: 'New tab', action: newTab },
    'separator',
    ...collapseAllItems(),
    'separator',
    { label: 'Settings', action: () => chrome.runtime.openOptionsPage() },
  ];
}

function openTabMenu(id, x, y, tabId = id) {
  openMenu(tabMenuItems(id, tabId), x, y);
}

function openMenu(items, x, y) {
  menuEl.replaceChildren();
  let lastWasSeparator = true;
  for (const item of items) {
    if (item === 'separator') {
      if (!lastWasSeparator) menuEl.append(Object.assign(document.createElement('div'), { className: 'menu-separator' }));
      lastWasSeparator = true;
      continue;
    }
    if (item.hidden) continue;
    const button = document.createElement('button');
    button.className = 'menu-item';
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.textContent = item.label;
    button.disabled = !!item.disabled;
    button.addEventListener('click', () => {
      closeMenu();
      item.action();
    });
    menuEl.append(button);
    lastWasSeparator = false;
  }
  if (menuEl.lastElementChild?.classList.contains('menu-separator')) menuEl.lastElementChild.remove();

  menuEl.hidden = false;
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  menuEl.style.top = `${Math.max(8, y + height > innerHeight - 8 ? y - height : y)}px`;
  menuEl.querySelector('.menu-item:not(:disabled)')?.focus();
}

function closeMenu() {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuEl.replaceChildren();
}

menuEl.addEventListener('keydown', (event) => {
  const items = [...menuEl.querySelectorAll('.menu-item:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
  else if (event.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
  else if (event.key === 'Escape') closeMenu();
  else return;
  event.preventDefault();
});
addEventListener('mousedown', (event) => {
  if (!menuEl.contains(event.target)) closeMenu();
});
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);
scroller.addEventListener('scroll', closeMenu);

// --- Drag and drop -----------------------------------------------------------

function startDrag(event, ids) {
  const blocked = new Set();
  for (const id of ids) {
    blocked.add(id);
    if (tree.children.has(id)) descendantsOf(tree, id).forEach((d) => blocked.add(d));
  }
  drag = { ids, blocked };
  const urls = ids.map((id) => tabsById.get(id)?.url).filter(Boolean);
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ windowId, ids }));
  // Lets tabs be dropped as links into pages, the omnibox or other apps.
  if (urls.length) {
    event.dataTransfer.setData('text/uri-list', urls.join('\r\n'));
    event.dataTransfer.setData('text/plain', urls.join('\n'));
  }
  for (const id of blocked) rowEls.get(id)?.classList.add('dragging');
}

function endDrag() {
  drag = null;
  for (const el of rowEls.values()) el.classList.remove('dragging');
  clearDropIndicators();
}

treeEl.addEventListener('dragstart', (event) => {
  const el = rowOf(event.target);
  if (!el) return;
  closeMenu();
  startDrag(event, selectedRowsFor(idOf(el)));
});

pinnedEl.addEventListener('dragstart', (event) => {
  const el = rowOf(event.target);
  if (el) startDrag(event, [idOf(el)]);
});

addEventListener('dragend', endDrag);

const isInternalDrag = (event) => event.dataTransfer.types.includes(DRAG_TYPE);
const isLinkDrag = (event) =>
  event.dataTransfer.types.includes('text/uri-list') || event.dataTransfer.types.includes('text/plain');

/** Finds where a drop at the pointer would land in the tree. */
function treeDropTarget(event) {
  const rows = treeEl.children;
  const y = event.clientY;
  for (const el of rows) {
    const rect = el.getBoundingClientRect();
    if (y >= rect.bottom) continue;
    const id = idOf(el);
    if (drag?.blocked.has(id)) return null;
    const ratio = Math.max(0, (y - rect.top) / rect.height);
    const position = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
    return { targetId: id, position, el };
  }
  return { targetId: null, position: 'end' };
}

function clearDropIndicators() {
  dropLine.hidden = true;
  for (const el of document.querySelectorAll('.drop-inside, .drop-before, .drop-after, .drop-target')) {
    el.classList.remove('drop-inside', 'drop-before', 'drop-after', 'drop-target');
  }
}

function showTreeDropIndicator({ targetId, position, el }) {
  clearDropIndicators();
  if (position === 'inside') {
    el.classList.add('drop-inside');
    return;
  }
  const indent = settings.indent;
  // Tree padding, then the row's start padding (--row-start in the CSS).
  const base = 6 + 9;
  let depth = 0;
  let top;
  const scrollerTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
  if (position === 'end') {
    const last = treeEl.lastElementChild;
    top = last ? last.getBoundingClientRect().bottom : treeEl.getBoundingClientRect().top;
  } else {
    const row = rowInfo(targetId);
    const rect = el.getBoundingClientRect();
    depth = row.depth;
    if (position === 'before') top = rect.top;
    else {
      top = rect.bottom;
      if (row.hasChildren && !row.collapsed) depth++;
    }
  }
  dropLine.style.top = `${top - scrollerTop}px`;
  dropLine.style.left = `${base + depth * indent}px`;
  dropLine.hidden = false;
}

scroller.addEventListener('dragover', (event) => {
  const internal = isInternalDrag(event);
  if (!internal && !isLinkDrag(event)) return;
  const target = treeDropTarget(event);
  if (!target) {
    clearDropIndicators();
    event.dataTransfer.dropEffect = 'none';
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = internal ? 'move' : 'copy';
  showTreeDropIndicator(target);
});

scroller.addEventListener('dragleave', (event) => {
  if (!scroller.contains(event.relatedTarget)) clearDropIndicators();
});

scroller.addEventListener('drop', (event) => {
  const target = treeDropTarget(event);
  clearDropIndicators();
  if (!target) return;
  event.preventDefault();
  const { targetId, position } = target;
  const raw = event.dataTransfer.getData(DRAG_TYPE);
  if (raw) {
    const { windowId: sourceWindowId, ids } = JSON.parse(raw);
    send({ type: 'move', ids, sourceWindowId, windowId, targetId, position });
  } else {
    const url = droppedUrl(event.dataTransfer);
    if (url) send({ type: 'open-url', windowId, url, targetId, position });
  }
  endDrag();
});

function droppedUrl(dataTransfer) {
  const list = dataTransfer.getData('text/uri-list');
  const first = list
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#'));
  const text = first || dataTransfer.getData('text/plain').trim();
  try {
    const url = new URL(text);
    return /^(https?|ftp|file):$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Pinned bar: reorder pinned tabs, or pin tabs dropped onto it.
function pinnedDropIndex(event) {
  const tiles = [...pinnedEl.children];
  for (let i = 0; i < tiles.length; i++) {
    const rect = tiles[i].getBoundingClientRect();
    if (event.clientY > rect.bottom || (event.clientY >= rect.top && event.clientX > rect.right)) continue;
    const before = event.clientX < rect.left + rect.width / 2;
    return { index: before ? i : i + 1, el: tiles[i], before };
  }
  return { index: tiles.length, el: tiles[tiles.length - 1], before: false };
}

pinnedEl.addEventListener('dragover', (event) => {
  if (!isInternalDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  const { el, before } = pinnedDropIndex(event);
  if (el) el.classList.add(before ? 'drop-before' : 'drop-after');
  else pinnedEl.classList.add('drop-target');
});

pinnedEl.addEventListener('dragleave', (event) => {
  if (!pinnedEl.contains(event.relatedTarget)) clearDropIndicators();
});

pinnedEl.addEventListener('drop', async (event) => {
  const raw = event.dataTransfer.getData(DRAG_TYPE);
  if (!raw) return;
  event.preventDefault();
  const { index } = pinnedDropIndex(event);
  const { windowId: sourceWindowId, ids } = JSON.parse(raw);
  clearDropIndicators();
  endDrag();
  let at = index;
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      if (sourceWindowId !== windowId) await chrome.tabs.move(id, { windowId, index: -1 });
      if (!tab.pinned) await chrome.tabs.update(id, { pinned: true });
      const current = (await chrome.tabs.get(id)).index;
      await chrome.tabs.move(id, { index: current < at ? at - 1 : at });
      at++;
    } catch {
      // The tab closed mid-drop; carry on with the others.
    }
  }
});

// --- Setup -------------------------------------------------------------------

// --- Full screen ---------------------------------------------------------------
// Chrome keeps showing the side panel next to full screen videos and pages.
// The panel can close itself when its window goes full screen (which resizes
// the panel), but Chrome only lets it open again from a click or shortcut
// (https://issues.chromium.org/issues/578117954). So the first time, the
// panel explains this and lets the user choose instead of just vanishing.

const notice = document.getElementById('fullscreen-notice');

function showNotice(show) {
  notice.hidden = !show;
  document.body.classList.toggle('showing-notice', show);
  if (show) notice.querySelector('.button.filled').focus();
}

async function showShortcut() {
  // The shortcut as Chrome shows it on this platform (⌥⇧T on a Mac), or none
  // if the user removed it.
  const commands = await chrome.commands.getAll().catch(() => []);
  const shortcut = commands.find((c) => c.name === '_execute_action')?.shortcut;
  const el = document.getElementById('fullscreen-shortcut');
  el.replaceChildren();
  if (shortcut) el.append(' or ', Object.assign(document.createElement('kbd'), { textContent: shortcut }));
}

async function watchFullscreen() {
  showShortcut();
  const isFullscreen = async () => (await chrome.windows.get(windowId).catch(() => null))?.state === 'fullscreen';
  // Act only when the window goes full screen. A panel the user opens, or
  // resizes, while the window is already full screen stays open.
  let wasFullscreen = await isFullscreen();
  addEventListener('resize', async () => {
    const fullscreen = await isFullscreen();
    const entered = fullscreen && !wasFullscreen;
    wasFullscreen = fullscreen;
    if (!settings.fullscreenChoiceMade) {
      if (entered) showNotice(true);
      else if (!fullscreen) showNotice(false);
    } else if (entered && settings.hideInFullscreen) {
      window.close();
    }
  });
  const choose = async (hide) => {
    await chrome.storage.sync.set({ hideInFullscreen: hide, fullscreenChoiceMade: true });
    showNotice(false);
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (hide && win?.state === 'fullscreen') window.close();
  };
  document.getElementById('fullscreen-hide').addEventListener('click', () => choose(true));
  document.getElementById('fullscreen-keep').addEventListener('click', () => choose(false));
}

function applySettings(next) {
  settings = next;
  document.documentElement.style.setProperty('--indent', `${settings.indent}px`);
  document.documentElement.classList.toggle('compact', settings.density === 'compact');
  document.documentElement.classList.toggle('no-collapsing', settings.disableCollapsing);
  document.documentElement.classList.toggle('no-guide-lines', settings.hideGuideLines);
}

async function main() {
  newTabEl.querySelector('.new-tab-icon').innerHTML = icon('add');
  // ?windowId= shows another window's tabs (used by the end-to-end test).
  const forced = Number(new URLSearchParams(location.search).get('windowId'));
  windowId = forced || (await chrome.windows.getCurrent()).id;
  applySettings(await loadSettings());
  onSettingsChanged((next) => {
    applySettings(next);
    scheduleRefresh();
  });

  const forThisWindow = (id) => id === undefined || id === windowId;
  chrome.tabs.onCreated.addListener((tab) => forThisWindow(tab.windowId) && scheduleRefresh());
  chrome.tabs.onUpdated.addListener((id, change, tab) => forThisWindow(tab.windowId) && scheduleRefresh());
  chrome.tabs.onActivated.addListener((info) => forThisWindow(info.windowId) && scheduleRefresh());
  chrome.tabs.onHighlighted.addListener((info) => forThisWindow(info.windowId) && scheduleRefresh());
  chrome.tabs.onMoved.addListener((id, info) => forThisWindow(info.windowId) && scheduleRefresh());
  chrome.tabs.onRemoved.addListener(scheduleRefresh);
  chrome.tabs.onAttached.addListener(scheduleRefresh);
  chrome.tabs.onDetached.addListener(scheduleRefresh);
  chrome.tabs.onReplaced.addListener(scheduleRefresh);
  chrome.tabGroups.onCreated.addListener(scheduleRefresh);
  chrome.tabGroups.onUpdated.addListener(scheduleRefresh);
  chrome.tabGroups.onRemoved.addListener(scheduleRefresh);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tree-changed' && forThisWindow(message.windowId)) scheduleRefresh();
  });

  if (!forced) await watchFullscreen();
  await refresh();
}

main();
