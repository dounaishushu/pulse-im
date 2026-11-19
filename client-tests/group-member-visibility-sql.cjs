// Execute the production directory SELECT in PostgreSQL (PGlite), without a
// production connection. This is SQL validation, not the Go HTTP integration suite.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const {PGlite} = require(process.env.PULSE_PGLITE_MODULE || path.join(root, '.local/tools/postgres-sql-check/node_modules/@electric-sql/pglite'));
const output = path.resolve(process.argv[2] || '.local/group-member-visibility-sql.json');
const source = fs.readFileSync(process.env.PULSE_DIRECTORY_SOURCE || path.join(root, 'server/internal/core/client_queries.go'), 'utf8').split('func (s *Service) ClientMemberPage(')[1];
const sql = source.match(/rows, err := tx.Query\(ctx, `(SELECT[\s\S]*?)`, cid, who.UserID, after, query, pattern, limit\+1\)/)[1];
const uuid = n => String(n).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor=uuid(1), owner=uuid(2), admin=uuid(3), peer=uuid(4), stranger=uuid(5), outsider=uuid(6), group=uuid(100);
(async()=>{
  const db = new PGlite(), checks=[]; await db.waitReady;
  const check = (name,actual,expected) => { assert.deepEqual(actual,expected,name); checks.push({name,passed:true}); };
  try {
    await db.exec(`CREATE SCHEMA pulse;
      CREATE TABLE pulse.users(id uuid PRIMARY KEY,account text,account_is_internal boolean DEFAULT false,nickname text,active boolean DEFAULT true,internal_staff boolean DEFAULT false,avatar_id uuid,legacy_public_id text,public_id text);
      CREATE TABLE pulse.conversations(id uuid PRIMARY KEY,kind text DEFAULT 'group',active boolean DEFAULT true,block_member_friend_requests boolean DEFAULT false);
      CREATE TABLE pulse.members(conversation_id uuid,user_id uuid,role text DEFAULT 'member',active boolean DEFAULT true,muted boolean DEFAULT false,muted_until timestamptz,PRIMARY KEY(conversation_id,user_id));
      CREATE TABLE pulse.contact_metadata(user_id uuid,peer_id uuid,remark text);
      CREATE TABLE pulse.friendships(user_low uuid,user_high uuid);`);
    for(const [id,account,nickname] of [[actor,'a1124','当前用户'],[owner,'owner','群主'],[admin,'admin','管理员'],[peer,'ceshi001','好友100%'],[stranger,'stranger','陌生成员'],[outsider,'outside','群外好友']]){
      await db.query('INSERT INTO pulse.users(id,account,nickname,public_id) VALUES($1,$2,$3,$4)',[id,account,nickname,id===peer?'77889900':account+'-id']);
    }
    await db.query('INSERT INTO pulse.conversations(id) VALUES($1)',[group]);
    for(const id of [actor,owner,admin,peer,stranger])await db.query('INSERT INTO pulse.members(conversation_id,user_id,role) VALUES($1,$2,$3)',[group,id,id===owner?'owner':id===admin?'admin':'member']);
    await db.query('INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,$3)',[actor,peer,'我的工作备注']);
    for(const id of [peer,outsider])await db.query('INSERT INTO pulse.friendships VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))',[actor,id]);
    const query=async(q='',after='',limit=100,viewer=actor)=>(await db.query(sql,[group,viewer,after||uuid(0),q,'%'+q.replace(/[\\%_]/g,'\\$&')+'%',limit+1])).rows;
    const ids=rows=>rows.map(r=>r.id);
    check('ban off exposes all current members to ordinary viewers',ids(await query()),[actor,owner,admin,peer,stranger]);
    check('ban off supports fuzzy search for a non-friend',ids(await query('陌生')),[stranger]);
    for(const q of ['工作','ESHI','8899','100%'])check('fuzzy name/remark/account/public-ID '+q,ids(await query(q)),[peer]);
    check('group search excludes an outside friend',ids(await query('群外')),[]);
    check('SQL-looking search text stays literal',ids(await query("_' OR 1=1 --")),[]);
    const first=await query('', '', 2), second=await query('',first[1].id,2);
    check('UUID pagination preserves visible order',[...ids(first.slice(0,2)),...ids(second.slice(0,2))],[actor,owner,admin,peer]);
    await db.query('UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1',[group]);
    check('ban on exposes only owner and administrators',ids(await query()),[owner,admin]);
    check('ban on hides non-friends from search',ids(await query('陌生')),[]);
    check('ban on preserves in-group friend search',ids(await query('工作')),[peer]);
    check('ordinary users cannot search non-friend administrators',ids(await query('管理')),[]);
    check('administrators retain full group directory',ids(await query('', '',100,admin)),[actor,owner,admin,peer,stranger]);
    await db.query('UPDATE pulse.conversations SET block_member_friend_requests=false WHERE id=$1',[group]);
    check('turning ban off restores ordinary members immediately',ids(await query()),[actor,owner,admin,peer,stranger]);
    await db.query("UPDATE pulse.conversations SET kind='channel' WHERE id=$1",[group]);
    check('a channel does not inherit open-group member visibility',ids(await query()),[owner,admin]);
    await db.query("UPDATE pulse.conversations SET kind='group' WHERE id=$1",[group]);
    await db.query('UPDATE pulse.members SET active=false WHERE conversation_id=$1 AND user_id=$2',[group,stranger]);
    check('departed members never appear',ids(await query('陌生')),[]);
    await db.query('UPDATE pulse.members SET active=false WHERE conversation_id=$1 AND user_id=$2',[group,actor]);
    check('departed viewers have no directory rows',ids(await query()),[]);
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({passed:checks.length,engine:'PGlite PostgreSQL',scope:'Exact production SQL; not HTTP/Redis integration',checks},null,2));
    console.log(JSON.stringify({passed:checks.length,output}));
  } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
