package geoip

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"
)

func TestOfflineLookupEmbeddedIPv4AndIPv6(t *testing.T) {
	for _, tc := range []struct{ ip, country string }{
		{"223.67.221.190", "中国"},
		{"117.5.147.45", "Viet Nam"},
		{"::ffff:223.67.221.190", "中国"},
		{"2001:4860:4860::8888", "United States"},
	} {
		t.Run(tc.ip, func(t *testing.T) {
			region, ok := Lookup(t.Context(), tc.ip)
			t.Logf("%s: %+v", tc.ip, region)
			if !ok || region.Country != tc.country {
				t.Fatalf("embedded IP location missing: %+v %v", region, ok)
			}
		})
	}
}

func TestOfflineLookupRejectsInvalidAndReservedAddresses(t *testing.T) {
	for _, ip := range []string{"", "bad", "8.8.8.8/32", "8.8.8.8%scope", "0.0.0.0", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.1.1", "169.254.1.2", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "224.1.2.3", "255.255.255.255", "::", "::1", "::ffff:192.168.1.1", "fe80::1%eth0", "fd00::1", "2001:db8::1"} {
		if region, found := Lookup(t.Context(), ip); found || region != (Region{}) {
			t.Errorf("assigned a fabricated location to %q: %+v", ip, region)
		}
	}
}

func TestOfflineLookupCancellationAndConcurrentReaders(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, found := Lookup(ctx, "223.67.221.190"); found {
		t.Fatal("cancelled lookup returned a location")
	}
	expected, found := Lookup(t.Context(), "223.67.221.190")
	if !found {
		t.Fatal("missing reference location")
	}
	var group sync.WaitGroup
	for range 128 {
		group.Go(func() {
			for range 20 {
				if region, found := Lookup(t.Context(), "223.67.221.190"); !found || region != expected {
					t.Errorf("concurrent reader returned inconsistent region: %+v", region)
					return
				}
			}
		})
	}
	group.Wait()
}

func TestOfflineDatabaseIntegrityAndDecompressionBounds(t *testing.T) {
	var compressed bytes.Buffer
	w := gzip.NewWriter(&compressed)
	_, _ = w.Write([]byte("test database"))
	_ = w.Close()
	digest := sha256.Sum256([]byte("test database"))
	checksum := hex.EncodeToString(digest[:])
	data, err := decompress(compressed.Bytes(), len("test database"), checksum)
	if err != nil || string(data) != "test database" {
		t.Fatalf("valid database rejected: %q %v", data, err)
	}
	for _, tc := range []struct {
		data     []byte
		size     int
		checksum string
	}{
		{compressed.Bytes(), 3, checksum},
		{compressed.Bytes(), 100, checksum},
		{compressed.Bytes(), len("test database"), "wrong"},
		{compressed.Bytes()[:len(compressed.Bytes())-4], len("test database"), checksum},
	} {
		if _, err := decompress(tc.data, tc.size, tc.checksum); err == nil {
			t.Fatal("accepted corrupted or oversized database")
		}
	}
}

func BenchmarkOfflineLookup(b *testing.B) {
	ctx := context.Background()
	_, _ = Lookup(ctx, "223.67.221.190")
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, found := Lookup(ctx, "223.67.221.190"); !found {
				b.Error("missing location")
			}
		}
	})
}
