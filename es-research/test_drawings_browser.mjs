// Optional headless browser integration test. Uses Playwright installed outside
// the repository at /tmp/es-drawing-qa; set DRAWINGS_URL to the local viewer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origin = process.env.DRAWINGS_URL || 'http://127.0.0.1:8766';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

async function ready() {
  await page.locator('#drawing-tool').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#load').disabled && document.querySelector('#drawing-status').textContent !== '绘图准备中…', null, { timeout: 60_000 });
  const status = await page.locator('#drawing-status').textContent();
  assert.ok(!status.includes('不可用'), status);
}
async function draw(tool, points) {
  const before = await count();
  await page.locator('#drawing-tool').selectOption(tool);
  for (const point of points) await page.locator('#chart').click({ position: point });
  try {
    await page.waitForFunction(expected => Number(document.querySelector('#drawing-status').textContent.match(/^(\d+)/)?.[1] || 0) >= expected, before + 1, { timeout: 12_000 });
  } catch (error) {
    console.error('drawing diagnostic:', tool, await page.locator('#drawing-status').textContent(), await page.locator('#status').textContent());
    throw error;
  }
}
async function count() {
  const text = await page.locator('#drawing-status').textContent();
  return Number(text.match(/^(\d+)/)?.[1] || 0);
}
async function exportDrawings(path) {
  const menu = page.locator('#drawing-settings');
  if (!await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#drawing-export').click();
  const download = await downloadPromise;
  await download.saveAs(path);
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (await menu.evaluate(el => el.open)) await menu.locator('summary').click();
  return data;
}
try {
  // Capture the public chart/series APIs in this test page only. This lets the
  // test use the library's own time/price coordinate conversion without
  // adding a production test hook.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'LightweightCharts', {
      configurable: true,
      set(value) {
        const wrapped = { ...value };
        wrapped.createChart = (...args) => {
          const chart = value.createChart(...args);
          const addSeries = chart.addSeries.bind(chart);
          let seriesCount = 0;
          chart.addSeries = (...seriesArgs) => {
            const series = addSeries(...seriesArgs);
            if (seriesCount++ === 0) window.__drawingQA.candles = series;
            return series;
          };
          window.__drawingQA.chart = chart;
          return chart;
        };
        window.__drawingQA = {};
        Object.defineProperty(this, 'LightweightCharts', { configurable: true, value: wrapped });
      },
    });
  });
  await page.goto(origin, { waitUntil: 'networkidle', timeout: 60_000 });
  await ready();
  await page.locator('#start').fill('2026-07-20');
  await page.locator('#end').fill('2026-07-31');
  const priorStatus = await page.locator('#status').textContent();
  await page.locator('#settings').evaluate(form => form.requestSubmit());
  await page.waitForFunction(old => {
    const text = document.querySelector('#status').textContent;
    return text !== old && text.startsWith('已加载');
  }, priorStatus);
  await ready();
  assert.ok(await page.locator('#chart').evaluate(el => el.clientHeight >= 500), 'chart should fill most of a desktop viewport');
  const apiBars = await page.evaluate(async () => {
    const params = new URLSearchParams({ start: '2026-07-20', end: '2026-07-31', interval: '5', session: 'rth' });
    const response = await fetch(`/api/bars?${params}`);
    if (!response.ok) throw new Error(`bar API returned ${response.status}`);
    return response.json();
  });
  const barsByTime = new Map(apiBars.map(bar => [bar.time, bar]));
  console.log('loaded', await page.locator('#status').textContent(), await page.locator('#drawing-status').textContent());

  const snapClicks = await page.evaluate(bars => {
    const { chart, candles } = window.__drawingQA;
    const candidates = bars.map(bar => ({ bar, range: bar.high - bar.low }))
      .sort((a, b) => b.range - a.range).slice(0, 30);
    const selected = [];
    for (const { bar } of candidates) {
      const x = chart.timeScale().timeToCoordinate(bar.time);
      const highY = candles.priceToCoordinate(bar.high);
      const lowY = candles.priceToCoordinate(bar.low);
      if (x != null && highY != null && lowY != null && Math.abs(lowY - highY) >= 8 && x > 40 && x < document.querySelector('#chart').clientWidth - 40) {
        selected.push({ time: bar.time, high: bar.high, low: bar.low, x, highY, lowY });
        if (selected.length === 2) break;
      }
    }
    return selected.map((point, index) => ({
      time: point.time,
      expected: index === 0 ? 'high' : 'low',
      x: point.x,
      y: index === 0 ? point.highY + (point.lowY - point.highY) * 0.2 : point.lowY - (point.lowY - point.highY) * 0.2,
    }));
  }, apiBars);
  assert.equal(snapClicks.length, 2, 'two visible candles have enough range to check nearest-endpoint snapping');
  await page.locator('#drawing-tool').selectOption('trend-line');
  for (const point of snapClicks) await page.locator('#chart').click({ position: { x: point.x, y: point.y } });
  assert.equal(await count(), 1);
  assert.equal(await page.locator('#drawing-delete').isEnabled(), true, 'new trend line should be selected');
  const snappedTrend = (await exportDrawings('/tmp/es-drawing-qa/snapped-trend.json')).drawings[0];
  for (const [index, point] of snappedTrend.points.entries()) {
    const bar = barsByTime.get(point.time);
    assert.ok(bar, `snapped trend anchor time ${point.time} belongs to a displayed API bar`);
    assert.ok(point.price === bar.high || point.price === bar.low, 'trend anchors snap to a candle high or low');
    assert.equal(point.time, snapClicks[index].time, 'anchor uses the candle under the pointer');
    assert.equal(point.price, bar[snapClicks[index].expected], `anchor chooses the ${snapClicks[index].expected}, the closer wick endpoint`);
  }
  assert.equal(snappedTrend.style.extendRight, true, 'new trend lines extend right by default');
  await page.locator('#drawing-undo').click();
  assert.equal(await count(), 0);
  await page.locator('#drawing-redo').click();
  assert.equal(await count(), 1);

  const settings = page.locator('#drawing-settings');
  const selectionCoords = await page.evaluate(point => {
    const { chart, candles } = window.__drawingQA;
    return { x: chart.timeScale().timeToCoordinate(point.time), y: candles.priceToCoordinate(point.price) };
  }, snappedTrend.points[0]);
  await page.locator('#chart').click({ position: selectionCoords });
  assert.equal(await page.locator('#drawing-apply').isEnabled(), true);
  await settings.locator('summary').click();
  await page.locator('#drawing-color').fill('#ff66aa');
  await page.locator('#drawing-width').selectOption('3');
  await page.locator('#drawing-text').fill('回测趋势');
  await page.locator('#drawing-apply').click();
  await settings.locator('summary').click();
  assert.equal(await page.locator('#drawing-delete').isEnabled(), true, 'edited line remains selected');
  const beforeDrag = await exportDrawings('/tmp/es-drawing-qa/before-drag.json');
  await page.screenshot({ path: '/tmp/es-drawing-qa/before-drag.png' });
  const chartBox = await page.locator('#chart').boundingBox();
  const draggedEndpoint = beforeDrag.drawings[0].points[1];
  const endpointCoords = await page.evaluate(point => {
    const { chart, candles } = window.__drawingQA;
    return { x: chart.timeScale().timeToCoordinate(point.time), y: candles.priceToCoordinate(point.price) };
  }, draggedEndpoint);
  assert.ok(endpointCoords.x !== null && endpointCoords.y !== null, 'selected endpoint is in chart coordinates');
  const startPoint = { x: chartBox.x + endpointCoords.x, y: chartBox.y + endpointCoords.y };
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await page.mouse.move(startPoint.x + 60, startPoint.y + 35, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterDrag = await exportDrawings('/tmp/es-drawing-qa/after-drag.json');
  assert.notDeepEqual(afterDrag.drawings[0].points, beforeDrag.drawings[0].points, 'dragging the trend line changes its anchors');

  // Replay-created drawings must disappear when reset moves the cursor before
  // their creation point, then return after stepping forward again.
  await page.locator('#mode').selectOption('replay');
  await page.locator('#start').fill('2026-07-31');
  await page.locator('#replay-time').fill('09:30');
  await page.locator('#settings').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('逐根回放'));
  await page.locator('#step').click();
  await page.waitForFunction(() => !document.querySelector('#load').disabled && !document.querySelector('#drawing-tool').disabled);
  await page.locator('#drawing-tool').selectOption('horizontal-line');
  await page.locator('#chart').click({ position: { x: 660, y: 320 } });
  assert.equal(await count(), 1, 'replay drawing is recorded in its own context');
  const replayDrawing = await exportDrawings('/tmp/es-drawing-qa/replay-drawing.json');
  await page.locator('#reset').click();
  await page.waitForFunction(() => document.querySelector('#drawing-tool').disabled);
  const resetDrawing = await exportDrawings('/tmp/es-drawing-qa/replay-reset.json');
  assert.deepEqual(resetDrawing.replayCreatedAt, replayDrawing.replayCreatedAt, 'reset retains replay creation cursor metadata');
  await page.locator('#step').click();
  await page.waitForFunction(() => !document.querySelector('#drawing-tool').disabled);
  await page.locator('#drawing-tool').selectOption('');
  await page.locator('#chart').click({ position: { x: 660, y: 320 } });
  assert.equal(await page.locator('#drawing-delete').isEnabled(), true, 'stepping forward restores replay-created drawings');

  // Opening-review mode leaves future time to the right; drawing tools can
  // place anchors in that empty chart space for forecast targets.
  await page.locator('#mode').selectOption('review');
  await page.locator('#review-date').fill('2026-07-31');
  await page.locator('#settings').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('早盘'));
  const reviewCount = await count();
  const chartBoxForPan = await page.locator('#chart').boundingBox();
  await page.mouse.move(chartBoxForPan.x + 1100, chartBoxForPan.y + 450);
  await page.mouse.down();
  await page.mouse.move(chartBoxForPan.x + 700, chartBoxForPan.y + 450, { steps: 10 });
  await page.mouse.up();
  await page.locator('#drawing-tool').selectOption('measured-move');
  await page.locator('#chart').click({ position: { x: 1150, y: 240 } });
  await page.locator('#chart').click({ position: { x: 1230, y: 190 } });
  await page.locator('#chart').click({ position: { x: 1310, y: 270 } });
  assert.equal(await count(), reviewCount + 1, 'measured-move can be anchored in the empty right-side review space');
  const reviewDrawing = await exportDrawings('/tmp/es-drawing-qa/review-projection.json');
  const projectedTimes = reviewDrawing.drawings.at(-1).points.map(point => point.time);
  assert.ok(projectedTimes.every(time => time > Date.parse('2026-07-31T11:25:00Z') / 1000), 'projection anchors map beyond the final morning candle');

  await draw('horizontal-line', [{ x: 520, y: 260 }]);
  assert.equal(await count(), 3);
  await draw('measured-move', [{ x: 610, y: 300 }, { x: 700, y: 185 }, { x: 790, y: 255 }]);
  assert.equal(await count(), 4);
  await draw('fib-retracement', [{ x: 850, y: 160 }, { x: 1040, y: 310 }]);
  assert.equal(await count(), 5);
  const fibLevels = page.locator('#drawing-fib-levels');
  await settings.locator('summary').click();
  assert.equal(await fibLevels.inputValue(), '0,0.236,0.382,0.5,0.618,0.786,1', 'Fib settings start with common retracement ratios');
  await page.locator('#drawing-fib-apply').click();
  let fibExport = await exportDrawings('/tmp/es-drawing-qa/fib-default.json');
  const fibDrawing = fibExport.drawings.find(drawing => drawing.kind === 'fib-retracement');
  assert.deepEqual(fibDrawing.style.levels.map(level => level.coeff), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  await settings.locator('summary').click();
  await fibLevels.fill('0,0.25,0.5,0.75,1');
  await page.locator('#drawing-fib-apply').click();
  fibExport = await exportDrawings('/tmp/es-drawing-qa/fib-custom.json');
  assert.deepEqual(fibExport.drawings.find(drawing => drawing.kind === 'fib-retracement').style.levels.map(level => level.coeff), [0, 0.25, 0.5, 0.75, 1], 'custom Fib levels are exported');
  await page.locator('#drawing-undo').click();
  await page.locator('#drawing-redo').click();
  fibExport = await exportDrawings('/tmp/es-drawing-qa/fib-redone.json');
  assert.deepEqual(fibExport.drawings.find(drawing => drawing.kind === 'fib-retracement').style.levels.map(level => level.coeff), [0, 0.25, 0.5, 0.75, 1], 'undo/redo preserves custom Fib levels');

  await page.locator('#drawing-tool').selectOption('');
  const horizontal = fibExport.drawings.find(drawing => drawing.kind === 'horizontal-line');
  const horizontalCoords = await page.evaluate(point => {
    const { chart, candles } = window.__drawingQA;
    return { x: chart.timeScale().timeToCoordinate(point.time), y: candles.priceToCoordinate(point.price) };
  }, horizontal.points[0]);
  await page.locator('#chart').click({ position: horizontalCoords });
  assert.equal(await page.locator('#drawing-delete').isEnabled(), true, 'existing drawings can be selected');
  await page.keyboard.press('Delete');
  assert.equal(await count(), 4, 'Delete removes the selected drawing');
  const afterDelete = await exportDrawings('/tmp/es-drawing-qa/after-delete.json');
  assert.ok(afterDelete.drawings.some(drawing => drawing.kind === 'fib-retracement'), 'delete selection leaves the custom Fib available for persistence checks');
  await page.locator('#drawing-undo').click();
  assert.equal(await count(), 5);
  await page.locator('#drawing-redo').click();
  assert.equal(await count(), 4);
  await page.screenshot({ path: '/tmp/es-drawing-qa/drawing-tools.png', fullPage: true });

  const jsonPath = '/tmp/es-drawing-qa/round-trip.json';
  const savedCount = await count();
  await exportDrawings(jsonPath);
  await page.reload({ waitUntil: 'networkidle' });
  await ready();
  assert.equal(await count(), savedCount, 'drawings survive browser reload');
  fibExport = await exportDrawings('/tmp/es-drawing-qa/fib-after-reload.json');
  assert.deepEqual(fibExport.drawings.find(drawing => drawing.kind === 'fib-retracement').style.levels.map(level => level.coeff), [0, 0.25, 0.5, 0.75, 1], 'custom Fib levels persist across reload');
  const chart = await page.locator('#chart').boundingBox();
  assert.ok(chart && chart.height >= 500, 'chart remains full-height after reload');
  await page.locator('#drawing-import').setInputFiles(jsonPath);
  assert.equal(await count(), savedCount, 'export can be imported in the same context');
  assert.deepEqual(pageErrors, [], 'no uncaught browser exceptions');
  console.log('PASS: four tools, selection, style update, undo/redo/delete, reload persistence, export/import, full-height chart. Screenshot: /tmp/es-drawing-qa/drawing-tools.png');
} finally {
  await context.close();
  await browser.close();
}
