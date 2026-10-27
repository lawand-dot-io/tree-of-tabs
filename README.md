# Tab Tree

Tree style tabs for Chrome, modeled on Firefox's
[Tree Style Tab](https://github.com/piroor/treestyletab). Your tabs show as a
tree in Chrome's own side panel, styled to match the browser.

## Features

- **Tabs opened from a tab become its children.** That covers link clicks,
  middle clicks and pages that open new tabs. Blank new tabs (Ctrl+T) start
  their own tree, and a setting can make them children too.
- **Drag and drop** in the panel:
  - drop on the middle of a tab to make it a child,
  - drop on the top or bottom edge to place it before or after as a sibling
    (dropping between a parent and its first child makes it the first child),
  - drop on the empty space below the tabs to make it a top-level tree,
  - drop onto the pinned bar to pin, or drag a pinned tab into the tree to unpin it.

  The whole subtree moves with the tab you drag. With several tabs selected
  (Ctrl/Cmd+click or Shift+click), they all move together. You can also drag
  between windows, and drop links from web pages to open them at that spot.
- **The native tab strip stays in sync.** Tree order and Chrome's tab order
  always match. Moving a tab in the tab strip moves its subtree too, and its
  new parent comes from where you dropped it.
- **Collapse and expand** subtrees with the arrow. A collapsed tree shows how
  many tabs it hides, and it expands again when one of its hidden tabs gets
  focus (for example through Ctrl+Tab).
- **Closing a parent** promotes its first child, like Tree Style Tab does.
  Closing a collapsed parent closes its hidden tabs too. Both are configurable.
- **Context menu**: new child tab, reload, duplicate, pin, mute, collapse or
  expand all, indent and outdent, move a tree to a new window, close children,
  close tree.
- **Keyboard**: arrow keys move through the tree, Left and Right collapse and
  expand, Enter activates, Delete closes, Shift+F10 opens the menu.
  Alt+Shift+T toggles the panel; you can change it at `chrome://extensions/shortcuts`.
- **Persistence**: the tree survives service worker restarts, extension
  updates and browser restarts. After a browser restart it is matched back to
  the restored tabs by URL.
- **Full screen**: Chrome keeps the side panel open next to full screen videos
  and pages, so Tab Tree can close it when you go full screen. The first time,
  the panel shows a short explanation instead of the tree and lets you choose
  whether to hide it; you can change this later in Settings. Chrome doesn't let
  extensions reopen the side panel by themselves
  ([Chromium issue 578117954](https://issues.chromium.org/issues/578117954)),
  so after full screen you bring it back with the toolbar button or Alt+Shift+T.
- Pinned tabs show as a row of icons at the top, tab group colors show as a
  bar on each tab, and a spinner shows while a page loads.

## Looking native

The panel uses Chrome's own Material 3 colors, its system font at 13px, its
icons, its 8px rounded tab shapes, and its favicon cache (so `chrome://` pages
and discarded tabs get the right icon too). It follows light and dark mode.
Chrome doesn't let extensions read the active browser theme, so a custom theme
won't change the panel. The colors are all variables in `src/theme.css` if you
want to tweak them.

For the classic vertical tabs layout, put the side panel on the left: open
`chrome://settings/appearance` and set **Side panel position** to
**Show on left**.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Click the toolbar button (pin it from the puzzle menu) or press Alt+Shift+T
   to open the tree.

Needs Chrome 116 or newer.

## Development

There is no build step. The extension is plain ES modules.

```
src/
  background.js      service worker: owns the tree and keeps the tab strip in sync
  tree.js            pure tree logic (planning moves, inferring parents, ...)
  settings.js        defaults and storage
  theme.css          Chrome-matching colors and type, shared by all pages
  sidepanel/         the tree UI
  options/           the settings page
test/
  tree.test.js       unit tests for tree.js
  e2e/run.js         loads the extension into Chromium and drives real tabs
tools/make-icons.py  regenerates icons/
tools/chrome-devtools-mcp.sh  starts the Chrome DevTools MCP server (see below)
```

```sh
npm test                    # unit tests
npm run test:e2e            # end-to-end, needs Playwright and Chromium
node test/e2e/run.js shots/ # also saves light and dark screenshots
```

### Chrome DevTools MCP server

`.mcp.json` registers the [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp)
with its extension tools, as Chrome's "Build with AI" docs suggest, so Claude
Code can install, reload and inspect the extension in a real browser.
`tools/chrome-devtools-mcp.sh` picks how to run it:

- On your computer it connects to your running Chrome (`--autoConnect`).
  Turn on remote debugging at `chrome://inspect/#remote-debugging` first
  (Chrome 144+).
- In a Claude Code cloud session it starts the preinstalled Chromium headless.

Claude Code asks you to approve project MCP servers the first time it starts
in this folder. The server sends Google usage statistics unless you add
`--no-usage-statistics` to the script.

### How it works

The background worker stores only a parent id per tab, plus which tabs are
collapsed. Sibling order is always the native tab order: the worker keeps each
subtree contiguous in the tab strip, right after its parent. Every tab event
and panel command runs through a single queue, so each one sees the result of
the one before it. Moves the worker makes itself are recorded, so their
`onMoved` events aren't mistaken for the user dragging in the tab strip.

## Limitations

- Chrome's horizontal tab strip can't be hidden by an extension.
- Collapsing a tree only hides tabs in the panel. Chrome has no API for
  hiding tabs in the tab strip.
- Chrome may add or remove a tab from a tab group when the tree moves it
  in or out of the group's range.
