import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Replay, countMarkers, openingRange, replayStartTime, gapMarkers } from './replay.js';

const bars = Array.from({ length: 12 }, (_, i) => ({ time: i + 1, barCount: i + 1, ema20: 10 + i, adr8: 20, abr8: i }));

test('replay excludes future candles and indicators, including on reset', () => {
  const replay = new Replay(bars, 4);
  assert.deepEqual(replay.visible(), bars.slice(0, 3));
  assert.equal(replay.played, 0);
  assert.equal(replay.total, 9);
  assert.deepEqual(replay.advance(), bars.slice(0, 4));
  assert.equal(replay.played, 1);
  assert.ok(replay.visible().every(bar => bar.time <= 4));
  assert.deepEqual(countMarkers(replay.visible()).map(marker => marker.time), [3]);
  replay.reset();
  assert.deepEqual(replay.visible(), bars.slice(0, 3));
});

test('playback starts empty, reaches end, and never overflows', () => {
  const replay = new Replay(bars, 1);
  assert.deepEqual(replay.visible(), []);
  for (let i = 0; i < 20; i++) replay.advance();
  assert.equal(replay.complete, true);
  assert.equal(replay.played, 12);
  assert.deepEqual(replay.visible(), bars);
});

test('non-trading start times select the next candle; no later candles ends replay', () => {
  assert.equal(new Replay(bars, 3.5).advance().at(-1).time, 4);
  const replay = new Replay(bars, 100);
  assert.equal(replay.complete, true);
  assert.equal(replay.total, 0);
  assert.deepEqual(replay.visible(), bars);
  assert.equal(new Replay([], 1).complete, true);
});

test('starting within a five-minute candle does not reveal its later OHLC as background', () => {
  const data = [{ time: 0, close: 100 }, { time: 300, close: 1000 }, { time: 600, close: 50 }];
  const inside = new Replay(data, 420, 300);
  assert.deepEqual(inside.visible(), [data[0]]);
  assert.deepEqual(inside.advance(), data.slice(0, 2));
  const aligned = new Replay(data, 600, 300);
  assert.deepEqual(aligned.visible(), data.slice(0, 2));
});

test('time controls accept seconds and invalid timestamps fail closed', () => {
  assert.equal(replayStartTime('2026-07-31', '09:30'), replayStartTime('2026-07-31', '09:30:00'));
  assert.throws(() => new Replay(bars, NaN), /有效/);
  assert.throws(() => new Replay(bars, Infinity), /有效/);
  assert.throws(() => new Replay(bars, 3, NaN), /有效/);
});

test('count markers reset each session, skip ETH, and preserve missing slots', () => {
  const data = [{ time: 1, barCount: null }, { time: 2, barCount: 1 }, { time: 3, barCount: 3 }, { time: 4, barCount: 6 }, { time: 5, barCount: 1 }, { time: 6, barCount: 3 }];
  assert.deepEqual(countMarkers(data).map(({ time, text }) => [time, text]), [[3, '3'], [4, '6'], [6, '3']]);
});

test('opening view keeps historical records but fits 24 target bars in the right half', () => {
  const focus = 156;
  const range = openingRange(focus);
  assert.equal((range.from + range.to) / 2, focus);
  assert.ok(range.from > 0);
  assert.equal(range.to - focus, 24.5);
  assert.equal(focus - range.from, 24.5);
});

test('gap markers appear only on revealed session opens and preserve direction', () => {
  const data = [{ time: 1, barCount: 1, rthGap: 3 }, { time: 2, barCount: 2, rthGap: 3 }, { time: 3, barCount: 1, rthGap: -2 }, { time: 4, barCount: 1, rthGap: null }];
  assert.deepEqual(gapMarkers(data.slice(0, 2)).map(m => m.text), ['Gap +3.00']);
  assert.deepEqual(gapMarkers(data).map(m => m.text), ['Gap +3.00', 'Gap -2.00']);
});
