// Run the exact Go broadcast SELECTs in isolated PostgreSQL (PGlite).
// This verifies SQL semantics; it does not replace HTTP/Redis integration tests.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const { PGlite } = require(process.env.PULSE_PGLITE_MODULE || path.join(root, '.local/tools/postgres-sql-check/node_modules/@electric-sql/pglite'));
const source = fs.readFileSync(path.join(root, 'server/internal/core/broadcast_targets.go'), 'utf8');
const extract = name => source.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`'))[1];
const friendSQL = extract('broadcastFriendTargetsSQL'), groupSQL = extract('broadcastGroupTargetsSQL');
const output = path.resolve(process.argv[2] || path.join(root, '.local/broadcast-targets-sql.json'));
const uuid = n => String(n).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = uuid(1), bob = uuid(2), carol = uuid(3), outsider = uuid(4), inactive = uuid(5), blocked = uuid(6), later = uuid(7), internal = uuid(8);
const snapshot = '2026-11-19T05:39:04Z';
const literal = value => value.replace(/[\\%_]/g, '\\$&');
(async () => {
  const db = new PGlite(), checks = []; await db.waitReady;
  const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push({ name, passed: true }); };
  try {
    await db.exec(`CREATE SCHEMA pulse;
      CREATE TABLE pulse.users(id uuid PRIMARY KEY,account text,nickname text,account_is_internal boolean DEFAULT false,active boolean DEFAULT true,avatar_id uuid,public_id text,legacy_public_id text);
      CREATE TABLE pulse.friendships(user_low uuid,user_high uuid,created_at timestamptz DEFAULT '2026-11-19T00:00:00Z');
      CREATE TABLE pulse.contact_metadata(user_id uuid,peer_id uuid,remark text,PRIMARY KEY(user_id,peer_id));
      CREATE TABLE pulse.blocks(user_id uuid,peer_id uuid);
      CREATE TABLE pulse.conversations(id uuid PRIMARY KEY,kind text DEFAULT 'group',title text,avatar_id uuid,public_id text,active boolean DEFAULT true,created_at timestamptz DEFAULT '2026-11-19T00:00:00Z');
      CREATE TABLE pulse.members(conversation_id uuid,user_id uuid,active boolean DEFAULT true,joined_at timestamptz DEFAULT '2026-11-19T00:00:00Z');
      CREATE TABLE pulse.user_states(conversation_id uuid,user_id uuid,hidden boolean DEFAULT false);`);
    for (const [id, account, nickname] of [[actor,'staff','本人'],[bob,'bob_account','Bob 原昵称'],[carol,'carol_account','同学'],[outsider,'outside','群外用户'],[inactive,'inactive','已停用'],[blocked,'blocked','被拉黑'],[later,'later','稍后加好友'],[internal,'hidden_staff','']]) {
      await db.query('INSERT INTO pulse.users(id,account,nickname,public_id) VALUES($1,$2,$3,$4)', [id,account,nickname,id===bob?'77889900':account+'-id']);
    }
    await db.query('UPDATE pulse.users SET active=false WHERE id=$1', [inactive]);
    await db.query("UPDATE pulse.users SET account_is_internal=true,public_id='staff-public-008' WHERE id=$1", [internal]);
    for (const id of [bob,carol,inactive,blocked,later,internal]) await db.query('INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))', [actor,id]);
    await db.query("UPDATE pulse.friendships SET created_at='2026-11-19T06:00:00Z' WHERE user_high=$1", [later]);
    await db.query('INSERT INTO pulse.blocks VALUES($1,$2)', [actor,blocked]);
    await db.query('INSERT INTO pulse.contact_metadata VALUES($1,$2,$3),($4,$2,$5)', [actor,bob,'11/18 平安100%_用户',outsider,'别人的私有备注']);
    const query = async (sql, q='', after=uuid(0), limit=100, viewer=actor) => (await db.query(sql,[viewer,snapshot,after,limit+1,q,'%'+literal(q)+'%'])).rows;
    const ids = rows => rows.map(row => row.id);
    let rows = await query(friendSQL);
    check('friend candidates exclude non-friends, inactive, blocked and post-snapshot contacts', ids(rows), [bob,carol,internal]);
    check('original name is retained while display_name prefers the viewer remark', [rows[0].name,rows[0].remark,rows[0].display_name], ['Bob 原昵称','11/18 平安100%_用户','11/18 平安100%_用户']);
    for (const q of ['平安','原昵称','BOB_ACCOUNT','8899','100%_']) check('fuzzy remark/name/account/public-ID search: '+q,ids(await query(friendSQL,q)),[bob]);
    for (const q of ['别人的私有备注','outside',"_' OR 1=1 --",'\\']) check('literal and viewer-scoped search: '+q,ids(await query(friendSQL,q)),[]);
    check('internal account is not searchable',ids(await query(friendSQL,'hidden_staff')),[]);
    const internalRow = rows.find(row=>row.id===internal);
    check('internal account does not leak through name fallbacks',[internalRow.name,internalRow.username,internalRow.display_name],['','','']);
    const first=await query(friendSQL,'',uuid(0),1), second=await query(friendSQL,'',first[0].id,1);
    check('UUID pagination remains stable under filtering',[first[0].id,second[0].id],[bob,carol]);
    await db.query("UPDATE pulse.contact_metadata SET remark='' WHERE user_id=$1 AND peer_id=$2",[actor,bob]);
    check('clearing a remark removes the old search match',ids(await query(friendSQL,'平安')),[]);
    check('clearing a remark restores nickname display',(await query(friendSQL,'BOB_ACCOUNT'))[0].display_name,'Bob 原昵称');
    check('another viewer receives no unrelated friendship directory',ids(await query(friendSQL,'',uuid(0),100,outsider)),[]);
    for (let n=100;n<=108;n++) {
      await db.query('INSERT INTO pulse.conversations(id,title,public_id) VALUES($1,$2,$3)',[uuid(n),n===100?'邀请群100%_':'测试群'+n,'group-id-'+n]);
      if(n!==102) {
        await db.query('INSERT INTO pulse.members(conversation_id,user_id) VALUES($1,$2)',[uuid(n),actor]);
        await db.query('INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2)',[uuid(n),actor]);
      }
    }
    await db.query('UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1',[uuid(101)]);
    await db.query("UPDATE pulse.conversations SET kind='channel' WHERE id=$1",[uuid(103)]);
    await db.query("UPDATE pulse.members SET joined_at='2026-11-19T06:00:00Z' WHERE conversation_id=$1",[uuid(104)]);
    await db.query('UPDATE pulse.conversations SET active=false WHERE id=$1',[uuid(105)]);
    await db.query("UPDATE pulse.conversations SET created_at='2026-11-19T06:00:00Z' WHERE id=$1",[uuid(106)]);
    await db.query('UPDATE pulse.members SET active=false WHERE conversation_id=$1',[uuid(107)]);
    check('group candidates respect visibility, membership, kind and snapshot',ids(await query(groupSQL)),[uuid(100),uuid(108)]);
    check('group title search treats wildcards literally',ids(await query(groupSQL,'100%_')),[uuid(100)]);
    check('group public-ID fuzzy search',ids(await query(groupSQL,'ID-108')),[uuid(108)]);
    check('group rows keep the friend result column contract',(await query(groupSQL,'100%_')).map(row=>[row.name,row.remark,row.display_name]),[['邀请群100%_','','邀请群100%_']]);
    await db.query('INSERT INTO pulse.blocks VALUES($1,$2)',[bob,actor]);
    check('a reverse block immediately removes the target',ids(await query(friendSQL,'BOB_ACCOUNT')),[]);
    fs.mkdirSync(path.dirname(output),{recursive:true});
    fs.writeFileSync(output,JSON.stringify({passed:checks.length,engine:'PGlite PostgreSQL',scope:'Exact production SELECTs; not HTTP/Redis integration',checks},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));
  } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
