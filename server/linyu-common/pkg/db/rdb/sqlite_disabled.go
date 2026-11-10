//go:build !linyu_legacy_db

package rdb

import "gorm.io/gorm"

func NewCreateSqliteDB() *gorm.DB { panic("SQLite requires linyu_legacy_db build; Pulse targets PostgreSQL") }
func SqliteMigrate(_ *gorm.DB, _ []interface{}) error { panic("SQLite requires linyu_legacy_db build") }
