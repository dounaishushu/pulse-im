const fs = require('node:fs');
const path = require('node:path');
const { configurationFromEnvironment } = require('./runtime-config.cjs');
try {
  // Go route discovery is anchored to the configured HTTPS API. PHP's signed
  // route-manifest template is not part of the Go client trust model.
  const config = configurationFromEnvironment(process.env);
  fs.writeFileSync(path.join(__dirname, 'runtime-config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log('生产服务地址校验通过，已生成安装包配置。');
} catch (error) {
  console.error(error.message + '\n请先设置 PULSE_API_URL=https://实际域名/api/v2、PULSE_WS_URL=wss://实际域名/api/v2/realtime。开发运行使用 npm start。');
  process.exitCode = 1;
}
