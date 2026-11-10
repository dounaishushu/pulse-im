package core

import (
	"context"
	"encoding/hex"
	"errors"
	"github.com/redis/go-redis/v9"
	"time"
)

type Cache struct {
	Client *redis.Client
	Prefix string
}

func OpenCache(ctx context.Context, rawURL, prefix string) (*Cache, error) {
	opt, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, errors.New("invalid Redis configuration")
	}
	opt.PoolSize = 8
	opt.MinIdleConns = 1
	opt.MaxRetries = -1
	opt.DialTimeout = 2 * time.Second
	opt.ReadTimeout = 500 * time.Millisecond
	opt.WriteTimeout = 500 * time.Millisecond
	opt.ContextTimeoutEnabled = true
	opt.Protocol = 2
	opt.DisableIdentity = true
	client := redis.NewClient(opt)
	if err = client.Ping(ctx).Err(); err != nil {
		client.Close()
		return nil, errors.New("Redis connection check failed")
	}
	return &Cache{Client: client, Prefix: prefix}, nil
}

var limitScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`)

func (c *Cache) Allow(ctx context.Context, scope, identity string, max int64, window time.Duration) error {
	key := c.Prefix + "limit:" + scope + ":" + hex.EncodeToString(digest(identity))
	count, err := limitScript.Run(ctx, c.Client, []string{key}, window.Milliseconds()).Int64()
	if err != nil {
		return ErrBusy
	}
	if count > max {
		return ErrLimited
	}
	return nil
}
func (c *Cache) Ticket(ctx context.Context, sessionID string) (string, error) {
	ticket := opaqueToken()
	err := c.Client.Set(ctx, c.Prefix+"ticket:"+hex.EncodeToString(digest(ticket)), sessionID, 30*time.Second).Err()
	if err != nil {
		return "", ErrBusy
	}
	return ticket, nil
}

var takeScript = redis.NewScript(`
local value=redis.call('GET',KEYS[1])
if value then redis.call('DEL',KEYS[1]) end
return value
`)

func (c *Cache) TakeTicket(ctx context.Context, ticket string) (string, error) {
	if len(ticket) != 64 {
		return "", ErrUnauthorized
	}
	sid, err := takeScript.Run(ctx, c.Client, []string{c.Prefix + "ticket:" + hex.EncodeToString(digest(ticket))}).Text()
	if errors.Is(err, redis.Nil) {
		return "", ErrUnauthorized
	}
	if err != nil {
		return "", ErrBusy
	}
	return sid, nil
}

// Online status is approximate, rebuildable metadata, never permission evidence.
// Keys include a random connection ID: a late old disconnect cannot delete a replacement.
func (c *Cache) Presence(ctx context.Context, online []Presence) error {
	if len(online) == 0 {
		return nil
	}
	_, err := c.Client.Pipelined(ctx, func(p redis.Pipeliner) error {
		for _, v := range online {
			p.Set(ctx, c.Prefix+"online:"+v.UserID+":"+v.ConnectionID, v.DeviceID, 75*time.Second)
		}
		return nil
	})
	return err
}

type Presence struct{ UserID, DeviceID, ConnectionID string }
