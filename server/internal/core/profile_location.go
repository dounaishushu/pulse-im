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
		localized := localizeLocationFields(row, valueKey, detailKey)
		_ = json.Unmarshal(row[valueKey], &existing)
		if strings.TrimSpace(existing) != "" {
			return localized
		}
		var detail struct{ Country, Province, City, District string }
		if json.Unmarshal(row[detailKey], &detail) == nil && strings.TrimSpace(detail.Country+detail.Province+detail.City+detail.District) != "" {
			return localized
		}
		cached, checked := lookedUp[ip]
		if !checked {
			cached.region, cached.found = geoip.Lookup(ctx, ip)
			lookedUp[ip] = cached
		}
		if !cached.found {
			return localized
		}
		region := geoip.Localize(cached.region)
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

// Translate labels without changing the reported/cached location, provenance,
// or stored provider fields. An IP lookup must never act as a translator.
func localizeLocationFields(row map[string]json.RawMessage, valueKey, detailKey string) bool {
	var detail map[string]json.RawMessage
	if json.Unmarshal(row[detailKey], &detail) != nil || detail == nil {
		return false
	}
	var original geoip.Region
	if raw, exists := detail["country"]; exists && json.Unmarshal(raw, &original.Country) != nil {
		return false
	}
	provinceKey := "province"
	var region string
	if raw, exists := detail["region"]; exists && json.Unmarshal(raw, &region) == nil && strings.TrimSpace(region) != "" {
		provinceKey = "region"
	}
	if raw, exists := detail[provinceKey]; exists && json.Unmarshal(raw, &original.Province) != nil {
		return false
	}
	if raw, exists := detail["city"]; exists && json.Unmarshal(raw, &original.City) != nil {
		return false
	}
	localized := geoip.Localize(original)
	if original == localized {
		return false
	}
	if original.Country != localized.Country {
		detail["country"], _ = json.Marshal(localized.Country)
	}
	if original.Province != localized.Province {
		detail[provinceKey], _ = json.Marshal(localized.Province)
	}
	if original.City != localized.City {
		detail["city"], _ = json.Marshal(localized.City)
	}
	row[detailKey], _ = json.Marshal(detail)
	values := []string{}
	for _, part := range []string{localized.Country, localized.Province, localized.City} {
		if strings.TrimSpace(part) != "" {
			values = append(values, part)
		}
	}
	row[valueKey], _ = json.Marshal(strings.Join(values, " "))
	return true
}
