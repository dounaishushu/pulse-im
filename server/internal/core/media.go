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
const MaxMediaAdmissionParallelism = 16

var ErrStorage = &Fault{507, "insufficient_storage"}

type MediaLimits struct {
	Uploads, Workers, Waiters, QueueJobs, AdmissionPreparers int
	QueueBytes, DecodeBytes                                  int64
	UploadReadTimeout, AdmissionWait                         time.Duration
}

func DefaultMediaLimits() MediaLimits {
	return MediaLimits{
		Uploads: 8, Workers: 2, Waiters: 64, QueueJobs: 1000, AdmissionPreparers: 1,
		QueueBytes: 4 << 30, DecodeBytes: 512 << 20,
		UploadReadTimeout: 120 * time.Second, AdmissionWait: 100 * time.Millisecond,
	}
}

// AdmissionQueue limits upload reservations waiting for the quota transaction.
func (l MediaLimits) AdmissionQueue() int { return max(64, l.Uploads*2) }

type MediaStore struct {
	admissionQueue chan struct{}
	admissionSlots chan int
	limits         MediaLimits
	root           string
	uploads        chan struct{}
	pixels         *semaphore.Weighted
	mu             sync.Mutex
	cancellations  map[string]context.CancelFunc
	wake           chan struct{}
	completion     map[string]*mediaCompletion
	waits          chan struct{}
	probe          string
}

func NewMediaStore(root, probe string) (*MediaStore, error) {
	return NewMediaStoreWithLimits(root, probe, DefaultMediaLimits())
}

func NewMediaStoreWithLimits(root, probe string, limits MediaLimits) (*MediaStore, error) {
	if limits.AdmissionPreparers < 1 || limits.AdmissionPreparers > MaxMediaAdmissionParallelism {
		return nil, errors.New("invalid media admission parallelism")
	}
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
	admissionSlots := make(chan int, limits.AdmissionPreparers)
	for i := range limits.AdmissionPreparers {
		admissionSlots <- i
	}
	return &MediaStore{
		limits: limits, root: root, probe: probe,
		uploads:        make(chan struct{}, limits.Uploads),
		admissionQueue: make(chan struct{}, limits.AdmissionQueue()), admissionSlots: admissionSlots,
		pixels: semaphore.NewWeighted(limits.DecodeBytes), wake: make(chan struct{}, limits.Workers),
		cancellations: map[string]context.CancelFunc{}, completion: map[string]*mediaCompletion{},
		waits: make(chan struct{}, limits.Waiters),
	}, nil
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
	select {
	case s.Media.admissionQueue <- struct{}{}:
		defer func() { <-s.Media.admissionQueue }()
	default:
		return out, &Fault{429, "upload_admission_busy"}
	}
	admission, cancel := context.WithTimeout(ctx, s.Media.limits.AdmissionWait)
	defer cancel()
	var slot int
	select {
	case slot = <-s.Media.admissionSlots:
		defer func() { s.Media.admissionSlots <- slot }()
	case <-admission.Done():
		return out, &Fault{429, "upload_admission_busy"}
	}
	free, _ := storageFree(s.Media.root)
	var diskBudget int64
	if free > 1<<30 {
		diskBudget = int64(min(free-(1<<30), uint64(s.Media.limits.QueueBytes)))
	}
	if s.Media.limits.AdmissionPreparers == 1 {
		return s.reserveUpload(ctx, who, ownerColumn, ownerID, in, diskBudget, slot, false)
	}
	out, err := s.reserveUpload(admission, who, ownerColumn, ownerID, in, diskBudget, slot, true)
	if errors.Is(err, pgx.ErrNoRows) {
		// Near quota, retry once with the exact budget under the exclusive lock.
		out, err = s.reserveUpload(admission, who, ownerColumn, ownerID, in, diskBudget, slot, false)
	}
	if err != nil && admission.Err() != nil && ctx.Err() == nil {
		return out, &Fault{429, "upload_admission_busy"}
	}
	return out, err
}

