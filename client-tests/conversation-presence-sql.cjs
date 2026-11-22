// Execute the shipping privacy query in isolated PostgreSQL/WASM; no live data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.PULSE_PGLITE_MODULE||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/pc-sidebar-presence-20261118/sql.json');
const sql=/const clientConversationPresenceSQL = `([\s\S]*?)`/.exec(fs.readFileSync(path.join(root,'server/internal/core/client_presence.go'),'utf8'))?.[1];assert.ok(sql);
const uuid=n=>String(n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
(async()=>{
  const db=new PGlite(),checks=[],mark=name=>checks.push({name,passed:true}),viewer=uuid(1),peer=uuid(2),outsider=uuid(3),cid=uuid(100),group=uuid(101);
  try{
    await db.exec(`CREATE SCHEMA pulse;
CREATE TABLE pulse.users(id uuid PRIMARY KEY,active boolean,last_active_at timestamptz,deleted_at timestamptz);
CREATE TABLE pulse.conversations(id uuid PRIMARY KEY,active boolean,kind text,direct_key text);
CREATE TABLE pulse.members(conversation_id uuid,user_id uuid,active boolean);
CREATE TABLE pulse.user_states(conversation_id uuid,user_id uuid,hidden boolean);
CREATE TABLE pulse.privacy_settings(user_id uuid PRIMARY KEY,last_seen text);
CREATE TABLE pulse.privacy_exceptions(user_id uuid,peer_id uuid,scope text,effect text);
CREATE TABLE pulse.friendships(user_low uuid,user_high uuid);
CREATE TABLE pulse.blocks(user_id uuid,peer_id uuid);`);
    await db.query(`INSERT INTO pulse.users(id,active,last_active_at) VALUES($1,true,now()),($2,true,now()),($3,true,now());`,[viewer,peer,outsider]);
    await db.query(`INSERT INTO pulse.conversations VALUES($1,true,'direct',$2),($3,true,'group',NULL);`,[cid,viewer+':'+peer,group]);
    await db.query(`INSERT INTO pulse.members VALUES($1,$2,true),($3,$2,true);`,[cid,viewer,group]);
    await db.query(`INSERT INTO pulse.user_states VALUES($1,$2,false),($3,$2,false);`,[cid,viewer,group]);
    const read=async who=>(await db.query(sql,[who||viewer,[cid,group,uuid(999)]])).rows;
    let rows=await read();assert.equal(rows.length,1);assert.equal(rows[0].conversation_id,cid);assert.equal(rows[0].peer_id,peer);assert.equal(rows[0].last_seen instanceof Date,true);
    mark('only an active direct conversation is returned; groups and unknown IDs are excluded');
    assert.equal((await read(outsider)).length,0);mark('a nonmember receives no peer identity or activity');
    await db.query(`INSERT INTO pulse.privacy_settings VALUES($1,'nobody')`,[peer]);assert.equal((await read())[0].last_seen,null);mark('nobody privacy removes activity instead of inventing offline status');
    await db.query(`UPDATE pulse.privacy_settings SET last_seen='contacts' WHERE user_id=$1`,[peer]);assert.equal((await read())[0].last_seen,null);
    await db.query(`INSERT INTO pulse.friendships VALUES($1,$2)`,[viewer,peer]);assert.ok((await read())[0].last_seen);mark('contacts privacy requires the actual friendship relation');
    await db.query(`INSERT INTO pulse.privacy_exceptions VALUES($1,$2,'last_seen','deny')`,[peer,viewer]);assert.equal((await read())[0].last_seen,null);mark('an explicit deny overrides contacts visibility');
    await db.query(`UPDATE pulse.privacy_exceptions SET effect='allow'`);await db.query(`UPDATE pulse.privacy_settings SET last_seen='nobody'`);assert.ok((await read())[0].last_seen);mark('an explicit allow can grant visibility through nobody privacy');
    for(const pair of [[viewer,peer],[peer,viewer]]){await db.query(`INSERT INTO pulse.blocks VALUES($1,$2)`,pair);assert.equal((await read())[0].last_seen,null);await db.exec('DELETE FROM pulse.blocks');}
    mark('either direction of blocking suppresses activity even with an explicit allow');
    await db.query(`UPDATE pulse.privacy_exceptions SET scope='phone',effect='deny'`);await db.query(`UPDATE pulse.privacy_settings SET last_seen='everyone'`);assert.ok((await read())[0].last_seen);mark('phone privacy exceptions cannot affect the last-seen rule');
    for(const [set,reset] of [
      [`UPDATE pulse.user_states SET hidden=true`,`UPDATE pulse.user_states SET hidden=false`],
      [`UPDATE pulse.members SET active=false`,`UPDATE pulse.members SET active=true`],
      [`UPDATE pulse.conversations SET active=false`,`UPDATE pulse.conversations SET active=true`],
    ]){await db.exec(set);assert.equal((await read()).length,0);await db.exec(reset);}
    mark('hidden chats, inactive membership, and inactive chats reveal no status');
    const prior=(await read())[0].last_seen;
    await db.query(`UPDATE pulse.users SET active=false WHERE id=$1`,[peer]);rows=await read();
    assert.equal(rows.length,1);assert.equal(rows[0].peer_active,false);assert.equal(rows[0].last_seen.getTime(),prior.getTime());
    mark('a frozen peer retains the conversation and authorized last-seen timestamp with an inactive status');
    await db.query(`UPDATE pulse.users SET deleted_at=now() WHERE id=$1`,[peer]);assert.equal((await read()).length,0);
    await db.query(`UPDATE pulse.users SET deleted_at=NULL,active=true WHERE id=$1`,[peer]);
    mark('a deleted peer remains excluded from presence');
    const columns=(await db.query(sql,[viewer,[cid]])).fields.map(f=>f.name);assert.deepEqual(columns,['conversation_id','peer_id','last_seen','peer_active']);mark('the lightweight query returns identity, authorized activity and the flag needed to keep frozen peers offline');
    const version=(await db.query('SELECT version() AS v')).rows[0].v;fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({passed:checks.length,checks,postgres:version,scope:'Shipping SQL in isolated PostgreSQL/WASM; Go HTTP/Redis integration is separate'},null,2));console.log(JSON.stringify({passed:checks.length,out}));
  }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
