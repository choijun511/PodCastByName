import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from server import Catalog
import ai_review

class AIReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'db';self.c=Catalog(self.path)
        self.env=patch.dict('os.environ',{'OPENAI_API_KEY':'','TINGSHUI_AI_MODEL':'','TINGSHUI_RULE_FEEDS':'[]','TINGSHUI_AI_DAILY_CALLS':'20'});self.env.start()
    def tearDown(self):self.c.db.close();self.env.stop();self.temp.cleanup()
    def person(self,name='Ada Lovelace',role='Mathematician'):return self.c.add_person({'name':name,'role':role})
    def candidate(self,p,cid,text,title='Conversation'):
        with self.c.db:self.c.db.execute('INSERT INTO candidates VALUES(?,?,?,?,?,?,?)',(cid,p['id'],'https://example.com/rss',cid,json.dumps({'title':title,'description':text,'source':'https://example.com/episode','audio':'https://example.com/'+cid+'.mp3'}),'pending',''))
    def participant(self,name,text):return {'name':name,'role':'guest','confidence':.98,'quote':text}
    def test_unconfigured_does_not_call_and_fabricated_quote_defers(self):
        p=self.person();text='Mathematician Ada Lovelace joins us for an interview.';self.candidate(p,'a',text)
        self.assertFalse(ai_review.review_pending(self.c)['configured'])
        result=ai_review.review_pending(self.c,lambda *_:{'participants':[self.participant(p['name'],'Invented Mathematician Ada Lovelace interview')]})
        self.assertEqual(result['deferred'],1);self.assertEqual(self.c.people(),[])
        self.assertEqual(ai_review.review_pending(self.c,lambda *_:self.fail('must not re-call'))['approved'],0)
    def test_one_extraction_shared_and_persisted_across_people_at_budget_cap(self):
        ada=self.person();alan=self.person('Alan Turing','Mathematician')
        text='Mathematicians Ada Lovelace and Alan Turing join us for an interview.'
        self.candidate(ada,'a',text);self.candidate(alan,'b',text)
        response={'participants':[self.participant(p['name'],text) for p in (ada,alan)]}
        with patch.dict('os.environ',{'TINGSHUI_AI_DAILY_CALLS':'1'}):
            judge=unittest.mock.Mock(return_value=response)
            result=ai_review.review_pending(self.c,judge,limit=1);self.assertEqual(result['approved'],1)
            self.c.db.close();self.c=Catalog(self.path)
            result=ai_review.review_pending(self.c,judge)
            self.assertEqual(result['approved'],1);self.assertEqual(result['cache_hits'],1);self.assertEqual(judge.call_count,1)
            self.assertEqual(ai_review.budget(self.c.db)['used'],1)
    def test_namesake_does_not_publish(self):
        p=self.person();self.person('Ada Lovelace','Author')
        text='Mathematician Ada Lovelace joins us for an interview.';self.candidate(p,'a',text)
        result=ai_review.review_pending(self.c,lambda *_:{'participants':[self.participant(p['name'],text)]})
        self.assertEqual(result['deferred'],1);self.assertEqual(self.c.people(),[])
    def test_daily_cap_errors_count_and_other_items_stay_pending(self):
        p=self.person();self.candidate(p,'a','Mathematician Ada Lovelace joins us.');self.candidate(p,'b','Another interview with Mathematician Ada Lovelace.')
        with patch.dict('os.environ',{'TINGSHUI_AI_DAILY_CALLS':'1'}):
            judge=unittest.mock.Mock(side_effect=ValueError('failure'))
            result=ai_review.review_pending(self.c,judge)
            self.assertEqual(result['errors'],1);self.assertEqual(judge.call_count,1)
            self.assertEqual(ai_review.budget(self.c.db)['remaining'],0);self.assertEqual(self.c.people(),[])
    def test_rules_work_without_key_or_model_budget(self):
        p=self.person();text='Guest: Ada Lovelace, Mathematician';self.candidate(p,'a',text)
        with patch.dict('os.environ',{'TINGSHUI_RULE_FEEDS':'["https://example.com/rss"]','TINGSHUI_AI_DAILY_CALLS':'0'}):
            result=ai_review.review_pending(self.c)
            self.assertEqual(result['rule_approved'],1);self.assertEqual(ai_review.budget(self.c.db)['used'],0)
    def test_demand_priority_and_no_raw_search_stored(self):
        p=self.person();other=self.person('Alan Turing','Mathematician')
        self.candidate(p,'a','Mathematician Ada Lovelace joins us.');self.candidate(other,'b','Mathematician Alan Turing joins us.')
        self.c.search('Alan Turing')
        with patch.dict('os.environ',{'TINGSHUI_AI_DAILY_CALLS':'1'}):
            judge=unittest.mock.Mock(return_value={'participants':[]});ai_review.review_pending(self.c,judge)
            self.assertIn('Alan Turing',judge.call_args[0][0]['description'])
            self.assertEqual(self.c.db.execute('SELECT person_id FROM intake_demand').fetchone()[0],other['id'])
    def test_mere_mention_extraction_empty_does_not_publish(self):
        p=self.person();self.candidate(p,'a','We discuss the work of Mathematician Ada Lovelace without a guest.')
        self.assertEqual(ai_review.review_pending(self.c,lambda *_:{'participants':[]})['deferred'],1)
        self.assertEqual(self.c.people(),[])

if __name__=='__main__':unittest.main()
