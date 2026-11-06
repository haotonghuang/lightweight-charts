#!/usr/bin/env python3
"""Local, read-only ES CSV viewer server."""
import argparse
import csv
import datetime as dt
import json
import sqlite3
import threading
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from encyclopedia_store import EncyclopediaStore
from roll_adjustment import RollAdjuster, detect_roll, load_overrides

ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / 'data' / 'ES_1min.csv'
DEFAULT_ROLL_OVERRIDES = ROOT / 'roll_overrides.json'
DEFAULT_ENCYCLOPEDIA_DB = ROOT / 'data' / 'encyclopedia.sqlite3'
MAX_ENCYCLOPEDIA_REQUEST = 64_001_000
RTH_OPEN = 9 * 60 + 30
RTH_CLOSE = 16 * 60 + 15
EMA_PERIOD = 20
EMA_ALPHA = 2 / (EMA_PERIOD + 1)
EMA_WARMUP_SESSIONS = 80
MAX_CACHED_BARS = 200_000
MAX_CACHED_DAYS = 1024


@dataclass
class DataIndex:
    day_offsets: dict
    rth_daily: dict
    rth_sessions: list
    roll_adjuster: object = None
    adjusted_daily: dict = None
    source_signature: tuple = None
    bar_cache: OrderedDict = field(default_factory=OrderedDict, repr=False)
    bar_cache_rows: int = 0
    bar_cache_lock: object = field(default_factory=threading.Lock, repr=False)

    @property
    def first(self):
        return next(iter(self.day_offsets))

    @property
    def last(self):
        return next(reversed(self.day_offsets))


def _date_and_minutes(stamp):
    day = stamp[:10].decode('ascii')
    hour = int(stamp[11:13])
    minute = int(stamp[14:16])
    return day, hour * 60 + minute


def build_index(path, roll_overrides=None):
    """Index day offsets and collect weekday RTH ranges and session endpoints."""
    signature = _source_signature(path)
    day_offsets = {}
    rth_daily = {}
    roll_events = []
    override_times = set((roll_overrides or {}).get('events', {}))
    missing_overrides = set(override_times)
    previous_stamp = None
    previous_close = None
    with path.open('rb') as f:
        header = f.readline().decode('utf-8-sig').strip().split(',')
        if header != ['', 'DateTime', 'Open', 'High', 'Low', 'Close', 'Volume']:
            raise ValueError('CSV 列格式不符合预期')
        while True:
            offset = f.tell()
            line = f.readline()
            if not line:
                break
            fields = line.rstrip(b'\r\n').split(b',')
            if len(fields) != 7:
                raise ValueError('CSV 数据行格式不符合预期')
            stamp = fields[1]
            stamp_text = stamp.decode('ascii')
            missing_overrides.discard(stamp_text)
            if previous_stamp is not None:
                event = detect_roll(previous_stamp, previous_close, stamp_text, float(fields[2]))
                if event is not None:
                    roll_events.append(event)
            previous_stamp, previous_close = stamp_text, float(fields[5])
            day, minutes = _date_and_minutes(stamp)
            if day not in day_offsets:
                day_offsets[day] = offset
            date = dt.date.fromisoformat(day)
            if date.weekday() >= 5 or not RTH_OPEN <= minutes < RTH_CLOSE:
                continue
            high, low = float(fields[3]), float(fields[4])
            daily = rth_daily.get(day)
            if daily is None:
                daily = {'high': high, 'low': low, 'open': None, 'close': None,
                         'openTime': None, 'closeTime': None}
                rth_daily[day] = daily
            else:
                daily['high'] = max(daily['high'], high)
                daily['low'] = min(daily['low'], low)
            if minutes == RTH_OPEN and stamp[17:19] == b'00' and daily['open'] is None:
                daily['open'] = float(fields[2])
                daily['openTime'] = f'{day} 09:30'
            daily['close'] = float(fields[5])
            daily['closeTime'] = stamp.decode('ascii')[:16]
    if not day_offsets:
        raise ValueError('CSV 没有数据')
    if missing_overrides:
        raise ValueError('换月修正时刻不在 CSV 中：' + ', '.join(sorted(missing_overrides)))
    sessions = sorted(rth_daily)
    index = DataIndex(day_offsets, rth_daily, sessions, RollAdjuster(roll_events, roll_overrides))
    index.adjusted_daily = _adjusted_daily(path, index)
    if _source_signature(path) != signature:
        raise ValueError('CSV 在索引期间发生变化，请重启服务重新索引')
    index.source_signature = signature
    return index


