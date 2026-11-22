package core

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Separate from password verifiers and disabled unless an operator supplies a key.
// The key must be kept outside the database, served files and source repository.
type userPasswordVault struct {
	aead  cipher.AEAD
	keyID string
}

func newUserPasswordVault(encoded string) (*userPasswordVault, error) {
	encoded = strings.TrimSpace(encoded)
	if encoded == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, errors.New("PULSE_USER_PASSWORD_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("user password encryption initialization failed")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("user password encryption initialization failed")
	}
	id := sha256.Sum256(key)
	clear(key)
	return &userPasswordVault{aead: aead, keyID: hex.EncodeToString(id[:])}, nil
}

func passwordCopyAAD(uid, verifier string) []byte {
	return []byte("pulse-user-password-copy:v1\x00" + uid + "\x00" + verifier)
}

// Call only after inserting/updating the verifier and while holding the user lock.
// The verifier and encrypted copy commit or roll back together.
func (s *Service) saveUserPasswordCopy(ctx context.Context, tx pgx.Tx, uid, password, verifier string) error {
	vault := s.passwordVault
	if vault == nil {
		return nil
	}
	nonce := make([]byte, vault.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return errors.New("user password encryption failed")
	}
	plaintext := []byte(password)
	defer clear(plaintext)
	sealed := vault.aead.Seal(nonce, nonce, plaintext, passwordCopyAAD(uid, verifier))
	_, err := tx.Exec(ctx, `INSERT INTO pulse.user_password_copies(user_id,verifier,key_id,ciphertext)
 VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET verifier=$2,key_id=$3,ciphertext=$4,updated_at=clock_timestamp()`, uid, verifier, vault.keyID, sealed)
	return err
}

