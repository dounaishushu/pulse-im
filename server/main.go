package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"pulse.im/server/internal/core"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Pulse IM stopped", "reason", err.Error())
		os.Exit(1)
	}
}
func run() error {
	if os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(2 << 30)
	}
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if command != "serve" && command != "migrate" && command != "create-user" && command != "create-admin" {
		return errors.New("usage: pulse-im [serve|migrate|create-user ACCOUNT]")
	}
	capacity, err := loadServerCapacity(os.Getenv)
	if err != nil {
		return err
	}
	dsn := os.Getenv("PULSE_POSTGRES_DSN")
	if dsn == "" {
		return errors.New("PULSE_POSTGRES_DSN is required")
	}
	startup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	store, err := core.OpenStoreWithPool(startup, dsn, int32(capacity.postgresMax), int32(capacity.postgresMin))
	cancel()
	if err != nil {
		return errors.New("PostgreSQL initialization failed")
	}
	defer store.Pool.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if command == "migrate" {
		if err := store.Migrate(ctx); err != nil {
			return errors.New("schema migration failed; inspect the database migration state")
		}
		fmt.Println("Pulse IM schema initialized.")
		return nil
	}
	if err = store.CheckSchema(ctx); err != nil {
		return err
	}
	if command == "create-admin" {
		if len(os.Args) != 3 {
			return errors.New("usage: pulse-im create-admin ACCOUNT (password from PULSE_ADMIN_PASSWORD)")
		}
		service, e := core.NewService(store, nil)
		if e != nil {
			return e
		}
		id, entry, e := service.BootstrapAdmin(ctx, os.Args[2], os.Getenv("PULSE_ADMIN_PASSWORD"))
		if e != nil {
			return errors.New("create-admin failed")
		}
		fmt.Println("Created admin", id, "entry_token", entry)
		return nil
	}
	if command == "create-user" {
		if len(os.Args) != 3 {
			return errors.New("usage: pulse-im create-user ACCOUNT (password from PULSE_USER_PASSWORD)")
		}
		service, err := core.NewService(store, nil)
		if err != nil {
			return err
		}
		id, err := service.CreateUser(ctx, os.Args[2], os.Getenv("PULSE_USER_PASSWORD"))
		if err != nil {
			return errors.New("create-user failed; check unique account and password length 10..256 bytes")
		}
		fmt.Println("Created user", id)
		return nil
	}
	redisURL := os.Getenv("PULSE_REDIS_URL")
	if redisURL == "" {
		return errors.New("PULSE_REDIS_URL is required")
	}
	cache, err := core.OpenCacheWithPool(ctx, redisURL, "pulse:", capacity.redisPool, capacity.redisMax)
	if err != nil {
		return err
	}
	defer cache.Client.Close()
	service, err := core.NewService(store, cache)
	if err != nil {
		return err
	}
	mediaRoot := os.Getenv("PULSE_MEDIA_DIR")
	if mediaRoot == "" {
		mediaRoot = "data/media"
	}
	probe := os.Getenv("PULSE_FFPROBE")
	if probe == "" {
		probe = "ffprobe"
	}
	probe, err = exec.LookPath(probe)
	if err != nil {
		return errors.New("ffprobe is required; set PULSE_FFPROBE to the installed executable")
	}
	service.Media, err = core.NewMediaStoreWithLimits(mediaRoot, probe, capacity.media)
	if err != nil {
		return errors.New("media storage initialization failed")
	}
	service.PushWorkers = capacity.push
	service.Push, err = core.NewPushTransport(core.PushConfig{APNsKeyID: os.Getenv("PULSE_APNS_KEY_ID"), APNsTeam: os.Getenv("PULSE_APNS_TEAM"), APNsTopic: os.Getenv("PULSE_APNS_TOPIC"), APNsKeyPath: os.Getenv("PULSE_APNS_KEY_PATH"), FCMAccountPath: os.Getenv("PULSE_FCM_ACCOUNT_PATH")})
	if err != nil {
		return err
	}
	service.Telegram, err = core.NewTelegramTransport(core.TelegramConfig{Token: os.Getenv("PULSE_TELEGRAM_TOKEN"), WebhookSecret: os.Getenv("PULSE_TELEGRAM_WEBHOOK_SECRET"), AdminBaseURL: os.Getenv("PULSE_ADMIN_BASE_URL"), DNSProvider: os.Getenv("PULSE_TELEGRAM_DNS_PROVIDER"), GroupPIN: os.Getenv("PULSE_TELEGRAM_GROUP_PIN"), GroupAccountsEnabled: strings.EqualFold(os.Getenv("PULSE_TELEGRAM_GROUP_ACCOUNTS_ENABLED"), "true")})
	if err != nil {
		return err
	}
	service.Locations, err = core.NewLocationClient(os.Getenv("PULSE_IP_LOCATION_URL"))
	service.IPPureEnabled = !strings.EqualFold(strings.TrimSpace(os.Getenv("PULSE_IPPURE_ENABLED")), "false")
	if err != nil {
		return err
	}
	service.RuntimeDir = os.Getenv("PULSE_RUNTIME_DIR")
	if service.RuntimeDir == "" {
		service.RuntimeDir = "runtime"
	}
	options := core.HTTPOptions{
		Origins:        map[string]bool{},
		AdminOpsSecret: os.Getenv("PULSE_ADMIN_OPS_SECRET"),
		MaxInflight:    capacity.httpInflight,
		MaxTransfers:   capacity.httpTransfers,
		MaxHandshakes:  capacity.wsHandshakes,
	}
	for _, origin := range strings.Split(os.Getenv("PULSE_ALLOWED_ORIGINS"), ",") {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			options.Origins[origin] = true
		}
	}
	for _, raw := range strings.Split(os.Getenv("PULSE_TRUSTED_PROXY_CIDRS"), ",") {
		if raw == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(strings.TrimSpace(raw))
		if err != nil {
			return errors.New("invalid trusted proxy CIDR")
		}
		options.TrustedProxies = append(options.TrustedProxies, prefix)
	}
	hub := core.NewHub(capacity.wsConns, int64(capacity.wsQueueMiB)<<20)
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	var workers sync.WaitGroup
	workers.Go(func() {
		// 备用实例先完成连接预热，交接时再启动后台任务，避免两个实例争抢实时通知。
		activation := os.Getenv("PULSE_WORKER_ACTIVATION_FILE")
		for activation != "" {
			if _, err := os.Stat(activation); err == nil {
				break
			} else if !os.IsNotExist(err) {
				slog.Error("worker activation file unavailable")
				stop()
				return
			}
			select {
			case <-workerCtx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
		workers.Go(func() { service.RunDispatcher(workerCtx, hub) })
		workers.Go(func() { service.RunSweeper(workerCtx, hub) })
		workers.Go(func() { service.RunMediaWorkers(workerCtx) })
		workers.Go(func() { service.RunDeliveryJobs(workerCtx) })
		workers.Go(func() { service.RunPushWorker(workerCtx) })
		workers.Go(func() { service.RunMaintenance(workerCtx) })
		workers.Go(func() { service.RunTelegramWorker(workerCtx) })
		workers.Go(func() { service.RunActivity(workerCtx) })
		slog.Info("Pulse workers activated")
	})
	address := os.Getenv("PULSE_LISTEN")
	if address == "" {
		address = "127.0.0.1:8080"
	}
	server := &http.Server{Addr: address, Handler: core.NewHandler(service, hub, options),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	slog.Info("Pulse IM listening", "address", address,
		slog.Group("capacity",
			"postgres_max", store.Pool.Stat().MaxConns(), "postgres_min", capacity.postgresMin,
			"redis_pool", cache.Client.Options().PoolSize, "redis_max", cache.Client.Options().MaxActiveConns,
			"http_inflight", capacity.httpInflight, "http_transfers", capacity.httpTransfers, "ws_handshakes", capacity.wsHandshakes,
			"ws_connections", capacity.wsConns, "ws_queue_mib", capacity.wsQueueMiB,
			"push_workers", capacity.push.Workers, "push_batch_size", capacity.push.BatchSize,
			"push_send_parallelism", capacity.push.Parallelism,
			"push_apns_configured", service.Push.Available("ios"), "push_fcm_configured", service.Push.Available("android"),
			"media_uploads", capacity.media.Uploads, "media_workers", capacity.media.Workers,
			"media_waiters", capacity.media.Waiters, "media_queue_jobs", capacity.media.QueueJobs,
			"media_queue_gib", capacity.media.QueueBytes>>30, "media_decode_mib", capacity.media.DecodeBytes>>20,
			"media_upload_seconds", int(capacity.media.UploadReadTimeout/time.Second),
			"media_admission_ms", capacity.media.AdmissionWait.Milliseconds(), "media_admission_queue", capacity.media.AdmissionQueue(),
			"media_admission_parallelism", capacity.media.AdmissionPreparers,
		))
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-stopped:
	}
	hub.Close()
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	_ = server.Shutdown(shutdown)
	cancelWorkers()
	workers.Wait()
	service.FlushWorkerHeartbeats()
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return errors.New("HTTP listener failed")
	}
	return nil
}
