"""Isolated synthetic fixtures for check-updates.cjs; never uses the main DB."""
import sys, tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from server import Catalog,make_handler,HTTPServer
temporary=tempfile.TemporaryDirectory(prefix='tingshui-updates-')
path=Path(temporary.name)/'catalog.sqlite3'
c=Catalog(path,Path(__file__).resolve().parent/'dist'/'data.js')
feed=b'''<rss><channel><title>Update test only</title><language>en</language><item><guid>updates-fixture</guid><title>Jensen Huang and Liu Zhenyun test interview</title><description>Jensen Huang and Liu Zhenyun join this isolated fixture.</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><link>https://example.com/updates-fixture</link><enclosure url="https://example.com/updates-fixture.mp3"/></item></channel></rss>'''
c.fetcher=lambda _:feed
c.import_feed('https://example.com/fixture','jensen')
c.import_feed('https://example.com/fixture','liu')
server=HTTPServer(('127.0.0.1',18765),make_handler(c,Path('/tmp/tingshui-admin-token').read_text(),18765))
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
    c.db.close()
    temporary.cleanup()
