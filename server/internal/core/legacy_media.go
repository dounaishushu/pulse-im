package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// LegacyMediaFile describes bytes prepared for an isolated migration. The
// caller inserts metadata only after validating ownership and source hashes.
type LegacyMediaFile struct {
	Filename                              string
	SourcePath, ContentPath, PreviewPath  string
	SHA256, MIME                          string
	SourceBytes, ContentBytes, DurationMS int64
	Width, Height                         int
	CompressionApplied                    bool
}

// PrepareLegacyMedia keeps the existing file private and uses the same image
// and container validation as a new upload. The source itself is never moved.
func (m *MediaStore) PrepareLegacyMedia(ctx context.Context, id, kind, filename, source string) (LegacyMediaFile, error) {
	var result LegacyMediaFile
	if !validID(id) || filepath.Base(filename) != filename || filename == "" {
		return result, ErrInvalid
	}
	if kind != "image" && kind != "video" && kind != "audio" && kind != "file" && kind != "avatar" && kind != "question" {
		return result, ErrInvalid
	}
	file, err := os.Open(source)
	if err != nil {
		return result, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > mediaLimit(kind) {
		return result, ErrInvalid
	}
	normalizedFilename := filename
	if kind == "image" || kind == "avatar" || kind == "question" {
		header := make([]byte, 512)
		n, readErr := file.Read(header)
		if readErr != nil && readErr != io.EOF {
			return result, readErr
		}
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			return result, err
		}
		extension := strings.ToLower(filepath.Ext(filename))
		detected := map[string]string{
			"image/jpeg": ".jpg",
			"image/png":  ".png",
			"image/gif":  ".gif",
			"image/webp": ".webp",
		}[http.DetectContentType(header[:n])]
		if detected != "" && extension != detected && !(detected == ".jpg" && extension == ".jpeg") {
			normalizedFilename = strings.TrimSuffix(filename, filepath.Ext(filename)) + detected
		}
	}
	name := id + "-" + newID() + ".source"
	target, err := m.path(name)
	if err != nil {
		return result, err
	}
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return result, err
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(out, h), file)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil || written != info.Size() {
		m.remove(name)
		return result, ErrStorage
	}
	processKind := kind
	if kind == "avatar" || kind == "question" {
		processKind = "image"
	}
	var processed mediaOutput
	if processKind == "image" {
		if _, err = file.Seek(0, io.SeekStart); err != nil {
			m.remove(name)
			return result, err
		}
		cfg, format, configErr := image.DecodeConfig(file)
		if configErr == nil && (int64(cfg.Width)*int64(cfg.Height) > maxImagePixels || cfg.Width > maxImageEdge || cfg.Height > maxImageEdge) {
			processed, err = m.prepareLargeLegacyImage(ctx, id, name, target, normalizedFilename, format, cfg.Width, cfg.Height, written)
		} else {
			processed, err = m.process(ctx, mediaJob{Media: Media{ID: id, Kind: processKind, Filename: normalizedFilename, Original: true}, Source: name, Lease: newID()})
		}
	} else {
		processed, err = m.process(ctx, mediaJob{Media: Media{ID: id, Kind: processKind, Filename: normalizedFilename, Original: true}, Source: name, Lease: newID()})
	}
	if err != nil {
		m.remove(name)
		return result, err
	}
	return LegacyMediaFile{
		Filename:   normalizedFilename,
		SourcePath: name, ContentPath: processed.content, PreviewPath: processed.preview,
		SHA256: hex.EncodeToString(h.Sum(nil)), MIME: processed.mime,
		SourceBytes: written, ContentBytes: processed.bytes, DurationMS: processed.duration,
		Width: processed.width, Height: processed.height, CompressionApplied: processed.compressed,
	}, nil
}

func (m *MediaStore) prepareLargeLegacyImage(ctx context.Context, id, sourceName, sourcePath, filename, format string, width, height int, sourceBytes int64) (out mediaOutput, err error) {
	if width <= 0 || height <= 0 || width > 20000 || height > 20000 || int64(width)*int64(height) > 100_000_000 {
		return out, mediaError("image_pixel_limit")
	}
	expectedFormat := map[string]string{".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".gif": "gif", ".webp": "webp"}[strings.ToLower(filepath.Ext(filename))]
	if expectedFormat != format {
		return out, mediaError("media_type_mismatch")
	}
	ffmpeg := filepath.Join(filepath.Dir(m.probe), "ffmpeg")
	if strings.EqualFold(filepath.Ext(m.probe), ".exe") {
		ffmpeg += ".exe"
	}
	if info, err := os.Stat(ffmpeg); err != nil || !info.Mode().IsRegular() {
		return out, &Fault{503, "media_preview_tool_unavailable"}
	}
	previewName := id + "-" + newID() + "-preview.jpg"
	previewPath, err := m.path(previewName)
	if err != nil {
		return out, err
	}
	defer func() {
		if err != nil {
			m.remove(previewName)
		}
	}()
	child, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(child, ffmpeg, "-v", "error", "-nostdin", "-threads", "1",
		"-protocol_whitelist", "file", "-i", sourcePath,
		"-vf", "scale=640:640:force_original_aspect_ratio=decrease",
		"-frames:v", "1", "-update", "1", "-q:v", "3", previewPath)
	cmd.Stdout = io.Discard
	cmd.Stderr = &cappedBuffer{limit: 4 << 10}
	if err = cmd.Run(); err != nil {
		return out, mediaError("legacy_preview_failed")
	}
	info, err := os.Lstat(previewPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 20<<20 {
		return out, mediaError("legacy_preview_invalid")
	}
	preview, openErr := os.Open(previewPath)
	if openErr != nil {
		return out, openErr
	}
	cfg, detected, decodeErr := image.DecodeConfig(preview)
	closeErr := preview.Close()
	if decodeErr != nil || closeErr != nil || detected != "jpeg" || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 640 || cfg.Height > 640 {
		return out, mediaError("legacy_preview_invalid")
	}
	out = mediaOutput{content: sourceName, preview: previewName, mime: "image/" + format, bytes: sourceBytes, width: width, height: height}
	return out, nil
}
