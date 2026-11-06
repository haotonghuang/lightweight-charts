import json
import datetime as dt
import math
import tempfile
import unittest
from pathlib import Path

from roll_adjustment import RollAdjuster, _parse_stamp, audit_csv, detect_roll, load_overrides, validate_overrides


def roll(stamp, gap):
    return {
        'time': stamp,
        'gap': gap,
        'newOpen': 5000 + gap,
        'previousClose': 5000,
        'threshold': 10,
        'method': 'quarterly-midnight-gap-v1',
        'estimated': True,
    }


class DetectRollTests(unittest.TestCase):
    def test_timestamp_parser_requires_the_canonical_fixed_width_format(self):
        self.assertEqual(_parse_stamp('2024-03-14 09:30:00').isoformat(' '), '2024-03-14 09:30:00')
        for stamp in ('2024-3-14 09:30:00', '2024-03-14T09:30:00',
                      '2024-03-14\t09:30:00', '2024-03-14 9:30:00',
                      '2024-03-14 09:30:00.000', '2024-02-30 09:30:00',
                      '２０２４-03-14 09:30:00', '0999-01-01 00:00:00', None):
            with self.subTest(stamp=stamp), self.assertRaises(ValueError):
                _parse_stamp(stamp)

    def test_detects_positive_and_negative_quarterly_gap(self):
        positive = detect_roll('2024-03-14 23:59:00', 5000, '2024-03-15 00:00:00', 5010)
        negative = detect_roll('2024-06-13 23:59:00', 5000, '2024-06-14 00:00:00', 4990)
        self.assertEqual(positive['gap'], 10)
        self.assertEqual(positive['newOpen'], 5010)
        self.assertEqual(positive['previousClose'], 5000)
        self.assertEqual(positive['time'], '2024-03-15 00:00:00')
        self.assertTrue(positive['estimated'])
        self.assertEqual(negative['gap'], -10)

    def test_requires_candidate_month_day_and_gap_threshold(self):
        self.assertIsNone(detect_roll('2024-03-14 23:59:00', 5000, '2024-03-15 00:01:00', 5008))
        self.assertIsNone(detect_roll('2024-02-14 23:59:00', 5000, '2024-02-15 00:00:00', 5100))
        self.assertIsNone(detect_roll('2024-03-08 23:59:00', 5000, '2024-03-11 00:00:00', 5100))

    def test_does_not_remove_regular_intraday_or_non_roll_gap(self):
        self.assertIsNone(detect_roll('2024-03-15 09:29:00', 5000, '2024-03-15 09:30:00', 5100))
        self.assertIsNone(detect_roll('2024-03-14 23:59:00', 5000, '2024-03-15 00:00:00', 5005))
        self.assertIsNone(detect_roll('2024-03-14 23:54:59', 5000, '2024-03-15 00:00:00', 5100))


