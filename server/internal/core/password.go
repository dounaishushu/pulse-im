// Adapted from the existing Argon2id helper; parameter and work bounds added for Pulse IM.
package core

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
	"strings"
)

func hashPassword(password string) (string, error) {
	if len(password) < 8 || len(password) > 256 {
		return "", ErrInvalid
	}
	return hashSecret(password)
}
func hashSecret(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=2$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}
func verifyPassword(password, encoded string) bool {
	if strings.HasPrefix(encoded, "$2y$") || strings.HasPrefix(encoded, "$2b$") || strings.HasPrefix(encoded, "$2a$") {
		if len(password) > 256 || len(encoded) != 60 {
			return false
		}
		return bcrypt.CompareHashAndPassword([]byte(encoded), []byte(password)) == nil
	}
	if len(password) > 256 || len(encoded) > 512 {
		return false
	}
	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[1] != "argon2id" || p[2] != "v=19" {
		return false
	}
	var memory, iterations, parallelism uint32
	if n, err := fmt.Sscanf(p[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil || n != 3 {
		return false
	}
	if memory < 8*1024 || memory > 64*1024 || iterations < 1 || iterations > 4 || parallelism < 1 || parallelism > 4 {
		return false
	}
	if fmt.Sprintf("m=%d,t=%d,p=%d", memory, iterations, parallelism) != p[3] {
		return false
	}
	salt, e1 := base64.RawStdEncoding.DecodeString(p[4])
	hash, e2 := base64.RawStdEncoding.DecodeString(p[5])
	if e1 != nil || e2 != nil || len(salt) != 16 || len(hash) != 32 {
		return false
	}
	computed := argon2.IDKey([]byte(password), salt, iterations, memory, uint8(parallelism), 32)
	return subtle.ConstantTimeCompare(computed, hash) == 1
}
