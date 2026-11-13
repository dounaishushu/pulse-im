package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/semaphore"
)

const maxImagePixels int64 = 24_000_000
const maxImageEdge = 12000

var ErrStorage = &Fault{507, "insufficient_storage"}

type MediaStore struct {
	admissions    chan struct{}
	root          string
	uploads       chan struct{}
	pixels        *semaphore.Weighted
	mu            sync.Mutex
	cancellations map[string]context.CancelFunc
	probe         string
}

func NewMediaStore(root, probe string) (*MediaStore, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if info, e := os.Lstat(root); e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("media root must be a real directory")
	}
	return &MediaStore{root: root, uploads: make(chan struct{}, 8), admissions: make(chan struct{}, 1), pixels: semaphore.NewWeighted(512 << 20), cancellations: map[string]context.CancelFunc{}, probe: probe}, nil
}
func (m *MediaStore) path(name string) (string, error) {
	if name == "" || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:") {
		return "", ErrInvalid
	}
	p := filepath.Join(m.root, name)
	if info, e := os.Lstat(p); e == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return "", ErrForbidden
	}
	return p, nil
}
func (m *MediaStore) remove(name string) {
	if p, e := m.path(name); e == nil {
		_ = os.Remove(p)
	}
}

type Media struct {
	ID                 string    `json:"id"`
	Kind               string    `json:"kind"`
	Filename           string    `json:"filename"`
	Status             string    `json:"status"`
	MIME               string    `json:"mime"`
	Bytes              int64     `json:"bytes,string"`
	Width              int       `json:"width"`
	Height             int       `json:"height"`
	DurationMS         int64     `json:"duration_ms"`
	Original           bool      `json:"original"`
	CompressionApplied bool      `json:"compression_applied"`
	ErrorCode          string    `json:"error_code,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

const mediaColumns = `id::text,kind,filename,status,mime,bytes,width,height,duration_ms,original,compression_applied,error_code,created_at`

func scanMedia(row scanner, m *Media, extra ...any) error {
	return row.Scan(append([]any{&m.ID, &m.Kind, &m.Filename, &m.Status, &m.MIME, &m.Bytes, &m.Width, &m.Height, &m.DurationMS, &m.Original, &m.CompressionApplied, &m.ErrorCode, &m.CreatedAt}, extra...)...)
}

type UploadInput struct {
	RequestID string `json:"request_id"`
	Kind      string `json:"kind"`
	Filename  string `json:"filename"`
	Bytes     int64  `json:"bytes,string"`
	SHA256    string `json:"sha256"`
	Original  bool   `json:"original"`
}

func mediaLimit(kind string) int64 {
	switch kind {
	case "image", "avatar", "question", "audio":
		return 10 << 20
	case "video":
		return 100 << 20
	case "file":
		return 50 << 20
	}
	return 0
}
func mediaOwner(who Identity) (string, string) {
	if who.administrator != nil && who.UserID == "" {
		return "admin_owner_id", who.administrator.ID
	}
	return "owner_id", who.UserID
}
func (s *Service) CreateUpload(ctx context.Context, who Identity, in UploadInput) (Media, error) {
	ownerColumn, ownerID := mediaOwner(who)
	var out Media
	if s.Media == nil {
		return out, &Fault{503, "media_unavailable"}
	}
	hash, e := hex.DecodeString(in.SHA256)
	if !requestPattern.MatchString(in.RequestID) || !validText(in.Filename, 1, 255) || filepath.Base(in.Filename) != in.Filename || strings.ContainsAny(in.Filename, "/\\\r\n:\x00") || in.Bytes <= 0 || in.Bytes > mediaLimit(in.Kind) || e != nil || len(hash) != 32 || strings.ToLower(in.SHA256) != in.SHA256 {
		return out, ErrInvalid
	}
	admissionTimer := time.NewTimer(100 * time.Millisecond)
	defer admissionTimer.Stop()
	select {
	case s.Media.admissions <- struct{}{}:
		defer func() { <-s.Media.admissions }()
	case <-ctx.Done():
		return out, ctx.Err()
	case <-admissionTimer.C:
		return out, &Fault{429, "upload_admission_busy"}
	}
	raw, _ := json.Marshal(in)
	fingerprint := digest(string(raw))
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	// Short admission transaction; neither network I/O nor image decoding holds this lock.
	var admitted bool
	if err = tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock(7151008)").Scan(&admitted); err != nil {
		return out, err
	}
	if !admitted {
		return out, &Fault{429, "upload_admission_busy"}
	}
	var prior []byte
	err = scanMedia(tx.QueryRow(ctx, "SELECT "+mediaColumns+",request_hash FROM pulse.media WHERE "+ownerColumn+"=$1 AND request_id=$2", ownerID, in.RequestID), &out, &prior)
	if err == nil {
		if !equalBytes(prior, fingerprint) {
			return out, ErrConflict
		}
		return out, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	var total, own int64
	var count int
	err = tx.QueryRow(ctx, `SELECT COALESCE(sum(expected_bytes),0),COALESCE(sum(expected_bytes) FILTER(WHERE `+ownerColumn+`=$1),0),count(*) FROM pulse.media WHERE status IN ('pending','receiving','queued','processing')`, ownerID).Scan(&total, &own, &count)
	if err != nil {
		return out, err
	}
	if count >= 1000 || total+in.Bytes > 4<<30 || own+in.Bytes > 512<<20 {
		return out, &Fault{429, "upload_queue_full"}
	}
	if free, err := storageFree(s.Media.root); err != nil || free < uint64(total+in.Bytes+(1<<30)) {
		return out, ErrStorage
	}
	err = scanMedia(tx.QueryRow(ctx, `INSERT INTO pulse.media(id,`+ownerColumn+`,request_id,request_hash,kind,filename,expected_bytes,expected_sha256,original) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING `+mediaColumns, newID(), ownerID, in.RequestID, fingerprint, in.Kind, in.Filename, in.Bytes, in.SHA256, in.Original), &out)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func equalBytes(a, b []byte) bool { return string(a) == string(b) }
func (s *Service) UploadBytes(ctx context.Context, who Identity, id string, body io.Reader) (Media, error) {
	ownerColumn, ownerID := mediaOwner(who)
	var out Media
	if s.Media == nil {
		return out, &Fault{503, "media_unavailable"}
	}
	if !validID(id) {
		return out, ErrInvalid
	}
	select {
	case s.Media.uploads <- struct{}{}:
		defer func() { <-s.Media.uploads }()
	default:
		return out, &Fault{429, "upload_busy"}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if closer, ok := body.(io.ReadCloser); ok {
		stop := context.AfterFunc(ctx, func() { _ = closer.Close() })
		defer stop()
	}
	s.Media.mu.Lock()
	if _, exists := s.Media.cancellations[id]; exists {
		s.Media.mu.Unlock()
		return out, ErrConflict
	}
	s.Media.cancellations[id] = cancel
	s.Media.mu.Unlock()
	defer func() { s.Media.mu.Lock(); delete(s.Media.cancellations, id); s.Media.mu.Unlock() }()
	lease := newID()
	var expected int64
	var checksum string
	err := s.Store.Pool.QueryRow(ctx, `UPDATE pulse.media SET status='receiving',lease_token=$3,lease_until=now()+interval '3 minutes',updated_at=now(),error_code='' WHERE id=$1 AND `+ownerColumn+`=$2 AND (status='pending' OR(status='receiving' AND lease_until<now())) RETURNING expected_bytes,expected_sha256`, id, ownerID, lease).Scan(&expected, &checksum)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrConflict
	}
	if err != nil {
		return out, err
	}
	name := id + "-" + lease + ".source"
	path, err := s.Media.path(name)
	if err != nil {
		return out, err
	}
	keep := false
	defer func() {
		if !keep {
			clean, done := context.WithTimeout(context.Background(), 2*time.Second)
			defer done()
			var stored, status string
			e := s.Store.Pool.QueryRow(clean, "SELECT source_path,status FROM pulse.media WHERE id=$1", id).Scan(&stored, &status)
			if e == nil && (stored != name || (status != "queued" && status != "processing" && status != "ready")) {
				s.Media.remove(name)
			}
			_, _ = s.Store.Pool.Exec(clean, `UPDATE pulse.media SET status='pending',lease_token=NULL,lease_until=NULL,error_code='upload_interrupted' WHERE id=$1 AND lease_token=$2 AND status='receiving'`, id, lease)
		}
	}()

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return out, ErrStorage
	}
	h := sha256.New()
	reader := &contextReader{ctx: ctx, reader: io.LimitReader(body, expected+1)}
	n, copyErr := io.CopyBuffer(io.MultiWriter(file, h), reader, make([]byte, 64<<10))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		if ctx.Err() != nil {
			return out, ctx.Err()
		}
		return out, &Fault{400, "upload_interrupted"}
	}
	if syncErr != nil || closeErr != nil {
		return out, ErrStorage
	}
	if n != expected || hex.EncodeToString(h.Sum(nil)) != checksum {
		return out, &Fault{422, "upload_checksum_mismatch"}
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	err = scanMedia(tx.QueryRow(ctx, `UPDATE pulse.media SET status='queued',source_path=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='receiving' RETURNING `+mediaColumns, id, lease, name), &out)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrConflict
	}
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	keep = true
	return out, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if e := r.ctx.Err(); e != nil {
		return 0, e
	}
	return r.reader.Read(p)
}
func (s *Service) CancelUpload(ctx context.Context, who Identity, id string) error {
	ownerColumn, ownerID := mediaOwner(who)
	if !validID(id) {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	var source string
	err = tx.QueryRow(ctx, `UPDATE pulse.media SET status='cancelled',updated_at=now() WHERE id=$1 AND `+ownerColumn+`=$2 AND status IN ('pending','receiving','queued','processing','failed','cancelled') RETURNING source_path`, id, ownerID).Scan(&source)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if s.Media != nil {
		s.Media.mu.Lock()
		if cancel := s.Media.cancellations[id]; cancel != nil {
			cancel()
		}
		s.Media.mu.Unlock()
		s.Media.remove(source)
	}
	return nil
}
func (s *Service) mediaVisible(ctx context.Context, tx pgx.Tx, who Identity, id string) error {
	if who.administrator != nil && who.UserID == "" {
		var ok bool
		e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.media WHERE id=$1 AND admin_owner_id=$2 AND status='ready')", id, who.administrator.ID).Scan(&ok)
		if e != nil {
			return e
		}
		if !ok {
			return ErrForbidden
		}
		return nil
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.media a WHERE a.id=$1 AND a.status='ready' AND (a.owner_id=$2 OR EXISTS(
 SELECT 1 FROM pulse.message_media mm JOIN pulse.messages msg ON msg.id=mm.message_id JOIN pulse.conversations c ON c.id=msg.conversation_id AND c.active
 JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$2 AND m.active JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=$2
 WHERE mm.media_id=a.id AND NOT msg.revoked AND msg.seq>=m.visible_from_seq AND msg.seq>st.clear_seq AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$2)) OR EXISTS(
 SELECT 1 FROM pulse.users u WHERE u.avatar_id=a.id AND u.active AND NOT EXISTS(SELECT 1 FROM pulse.blocks WHERE(user_id=$2 AND peer_id=u.id)OR(user_id=u.id AND peer_id=$2))) OR EXISTS(
 SELECT 1 FROM pulse.conversations c JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$2 AND m.active WHERE c.avatar_id=a.id AND c.active) OR EXISTS(SELECT 1 FROM pulse.work_record_media rm JOIN pulse.work_records r ON r.id=rm.record_id WHERE rm.media_id=a.id AND r.user_id=$2)))`, id, who.UserID).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	return nil
}
func (s *Service) MediaStatus(ctx context.Context, who Identity, id string) (Media, error) {
	ownerColumn, ownerID := mediaOwner(who)
	var out Media
	if !validID(id) {
		return out, ErrInvalid
	}
	err := scanMedia(s.Store.Pool.QueryRow(ctx, "SELECT "+mediaColumns+" FROM pulse.media WHERE id=$1 AND "+ownerColumn+"=$2", id, ownerID), &out)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrMissing
	}
	return out, err
}
func (a *API) registerMedia(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/media/uploads", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in UploadInput
		if e := decode(w, r, &in); e != nil {
			return e
		}
		v, e := s.CreateUpload(r.Context(), who, in)
		if e == nil {
			writeJSON(w, 201, v)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/media/{id}/bytes", a.wrapTimed(true, 150*time.Second, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(120 * time.Second))
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(150 * time.Second))
		stop := context.AfterFunc(r.Context(), func() { _ = http.NewResponseController(w).SetReadDeadline(time.Now()) })
		defer stop()
		r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
		v, e := s.UploadBytes(r.Context(), who, r.PathValue("id"), r.Body)
		if e == nil {
			writeJSON(w, 202, v)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/media/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		v, e := s.MediaStatus(r.Context(), who, r.PathValue("id"))
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("DELETE /api/v2/media/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		e := s.CancelUpload(r.Context(), who, r.PathValue("id"))
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/media/{id}/retry", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		cmd, e := s.Store.Pool.Exec(r.Context(), `UPDATE pulse.media SET status=CASE WHEN source_path='' THEN 'pending' ELSE 'queued' END,error_code='',updated_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND owner_id=$2 AND status='failed' AND attempts<3`, id, who.UserID)
		if e != nil {
			return e
		}
		if cmd.RowsAffected() != 1 {
			return ErrConflict
		}
		writeJSON(w, 202, map[string]string{"id": id})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/media/{id}/{variant}", a.wrapTimed(true, 150*time.Second, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		return a.serveMedia(w, r, who, r.PathValue("id"), r.PathValue("variant"))
	}))
	mux.HandleFunc("POST /api/v2/media/{id}/grants", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id := r.PathValue("id")
		if !validID(id) {
			return ErrInvalid
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		if e = s.mediaVisible(r.Context(), tx, who, id); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		token := opaqueToken()
		if e = s.Cache.Client.Set(r.Context(), s.Cache.Prefix+"media-grant:"+hex.EncodeToString(digest(token)), who.SessionID+":"+id, 2*time.Minute).Err(); e != nil {
			return ErrBusy
		}
		writeJSON(w, 201, map[string]any{"token": token, "expires_in": 120, "content_path": "/api/v2/media-grants/" + token + "/content", "preview_path": "/api/v2/media-grants/" + token + "/preview"})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/media-grants/{token}/{variant}", a.wrapTimed(false, 150*time.Second, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		token := r.PathValue("token")
		if len(token) != 64 {
			return ErrUnauthorized
		}
		value, e := s.Cache.Client.Get(r.Context(), s.Cache.Prefix+"media-grant:"+hex.EncodeToString(digest(token))).Result()
		if e != nil {
			return ErrUnauthorized
		}
		parts := strings.Split(value, ":")
		if len(parts) != 2 || !validID(parts[0]) || !validID(parts[1]) {
			return ErrUnauthorized
		}
		who, e := s.Session(r.Context(), parts[0])
		if e != nil {
			return e
		}
		return a.serveMedia(w, r, who, parts[1], r.PathValue("variant"))
	}))

}

