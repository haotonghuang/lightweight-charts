// Run against a dedicated server with an EMPTY scratch encyclopedia database.
// No browser or test dependencies are needed by the application itself.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
if (process.env.ENCYCLOPEDIA_QA_WRITES !== '1') throw new Error('Use ENCYCLOPEDIA_QA_WRITES=1 and a scratch --encyclopedia-db');
await mkdir('/tmp/abu-chart-qa', { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await page.addInitScript(() => {
  Object.defineProperty(window, 'LightweightCharts', {
    configurable: true,
    set(api) {
      const wrapped = { ...api };
      wrapped.createChart = (...args) => {
        const chart = api.createChart(...args);
        window.__encyclopediaQA = { chart, instances: (window.__encyclopediaQA?.instances ?? 0) + 1 };
        window.__encyclopediaQA.clicks = [];
        chart.subscribeClick(event => window.__encyclopediaQA.clicks.push({ type: 'click', time: event.time }));
        chart.subscribeDblClick(event => window.__encyclopediaQA.clicks.push({ type: 'double', time: event.time }));
        const addSeries = chart.addSeries.bind(chart);
        chart.addSeries = (...args) => {
          const series = addSeries(...args);
          window.__encyclopediaQA.candles ??= series;
          return series;
        };
        return chart;
      };
      Object.defineProperty(this, 'LightweightCharts', { configurable: true, value: wrapped });
    },
  });
});
async function loaded() {
  await page.waitForFunction(() => !document.querySelector('#load').disabled && !document.querySelector('#status').textContent.includes('正在'), null, { timeout: 60_000 });
  assert.ok(!(await page.locator('#status').textContent()).includes('失败'));
}
async function status(text) {
  try {
    await page.waitForFunction(text => document.querySelector('.encyclopedia-status').textContent.includes(text), text, { timeout: 10_000 });
  } catch (error) {
    console.error('Expected status:', text, 'Actual:', await page.locator('.encyclopedia-status').textContent(), errors);
    await page.screenshot({ path: '/tmp/abu-chart-qa/status-failure.png', fullPage: true });
    throw error;
  }
}
async function submit(form, expectedStatus) {
  await form.evaluate(node => node.requestSubmit());
  await status(expectedStatus);
}
async function pickSignal(barNumber) {
  await page.evaluate(() => {
    const el = document.querySelector('#chart');
    window.__encyclopediaQA.events = [];
    if (!window.__encyclopediaQA.eventProbe) {
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) el.addEventListener(type, e => window.__encyclopediaQA.events.push({type, target:e.target.tagName, x:e.offsetX,y:e.offsetY}), true);
      window.__encyclopediaQA.eventProbe = true;
    }
  });
  const point = await page.evaluate(number => {
    const { chart, candles } = window.__encyclopediaQA;
    const bar = candles.data()[number - 1];
    return { x: chart.timeScale().timeToCoordinate(bar.time), y: candles.priceToCoordinate(bar.close) };
  }, barNumber);
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  const box = await page.locator('#chart').boundingBox();
  await page.mouse.move(box.x + point.x + 1, box.y + point.y + 1);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.locator('#chart').click({ position: point, delay: 60 });
  try {
    await page.waitForFunction(number => document.querySelector('#case-selection').textContent.includes(`bar ${number}`), barNumber, { timeout: 5000 });
  } catch (error) {
    console.error('Signal click:', point, await page.locator('#case-selection').textContent(), await page.locator('#drawing-tool').inputValue(), await page.evaluate(() => ({clicks:window.__encyclopediaQA.clicks,events:window.__encyclopediaQA.events})), errors);
    await page.screenshot({ path: '/tmp/abu-chart-qa/signal-click-failure.png', fullPage: true });
    throw error;
  }
}
let baseline;
try {
  await page.goto(process.env.ENCYCLOPEDIA_URL || 'http://127.0.0.1:8877', { waitUntil: 'networkidle', timeout: 60_000 });
  await loaded();
  baseline = await page.evaluate(async () => (await fetch('/api/encyclopedia')).json());
  assert.deepEqual([baseline.setups.length, baseline.tags.length, baseline.cases.length], [0, 0, 0], 'Refuse to modify a populated database');
  await page.locator('#encyclopedia-toggle').click();
  await page.locator('.encyclopedia-management summary').click();
  const setupForm = page.locator('form[data-action="save-setup"]');
  await setupForm.locator('[name="name"]').fill('big gap up and low2 top');
  await setupForm.locator('[name="description"]').fill('背景与入场理由由 setup 统一描述');
  await submit(setupForm, 'Setup 已保存');
  await setupForm.locator('[name="name"]').fill('low2 top');
  await submit(setupForm, 'Setup 已保存');
  const tagForm = page.locator('form[data-action="save-tag"]');
  for (const name of ['strong buying', 'just above EMA']) {
    await tagForm.locator('[name="name"]').fill(name);
    await submit(tagForm, '标签已保存');
  }
  await page.locator('.encyclopedia-management summary').click();
  await page.locator('#start').fill('2017-03-14');
  await page.locator('#end').fill('2017-03-14');
  await page.locator('#settings').evaluate(node => node.requestSubmit());
  await loaded();
  const editor = page.locator('.encyclopedia-editor');
  for (const [barNumber, tag] of [[15, 'strong buying'], [20, 'just above EMA']]) {
    await pickSignal(barNumber);
    await page.locator('#case-capture').click();
    await editor.getByLabel('big gap up and low2 top', { exact: true }).check();
    if (barNumber === 15) await editor.getByLabel('low2 top', { exact: true }).check();
    await editor.getByLabel(tag, { exact: true }).check();
    await editor.locator('[name="notes"]').fill(`信号 bar ${barNumber} 的补充观察`);
    await submit(editor.locator('form'), '案例已保存');
  }
  const cases = page.locator('.encyclopedia-case');
  assert.equal(await cases.count(), 2);
  const filter = page.locator('.encyclopedia-filters');
  await filter.getByLabel('strong buying', { exact: true }).check();
  assert.equal(await cases.count(), 1);
  await filter.getByLabel('just above EMA', { exact: true }).check();
  assert.equal(await cases.count(), 0);
  await filter.locator('[name="tagMode"]').selectOption('any');
  assert.equal(await cases.count(), 2);
  for (const tag of ['strong buying', 'just above EMA']) await filter.getByLabel(tag, { exact: true }).uncheck();
  const filteredSetupId = await filter.locator('option').evaluateAll(nodes => nodes.find(node => node.textContent === 'low2 top').value);
  await filter.locator('[name="setupFilter"]').selectOption(filteredSetupId);
  assert.equal(await cases.count(), 1);
  await filter.locator('[name="setupFilter"]').selectOption('');
  await cases.first().locator('[data-action="navigate"]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('bar 20 ·'));
  await page.locator('[data-action="next"]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('bar 15 ·'));
  assert.equal(await page.evaluate(() => window.__encyclopediaQA.instances), 1);
  assert.equal(context.pages().length, 1);

  // A draft stays tied to its captured signal even after reloading another interval.
  await page.locator('#case-capture').click();
  await editor.getByLabel('low2 top', { exact: true }).check();
  await editor.locator('[name="notes"]').fill('草稿固定在 bar 15');
  await page.locator('.encyclopedia-management summary').click();
  await tagForm.locator('[name="name"]').fill('below prior high');
  await submit(tagForm, '标签已保存');
  assert.equal(await editor.locator('[name="notes"]').inputValue(), '草稿固定在 bar 15');
  await page.locator('.encyclopedia-management summary').click();
  await page.locator('#interval').selectOption('15');
  await page.locator('#settings').evaluate(node => node.requestSubmit());
  await loaded();
  assert.ok((await editor.locator('.encyclopedia-anchor').textContent()).includes('bar 15'));
  await submit(editor.locator('form'), '案例已保存');
  let snapshot = await page.evaluate(async () => (await fetch('/api/encyclopedia')).json());
  const draftCase = snapshot.cases.find(item => item.notes === '草稿固定在 bar 15');
  assert.equal(draftCase.interval, 5);
  assert.equal(draftCase.barNumber, 15);

  // Editing and category renaming preserve case associations and optional notes.
  const editCard = cases.filter({ hasText: '草稿固定在 bar 15' });
  await editCard.locator('[data-action="edit-case"]').click();
  await editor.locator('[name="notes"]').fill('编辑后仍保留标签和定位');
  await editor.getByLabel('strong buying', { exact: true }).check();
  await submit(editor.locator('form'), '案例已保存');
  await page.locator('.encyclopedia-management summary').click();
  await page.locator('.encyclopedia-managed-item').filter({ hasText: 'strong buying' }).getByRole('button', { name: '改名 / 编辑' }).click();
  await tagForm.locator('[name="name"]').fill('Strong Buying');
  await submit(tagForm, '标签已保存');
  await page.locator('.encyclopedia-management summary').click();
  assert.equal(await filter.getByLabel('Strong Buying', { exact: true }).count(), 1);
  await page.screenshot({ path: '/tmp/abu-chart-qa/encyclopedia-desktop.png', fullPage: true });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-action="export"]').click();
  const download = await downloadPromise;
  const backupPath = '/tmp/abu-chart-qa/backup.json';
  await download.saveAs(backupPath);
  const exported = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(exported.cases.length, 3);
  await page.locator('[name="import"]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"setups":[],"tags":[],"cases":[{}]}') });
  await status('恢复失败');
  assert.equal(await cases.count(), 3);
  await page.locator('[name="import"]').setInputFiles(backupPath);
  await status('百科备份已恢复');
  await page.reload({ waitUntil: 'networkidle' });
  await loaded();
  await page.locator('#encyclopedia-toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('.encyclopedia-case').length === 3);
  await page.locator('.encyclopedia-case').first().locator('[data-action="navigate"]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已定位信号'));
  assert.equal(await page.evaluate(() => window.__encyclopediaQA.instances), 1);
  await page.locator('.encyclopedia-case').filter({ hasText: '编辑后仍保留标签和定位' }).locator('[data-action="edit-case"]').click();
  await editor.locator('[data-action="delete-case"]').click();
  await status('案例已删除');
  assert.equal(await cases.count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/abu-chart-qa/encyclopedia-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: capture, multi-setup/tags, AND/OR filters, same-chart navigation, immutable draft, editing, rename, JSON backup/restore, reload persistence, mobile layout.');
} finally {
  if (baseline && !baseline.cases.length && !baseline.setups.length && !baseline.tags.length) {
    await page.evaluate(async data => {
      const response = await fetch('/api/encyclopedia', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'import', data }) });
      if (!response.ok) throw new Error('Failed to clean scratch database');
    }, baseline).catch(error => console.error(error.message));
  }
  await context.close();
  await browser.close();
}
