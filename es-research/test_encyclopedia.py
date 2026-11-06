import datetime as dt
from email.message import Message
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from encyclopedia_store import EncyclopediaStore
import server


class EncyclopediaStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / 'encyclopedia.sqlite3'
        self.store = EncyclopediaStore(self.db_path)
        self.setup = self.store.mutate({'action': 'saveSetup', 'item': {'name': 'Low 2 top', 'description': 'Second attempt at resistance'}})['setups'][0]
        self.tag = self.store.mutate({'action': 'saveTag', 'item': {'name': 'Strong buying'}})['tags'][0]

    def tearDown(self):
        self.temp.cleanup()

    def sample_case(self, **overrides):
        item = {
            'date': '2017-03-14', 'barNumber': 15,
            'time': int(dt.datetime(2017, 3, 14, 10, 40, tzinfo=dt.timezone.utc).timestamp()),
            'interval': 5, 'session': 'rth', 'adjustment': 'back', 'rollRevision': 'v1',
            'dataSource': 'ES_1min.csv', 'setupIds': [self.setup['id']], 'tagIds': [self.tag['id']], 'notes': 'Clean signal',
        }
        item.update(overrides)
        return item

    def test_saves_links_and_survives_reopen(self):
        snapshot = self.store.mutate({'action': 'saveCase', 'item': self.sample_case()})
        case = snapshot['cases'][0]
        reopened = EncyclopediaStore(self.db_path).snapshot()['cases'][0]
        self.assertEqual(reopened, case)
        self.assertEqual((case['date'], case['barNumber']), ('2017-03-14', 15))
        self.assertEqual(case['setupIds'], [self.setup['id']])
        self.assertEqual(case['tagIds'], [self.tag['id']])

    def test_upsert_preserves_case_id_and_creation_time(self):
        first = self.store.mutate({'action': 'saveCase', 'item': self.sample_case()})['cases'][0]
        updated = self.store.mutate({'action': 'saveCase', 'item': self.sample_case(id=first['id'], notes='Updated')})['cases'][0]
        self.assertEqual(updated['createdAt'], first['createdAt'])
        self.assertGreaterEqual(updated['updatedAt'], first['updatedAt'])

    def test_rejects_bad_bar_reference_and_missing_setup(self):
        with self.assertRaisesRegex(ValueError, 'RTH 信号'):
            self.store.mutate({'action': 'saveCase', 'item': self.sample_case(barNumber=14)})
        with self.assertRaisesRegex(ValueError, 'RTH 信号'):
            self.store.mutate({'action': 'saveCase', 'item': self.sample_case(interval=0)})
        with self.assertRaisesRegex(ValueError, '不存在'):
            self.store.mutate({'action': 'saveCase', 'item': self.sample_case(setupIds=['00000000-0000-0000-0000-000000000001'])})

    def test_accepts_one_minute_signal_bar_numbers_above_the_five_minute_session_count(self):
        item = self.sample_case(
            date='2017-03-14', barNumber=400,
            time=int(dt.datetime(2017, 3, 14, 16, 9, tzinfo=dt.timezone.utc).timestamp()),
            interval=1,
        )
        case = self.store.mutate({'action': 'saveCase', 'item': item})['cases'][0]
        self.assertEqual((case['interval'], case['barNumber']), (1, 400))

    def test_rejects_case_insensitive_duplicate_names_and_deleting_referenced_values(self):
        with self.assertRaisesRegex(ValueError, '名称已被使用'):
            self.store.mutate({'action': 'saveTag', 'item': {'name': 'STRONG BUYING'}})
        self.store.mutate({'action': 'saveCase', 'item': self.sample_case()})
        for action, identifier in (('deleteSetup', self.setup['id']), ('deleteTag', self.tag['id'])):
            with self.assertRaisesRegex(ValueError, '仍被案例使用'):
                self.store.mutate({'action': action, 'id': identifier})

    def test_import_is_atomic_and_restores_complete_snapshot(self):
        original = self.store.mutate({'action': 'saveCase', 'item': self.sample_case()})
        invalid = {**original, 'setups': [{'id': 'bad', 'name': 'Replacement'}]}
        with self.assertRaises(ValueError):
            self.store.mutate({'action': 'import', 'data': invalid})
        self.assertEqual(self.store.snapshot(), original)
        self.store.mutate({'action': 'deleteCase', 'id': original['cases'][0]['id']})
        restored = self.store.mutate({'action': 'import', 'data': original})
        self.assertEqual(restored['cases'][0]['id'], original['cases'][0]['id'])
        self.assertEqual(restored['cases'][0]['setupIds'], [self.setup['id']])

    def test_new_records_stop_at_import_limit_but_updates_and_imports_at_limit_work(self):
        with patch('encyclopedia_store.MAX_ITEMS', 1):
            case = self.store.mutate({'action': 'saveCase', 'item': self.sample_case()})['cases'][0]
            self.store.mutate({'action': 'saveSetup', 'item': {**self.setup, 'description': 'Updated'}})
            self.store.mutate({'action': 'saveTag', 'item': self.tag})
            updated_case = self.store.mutate({'action': 'saveCase', 'item': self.sample_case(id=case['id'], notes='Updated')})['cases'][0]
            self.assertEqual(updated_case['notes'], 'Updated')
            with self.assertRaisesRegex(ValueError, '备份上限'):
                self.store.mutate({'action': 'saveSetup', 'item': {'name': 'Another setup'}})
            with self.assertRaisesRegex(ValueError, '备份上限'):
                self.store.mutate({'action': 'saveTag', 'item': {'name': 'Another tag'}})
            next_day = dt.date.fromisoformat('2017-03-14') + dt.timedelta(days=1)
            next_case = self.sample_case(
                date=next_day.isoformat(), barNumber=1,
                time=int(dt.datetime.combine(next_day, dt.time(9, 30), dt.timezone.utc).timestamp()),
            )
            with self.assertRaisesRegex(ValueError, '备份上限'):
                self.store.mutate({'action': 'saveCase', 'item': next_case})
            backup = self.store.snapshot()
            restored = self.store.mutate({'action': 'import', 'data': backup})
            self.assertEqual(len(restored['setups']), 1)
            self.assertEqual(len(restored['tags']), 1)
            self.assertEqual(len(restored['cases']), 1)


class EncyclopediaHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        csv_path = root / 'empty.csv'
        csv_path.write_text(',DateTime,Open,High,Low,Close,Volume\n0,2017-03-14 09:30:00,1,2,0,1,1\n', encoding='utf-8')
        self.csv_path = csv_path
        self.index = server.build_index(csv_path)
        self.handler = server.make_handler(csv_path, self.index, root / 'db.sqlite3')
        self.origin = 'http://127.0.0.1:8765'

    def tearDown(self):
        self.temp.cleanup()

    def request(self, data, headers=None, path='/api/encyclopedia'):
        message = Message()
        message['Host'] = '127.0.0.1:8765'
        message['Content-Length'] = str(len(data))
        for key, value in (headers or {}).items():
            message[key] = value
        handler_class = self.handler
        class FakeRequest:
            _send_json = handler_class._send_json
            _local_same_origin = handler_class._local_same_origin
            do_POST = handler_class.do_POST

            def __init__(request_self):
                request_self.headers = message
                request_self.path = path
                request_self.rfile = BytesIO(data)
                request_self.wfile = BytesIO()
                request_self.response_status = None
                request_self.close_connection = False

            def send_response(request_self, status):
                request_self.response_status = status

            def send_header(request_self, *_):
                pass

            def end_headers(request_self):
                pass

            def send_error(request_self, status):
                request_self._send_json({'error': 'not found'}, status)

        request = FakeRequest()
        request.do_POST()
        return request.response_status, json.loads(request.wfile.getvalue())

    def request_get(self):
        handler_class = self.handler
        class FakeRequest:
            _send_json = handler_class._send_json
            do_GET = handler_class.do_GET
            def __init__(request_self):
                request_self.path = '/api/encyclopedia'
                request_self.wfile = BytesIO()
                request_self.response_status = None
            def send_response(request_self, status):
                request_self.response_status = status
            def send_header(request_self, *_):
                pass
            def end_headers(request_self):
                pass
        request = FakeRequest()
        request.do_GET()
        return request.response_status, json.loads(request.wfile.getvalue())

    def test_read_and_write_json_endpoint(self):
        status, empty = self.request_get()
        self.assertEqual(status, 200)
        self.assertEqual(empty, {'version': 1, 'setups': [], 'tags': [], 'cases': []})
        status, created = self.request(b'{"action":"saveSetup","item":{"name":"Gap up"}}',
                                       {'Content-Type': 'application/json', 'Origin': self.origin})
        self.assertEqual(status, 200)
        self.assertEqual(created['setups'][0]['name'], 'Gap up')
        status, fetched = self.request_get()
        self.assertEqual(status, 200)
        self.assertEqual(fetched['setups'][0]['id'], created['setups'][0]['id'])

    def test_rejects_foreign_origin_wrong_content_type_and_invalid_json(self):
        status, _ = self.request(b'{}', {'Content-Type': 'application/json', 'Origin': 'http://evil.example'})
        self.assertEqual(status, 403)
        status, _ = self.request(b'{}', {'Content-Type': 'text/plain'})
        self.assertEqual(status, 415)
        status, body = self.request(b'{bad', {'Content-Type': 'application/json'})
        self.assertEqual(status, 400)
        self.assertIn('error', body)

    def test_rejects_request_larger_than_configured_backup_limit(self):
        with patch.object(server, 'MAX_ENCYCLOPEDIA_REQUEST', 2):
            status, body = self.request(b'{} ', {'Content-Type': 'application/json', 'Origin': self.origin})
        self.assertEqual(status, 413)
        self.assertIn('64 MB', body['error'])

    def test_accepts_and_restores_import_larger_than_two_megabytes(self):
        day = dt.date(2017, 3, 14)
        setup_id = str(uuid.uuid4())
        tag_id = str(uuid.uuid4())
        cases = []
        for offset in range(600):
            current = day + dt.timedelta(days=offset)
            cases.append({
                'id': str(uuid.uuid4()), 'date': current.isoformat(), 'barNumber': 1,
                'time': int(dt.datetime.combine(current, dt.time(9, 30), dt.timezone.utc).timestamp()),
                'interval': 5, 'session': 'rth', 'adjustment': 'back', 'rollRevision': 'v1',
                'dataSource': 'ES_1min.csv', 'setupIds': [setup_id], 'tagIds': [tag_id], 'notes': 'n' * 4000,
            })
        data = {'version': 1, 'setups': [{'id': setup_id, 'name': 'Large backup'}],
                'tags': [{'id': tag_id, 'name': 'Rich notes'}], 'cases': cases}
        body = json.dumps({'action': 'import', 'data': data}).encode()
        self.assertGreater(len(body), 2_000_000)
        status, restored = self.request(body, {'Content-Type': 'application/json', 'Origin': self.origin})
        self.assertEqual(status, 200)
        self.assertEqual(len(restored['cases']), 600)
        self.assertEqual(len(restored['cases'][0]['notes']), 4000)


if __name__ == '__main__':
    unittest.main()
