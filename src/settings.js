export const DEFAULTS = {
  // Where a tab opened from another tab goes: 'end' (last child) or 'first'.
  childPosition: 'end',
  // What happens to the children of a closed parent: 'promoteFirst' or 'promoteAll'.
  onCloseParent: 'promoteFirst',
  // Closing a collapsed parent closes the whole hidden subtree.
  closeCollapsedTree: true,
  // Treat Ctrl+T new tabs as children of the current tab.
  newTabAsChild: false,
  // Expand collapsed trees when one of their hidden tabs gets activated.
  autoExpandOnActivate: true,
  // Indentation per level in the side panel, in pixels.
  indent: 16,
  // 'comfortable' (32px rows) or 'compact' (26px rows).
  density: 'comfortable',
  // Where the tree shows: 'sidePanel' (Chrome's side panel) or 'docked' (a
  // narrow window attached to the side of each browser window).
  displayMode: 'sidePanel',
  // Docked mode: which side of the browser window, how wide (remembered when
  // the dock is resized), and whether every new window gets one.
  dockSide: 'left',
  dockWidth: 220,
  dockAutoOpen: true,
};

export async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') loadSettings().then(callback);
  });
}
