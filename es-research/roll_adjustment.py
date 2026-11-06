#!/usr/bin/env python3
"""Conservative, auditable backward adjustment for continuous ES minute data.

The source CSV has no contract identifiers. Detected events are therefore
estimates based on a narrow quarterly-midnight-gap heuristic, not confirmed
contract rolls. Adjustments are additive and leave the newest segment intact.
"""
from __future__ import annotations

import argparse
from bisect import bisect_right
import csv
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent
DEFAULT_OVERRIDES = ROOT / 'roll_overrides.json'
ALGORITHM = 'quarterly-midnight-gap-v1'
CSV_HEADER = ['', 'DateTime', 'Open', 'High', 'Low', 'Close', 'Volume']
_DATETIME_FORMAT = '%Y-%m-%d %H:%M:%S'
_OHLC = ('open', 'high', 'low', 'close')


def _parse_stamp(stamp: str) -> dt.datetime:
    if not isinstance(stamp, str):
        raise ValueError('时间戳必须是字符串')
    if (len(stamp) != 19 or stamp[:4] < '1000' or stamp[4] != '-' or stamp[7] != '-'
            or stamp[10] != ' ' or stamp[13] != ':' or stamp[16] != ':'
            or any(char not in '0123456789' for char in stamp[:4] + stamp[5:7]
                   + stamp[8:10] + stamp[11:13] + stamp[14:16] + stamp[17:19])):
        raise ValueError(f'无效时间戳: {stamp!r}; 预期格式 YYYY-MM-DD HH:MM:SS')
    try:
        return dt.datetime.fromisoformat(stamp)
    except ValueError as exc:
        raise ValueError(f'无效时间戳: {stamp!r}; 预期格式 YYYY-MM-DD HH:MM:SS') from exc


def _finite_number(value, field: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f'{field} 必须是有限数值') from exc
    if not math.isfinite(result):
        raise ValueError(f'{field} 必须是有限数值')
    return result


def _looks_like_candidate_stamp(stamp: str) -> bool:
    """Cheap lexical screen so full datetime parsing is limited to candidates."""
    if not isinstance(stamp, str) or len(stamp) != 19:
        return False
    if stamp[4] != '-' or stamp[7] != '-' or stamp[10] != ' ' or stamp[13] != ':' or stamp[16] != ':':
        return False
    if not (stamp[0:4] + stamp[5:7] + stamp[8:10] + stamp[11:13] + stamp[14:16] + stamp[17:19]).isdigit():
        return False
    month, day = int(stamp[5:7]), int(stamp[8:10])
    hour, minute, second = int(stamp[11:13]), int(stamp[14:16]), int(stamp[17:19])
    return month in (3, 6, 9, 12) and 10 <= day <= 18 and hour == 0 and minute <= 2 and second == 0


def detect_roll(previous_stamp: str, previous_close: float, stamp: str, opening: float):
    """Return a suspected roll event at ``stamp`` or ``None``.

    The event's ``gap`` is new open minus previous close. It deliberately uses
    the adjacent bars because this CSV lacks overlapping contract prices; a
    candidate can include genuine overnight movement and should be reviewed.
    """
    if not _looks_like_candidate_stamp(stamp):
        return None
    # Date-boundary prefilter before parsing both values.
    if not isinstance(previous_stamp, str) or len(previous_stamp) != 19 or previous_stamp[:10] == stamp[:10]:
        return None
    current = _parse_stamp(stamp)
    previous = _parse_stamp(previous_stamp)
    elapsed = (current - previous).total_seconds()
    if not 0 < elapsed <= 300:
        return None
    prior = _finite_number(previous_close, 'previous_close')
    opened = _finite_number(opening, 'opening')
    threshold = max(2.0, abs(prior) * 0.002)
    gap = opened - prior
    if abs(gap) < threshold:
        return None
    return {
        'time': stamp,
        'gap': gap,
        'newOpen': opened,
        'previousClose': prior,
        'threshold': threshold,
        'method': ALGORITHM,
        'estimated': True,
    }


