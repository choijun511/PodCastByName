"""Conservative, versioned guest-line gate. No feed is trusted by default.

Only explicitly allowlisted RSS templates can approve; other cases are either
clear non-appearances (defer) or require model evaluation (model).
"""
from html.parser import HTMLParser
import json
import os
import re

VERSION = 'rule-v1'
GENERIC_ROLES = {'科技', '文学', '商业', '文化', '艺术', '科学', '教育', '体育', '娱乐', '音乐', '社会', '历史', '经济', '政治', '健康', '生活', '人物', '嘉宾', 'technology', 'literature', 'business', 'culture', 'guest'}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        if tag in ('br', 'p', 'div', 'li', 'section', 'h1', 'h2', 'h3'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)
        if tag in ('p', 'div', 'li', 'section', 'h1', 'h2', 'h3'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _result(decision, code, reason, quote=''):
    return dict(decision=decision, quote=quote, reason=f'{VERSION}:{code} {reason}')


def _templates(explicit):
    if explicit is None:
        try:
            explicit = json.loads(os.environ.get('TINGSHUI_RULE_FEEDS', '[]'))
        except (TypeError, ValueError):
            explicit = []
    if not isinstance(explicit, (list, tuple, set)) or any(not isinstance(url, str) for url in explicit):
        return set()
    return set(explicit)


def evaluate(episode, person, feed_url, templates=None):
    """Return {decision,quote,reason}; approval quote is verbatim source text.

    Feed URLs are compared exactly, without normalization or prefix matching.
    No inferred identity, fuzzy alias matching, or title-only guest inference.
    """
    description = episode.get('description', '')
    if not isinstance(description, str):
        return _result('model', 'invalid-description', '缺少可核验的原始简介')
    parser = _Text()
    try:
        parser.feed(description)
        plain = ''.join(parser.parts)
    except Exception:
        return _result('model', 'html-parse', '简介格式无法可靠读取')
    names = [person.get('name', '')]
    aliases = person.get('alias', '')
    if isinstance(aliases, str):
        names.extend(re.split(r'[,，;；|/]', aliases))
    names = [n.strip() for n in names if isinstance(n, str) and n.strip()]
    if not names:
        return _result('model', 'missing-name', '缺少完整姓名')

    # Explicit non-participation is sufficient to defer. Never infer absence
    # from a title/topic mention or generic episode language.
    if re.search(r'本期\s*(?:没有|无)\s*嘉宾|\bno\s+guests?\s+(?:in|on|for)\s+this\s+episode\b', plain, re.I):
        return _result('defer', 'no-guest', '简介明确声明本期没有嘉宾')
    for line in plain.splitlines():
        if not any(name.casefold() in line.casefold() for name in names):
            continue
        if re.search(r'未(?:曾)?(?:出席|参与|参加|做客)|没有(?:出席|参与|参加|做客)|并非(?:本期)?嘉宾|不是(?:本期)?嘉宾|did\s+not\s+(?:appear|participate|join)|not\s+(?:our\s+|a\s+)?guest', line, re.I):
            return _result('defer', 'negated-appearance', '人物同一行明确否认参与')
        if re.search(r'档案(?:音频|录音|片段)|历史录音|旧采访片段|(?:采访|演讲|录音|音频)片段|模仿(?:者|秀|声音)?|冒充|声音克隆|AI\s*(?:配音|合成)|archival\s+(?:clip|audio|recording)|archive\s+(?:clip|audio|recording)|impersonat(?:ion|or|ing)|voice\s+clone|(?:speech|interview|audio)\s+clips?', line, re.I):
            return _result('defer', 'non-live-source', '人物同一行标记为历史片段或模仿内容')
    if feed_url not in _templates(templates):
        return _result('model', 'unvalidated-feed', 'RSS 尚无已验证的嘉宾行模板')

    roles = person.get('role', '')
    roles = [r.strip() for r in re.split(r'[·/|｜,，;；]', roles)] if isinstance(roles, str) else []
    roles = [r for r in roles if len(r) >= 2 and r.casefold() not in GENERIC_ROLES]
    if not roles:
        return _result('model', 'missing-identity', '没有足够具体的身份用于同名辨认')

    for line in plain.splitlines():
        line = line.strip()
        match = re.fullmatch(r'(?:本期嘉宾\s*[:：]|Guest\s*:)\s*([^,，]+)[,，]\s*(.+)', line, re.I)
        if not match:
            continue
        name, identity = match.groups()
        if name.strip() not in names:
            continue
        if re.search(r'不是|并非|不是真正|非本人|未到场|未出席|\bnot\b|\babsent\b', identity, re.I):
            return _result('defer', 'negated-guest-identity', '嘉宾行身份或出场包含明确否定')
        if not any(role in identity for role in roles):
            continue
        # HTML/entity manipulation must not manufacture an evidence quotation.
        if line not in description:
            return _result('model', 'noncontiguous-quote', '嘉宾行经 HTML 处理后无法逐字引用原始简介')
        return _result('approve', 'explicit-guest-identity', '已验证 RSS 模板中完整姓名及具体身份同时命中', line)
    return _result('model', 'ambiguous-guest-line', '未找到完整姓名及身份都明确匹配的嘉宾行')
