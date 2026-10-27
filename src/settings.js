export const DEFAULTS = {
  // Where a tab opened from another tab goes: 'end' (last child) or 'first'.
  childPosition: 'end',
  // What happens to the children of a closed parent: 'promoteFirst',
  // 'promoteAll', or 'closeAll' (they close with it).
  onCloseParent: 'promoteFirst',
  // Closing a collapsed parent closes the whole hidden subtree.
  closeCollapsedTree: true,
  // Treat Ctrl+T new tabs as children of the current tab.
  newTabAsChild: false,
  // Expand collapsed trees when one of their hidden tabs gets activated.
  autoExpandOnActivate: true,
  // Indentation per level in the side panel, in pixels.
  indent: 20,
  // 'comfortable' (32px rows) or 'compact' (26px rows).
  density: 'comfortable',
  // Hide the gray guide lines between parents and children. Tab group
  // lines still show.
  hideGuideLines: false,
  // Turn collapsing off entirely: no arrows, no collapse menu items, and
  // every tree stays expanded.
  disableCollapsing: false,
  // Advanced: closing a window's last tab from the tree opens a new tab
  // first, so the window stays open (Chrome normally closes it).
  keepWindowOnLastTab: false,
  // Close the side panel while its window is full screen (videos, F11).
  hideInFullscreen: true,
  // Whether the user has picked hideInFullscreen yet. Until then, the first
  // full screen explains the choice in the panel instead of closing it.
  fullscreenChoiceMade: false,
};

// Indentation sizes the panel is designed for (see the highlight and guide
// line spacing in sidepanel.css); anything else falls back to the default.
export const INDENTS = [20, 28];

export async function loadSettings() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  if (!INDENTS.includes(settings.indent)) settings.indent = DEFAULTS.indent;
  return settings;
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') loadSettings().then(callback);
  });
}
