package core

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math/big"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
	"golang.org/x/image/font"
	"golang.org/x/image/font/basicfont"
	"golang.org/x/image/math/fixed"
)

// The old username registration route accepts 5-32 letters/digits with a
// letter first. The single-page client may impose a narrower presentation rule.
var accountPattern = regexp.MustCompile(`^[a-z][a-z0-9]{4,31}$`)
var phonePattern = regexp.MustCompile(`^[0-9+ -]{6,32}$`)

func uniqueFault(err error) error {
	var e *pgconn.PgError
	if errors.As(err, &e) && e.Code == "23505" {
		return &Fault{409, "already_exists"}
	}
	return err
}
func nullableIP(ip string) any {
	if net.ParseIP(ip) == nil {
		return nil
	}
	return ip
}
func readSetting(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, key string, dest any) error {
	var raw []byte
	if err := q.QueryRow(ctx, "SELECT value FROM pulse.system_settings WHERE key=$1", key).Scan(&raw); err != nil {
		return err
	}
	return json.Unmarshal(raw, dest)
}

type RegistrationPolicy struct {
	Enabled        bool `json:"enabled"`
	AvatarRequired bool `json:"avatar_required"`
	PerIPLimit     int  `json:"per_ip_limit"`
}
type Captcha struct {
	ID        string `json:"id"`
	Image     string `json:"image"`
	ExpiresIn int    `json:"expires_in"`
}

func randomCode(n int) string {
	const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	b := make([]byte, n)
	for i := range b {
		v, e := rand.Int(rand.Reader, big.NewInt(int64(len(chars))))
		if e != nil {
			panic(e)
		}
		b[i] = chars[v.Int64()]
	}
	return string(b)
}
func (s *Service) Captcha(ctx context.Context, ip string) (Captcha, error) {
	if err := s.Cache.Allow(ctx, "captcha", ip, 10, time.Minute); err != nil {
		return Captcha{}, err
	}
	id, code := opaqueToken(), randomCode(5)
	// Only a PNG is returned. Answers and drawing instructions never leave the server.
	canvas := image.NewRGBA(image.Rect(0, 0, 150, 50))
	for y := 0; y < 50; y++ {
		for x := 0; x < 150; x++ {
			canvas.Set(x, y, color.RGBA{235, 240, 245, 255})
		}
	}
	for i := 0; i < 250; i++ {
		v := make([]byte, 3)
		if _, e := rand.Read(v); e != nil {
			return Captcha{}, e
		}
		canvas.Set(int(v[0])%150, int(v[1])%50, color.RGBA{v[2], 120, 160, 255})
	}
	d := font.Drawer{Dst: canvas, Src: image.NewUniform(color.RGBA{24, 42, 64, 255}), Face: basicfont.Face7x13}
	for i, c := range code {
		d.Dot = fixed.P(18+i*25, 28+(i%2)*4)
		d.DrawString(string(c))
	}
	var b bytes.Buffer
	if err := png.Encode(&b, canvas); err != nil {
		return Captcha{}, err
	}
	if err := s.Cache.Client.Set(ctx, s.Cache.Prefix+"captcha:"+hex.EncodeToString(digest(id)), hex.EncodeToString(digest(ip+":"+code)), 120*time.Second).Err(); err != nil {
		return Captcha{}, ErrBusy
	}
	return Captcha{id, "data:image/png;base64," + base64.StdEncoding.EncodeToString(b.Bytes()), 120}, nil
}
func (s *Service) consumeCaptcha(ctx context.Context, ip, id, code string) error {
	if len(id) != 64 || len(code) > 20 {
		return ErrInvalid
	}
	value, err := takeScript.Run(ctx, s.Cache.Client, []string{s.Cache.Prefix + "captcha:" + hex.EncodeToString(digest(id))}).Text()
	if errors.Is(err, redis.Nil) {
		return &Fault{400, "captcha_invalid_or_expired"}
	}
	if err != nil {
		return ErrBusy
	}
	if subtle.ConstantTimeCompare([]byte(value), []byte(hex.EncodeToString(digest(ip+":"+strings.ToUpper(strings.TrimSpace(code)))))) != 1 {
		return &Fault{400, "captcha_invalid_or_expired"}
	}
	return nil
}

