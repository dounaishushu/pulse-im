package core

import (
	"net/http"
	"strings"
)

func adminEntryCookieName(r *http.Request) string {
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		return "__Host-pulse_admin_entry"
	}
	return "pulse_admin_entry_local"
}

// Older browsers retain the entrance as an HttpOnly cookie rather than
// sessionStorage. Explicit credentials always take precedence over that cookie.
func adminRequestEntry(r *http.Request, supplied string) string {
	if supplied != "" {
		return supplied
	}
	if header := r.Header.Get("X-Admin-Entry"); header != "" {
		return header
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return ""
	}
	name := adminEntryCookieName(r)
	scheme := "http"
	if name == "__Host-pulse_admin_entry" {
		scheme = "https"
	}
	if origin := r.Header.Get("Origin"); origin != "" && !strings.EqualFold(origin, scheme+"://"+r.Host) {
		return ""
	}
	entry, found := "", false
	for _, cookie := range r.Cookies() {
		if cookie.Name != name {
			continue
		}
		if found {
			return ""
		}
		entry, found = cookie.Value, true
	}
	return entry
}

func setAdminEntryCookie(w http.ResponseWriter, r *http.Request, entry string) {
	name := adminEntryCookieName(r)
	http.SetCookie(w, &http.Cookie{Name: name, Value: entry, Path: "/", HttpOnly: true,
		Secure: name == "__Host-pulse_admin_entry", SameSite: http.SameSiteStrictMode})
}
