"""Read public feeds and probe a bounded audio range; does not prove browser playback."""
import concurrent.futures, datetime, json, urllib.request, xml.etree.ElementTree as ET
from pathlib import Path
SOURCES = [
 ('黄仁勋', 'https://lexfridman.com/feed/podcast/', 'Jensen Huang'),
 ('刘震云', 'https://feed.xyzfm.space/mcklbwxjdvfu', '刘震云'),
 ('Ocean Vuong', 'https://feeds.simplecast.com/AuAxH_Bf', 'Ocean Vuong'),
]
def check(source):
 person, feed, term = source
 result = {'person': person, 'feed': feed, 'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'episodes': []}
 try:
  with urllib.request.urlopen(feed, timeout=25) as response:
   root = ET.fromstring(response.read())
  result['show'] = root.findtext('./channel/title')
  for item in root.findall('./channel/item'):
   if term.lower() not in (item.findtext('title') or '').lower(): continue
   enclosure = item.find('enclosure')
   entry = {'title': item.findtext('title'), 'guid': item.findtext('guid'), 'published': item.findtext('pubDate'), 'link': item.findtext('link'), 'audio': enclosure.attrib if enclosure is not None else None}
   if len(result['episodes']) < 2 and enclosure is not None:
    try:
     req = urllib.request.Request(enclosure.get('url'), headers={'Range': 'bytes=0-1023'})
     with urllib.request.urlopen(req, timeout=20) as response:
      entry['probe'] = {'status': response.status, 'content_type': response.headers.get('Content-Type'), 'content_range': response.headers.get('Content-Range'), 'bytes_read': len(response.read(1024))}
    except Exception as exc: entry['probe'] = {'error': str(exc)}
   result['episodes'].append(entry)
 except Exception as exc: result['error'] = str(exc)
 return result
if __name__ == '__main__':
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
  results = list(pool.map(check, SOURCES))
 Path(__file__).with_name('feed-check.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
 for result in results:
  print(json.dumps(result, ensure_ascii=False))
