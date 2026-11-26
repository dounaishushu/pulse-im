package geoip

import (
	_ "embed"
	"encoding/json"
	"strings"
	"sync"

	"golang.org/x/text/unicode/norm"
)

// Name translation uses only a small static catalogue. It never queries an IP
// or changes a provider's geographical decision to that of another provider.
//
//go:embed data/zh_names.json
var chineseNames []byte

type nameCatalogue struct {
	Countries map[string]string            `json:"countries"`
	Provinces map[string]string            `json:"provinces"`
	Cities    map[string]map[string]string `json:"cities"`
	Foreign   map[string]map[string]string `json:"foreign"`
}

var names = sync.OnceValue(func() nameCatalogue {
	var result nameCatalogue
	if err := json.Unmarshal(chineseNames, &result); err != nil {
		// This is a build-time embedded asset, not user input or a network file.
		panic("invalid embedded IP location name catalogue: " + err.Error())
	}
	return result
})

func nameKey(value string) string {
	var result strings.Builder
	for _, ch := range norm.NFD.String(strings.ToLower(value)) {
		if ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' {
			result.WriteRune(ch)
		}
	}
	return result.String()
}

// Localize translates recognized names and preserves unknown names verbatim.
// No missing province/city is invented, and city aliases are province-scoped.
func Localize(region Region) Region {
	catalogue := names()
	if country := catalogue.Countries[nameKey(region.Country)]; country != "" {
		region.Country = country
	}
	if region.Country == "中国" {
		if province := catalogue.Provinces[nameKey(region.Province)]; province != "" {
			region.Province = province
		}
		if city := catalogue.Cities[region.Province][nameKey(region.City)]; city != "" {
			region.City = city
		} else if city := catalogue.Cities[region.Province][strings.TrimSuffix(nameKey(region.City), "city")]; city != "" {
			region.City = city
		}
	} else if foreign := catalogue.Foreign[region.Country]; foreign != nil {
		if province := foreign[nameKey(region.Province)]; province != "" {
			region.Province = province
		}
		if city := foreign[nameKey(region.City)]; city != "" {
			region.City = city
		}
	}
	return region
}
