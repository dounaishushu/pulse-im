/* A viewport-anchored shortcut, separate from the message list and composer. */
(() => {
  let binding;
  window.PulseChatBottom = Object.freeze({
    refresh() { binding?.refresh(); },
    followLatest() { binding?.followLatest(); },
    bind({context,jump,feedback}) {
      binding?.dispose();
      const messages=document.getElementById('messages'),main=messages?.closest('.main');
      if(!main)return;
      const account=context(),abort=new AbortController(),rows=new Set();let frame=0,pending=null,following=null,followedTop=0;
      const button=document.createElement('button');button.id='chat-scroll-bottom';button.type='button';button.className='chat-bottom-button';button.hidden=true;
      button.title='回到最新消息';button.setAttribute('aria-label','回到底部');button.setAttribute('aria-controls','messages');
      button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
      main.append(button);
      const valid=c=>messages.isConnected&&c.allowed&&c.token===account.token&&c.userId===account.userId;
      const same=(a,b)=>a.token===b.token&&a.userId===b.userId&&a.id===b.id&&a.navigation===b.navigation;
      const movedUp=()=>messages.scrollTop<followedTop-2&&messages.scrollHeight-messages.scrollTop-messages.clientHeight>2;
      function refresh() {
        const c=context();
        if(following&&(!valid(c)||!same(following,c)||c.located))following=null;
        if(following){
          // An upward scroll supersedes the list-click intent. Resizing media
          // can grow below the viewport without changing this scroll offset.
          if(movedUp())following=null;
          else{messages.scrollTop=messages.scrollHeight;followedTop=messages.scrollTop;}
        }
        if(pending&&!same(pending,c))pending=null;
        const visible=valid(c)&&c.id>0&&messages.getClientRects().length>0&&
          (Boolean(c.located)||Boolean(pending)||messages.scrollHeight-messages.scrollTop-messages.clientHeight>80);
        button.hidden=!visible;button.disabled=Boolean(pending);button.setAttribute('aria-busy',String(Boolean(pending)));
        if(visible){const r=messages.getBoundingClientRect(),m=main.getBoundingClientRect();button.style.right=Math.max(14,m.right-r.right+14)+'px';button.style.bottom=Math.max(14,m.bottom-r.bottom+14)+'px';}
      }
      function followLatest(){
        const c=context();if(!valid(c)||!c.id||c.located)return;
        following={...c};messages.scrollTop=messages.scrollHeight;followedTop=messages.scrollTop;schedule();
      }
      function schedule(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;refresh();});}
      const resize=new ResizeObserver(schedule);resize.observe(messages);
      function watchRows(){for(const n of rows)if(n.parentElement!==messages){resize.unobserve(n);rows.delete(n);}for(const n of messages.children)if(!rows.has(n)){rows.add(n);resize.observe(n);}schedule();}
      const changes=new MutationObserver(watchRows);changes.observe(messages,{childList:true,subtree:true});watchRows();
      const visibility=new MutationObserver(schedule);visibility.observe(messages,{attributes:true,attributeFilter:['hidden','class','style']});visibility.observe(main,{attributes:true,attributeFilter:['hidden','class','style']});
      messages.addEventListener('scroll',()=>{if(following&&movedUp())following=null;schedule();},{signal:abort.signal,passive:true});
      messages.addEventListener('wheel',event=>{if(event.deltaY<0)following=null;},{signal:abort.signal,passive:true});
      messages.addEventListener('load',schedule,{signal:abort.signal,capture:true});
      window.addEventListener('resize',schedule,{signal:abort.signal});
      document.addEventListener('visibilitychange',schedule,{signal:abort.signal});
      button.addEventListener('click',async()=>{
        const c=context();if(!valid(c)||pending||!c.id||document.querySelector('[aria-modal="true"],.classic-passcode-lock-screen'))return;
        const request=pending=c;let owner=request;refresh();
        try{const work=jump(),after=context();if(valid(after)&&after.id===c.id){pending=owner={...after};refresh();}await work;if(pending===owner)pending=null;}
        catch(error){if(pending===owner&&valid(context())&&same(owner,context()))feedback(error.message||'回到最新消息失败，请重试');if(pending===owner)pending=null;}
        finally{schedule();}
      },{signal:abort.signal});
      const dispose=()=>{abort.abort();changes.disconnect();visibility.disconnect();resize.disconnect();if(frame)cancelAnimationFrame(frame);button.remove();if(binding?.dispose===dispose)binding=null;};
      binding={refresh,followLatest,dispose};refresh();
    }
  });
})();