type RegisterInput struct {
	AvatarBase64   string `json:"avatar_base64,omitempty"`
	AvatarFilename string `json:"avatar_filename,omitempty"`
	Account        string `json:"account"`
	Phone          string `json:"phone,omitempty"`
	Nickname       string `json:"nickname"`
	Password       string `json:"password"`
	CaptchaID      string `json:"captcha_id"`
	CaptchaCode    string `json:"captcha_code"`
}

func (s *Service) Register(ctx context.Context, in RegisterInput, ip string) (string, error) {
	if err := s.Cache.Allow(ctx, "register", ip, 5, time.Minute); err != nil {
		return "", err
	}
	if err := s.consumeCaptcha(ctx, ip, in.CaptchaID, in.CaptchaCode); err != nil {
		return "", err
	}
	in.Account = strings.ToLower(strings.TrimSpace(in.Account))
	in.Phone = strings.TrimSpace(in.Phone)
	in.Nickname = strings.TrimSpace(in.Nickname)
	if (in.Account == "" && in.Phone == "") || (in.Account != "" && !accountPattern.MatchString(in.Account)) || (in.Phone != "" && !phonePattern.MatchString(in.Phone)) || !validText(in.Nickname, 2, 32) {
		return "", ErrInvalid
	}
	if in.Account != "" {
		letter, digit := false, false
		for _, r := range in.Password {
			letter = letter || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
			digit = digit || (r >= '0' && r <= '9')
			if unicode.IsSpace(r) {
				return "", ErrInvalid
			}
		}
		if !letter || !digit {
			return "", ErrInvalid
		}
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return "", ErrBusy
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		return "", err
	}
	id := newID()
	internalAccount := in.Account == ""
	accountChanges := 1
	if internalAccount {
		in.Account = "__phone_only__" + strings.ReplaceAll(id, "-", "")
		accountChanges = 0
	}
	avatar, cleanup, err := s.prepareRegistrationAvatar(ctx, id, in.AvatarFilename, in.AvatarBase64)
	if err != nil {
		return "", err
	}
	defer cleanup()
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	// Registration policy and IP quota are checked in the same transaction as creation.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(7157)"); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,7150))", ip); err != nil {
		return "", err
	}
	var policy RegistrationPolicy
	if err = readSetting(ctx, tx, "registration", &policy); err != nil {
		return "", err
	}
	if !policy.Enabled {
		return "", &Fault{403, "registration_disabled"}
	}
	if policy.AvatarRequired && avatar == nil {
		return "", &Fault{400, "registration_avatar_required"}
	}
	if policy.PerIPLimit > 0 && nullableIP(ip) == nil {
		return "", ErrInvalid
	}
	if policy.PerIPLimit > 0 {
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.users WHERE registration_ip=$1 AND deleted_at IS NULL", nullableIP(ip)).Scan(&count); err != nil {
			return "", err
		}
		if count >= policy.PerIPLimit {
			return "", &Fault{429, "registration_ip_limit"}
		}
	}
	_, err = tx.Exec(ctx, "INSERT INTO pulse.users(id,account,nickname,password_hash,registration_ip,can_create_group,phone,account_is_internal,account_changes) VALUES($1,$2,$3,$4,$5,false,NULLIF($6,''),$7,$8)", id, in.Account, in.Nickname, hash, nullableIP(ip), in.Phone, internalAccount, accountChanges)
	if err != nil {
		return "", uniqueFault(err)
	}
	if avatar != nil {
		if err = insertRegistrationAvatar(ctx, tx, id, *avatar); err != nil {
			return "", err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	if avatar != nil {
		avatar.keep = true
	}
	return id, nil
}

type LoginOptions struct {
	SecondFactor string `json:"second_factor"`
	Platform     string `json:"platform"`
	DeviceName   string `json:"device_name"`
}

func normalizeLoginOptions(in LoginOptions) (LoginOptions, error) {
	if in.Platform == "" {
		in.Platform = "unknown"
	}
	if !validText(in.DeviceName, 0, 128) || len(in.SecondFactor) > 256 {
		return in, ErrInvalid
	}
	switch in.Platform {
	case "unknown", "pc", "web", "android", "ios":
		return in, nil
	}
	return in, ErrInvalid
}

type securityRecord struct {
	Hash     string
	Recovery []string
	Version  int64
}

func readSecurity(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, uid string) (securityRecord, error) {
	var r securityRecord
	err := q.QueryRow(ctx, "SELECT password_hash,recovery_hashes,version FROM pulse.security WHERE user_id=$1", uid).Scan(&r.Hash, &r.Recovery, &r.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil
	}
	return r, err
}
func verifySecondFactor(r securityRecord, code string) (string, error) {
	if r.Hash == "" {
		return "", nil
	}
	if code == "" {
		return "", &Fault{401, "second_factor_required"}
	}
	if verifyPassword(code, r.Hash) {
		return "", nil
	}
	h := hex.EncodeToString(digest(strings.ToUpper(strings.TrimSpace(code))))
	for _, old := range r.Recovery {
		if subtle.ConstantTimeCompare([]byte(h), []byte(old)) == 1 {
			return h, nil
		}
	}
	return "", ErrUnauthorized
}
func (s *Service) Security(ctx context.Context, who Identity) (map[string]any, error) {
	r, e := readSecurity(ctx, s.Store.Pool, who.UserID)
	return map[string]any{"enabled": r.Hash != "", "recovery_codes_remaining": len(r.Recovery)}, e
}

type SecurityInput struct {
	Action        string `json:"action"`
	LoginPassword string `json:"login_password"`
	Current       string `json:"current"`
	Next          string `json:"next"`
}

func (s *Service) UpdateSecurity(ctx context.Context, who Identity, in SecurityInput) (map[string]any, error) {
	if in.Action != "enable" && in.Action != "disable" && in.Action != "change" && in.Action != "recovery" {
		return nil, ErrInvalid
	}
	if err := s.Cache.Allow(ctx, "security", who.UserID, 10, 15*time.Minute); err != nil {
		return nil, err
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return nil, ErrBusy
	}
	var password string
	if err := s.Store.Pool.QueryRow(ctx, "SELECT password_hash FROM pulse.users WHERE id=$1 AND active", who.UserID).Scan(&password); err != nil {
		return nil, err
	}
	if !verifyPassword(in.LoginPassword, password) {
		return nil, ErrUnauthorized
	}
	old, err := readSecurity(ctx, s.Store.Pool, who.UserID)
	if err != nil {
		return nil, err
	}
	if (in.Action == "enable") != (old.Hash == "") {
		return nil, ErrConflict
	}
	if _, err = verifySecondFactor(old, in.Current); err != nil {
		return nil, err
	}
	hash := old.Hash
	if in.Action == "enable" || in.Action == "change" {
		if len(in.Next) < 8 || len(in.Next) > 128 {
			return nil, ErrInvalid
		}
		hash, err = hashSecret(in.Next)
		if err != nil {
			return nil, err
		}
	}
	codes, hashes := []string{}, []string{}
	if in.Action != "disable" {
		for i := 0; i < 8; i++ {
			c := strings.ToUpper(opaqueToken()[:32])
			codes = append(codes, c)
			hashes = append(hashes, hex.EncodeToString(digest(c)))
		}
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var current string
	if err = tx.QueryRow(ctx, "SELECT password_hash FROM pulse.users WHERE id=$1 AND active FOR UPDATE", who.UserID).Scan(&current); err != nil {
		return nil, err
	}
	if current != password {
		return nil, ErrConflict
	}
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return nil, err
	}
	record, err := readSecurity(ctx, tx, who.UserID)
	if err != nil {
		return nil, err
	}
	if record.Version != old.Version || record.Hash != old.Hash {
		return nil, ErrConflict
	}
	if in.Action == "disable" {
		_, err = tx.Exec(ctx, "DELETE FROM pulse.security WHERE user_id=$1", who.UserID)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO pulse.security(user_id,password_hash,recovery_hashes) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET password_hash=$2,recovery_hashes=$3,version=pulse.security.version+1`, who.UserID, hash, hashes)
	}
	if err != nil {
		return nil, err
	}
	// Changing protection invalidates other devices; the caller remains available to finish its settings flow.
	if _, err = tx.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL", who.UserID, who.SessionID); err != nil {
		return nil, err
	}
	return map[string]any{"enabled": in.Action != "disable", "recovery_codes": codes}, tx.Commit(ctx)
}
func (s *Service) enforceLoginPolicy(ctx context.Context, tx pgx.Tx, uid, device string, opt LoginOptions, old securityRecord, recovery string) error {
	current, err := readSecurity(ctx, tx, uid)
	if err != nil {
		return err
	}
	if current.Hash != old.Hash || current.Version != old.Version {
		return ErrConflict
	}
	if recovery != "" {
		found := false
		for _, h := range current.Recovery {
			if h == recovery {
				found = true
			}
		}
		if !found {
			return ErrUnauthorized
		}
		if _, err = tx.Exec(ctx, "UPDATE pulse.security SET recovery_hashes=array_remove(recovery_hashes,$2),version=version+1 WHERE user_id=$1", uid, recovery); err != nil {
			return err
		}
	}
	if opt.Platform != "android" && opt.Platform != "ios" {
		return nil
	}
	var policy struct {
		Enabled bool `json:"enabled"`
	}
	if err = readSetting(ctx, tx, "mobile_binding", &policy); err != nil {
		return err
	}
	var internal bool
	if err = tx.QueryRow(ctx, "SELECT internal_staff FROM pulse.users WHERE id=$1", uid).Scan(&internal); err != nil {
		return err
	}
	if !policy.Enabled || internal {
		return nil
	}
	var bound []byte
	err = tx.QueryRow(ctx, "SELECT device_hash FROM pulse.mobile_bindings WHERE user_id=$1", uid).Scan(&bound)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, "INSERT INTO pulse.mobile_bindings(user_id,device_hash,platform,device_name) VALUES($1,$2,$3,$4)", uid, digest(device), opt.Platform, opt.DeviceName)
	} else if err == nil {
		if !bytes.Equal(bound, digest(device)) {
			return &Fault{403, "mobile_device_bound"}
		}
		_, err = tx.Exec(ctx, "UPDATE pulse.mobile_bindings SET last_login_at=now(),device_name=$2 WHERE user_id=$1", uid, opt.DeviceName)
	}
	return err
}
func (a *API) registerAccounts(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/auth/captcha", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		v, e := a.Service.Captcha(r.Context(), a.clientIP(r))
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/auth/register", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		select {
		case a.Service.registrationSlots <- struct{}{}:
			defer func() { <-a.Service.registrationSlots }()
		default:
			return ErrBusy
		}
		var in RegisterInput
		if e := decodeLimit(w, r, &in, 14<<20); e != nil {
			return e
		}
		id, e := a.Service.Register(r.Context(), in, a.clientIP(r))
		if e == nil {
			writeJSON(w, 201, map[string]string{"id": id})
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/me/security", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		v, e := a.Service.Security(r.Context(), who)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/me/security", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in SecurityInput
		if e := decode(w, r, &in); e != nil {
			return e
		}
		v, e := a.Service.UpdateSecurity(r.Context(), who, in)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
}
