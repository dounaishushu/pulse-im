// loadcheck operates only against an explicitly named local disposable database.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"pulse.im/server/internal/core"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

func uuid() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func token() string          { b := make([]byte, 32); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func digest(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

type actor struct{ ID, Token, Session, CID string }
type stats struct {
	mu        sync.Mutex
	latencies []float64
	codes     map[int]int
	errors    int
	success   int
}

func (s *stats) add(start time.Time, code int, e error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latencies = append(s.latencies, float64(time.Since(start).Microseconds())/1000)
	s.codes[code]++
	if e != nil || code < 200 || code >= 300 {
		s.errors++
	} else {
		s.success++
	}
}
func (s *stats) report() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := append([]float64(nil), s.latencies...)
	sort.Float64s(values)
	percentile := func(p float64) float64 {
		if len(values) == 0 {
			return 0
		}
		return values[min(len(values)-1, int(float64(len(values)-1)*p))]
	}
	return map[string]any{"requests": len(values), "success": s.success, "errors": s.errors, "http_status": s.codes, "p50_ms": percentile(.5), "p95_ms": percentile(.95), "p99_ms": percentile(.99)}
}
func request(ctx context.Context, client *http.Client, base, method, path string, a actor, value any, out any) (int, error) {
	var body io.Reader
	if value != nil {
		if raw, ok := value.([]byte); ok {
			body = bytes.NewReader(raw)
		} else {
			raw, e := json.Marshal(value)
			if e != nil {
				return 0, e
			}
			body = bytes.NewReader(raw)
		}
	}
	req, e := http.NewRequestWithContext(ctx, method, base+path, body)
	if e != nil {
		return 0, e
	}
	req.Header.Set("Content-Type", "application/json")
	if a.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.Token)
	}
	octet := 1
	if a.ID != "" {
		octet = int(a.ID[0])%200 + 1
	}
	req.Header.Set("X-Real-IP", "192.0.2."+strconv.Itoa(octet))
	resp, e := client.Do(req)
	if e != nil {
		return 0, e
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if e != nil {
		return resp.StatusCode, e
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && out != nil {
		e = json.Unmarshal(raw, out)
	}
	return resp.StatusCode, e
}
func seed(ctx context.Context, store *core.Store, n int) ([]actor, string, string, error) {
	var db, host string
	host = store.Pool.Config().ConnConfig.Host
	if e := store.Pool.QueryRow(ctx, "SELECT current_database()").Scan(&db); e != nil {
		return nil, "", "", e
	}
	if db != "pulse_core_test" || (host != "127.0.0.1" && host != "localhost") {
		return nil, "", "", errors.New("disposable localhost/pulse_core_test required")
	}
	if _, e := store.Pool.Exec(ctx, "TRUNCATE pulse.users,pulse.admin_accounts,pulse.work_questions,pulse.sensitive_words CASCADE"); e != nil {
		return nil, "", "", e
	}
	service, e := core.NewService(store, nil)
	if e != nil {
		return nil, "", "", e
	}
	uid, e := service.CreateUser(ctx, "fixtureseed", token())
	if e != nil {
		return nil, "", "", e
	}
	var hash string
	if e = store.Pool.QueryRow(ctx, "SELECT password_hash FROM pulse.users WHERE id=$1", uid).Scan(&hash); e != nil {
		return nil, "", "", e
	}
	actors := make([]actor, n)
	rows := make([][]any, 0, n)
	sessions := make([][]any, 0, n)
	members := make([][]any, 0, n)
	states := make([][]any, 0, n)
	conversations := [][]any{}
	cid := ""
	for i := range actors {
		if i%50 == 0 {
			cid = uuid()
			conversations = append(conversations, []any{cid, "group", "load-group", int64(500)})
		}
		a := actor{uuid(), token(), uuid(), cid}
		actors[i] = a
		rows = append(rows, []any{a.ID, fmt.Sprintf("load%06d", i), hash})
		sessions = append(sessions, []any{a.Session, a.ID, "load", digest(a.Token), time.Now().Add(4 * time.Hour)})
		role := "member"
		if i%50 == 0 {
			role = "owner"
		}
		members = append(members, []any{cid, a.ID, role, true})
		states = append(states, []any{cid, a.ID})
	}
	for _, input := range []struct {
		table   string
		columns []string
		rows    [][]any
	}{{"users", []string{"id", "account", "password_hash"}, rows}, {"login_sessions", []string{"id", "user_id", "device_id", "token_hash", "expires_at"}, sessions}, {"conversations", []string{"id", "kind", "title", "member_limit"}, conversations}, {"members", []string{"conversation_id", "user_id", "role", "history_allowed"}, members}, {"user_states", []string{"conversation_id", "user_id"}, states}} {
		if _, e = store.Pool.CopyFrom(ctx, pgx.Identifier{"pulse", input.table}, input.columns, pgx.CopyFromRows(input.rows)); e != nil {
			return nil, "", "", e
		}
	}
	password := token()
	_, entry, e := service.BootstrapAdmin(ctx, "loadadmin", password)
	return actors, password, entry, e
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	base := flag.String("url", "http://127.0.0.1:18082", "")
	n := flag.Int("connections", 10000, "")
	duration := flag.Duration("duration", 60*time.Second, "")
	rate := flag.Int("messages-per-second", 100, "")
	images := flag.Int("images", 300, "")
	imageUsers := flag.Int("image-users", 1, "")
	outdir := flag.String("output", "", "")
	flag.Parse()
	u, e := url.Parse(*base)
	if e != nil || u.Hostname() != "127.0.0.1" || u.Scheme != "http" || *n < 1 || *n > 12000 || *rate < 1 || *rate > 2000 || *images < 0 || *images > 1000 || *imageUsers < 1 || *imageUsers > *n || *outdir == "" {
		return errors.New("invalid bounded local load configuration")
	}
	if _, e = os.Stat(*outdir); !os.IsNotExist(e) {
		return errors.New("use a fresh output directory")
	}
	if e = os.MkdirAll(*outdir, 0700); e != nil {
		return e
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store, e := core.OpenStore(ctx, os.Getenv("PULSE_CORE_TEST_DSN"))
	if e != nil {
		return e
	}
	defer store.Pool.Close()
	if e = store.Migrate(ctx); e != nil {
		return e
	}
	actors, password, entry, e := seed(ctx, store, *n)
	if e != nil {
		return e
	}
	client := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{MaxIdleConns: 256, MaxIdleConnsPerHost: 128, MaxConnsPerHost: 256, ResponseHeaderTimeout: 15 * time.Second}}
	var admin struct {
		CSRF string `json:"csrf_token"`
	}
	raw, _ := json.Marshal(map[string]string{"account": "loadadmin", "password": password, "entry_token": entry})
	resp, e := client.Post(*base+"/api/v2/admin/auth/login", "application/json", bytes.NewReader(raw))
	if e != nil {
		return e
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return fmt.Errorf("load admin status %d", resp.StatusCode)
	}
	e = json.NewDecoder(resp.Body).Decode(&admin)
	cookies := resp.Cookies()
	resp.Body.Close()
	if e != nil {
		return e
	}
	metrics := func() map[string]any {
		req, _ := http.NewRequestWithContext(ctx, "GET", *base+"/api/v2/admin/health", nil)
		for _, c := range cookies {
			req.AddCookie(c)
		}
		req.Header.Set("X-Admin-Entry", entry)
		resp, e := client.Do(req)
		if e != nil {
			return map[string]any{"error": "health_unavailable"}
		}
		defer resp.Body.Close()
		var result map[string]any
		if json.NewDecoder(resp.Body).Decode(&result) != nil {
			return map[string]any{"error": "health_invalid"}
		}
		return result
	}
	samples, e := os.Create(filepath.Join(*outdir, "samples.jsonl"))
	if e != nil {
		return e
	}
	defer samples.Close()
	sampleCtx, stopSampling := context.WithCancel(ctx)
	var sampling sync.WaitGroup
	sampling.Go(func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		encoder := json.NewEncoder(samples)
		for {
			select {
			case <-sampleCtx.Done():
				return
			case <-tick.C:
			}
			v := metrics()
			v["at"] = time.Now().UTC()
			_ = encoder.Encode(v)
		}
	})
	defer func() { stopSampling(); sampling.Wait() }()
	opened := atomic.Int64{}
	closed := atomic.Int64{}
	frames := atomic.Int64{}
	handshake := &stats{codes: map[int]int{}}
	sockets := make([]*websocket.Conn, *n)
	jobs := make(chan int)
	var wg sync.WaitGroup
	started := time.Now()
	for worker := 0; worker < 32; worker++ {
		wg.Go(func() {
			for i := range jobs {
				a := actors[i]
				var ticket struct {
					Ticket string `json:"ticket"`
				}
				start := time.Now()
				code, e := request(ctx, client, *base, "POST", "/api/v2/realtime/tickets", a, map[string]any{}, &ticket)
				if e != nil || code != 201 {
					handshake.add(start, code, e)
					continue
				}
				headers := http.Header{"X-Real-IP": []string{"192.0.2." + strconv.Itoa(i%200+1)}}
				conn, response, e := websocket.DefaultDialer.DialContext(ctx, "ws://"+u.Host+"/api/v2/realtime?ticket="+ticket.Ticket, headers)
				if e != nil {
					status := 0
					if response != nil {
						status = response.StatusCode
					}
					handshake.add(start, status, e)
					continue
				}
				var ready map[string]any
				_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
				e = conn.ReadJSON(&ready)
				if e != nil || ready["type"] != "ready" {
					conn.Close()
					handshake.add(start, 0, errors.New("ready missing"))
					continue
				}
				_ = conn.SetReadDeadline(time.Time{})
				sockets[i] = conn
				opened.Add(1)
				handshake.add(start, 201, nil)
				go func() {
					defer closed.Add(1)
					for {
						if _, _, e := conn.ReadMessage(); e != nil {
							return
						}
						frames.Add(1)
					}
				}()
			}
		})
	}
	for i := range actors {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	connectionSeconds := time.Since(started).Seconds()
	fmt.Printf("connections ready: %d/%d in %.1fs\n", opened.Load(), *n, connectionSeconds)
	baseline := metrics()
	invalidCases := map[string]int{}
	invalidActor := actors[0]
	for label, config := range map[string]struct {
		method, path string
		actor        actor
		body         any
		expected     int
	}{
		"bad_session":     {"POST", "/api/v2/conversations/" + invalidActor.CID + "/messages", actor{Token: token()}, map[string]string{"request_id": "bad-session", "body": "denied"}, 401},
		"forged_media":    {"POST", "/api/v2/conversations/" + invalidActor.CID + "/messages", invalidActor, map[string]string{"request_id": "forged-media", "kind": "image", "media_id": uuid()}, 403},
		"invalid_message": {"POST", "/api/v2/conversations/" + invalidActor.CID + "/messages", invalidActor, map[string]string{"request_id": "invalid-body", "body": ""}, 400},
		"bad_sequence":    {"GET", "/api/v2/conversations/" + invalidActor.CID + "/history?after_seq=not-a-number", invalidActor, nil, 400},
	} {
		code, e := request(ctx, client, *base, config.method, config.path, config.actor, config.body, nil)
		invalidCases[label] = code
		if e != nil || code != config.expected {
			return fmt.Errorf("error contract %s: status %d", label, code)
		}
	}

	sends := &stats{codes: map[int]int{}}
	active := make(chan int, 256)
	var sending sync.WaitGroup
	for worker := 0; worker < 32; worker++ {
		sending.Go(func() {
			for i := range active {
				a := actors[i%len(actors)]
				start := time.Now()
				code, e := request(ctx, client, *base, "POST", "/api/v2/conversations/"+a.CID+"/messages", a, map[string]string{"request_id": fmt.Sprintf("load-%d", i), "body": "ordinary load message"}, nil)
				sends.add(start, code, e)
			}
		})
	}
	tick := time.NewTicker(time.Second / time.Duration(*rate))
	until := time.NewTimer(*duration)
	sequence := 0
loop:
	for {
		select {
		case <-until.C:
			break loop
		case <-tick.C:
			active <- sequence
			sequence++
		}
	}
	tick.Stop()
	close(active)
	sending.Wait()
	fmt.Printf("chat phase requests: %d\n", sequence)
	imageChat := &stats{codes: map[int]int{}}
	imageChatCtx, stopImageChat := context.WithCancel(ctx)
	defer stopImageChat()
	var imageChatWait sync.WaitGroup
	imageChatWait.Go(func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		seq := 0
		for {
			select {
			case <-imageChatCtx.Done():
				return
			case <-ticker.C:
			}
			a := actors[(seq+20)%len(actors)]
			start := time.Now()
			code, e := request(imageChatCtx, client, *base, "POST", "/api/v2/conversations/"+a.CID+"/messages", a, map[string]string{"request_id": fmt.Sprintf("image-chat-%d", seq), "body": "chat during media processing"}, nil)
			imageChat.add(start, code, e)
			seq++
		}
	})
	uploadStats := &stats{codes: map[int]int{}}
	readyImages := atomic.Int64{}
	failedImages := atomic.Int64{}
	imageMessages := &stats{codes: map[int]int{}}
	peakUploads := metrics()
	if *images > 0 {
		// Deterministic 2048x1536 JPEG; each request holds only a shared immutable byte slice.
		picture := image.NewNRGBA(image.Rect(0, 0, 2048, 1536))
		var value uint32 = 19937
		for y := 0; y < 1536; y++ {
			for x := 0; x < 2048; x++ {
				value = value*1664525 + 1013904223
				picture.SetNRGBA(x, y, color.NRGBA{uint8(value >> 24), uint8(value >> 16), uint8(value >> 8), 255})
			}
		}
		var buffer bytes.Buffer
		if e = jpeg.Encode(&buffer, picture, &jpeg.Options{Quality: 95}); e != nil {
			return e
		}
		imageData := buffer.Bytes()
		hash := sha256.Sum256(imageData)
		queue := make(chan int)
		mediaIDs := make(chan struct {
			actor actor
			id    string
		}, *images)
		var uploading sync.WaitGroup
		for worker := 0; worker < 24; worker++ {
			uploading.Go(func() {
				for i := range queue {
					a := actors[i%min(*imageUsers, len(actors))]
					input := map[string]any{"request_id": fmt.Sprintf("burst-%d", i), "kind": "image", "filename": "burst.jpg", "bytes": strconv.Itoa(len(imageData)), "sha256": hex.EncodeToString(hash[:]), "original": i%5 == 0}
					var obj struct {
						ID string `json:"id"`
					}
					ok := false
					for attempt := 0; attempt < 120; attempt++ {
						start := time.Now()
						code, e := request(ctx, client, *base, "POST", "/api/v2/media/uploads", a, input, &obj)
						uploadStats.add(start, code, e)
						if e == nil && code == 201 {
							ok = true
							break
						}
						if code != 429 && code != 503 {
							break
						}
						time.Sleep(time.Second)
					}
					if !ok {
						failedImages.Add(1)
						continue
					}
					ok = false
					for attempt := 0; attempt < 120; attempt++ {
						start := time.Now()
						code, e := request(ctx, client, *base, "PUT", "/api/v2/media/"+obj.ID+"/bytes", a, imageData, nil)
						uploadStats.add(start, code, e)
						if e == nil && code == 202 {
							ok = true
							break
						}
						if code != 429 && code != 503 {
							break
						}
						time.Sleep(time.Second)
					}
					if !ok {
						failedImages.Add(1)
						continue
					}
					mediaIDs <- struct {
						actor actor
						id    string
					}{a, obj.ID}
				}
			})
		}
		for i := 0; i < *images; i++ {
			queue <- i
		}
		close(queue)
		uploading.Wait()
		close(mediaIDs)
		fmt.Printf("image uploads submitted (%d bytes/image)\n", len(imageData))
		pending := []struct {
			actor actor
			id    string
		}{}
		for item := range mediaIDs {
			pending = append(pending, item)
		}
		deadline := time.Now().Add(8 * time.Minute)
		for len(pending) > 0 && time.Now().Before(deadline) {
			remaining := pending[:0]
			for _, item := range pending {
				var status struct {
					Status string `json:"status"`
				}
				code, e := request(ctx, client, *base, "GET", "/api/v2/media/"+item.id, item.actor, nil, &status)
				if e != nil || code != 200 {
					remaining = append(remaining, item)
					continue
				}
				if status.Status == "ready" {
					readyImages.Add(1)
					start := time.Now()
					status, err := request(ctx, client, *base, "POST", "/api/v2/conversations/"+item.actor.CID+"/messages", item.actor, map[string]string{"request_id": "image-msg-" + item.id, "kind": "image", "media_id": item.id}, nil)
					if err != nil || status == 429 || status == 503 {
						remaining = append(remaining, item)
						readyImages.Add(-1)
						continue
					}
					imageMessages.add(start, status, err)
				} else if status.Status == "failed" || status.Status == "cancelled" {
					failedImages.Add(1)
				} else {
					remaining = append(remaining, item)
				}
			}
			pending = remaining
			if len(pending) > 0 {
				time.Sleep(2 * time.Second)
			}
		}
		failedImages.Add(int64(len(pending)))
		peakUploads = metrics()
	}
	stopImageChat()
	imageChatWait.Wait()
	recovery := metrics()
	beforeClose := closed.Load()
	for _, socket := range sockets {
		if socket != nil {
			_ = socket.Close()
		}
	}
	time.Sleep(3 * time.Second)
	afterClose := metrics()
	result := map[string]any{"started_at": started.UTC(), "completed_at": time.Now().UTC(), "host_logical_cpus": runtime.NumCPU(), "connections_requested": *n, "connections_opened": opened.Load(), "unexpected_disconnects": beforeClose, "connection_seconds": connectionSeconds, "connection_requests": handshake.report(), "chat_duration_seconds": duration.Seconds(), "chat_target_rps": *rate, "chat": sends.report(), "images_requested": *images, "image_users": *imageUsers, "images_ready": readyImages.Load(), "image_messages": imageMessages.report(), "images_failed": failedImages.Load(), "upload_attempts": uploadStats.report(), "chat_during_images": imageChat.report(), "notification_frames": frames.Load(), "baseline": baseline, "after_images": peakUploads, "before_disconnect": recovery, "after_disconnect": afterClose, "production_changed": false, "invalid_request_statuses": invalidCases}
	encoded, _ := json.MarshalIndent(result, "", "  ")
	if e = os.WriteFile(filepath.Join(*outdir, "result.json"), encoded, 0600); e != nil {
		return e
	}
	fmt.Printf("report: %s\n", filepath.Join(*outdir, "result.json"))
	if opened.Load() != int64(*n) || failedImages.Load() != 0 || beforeClose != 0 || sends.errors != 0 || imageMessages.errors != 0 {
		return errors.New("load acceptance condition failed; inspect report")
	}
	return nil
}
