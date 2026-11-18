// Optional real PostgreSQL/WASM check. Set PULSE_PGLITE_MODULE to a local PGlite install.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.PULSE_PGLITE_MODULE||'@electric-sql/pglite');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.local/pc-presence-location-20261118/staff-sql.json');
const source=fs.readFileSync(path.join(root,'server/internal/core/admin_groups.go'),'utf8');
const sql=/const staffUserProfileSQL = `([\s\S]*?)`/.exec(source)?.[1];assert.ok(sql,'must execute the shipping SQL');
(async()=>{
  const db=new PGlite(),checks=[];const mark=name=>checks.push({name,passed:true});
  try{
    await db.exec(`CREATE SCHEMA pulse;
CREATE TABLE pulse.users(id uuid PRIMARY KEY,account text,nickname text,phone text,public_id text,legacy_public_id text,registration_ip inet,active boolean);
CREATE TABLE pulse.ip_locations(ip inet PRIMARY KEY,country text,province text,city text,status text);
CREATE TABLE pulse.login_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid,ip inet,platform text,device_name text,created_at timestamptz DEFAULT now(),success boolean);`);
    const uid='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
    await db.query(`INSERT INTO pulse.users VALUES($1,'fixture','联系人',NULL,'PUBLIC',NULL,'192.0.2.10/32',true),($2,'other','其他人',NULL,'OTHER',NULL,NULL,true)`,[uid,other]);
    const read=async(available=true,id=uid)=>(await db.query(sql,[id,available])).rows[0]?.jsonb_build_object;
    let r=await read(false);assert.equal(r.registration_ip,'192.0.2.10');assert.equal(r.registration_ip_location,'');assert.equal(r.registration_ip_location_status,'unconfigured');assert.deepEqual(r.logins,[]);
    mark('unconfigured and missing cache remains explicit; inet prefixes are not leaked into IP text');
    r=await read(true);assert.equal(r.registration_ip_location_status,'unknown');mark('configured-but-uncached and unconfigured are distinct');
    await db.exec(`INSERT INTO pulse.ip_locations VALUES('192.0.2.10','中国','北京','北京','resolved'),('192.0.2.20','中国','广东','深圳','resolved'),('192.0.2.30','错误数据','错误数据','错误数据','failed');`);
    await db.query(`INSERT INTO pulse.login_events(user_id,ip,platform,device_name,success) VALUES($1,'192.0.2.20','android','成功设备',true),($1,'192.0.2.30','pc','失败设备',false),($2,'192.0.2.30','pc','其他用户',true)`,[uid,other]);
    r=await read(false);assert.equal(r.registration_ip_location,'中国 北京 北京');assert.equal(r.logins.length,1);assert.equal(r.logins[0].ip,'192.0.2.20');assert.equal(r.logins[0].location,'中国 广东 深圳');assert.equal(r.logins[0].location_status,'resolved');
    assert.ok(!JSON.stringify(r).includes('失败设备')&&!JSON.stringify(r).includes('其他用户'));
    mark('resolved cache works without an active provider, and failed/other-user logins do not replace the selected login');
    await db.query(`INSERT INTO pulse.login_events(user_id,ip,platform,device_name,success) VALUES($1,'192.0.2.30','pc','新成功设备',true)`,[uid]);
    r=await read();assert.equal(r.logins[0].location,'');assert.equal(r.logins[0].location_status,'failed');mark('failed lookup cannot expose leftover country/city fields as a resolved location');
    await db.query(`INSERT INTO pulse.login_events(user_id,ip,platform,device_name,success) SELECT $1,'192.0.2.20','pc','设备'||n,true FROM generate_series(1,25)n`,[uid]);
    r=await read();assert.equal(r.logins.length,20);assert.equal(r.logins[0].device_name,'设备25');assert.equal(r.logins.at(-1).device_name,'设备6');assert.ok(r.logins.every(v=>!Object.hasOwn(v,'user_id')&&!Object.hasOwn(v,'account')&&!Object.hasOwn(v,'id')));
    mark('history remains ordered, limited to twenty, and omits internal identity columns');
    await db.query('UPDATE pulse.users SET active=false WHERE id=$1',[uid]);assert.equal(await read(),undefined);mark('inactive user remains inaccessible through this query');
    const version=(await db.query('SELECT version() AS version')).rows[0].version;
    fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({passed:checks.length,checks,postgres:version,scope:'Shipping SQL executed in isolated PostgreSQL/WASM; not the Go HTTP/Redis integration suite'},null,2));console.log(JSON.stringify({passed:checks.length,output:out,postgres:version}));
  }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
