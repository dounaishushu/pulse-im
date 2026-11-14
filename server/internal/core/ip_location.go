package core

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type LocationClient struct {
	Endpoint string
	client   *http.Client
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
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if e != nil {
		return "", "", "", e
	}
	var data struct {
		Country  string `json:"country"`
		Province string `json:"province"`
		Region   string `json:"regionName"`
		City     string `json:"city"`
		Status   string `json:"status"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Status == "fail" {
		return "", "", "", ErrBusy
	}
	if data.Province == "" {
		data.Province = data.Region
	}
	if !validText(data.Country, 0, 128) || !validText(data.Province, 0, 128) || !validText(data.City, 0, 128) {
		return "", "", "", ErrBusy
	}
	return data.Country, data.Province, data.City, nil
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
				code = "lookup_failed"
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
