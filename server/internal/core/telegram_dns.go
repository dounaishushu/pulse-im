package core

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Telegram alone may use encrypted DNS on hosts with an unreliable system
// resolver. HTTPS still verifies api.telegram.org with the normal trust store.
type telegramDNSResolver struct {
	client    *http.Client
	endpoint  string
	mu        sync.Mutex
	addresses []string
	expires   time.Time
}

func telegramHTTPClient(provider string) (*http.Client, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("Telegram redirect refused")
	}}
	if provider == "" || provider == "system" {
		return client, nil
	}
	var endpoint, bootstrap string
	switch provider {
	case "cloudflare":
		endpoint, bootstrap = "https://cloudflare-dns.com/dns-query?name=api.telegram.org&type=A", "1.1.1.1:443"
	case "google":
		endpoint, bootstrap = "https://dns.google/resolve?name=api.telegram.org&type=A", "8.8.8.8:443"
	default:
		return nil, errors.New("invalid Telegram DNS provider")
	}
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	dohTransport := http.DefaultTransport.(*http.Transport).Clone()
	dohTransport.Proxy = nil
	dohTransport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, bootstrap)
	}
	resolver := &telegramDNSResolver{endpoint: endpoint, client: &http.Client{
		Transport: dohTransport, Timeout: 3 * time.Second, CheckRedirect: client.CheckRedirect,
	}}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || host != "api.telegram.org" || port != "443" {
			return nil, errors.New("unexpected Telegram endpoint")
		}
		addresses, err := resolver.resolve(ctx)
		if err != nil {
			return nil, err
		}
		for _, ip := range addresses {
			connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
			if err == nil {
				return connection, nil
			}
		}
		return nil, errors.New("Telegram connection unavailable")
	}
	client.Transport = transport
	return client, nil
}

func (r *telegramDNSResolver) resolve(ctx context.Context) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.addresses) > 0 && time.Now().Before(r.expires) {
		return append([]string(nil), r.addresses...), nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.endpoint, nil)
	if err != nil {
		return nil, errors.New("Telegram DNS request failed")
	}
	req.Header.Set("Accept", "application/dns-json")
	response, err := r.client.Do(req)
	if err != nil {
		return nil, errors.New("Telegram DNS unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("Telegram DNS rejected request")
	}
	var payload struct {
		Status int
		TC     bool
		Answer []struct {
			Name string
			Type int
			TTL  uint32
			Data string
		}
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 32<<10)).Decode(&payload); err != nil || payload.Status != 0 || payload.TC {
		return nil, errors.New("invalid Telegram DNS response")
	}
	addresses := make([]string, 0, 4)
	ttl := uint32(300)
	for _, answer := range payload.Answer {
		if answer.Type != 1 || !strings.EqualFold(strings.TrimSuffix(answer.Name, "."), "api.telegram.org") {
			continue
		}
		ip, err := netip.ParseAddr(answer.Data)
		if err != nil || !ip.Is4() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
			return nil, errors.New("invalid Telegram DNS address")
		}
		addresses = append(addresses, ip.String())
		if answer.TTL < ttl {
			ttl = answer.TTL
		}
		if len(addresses) == 8 {
			break
		}
	}
	if len(addresses) == 0 {
		return nil, errors.New("Telegram DNS returned no addresses")
	}
	r.addresses, r.expires = addresses, time.Now().Add(time.Duration(ttl)*time.Second)
	return append([]string(nil), addresses...), nil
}
