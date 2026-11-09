const fs = require('node:fs');
const path = require('node:path');
const { configurationFromEnvironment, validateProductionConfig } = require('./runtime-config.cjs');
try {
  let config = configurationFromEnvironment(process.env);
  const trustPath = process.env.PULSE_ROUTE_TRUST_FILE || path.join(__dirname, '..', 'mobile-contracts', 'route-trust.json');
  const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
  if (!trust.seed_routes.some(row => row.api_url === config.apiBaseUrl)) throw new Error('服务地址与内置线路不一致，请配置 PULSE_ROUTE_TRUST_FILE');
  config = validateProductionConfig({ ...config, routeClusterId: trust.cluster_id, routePublicKeys: { [trust.key_id]: trust.public_key_spki }, routeSeeds: trust.seed_routes, routeDiscoveryUrls: trust.discovery_urls });
  fs.writeFileSync(path.join(__dirname, 'runtime-config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log('生产服务地址校验通过，已生成安装包配置。');
} catch (error) {
  console.error(error.message + '\n请先设置 PULSE_API_URL=https://实际域名/api、PULSE_WS_URL=wss://实际域名/ws。开发运行使用 npm start。');
  process.exitCode = 1;
}
