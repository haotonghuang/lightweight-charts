import {
  DrawingManager,
  factoryStyleFor,
  setDefaultStyleOverride,
} from './vendor/drawing/lightweight-charts-drawing-0.6.3.mjs';

export const DRAWING_VERSION = '0.6.3';
const ALLOWED = new Set(['trend-line', 'horizontal-line', 'fib-retracement', 'trend-based-fib-extension']);
const POINTS = { 'trend-line': 2, 'horizontal-line': 1, 'fib-retracement': 2, 'trend-based-fib-extension': 3 };
const MAX_IMPORT_CHARS = 1_000_000;
const MAX_DRAWINGS = 2_000;
const MAX_UNDO = 100;
const STORAGE_PREFIX = 'es-research:drawings:v1:';
const FIB_LEVELS_STORAGE_KEY = 'es-research:drawings:fib-levels:v1';
const MEASURED_BASE_STYLE = factoryStyleFor('trend-based-fib-extension');
const FIB_BASE_STYLE = factoryStyleFor('fib-retracement');
const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = FIB_BASE_STYLE.levels.map(level => level.color);
let activeFibLevels = [...DEFAULT_FIB_LEVELS];

function fibStyleLevels(ratios, existing = FIB_BASE_STYLE.levels) {
  return ratios.map((coeff, index) => {
    const prior = existing.find(level => level.coeff === coeff);
    return {
      coeff,
      color: prior?.color ?? FIB_COLORS[index % FIB_COLORS.length] ?? FIB_BASE_STYLE.color,
      visible: true,
      ...(typeof prior?.label === 'string' ? { label: prior.label } : {}),
    };
  });
}

function parseFibLevels(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.trim().split(/[,，\s]+/u).filter(Boolean).map(token => Number(token))
      : null;
  if (!values || values.length === 0 || values.length > 30 || values.some(level => !Number.isFinite(level) || level < -10 || level > 10)) {
    throw new Error('斐波那契比例需为 1 到 30 个 [-10, 10] 范围内的数字');
  }
  const unique = [...new Set(values)];
  if (unique.length === 0) throw new Error('请至少输入一个斐波那契比例');
  return unique;
}

function readFibLevels(storage) {
  try {
    const raw = storage?.getItem?.(FIB_LEVELS_STORAGE_KEY);
    if (raw === null || raw === undefined) return [...DEFAULT_FIB_LEVELS];
    return parseFibLevels(JSON.parse(raw));
  } catch {
    return [...DEFAULT_FIB_LEVELS];
  }
}

function measuredMoveStyle() {
  const base = { ...MEASURED_BASE_STYLE };
  const levels = (base.levels ?? []).map(level => ({ ...level, visible: level.coeff === 1 }));
  if (!levels.some(level => level.coeff === 1)) levels.push({ coeff: 1, color: base.color, visible: true });
  return { ...base, levels, extendRight: true, fillBackground: false, showPrices: true, showCoeffs: true };
}

// The placement manager reads this merged override when a tool is clicked.
// Keep all per-tool defaults together so registering Fib and ray styles cannot
// replace the measured-move projection style.
setDefaultStyleOverride(kind => {
  if (kind === 'trend-based-fib-extension') return measuredMoveStyle();
  if (kind === 'trend-line') return { extendRight: true, extendLeft: false };
  if (kind === 'fib-retracement') return { levels: fibStyleLevels(activeFibLevels) };
  return undefined;
});

export const TOOL_KINDS = Object.freeze({
  'trend-line': 'trend-line',
  'horizontal-line': 'horizontal-line',
  'fib-retracement': 'fib-retracement',
  'measured-move': 'trend-based-fib-extension',
  trendline: 'trend-line',
  support: 'horizontal-line',
  resistance: 'horizontal-line',
  retracement: 'fib-retracement',
  measuredMove: 'trend-based-fib-extension',
});

