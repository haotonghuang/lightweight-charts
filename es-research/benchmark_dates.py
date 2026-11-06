#!/usr/bin/env python3
"""Measure cold, repeated and adjacent date loads without changing source data."""
import argparse
import json
import time
from pathlib import Path

import server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--csv', type=Path, default=server.DEFAULT_CSV)
    parser.add_argument('--date', default='2017-03-14')
    parser.add_argument('--roll-overrides', type=Path, default=server.DEFAULT_ROLL_OVERRIDES)
    args = parser.parse_args()
    started = time.perf_counter()
    index = server.build_index(args.csv, server.load_overrides(args.roll_overrides))
    result = {'indexSeconds': round(time.perf_counter() - started, 4), 'queries': []}
    if args.date not in index.rth_sessions:
        parser.error('所选日期没有 RTH 数据')
    position = index.rth_sessions.index(args.date)
    adjacent = index.rth_sessions[min(position + 1, len(index.rth_sessions) - 1)]
    baseline = None
    for kind, day in [('cold', args.date), ('repeat', args.date), ('adjacent', adjacent), ('repeat', args.date)]:
        started = time.perf_counter()
        bars = server.read_bars(args.csv, index, day, day, 5, 'rth', 'back')
        result['queries'].append({'kind': kind, 'date': day, 'milliseconds': round((time.perf_counter() - started) * 1000, 2), 'bars': len(bars)})
        if baseline is None:
            baseline = bars
        elif day == args.date:
            assert bars == baseline, '缓存前后数据不一致'
    result['cachedBars'] = index.bar_cache_rows
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
