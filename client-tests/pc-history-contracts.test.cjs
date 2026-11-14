const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const {createHistoryWindows} = require('../pc/history-window.cjs');
const {create} = require('../client-shared/go-v2.js');

test('desktop history crosses Go pages without repeating the boundary message', async () => {
  const cid='11111111-1111-4111-8111-111111111111', uid='22222222-2222-4222-8222-222222222222';
  const base='https://chat.example.invalid/api/v2',values=new Map(),handlers=new Map(),requests=[];
  const local=create({base,storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}}).local('conversation',cid);
  let window;
  class Window extends EventEmitter {
    constructor(){super();this.webContents=new EventEmitter();Object.assign(this.webContents,{id:10,mainFrame:{url:''},setWindowOpenHandler(){},send(){}});window=this;}
    isDestroyed(){return false;}
    setMenuBarVisibility(){}
    async loadURL(url){this.webContents.mainFrame.url=url;}
    destroy(){}
  }
  const owner={webContents:{id:1},profile:{accountId:1,session:{}},window:{getBounds:()=>({x:0,y:0,width:800,height:600})}};
  const windows=createHistoryWindows({electron:{BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)},clipboard:{}},
    directory:path.join(__dirname,'../pc'),runtimeConfig:{apiBaseUrl:base},appVersion:'1.0.0',appName:'Fixture',ownerCurrent:()=>true,
    fetchHistory:async(_,url)=>{
      const query=new URL(url).searchParams,before=Number(query.get('before_seq'))||60;requests.push(before);
      const items=Array.from({length:Math.min(50,before)},(_,index)=>{
        const seq=before-index;
        return {id:String(seq).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa',conversation_id:cid,sender_id:uid,
          seq:String(seq),version:'1',kind:'text',body:'history '+seq,request_id:'history-'+seq,content:{},
          created_at:'2026-11-13T00:00:00Z',updated_at:'2026-11-13T00:00:00Z'};
      });
      return Response.json({items,membership_version:'1',snapshot_max_seq:'60',clear_seq:'0',visible_from_seq:'1',next_after_seq:'0',has_more:before>50});
    }});
  windows.open(owner,{accountId:1,conversationId:local,conversationWireId:cid,token:'fixture-token'});
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  const first=await handlers.get('pulse:history-window:page')(event,0);
  const second=await handlers.get('pulse:history-window:page')(event,first.oldestId);
  assert.deepEqual(requests,[60,10]);
  assert.equal(first.items.length+second.items.length,60);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,60);
  windows.destroy();
});
