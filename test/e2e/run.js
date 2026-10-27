// End-to-end check: loads the unpacked extension into Chromium, drives real
// tabs, and checks the tree the background keeps plus what the panel renders.
// Usage: node test/e2e/run.js [screenshot-dir]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// require() also finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const shots = process.argv[2];

// Pages with links, so tabs get a real opener like they do for users.
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1)) || 'home';
  res.setHeader('content-type', 'text/html');
  res.end(`<title>Page ${name}</title><h1>${name}</h1>
    <a id="child" href="${req.url}-child" target="_blank">open child</a>`);
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'tree-of-tabs-')), {
  headless: true,
  channel: 'chromium', // The headless shell cannot load extensions.
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 320, height: 640 },
});

let failures = 0;
async function check(name, fn) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000)),
    ]);
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`not ok - ${name}\n  ${error.stack.split('\n').slice(0, 12).join('\n  ')}`);
  }
}

try {
  let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

  // Snapshot of the window as [title, depth] pairs in native tab order.
  const outline = () =>
    worker.evaluate(async () => {
      const { tree } = await chrome.storage.session.get('tree');
      const parents = new Map(tree.parents);
      const tabs = (await chrome.tabs.query({ windowId: self.mainWindowId })).sort((a, b) => a.index - b.index);
      const depth = (id) => {
        let d = 0;
        for (let p = parents.get(id); p != null; p = parents.get(p)) d++;
        return d;
      };
      return tabs.map((t) => `${' '.repeat(depth(t.id))}${t.pinned ? '[pinned] ' : ''}${t.title}`).join('\n');
    });
  const idOf = (title) =>
    worker.evaluate(async (title) => (await chrome.tabs.query({ title }))[0]?.id, title);

  // Wait for the worker to finish initializing.
  await worker.evaluate(async () => {
    while (!(await chrome.storage.session.get('tree')).tree) await new Promise((r) => setTimeout(r, 50));
  });

  const first = context.pages()[0];
  await first.goto(`${base}/A`);
  // The panel runs in its own popup window showing the main window, so
  // activating tabs never hides it.
  const mainWindowId = await worker.evaluate(async () => (await chrome.windows.getLastFocused()).id);
  await worker.evaluate((id) => (self.mainWindowId = id), mainWindowId);
  const panelUrl = `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?windowId=${mainWindowId}`;
  const [panel] = await Promise.all([
    context.waitForEvent('page'),
    worker.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 320, height: 640 }), panelUrl),
  ]);
  await panel.setViewportSize({ width: 320, height: 640 });
  await panel.waitForLoadState();
  // Any uncaught error in the panel fails the run (checked at the end).
  const panelErrors = [];
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  await settle();
  // Playwright's mouse-driven drag stalls on extension pages, so dispatch the
  // HTML5 drag events directly. `fraction` is where on the target row to drop.
  const drag = (sourceText, targetSelector, fraction = 0.5) =>
    panel.evaluate(
      ({ sourceText, targetSelector, fraction }) => {
        const source = [...document.querySelectorAll('.tab')].find(
          (el) => el.querySelector('.title').textContent === sourceText,
        );
        const target = document.querySelector(targetSelector);
        const rect = target.getBoundingClientRect();
        const at = { clientX: rect.left + 40, clientY: rect.top + rect.height * fraction, bubbles: true };
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { ...at, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer, cancelable: true }));
        target.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer, cancelable: true }));
        source.dispatchEvent(new DragEvent('dragend', { ...at, dataTransfer }));
      },
      { sourceText, targetSelector, fraction },
    );
  const rowSelector = (text) =>
    panel.evaluate((text) => {
      const rows = [...document.querySelectorAll('.tab')];
      return `.tab[data-id="${rows.find((el) => el.querySelector('.title').textContent === text).dataset.id}"]`;
    }, text);

  // Opens a tab the way people do: by clicking (or middle-clicking) a link
  // on a page. Every test page has one link; `name` points it somewhere.
  const openFrom = async (page, name, { middle = false } = {}) => {
    if (name) await page.evaluate((href) => (document.getElementById('child').href = href), `/${encodeURIComponent(name)}`);
    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      page.click('#child', middle ? { button: 'middle' } : {}),
    ]);
    await opened.waitForLoadState();
    return opened;
  };
  const clickLink = (page) => openFrom(page);
  // A tab that no page opened, like one from the address bar.
  const openRoot = async (name) => {
    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      worker.evaluate(
        ({ url, windowId }) => chrome.tabs.create({ windowId, url, active: false }),
        { url: `${base}/${encodeURIComponent(name)}`, windowId: mainWindowId },
      ),
    ]);
    await opened.waitForLoadState();
    return opened;
  };

  await check('a link opened from a tab becomes its child', async () => {
    const child = await clickLink(first);
    await clickLink(child);
    await clickLink(first);
    await settle();
    assert.equal(
      await outline(),
      ['Page A', ' Page A-child', '  Page A-child-child', ' Page A-child'].join('\n'),
    );
  });

  await check('a blank new tab starts its own tree', async () => {
    await worker.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: false }));
    await settle();
    const lines = (await outline()).split('\n');
    assert.equal(lines.at(-1), 'about:blank');
  });

  await check('the panel renders the tree with indentation', async () => {
    await settle();
    const rows = await panel.$$eval('.tab', (els) =>
      els.map((el) => `${' '.repeat(Number(el.style.getPropertyValue('--depth')))}${el.querySelector('.title').textContent}`),
    );
    assert.deepEqual(rows.slice(0, 4), ['Page A', ' Page A-child', '  Page A-child-child', ' Page A-child']);
  });

  await check('collapsing hides descendants and shows a count', async () => {
    const parentRow = panel.locator('.tab', { hasText: 'Page A' }).first();
    await parentRow.hover(); // An expanded tree's arrow only shows on hover.
    await parentRow.locator('.twisty').click();
    await settle();
    const titles = await panel.$$eval('.tab .title', (els) => els.map((e) => e.textContent));
    assert.ok(!titles.includes('Page A-child'));
    assert.equal(await panel.locator('.tab.collapsed .badge').first().textContent(), '3');
    await parentRow.locator('.twisty').click();
    await settle();
  });

  await check('arrows show on collapsed trees, and on expanded ones only when pointed at', async () => {
    const parentRow = panel.locator('.tab', { hasText: 'Page A' }).first();
    const twisty = parentRow.locator('.twisty');
    await panel.mouse.move(300, 630);
    assert.equal(await twisty.isVisible(), false, 'expanded, not pointed at');
    await parentRow.hover();
    assert.equal(await twisty.isVisible(), true, 'pointed at');
    await twisty.click();
    await settle();
    await panel.mouse.move(300, 630);
    assert.equal(await twisty.isVisible(), true, 'collapsed');
    await parentRow.hover();
    await twisty.click();
    await settle();
  });

  await check('dragging a tab onto another makes it a child', async () => {
    await drag('about:blank', await rowSelector('Page A-child-child'), 0.5);
    await settle();
    assert.equal(
      await outline(),
      ['Page A', ' Page A-child', '  Page A-child-child', '   about:blank', ' Page A-child'].join('\n'),
    );
  });

  await check('dragging a subtree to the empty area makes it a root', async () => {
    await drag('Page A-child', '#new-tab');
    await settle();
    assert.equal(
      await outline(),
      ['Page A', ' Page A-child', 'Page A-child', ' Page A-child-child', '  about:blank'].join('\n'),
    );
  });

  await check('dropping above a tab inserts before it as a sibling', async () => {
    await drag('about:blank', '.tab', 0.1);
    await settle();
    assert.equal(
      await outline(),
      ['about:blank', 'Page A', ' Page A-child', 'Page A-child', ' Page A-child-child'].join('\n'),
    );
  });

  await check('moving a parent in the tab strip brings its subtree along', async () => {
    const id = await idOf('Page A');
    await worker.evaluate((id) => chrome.tabs.move(id, { index: -1 }), id);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(
      await outline(),
      ['about:blank', 'Page A-child', ' Page A-child-child', 'Page A', ' Page A-child'].join('\n'),
    );
  });

  await check('closing a parent promotes its first child', async () => {
    // Give "Page A" a second child first.
    await clickLink(first);
    await settle();
    await worker.evaluate(async (id) => chrome.tabs.remove(id), await idOf('Page A'));
    await settle();
    assert.equal(
      await outline(),
      ['about:blank', 'Page A-child', ' Page A-child-child', 'Page A-child', ' Page A-child'].join('\n'),
    );
  });

  await check('with "Close its children too", closing a parent closes its whole branch', async () => {
    await worker.evaluate(() => chrome.storage.sync.set({ onCloseParent: 'closeAll' }));
    const parentPage = await openRoot('Close parent');
    const childPage = await openFrom(parentPage, 'Close child');
    await openFrom(childPage, 'Close grandchild', { middle: true });
    await openFrom(parentPage, 'Close sibling', { middle: true });
    await openRoot('Bystander');
    await settle();
    const ids = {};
    for (const name of ['parent', 'child', 'grandchild', 'sibling']) ids[name] = await idOf(`Page Close ${name}`);
    ids.bystander = await idOf('Page Bystander');
    await worker.evaluate((id) => chrome.tabs.remove(id), ids.parent);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const alive = await worker.evaluate(
      async (ids) => Object.fromEntries(await Promise.all(
        Object.entries(ids).map(async ([name, id]) => [name, !!(await chrome.tabs.get(id).catch(() => null))]),
      )),
      ids,
    );
    assert.deepEqual(alive, { parent: false, child: false, grandchild: false, sibling: false, bystander: true });
    await worker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
      await chrome.storage.sync.remove('onCloseParent');
    }, ids.bystander);
    await settle();
  });

  await check('tabs the browser or another extension opens are not children', async () => {
    const parentOf = (url) =>
      worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        const { tree } = await chrome.storage.session.get('tree');
        return { id: tab?.id, parent: new Map(tree.parents).get(tab?.id) };
      }, url);
    // Chrome gives these an opener (the active tab), but no page opened them.
    await panel.evaluate(() => chrome.runtime.openOptionsPage());
    await settle();
    const options = await parentOf(`chrome-extension://${extensionId}/src/options/options.html`);
    assert.ok(options.id, 'the options page opened');
    assert.equal(options.parent, null, 'the options page is not a child');
    const created = await worker.evaluate(async (windowId) => {
      // An extension creating a tab "from" a web page (extension pages as
      // openers are trusted, see the settings page links test).
      const [web] = (await chrome.tabs.query({ windowId })).filter((t) => t.url.startsWith('http'));
      const tab = await chrome.tabs.create({ windowId, url: 'about:blank', openerTabId: web.id, active: false });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const { tree } = await chrome.storage.session.get('tree');
      return { id: tab.id, parent: new Map(tree.parents).get(tab.id) };
    }, mainWindowId);
    assert.equal(created.parent, null, 'a tab another extension opens is not a child');
    await worker.evaluate((ids) => chrome.tabs.remove(ids), [options.id, created.id]);
    await settle();
  });

  await check('a duplicate goes right after the original, as its sibling', async () => {
    const original = await openRoot('Original');
    await openFrom(original, 'Original child');
    await settle();
    const originalId = await idOf('Page Original');
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'duplicate', ids: [id] }), originalId);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const lines = (await outline()).split('\n');
    const at = lines.indexOf('Page Original');
    assert.deepEqual(lines.slice(at, at + 3), ['Page Original', ' Page Original child', 'Page Original']);
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ title: 'Page Original*' });
      await chrome.tabs.remove(tabs.map((t) => t.id));
    });
    await settle();
  });

  await check('closing the last tab from the tree keeps the window only when the setting is on', async () => {
    const openWindow = async (name) => {
      const [page] = await Promise.all([
        context.waitForEvent('page'),
        worker.evaluate((url) => chrome.windows.create({ url }), `${base}/${encodeURIComponent(name)}`),
      ]);
      await page.waitForLoadState();
      const tabId = await idOf(`Page ${name}`);
      const windowId = await worker.evaluate(async (id) => (await chrome.tabs.get(id)).windowId, tabId);
      return { page, tabId, windowId };
    };
    const closeFromTree = (ids) => panel.evaluate((ids) => chrome.runtime.sendMessage({ type: 'close-tabs', ids }), ids);
    const windowTabs = (windowId) =>
      worker.evaluate((id) => chrome.tabs.query({ windowId: id }).then((tabs) => tabs.map((t) => t.pendingUrl || t.url)), windowId);
    const windowExists = (windowId) => worker.evaluate((id) => chrome.windows.get(id).then(() => true, () => false), windowId);

    // Off (the default): the window closes with its last tab, as in Chrome.
    const plain = await openWindow('Last tab plain');
    await closeFromTree([plain.tabId]);
    await settle();
    assert.equal(await windowExists(plain.windowId), false);

    // On: a new tab takes the last tab's place and the window stays.
    await worker.evaluate(() => chrome.storage.sync.set({ keepWindowOnLastTab: true }));
    const kept = await openWindow('Last tab kept');
    await closeFromTree([kept.tabId]);
    await settle();
    assert.equal(await windowExists(kept.windowId), true);
    assert.deepEqual(await windowTabs(kept.windowId), ['chrome://newtab/']);

    // On, with a branch that closes along with its parent.
    await worker.evaluate(() => chrome.storage.sync.set({ onCloseParent: 'closeAll' }));
    const branch = await openWindow('Last branch');
    await openFrom(branch.page, 'Last branch child');
    await settle();
    await closeFromTree([branch.tabId]);
    await settle();
    assert.equal(await windowExists(branch.windowId), true);
    assert.deepEqual(await windowTabs(branch.windowId), ['chrome://newtab/']);

    await worker.evaluate(async (ids) => {
      await Promise.all(ids.map((id) => chrome.windows.remove(id)));
      await chrome.storage.sync.remove(['keepWindowOnLastTab', 'onCloseParent']);
    }, [kept.windowId, branch.windowId]);
    await settle();
  });

  await check('closing several tabs at once closes only those, not their branches', async () => {
    const alive = (ids) =>
      worker.evaluate(
        async (ids) => Promise.all(ids.map((id) => chrome.tabs.get(id).then(() => true, () => false))),
        ids,
      );
    // Like Chrome's "Close other tabs" while keeping a child: its parent
    // closes in the same moment, and the kept child must stay.
    await worker.evaluate(() => chrome.storage.sync.set({ onCloseParent: 'closeAll' }));
    const parentPage = await openRoot('Batch parent');
    await openFrom(parentPage, 'Batch child');
    await openRoot('Batch other');
    await settle();
    const [parent, child, other] = [
      await idOf('Page Batch parent'),
      await idOf('Page Batch child'),
      await idOf('Page Batch other'),
    ];
    await worker.evaluate((ids) => chrome.tabs.remove(ids), [parent, other]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(await alive([parent, child, other]), [false, true, false]);
    await worker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
      await chrome.storage.sync.remove('onCloseParent');
    }, child);

    // The same with a collapsed tree and the default settings.
    const folded = await openRoot('Folded parent');
    await openFrom(folded, 'Folded child');
    await openRoot('Folded other');
    await settle();
    const [foldedParent, foldedChild, foldedOther] = [
      await idOf('Page Folded parent'),
      await idOf('Page Folded child'),
      await idOf('Page Folded other'),
    ];
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'set-collapsed', tabId: id, collapsed: true }), foldedParent);
    await worker.evaluate((ids) => chrome.tabs.remove(ids), [foldedParent, foldedOther]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(await alive([foldedParent, foldedChild, foldedOther]), [false, true, false]);
    await worker.evaluate((id) => chrome.tabs.remove(id), foldedChild);
    await settle();
  });

  await check('"Close other tabs" and "Close tabs below" keep the chosen tab and pinned tabs', async () => {
    // In a window of its own, with its own panel, so the main window's tabs stay.
    await worker.evaluate(() => chrome.storage.sync.set({ onCloseParent: 'closeAll' }));
    const [firstPage, windowId] = await Promise.all([
      context.waitForEvent('page'),
      worker.evaluate(async (url) => (await chrome.windows.create({ url })).id, `${base}/Others parent`),
    ]);
    await firstPage.waitForLoadState();
    const openIn = async (name, extra = {}) => {
      const [opened] = await Promise.all([
        context.waitForEvent('page'),
        worker.evaluate((args) => chrome.tabs.create({ active: false, ...args }), { windowId, url: `${base}/${name}`, ...extra }),
      ]);
      await opened.waitForLoadState();
      return opened;
    };
    await openFrom(firstPage, 'Others child'); // The tab to keep, under a parent that closes.
    // Only the parent closes, by itself, so the kept child can't slip in with its branch.
    await openIn('Others pinned', { pinned: true });
    await settle();
    const titles = () =>
      worker.evaluate(
        async (windowId) => (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index).map((t) => t.title),
        windowId,
      );
    const [otherPanel] = await Promise.all([
      context.waitForEvent('page'),
      worker.evaluate(
        (url) => chrome.windows.create({ url, type: 'popup', width: 320, height: 640 }),
        panelUrl.replace(`windowId=${mainWindowId}`, `windowId=${windowId}`),
      ),
    ]);
    await otherPanel.waitForLoadState();
    await settle();
    const menu = async (title, item) => {
      await otherPanel.locator('.tab', { hasText: title }).click({ button: 'right' });
      await otherPanel.locator('.menu-item', { hasText: item }).click();
      await new Promise((resolve) => setTimeout(resolve, 800));
    };

    await menu('Page Others child', 'Close other tabs');
    assert.deepEqual(await titles(), ['Page Others pinned', 'Page Others child']);

    await openIn('Others second');
    await openIn('Others third');
    await openIn('Others fourth');
    await settle();
    await menu('Page Others second', 'Close tabs below');
    assert.deepEqual(await titles(), ['Page Others pinned', 'Page Others child', 'Page Others second']);

    await otherPanel.locator('.tab', { hasText: 'Page Others second' }).click({ button: 'right' });
    assert.ok(await otherPanel.locator('.menu-item', { hasText: 'Close tabs below' }).isDisabled(), 'nothing below');
    await otherPanel.keyboard.press('Escape');
    await otherPanel.close();
    await worker.evaluate(async (windowId) => {
      await chrome.windows.remove(windowId);
      await chrome.storage.sync.remove('onCloseParent');
    }, windowId);
    await settle();
  });

  await check('links on the settings page open as its children', async () => {
    const optionsUrl = `chrome-extension://${extensionId}/src/options/options.html`;
    const [options] = await Promise.all([
      context.waitForEvent('page'),
      worker.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId }), { url: optionsUrl, windowId: mainWindowId }),
    ]);
    await options.waitForLoadState();
    // Point the links at local pages; the test can't reach the real sites.
    await options.evaluate((base) => {
      document.querySelectorAll('.about a').forEach((a, i) => (a.href = `${base}/Settings link ${i}`));
    }, base);
    const optionsId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, optionsUrl);
    await options.click('.about a >> nth=0');
    // People can only click links on the tab in front.
    await options.bringToFront();
    await options.click('.about a >> nth=1', { button: 'middle' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const opened = await worker.evaluate(async (optionsId) => {
      const { tree } = await chrome.storage.session.get('tree');
      const parents = new Map(tree.parents);
      const tabs = (await chrome.tabs.query({})).filter((t) => (t.pendingUrl || t.url).includes('Settings%20link'));
      return tabs.map((t) => parents.get(t.id) === optionsId);
    }, optionsId);
    assert.deepEqual(opened, [true, true], 'a click and a middle click both nest under the settings page');
    await worker.evaluate(async (optionsId) => {
      const tabs = (await chrome.tabs.query({})).filter((t) => (t.pendingUrl || t.url).includes('Settings%20link'));
      await chrome.tabs.remove([optionsId, ...tabs.map((t) => t.id)]);
    }, optionsId);
    await settle();
  });

  await check('pinned tabs leave the tree and show in the pinned bar', async () => {
    await worker.evaluate(async (id) => chrome.tabs.update(id, { pinned: true }), await idOf('about:blank'));
    await settle();
    assert.equal(await panel.locator('.pinned-tab').count(), 1);
    assert.ok((await outline()).startsWith('[pinned] about:blank'));
  });

  await check('the menu offers to mute just the tab', async () => {
    await panel.locator('.tab').first().click({ button: 'right' });
    const labels = await panel.$$eval('.menu-item', (items) => items.map((item) => item.textContent));
    await panel.keyboard.press('Escape');
    assert.ok(labels.includes('Mute tab'), labels.join(', '));
    assert.ok(!labels.some((label) => label.includes('site')));
  });

  await check('clicking a tab that just closed is not an error', async () => {
    const id = await worker.evaluate(async (windowId) => {
      const tab = await chrome.tabs.create({ windowId, url: 'about:blank#closing', active: false });
      return tab.id;
    }, mainWindowId);
    await settle();
    const row = panel.locator(`.tab[data-id="${id}"]`);
    // Remove the tab behind the panel's back, then click its row before the
    // panel has caught up.
    await row.evaluate((el, id) => {
      chrome.tabs.remove(id);
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      el.querySelector('.close').click();
    }, id);
    await settle();
    assert.deepEqual(panelErrors, []);
  });

  await check('the new tab button opens a tree, or a child when middle-clicked or from its menu', async () => {
    const newest = () =>
      worker.evaluate(async (windowId) => {
        const tabs = await chrome.tabs.query({ windowId });
        const tab = tabs.reduce((a, b) => (b.id > a.id ? b : a));
        const { tree } = await chrome.storage.session.get('tree');
        return { id: tab.id, parent: new Map(tree.parents).get(tab.id) };
      }, mainWindowId);
    const activeId = await worker.evaluate(
      async (windowId) => (await chrome.tabs.query({ windowId, active: true }))[0].id,
      mainWindowId,
    );
    const before = (await newest()).id;

    await panel.click('#new-tab', { button: 'middle' });
    await settle();
    const child = await newest();
    assert.notEqual(child.id, before);
    assert.equal(child.parent, activeId, 'middle click: child of the active tab');
    await worker.evaluate((id) => chrome.tabs.remove(id), child.id);
    await settle();

    await panel.click('#new-tab');
    await settle();
    const root = await newest();
    assert.notEqual(root.id, child.id);
    assert.equal(root.parent, null, 'left click: a new tree');
    await worker.evaluate((id) => chrome.tabs.remove(id), root.id);
    await settle();

    await panel.click('#new-tab', { button: 'right' });
    const labels = await panel.$$eval('.menu-item', (items) => items.map((item) => item.textContent));
    assert.deepEqual(labels, ['New tab', 'New tab under the current tab']);
    await panel.locator('.menu-item', { hasText: 'under the current tab' }).click();
    await settle();
    const fromMenu = await newest();
    assert.notEqual(fromMenu.id, root.id);
    assert.equal(fromMenu.parent, activeId, 'right-click menu: child of the active tab');
    await worker.evaluate((id) => chrome.tabs.remove(id), fromMenu.id);
    await settle();
  });

  await check('the panel reflects the tree after a reload', async () => {
    await panel.reload();
    await settle();
    const depths = await panel.$$eval('.tab', (els) => els.map((el) => el.style.getPropertyValue('--depth')));
    assert.deepEqual(depths, ['0', '1', '0', '1']);
  });

  await check('moving a tree to a new window keeps its structure', async () => {
    const id = await idOf('Page A-child-child');
    const parentId = await worker.evaluate(async (id) => {
      const { tree } = await chrome.storage.session.get('tree');
      return new Map(tree.parents).get(id);
    }, id);
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'move-to-new-window', ids: [id] }), parentId);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const moved = await worker.evaluate(async (ids) => {
      const { tree } = await chrome.storage.session.get('tree');
      const parents = new Map(tree.parents);
      const [a, b] = await Promise.all(ids.map((id) => chrome.tabs.get(id)));
      return { sameWindow: a.windowId === b.windowId, newWindow: a.windowId !== self.mainWindowId, parent: parents.get(b.id) };
    }, [parentId, id]);
    assert.deepEqual(moved, { sameWindow: true, newWindow: true, parent: parentId });
    assert.equal(await outline(), ['[pinned] about:blank', 'Page A-child', ' Page A-child'].join('\n'));
  });

  await check('tabs opened in quick succession keep their parents', async () => {
    const docs = await openRoot('Project docs');
    const spec = await openFrom(docs, 'Design spec');
    await openFrom(spec, 'Review comments', { middle: true });
    await openFrom(docs, 'Meeting notes', { middle: true });
    const news = await openRoot('News');
    // Two middle clicks right after each other, without waiting for the tabs.
    for (const name of ['Article about browsers', 'Another article']) {
      await news.evaluate((href) => (document.getElementById('child').href = href), `/${encodeURIComponent(name)}`);
      await news.click('#child', { button: 'middle' });
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const lines = (await outline()).split('\n').slice(3);
    assert.deepEqual(lines, [
      'Page Project docs',
      ' Page Design spec',
      '  Page Review comments',
      ' Page Meeting notes',
      'Page News',
      ' Page Article about browsers',
      ' Page Another article',
    ]);
  });

  await check('the tree is rebuilt from the snapshot when session state is lost', async () => {
    const newsId = await idOf('Page News');
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'set-collapsed', tabId: id, collapsed: true }), newsId);
    const before = await outline();
    await new Promise((resolve) => setTimeout(resolve, 1500)); // Let the snapshot save.
    // Same as an extension update: session storage is gone, the worker restarts.
    await worker.evaluate(() => chrome.storage.session.clear());
    const cdp = await context.newCDPSession(panel);
    await cdp.send('ServiceWorker.enable');
    await worker.evaluate(() => (self.marker = 'old worker'));
    await cdp.send('ServiceWorker.stopAllWorkers');
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'get-tree' }));
    worker = context.serviceWorkers().at(-1);
    assert.equal(await worker.evaluate(() => self.marker), undefined);
    await worker.evaluate((id) => (self.mainWindowId = id), mainWindowId);
    await worker.evaluate(async () => {
      while (!(await chrome.storage.session.get('tree')).tree) await new Promise((r) => setTimeout(r, 50));
    });
    assert.equal(await outline(), before);
    const { tree } = await worker.evaluate(() => chrome.storage.session.get('tree'));
    assert.ok(tree.collapsed.includes(newsId));
  });

  // Here the panel runs as a tab without ?windowId=, like the real side
  // panel, so it watches its own window. Playwright pins the page size, so
  // the page gets no real resize events; tests send the one Chrome would.
  const plainPanelUrl = panelUrl.replace(/\?.*/, '');
  const fullscreenWindow = await worker.evaluate(
    (url) => chrome.windows.create({ url: ['about:blank', url], width: 900, height: 600 }).then((w) => w.id),
    plainPanelUrl,
  );
  const openOwnPanel = async () => {
    const before = new Set(context.pages());
    await worker.evaluate(
      ({ windowId, url }) => chrome.tabs.create({ windowId, url }),
      { windowId: fullscreenWindow, url: plainPanelUrl },
    );
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      page = context.pages().find((p) => !before.has(p) && p.url() === plainPanelUrl);
      if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await page.waitForLoadState();
    await page.waitForSelector('.tab');
    return page;
  };
  const setState = (state) =>
    worker.evaluate(({ id, state }) => chrome.windows.update(id, { state }), { id: fullscreenWindow, state });
  const resize = (page) => page.evaluate(() => dispatchEvent(new Event('resize'))).catch(() => {});
  const noticeShown = (page) => page.locator('#fullscreen-notice').isVisible();
  const settled = () => new Promise((resolve) => setTimeout(resolve, 400));
  const fullscreenSettings = () =>
    worker.evaluate(() => chrome.storage.sync.get(['hideInFullscreen', 'fullscreenChoiceMade']));

  await check('the first full screen explains the choice instead of closing the panel', async () => {
    const own = context.pages().find((p) => p.url() === plainPanelUrl) ?? (await openOwnPanel());
    await own.waitForSelector('.tab');
    await worker.evaluate((id) => chrome.windows.update(id, { width: 800 }), fullscreenWindow);
    await resize(own);
    await settled();
    assert.equal(await noticeShown(own), false, 'an ordinary resize changes nothing');

    await setState('fullscreen');
    await resize(own);
    await settled();
    assert.equal(own.isClosed(), false);
    assert.equal(await noticeShown(own), true, 'the notice replaces the tree');
    assert.equal(await own.locator('#scroller').isVisible(), false);
    // The notice names the shortcut Chrome has assigned, if there is one.
    const shortcut = await worker.evaluate(
      async () => (await chrome.commands.getAll()).find((c) => c.name === '_execute_action').shortcut,
    );
    const text = await own.locator('#fullscreen-notice').textContent();
    assert.ok(text.includes(shortcut ? `toolbar button or ${shortcut}.` : 'toolbar button.'), text);
    if (shots) {
      for (const scheme of ['light', 'dark']) {
        await own.emulateMedia({ colorScheme: scheme });
        await own.screenshot({ path: path.join(shots, `fullscreen-notice-${scheme}.png`) });
      }
    }

    await setState('normal');
    await resize(own);
    await settled();
    assert.equal(await noticeShown(own), false, 'leaving full screen unanswered brings the tree back');
    assert.equal(await own.locator('#scroller').isVisible(), true);

    await setState('fullscreen');
    await resize(own);
    await settled();
    await Promise.all([own.waitForEvent('close', { timeout: 5000 }), own.click('#fullscreen-hide')]);
    assert.deepEqual(await fullscreenSettings(), { hideInFullscreen: true, fullscreenChoiceMade: true });
  });

  await check('after choosing to hide, full screen closes the panel without asking', async () => {
    await setState('normal');
    const own = await openOwnPanel();
    await setState('fullscreen');
    await Promise.all([own.waitForEvent('close', { timeout: 5000 }), resize(own)]);
  });

  await check('a panel opened while already in full screen stays open when resized', async () => {
    await setState('normal');
    const own = await openOwnPanel();
    // Opening a tab takes the test window out of full screen, so go full
    // screen first and then load the panel, as if it were opened just now.
    await setState('fullscreen');
    await own.reload();
    await own.waitForSelector('.tab');
    assert.equal(await worker.evaluate((id) => chrome.windows.get(id).then((w) => w.state), fullscreenWindow), 'fullscreen');
    await resize(own);
    await settled();
    assert.equal(own.isClosed(), false, 'opening it on purpose in full screen keeps it');
    await resize(own);
    await settled();
    assert.equal(own.isClosed(), false, 'resizing it keeps it too');
    await own.close();
  });

  await check('choosing to keep it open leaves the panel open in full screen', async () => {
    await setState('normal');
    await worker.evaluate(() => chrome.storage.sync.set({ fullscreenChoiceMade: false }));
    const own = await openOwnPanel();
    await setState('fullscreen');
    await resize(own);
    await settled();
    await own.click('#fullscreen-keep');
    await settled();
    assert.equal(await noticeShown(own), false);
    assert.equal(await own.locator('#scroller').isVisible(), true);
    assert.deepEqual(await fullscreenSettings(), { hideInFullscreen: false, fullscreenChoiceMade: true });
    await resize(own);
    await settled();
    assert.equal(own.isClosed(), false, 'later full screens leave it open too');
    assert.equal(await noticeShown(own), false);
    await worker.evaluate(async (id) => {
      await chrome.windows.remove(id);
      await chrome.storage.sync.remove(['hideInFullscreen', 'fullscreenChoiceMade']);
    }, fullscreenWindow);
  });

  if (shots) {
    await worker.evaluate(async (id) => chrome.tabs.update(id, { active: true }), await idOf('Page Design spec'));
    await settle();
    await panel.bringToFront();
    for (const scheme of ['light', 'dark']) {
      await panel.emulateMedia({ colorScheme: scheme });
      await panel.locator('.tab').nth(4).hover();
      await panel.screenshot({ path: path.join(shots, `panel-${scheme}.png`) });
    }
    await panel.locator('.tab').nth(3).click({ button: 'right' });
    await panel.screenshot({ path: path.join(shots, 'panel-menu-dark.png') });
    await panel.keyboard.press('Escape');
  }
  await check('the panel reported no errors', async () => {
    assert.deepEqual(panelErrors, []);
  });
} finally {
  await context.close();
  server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
