package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pulse.im/server/internal/core"
)

type mediaManifestItem struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type externalMediaManifest struct {
	Count    int   `json:"count"`
	Failures []any `json:"failures"`
	Items    []struct {
		MessageID int64  `json:"message_id"`
		SenderID  int64  `json:"sender_id"`
		Path      string `json:"path"`
		Bytes     int64  `json:"bytes"`
		SHA256    string `json:"sha256"`
	} `json:"items"`
}

type legacyMedia struct {
	ID    string
	Value core.Media
}

func mediaPath(root, path string) (string, error) {
	if !strings.HasPrefix(path, "uploads/") || strings.ContainsAny(path, "\\:") || strings.Contains(path, "..") || filepath.IsAbs(path) {
		return "", fmt.Errorf("unsafe legacy media path")
	}
	abs, e := filepath.Abs(filepath.Join(root, filepath.FromSlash(path)))
	if e != nil {
		return "", e
	}
	rel, e := filepath.Rel(root, abs)
	if e != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("legacy media path leaves snapshot root")
	}
	info, e := os.Lstat(abs)
	if e != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("legacy media file missing or not regular")
	}
	return abs, nil
}

func readMediaManifest(path string) (map[string]mediaManifestItem, error) {
	file, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer file.Close()
	items := map[string]mediaManifestItem{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		var item mediaManifestItem
		if e = json.Unmarshal(scanner.Bytes(), &item); e != nil {
			return nil, e
		}
		if item.Path == "" || len(item.SHA256) != 64 || item.Bytes <= 0 {
			return nil, fmt.Errorf("invalid media manifest row")
		}
		if _, ok := items[item.Path]; ok {
			return nil, fmt.Errorf("duplicate media manifest path")
		}
		items[item.Path] = item
	}
	return items, scanner.Err()
}

func (i *importer) insertPreparedMedia(ctx context.Context, oldPath string, oldUser, oldAdmin sql.NullInt64, oldKind string, created time.Time, sourcePath string, expected mediaManifestItem, store *core.MediaStore) (legacyMedia, error) {
	var result legacyMedia
	kind := oldKind
	switch oldKind {
	case "voice":
		kind = "audio"
	case "dispatch_image":
		kind = "image"
	case "image", "video", "file", "avatar":
	default:
		return result, fmt.Errorf("unsupported old media kind %s", oldKind)
	}
	if !oldUser.Valid && !oldAdmin.Valid {
		return result, fmt.Errorf("unowned legacy media")
	}
	if oldUser.Valid && oldAdmin.Valid && oldKind != "dispatch_image" {
		return result, fmt.Errorf("unexpected dual-owned legacy media")
	}
	id := legacyStringUUID("media_path", oldPath)
	filename := filepath.Base(sourcePath)
	if oldKind == "dispatch_image" {
		kind = "image"
	}
	prepared, e := i.preparedMedia(oldPath, kind, filename, expected, func() (core.LegacyMediaFile, error) {
		return store.PrepareLegacyMedia(ctx, id, kind, filename, sourcePath)
	})
	if e != nil {
		return result, fmt.Errorf("media path %s: %w", oldPath, e)
	}
	filename = prepared.Filename
	if prepared.SourceBytes != expected.Bytes || prepared.SHA256 != expected.SHA256 {
		return result, fmt.Errorf("media source checksum mismatch")
	}
	var userID, adminID any
	if oldAdmin.Valid {
		adminID = legacyUUID("admin", oldAdmin.Int64)
	} else {
		userID = legacyUUID("user", oldUser.Int64)
	}
	h := sha256.Sum256([]byte(oldPath))
	requestID := "legacy_" + hex.EncodeToString(h[:])[:56]
	_, e = i.target.Exec(ctx, `INSERT INTO pulse.media(
 id,owner_id,admin_owner_id,request_id,request_hash,kind,filename,expected_bytes,
 expected_sha256,original,status,mime,bytes,width,height,duration_ms,compression_applied,
 source_path,content_path,preview_path,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,'ready',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
		id, userID, adminID, requestID, legacyDigest(oldPath+":"+prepared.SHA256), kind, filename,
		prepared.SourceBytes, prepared.SHA256, prepared.MIME, prepared.ContentBytes,
		prepared.Width, prepared.Height, prepared.DurationMS, prepared.CompressionApplied,
		prepared.SourcePath, prepared.ContentPath, prepared.PreviewPath, created)
	if e != nil {
		return result, e
	}
	_, e = i.target.Exec(ctx, `INSERT INTO pulse.legacy_media_paths(
 path,media_id,source_bytes,source_sha256,legacy_user_id,legacy_admin_id,legacy_kind)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, oldPath, id, prepared.SourceBytes, prepared.SHA256, nullInt(oldUser), nullInt(oldAdmin), oldKind)
	if e != nil {
		return result, e
	}
	result.ID = id
	result.Value = core.Media{ID: id, Kind: kind, Filename: filename, Status: "ready", MIME: prepared.MIME,
		Bytes: prepared.ContentBytes, Width: prepared.Width, Height: prepared.Height,
		DurationMS: prepared.DurationMS, Original: true, CompressionApplied: prepared.CompressionApplied,
		CreatedAt: created}
	return result, nil
}

