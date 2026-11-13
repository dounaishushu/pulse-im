package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"pulse.im/server/internal/core"
)

// The checkpoint lives only beside the isolated private media copy. A failed
// database transaction may be retried without decoding every media file again.
type mediaCacheEntry struct {
	Path          string               `json:"path"`
	Kind          string               `json:"kind"`
	OriginalName  string               `json:"original_name"`
	Prepared      core.LegacyMediaFile `json:"prepared"`
	ContentSHA256 string               `json:"content_sha256"`
	PreviewSHA256 string               `json:"preview_sha256"`
}

func (i *importer) openMediaCache(root string) error {
	i.mediaCachePath = filepath.Join(root, ".media-cache.jsonl")
	i.mediaCache = make(map[string]mediaCacheEntry)
	file, err := os.Open(i.mediaCachePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		var entry mediaCacheEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			return err
		}
		if entry.Path == "" || entry.Kind == "" || entry.Prepared.SourcePath == "" {
			return fmt.Errorf("invalid private media checkpoint")
		}
		if _, exists := i.mediaCache[entry.Path]; exists {
			return fmt.Errorf("duplicate private media checkpoint")
		}
		i.mediaCache[entry.Path] = entry
	}
	return scanner.Err()
}

func mediaCacheHash(root, name string) (string, int64, error) {
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:") {
		return "", 0, fmt.Errorf("invalid private media checkpoint path")
	}
	path := filepath.Join(root, name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", 0, fmt.Errorf("private checkpoint media file missing")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	count, err := io.Copy(hash, file)
	if err != nil || count != info.Size() {
		return "", 0, fmt.Errorf("private checkpoint media read failed")
	}
	return hex.EncodeToString(hash.Sum(nil)), count, nil
}

func (i *importer) preparedMedia(oldPath, kind, originalName string, expected mediaManifestItem,
	prepare func() (core.LegacyMediaFile, error)) (core.LegacyMediaFile, error) {
	if cached, ok := i.mediaCache[oldPath]; ok {
		prepared := cached.Prepared
		if cached.Kind != kind || cached.OriginalName != originalName ||
			prepared.SourceBytes != expected.Bytes || prepared.SHA256 != expected.SHA256 {
			return prepared, fmt.Errorf("private media checkpoint disagrees with source manifest")
		}
		for _, check := range []struct {
			name, sha string
			bytes     int64
		}{
			{prepared.SourcePath, prepared.SHA256, prepared.SourceBytes},
			{prepared.ContentPath, cached.ContentSHA256, prepared.ContentBytes},
		} {
			actualSHA, size, err := mediaCacheHash(i.mediaRoot, check.name)
			if err != nil || actualSHA != check.sha || size != check.bytes {
				return prepared, fmt.Errorf("private media checkpoint file changed")
			}
		}
		if prepared.PreviewPath != "" {
			actualSHA, size, err := mediaCacheHash(i.mediaRoot, prepared.PreviewPath)
			if err != nil || actualSHA != cached.PreviewSHA256 || size <= 0 {
				return prepared, fmt.Errorf("private media checkpoint preview changed")
			}
		}
		return prepared, nil
	}
	prepared, err := prepare()
	if err != nil {
		return prepared, err
	}
	if prepared.SourceBytes != expected.Bytes || prepared.SHA256 != expected.SHA256 {
		return prepared, fmt.Errorf("media source checksum mismatch")
	}
	contentHash, contentBytes, err := mediaCacheHash(i.mediaRoot, prepared.ContentPath)
	if err != nil || contentBytes != prepared.ContentBytes {
		return prepared, fmt.Errorf("prepared media content missing")
	}
	previewHash := ""
	if prepared.PreviewPath != "" {
		var size int64
		previewHash, size, err = mediaCacheHash(i.mediaRoot, prepared.PreviewPath)
		if err != nil || size <= 0 {
			return prepared, fmt.Errorf("prepared media preview missing")
		}
	}
	entry := mediaCacheEntry{Path: oldPath, Kind: kind, OriginalName: originalName,
		Prepared: prepared, ContentSHA256: contentHash, PreviewSHA256: previewHash}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return prepared, err
	}
	file, err := os.OpenFile(i.mediaCachePath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return prepared, err
	}
	line := append(encoded, '\n')
	written, writeErr := file.Write(line)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil || written != len(line) {
		return prepared, fmt.Errorf("write private media checkpoint failed")
	}
	i.mediaCache[oldPath] = entry
	return prepared, nil
}
