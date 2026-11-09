#!/usr/bin/env node
'use strict';

// Read only the public-trust.json produced by init-route-trust-20261103.cjs.
// Run this copy from the exported source package, not from its template folder.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function argumentsFrom(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null;
  const allowed = new Set(['--public-trust', '--api', '--ws', '--cluster']);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const option = argv[i];
    if (!allowed.has(option) || Object.hasOwn(result, option) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Unknown, duplicate, or incomplete option. Use --help.');
    }
    result[option] = argv[i + 1];
  }
  if (!result['--public-trust'] || !result['--api'] || !result['--ws']) {
    throw new Error('--public-trust, --api, and --ws are required. Use --help.');
  }
  return result;
}

function rejectSecrets(value) {
  if (typeof value === 'string' && /-----BEGIN[^\r\n]*PRIVATE KEY-----/i.test(value)) {
    throw new Error('Private key material is forbidden; supply only public-trust.json.');
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/private|secret|password|token|credential/i.test(key.replace(/[^a-z0-9]/gi, ''))) {
      throw new Error('Secret fields are forbidden; supply only public-trust.json.');
    }
    rejectSecrets(item);
  }
}

function readPublicTrust(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 16384) throw new Error('Public trust input must be a JSON file smaller than 16 KiB.');
  let input;
  try { input = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Public trust input is not valid JSON.'); }
  rejectSecrets(input);
  const fields = ['cluster_id', 'key_id', 'public_key_spki'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key) || typeof input[key] !== 'string')) {
    throw new Error('Public trust input must contain exactly cluster_id, key_id, and public_key_spki.');
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.cluster_id)) throw new Error('Invalid input cluster_id.');
  if (!/^[a-f0-9]{24}$/.test(input.key_id)) throw new Error('Invalid public key ID.');
  const encoded = input.public_key_spki;
  if (!encoded || encoded.length > 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid public key base64.');
  const der = Buffer.from(encoded, 'base64');
  if (der.toString('base64') !== encoded) throw new Error('Public key base64 must be canonical.');
  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { throw new Error('Public key must use DER SPKI encoding.'); }
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !publicKey.export({ format: 'der', type: 'spki' }).equals(der)) {
    throw new Error('Public key must be a canonical P-256 SPKI public key.');
  }
  if (crypto.createHash('sha256').update(der).digest('hex').slice(0, 24) !== input.key_id) {
    throw new Error('Public key ID does not match SHA-256 of the public key.');
  }
  return input;
}

function checkedOutput(root, relative) {
  const output = path.resolve(root, relative);
  const inside = path.relative(root, output);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('Output must stay inside this source package.');
  // Fixed output names and rejection of symlinks/junctions prevent redirects out
  // of the package. Renames replace existing files without following hard links.
  let cursor = root;
  const parts = inside.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (error.code === 'ENOENT' && i === parts.length - 1) continue; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Output paths must use regular package directories and files, with no symlinks or junctions.');
    }
  }
  return output;
}

function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (!args) {
    console.log('Usage: node tools/configure-client-routes.cjs --public-trust /absolute/private-dir/public-trust.json --api https://YOUR_DOMAIN/api --ws wss://YOUR_DOMAIN/ws [--cluster YOUR_CLUSTER_ID]');
    return;
  }
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  const publicTrust = readPublicTrust(path.resolve(args['--public-trust']));
  const clusterId = args['--cluster'] || publicTrust.cluster_id;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(clusterId)) throw new Error('Cluster ID must contain 1-80 ASCII letters, digits, underscores, or hyphens.');
  const api = new URL(args['--api']);
  const { validateProductionConfig } = require(path.join(root, 'pc', 'runtime-config.cjs'));
  const runtime = validateProductionConfig({
    apiBaseUrl: args['--api'], websocketUrl: args['--ws'], webUrl: '', updateUrl: '',
    routeClusterId: clusterId,
    routePublicKeys: { [publicTrust.key_id]: publicTrust.public_key_spki },
    routeSeeds: [{ id: 'seed-main', name: 'Primary', api_url: args['--api'], ws_url: args['--ws'], media_url: api.origin + '/storage' }],
    routeDiscoveryUrls: [args['--api'].replace(/\/+$/, '') + '/client/route-manifest'],
  });
  runtime.apiBaseUrl = runtime.routeSeeds[0].api_url;
  runtime.websocketUrl = runtime.routeSeeds[0].ws_url;
  const trust = {
    cluster_id: clusterId, key_id: publicTrust.key_id, public_key_spki: publicTrust.public_key_spki,
    seed_routes: runtime.routeSeeds, discovery_urls: runtime.routeDiscoveryUrls,
  };
  const outputs = [
    { path: checkedOutput(root, 'mobile-contracts/route-trust.json'), data: trust },
    { path: checkedOutput(root, 'pc/runtime-config.json'), data: runtime },
  ];
  // Finish every configuration/path validation before touching either output.
  const staged = [];
  try {
    for (const output of outputs) {
      const temporary = output.path + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(output.data, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
      staged.push({ temporary, destination: output.path });
    }
    for (const output of staged) fs.renameSync(output.temporary, output.destination);
  } finally {
    for (const output of staged) { try { fs.unlinkSync(output.temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  console.log('Updated mobile-contracts/route-trust.json and pc/runtime-config.json using public key data only.');
  console.log('Set the backend to the same ROUTE_CLUSTER_ID=' + clusterId);
  console.log('Set the backend ROUTE_DEFAULT_API_URL=' + runtime.apiBaseUrl);
  console.log('Also configure the backend WS/media defaults and private signing-key path; this command does not edit .env.');
  console.log('Run: python3 tools/sync-route-trust-20261103.py');
}

try { main(); }
catch (error) { console.error('Configuration failed: ' + error.message); process.exitCode = 1; }