def _source_signature(path):
    path = Path(path)
    stat = path.stat()
    return str(path.resolve()), stat.st_size, stat.st_mtime_ns


def _read_rows(path, index, start, end, session='all', days=None):
    """Yield OHLCV rows over an inclusive date range, preserving CSV order."""
    days = [day for day in index.day_offsets if start <= day <= end and (days is None or day in days)]
    if not days:
        return
    with path.open('r', encoding='utf-8', newline='') as f:
        f.seek(index.day_offsets[days[0]])
        for row in csv.reader(f):
            stamp = row[1]
            day = stamp[:10]
            if day > end:
                break
            # Skip ETH before allocating datetimes and OHLCV mappings. Most
            # requests need only the RTH part of the 80-session warmup window.
            if session == 'rth' and (day not in index.rth_daily or not '09:30:00' <= stamp[11:] < '16:15:00'):
                continue
            date = dt.datetime.fromisoformat(stamp)
            yield day, date, dict(
                time=int(date.replace(tzinfo=dt.timezone.utc).timestamp()),
                open=float(row[2]), high=float(row[3]), low=float(row[4]),
                close=float(row[5]), volume=float(row[6]),
            )


def _adjusted_daily(path, index):
    result = {}
    for day, daily in index.rth_daily.items():
        start, end = f'{day} 09:30:00', f'{day} 16:15:00'
        # Normal inferred rolls occur at midnight, so one offset covers RTH.
        # Explicit intraday overrides require rebuilding that day's extremes.
        intraday = any(event['enabled'] and start < event['time'] < end for event in index.roll_adjuster.events)
        if not intraday:
            offset = index.roll_adjuster.offset_at(start)
            result[day] = {**daily, **{key: None if daily[key] is None else daily[key] + offset for key in ('open', 'high', 'low', 'close')}}
            continue
        rebuilt = {**daily, 'high': float('-inf'), 'low': float('inf')}
        for _, date, row in _read_rows(path, index, day, day):
            if not _is_rth(day, date):
                continue
            adjusted = index.roll_adjuster.adjust_bar(date.strftime('%Y-%m-%d %H:%M:%S'), row)
            rebuilt['high'] = max(rebuilt['high'], adjusted['high'])
            rebuilt['low'] = min(rebuilt['low'], adjusted['low'])
            if date.hour * 60 + date.minute == RTH_OPEN and date.second == 0:
                rebuilt['open'] = adjusted['open']
            rebuilt['close'] = adjusted['close']
        result[day] = rebuilt
    return result


def _is_rth(day, date):
    return date.weekday() < 5 and RTH_OPEN <= date.hour * 60 + date.minute < RTH_CLOSE