function safeJSON(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

function validateStyle(style) {
  if (style === undefined) return {};
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new Error('图形样式无效');
  const clean = {};
  if ('lineWidth' in style && !('width' in style)) style = { ...style, width: style.lineWidth };
  if ('color' in style) {
    if (typeof style.color !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(style.color)) throw new Error('图形颜色无效');
    clean.color = style.color;
  }
  if ('width' in style) {
    if (!Number.isFinite(style.width) || style.width < 0.5 || style.width > 6) throw new Error('线宽需在 0.5 到 6 像素之间');
    clean.width = style.width;
  }
  if ('lineStyle' in style) {
    if (!['solid', 'dashed', 'dotted'].includes(style.lineStyle)) throw new Error('线型无效');
    clean.lineStyle = style.lineStyle;
  }
  if ('text' in style) {
    if (typeof style.text !== 'string' || style.text.length > 80) throw new Error('图形标签最多 80 个字符');
    clean.text = style.text;
  }
  if ('textColor' in style && typeof style.textColor === 'string' && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(style.textColor)) clean.textColor = style.textColor;
  if ('levels' in style) {
    if (!Array.isArray(style.levels) || style.levels.length > 30 || style.levels.some(level => !level || !Number.isFinite(level.coeff) || typeof level.visible !== 'boolean' || typeof level.color !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(level.color))) throw new Error('斐波那契比例无效');
    clean.levels = style.levels.map(level => ({ coeff: level.coeff, visible: level.visible, color: level.color, ...(typeof level.label === 'string' ? { label: level.label.slice(0, 24) } : {}) }));
  }
  for (const name of ['extendLeft', 'extendRight', 'fillBackground', 'showPriceLabels', 'showPrices', 'showCoeffs', 'fibLevelsAsPercents', 'reverse']) {
    if (name in style) {
      if (typeof style[name] !== 'boolean') throw new Error(`图形选项 ${name} 无效`);
      clean[name] = style[name];
    }
  }
  if ('backgroundColor' in style) {
    if (typeof style.backgroundColor !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(style.backgroundColor)) throw new Error('背景颜色无效');
    clean.backgroundColor = style.backgroundColor;
  }
  if ('transparency' in style) {
    if (!Number.isFinite(style.transparency) || style.transparency < 0 || style.transparency > 100) throw new Error('透明度无效');
    clean.transparency = style.transparency;
  }
  if ('fontSize' in style) {
    if (!Number.isFinite(style.fontSize) || style.fontSize < 8 || style.fontSize > 32) throw new Error('字体大小无效');
    clean.fontSize = style.fontSize;
  }
  return clean;
}

function validateDrawings(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_DRAWINGS) throw new Error('图形文件格式错误或图形数量过多');
  const ids = new Set();
  return raw.map(drawing => {
    if (!drawing || typeof drawing !== 'object' || !ALLOWED.has(drawing.kind)) throw new Error('图形文件包含暂不支持的工具');
    if (typeof drawing.id !== 'string' || !drawing.id || drawing.id.length > 120 || ids.has(drawing.id)) throw new Error('图形编号无效');
    ids.add(drawing.id);
    if (!Array.isArray(drawing.points) || drawing.points.length !== POINTS[drawing.kind]) throw new Error('图形锚点数量无效');
    const points = drawing.points.map(point => {
      if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.price)) throw new Error('图形锚点必须包含有效时间和价格');
      return { time: point.time, price: point.price };
    });
    const style = validateStyle(drawing.style);
    // Existing saved/imported trend lines follow the current ray behavior while
    // retaining their original two anchors.
    if (drawing.kind === 'trend-line') {
      style.extendRight = true;
      style.extendLeft = false;
    }
    return { id: drawing.id, kind: drawing.kind, points, style, ...(typeof drawing.text === 'string' ? { text: drawing.text.slice(0, 80) } : {}) };
  });
}

function timeValue(time) {
  if (typeof time === 'number') return time;
  if (typeof time === 'string') return Date.parse(`${time}T00:00:00Z`) / 1000;
  if (time && Number.isInteger(time.year) && Number.isInteger(time.month) && Number.isInteger(time.day)) {
    return Date.UTC(time.year, time.month - 1, time.day) / 1000;
  }
  return NaN;
}

