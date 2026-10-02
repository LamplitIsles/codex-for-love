import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('supported locale catalogs provide every message and preserve interpolation inputs', async () => {
  const settings = JSON.parse(await readFile(new URL('../project.inlang/settings.json', import.meta.url), 'utf8'));
  const catalog = async (locale: string): Promise<Record<string, string>> => JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
  const base = await catalog(settings.baseLocale);
  const inputs = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();
  for (const locale of settings.locales) {
    const messages = await catalog(locale);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(base).sort(), `${locale} must cover every configured message`);
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(typeof value === 'string' && value.trim(), `${locale}:${key} must be a nonempty message`);
      assert.deepEqual(inputs(value), inputs(base[key]), `${locale}:${key} must preserve interpolation inputs`);
    }
  }
});
