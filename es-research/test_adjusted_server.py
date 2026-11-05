import csv
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class AdjustedServerTests(unittest.TestCase):
    def fixture(self, rows, overrides=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'ES.csv'
        with path.open('w', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['', 'DateTime', 'Open', 'High', 'Low', 'Close', 'Volume'])
            for i, (stamp, opening, high, low, close) in enumerate(rows):
                writer.writerow([i, stamp, opening, high, low, close, 10])
        return path, server.build_index(path, overrides)

    def test_roll_adjustment_removes_only_estimated_splice_and_recomputes_gap_and_ema(self):
        path, index = self.fixture([
            ('2024-03-13 09:30:00', 99, 101, 98, 100),
            ('2024-03-13 16:14:00', 100, 102, 99, 100),
            ('2024-03-13 23:59:00', 102, 103, 101, 102),
            ('2024-03-14 00:00:00', 112, 113, 111, 112),
            ('2024-03-14 09:30:00', 115, 117, 114, 116),
            ('2024-03-14 16:14:00', 116, 118, 115, 117),
        ])
        raw = server.read_bars(path, index, '2024-03-13', '2024-03-14', 5, 'rth', 'raw')
        adjusted = server.read_bars(path, index, '2024-03-13', '2024-03-14', 5, 'rth', 'back')
        self.assertEqual(raw[2]['rthGap'], 15)
        self.assertEqual(adjusted[2]['rthGap'], 5)  # genuine market movement remains
        self.assertEqual(adjusted[0]['open'], raw[0]['open'] + 10)
        self.assertEqual(adjusted[2]['open'], raw[2]['open'])  # newest contract remains raw
        self.assertEqual(adjusted[2]['ema20'], (2 / 21) * 116 + (19 / 21) * 110)
        self.assertEqual(adjusted[0]['high'] - adjusted[0]['low'], raw[0]['high'] - raw[0]['low'])
        self.assertEqual(adjusted[0]['volume'], raw[0]['volume'])
        review = server.read_review(path, index, '2024-03-14', 'back')
        self.assertEqual(review['bars'][0], adjusted[0])

    def test_large_non_roll_overnight_gap_is_preserved(self):
        path, index = self.fixture([
            ('2024-04-10 16:14:00', 100, 101, 99, 100),
            ('2024-04-10 23:59:00', 100, 101, 99, 100),
            ('2024-04-11 00:00:00', 120, 121, 119, 120),
            ('2024-04-11 09:30:00', 121, 123, 120, 122),
        ])
        bars = server.read_bars(path, index, '2024-04-11', '2024-04-11', 5, 'rth')
        self.assertEqual(bars[0]['rthGap'], 21)
        self.assertEqual(index.roll_adjuster.events, [])
        with self.assertRaises(ValueError):
            server.read_bars(path, index, '2024-04-11', '2024-04-11', 5, 'rth', 'invalid')

    def test_manual_intraday_override_rebuilds_daily_extremes_after_adjustment(self):
        path, index = self.fixture([
            ('2024-03-14 09:30:00', 100, 101, 99, 100),
            ('2024-03-14 10:00:00', 112, 113, 111, 112),
            ('2024-03-14 16:14:00', 112, 113, 111, 112),
        ], {'version': 1, 'events': {'2024-03-14 10:00:00': {'enabled': True, 'delta': 10, 'note': 'synthetic intraday splice'}}})
        self.assertEqual(index.rth_daily['2024-03-14']['high'] - index.rth_daily['2024-03-14']['low'], 14)
        daily = index.adjusted_daily['2024-03-14']
        self.assertEqual((daily['open'], daily['high'], daily['low'], daily['close']), (110, 113, 109, 112))
        rows = server.read_bars(path, index, '2024-03-14', '2024-03-14', 60, 'rth')
        self.assertEqual((rows[0]['high'], rows[0]['low']), (113, 109))


if __name__ == '__main__':
    unittest.main()
