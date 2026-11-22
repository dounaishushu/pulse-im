// Package geoip supplies a local fallback for IPs without an existing location.
// It never sends user addresses or credentials to an external service.
package geoip

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"io"
	"net/netip"
	"strings"
	"sync"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

const Version = "ip2region v3.19.0"

//go:embed data/ip2region_v4.xdb.gz
var ipv4Data []byte

//go:embed data/ip2region_v6.xdb.gz
var ipv6Data []byte

type Region struct {
	Country, Province, City string
}

type readers struct{ ipv4, ipv6 *xdb.Searcher }

var load = sync.OnceValues(func() (chan readers, error) {
	v4, err := decompress(ipv4Data, 11122742, "a12ad5aca1277d67e525efcda531a20cc0d654ff4f087150d45bc17fca4bc260")
	if err != nil {
		return nil, err
	}
	v6, err := decompress(ipv6Data, 37277813, "939f6b46bd2b8bec3cf7c5ceb8ba782266ae9b1f35b5ba7916700dec0b7506ed")
	if err != nil {
		return nil, err
	}
	pool := make(chan readers, 4)
	for range cap(pool) {
		v4Reader, err := xdb.NewWithBuffer(xdb.IPv4, v4)
		if err != nil {
			return nil, err
		}
		v6Reader, err := xdb.NewWithBuffer(xdb.IPv6, v6)
		if err != nil {
			return nil, err
		}
		pool <- readers{v4Reader, v6Reader}
	}
	return pool, nil
})

func decompress(compressed []byte, size int, checksum string) ([]byte, error) {
	r, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, err
	}
	defer r.Close()
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, err
	}
	// Verify the end/checksum without allowing an unbounded decompression.
	if extra, err := io.ReadAll(io.LimitReader(r, 1)); err != nil || len(extra) != 0 {
		return nil, errors.New("invalid offline IP database size")
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != checksum {
		return nil, errors.New("invalid offline IP database checksum")
	}
	return data, nil
}

var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

// Lookup is safe for concurrent requests. The upstream searcher is not thread
// safe: four independent readers share the two immutable database buffers.
func Lookup(ctx context.Context, input string) (Region, bool) {
	ip, err := netip.ParseAddr(input)
	if err != nil || ip.Zone() != "" || ctx.Err() != nil {
		return Region{}, false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return Region{}, false
	}
	for _, prefix := range reserved {
		if prefix.Contains(ip) {
			return Region{}, false
		}
	}
	pool, err := load()
	if err != nil {
		return Region{}, false
	}
	select {
	case reader := <-pool:
		defer func() { pool <- reader }()
		if ctx.Err() != nil {
			return Region{}, false
		}
		searcher := reader.ipv6
		if ip.Is4() {
			searcher = reader.ipv4
		}
		raw, err := searcher.Search(ip.AsSlice())
		if err != nil {
			return Region{}, false
		}
		return parse(raw)
	case <-ctx.Done():
		return Region{}, false
	}
}

func parse(raw string) (Region, bool) {
	fields := strings.Split(raw, "|")
	if len(fields) != 5 {
		return Region{}, false
	}
	clean := func(value string) string {
		value = strings.TrimSpace(value)
		if value == "0" {
			return ""
		}
		return value
	}
	region := Region{clean(fields[0]), clean(fields[1]), clean(fields[2])}
	return region, region != (Region{})
}
