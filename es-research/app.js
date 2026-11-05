import { createDrawingController } from './drawings.js';
import { Replay, countMarkers, openingRange, replayStartTime, gapMarkers } from './replay.js';

const { createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers } = LightweightCharts;
const $ = id => document.getElementById(id);
const stamp = time => new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ');
const number = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const signed = value => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : '—';
const chart = createChart($('chart'), {
  autoSize: true,
  layout: { background: { color: '#101722' }, textColor: '#b9c8d8', attributionLogo: true },
  grid: { vertLines: { color: '#1d2a3b' }, horzLines: { color: '#1d2a3b' } },
  timeScale: { timeVisible: true, secondsVisible: false },
  localization: { locale: 'zh-CN', timeFormatter: stamp },
});
const candles = chart.addSeries(CandlestickSeries, {
  upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
  wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
});
const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
volume.priceScale().applyOptions({ scaleMargins: { top: 0.90, bottom: 0 } });
candles.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.15 } });
const ema = chart.addSeries(LineSeries, { color: '#f7bc53', lineWidth: 2, title: 'EMA20', priceLineVisible: false });
const adr = chart.addSeries(LineSeries, { color: '#68acff', lineWidth: 2, title: 'ADR8', priceLineVisible: false }, 1);
const abr = chart.addSeries(LineSeries, { color: '#ca93f8', lineWidth: 2, title: 'ABR8', priceLineVisible: false }, 1);
chart.panes()[0].setStretchFactor(7);
chart.panes()[1].setStretchFactor(1);
const markers = createSeriesMarkers(candles, []);

let visible = [];
let records = new Map();
let replay = null;
let timer = null;
let activeMode = null;
let review = null;
let controller = null;
let loading = false;
let dirty = false;
let rollRevision = 'v1';
let rollEventCount = 0;

