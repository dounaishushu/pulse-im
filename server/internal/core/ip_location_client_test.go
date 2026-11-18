package core

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestIPLocationRetiredOrSelfOnlyProviderIsDisabled(t *testing.T) {
	for _, host := range []string{"api.map.baidu.com", "my.ippure.com", "MY.IPPURE.COM."} {
		endpoint := (&url.URL{Scheme: "https", Host: host, Path: "/v1/info"}).String()
		client, err := NewLocationClient(endpoint)
		if err != nil || client.Available() {
			t.Fatalf("unexpected provider: %v", err)
		}
		var failure *Fault
		if _, _, _, err := client.Lookup(context.Background(), "192.0.2.1"); !errors.As(err, &failure) || failure.Code != "ip_location_unconfigured" {
			t.Fatalf("unexpected provider error: %v", err)
		}
	}
}

func TestIPLocationResponseValidation(t *testing.T) {
	const ip = "192.0.2.1"
	for _, raw := range []string{
		`{"status":"success","country":" Test ","regionName":"Example","city":"City","ip":"::ffff:192.0.2.1"}`,
		`{"status":0,"country":"Test","province":"Example","city":"City"}`,
	} {
		country, province, city, err := decodeIPLocation([]byte(raw), ip)
		if err != nil || country != "Test" || province != "Example" || city != "City" {
			t.Fatalf("bad normalization: %q %q %q %v", country, province, city, err)
		}
	}
	for _, raw := range []string{`{"ip":"192.0.2.2","city":"Wrong"}`, `{"status":"fail","city":"Stale"}`, `{"status":210,"city":"Stale"}`, `{"status":0}`, `{`, `[]`, `<html>`, `{"city":"\u0000"}`, `{"city":"` + strings.Repeat("x", 129) + `"}`} {
		if _, _, _, err := decodeIPLocation([]byte(raw), ip); !errors.Is(err, ErrBusy) {
			t.Fatalf("accepted invalid provider output %q: %v", raw, err)
		}
	}
}

func TestIPLocationHTTPBoundaries(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/unexpected", 302)
		case "/oversize":
			_, _ = w.Write([]byte(strings.Repeat("x", 64<<10+1)))
		case "/failure":
			w.WriteHeader(503)
		default:
			t.Error("unexpected provider request")
		}
	}))
	defer provider.Close()
	for _, path := range []string{"/redirect", "/oversize", "/failure"} {
		client, err := NewLocationClient(provider.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, _, err = client.Lookup(context.Background(), "192.0.2.1"); !errors.Is(err, ErrBusy) {
			t.Fatalf("unexpected provider result: %v", err)
		}
		if _, _, _, err = client.Lookup(context.Background(), "192.0.2.1/32"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid input got through: %v", err)
		}
	}
	if calls.Load() != 3 {
		t.Fatalf("redirect or invalid input reached provider: %d", calls.Load())
	}
}
