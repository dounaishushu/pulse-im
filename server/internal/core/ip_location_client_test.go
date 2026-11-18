package core

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestIPLocationBaiduNestedResponse(t *testing.T) {
	for _, status := range []string{`0`, `"0"`} {
		t.Run(status, func(t *testing.T) {
			mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("ip") != "192.0.2.1" {
					t.Error("requested IP missing")
				}
				_, _ = w.Write([]byte(`{"address":"CN|广东省|深圳市|None|None|100","content":{"address_detail":{"province":"广东省","city":"深圳市"}},"status":` + status + `}`))
			}))
			defer mock.Close()
			client, err := NewLocationClient(mock.URL)
			if err != nil {
				t.Fatal(err)
			}
			country, province, city, err := client.Lookup(context.Background(), "192.0.2.1")
			if err != nil || country != "中国" || province != "广东省" || city != "深圳市" {
				t.Fatalf("Baidu nested result not decoded: country=%q province=%q city=%q err=%v", country, province, city, err)
			}
		})
	}
}

type ipLocationTransport func(*http.Request) (*http.Response, error)

func (f ipLocationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestIPLocationBaiduServerConfiguration(t *testing.T) {
	const key = "fixture-server-key"
	client, err := NewLocationClientWithBaiduAK("", key)
	if err != nil || client.Endpoint != baiduIPLocationEndpoint || strings.Contains(client.Endpoint, key) {
		t.Fatalf("separate server AK configuration failed: %v", err)
	}
	client.client.Transport = ipLocationTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "api.map.baidu.com" || r.URL.Path != "/location/ip" || r.URL.Query().Get("ak") != key || r.URL.Query().Get("ip") != "192.0.2.2" || r.URL.Query().Get("coor") != "bd09ll" {
			t.Error("wrong Baidu endpoint, AK, coordinate system or requested IP")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":0,"address":"CN|北京","content":{"address_detail":{"province":"北京市","city":"北京市"}}}`)), Header: make(http.Header)}, nil
	})
	country, province, city, err := client.Lookup(context.Background(), "192.0.2.2")
	if err != nil || country != "中国" || province != "北京市" || city != "北京市" {
		t.Fatalf("configured provider did not return its requested location: %q %q %q %v", country, province, city, err)
	}
	t.Run("custom provider retains priority and receives no Baidu AK", func(t *testing.T) {
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("ak") != "" || r.URL.Query().Get("token") != "custom" || r.URL.Query().Get("ip") != "192.0.2.3" {
				t.Error("Baidu key was forwarded to a different provider or original options were lost")
			}
			_, _ = w.Write([]byte(`{"country":"Test","province":"Example","city":"Fixture"}`))
		}))
		defer mock.Close()
		other, err := NewLocationClientWithBaiduAK(mock.URL+"?token=custom", key)
		if err != nil {
			t.Fatal(err)
		}
		_, _, city, err := other.Lookup(context.Background(), "192.0.2.3")
		if err != nil || city != "Fixture" {
			t.Fatalf("custom provider changed: %q %v", city, err)
		}
	})
	t.Run("explicit Baidu URL key retains priority", func(t *testing.T) {
		other, err := NewLocationClientWithBaiduAK(baiduIPLocationEndpoint+"?ak=explicit&coor=gcj02", key)
		if err != nil {
			t.Fatal(err)
		}
		other.client.Transport = ipLocationTransport(func(r *http.Request) (*http.Response, error) {
			if r.URL.Query().Get("ak") != "explicit" || r.URL.Query().Get("coor") != "gcj02" {
				t.Error("explicit Baidu URL parameters overwritten")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":0,"address":"CN|浙江","content":{"address_detail":{"province":"浙江省","city":"杭州市"}}}`)), Header: make(http.Header)}, nil
		})
		if _, _, _, err = other.Lookup(context.Background(), "192.0.2.4"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("no provider remains disabled", func(t *testing.T) {
		other, err := NewLocationClientWithBaiduAK("", "")
		if err != nil || other.Endpoint != "" {
			t.Fatalf("optional provider unexpectedly enabled: %v", err)
		}
		_, _, _, err = other.Lookup(context.Background(), "192.0.2.5")
		var fault *Fault
		if !errors.As(err, &fault) || fault.Code != "ip_location_unconfigured" {
			t.Fatalf("expected unconfigured state: %v", err)
		}
	})
	for _, endpoint := range []string{"ftp://example.org", "https://user:pass@example.org", "https://example.org/#fragment", "http://api.map.baidu.com/location/ip"} {
		t.Run("invalid endpoint "+strings.Split(endpoint, ":")[0], func(t *testing.T) {
			if _, err := NewLocationClientWithBaiduAK(endpoint, key); !errors.Is(err, ErrInvalid) {
				t.Fatalf("unsafe provider accepted: %v", err)
			}
		})
	}
}

func TestIPLocationResponseValidation(t *testing.T) {
	tests := []struct {
		name, raw, country, province, city string
		baidu, bad                         bool
	}{
		{name: "flat provider", raw: `{"country":"CN","province":"广东","city":"深圳"}`, country: "CN", province: "广东", city: "深圳"},
		{name: "flat regionName", raw: `{"status":"success","country":"China","regionName":"广东","city":"深圳"}`, country: "China", province: "广东", city: "深圳"},
		{name: "trim flat fields", raw: `{"status":"ok","country":" 中国 ","province":" 广东 ","city":" 深圳 "}`, country: "中国", province: "广东", city: "深圳"},
		{name: "country-only flat result", raw: `{"country":"US"}`, country: "US"},
		{name: "Baidu foreign country is preserved", raw: `{"status":0,"address":"US|California|Los Angeles","content":{"address_detail":{"province":"California","city":"Los Angeles"}}}`, country: "US", province: "California", city: "Los Angeles", baidu: true},
		{name: "do not invent China when country is missing", raw: `{"status":"0","content":{"address_detail":{"province":"Example","city":"City"}}}`, province: "Example", city: "City", baidu: true},
		{name: "Baidu proxy nested response", raw: `{"status":0,"address":"CN|广东","content":{"address_detail":{"province":"广东省","city":"深圳市"}}}`, country: "中国", province: "广东省", city: "深圳市"},
		{name: "missing Baidu content", raw: `{"status":0}`, baidu: true, bad: true},
		{name: "missing Baidu status", raw: `{"address":"CN","content":{"address_detail":{"province":"广东"}}}`, baidu: true, bad: true},
		{name: "bad Baidu status type", raw: `{"status":false,"content":{"address_detail":{"city":"旧城市"}}}`, baidu: true, bad: true},
		{name: "null Baidu status", raw: `{"status":null,"content":{"address_detail":{"city":"旧城市"}}}`, baidu: true, bad: true},
		{name: "empty generic response cannot be cached as resolved", raw: `{}`, bad: true},
		{name: "empty Baidu response cannot be cached as resolved", raw: `{"status":0,"content":{"address_detail":{}}}`, baidu: true, bad: true},
		{name: "generic failed result cannot expose stale city", raw: `{"status":"fail","city":"旧城市"}`, bad: true},
		{name: "generic error result cannot expose stale city", raw: `{"status":"error","city":"旧城市"}`, bad: true},
		{name: "generic numeric error result", raw: `{"status":210,"city":"旧城市"}`, bad: true},
		{name: "html instead of data", raw: `<html>error</html>`, bad: true},
		{name: "incomplete JSON", raw: `{"status":0`, baidu: true, bad: true},
		{name: "array instead of data", raw: `[]`, bad: true},
		{name: "oversized province", raw: `{"province":"` + strings.Repeat("省", 129) + `"}`, bad: true},
		{name: "nul in location", raw: `{"city":"Bad\u0000City"}`, bad: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			country, province, city, err := decodeIPLocation([]byte(tt.raw), tt.baidu)
			if tt.bad {
				if err == nil || country != "" || province != "" || city != "" {
					t.Fatalf("unusable lookup exposed as resolved: %q %q %q %v", country, province, city, err)
				}
			} else if err != nil || country != tt.country || province != tt.province || city != tt.city {
				t.Fatalf("wrong location: got %q %q %q %v", country, province, city, err)
			}
		})
	}
}

func TestIPLocationBaiduFailureCodesAndKeyRedaction(t *testing.T) {
	for _, status := range []string{`101`, `200`, `210`, `"211"`, `240`, `302`, `401`, `1001`} {
		t.Run(status, func(t *testing.T) {
			country, province, city, err := decodeIPLocation([]byte(`{"status":`+status+`,"message":"provider rejected","content":{"address_detail":{"city":"旧城市"}}}`), true)
			if err == nil || country != "" || province != "" || city != "" || locationLookupErrorCode(err) != "ip_location_baidu_"+strings.Trim(status, `"`) {
				t.Fatalf("provider failure was not preserved safely: %v", err)
			}
		})
	}
	const key = "fixture-private-server-key"
	client, err := NewLocationClientWithBaiduAK("", key)
	if err != nil {
		t.Fatal(err)
	}
	client.client.Transport = ipLocationTransport(func(r *http.Request) (*http.Response, error) {
		return nil, &url.Error{Op: "Get", URL: r.URL.String(), Err: errors.New("provider transport failed")}
	})
	_, _, _, err = client.Lookup(context.Background(), "192.0.2.10")
	if err == nil || strings.Contains(err.Error(), key) || strings.Contains(locationLookupErrorCode(err), key) || locationLookupErrorCode(err) != "lookup_failed" {
		t.Fatalf("outbound URL/key must not escape via errors: %v", err)
	}
}

func TestIPLocationHTTPBoundaries(t *testing.T) {
	for _, tt := range []struct {
		name, body string
		status     int
	}{
		{"HTTP failure", `{"country":"Fake"}`, 503},
		{"oversized response", `{"country":"CN","padding":"` + strings.Repeat("x", 64<<10) + `"}`, 200},
	} {
		t.Run(tt.name, func(t *testing.T) {
			mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer mock.Close()
			client, _ := NewLocationClient(mock.URL)
			country, province, city, err := client.Lookup(context.Background(), "192.0.2.10")
			if err == nil || country != "" || province != "" || city != "" {
				t.Fatalf("HTTP/body limit must reject unusable lookups: %v", err)
			}
		})
	}
	t.Run("redirects cannot forward credentials", func(t *testing.T) {
		var calls atomic.Int32
		mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); http.Redirect(w, r, "/unexpected", 302) }))
		defer mock.Close()
		client, _ := NewLocationClient(mock.URL + "?token=fixture")
		_, _, _, err := client.Lookup(context.Background(), "192.0.2.10")
		if err == nil || calls.Load() != 1 {
			t.Fatalf("provider redirects must remain disabled: calls=%d err=%v", calls.Load(), err)
		}
	})
	t.Run("invalid IP is rejected before any provider request", func(t *testing.T) {
		client, _ := NewLocationClientWithBaiduAK("", "fixture-key")
		client.client.Transport = ipLocationTransport(func(r *http.Request) (*http.Response, error) {
			t.Error("invalid IP reached provider")
			return nil, ErrBusy
		})
		for _, ip := range []string{"", "not-an-ip", "192.0.2.1/32"} {
			if _, _, _, err := client.Lookup(context.Background(), ip); !errors.Is(err, ErrInvalid) {
				t.Fatalf("invalid IP accepted: %v", err)
			}
		}
	})
}
