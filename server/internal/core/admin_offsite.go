package core

import (
	"encoding/json"
	"net/http"
)

// Report the latest successful login against the registration location. Both
// locations must already have a resolved lookup; no external request occurs
// while rendering the dashboard.
func (a *API) registerAdminOffsite(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/admin/offsite-logins", a.adminWrap("stats", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		page, size, err := clientPage(r)
		if err != nil {
			return err
		}
		const latest = `WITH recent AS (
		  SELECT DISTINCT ON (user_id) user_id,ip,device_name,created_at
		  FROM pulse.login_events WHERE success AND user_id IS NOT NULL
		  ORDER BY user_id,created_at DESC,id DESC
		), located AS (
		  SELECT u.id,u.account,u.nickname,u.avatar_id,u.registration_ip,u.registration_ip AS register_ip,
		         recent.ip AS login_ip,r.country AS register_country,r.province AS register_province,r.city AS register_city,
		         l.country AS login_country,l.province AS login_province,l.city AS login_city,
		         r.status AS register_status,l.status AS login_status,
		         recent.created_at AS login_at,recent.device_name AS login_device,
		         recent.user_id IS NOT NULL AS has_login
		  FROM pulse.users u LEFT JOIN recent ON recent.user_id=u.id
		  LEFT JOIN pulse.ip_locations r ON r.ip=u.registration_ip
		  LEFT JOIN pulse.ip_locations l ON l.ip=recent.ip
		  WHERE u.active AND u.deleted_at IS NULL
		) `
		const differing = `register_status='resolved' AND login_status='resolved' AND
		   (register_country IS DISTINCT FROM login_country OR register_province IS DISTINCT FROM login_province OR register_city IS DISTINCT FROM login_city)`
		var total, active, noLogin, unknown int64
		err = a.Service.Store.Pool.QueryRow(r.Context(), latest+`SELECT count(*) FILTER(WHERE `+differing+`),count(*),
		count(*) FILTER(WHERE NOT has_login),count(*) FILTER(WHERE has_login AND (register_status IS DISTINCT FROM 'resolved' OR login_status IS DISTINCT FROM 'resolved')) FROM located`).Scan(&total, &active, &noLogin, &unknown)
		if err != nil {
			return err
		}
		pendingRows, err := a.Service.Store.Pool.Query(r.Context(), latest+`SELECT DISTINCT host(ip) FROM (
		  SELECT register_ip AS ip FROM located WHERE register_ip IS NOT NULL AND COALESCE(register_status,'unknown') NOT IN ('resolved','failed')
		  UNION ALL SELECT login_ip AS ip FROM located WHERE login_ip IS NOT NULL AND COALESCE(login_status,'unknown') NOT IN ('resolved','failed')
		) x LIMIT 20`)
		if err != nil {
			return err
		}
		nextIPs := []string{}
		for pendingRows.Next() {
			var ip string
			if err = pendingRows.Scan(&ip); err != nil {
				pendingRows.Close()
				return err
			}
			nextIPs = append(nextIPs, ip)
		}
		err = pendingRows.Err()
		pendingRows.Close()
		if err != nil {
			return err
		}
		rows, err := a.Service.Store.Pool.Query(r.Context(), latest+`SELECT jsonb_build_object(
		  'user_id',id::text,'account',account,'nickname',nickname,'avatar_id',COALESCE(avatar_id::text,''),
		  'register_ip',COALESCE(host(register_ip),''),'login_ip',COALESCE(host(login_ip),''),
		  'register_location',concat_ws(' ',register_country,register_province,register_city),
		  'login_location',concat_ws(' ',login_country,login_province,login_city),
		  'login_at',login_at,'login_device',login_device,
		  'difference_level',CASE WHEN register_country IS DISTINCT FROM login_country THEN 'country'
		    WHEN register_province IS DISTINCT FROM login_province THEN 'province' ELSE 'city' END)
		  FROM located WHERE `+differing+` ORDER BY login_at DESC,id LIMIT $1 OFFSET $2`, size, (page-1)*size)
		if err != nil {
			return err
		}
		defer rows.Close()
		items := []json.RawMessage{}
		for rows.Next() {
			var raw []byte
			if err = rows.Scan(&raw); err != nil {
				return err
			}
			items = append(items, json.RawMessage(raw))
		}
		if err = rows.Err(); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items, "total": total, "page": page, "size": size,
			"active_users": active, "checked_users": active - noLogin - unknown, "unknown_users": unknown, "no_login_users": noLogin,
			"next_ips": nextIPs, "pending_ip_count": len(nextIPs), "processed_ips": 0,
			"lookup_available": a.Service.Locations != nil && a.Service.Locations.Endpoint != ""})
		return nil
	}))
}
