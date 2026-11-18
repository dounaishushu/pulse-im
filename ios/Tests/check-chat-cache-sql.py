"""Exercise the shipping snapshot SQL with SQLite, independent of Swift/UIKit.

This validates large snapshot deletion, isolation and transaction rollback. It
does not execute Swift, encryption, Keychain or the iOS view lifecycle.
"""
import json
from pathlib import Path
import re
import sqlite3

root = Path(__file__).resolve().parents[2]
source = (root / 'ios/PulseIM/LocalChatStore.swift').read_text(encoding='utf-8')
queries = re.findall(r'execute\("([^"\n]+)"', source)
create = next(q for q in queries if q.startswith('CREATE TEMP TABLE IF NOT EXISTS incoming_snapshot_ids'))
insert = next(q for q in queries if q.startswith('INSERT OR IGNORE INTO incoming_snapshot_ids'))
clear = next(q for q in queries if q == 'DELETE FROM incoming_snapshot_ids')
reconcile = next(q for q in queries if q.startswith('UPDATE messages SET removed=1') and 'incoming_snapshot_ids' in q)
checks = []
for count in [0, 50, 500, 501, 1000, 5000]:
    db = sqlite3.connect(':memory:')
    db.execute('CREATE TABLE messages(scope TEXT,cid INTEGER,id INTEGER,edited TEXT,removed INTEGER,rev INTEGER,data BLOB,PRIMARY KEY(scope,cid,id))')
    upper = count + 10
    for scope, cid in [('owner', 1), ('other-account', 1), ('owner', 2)]:
        db.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?,?)',
                       [(scope, cid, n, '1', 0, 1, b'ciphertext') for n in range(1, upper + 1)])
    # This event arrived after the snapshot ticket; an older snapshot cannot erase it.
    late = count + 3
    db.execute('UPDATE messages SET rev=11 WHERE scope=? AND cid=? AND id=?', ('owner', 1, late))
    received = set(range(1, count + 1))
    if count > 10:
        db.execute('UPDATE messages SET removed=1,data=NULL WHERE scope=? AND cid=? AND id=?', ('owner', 1, 20))
    db.commit()
    before = list(db.execute('SELECT * FROM messages ORDER BY scope,cid,id'))
    db.execute('BEGIN IMMEDIATE')
    db.execute(create)
    db.execute(clear)
    db.executemany(insert, [(n,) for n in sorted(received)])
    if received:
        db.execute(insert, (min(received),))  # repeated IDs cannot break a snapshot
    db.execute(reconcile, (12, 'owner', 1, 1, upper, 10))
    db.execute(clear)
    for n, removed, rev, data in db.execute('SELECT id,removed,rev,data FROM messages WHERE scope=? AND cid=?', ('owner', 1)):
        if n in received or n == late:
            assert removed == (1 if n == 20 and count > 10 else 0), (count, n, 'received row removed')
        else:
            assert removed == 1 and data is None and rev == 12, (count, n, 'missing row retained')
    assert db.execute('SELECT COUNT(*) FROM messages WHERE scope=? AND removed=1', ('other-account',)).fetchone()[0] == 0
    assert db.execute('SELECT COUNT(*) FROM messages WHERE scope=? AND cid=? AND removed=1', ('owner', 2)).fetchone()[0] == 0
    db.rollback()
    assert list(db.execute('SELECT * FROM messages ORDER BY scope,cid,id')) == before
    db.close()
    checks.append({'snapshot_input_count': len(received), 'passed': ['received rows preserved', 'missing rows tombstoned', 'newer events protected', 'account/conversation isolation', 'rollback atomicity']})
print(json.dumps({'result': 'passed', 'scope': 'actual snapshot SQL; not a Swift or iPhone runtime test', 'cases': checks}, indent=2))
