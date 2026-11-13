package core

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
)

func TestOldAdminEntryRequiresMatchingAccountAndSecret(t *testing.T) {
	secret := "private-rehearsal-secret-with-adequate-length"
	salt := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	key := hmac.New(sha256.New, []byte(secret))
	key.Write([]byte("pulse-admin-entry-key-v1"))
	mac := hmac.New(sha256.New, key.Sum(nil))
	mac.Write([]byte(fmt.Sprintf("account:%d:salt:%s", 42, salt)))
	token := hex.EncodeToString(mac.Sum(nil))
	hash := sha256.Sum256([]byte(token))
	stored := hex.EncodeToString(hash[:])
	if !legacyAdminEntryMatches(secret, token, 42, salt, stored) {
		t.Fatal("valid old entry rejected")
	}
	for _, v := range []struct {
		secret, token string
		id            int64
		salt, hash    string
	}{
		{"wrong-secret-with-adequate-length-12345", token, 42, salt, stored},
		{secret, token, 43, salt, stored},
		{secret, token, 42, salt, hex.EncodeToString(make([]byte, 32))},
		{secret, token[:63] + "0", 42, salt, stored},
	} {
		if legacyAdminEntryMatches(v.secret, v.token, v.id, v.salt, v.hash) {
			t.Fatalf("invalid old entry accepted: %+v", v)
		}
	}
}