def validate_overrides(overrides) -> dict:
    """Validate and copy the explicit version-1 override document."""
    if not isinstance(overrides, dict) or set(overrides) != {'version', 'events'}:
        raise ValueError('overrides 必须恰好包含 version 和 events')
    if overrides['version'] != 1 or isinstance(overrides['version'], bool):
        raise ValueError('overrides.version 必须为 1')
    if not isinstance(overrides['events'], dict):
        raise ValueError('overrides.events 必须是对象')
    result = {'version': 1, 'events': {}}
    for stamp, entry in overrides['events'].items():
        _parse_stamp(stamp)
        if not isinstance(entry, dict) or not set(entry).issubset({'enabled', 'delta', 'note'}):
            raise ValueError(f'无效的 overrides.events[{stamp!r}]')
        if 'enabled' not in entry or not isinstance(entry['enabled'], bool):
            raise ValueError(f'overrides.events[{stamp!r}].enabled 必须为布尔值')
        clean = {'enabled': entry['enabled']}
        if 'delta' in entry:
            clean['delta'] = _finite_number(entry['delta'], f'overrides.events[{stamp!r}].delta')
        if 'note' in entry:
            if not isinstance(entry['note'], str):
                raise ValueError(f'overrides.events[{stamp!r}].note 必须为字符串')
            clean['note'] = entry['note']
        result['events'][stamp] = clean
    return result


def load_overrides(path) -> dict:
    """Load a strict JSON override document; malformed files raise explicitly."""
    try:
        with Path(path).open('r', encoding='utf-8') as handle:
            return validate_overrides(json.load(handle))
    except json.JSONDecodeError as exc:
        raise ValueError(f'无法解析 overrides JSON: {exc}') from exc


