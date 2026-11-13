package core

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"strings"
	"sync"
	"time"
)

type Service struct {
	activity          chan Identity
	Locations         *LocationClient
	RuntimeDir        string
	Telegram          *TelegramTransport
	Push              *PushTransport
	wordMu            sync.Mutex
	words             *strings.Replacer
	wordsUntil        time.Time
	Media             *MediaStore
	Store             *Store
	Cache             *Cache
	Wake              chan struct{}
	passwordSlots     chan struct{}
	registrationSlots chan struct{}
	importSlots       chan struct{}
	dummyHash         string
}

func NewService(store *Store, cache *Cache) (*Service, error) {
	dummy, err := hashPassword(opaqueToken())
	if err != nil {
		return nil, err
	}
	return &Service{Store: store, Cache: cache, activity: make(chan Identity, 2048), Wake: make(chan struct{}, 1), passwordSlots: make(chan struct{}, 2), registrationSlots: make(chan struct{}, 2), importSlots: make(chan struct{}, 1), dummyHash: dummy}, nil
}
func (s *Service) notify() {
	select {
	case s.Wake <- struct{}{}:
	default:
	}
}

// CreateUser is an operator CLI/migration primitive, not public registration.
// Public registration enforces captcha and registration policy through a separate API.
func (s *Service) CreateUser(ctx context.Context, account, password string) (string, error) {
	account = strings.ToLower(strings.TrimSpace(account))
	if !validText(account, 3, 64) || len(account) > 64 {
		return "", ErrInvalid
	}
	hash, err := hashPassword(password)
	if err != nil {
		return "", err
	}
	id := newID()
	_, err = s.Store.Pool.Exec(ctx, "INSERT INTO pulse.users(id,account,password_hash) VALUES($1,$2,$3)", id, account, hash)
	return id, err
}
func (s *Service) Login(ctx context.Context, account, password, deviceID, ip string, options ...LoginOptions) (result Login, resultErr error) {
	opt := LoginOptions{}
	if len(options) > 0 {
		opt = options[0]
	}
	opt, optionErr := normalizeLoginOptions(opt)
	if optionErr != nil {
		return Login{}, optionErr
	}
	account = strings.ToLower(strings.TrimSpace(account))
	if !validText(account, 3, 64) || len(account) > 64 || len(password) > 256 || !validText(deviceID, 1, 128) || len(deviceID) > 128 {
		return Login{}, ErrInvalid
	}
	if err := s.Cache.Allow(ctx, "login-ip", ip, 30, time.Minute); err != nil {
		return Login{}, err
	}
	if err := s.Cache.Allow(ctx, "login-account", account, 10, time.Minute); err != nil {
		return Login{}, err
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return Login{}, ErrBusy
	}
	var uid, hash string
	defer func() {
		reason := "ok"
		if resultErr != nil {
			reason = "failed"
			var f *Fault
			if errors.As(resultErr, &f) {
				reason = f.Code
			}
		}
		auditCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _ = s.Store.Pool.Exec(auditCtx, "INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason) VALUES($1,$2,$3,$4,$5,$6,$7)", optionalUUID(uid), account, nullableIP(ip), opt.Platform, opt.DeviceName, resultErr == nil, reason)
	}()
	err := s.Store.Pool.QueryRow(ctx, "SELECT id::text,password_hash FROM pulse.users WHERE (account=$1 OR phone=$1) AND active AND deleted_at IS NULL ORDER BY (account=$1) DESC LIMIT 1", account).Scan(&uid, &hash)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return Login{}, err
	}
	if hash == "" {
		hash = s.dummyHash
	}
	valid := verifyPassword(password, hash)
	if !valid || uid == "" {
		return Login{}, ErrUnauthorized
	}
	security, err := readSecurity(ctx, s.Store.Pool, uid)
	if err != nil {
		return Login{}, err
	}
	recovery, err := verifySecondFactor(security, opt.SecondFactor)
	if err != nil {
		return Login{}, err
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return Login{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(7153002)"); err != nil {
		return Login{}, err
	}
	// Password reset and login serialize on the user row. A stale verified hash
	// cannot create a new session after reset or freeze commits.
	var current string
	err = tx.QueryRow(ctx, "SELECT password_hash FROM pulse.users WHERE id=$1 AND active FOR UPDATE", uid).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		return Login{}, ErrUnauthorized
	}
	if err != nil {
		return Login{}, err
	}
	if current != hash {
		return Login{}, ErrUnauthorized
	}

	if err = s.enforceLoginPolicy(ctx, tx, uid, deviceID, opt, security, recovery); err != nil {
		return Login{}, err
	}
	var otherDevices int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM pulse.login_sessions WHERE user_id=$1 AND device_id<>$2
        AND revoked_at IS NULL AND expires_at>clock_timestamp()`, uid, deviceID).Scan(&otherDevices); err != nil {
		return Login{}, err
	}
	if otherDevices >= 8 {
		return Login{}, &Fault{409, "device_session_limit"}
	}
	token, sid := opaqueToken(), newID()
	expires := time.Now().UTC().Add(30 * 24 * time.Hour)
	// Re-login on the same device replaces its old credential, and old sockets
	// are closed by the caller/periodic session sweeper.
	if _, err = tx.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1 AND device_id=$2 AND revoked_at IS NULL", uid, deviceID); err != nil {
		return Login{}, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at,platform,device_name,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", sid, uid, deviceID, digest(token), expires, opt.Platform, opt.DeviceName, nullableIP(ip)); err != nil {
		return Login{}, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO pulse.login_audit(user_id,device_id) VALUES($1,$2)", uid, deviceID); err != nil {
		return Login{}, err
	}
	if _, err = tx.Exec(ctx, "UPDATE pulse.users SET last_active_at=now() WHERE id=$1", uid); err != nil {
		return Login{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Login{}, err
	}
	return Login{Identity: Identity{UserID: uid, SessionID: sid, DeviceID: deviceID, ExpiresAt: expires}, Token: token}, nil
}
func (s *Service) Authenticate(ctx context.Context, token string) (Identity, error) {
	if len(token) != 64 {
		return Identity{}, ErrUnauthorized
	}
	return s.identity(ctx, "s.token_hash=$1", digest(token))
}
func (s *Service) Session(ctx context.Context, sid string) (Identity, error) {
	return s.identity(ctx, "s.id=$1::uuid", sid)
}
func (s *Service) identity(ctx context.Context, predicate string, arg any) (Identity, error) {
	var who Identity
	err := s.Store.Pool.QueryRow(ctx, `SELECT u.id::text,s.id::text,s.device_id,s.expires_at
        FROM pulse.login_sessions s JOIN pulse.users u ON u.id=s.user_id
        WHERE `+predicate+` AND u.active AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`, arg).
		Scan(&who.UserID, &who.SessionID, &who.DeviceID, &who.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return who, ErrUnauthorized
	}
	return who, err
}
func lockIdentity(ctx context.Context, tx pgx.Tx, who Identity) (bool, error) {
	if who.administrator != nil {
		if e := lockAdmin(ctx, tx, *who.administrator, who.adminModule, true); e != nil {
			return false, e
		}
		if who.UserID == "" {
			return false, nil
		}
		var internal bool
		e := tx.QueryRow(ctx, "SELECT internal_staff FROM pulse.users WHERE id=$1 AND active FOR SHARE", who.UserID).Scan(&internal)
		if errors.Is(e, pgx.ErrNoRows) {
			return false, ErrForbidden
		}
		return internal, e
	}
	var internal bool
	// All credential mutations and authenticated transactions acquire the user
	// before session rows. A joined locking SELECT does not specify that order.
	err := tx.QueryRow(ctx, "SELECT internal_staff FROM pulse.users WHERE id=$1 AND active FOR SHARE", who.UserID).Scan(&internal)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrUnauthorized
	}
	if err != nil {
		return false, err
	}
	var sid string
	err = tx.QueryRow(ctx, `SELECT id::text FROM pulse.login_sessions
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()
		FOR SHARE`, who.SessionID, who.UserID).Scan(&sid)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrUnauthorized
	}
	return internal, err
}
func (s *Service) Logout(ctx context.Context, who Identity) error {
	_, err := s.Store.Pool.Exec(ctx, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL", who.SessionID, who.UserID)
	return err
}
