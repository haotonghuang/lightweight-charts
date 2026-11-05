// Every chart consumer, including hover and markers, uses the revealed slice.
export class Replay {
  constructor(bars, startTime, barSeconds = 0) {
    if (!Number.isFinite(startTime) || !Number.isFinite(barSeconds) || barSeconds < 0) {
      throw new Error('请选择有效的回放日期、时刻和周期');
    }
    this.bars = bars;
    // A start inside a candle must not reveal that candle's later OHLC as
    // background. Replay the containing candle on the first step instead.
    const start = bars.findIndex(bar => barSeconds ? bar.time + barSeconds > startTime : bar.time >= startTime);
    this.start = start < 0 ? bars.length : start;
    this.reset();
  }

  reset() { this.end = this.start; }
  advance() {
    this.end = Math.min(this.end + 1, this.bars.length);
    return this.visible();
  }
  visible() { return this.bars.slice(0, this.end); }
  get played() { return this.end - this.start; }
  get total() { return this.bars.length - this.start; }
  get complete() { return this.end === this.bars.length; }
}

export function replayStartTime(day, time) {
  const clock = time.length === 5 ? `${time}:00` : time;
  return Date.parse(`${day}T${clock}Z`) / 1000;
}

export function countMarkers(bars) {
  return bars.filter(bar => bar.barCount > 0 && bar.barCount % 3 === 0).map(bar => ({
    time: bar.time, position: 'belowBar', shape: 'circle', size: 0,
    color: '#a9b8ca', text: String(bar.barCount),
  }));
}

export function openingRange(focusIndex) {
  const half = 24.5;
  return { from: focusIndex - half, to: focusIndex + half };
}

export function gapMarkers(bars) {
  return bars.filter(bar => bar.barCount === 1 && Number.isFinite(bar.rthGap)).map(bar => ({
    time: bar.time, position: 'aboveBar', shape: bar.rthGap >= 0 ? 'arrowUp' : 'arrowDown',
    size: 0.7, color: bar.rthGap >= 0 ? '#51c4ab' : '#ff9292',
    text: `Gap ${bar.rthGap >= 0 ? '+' : ''}${bar.rthGap.toFixed(2)}`,
  }));
}
