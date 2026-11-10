// Modified for Pulse IM on 2026-11-09; see docs/FORK-CHANGES.md for the adaptation scope.
package rdb

import (
	"github.com/linyu-im/linyu-server/linyu-common/pkg/config"
	"gorm.io/gorm"
)

func InitRdb(models []interface{}) *gorm.DB {
	if config.C.Rdb.Type == "" {
		panic("rdb type not set")
	}
	var rdb *gorm.DB
	switch config.C.Rdb.Type {
	case config.PostgresRdbType:
        var err error
        rdb, err = OpenPostgres(config.C.Rdb.PostgresRdb)
        if err != nil { panic("postgres initialization failed: " + err.Error()) }
        if config.C.Rdb.PostgresRdb.AutoMigrate {
            if err := PostgresMigrate(rdb, models); err != nil { panic("postgres migration failed: " + err.Error()) }
        }
    case config.MysqlRdbType:
		rdb = NewCreateMysqlDB()
		err := MysqlMigrate(rdb, models)
		if err != nil {
			panic("mysql db migrate error: " + err.Error())
		}
	case config.SqliteRdbType:
		rdb = NewCreateSqliteDB()
		err := SqliteMigrate(rdb, models)
		if err != nil {
			panic("sqlite db migrate error: " + err.Error())
		}
	default:
		panic("db type not supported: " + config.C.Rdb.Type)
	}
	return rdb
}
