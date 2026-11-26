const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { create } = require('../client-shared/go-v2.js');
const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/features/contacts/ipLocation.ts')).href);
const shared = import('../client-shared/ip-location.mjs');

test('chat and profile show country-region-city without omitting China or adding districts', async () => {
  const { ipLocationText, ipLocationSource } = await helpers;
  const value = { country: '中国', province: '广东省', city: '深圳市', district: '南山区', source: 'ippure', reported: true };
  assert.equal(ipLocationText('8.8.8.8', '', 'reported', value), '中国-广东省-深圳市');
  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { ...value, district: '' }), '中国-广东省-深圳市');
  assert.equal(ipLocationText('8.8.8.8', '', 'resolved', { country: '中国', province: '北京市', city: '北京市', district: '' }), '中国-北京市-北京市');
  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { country: 'United States', province: 'California', city: 'Los Angeles', district: '' }), 'United States-California-Los Angeles');
  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { country: 'China' }), 'China');
  assert.match(ipLocationSource(value), /IPPure.*上报/);
});

test('IPPure region and the stored province use the same format without fabricated fields', async () => {
  const { countryRegionCity } = await shared;
  assert.equal(countryRegionCity({ country: ' United States ', region: ' California ', city: 'Los Angeles', district: 'ignored' }), 'United States-California-Los Angeles');
  assert.equal(countryRegionCity({ country: '中国', province: '北京市', city: '北京市' }), '中国-北京市-北京市');
  assert.equal(countryRegionCity({ country: '中国', region: 'bad\u0000region', province: '广东省', city: 12 }), '中国-广东省');
  assert.equal(countryRegionCity({ country: 'x'.repeat(129), province: false, city: '深圳市' }), '深圳市');
  assert.equal(countryRegionCity({ district: '南山区' }), '');
  assert.equal(countryRegionCity(null), '');
});

test('missing IPs, missing historical data, failures and old backends remain distinct', async () => {
  const { ipLocationText } = await helpers;
  assert.equal(ipLocationText('', 'must not display'), '暂无记录');
  assert.equal(ipLocationText('8.8.8.8', '旧版归属地', 'resolved'), '旧版归属地');
  assert.equal(ipLocationText('8.8.8.8', '', 'failed'), '归属地查询失败');
  assert.equal(ipLocationText('8.8.8.8', '', 'unconfigured'), '归属地暂不可用');
  assert.equal(ipLocationText('8.8.8.8', '', 'unknown'), '暂未查到归属地');
});

test('the adapter preserves distinct login and registration location detail from the authorized staff endpoint', async () => {
  const id = '00000001-eeee-4eee-8eee-eeeeeeeeeeee', values = new Map(), paths = [];
  const login = { country: '中国', province: '广东省', city: '深圳市', district: '', source: 'ippure', reported: true };
  const registration = { country: '中国', province: '浙江省', city: '杭州市', district: '西湖区', source: 'ippure', reported: true };
  const client = create({ base: 'https://fixture.invalid/api/v2', storage: { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }, fetch: async raw => {
    paths.push(new URL(raw).pathname);
    return Response.json({ id, registration_ip: '8.8.8.8', registration_ip_location_detail: registration, registration_ip_location_status: 'reported', logins: [{ ip: '7.7.7.7', location_detail: login, location_status: 'reported' }] });
  } });
  client.session('staff');
  const row = await client.request('/contacts/internal-profile?user_id=' + client.local('user', id));
  assert.equal(row.last_login_ip, '7.7.7.7'); assert.equal(row.register_ip, '8.8.8.8');
  assert.deepEqual(row.last_login_location_detail, login); assert.deepEqual(row.register_ip_location_detail, registration);
  assert.deepEqual(paths, ['/api/v2/staff/users/' + id]);
});
