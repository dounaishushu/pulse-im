package core

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"
)

type LocationClient struct {
	Endpoint string
	client   *http.Client
	slots    chan struct{}
}

func NewLocationClient(endpoint string) (*LocationClient, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint != "" && !safeURL(endpoint, false) {
		return nil, ErrInvalid
	}
	u, _ := url.Parse(endpoint)
	switch strings.TrimSuffix(strings.ToLower(u.Hostname()), ".") {
	case "api.map.baidu.com", "my.ippure.com":
		// Retire Baidu; the public self-IP endpoint is not a historical lookup.
		endpoint = ""
	}
	return &LocationClient{Endpoint: endpoint, slots: make(chan struct{}, 4), client: &http.Client{Timeout: 4 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return ErrForbidden }}}, nil
}

func (l *LocationClient) Available() bool { return l != nil && l.Endpoint != "" }

func canonicalIP(raw string) (string, error) {
	ip, err := netip.ParseAddr(raw)
	if err != nil || ip.Zone() != "" {
		return "", ErrInvalid
	}
	return ip.Unmap().String(), nil
}

func (l *LocationClient) Lookup(ctx context.Context, ip string) (string, string, string, error) {
	ip, err := canonicalIP(ip)
	if err != nil {
		return "", "", "", err
	}
	if !l.Available() {
		return "", "", "", &Fault{503, "ip_location_unconfigured"}
	}
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	case <-ctx.Done():
		return "", "", "", ErrBusy
	}
	u, err := url.Parse(l.Endpoint)
	if err != nil {
		return "", "", "", ErrBusy
	}
	q := u.Query()
	q.Set("ip", ip)
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return "", "", "", ErrBusy
	}
	resp, err := l.client.Do(req)
	if err != nil {
		return "", "", "", ErrBusy
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", ErrBusy
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil || len(raw) > 64<<10 {
		return "", "", "", ErrBusy
	}
	return decodeIPLocation(raw, ip)
}

func decodeIPLocation(raw []byte, ip string) (string, string, string, error) {
	var data struct {
		IP       string          `json:"ip"`
		Country  string          `json:"country"`
		Province string          `json:"province"`
		Region   string          `json:"regionName"`
		City     string          `json:"city"`
		Status   json.RawMessage `json:"status"`
	}
	if json.Unmarshal(raw, &data) != nil {
		return "", "", "", ErrBusy
	}
	status := strings.TrimSpace(string(data.Status))
	if strings.HasPrefix(status, `"`) && json.Unmarshal(data.Status, &status) != nil {
		return "", "", "", ErrBusy
	}
	if status != "" && status != "null" && status != "ok" && status != "success" && status != "0" {
		return "", "", "", ErrBusy
	}
	if data.IP != "" {
		returned, err := canonicalIP(data.IP)
		if err != nil || returned != ip {
			return "", "", "", ErrBusy
		}
	}
	if strings.TrimSpace(data.Province) == "" {
		data.Province = data.Region
	}
	country, province, city := strings.TrimSpace(data.Country), strings.TrimSpace(data.Province), strings.TrimSpace(data.City)
	if !validText(country, 0, 128) || !validText(province, 0, 128) || !validText(city, 0, 128) || country == "" && province == "" && city == "" {
		return "", "", "", ErrBusy
	}
	return country, province, city, nil
}

func locationIPs(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > 20 {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	var ips []string
	for _, value := range values {
		ip, err := canonicalIP(value)
		if err != nil {
			return nil, err
		}
		if !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
	}
	sort.Strings(ips)
	return ips, nil
}

type locationResult struct {
	IP                      string `json:"ip"`
	Status                  string `json:"status"`
	Error                   string `json:"error"`
	country, province, city string
}

func (a *API) registerLocations(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/admin/ip-locations/pending", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, _ AdminIdentity) error {
		rows, err := a.Service.Store.Pool.Query(r.Context(), `SELECT DISTINCT host(u.registration_ip) FROM pulse.users u
		 LEFT JOIN pulse.ip_locations l ON l.ip=u.registration_ip WHERE u.registration_ip IS NOT NULL
		 AND l.status IS DISTINCT FROM 'resolved' AND (l.status IS DISTINCT FROM 'failed' OR l.updated_at<now()-interval '10 minutes')
		 ORDER BY host(u.registration_ip) LIMIT 20`)
		if err != nil {
			return err
		}
		defer rows.Close()
		ips := []string{}
		for rows.Next() {
			var ip string
			if err := rows.Scan(&ip); err != nil {
				return err
			}
			ips = append(ips, ip)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": ips, "lookup_available": a.Service.Locations.Available()})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/ip-locations", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if !adminPermission(who.Role, who.Permissions, "stats", false) && !adminPermission(who.Role, who.Permissions, "users", false) {
			return ErrForbidden
		}
		ips, err := locationIPs(r.URL.Query()["ip"])
		if err != nil {
			return err
		}
		rows, err := a.Service.Store.Pool.Query(r.Context(), `SELECT host(ip),country,province,city,status FROM pulse.ip_locations WHERE ip=ANY($1::inet[])`, ips)
		if err != nil {
			return err
		}
		defer rows.Close()
		items := []map[string]string{}
		for rows.Next() {
			var ip, country, province, city, status string
			if err := rows.Scan(&ip, &country, &province, &city, &status); err != nil {
				return err
			}
			items = append(items, map[string]string{"ip": ip, "country": country, "province": province, "city": city, "status": status})
		}
		if err := rows.Err(); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/admin/ip-locations/refresh", a.adminWrap("stats", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var input struct {
			IPs []string `json:"ips"`
		}
		if err := decode(w, r, &input); err != nil {
			return err
		}
		ips, err := locationIPs(input.IPs)
		if err != nil {
			return err
		}
		client := a.Service.Locations
		if !client.Available() {
			return &Fault{503, "ip_location_unconfigured"}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		var lookups errgroup.Group
		lookups.SetLimit(4)
		items := make([]locationResult, len(ips))
		for index, ip := range ips {
			lookups.Go(func() error {
				country, province, city, err := client.Lookup(ctx, ip)
				item := locationResult{IP: ip, Status: "resolved", country: country, province: province, city: city}
				if err != nil {
					item.Status, item.Error = "failed", "lookup_failed"
				}
				items[index] = item
				return nil
			})
		}
		_ = lookups.Wait()
		err = a.Service.adminWrite(r.Context(), who, "stats", "location.refresh", "ip", strings.Join(ips, ","), func(tx pgx.Tx) error {
			for _, item := range items {
				_, err := tx.Exec(r.Context(), `INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES($1,$2,$3,$4,$5)
				 ON CONFLICT(ip) DO UPDATE SET country=$2,province=$3,city=$4,status=$5,updated_at=now()
				 WHERE pulse.ip_locations.status<>'resolved' OR EXCLUDED.status='resolved'`, item.IP, item.country, item.province, item.city, item.Status)
				if err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
}
