package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type fullCountPair struct {
	source string
	target string
}

type fullReconciliation struct {
	Complete           bool             `json:"complete"`
	Scope              string           `json:"scope"`
	SourceCounts       map[string]int64 `json:"source_counts"`
	TargetCounts       map[string]int64 `json:"target_counts"`
	LegacyIDsChecked   int64            `json:"legacy_ids_checked"`
	MediaFilesChecked  int64            `json:"media_files_checked"`
	MediaBytesChecked  int64            `json:"media_bytes_checked"`
	ExternalMediaCount int64            `json:"external_media_count"`
	UnreferencedFiles  int64            `json:"unreferenced_files"`
}

func reconcileFull(ctx context.Context, source *sql.DB, target *pgxpool.Pool) error {
	report := fullReconciliation{
		Complete: false, Scope: "isolated-full-snapshot",
		SourceCounts: map[string]int64{}, TargetCounts: map[string]int64{},
	}
	pairs := []fullCountPair{
		{"admin_accounts", "SELECT count(*) FROM pulse.admin_accounts"},
		{"mobile_device_bindings", "SELECT count(*) FROM pulse.legacy_mobile_bindings"},
		{"auth_tokens", "SELECT count(*) FROM pulse.legacy_session_tokens"},
		{"mobile_device_policy", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='mobile_device_policy'"},
		{"maintenance_config", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='maintenance_config'"},
		{"maintenance_state", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='maintenance_state'"},
		{"admin_account_guard", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='admin_account_guard'"},
		{"client_route_state", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='client_route_state'"},
		{"admin_login_attempts", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='admin_login_attempts'"},
		{"admin_security_rates", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='admin_security_rates'"},
		{"work_record_reviews", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='work_record_reviews'"},
		{"user_presence", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='user_presence'"},
		{"realtime_events", "SELECT count(*) FROM pulse.legacy_realtime_events"},
		{"realtime_sequence", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='realtime_sequence'"},
		{"push_cursor", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='push_cursor'"},
		{"dispatch_worker_health", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='dispatch_worker_health'"},
		{"websocket_worker_health", "SELECT count(*) FROM pulse.legacy_runtime_state WHERE source='websocket_worker_health'"},
		{"conversation_folders", "SELECT count(*) FROM pulse.conversation_folders"},
		{"conversation_folder_items", "SELECT count(*) FROM pulse.user_states WHERE folder_id IS NOT NULL"},
		{"ip_region_locations", "SELECT count(*) FROM pulse.ip_locations"},
		{"admin_account_entries", "SELECT count(*) FROM pulse.legacy_admin_entries"},
		{"user_security", "SELECT count(*) FROM pulse.security"},
		{"user_settings", "SELECT count(*) FROM pulse.privacy_settings WHERE imported_legacy"},
		{"conversation_read_progress", "SELECT count(*) FROM pulse.legacy_read_progress"},
		{"media_uploads", "SELECT count(*) FROM pulse.legacy_media_paths WHERE path LIKE 'uploads/%'"},
		{"media_references", "SELECT count(*) FROM pulse.message_media mm JOIN pulse.legacy_media_paths p ON p.media_id=mm.media_id WHERE p.path LIKE 'uploads/%'"},
		{"work_tasks", "SELECT count(*) FROM pulse.work_tasks"},
		{"work_questions", "SELECT count(*) FROM pulse.work_questions"},
		{"work_task_codes", "SELECT count(*) FROM pulse.work_codes"},
		{"work_task_daily_questions", "SELECT count(*) FROM pulse.legacy_work_snapshots WHERE entity='daily'"},
		{"work_task_records", "SELECT count(*) FROM pulse.work_records"},
		{"dispatch_tasks", "SELECT count(*) FROM pulse.legacy_dispatch_tasks"},
		{"dispatch_task_runs", "SELECT count(*) FROM pulse.legacy_dispatch_runs"},
		{"user_notifications", "SELECT count(*) FROM pulse.notifications"},

		{"notification_devices", "SELECT count(*) FROM pulse.legacy_push_devices"},
		{"login_logs", "SELECT count(*) FROM pulse.login_events"},
		{"admin_audit_logs", "SELECT count(*) FROM pulse.admin_audit"},
		{"sensitive_words", "SELECT count(*) FROM pulse.sensitive_words"},
		{"client_app_config", "SELECT count(*) FROM pulse.legacy_client_config WHERE source='client_app_config'"},
		{"client_announcements", "SELECT count(*) FROM pulse.legacy_client_config WHERE source='client_announcements'"},
		{"client_navigation_config", "SELECT count(*) FROM pulse.legacy_client_config WHERE source='client_navigation_config'"},
		{"client_routes", "SELECT count(*) FROM pulse.legacy_client_config WHERE source='client_routes'"},
	}
	for _, pair := range pairs {
		var from, to int64
		if err := source.QueryRowContext(ctx, "SELECT count(*) FROM `"+pair.source+"`").Scan(&from); err != nil {
			return fmt.Errorf("%s source count: %w", pair.source, err)
		}
		if err := target.QueryRow(ctx, pair.target).Scan(&to); err != nil {
			return fmt.Errorf("%s target count: %w", pair.source, err)
		}
		report.SourceCounts[pair.source] = from
		report.TargetCounts[pair.source] = to
		if from != to {
			return fmt.Errorf("%s count differs: source=%d target=%d", pair.source, from, to)
		}
	}
	mentions, err := reconcileMentions(ctx, source, target)
	if err != nil {
		return err
	}
	report.SourceCounts["message_mentions"] = mentions
	report.TargetCounts["message_mentions"] = mentions
	var oldSystemAudit, newSystemAudit, archivedAudit, archivedSystemAudit int64
	if err := source.QueryRowContext(ctx, "SELECT count(*) FROM admin_audit_logs WHERE admin_id IS NULL OR admin_id=0").Scan(&oldSystemAudit); err != nil {
		return err
	}
	for query, count := range map[string]*int64{
		"SELECT count(*) FROM pulse.admin_audit WHERE admin_id IS NULL":                                                                                 &newSystemAudit,
		"SELECT count(*) FROM pulse.legacy_audit_events WHERE source='admin_audit_logs'":                                                                &archivedAudit,
		"SELECT count(*) FROM pulse.legacy_audit_events WHERE source='admin_audit_logs' AND (payload->>'admin_id' IS NULL OR payload->>'admin_id'='0')": &archivedSystemAudit,
	} {
		if err := target.QueryRow(ctx, query).Scan(count); err != nil {
			return err
		}
	}
	if oldSystemAudit != newSystemAudit || oldSystemAudit != archivedSystemAudit || archivedAudit != report.SourceCounts["admin_audit_logs"] {
		return fmt.Errorf("system administrator audit history differs")
	}
	report.SourceCounts["system_admin_audit"] = oldSystemAudit
	report.TargetCounts["system_admin_audit"] = newSystemAudit
	var oldReplies, newReplies int64
	if err := source.QueryRowContext(ctx, "SELECT count(*) FROM messages WHERE JSON_EXTRACT(body_json,'$.reply_to_id') IS NOT NULL").Scan(&oldReplies); err != nil {
		return err
	}
	if err := target.QueryRow(ctx, "SELECT count(*) FROM pulse.messages WHERE reply_to IS NOT NULL").Scan(&newReplies); err != nil {
		return err
	}
	report.SourceCounts["message_replies"] = oldReplies
	report.TargetCounts["message_replies"] = newReplies
	if oldReplies != newReplies {
		return fmt.Errorf("message reply count differs")
	}
	for _, pair := range []struct {
		entity, table string
	}{
		{"user", "users"}, {"conversation", "conversations"}, {"message", "messages"},
		{"friend_request", "contact_requests"}, {"admin", "admin_accounts"},
		{"task", "work_tasks"}, {"question", "work_questions"}, {"record", "work_task_records"},
		{"dispatch", "dispatch_tasks"}, {"notification", "user_notifications"}, {"folder", "conversation_folders"},
	} {
		n, err := compareLegacyIDs(ctx, source, target, pair.entity, pair.table)
		if err != nil {
			return err
		}
		report.LegacyIDsChecked += n
	}
	raw, err := os.ReadFile(os.Getenv("PULSE_LEGACY_EXTERNAL_MEDIA_MANIFEST"))
	if err != nil {
		return fmt.Errorf("external media manifest: %w", err)
	}
	var external externalMediaManifest
	if err := json.Unmarshal(raw, &external); err != nil {
		return err
	}
	if external.Count != len(external.Items) || len(external.Failures) != 0 {
		return fmt.Errorf("external media manifest is incomplete")
	}
	report.ExternalMediaCount = int64(external.Count)
	var importedExternal, importedMedia, importedQuestions, importedDaily, importedPush int64
	for query, value := range map[string]*int64{
		"SELECT count(*) FROM pulse.legacy_media_paths WHERE path LIKE 'external/message/%'": &importedExternal,
		"SELECT count(*) FROM pulse.media":                                                   &importedMedia,
		"SELECT count(*) FROM pulse.media WHERE kind='question'":                             &importedQuestions,
		"SELECT count(*) FROM pulse.work_daily":                                              &importedDaily,
		"SELECT count(*) FROM pulse.push_devices":                                            &importedPush,
	} {
		if err := target.QueryRow(ctx, query).Scan(value); err != nil {
			return err
		}
	}
	if importedPush != 0 {
		return fmt.Errorf("old push registrations were activated without a new client session")
	}
	if importedExternal != report.ExternalMediaCount ||
		importedQuestions != report.SourceCounts["work_questions"] ||
		importedDaily != report.SourceCounts["work_task_daily_questions"] ||
		importedMedia != report.SourceCounts["media_uploads"]+importedExternal+importedQuestions {
		return fmt.Errorf("media or work daily totals differ")
	}
	if err := reconcileCore(ctx, source, target); err != nil {
		return err
	}
	if err := reconcileMediaFiles(ctx, target, os.Getenv("PULSE_MEDIA_DIR"), &report); err != nil {
		return err
	}
	if report.MediaFilesChecked != importedMedia {
		return fmt.Errorf("private media row count differs")
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func reconcileMentions(ctx context.Context, source *sql.DB, target *pgxpool.Pool) (int64, error) {
	oldRows, err := source.QueryContext(ctx, `SELECT message_id,user_id FROM message_mentions ORDER BY message_id,user_id`)
	if err != nil {
		return 0, err
	}
	defer oldRows.Close()
	newRows, err := target.Query(ctx, `SELECT legacy_message_id,legacy_user_id FROM (
 SELECT m.legacy_id AS legacy_message_id,u.legacy_id AS legacy_user_id
 FROM pulse.message_mentions mm
 JOIN pulse.legacy_ids m ON m.entity='message' AND m.new_id=mm.message_id
 JOIN pulse.legacy_ids u ON u.entity='user' AND u.new_id=mm.user_id
 UNION ALL
 SELECT m.legacy_id,0::bigint
 FROM pulse.messages msg
 JOIN pulse.legacy_ids m ON m.entity='message' AND m.new_id=msg.id
 WHERE msg.content->>'mention_all'='true'
) mentions ORDER BY legacy_message_id,legacy_user_id`)
	if err != nil {
		return 0, err
	}
	defer newRows.Close()
	var checked int64
	for oldRows.Next() {
		var oldMessage, oldUser, newMessage, newUser int64
		if err := oldRows.Scan(&oldMessage, &oldUser); err != nil {
			return checked, err
		}
		if !newRows.Next() {
			return checked, fmt.Errorf("target message mentions ended early")
		}
		if err := newRows.Scan(&newMessage, &newUser); err != nil {
			return checked, err
		}
		if oldMessage != newMessage || oldUser != newUser {
			return checked, fmt.Errorf("message mention differs at row %d", checked+1)
		}
		checked++
	}
	if err := oldRows.Err(); err != nil {
		return checked, err
	}
	if newRows.Next() {
		return checked, fmt.Errorf("target has extra message mentions")
	}
	if err := newRows.Err(); err != nil {
		return checked, err
	}
	return checked, nil
}

func compareLegacyIDs(ctx context.Context, source *sql.DB, target *pgxpool.Pool, entity, table string) (int64, error) {
	oldRows, err := source.QueryContext(ctx, "SELECT id FROM `"+table+"` ORDER BY id")
	if err != nil {
		return 0, err
	}
	defer oldRows.Close()
	newRows, err := target.Query(ctx, "SELECT legacy_id,new_id::text FROM pulse.legacy_ids WHERE entity=$1 ORDER BY legacy_id", entity)
	if err != nil {
		return 0, err
	}
	defer newRows.Close()
	var count int64
	for oldRows.Next() {
		var oldID, newID int64
		var mapped string
		if err := oldRows.Scan(&oldID); err != nil {
			return count, err
		}
		if !newRows.Next() {
			return count, fmt.Errorf("%s legacy mapping ended early", entity)
		}
		if err := newRows.Scan(&newID, &mapped); err != nil {
			return count, err
		}
		if oldID != newID || mapped != legacyUUID(entity, oldID) {
			return count, fmt.Errorf("%s legacy mapping mismatch at %d", entity, oldID)
		}
		count++
	}
	if err := oldRows.Err(); err != nil {
		return count, err
	}
	if newRows.Next() {
		return count, fmt.Errorf("%s legacy mapping has extra rows", entity)
	}
	if err := newRows.Err(); err != nil {
		return count, err
	}
	return count, nil
}

func checkedMediaPath(root, name string) (string, os.FileInfo, error) {
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:") {
		return "", nil, fmt.Errorf("invalid private media filename")
	}
	path := filepath.Join(root, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, fmt.Errorf("private media file missing: %s", name)
	}
	return path, info, nil
}

func reconcileMediaFiles(ctx context.Context, target *pgxpool.Pool, root string, report *fullReconciliation) error {
	if root == "" {
		return fmt.Errorf("PULSE_MEDIA_DIR is required for full reconciliation")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	marker, err := os.ReadFile(filepath.Join(root, "REHEARSAL_METADATA_COMMITTED"))
	if err != nil || strings.TrimSpace(string(marker)) != target.Config().ConnConfig.Database {
		return fmt.Errorf("media metadata commit marker is missing or mismatched")
	}
	rows, err := target.Query(ctx, `SELECT source_path,content_path,COALESCE(preview_path,''),
 expected_bytes,expected_sha256,bytes FROM pulse.media WHERE status='ready' ORDER BY id`)
	if err != nil {
		return err
	}
	expectedFiles := map[string]bool{"REHEARSAL_METADATA_COMMITTED": true}
	for rows.Next() {
		var sourceName, contentName, previewName, expectedHash string
		var sourceBytes, contentBytes int64
		if err = rows.Scan(&sourceName, &contentName, &previewName, &sourceBytes, &expectedHash, &contentBytes); err != nil {
			rows.Close()
			return err
		}
		path, info, fileErr := checkedMediaPath(root, sourceName)
		if fileErr != nil {
			rows.Close()
			return fileErr
		}
		if info.Size() != sourceBytes {
			rows.Close()
			return fmt.Errorf("private media source size differs: %s", sourceName)
		}
		file, fileErr := os.Open(path)
		if fileErr != nil {
			rows.Close()
			return fileErr
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil || hex.EncodeToString(hash.Sum(nil)) != expectedHash {
			rows.Close()
			return fmt.Errorf("private media source hash differs: %s", sourceName)
		}
		expectedFiles[sourceName] = true
		_, contentInfo, fileErr := checkedMediaPath(root, contentName)
		if fileErr != nil || contentInfo.Size() != contentBytes {
			rows.Close()
			return fmt.Errorf("private media content missing or size differs: %s", contentName)
		}
		expectedFiles[contentName] = true
		if previewName != "" {
			_, previewInfo, previewErr := checkedMediaPath(root, previewName)
			if previewErr != nil || previewInfo.Size() == 0 {
				rows.Close()
				return fmt.Errorf("private media preview missing: %s", previewName)
			}
			expectedFiles[previewName] = true
		}
		report.MediaFilesChecked++
		report.MediaBytesChecked += sourceBytes
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !expectedFiles[entry.Name()] {
			report.UnreferencedFiles++
		}
		return nil
	})
	if err != nil {
		return err
	}
	if report.UnreferencedFiles != 0 {
		return fmt.Errorf("%d unreferenced or unsafe private media files", report.UnreferencedFiles)
	}
	return nil
}
