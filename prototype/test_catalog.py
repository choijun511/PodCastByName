import json
import io
from email.message import Message
from email.utils import format_datetime
from datetime import datetime, timezone
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from server import Catalog, parse_feed, public_target, make_handler

FEED = b'''<rss version="2.0"><channel><title>Test interviews</title><language>en</language>
<item><guid>one</guid><title>Talk with Ada Lovelace</title><description>Ada Lovelace joins us.</description><link>https://example.com/one</link><enclosure url="https://example.com/one.mp3"/></item>
<item><guid>two</guid><title>Discussing Ada Lovelace</title><description>We mention her work.</description><enclosure url="https://example.com/two.mp3"/></item>
<item><guid>three</guid><title>Other guest</title><enclosure url="https://example.com/three.mp3"/></item>
</channel></rss>'''

class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'catalog.sqlite'
        self.catalog = Catalog(self.path, fetcher=lambda _: FEED)
        self.pid = self.catalog.add_person(dict(name='Ada Lovelace', alias='埃达', topic='科技'))['id']
    def tearDown(self):
        self.catalog.db.close()
        self.tmp.cleanup()
    def test_import_review_reject_reimport_and_persistence(self):
        result = self.catalog.import_feed('https://example.com/feed', self.pid)
        self.assertEqual((result['matched'], result['added']), (2, 2))
        self.assertEqual(self.catalog.people(), [])
        candidate = next(c for c in self.catalog.state()['candidates'] if c['guid'] == 'one')
        with self.assertRaises(ValueError):
            self.catalog.review(candidate['id'], 'approved', ' ')
        self.catalog.review(candidate['id'], 'approved', 'Official description explicitly names guest')
        public = self.catalog.people()[0]['episodes']
        self.assertEqual(len(public), 1)
        self.assertEqual(public[0]['show'], 'Test interviews')
        self.assertTrue(public[0]['evidence'])
        self.catalog.review(candidate['id'], 'rejected', 'Correction: wrong person')
        self.assertEqual(self.catalog.people(), [])
        self.assertEqual(self.catalog.import_feed('https://example.com/feed', self.pid)['added'], 0)
        self.assertEqual(next(c for c in self.catalog.state()['candidates'] if c['id'] == candidate['id'])['status'], 'rejected')
        self.catalog.review(candidate['id'], 'pending', 'Reopen')
        self.assertEqual(len(self.catalog.state()['reviews']), 3)
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        self.assertEqual(len(self.catalog.state()['candidates']), 2)
        self.assertEqual(self.catalog.people(), [])
    def test_empty_people_private_and_unsafe_source_removed(self):
        self.assertEqual(self.catalog.people(), [])
        self.assertEqual(self.catalog.state()['people'][0]['id'], self.pid)
        unsafe = FEED.replace(b'https://example.com/one</link>', b'javascript:alert(1)</link>')
        self.assertEqual(parse_feed(unsafe)[0]['source'], '')
        self.assertEqual(len(parse_feed(FEED.replace(b'https://example.com/one.mp3', b'https://user:pass@example.com/one.mp3'))), 2)

    def approve_all(self):
        for candidate in self.catalog.state()['candidates']:
            self.catalog.review(candidate['id'], 'approved', 'Official guest listing verified')

    def test_search_normalization_pagination_and_namesake_isolation(self):
        # Existing Ada receives identity before creating a namesake.
        original = json.loads(self.catalog.db.execute('SELECT data FROM people WHERE id=?', (self.pid,)).fetchone()['data'])
        original['role'] = 'Mathematician'
        with self.catalog.db:
            self.catalog.db.execute('UPDATE people SET data=? WHERE id=?', (json.dumps(original), self.pid))
        other = self.catalog.add_person(dict(name='Ada Lovelace', alias='ＡＤＡ', role='Musician'))
        third = self.catalog.add_person(dict(name='Ada Lovelace Interviews', role='Host'))
        with self.assertRaises(ValueError):
            self.catalog.add_person(dict(name='Ａｄａ  Lovelace', role=' musician '))
        with self.assertRaises(ValueError):
            self.catalog.add_person(dict(name='Ada Lovelace'))
        self.catalog.import_feed('https://example.com/feed', self.pid)
        self.catalog.import_feed('https://example.com/feed', other['id'])
        # Only original is approved; namesake remains private and never inherits episodes.
        for candidate in self.catalog.state()['candidates']:
            if candidate['person_id'] == self.pid:
                self.catalog.review(candidate['id'], 'approved', 'Guest verified')
        self.assertEqual(self.catalog.search(' Ａｄａ   ＬＯＶＥＬＡＣＥ ')['total'], 1)
        self.assertEqual(self.catalog.search('埃达')['items'][0]['id'], self.pid)
        self.approve_all()
        result = self.catalog.search('Ada Lovelace', 1, 0)
        self.assertEqual(result['total'], 2)
        self.assertEqual(len(result['items']), 1)
        second = self.catalog.search('Ada Lovelace', 1, 1)
        self.assertNotEqual(result['items'][0]['id'], second['items'][0]['id'])
        self.assertEqual(self.catalog.search('', 1, 20)['items'], [])
        self.assertEqual(self.catalog.search('ADA')['items'][0]['id'], other['id'])
        self.assertNotIn(third['id'], [p['id'] for p in self.catalog.search()['items']])
        for limit, offset in [(0, 0), (101, 0), (20, -1), (20, 100001), ('20', 0)]:
            with self.assertRaises(ValueError):
                self.catalog.search('', limit, offset)

    def test_requests_dedup_ownership_transitions_and_persistence(self):
        key = 'a' * 32
        other_key = 'b' * 32
        created = self.catalog.request_person('ＡＤＡ  Lovelace', '  mathematician ', key)
        rid = created['request']['id']
        self.assertTrue(created['created'])
        self.assertEqual(created['request']['status'], 'queued')
        duplicate = self.catalog.request_person('ada lovelace', 'MATHEMATICIAN', key)
        self.assertFalse(duplicate['created'])
        self.assertEqual(duplicate['request']['id'], rid)
        self.assertEqual(self.catalog.requests(other_key), [])
        different = self.catalog.request_person('ada lovelace', 'mathematician', other_key)
        self.assertNotEqual(different['request']['id'], rid)
        self.assertEqual(len(self.catalog.requests(key)), 1)
        self.assertNotIn(key, json.dumps(self.catalog.state()))
        stored = self.catalog.db.execute('SELECT client_hash FROM requests WHERE id=?', (rid,)).fetchone()[0]
        self.assertNotEqual(stored, key)
        with self.assertRaises(ValueError):
            self.catalog.update_request(rid, 'completed', person_id=self.pid)
        with self.assertRaises(ValueError):
            self.catalog.update_request(rid, 'not_found')
        self.catalog.update_request(rid, 'researching', 'Searching public feeds')
        self.catalog.update_request(rid, 'reviewing', 'Guest evidence found')
        self.catalog.import_feed('https://example.com/feed', self.pid)
        self.approve_all()
        completed = self.catalog.update_request(rid, 'completed', 'Verified', self.pid)['request']
        self.assertEqual(completed['person_id'], self.pid)
        reopened = self.catalog.update_request(rid, 'queued', 'Need another check')['request']
        self.assertEqual(reopened['person_id'], '')
        self.catalog.update_request(rid, 'not_found', 'No verified public appearance located')
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        persisted = self.catalog.requests(key)[0]
        self.assertEqual(persisted['status'], 'not_found')
        self.assertEqual(len(persisted['history']), 6)
        self.assertEqual(self.catalog.requests(other_key)[0]['status'], 'queued')
        for args in [('', '', key), ('a' * 201, '', key), ('Ada', 'b' * 1001, key), ('Ada', '', 'short')]:
            with self.assertRaises(ValueError):
                self.catalog.request_person(*args)

    def test_http_search_errors_and_request_auth_boundaries(self):
        Handler = make_handler(self.catalog, 'secret-token', 8765)
        def request(method, path, body=None, extra=None):
            handler = Handler.__new__(Handler)
            handler.path = path
            handler.headers = Message()
            handler.headers['Host'] = '127.0.0.1:8765'
            for k, v in (extra or {}).items():
                handler.headers[k] = v
            encoded = json.dumps(body or {}).encode()
            handler.headers['Content-Length'] = str(len(encoded))
            handler.rfile = io.BytesIO(encoded)
            handler.wfile = io.BytesIO()
            status = []
            handler.send_response = lambda code: status.append(code)
            handler.send_header = lambda *args: None
            handler.end_headers = lambda: None
            getattr(handler, 'do_' + method)()
            return status[0], json.loads(handler.wfile.getvalue())
        for path in ['/api/search?limit=no', '/api/search?offset=-1', '/api/search?q=a&q=b', '/api/search?bad=1', '/api/updates?after=no', '/api/updates?people=bad,id,', '/api/updates?limit=0', '/api/updates?after=1&after=2']:
            self.assertEqual(request('GET', path)[0], 400)
        self.assertEqual(request('GET', '/api/search')[0], 200)
        self.assertEqual(request('GET', '/api/requests')[0], 400)
        key = 'c' * 32
        response = request('POST', '/api/requests', dict(query='New person', client_key=key))
        self.assertEqual(response[0], 200)
        rid = response[1]['request']['id']
        self.assertEqual(request('GET', '/api/requests', extra={'X-Client-Key': key})[1]['requests'][0]['id'], rid)
        self.assertEqual(request('GET', '/api/requests', extra={'X-Client-Key': 'd'*32})[1]['requests'], [])
        self.assertEqual(request('POST', '/api/admin/request', dict(id=rid, status='researching'))[0], 401)
        self.assertEqual(request('POST', '/api/requests', dict(query='Other', client_key=key), {'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(request('POST', '/api/admin/request', dict(id=rid, status='researching'), {'Authorization': 'Bearer secret-token'})[0], 200)

    def test_approval_events_once_revoke_and_timestamp_kind(self):
        self.catalog.import_feed('https://example.com/feed', self.pid)
        first, second = self.catalog.state()['candidates']
        self.assertEqual(self.catalog.updates([self.pid])['items'], [])
        self.catalog.review(first['id'], 'approved', 'Guest verified')
        initial = self.catalog.updates([self.pid])
        self.assertEqual(len(initial['items']), 1)
        self.assertEqual(initial['items'][0]['kind'], 'backfill')
        self.assertEqual(initial['items'][0]['people'][0]['seq'], initial['items'][0]['seq'])
        cursor = initial['cursor']
        self.catalog.review(first['id'], 'approved', 'Better evidence')
        self.assertEqual(self.catalog.updates([self.pid], after=cursor)['items'], [])
        self.catalog.review(first['id'], 'rejected', 'Withdraw')
        self.assertEqual(self.catalog.updates([self.pid])['items'], [])
        self.catalog.review(first['id'], 'approved', 'Reconfirm')
        self.assertEqual(self.catalog.updates([self.pid], after=cursor)['items'], [])
        self.assertEqual(self.catalog.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], 1)
        data = json.loads(self.catalog.db.execute('SELECT data FROM candidates WHERE id=?', (second['id'],)).fetchone()[0])
        data['date'] = format_datetime(datetime.now(timezone.utc))
        with self.catalog.db:
            self.catalog.db.execute('UPDATE candidates SET data=? WHERE id=?', (json.dumps(data), second['id']))
        self.catalog.review(second['id'], 'approved', 'Recent guest')
        latest = self.catalog.updates([self.pid], after=cursor)
        self.assertEqual(len(latest['items']), 1)
        self.assertEqual(latest['items'][0]['kind'], 'new_release')
        self.assertEqual(self.catalog.updates()['latest_cursor'], latest['cursor'])
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        self.assertEqual(self.catalog.updates([self.pid])['latest_cursor'], latest['cursor'])

    def test_updates_multi_person_grouping_and_pagination(self):
        other = self.catalog.add_person(dict(name='Second participant', alias='Ada Lovelace', role='Writer'))
        self.catalog.import_feed('https://example.com/feed', self.pid)
        self.catalog.import_feed('https://example.com/feed', other['id'])
        self.approve_all()
        all_updates = self.catalog.updates([self.pid, other['id']])
        self.assertEqual(len(all_updates['items']), 2)
        for item in all_updates['items']:
            self.assertEqual({p['id'] for p in item['people']}, {self.pid, other['id']})
            self.assertEqual(item['seq'], max(p['seq'] for p in item['people']))
            self.assertTrue(item['episode']['evidence'])
        page = self.catalog.updates([self.pid, other['id']], limit=1)
        self.assertTrue(page['has_more'])
        next_page = self.catalog.updates([self.pid, other['id']], after=page['cursor'], limit=1)
        self.assertFalse(next_page['has_more'])
        self.assertNotEqual(page['items'][0]['id'], next_page['items'][0]['id'])
        self.assertEqual(next_page['cursor'], all_updates['latest_cursor'])
        # A single followed person receives only their own credit and cursor sequence.
        own = self.catalog.updates([self.pid])
        self.assertTrue(all(len(item['people']) == 1 for item in own['items']))
        self.assertEqual(self.catalog.updates(['unknown'])['items'], [])
        for args in [(['bad,id'], 0, 50), ([self.pid], -1, 50), ([self.pid], 0, 101)]:
            with self.assertRaises(ValueError):
                self.catalog.updates(*args)

    def test_events_migration_backfills_approved_once(self):
        self.catalog.import_feed('https://example.com/feed', self.pid)
        self.approve_all()
        with self.catalog.db:
            self.catalog.db.execute('DELETE FROM events')
            self.catalog.db.execute("DELETE FROM meta WHERE key='approval_events_v1'")
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        count = self.catalog.db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        self.assertEqual(count, 2)
        cursor = self.catalog.updates()['latest_cursor']
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        self.assertEqual(self.catalog.updates()['latest_cursor'], cursor)
        self.assertEqual(self.catalog.db.execute('SELECT COUNT(*) FROM events').fetchone()[0], count)

    def test_sources_refresh_recovery_and_review_gate(self):
        self.catalog.import_feed('https://example.com/feed', self.pid)
        source = self.catalog.sources()[0]
        self.assertEqual(len(self.catalog.sources()), 1)
        first_success = source['last_success_at']
        self.approve_all()
        cursor = self.catalog.updates()['latest_cursor']
        self.assertEqual(self.catalog.refresh_source(source['id'])['added'], 0)
        first_success = self.catalog.sources()[0]['last_success_at']
        self.assertEqual(self.catalog.updates()['latest_cursor'], cursor)
        def failing(_):
            raise ValueError('Fixture network failure')
        self.catalog.fetcher = failing
        with self.assertRaises(ValueError):
            self.catalog.refresh_source(source['id'])
        failed = self.catalog.sources()[0]
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['last_success_at'], first_success)
        self.assertIn('Fixture network failure', failed['error'])
        extra = b'<item><guid>new</guid><title>Ada Lovelace new interview</title><enclosure url="https://example.com/new.mp3"/></item>'
        self.catalog.fetcher = lambda _: FEED.replace(b'</channel>', extra + b'</channel>')
        self.assertEqual(self.catalog.refresh_source(source['id'])['added'], 1)
        self.assertEqual(len(self.catalog.people()[0]['episodes']), 2)
        self.assertEqual(self.catalog.updates()['latest_cursor'], cursor)
        new = next(c for c in self.catalog.state()['candidates'] if c['guid'] == 'new')
        self.assertEqual(new['status'], 'pending')
        self.catalog.review(new['id'], 'approved', 'Verified fixture appearance')
        self.assertEqual(len(self.catalog.updates([self.pid], cursor)['items']), 1)
        with self.assertRaises(ValueError):
            self.catalog.refresh_source('unknown')
        with self.catalog.db:
            self.catalog.db.execute("INSERT INTO runs(started_at,feed_url,person_id,status) VALUES('2026-01-01',?,?,'running')", ('https://example.com/feed', self.pid))
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        recovered = self.catalog.sources()[0]
        self.assertEqual(recovered['id'], source['id'])
        self.assertEqual(recovered['status'], 'failed')
        self.assertIn('中断', recovered['error'])
        self.assertEqual(recovered['attempts'], 5)

    def test_failed_run_persisted(self):
        self.catalog.fetcher = lambda _: b'not RSS'
        with self.assertRaises(ValueError):
            self.catalog.import_feed('https://example.com/rss', self.pid)
        run = self.catalog.state()['runs'][0]
        self.assertEqual(run['status'], 'failed')
        self.assertTrue(run['error'])
        self.assertTrue(run['finished_at'])
    def test_seed_id_and_review_survive_restart(self):
        seed = Path(self.tmp.name) / 'data.js'
        seed.write_text('window.PEOPLE = ' + json.dumps([dict(id='seed', name='Seed', show='Show', episodes=[dict(id='seed-1', title='Episode', audio='https://example.com/seed.mp3', source='https://example.com/seed')])]) + ';')
        self.catalog.db.close()
        self.catalog = Catalog(self.path, seed)
        self.assertEqual(next(p for p in self.catalog.people() if p['id']=='seed')['episodes'][0]['id'], 'seed-1')
        self.catalog.review('seed-1', 'rejected', 'invalid')
        self.catalog.db.close()
        self.catalog = Catalog(self.path, seed)
        self.assertEqual([p for p in self.catalog.people() if p['id']=='seed'], [])
    def test_entity_and_private_targets_rejected(self):
        with self.assertRaises(ValueError):
            parse_feed(b'<!DOCTYPE rss [<!ENTITY e "x">]><rss/>')
        with self.assertRaises(ValueError):
            parse_feed('<!DOCTYPE rss [<!ENTITY e "x">]><rss/>'.encode('utf-16'))
        for url in ['file:///etc/passwd', 'http://127.0.0.1/a', 'http://[::1]/a', 'http://169.254.169.254/a']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                public_target(url)
        with patch('server.socket.getaddrinfo', return_value=[(2, 1, 6, '', ('10.0.0.3', 80))]):
            with self.assertRaises(ValueError):
                public_target('https://example.com')

if __name__ == '__main__':
    unittest.main()