func (s *Service) reserveUpload(ctx context.Context, who Identity, ownerColumn, ownerID string, in UploadInput, diskBudget int64, slot int, parallel bool) (Media, error) {
	var out Media
	raw, _ := json.Marshal(in)
	fingerprint := digest(string(raw))
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	queueJobs, queueBytes := s.Media.limits.QueueJobs, diskBudget
	if parallel {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(7151008)"); err != nil {
			return out, err
		}
		// The numbered locks cap overlapping reservations across processes. The
		// owner lock serializes retries and byte quota checks for that owner.
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7151008,$1), pg_advisory_xact_lock(7151009,hashtext($2))", slot, ownerID); err != nil {
			return out, err
		}
		// A reservation query sees committed rows. Leave room for at most
		// 15 other transactions that may have reserved 100 MiB each.
		queueJobs -= MaxMediaAdmissionParallelism - 1
		queueBytes -= int64(MaxMediaAdmissionParallelism-1) * mediaLimit("video")
	} else if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7151008)"); err != nil {
		return out, err
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
	usage := `SELECT COALESCE(sum(expected_bytes),0) total,
		COALESCE(sum(expected_bytes) FILTER(WHERE ` + ownerColumn + `=$1),0) own,
		count(*) jobs FROM pulse.media WHERE status IN ('pending','receiving','queued','processing')`
	const ownBudget = 512 << 20
	err = scanMedia(tx.QueryRow(ctx, `WITH usage AS (`+usage+`)
		INSERT INTO pulse.media(id,`+ownerColumn+`,request_id,request_hash,kind,filename,expected_bytes,expected_sha256,original)
		SELECT $2,$1,$3,$4,$5,$6,$7,$8,$9 FROM usage
		WHERE jobs < $10 AND own + $7::bigint <= $11 AND total + $7::bigint <= $12
		RETURNING `+mediaColumns,
		ownerID, newID(), in.RequestID, fingerprint, in.Kind, in.Filename,
		in.Bytes, in.SHA256, in.Original, queueJobs, ownBudget, queueBytes), &out)
	if errors.Is(err, pgx.ErrNoRows) && !parallel {
		if diskBudget < s.Media.limits.QueueBytes {
			var total, own, jobs int64
			if err = tx.QueryRow(ctx, usage, ownerID).Scan(&total, &own, &jobs); err != nil {
				return out, err
			}
			if jobs < int64(queueJobs) && own+in.Bytes <= ownBudget && total+in.Bytes <= s.Media.limits.QueueBytes {
				return out, ErrStorage
			}
		}
		return out, &Fault{429, "upload_queue_full"}
	}
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
	case <-ctx.Done():
		return out, ErrBusy
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
	s.Media.wakeWorker()
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
		s.Media.completed(id)
		s.Media.mu.Lock()
		if cancel := s.Media.cancellations[id]; cancel != nil {
			cancel()
		}
		s.Media.mu.Unlock()
		s.Media.remove(source)
	}
	return nil
}

