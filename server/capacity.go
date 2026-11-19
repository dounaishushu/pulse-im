package main

import (
	"fmt"
	"strconv"
	"time"

	"pulse.im/server/internal/core"
)

type serverCapacity struct {
	postgresMax, postgresMin    int
	redisPool, redisMax         int
	httpInflight, httpTransfers int
	wsHandshakes, wsConns       int
	wsQueueMiB                  int
	media                       core.MediaLimits
}

func loadServerCapacity(getenv func(string) string) (serverCapacity, error) {
	c := serverCapacity{
		postgresMax: 16, postgresMin: 2,
		redisPool:    8,
		httpInflight: 256, httpTransfers: 128,
		wsHandshakes: 128, wsConns: 12000, wsQueueMiB: 32,
		media: core.DefaultMediaLimits(),
	}
	queueGiB := int(c.media.QueueBytes >> 30)
	decodeMiB := int(c.media.DecodeBytes >> 20)
	uploadSeconds := int(c.media.UploadReadTimeout / time.Second)
	admissionMillis := int(c.media.AdmissionWait / time.Millisecond)
	for _, setting := range []struct {
		key      string
		target   *int
		min, max int
	}{
		{"PULSE_DB_MAX_CONNS", &c.postgresMax, 4, 256},
		{"PULSE_DB_MIN_CONNS", &c.postgresMin, 0, 64},
		{"PULSE_REDIS_POOL_SIZE", &c.redisPool, 1, 128},
		{"PULSE_REDIS_MAX_CONNS", &c.redisMax, 0, 256},
		{"PULSE_HTTP_MAX_INFLIGHT", &c.httpInflight, 16, 4096},
		{"PULSE_HTTP_MAX_TRANSFERS", &c.httpTransfers, 8, 2048},
		{"PULSE_WS_MAX_HANDSHAKES", &c.wsHandshakes, 8, 1024},
		{"PULSE_WS_MAX_CONNECTIONS", &c.wsConns, 128, 100000},
		{"PULSE_WS_QUEUE_MIB", &c.wsQueueMiB, 1, 512},
		{"PULSE_MEDIA_UPLOAD_SLOTS", &c.media.Uploads, 1, 128},
		{"PULSE_MEDIA_WORKERS", &c.media.Workers, 1, 32},
		{"PULSE_MEDIA_WAIT_SLOTS", &c.media.Waiters, 1, 1024},
		{"PULSE_MEDIA_QUEUE_JOBS", &c.media.QueueJobs, 100, 10000},
		{"PULSE_MEDIA_QUEUE_GIB", &queueGiB, 1, 64},
		{"PULSE_MEDIA_DECODE_MIB", &decodeMiB, 512, 4096},
		{"PULSE_MEDIA_UPLOAD_SECONDS", &uploadSeconds, 30, 150},
		{"PULSE_MEDIA_ADMISSION_MS", &admissionMillis, 50, 1500},
		{"PULSE_MEDIA_ADMISSION_PARALLELISM", &c.media.AdmissionPreparers, 1, core.MaxMediaAdmissionParallelism},
	} {
		if raw := getenv(setting.key); raw != "" {
			value, err := strconv.Atoi(raw)
			if err != nil || value < setting.min || value > setting.max {
				return serverCapacity{}, fmt.Errorf("%s must be an integer between %d and %d", setting.key, setting.min, setting.max)
			}
			*setting.target = value
		}
	}
	if c.postgresMin > c.postgresMax {
		return serverCapacity{}, fmt.Errorf("PULSE_DB_MIN_CONNS exceeds PULSE_DB_MAX_CONNS")
	}
	if c.redisMax > 0 && c.redisMax < c.redisPool {
		return serverCapacity{}, fmt.Errorf("PULSE_REDIS_MAX_CONNS is smaller than PULSE_REDIS_POOL_SIZE")
	}
	if c.media.Waiters+c.media.AdmissionQueue() >= c.httpInflight {
		return serverCapacity{}, fmt.Errorf("media slots must leave room for other HTTP requests")
	}
	if c.media.Uploads >= c.httpTransfers {
		return serverCapacity{}, fmt.Errorf("media upload slots must leave room for downloads")
	}
	if c.media.AdmissionPreparers > c.postgresMax/4 {
		return serverCapacity{}, fmt.Errorf("media admission cannot reserve more than one quarter of the PostgreSQL pool")
	}
	c.media.QueueBytes = int64(queueGiB) << 30
	c.media.DecodeBytes = int64(decodeMiB) << 20
	c.media.UploadReadTimeout = time.Duration(uploadSeconds) * time.Second
	c.media.AdmissionWait = time.Duration(admissionMillis) * time.Millisecond
	return c, nil
}
