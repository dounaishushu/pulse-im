package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"pulse.im/server/internal/core"
)

func TestPrivateMediaCheckpointReuseAndTamperDetection(t *testing.T) {
	root := t.TempDir()
	source := []byte("original image bytes")
	preview := []byte("private preview bytes")
	for name, content := range map[string][]byte{"test.source": source, "test.preview": preview} {
		if err := os.WriteFile(filepath.Join(root, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	digest := sha256.Sum256(source)
	expected := mediaManifestItem{Bytes: int64(len(source)), SHA256: hex.EncodeToString(digest[:])}
	prepared := core.LegacyMediaFile{
		Filename: "test.jpg", SourcePath: "test.source", ContentPath: "test.source", PreviewPath: "test.preview",
		SourceBytes: int64(len(source)), ContentBytes: int64(len(source)), SHA256: expected.SHA256,
	}
	first := &importer{mediaRoot: root}
	if err := first.openMediaCache(root); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if _, err := first.preparedMedia("uploads/test.jpg", "image", "test.jpg", expected, func() (core.LegacyMediaFile, error) {
		calls++
		return prepared, nil
	}); err != nil || calls != 1 {
		t.Fatalf("first checkpoint write failed: %v", err)
	}
	reopened := &importer{mediaRoot: root}
	if err := reopened.openMediaCache(root); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.preparedMedia("uploads/test.jpg", "image", "test.jpg", expected, func() (core.LegacyMediaFile, error) {
		return prepared, errors.New("media was processed twice")
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "test.preview"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.preparedMedia("uploads/test.jpg", "image", "test.jpg", expected, func() (core.LegacyMediaFile, error) {
		return prepared, nil
	}); err == nil {
		t.Fatal("tampered private preview was accepted")
	}
}
