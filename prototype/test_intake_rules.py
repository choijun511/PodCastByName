import os
import unittest
from unittest.mock import patch
from intake_rules import evaluate

FEED = 'https://example.com/feed.xml'
PERSON = dict(name='黄仁勋', alias='Jensen Huang|黃仁勳', role='科技 · NVIDIA 创始人')

class IntakeRulesTests(unittest.TestCase):
    def evaluate(self, description, person=PERSON, templates=None, **episode):
        return evaluate(dict(description=description, **episode), person, FEED, [FEED] if templates is None else templates)

    def test_exact_guest_and_identity_approve_with_original_quote(self):
        line = '本期嘉宾：黄仁勋，NVIDIA 创始人，谈领导力'
        result = self.evaluate('节目简介\n' + line + '\n欢迎收听')
        self.assertEqual(result['decision'], 'approve')
        self.assertEqual(result['quote'], line)
        self.assertTrue(result['reason'].startswith('rule-v1:'))
        english = self.evaluate('Guest: Jensen Huang, NVIDIA 创始人')
        self.assertEqual(english['decision'], 'approve')

    def test_title_mention_unknown_template_and_namesake_need_model(self):
        self.assertEqual(self.evaluate('今天讨论黄仁勋的观点', title='采访黄仁勋')['decision'], 'model')
        self.assertEqual(self.evaluate('本期嘉宾：黄仁勋，NVIDIA 创始人', templates=[])['decision'], 'model')
        self.assertEqual(self.evaluate('本期嘉宾：黄仁勋先生，NVIDIA 创始人')['decision'], 'model')
        self.assertEqual(self.evaluate('本期嘉宾：黄仁勋，音乐人')['decision'], 'model')
        self.assertEqual(self.evaluate('本期嘉宾：黄仁勋，科技', person=dict(name='黄仁勋', role='科技'))['decision'], 'model')
        self.assertEqual(self.evaluate('本期嘉宾：黄仁勋，NVIDIA 创始人', templates=[FEED+'/other'])['decision'], 'model')

    def test_clips_impersonation_and_negation_defer(self):
        for text in ['本期没有嘉宾，我们讨论黄仁勋', '本期嘉宾：黄仁勋，NVIDIA 创始人（历史录音）',
                     '黄仁勋并非本期嘉宾', '本期嘉宾：黄仁勋，并非 NVIDIA 创始人', 'Guest: Jensen Huang, NVIDIA 创始人, archival clip',
                     'Guest: Jensen Huang, NVIDIA 创始人 impersonator', '黄仁勋没有参加，本期由主持人讨论']:
            with self.subTest(text=text):
                self.assertEqual(self.evaluate(text)['decision'], 'defer')
        self.assertEqual(self.evaluate('黄仁勋讲述没有参加某次会议的经历')['decision'], 'defer')
        self.assertEqual(self.evaluate('本期嘉宾：黄仁勋，NVIDIA 创始人', title='没有嘉宾的时代')['decision'], 'approve')

    def test_html_does_not_invent_quote(self):
        original = '<p>本期嘉宾：黄仁勋，NVIDIA 创始人</p>'
        result = self.evaluate(original)
        self.assertEqual(result['decision'], 'approve')
        self.assertIn(result['quote'], original)
        self.assertEqual(self.evaluate('<p>本期嘉宾：<b>黄仁勋</b>，NVIDIA 创始人</p>')['decision'], 'model')
        self.assertEqual(self.evaluate('Guest: Jensen Huang, NVIDIA&#32;创始人')['decision'], 'model')
        self.assertEqual(self.evaluate('<script>本期嘉宾：黄仁勋，NVIDIA 创始人</script>')['decision'], 'model')

    def test_default_empty_allowlist_and_environment(self):
        episode = dict(description='本期嘉宾：黄仁勋，NVIDIA 创始人')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(evaluate(episode, PERSON, FEED)['decision'], 'model')
        with patch.dict(os.environ, {'TINGSHUI_RULE_FEEDS':'["https://example.com/feed.xml"]'}):
            self.assertEqual(evaluate(episode, PERSON, FEED)['decision'], 'approve')
        with patch.dict(os.environ, {'TINGSHUI_RULE_FEEDS':'invalid'}):
            self.assertEqual(evaluate(episode, PERSON, FEED)['decision'], 'model')

if __name__ == '__main__':
    unittest.main()
