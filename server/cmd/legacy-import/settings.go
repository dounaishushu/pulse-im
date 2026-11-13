package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"pulse.im/server/internal/core"
)

func oldString(value any) string {
	switch item := value.(type) {
	case string:
		return item
	case float64:
		return strconv.FormatFloat(item, 'f', -1, 64)
	}
	return ""
}
func oldBool(value any) bool {
	return value == true || oldString(value) == "1" || strings.EqualFold(oldString(value), "true")
}
func oldInt(value any) int {
	number, _ := strconv.Atoi(oldString(value))
	return number
}
func oldJSON(value any, into any) error {
	raw := oldString(value)
	if raw == "" {
		return fmt.Errorf("legacy JSON value is empty")
	}
	return json.Unmarshal([]byte(raw), into)
}
func oldConfigRow(ctx context.Context, i *importer, source string) (map[string]any, error) {
	var payload []byte
	err := i.target.QueryRow(ctx, `SELECT payload FROM pulse.legacy_client_config
 WHERE source=$1 AND legacy_id=1`, source).Scan(&payload)
	if err != nil {
		return nil, err
	}
	var row map[string]any
	if err := json.Unmarshal(payload, &row); err != nil {
		return nil, err
	}
	return row, nil
}
func (i *importer) saveSetting(ctx context.Context, key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = i.target.Exec(ctx, `UPDATE pulse.system_settings SET value=$2::jsonb WHERE key=$1`, key, raw)
	return err
}

func (i *importer) importActiveSettings(ctx context.Context) error {
	config, err := oldConfigRow(ctx, i, "client_app_config")
	if err != nil {
		return err
	}
	registration := map[string]any{
		"enabled":         true,
		"avatar_required": oldBool(config["register_require_avatar"]),
		"per_ip_limit":    oldInt(config["max_register_accounts_per_ip"]),
	}
	if limit := registration["per_ip_limit"].(int); limit < 0 || limit > 100000 {
		return fmt.Errorf("legacy registration IP limit is out of range")
	}
	if err = i.saveSetting(ctx, "registration", registration); err != nil {
		return err
	}
	if err = i.saveSetting(ctx, "display", map[string]any{
		"show_group_count": oldBool(config["show_group_member_count"]),
	}); err != nil {
		return err
	}
	var oldUpdates map[string]map[string]any
	if err = oldJSON(config["platform_updates_json"], &oldUpdates); err != nil {
		return fmt.Errorf("legacy release settings: %w", err)
	}
	releases := map[string]core.ClientRelease{}
	for _, platform := range []string{"pc", "android", "ios", "web"} {
		item := oldUpdates[platform]
		if item == nil {
			item = map[string]any{}
		}
		latest := oldString(item["latest_version"])
		if latest == "" && platform == "pc" {
			latest = oldString(config["latest_version"])
		}
		if latest == "" {
			continue
		}
		minimum := oldString(item["minimum_version"])
		force := oldBool(item["force_update"])
		if force && minimum == "" {
			minimum = latest
		}
		download := ""
		switch platform {
		case "pc":
			download = oldString(config["pc_download_url"])
		case "android":
			download = oldString(config["android_download_url"])
		case "ios":
			download = oldString(config["ios_download_url"])
		}
		releases[platform] = core.ClientRelease{
			Latest: latest, Minimum: minimum, Force: force, URL: download,
			Notes: oldString(config["update_description"]),
		}
	}
	if len(releases) == 0 {
		return fmt.Errorf("legacy release settings are empty")
	}
	if err = i.saveSetting(ctx, "releases", releases); err != nil {
		return err
	}
	shops := []core.NavigationItem{}
	var oldShops []map[string]any
	if err = oldJSON(config["mall_links"], &oldShops); err != nil {
		return fmt.Errorf("legacy shops: %w", err)
	}
	for index, item := range oldShops {
		name, link := oldString(item["name"]), oldString(item["url"])
		if name == "" && link == "" {
			continue
		}
		shops = append(shops, core.NavigationItem{
			ID: fmt.Sprintf("shop-%d", index+1), Title: name, URL: link, Order: index,
		})
	}
	if err = i.saveSetting(ctx, "shops", shops); err != nil {
		return err
	}
	announcement, err := oldConfigRow(ctx, i, "client_announcements")
	if err != nil {
		return err
	}
	if err = i.saveSetting(ctx, "announcement", map[string]any{
		"enabled": oldBool(announcement["enabled"]),
		"title":   oldString(announcement["title"]),
		"body":    oldString(announcement["content"]),
	}); err != nil {
		return err
	}
	navigation, err := oldConfigRow(ctx, i, "client_navigation_config")
	if err != nil {
		return err
	}
	var oldLinks []map[string]any
	if err = oldJSON(navigation["explore_links"], &oldLinks); err != nil {
		return fmt.Errorf("legacy navigation: %w", err)
	}
	links := []core.NavigationItem{}
	for index, item := range oldLinks {
		links = append(links, core.NavigationItem{
			ID:    fmt.Sprintf("explore-%d", index+1),
			Title: oldString(item["name"]), URL: oldString(item["url"]), Order: index,
		})
	}
	if err = i.saveSetting(ctx, "navigation", links); err != nil {
		return err
	}
	rows, err := i.target.Query(ctx, `SELECT payload FROM pulse.legacy_client_config
 WHERE source='client_routes' ORDER BY legacy_id`)
	if err != nil {
		return err
	}
	routes := []core.ClientRoute{}
	for rows.Next() {
		var payload []byte
		if err = rows.Scan(&payload); err != nil {
			rows.Close()
			return err
		}
		var old map[string]any
		if err = json.Unmarshal(payload, &old); err != nil {
			rows.Close()
			return err
		}
		routes = append(routes, core.ClientRoute{
			ID:      fmt.Sprintf("route-%d", oldInt(old["id"])),
			Name:    oldString(old["name"]),
			API:     oldString(old["url"]),
			WS:      oldString(old["ws_url"]),
			Media:   oldString(old["media_url"]),
			Order:   oldInt(old["sort"]),
			Enabled: oldString(old["status"]) == "enabled",
		})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(routes) == 0 {
		return fmt.Errorf("legacy routes are empty")
	}
	return i.saveSetting(ctx, "routes", routes)
}