def _bucket_time(date, minutes, session):
    if session == 'rth':
        start_minutes = RTH_OPEN + ((date.hour * 60 + date.minute - RTH_OPEN) // minutes) * minutes
        bucket = date.replace(hour=start_minutes // 60, minute=start_minutes % 60, second=0)
    elif minutes < 60:
        bucket = date.replace(minute=date.minute // minutes * minutes, second=0)
    else:
        bucket = date.replace(minute=0, second=0)
    return int(bucket.replace(tzinfo=dt.timezone.utc).timestamp())


def _ema(values):
    result = []
    current = None
    for value in values:
        current = value if current is None else EMA_ALPHA * value + (1 - EMA_ALPHA) * current
        result.append(current)
    return result


def _adr_by_day(index, daily_ranges=None):
    """Map each RTH session to the average range of its prior eight sessions."""
    previous_ranges = deque(maxlen=8)
    result = {}
    for day in index.rth_sessions:
        result[day] = (
            sum(previous_ranges) / len(previous_ranges) if len(previous_ranges) == 8 else None,
            len(previous_ranges),
        )
        daily = (index.rth_daily if daily_ranges is None else daily_ranges)[day]
        previous_ranges.append(daily['high'] - daily['low'])
    return result


def _rth_gaps_by_day(index, daily_ranges=None):
    """Use the exact 09:30 open and the previous available RTH close only."""
    result = {}
    previous_close = None
    previous_close_time = None
    for day in index.rth_sessions:
        daily = (index.rth_daily if daily_ranges is None else daily_ranges)[day]
        opening = daily['open']
        if opening is None or previous_close in (None, 0):
            result[day] = {'gap': None, 'percent': None, 'previousCloseTime': previous_close_time}
        else:
            gap = opening - previous_close
            result[day] = {
                'gap': gap,
                'percent': gap / previous_close * 100,
                'previousCloseTime': previous_close_time,
            }
        previous_close = daily['close']
        previous_close_time = daily['closeTime']
    return result


def _enrich(bars, adr, gaps):
    ema_values = _ema([bar['close'] for bar in bars])
    ranges = deque(maxlen=8)
    for bar, ema_value in zip(bars, ema_values):
        ranges.append(bar['high'] - bar['low'])
        bar['ema20'] = ema_value
        bar['abr8'] = sum(ranges) / 8 if len(ranges) == 8 else None
        bar['adr8'], bar['adr8Count'] = adr.get(bar['_day'], (None, 0))
        gap = gaps.get(bar['_day'], {})
        bar['rthGap'] = gap.get('gap') if bar.get('_hasRthGap') else None
        bar['rthGapPercent'] = gap.get('percent') if bar.get('_hasRthGap') else None
        bar['previousRthCloseTime'] = gap.get('previousCloseTime') if bar.get('_hasRthGap') else None
        bar['barCount'] = bar.get('_barCount')
        del bar['_day']
        bar.pop('_barCount', None)
        bar.pop('_hasRthGap', None)
    return bars


def _daily_bars(path, index, day, minutes, session, adjustment):
    key = (day, minutes, session, adjustment, index.roll_adjuster.revision)
    with index.bar_cache_lock:
        cached = index.bar_cache.get(key)
        if cached is not None:
            index.bar_cache.move_to_end(key)
            return cached
    bars = []
    for day, date, row in _read_rows(path, index, day, day, session=session):
        if adjustment == 'back':
            row = index.roll_adjuster.adjust_bar(date.isoformat(sep=' ', timespec='seconds'), row)
        bucket = _bucket_time(date, minutes, session)
        if bars and bars[-1]['time'] == bucket:
            bar = bars[-1]
            bar['high'] = max(bar['high'], row['high'])
            bar['low'] = min(bar['low'], row['low'])
            bar['close'] = row['close']
            bar['volume'] += row['volume']
        else:
            bar = dict(row, time=bucket, _day=day)
            bars.append(bar)
        if _is_rth(day, date) and (session == 'rth' or minutes in (1, 5, 15)):
            bar['_hasRthGap'] = True
            offset = date.hour * 60 + date.minute - RTH_OPEN
            bar['_barCount'] = offset // minutes + 1
    cached = tuple(bars)
    with index.bar_cache_lock:
        previous = index.bar_cache.pop(key, ())
        index.bar_cache_rows -= len(previous)
        index.bar_cache[key] = cached
        index.bar_cache_rows += len(cached)
        while index.bar_cache and (index.bar_cache_rows > MAX_CACHED_BARS or len(index.bar_cache) > MAX_CACHED_DAYS):
            _, removed = index.bar_cache.popitem(last=False)
            index.bar_cache_rows -= len(removed)
    return cached


def read_bars(path, index, start, end, minutes, session='all', adjustment='back'):
    """Return interval bars with indicators warmed before the requested range."""
    start_date, end_date = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    if start > end or (end_date - start_date).days > 30 or minutes not in (1, 5, 15, 60):
        raise ValueError('请选择不超过 31 个自然日的日期范围及有效周期')
    if adjustment not in ('back', 'raw'):
        raise ValueError('adjustment 必须为 back 或 raw')
    if session not in ('all', 'rth'):
        raise ValueError('session 必须为 all 或 rth')
    try:
        signature = _source_signature(path)
    except OSError as exc:
        raise ValueError('CSV 无法读取，请检查文件并重启服务') from exc
    if index.source_signature is not None and signature != index.source_signature:
        raise ValueError('CSV 已变化，请重启服务重新索引')

    if session == 'rth':
        warmup_days = index.rth_sessions
    else:
        warmup_days = index.day_offsets
    prior_days = [day for day in warmup_days if day < start][-EMA_WARMUP_SESSIONS:]
    scan_start = prior_days[0] if prior_days else start
    bars = []
    days = index.rth_sessions if session == 'rth' else index.day_offsets
    for day in days:
        if scan_start <= day <= end:
            # Enrichment is request-specific and mutates its input. Never let
            # indicators or caller edits leak back into the shared day cache.
            bars.extend(dict(bar) for bar in _daily_bars(path, index, day, minutes, session, adjustment))

    daily = index.adjusted_daily if adjustment == 'back' else index.rth_daily
    adr = _adr_by_day(index, daily)
    bars = _enrich(bars, adr, _rth_gaps_by_day(index, daily))
    result = [bar for bar in bars if start <= dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).date().isoformat() <= end]
    try:
        if _source_signature(path) != signature:
            raise ValueError('CSV 已变化，请重启服务重新索引')
    except OSError as exc:
        raise ValueError('CSV 无法读取，请检查文件并重启服务') from exc
    return result


def read_review(path, index, target_date, adjustment='back'):
    """Return the target morning plus two previous complete RTH sessions."""
    dt.date.fromisoformat(target_date)
    if target_date not in index.rth_daily:
        raise ValueError('所选日期没有 RTH 数据')
    target_position = index.rth_sessions.index(target_date)
    previous = index.rth_sessions[max(0, target_position - 2):target_position]
    first_day = previous[0] if previous else target_date
    bars = read_bars(path, index, first_day, target_date, 5, 'rth', adjustment)
    visible_bars = []
    target_bars = []
    for bar in bars:
        bar_date = dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc)
        if bar_date.date().isoformat() != target_date:
            visible_bars.append(bar)
        elif bar_date.hour * 60 + bar_date.minute < 11 * 60 + 30:
            target_bars.append(bar)
            visible_bars.append(bar)
    if not target_bars:
        raise ValueError('所选日期没有 RTH 开盘时段数据')
    bars = visible_bars
    warnings = []
    if len(previous) < 2:
        warnings.append('数据中不足两个此前的 RTH 交易日。')
    if len(target_bars) < 24:
        warnings.append(f'所选日期开盘后仅有 {len(target_bars)} 根 5 分钟 K 线，少于 24 根。')
    return {
        'bars': bars,
        'focusTime': target_bars[0]['time'],
        'previousSessions': previous,
        'targetDate': target_date,
        'targetCount': len(target_bars),
        'warnings': warnings,
    }


def make_handler(path, index, encyclopedia_db=None):
    store_path = encyclopedia_db or DEFAULT_ENCYCLOPEDIA_DB
    store = None
    store_lock = threading.Lock()

    def get_store():
        nonlocal store
        if store is None:
            with store_lock:
                if store is None:
                    store = EncyclopediaStore(store_path)
        return store

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT), **kwargs)

        def send_error(self, code, message=None, explain=None):
            if code == 404:
                body = json.dumps({'error': '未找到资源'}, ensure_ascii=False).encode()
                self.send_response(404)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            super().send_error(code, message, explain)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == '/api/encyclopedia':
                try:
                    return self._send_json(get_store().snapshot())
                except sqlite3.Error:
                    return self._send_json({'error': '百科存储暂时不可用'}, 500)
            if url.path in ('/api/meta', '/api/bars', '/api/review'):
                try:
                    if url.path == '/api/meta':
                        payload = {
                            'first': index.first,
                            'last': index.last,
                            'rthSessions': index.rth_sessions,
                            'dataFile': path.name,
                            'rth': {'open': '09:30', 'close': '16:15', 'fiveMinuteSlots': 81},
                            'rollAdjustment': index.roll_adjuster.metadata,
                        }
                    else:
                        q = parse_qs(url.query)
                        if url.path == '/api/review':
                            payload = read_review(path, index, q['date'][0], q.get('adjustment', ['back'])[0])
                        else:
                            start, end = q['start'][0], q['end'][0]
                            minutes = int(q['interval'][0])
                            session = q.get('session', ['all'])[0]
                            payload = read_bars(path, index, start, end, minutes, session, q.get('adjustment', ['back'])[0])
                    body = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode()
                    self.send_response(200)
                except (KeyError, ValueError, IndexError) as exc:
                    body = json.dumps({'error': str(exc)}, ensure_ascii=False).encode()
                    self.send_response(400)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            # Expose only the page assets. In particular, the copied CSV is
            # never downloadable through SimpleHTTPRequestHandler.
            assets = {'/', '/index.html', '/app.js', '/replay.js', '/drawings.js', '/encyclopedia.js', '/encyclopedia.css', '/vendor/drawing/lightweight-charts-drawing-0.6.3.mjs', '/vendor/drawing/LICENSE', '/vendor/dist/lightweight-charts.standalone.production.js', '/vendor/LICENSE'}
            if url.path not in assets:
                return self.send_error(404)
            return super().do_GET()

        def _send_json(self, payload, status=200):
            body = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def _local_same_origin(self):
            host = self.headers.get('Host', '')
            try:
                if urlparse(f'//{host}').hostname not in ('127.0.0.1', 'localhost', '::1'):
                    return False
            except ValueError:
                return False
            origin = self.headers.get('Origin')
            if origin is None:
                return True
            parsed = urlparse(origin)
            if parsed.scheme != 'http' or parsed.path not in ('', '/') or parsed.params or parsed.query or parsed.fragment:
                return False
            try:
                return parsed.hostname in ('127.0.0.1', 'localhost', '::1') and parsed.netloc.lower() == host.lower()
            except ValueError:
                return False

        def do_POST(self):
            if urlparse(self.path).path != '/api/encyclopedia':
                return self.send_error(404)
            if not self._local_same_origin():
                return self._send_json({'error': '仅允许同源本地请求'}, 403)
            if self.headers.get_content_type() != 'application/json':
                return self._send_json({'error': '请求必须使用 application/json'}, 415)
            try:
                length = int(self.headers.get('Content-Length', ''))
                if length < 0 or length > MAX_ENCYCLOPEDIA_REQUEST:
                    raise ValueError
            except ValueError:
                self.close_connection = True
                return self._send_json({'error': '请求长度无效或百科备份超过 64 MB'}, 413)
            try:
                payload = json.loads(self.rfile.read(length))
                result = get_store().mutate(payload)
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self._send_json({'error': 'JSON 格式无效'}, 400)
            except (ValueError, TypeError) as exc:
                return self._send_json({'error': str(exc)}, 400)
            except sqlite3.IntegrityError:
                return self._send_json({'error': '名称已存在或关联数据冲突'}, 409)
            except sqlite3.Error:
                return self._send_json({'error': '百科存储暂时不可用'}, 500)
            return self._send_json(result)
    return Handler


def main():
    parser = argparse.ArgumentParser(description='本地 ES 图表（只监听本机）')
    parser.add_argument('--csv', type=Path, default=DEFAULT_CSV, help='ES CSV 路径')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--roll-overrides', type=Path, default=DEFAULT_ROLL_OVERRIDES, help='换月候选修正 JSON 路径')
    parser.add_argument('--encyclopedia-db', type=Path, default=DEFAULT_ENCYCLOPEDIA_DB, help='百科 SQLite 数据库路径')
    args = parser.parse_args()
    path = args.csv.expanduser().resolve()
    print(f'正在索引 {path.name}，请稍候…', flush=True)
    overrides = load_overrides(args.roll_overrides.expanduser())
    index = build_index(path, overrides)
    print(f'估算换月调整：{sum(event["enabled"] for event in index.roll_adjuster.events)} 处；RTH 09:30–16:15（81 根 5m）。', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(path, index, args.encyclopedia_db.expanduser()))
    print(f'数据范围 {index.first} 至 {index.last}。打开 http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
