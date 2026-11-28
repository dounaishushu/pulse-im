"""Exercise the shipping snapshot SQL with SQLite, independent of Swift/UIKit.

This validates large snapshot deletion, isolation and transaction rollback. It
does not execute Swift, encryption, Keychain or the iOS view lifecycle.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-root', type=Path, default=root)
source_root = parser.parse_args().source_root
source = (source_root / 'ios/PulseIM/LocalChatStore.swift').read_text(encoding='utf-8')
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

# Reproduce a completed HTTP snapshot racing with newer messages already on
# disk. Use the upper-bound argument actually wired by the shipping view.
view = (source_root / 'ios/PulseIM/ChatView.swift').read_text(encoding='utf-8')
call = re.search(r'merge\(localTicket, items: rows, floor: floor, maximum: ([\w.]+), cutoff: cutoff\)', view)
assert call, 'snapshot cache merge call was not found'
argument = call.group(1)
if argument == 'Int.max':
    snapshot_maximum = 2**63 - 1
else:
    assert re.search(r'let\s+' + re.escape(argument) + r'\s*=\s*snapshot\s*\?\?\s*0\b', view), 'snapshot cache upper boundary is not captured from HTTP'
    snapshot_maximum = 20

db = sqlite3.connect(':memory:')
db.execute('CREATE TABLE messages(scope TEXT,cid INTEGER,id INTEGER,edited TEXT,removed INTEGER,rev INTEGER,data BLOB,PRIMARY KEY(scope,cid,id))')
for scope, cid in [('owner', 1), ('other-account', 1), ('owner', 2)]:
    db.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?,?)',
                   [(scope, cid, n, '1', 0, 1, b'ciphertext') for n in [5, 10, 15, 20, 21, 25]])
db.commit()
db.execute('BEGIN IMMEDIATE')
db.execute(create)
db.execute(clear)
db.executemany(insert, [(10,), (20,)])
db.execute(reconcile, (12, 'owner', 1, 10, snapshot_maximum, 10))
remaining = [row[0] for row in db.execute('SELECT id FROM messages WHERE scope=? AND cid=? AND removed=0 ORDER BY id', ('owner', 1))]
assert remaining == [5, 10, 20, 21, 25], ('snapshot erased messages outside its upper boundary', remaining)
for scope, cid in [('other-account', 1), ('owner', 2)]:
    assert db.execute('SELECT COUNT(*) FROM messages WHERE scope=? AND cid=? AND removed=1', (scope, cid)).fetchone()[0] == 0
db.rollback()
assert db.execute('SELECT COUNT(*) FROM messages WHERE removed=1').fetchone()[0] == 0
db.close()
checks.append({'snapshot_maximum': snapshot_maximum, 'passed': ['actual caller upper-bound wiring', 'older history retained', 'covered missing row removed', 'preexisting newer messages retained', 'account/conversation isolation', 'rollback atomicity']})
print(json.dumps({'result': 'passed', 'scope': 'actual snapshot SQL and static caller wiring; not a Swift or iPhone runtime test', 'cases': checks}, indent=2))
