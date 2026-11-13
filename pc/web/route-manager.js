/* Verified route discovery and transport. No business credentials in discovery/probes. */
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.PulseRoutes = value;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TRUST = Object.freeze({ clusterId: 'pulse-im-new-install', publicKeys: {} });
  const decoder = () => new TextDecoder('utf-8', { fatal: true });
  function from64(value) {
    if (typeof value !== 'string' || value.length > 360000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('线路签名格式无效');
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  }
  function derToRaw(signature) {
    let p = 0;
    if (signature[p++] !== 48 || signature[p++] !== signature.length - 2 || signature[p++] !== 2) throw new Error('线路签名无效');
    const first = signature.slice(p + 1, p + 1 + signature[p]); p += 1 + signature[p];
    if (signature[p++] !== 2) throw new Error('线路签名无效');
    const second = signature.slice(p + 1, p + 1 + signature[p]);
    if (p + 1 + signature[p] !== signature.length) throw new Error('线路签名无效');
    const out = new Uint8Array(64);
    [first, second].forEach((part, i) => {
      if (part.length === 33 && part[0] === 0) part = part.slice(1);
      if (!part.length || part.length > 32) throw new Error('线路签名无效');
      out.set(part, i * 32 + 32 - part.length);
    });
    return out;
  }
  function endpoint(value, kind, local = false) {
    if (typeof value !== 'string' || value.length > 2048 || !value.trim() || /[\x00-\x20\x7f]/.test(value)) throw new Error('线路地址无效');
    const u = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]', '10.0.2.2'].includes(u.hostname);
    const expected = kind === 'ws' ? 'wss:' : 'https:';
    if (u.username || u.password || u.search || u.hash || (u.protocol !== expected && !(local && loopback && u.protocol === (kind === 'ws' ? 'ws:' : 'http:')))) throw new Error('线路地址必须使用安全连接');
    if (!local && (!u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname) || /(?:^|\.)(?:localhost|example\.(?:com|org|net)|invalid|test|local)$/.test(u.hostname))) throw new Error('线路域名无效');
    if (kind === 'media' && !u.pathname.replace(/\/+$/, '').endsWith('/storage')) throw new Error('附件入口路径必须以 /storage 结尾');
    return u.href.replace(/\/+$/, '');
  }
  function route(value, local = false) {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 64 || !['string', 'number'].includes(typeof value.id)) throw new Error('线路配置无效');
    return Object.freeze({ id: String(value.id), name: value.name, api_url: endpoint(value.api_url || value.url, 'api', local), ws_url: endpoint(value.ws_url, 'ws', local), media_url: endpoint(value.media_url, 'media', local), sort: Number(value.sort) || 0 });
  }
  async function verify(envelope, { clusterId, publicKeys, now = Date.now(), minRevision = -1, allowLocal = false, expiredDiscoveryOnly = false, crypto = globalThis.crypto }) {
    const pinned = publicKeys?.[envelope?.key_id];
    if (!pinned || envelope.algorithm !== 'ES256-DER') throw new Error('线路清单来自未受信任的签名者');
    const bytes = from64(envelope.payload);
    if (bytes.length > 262144) throw new Error('线路清单过大');
    const key = await crypto.subtle.importKey('spki', from64(pinned), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(from64(envelope.signature)), bytes)) throw new Error('线路清单签名校验失败');
    const data = JSON.parse(decoder().decode(bytes));
    const seconds = Math.floor(now / 1000);
    if (data.version !== 1 || data.cluster_id !== clusterId || !Number.isSafeInteger(data.revision) || data.revision < minRevision || data.revision < 1) throw new Error('线路业务标识或版本无效');
    if (!Number.isSafeInteger(data.issued_at) || !Number.isSafeInteger(data.expires_at) || data.issued_at > seconds + 300 || (!expiredDiscoveryOnly && data.expires_at <= seconds) || data.expires_at <= data.issued_at || data.expires_at - data.issued_at > 604800) throw new Error('线路清单已过期或时间无效');
    if (!Array.isArray(data.routes) || !data.routes.length || data.routes.length > 32 || !Array.isArray(data.discovery_urls) || data.discovery_urls.length > 32) throw new Error('线路清单数量无效');
    const routes = data.routes.map(r => route(r, allowLocal));
    if (new Set(routes.map(r => r.id)).size !== routes.length || new Set(routes.map(r => r.api_url)).size !== routes.length) throw new Error('线路重复');
    return Object.freeze({ ...data, routes, discovery_urls: data.discovery_urls.map(u => endpoint(u, 'discovery', allowLocal)) });
  }
  function mediaPath(raw) {
    let path;
    try {
      path = decodeURIComponent(raw.pathname);
      if (/(?:^|\/)media$/.test(path)) path = raw.searchParams.get('path') || '';
      else if (path.includes('/storage/')) path = path.slice(path.indexOf('/storage/') + 9);
      else return null;
    } catch { return null; }
    return /^(?:uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{32}\.[a-z0-9]{1,8}|work-questions\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{64}\.(?:jpg|png|gif|webp))$/.test(path) ? path : null;
  }
  class Manager {
    constructor(options) {
      this.options = { ...TRUST, ...options };
      this.fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
      this.now = options.now || Date.now;
      this.storage = options.storage;
      this.key = 'pulse_routes_v1:' + this.options.clusterId;
      this.seeds = options.seeds.map(r => route(r, this.options.allowLocal));
      if (!this.seeds.length) throw new Error('缺少内置线路');
      this.routes = this.seeds; this.current = this.seeds[0]; this.preferred = '';
      this.manifest = null; this.knownDiscovery = []; this.lastError = ''; this.listeners = new Set(); this.latencies = new Map();
      this.refreshing = null; this.failing = null; this.revision = -1; this.serial = 0;
      this.ready = this.restore();
    }
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { for (const fn of this.listeners) { try { fn(this.snapshot()); } catch {} } }
    snapshot() { return { current: this.current, preferred: this.preferred, routes: this.routes.map(r => ({ ...r, latency_ms: this.latencies.get(r.id) ?? null })), revision: this.revision, error: this.lastError }; }
    async restore() {
      try {
        const saved = JSON.parse(this.storage?.getItem(this.key) || 'null');
        if (!saved) return;
        let verified;
        try { verified = await verify(saved.envelope, { ...this.options, now: this.now() }); }
        catch {
          // An expired signature may supply anonymous discovery addresses, never auth routes.
          const expired = await verify(saved.envelope, { ...this.options, now: this.now(), expiredDiscoveryOnly: true });
          this.knownDiscovery = expired.discovery_urls; this.revision = expired.revision; return;
        }
        this.install(verified, saved.envelope);
        this.preferred = typeof saved.preferred === 'string' ? saved.preferred : '';
        this.current = this.routes.find(r => r.id === saved.current) || this.routes.find(r => r.id === this.preferred) || this.routes[0];
        this.persist();
      } catch { /* Invalid/expired cache never authorizes an endpoint. Seeds remain pinned. */ }
    }
    persist() {
      if (!this.envelope) return;
      try { this.storage?.setItem(this.key, JSON.stringify({ envelope: this.envelope, current: this.current.id, preferred: this.preferred })); } catch {}
    }
    install(data, envelope) {
      this.manifest = data; this.envelope = envelope; this.revision = data.revision;
      this.knownDiscovery = data.discovery_urls;
      this.routes = data.routes.slice().sort((a, b) => a.sort - b.sort);
      const next = this.routes.find(r => r.id === this.current.id && r.api_url === this.current.api_url) || this.routes.find(r => r.api_url === this.current.api_url) || this.routes[0];
      const changed = this.current.api_url !== next.api_url || this.current.ws_url !== next.ws_url || this.current.media_url !== next.media_url;
      this.current = next; this.serial++; this.persist();
      if (changed) this.emit();
    }
    async json(url, timeout = 4000, maximum = 393216) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.fetchImpl(url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok || Number(response.headers.get('content-length') || 0) > maximum) throw new Error('线路服务暂不可用');
        let bytes;
        if (response.body?.getReader) {
          const reader = response.body.getReader(); const chunks = []; let size = 0;
          for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > maximum) { await reader.cancel(); throw new Error('线路响应过大'); } chunks.push(item.value); }
          bytes = new Uint8Array(size); let p = 0; for (const chunk of chunks) { bytes.set(chunk, p); p += chunk.length; }
        } else { bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > maximum) throw new Error('线路响应过大'); }
        return JSON.parse(decoder().decode(bytes));
      } finally { clearTimeout(timer); }
    }
    async refresh() {
      await this.ready;
      this.expire();
      if (this.refreshing) return this.refreshing;
      this.refreshing = (async () => {
        const sources = [...new Set([this.current.api_url + '/client/route-manifest', ...this.knownDiscovery, ...(this.options.discoveryUrls || []), ...this.seeds.map(r => r.api_url + '/client/route-manifest')])];
        const results = await Promise.allSettled(sources.slice(0, 8).map(async url => {
          const response = await this.json(url);
          return { data: await verify(response.data || response, { ...this.options, now: this.now(), minRevision: this.revision }), envelope: response.data || response };
        }));
        const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => b.data.revision - a.data.revision || b.data.issued_at - a.data.issued_at);
        if (!valid.length) { this.lastError = '暂时无法更新线路，继续使用已验证线路'; this.emit(); return false; }
        this.install(valid[0].data, valid[0].envelope); this.lastError = ''; this.emit(); return true;
      })();
      try { return await this.refreshing; } finally { this.refreshing = null; }
    }
    async probe(item) {
      const nonce = Array.from((this.options.crypto || globalThis.crypto).getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      const start = this.now();
      const response = await this.json(item.api_url + '/client/route-probe?nonce=' + nonce, 3500, 4096);
      if (!response.ok || response.data?.cluster_id !== this.options.clusterId || response.data?.ready !== true || response.data?.nonce !== nonce) throw new Error('线路暂不可接管或不属于当前业务');
      const elapsed = Math.max(0, this.now() - start); this.latencies.set(item.id, elapsed); return elapsed;
    }
    async select(id, manual = true) {
      await this.ready;
      this.expire();
      const item = this.routes.find(r => r.id === String(id)); if (!item) throw new Error('请先更新可用线路');
      await this.probe(item);
      this.expire();
      if (!this.routes.includes(item)) throw new Error('线路配置已更新，请重新选择');
      this.activate(item, manual); return this.snapshot();
    }
    activate(item, manual = false) {
      if (manual) this.preferred = item.id;
      const changed = this.current.api_url !== item.api_url || this.current.ws_url !== item.ws_url || this.current.media_url !== item.media_url;
      this.current = item; this.serial++; this.lastError = ''; this.persist(); if (changed || manual) this.emit();
    }
    async failover(failed = this.current) {
      await this.ready;
      this.expire();
      if (this.current.api_url !== failed.api_url) return true;
      if (this.failing) return this.failing;
      const serial = this.serial;
      this.failing = (async () => {
        const candidates = () => this.routes.filter(r => r.api_url !== failed.api_url).sort((a, b) => (a.id === this.preferred ? -1 : b.id === this.preferred ? 1 : a.sort - b.sort));
        const tryCandidates = async () => {
          const list = candidates();
          for (let offset = 0; offset < list.length; offset += 8) {
            const batch = list.slice(offset, offset + 8);
            const results = await Promise.allSettled(batch.map(item => this.probe(item)));
            this.expire();
            if (this.serial !== serial && this.current.api_url !== failed.api_url) return true;
            const item = batch.find((entry, index) => results[index].status === 'fulfilled' && this.routes.includes(entry));
            if (item) { this.activate(item); return true; }
          }
          return false;
        };
        if (await tryCandidates()) return true;
        await this.refresh();
        if (this.current.api_url !== failed.api_url) { try { await this.probe(this.current); return true; } catch {} }
        return tryCandidates();
      })();
      try { return await this.failing; } finally { this.failing = null; }
    }
    async request(path, options = {}, safeToReplay = false) {
      await this.ready;
      this.expire();
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('接口路径无效');
      const first = this.current;
      const { requestTimeoutMs, ...fetchOptions } = options;
      const attemptTimeout = Number.isFinite(requestTimeoutMs) ? Math.max(500, Math.min(15000, requestTimeoutMs)) : 15000;
      const perform = async item => {
        const controller = new AbortController();
        const cancel = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', cancel, { once: true });
        if (options.signal?.aborted) cancel();
        const timer = setTimeout(() => controller.abort(), options.body instanceof FormData ? 120000 : attemptTimeout);
        try {
          const response = await this.fetchImpl(item.api_url + path, { ...fetchOptions, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
          // Keep the deadline through response consumption, including a cut connection after headers.
          if (!response.body?.getReader) return response;
          const reader = response.body.getReader(); const chunks = []; let length = 0;
          for (;;) { const block = await reader.read(); if (block.done) break; length += block.value.length; if (length > 16777216) { await reader.cancel(); throw new Error('接口响应过大'); } chunks.push(block.value); }
          const bytes = new Uint8Array(length); let position = 0;
          for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
          return new Response([101, 204, 205, 304].includes(response.status) || options.method === 'HEAD' ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
      };
      let response;
      try { response = await perform(first); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        const switched = await this.failover(first);
        if (switched && safeToReplay) return perform(this.current);
        if (switched) { const e = new Error('已切换备用线路，请确认操作结果后重试'); e.cause = error; e.routeChanged = true; throw e; }
        throw error;
      }
      if ([502, 503, 504].includes(response.status)) {
        const switched = await this.failover(first);
        if (switched && safeToReplay) { await response.body?.cancel(); return perform(this.current); }
      }
      return response;
    }
    expire() {
      if (!this.manifest || this.manifest.expires_at > Math.floor(this.now() / 1000)) return;
      this.manifest = null; this.envelope = null; this.routes = this.seeds; this.current = this.seeds[0]; this.serial++;
      this.lastError = '保存的线路已过期，正在尝试更新'; this.emit();
    }
    mediaURL(value) {
      this.expire();
      try {
        const raw = new URL(String(value || ''), this.current.api_url);
        const path = mediaPath(raw); if (!path) return raw.href;
        const target = new URL(this.current.media_url + '/' + path);
        for (const [key, val] of raw.searchParams) if (key !== 'path') target.searchParams.append(key, val);
        return target.href;
      } catch { return String(value || ''); }
    }
  }
  return Object.freeze({ Manager, verify, endpoint, route, mediaPath, derToRaw, TRUST });
});
