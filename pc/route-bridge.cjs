// Native child windows use the same verified policy as their owning account.
// An IPC URL alone can never redirect a bearer credential.
const { Manager, verify } = require('./web/route-manager.js');
const { webcrypto } = require('node:crypto');
function createRouteBridge({ runtimeConfig, fetchForProfile, onChange }) {
  const managers = new WeakMap();
  function manager(profile) {
    let entry = managers.get(profile);
    if (!entry) {
      entry = { muted: false };
      const api = runtimeConfig.apiBaseUrl;
      const goMode=new URL(api).pathname.replace(/\/$/,'')==='/api/v2';
      entry.manager = goMode ? new (require('./web/go-routes.js').Manager)({base:api,allowLocal:runtimeConfig.production!==true,fetch:(url,options)=>fetchForProfile(profile,url,options)}) : new Manager({
        ...(runtimeConfig.routePublicKeys ? { publicKeys: runtimeConfig.routePublicKeys, clusterId: runtimeConfig.routeClusterId } : {}),
        seeds: runtimeConfig.routeSeeds || [{ id: 'seed-main', name: '主线路', api_url: api, ws_url: runtimeConfig.websocketUrl, media_url: new URL('/storage', api).href }],
        discoveryUrls: runtimeConfig.routeDiscoveryUrls || [api + '/client/route-manifest'],
        allowLocal: runtimeConfig.production !== true && (runtimeConfig.localPreview === true || ['localhost', '127.0.0.1', '10.0.2.2'].includes(new URL(api).hostname)),
        crypto: webcrypto, fetch: (url, options) => fetchForProfile(profile, url, options),
      });
      entry.manager.onChange(() => { if (!entry.muted) onChange?.(profile, entry.manager.isGo?{goRoute:entry.manager.current.id}:{ envelope: entry.manager.envelope || null, current: entry.manager.current.id }); });
      managers.set(profile, entry);
    }
    return entry;
  }
  return {
    release(profile) { const entry = managers.get(profile); if (entry) { entry.muted = true; entry.manager.listeners.clear(); managers.delete(profile); } },
    async accept(profile, value) {
      const entry = manager(profile), m = entry.manager; await m.ready;
      if (JSON.stringify(value).length > 393216) throw Error('线路证明过大');
      if(m.isGo){
        if(typeof value?.goRoute!=='string')throw Error('线路标识无效');
        if(m.current.id===value.goRoute)return true;
        entry.muted=true;
        try{await m.refresh();await m.select(value.goRoute);}finally{entry.muted=false;}
        return true;
      }
      const data = value?.envelope ? await verify(value.envelope, { ...m.options, minRevision: m.revision }) : null;
      if (data && data.revision < m.revision) throw Error('线路版本已过期');
      const selected = data?.routes.find(r => r.id === String(value.current));
      if (data && !selected) throw Error('线路不在已验证清单中');
      entry.muted = true;
      try {
        if (data) { m.install(data, value.envelope); m.activate(selected); }
        else { m.manifest = null; m.envelope = null; m.routes = m.seeds; m.activate(m.seeds[0]); }
      } finally { entry.muted = false; }
      return true;
    },
    request(profile, path, options) { return manager(profile).manager.request(path, options, ['GET', 'HEAD'].includes(options?.method || 'GET')); },
    mediaURL(profile, value) { return manager(profile).manager.mediaURL(value); },
    messageMediaURL(profile, value, conversationId, messageId, enabled = true, kind = '') {
      const sources = require('./web/media-source.js'), m = manager(profile).manager;
      const raw = m.mediaURL(sources.original(value)), u = sources.source(raw);
      const origins = new Set([...m.seeds, ...m.routes].flatMap(r => [new URL(r.api_url).origin, new URL(r.media_url).origin]));
      return sources.display(raw, profile.accountId, conversationId, messageId, enabled && Boolean(u && origins.has(u.origin)), kind);
    },
    avatarSource(profile, value) {
      const m = manager(profile).manager; m.expire();
      const u = require('./web/avatar-source.js').source(value); if (!u) return null;
      const origins = new Set([...m.seeds, ...m.routes].flatMap(r => [new URL(r.api_url).origin, new URL(r.media_url).origin]));
      return origins.has(u.origin) ? u.href : null;
    },
    mediaSource(profile, value) {
      const m = manager(profile).manager; m.expire();
      const u = require('./web/media-source.js').source(value); if (!u) return null;
      const origins = new Set([...m.seeds, ...m.routes].flatMap(r => [new URL(r.api_url).origin, new URL(r.media_url).origin]));
      return origins.has(u.origin) ? u.href : null;
    },
    current(profile) { const m = manager(profile).manager; m.expire(); return m.current; },
  };
}
module.exports = { createRouteBridge };
