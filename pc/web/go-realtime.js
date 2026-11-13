/* One ticket-authenticated socket per login, shared by same-origin windows. */
(function(root){
  'use strict';
  async function connect({api, token, onPacket, shared=true, WebSocketClass=root.WebSocket}) {
    let closed=false, socket=null, retry=null, heartbeat=null, release=null, channel=null, ready=false, delay=1000;
    const controller=new AbortController();
    const deliver=packet=>{if(!closed)onPacket(packet);};
    const emit=packet=>{deliver(packet);channel?.postMessage(packet);};
    function close(){if(closed)return;closed=true;controller.abort();clearTimeout(retry);clearInterval(heartbeat);socket?.close();channel?.close();release?.();}
    async function open(){
      if(closed)return;
      try{
        const data=await api.raw('/realtime/tickets',{method:'POST',authToken:token,signal:controller.signal});
        if(closed)return;
        const ws=new WebSocketClass(api.websocketURL+'?ticket='+encodeURIComponent(data.ticket)); socket=ws;
        let seen=Date.now();ready=false;
        heartbeat=setInterval(()=>{if(closed||socket!==ws)return;if(Date.now()-seen>45000){ws.close();return;}if(ws.readyState===1)ws.send(JSON.stringify({type:'ping'}));},15000);
        ws.onmessage=event=>{
          if(closed||socket!==ws)return;let packet;try{packet=JSON.parse(event.data);}catch{return;}
          seen=Date.now();if(packet.type==='ready'){ready=true;delay=1000;} if(!ready)return;
          if(packet.type!=='pong')emit(packet);
        };
        ws.onerror=()=>{};
        ws.onclose=()=>{
          if(closed||socket!==ws)return;socket=null;ready=false;clearInterval(heartbeat);emit({type:'connection.lost'});
          retry=setTimeout(open,delay+Math.floor(Math.random()*500));delay=Math.min(delay*2,30000);
        };
      }catch(error){
        if(closed)return;emit({type:'connection.error',status:error.status,code:error.code});
        if(error.status===401){close();return;}
        retry=setTimeout(open,delay+Math.floor(Math.random()*500));delay=Math.min(delay*2,30000);
      }
    }
    if(shared){
      if(!root.navigator?.locks||!root.BroadcastChannel)throw api.fail('unsupported',501);
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(api.base+'|'+token));
      const name='pulse-go-realtime:'+Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,'0')).join('');
      channel=new BroadcastChannel(name);
      channel.onmessage=e=>{if(e.data?.type==='client.hello'){if(ready)channel.postMessage({type:'ready'});}else if(e.data?.type)deliver(e.data);};
      channel.postMessage({type:'client.hello'});
      void navigator.locks.request(name,{signal:controller.signal},async()=>{
        if(closed)return;
        // Lock ownership survives reconnects; releasing it elects the next window.
        const finished=new Promise(resolve=>{release=resolve;});void open();await finished;
      }).catch(error=>{if(!closed)emit({type:'connection.error',code:error.code||'unavailable'});});
    }else void open();
    return {close};
  }
  if(typeof module==='object'&&module.exports)module.exports={connect};else root.PulseGoRealtime={connect};
})(globalThis);
