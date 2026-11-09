// Keep the signing key outside source archives and web roots. Never print it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error('Pass an absolute private-key directory');
const sourceRoot = path.resolve(__dirname, '..').toLowerCase(), privateRoot = path.resolve(directory).toLowerCase();
if (privateRoot === sourceRoot || privateRoot.startsWith(sourceRoot + path.sep)) throw new Error('Signing keys must stay outside the source workspace and web root');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const privatePath = path.join(directory, 'route-signing-private.pem');
if (!fs.existsSync(privatePath)) {
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  fs.writeFileSync(privatePath, keys.privateKey, { flag: 'wx', mode: 0o600 });
}
const publicKey = crypto.createPublicKey(fs.readFileSync(privatePath));
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const der = publicKey.export({ type: 'spki', format: 'der' });
fs.writeFileSync(path.join(directory, 'route-signing-public.pem'), pem, { mode: 0o644 });
const result = { cluster_id: 'pulse-im-new-install', key_id: crypto.createHash('sha256').update(der).digest('hex').slice(0, 24), public_key_spki: der.toString('base64') };
fs.writeFileSync(path.join(directory, 'public-trust.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify({ ...result, private_key_file: privatePath }) + '\n');
