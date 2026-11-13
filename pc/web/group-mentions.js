/* All members may mention a selected author. Roster search and @all remain manager-only. */
(() => {
  let binding,accountKey='';const drafts=new Map();
  function draft(c){const owner=JSON.stringify([c.token,c.userId]);if(owner!==accountKey){drafts.clear();accountKey=owner;}const id=Number(c.id);if(!drafts.has(id)){if(drafts.size>=100)drafts.delete(drafts.keys().next().value);drafts.set(id,{chosen:new Map(),all:false});}return drafts.get(id);}
  const label=value=>Array.from(String(value||'').replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/\s+/gu,' ').trim()).slice(0,80).join('');
  const contains=(text,name)=>new RegExp('(?:^|\\s)@'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=\\s|$)','u').test(text);
  window.PulseGroupMentions=Object.freeze({refresh(){binding?.refresh();},remember(row){binding?.remember(row);},body(text){return binding?.body(text)||{text};},bind({context,request,avatar,feedback,closeEmoji}){
    binding?.dispose();
    const input=document.getElementById('message-input'),composer=document.getElementById('composer'),main=composer?.closest('.main');if(!input||!main)return;
    const abort=new AbortController(),button=document.createElement('button');button.id='group-mention-button';button.type='button';button.textContent='@';button.title='艾特群成员';button.setAttribute('aria-label','艾特群成员');button.hidden=true;composer.insertBefore(button,input);
    const panel=document.createElement('section');panel.id='group-mention-picker';panel.className='group-mention-picker';panel.hidden=true;panel.setAttribute('role','listbox');panel.setAttribute('aria-label','选择要艾特的群成员');main.append(panel);
    let timer,controller,revision=0,key='',denied='',selection=null,items=[],index=0,more=false,page=1,composing=false,data={chosen:new Map(),all:false};
    const scope=c=>[c.token,c.userId,c.id,c.navigation,c.role,c.staff].join(':');
    const member=c=>c.allowed&&['owner','admin','member'].includes(c.role);
    const permitted=c=>member(c)&&['owner','admin'].includes(c.role)&&scope(c)!==denied;
    const token=()=>{const end=input.selectionStart;if(end!==input.selectionEnd)return null;const m=/(?:^|\s)@([^\s@]{0,80})$/u.exec(input.value.slice(0,end));return m?{from:end-m[1].length-1,to:end,q:m[1],text:input.value}:null;};
    function close(){clearTimeout(timer);controller?.abort();controller=null;++revision;panel.hidden=true;panel.replaceChildren();input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','false');selection=null;items=[];}
    function refresh(){const c=context(),next=scope(c);if(next!==key){close();data=draft(c);key=next;}button.hidden=!permitted(c);composer.classList.toggle('has-group-mention',!button.hidden);if(!permitted(c)||input.disabled||composer.hidden||document.hidden)close();}
    function remember(row){refresh();const c=context(),id=Number(row.user_id),name=label(row.nickname);if(member(c)&&Number.isSafeInteger(id)&&id>0&&id!==c.userId&&name)data.chosen.set(id,name);}
    function body(text){refresh();const c=context();if(!member(c))return{text};const ids=[...data.chosen].filter(([,name])=>name&&contains(text,name)).map(([id])=>id);return{text,...(permitted(c)&&data.all&&contains(text,'所有人')?{mention_all:true}:ids.length?{mention_user_ids:ids}: {})};}
    function position(){const m=main.getBoundingClientRect(),r=composer.getBoundingClientRect();panel.style.left='0px';panel.style.right='0px';panel.style.bottom=(m.bottom-r.top)+'px';panel.style.maxHeight=Math.max(0,Math.min(250,r.top-m.top-50))+'px';}
    function status(text,retry){panel.replaceChildren();const n=document.createElement(retry?'button':'p');n.textContent=text;if(retry){n.type='button';n.onclick=()=>load(1);}n.className='group-mention-status';panel.append(n);}
    function paint(){panel.replaceChildren();if(!items.length)status('未找到匹配成员');items.forEach((row,i)=>{
      const n=document.createElement('button');n.type='button';n.id='group-mention-'+i;n.className='group-mention-row';n.setAttribute('role','option');n.setAttribute('aria-selected',String(i===index));
      const icon=document.createElement('span');icon.className='group-mention-avatar';icon.textContent=Array.from(row.nickname||'?')[0];if(row.avatar_url){const img=document.createElement('img');img.src=avatar(row.avatar_url);img.alt='';img.onerror=()=>img.remove();icon.append(img);}
      const name=document.createElement('strong');name.textContent=row.nickname;const username=document.createElement('small');username.textContent=row.all?'提醒群内所有成员':row.username?'@'+row.username:(row.public_id?'ID: '+row.public_id:'');n.append(icon,name,username);if(row.all){n.dataset.mentionAll='true';icon.textContent='@';}n.onclick=()=>choose(row);panel.append(n);
    });if(more){const n=document.createElement('button');n.type='button';n.textContent='加载更多';n.className='group-mention-status';n.onclick=()=>load(page+1);panel.append(n);}if(items.length)input.setAttribute('aria-activedescendant','group-mention-'+index);}
    const current=(s,r)=>r===revision&&permitted(context())&&scope(context())===s&&selection&&input.value===selection.text&&input.selectionStart===selection.to&&input.selectionEnd===selection.to;
    async function load(next){const c=context();if(!selection||!permitted(c))return close();const s=scope(c),r=++revision;controller?.abort();controller=new AbortController();panel.hidden=false;input.setAttribute('aria-expanded','true');position();if(next===1)status('正在查找群成员…');
      try{const result=await request(c.id,selection.q,next,c.token,controller.signal);if(!current(s,r))return;
        if(result.can_search!==true){denied=s;refresh();return;}if(Number(result.conversation_id)!==c.id||!Array.isArray(result.items))throw Error('成员搜索响应无效');
        const valid=result.items.filter(row=>Number.isSafeInteger(row.user_id)&&row.user_id>0&&row.user_id!==c.userId&&typeof row.nickname==='string');
        const all=result.can_mention_all===true&&(!selection.q||'所有人'.includes(selection.q.toLowerCase())||'all'.includes(selection.q.toLowerCase()))?[{user_id:0,nickname:'所有人',all:true}]:[];
        items=next===1?[...all,...valid]:[...items,...valid.filter(row=>!items.some(n=>n.user_id===row.user_id))];index=0;page=next;more=result.has_more===true;paint();
      }catch(e){if(e.name!=='AbortError'&&current(s,r))status('加载失败，点击重试',true);}}
    function changed(){refresh();for(const[id,name]of data.chosen)if(!contains(input.value,name))data.chosen.delete(id);if(!contains(input.value,'所有人'))data.all=false;if(composing||document.activeElement!==input||!permitted(context()))return close();const t=token();if(!t)return close();close();selection=t;timer=setTimeout(()=>load(1),180);}
    function choose(row){const c=context(),s=selection;if(!s||!permitted(c)||input.disabled||input.value!==s.text||input.selectionStart!==s.to)return close();const name=label(row.nickname);if(!name)return;const value='@'+name+' ';if(Array.from(input.value.slice(0,s.from)+value+input.value.slice(s.to)).length>5000){feedback('输入内容已达到长度上限');return;}close();input.focus();input.setRangeText(value,s.from,s.to,'end');if(row.all)data.all=true;else data.chosen.set(row.user_id,name);input.dispatchEvent(new Event('input',{bubbles:true}));}
    button.addEventListener('mousedown',e=>e.preventDefault(),{signal:abort.signal});button.addEventListener('click',()=>{refresh();if(button.hidden||input.disabled)return;closeEmoji();input.focus();if(!token()){const a=input.selectionStart,b=input.selectionEnd;input.setRangeText((a>0&&!/\s/u.test(input.value[a-1])?' ':'')+'@',a,b,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}else changed();},{signal:abort.signal});
    panel.addEventListener('mousedown',e=>e.preventDefault(),{signal:abort.signal});
    input.setAttribute('aria-controls',panel.id);input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');
    input.addEventListener('input',changed,{signal:abort.signal});input.addEventListener('click',changed,{signal:abort.signal});
    input.addEventListener('compositionstart',()=>{composing=true;close();},{signal:abort.signal});input.addEventListener('compositionend',()=>{composing=false;changed();},{signal:abort.signal});
    input.addEventListener('keydown',e=>{if(panel.hidden||e.isComposing||composing)return;if(['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();if(e.key==='Escape')close();else if(e.key==='Enter'){if(items[index])choose(items[index]);}else if(items.length){index=(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;paint();document.getElementById('group-mention-'+index)?.scrollIntoView({block:'nearest'});}}else if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key))close();},{capture:true,signal:abort.signal});
    document.addEventListener('pointerdown',e=>{if(!panel.contains(e.target)&&e.target!==input&&e.target!==button)close();},{signal:abort.signal});document.addEventListener('visibilitychange',refresh,{signal:abort.signal});window.addEventListener('resize',position,{signal:abort.signal});
    window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden&&!composing&&!e.isComposing){e.preventDefault();e.stopImmediatePropagation();close();}},{capture:true,signal:abort.signal});
    const resize=new ResizeObserver(position);resize.observe(composer);const dispose=()=>{close();abort.abort();resize.disconnect();button.remove();panel.remove();composer.classList.remove('has-group-mention');};binding={refresh,remember,body,dispose};refresh();
  }});
})();
