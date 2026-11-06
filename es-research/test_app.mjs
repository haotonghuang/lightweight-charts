import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

// Exercise real app handlers using a chart/DOM boundary double. This is not a
// browser layout test; it proves what data the chart and hover can observe.
class Element {
  constructor(value = '') { this.value = value; this.checked = true; this.listeners = {}; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  emit(name, extra = {}) { for (const fn of this.listeners[name] ?? []) fn({ preventDefault() {}, target: this, ...extra }); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await setImmediate(); };
const ts = text => Date.parse(`${text}Z`) / 1000;
const makeBar = (time, barCount) => ({ time: ts(time), open: 100, high: 102, low: 99, close: 101, volume: 100, ema20: 100.5, adr8: 30 + barCount, abr8: 3 + barCount, barCount, rthGap: 5, rthGapPercent: 0.5 });

test('app integrates browse, concealed replay, controls, hover, review, and stale loads', async () => {
  const ids = ['adjustment', 'adjustment-info', 'roll-events', 'drawing-fib-apply', 'drawing-fib-levels', 'drawing-tool', 'drawing-undo', 'drawing-redo', 'drawing-delete', 'drawing-apply', 'drawing-visible', 'drawing-color', 'drawing-width', 'drawing-text', 'drawing-export', 'drawing-import', 'drawing-status', 'chart', 'ohlc', 'range-value', 'body-value', 'gap-value', 'show-gap', 'ema-value', 'adr-value', 'abr-value', 'count-value', 'show-count', 'show-ema', 'show-adr', 'show-abr', 'play', 'step', 'reset', 'fit', 'center', 'progress', 'speed', 'mode', 'review-field', 'review-date', 'replay-field', 'replay-time', 'transport', 'load', 'status', 'start', 'end', 'interval', 'session', 'settings'];
  ids.push('case-capture', 'case-selection');
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements.chart.getBoundingClientRect = () => ({ left: 0 });
  elements.chart.clientLeft = 0;
  Object.assign(elements.mode, { value: 'browse' });
  elements.interval.value = '5'; elements.session.value = 'rth';
  elements['replay-time'].value = '09:35'; elements.speed.value = '1000';
  const rangeFields = ['start', 'end', 'interval', 'session'].map(id => ({ hidden: false, querySelectorAll: () => [elements[id]] }));
  const document = new Element();
  document.getElementById = id => elements[id];
  document.querySelectorAll = () => rangeFields;
  const series = [];
  let markerData = [];
  let crosshair;
  let chartClick;
  let chartInstances = 0;
  let logicalRange = null;
  const chart = {
    addSeries() { const s = { data: [], setData(data) { this.data = data; }, priceScale() { return { applyOptions() {} }; }, applyOptions(options) { this.options = options; } }; series.push(s); return s; },
    panes: () => [{ setStretchFactor() {} }, { setStretchFactor() {} }],
    subscribeCrosshairMove(fn) { crosshair = fn; },
    subscribeClick(fn) { chartClick = fn; },
    timeScale: () => ({ coordinateToTime: x => bars[x]?.time, getVisibleLogicalRange: () => logicalRange, setVisibleLogicalRange: range => { logicalRange = range; }, fitContent: () => { logicalRange = { from: 0, to: 80 }; } }),
  };
  const bars = [0, 1, 2, 3].map(i => makeBar(`2026-07-31T09:${30 + 5 * i}:00`, i + 1));
  let responseBars = bars;
  let fail = false;
  let pending = null;
  let resolvePending;
  const timers = new Map();
  let nextTimer = 1;
  const originals = Object.fromEntries(['document', 'LightweightCharts', 'fetch', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]));
  globalThis.document = document;
  globalThis.LightweightCharts = { createChart: () => { chartInstances++; return chart; }, createSeriesMarkers: () => ({ setMarkers: data => { markerData = data; } }) };
  globalThis.setInterval = fn => { const key = nextTimer++; timers.set(key, fn); return key; };
  globalThis.clearInterval = key => timers.delete(key);
  globalThis.fetch = async url => {
    if (url === '/api/meta') return { ok: true, json: async () => ({ first: '2026-07-01', last: '2026-07-31', dataFile: 'ES_1min.csv', rthSessions: ['2026-07-31'] }) };
    if (pending) { await pending; pending = null; }
    if (fail) return { ok: false, json: async () => ({ error: '测试错误' }) };
    if (url.startsWith('/api/review')) return { ok: true, json: async () => ({ bars: responseBars, focusTime: responseBars[1].time, previousSessions: ['2026-07-29', '2026-07-30'], targetDate: '2026-07-31', targetCount: 24, warnings: [] }) };
    return { ok: true, json: async () => responseBars };
  };
  try {
    const { navigateCase } = await import('./app.js');
    await flush();
    assert.equal(series.length, 5);
    assert.equal(series[0].data.length, 4);
    assert.equal(elements.load.disabled, false);
    assert.equal(elements['case-capture'].disabled, true);
    chartClick({ time: bars[1].time });
    assert.equal(elements['case-capture'].disabled, false);
    assert.ok(elements['case-selection'].textContent.includes('bar 2'));
    assert.ok(markerData.some(marker => marker.text === '信号 bar 2'));
    // Native stationary selection remains usable after focus leaves the chart.
    elements.chart.emit('pointerdown', { button: 0, clientX: 2, clientY: 20 });
    elements.chart.emit('click', { button: 0, clientX: 2, clientY: 20 });
    assert.ok(elements['case-selection'].textContent.includes('bar 3'));
    elements.chart.emit('pointerdown', { button: 0, clientX: 3, clientY: 20 });
    elements.chart.emit('pointermove', { clientX: 10, clientY: 20 });
    elements.chart.emit('click', { button: 0, clientX: 3, clientY: 20 });
    assert.ok(elements['case-selection'].textContent.includes('bar 3'), 'dragging does not choose a new signal');

    elements.mode.value = 'replay'; elements.start.value = '2026-07-31';
    elements.settings.emit('change'); elements.settings.emit('submit'); await flush();
    assert.equal(series[0].data.length, 1);
    for (const s of series) assert.ok(s.data.every(bar => bar.time < bars[1].time));
    assert.equal(markerData.length, 1);
    assert.equal(markerData[0].text, 'Gap +5.00');
    assert.equal(elements.play.disabled, false);
    crosshair({ time: bars[3].time });
    assert.ok(elements.ohlc.textContent.includes('09:30'));
    assert.ok(!elements.ohlc.textContent.includes('09:45'));
    assert.equal(elements['adr-value'].textContent, 'ADR_8 31.00');
    assert.equal(elements['abr-value'].textContent, 'ABR_8 4.00');
    assert.ok(elements['range-value'].textContent.includes('3.00'));
    assert.ok(elements['body-value'].textContent.includes('1.00'));
    assert.ok(elements['gap-value'].textContent.includes('+5.00'));

    elements.step.emit('click'); elements.step.emit('click');
    assert.equal(series[0].data.length, 3);
    crosshair({ time: bars[1].time });
    assert.equal(elements['adr-value'].textContent, 'ADR_8 32.00');
    assert.equal(elements['abr-value'].textContent, 'ABR_8 5.00');
    crosshair({ time: bars[0].time });
    assert.equal(elements['adr-value'].textContent, 'ADR_8 31.00');
    assert.deepEqual(markerData.filter(marker => marker.position === 'belowBar').map(marker => marker.text), ['3']);
    elements.reset.emit('click');
    assert.equal(series[0].data.length, 1);
    elements.play.emit('click');
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    assert.equal(series[0].data.length, 2);
    elements.settings.emit('change');
    assert.equal(timers.size, 0);
    assert.equal(elements.step.disabled, true);
    elements.step.emit('click');
    assert.equal(series[0].data.length, 2);

    elements.mode.value = 'review'; elements.settings.emit('change');
    assert.equal(elements.start.disabled, true);
    assert.equal(elements['review-date'].required, true);
    elements.settings.emit('submit'); await flush();
    assert.equal((logicalRange.from + logicalRange.to) / 2, 1);
    assert.equal(elements.center.disabled, false);
    assert.ok(markerData.some(marker => marker.text.startsWith('当日开盘')));
    elements['show-ema'].checked = false; elements['show-ema'].emit('change');
    assert.equal(series[2].options.visible, false);

    // Changing settings during a fetch aborts its eventual result.
    pending = new Promise(resolve => { resolvePending = resolve; });
    elements.settings.emit('submit');
    assert.equal(series[0].data.length, 0);
    elements.settings.emit('change');
    resolvePending(); await flush();
    assert.equal(series[0].data.length, 0);
    assert.ok(elements.status.textContent.includes('设置已更改'));

    fail = true;
    elements.settings.emit('submit'); await flush();
    assert.ok(elements.status.textContent.includes('测试错误'));
    assert.equal(series[0].data.length, 0);
    assert.equal(elements.center.disabled, true);

    // Encyclopedia navigation restores saved chart settings and reuses its instance.
    fail = false;
    const anchor = { id: 'case-a', date: '2026-07-31', barNumber: 2, time: bars[1].time,
      interval: 5, session: 'rth', adjustment: 'raw', rollRevision: 'v1', dataSource: 'ES_1min.csv' };
    await navigateCase(anchor);
    assert.equal(elements.mode.value, 'browse');
    assert.equal(elements.adjustment.value, 'raw');
    assert.ok(elements.status.textContent.includes('bar 2'));
    assert.equal(logicalRange.from, 1 - 32);
    await navigateCase({ ...anchor, barNumber: 3, time: bars[2].time });
    assert.ok(markerData.some(marker => marker.text === '信号 bar 3'));
    assert.equal(chartInstances, 1);
    await assert.rejects(navigateCase({ ...anchor, dataSource: 'other.csv' }), /数据源/);
    await assert.rejects(navigateCase({ ...anchor, adjustment: 'back', rollRevision: 'old' }), /换月调整版本/);
    await assert.rejects(navigateCase({ ...anchor, barNumber: 5, time: bars[3].time + 300 }), /未找到/);

    // Even a fetch implementation that ignores AbortSignal cannot replace B with A.
    pending = new Promise(resolve => { resolvePending = resolve; });
    const first = navigateCase({ ...anchor, adjustment: 'back' });
    const firstRejected = assert.rejects(first, { name: 'AbortError' });
    const second = navigateCase({ ...anchor, adjustment: 'raw', barNumber: 4, time: bars[3].time });
    resolvePending();
    await Promise.all([firstRejected, second]);
    assert.ok(elements.status.textContent.includes('bar 4'));
    assert.ok(markerData.some(marker => marker.text === '信号 bar 4'));
    assert.equal(chartInstances, 1);

    pending = new Promise(resolve => { resolvePending = resolve; });
    const olderLoad = navigateCase({ ...anchor, adjustment: 'back' });
    const olderRejected = assert.rejects(olderLoad, { name: 'AbortError' });
    await assert.rejects(navigateCase({ ...anchor, dataSource: 'unavailable.csv' }), /数据源/);
    resolvePending();
    await olderRejected;
    assert.equal(series[0].data.length, 0);
    assert.equal(elements.load.disabled, false);
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
