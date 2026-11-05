#!/usr/bin/env python3
"""Read-only HTTP smoke check against an already running local viewer."""
import argparse
import datetime as dt
import json
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    origin = f'http://127.0.0.1:{args.port}'

    def get(path, status=200):
        try:
            response = urlopen(origin + path, timeout=60)
        except HTTPError as error:
            response = error
        with response:
            assert response.status == status, (path, response.status)
            body = response.read()
            return json.loads(body) if 'application/json' in response.headers.get('Content-Type', '') else body

    meta = get('/api/meta')
    day = meta['rthSessions'][-1]
    assert meta['rth']['fiveMinuteSlots'] == 81
    assert meta['rth']['close'] == '16:15'
    bars = get('/api/bars?' + urlencode(dict(start=day, end=day, interval=5, session='rth')))
    assert len(bars) == 81 and bars[-1]['barCount'] == 81
    assert dt.datetime.fromtimestamp(bars[-1]['time'], dt.timezone.utc).strftime('%H:%M') == '16:10'
    review = get('/api/review?' + urlencode(dict(date=day)))
    target = [bar for bar in review['bars'] if dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).date().isoformat() == day]
    expected = [bar for bar in bars if dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).hour * 60 + dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).minute < 11 * 60 + 30]
    assert target == expected
    assert review['targetCount'] == len(target) <= 24
    assert review['focusTime'] == target[0]['time']
    prior_day = meta['rthSessions'][-2]
    previous = get('/api/bars?' + urlencode(dict(start=prior_day, end=prior_day, interval=5, session='rth')))
    if target[0]['barCount'] == 1:
        expected_gap = target[0]['open'] - previous[-1]['close']
        assert target[0]['rthGap'] == expected_gap
        assert target[0]['rthGapPercent'] == expected_gap / previous[-1]['close'] * 100
    assert review['previousSessions'] == meta['rthSessions'][-3:-1]
    assert all(bar['barCount'] is not None for bar in review['bars'])
    enabled_rolls = [event for event in meta['rollAdjustment']['events'] if event['enabled']]
    if enabled_rolls:
        event = enabled_rolls[-1]
        boundary = dt.datetime.strptime(event['time'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.timezone.utc)
        start_day = (boundary - dt.timedelta(days=1)).date().isoformat()
        end_day = boundary.date().isoformat()
        params = dict(start=start_day, end=end_day, interval=1, session='all')
        raw = get('/api/bars?' + urlencode({**params, 'adjustment': 'raw'}))
        back = get('/api/bars?' + urlencode({**params, 'adjustment': 'back'}))
        pos = next(i for i, bar in enumerate(raw) if bar['time'] == int(boundary.timestamp()))
        assert pos > 0 and len(raw) == len(back)
        raw_gap = raw[pos]['open'] - raw[pos - 1]['close']
        adjusted_gap = back[pos]['open'] - back[pos - 1]['close']
        assert abs(raw_gap - adjusted_gap - event['delta']) < 1e-7
    assert b'type="module"' in get('/')
    assert b'replayStartTime' in get('/app.js')
    assert b'export class Replay' in get('/replay.js')
    assert b'createDrawingController' in get('/drawings.js')
    assert b'DrawingManager' in get('/vendor/drawing/lightweight-charts-drawing-0.6.3.mjs')
    assert b'MIT' in get('/vendor/drawing/LICENSE')
    assert b'LightweightCharts' in get('/vendor/dist/lightweight-charts.standalone.production.js')
    for path in ['/data/ES_1min.csv', '/server.py', '/README.md', '/data/', '/%64ata/ES_1min.csv']:
        get(path, 404)
    get('/api/bars?start=2026-01-01&end=2026-03-01&interval=5', 400)
    get('/api/review?date=invalid', 400)
    print(f"HTTP smoke OK: {meta['first']}..{meta['last']}; {day}: {len(bars)} RTH bars, {len(review['bars'])} review bars ({len(target)} target); EMA20={target[0]['ema20']:.4f}, ADR8={target[0]['adr8']}, ABR8={target[0]['abr8']}, RTH gap={target[0]['rthGap']}")


if __name__ == '__main__':
    main()
