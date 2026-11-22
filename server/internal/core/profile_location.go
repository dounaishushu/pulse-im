package core

import (
	"context"
	"encoding/json"
	"strings"

	"pulse.im/server/internal/geoip"
)

// Existing IPPure reports and server cache entries remain authoritative. Only
// authorized staff responses with missing locations use the offline database;
// fallback results never write into either cache or client-reported tables.
func fillOfflineProfileLocations(ctx context.Context, raw []byte) []byte {
	var profile map[string]json.RawMessage
	if json.Unmarshal(raw, &profile) != nil || profile == nil {
		return raw
	}
	type result struct {
		region geoip.Region
		found  bool
	}
	lookedUp := make(map[string]result)
	fill := func(row map[string]json.RawMessage, ipKey, valueKey, detailKey, statusKey string) bool {
		var ip, existing string
		if json.Unmarshal(row[ipKey], &ip) != nil || ip == "" {
			return false
		}
		_ = json.Unmarshal(row[valueKey], &existing)
		if strings.TrimSpace(existing) != "" {
			return false
		}
		var detail struct{ Country, Province, City, District string }
		if json.Unmarshal(row[detailKey], &detail) == nil && strings.TrimSpace(detail.Country+detail.Province+detail.City+detail.District) != "" {
			return false
		}
		cached, checked := lookedUp[ip]
		if !checked {
			cached.region, cached.found = geoip.Lookup(ctx, ip)
			lookedUp[ip] = cached
		}
		if !cached.found {
			return false
		}
		region := cached.region
		encodedDetail, _ := json.Marshal(map[string]any{
			"country": region.Country, "province": region.Province, "city": region.City, "district": "",
			"source": "offline", "reported": false, "database_version": geoip.Version,
		})
		value, _ := json.Marshal(strings.TrimSpace(strings.Join([]string{region.Country, region.Province, region.City}, " ")))
		row[valueKey], row[detailKey], row[statusKey] = value, encodedDetail, json.RawMessage(`"offline"`)
		return true
	}
	changed := fill(profile, "registration_ip", "registration_ip_location", "registration_ip_location_detail", "registration_ip_location_status")
	var logins []map[string]json.RawMessage
	if json.Unmarshal(profile["logins"], &logins) == nil {
		loginChanged := false
		// staffUserProfileSQL limits the read to the latest 20 successful logins.
		for _, login := range logins {
			loginChanged = fill(login, "ip", "location", "location_detail", "location_status") || loginChanged
		}
		if loginChanged {
			profile["logins"], _ = json.Marshal(logins)
			changed = true
		}
	}
	if !changed {
		return raw
	}
	filled, err := json.Marshal(profile)
	if err != nil {
		return raw
	}
	return filled
}