class RollAdjuster:
    """Apply additive backward adjustments while preserving the raw input.

    ``events`` is a sequence returned by :func:`detect_roll` (or equivalent
    observed event dictionaries). ``overrides`` is a validated dict or the
    version-1 JSON object. An override at an unobserved timestamp is treated as
    a user-declared manual boundary and must provide ``delta`` and ``note``.
    """

    def __init__(self, events: Iterable[dict], overrides=None):
        if overrides is None:
            clean_overrides = {'version': 1, 'events': {}}
        else:
            clean_overrides = validate_overrides(overrides)

        by_time = {}
        for event in events:
            if not isinstance(event, dict):
                raise ValueError('事件必须是对象')
            stamp = event.get('time')
            _parse_stamp(stamp)
            if stamp in by_time:
                raise ValueError(f'重复的换月事件时间: {stamp}')
            gap = _finite_number(event.get('gap'), f'{stamp}.gap')
            item = dict(event)
            item.update(time=stamp, gap=gap, delta=gap, enabled=True,
                        source='auto', estimated=bool(event.get('estimated', True)))
            by_time[stamp] = item

        for stamp, override in clean_overrides['events'].items():
            observed = by_time.get(stamp)
            if observed is None:
                if 'delta' not in override or not override.get('note', '').strip():
                    raise ValueError(f'手动边界 {stamp} 必须提供有限 delta 和非空 note')
                observed = {
                    'time': stamp, 'gap': override['delta'], 'delta': override['delta'],
                    'newOpen': None, 'previousClose': None, 'threshold': None,
                    'method': 'manual', 'estimated': False, 'source': 'manual',
                    'enabled': True,
                }
                by_time[stamp] = observed
            observed['enabled'] = override['enabled']
            if 'delta' in override:
                observed['delta'] = override['delta']
            if 'note' in override:
                observed['note'] = override['note']
            if observed['source'] != 'manual':
                observed['source'] = 'override' if ('delta' in override or not override['enabled']) else 'auto'

        self._events = tuple(by_time[stamp] for stamp in sorted(by_time))
        self._times = tuple(event['time'] for event in self._events)
        # The normal detector emits a few dozen sparse events. Cache exact
        # ascending-order sums for those common cases; large manual event sets
        # retain bounded construction cost and use the bisected suffix below.
        self._offset_suffix = None
        if len(self._events) <= 512:
            self._offset_suffix = tuple(
                sum(event['delta'] for event in self._events[start:] if event['enabled'])
                for start in range(len(self._events) + 1)
            )
        self.total_offset = sum(event['delta'] for event in self._events if event['enabled'])
        revision_payload = {
            'algorithm': ALGORITHM,
            'events': self._events,
        }
        canonical = json.dumps(revision_payload, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
        self.revision = hashlib.sha256(canonical.encode('utf-8')).hexdigest()

    @property
    def events(self):
        """Return independent audit records so callers cannot mutate state."""
        return [dict(event) for event in self._events]

    @property
    def metadata(self):
        return {
            'algorithm': ALGORITHM,
            'basis': 'additive-backward',
            'estimated': sum(bool(event['estimated']) for event in self._events if event['enabled']),
            'eventCount': sum(bool(event['enabled']) for event in self._events),
            'totalOffset': self.total_offset,
            'revision': self.revision,
            'events': self.events,
        }

    def offset_at(self, stamp: str) -> float:
        """Return the sum of enabled event deltas strictly after ``stamp``."""
        _parse_stamp(stamp)
        start = bisect_right(self._times, stamp)
        if self._offset_suffix is not None:
            return self._offset_suffix[start]
        return sum(event['delta'] for event in self._events[start:] if event['enabled'])

    def adjust_bar(self, stamp: str, bar: dict) -> dict:
        """Return an adjusted copy of an OHLCV mapping; input is not modified."""
        offset = self.offset_at(stamp)
        if not isinstance(bar, dict):
            raise ValueError('bar 必须是对象')
        adjusted = dict(bar)
        for field in _OHLC:
            adjusted[field] = _finite_number(bar.get(field), f'bar.{field}') + offset
        if 'volume' in bar:
            adjusted['volume'] = bar['volume']
        return adjusted


def _scan_csv(path, required_stamps=None):
    path = Path(path)
    events = []
    required_stamps = set(required_stamps or ())
    found_stamps = set()
    previous_stamp = None
    previous_close = None
    last_stamp = None
    row_count = 0
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration as exc:
            raise ValueError('CSV 为空') from exc
        if header != CSV_HEADER:
            raise ValueError('CSV 列格式不符合预期: 需要 ,DateTime,Open,High,Low,Close,Volume')
        for row_number, row in enumerate(reader, start=2):
            if len(row) != 7:
                raise ValueError(f'CSV 第 {row_number} 行列数不符合预期')
            stamp = row[1]
            current = _parse_stamp(stamp)
            if last_stamp is not None and current <= last_stamp:
                raise ValueError(f'CSV 时间戳未严格递增: 第 {row_number} 行 {stamp}')
            opening = _finite_number(row[2], f'第 {row_number} 行 open')
            close = _finite_number(row[5], f'第 {row_number} 行 close')
            found = detect_roll(previous_stamp, previous_close, stamp, opening) if previous_stamp is not None else None
            if found is not None:
                events.append(found)
            if stamp in required_stamps:
                found_stamps.add(stamp)
            previous_stamp, previous_close, last_stamp = stamp, close, current
            row_count += 1
    if row_count == 0:
        raise ValueError('CSV 没有数据')
    return events, found_stamps


def audit_csv(path, overrides=None) -> RollAdjuster:
    """Scan one CSV and return an adjuster; manual override timestamps must exist."""
    if isinstance(overrides, (str, Path)):
        overrides = load_overrides(overrides)
    clean = {'version': 1, 'events': {}} if overrides is None else validate_overrides(overrides)
    events, found_stamps = _scan_csv(path, clean['events'])
    missing = sorted(set(clean['events']) - found_stamps)
    if missing:
        raise ValueError(f'overrides 时间戳不存在于 CSV: {", ".join(missing)}')
    return RollAdjuster(events, clean)


def _cli_scan(args):
    overrides = load_overrides(args.overrides) if args.overrides else {'version': 1, 'events': {}}
    adjuster = audit_csv(args.csv, overrides)
    events = adjuster.events
    report = {
        'csv': str(Path(args.csv)),
        'candidateCount': sum(event['source'] == 'auto' or (event['source'] == 'override' and event['estimated'])
                              for event in events),
        'enabledEventCount': adjuster.metadata['eventCount'],
        'estimatedTotalOffset': adjuster.total_offset,
        'revision': adjuster.revision,
        'tail': events[-args.tail:] if args.tail else [],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    scan = commands.add_parser('scan', help='只读扫描 CSV 并输出估算换月候选')
    scan.add_argument('--csv', required=True, help='原始 OHLCV CSV 路径')
    scan.add_argument('--overrides', default=str(DEFAULT_OVERRIDES), help='版本 1 的换月人工覆盖 JSON')
    scan.add_argument('--tail', type=int, default=10, help='输出末尾候选数；设为 0 不输出事件明细')
    scan.set_defaults(func=_cli_scan)
    args = parser.parse_args(argv)
    if args.tail < 0:
        parser.error('--tail 不能为负数')
    args.func(args)


if __name__ == '__main__':
    main()
