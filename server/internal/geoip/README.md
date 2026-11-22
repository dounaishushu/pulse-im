# Offline IP location fallback

The authorized staff-profile endpoint uses this database only when neither an
IPPure report for that user/IP nor a resolved server cache entry is available.
Results are labelled `source: offline`; they do not populate either shared cache.
IPPure reports retain priority. IPs, credentials and account IDs are never sent
to an external service by this lookup.

The IPv4 and IPv6 datasets and Go reader are pinned to the official
[ip2region v3.19.0 release](https://github.com/lionsoul2014/ip2region/releases/tag/v3.19.0),
commit `d003e9ea1cbce169488cea7d7de3ac6d6fd00249`.
Copyright belongs to the Ip2Region Authors. The upstream dual MIT/Apache-2.0
license is reproduced in [LICENSE.ip2region.md](LICENSE.ip2region.md).

`data/manifest.json` records upstream blob IDs and SHA-256 checksums. The two
files are losslessly gzip-compressed with an empty filename and mtime zero.
Their exact uncompressed sizes and SHA-256 checksums are checked on first use.
Update the data, pinned reader, manifest, checksums and regression expectations
together when adopting a later upstream release; no runtime download occurs.

The XDB fields are `country|province|city|isp|country_code`. They do **not** contain
a district: the response leaves it empty. Network location is an estimate.
Reserved, private, documentation and invalid IPs are not assigned a location.

Compressed assets add about 12 MiB to the server binary; the uncompressed shared
buffers use about 46 MiB per server process after the first authorized lookup.
Four independent searchers share these immutable buffers because upstream's
searcher is not thread safe. A profile deduplicates its at most 21 candidate IPs.
The PC installer contains neither database and needs no database download.
