// Every language in _locales/ has the same texts as English, with the same
// placeholders, so a text added or changed in English can't be forgotten in a
// translation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const LOCALES = path.resolve(import.meta.dirname, '../_locales');
const read = (lang) => JSON.parse(readFileSync(path.join(LOCALES, lang, 'messages.json'), 'utf8'));
const placeholders = (text) => (text.match(/\$[A-Za-z_]+\$/g) ?? []).map((p) => p.toLowerCase()).sort();
const en = read('en');

test('every English text says where it appears', () => {
  for (const [key, { message, description }] of Object.entries(en)) {
    assert.ok(message, key);
    assert.ok(description, `${key} needs a description for translators`);
  }
});

for (const lang of readdirSync(LOCALES).filter((l) => l !== 'en')) {
  test(`${lang} has every text, with the same placeholders`, () => {
    const messages = read(lang);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort());
    for (const [key, { message, placeholders: defined }] of Object.entries(messages)) {
      assert.ok(message.trim(), `${lang}.${key} is empty`);
      assert.deepEqual(placeholders(message), placeholders(en[key].message), `${lang}.${key}`);
      assert.deepEqual(defined, en[key].placeholders, `${lang}.${key} defines its placeholders`);
    }
  });

  test(`${lang} description fits the Chrome Web Store`, () => {
    assert.ok(read(lang).extDescription.message.length <= 132);
  });
}