class RollAdjusterTests(unittest.TestCase):
    def test_offsets_match_original_ordered_sum_for_fractional_deltas(self):
        deltas = [0.1, 0.2, 0.3]
        stamps = ['2024-03-14 00:00:00', '2024-06-14 00:00:00', '2024-09-13 00:00:00']
        adjuster = RollAdjuster([roll(stamp, delta) for stamp, delta in zip(stamps, deltas)])
        self.assertEqual(adjuster.offset_at('2024-03-13 23:59:00'), sum(deltas))
        self.assertEqual(adjuster.offset_at(stamps[0]), sum(deltas[1:]))
        self.assertEqual(adjuster.offset_at(stamps[1]), deltas[2])

    def test_large_event_set_uses_bounded_fallback_with_ordered_sums(self):
        start = dt.datetime(2024, 1, 1)
        deltas = [0.1, 0.2, 0.3] * 171
        events = [roll((start + dt.timedelta(minutes=index)).strftime('%Y-%m-%d %H:%M:%S'), delta)
                  for index, delta in enumerate(deltas)]
        adjuster = RollAdjuster(events)
        query = (start - dt.timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S')
        self.assertEqual(adjuster.offset_at(query), sum(deltas))

    def test_offsets_accumulate_and_event_bar_uses_new_segment_basis(self):
        adjuster = RollAdjuster([
            roll('2024-06-14 00:00:00', -5),
            roll('2024-09-13 00:00:00', 10),
        ])
        self.assertEqual(adjuster.offset_at('2024-06-13 23:59:00'), 5)
        self.assertEqual(adjuster.offset_at('2024-06-14 00:00:00'), 10)
        self.assertEqual(adjuster.offset_at('2024-09-12 23:59:00'), 10)
        self.assertEqual(adjuster.offset_at('2024-09-13 00:00:00'), 0)
        self.assertEqual(adjuster.offset_at('2024-09-13 00:01:00'), 0)
        self.assertEqual(adjuster.total_offset, 5)

    def test_adjusts_only_ohlc_without_changing_shape_body_volume_or_input(self):
        adjuster = RollAdjuster([roll('2024-09-13 00:00:00', 8)])
        raw = {'open': 100, 'high': 106, 'low': 98, 'close': 104, 'volume': 123, 'time': 1}
        adjusted = adjuster.adjust_bar('2024-06-01 12:00:00', raw)
        self.assertEqual(adjusted, {'open': 108, 'high': 114, 'low': 106, 'close': 112,
                                    'volume': 123, 'time': 1})
        self.assertEqual(adjusted['high'] - adjusted['low'], raw['high'] - raw['low'])
        self.assertEqual(adjusted['close'] - adjusted['open'], raw['close'] - raw['open'])
        self.assertEqual(raw['open'], 100)
        self.assertEqual(adjuster.adjust_bar('2024-09-13 00:00:00', raw)['close'], 104)

    def test_overrides_disable_change_delta_and_add_manual_boundary(self):
        overrides = {
            'version': 1,
            'events': {
                '2024-06-14 00:00:00': {'enabled': False},
                '2024-09-13 00:00:00': {'enabled': True, 'delta': 12.5, 'note': 'confirmed spread'},
                '2024-12-13 00:00:00': {'enabled': True, 'delta': -3, 'note': 'manual boundary'},
            },
        }
        adjuster = RollAdjuster([
            roll('2024-06-14 00:00:00', -5),
            roll('2024-09-13 00:00:00', 10),
        ], overrides)
        events = {event['time']: event for event in adjuster.events}
        self.assertFalse(events['2024-06-14 00:00:00']['enabled'])
        self.assertEqual(events['2024-09-13 00:00:00']['delta'], 12.5)
        self.assertEqual(events['2024-09-13 00:00:00']['source'], 'override')
        self.assertEqual(events['2024-12-13 00:00:00']['source'], 'manual')
        self.assertFalse(events['2024-12-13 00:00:00']['estimated'])
        self.assertEqual(adjuster.total_offset, 9.5)

    def test_revision_is_stable_and_changes_with_event_state(self):
        first = RollAdjuster([roll('2024-09-13 00:00:00', 8)])
        same = RollAdjuster([roll('2024-09-13 00:00:00', 8)])
        changed = RollAdjuster([roll('2024-09-13 00:00:00', 9)])
        self.assertEqual(first.revision, same.revision)
        self.assertNotEqual(first.revision, changed.revision)
        self.assertEqual(first.metadata['revision'], first.revision)
        self.assertEqual(first.metadata['events'][0]['delta'], 8)
        self.assertEqual(len(first.revision), 64)

    def test_invalid_overrides_fail_closed(self):
        invalid = [
            {'version': 2, 'events': {}},
            {'version': 1, 'events': {'bad-time': {'enabled': False}}},
            {'version': 1, 'events': {'2024-09-13 00:00:00': {'enabled': 1}}},
            {'version': 1, 'events': {'2024-09-13 00:00:00': {'enabled': True, 'delta': math.inf}}},
            {'version': 1, 'events': {'2024-12-13 00:00:00': {'enabled': True, 'delta': 1}}},
        ]
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValueError):
                RollAdjuster([], config)
        with self.assertRaises(ValueError):
            validate_overrides({'version': 1, 'events': {}, 'fallback': True})

    def test_audit_csv_checks_manual_timestamp_against_source(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ES.csv'
            path.write_text(
                ',DateTime,Open,High,Low,Close,Volume\n'
                '0,2024-03-14 23:59:00,5000,5001,4999,5000,10\n'
                '1,2024-03-15 00:00:00,5010,5012,5009,5011,20\n',
                encoding='utf-8',
            )
            adjuster = audit_csv(path, {'version': 1, 'events': {}})
            self.assertEqual(adjuster.metadata['eventCount'], 1)
            valid = {'version': 1, 'events': {
                '2024-03-15 00:00:00': {'enabled': True, 'delta': 7, 'note': 'reviewed'},
            }}
            self.assertEqual(audit_csv(path, valid).total_offset, 7)
            missing = {'version': 1, 'events': {
                '2024-03-15 00:01:00': {'enabled': True, 'delta': 7, 'note': 'reviewed'},
            }}
            with self.assertRaises(ValueError):
                audit_csv(path, missing)

    def test_override_json_loader_rejects_malformed_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.json'
            path.write_text('{oops', encoding='utf-8')
            with self.assertRaises(ValueError):
                load_overrides(path)
            path.write_text(json.dumps({'version': 1, 'events': {}}), encoding='utf-8')
            self.assertEqual(load_overrides(path), {'version': 1, 'events': {}})


if __name__ == '__main__':
    unittest.main()
