# HTTPS trust roots

`mozilla-ca-bundle.crt` contains only the 120 public Mozilla CA root certificates
distributed with the locally installed Node.js v24.19.0 (`tls.rootCertificates`).
Exported on 2026-10-19; no private keys or application credentials are included.
Node.js makes the root certificate list available from its Mozilla trust store:
https://nodejs.org/api/tls.html#tlsrootcertificates

The IP location provider uses the PHP `curl.cainfo` or `openssl.cafile` setting
when configured. Otherwise it uses this bundle so that older Windows PHP/cURL
builds can verify HTTPS certificates. `IP_API_CA_BUNDLE` can explicitly select
an administrator-maintained local CA bundle. The provider always verifies both
the certificate chain and the server hostname.

Keep this public bundle current when updating the runtime. To regenerate it
from a trusted current Node.js installation, run from the repository root:

```
node -e "require('node:fs').writeFileSync('backend/config/certs/mozilla-ca-bundle.crt',require('node:tls').rootCertificates.join('\n')+'\n')"
```
