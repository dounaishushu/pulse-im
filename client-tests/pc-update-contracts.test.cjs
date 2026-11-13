const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require('node:path').join(__dirname, '../pc/main.js'), 'utf8');

async function check(runtimeConfig, manifest) {
  let requested;
  const context = { runtimeConfig, appVersion: '2.4.155', updateCheckController: null, URL, AbortController,
    Promise, setTimeout, clearTimeout, session: { defaultSession: {} },
    globalProxy: { whenIdle: async () => {}, isSessionReady: () => true },
    net: { request(options) {
      requested = options.url;
      const request = new EventEmitter();
      request.setHeader = request.abort = () => {};
      request.end = () => {
        const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
        request.emit('response', response);
        response.emit('data', JSON.stringify(manifest)); response.emit('end');
      };
      return request;
    } },
  };
  vm.runInNewContext(source.slice(source.indexOf('function compareVersions('), source.indexOf('async function checkForUpdate(')), context);
  return { result: await context.readUpdateManifest(), requested: new URL(requested) };
}

test('desktop update checks default to the Go API and consume its release contract', async () => {
  const { result, requested } = await check({ apiBaseUrl: 'https://chat.example.org/api/v2' }, {
    latest_version: '2.5.0', url: 'https://downloads.example.org/client.exe', notes: 'fixture release', update_available: true,
  });
  assert.equal(requested.pathname, '/api/v2/client/update');
  assert.equal(requested.searchParams.get('platform'), 'pc');
  assert.equal(requested.searchParams.get('version'), '2.4.155');
  assert.equal(result.latestVersion, '2.5.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.downloadUrl, 'https://downloads.example.org/client.exe');
});

test('an explicitly configured desktop release manifest keeps its existing contract', async () => {
  const { result, requested } = await check({ updateUrl: 'https://downloads.example.org/desktop.json' }, { version: '2.4.155' });
  assert.equal(requested.pathname, '/desktop.json');
  assert.equal(result.updateAvailable, false);
});

test('Go production packaging accepts a valid authority without the obsolete PHP route-signing template', () => {
  let saved;
  const original = require;
  const context = {
    __dirname: require('node:path').join(__dirname, '../pc'),
    process: { env: { PULSE_API_URL: 'https://api.imapi.shop/api/v2', PULSE_WS_URL: 'wss://api.imapi.shop/api/v2/realtime' }, exitCode: undefined },
    console: { log() {}, error() {} },
    require(name) {
      if (name === 'node:fs') return { writeFileSync(_, value) { saved = JSON.parse(value); }, readFileSync() { throw new Error('Go packaging must not read the PHP trust template'); } };
      if (name === './runtime-config.cjs') return original('../pc/runtime-config.cjs');
      return original(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../pc/prepare-production.cjs'), 'utf8'), context);
  assert.equal(context.process.exitCode, undefined);
  assert.equal(saved.apiBaseUrl, 'https://api.imapi.shop/api/v2');
  assert.equal(saved.websocketUrl, 'wss://api.imapi.shop/api/v2/realtime');
  assert.equal(saved.routePublicKeys, undefined);
  assert.equal(saved.production, true);
});
