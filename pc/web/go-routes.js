(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PulseGoRoutes=factory();})(globalThis,function(){
  'use strict';
  class Manager {
    constructor({base,fetch:fetcher=globalThis.fetch.bind(globalThis),storage=null,allowLocal=false}) {
      this.isGo=true;this.base=this.endpoint(base,allowLocal);this.allowLocal=allowLocal;this.fetchImpl=fetcher;this.storage=storage;
      this.seeds=[{id:'go-main',name:'主线路',api_url:this.base,ws_url:this.base.replace(/^http/,'ws')+'/realtime',media_url:new URL(this.base).origin}];
      this.routes=this.seeds.slice();this.current=this.seeds[0];this.listeners=new Set();this.latencies=new Map();this.serial=0;
      this.preferred=storage?.getItem('pulse.go.route:'+this.base)||this.current.id;this.loaded=false;this.ready=Promise.resolve();
    }
    endpoint(value,allowLocal=this.allowLocal) {
      const url=new URL(value),local=['localhost','127.0.0.1','[::1]','10.0.2.2'].includes(url.hostname);
      if(url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='/api/v2'||(url.protocol!=='https:'&&!(allowLocal&&local&&url.protocol==='http:')))throw Error('Go 线路地址无效');
      return url.origin+'/api/v2';
    }
    snapshot(){return {routes:this.routes.map(row=>({...row,latency_ms:this.latencies.get(row.id)??null})),current:this.current,preferred:this.preferred};}
    onChange(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
    emit(){this.serial++;for(const fn of this.listeners)fn();}
    expire(){}
    async config(base){
      const response=await this.fetchImpl(base+'/client/config',{credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('线路暂时不可用');return response.json();
    }
    async refresh(){
      // Only the configured authority supplies trusted aliases; an alternate
      // endpoint cannot install a new destination for account credentials.
      const config=await this.config(this.base),rows=[];
      for(const raw of config.routes||[]){
        if(!raw.enabled)continue;
        const api=this.endpoint(raw.api_url);if(!raw.id||rows.some(row=>row.id===raw.id||row.api_url===api))continue;
        rows.push({id:String(raw.id),name:String(raw.name||'线路'),api_url:api,ws_url:api.replace(/^http/,'ws')+'/realtime',media_url:new URL(api).origin});
      }
      if(rows.length>32)throw Error('线路清单过大');
      if(!rows.some(row=>row.api_url===this.base))rows.unshift(this.seeds[0]);
      this.routes=rows;this.current=(!this.loaded&&rows.find(row=>row.id===this.preferred))||rows.find(row=>row.id===this.current.id)||rows.find(row=>row.api_url===this.current.api_url)||rows[0];this.loaded=true;this.emit();return true;
    }
    async probe(row){const start=Date.now();await this.config(row.api_url);this.latencies.set(row.id,Date.now()-start);return Date.now()-start;}
    async select(id){const row=this.routes.find(row=>row.id===String(id));if(!row)throw Error('线路不在服务清单中');await this.probe(row);this.current=row;this.preferred=row.id;this.storage?.setItem('pulse.go.route:'+this.base,row.id);this.emit();}
    async failover(previous=this.current){
      if(this.current!==previous)return true;
      for(const row of this.routes){if(row.id===previous.id)continue;try{await this.probe(row);if(this.current!==previous)return true;this.current=row;this.emit();return true;}catch{}}
      return false;
    }
    async request(path,options={},safe=['GET','HEAD'].includes(options.method||'GET')){
      if(!path.startsWith('/')||path.startsWith('//'))throw Error('接口路径无效');
      const previous=this.current,perform=row=>this.fetchImpl(row.api_url+path,{...options,credentials:'omit',redirect:'error',cache:'no-store'});
      try{const response=await perform(previous);if(safe&&[502,503,504].includes(response.status)&&await this.failover(previous)){await response.body?.cancel();return perform(this.current);}return response;}
      catch(error){if(options.signal?.aborted||!await this.failover(previous))throw error;if(safe)return perform(this.current);throw Error('线路已切换，请确认操作结果后重试');}
    }
    async fetch(url,options={}){
      const parsed=new URL(url),base=new URL(this.base);
      const allowed=[...this.seeds,...this.routes].some(row=>new URL(row.api_url).origin===parsed.origin);
      if(!allowed||!parsed.pathname.startsWith(base.pathname+'/'))throw Error('接口地址不属于当前服务');
      const path=parsed.pathname.slice(base.pathname.length)+parsed.search;
      let safe=['GET','HEAD'].includes(options.method||'GET');
      if(options.method==='POST'&&/^\/conversations\/[0-9a-f-]{36}\/messages$/.test(path)){try{safe=!!JSON.parse(options.body).request_id;}catch{}}
      return this.request(path,options,safe);
    }
    mediaURL(value){try{const url=new URL(value,this.base);if(/^\/api\/v2\/media-grants\/[a-f0-9]{64}\/(content|preview)$/.test(url.pathname)&&[...this.seeds,...this.routes].some(row=>new URL(row.api_url).origin===url.origin)){const target=new URL(this.current.api_url);url.protocol=target.protocol;url.host=target.host;}return url.href;}catch{return String(value||'');}}
  }
  return {Manager};
});
