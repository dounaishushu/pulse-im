package core

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct{ Pool *pgxpool.Pool }

func OpenStore(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL configuration")
	}
	cfg.MaxConns, cfg.MinConns = 16, 2
	cfg.MaxConnLifetime, cfg.MaxConnIdleTime = 30*time.Minute, 5*time.Minute
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "2000"
	cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(765220261109)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS public.pulse_schema_migrations(version int PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	files, err := migrationFiles()
	if err != nil {
		return err
	}
	known, err := appliedMigrations(ctx, tx)
	if err != nil {
		return err
	}
	for version := range known {
		if version < 1 || version > len(files) {
			return errors.New("database schema is newer than this binary")
		}
	}
	for i, name := range files {
		source, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		checksum := migrationChecksum(source)
		version := i + 1
		if existing, ok := known[version]; ok {
			if existing != checksum {
				return errors.New("migration checksum mismatch")
			}
			continue
		}
		if _, err = tx.Exec(ctx, string(source)); err != nil {
			return fmt.Errorf("migration %d: %w", version, err)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO public.pulse_schema_migrations(version,checksum) VALUES($1,$2)", version, checksum); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) CheckSchema(ctx context.Context) error {
	files, err := migrationFiles()
	if err != nil {
		return err
	}
	known, err := appliedMigrations(ctx, s.Pool)
	if err != nil {
		return errors.New("database not initialized; run pulse-im migrate explicitly")
	}
	if len(known) != len(files) {
		return errors.New("database schema version mismatch; run pulse-im migrate explicitly")
	}
	for i, name := range files {
		b, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if known[i+1] != migrationChecksum(b) {
			return errors.New("migration checksum mismatch")
		}
	}
	return nil
}

type migrationQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func appliedMigrations(ctx context.Context, q migrationQuerier) (map[int]string, error) {
	rows, err := q.Query(ctx, "SELECT version,checksum FROM public.pulse_schema_migrations")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[int]string)
	for rows.Next() {
		var version int
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			return nil, err
		}
		result[version] = checksum
	}
	return result, rows.Err()
}
func migrationFiles() ([]string, error) {
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	for i, name := range files {
		parts := strings.SplitN(name, "_", 2)
		version, err := strconv.Atoi(parts[0])
		if err != nil || version != i+1 || len(parts) != 2 {
			return nil, errors.New("non-contiguous migration filenames")
		}
	}
	return files, nil
}
func migrationChecksum(source []byte) string {
	sum := sha256.Sum256(source)
	return hex.EncodeToString(sum[:])
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func opaqueToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func digest(value string) []byte { d := sha256.Sum256([]byte(value)); return d[:] }

type Fault struct {
	Status int
	Code   string
}

func (e *Fault) Error() string { return e.Code }

var (
	ErrInvalid      = &Fault{400, "invalid_request"}
	ErrUnauthorized = &Fault{401, "unauthorized"}
	ErrForbidden    = &Fault{403, "forbidden"}
	ErrMissing      = &Fault{404, "not_found"}
	ErrConflict     = &Fault{409, "request_conflict"}
	ErrBusy         = &Fault{503, "temporarily_unavailable"}
	ErrLimited      = &Fault{429, "rate_limited"}
)
