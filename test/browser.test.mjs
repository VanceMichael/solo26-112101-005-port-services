import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startSources } from '../sources/server.mjs';

test('Chromium 可通过日常操作使用演练来源', async () => {
  const source = await startSources();
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const tab = await context.newPage();

    await tab.goto(source.url + '/west');
    await tab.getByRole('link', { name: '北作业区' }).click();
    await tab.getByRole('link', { name: '海星' }).click();
    assert.equal(await tab.getByText('B-08').count(), 1);
    const download = tab.waitForEvent('download');
    await tab.getByRole('link', { name: '领取原单' }).click();
    const file = await download;
    assert.equal(file.suggestedFilename(), 'SV-19-r1.csv');
    const incoming = await file.createReadStream();
    let text = '';
    for await (const chunk of incoming) text += chunk;
    assert.match(text, /B-08,SEA-201/);
    await context.request.post(source.url + '/scenario/corrected');
    await tab.reload();
    assert.equal(await tab.getByText('B-09').count(), 1);
    const wrong = tab.waitForEvent('download');
    await tab.getByRole('link', { name: '领取原单' }).click();
    const substitute = await wrong;
    assert.equal(substitute.suggestedFilename(), 'SV-19-r2.csv');
    const bytes = await substitute.createReadStream();
    let wrongContent = '';
    for await (const chunk of bytes) wrongContent += chunk;
    assert.match(wrongContent, /SV-63,2,B-19/);
  } finally {
    await browser?.close();
    await source.close();
  }
});
