(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PulseMediaLoadRecovery=factory();})(globalThis,function(){
  'use strict';
  function create({context,refresh,delays=[300,900],setTimer=setTimeout,clearTimer=clearTimeout}) {
    const records=new WeakMap();
    const scope=img=>{try{return context(img);}catch{return null;}};
    const current=(img,record)=>{const value=scope(img);return img.isConnected&&value?.allowed&&value.key===record.key;};
    function clear(record){if(record.timer!==null){clearTimer(record.timer);record.timer=null;}}
    function status(img,record,text) {
      const button=img.closest('button.classic-image-media');if(!button)return;
      if(!record.status||record.status.parentElement!==button){record.status=img.ownerDocument.createElement('span');record.status.className='message-image-status';button.append(record.status);if(record.label===null)record.label=button.getAttribute('aria-label');}
      record.status.textContent=text;button.setAttribute('aria-label',text);img.hidden=true;img.loading='eager';
    }
    function loaded(img,record) {
      clear(record);record.attempt=0;record.failed=false;record.busy=false;record.status?.remove();record.status=null;
      const button=img.closest('button.classic-image-media');if(button&&record.label)button.setAttribute('aria-label',record.label);
      img.hidden=false;
    }
    function failed(img,record) {
      clear(record);record.busy=false;
      if(!current(img,record))return;
      record.failed=true;status(img,record,'图片加载失败，点击重试');
    }
    function schedule(img,record) {
      if(record.busy||record.timer!==null||!current(img,record))return;
      if(record.attempt>=delays.length){failed(img,record);return;}
      const delay=delays[record.attempt++];record.failed=false;
      status(img,record,'正在重新加载图片…');
      record.timer=setTimer(async()=>{
        const key=record.key,valid=()=>record.key===key&&current(img,record);
        record.timer=null;if(!valid())return;record.busy=true;
        try {
          const value=await refresh(img,valid);
          if(!valid())return;
          if(typeof value!=='string'||!value)throw Error('MEDIA_SOURCE_UNAVAILABLE');
          record.busy=false;img.setAttribute('src',value);
        } catch(error) {
          if(!valid())return;record.busy=false;
          if([401,403,404,409].includes(error?.status)){failed(img,record);return;}
          schedule(img,record);
        }
      },delay);
    }
    function bind(img) {
      const value=scope(img);if(!value?.allowed||!value.key)return;
      let record=records.get(img);
      if(record&&record.key===value.key){if(record.failed)status(img,record,'图片加载失败，点击重试');else if(record.timer!==null||record.busy)status(img,record,'正在重新加载图片…');return;}
      if(record){clear(record);loaded(img,record);record.key=value.key;}
      else {
        record={key:value.key,attempt:0,timer:null,busy:false,failed:false,status:null,label:null};records.set(img,record);
        img.addEventListener('load',()=>{if(current(img,record))loaded(img,record);});
        img.addEventListener('error',()=>schedule(img,record));
        const button=img.closest('button.classic-image-media');
        button?.addEventListener('click',event=>{
          if(!record.failed)return;
          event.preventDefault();event.stopImmediatePropagation();
          if(current(img,record)){record.attempt=0;record.failed=false;schedule(img,record);}
        },true);
      }
      if(img.complete&&!img.naturalWidth&&img.getAttribute('src'))schedule(img,record);
    }
    return {bind};
  }
  return {create};
});
