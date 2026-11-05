import csv
import datetime as dt
from io import BytesIO
import json
import sys
import tempfile
import unittest
from unittest.mock import Mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


HEADER = ['', 'DateTime', 'Open', 'High', 'Low', 'Close', 'Volume']


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.csv'
        self.rows = []

    def tearDown(self):
        self.temp.cleanup()

    def add_bar(self, day, time, open_, high, low, close, volume=1):
        stamp = f'{day} {time}:00'
        self.rows.append([len(self.rows), stamp, open_, high, low, close, volume])

    def write_csv(self):
        with self.path.open('w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow(HEADER)
            writer.writerows(self.rows)
        return server.build_index(self.path)

    def add_session(self, day, day_range, close=100):
        half = day_range / 2
        self.add_bar(day, '09:30', close, close + half, close - half, close)
        self.add_bar(day, '09:31', close, close + half, close - half, close)

    def test_rth_5_minute_aggregation_respects_boundaries_weekend_and_clock_slots(self):
        self.add_bar('2024-01-02', '09:29', 1, 999, 0, 999)
        self.add_bar('2024-01-02', '09:30', 100, 102, 99, 101, 5)
        self.add_bar('2024-01-02', '09:31', 101, 103, 100, 102, 6)
        self.add_bar('2024-01-02', '09:40', 102, 104, 101, 103, 7)
        self.add_bar('2024-01-02', '16:00', 103, 104, 102, 103)
        self.add_bar('2024-01-02', '16:14', 104, 105, 103, 105)
        self.add_bar('2024-01-02', '16:15', 105, 999, 0, 999)
        self.add_bar('2024-01-06', '09:30', 1, 999, 0, 999)
        index = self.write_csv()

        bars = server.read_bars(self.path, index, '2024-01-02', '2024-01-06', 5, 'rth')

        self.assertEqual([dt.datetime.fromtimestamp(b['time'], dt.timezone.utc).strftime('%H:%M') for b in bars],
                         ['09:30', '09:40', '16:00', '16:10'])
        self.assertEqual((bars[0]['open'], bars[0]['high'], bars[0]['low'], bars[0]['close'], bars[0]['volume']), (100, 103, 99, 102, 11))
        self.assertEqual((bars[-1]['high'], bars[-1]['low'], bars[-1]['close']), (105, 103, 105))
        self.assertEqual([bar['barCount'] for bar in bars], [1, 3, 79, 81])
        self.assertIsNone(bars[0]['abr8'])
        self.assertIsNone(bars[0]['adr8'])
        self.assertEqual(bars[0]['adr8Count'], 0)

    def test_indicators_use_prior_completed_sessions_and_include_current_bar_in_abr(self):
        days = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08',
                '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12']
        for i, day in enumerate(days):
            self.add_session(day, i + 1, close=100 + i)
        self.add_bar(days[-1], '16:14', 108, 10_000, 0, 108)
        index = self.write_csv()

        bars = server.read_bars(self.path, index, days[0], days[-1], 1, 'rth')
        target = [bar for bar in bars if dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).date().isoformat() == days[-1]]

        self.assertEqual(target[0]['adr8'], sum(range(1, 9)) / 8)
        self.assertEqual(index.rth_daily[days[-1]]['high'], 10_000)
        self.assertIsNone(bars[0]['abr8'])
        previous_eight_ranges = [bar['high'] - bar['low'] for bar in bars if bar['time'] <= target[1]['time']][-8:]
        self.assertEqual(target[1]['abr8'], sum(previous_eight_ranges) / 8)
        self.assertAlmostEqual(target[0]['ema20'], server.EMA_ALPHA * 108 + (1 - server.EMA_ALPHA) * bars[-4]['ema20'])

    def test_late_rth_bar_updates_adr_and_next_session_gap_but_1615_is_excluded(self):
        days = []
        current = dt.date(2024, 1, 2)
        while len(days) < 10:
            if current.weekday() < 5:
                days.append(current.isoformat())
            current += dt.timedelta(days=1)

        for position, day in enumerate(days):
            opening = 106 if position == len(days) - 1 else 100
            self.add_bar(day, '09:30', opening, opening + 1, opening - 1, opening)
            if position == 0:
                high, low, close = 201, -1, 150
            elif position == len(days) - 2:
                high, low, close = 110, 90, 105
            else:
                high, low, close = 101, 99, 100
            self.add_bar(day, '16:14', close - 1, high, low, close)
            self.add_bar(day, '16:15', close, 10_000, -10_000, 10_000)
        index = self.write_csv()

        late_session = index.rth_daily[days[-2]]
        next_session = server.read_bars(self.path, index, days[-1], days[-1], 5, 'rth')[0]

        self.assertEqual((late_session['high'], late_session['low']), (110, 90))
        self.assertEqual((late_session['close'], late_session['closeTime']), (105, f'{days[-2]} 16:14'))
        self.assertEqual(next_session['adr8'], 4.25)
        self.assertEqual(next_session['rthGap'], 1)
        self.assertEqual(next_session['previousRthCloseTime'], f'{days[-2]} 16:14')

    def test_all_session_bars_keep_natural_clock_buckets_and_null_rth_counter(self):
        self.add_bar('2024-01-02', '09:29', 99, 100, 98, 100, 1)
        self.add_bar('2024-01-02', '09:31', 100, 103, 99, 102, 2)
        self.add_bar('2024-01-02', '09:34', 102, 105, 101, 104, 3)
        index = self.write_csv()
        bars = server.read_bars(self.path, index, '2024-01-02', '2024-01-02', 5, 'all')
        self.assertEqual(len(bars), 2)
        self.assertEqual((bars[1]['high'], bars[1]['low'], bars[1]['volume']), (105, 99, 5))
        self.assertIsNone(bars[0]['barCount'])
        self.assertEqual(bars[1]['barCount'], 1)

    def test_complete_rth_session_has_405_one_minute_rows_81_five_minute_bars_and_45_minute_final_hour(self):
        day = '2024-01-02'
        for offset, minute in enumerate(range(9 * 60 + 30, 16 * 60 + 15)):
            hh, mm = divmod(minute, 60)
            price = float(offset)
            self.add_bar(day, f'{hh:02d}:{mm:02d}', price, price + 0.5, price - 0.5, price + 0.25)
        index = self.write_csv()

        one_minute = server.read_bars(self.path, index, day, day, 1, 'rth')
        five_minute = server.read_bars(self.path, index, day, day, 5, 'rth')
        hourly = server.read_bars(self.path, index, day, day, 60, 'rth')

        self.assertEqual(len(one_minute), 405)
        self.assertEqual(len(five_minute), 81)
        self.assertEqual(five_minute[-1]['barCount'], 81)
        self.assertEqual(dt.datetime.fromtimestamp(five_minute[-1]['time'], dt.timezone.utc).strftime('%H:%M'), '16:10')
        self.assertEqual((five_minute[-1]['open'], five_minute[-1]['close'], five_minute[-1]['volume']), (400, 404.25, 5))
        self.assertEqual(len(hourly), 7)
        self.assertEqual(dt.datetime.fromtimestamp(hourly[-1]['time'], dt.timezone.utc).strftime('%H:%M'), '15:30')
        self.assertEqual((hourly[-1]['open'], hourly[-1]['close'], hourly[-1]['volume']), (360, 404.25, 45))

    def test_review_returns_previous_two_rth_sessions_and_first_24_target_bars(self):
        days = ['2024-01-02', '2024-01-03', '2024-01-04']
        for day_number, day in enumerate(days):
            first_minute, final_minute = (9 * 60 + 30, 11 * 60 + 29) if day == days[-1] else (9 * 60 + 30, 16 * 60 + 14)
            for minute in range(first_minute, final_minute + 1):
                hh, mm = divmod(minute, 60)
                self.add_bar(day, f'{hh:02d}:{mm:02d}', 100 + day_number, 101 + day_number, 99 + day_number, 100 + day_number)
        index = self.write_csv()

        result = server.read_review(self.path, index, days[-1])
        target = [bar for bar in result['bars'] if dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).date().isoformat() == days[-1]]

        self.assertEqual(result['previousSessions'], days[:2])
        self.assertEqual(result['targetCount'], 24)
        self.assertEqual([bar['barCount'] for bar in target], list(range(1, 25)))
        self.assertEqual([bar['barCount'] for bar in result['bars'][:81]], list(range(1, 82)))
        self.assertEqual([sum(dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).date().isoformat() == day
                              for bar in result['bars']) for day in days], [81, 81, 24])
        self.assertEqual(result['focusTime'], target[0]['time'])
        self.assertEqual(result['warnings'], [])
        self.assertEqual(len(result['bars']), 81 * 2 + 24)

    def test_review_indicators_match_a_narrow_rth_query_after_long_warmup(self):
        days = []
        current = dt.date(2024, 1, 2)
        while len(days) < 85:
            if current.weekday() < 5:
                days.append(current.isoformat())
            current += dt.timedelta(days=1)
        for session_number, day in enumerate(days):
            for bar_number, minute in enumerate(range(9 * 60 + 30, 16 * 60 + 15, 5)):
                hh, mm = divmod(minute, 60)
                close = 100 + session_number + bar_number / 100
                self.add_bar(day, f'{hh:02d}:{mm:02d}', close, close + 0.25, close - 0.25, close)
        index = self.write_csv()

        review = server.read_review(self.path, index, days[-1])
        narrow = server.read_bars(self.path, index, days[-1], days[-1], 5, 'rth')
        review_target = [bar for bar in review['bars'] if dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).date().isoformat() == days[-1]]

        self.assertEqual(review['previousSessions'], days[-3:-1])
        self.assertEqual(review_target, narrow[:24])

    def test_review_reports_incomplete_target_and_rejects_date_without_rth(self):
        self.add_bar('2024-01-02', '09:30', 100, 101, 99, 100)
        index = self.write_csv()
        result = server.read_review(self.path, index, '2024-01-02')
        self.assertEqual(result['targetCount'], 1)
        self.assertTrue(any('少于 24 根' in warning for warning in result['warnings']))
        self.assertTrue(any('不足两个' in warning for warning in result['warnings']))
        with self.assertRaises(ValueError):
            server.read_review(self.path, index, '2024-01-03')

    def test_rth_60_minute_bars_are_anchored_at_open_and_all_session_60m_count_is_null(self):
        day = '2024-01-02'
        for time, close in [('09:29', 99), ('09:30', 100), ('10:29', 101),
                            ('10:30', 102), ('15:59', 103), ('16:00', 104),
                            ('16:14', 105), ('16:15', 106)]:
            self.add_bar(day, time, close, close + 1, close - 1, close)
        index = self.write_csv()

        rth = server.read_bars(self.path, index, day, day, 60, 'rth')
        all_session = server.read_bars(self.path, index, day, day, 60, 'all')

        self.assertEqual([dt.datetime.fromtimestamp(bar['time'], dt.timezone.utc).strftime('%H:%M') for bar in rth], ['09:30', '10:30', '15:30'])
        self.assertEqual([bar['barCount'] for bar in rth], [1, 2, 7])
        self.assertEqual(rth[-1]['close'], 105)
        self.assertTrue(all(bar['barCount'] is None for bar in all_session))

    def test_rth_gap_uses_exact_open_previous_available_rth_close_and_skips_weekend(self):
        friday, monday = '2024-01-05', '2024-01-08'
        self.add_bar(friday, '09:30', 99, 101, 98, 99)
        self.add_bar(friday, '15:58', 100, 101, 100, 100)
        self.add_bar(friday, '16:14', 100, 101, 100, 100.25)
        # Weekend rows must not become the previous session close.
        self.add_bar('2024-01-06', '09:30', 1, 500, 0, 1)
        self.add_bar(monday, '09:30', 102, 103, 101, 102.5)
        self.add_bar(monday, '09:31', 102.5, 10_000, 2, 10_000)
        self.add_bar(monday, '16:14', 105, 106, 104, 105)
        index = self.write_csv()

        monday_bars = server.read_bars(self.path, index, monday, monday, 1, 'rth')
        target = next(bar for bar in monday_bars if bar['barCount'] == 1)

        self.assertEqual(target['rthGap'], 1.75)
        self.assertAlmostEqual(target['rthGapPercent'], 1.75 / 100.25 * 100)
        self.assertEqual(target['previousRthCloseTime'], f'{friday} 16:14')
        self.assertEqual({bar['rthGap'] for bar in monday_bars}, {1.75})
        self.assertEqual({bar['rthGapPercent'] for bar in monday_bars}, {target['rthGapPercent']})
        self.assertIsNone(server.read_bars(self.path, index, friday, friday, 1, 'rth')[0]['rthGap'])

    def test_rth_gap_supports_negative_values_and_missing_exact_open(self):
        first, missing_open, next_day = '2024-01-02', '2024-01-03', '2024-01-04'
        self.add_bar(first, '09:30', 100, 101, 99, 100)
        self.add_bar(first, '16:14', 100, 101, 99, 100)
        self.add_bar(missing_open, '09:31', 99, 101, 98, 99)
        self.add_bar(missing_open, '16:14', 98, 100, 97, 98)
        self.add_bar(next_day, '09:30', 96, 97, 95, 96)
        index = self.write_csv()

        no_open = server.read_bars(self.path, index, missing_open, missing_open, 5, 'rth')
        later = server.read_bars(self.path, index, next_day, next_day, 5, 'rth')[0]

        self.assertTrue(all(bar['rthGap'] is None for bar in no_open))
        self.assertEqual(later['rthGap'], -2)
        self.assertAlmostEqual(later['rthGapPercent'], -2 / 98 * 100)
        self.assertEqual(later['previousRthCloseTime'], f'{missing_open} 16:14')

    def test_rth_gap_is_available_only_on_rth_anchored_bars(self):
        self.add_bar('2024-01-01', '09:30', 99, 101, 98, 100)
        self.add_bar('2024-01-01', '15:59', 100, 101, 99, 100)
        self.add_bar('2024-01-02', '09:29', 99, 100, 98, 99)
        self.add_bar('2024-01-02', '09:30', 101, 102, 100, 101)
        self.add_bar('2024-01-02', '09:31', 101, 102, 100, 101)
        index = self.write_csv()

        all_minutes = server.read_bars(self.path, index, '2024-01-02', '2024-01-02', 1, 'all')
        all_hourly = server.read_bars(self.path, index, '2024-01-02', '2024-01-02', 60, 'all')

        self.assertIsNone(all_minutes[0]['rthGap'])
        self.assertEqual(all_minutes[1]['rthGap'], 1)
        self.assertTrue(all(bar['rthGap'] is None for bar in all_hourly))

    def test_api_validation_meta_and_static_asset_allowlist(self):
        self.add_session('2024-01-02', 2)
        index = self.write_csv()
        handler_class = server.make_handler(self.path, index)

        def request(path):
            handler = object.__new__(handler_class)
            handler.path = path
            handler.wfile = BytesIO()
            handler.send_response = Mock()
            handler.send_header = Mock()
            handler.end_headers = Mock()
            handler.do_GET()
            return handler.send_response.call_args.args[0], json.loads(handler.wfile.getvalue())

        status, meta = request('/api/meta')
        self.assertEqual(status, 200)
        self.assertEqual(meta['rthSessions'], ['2024-01-02'])
        self.assertEqual(meta['dataFile'], 'test.csv')
        self.assertNotIn(str(self.path.parent), json.dumps(meta))

        status, payload = request('/api/bars?start=2024-01-02&end=2024-02-10&interval=5')
        self.assertEqual(status, 400)
        self.assertIn('error', payload)

        status, payload = request('/data/test.csv')
        self.assertEqual(status, 404)
        self.assertIn('error', payload)

    def test_default_csv_is_project_local_and_ignored(self):
        self.assertEqual(server.DEFAULT_CSV, server.ROOT / 'data' / 'ES_1min.csv')
        self.assertEqual((server.ROOT / 'data' / '.gitignore').read_text().splitlines(), ['*', '!.gitignore'])


if __name__ == '__main__':
    unittest.main()
