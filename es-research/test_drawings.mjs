import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultStyleFor } from './vendor/drawing/lightweight-charts-drawing-0.6.3.mjs';
import { createDrawingController, TOOL_KINDS } from './drawings.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

class ManagerStub {
  constructor() {
    this.items = []; this.handlers = new Map(); this.selected = []; this.activeTool = null; this.visible = true; this.serial = 0; this.magnetEnabled = true;
    this.coords = {
      xToTime: x => x,
      yToPrice: y => 100 - y,
      priceToY: price => 100 - price,
      timeToX: time => time,
    };
  }
  magnet() { return { enabled: this.magnetEnabled, mode: 'weak' }; }
  snapFn() { return point => point; }
  aimAt(point) { return point; }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event).delete(handler);
  }
  fire(event, ...args) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
  setTool(kind) { this.activeTool = kind; this.fire('tool', kind); }
  selection() { return this.selected; }
  select(ids) { this.selected = [...ids]; this.fire('selection', this.selected); }
  drawings() { return this.items; }
  get(id) { return this.items.find(item => item.id === id); }
  exportJSON() { return JSON.stringify(this.items); }
  importJSON(json) { this.items = JSON.parse(json); this.selected = this.selected.filter(id => this.get(id)); this.fire('selection', this.selected); this.fire('change', this.items); }
  setDrawingsVisible(value) { this.visible = value; this.fire('visibility', value); }
  add(drawing) {
    const saved = { id: `draw-${++this.serial}`, ...drawing, style: { color: '#2962ff', width: 2, lineStyle: 'solid', ...(drawing.style ?? {}) } };
    this.items.push(saved); this.fire('add', saved); this.fire('change', this.items); this.fire('gestureEnd');
    return saved.id;
  }
  update(drawing) { const prior = this.get(drawing.id); this.items = this.items.map(item => item.id === drawing.id ? drawing : item); this.fire('update', drawing, prior); this.fire('change', this.items); }
  remove(id) { const prior = this.get(id); if (!prior) return; this.items = this.items.filter(item => item.id !== id); this.selected = this.selected.filter(item => item !== id); this.fire('remove', prior); this.fire('change', this.items); }
  destroy() {}
}

function boot(storage = new MemoryStorage()) {
  const managers = [];
  const states = [];
  const controller = createDrawingController({ chart: {}, series: {}, storage, onState: state => states.push(state), managerFactory: () => { const manager = new ManagerStub(); managers.push(manager); return manager; } });
  controller.setContext({ key: 'ES|5|rth|browse', mode: 'browse' });
  return { controller, storage, managers, manager: managers[0], states };
}

const line = (id, time = 100, kind = 'trend-line', points) => ({
  id, kind,
  points: points ?? (kind === 'horizontal-line' ? [{ time, price: 101 }] : [{ time, price: 101 }, { time: time + 10, price: 111 }]),
  style: { color: '#2962ff', width: 2, lineStyle: 'solid' },
});

