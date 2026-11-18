package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type LocationClient struct {
	Endpoint string
	baiduAK  string
	client   *http.Client
}

const baiduIPLocationEndpoint = "https://api.map.baidu.com/location/ip"

func isBaiduIPLocationURL(u *url.URL) bool {
	return strings.EqualFold(u.Hostname(), "api.map.baidu.com") && u.Path == "/location/ip"
}

// Keep an explicitly configured provider. A separate AK selects Baidu when no
// endpoint is configured and is never forwarded to a different provider.
func NewLocationClientWithBaiduAK(endpoint, ak string) (*LocationClient, error) {
	endpoint, ak = strings.TrimSpace(endpoint), strings.TrimSpace(ak)
	if endpoint == "" && ak != "" {
		endpoint = baiduIPLocationEndpoint
	}
	l, err := NewLocationClient(endpoint)
	if err != nil || endpoint == "" {
		return l, err
	}
	u, _ := url.Parse(endpoint)
	if isBaiduIPLocationURL(u) && ak != "" {
		if u.Scheme != "https" || !validText(ak, 1, 256) || strings.ContainsAny(ak, " \t\r\n") {
			return nil, ErrInvalid
		}
		l.baiduAK = ak
	}
	return l, nil
}

func NewLocationClient(endpoint string) (*LocationClient, error) {
	if endpoint != "" && !safeURL(endpoint, false) {
		return nil, ErrInvalid
	}
	return &LocationClient{Endpoint: endpoint, client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return ErrForbidden }}}, nil
}
func (l *LocationClient) Lookup(ctx context.Context, ip string) (country, province, city string, err error) {
	if net.ParseIP(ip) == nil {
		return "", "", "", ErrInvalid
	}
	if l == nil || l.Endpoint == "" {
		return "", "", "", &Fault{503, "ip_location_unconfigured"}
	}
	u, e := url.Parse(l.Endpoint)
	if e != nil {
		return "", "", "", e
	}
	q := u.Query()
	q.Set("ip", ip)
	baidu := isBaiduIPLocationURL(u)
	if baidu {
		if q.Get("ak") == "" && l.baiduAK != "" {
			q.Set("ak", l.baiduAK)
		}
		if q.Get("coor") == "" {
			q.Set("coor", "bd09ll")
		}
	}
	u.RawQuery = q.Encode()
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return "", "", "", e
	}
	resp, e := l.client.Do(req)
	if e != nil {
		return "", "", "", ErrBusy
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", "", "", ErrBusy
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if e != nil {
		return "", "", "", ErrBusy
	}
	if len(raw) > 64<<10 {
		return "", "", "", ErrBusy
	}
	return decodeIPLocation(raw, baidu)
}

