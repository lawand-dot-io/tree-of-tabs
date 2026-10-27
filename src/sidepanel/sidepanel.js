import { buildTree, descendantsOf } from '../tree.js';
import { DEFAULTS, loadSettings, onSettingsChanged } from '../settings.js';
import { icon } from './icons.js';

const DRAG_TYPE = 'application/x-tab-tree';

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
let visible = []; // Rows currently shown: { id, depth, hasChildren, collapsed, hidden }
let activeId = null;
let focusedId = null;
let drag = null;

const rowEls = new Map();
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
    const kids = tree.children.get(id);
    const isCollapsed = kids.length > 0 && collapsed.has(id) && !settings.disableCollapsing;
    const hidden = isCollapsed ? descendantsOf(tree, id).length : 0;
    visible.push({ id, depth, hasChildren: kids.length > 0, collapsed: isCollapsed, hidden });
    if (!isCollapsed) for (const kid of kids) walk(kid, depth + 1);
  };
  tree.roots.forEach((id) => walk(id, 0));

  renderPinned(pinnedTabs);
  renderRows();

  const active = [...tabsById.values()].find((t) => t.active);
  if (active && active.id !== activeId) {
    activeId = active.id;
    (rowEls.get(activeId) ?? pinnedEls.get(activeId))?.scrollIntoView({ block: 'nearest' });
  }
  if (focusedId === null || !rowEls.has(focusedId)) focusedId = activeId;
  for (const [id, el] of rowEls) el.tabIndex = id === focusedId ? 0 : -1;
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
  const elements = visible.map((row) => {
    let el = rowEls.get(row.id);
    if (!el) rowEls.set(row.id, (el = createRow(row.id)));
    updateRow(el, tabsById.get(row.id), row);
    used.add(row.id);
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
  el.innerHTML = `
    <button class="twisty" tabindex="-1" aria-label="Expand or collapse">${icon('chevron')}</button>
    <span class="icon">
      <img class="favicon" alt="" draggable="false">
      <span class="fallback-icon">${icon('globe')}</span>
      <span class="spinner"></span>
    </span>
    <span class="title"></span>
    <span class="badge"></span>
    <button class="tab-button audio" tabindex="-1"></button>
    <button class="tab-button close" tabindex="-1" aria-label="Close tab">${icon('close')}</button>`;
  const iconEl = el.querySelector('.icon');
  el.querySelector('.favicon').addEventListener('error', () => iconEl.classList.add('no-favicon'));
  return el;
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
  el.style.setProperty('--depth', row.depth);
  el.classList.toggle('active', tab.active);
  el.classList.toggle('highlighted', tab.highlighted && !tab.active);
  el.classList.toggle('has-children', row.hasChildren);
  el.classList.toggle('collapsed', row.collapsed);
  el.classList.toggle('loading', tab.status === 'loading');
  el.classList.toggle('discarded', !!tab.discarded);
  el.classList.toggle('audible', !!tab.audible);
  el.classList.toggle('muted', !!tab.mutedInfo?.muted);
  el.classList.toggle('dragging', !!drag?.blocked.has(tab.id));
  el.setAttribute('aria-level', row.depth + 1);
  el.setAttribute('aria-selected', tab.active);
  if (row.hasChildren) el.setAttribute('aria-expanded', !row.collapsed);
  else el.removeAttribute('aria-expanded');

  const title = tabTitle(tab);
  const titleEl = el.querySelector('.title');
  if (titleEl.textContent !== title) titleEl.textContent = title;
  el.title = tab.url && tab.url !== title ? `${title}\n${tab.url}` : title;
  el.querySelector('.badge').textContent = row.hidden;
  setFavicon(el.querySelector('.icon'), tab);

  const audio = el.querySelector('.audio');
  const muted = !!tab.mutedInfo?.muted;
  const audioKey = muted ? 'off' : 'on';
  if (audio.dataset.state !== audioKey) {
    audio.dataset.state = audioKey;
    audio.innerHTML = icon(muted ? 'volumeOff' : 'volumeUp');
    audio.setAttribute('aria-label', muted ? 'Unmute tab' : 'Mute tab');
  }

  const group = groups.get(tab.groupId);
  if (group) {
    el.dataset.groupColor = group.color;
    el.style.setProperty('--group-color', `var(--group-${group.color})`);
  } else {
    delete el.dataset.groupColor;
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

function activate(id) {
  quietly(chrome.tabs.update(id, { active: true }));
}

function closeTab(id) {
  quietly(chrome.tabs.remove(id));
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
  const selected = new Set(tabs.filter((t) => t.highlighted).map((t) => t.id));
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  highlight(active, [...selected]);
}

/** Shift+click: select every visible tab between the active tab and this one. */
function selectRange(id) {
  const active = [...tabsById.values()].find((t) => t.active);
  const ids = visible.map((r) => r.id);
  const from = ids.indexOf(active?.id);
  const to = ids.indexOf(id);
  if (from === -1 || to === -1) return activate(id);
  highlight(active, ids.slice(Math.min(from, to), Math.max(from, to) + 1));
}

function highlight(active, ids) {
  // The first index becomes the active tab, so keep the current one first.
  const indexes = [active.index, ...ids.filter((x) => x !== active.id).map((x) => tabsById.get(x).index)];
  quietly(chrome.tabs.highlight({ windowId, tabs: indexes }));
}

function selectedIdsFor(id) {
  const tab = tabsById.get(id);
  const highlighted = visible.map((r) => tabsById.get(r.id)).filter((t) => t?.highlighted);
  return tab?.highlighted && highlighted.length > 1 ? highlighted.map((t) => t.id) : [id];
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
  const id = idOf(el);
  if (event.button === 1) {
    event.preventDefault(); // No autoscroll on middle click.
    return;
  }
  if (event.button !== 0) return;
  if (event.ctrlKey || event.metaKey) return toggleHighlighted(id);
  if (event.shiftKey) return selectRange(id);
  // Keep a multi-selection alive so it can be dragged; activate on click.
  const tab = tabsById.get(id);
  const multi = [...tabsById.values()].filter((t) => t.highlighted).length > 1;
  if (!(multi && tab?.highlighted)) activate(id);
}

function onClick(event) {
  const el = rowOf(event.target);
  if (!el) return;
  const id = idOf(el);
  const button = event.target.closest('button');
  if (button?.classList.contains('twisty')) return toggleCollapsed(id);
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
    closeTab(idOf(el));
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
    openTabMenu(idOf(el), event.clientX, event.clientY);
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
newTabEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') newTab();
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
      else if (row.hasChildren) focusRow(tree.children.get(id)[0]);
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
      activate(id);
      break;
    case 'Delete':
    case 'Backspace':
      handled();
      closeTab(id);
      break;
    case 'ContextMenu':
    case 'F10': {
      if (event.key === 'F10' && !event.shiftKey) break;
      handled();
      const rect = el.getBoundingClientRect();
      openTabMenu(id, rect.left + 24, rect.bottom);
      break;
    }
  }
});

// --- Context menu ------------------------------------------------------------

function tabMenuItems(id) {
  const tab = tabsById.get(id);
  if (!tab) return [];
  const row = rowInfo(id);
  const hasChildren = !tab.pinned && tree.children.get(id)?.length > 0;
  const parent = tab.pinned ? null : tree.parentOf.get(id);
  const siblings = parent === null || parent === undefined ? tree.roots : tree.children.get(parent);
  const ids = selectedIdsFor(id);
  const many = ids.length > 1;
  return [
    { label: 'New tab as child', action: () => send({ type: 'new-child-tab', tabId: id }), hidden: tab.pinned },
    { label: 'New tab', action: newTab },
    'separator',
    { label: 'Reload', action: () => ids.forEach((x) => quietly(chrome.tabs.reload(x))) },
    { label: 'Duplicate', action: () => ids.forEach((x) => quietly(chrome.tabs.duplicate(x))) },
    {
      label: tab.pinned ? 'Unpin' : 'Pin',
      action: () => ids.forEach((x) => quietly(chrome.tabs.update(x, { pinned: !tab.pinned }))),
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
      label: many ? 'Move tabs to new window' : hasChildren ? 'Move tree to new window' : 'Move to new window',
      action: () => send({ type: 'move-to-new-window', ids }),
      hidden: tab.pinned,
    },
    'separator',
    { label: 'Close children', action: () => send({ type: 'close-children', tabId: id }), hidden: !hasChildren },
    { label: 'Close tree', action: () => send({ type: 'close-tree', tabId: id }), hidden: !hasChildren },
    { label: many ? 'Close tabs' : 'Close', action: () => quietly(chrome.tabs.remove(ids)) },
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

function windowMenuItems() {
  return [
    { label: 'New tab', action: newTab },
    'separator',
    ...collapseAllItems(),
    'separator',
    { label: 'Settings', action: () => chrome.runtime.openOptionsPage() },
  ];
}

function openTabMenu(id, x, y) {
  openMenu(tabMenuItems(id), x, y);
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
  startDrag(event, selectedIdsFor(idOf(el)));
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
  // Tree padding, then the row's start padding (--row-start in the CSS) and
  // the twisty with its gap when shown.
  const base = 6 + (settings.disableCollapsing ? 9 : 4 + 16 + 6);
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

function watchFullscreen() {
  showShortcut();
  addEventListener('resize', async () => {
    const win = await chrome.windows.get(windowId).catch(() => null);
    const fullscreen = win?.state === 'fullscreen';
    if (!settings.fullscreenChoiceMade) showNotice(fullscreen);
    else if (fullscreen && settings.hideInFullscreen) window.close();
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

  if (!forced) watchFullscreen();
  await refresh();
}

main();
