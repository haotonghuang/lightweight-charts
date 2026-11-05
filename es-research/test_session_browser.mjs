// Optional real-browser test; Playwright is a development-only dependency.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  Object.defineProperty(window, 'LightweightCharts', {
    configurable: true,
    set(api) {
      const wrapped = { ...api };
      wrapped.createChart = (...args) => {
        const chart = api.createChart(...args);
        const addSeries = chart.addSeries.bind(chart);
        window.__sessionQA = { chart };
        chart.addSeries = (...seriesArgs) => {
          const series = addSeries(...seriesArgs);
          window.__sessionQA.candles ??= series;
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
async function submit() {
  await page.locator('#settings').evaluate(form => form.requestSubmit());
  await loaded();
}
try {
  await page.goto(process.env.DRAWINGS_URL || 'http://127.0.0.1:8766', { waitUntil: 'networkidle', timeout: 60_000 });
  await loaded();
  assert.equal(await page.locator('#adjustment').inputValue(), 'back');
  assert.ok((await page.locator('.session-hint').textContent()).includes('16:15'));
  assert.ok((await page.locator('#roll-events').textContent()).includes('2025-03-14'));
  await page.locator('#start').fill('2025-03-13');
  await page.locator('#end').fill('2025-03-14');
  await submit();
  const data = await page.evaluate(async () => {
    const q = new URLSearchParams({ start: '2025-03-13', end: '2025-03-14', interval: '5', session: 'rth' });
    const back = await (await fetch(`/api/bars?${q}&adjustment=back`)).json();
    const raw = await (await fetch(`/api/bars?${q}&adjustment=raw`)).json();
    const displayed = window.__sessionQA.candles.data();
    const first = back[20];
    return { back, raw, displayed, x: window.__sessionQA.chart.timeScale().timeToCoordinate(first.time), y: window.__sessionQA.candles.priceToCoordinate(first.high) };
  });
  assert.equal(data.back.length, 162);
  assert.equal(data.back[80].barCount, 81);
  assert.equal(data.back[161].barCount, 81);
  assert.equal(data.back[0].open - data.raw[0].open, 51.25);
  assert.equal(data.displayed[0].open, data.back[0].open);
  assert.equal(data.raw[81].rthGap - data.back[81].rthGap, 51.25);
  await page.locator('#drawing-tool').selectOption('horizontal-line');
  await page.locator('#chart').click({ position: { x: data.x, y: data.y } });
  assert.ok((await page.locator('#drawing-status').textContent()).startsWith('1 '));
  await page.locator('#adjustment').selectOption('raw');
  await submit();
  assert.equal(await page.evaluate(() => window.__sessionQA.candles.data()[0].open), data.raw[0].open);
  assert.ok((await page.locator('#drawing-status').textContent()).startsWith('0 '));
  await page.locator('#adjustment').selectOption('back');
  await submit();
  assert.ok((await page.locator('#drawing-status').textContent()).startsWith('1 '));
  await page.locator('#mode').selectOption('review');
  await page.locator('#review-date').fill('2025-03-14');
  await submit();
  assert.equal(await page.evaluate(() => window.__sessionQA.candles.data().length), 186);
  const box = await page.locator('#chart').boundingBox();
  assert.ok(box.height >= 500);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/es-drawing-qa/session-roll-adjustment.png', fullPage: true });
  console.log('PASS: 16:15 RTH (81 bars), 186-bar morning review, estimated roll/raw prices, gap recalculation, isolated drawing storage and compact layout.');
} finally {
  await context.close();
  await browser.close();
}
