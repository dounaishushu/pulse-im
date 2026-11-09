// Bounded invitations. Only a definite missing endpoint permits legacy fallback.
(function(root){'use strict';
  function create({request}) {
    const options = (account, signal) => ({authToken:account.token,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
    async function candidates(group, account, signal, current) {
      const items=[];let profile;
      for(let page=1;page<=1000;page++) {
        let result;
        try { result=await request(`/conversations/invite-candidates?conversation_id=${Number(group.id)}&page=${page}&size=500`,options(account,signal)); }
        catch(error){if([404,405].includes(error.status))return null;throw error;}
        if(!current())return null;
        if(Number(result?.group?.id)!==Number(group.id)||!['owner','admin'].includes(result.group.my_role)||result.group.can_invite!==true
          ||!Array.isArray(result.items)||result.items.length>500||typeof result.has_more!=='boolean'
          ||result.items.some(p=>!Number.isSafeInteger(p.user_id)||p.user_id<=0))throw Error('邀请用户列表无效，请重新打开。');
        profile=result.group;items.push(...result.items);
        if(!result.has_more)return {items,group:profile};
        if(!result.items.length)throw Error('邀请用户分页无效，请重试。');
      }
      throw Error('用户列表过大，请联系管理员。');
    }
    async function add({group,ids,account,signal,current,progress=()=>{},apply=()=>{}}) {
      let legacy=false;const items=[];
      for(let offset=0;offset<ids.length;offset+=50) {
        if(!current())return {items,abandoned:true};
        const chunk=ids.slice(offset,offset+50);progress(offset,ids.length);
        let result;
        try {
          if(!legacy)try {
            result=await request('/conversations/members/batch',{...options(account,signal),method:'POST',body:JSON.stringify({conversation_id:Number(group.id),user_ids:chunk})});
          }catch(error){if(![404,405].includes(error.status))throw error;legacy=true;}
          if(legacy) {
            const rows=[];
            for(const id of chunk){if(!current())return {items,abandoned:true};
              try{const one=await request('/conversations/members',{...options(account,signal),method:'POST',body:JSON.stringify({conversation_id:Number(group.id),user_id:id})});
                if(Number(one?.conversation_id)!==Number(group.id)||Number(one?.user_id)!==id||one.status!=='joined')throw Error('邀请结果异常，请刷新群成员后确认。');
                rows.push({user_id:id,status:'joined',added:true});
              }catch(error){rows.push({user_id:id,status:'rejected',message:error.message||'邀请失败'});}
            }
            result={conversation_id:Number(group.id),items:rows};
          }
          if(!current())return {items,abandoned:true};
          const rows=result?.items;
          if(Number(result?.conversation_id)!==Number(group.id)||!Array.isArray(rows)||rows.length!==chunk.length
            ||new Set(rows.map(r=>r.user_id)).size!==chunk.length
            ||rows.some(r=>!chunk.includes(r.user_id)||!['joined','rejected'].includes(r.status))
            ||(!legacy&&(!Number.isSafeInteger(result.member_count)||result.member_count<0||!Number.isSafeInteger(result.remaining)||result.remaining<0)))throw Error('邀请结果异常，请刷新群成员后确认。');
          items.push(...rows);apply(result);
          if(!legacy&&result.remaining===0&&offset+50<ids.length){const rest=ids.slice(offset+50).map(user_id=>({user_id,status:'rejected',message:'该群组成员数量已达到上限。'}));items.push(...rest);break;}
        }catch(error){
          if(!current())return {items,abandoned:true};
          // A timeout may happen after commit. Do not replay or report success.
          const definite=Number(error.status)>=400&&Number(error.status)<500&&![408,429].includes(error.status);
          items.push(...ids.slice(offset).map(user_id=>({user_id,status:'rejected',code:definite?'INVITE_REJECTED':'INVITE_CONFIRM_REQUIRED',message:definite?(error.message||'邀请被拒绝，请刷新群资料。'):'状态待确认，请刷新群成员后再试。'+(error.requestId?' 请求编号：'+error.requestId:'')})));
          break;
        }
      }
      return {items,abandoned:false};
    }
    return {candidates,add};
  }
  if(typeof module==='object'&&module.exports)module.exports={create};else root.PulseGroupInvitations={create};
})(typeof window==='object'?window:globalThis);
