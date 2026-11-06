// UI acceptance with an intercepted API: never writes to the user's database.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const snapshot = { version: 1, setups: [], tags: [], cases: [] };
let writes = 0;
await page.route('**/api/encyclopedia', async route => {
  if (route.request().method() === 'POST') {
    writes++;
    const { action, item } = route.request().postDataJSON();
    if (action === 'saveSetup') snapshot.setups.push({ ...item, id: crypto.randomUUID() });
    else if (action === 'saveTag') snapshot.tags.push({ ...item, id: crypto.randomUUID() });
    else if (action === 'saveCase') snapshot.cases.push({ ...item, id: crypto.randomUUID() });
    else throw new Error(`Unexpected action ${action}`);
  }
  await route.fulfill({ json: snapshot });
});
try {
  await page.goto(process.env.ENCYCLOPEDIA_URL || 'http://127.0.0.1:8765', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { createEncyclopedia } = await import('/encyclopedia.js');
    const anchor = { date: '2017-03-14', barNumber: 15, time: 1489488000, interval: 5, session: 'rth', adjustment: 'raw', rollRevision: 'v1', dataSource: 'ES_1min.csv' };
    const library = createEncyclopedia({ host: document.querySelector('#encyclopedia'), onCapture: () => anchor });
    await library.refresh();
    await library.capture(anchor);
  });
  const editor = page.locator('.encyclopedia-editor');
  await editor.locator('[name="notes"]').fill('创建分类与标签时保留的备注');
  await editor.getByLabel('新建 setup', { exact: true }).fill('big gap up and low2 top');
  await editor.locator('[data-action="quick-setup"]').click();
  await editor.getByLabel('big gap up and low2 top', { exact: true }).waitFor();
  assert.equal(await editor.getByLabel('big gap up and low2 top', { exact: true }).isChecked(), true);
  assert.equal(await editor.locator('[name="notes"]').inputValue(), '创建分类与标签时保留的备注');
  await editor.getByLabel('新建标签', { exact: true }).fill('strong buying');
  await editor.getByLabel('新建标签', { exact: true }).press('Enter');
  await editor.getByLabel('strong buying', { exact: true }).waitFor();
  assert.equal(await editor.getByLabel('strong buying', { exact: true }).isChecked(), true);
  assert.equal(snapshot.cases.length, 0, 'Enter creates the label instead of submitting the case');
  await editor.getByLabel('新建标签', { exact: true }).fill('Strong Buying');
  await editor.locator('[data-action="quick-tag"]').click();
  assert.equal(writes, 2, 'Existing name is reused without a duplicate API mutation');
  await editor.getByRole('button', { name: '保存案例', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.encyclopedia-status').textContent === '案例已保存。');
  assert.equal(snapshot.cases.length, 1);
  assert.deepEqual(snapshot.cases[0].setupIds, [snapshot.setups[0].id]);
  assert.deepEqual(snapshot.cases[0].tagIds, [snapshot.tags[0].id]);
  assert.equal(snapshot.cases[0].notes, '创建分类与标签时保留的备注');
  assert.deepEqual(errors, []);
  console.log('PASS: first-case inline setup/tag creation, automatic selection, preserved notes, Enter, duplicate reuse and case save. No real database writes.');
} finally { await browser.close(); }
