package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyMediaCopyPreservesOriginalAndCreatesPrivatePreview(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "original.png")
	input := imageBytes(t, 80, 60)
	if err := os.WriteFile(source, input, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := NewMediaStore(filepath.Join(root, "private"), "")
	if err != nil {
		t.Fatal(err)
	}
	out, err := store.PrepareLegacyMedia(context.Background(), newID(), "image", "original.png", source)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(input)
	if out.SHA256 != hex.EncodeToString(digest[:]) || out.SourceBytes != int64(len(input)) || out.ContentBytes != int64(len(input)) || out.PreviewPath == "" {
		t.Fatalf("import changed original metadata: %+v", out)
	}
	copyPath, err := store.path(out.ContentPath)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(copyPath)
	if err != nil || !bytes.Equal(copied, input) {
		t.Fatalf("original bytes changed: %v", err)
	}
	preview, err := store.path(out.PreviewPath)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(preview); err != nil || info.Size() == 0 {
		t.Fatalf("preview missing: %v", err)
	}
	current, err := os.ReadFile(source)
	if err != nil || !bytes.Equal(current, input) {
		t.Fatalf("source was modified: %v", err)
	}
}

func TestLegacyMediaReportsMissingProbe(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "voice.m4a")
	if e := os.WriteFile(source, []byte("unprocessed fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	store, e := NewMediaStore(filepath.Join(root, "private"), filepath.Join(root, "missing-ffprobe"))
	if e != nil {
		t.Fatal(e)
	}
	_, e = store.PrepareLegacyMedia(context.Background(), newID(), "audio", "voice.m4a", source)
	var fault *Fault
	if !errors.As(e, &fault) || fault.Status != 503 || fault.Code != "media_probe_unavailable" {
		t.Fatalf("missing probe reported as corrupt media: %v", e)
	}
}

func TestLegacyMediaCorrectsMismatchedImageExtension(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "old-image.png")
	var encoded bytes.Buffer
	if e := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 3, 3)), nil); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(source, encoded.Bytes(), 0600); e != nil {
		t.Fatal(e)
	}
	store, e := NewMediaStore(filepath.Join(root, "private"), "")
	if e != nil {
		t.Fatal(e)
	}
	out, e := store.PrepareLegacyMedia(context.Background(), newID(), "image", filepath.Base(source), source)
	if e != nil {
		t.Fatal(e)
	}
	if out.Filename != "old-image.jpg" || out.MIME != "image/jpeg" {
		t.Fatalf("legacy image format was not detected: %+v", out)
	}
	copyPath, e := store.path(out.ContentPath)
	if e != nil {
		t.Fatal(e)
	}
	copied, e := os.ReadFile(copyPath)
	if e != nil || !bytes.Equal(copied, encoded.Bytes()) {
		t.Fatalf("original JPEG bytes changed: %v", e)
	}
}