test('v5 plugin tool models use the expected anchors and one-times AB=CD projection', () => {
  assert.equal(TOOL_KINDS['trend-line'], 'trend-line');
  assert.equal(TOOL_KINDS['horizontal-line'], 'horizontal-line');
  assert.equal(TOOL_KINDS['fib-retracement'], 'fib-retracement');
  assert.equal(TOOL_KINDS['measured-move'], 'trend-based-fib-extension');
  const style = defaultStyleFor('trend-based-fib-extension');
  assert.deepEqual(style.levels.filter(level => level.visible).map(level => level.coeff), [1]);
  assert.deepEqual([defaultStyleFor('trend-line').extendRight, defaultStyleFor('trend-line').extendLeft], [true, false]);
  assert.deepEqual(defaultStyleFor('fib-retracement').levels.filter(level => level.visible).map(level => level.coeff), [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
});

test('anchors snap to the current visible bar high or low in screen space only', () => {
  const { controller, manager } = boot();
  controller.setVisibleBars([
    { time: 10, open: 10, high: 12, low: 8, close: 9 },
    { time: 20, open: 9, high: 11, low: 7, close: 10 },
  ]);
  const snap = manager.snapFn();
  assert.deepEqual(snap({ time: 10, price: 11.5 }), { time: 10, price: 12 });
  assert.deepEqual(snap({ time: 10, price: 8.5 }), { time: 10, price: 8 });
  assert.deepEqual(snap({ time: 10, price: 10 }), { time: 10, price: 12 });
  assert.deepEqual(snap({ time: 11, price: 11.5 }), { time: 11, price: 11.5 }, 'must not snap to a neighboring timestamp');
  assert.deepEqual(snap({ time: 30, price: 11.5 }), { time: 30, price: 11.5 }, 'future blank space must not snap to the last bar');
  assert.deepEqual(manager.aimAt({ x: 10, y: 88.5 }), { x: 10, y: 88 }, 'placement preview follows the same high/low snap');
  assert.deepEqual(manager.aimAt({ x: 30, y: 88.5 }), { x: 30, y: 88.5 }, 'preview remains free in future blank space');

  manager.magnetEnabled = false;
  assert.deepEqual(manager.snapFn()({ time: 10, price: 11.5 }), { time: 10, price: 11.5 }, 'Shift/Ctrl magnet override remains a temporary free-point mode');
  assert.deepEqual(manager.aimAt({ x: 10, y: 88.5 }), { x: 10, y: 88.5 });
});

test('Fib levels validate, persist separately, apply to new Fib defaults, and update a selected Fib undoably', () => {
  const ctx = boot();
  const { controller, manager, storage } = ctx;
  const key = 'es-research:drawings:fib-levels:v1';
  assert.deepEqual(controller.state().fibLevels, [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
  assert.equal(controller.setFibLevels('0, 0.5， -0.272 1.618 0.5'), true);
  const ratios = [0, 0.5, -0.272, 1.618];
  assert.deepEqual(controller.state().fibLevels, ratios);
  assert.deepEqual(JSON.parse(storage.getItem(key)), ratios);
  assert.deepEqual(defaultStyleFor('fib-retracement').levels.map(level => level.coeff), ratios);

  const fibId = manager.add({ ...line('fib', 100, 'fib-retracement'), style: { levels: [{ coeff: 0.5, color: '#00aa88', visible: true }] } });
  manager.select([fibId]);
  assert.deepEqual(controller.state().fibLevels, [0.5], 'selected Fib levels are exposed to the settings input');
  assert.equal(controller.setFibLevels([0, 0.618, 1.272]), true);
  assert.deepEqual(manager.get(fibId).style.levels.map(level => level.coeff), [0, 0.618, 1.272]);
  assert.deepEqual(controller.state().fibLevels, [0, 0.618, 1.272]);
  assert.equal(controller.undo(), true);
  assert.deepEqual(manager.get(fibId).style.levels.map(level => level.coeff), [0.5]);
  assert.equal(controller.redo(), true);
  assert.deepEqual(manager.get(fibId).style.levels.map(level => level.coeff), [0, 0.618, 1.272]);

  const savedPreference = storage.getItem(key);
  const savedDrawing = controller.exportJSON();
  for (const invalid of ['0,NaN', '0,10.01', '0,-10.01', '']) {
    assert.throws(() => controller.setFibLevels(invalid), /斐波那契比例/);
    assert.equal(storage.getItem(key), savedPreference);
    assert.deepEqual(manager.get(fibId).style.levels.map(level => level.coeff), [0, 0.618, 1.272]);
  }
  const reloaded = boot(storage);
  assert.deepEqual(reloaded.controller.state().fibLevels, [0, 0.618, 1.272], 'the latest applied ratios persist independently of chart context');
  assert.deepEqual(JSON.parse(savedDrawing).drawings[0].style.levels.map(level => level.coeff), [0, 0.618, 1.272], 'drawing export retains its own levels');
  const imported = boot(storage);
  imported.controller.importJSON(savedDrawing);
  assert.deepEqual(imported.manager.items[0].style.levels.map(level => level.coeff), [0, 0.618, 1.272]);
});

test('loaded and imported trend lines are normalized to right-extending rays without moving anchors', () => {
  const original = line('old-ray');
  const storage = new MemoryStorage();
  storage.setItem('es-research:drawings:v1:ES%7C5%7Crth%7Cbrowse', JSON.stringify([original]));
  const { controller, manager } = boot(storage);
  assert.deepEqual(manager.get('old-ray').points, original.points);
  assert.deepEqual([manager.get('old-ray').style.extendRight, manager.get('old-ray').style.extendLeft], [true, false]);

  controller.importJSON(JSON.stringify({ version: 1, drawings: [original] }));
  assert.deepEqual(manager.get('old-ray').points, original.points);
  assert.deepEqual([manager.get('old-ray').style.extendRight, manager.get('old-ray').style.extendLeft], [true, false]);
});

test('drawings save by context, update style, delete, undo and redo against the full model', () => {
  const ctx = boot();
  const { controller, manager, storage } = ctx;
  controller.setTool('trend-line');
  assert.equal(manager.activeTool, 'trend-line');
  const trend = manager.add(line('trend'));
  manager.add(line('support', 120, 'horizontal-line'));
  manager.add(line('fib', 140, 'fib-retracement'));
  manager.add(line('measured', 160, 'trend-based-fib-extension', [{ time: 160, price: 100 }, { time: 170, price: 110 }, { time: 180, price: 103 }]));
  assert.equal(controller.state().count, 4);
  assert.equal(JSON.parse(storage.getItem('es-research:drawings:v1:ES%7C5%7Crth%7Cbrowse')).drawings.length, 4);

  manager.select([trend]);
  assert.equal(controller.updateSelected({ color: '#00aa88', lineWidth: 3, text: 'swing' }), true);
  assert.deepEqual([manager.get(trend).style.color, manager.get(trend).style.width, manager.get(trend).style.text, manager.get(trend).text], ['#00aa88', 3, 'swing', 'swing']);
  assert.equal(controller.undo(), true);
  assert.deepEqual([manager.get(trend).style.color, manager.get(trend).style.width], ['#2962ff', 2]);
  assert.equal(controller.redo(), true);
  assert.deepEqual([manager.get(trend).style.text, manager.get(trend).text], ['swing', 'swing']);

  manager.select([trend]);
  assert.equal(controller.deleteSelected(), true);
  assert.deepEqual(manager.items.map(item => item.id), ['support', 'fib', 'measured']);
  assert.equal(controller.state().count, 3);
  assert.equal(controller.undo(), true);
  assert.equal(controller.state().count, 4);
  assert.deepEqual([manager.get(trend).style.text, manager.get(trend).text], ['swing', 'swing']);
  assert.equal(controller.redo(), true);
  assert.equal(controller.state().count, 3);

  const exported = controller.exportJSON();
  const restored = boot(storage);
  assert.equal(restored.controller.state().count, 3);
  assert.deepEqual(JSON.parse(restored.controller.exportJSON()).drawings, JSON.parse(exported).drawings);
  restored.controller.setContext({ key: 'ES|1|rth|browse', mode: 'browse' });
  assert.equal(restored.controller.state().count, 0);
  restored.controller.setContext({ key: 'ES|5|rth|browse', mode: 'browse' });
  assert.equal(restored.controller.state().count, 3);
});

test('replay filters later anchors, keeps user forecast drawings until their creation cursor, and resets safely', () => {
  const { controller, manager } = boot();
  controller.setContext({ key: 'ES|5|rth|replay|2026-07-31|09:30', mode: 'replay' });
  controller.importJSON(JSON.stringify({ version: 1, context: 'ES|5|rth|replay|2026-07-31|09:30', drawings: [line('old', 100), line('future', 200)], replayCreatedAt: {} }));
  controller.setVisibleBars([{ time: 150, high: 110, low: 90, open: 100, close: 101 }]);
  assert.deepEqual(manager.items.map(item => item.id), ['old']);

  const forecastId = manager.add(line('forecast', 300));
  assert.deepEqual(manager.items.map(item => item.id), ['old', forecastId]);
  assert.equal(JSON.parse(controller.exportJSON()).replayCreatedAt[forecastId], 150);
  controller.setVisibleBars([{ time: 130 }]);
  assert.deepEqual(manager.items.map(item => item.id), ['old']);
  controller.setVisibleBars([{ time: 150 }]);
  assert.deepEqual(manager.items.map(item => item.id), ['old', forecastId]);
  controller.setVisibleBars([{ time: 100 }]);
  assert.deepEqual(manager.items.map(item => item.id), []);
  assert.equal(controller.undo(), true);
  assert.equal(manager.items.some(item => item.id === forecastId), false);
  assert.equal(manager.items.some(item => item.id === 'old'), false);
  assert.equal(controller.redo(), true);
  assert.equal(manager.items.some(item => item.id === forecastId), false);
  assert.equal(manager.items.some(item => item.id === 'old'), false);
  controller.setVisibleBars([{ time: 150 }]);
  assert.deepEqual(manager.items.map(item => item.id), ['old', forecastId]);
});

test('replay edits advance drawing visibility and undo/redo restore the edit cursor', () => {
  const { controller, manager } = boot();
  controller.setContext({ key: 'ES|5|rth|replay|2026-07-31|09:30', mode: 'replay' });
  controller.importJSON(JSON.stringify({ version: 1, context: 'ES|5|rth|replay|2026-07-31|09:30', drawings: [line('old', 100)], replayCreatedAt: {} }));
  controller.setVisibleBars([{ time: 150 }]);
  assert.deepEqual(manager.items.map(item => item.id), ['old']);

  controller.setVisibleBars([{ time: 200 }]);
  manager.select(['old']);
  assert.equal(controller.updateSelected({ color: '#00aa88' }), true);
  assert.equal(JSON.parse(controller.exportJSON()).replayCreatedAt.old, 200);
  controller.setVisibleBars([{ time: 150 }]);
  assert.deepEqual(manager.items, []);

  assert.equal(controller.undo(), true);
  assert.deepEqual(manager.items.map(item => item.id), ['old']);
  assert.equal(manager.get('old').style.color, '#2962ff');
  assert.equal(JSON.parse(controller.exportJSON()).replayCreatedAt.old, undefined);

  assert.equal(controller.redo(), true);
  assert.deepEqual(manager.items, []);
  assert.equal(JSON.parse(controller.exportJSON()).replayCreatedAt.old, 200);
  controller.setVisibleBars([{ time: 200 }]);
  assert.deepEqual(manager.items.map(item => item.id), ['old']);
  assert.equal(manager.get('old').style.color, '#00aa88');
});

test('import validates everything before replacing drawings and protects malformed saved data', () => {
  const ctx = boot();
  const { controller, manager, storage } = ctx;
  manager.add(line('keep'));
  const before = controller.exportJSON();
  assert.throws(() => controller.importJSON(JSON.stringify([line('bad', 100, 'parallel-channel')])), /不支持/);
  assert.deepEqual(JSON.parse(controller.exportJSON()).drawings, JSON.parse(before).drawings);
  const savedKey = 'es-research:drawings:v1:ES%7C5%7Crth%7Cbrowse';
  const corrupt = '{ broken json';
  storage.setItem(savedKey, corrupt);
  const second = boot(storage);
  assert.ok(second.controller.state().error.includes('无法载入'));
  second.controller.setContext({ key: 'ES|1|rth|browse', mode: 'browse' });
  second.controller.destroy();
  assert.equal(storage.getItem(savedKey), corrupt);
});
