# Offline IP location fallback

The authorized staff-profile and admin-user list/detail endpoints use this database only when neither an
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

User management looks up only the already-selected page, after releasing its
PostgreSQL rows/connection. A response-local memo deduplicates registration and
login addresses. The page-limited query and schema-068 index remain unchanged.
Private/reserved addresses and missing province/city fields are not invented.

`data/zh_names.json` is a small presentation-only name catalogue. Chinese city
names come from the pinned XDB, English/ISO country names from the existing
golang.org/x/text CLDR data, and city pinyin aliases were generated offline using
the project's existing pinyin4j 2.5.1 tool dependency. Conventional spellings and
ambiguous prefecture/county names are handled explicitly. No new runtime library
or remote translation service is required. This name translation does not query
the IP database, change a provider's location, or rewrite stored provider data.
Unknown names remain verbatim; uncommon overseas province/city translations are
not exhaustive. An empty province or city stays empty.
