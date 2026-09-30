import json
import tempfile
import threading
import unittest
from datetime import datetime,timezone,timedelta
from pathlib import Path
from unittest.mock import patch
import ai_review
from server import Catalog

class AIWorkerTests(unittest.TestCase):
    def fixture(self,path):
        c=Catalog(path);p=c.add_person({'name':'Ada Lovelace','role':'Mathematician'})
        title='Mathematician Ada Lovelace joins us for an interview.'
        with c.db:c.db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)',('test',p['id'],'https://example.com/rss','test',json.dumps({'title':title,'description':title}),'pending',''))
        return c,{'participants':[dict(name='Ada Lovelace',confidence=.99,role='guest',quote=title)]}

    def test_slow_worker_keeps_db_available_and_obeys_withdrawal(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'db';c,good=self.fixture(path)
            started=threading.Event();release=threading.Event()
            def judge(*args):
                started.set();release.wait(3);return good
            with patch.object(ai_review,'configured',return_value=True),patch.object(ai_review,'ask',side_effect=judge):
                stop,worker=ai_review.start_worker(lambda:Catalog(path,recover=False))
                try:
                    self.assertTrue(started.wait(2))
                    self.assertEqual(c.people(),[])
                    c.review('test','rejected','Wrong person found while model waited')
                    release.set();stop.set();ai_review.WAKE.set();worker.join(3)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(c.db.execute("SELECT status FROM candidates WHERE id='test'").fetchone()[0],'rejected')
                    self.assertEqual(c.people(),[])
                    self.assertEqual(ai_review.runtime(c.db)['status'],'stopped')
                finally:
                    release.set();stop.set();ai_review.WAKE.set();worker.join(3);c.db.close()

    def test_retry_backoff_and_ceiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            c,_=self.fixture(Path(tmp)/'db')
            stamp=datetime.now(timezone.utc).isoformat()
            def add_error(at):
                with c.db:c.db.execute('INSERT INTO ai_reviews(candidate_id,fingerprint,created_at,outcome) VALUES(?,?,?,?)',('test','hash',at,'error'))
            add_error(stamp)
            self.assertFalse(ai_review.eligible(c.db,'test','hash'))
            old=(datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat()
            with c.db:c.db.execute('UPDATE ai_reviews SET created_at=?',(old,))
            self.assertTrue(ai_review.eligible(c.db,'test','hash'))
            add_error(old);add_error(old)
            self.assertFalse(ai_review.eligible(c.db,'test','hash'))
            self.assertTrue(ai_review.eligible(c.db,'test','new-content'))
            c.db.close()

if __name__=='__main__':unittest.main()