func decodeIPLocation(raw []byte, baidu bool) (country, province, city string, err error) {
	var data struct {
		Country  string          `json:"country"`
		Province string          `json:"province"`
		Region   string          `json:"regionName"`
		City     string          `json:"city"`
		Status   json.RawMessage `json:"status"`
		Address  string          `json:"address"`
		Content  *struct {
			AddressDetail struct {
				Province string `json:"province"`
				City     string `json:"city"`
			} `json:"address_detail"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &data) != nil {
		return "", "", "", ErrBusy
	}
	status := strings.TrimSpace(string(data.Status))
	if strings.HasPrefix(status, `"`) && json.Unmarshal(data.Status, &status) != nil {
		return "", "", "", ErrBusy
	}
	if baidu || data.Content != nil {
		if status != "0" {
			if code, e := strconv.Atoi(status); e == nil && code > 0 && code <= 9999 {
				return "", "", "", &Fault{503, "ip_location_baidu_" + strconv.Itoa(code)}
			}
			return "", "", "", ErrBusy
		}
		if data.Content == nil {
			return "", "", "", ErrBusy
		}
		province, city = data.Content.AddressDetail.Province, data.Content.AddressDetail.City
		prefix, _, _ := strings.Cut(data.Address, "|")
		prefix = strings.ToUpper(strings.TrimSpace(prefix))
		if prefix == "CN" {
			country = "中国"
		} else if len(prefix) == 2 && prefix[0] >= 'A' && prefix[0] <= 'Z' && prefix[1] >= 'A' && prefix[1] <= 'Z' {
			country = prefix
		}
	} else {
		if status != "" && status != "null" && status != "success" && status != "ok" && status != "0" {
			return "", "", "", ErrBusy
		}
		country, province, city = data.Country, data.Province, data.City
		if province == "" {
			province = data.Region
		}
	}
	country, province, city = strings.TrimSpace(country), strings.TrimSpace(province), strings.TrimSpace(city)
	if !validText(country, 0, 128) || !validText(province, 0, 128) || !validText(city, 0, 128) || country == "" && province == "" && city == "" {
		return "", "", "", ErrBusy
	}
	return country, province, city, nil
}

func locationLookupErrorCode(err error) string {
	var fault *Fault
	if errors.As(err, &fault) && strings.HasPrefix(fault.Code, "ip_location_baidu_") {
		return fault.Code
	}
	return "lookup_failed"
}
func (a *API) registerLocations(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/admin/ip-locations/pending", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		rows, e := a.Service.Store.Pool.Query(r.Context(), `SELECT DISTINCT host(u.registration_ip) FROM pulse.users u
		  LEFT JOIN pulse.ip_locations l ON l.ip=u.registration_ip
		  WHERE u.registration_ip IS NOT NULL AND COALESCE(l.status,'unknown') NOT IN ('resolved','failed')
		  ORDER BY host(u.registration_ip) LIMIT 20`)
		if e != nil {
			return e
		}
		defer rows.Close()
		ips := []string{}
		for rows.Next() {
			var ip string
			if e = rows.Scan(&ip); e != nil {
				return e
			}
			ips = append(ips, ip)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": ips, "lookup_available": a.Service.Locations != nil && a.Service.Locations.Endpoint != ""})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/ip-locations", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if !adminPermission(who.Role, who.Permissions, "stats", false) && !adminPermission(who.Role, who.Permissions, "users", false) {
			return ErrForbidden
		}
		ips := r.URL.Query()["ip"]
		if len(ips) == 0 || len(ips) > 20 {
			return ErrInvalid
		}
		for _, ip := range ips {
			if net.ParseIP(ip) == nil {
				return ErrInvalid
			}
		}
		rows, e := a.Service.Store.Pool.Query(r.Context(), "SELECT host(ip),country,province,city,status FROM pulse.ip_locations WHERE ip=ANY($1::inet[])", ips)
		if e != nil {
			return e
		}
		defer rows.Close()
		items := []map[string]string{}
		for rows.Next() {
			var ip, country, province, city, status string
			if e = rows.Scan(&ip, &country, &province, &city, &status); e != nil {
				return e
			}
			items = append(items, map[string]string{"ip": ip, "country": country, "province": province, "city": city, "status": status})
		}
		if e = rows.Err(); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/admin/ip-locations/refresh", a.adminWrap("stats", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			IPs []string `json:"ips"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.IPs) < 1 || len(in.IPs) > 20 {
			return ErrInvalid
		}
		if a.Service.Locations == nil || a.Service.Locations.Endpoint == "" {
			return &Fault{503, "ip_location_unconfigured"}
		}
		items := []map[string]string{}
		for _, ip := range in.IPs {
			if net.ParseIP(ip) == nil {
				return ErrInvalid
			}
			country, province, city, e := a.Service.Locations.Lookup(r.Context(), ip)
			status := "resolved"
			code := ""
			if e != nil {
				status = "failed"
				code = locationLookupErrorCode(e)
			}
			saveErr := a.Service.adminWrite(r.Context(), who, "stats", "location.refresh", "ip", ip, func(tx pgx.Tx) error {
				_, e := tx.Exec(r.Context(), "INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(ip) DO UPDATE SET country=$2,province=$3,city=$4,status=$5,updated_at=now()", ip, strings.TrimSpace(country), strings.TrimSpace(province), strings.TrimSpace(city), status)
				return e
			})
			if saveErr != nil {
				return saveErr
			}
			items = append(items, map[string]string{"ip": ip, "status": status, "error": code})
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
}
