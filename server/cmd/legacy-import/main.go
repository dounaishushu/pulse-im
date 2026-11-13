// legacy-import is an isolated rehearsal importer. It refuses the live MySQL
// host and any PostgreSQL database other than the dedicated rehearsal target.
// The source is a restored, read-only copy of one consistent MySQL dump.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5"
	"pulse.im/server/internal/core"
)

type importer struct {
	source                 *sql.DB
	target                 pgx.Tx
	counts                 map[string]int64
	messageIDs             map[int64]messageKey
	conversationMessageIDs map[int64][]int64
	members                map[int64][]oldMember
	adminEntries           map[string]string
	mediaPaths             map[string]legacyMedia
	imageURLMessageIDs     map[string]int64
	mediaRoot              string
	mediaCache             map[string]mediaCacheEntry
	mediaCachePath         string
}

type messageKey struct {
	Conversation int64
	Sequence     int64
	Sender       int64
	Kind         string
}

type importPhase struct {
	name string
	fn   func(context.Context, *importer) error
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "isolated import failed:", err)
		os.Exit(1)
	}
}

func run() error {
	coreRehearsal := flag.Bool("core-rehearsal", false, "import only core chat data into an isolated rehearsal database; never marks migration complete")
	mediaRehearsal := flag.Bool("media-rehearsal", false, "import core chat and media into an isolated rehearsal database")
	verifyCore := flag.Bool("verify-core", false, "read-only full reconciliation of imported core chat data")
	verifyFull := flag.Bool("verify-full", false, "read-only full-domain and private media reconciliation of the isolated snapshot")
	migrateRehearsal := flag.Bool("migrate-rehearsal", false, "apply embedded migrations to the isolated rehearsal database")
	serverRehearsal := flag.Bool("server-rehearsal", false, "run only on the verified rehearsal server and its localhost PostgreSQL")
	serverFinal := flag.Bool("server-final", false, "run on the frozen final copy and its dedicated localhost PostgreSQL database")
	flag.Parse()
	if *serverRehearsal && *serverFinal {
		return errors.New("choose one server target")
	}
	selected := 0
	for _, enabled := range []bool{*coreRehearsal, *mediaRehearsal, *verifyCore, *verifyFull, *migrateRehearsal} {
		if enabled {
			selected++
		}
	}
	if selected != 1 {
		return errors.New("choose exactly one isolated rehearsal or verification mode")
	}
	sourceDSN, targetDSN := os.Getenv("PULSE_LEGACY_MYSQL_DSN"), os.Getenv("PULSE_POSTGRES_DSN")
	if sourceDSN == "" || targetDSN == "" {
		return errors.New("PULSE_LEGACY_MYSQL_DSN and PULSE_POSTGRES_DSN are required")
	}
	config, err := mysql.ParseDSN(sourceDSN)
	if err != nil || config.DBName != "pulse_im" || config.Net != "tcp" || config.Addr != "127.0.0.1:13306" || !config.ParseTime || config.Loc == nil || config.Loc.String() != "Asia/Shanghai" {
		return errors.New("source must be the restored localhost:13306/pulse_im snapshot with parseTime and Asia/Shanghai")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if config.Params == nil {
		config.Params = map[string]string{}
	}
	config.Params["net_write_timeout"] = "3600"
	config.Params["net_read_timeout"] = "3600"
	config.Params["wait_timeout"] = "28800"
	source, err := sql.Open("mysql", config.FormatDSN())
	if err != nil {
		return errors.New("invalid isolated MySQL source")
	}
	defer source.Close()
	source.SetMaxOpenConns(2)
	source.SetMaxIdleConns(0)
	if err = source.PingContext(ctx); err != nil {
		return errors.New("isolated MySQL source unavailable")
	}
	store, err := core.OpenStore(ctx, targetDSN)
	if err != nil {
		return errors.New("PostgreSQL rehearsal target unavailable")
	}
	defer store.Pool.Close()
	pgConfig := store.Pool.Config().ConnConfig
	allowedPort := uint16(15440)
	if *serverRehearsal || *serverFinal {
		hostname, e := os.Hostname()
		if e != nil || hostname != "rbm-oHGth9FP" || runtime.GOOS != "linux" {
			return errors.New("unexpected migration server identity")
		}
		allowedPort = 5432
	}
	allowedDatabase := regexp.MustCompile(`^pulse_legacy_rehearsal(_v[0-9]+)?$`).MatchString(pgConfig.Database)
	if *serverFinal {
		allowedDatabase = pgConfig.Database == "pulse_legacy_final"
		freeze := os.Getenv("PULSE_LEGACY_FREEZE_MANIFEST")
		if freeze == "" || filepath.Dir(filepath.Dir(freeze)) != "/root/pulse-im-migration" || filepath.Base(freeze) != "freeze-manifest.json" {
			return errors.New("verified legacy freeze manifest is required")
		}
		if info, e := os.Stat(freeze); e != nil || !info.Mode().IsRegular() {
			return errors.New("verified legacy freeze manifest is missing")
		}
	}
	if pgConfig.Host != "127.0.0.1" || pgConfig.Port != allowedPort || !allowedDatabase {
		return errors.New("target must be the dedicated localhost PostgreSQL migration database")
	}
	if *migrateRehearsal {
		return store.Migrate(ctx)
	}
	if err = store.CheckSchema(ctx); err != nil {
		return err
	}
	if *verifyCore {
		return reconcileCore(ctx, source, store.Pool)
	}
	if *verifyFull {
		return reconcileFull(ctx, source, store.Pool)
	}
	for _, table := range []string{"users", "admin_accounts", "conversations", "messages", "receipt_facts", "legacy_ids"} {
		var count int64
		if err = store.Pool.QueryRow(ctx, "SELECT count(*) FROM pulse."+table).Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return fmt.Errorf("target table %s is not empty; no data was changed", table)
		}
	}
	var schema string
	if err = source.QueryRowContext(ctx, "SELECT DATABASE()").Scan(&schema); err != nil || schema != "pulse_im" {
		return errors.New("unexpected MySQL source database")
	}
	targetTx, err := store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer targetTx.Rollback(ctx)
	i := &importer{source: source, target: targetTx, counts: map[string]int64{}, messageIDs: map[int64]messageKey{}, conversationMessageIDs: map[int64][]int64{}, members: map[int64][]oldMember{}, adminEntries: map[string]string{}, mediaPaths: map[string]legacyMedia{}, imageURLMessageIDs: map[string]int64{}}
	phases := []importPhase{
		{"users", importUsers},
		{"admins", importAdmins},
		{"user_settings", importUserSettings},
		{"user_security", importUserSecurity},
		{"relationships", importRelationships},
		{"members_snapshot", loadMembers},
		{"conversations", importConversations},
		{"messages", importMessages},
		{"member_states", importMemberStates},
		{"folders", importFolders},
	}
	if *mediaRehearsal {
		phases = append(phases, importPhase{"media", importMedia})
	}
	phases = append(phases, importPhase{"message_relations", importMessageRelations})
	if *mediaRehearsal {
		phases = append(phases, importPhase{"work", importWork}, importPhase{"dispatch", importDispatch},
			importPhase{"notifications", importNotifications}, importPhase{"push_devices", importPushDevices},
			importPhase{"audit_config", importAuditConfig}, importPhase{"regions", importRegionLocations}, importPhase{"operational", importOperationalState})
	}
	phases = append(phases, importPhase{"receipt_facts", importReceiptFacts})
	for _, phase := range phases {
		if err = phase.fn(ctx, i); err != nil {
			return fmt.Errorf("%s: %w", phase.name, err)
		}
		fmt.Fprintln(os.Stderr, "phase complete:", phase.name)
	}
	// Rehearsal data is never a cutover target without full-domain reconciliation.
	entriesPath := os.Getenv("PULSE_LEGACY_ADMIN_ENTRIES_OUT")
	if len(i.adminEntries) > 0 {
		if entriesPath == "" {
			return errors.New("PULSE_LEGACY_ADMIN_ENTRIES_OUT is required for one-time replacement admin entries")
		}
		cwd, e := os.Getwd()
		if e != nil {
			return e
		}
		allowed := filepath.Join(filepath.Dir(cwd), ".local", "migration")
		if *serverRehearsal || *serverFinal {
			allowed = "/root/pulse-im-migration"
		}
		absolute, e := filepath.Abs(entriesPath)
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(allowed, absolute)
		if e != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return errors.New("admin entry output must be a new file beneath .local/migration")
		}
		if _, e = os.Stat(absolute); !os.IsNotExist(e) {
			return errors.New("admin entry output already exists")
		}
		encoded, e := json.MarshalIndent(i.adminEntries, "", "  ")
		if e != nil {
			return e
		}
		if e = os.MkdirAll(filepath.Dir(absolute), 0700); e != nil {
			return e
		}
		pending := absolute + ".pending"
		file, e := os.OpenFile(pending, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		if _, e = file.Write(encoded); e != nil {
			file.Close()
			os.Remove(pending)
			return e
		}
		if e = file.Close(); e != nil {
			os.Remove(pending)
			return e
		}
		committed := false
		defer func() {
			if !committed {
				_ = os.Remove(pending)
			}
		}()
		if err = targetTx.Commit(ctx); err != nil {
			return err
		}
		committed = true
		if err = os.Rename(pending, absolute); err != nil {
			return err
		}
	} else {
		if err = targetTx.Commit(ctx); err != nil {
			return err
		}
	}
	if *mediaRehearsal && i.mediaRoot != "" {
		if err = os.Remove(i.mediaCachePath); err != nil {
			return fmt.Errorf("remove private media checkpoint: %w", err)
		}
		ready := filepath.Join(i.mediaRoot, "REHEARSAL_METADATA_COMMITTED")
		if err = os.WriteFile(ready, []byte(pgConfig.Database+"\n"), 0600); err != nil {
			return err
		}
	}
	scope := "core-rehearsal"
	if *mediaRehearsal {
		scope = "media-rehearsal"
	}
	if *serverFinal {
		scope = "frozen-final-copy"
	}
	result, _ := json.Marshal(map[string]any{"complete": false, "scope": scope, "counts": i.counts})
	fmt.Println(string(result))
	return nil
}

