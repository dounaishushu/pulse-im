package core

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTelegramDNSCachesUntilTTLAndSerializesRefresh(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Accept") != "application/dns-json" {
			t.Error("DNS request missing content negotiation")
		}
		_, _ = w.Write([]byte(`{"Status":0,"Answer":[{"name":"api.telegram.org.","type":1,"TTL":60,"data":"203.0.113.8"}]}`))
	}))
	defer server.Close()
	resolver := &telegramDNSResolver{client: server.Client(), endpoint: server.URL}
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			addresses, err := resolver.resolve(context.Background())
			if err != nil || len(addresses) != 1 || addresses[0] != "203.0.113.8" {
				t.Errorf("resolve failed: %v %v", addresses, err)
			}
		})
	}
	workers.Wait()
	if requests.Load() != 1 {
		t.Fatal("concurrent callers caused duplicate DNS refresh")
	}
	resolver.expires = time.Now().Add(-time.Second)
	if _, err := resolver.resolve(context.Background()); err != nil || requests.Load() != 2 {
		t.Fatal("expired DNS addresses did not refresh")
	}
}

func TestTelegramDNSRejectsInvalidReplies(t *testing.T) {
	for _, payload := range []string{
		`{"Status":2}`,
		`{"Status":0,"TC":true}`,
		`{"Status":0,"Answer":[{"name":"api.telegram.org.","type":1,"data":"127.0.0.1"}]}`,
		`{"Status":0,"Answer":[{"name":"api.telegram.org.","type":1,"data":"10.0.0.1"}]}`,
		`{"Status":0,"Answer":[{"name":"unrelated.invalid.","type":1,"data":"203.0.113.8"}]}`,
		`{"Status":0,"Answer":[{"name":"api.telegram.org.","type":1,"data":"invalid"}]}`,
		`not-json`,
	} {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(payload))
		}))
		resolver := &telegramDNSResolver{client: server.Client(), endpoint: server.URL}
		if _, err := resolver.resolve(context.Background()); err == nil {
			t.Error("invalid DNS response accepted")
		}
		server.Close()
	}
}

func TestTelegramDNSProviderScopeAndTLSVerification(t *testing.T) {
	if _, err := telegramHTTPClient("untrusted"); err == nil {
		t.Fatal("unknown DNS provider accepted")
	}
	for _, provider := range []string{"", "system", "cloudflare", "google"} {
		client, err := telegramHTTPClient(provider)
		if err != nil {
			t.Fatal(err)
		}
		if client.CheckRedirect(&http.Request{}, nil) == nil {
			t.Fatal("Telegram redirects became allowed")
		}
		if provider == "" || provider == "system" {
			if client.Transport != nil {
				t.Fatal("system DNS transport changed")
			}
			continue
		}
		transport := client.Transport.(*http.Transport)
		if transport.TLSClientConfig != nil && transport.TLSClientConfig.InsecureSkipVerify {
			t.Fatal("encrypted DNS disabled Telegram TLS verification")
		}
		if _, err = transport.DialContext(context.Background(), "tcp", "unrelated.invalid:443"); err == nil {
			t.Fatal("Telegram DNS policy escaped its hostname scope")
		}
	}
}
