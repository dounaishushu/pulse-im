package core

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type mediaOutput struct {
	content, preview, mime string
	bytes, duration        int64
	width, height          int
	compressed             bool
}

func (m *MediaStore) process(ctx context.Context, j mediaJob) (out mediaOutput, err error) {
	path, e := m.path(j.Source)
	if e != nil {
		return out, e
	}
	file, e := os.Open(path)
	if e != nil {
		return out, mediaError("upload_source_missing")
	}
	defer file.Close()
	stat, e := file.Stat()
	if e != nil {
		return out, e
	}
	if stat.Size() > mediaLimit(j.Kind) {
		return out, mediaError("media_too_large")
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	head = head[:n]
	_, _ = file.Seek(0, 0)
	ext := strings.ToLower(filepath.Ext(j.Filename))
	out.content = j.Source
	out.bytes = stat.Size()
	switch j.Kind {
	case "image", "avatar", "question":
		return m.processImage(ctx, j, file, stat.Size(), ext)
	case "video", "audio":
		accepted := false
		switch ext {
		case ".mp4", ".webm":
			accepted = true
		case ".mov", ".avi", ".mkv", ".ogv", ".mpeg", ".mpg", ".3gp", ".m4v", ".wmv":
			accepted = j.Kind == "video"
		case ".m4a", ".ogg", ".opus", ".mp3", ".wav":
			accepted = j.Kind == "audio"
		}
		if !accepted {
			return out, mediaError("media_type_mismatch")
		}
		return m.probeMedia(ctx, j, path, stat.Size())
	case "file":
		switch ext {
		case ".pdf":
			if !bytes.HasPrefix(head, []byte("%PDF-")) {
				return out, mediaError("media_type_mismatch")
			}
			out.mime = "application/pdf"
		case ".txt":
			reader := bufio.NewReaderSize(file, 64<<10)
			for {
				r, n, e := reader.ReadRune()
				if e == io.EOF {
					break
				}
				if e != nil {
					return out, e
				}
				if r == 0 || (r == utf8.RuneError && n == 1) {
					return out, mediaError("media_type_mismatch")
				}
				if ctx.Err() != nil {
					return out, ctx.Err()
				}
			}

			out.mime = "text/plain; charset=utf-8"
		case ".zip", ".docx":
			if !bytes.HasPrefix(head, []byte("PK")) {
				return out, mediaError("media_type_mismatch")
			}
			if e = validateArchive(file, stat.Size(), ext == ".docx"); e != nil {
				return out, e
			}
			out.mime = "application/zip"
			if ext == ".docx" {
				out.mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			}
		case ".doc":
			if !bytes.HasPrefix(head, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}) {
				return out, mediaError("media_type_mismatch")
			}
			out.mime = "application/msword"
		default:
			return out, mediaError("media_type_unsupported")
		}
		return out, nil
	}
	return out, mediaError("media_type_unsupported")
}
func validateArchive(file *os.File, size int64, docx bool) error {
	tail := make([]byte, min(size, 65557))
	if _, e := file.ReadAt(tail, size-int64(len(tail))); e != nil {
		return mediaError("archive_invalid")
	}
	pos := bytes.LastIndex(tail, []byte{'P', 'K', 5, 6})
	if pos < 0 || pos+22 > len(tail) {
		return mediaError("archive_invalid")
	}
	count := binary.LittleEndian.Uint16(tail[pos+10:])
	if count > 10000 || count == 0xffff {
		return mediaError("archive_entry_limit")
	}
	zr, e := zip.NewReader(file, size)
	if e != nil {
		return mediaError("archive_invalid")
	}
	var expanded uint64
	hasDocument := false
	for _, f := range zr.File {
		expanded += f.UncompressedSize64
		if expanded > 256<<20 || f.UncompressedSize64 > 100<<20 {
			return mediaError("archive_expansion_limit")
		}
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if strings.HasPrefix(name, "/") || strings.Contains(name, ":") || strings.Contains("/"+name, "/../") {
			return mediaError("archive_path_invalid")
		}
		if name == "word/document.xml" {
			hasDocument = true
		}
	}
	if docx && !hasDocument {
		return mediaError("media_type_mismatch")
	}
	return nil
}
func (m *MediaStore) processImage(ctx context.Context, j mediaJob, file *os.File, size int64, ext string) (out mediaOutput, err error) {
	cfg, format, e := image.DecodeConfig(file)
	if e != nil {
		return out, mediaError("image_invalid")
	}
	validExt := map[string]string{".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".gif": "gif", ".webp": "webp"}
	if validExt[ext] != format {
		return out, mediaError("media_type_mismatch")
	}
	pixels := int64(cfg.Width) * int64(cfg.Height)
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxImageEdge || cfg.Height > maxImageEdge || pixels > maxImagePixels {
		return out, mediaError("image_pixel_limit")
	}
	if err = m.pixels.Acquire(ctx, pixels*16+(1<<20)); err != nil {
		return out, ErrBusy
	}
	defer m.pixels.Release(pixels*16 + (1 << 20))
	if format == "gif" {
		if e = validateGIF(file); e != nil {
			return out, e
		}
	}
	_, _ = file.Seek(0, 0)
	src, _, e := image.Decode(file)
	if e != nil {
		return out, mediaError("image_invalid")
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	orientation := 1
	if format == "jpeg" {
		orientation = jpegOrientation(file)
	}
	src = orientedImage(src, orientation)
	out.width, out.height = src.Bounds().Dx(), src.Bounds().Dy()
	out.mime = "image/" + format
	out.content = j.Source
	out.bytes = size
	stem := j.ID + "-" + j.Lease
	// Originals and animation retain their exact validated bytes. Avatars always normalize.
	normalize := !j.Original || j.Kind == "avatar"
	if normalize && (format != "gif" || j.Kind == "avatar") {
		target := 2560
		if j.Kind == "avatar" {
			target = 512
		}
		scaled := resizeImage(src, target, false)
		suffix := ".jpg"
		out.mime = "image/jpeg"
		transparent := false
		if opaque, ok := scaled.(interface{ Opaque() bool }); ok {
			transparent = !opaque.Opaque()
		}
		if transparent {
			suffix = ".png"
			out.mime = "image/png"
		}
		out.content = stem + suffix
		p, e := m.path(out.content)
		if e != nil {
			return out, e
		}
		f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return out, ErrStorage
		}
		if transparent {
			e = png.Encode(f, scaled)
		} else {
			e = jpeg.Encode(f, scaled, &jpeg.Options{Quality: 85})
		}
		closeErr := f.Close()
		if e != nil || closeErr != nil {
			m.remove(out.content)
			return out, mediaError("image_encode_failed")
		}
		st, e := os.Stat(p)
		if e != nil {
			return out, e
		}
		out.bytes = st.Size()
		out.width, out.height = scaled.Bounds().Dx(), scaled.Bounds().Dy()
		out.compressed = out.bytes < size || scaled.Bounds().Dx() != src.Bounds().Dx() || scaled.Bounds().Dy() != src.Bounds().Dy()
	}
	success := false
	defer func() {
		if !success && out.content != j.Source {
			m.remove(out.content)
		}
		if !success {
			m.remove(out.preview)
		}
	}()
	thumb := resizeImage(src, 640, true)
	out.preview = stem + "-preview.jpg"
	p, e := m.path(out.preview)
	if e != nil {
		return out, e
	}
	f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return out, ErrStorage
	}
	e = jpeg.Encode(f, thumb, &jpeg.Options{Quality: 80})
	closeErr := f.Close()
	if e != nil || closeErr != nil {
		return out, mediaError("image_encode_failed")
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	success = true
	return out, nil
}
func resizeImage(src image.Image, maxEdge int, white bool) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if max(w, h) > maxEdge {
		ratio := float64(maxEdge) / float64(max(w, h))
		w = max(1, int(float64(w)*ratio))
		h = max(1, int(float64(h)*ratio))
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	if white {
		draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	}
	op := draw.Src
	if white {
		op = draw.Over
	}
	xdraw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, b, op, nil)
	return dst
}