let drawingController = null;
let drawingContextRevision = 0;
function drawingAction(action) {
  try { return action(drawingController); }
  catch (error) { $('drawing-status').textContent = `绘图：${error.message}`; }
}
try {
  drawingController = createDrawingController({
    chart, series: candles, storage: globalThis.localStorage,
    onState(state) {
      $('drawing-tool').value = state.tool ?? '';
      $('drawing-undo').disabled = !state.canUndo;
      $('drawing-redo').disabled = !state.canRedo;
      $('drawing-delete').disabled = !state.selectedCount;
      $('drawing-apply').disabled = state.selectedCount !== 1;
      $('drawing-visible').checked = state.visible !== false;
      if (state.fibLevels && document.activeElement !== $('drawing-fib-levels')) $('drawing-fib-levels').value = state.fibLevels.join(',');
      const instructions = { 'trend-line': '依次点击两点，向右延伸；吸附当前 K 线高 / 低点', 'horizontal-line': '点击放置水平线', 'measured-move': '依次点击 A、B、C', 'fib-retracement': '依次点击波段起点、终点' };
      $('drawing-status').textContent = state.error || instructions[state.tool] || `${state.count ?? 0} 个图形${state.selectedCount ? ` · 已选 ${state.selectedCount}` : ''}`;
    },
  });
} catch (error) {
  $('drawing-status').textContent = `绘图不可用：${error.message}`;
  $('drawing-tool').disabled = true;
}
$('drawing-tool').addEventListener('change', () => { pause(); drawingAction(d => d?.setTool($('drawing-tool').value || null)); });
$('drawing-undo').addEventListener('click', () => drawingAction(d => d?.undo()));
$('drawing-redo').addEventListener('click', () => drawingAction(d => d?.redo()));
$('drawing-delete').addEventListener('click', () => drawingAction(d => d?.deleteSelected()));
$('drawing-visible').addEventListener('change', () => drawingAction(d => d?.setVisible($('drawing-visible').checked)));
$('drawing-fib-apply').addEventListener('click', () => drawingAction(d => d?.setFibLevels($('drawing-fib-levels').value)));
$('drawing-apply').addEventListener('click', () => drawingAction(d => d?.updateSelected({
  color: $('drawing-color').value, lineWidth: Number($('drawing-width').value), text: $('drawing-text').value,
})));
$('drawing-export').addEventListener('click', () => drawingAction(d => {
  if (!d) return;
  const url = URL.createObjectURL(new Blob([d.exportJSON()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'es-drawings.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}));
$('drawing-import').addEventListener('change', async () => {
  const revision = drawingContextRevision;
  const file = $('drawing-import').files?.[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error('绘图文件不能超过 1 MB');
    const text = await file.text();
    if (revision !== drawingContextRevision) throw new Error('加载区间已改变，请重新选择导入文件');
    drawingAction(d => d?.importJSON(text));
  } catch (error) { $('drawing-status').textContent = `导入失败：${error.message}`; }
  finally { $('drawing-import').value = ''; }
});
document.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,[contenteditable]')) return;
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
    event.preventDefault();
    drawingAction(d => event.shiftKey ? d?.redo() : d?.undo());
  }
});

function readout(bar) {
  $('ohlc').textContent = bar
    ? `${stamp(bar.time)}　开 ${number(bar.open)}　高 ${number(bar.high)}　低 ${number(bar.low)}　收 ${number(bar.close)}　成交量 ${bar.volume.toLocaleString()}`
    : '移动十字光标查看已显示的 K 线。';
  $('ema-value').textContent = `EMA_20 ${number(bar?.ema20)}`;
  $('adr-value').textContent = `ADR_8 ${number(bar?.adr8)}`;
  $('abr-value').textContent = `ABR_8 ${number(bar?.abr8)}`;
  $('range-value').textContent = `长度 H−L ${bar ? number(bar.high - bar.low) : '—'} 点`;
  $('body-value').textContent = `实体 |C−O| ${bar ? number(Math.abs(bar.close - bar.open)) : '—'} 点`;
  $('gap-value').textContent = `RTH 跳空 ${signed(bar?.rthGap)} 点 (${signed(bar?.rthGapPercent)}%)`;
  $('count-value').textContent = `RTH 第 ${bar?.barCount ?? '—'} 根`;
}
chart.subscribeCrosshairMove(param => readout(records.get(param.time) ?? visible.at(-1)));

function updateMarkers() {
  const data = $('show-count').checked ? countMarkers(visible) : [];
  if ($('show-gap').checked) data.push(...gapMarkers(visible));
  if (review && records.has(review.focusTime)) {
    const opening = data.find(marker => marker.time === review.focusTime && marker.position === 'aboveBar');
    if (opening) opening.text = `当日开盘 · ${opening.text}`;
    else data.push({ time: review.focusTime, position: 'aboveBar', shape: 'arrowDown', color: '#f7bc53', text: '当日开盘' });
  }
  data.sort((a, b) => a.time - b.time);
  markers.setMarkers(data);
}
function lineData(bars, key) {
  return bars.map(bar => Number.isFinite(bar[key]) ? { time: bar.time, value: bar[key] } : { time: bar.time });
}
function render(bars) {
  // The chart and hover map always consume the same revealed slice.
  visible = bars;
  records = new Map(bars.map(bar => [bar.time, bar]));
  candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
  volume.setData(bars.map(bar => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? '#26a69a80' : '#ef535080' })));
  ema.setData(lineData(bars, 'ema20'));
  adr.setData(lineData(bars, 'adr8'));
  abr.setData(lineData(bars, 'abr8'));
  drawingAction(d => d?.setVisibleBars(bars));
  updateMarkers();
  readout(bars.at(-1));
  syncControls();
}
function syncControls() {
  const ready = replay && !loading && !dirty && activeMode === 'replay';
  $('drawing-tool').disabled = !drawingController || loading || dirty || !visible.length;
  $('play').disabled = !ready || replay.complete;
  $('step').disabled = !ready || replay.complete;
  $('reset').disabled = !ready;
  $('fit').disabled = !visible.length || loading;
  $('center').disabled = !review || !visible.length || loading || dirty;
  $('play').textContent = timer ? '暂停' : '播放';
  if (replay) $('progress').textContent = `已播放 ${replay.played} / ${replay.total} 根${replay.complete ? ' · 回放结束' : ' · 空格播放 / 暂停'}`;
}
function pause() {
  clearInterval(timer);
  timer = null;
  syncControls();
}
function step() {
  if (!replay || loading || dirty || replay.complete) return;
  const range = chart.timeScale().getVisibleLogicalRange();
  render(replay.advance());
  const end = visible.length - 1;
  if (range) {
    const width = Math.max(30, range.to - range.from);
    chart.timeScale().setVisibleLogicalRange({ from: end - width + 6, to: end + 6 });
  } else chart.timeScale().setVisibleLogicalRange({ from: end - 65, to: end + 6 });
  if (replay.complete) pause();
}
function play() {
  if (timer) return pause();
  if (!replay || loading || dirty || replay.complete) return;
  drawingAction(d => d?.setTool(null));
  timer = setInterval(step, Number($('speed').value));
  syncControls();
}
function centerOpen() {
  if (!review || !visible.length) return;
  const index = visible.findIndex(bar => bar.time === review.focusTime);
  if (index >= 0) chart.timeScale().setVisibleLogicalRange(openingRange(index));
}
function configureMode() {
  const mode = $('mode').value;
  for (const element of document.querySelectorAll('[data-range]')) {
    element.hidden = mode === 'review';
    for (const input of element.querySelectorAll('input,select')) input.disabled = mode === 'review';
  }
  $('review-field').hidden = mode !== 'review';
  $('review-date').disabled = mode !== 'review';
  $('review-date').required = mode === 'review';
  $('replay-field').hidden = mode !== 'replay';
  $('replay-time').disabled = mode !== 'replay';
  $('replay-time').required = mode === 'replay';
  $('transport').hidden = mode !== 'replay';
  $('center').hidden = mode !== 'review';
  $('load').textContent = mode === 'review' ? '加载早盘' : mode === 'replay' ? '准备回放' : '加载图表';
}
async function load() {
  pause();
  controller?.abort();
  const request = new AbortController();
  controller = request;
  loading = true;
  dirty = false;
  replay = null;
  review = null;
  activeMode = $('mode').value;
  const mode = activeMode;
  // Capture settings before awaiting; an input change aborts this request.
  const start = $('start').value;
  const end = $('end').value;
  const replayTime = $('replay-time').value;
  const startTime = replayStartTime(start, replayTime);
  const adjustment = $('adjustment').value || 'back';
  const params = new URLSearchParams({ start, end, interval: $('interval').value, session: $('session').value, adjustment });
  $('adjustment-info').textContent = adjustment === 'back' ? `估算去换月 · ${rollEventCount} 处` : '原始价格';
  drawingAction(d => d?.setVisibleBars([]));
  drawingContextRevision++;
  const drawingSymbol = adjustment === 'back' ? `ES@back:${rollRevision}:rth1615` : 'ES';
  const drawingKey = mode === 'replay'
    ? `${drawingSymbol}|${params.get('interval')}|${params.get('session')}|replay|${start}|${replayTime}`
    : `${drawingSymbol}|${mode === 'review' ? '5|rth' : `${params.get('interval')}|${params.get('session')}`}|study`;
  drawingAction(d => d?.setContext({ key: drawingKey, mode }));
  const url = mode === 'review' ? `/api/review?${new URLSearchParams({ date: $('review-date').value, adjustment })}` : `/api/bars?${params}`;
  $('status').textContent = '正在加载并预热指标…';
  $('load').disabled = true;
  $('progress').textContent = '正在准备回放…';
  render([]);
  try {
    const response = await fetch(url, { signal: request.signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '读取失败');
    if (request.signal.aborted) return;
    const bars = mode === 'review' ? payload.bars : payload;
    if (mode === 'review') review = payload;
    if (mode === 'replay') replay = new Replay(bars, startTime, Number(params.get('interval')) * 60);
    render(replay ? replay.visible() : bars);
    if (mode === 'review') centerOpen();
    else if (visible.length) chart.timeScale().fitContent();
    if (!bars.length) $('status').textContent = '所选日期没有数据，请选择其他日期。';
    else if (mode === 'review') $('status').textContent = `${payload.targetDate} 早盘 ${payload.targetCount} 根 · 前两交易日 ${payload.previousSessions.join('、') || '无'}。${(payload.warnings || []).join(' ')}`;
    else if (mode === 'replay') $('status').textContent = replay.total
      ? `从 ${start} ${replayTime} 所在的 K 线起逐根回放；之前的 ${replay.start} 根为已知背景。`
      : '起始时刻之后没有 K 线，请调整日期、时刻或时段。';
    else $('status').textContent = `已加载 ${bars.length.toLocaleString()} 根 K 线。滚轮缩放，拖动平移；下方面板为 ADR / ABR（点）。`;
  } catch (error) {
    if (error.name !== 'AbortError') $('status').textContent = `加载失败：${error.message}`;
  } finally {
    if (controller === request) {
      loading = false;
      $('load').disabled = false;
      syncControls();
    }
  }
}
$('settings').addEventListener('submit', event => { event.preventDefault(); load(); });
$('settings').addEventListener('change', () => {
  pause();
  controller?.abort();
  loading = false;
  dirty = true;
  $('load').disabled = false;
  drawingAction(d => d?.setTool(null));
  configureMode();
  $('status').textContent = '设置已更改，加载后生效。';
  syncControls();
});
$('fit').addEventListener('click', () => chart.timeScale().fitContent());
$('center').addEventListener('click', centerOpen);
$('play').addEventListener('click', play);
$('step').addEventListener('click', step);
$('reset').addEventListener('click', () => {
  pause();
  if (!replay || dirty) return;
  replay.reset();
  render(replay.visible());
  if (visible.length) chart.timeScale().fitContent();
});
$('speed').addEventListener('change', () => { if (timer) { pause(); play(); } });
$('show-count').addEventListener('change', updateMarkers);
$('show-gap').addEventListener('change', updateMarkers);
for (const [id, series] of [['show-ema', ema], ['show-adr', adr], ['show-abr', abr]]) {
  $(id).addEventListener('change', () => series.applyOptions({ visible: $(id).checked }));
}
document.addEventListener('keydown', event => {
  if (event.target.closest('input,select,textarea,button,[contenteditable]') || $('mode').value !== 'replay') return;
  if (event.code === 'Space') { event.preventDefault(); play(); }
  if (event.code === 'ArrowRight') { event.preventDefault(); pause(); step(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
configureMode();
(async () => {
  try {
    const response = await fetch('/api/meta');
    if (!response.ok) throw new Error('无法读取数据范围');
    const meta = await response.json();
    rollRevision = meta.rollAdjustment?.revision ?? 'v1';
    const events = meta.rollAdjustment?.events ?? [];
    rollEventCount = events.filter(event => event.enabled).length;
    $('roll-events').textContent = events.length ? events.map(event => `${event.time}  ${event.enabled ? '启用' : '停用'}  ${signed(event.delta)} 点  ${event.source ?? 'estimated'}`).join('\n') : '当前规则未识别候选换月点。';
    for (const id of ['start', 'end', 'review-date']) { $(id).min = meta.first; $(id).max = meta.last; }
    $('end').value = meta.last;
    $('review-date').value = meta.rthSessions?.at(-1) ?? meta.last;
    const date = new Date(`${meta.last}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 6);
    $('start').value = date.toISOString().slice(0, 10) < meta.first ? meta.first : date.toISOString().slice(0, 10);
    await load();
  } catch (error) { $('status').textContent = `初始化失败：${error.message}`; }
})();
