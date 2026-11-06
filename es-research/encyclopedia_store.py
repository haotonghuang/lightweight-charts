"""Small durable SQLite store for the local trading-pattern encyclopedia."""
import datetime as dt
from contextlib import contextmanager
import math
import sqlite3
import uuid
from pathlib import Path


VERSION = 1
MAX_ITEMS = 20_000
INTERVALS = {1, 5, 15, 60}
SESSIONS = {'rth', 'all'}
ADJUSTMENTS = {'back', 'raw'}


def _text(value, field, limit, required=False):
    if not isinstance(value, str):
        raise ValueError(f'{field} 必须是文本')
    value = value.strip()
    if required and not value:
        raise ValueError(f'{field} 不能为空')
    if len(value) > limit:
        raise ValueError(f'{field} 不能超过 {limit} 个字符')
    return value


def _id(value=None):
    if value is None:
        return str(uuid.uuid4())
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('无效的记录 ID') from None


def _unique_names(items, kind):
    names = set()
    for item in items:
        key = item['name'].casefold()
        if key in names:
            raise ValueError(f'{kind}名称不能重复')
        names.add(key)


def _date(value):
    if not isinstance(value, str):
        raise ValueError('date 必须为 YYYY-MM-DD')
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError('date 必须为 YYYY-MM-DD') from None
    if parsed.isoformat() != value:
        raise ValueError('date 必须为 YYYY-MM-DD')
    return value


def _case(item):
    if not isinstance(item, dict):
        raise ValueError('案例必须是对象')
    identifier = _id(item.get('id'))
    day = _date(item.get('date'))
    try:
        interval = item['interval']
        if isinstance(interval, bool) or int(interval) != interval or int(interval) not in INTERVALS:
            raise ValueError
        interval = int(interval)
        bar_number = item['barNumber']
        if isinstance(bar_number, bool) or int(bar_number) != bar_number or not 1 <= int(bar_number) <= math.ceil(405 / interval):
            raise ValueError
        bar_number = int(bar_number)
        stamp = item['time']
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp) or int(stamp) != stamp:
            raise ValueError
        stamp = int(stamp)
        when = dt.datetime.fromtimestamp(stamp, dt.timezone.utc)
        if when.date().isoformat() != day or when.second != 0 or when.microsecond != 0:
            raise ValueError
        minute = when.hour * 60 + when.minute
        offset = minute - (9 * 60 + 30)
        if not 0 <= offset < 405 or offset % interval or offset // interval + 1 != bar_number:
            raise ValueError
        if interval == 60 and minute != 9 * 60 + 30 + (bar_number - 1) * 60:
            raise ValueError
        session = item['session']
        if session not in SESSIONS or (session == 'all' and interval == 60):
            raise ValueError
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        raise ValueError('案例需指向有效的 RTH 信号 K 线（bar 编号、时间及周期必须一致）') from None
    adjustment = item.get('adjustment', 'back')
    if adjustment not in ADJUSTMENTS:
        raise ValueError('无效的价格口径')
    setup_ids = item.get('setupIds')
    tag_ids = item.get('tagIds', [])
    if not isinstance(setup_ids, list) or not setup_ids or not isinstance(tag_ids, list):
        raise ValueError('案例至少需要一个 setup，标签列表必须是数组')
    setup_ids = [_id(value) for value in setup_ids]
    tag_ids = [_id(value) for value in tag_ids]
    if len(set(setup_ids)) != len(setup_ids) or len(set(tag_ids)) != len(tag_ids):
        raise ValueError('案例关联不能重复')
    created = item.get('createdAt')
    updated = item.get('updatedAt')
    for value in (created, updated):
        if value is not None and (not isinstance(value, str) or len(value) > 40):
            raise ValueError('时间戳格式无效')
    return {
        'id': identifier, 'date': day, 'barNumber': bar_number, 'time': stamp,
        'interval': interval, 'session': session, 'adjustment': adjustment,
        'rollRevision': _text(item.get('rollRevision', ''), 'rollRevision', 100),
        'dataSource': _text(item.get('dataSource', 'ES'), 'dataSource', 100, True),
        'setupIds': setup_ids, 'tagIds': tag_ids,
        'notes': _text(item.get('notes', ''), 'notes', 4000),
        'createdAt': created, 'updatedAt': updated,
    }


