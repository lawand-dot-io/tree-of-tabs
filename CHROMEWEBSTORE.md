# Chrome Web Store Listing — Tab Tree

> Last Updated: 2026-10-27

Everything needed to fill in the Chrome Web Store Developer Dashboard. Copy each
field from here.

## Still needed before submitting

- [ ] Publisher name, contact email and support URL (see [Developer Info](#developer-info))
- [ ] At least one screenshot (see [Graphics & Assets](#graphics--assets))
- [ ] Host the privacy policy below at a public URL and put the link in the dashboard
- [ ] Choose visibility (public or unlisted)

## Store Listing

**Extension Name**

Tab Tree

**Short Description** (120 of 132 characters; same as the manifest description)

See your tabs as a tree in the side panel. Tabs you open from a page nest under it, and you can drag them to reorganize.

**Detailed Description** (plain text: the store strips Markdown)

```
See your tabs as a tree in the side panel. Every tab you open from a page appears nested under that page, so you can always tell where a tab came from and which tabs belong together.

FEATURES
• Automatic nesting: links you open in a new tab, middle-clicked links and pages that open tabs show up under the tab they came from. Tabs you open yourself, from the address bar, a bookmark or a new tab, start their own tree.
• Drag and drop: drop a tab onto another to nest it, between tabs to reorder it, or below the list to start a new tree. The whole branch moves with it, and you can drag several selected tabs at once or move them to another window.
• Stays in step with your tabs: the tree and the order of tabs at the top of the window always match. Moving a tab at the top moves its branch too.
• Collapse branches you are not using, with a count of the tabs inside. If you never collapse, you can turn collapsing off entirely.
• Closing a parent tab keeps its branch together: its first child takes its place. You can also choose to close the whole branch with it.
• Pinned tabs show as a row of icons at the top. Tab group colors appear next to each tab.
• Right-click a tab for quick actions: new tab inside this branch, reload, duplicate, pin, mute, indent or outdent, move a branch to a new window, close a branch.
• Keyboard friendly: move through the tree with the arrow keys, open the menu with Shift+F10, and show or hide the tree with a keyboard shortcut (Alt+Shift+T by default, Option+Shift+T on a Mac).
• Looks like part of the browser, in light and dark mode.
• Full screen videos get the whole screen: the tree can hide itself when a page goes full screen.
• Remembers your tree when you restart the browser.

HOW TO USE
1. Click the Tab Tree button in the toolbar (or use its keyboard shortcut) to open the tree in the side panel.
2. Browse as usual. Tabs you open from a page appear under it.
3. Drag tabs to reorganize. Right-click a tab for more actions.
4. Right-click the tree and choose Settings to change how new and closed tabs behave, the spacing, and more.
Tip: to put the tree on the left, open the browser's appearance settings and set the side panel position to the left.

PRIVACY
Tab Tree never sends your tabs or browsing anywhere. It keeps the shape of your tree on your own computer so it can rebuild it after a restart, and it has no analytics, no accounts and no servers. Your settings sync with your browser profile if you use browser sync.

PERMISSIONS
• "Read your browsing history": Tab Tree needs the titles and addresses of your open tabs to show them in the tree and to know which tab a new tab was opened from. It does not read the content of any page, and it does not see the history of pages you closed.

SUPPORT
Found a bug or have an idea? Contact the developer through the support link on this page.
```

**Category**

Productivity. If the dashboard asks for a subcategory, Tools fits best.

**Single Purpose**

Shows the user's open tabs as a tree in the browser's side panel, nesting each tab under the tab it was opened from so the user can organize them.

**Primary Language**

English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 | 1280×800 | ⬜ Not created | |
| Screenshot 2 | 1280×800 | ⬜ Not created | |
| Screenshot 3 | 1280×800 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

### Screenshot Notes

Take these in a real browser window at 1280×800, with the side panel open and a
realistic set of tabs (avoid sites whose names or logos could be read as an
endorsement).

1. The tree next to a page: two or three branches, one of them two levels deep,
   with the active tab highlighted.
2. Drag and drop in progress: a tab being dropped into another branch, with the
   blue drop line or the highlighted target visible.
3. The right-click menu open on a tab with children.
4. Dark mode.
5. The settings page.

## Permissions Justification

There are no host permissions: Tab Tree never reads or changes the content of
web pages. There is no `scripting`, `history`, `bookmarks` or `<all_urls>`.

| Permission | Type | Justification |
|------------|------|---------------|
| `tabs` | permissions | The tree shows every open tab with its title, website address and icon, so it needs those three properties of each tab. The tree's actions (activate, move, close, reload, duplicate, pin and mute tabs) act on the user's own tabs when they click, drag or use the menu. Tab content is never read. |
| `webNavigation` | permissions | Tells the extension when a page opens a new tab (a link opened in a new tab, a middle-clicked link, or a page opening a window), and which tab that page is in. That is how a new tab gets nested under the page it came from, while tabs the user opens from the address bar, a bookmark or the browser's menus start their own tree. Only that event is used; the extension doesn't track the pages visited. |
| `tabGroups` | permissions | Reads the color of each tab group so the tree can show a matching color bar next to tabs that are in a group. Groups are never changed. |
| `sidePanel` | permissions | The tree is displayed in the browser's side panel. Clicking the toolbar button or pressing the keyboard shortcut opens it, and it closes itself when a page goes full screen if the user chose that. |
| `storage` | permissions | Saves the tree's structure (which tab is nested under which, and which branches are collapsed) so it survives restarts, and saves the user's settings, such as where new child tabs go and the row spacing. |
| `favicon` | permissions | Shows each tab's website icon from the browser's own icon cache. This is how browser pages and tabs that have been put to sleep still get their icon, without downloading anything. |

The install prompt shows `tabs` and `webNavigation` together as "Read your browsing history". The detailed
description explains this in plain words.

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No. Nothing is sent to the developer or
to any third party.

What it handles, all of it kept on the user's device:

| Data | Where it is kept | Why |
|------|------------------|-----|
| Open tabs' titles, addresses and icons | Only in memory while the tree is shown | To display the tree |
| Tree structure: which tab is nested under which, plus collapsed branches | Browser session storage, cleared when the browser closes | To keep the tree when the extension's background process restarts |
| A copy of the tree per window (tab addresses and their nesting, for the last 12 windows) | Local extension storage on the device | To rebuild the tree after the browser restarts, when tabs get new internal numbers |
| Settings (choices on the settings page) | Browser sync storage | So settings follow the user's browser profile. When browser sync is on, the browser syncs them through the user's Google account. They contain no browsing data. |

The tree also displays each tab's website icon. For most tabs, the icon image is
loaded from the tab's own website (the same image the browser shows on the tab).
This doesn't send any data to the developer.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | | No |
| Health info | No | No | | No |
| Financial info | No | No | | No |
| Authentication info | No | No | | No |
| Personal communications | No | No | | No |
| Location | No | No | | No |
| Web history | No (open tabs' addresses are handled on the device only, see above) | No | Displaying and restoring the tree | No |
| User activity | No | No | | No |
| Website content | No | No | | No |

### Data Use Certification

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL**

Not hosted yet. Publish the text below at a stable public address (for example
GitHub Pages or a public gist), check that the link loads, and enter it in the
dashboard.

```
Privacy Policy for Tab Tree

Last updated: October 27, 2026

What data Tab Tree handles
Tab Tree shows your open tabs as a tree. To do that it reads the title, website address and icon of each open tab, and remembers which tab each tab was opened from. It does not read the content of web pages, and it does not access the history of pages you have closed.

How it is stored
- The tree's structure is kept in the browser's session storage, which the browser clears when it closes.
- A copy of the tree for your most recent windows (tab addresses and how they are nested, for up to 12 windows) is kept in the extension's local storage on your computer, so the tree can be rebuilt after you restart the browser.
- Your settings are kept in the browser's sync storage. If browser sync is turned on, your browser syncs them to your other devices through your Google account. Settings contain only your choices on the settings page, no browsing data.

How it is used
Only to display your tabs as a tree and to restore that tree after a restart.

Third-party services
Tab Tree does not use any third-party services, analytics or advertising, and it has no servers. To show a tab's icon, it loads the icon image from that tab's own website, as the browser does for the tab itself.

Data sharing
Tab Tree does not send your data to the developer or to anyone else, and does not sell it.

Retention and deletion
Session data is cleared when you close the browser. The saved copy of the tree is replaced as you use the browser and keeps only your most recent windows. Removing Tab Tree from the browser deletes everything it stored.

Changes to this policy
If Tab Tree's data practices change, this policy will be updated and the date above changed before the new version is published.

Contact
[contact email or support page]
```

## Distribution

**Visibility**: to decide. Public, or Unlisted to share with a few people first.

**Regions**: All regions

## Developer Info

**Publisher Name**: to fill in

**Contact Email**: to fill in. It is shown publicly, and Google sends policy notices
to it, so use an address that is checked.

**Support URL / Email**: to fill in. The GitHub repository's Issues page works if
the repository is public.

**Homepage URL**: optional, for example the GitHub repository.

## Packaging

Only these go in the ZIP: `manifest.json`, `icons/` and `src/`. The tests, tools,
`.claude/`, `.mcp.json`, `package.json`, `README.md` and this file stay out.

```sh
zip -r tab-tree-v0.1.0.zip manifest.json icons src -x "*.DS_Store"
```

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-10-27 | First release: tab tree in the side panel, automatic nesting, drag and drop, choice of what happens to a closed parent's children, collapsing (or turning it off), pinned tabs, tab group colors, right-click actions, keyboard navigation, hiding during full screen, tree restored after restart | Draft |

## Review Notes

### Known Issues / Limitations

- The side panel has a minimum width set by the browser, which extensions can't
  lower (Chromium issue 40926440).
- The tab row at the top of the window can't be hidden by an extension.
- Collapsing a branch only hides its tabs in the tree, not at the top of the window.
- After a page goes full screen, the browser doesn't let extensions reopen the side
  panel by themselves; the user reopens it with the toolbar button or shortcut
  (reported as Chromium issue 578117954). The first time, the panel explains this
  and lets the user choose whether to hide it.
- Requires Chrome 116 or newer.
- Web history disclosure: open tabs' addresses are only handled on the device, so
  "Web history" is answered No above. If a reviewer counts storing tab addresses
  locally as handling web history, check that box and add the same explanation.

### Rejection History

None yet.
