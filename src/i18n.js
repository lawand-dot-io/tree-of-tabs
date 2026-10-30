// Texts come from _locales/<language>/messages.json: the browser's language
// when there's a translation for it, English otherwise.

/** The text for `key`, with its placeholders filled in from `substitutions`. */
export function t(key, ...substitutions) {
  return chrome.i18n.getMessage(key, substitutions.map(String));
}

const MARK = '';

/** Fills `el` with the text for `key`, whose placeholders are the elements in
 * `nodes` (a link, a keyboard key), in order. */
export function fill(el, key, ...nodes) {
  const parts = t(key, ...nodes.map((_, i) => `${MARK}${i}${MARK}`)).split(MARK);
  el.replaceChildren(...parts.map((part, i) => (i % 2 ? nodes[Number(part)] : part)));
}

/** Translates the page: `data-i18n` sets an element's text, `data-i18n-title`
 * and `data-i18n-aria-label` those attributes, and `data-i18n-fill` builds the
 * text around the element's own children (see `fill`). */
export function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }
  for (const el of document.querySelectorAll('[data-i18n-fill]')) fill(el, el.dataset.i18nFill, ...el.children);
}