type userPasswordStatus struct {
	Enabled   bool   `json:"enabled"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// This is stricter than users.manage: delegated operators cannot read credentials.
// Recheck the database role and active session inside the same transaction as the read.
func lockPasswordViewer(ctx context.Context, tx pgx.Tx, who AdminIdentity) (string, error) {
	if who.Role != "superadmin" || who.SessionID == "" {
		return "", ErrForbidden
	}
	if err := lockAdmin(ctx, tx, who, "users", true); err != nil {
		return "", err
	}
	var role, hash string
	if err := tx.QueryRow(ctx, "SELECT role,password_hash FROM pulse.admin_accounts WHERE id=$1 AND active", who.ID).Scan(&role, &hash); err != nil {
		return "", err
	}
	if role != "superadmin" {
		return "", ErrForbidden
	}
	return hash, nil
}

func (s *Service) adminUserPasswordStatus(ctx context.Context, who AdminIdentity, uid string) (userPasswordStatus, error) {
	out := userPasswordStatus{Enabled: s.passwordVault != nil}
	if !validID(uid) {
		return out, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockPasswordViewer(ctx, tx, who); err != nil {
		return out, err
	}
	var current bool
	var keyID string
	err = tx.QueryRow(ctx, `SELECT COALESCE(v.verifier=u.password_hash,false),COALESCE(v.key_id,'')
 FROM pulse.users u LEFT JOIN pulse.user_password_copies v ON v.user_id=u.id
 WHERE u.id=$1 AND u.deleted_at IS NULL`, uid).Scan(&current, &keyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrMissing
	}
	if err != nil {
		return out, err
	}
	switch {
	case !out.Enabled:
		out.Reason = "not_configured"
	case !current:
		out.Reason = "not_recorded"
	case keyID != s.passwordVault.keyID:
		out.Reason = "key_unavailable"
	default:
		out.Available = true
	}
	return out, tx.Commit(ctx)
}

type userPasswordReveal struct {
	Password          string    `json:"password"`
	UpdatedAt         time.Time `json:"updated_at"`
	VisibleForSeconds int       `json:"visible_for_seconds"`
}

func (s *Service) adminRevealUserPassword(ctx context.Context, who AdminIdentity, uid, adminPassword string) (userPasswordReveal, error) {
	out := userPasswordReveal{}
	if who.Role != "superadmin" || who.SessionID == "" {
		return out, ErrForbidden
	}
	if !validID(uid) || len(adminPassword) == 0 || len(adminPassword) > 256 {
		return out, ErrInvalid
	}
	if err := s.Cache.Allow(ctx, "admin-password-reveal", who.ID, 10, time.Minute); err != nil {
		return out, err
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return out, ErrBusy
	}
	var verifiedHash string
	err := s.Store.Pool.QueryRow(ctx, "SELECT password_hash FROM pulse.admin_accounts WHERE id=$1 AND active", who.ID).Scan(&verifiedHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrUnauthorized
	}
	if err != nil {
		return out, err
	}
	verified := verifyPassword(adminPassword, verifiedHash)
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	currentHash, err := lockPasswordViewer(ctx, tx, who)
	if err != nil {
		return out, err
	}
	if currentHash != verifiedHash {
		return out, ErrUnauthorized
	}
	if !verified {
		if err = auditTx(ctx, tx, who, "user.password-reveal-denied", "user", uid, map[string]string{"reason": "admin_password_invalid"}); err != nil {
			return out, err
		}
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return out, &Fault{422, "admin_password_invalid"}
	}
	if s.passwordVault == nil {
		return out, &Fault{409, "password_view_not_configured"}
	}
	var verifier, keyID string
	var ciphertext []byte
	err = tx.QueryRow(ctx, `SELECT u.password_hash,v.key_id,v.ciphertext,v.updated_at
 FROM pulse.users u JOIN pulse.user_password_copies v ON v.user_id=u.id AND v.verifier=u.password_hash
 WHERE u.id=$1 AND u.deleted_at IS NULL FOR SHARE OF u,v`, uid).Scan(&verifier, &keyID, &ciphertext, &out.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return userPasswordReveal{}, &Fault{409, "password_not_recorded"}
	}
	if err != nil {
		return userPasswordReveal{}, err
	}
	vault := s.passwordVault
	if keyID != vault.keyID {
		return userPasswordReveal{}, &Fault{409, "password_key_unavailable"}
	}
	if len(ciphertext) < vault.aead.NonceSize()+vault.aead.Overhead() {
		return userPasswordReveal{}, &Fault{409, "password_copy_invalid"}
	}
	plaintext, err := vault.aead.Open(nil, ciphertext[:vault.aead.NonceSize()], ciphertext[vault.aead.NonceSize():], passwordCopyAAD(uid, verifier))
	if err != nil {
		return userPasswordReveal{}, &Fault{409, "password_copy_invalid"}
	}
	defer clear(plaintext)
	if err = auditTx(ctx, tx, who, "user.password-reveal", "user", uid, map[string]string{"result": "viewed"}); err != nil {
		return userPasswordReveal{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return userPasswordReveal{}, err
	}
	out.Password, out.VisibleForSeconds = string(plaintext), 30
	return out, nil
}

func (a *API) registerUserPasswordCopies(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v2/admin/users/{id}/password-status", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		out, err := a.Service.adminUserPasswordStatus(r.Context(), who, r.PathValue("id"))
		if err == nil {
			writeJSON(w, 200, out)
		}
		return err
	}))
	mux.HandleFunc("POST /api/v2/admin/users/{id}/password-reveal", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if who.Role != "superadmin" {
			return ErrForbidden
		}
		var in struct {
			AdminPassword string `json:"admin_password"`
		}
		if err := decodeLimit(w, r, &in, 2048); err != nil {
			return err
		}
		out, err := a.Service.adminRevealUserPassword(r.Context(), who, r.PathValue("id"), in.AdminPassword)
		in.AdminPassword = ""
		if err == nil {
			w.Header().Set("Pragma", "no-cache")
			writeJSON(w, 200, out)
		}
		return err
	}))
}
