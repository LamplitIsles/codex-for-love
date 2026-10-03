// Native Framework7 acceptance on the actual isolated Partner and fake official SDK.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { quietCompactionFixture } from './quiet-compaction-fixture.ts';
const { chromium, expect } = await import(pathToFileURL(resolve(process.argv[2], 'node_modules/@playwright/test/index.mjs')).href);
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true });
const h = await quietCompactionFixture(resolve('apps/partner/build'));
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  for (const width of [390, 1280, 320]) {
    await h.action({ action: 'reset' });
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN' });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(h.origin);
    const input = page.locator('#companion-textarea'); const status = page.getByTestId('companion-continuity-status');
    const ring = page.locator('.companion-context-meter');
    await expect(input).toBeVisible(); await expect(ring).toHaveAttribute('aria-label', /0%/);
    await h.action({ action: 'usage', tokens: 50000, capacity: 100000 });
    await expect(ring).toHaveAttribute('aria-label', /50%/);
    await input.fill('/compact'); await page.locator('.companion-send').click();
    await expect(status).toHaveAttribute('data-state', 'running');
    await page.screenshot({ path: `${evidence}/running-${width}.png`, fullPage: true });
    await h.action({ action: 'finish' });
    const silent = async () => {
      await expect(status).toHaveCount(0); await expect(page.locator('[data-testid^="continuity-record-"]')).toHaveCount(0);
      await expect(page.getByText('已整理对话', { exact: true })).toHaveCount(0); await expect(page.locator('.toast')).toHaveCount(0);
    };
    await silent(); await expect(ring).toHaveAttribute('aria-label', /0%/);
    await h.action({ action: 'usage', tokens: 12000, capacity: 100000 }); await expect(ring).toHaveAttribute('aria-label', /12%/);
    await page.reload(); await silent(); await expect(ring).toHaveAttribute('aria-label', /12%/);
    await h.action({ action: 'auto' }); await expect(status).toHaveAttribute('data-state', 'running');
    await h.action({ action: 'finish', failed: true }); await expect(status).toHaveAttribute('data-state', 'failed');
    await page.screenshot({ path: `${evidence}/failed-${width}.png`, fullPage: true });
    await h.action({ action: 'auto' }); await h.action({ action: 'finish' }); await silent();
    await page.reload(); await silent();
    await page.screenshot({ path: `${evidence}/silent-${width}.png`, fullPage: true });
    expect(errors).toEqual([]); expect((await h.action({ action: 'state' })).submissions).toEqual([]);
    await context.close();
  }
  await writeFile(`${evidence}/results.json`, JSON.stringify({ backend: 'actual-native-Partner', widths: [390, 1280, 320], manual: true, automatic: true, history: true, running: true, failure: true }));
} finally { await browser.close(); await h.close(); }
