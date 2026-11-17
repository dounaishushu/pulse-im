// Launch with pc/node_modules/electron/dist/electron.exe. Uses isolated local
// profiles and fixture pages; no production account, network or OS input hooks.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const electron=require('electron'),{app,BrowserWindow,protocol}=electron;
const root=path.resolve(__dirname,'..'),output=path.resolve(process.argv[2]||path.join(root,'.local/artifacts/pc-window-focus'));
fs.mkdirSync(output,{recursive:true});
const fixture=path.join(output,'fixture');fs.mkdirSync(path.join(fixture,'web'),{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(output,'user-data-')));
protocol.registerSchemesAsPrivileged([{scheme:'pulse-app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
for(const name of ['chat-typography.js','media-identity.js','media-source.js','media-lifecycle.js','history-window.js','history-window.css','history-window.html'])fs.copyFileSync(path.join(root,'pc/web',name),path.join(fixture,'web',name));
fs.writeFileSync(path.join(fixture,'preload.js'),'');
fs.writeFileSync(path.join(fixture,'web/index.html'),'<!doctype html><meta charset="utf-8"><title>前台恢复独立测试</title><style>body{font:20px sans-serif;padding:40px}button,input{padding:20px;margin:20px}</style><button id="chat">切换测试会话</button><input id="entry"><p id="status">等待点击</p><script src="fixture.js"></script>');
fs.writeFileSync(path.join(fixture,'web/fixture.js'),'window.pageId=crypto.randomUUID();window.clicks=0;chat.onclick=()=>{clicks++;document.getElementById("status").textContent="已响应 "+clicks;};entry.focus();');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test){const end=Date.now()+4000;while(!await test()){assert.ok(Date.now()<end,'Native focus did not settle');await sleep(20);}}
let manager,other,exitCode=0;
app.whenReady().then(async()=>{
  const checks=[],cycles=[];
  try{
    manager=require('../pc/window-manager.cjs').createWindowManager({electron,directory:fixture,
      runtimeConfig:{apiBaseUrl:'http://127.0.0.1:9/api/v2',websocketUrl:'ws://127.0.0.1:9/api/v2/realtime',production:false},
      appVersion:'fixture',appName:'前台恢复独立测试'});
    const main=manager.createMainWindow(),first=manager.windows()[0];await first.ready;
    other=new BrowserWindow({width:520,height:320,title:'测试用其他应用',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await other.loadURL('data:text/html,<title>Other fixture app</title><p>Isolated foreground recovery test</p>');
    async function checkReturn(record,mode,index){
      const wc=record.webContents,identity=await wc.executeJavaScript('pageId'),before=await wc.executeJavaScript('clicks');
      await wc.executeJavaScript('entry.value="保留草稿";entry.focus()');
      const mounted=record.window.contentView.children.length;
      if(mode==='minimize')record.window.minimize();
      else if(mode==='hide')record.window.hide();
      other.show();other.focus();await until(()=>other.isFocused());
      assert.equal(record.window.isFocused(),false);
      // Merely bringing up an already mounted account in a background window
      // must not activate that application's native window.
      manager.createMainWindow(record.profileId);await sleep(30);
      assert.equal(other.isFocused(),true);
      if(mode==='minimize')record.window.restore();
      if(mode==='hide')record.window.show();
      record.window.focus();await until(()=>record.window.isFocused()&&wc.isFocused());
      const state=await wc.executeJavaScript('({pageId,focus:document.hasFocus(),value:entry.value})');
      assert.equal(state.focus,true);assert.equal(state.pageId,identity);assert.equal(state.value,'保留草稿');
      assert.equal(record.window.contentView.children.length,mounted);
      const point=await wc.executeJavaScript('(()=>{const r=chat.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
      wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      await until(async()=>await wc.executeJavaScript('clicks')===before+1);
      await wc.executeJavaScript('entry.focus()');wc.sendInputEvent({type:'char',keyCode:'x'});
      await until(async()=>await wc.executeJavaScript('entry.value')==='保留草稿x');
      cycles.push({profile:record.profileId===first.profileId?'first':'second',mode,index,firstClick:true,keyboard:true,pageRetained:true,childrenRetained:true});
    }
    main.show();main.focus();await until(()=>first.webContents.isFocused());
    for(const mode of ['switch','minimize','hide'])for(let i=0;i<3;i++)await checkReturn(first,mode,i);
    checks.push('single-account returns accept the first click and keyboard input, preserving page and draft');
    manager.createAccountWindow({sourceProfileId:first.profileId,reuseEmpty:false});
    const second=manager.windows().find(r=>r!==first);await second.ready;
    assert.equal(second.window,main);assert.equal(first.view.getVisible(),false);assert.equal(second.view.getVisible(),true);
    checks.push('two accounts retain distinct views in the same native host');
    for(const mode of ['switch','minimize','hide'])for(let i=0;i<3;i++)await checkReturn(second,mode,i);
    assert.equal(first.webContents.isFocused(),false);checks.push('a foreground return focuses the selected account, leaving the inactive one unfocused');
    manager.createMainWindow(first.profileId);await until(()=>first.webContents.isFocused());
    for(let i=0;i<3;i++)await checkReturn(first,'switch',i+3);
    checks.push('switching back to the earlier account retains first-click and input behavior');
    const independent=manager.createIndependentWindow(),third=manager.windows().find(r=>r.window===independent);await third.ready;
    await checkReturn(third,'switch',0);
    assert.equal(main.isFocused(),false);checks.push('independent native windows do not route focus to a different window');
    fs.writeFileSync(path.join(output,'returned.png'),(await third.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({electron:process.versions.electron,cycles:cycles.length,checks,results:cycles},null,2));
    console.log(JSON.stringify({cycles:cycles.length,checks:checks.length,passed:true}));
  }catch(error){exitCode=1;fs.writeFileSync(path.join(output,'error.txt'),error.stack);console.error(error);}
  finally{other?.destroy();manager?.destroyAll();app.exit(exitCode);}
});