type mediaJob struct {
	Media
	Owner  string
	Source string
	Lease  string
}

func (s *Service) ProcessMediaOnce(ctx context.Context) (bool, error) {
	if s.Media == nil {
		return false, nil
	}
	var job mediaJob
	if _, e := s.Store.Pool.Exec(ctx, "UPDATE pulse.media SET status='failed',error_code='processing_attempts_exhausted',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<now() AND attempts>=3"); e != nil {
		return false, e
	}
	err := scanMedia(s.Store.Pool.QueryRow(ctx, `WITH candidate AS(SELECT id FROM pulse.media WHERE(status='queued' OR(status='processing' AND lease_until<now())) AND attempts<3 ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
 UPDATE pulse.media m SET status='processing',lease_token=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1,updated_at=now() FROM candidate WHERE m.id=candidate.id RETURNING m.id::text,m.kind,m.filename,m.status,m.mime,m.bytes,m.width,m.height,m.duration_ms,m.original,m.compression_applied,m.error_code,m.created_at,COALESCE(m.owner_id,m.admin_owner_id)::text,m.source_path,m.lease_token::text`, newID()), &job.Media, &job.Owner, &job.Source, &job.Lease)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	processCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var output mediaOutput
	e := s.ObserveWorker(processCtx, "media", func(c context.Context) error { var err error; output, err = s.Media.process(c, job); return err })
	code := ""
	if e != nil {
		code = "media_processing_failed"
		var f *Fault
		if errors.As(e, &f) {
			code = f.Code
		}
	}
	finishCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if e != nil {
		_, err = s.Store.Pool.Exec(finishCtx, `UPDATE pulse.media SET status='failed',error_code=$3,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='processing'`, job.ID, job.Lease, code)
		return true, err
	}
	cmd, err := s.Store.Pool.Exec(finishCtx, `UPDATE pulse.media SET status='ready',mime=$3,bytes=$4,width=$5,height=$6,duration_ms=$7,compression_applied=$8,content_path=$9,preview_path=$10,error_code='',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='processing'`, job.ID, job.Lease, output.mime, output.bytes, output.width, output.height, output.duration, output.compressed, output.content, output.preview)
	if err != nil {
		return true, err
	}
	if cmd.RowsAffected() != 1 {
		s.Media.remove(output.content)
		s.Media.remove(output.preview)
		return true, err
	}
	// The original upload is retained only when explicitly requested or needed to preserve animation.
	if output.content != job.Source {
		s.Media.remove(job.Source)
		_, _ = s.Store.Pool.Exec(finishCtx, "UPDATE pulse.media SET source_path='' WHERE id=$1 AND status='ready'", job.ID)
	}
	return true, nil
}
func (s *Service) RunMediaWorkers(ctx context.Context) {
	var workers sync.WaitGroup
	for i := 0; i < 2; i++ {
		workers.Go(func() {
			ticker := time.NewTicker(250 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
				for {
					done, e := s.ProcessMediaOnce(ctx)
					if e != nil || !done || ctx.Err() != nil {
						break
					}
				}
			}
		})
	}
	workers.Wait()
}
func mediaError(code string) error    { return &Fault{422, code} }
func mediaDescription(m Media) string { return fmt.Sprintf("%s:%s", m.Kind, m.ID) }

func (a *API) serveMedia(w http.ResponseWriter, r *http.Request, who Identity, id, variant string) error {
	s := a.Service
	if s.Media == nil {
		return &Fault{503, "media_unavailable"}
	}

	if !validID(id) || (variant != "content" && variant != "preview") {
		return ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = lockIdentity(r.Context(), tx, who); e != nil {
		return e
	}
	if e = s.mediaVisible(r.Context(), tx, who, id); e != nil {
		return e
	}
	var name, preview, filename, mimeType, kind string
	var created time.Time
	if e = tx.QueryRow(r.Context(), "SELECT content_path,preview_path,filename,mime,kind,created_at FROM pulse.media WHERE id=$1 AND status='ready'", id).Scan(&name, &preview, &filename, &mimeType, &kind, &created); e != nil {
		return e
	}
	if variant == "preview" {
		if preview == "" {
			return ErrMissing
		}
		name = preview
		mimeType = "image/jpeg"
	}
	path, e := s.Media.path(name)
	if e != nil {
		return e
	}
	file, e := os.Open(path)
	if e != nil {
		return ErrMissing
	}
	defer file.Close()
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if kind == "file" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(120 * time.Second))
	http.ServeContent(w, r, filename, created, file)
	return nil
}