// Validate all GIF block boundaries without DecodeAll allocating every animation frame.
func validateGIF(file *os.File) error {
	_, _ = file.Seek(0, 0)
	header := make([]byte, 13)
	if _, e := io.ReadFull(file, header); e != nil {
		return mediaError("image_invalid")
	}
	if header[10]&128 != 0 {
		if _, e := file.Seek(int64(3*(1<<((header[10]&7)+1))), io.SeekCurrent); e != nil {
			return e
		}
	}
	frames := 0
	var total int64
	skipBlocks := func() error {
		var b [1]byte
		for {
			if _, e := io.ReadFull(file, b[:]); e != nil {
				return e
			}
			if b[0] == 0 {
				return nil
			}
			if _, e := io.CopyN(io.Discard, file, int64(b[0])); e != nil {
				return e
			}
		}
	}
	for {
		var b [1]byte
		if _, e := io.ReadFull(file, b[:]); e != nil {
			return mediaError("image_invalid")
		}
		switch b[0] {
		case 0x3b:
			if frames == 0 {
				return mediaError("image_invalid")
			}
			return nil
		case 0x21:
			if _, e := io.ReadFull(file, b[:]); e != nil {
				return mediaError("image_invalid")
			}
			if e := skipBlocks(); e != nil {
				return mediaError("image_invalid")
			}
		case 0x2c:
			d := make([]byte, 9)
			if _, e := io.ReadFull(file, d); e != nil {
				return mediaError("image_invalid")
			}
			w, h := int64(binary.LittleEndian.Uint16(d[4:6])), int64(binary.LittleEndian.Uint16(d[6:8]))
			total += w * h
			frames++
			if frames > 500 || w*h > maxImagePixels || total > 200_000_000 {
				return mediaError("animation_frame_limit")
			}
			if d[8]&128 != 0 {
				if _, e := io.CopyN(io.Discard, file, int64(3*(1<<((d[8]&7)+1)))); e != nil {
					return mediaError("image_invalid")
				}
			}
			if _, e := io.ReadFull(file, b[:]); e != nil {
				return mediaError("image_invalid")
			}
			if e := skipBlocks(); e != nil {
				return mediaError("image_invalid")
			}
		default:
			return mediaError("image_invalid")
		}
	}
}
func jpegOrientation(file *os.File) int {
	_, _ = file.Seek(2, 0)
	for i := 0; i < 256; i++ {
		var marker [4]byte
		if _, e := io.ReadFull(file, marker[:]); e != nil || marker[0] != 0xff {
			return 1
		}
		if marker[1] == 0xda || marker[1] == 0xd9 {
			return 1
		}
		n := int(binary.BigEndian.Uint16(marker[2:])) - 2
		if n < 0 || n > 65533 {
			return 1
		}
		data := make([]byte, n)
		if _, e := io.ReadFull(file, data); e != nil {
			return 1
		}
		if marker[1] != 0xe1 || len(data) < 14 || !bytes.HasPrefix(data, []byte("Exif\x00\x00")) {
			continue
		}
		data = data[6:]
		var order binary.ByteOrder = binary.LittleEndian
		if string(data[:2]) == "MM" {
			order = binary.BigEndian
		} else if string(data[:2]) != "II" {
			return 1
		}
		off := int(order.Uint32(data[4:8]))
		if off < 8 || off+2 > len(data) {
			return 1
		}
		count := int(order.Uint16(data[off:]))
		for j := 0; j < count; j++ {
			p := off + 2 + j*12
			if p+12 > len(data) {
				return 1
			}
			if order.Uint16(data[p:]) == 0x112 && order.Uint16(data[p+2:]) == 3 && order.Uint32(data[p+4:]) == 1 {
				v := int(order.Uint16(data[p+8:]))
				if v >= 1 && v <= 8 {
					return v
				}
			}
		}
		return 1
	}
	return 1
}
func orientedImage(src image.Image, o int) image.Image {
	if o == 1 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	ow, oh := w, h
	if o >= 5 {
		ow, oh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, ow, oh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dx, dy := x, y
			switch o {
			case 2:
				dx = w - 1 - x
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dy = h - 1 - y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}

type cappedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("process output limit")
	}
	return b.Buffer.Write(p)
}
func (m *MediaStore) probeMedia(ctx context.Context, j mediaJob, path string, size int64) (out mediaOutput, err error) {
	if m.probe == "" {
		return out, &Fault{503, "media_probe_unavailable"}
	}
	cmd := exec.CommandContext(ctx, m.probe, "-v", "error", "-max_alloc", "67108864", "-threads", "1", "-protocol_whitelist", "file", "-probesize", "1048576", "-analyzeduration", "3000000", "-show_entries", "stream=codec_type,width,height:format=duration,format_name", "-of", "json", path)
	stdout, stderr := &cappedBuffer{limit: 64 << 10}, &cappedBuffer{limit: 4 << 10}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if e := cmd.Run(); e != nil {
		if errors.Is(e, exec.ErrNotFound) || errors.Is(e, os.ErrNotExist) {
			return out, &Fault{503, "media_probe_unavailable"}
		}
		return out, mediaError("media_container_invalid")
	}
	var data struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
			Name     string `json:"format_name"`
		} `json:"format"`
	}
	if e := json.Unmarshal(stdout.Bytes(), &data); e != nil {
		return out, mediaError("media_container_invalid")
	}
	audio, video := false, false
	for _, stream := range data.Streams {
		if stream.CodecType == "audio" {
			audio = true
		}
		if stream.CodecType == "video" {
			video = true
			out.width = max(out.width, stream.Width)
			out.height = max(out.height, stream.Height)
		}
	}
	if len(data.Streams) > 16 || (!audio && !video) || (j.Kind == "audio" && (!audio || video)) || (j.Kind == "video" && !video) || int64(out.width)*int64(out.height) > maxImagePixels {
		return out, mediaError("media_type_mismatch")
	}
	d, e := strconv.ParseFloat(data.Format.Duration, 64)
	if e != nil || math.IsInf(d, 0) || math.IsNaN(d) || d <= 0 || d > 24*3600 || (j.Kind == "audio" && d > 300) {
		return out, mediaError("media_duration_invalid")
	}
	out.duration = int64(d * 1000)
	ext := strings.ToLower(filepath.Ext(j.Filename))
	expected := map[string]string{
		".mp4": "mp4", ".m4a": "mp4", ".mov": "mov", ".webm": "webm",
		".ogg": "ogg", ".opus": "ogg", ".mp3": "mp3", ".wav": "wav",
		".avi": "avi", ".mkv": "matroska", ".ogv": "ogg", ".mpeg": "mpeg",
		".mpg": "mpeg", ".3gp": "3gp", ".m4v": "mp4", ".wmv": "asf",
	}[ext]
	if expected == "" || !strings.Contains(data.Format.Name, expected) {
		return out, mediaError("media_type_mismatch")
	}
	out.mime = map[string]string{
		".mp4": "video/mp4", ".m4a": "audio/mp4", ".mov": "video/quicktime",
		".webm": "video/webm", ".ogg": "audio/ogg", ".opus": "audio/ogg",
		".mp3": "audio/mpeg", ".wav": "audio/wav", ".avi": "video/x-msvideo",
		".mkv": "video/x-matroska", ".ogv": "video/ogg", ".mpeg": "video/mpeg",
		".mpg": "video/mpeg", ".3gp": "video/3gpp", ".m4v": "video/x-m4v",
		".wmv": "video/x-ms-wmv",
	}[ext]
	if j.Kind == "audio" {
		out.mime = strings.Replace(out.mime, "video/", "audio/", 1)
	}
	out.content, out.bytes = j.Source, size
	return out, nil
}