// Stable, collision-resistant UUIDv8 values make every old foreign key and
// reconciliation pair reproducible without retaining a process-local map.
func legacyUUID(entity string, id int64) string {
	return legacyStringUUID(entity, strconv.FormatInt(id, 10))
}

func legacyStringUUID(entity, value string) string {
	h := sha256.Sum256([]byte("pulse-im-legacy-v1/" + entity + "/" + value))
	b := h[:16]
	b[6] = (b[6] & 0x0f) | 0x80
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}

func legacyDigest(text string) []byte {
	h := sha256.Sum256([]byte(text))
	return h[:]
}

func nullString(v sql.NullString) string {
	if v.Valid {
		return v.String
	}
	return ""
}

func nullOrString(v sql.NullString) any {
	if v.Valid && v.String != "" {
		return v.String
	}
	return nil
}

func nullInt(v sql.NullInt64) any {
	if v.Valid {
		return v.Int64
	}
	return nil
}

func nullTime(v sql.NullTime) any {
	if v.Valid {
		return v.Time
	}
	return nil
}

func legacyPositiveIDCell(value any) (int64, error) {
	var id int64
	switch raw := value.(type) {
	case int64:
		id = raw
	case uint64:
		if raw > math.MaxInt64 {
			return 0, fmt.Errorf("legacy ID exceeds int64 range")
		}
		id = int64(raw)
	case []byte:
		parsed, err := strconv.ParseInt(string(raw), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("invalid legacy ID: %w", err)
		}
		id = parsed
	default:
		return 0, fmt.Errorf("unsupported legacy ID type %T", value)
	}
	if id <= 0 {
		return 0, fmt.Errorf("legacy ID must be positive")
	}
	return id, nil
}

func (i *importer) addID(ctx context.Context, entity string, oldID int64) error {
	if oldID <= 0 {
		return errors.New("invalid positive legacy id")
	}
	_, err := i.target.Exec(ctx, `INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES($1,$2,$3)`, entity, oldID, legacyUUID(entity, oldID))
	return err
}

func sortedPair(a, b string) (string, string) {
	values := []string{a, b}
	sort.Strings(values)
	return values[0], values[1]
}

func validOldAccount(account string) bool {
	if account == "" || len(account) > 64 {
		return false
	}
	for _, r := range account {
		if r > 127 || !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return !strings.HasPrefix(account, "__phone_only__")
}
