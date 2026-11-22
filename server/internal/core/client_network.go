package core

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"unicode"
)

type clientNetworkInput struct {
	ClientVersion string            `json:"client_version"`
	ExitIP        string            `json:"exit_ip"`
	RiskScore     *float64          `json:"risk_score"`
	Residential   *bool             `json:"is_residential"`
	Broadcast     *bool             `json:"is_broadcast"`
	ExitLocation  *clientIPLocation `json:"exit_location"`
}

type clientIPLocation struct {
	Country  string `json:"country"`
	Province string `json:"province"`
	City     string `json:"city"`
	District string `json:"district"`
}

func (in *clientNetworkInput) normalize(allowIPPure bool) error {
	in.ClientVersion = strings.TrimSpace(in.ClientVersion)
	if in.ClientVersion != "" && !loginClientVersionPattern.MatchString(in.ClientVersion) {
		return ErrInvalid
	}
	if !allowIPPure || in.ExitIP == "" {
		in.ExitIP, in.RiskScore, in.Residential, in.Broadcast = "", nil, nil, nil
		in.ExitLocation = nil
		return nil
	}
	ip, err := netip.ParseAddr(in.ExitIP)
	if err != nil || ip.Zone() != "" {
		return ErrInvalid
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || in.RiskScore != nil && !(*in.RiskScore >= 0 && *in.RiskScore <= 100) {
		return ErrInvalid
	}
	in.ExitIP = ip.String()
	if location := in.ExitLocation; location != nil {
		for _, field := range []*string{&location.Country, &location.Province, &location.City, &location.District} {
			*field = strings.TrimSpace(*field)
			if !validText(*field, 0, 128) || strings.ContainsFunc(*field, unicode.IsControl) {
				return ErrInvalid
			}
		}
		if *location == (clientIPLocation{}) {
			in.ExitLocation = nil
		}
	}
	return nil
}

func (s *Service) recordClientNetwork(ctx context.Context, who Identity, observed string, in clientNetworkInput) error {
	if err := in.normalize(s.IPPureEnabled); err != nil {
		return err
	}
	ip, err := netip.ParseAddr(observed)
	if err != nil || ip.Zone() != "" {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	// The score is supplied by the client. It is advisory, independent of the
	// observed connection address and never inputs to auth or message access.
	observedIP := ip.Unmap().String()
	written, err := tx.Exec(ctx, `INSERT INTO pulse.client_network_observations(session_id,user_id,observed_ip,exit_ip,risk_score,is_residential,is_broadcast,client_version)
	 VALUES($1,$2,$3::inet,NULLIF($4,'')::inet,$5,$6,$7,$8)
	 ON CONFLICT(session_id) DO UPDATE SET observed_ip=EXCLUDED.observed_ip,exit_ip=EXCLUDED.exit_ip,risk_score=EXCLUDED.risk_score,
	 is_residential=EXCLUDED.is_residential,is_broadcast=EXCLUDED.is_broadcast,client_version=EXCLUDED.client_version,checked_at=clock_timestamp()
	 WHERE pulse.client_network_observations.checked_at < clock_timestamp()-interval '1 minute'`,
		who.SessionID, who.UserID, observedIP, in.ExitIP, in.RiskScore, in.Residential, in.Broadcast, in.ClientVersion)
	if err != nil {
		return err
	}
	// Never attribute the API caller's exit location to a different IM address,
	// or let one user populate another user's or the authoritative IP cache.
	if location := in.ExitLocation; written.RowsAffected() > 0 && location != nil && observedIP == in.ExitIP {
		_, err = tx.Exec(ctx, `INSERT INTO pulse.client_reported_ip_locations(user_id,ip,country,province,city,district)
		 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,ip) DO UPDATE SET country=$3,province=$4,city=$5,district=$6,checked_at=now()`,
			who.UserID, observedIP, location.Country, location.Province, location.City, location.District)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (a *API) registerClientNetwork(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/client/network-observation", a.wrap(true, func(w http.ResponseWriter, _ *http.Request, _ Identity) error {
		provider := ""
		if a.Service.IPPureEnabled {
			provider = (&url.URL{Scheme: "https", Host: "my.ippure.com", Path: "/v1/info"}).String()
		}
		writeJSON(w, 200, map[string]string{"ippure_url": provider})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/client/network-observation", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in clientNetworkInput
		if err := decodeLimit(w, r, &in, 4096); err != nil {
			return err
		}
		if err := a.Service.recordClientNetwork(r.Context(), who, a.clientIP(r), in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]bool{"recorded": true})
		return nil
	}))
}