export function drawingAnchorTimes(drawing) {
  return drawing.points.map(point => timeValue(point.time));
}

function validReplayCreatedAt(value, drawings) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const ids = new Set(drawings.map(drawing => drawing.id));
  return Object.fromEntries(Object.entries(value).filter(([id, time]) => ids.has(id) && Number.isFinite(time)));
}

function emptyState(tool, selectedCount, canUndo, canRedo, count, visible, error, fibLevels = DEFAULT_FIB_LEVELS) {
  return { tool, selectedCount, canUndo, canRedo, count, visible, fibLevels: [...fibLevels], ...(error ? { error } : {}) };
}

function assertSnapCompatibility(manager) {
  const requiredManagerMethods = ['snapFn', 'aimAt', 'magnet'];
  const requiredCoordinates = ['xToTime', 'yToPrice', 'priceToY', 'timeToX'];
  if (requiredManagerMethods.some(name => typeof manager?.[name] !== 'function')
    || requiredCoordinates.some(name => typeof manager?.coords?.[name] !== 'function')) {
    throw new Error(`绘图插件 ${DRAWING_VERSION} 的吸附接口不兼容`);
  }
}

function installHighLowSnap(manager, bars) {
  // 0.6.3 exposes snapFn(), aimAt(), and coords on DrawingManager instances.
  // We wrap these narrow extension points instead of changing the vendored bundle.
  assertSnapCompatibility(manager);
  const defaultSnapFn = manager.snapFn;
  const defaultAimAt = manager.aimAt;

  function snapToVisibleExtremum(point, coords) {
    const pointTime = timeValue(point?.time);
    if (!Number.isFinite(pointTime)) return null;
    const bar = bars().find(item => timeValue(item.time) === pointTime);
    if (!bar || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) return null;
    const pointerY = coords.priceToY(point.price);
    const highY = coords.priceToY(bar.high);
    const lowY = coords.priceToY(bar.low);
    if (![pointerY, highY, lowY].every(Number.isFinite)) return null;
    const price = Math.abs(pointerY - highY) <= Math.abs(pointerY - lowY) ? bar.high : bar.low;
    return { time: point.time, price };
  }

  manager.snapFn = function snapVisibleHighLow() {
    const magnet = this.magnet();
    const fallback = defaultSnapFn.call(this);
    if (!magnet?.enabled) return fallback;
    const coords = this.coords;
    return point => snapToVisibleExtremum(point, coords) ?? point;
  };

  manager.aimAt = function aimVisibleHighLow(point) {
    const magnet = this.magnet();
    if (!magnet?.enabled) return defaultAimAt.call(this, point);
    const coords = this.coords;
    const time = coords.xToTime(point.x);
    const price = coords.yToPrice(point.y);
    if (!Number.isFinite(timeValue(time)) || !Number.isFinite(price)) return point;
    const snapped = snapToVisibleExtremum({ time, price }, coords);
    if (!snapped) return point;
    const x = coords.timeToX(snapped.time);
    const y = coords.priceToY(snapped.price);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : point;
  };
}