class EncyclopediaStore:
    """Thread-safe through short-lived connections; each mutation is atomic."""

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS setups (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    description TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS tags (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE
                );
                CREATE TABLE IF NOT EXISTS cases (
                    id TEXT PRIMARY KEY, date TEXT NOT NULL, bar_number INTEGER NOT NULL,
                    time INTEGER NOT NULL, interval INTEGER NOT NULL, session TEXT NOT NULL,
                    adjustment TEXT NOT NULL, roll_revision TEXT NOT NULL,
                    data_source TEXT NOT NULL, notes TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS case_setups (
                    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
                    setup_id TEXT NOT NULL REFERENCES setups(id) ON DELETE RESTRICT,
                    PRIMARY KEY(case_id, setup_id)
                );
                CREATE TABLE IF NOT EXISTS case_tags (
                    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
                    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
                    PRIMARY KEY(case_id, tag_id)
                );
            ''')

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys = ON')
        return db

    @contextmanager
    def _connection(self):
        db = self._connect()
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _timestamp():
        return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')

    def snapshot(self):
        with self._connection() as db:
            db.execute('BEGIN')
            setups = [dict(row) for row in db.execute('SELECT id,name,description FROM setups ORDER BY name COLLATE NOCASE')]
            tags = [dict(row) for row in db.execute('SELECT id,name FROM tags ORDER BY name COLLATE NOCASE')]
            cases = []
            for row in db.execute('SELECT * FROM cases ORDER BY date DESC, time DESC, id'):
                case = {
                    'id': row['id'], 'date': row['date'], 'barNumber': row['bar_number'], 'time': row['time'],
                    'interval': row['interval'], 'session': row['session'], 'adjustment': row['adjustment'],
                    'rollRevision': row['roll_revision'], 'dataSource': row['data_source'],
                    'setupIds': [], 'tagIds': [], 'notes': row['notes'],
                    'createdAt': row['created_at'], 'updatedAt': row['updated_at'],
                }
                cases.append(case)
            by_id = {case['id']: case for case in cases}
            for relation in db.execute('SELECT case_id,setup_id FROM case_setups ORDER BY setup_id'):
                by_id[relation['case_id']]['setupIds'].append(relation['setup_id'])
            for relation in db.execute('SELECT case_id,tag_id FROM case_tags ORDER BY tag_id'):
                by_id[relation['case_id']]['tagIds'].append(relation['tag_id'])
            return {'version': VERSION, 'setups': setups, 'tags': tags, 'cases': cases}

    @staticmethod
    def _entity(item, kind):
        if not isinstance(item, dict):
            raise ValueError(f'{kind}必须是对象')
        name = _text(item.get('name'), f'{kind}名称', 100, True)
        entity = {'id': _id(item.get('id')), 'name': name}
        if kind == 'setup':
            entity['description'] = _text(item.get('description', ''), 'setup说明', 1000)
        return entity

    @staticmethod
    def _assert_name_available(db, table, name, identifier):
        if table not in ('setups', 'tags'):
            raise ValueError('无效的百科类型')
        for row in db.execute(f'SELECT id,name FROM {table}'):
            if row['id'] != identifier and row['name'].casefold() == name.casefold():
                raise ValueError('名称已被使用')

    def mutate(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('请求必须是 JSON 对象')
        action = payload.get('action')
        now = self._timestamp()
        with self._connection() as db:
            if action == 'saveSetup':
                item = self._entity(payload.get('item'), 'setup')
                db.execute('BEGIN IMMEDIATE')
                if not db.execute('SELECT 1 FROM setups WHERE id=?', (item['id'],)).fetchone() and db.execute('SELECT COUNT(*) FROM setups').fetchone()[0] >= MAX_ITEMS:
                    raise ValueError(f'setup 数量已达到备份上限（{MAX_ITEMS}）')
                self._assert_name_available(db, 'setups', item['name'], item['id'])
                db.execute('''INSERT INTO setups(id,name,description) VALUES(:id,:name,:description)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description''', item)
            elif action == 'saveTag':
                item = self._entity(payload.get('item'), '标签')
                db.execute('BEGIN IMMEDIATE')
                if not db.execute('SELECT 1 FROM tags WHERE id=?', (item['id'],)).fetchone() and db.execute('SELECT COUNT(*) FROM tags').fetchone()[0] >= MAX_ITEMS:
                    raise ValueError(f'标签数量已达到备份上限（{MAX_ITEMS}）')
                self._assert_name_available(db, 'tags', item['name'], item['id'])
                db.execute('''INSERT INTO tags(id,name) VALUES(:id,:name)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name''', item)
            elif action == 'saveCase':
                case = _case(payload.get('item'))
                db.execute('BEGIN IMMEDIATE')
                missing_setups = [identifier for identifier in case['setupIds'] if not db.execute('SELECT 1 FROM setups WHERE id=?', (identifier,)).fetchone()]
                missing_tags = [identifier for identifier in case['tagIds'] if not db.execute('SELECT 1 FROM tags WHERE id=?', (identifier,)).fetchone()]
                if missing_setups or missing_tags:
                    raise ValueError('案例引用了不存在的 setup 或标签')
                previous = db.execute('SELECT created_at FROM cases WHERE id=?', (case['id'],)).fetchone()
                if previous is None and db.execute('SELECT COUNT(*) FROM cases').fetchone()[0] >= MAX_ITEMS:
                    raise ValueError(f'案例数量已达到备份上限（{MAX_ITEMS}）')
                created = previous['created_at'] if previous else (case['createdAt'] or now)
                updated = now
                db.execute('''INSERT INTO cases VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                    date=excluded.date,bar_number=excluded.bar_number,time=excluded.time,interval=excluded.interval,
                    session=excluded.session,adjustment=excluded.adjustment,roll_revision=excluded.roll_revision,
                    data_source=excluded.data_source,notes=excluded.notes,updated_at=excluded.updated_at''',
                    (case['id'], case['date'], case['barNumber'], case['time'], case['interval'], case['session'],
                     case['adjustment'], case['rollRevision'], case['dataSource'], case['notes'], created, updated))
                db.execute('DELETE FROM case_setups WHERE case_id=?', (case['id'],))
                db.execute('DELETE FROM case_tags WHERE case_id=?', (case['id'],))
                db.executemany('INSERT INTO case_setups VALUES(?,?)', [(case['id'], value) for value in case['setupIds']])
                db.executemany('INSERT INTO case_tags VALUES(?,?)', [(case['id'], value) for value in case['tagIds']])
            elif action == 'deleteCase':
                if 'id' not in payload:
                    raise ValueError('缺少案例 ID')
                db.execute('DELETE FROM cases WHERE id=?', (_id(payload.get('id')),))
            elif action in ('deleteSetup', 'deleteTag'):
                if 'id' not in payload:
                    raise ValueError('缺少条目 ID')
                identifier = _id(payload.get('id'))
                table, relation, column = ('setups', 'case_setups', 'setup_id') if action == 'deleteSetup' else ('tags', 'case_tags', 'tag_id')
                if db.execute(f'SELECT 1 FROM {relation} WHERE {column}=? LIMIT 1', (identifier,)).fetchone():
                    raise ValueError('该条目仍被案例使用，请先移除案例关联')
                db.execute(f'DELETE FROM {table} WHERE id=?', (identifier,))
            elif action == 'import':
                self._import(db, payload.get('data'))
            else:
                raise ValueError('未知的百科操作')
        return self.snapshot()

    @staticmethod
    def _import(db, data):
        if not isinstance(data, dict) or data.get('version') != VERSION:
            raise ValueError('不支持的百科备份版本')
        setups, tags, cases = data.get('setups'), data.get('tags'), data.get('cases')
        if not all(isinstance(rows, list) and len(rows) <= MAX_ITEMS for rows in (setups, tags, cases)):
            raise ValueError('百科备份条目格式无效或数量超限')
        if any(not isinstance(item, dict) or 'id' not in item for item in setups + tags + cases):
            raise ValueError('备份条目缺少 ID')
        setups = [EncyclopediaStore._entity(item, 'setup') for item in setups]
        tags = [EncyclopediaStore._entity(item, '标签') for item in tags]
        cases = [_case(item) for item in cases]
        for rows, kind in ((setups, 'setup'), (tags, '标签')):
            _unique_names(rows, kind)
            if len({row['id'] for row in rows}) != len(rows):
                raise ValueError(f'{kind} ID 重复')
        setup_ids, tag_ids = {row['id'] for row in setups}, {row['id'] for row in tags}
        if len({case['id'] for case in cases}) != len(cases):
            raise ValueError('案例 ID 重复')
        for case in cases:
            if not set(case['setupIds']) <= setup_ids or not set(case['tagIds']) <= tag_ids:
                raise ValueError('百科备份包含无效关联')
        db.execute('DELETE FROM cases')
        db.execute('DELETE FROM setups')
        db.execute('DELETE FROM tags')
        db.executemany('INSERT INTO setups VALUES(?,?,?)', [(item['id'], item['name'], item['description']) for item in setups])
        db.executemany('INSERT INTO tags VALUES(?,?)', [(item['id'], item['name']) for item in tags])
        for case in cases:
            created = case['createdAt'] or EncyclopediaStore._timestamp()
            updated = case['updatedAt'] or created
            db.execute('INSERT INTO cases VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (case['id'], case['date'], case['barNumber'], case['time'], case['interval'], case['session'],
                        case['adjustment'], case['rollRevision'], case['dataSource'], case['notes'], created, updated))
            db.executemany('INSERT INTO case_setups VALUES(?,?)', [(case['id'], value) for value in case['setupIds']])
            db.executemany('INSERT INTO case_tags VALUES(?,?)', [(case['id'], value) for value in case['tagIds']])
