(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PulseMediaIdentity=factory();})(globalThis,function(){
  'use strict';
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,bindings=new Map();
  function grant(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||u.search||!/^\/api\/v2\/media-grants\/[a-f0-9]{64}\/(content|preview)$/.test(u.pathname))return null;return u;}catch{return null;}}
  function remember(value,id){const u=grant(value);if(!u||!UUID.test(id||''))return false;const key=u.origin+u.pathname.replace(/\/(content|preview)$/,'');bindings.delete(key);bindings.set(key,id.toLowerCase());while(bindings.size>8192)bindings.delete(bindings.keys().next().value);return true;}
  function mediaId(value){const u=grant(value);if(!u)return '';const key=u.origin+u.pathname.replace(/\/(content|preview)$/, ''),id=bindings.get(key)||'';if(id){bindings.delete(key);bindings.set(key,id);}return id;}
  function identity(value,hint=''){const u=grant(value),id=UUID.test(hint)?hint.toLowerCase():mediaId(value);return u&&id?u.origin+'/api/v2/media/'+id+'/'+u.pathname.split('/').pop():String(value||'');}
  return {remember,mediaId,identity,validId:value=>UUID.test(value||'')};
});