func (i *importer) linkMediaMessage(ctx context.Context, messageID int64, media legacyMedia) error {
	if _, ok := i.messageIDs[messageID]; !ok {
		return fmt.Errorf("media reference has missing message")
	}
	content, e := json.Marshal(core.MessageContent{Media: &media.Value})
	if e != nil {
		return e
	}
	if _, e = i.target.Exec(ctx, "INSERT INTO pulse.message_media(message_id,media_id) VALUES($1,$2)", legacyUUID("message", messageID), media.ID); e != nil {
		return e
	}
	_, e = i.target.Exec(ctx, "UPDATE pulse.messages SET content=$2 WHERE id=$1", legacyUUID("message", messageID), json.RawMessage(content))
	return e
}

func importMedia(ctx context.Context, i *importer) error {
	root := os.Getenv("PULSE_LEGACY_MEDIA_ROOT")
	manifestPath := os.Getenv("PULSE_LEGACY_MEDIA_MANIFEST")
	privateRoot := os.Getenv("PULSE_MEDIA_DIR")
	probe := os.Getenv("PULSE_FFPROBE")
	if root == "" || manifestPath == "" || privateRoot == "" || probe == "" {
		return fmt.Errorf("media rehearsal paths and ffprobe are required")
	}
	root, e := filepath.Abs(root)
	if e != nil {
		return e
	}
	manifest, e := readMediaManifest(manifestPath)
	if e != nil {
		return e
	}
	store, e := core.NewMediaStore(privateRoot, probe)
	if e != nil {
		return e
	}
	i.mediaRoot = privateRoot
	if e = i.openMediaCache(privateRoot); e != nil {
		return e
	}
	rows, e := i.source.QueryContext(ctx, "SELECT path,user_id,admin_id,kind,created_at FROM media_uploads ORDER BY path")
	if e != nil {
		return e
	}
	for rows.Next() {
		var path, kind string
		var user, admin sql.NullInt64
		var created time.Time
		if e = rows.Scan(&path, &user, &admin, &kind, &created); e != nil {
			rows.Close()
			return e
		}
		entry, ok := manifest[path]
		if !ok {
			rows.Close()
			return fmt.Errorf("legacy media manifest missing path")
		}
		file, e := mediaPath(root, path)
		if e != nil {
			rows.Close()
			return e
		}
		media, e := i.insertPreparedMedia(ctx, path, user, admin, kind, created, file, entry, store)
		if e != nil {
			rows.Close()
			return e
		}
		i.mediaPaths[path] = media
		i.counts["media_uploads"]++
		if i.counts["media_uploads"]%2000 == 0 {
			fmt.Fprintln(os.Stderr, "media files processed:", i.counts["media_uploads"])
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if int64(len(manifest)) != i.counts["media_uploads"] {
		return fmt.Errorf("media manifest and database path count differ")
	}
	refs, e := i.source.QueryContext(ctx, "SELECT path,message_id FROM media_references ORDER BY message_id")
	if e != nil {
		return e
	}
	used := map[int64]bool{}
	for refs.Next() {
		var path string
		var messageID int64
		if e = refs.Scan(&path, &messageID); e != nil {
			refs.Close()
			return e
		}
		media, ok := i.mediaPaths[path]
		if !ok {
			refs.Close()
			return fmt.Errorf("message references absent media path")
		}
		if used[messageID] {
			refs.Close()
			return fmt.Errorf("message has multiple old media references")
		}
		if e = i.linkMediaMessage(ctx, messageID, media); e != nil {
			refs.Close()
			return e
		}
		used[messageID] = true
		i.counts["media_references"]++
	}
	e = refs.Err()
	refs.Close()
	if e != nil {
		return e
	}
	if e = i.importExternalMedia(ctx, store, used); e != nil {
		return e
	}
	return i.linkLegacyAvatars(ctx)
}

func (i *importer) importExternalMedia(ctx context.Context, store *core.MediaStore, used map[int64]bool) error {
	root := os.Getenv("PULSE_LEGACY_EXTERNAL_MEDIA_ROOT")
	manifestPath := os.Getenv("PULSE_LEGACY_EXTERNAL_MEDIA_MANIFEST")
	if root == "" || manifestPath == "" {
		return fmt.Errorf("external media archive is required")
	}
	raw, e := os.ReadFile(manifestPath)
	if e != nil {
		return e
	}
	var manifest externalMediaManifest
	if e = json.Unmarshal(raw, &manifest); e != nil {
		return e
	}
	if manifest.Count != len(manifest.Items) || len(manifest.Failures) != 0 {
		return fmt.Errorf("external media archive is incomplete")
	}
	root, e = filepath.Abs(root)
	if e != nil {
		return e
	}
	for _, item := range manifest.Items {
		key, ok := i.messageIDs[item.MessageID]
		if !ok || key.Kind != "image" || key.Sender != item.SenderID || used[item.MessageID] {
			return fmt.Errorf("external media manifest disagrees with messages")
		}
		if filepath.Base(item.Path) != item.Path || strings.ContainsAny(item.Path, "\\/: ") {
			return fmt.Errorf("unsafe external archive filename")
		}
		filename := filepath.Join(root, item.Path)
		info, e := os.Lstat(filename)
		if e != nil || !info.Mode().IsRegular() || info.Size() != item.Bytes {
			return fmt.Errorf("external media archive file missing")
		}
		oldPath := fmt.Sprintf("external/message/%d", item.MessageID)
		var created time.Time
		if e = i.target.QueryRow(ctx, "SELECT created_at FROM pulse.messages WHERE id=$1", legacyUUID("message", item.MessageID)).Scan(&created); e != nil {
			return e
		}
		user := sql.NullInt64{Int64: item.SenderID, Valid: true}
		media, e := i.insertPreparedMedia(ctx, oldPath, user, sql.NullInt64{}, "image", created, filename,
			mediaManifestItem{Path: item.Path, Bytes: item.Bytes, SHA256: item.SHA256}, store)
		if e != nil {
			return e
		}
		if e = i.linkMediaMessage(ctx, item.MessageID, media); e != nil {
			return e
		}
		i.mediaPaths[oldPath] = media
		used[item.MessageID] = true
		i.counts["external_media"]++
	}
	var missing int64
	if e = i.target.QueryRow(ctx, `SELECT count(*) FROM pulse.messages m WHERE kind IN ('image','video','audio','file')
 AND NOT EXISTS(SELECT 1 FROM pulse.message_media mm WHERE mm.message_id=m.id)`).Scan(&missing); e != nil {
		return e
	}
	if missing != 0 {
		return fmt.Errorf("%d imported media messages have no private file", missing)
	}
	return nil
}

func importedURLPath(raw string) (string, bool) {
	pos := strings.Index(raw, "uploads/")
	if pos < 0 {
		return "", false
	}
	path := strings.SplitN(raw[pos:], "?", 2)[0]
	if strings.ContainsAny(path, "\\#") || strings.Contains(path, "..") {
		return "", false
	}
	return path, true
}

func (i *importer) linkLegacyAvatars(ctx context.Context) error {
	users, e := i.target.Query(ctx, `SELECT id::text,legacy_avatar_url FROM pulse.users
 WHERE legacy_avatar_url IS NOT NULL AND legacy_avatar_url<>''`)
	if e != nil {
		return e
	}
	type avatar struct{ id, url string }
	userRows := []avatar{}
	for users.Next() {
		var a avatar
		if e = users.Scan(&a.id, &a.url); e != nil {
			users.Close()
			return e
		}
		userRows = append(userRows, a)
	}
	e = users.Err()
	users.Close()
	if e != nil {
		return e
	}
	for _, a := range userRows {
		path, ok := importedURLPath(a.url)
		if !ok {
			i.counts["unmapped_user_avatars"]++
			continue
		}
		media, ok := i.mediaPaths[path]
		if !ok {
			return fmt.Errorf("old user avatar references missing media")
		}
		if _, e = i.target.Exec(ctx, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", a.id, media.ID); e != nil {
			return e
		}
		i.counts["user_avatars"]++
	}
	conversations, e := i.target.Query(ctx, `SELECT id::text,legacy_avatar_url FROM pulse.conversations
 WHERE legacy_avatar_url IS NOT NULL AND legacy_avatar_url<>''`)
	if e != nil {
		return e
	}
	groupRows := []avatar{}
	for conversations.Next() {
		var a avatar
		if e = conversations.Scan(&a.id, &a.url); e != nil {
			conversations.Close()
			return e
		}
		groupRows = append(groupRows, a)
	}
	e = conversations.Err()
	conversations.Close()
	if e != nil {
		return e
	}
	for _, a := range groupRows {
		path, ok := importedURLPath(a.url)
		if !ok {
			return fmt.Errorf("old group avatar is external")
		}
		media, ok := i.mediaPaths[path]
		if !ok {
			return fmt.Errorf("old group avatar references missing media")
		}
		if _, e = i.target.Exec(ctx, "UPDATE pulse.conversations SET avatar_id=$2 WHERE id=$1", a.id, media.ID); e != nil {
			return e
		}
		i.counts["group_avatars"]++
	}
	return nil
}
