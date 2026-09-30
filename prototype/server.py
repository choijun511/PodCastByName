#!/usr/bin/env python3
"""Loopback-only RSS catalog. Python standard library; no runtime dependencies."""
import moderation
import ai_review
import argparse
import hashlib
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import ssl
import sys
import unicodedata
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urljoin, urlsplit, parse_qs
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
MAX_FEED = 4 * 1024 * 1024

def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())

def client_hash(key):
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        raise ValueError('需要有效的设备密钥')
    return hashlib.sha256(key.encode()).hexdigest()

def bounded(value, label, maximum, required=False):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise ValueError(f'{label}需要{1 if required else 0}–{maximum}个字符')
    return value.strip()

def now():
    return datetime.now(timezone.utc).isoformat()

def public_target(url):
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('仅支持无凭据的公开 HTTP(S) 地址')
    port = p.port or (443 if p.scheme == 'https' else 80)
    addresses = socket.getaddrinfo(p.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('禁止访问本机、内网和保留地址')
    return p, addresses[0]

def fetch_public(url):
    """Pin the validated address to the socket, including each redirect."""
    for _ in range(6):
        p, address = public_target(url)
        sock = socket.socket(address[0], address[1], address[2])
        sock.settimeout(15)
        conn = http.client.HTTPConnection(p.hostname, p.port or (443 if p.scheme == 'https' else 80), timeout=15)
        try:
            sock.connect(address[4])
            if p.scheme == 'https':
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=p.hostname)
            conn.sock = sock
            conn.request('GET', p.path + ('?' + p.query if p.query else '') or '/', headers={'User-Agent': 'TingshuiLocalCatalog/1.0', 'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                target = response.getheader('Location')
                if not target:
                    raise ValueError('RSS 重定向缺少目标地址')
                url = urljoin(url, target)
                continue
            if response.status != 200:
                raise ValueError('RSS HTTP 状态：' + str(response.status))
            if response.getheader('Content-Encoding', 'identity') != 'identity':
                raise ValueError('不支持压缩 RSS 响应')
            data = response.read(MAX_FEED + 1)
            if len(data) > MAX_FEED:
                raise ValueError('RSS 超过 4 MB 限制')
            return data
        finally:
            conn.close()
            sock.close()
    raise ValueError('RSS 重定向次数过多')

def media_url(value):
    try:
        p = urlsplit(value)
        return value if p.scheme in ('https', 'http') and p.hostname and not p.username and not p.password else ''
    except ValueError:
        return ''

def parse_feed(data):
    if len(data) > MAX_FEED or re.search(br'<!\s*(DOCTYPE|ENTITY)', data.replace(b'\x00', b''), re.I):
        raise ValueError('RSS 过大或包含禁止的 XML 实体声明')
    root = ET.fromstring(data)
    if len(list(root.iter())) > 60000:
        raise ValueError('RSS 节点过多')
    channel = root.find('channel')
    if channel is None:
        raise ValueError('需要 RSS 2.0 channel')
    show = channel.findtext('title', '').strip()
    lang = channel.findtext('language', '')
    items = []
    for item in channel.findall('item')[:3000]:
        enc = item.find('enclosure')
        if enc is None:
            continue
        audio = media_url(enc.get('url', ''))
        if not audio:
            continue
        description = item.findtext('description', '')
        description += ' ' + ' '.join((e.text or '') for e in item if e.tag.endswith('encoded'))
        items.append(dict(title=item.findtext('title', '').strip(), description=description[:20000], audio=audio,
                          source=media_url(item.findtext('link', '')), guid=item.findtext('guid', '') or audio,
                          date=item.findtext('pubDate', ''), lang=lang, show=show, version='完整单集'))
    return items

def same_release(existing, incoming):
    if existing.get('audio') == incoming.get('audio'):
        return True
    def source_key(value):
        parsed = urlsplit(value or '')
        return (parsed.hostname or '', parsed.path.rstrip('/'))
    return bool(existing.get('source') and incoming.get('source') and
                source_key(existing['source']) == source_key(incoming['source']) and
                existing.get('title', '').casefold().strip() == incoming.get('title', '').casefold().strip())

class Catalog:
    def __init__(self, db_path, seed_path=None, fetcher=fetch_public, recover=True):
        self.db = sqlite3.connect(db_path)
        self.db.row_factory = sqlite3.Row
        self.fetcher = fetcher
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, person_id TEXT NOT NULL, feed_url TEXT NOT NULL, guid TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, UNIQUE(person_id,feed_url,guid));
        CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, feed_url TEXT, person_id TEXT, status TEXT, matched INTEGER, added INTEGER, error TEXT);
        CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, candidate_id TEXT, reviewed_at TEXT, old_status TEXT, new_status TEXT, evidence TEXT);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, client_hash TEXT NOT NULL, query TEXT NOT NULL, identity_hint TEXT NOT NULL, query_key TEXT NOT NULL, hint_key TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, person_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(client_hash,query_key,hint_key));
        CREATE TABLE IF NOT EXISTS request_history(id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, person_id TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL UNIQUE, approved_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        ''')
        moderation.setup(self.db)
        ai_review.setup(self.db)
        if seed_path and not self.db.execute("SELECT 1 FROM meta WHERE key='seeded'").fetchone():
            raw = Path(seed_path).read_text()
            people = json.loads(raw.split('=', 1)[1].strip().rstrip(';'))
            with self.db:
                for person in people:
                    episodes = person.pop('episodes', [])
                    self.db.execute('INSERT OR IGNORE INTO people VALUES(?,?)', (person['id'], json.dumps(person, ensure_ascii=False)))
                    for ep in episodes:
                        ep['show'] = person.get('show', '')
                        self.db.execute('INSERT OR IGNORE INTO candidates VALUES(?,?,?,?,?,?,?)', (ep['id'], person['id'], '', ep['id'], json.dumps(ep, ensure_ascii=False), 'approved', ep.get('evidence') or '既有人工核验样本；来源：' + ep.get('source', '')))
                        self.db.execute('INSERT OR IGNORE INTO events(candidate_id,approved_at) VALUES(?,?)', (ep['id'], now()))
                self.db.execute("INSERT INTO meta VALUES('seeded','1')")

        if recover:
            with self.db:
                self.db.execute("UPDATE runs SET status='failed',finished_at=?,error=? WHERE status='running'", (now(), '上次刷新被中断，可重试'))

        # Existing confirmed catalog entries become baseline events once, including seed data.
        if not self.db.execute("SELECT 1 FROM meta WHERE key='approval_events_v1'").fetchone():
            stamp = now()
            with self.db:
                for row in self.db.execute("SELECT id FROM candidates WHERE status='approved' ORDER BY rowid"):
                    self.db.execute('INSERT OR IGNORE INTO events(candidate_id,approved_at) VALUES(?,?)', (row['id'], stamp))
                self.db.execute("INSERT INTO meta VALUES('approval_events_v1','1')")

    def people(self, include_empty=False):
        result = []
        for row in self.db.execute('SELECT * FROM people ORDER BY rowid'):
            person = json.loads(row['data'])
            person['episodes'] = []
            for episode in self.db.execute("SELECT * FROM candidates WHERE person_id=? AND status='approved' AND NOT EXISTS (SELECT 1 FROM community_hidden h WHERE h.candidate_id=candidates.id) ORDER BY rowid", (row['id'],)):
                data = json.loads(episode['data'])
                data.update(id=episode['id'], evidence=episode['evidence'], votes=moderation.summary(self,episode['id']))
                person['episodes'].append(data)
            if person['episodes'] or include_empty:
                result.append(person)
        return result

    def state(self):
        candidates = []
        for row in self.db.execute('SELECT * FROM candidates ORDER BY rowid DESC'):
            data = json.loads(row['data'])
            data.update({key: row[key] for key in ('id', 'person_id', 'feed_url', 'status', 'evidence')})
            candidates.append(data)
        return dict(people=[dict(id=p['id'], name=p['name'], role=p.get('role', '')) for p in self.people(include_empty=True)], candidates=candidates,
                    runs=[dict(r) for r in self.db.execute('SELECT * FROM runs ORDER BY id DESC LIMIT 50')],
                    reviews=[dict(r) for r in self.db.execute('SELECT * FROM reviews ORDER BY id DESC LIMIT 100')], requests=self.requests(), sources=self.sources(), ai=dict(configured=ai_review.configured(), runtime=ai_review.runtime(self.db), budget=ai_review.budget(self.db), rule=ai_review.RULE_VERSION, recent=[dict(r) for r in self.db.execute('SELECT candidate_id,outcome,created_at,detail FROM ai_reviews ORDER BY id DESC LIMIT 20')]))

    def sources(self):
        # Run history is the durable registry, including unsuccessful first imports.
        sources = {}
        for row in self.db.execute('SELECT * FROM runs ORDER BY id DESC'):
            key = (row['feed_url'], row['person_id'])
            if key not in sources:
                sources[key] = dict(id=hashlib.sha256(('\n'.join(key)).encode()).hexdigest()[:24],
                                    feed_url=key[0], person_id=key[1], status=row['status'],
                                    last_checked_at=row['finished_at'] or row['started_at'],
                                    matched=row['matched'], added=row['added'], error=row['error'],
                                    last_success_at=None, attempts=0)
            source = sources[key]
            source['attempts'] += 1
            if row['status'] == 'completed' and source['last_success_at'] is None:
                source['last_success_at'] = row['finished_at']
        return list(sources.values())

    def refresh_source(self, source_id):
        source = next((source for source in self.sources() if source['id'] == source_id), None)
        if source is None:
            raise ValueError('来源不存在')
        return self.import_feed(source['feed_url'], source['person_id'])

    def import_feed(self, feed_url, person_id):
        person_row = self.db.execute('SELECT data FROM people WHERE id=?', (person_id,)).fetchone()
        if not person_row:
            raise ValueError('人物不存在')
        with self.db:
            run_id = self.db.execute('INSERT INTO runs(started_at,feed_url,person_id,status) VALUES(?,?,?,?)', (now(), feed_url, person_id, 'running')).lastrowid
        try:
            items = parse_feed(self.fetcher(feed_url))
            person = json.loads(person_row['data'])
            names = [s.strip().casefold() for s in [person['name'], *re.split(r'[,，;；|]', person.get('alias', ''))] if s.strip()]
            matched = added = 0
            with self.db:
                for ep in items:
                    haystack = (ep['title'] + ' ' + ep['description']).casefold()
                    if not any(name in haystack for name in names):
                        continue
                    matched += 1
                    exists = self.db.execute('SELECT * FROM candidates WHERE person_id=? AND feed_url=? AND guid=?', (person_id, feed_url, ep['guid'])).fetchone()
                    if exists:
                        continue
                    # Same audio links across directories represent one release; preserve review state.
                    duplicate = next((r for r in self.db.execute('SELECT * FROM candidates WHERE person_id=?', (person_id,)) if same_release(json.loads(r['data']), ep)), None)
                    if duplicate:
                        continue
                    cid = 'rss-' + hashlib.sha256((person_id + '\n' + feed_url + '\n' + ep['guid']).encode()).hexdigest()[:20]
                    self.db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)', (cid, person_id, feed_url, ep['guid'], json.dumps(ep, ensure_ascii=False), 'pending', ''))
                    added += 1
                self.db.execute('UPDATE runs SET finished_at=?,status=?,matched=?,added=? WHERE id=?', (now(), 'completed', matched, added, run_id))
            ai_review.WAKE.set()
            ai_result={'configured':ai_review.configured(),'queued':True}
            return dict(run_id=run_id, matched=matched, added=added, ai=ai_result)
        except Exception as exc:
            with self.db:
                self.db.execute('UPDATE runs SET finished_at=?,status=?,error=? WHERE id=?', (now(), 'failed', str(exc)[:1000], run_id))
            raise ValueError(str(exc)) from exc

    def review(self, cid, status, evidence):
        if status not in ('approved', 'rejected', 'pending'):
            raise ValueError('无效的审核状态')
        if status == 'approved' and not evidence.strip():
            raise ValueError('确认本人出场前必须填写依据')
        row = self.db.execute('SELECT status FROM candidates WHERE id=?', (cid,)).fetchone()
        if not row:
            raise ValueError('候选单集不存在')
        with self.db:
            self.db.execute('INSERT INTO reviews(candidate_id,reviewed_at,old_status,new_status,evidence) VALUES(?,?,?,?,?)', (cid, now(), row['status'], status, evidence))
            self.db.execute('UPDATE candidates SET status=?,evidence=? WHERE id=?', (status, evidence, cid))
            if status == 'approved' and not self.db.execute('SELECT 1 FROM events WHERE candidate_id=?', (cid,)).fetchone():
                self.db.execute('INSERT INTO events(candidate_id,approved_at) VALUES(?,?)', (cid, now()))
        return dict(id=cid, status=status)

    def add_person(self, data):
        name = data.get('name', '').strip()
        if not name or len(name) > 100:
            raise ValueError('人物姓名需要 1–100 个字符')
        role = bounded(data.get('role', ''), '身份', 200)
        same_names = [p for p in self.people(include_empty=True) if normalize(p['name']) == normalize(name)]
        if same_names and (not role or any(not p.get('role') or normalize(p['role']) == normalize(role) for p in same_names)):
            raise ValueError('同名人物必须分别填写不同身份；姓名和身份都相同的人物已存在')
        person = {key: data.get(key, '').strip()[:2000] for key in ('name', 'alias', 'topic', 'role', 'intro')}
        person.update(id='person-' + secrets.token_hex(6), initial=name[0], color='#dcebbf', show='')
        with self.db:
            self.db.execute('INSERT INTO people VALUES(?,?)', (person['id'], json.dumps(person, ensure_ascii=False)))
        return person

    def updates(self, people=None, after=0, limit=50):
        if not isinstance(after, int) or isinstance(after, bool) or not 0 <= after <= 9223372036854775807 or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
            raise ValueError('after 需要非负整数，limit 需要 1–100 的整数')
        people = people or []
        if not isinstance(people, list) or len(people) > 100 or any(not isinstance(pid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', pid) for pid in people):
            raise ValueError('people 需要至多 100 个合法人物 ID')
        latest = self.db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0]
        selected = set(people)
        groups = []
        if selected:
            rows = self.db.execute("SELECT e.seq,e.approved_at,c.id,c.person_id,c.data,c.evidence,p.data AS person_data FROM events e JOIN candidates c ON c.id=e.candidate_id JOIN people p ON p.id=c.person_id WHERE c.status='approved' AND NOT EXISTS (SELECT 1 FROM community_hidden h WHERE h.candidate_id=c.id) ORDER BY e.seq")
            for row in rows:
                if row['person_id'] not in selected:
                    continue
                episode = json.loads(row['data'])
                episode.update(id=row['id'], evidence=row['evidence'])
                person = json.loads(row['person_data'])
                member = dict(id=row['person_id'], name=person['name'], seq=row['seq'])
                group = next((g for g in groups if same_release(g['episode'], episode)), None)
                if group is None:
                    group = dict(id='update-' + str(row['seq']), seq=row['seq'], people=[], episode=episode, approved_at=row['approved_at'])
                    groups.append(group)
                existing = next((p for p in group['people'] if p['id'] == member['id']), None)
                if existing:
                    existing['seq'] = max(existing['seq'], member['seq'])
                else:
                    group['people'].append(member)
                if row['seq'] >= group['seq']:
                    group.update(seq=row['seq'], approved_at=row['approved_at'])
        groups = sorted((g for g in groups if g['seq'] > after), key=lambda g: g['seq'])
        page = groups[:limit]
        for group in page:
            # Timestamp heuristic, not a claim about first-ever publication: older/unknown dates are backfills.
            group['kind'] = 'backfill'
            try:
                publication = parsedate_to_datetime(group['episode'].get('date', ''))
                if publication.tzinfo is None:
                    publication = publication.replace(tzinfo=timezone.utc)
                approval = datetime.fromisoformat(group['approved_at'])
                if approval - timedelta(days=7) <= publication <= approval + timedelta(days=1):
                    group['kind'] = 'new_release'
            except (ValueError, TypeError, OverflowError):
                pass
        more = len(groups) > limit
        return dict(items=page, cursor=page[-1]['seq'] if more else max(latest, after), latest_cursor=latest, has_more=more)

    def search(self, query='', limit=20, offset=0):
        query = normalize(bounded(query, '搜索词', 200))
        if isinstance(limit, bool) or isinstance(offset, bool) or not isinstance(limit, int) or not isinstance(offset, int) or not 1 <= limit <= 100 or not 0 <= offset <= 100000:
            raise ValueError('limit 需要 1–100，offset 需要 0–100000 的整数')
        # Store only matching person IDs, not search text or device identity.
        if len(query)>=2:
            for row in self.db.execute('SELECT data FROM people').fetchall():
                person=json.loads(row['data'])
                if any(query in normalize(name) for name in ai_review.aliases(person)):
                    ai_review.demand(self.db,person['id'])
        matches = []
        for person in self.people():
            names = [normalize(person['name']), *[normalize(a) for a in re.split(r'[,，;；|]', person.get('alias', '')) if a.strip()]]
            if not query or any(query in name for name in names):
                matches.append((0 if query in names else 1, person))
        matches.sort(key=lambda pair: (pair[0], normalize(pair[1]['name']), pair[1]['id']))
        return dict(items=[p for _, p in matches[offset:offset+limit]], total=len(matches), limit=limit, offset=offset)

    def requests(self, key=None):
        rows = self.db.execute('SELECT * FROM requests' + (' WHERE client_hash=?' if key is not None else '') + ' ORDER BY created_at DESC, id', (client_hash(key),) if key is not None else ())
        result = []
        for row in rows:
            item = {k: row[k] for k in ('id', 'query', 'identity_hint', 'status', 'note', 'person_id', 'created_at', 'updated_at')}
            item['history'] = [dict(h) for h in self.db.execute('SELECT status,note,person_id,created_at FROM request_history WHERE request_id=? ORDER BY id', (row['id'],))]
            result.append(item)
        return result

    def request_person(self, query, identity_hint, key):
        hashed = client_hash(key)
        query = bounded(query, '人物姓名', 200, True)
        identity_hint = bounded(identity_hint, '身份线索', 1000)
        existing = self.db.execute('SELECT id FROM requests WHERE client_hash=? AND query_key=? AND hint_key=?', (hashed, normalize(query), normalize(identity_hint))).fetchone()
        if existing:
            return dict(request=next(r for r in self.requests(key) if r['id'] == existing['id']), created=False)
        rid = 'request-' + secrets.token_hex(12)
        stamp = now()
        with self.db:
            self.db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)', (rid, hashed, query, identity_hint, normalize(query), normalize(identity_hint), 'queued', '', '', stamp, stamp))
            self.db.execute('INSERT INTO request_history(request_id,status,note,person_id,created_at) VALUES(?,?,?,?,?)', (rid, 'queued', '', '', stamp))
        return dict(request=next(r for r in self.requests(key) if r['id'] == rid), created=True)

    def update_request(self, rid, status, note='', person_id=''):
        if status not in ('queued', 'researching', 'reviewing', 'completed', 'not_found'):
            raise ValueError('无效的补录状态')
        note = bounded(note, '处理说明', 2000)
        person_id = bounded(person_id, '人物 ID', 100)
        if status == 'not_found' and not note:
            raise ValueError('暂未找到时需要填写说明')
        if status == 'completed' and not any(p['id'] == person_id for p in self.people()):
            raise ValueError('完成补录必须关联至少有一个已确认出场的人物')
        if not self.db.execute('SELECT 1 FROM requests WHERE id=?', (rid,)).fetchone():
            raise ValueError('补录请求不存在')
        if status != 'completed':
            person_id = ''
        stamp = now()
        with self.db:
            self.db.execute('UPDATE requests SET status=?,note=?,person_id=?,updated_at=? WHERE id=?', (status, note, person_id, stamp, rid))
            self.db.execute('INSERT INTO request_history(request_id,status,note,person_id,created_at) VALUES(?,?,?,?,?)', (rid, status, note, person_id, stamp))
        return dict(request=next(r for r in self.requests() if r['id'] == rid))

def make_handler(catalog, token, port):
    class Handler(BaseHTTPRequestHandler):
        def log_request(self, code='-', size='-'):
            # Do not write raw person-search terms or query strings to access logs.
            self.log_message('%s %s %s', self.command, urlsplit(self.path).path, str(code))

        def json(self, status, data):
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def allowed(self, admin=False):
            host = self.headers.get('Host', '')
            if host not in (f'127.0.0.1:{port}', f'localhost:{port}'):
                self.json(403, {'error': '非法 Host'})
                return False
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + host:
                self.json(403, {'error': '禁止跨来源访问'})
                return False
            if admin and not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.json(401, {'error': '请输入启动终端中的管理令牌'})
                return False
            return True

        def do_GET(self):
            path = urlsplit(self.path).path
            if not self.allowed(path.startswith('/api/admin/')):
                return
            if path in ('/api/search', '/api/requests', '/api/updates'):
                try:
                    if path == '/api/updates':
                        params = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                        if set(params) - {'people', 'after', 'limit'} or any(len(v) != 1 for v in params.values()):
                            raise ValueError('动态参数无效')
                        people = params.get('people', [''])[0]
                        self.json(200, catalog.updates(people.split(',') if people else [], int(params.get('after', ['0'])[0]), int(params.get('limit', ['50'])[0])))
                    elif path == '/api/requests':
                        self.json(200, {'requests': catalog.requests(self.headers.get('X-Client-Key', ''))})
                    else:
                        params = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                        if set(params) - {'q', 'limit', 'offset'} or any(len(v) != 1 for v in params.values()):
                            raise ValueError('搜索参数无效')
                        self.json(200, catalog.search(params.get('q', [''])[0], int(params.get('limit', ['20'])[0]), int(params.get('offset', ['0'])[0])))
                except (ValueError, TypeError) as exc:
                    self.json(400, {'error': str(exc)})
            elif path == '/api/health':
                catalog.db.execute('SELECT 1').fetchone()
                self.json(200, {'service': 'tingshui', 'status': 'ok', 'pid': os.getpid(),
                                'instance': os.environ.get('TINGSHUI_INSTANCE', '')})
            elif path == '/api/people':
                self.json(200, catalog.people())
            elif path == '/api/admin/state':
                self.json(200, catalog.state())
            elif path.startswith('/api/'):
                self.json(404, {'error': '接口不存在'})
            else:
                relative = 'index.html' if path == '/' else path.lstrip('/')
                file = (ROOT / 'dist' / relative).resolve()
                types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.woff2':'font/woff2', '.ico':'image/x-icon'}
                if not file.is_relative_to((ROOT / 'dist').resolve()) or file.suffix not in types or any(p.startswith('.') for p in Path(relative).parts) or not file.is_file():
                    self.json(404, {'error':'文件不存在'})
                    return
                body = file.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', types[file.suffix])
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)

        def do_POST(self):
            path = urlsplit(self.path).path
            if not self.allowed(path not in ('/api/requests','/api/vote','/api/interest')):
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536:
                    raise ValueError('请求大小无效')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict) or any(not isinstance(v, str) for v in data.values()):
                    raise ValueError('请求字段必须为字符串')
                path = urlsplit(self.path).path
                if path == '/api/interest':
                    if not catalog.db.execute('SELECT 1 FROM people WHERE id=?',(data['id'],)).fetchone():
                        raise ValueError('人物不存在')
                    ai_review.demand(catalog.db,data['id'])
                    result = {'queued':True}
                elif path == '/api/vote':
                    result = moderation.vote(catalog,data['id'],data['value'],data['client_key'])
                elif path == '/api/requests':
                    result = catalog.request_person(data['query'], data.get('identity_hint', ''), data['client_key'])
                elif path == '/api/admin/ai-review':
                    ai_review.WAKE.set()
                    result = {'configured':ai_review.configured(),'queued':True}
                elif path == '/api/admin/request':
                    result = catalog.update_request(data['id'], data['status'], data.get('note', ''), data.get('person_id', ''))
                elif path == '/api/admin/import':
                    result = catalog.import_feed(data['feed_url'], data['person_id'])
                elif path == '/api/admin/refresh':
                    result = catalog.refresh_source(data['id'])
                elif path == '/api/admin/review':
                    result = catalog.review(data['id'], data['status'], data.get('evidence', ''))
                elif path == '/api/admin/person':
                    result = catalog.add_person(data)
                else:
                    self.json(404, {'error':'接口不存在'})
                    return
                self.json(200, result)
            except (ValueError, KeyError, TypeError) as exc:
                self.json(400, {'error': str(exc)})
            except Exception:
                self.json(500, {'error':'服务器内部错误；请查看本地目录状态后重试'})
    return Handler

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--db', type=Path, default=ROOT / 'catalog.sqlite3')
    args = parser.parse_args()
    catalog = Catalog(args.db, ROOT / 'dist' / 'data.js')
    token = os.environ.get('CATALOG_ADMIN_TOKEN') or secrets.token_urlsafe(32)
    if len(token) < 24:
        parser.error('CATALOG_ADMIN_TOKEN 至少需要 24 个字符')
    server = HTTPServer(('127.0.0.1', args.port), make_handler(catalog, token, args.port))
    worker_stop,worker_thread=ai_review.start_worker(lambda: Catalog(args.db,recover=False))
    print(f'听谁 http://127.0.0.1:{args.port}/', flush=True)
    if os.environ.get('CATALOG_ADMIN_TOKEN'):
        print('管理令牌已从 CATALOG_ADMIN_TOKEN 读取。', flush=True)
    else:
        print(f'管理令牌（仅本机使用）：{token}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        worker_stop.set()
        ai_review.WAKE.set()
        worker_thread.join(timeout=1)
        catalog.db.close()

if __name__ == '__main__':
    main()
