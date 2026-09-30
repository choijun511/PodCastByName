import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from server import Catalog
from moderation import setup, vote, summary


class ModerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'catalog.sqlite'
        self.catalog = Catalog(self.path)
        setup(self.catalog.db)
        self.pid = self.catalog.add_person(dict(name='Guest', role='Writer'))['id']
        with self.catalog.db:
            for index in range(24):
                self.catalog.db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)',
                    (f'ep-{index}', self.pid, '', str(index), json.dumps(dict(title='Same release', audio='https://example.com/audio.mp3')), 'approved', 'verified'))
            for status in ('pending', 'rejected'):
                self.catalog.db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)',
                    (status, self.pid, '', status, '{}', status, ''))

    def tearDown(self):
        self.catalog.db.close()
        self.tmp.cleanup()

    def key(self, index):
        return f'device-{index:032d}'

    def test_duplicate_change_and_private_summary(self):
        first = vote(self.catalog, 'ep-0', 'no', self.key(1))
        second = vote(self.catalog, 'ep-0', 'no', self.key(1))
        self.assertEqual(first, second)
        changed = vote(self.catalog, 'ep-0', 'yes', self.key(1))
        self.assertEqual(changed, dict(yes=1, no=0, total=1, hidden=False, mine='yes', threshold=3))
        self.assertIsNone(summary(self.catalog, 'ep-0')['mine'])
        self.assertIsNone(summary(self.catalog, 'ep-0', self.key(2))['mine'])
        self.assertEqual(summary(self.catalog, 'ep-0', self.key(1))['mine'], 'yes')
        self.assertNotIn(self.key(1), json.dumps(summary(self.catalog, 'ep-0', self.key(1))))
        stored = self.catalog.db.execute('SELECT client_hash FROM votes').fetchone()[0]
        self.assertNotEqual(stored, self.key(1))

    def test_quorum_ratio_sticky_hidden_and_relation_isolation(self):
        for index in (1, 2):
            self.assertFalse(vote(self.catalog, 'ep-0', 'no', self.key(index))['hidden'])
        for index in (3, 4, 5):
            vote(self.catalog, 'ep-0', 'yes', self.key(index))
        self.assertFalse(vote(self.catalog, 'ep-0', 'no', self.key(6))['hidden']) # 3 of 6
        self.assertFalse(vote(self.catalog, 'ep-0', 'no', self.key(7))['hidden']) # 4 of 7
        hidden = vote(self.catalog, 'ep-0', 'no', self.key(3)) # 5 of 7
        self.assertTrue(hidden['hidden'])
        for index in (1, 2, 3, 6, 7):
            self.assertTrue(vote(self.catalog, 'ep-0', 'yes', self.key(index))['hidden'])
        self.assertEqual(summary(self.catalog, 'ep-0')['no'], 0)
        self.assertFalse(summary(self.catalog, 'ep-1')['hidden'])
        self.assertEqual(self.catalog.db.execute("SELECT status FROM candidates WHERE id='ep-0'").fetchone()[0], 'approved')
        hidden_at = self.catalog.db.execute("SELECT hidden_at FROM community_hidden WHERE candidate_id='ep-0'").fetchone()[0]
        self.catalog.db.close()
        self.catalog = Catalog(self.path)
        setup(self.catalog.db)
        self.assertTrue(summary(self.catalog, 'ep-0')['hidden'])
        self.assertEqual(self.catalog.db.execute("SELECT hidden_at FROM community_hidden WHERE candidate_id='ep-0'").fetchone()[0], hidden_at)

    def test_minimum_three_no_and_existing_hidden_can_change(self):
        for index in (1, 2, 3):
            result = vote(self.catalog, 'ep-0', 'no', self.key(index))
        self.assertTrue(result['hidden'])
        with self.catalog.db:
            self.catalog.db.execute("UPDATE candidates SET status='rejected' WHERE id='ep-0'")
        self.assertTrue(vote(self.catalog, 'ep-0', 'yes', self.key(1))['hidden'])
        for cid in ('missing', 'pending', 'rejected'):
            with self.assertRaises(ValueError):
                vote(self.catalog, cid, 'yes', self.key(1))
        self.assertEqual(self.catalog.db.execute('SELECT COUNT(*) FROM votes').fetchone()[0], 3)

    def test_rolling_new_vote_limit_and_changes_do_not_consume_quota(self):
        for index in range(20):
            vote(self.catalog, f'ep-{index}', 'yes', self.key(1))
        with self.assertRaises(ValueError):
            vote(self.catalog, 'ep-20', 'yes', self.key(1))
        self.assertEqual(vote(self.catalog, 'ep-0', 'no', self.key(1))['mine'], 'no')
        self.assertEqual(vote(self.catalog, 'ep-20', 'yes', self.key(2))['mine'], 'yes')
        with self.catalog.db:
            self.catalog.db.execute("UPDATE votes SET created_at=? WHERE candidate_id='ep-0'", ((datetime.now(timezone.utc)-timedelta(hours=25)).isoformat(),))
        self.assertEqual(vote(self.catalog, 'ep-20', 'yes', self.key(1))['total'], 2)
        self.assertEqual(self.catalog.db.execute('SELECT COUNT(*) FROM votes').fetchone()[0], 22)

    def test_invalid_input_and_outer_transaction_preserved(self):
        for value, key in [('maybe', self.key(1)), ('yes', 'short')]:
            with self.assertRaises(ValueError):
                vote(self.catalog, 'ep-0', value, key)
        self.catalog.db.execute('BEGIN')
        vote(self.catalog, 'ep-0', 'yes', self.key(1))
        self.assertTrue(self.catalog.db.in_transaction)
        self.catalog.db.rollback()
        self.assertEqual(summary(self.catalog, 'ep-0')['total'], 0)


if __name__ == '__main__':
    unittest.main()
