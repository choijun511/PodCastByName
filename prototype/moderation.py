"""Device-scoped community appearance votes for the local catalog prototype.

A device key is a bearer capability, not a verified person identity: users can
reset/create devices. The quorum is a reversible moderation aid, not Sybil-proof.
"""
from datetime import datetime, timedelta, timezone

THRESHOLD = 3
DAILY_NEW_VOTES = 20


def setup(db):
    """Create additive tables; candidate editorial status is never modified."""
    db.executescript('''
    CREATE TABLE IF NOT EXISTS votes(
        candidate_id TEXT NOT NULL,
        client_hash TEXT NOT NULL,
        value TEXT NOT NULL CHECK(value IN ('yes','no')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id,client_hash)
    );
    CREATE INDEX IF NOT EXISTS votes_client_created ON votes(client_hash,created_at);
    CREATE TABLE IF NOT EXISTS community_hidden(
        candidate_id TEXT PRIMARY KEY,
        hidden_at TEXT NOT NULL
    );
    ''')


def _hash(key):
    # Lazy import avoids import cycles when the server wires these functions in.
    from server import client_hash
    return client_hash(key)


def _candidate(db, cid):
    if not isinstance(cid, str) or not cid or len(cid) > 200:
        raise ValueError('无效的出场 ID')
    candidate = db.execute('SELECT status FROM candidates WHERE id=?', (cid,)).fetchone()
    hidden = db.execute('SELECT 1 FROM community_hidden WHERE candidate_id=?', (cid,)).fetchone()
    if not candidate or (candidate[0] != 'approved' and not hidden):
        raise ValueError('仅可评价已发布或因社区反馈隐藏的出场')
    return bool(hidden)


def _summary(db, cid, hashed=None):
    counts = dict(db.execute('SELECT value,COUNT(*) FROM votes WHERE candidate_id=? GROUP BY value', (cid,)).fetchall())
    yes, no = counts.get('yes', 0), counts.get('no', 0)
    mine = None
    if hashed:
        row = db.execute('SELECT value FROM votes WHERE candidate_id=? AND client_hash=?', (cid, hashed)).fetchone()
        mine = row[0] if row else None
    return dict(yes=yes, no=no, total=yes+no,
                hidden=bool(db.execute('SELECT 1 FROM community_hidden WHERE candidate_id=?', (cid,)).fetchone()),
                mine=mine, threshold=THRESHOLD)


def summary(catalog, cid, key=None):
    """Return aggregate counts and optionally the caller's own vote only."""
    hashed = _hash(key) if key is not None else None
    _candidate(catalog.db, cid)
    return _summary(catalog.db, cid, hashed)


def vote(catalog, cid, value, key):
    """Upsert one vote/device; quorum hides only this candidate relation.

    New distinct-candidate votes are limited to 20/device over a rolling 24 hours.
    Changes and repeated votes remain allowed and do not consume more allowance.
    Once hidden, later vote changes cannot automatically restore the relation.
    """
    if value not in ('yes', 'no'):
        raise ValueError('评价必须是 yes 或 no')
    hashed = _hash(key)
    db = catalog.db
    stamp = datetime.now(timezone.utc)
    # IMMEDIATE serializes quota checks and quorum changes across DB connections.
    # A SAVEPOINT also makes this operation composable in an existing transaction.
    outer = db.in_transaction
    if not outer:
        db.execute('BEGIN IMMEDIATE')
    db.execute('SAVEPOINT community_vote')
    try:
        _candidate(db, cid)
        existing = db.execute('SELECT 1 FROM votes WHERE candidate_id=? AND client_hash=?', (cid, hashed)).fetchone()
        if not existing:
            recent = db.execute('SELECT COUNT(*) FROM votes WHERE client_hash=? AND created_at>=?',
                                (hashed, (stamp-timedelta(hours=24)).isoformat())).fetchone()[0]
            if recent >= DAILY_NEW_VOTES:
                raise ValueError('此设备 24 小时内最多评价 20 条新出场，请稍后再试')
        db.execute('''INSERT INTO votes(candidate_id,client_hash,value,created_at,updated_at)
                      VALUES(?,?,?,?,?) ON CONFLICT(candidate_id,client_hash)
                      DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at''',
                   (cid, hashed, value, stamp.isoformat(), stamp.isoformat()))
        result = _summary(db, cid, hashed)
        if result['no'] >= THRESHOLD and result['no'] * 3 >= result['total'] * 2:
            db.execute('INSERT OR IGNORE INTO community_hidden(candidate_id,hidden_at) VALUES(?,?)', (cid, stamp.isoformat()))
            result['hidden'] = True
        db.execute('RELEASE community_vote')
        if not outer:
            db.commit()
        return result
    except BaseException:
        db.execute('ROLLBACK TO community_vote')
        db.execute('RELEASE community_vote')
        if not outer:
            db.rollback()
        raise