export function createDrawingController({ chart, series, storage = globalThis.localStorage, onState = () => {}, managerFactory = (c, s, options) => new DrawingManager(c, s, options) }) {
  let manager;
  let contextKey = 'default';
  let contextMode = 'browse';
  let visibleBars = [];
  let replayCursor = -Infinity;
  let drawings = [];
  let replayCreatedAt = {};
  let visible = true;
  let tool = null;
  let error = '';
  let undo = [];
  let redo = [];
  let committedJSON = '[]';
  let pendingBefore = null;
  let applying = false;
  let persistAllowed = true;
  let disposed = false;
  const off = [];
  let fibLevels = readFibLevels(storage);
  activeFibLevels = [...fibLevels];

  const selected = () => manager ? manager.selection().length : 0;
  const contextStorageKey = key => `${STORAGE_PREFIX}${encodeURIComponent(key)}`;
  function stateFibLevels() {
    if (manager) {
      const ids = manager.selection();
      if (ids.length === 1) {
        const drawing = manager.get(ids[0]);
        if (drawing?.kind === 'fib-retracement' && Array.isArray(drawing.style?.levels)) {
          return drawing.style.levels.map(level => level.coeff);
        }
      }
    }
    return fibLevels;
  }

  function emit() {
    onState(emptyState(tool, selected(), undo.length > 0, redo.length > 0, drawings.length, visible, error, stateFibLevels()));
  }
  function reportError(cause) {
    error = cause?.message || String(cause);
    emit();
  }
  function envelopeJSON() {
    return JSON.stringify({ version: 1, drawingLibrary: DRAWING_VERSION, context: contextKey, drawings, replayCreatedAt });
  }
  function persist() {
    if (!persistAllowed || !storage?.setItem) return;
    try { storage.setItem(contextStorageKey(contextKey), envelopeJSON()); error = ''; }
    catch (cause) { reportError(new Error(`自动保存失败：${cause.message || cause}`)); }
  }
  function managerJSON() {
    return manager ? manager.exportJSON() : '[]';
  }
  function snapshot() {
    return { json: JSON.stringify(drawings), replayCreatedAt: { ...replayCreatedAt } };
  }
  function syncModelFromManager() {
    if (!manager) return;
    const previous = new Map(drawings.map(drawing => [drawing.id, drawing]));
    const next = new Map(drawings.map(drawing => [drawing.id, drawing]));
    for (const drawing of manager.drawings()) next.set(drawing.id, drawing);
    // Keep drawings hidden for this replay cursor in the saved model.
    drawings = Array.from(next.values());
    const ids = new Set(drawings.map(drawing => drawing.id));
    replayCreatedAt = Object.fromEntries(Object.entries(replayCreatedAt).filter(([id]) => ids.has(id)));
    for (const [id, drawing] of previous) if (!next.has(id)) replayCreatedAt = Object.fromEntries(Object.entries(replayCreatedAt).filter(([key]) => key !== id));
  }
  function replayEligible(drawing) {
    if (contextMode !== 'replay') return true;
    const createdAt = replayCreatedAt[drawing.id];
    if (Number.isFinite(createdAt)) return createdAt <= replayCursor;
    const times = drawingAnchorTimes(drawing);
    return times.every(Number.isFinite) && times.every(time => time <= replayCursor);
  }
  function visibleDrawings() { return drawings.filter(replayEligible); }
  function applyToManager(nextDrawings, nextCreatedAt = replayCreatedAt) {
    applying = true;
    try {
      manager.importJSON(JSON.stringify(nextDrawings));
      replayCreatedAt = nextCreatedAt;
      manager.setDrawingsVisible(visible);
      pendingBefore = null;
      emit();
    } finally { applying = false; }
  }
  function pushUndo(before, after) {
    if (before.json === after.json && safeJSON(before.replayCreatedAt) === safeJSON(after.replayCreatedAt)) return;
    undo.push(before);
    if (undo.length > MAX_UNDO) undo.shift();
    redo = [];
  }
  function commitPending() {
    if (applying || pendingBefore === null) return;
    syncModelFromManager();
    const current = snapshot();
    pushUndo(pendingBefore, current);
    pendingBefore = null;
    committedJSON = current.json;
    persist();
    emit();
  }
  function checkpointManualEdit(action) {
    const before = snapshot();
    pendingBefore = before;
    action();
    commitPending();
  }
  function restoreFromStack(from, to) {
    if (!from.length) return false;
    const current = snapshot();
    const next = from.pop();
    to.push(current);
    const parsed = JSON.parse(next.json);
    drawings = parsed;
    replayCreatedAt = next.replayCreatedAt;
    applyToManager(visibleDrawings(), replayCreatedAt);
    syncModelFromManager();
    persist();
    return true;
  }
  function wireManager() {
    off.push(manager.on('selection', () => emit()));
    off.push(manager.on('tool', value => {
      tool = value ? Object.entries(TOOL_KINDS).find(([, kind]) => kind === value)?.[0] ?? value : null;
      emit();
    }));
    off.push(manager.on('visibility', value => { visible = value; emit(); }));
    off.push(manager.on('change', () => {
      if (applying) return;
      syncModelFromManager();
      persist();
      emit();
    }));
    off.push(manager.on('add', drawing => {
      pendingBefore ??= snapshot();
      if (contextMode === 'replay' && Number.isFinite(replayCursor)) replayCreatedAt[drawing.id] = replayCursor;
    }));
    off.push(manager.on('update', drawing => {
      pendingBefore ??= snapshot();
      if (contextMode === 'replay' && Number.isFinite(replayCursor)) replayCreatedAt[drawing.id] = replayCursor;
    }));
    off.push(manager.on('remove', drawing => {
      pendingBefore ??= snapshot();
      drawings = drawings.filter(item => item.id !== drawing.id);
      delete replayCreatedAt[drawing.id];
      queueMicrotask(commitPending);
    }));
    off.push(manager.on('gestureEnd', commitPending));
  }
  function loadKey(key, mode) {
    contextKey = key;
    contextMode = mode;
    undo = [];
    redo = [];
    pendingBefore = null;
    replayCursor = -Infinity;
    persistAllowed = true;
    let raw = null;
    try { raw = storage?.getItem?.(contextStorageKey(contextKey)); }
    catch (cause) {
      persistAllowed = false;
      reportError(new Error(`读取本地标注失败：${cause.message || cause}`));
    }
    if (!raw) {
      drawings = [];
      replayCreatedAt = {};
      applyToManager([]);
      return;
    }
    try {
      if (raw.length > MAX_IMPORT_CHARS) throw new Error('该图形文件过大');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed?.drawings;
      const checked = validateDrawings(list);
      const created = Array.isArray(parsed) ? {} : validReplayCreatedAt(parsed.replayCreatedAt, checked);
      drawings = checked;
      replayCreatedAt = created;
      applyToManager(visibleDrawings(), created);
      // `drawings` intentionally remains the full set when replay hides future drawings.
      drawings = checked;
      committedJSON = JSON.stringify(checked);
      persistAllowed = true;
    } catch (cause) {
      error = `无法载入此组图形：${cause.message || cause}`;
      persistAllowed = false;
      drawings = [];
      replayCreatedAt = {};
      applyToManager([]);
    }
  }

  manager = managerFactory(chart, series, {
    magnet: 'weak',
    stayInDrawingMode: false,
    timeInfo: { timeZone: 'UTC', intraday: true },
    bars: () => visibleBars,
  });
  installHighLowSnap(manager, () => visibleBars);
  wireManager();
  committedJSON = managerJSON();
  emit();

  return {
    setContext({ key, mode = 'browse' } = {}) {
      if (disposed) return;
      if (typeof key !== 'string' || !key || key.length > 500) throw new Error('图形分类键无效');
      if (!['browse', 'review', 'replay'].includes(mode)) throw new Error('图形模式无效');
      if (key === contextKey && mode === contextMode) return;
      syncModelFromManager();
      persist();
      contextKey = key;
      contextMode = mode;
      visibleBars = [];
      replayCursor = -Infinity;
      manager.setTool(null);
      loadKey(key, mode);
      emit();
    },
    setVisibleBars(bars) {
      if (disposed) return;
      visibleBars = bars.filter(bar => Number.isFinite(bar.time));
      replayCursor = visibleBars.length ? timeValue(visibleBars.at(-1).time) : -Infinity;
      if (contextMode === 'replay') {
        syncModelFromManager();
        const next = JSON.stringify(visibleDrawings());
        if (next !== managerJSON()) {
          applyToManager(JSON.parse(next));
          committedJSON = managerJSON();
        }
      }
      emit();
    },
    setTool(value) {
      if (disposed) return;
      if (value === null) { manager.setTool(null); return; }
      const kind = TOOL_KINDS[value];
      if (!kind || !ALLOWED.has(kind)) throw new Error('暂不支持该绘图工具');
      activeFibLevels = [...fibLevels];
      manager.setTool(kind);
    },
    setFibLevels(value) {
      if (disposed) return false;
      const nextLevels = parseFibLevels(value);
      fibLevels = nextLevels;
      activeFibLevels = [...nextLevels];
      let storageError = null;
      try { storage?.setItem?.(FIB_LEVELS_STORAGE_KEY, JSON.stringify(nextLevels)); }
      catch (cause) { storageError = cause; }

      const ids = manager.selection();
      if (ids.length === 1) {
        const drawing = manager.get(ids[0]);
        if (drawing?.kind === 'fib-retracement') {
          const levels = fibStyleLevels(nextLevels, drawing.style?.levels ?? FIB_BASE_STYLE.levels);
          const style = validateStyle({ ...drawing.style, levels });
          checkpointManualEdit(() => manager.update({ ...drawing, style }));
          if (storageError) reportError(new Error(`默认斐波那契比例保存失败：${storageError.message || storageError}`));
          return true;
        }
      }
      if (storageError) {
        reportError(new Error(`默认斐波那契比例保存失败：${storageError.message || storageError}`));
        return true;
      }
      emit();
      return true;
    },
    undo() { if (disposed) return false; pendingBefore = null; const ok = restoreFromStack(undo, redo); emit(); return ok; },
    redo() { if (disposed) return false; pendingBefore = null; const ok = restoreFromStack(redo, undo); emit(); return ok; },
    deleteSelected() {
      if (disposed) return false;
      const ids = manager.selection();
      if (!ids.length) return false;
      checkpointManualEdit(() => ids.forEach(id => manager.remove(id)));
      return true;
    },
    updateSelected(changes = {}) {
      if (disposed) return false;
      const ids = manager.selection();
      if (ids.length !== 1) return false;
      const drawing = manager.get(ids[0]);
      if (!drawing || !ALLOWED.has(drawing.kind)) return false;
      const { lineWidth, text, ...styleChanges } = changes;
      if (lineWidth !== undefined) styleChanges.width = lineWidth;
      if (text !== undefined && (typeof text !== 'string' || text.length > 80)) throw new Error('图形标签最多 80 个字符');
      // Line tools render labels from style.text; retain top-level text for export interoperability.
      if (text !== undefined) styleChanges.text = text;
      const style = validateStyle({ ...drawing.style, ...styleChanges });
      checkpointManualEdit(() => manager.update({ ...drawing, style, ...(text !== undefined ? { text } : {}) }));
      return true;
    },
    setVisible(value) {
      if (disposed) return;
      visible = Boolean(value);
      manager.setDrawingsVisible(visible);
      emit();
    },
    exportJSON() {
      syncModelFromManager();
      return JSON.stringify({ version: 1, drawingLibrary: DRAWING_VERSION, context: contextKey, drawings, replayCreatedAt }, null, 2);
    },
    importJSON(raw) {
      if (disposed) return false;
      if (typeof raw !== 'string' || raw.length > MAX_IMPORT_CHARS) throw new Error('图形文件格式错误或文件过大');
      const value = JSON.parse(raw);
      if (!Array.isArray(value) && (value.version !== 1 || (value.context && value.context !== contextKey))) throw new Error('图形文件版本或分类与当前图表不匹配');
      const checked = validateDrawings(Array.isArray(value) ? value : value.drawings);
      const created = Array.isArray(value) ? {} : validReplayCreatedAt(value.replayCreatedAt, checked);
      const before = snapshot();
      drawings = checked;
      replayCreatedAt = created;
      applyToManager(visibleDrawings(), created);
      committedJSON = JSON.stringify(checked);
      pushUndo(before, snapshot());
      persist();
      error = '';
      emit();
      return true;
    },
    state() { return emptyState(tool, selected(), undo.length > 0, redo.length > 0, drawings.length, visible, error, stateFibLevels()); },
    manager,
    destroy() {
      if (disposed) return;
      syncModelFromManager();
      persist();
      for (const unsubscribe of off) unsubscribe();
      manager.destroy();
      disposed = true;
    },
  };
}
