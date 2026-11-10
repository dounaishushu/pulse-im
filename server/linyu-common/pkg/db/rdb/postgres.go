package rdb

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/localtime"
	"os"
	"time"

	"github.com/linyu-im/linyu-server/linyu-common/pkg/config"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// OpenPostgres opens a bounded pool. It never alters the database schema.
func OpenPostgres(c config.PostgresRdbConfig) (*gorm.DB, error) {
	dsn := c.DSN
	if override := os.Getenv("PULSE_POSTGRES_DSN"); override != "" {
		dsn = override
	}
	if dsn == "" {
		return nil, errors.New("PULSE_POSTGRES_DSN is required")
	}
	pgConfig, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	pgConfig.RuntimeParams["timezone"] = "Asia/Shanghai"
	sqlPool := stdlib.OpenDB(*pgConfig, stdlib.OptionAfterConnect(func(ctx context.Context, conn *pgx.Conn) error {
		// Legacy LocalTime columns store Shanghai wall time without an offset.
		// Interpret those columns in the same zone; new message tables will use timestamptz.
		conn.TypeMap().RegisterType(&pgtype.Type{Name: "timestamp", OID: pgtype.TimestampOID, Codec: &pgtype.TimestampCodec{ScanLocation: localtime.Location}})
		return nil
	}))
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlPool}), &gorm.Config{
		DisableAutomaticPing: true,
		Logger:               logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		_ = sqlPool.Close()
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	pool, err := db.DB()
	if err != nil {
		return nil, err
	}
	maxOpen := c.MaxOpen
	if maxOpen <= 0 {
		maxOpen = 16
	}
	maxIdle := c.MaxIdle
	if maxIdle <= 0 {
		maxIdle = 4
	}
	if maxIdle > maxOpen {
		maxIdle = maxOpen
	}
	pool.SetMaxOpenConns(maxOpen)
	pool.SetMaxIdleConns(maxIdle)
	pool.SetConnMaxLifetime(30 * time.Minute)
	pool.SetConnMaxIdleTime(5 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return nil, errors.New("PostgreSQL connection check failed")
	}
	return db, nil
}

// PostgresMigrate is for isolated development databases only. Production will use
// versioned SQL migrations after the message model and import contract are fixed.
func PostgresMigrate(db *gorm.DB, models []interface{}) error {
	return db.Transaction(func(tx *gorm.DB) error {
		for _, m := range models {
			if err := tx.AutoMigrate(m); err != nil {
				return err
			}
			if initializer, ok := m.(interface{ TableInit(*gorm.DB) error }); ok {
				if err := initializer.TableInit(tx); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
