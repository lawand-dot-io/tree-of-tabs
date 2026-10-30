// Screenshots of the extension in every language in _locales/, to check
// translations for wording and fit: the panel at its narrowest, the tab menu,
// the two notices and the settings page.
// Usage: node tools/translation-shots.mjs <output folder> [language ...]
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// require() also finds a globally installed Playwright.
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = process.argv[2];
if (!OUT) throw new Error('Usage: node tools/translation-shots.mjs <output folder> [language ...]');
const languages = process.argv.length > 3 ? process.argv.slice(3) : fs.readdirSync(path.join(ROOT, '_locales'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pages with names that are the same in every language.
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${name}</title><h1>${name}</h1>`);
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://localhost:${server.address().port}`;

for (const lang of languages) {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'lang-')), {
    headless: true,
    channel: 'chromium', // The headless shell cannot load extensions.
    locale: lang.replace('_', '-'),
    args: [`--lang=${lang.replace('_', '-')}`, `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    viewport: { width: 320, height: 640 },
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extension = new URL(worker.url()).host;
  const first = context.pages()[0];
  await first.goto(`${base}/Lisboa`);
  for (const name of ['Alfama', 'Belém', 'Sintra']) {
    await first.evaluate((href) => {
      const a = Object.assign(document.createElement('a'), { href, id: 'link', textContent: href });
      document.body.append(a);
    }, `${base}/${name}`);
    await Promise.all([context.waitForEvent('page'), first.click('#link', { button: 'middle' })]);
    await first.evaluate(() => document.getElementById('link').remove());
  }
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `${base}/Porto`);
  await sleep(800);

  // The tree and its menu, for the window with the tabs.
  const windowId = await worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);
  const panelUrl = `chrome-extension://${extension}/src/sidepanel/sidepanel.html`;
  const open = async (url, type) => {
    const [page] = await Promise.all([
      context.waitForEvent('page'),
      worker.evaluate(({ url, type }) => chrome.windows.create({ url, type, width: 320, height: 640 }), { url, type }),
    ]);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForSelector('.tab');
    await sleep(800);
    return page;
  };
  const panel = await open(`${panelUrl}?windowId=${windowId}`, 'popup');
  await panel.screenshot({ path: path.join(OUT, `${lang}-1-panel.png`) });
  await panel.locator('.tab').first().click({ button: 'right' });
  await panel.screenshot({ path: path.join(OUT, `${lang}-3-menu.png`) });

  // The panel as Chrome shows it, in a window of its own: with two windows
  // open it shows the new window tip; the full screen notice is shown by hand.
  const own = await open(panelUrl, 'normal');
  await own.waitForSelector('#window-tip:not([hidden])');
  await own.evaluate(() => {
    document.getElementById('fullscreen-notice').hidden = false;
    document.body.classList.add('showing-notice');
  });
  await own.screenshot({ path: path.join(OUT, `${lang}-2-notices.png`) });
  await own.evaluate(() => {
    document.getElementById('fullscreen-notice').hidden = true;
    document.body.classList.remove('showing-notice');
  });
  await own.screenshot({ path: path.join(OUT, `${lang}-2-tip.png`), clip: { x: 0, y: 0, width: 320, height: 200 } });

  const settings = await context.newPage();
  await settings.setViewportSize({ width: 760, height: 900 });
  await settings.goto(`chrome-extension://${extension}/src/options/options.html`);
  await settings.locator('[name=disableCollapsing]').check();
  await sleep(300);
  await settings.screenshot({ path: path.join(OUT, `${lang}-4-settings.png`), fullPage: true });
  console.log(lang, await settings.evaluate(() => chrome.i18n.getUILanguage()));
  await settings.locator('[name=disableCollapsing]').uncheck();
  await context.close();
}
server.close();
