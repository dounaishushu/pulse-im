package core

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
)

type clientNetworkInput struct {
	ClientVersion string   `json:"client_version"`
	ExitIP        string   `json:"exit_ip"`
	RiskScore     *float64 `json:"risk_score"`
	Residential   *bool    `json:"is_residential"`
	Broadcast     *bool    `json:"is_broadcast"`
}

func (in *clientNetworkInput) normalize(allowIPPure bool) error {
	in.ClientVersion = strings.TrimSpace(in.ClientVersion)
	if in.ClientVersion != "" && !loginClientVersionPattern.MatchString(in.ClientVersion) {
		return ErrInvalid
	}
	if !allowIPPure || in.ExitIP == "" {
		in.ExitIP, in.RiskScore, in.Residential, in.Broadcast = "", nil, nil, nil
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
	_, err = tx.Exec(ctx, `INSERT INTO pulse.client_network_observations(session_id,user_id,observed_ip,exit_ip,risk_score,is_residential,is_broadcast,client_version)
	 VALUES($1,$2,$3::inet,NULLIF($4,'')::inet,$5,$6,$7,$8)
	 ON CONFLICT(session_id) DO UPDATE SET observed_ip=EXCLUDED.observed_ip,exit_ip=EXCLUDED.exit_ip,risk_score=EXCLUDED.risk_score,
	 is_residential=EXCLUDED.is_residential,is_broadcast=EXCLUDED.is_broadcast,client_version=EXCLUDED.client_version,checked_at=clock_timestamp()
	 WHERE pulse.client_network_observations.checked_at < clock_timestamp()-interval '1 minute'`,
		who.SessionID, who.UserID, ip.Unmap().String(), in.ExitIP, in.RiskScore, in.Residential, in.Broadcast, in.ClientVersion)
	if err != nil {
		return err
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
		if err := decodeLimit(w, r, &in, 1024); err != nil {
			return err
		}
		if err := a.Service.recordClientNetwork(r.Context(), who, a.clientIP(r), in); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]bool{"recorded": true})
		return nil
	}))
}