// Materialize only references to this media before joining message visibility.
// Otherwise generic plans can scan a viewer's entire history for each avatar.
const visibleMediaPredicate = `(a.owner_id=$2 OR EXISTS(
 WITH candidate_refs AS MATERIALIZED (SELECT message_id FROM pulse.message_media WHERE media_id=a.id)
 SELECT 1 FROM candidate_refs mm JOIN pulse.messages msg ON msg.id=mm.message_id JOIN pulse.conversations c ON c.id=msg.conversation_id AND c.active
 JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$2 AND m.active JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=$2
 WHERE NOT msg.revoked AND (NOT msg.manager_only OR m.role IN('owner','admin')) AND msg.seq>=m.visible_from_seq AND msg.seq>st.clear_seq AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$2)) OR EXISTS(
 SELECT 1 FROM pulse.users u WHERE u.avatar_id=a.id AND u.deleted_at IS NULL
 AND (u.active OR EXISTS(SELECT 1 FROM pulse.friendships f WHERE f.user_low=LEAST($2::uuid,u.id) AND f.user_high=GREATEST($2::uuid,u.id))
 OR EXISTS(SELECT 1 FROM pulse.members viewer JOIN pulse.members peer USING(conversation_id)
 JOIN pulse.conversations c ON c.id=viewer.conversation_id AND c.active
 WHERE viewer.user_id=$2 AND peer.user_id=u.id AND viewer.active AND peer.active))
 AND NOT EXISTS(SELECT 1 FROM pulse.blocks WHERE(user_id=$2 AND peer_id=u.id)OR(user_id=u.id AND peer_id=$2))) OR EXISTS(
 SELECT 1 FROM pulse.conversations c JOIN pulse.members m ON m.conversation_id=c.id AND m.user_id=$2 AND m.active WHERE c.avatar_id=a.id AND c.active) OR EXISTS(SELECT 1 FROM pulse.work_record_media rm JOIN pulse.work_records r ON r.id=rm.record_id WHERE rm.media_id=a.id AND r.user_id=$2))`

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
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.media a WHERE a.id=$1 AND a.status='ready' AND `+visibleMediaPredicate+`)`, id, who.UserID).Scan(&allowed)
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
	a.registerBatchMediaGrants(mux)
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
	uploadReadTimeout := DefaultMediaLimits().UploadReadTimeout
	if s.Media != nil {
		uploadReadTimeout = s.Media.limits.UploadReadTimeout
	}
	uploadTimeout := uploadReadTimeout + 30*time.Second
	mux.HandleFunc("PUT /api/v2/media/{id}/bytes", a.wrapWithSlots(a.transfers, true, uploadTimeout, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		wait, e := mediaWaitDuration(r)
		if e != nil {
			return e
		}
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(uploadReadTimeout))
		_ = controller.SetWriteDeadline(time.Now().Add(uploadTimeout))
		stop := context.AfterFunc(r.Context(), func() { _ = http.NewResponseController(w).SetReadDeadline(time.Now()) })
		defer stop()
		r.Body = http.MaxBytesReader(w, r.Body, 100<<20)
		v, e := s.UploadBytes(r.Context(), who, r.PathValue("id"), r.Body)
		if e == nil {
			v, e = s.waitForMedia(r.Context(), who, v, wait)
			if e == nil {
				e = a.writeMediaResult(w, r, who, 202, v, wait > 0)
			}
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/media/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		wait, e := mediaWaitDuration(r)
		if e != nil {
			return e
		}
		v, e := s.MediaStatus(r.Context(), who, r.PathValue("id"))
		if e == nil {
			v, e = s.waitForMedia(r.Context(), who, v, wait)
			if e == nil {
				e = a.writeMediaResult(w, r, who, 200, v, wait > 0)
			}
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
		s.Media.wakeWorker()
		writeJSON(w, 202, map[string]string{"id": id})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/media/{id}/{variant}", a.wrapWithSlots(a.transfers, true, 150*time.Second, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		return a.serveMedia(w, r, who, r.PathValue("id"), r.PathValue("variant"))
	}))
	mux.HandleFunc("POST /api/v2/media/{id}/grants", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		grant, e := s.createMediaGrant(r.Context(), who, r.PathValue("id"))
		if e == nil {
			writeJSON(w, 201, grant)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/media-grants/{token}/{variant}", a.wrapWithSlots(a.transfers, false, 150*time.Second, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
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
	// A claimed job can be slow. Let a second worker claim the next one.
	s.Media.wakeWorker()
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
		if err == nil {
			s.Media.completed(job.ID)
		}
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
	s.Media.completed(job.ID)
	// The original upload is retained only when explicitly requested or needed to preserve animation.
	if output.content != job.Source {
		s.Media.remove(job.Source)
		_, _ = s.Store.Pool.Exec(finishCtx, "UPDATE pulse.media SET source_path='' WHERE id=$1 AND status='ready'", job.ID)
	}
	return true, nil
}
func (s *Service) RunMediaWorkers(ctx context.Context) {
	if s.Media == nil {
		return
	}
	var workers sync.WaitGroup
	for range s.Media.limits.Workers {
		workers.Go(func() {
			for {
				select {
				case <-ctx.Done():
					return
				case <-s.Media.wake:
				}
				for ctx.Err() == nil {
					processed, err := s.ProcessMediaOnce(ctx)
					if err != nil || !processed {
						break
					}
				}
			}
		})
	}
	defer workers.Wait()
	// One periodic check recovers queued work and expired leases. Idle
	// workers sleep until notified, regardless of the configured pool size.
	poll := time.NewTicker(time.Second)
	defer poll.Stop()
	s.Media.wakeWorker()
	for {
		select {
		case <-ctx.Done():
			return
		case <-poll.C:
			s.Media.wakeWorker()
		}
	}
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
	privateMediaCache(w, id, variant, who.SessionID)
	w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
	if r.PathValue("token") != "" {
		w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if kind == "file" {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(120 * time.Second))
	http.ServeContent(w, r, filename, created, file)
	return nil
}
