"""Synchronize public bootstrap settings into iOS. Never reads a private key."""
from pathlib import Path
import argparse,base64,hashlib,json,plistlib
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
trust=json.loads((ROOT/'mobile-contracts/route-trust.json').read_text(encoding='utf-8'))
der=base64.b64decode(trust['public_key_spki'],validate=True)
assert hashlib.sha256(der).hexdigest()[:24]==trust['key_id'],'public key identity mismatch'
assert 1<=len(trust['seed_routes'])<=32 and len(trust['discovery_urls'])<=32
def endpoint(value,scheme,media=False):
 u=urlparse(value)
 assert u.scheme==scheme and u.hostname and '.' in u.hostname and not all(c in '0123456789.' for c in u.hostname) and not u.username and not u.password and not u.query and not u.fragment,value
 assert not media or u.path.rstrip('/').endswith('/storage'),value
for row in trust['seed_routes']:
 for field,scheme in [('api_url','https'),('ws_url','wss'),('media_url','https')]:endpoint(row[field],scheme,field=='media_url')
for url in trust['discovery_urls']:endpoint(url,'https')
path=ROOT/'ios/PulseIM/Info.plist';data=plistlib.loads(path.read_bytes())
expected={'PulseRouteClusterID':trust['cluster_id'],'PulseRoutePublicKey':trust['public_key_spki'],'PulseRouteSeeds':trust['seed_routes'],'PulseRouteDiscoveryURLs':trust['discovery_urls']}
if args.check:
 assert all(data.get(k)==v for k,v in expected.items()),'Run sync-route-trust-20261103.py after changing the public bootstrap contract'
else:
 data.update(expected);path.write_bytes(plistlib.dumps(data,sort_keys=False))
print(json.dumps({'ok':True,'check_only':args.check,'seed_count':len(trust['seed_routes']),'independent_bootstrap_configured':len({urlparse(u).hostname for u in trust['discovery_urls']})>1,'private_key_read':False}))
