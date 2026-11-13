const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const routePolicy = require('./web/route-manager.js');

function validateProductionConfig(input) {
  if (input.profile === 'local-preview' || input.localPreview === true) throw new Error('本地测试配置不能用于生产构建');
  const config = { apiBaseUrl: String(input.apiBaseUrl || '').trim(), websocketUrl: String(input.websocketUrl || '').trim(), webUrl: String(input.webUrl || '').trim(), updateUrl: String(input.updateUrl || '').trim(), production: true };
  for (const [field, protocol, required] of [['apiBaseUrl', 'https:', true], ['websocketUrl', 'wss:', true], ['webUrl', 'https:', false], ['updateUrl', 'https:', false]]) {
    const value = config[field];
    if (!value && !required) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`生产构建缺少有效配置：${field}`); }
    if (url.protocol !== protocol || url.username || url.password || /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?)$/i.test(url.hostname) || /\.localhost$/i.test(url.hostname) || /(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)$/i.test(url.hostname)) throw new Error(`生产配置 ${field} 必须是实际服务的 ${protocol.replace(':', '').toUpperCase()} 地址`);
  }
  if (input.routePublicKeys || input.routeSeeds || input.routeDiscoveryUrls || input.routeClusterId) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.routeClusterId || '')) throw new Error('线路业务标识无效');
    const keys = input.routePublicKeys;
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length < 1 || Object.keys(keys).length > 4) throw new Error('线路签名公钥配置无效');
    for (const [id, value] of Object.entries(keys)) {
      if (typeof value !== 'string' || value.length > 1024) throw new Error('线路公钥无效');
      const der = Buffer.from(value, 'base64');
      const publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || crypto.createHash('sha256').update(der).digest('hex').slice(0, 24) !== id) throw new Error('线路公钥标识无效');
    }
    if (!Array.isArray(input.routeSeeds) || !input.routeSeeds.length || input.routeSeeds.length > 32 || !Array.isArray(input.routeDiscoveryUrls) || input.routeDiscoveryUrls.length > 32) throw new Error('内置线路数量无效');
    const seeds = input.routeSeeds.map(row => routePolicy.route(row));
    if (new Set(seeds.map(row => row.api_url)).size !== seeds.length) throw new Error('内置线路重复');
    config.routeClusterId = input.routeClusterId;
    config.routePublicKeys = { ...keys };
    config.routeSeeds = seeds;
    config.routeDiscoveryUrls = input.routeDiscoveryUrls.map(url => routePolicy.endpoint(url, 'discovery'));
  }
  const api = new URL(config.apiBaseUrl), ws = new URL(config.websocketUrl);
  if (api.pathname !== '/api/v2' || api.search || api.hash || ws.href !== api.href.replace(/^https:/, 'wss:') + '/realtime') throw new Error('API 必须为 /api/v2，WebSocket 必须为同一服务的 /api/v2/realtime');
  return config;
}
function configurationFromEnvironment(env) {
  return validateProductionConfig({ apiBaseUrl: env.PULSE_API_URL, websocketUrl: env.PULSE_WS_URL, webUrl: env.PULSE_WEB_URL, updateUrl: env.PULSE_UPDATE_URL });
}
function localPreviewConfig() {
  return { profile: 'local-preview', localPreview: true, production: false, apiBaseUrl: 'http://127.0.0.1:18080/api/v2', websocketUrl: 'ws://127.0.0.1:18080/api/v2/realtime', webUrl: '', updateUrl: '' };
}
function validateLocalPreviewConfig(input) {
  const expected = localPreviewConfig();
  for (const [key, value] of Object.entries(expected)) if (input[key] !== value) throw new Error('本地测试包只允许连接本机 18080 Go API 与消息服务');
  return expected;
}
function loadRuntimeConfig({ packaged, directory, env = process.env, buildProfile = '' }) {
  if (packaged) {
    const input = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-config.json'), 'utf8'));
    return buildProfile === 'local-preview' ? validateLocalPreviewConfig(input) : validateProductionConfig(input);
  }
  return { apiBaseUrl: env.PULSE_API_URL || 'http://127.0.0.1:18080/api/v2', websocketUrl: env.PULSE_WS_URL || 'ws://127.0.0.1:18080/api/v2/realtime', webUrl: env.PULSE_WEB_URL || '', updateUrl: env.PULSE_UPDATE_URL || '', production: false };
}
module.exports = { validateProductionConfig, configurationFromEnvironment, loadRuntimeConfig, localPreviewConfig, validateLocalPreviewConfig };
