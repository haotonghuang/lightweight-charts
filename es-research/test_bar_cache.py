import csv
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


HEADER = ['', 'DateTime', 'Open', 'High', 'Low', 'Close', 'Volume']


class BarCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'ES.csv'
        rows = []
        daily_prices = {
            '2024-01-02': 100,
            '2024-01-03': 102,
            '2024-01-05': 125,
        }
        for day, base in daily_prices.items():
            for time, bump in [('08:30', -2), ('09:30', 0), ('09:31', 0.25), ('09:35', 1), ('10:00', 12), ('16:10', 2), ('16:14', 3)]:
                price = base + bump
                rows.append([len(rows), f'{day} {time}:00', price, price + 2, price - 1, price + 1, 10])
        with self.path.open('w', encoding='utf-8', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(HEADER)
            writer.writerows(rows)
        overrides = {'version': 1, 'events': {
            '2024-01-03 10:00:00': {'enabled': True, 'delta': 7, 'note': 'synthetic intraday splice'},
        }}
        self.index = server.build_index(self.path, overrides)

    def read(self, day, interval=5, session='rth', adjustment='back'):
        return server.read_bars(self.path, self.index, day, day, interval, session, adjustment)

    def test_repeated_and_adjacent_requests_reuse_daily_aggregates(self):
        with patch.object(server, '_read_rows', wraps=server._read_rows) as scan:
            first = self.read('2024-01-05')
            first_scan_count = scan.call_count
            self.assertGreater(first_scan_count, 0)
            repeated = self.read('2024-01-05')
            adjacent = self.read('2024-01-03')
            self.assertEqual(scan.call_count, first_scan_count)
        self.assertEqual(repeated, first)
        self.assertEqual(adjacent[0]['barCount'], 1)
        self.assertEqual(first[0]['barCount'], 1)

    def test_cached_bars_are_copied_before_enrichment_and_consistent_with_review(self):
        cold = self.read('2024-01-05')
        expected_review = server.read_review(self.path, self.index, '2024-01-05', 'back')
        cold[0]['high'] = -999
        cold[0]['ema20'] = -999
        warm = self.read('2024-01-05')
        warm_review = server.read_review(self.path, self.index, '2024-01-05', 'back')
        self.assertEqual(warm[0]['high'], 127.25)
        self.assertNotEqual(warm[0]['ema20'], -999)
        self.assertEqual(warm_review, expected_review)

    def test_cache_separates_price_adjustment_interval_and_session(self):
        raw = self.read('2024-01-02', adjustment='raw')
        adjusted = self.read('2024-01-02', adjustment='back')
        five_minute = self.read('2024-01-05')
        one_minute = self.read('2024-01-05', interval=1)
        all_session = self.read('2024-01-05', session='all')
        self.assertNotEqual(raw[0]['open'], adjusted[0]['open'])
        self.assertNotEqual(len(one_minute), len(five_minute))
        self.assertNotEqual(len(all_session), len(five_minute))
        self.assertEqual(self.read('2024-01-02', adjustment='raw'), raw)
        self.assertEqual(self.read('2024-01-05', interval=1), one_minute)

    def test_gaps_between_sessions_remain_valid_cache_keys(self):
        self.assertEqual(self.read('2024-01-04'), [])
        before = self.read('2024-01-03')
        after = self.read('2024-01-05')
        self.assertTrue(before)
        self.assertTrue(after)
        self.assertEqual(self.read('2024-01-04'), [])

    def test_cache_is_bounded_and_evicted_days_are_reloaded(self):
        with patch.object(server, 'MAX_CACHED_BARS', 5):
            with patch.object(server, '_read_rows', wraps=server._read_rows) as scan:
                self.read('2024-01-02')
                self.read('2024-01-03')
                self.assertLessEqual(self.index.bar_cache_rows, 5)
                scans_after_eviction = scan.call_count
                self.read('2024-01-02')
                self.assertGreater(scan.call_count, scans_after_eviction)
                self.assertLessEqual(self.index.bar_cache_rows, 5)
        with patch.object(server, 'MAX_CACHED_DAYS', 1):
            self.index.bar_cache.clear()
            self.index.bar_cache_rows = 0
            with patch.object(server, '_read_rows', wraps=server._read_rows) as scan:
                self.read('2024-01-02')
                self.read('2024-01-03')
                self.assertEqual(len(self.index.bar_cache), 1)
                scans_after_eviction = scan.call_count
                self.read('2024-01-02')
                self.assertGreater(scan.call_count, scans_after_eviction)

    def test_source_change_requires_reindex_instead_of_reusing_stale_cache(self):
        self.read('2024-01-05')
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        with self.assertRaisesRegex(ValueError, 'CSV.*重启'):
            self.read('2024-01-05')

    def test_source_change_during_a_cold_read_rejects_the_current_response(self):
        original = server._read_rows
        def changing_rows(*args, **kwargs):
            for row in original(*args, **kwargs):
                yield row
                stat = self.path.stat()
                os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        with patch.object(server, '_read_rows', side_effect=changing_rows):
            with self.assertRaisesRegex(ValueError, 'CSV.*重启'):
                self.read('2024-01-05')


if __name__ == '__main__':
    unittest.main()
