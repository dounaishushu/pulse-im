package model

import (
	"encoding/json"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/config"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/db/rdb"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/localtime"
	"os"
	"testing"
	"time"
)

func TestPostgresCoreModelsRoundTrip(t *testing.T) {
	dsn := os.Getenv("PULSE_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("requires an isolated PostgreSQL database")
	}
	t.Setenv("PULSE_POSTGRES_DSN", "")
	database, err := rdb.OpenPostgres(config.PostgresRdbConfig{DSN: dsn, MaxOpen: 4, MaxIdle: 2})
	if err != nil {
		t.Fatal(err)
	}
	pool, _ := database.DB()
	t.Cleanup(func() { _ = pool.Close() })
	var name string
	if err := database.Raw("SELECT current_database()").Scan(&name).Error; err != nil {
		t.Fatal(err)
	}
	if name != "pulse_linyu_eval" {
		t.Fatal("refusing to write outside the isolated evaluation database")
	}
	if pool.Stats().MaxOpenConnections != 4 {
		t.Fatal("database pool limit was not applied")
	}
	models := []interface{}{&User{}, &Group{}, &GroupMember{}, &Contacts{}, &Chat{}, &Message{}}
	if err := rdb.PostgresMigrate(database, models); err != nil {
		t.Fatal(err)
	}
	if err := rdb.PostgresMigrate(database, models); err != nil {
		t.Fatalf("repeat development migration: %v", err)
	}
	id := time.Now().Format("20060102150405.000000000")
	created := time.Date(2026, 11, 9, 14, 23, 45, 0, localtime.Location)
	msg := Message{ID: id, SessionID: "evaluation-session", FromID: "alice", ToID: "bob", SceneType: "user", MsgType: "text", IsShowTime: true, Content: json.RawMessage(`{"text":"迁移验证🙂"}`), CreatedAt: localtime.LocalTime(created), UpdatedAt: localtime.LocalTime(created)}
	if err := database.Create(&msg).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Unscoped().Delete(&Message{}, "id = ?", id) })
	var read Message
	if err := database.First(&read, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	if read.ID != id || !read.IsShowTime {
		t.Fatal("ID or boolean did not survive the round trip")
	}
	if string(read.Content) != string(msg.Content) {
		t.Fatalf("JSON payload changed: %s", read.Content)
	}
	if !read.CreatedAt.ToTime().Equal(created) {
		t.Fatalf("timestamp shifted: want %v, got %v", created, read.CreatedAt.ToTime())
	}
	user := User{ID: "u-" + id, Account: "a-" + id, Username: "测试账号", Password: "hash-only", Status: "active"}
	if err := database.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Unscoped().Delete(&User{}, "id = ?", user.ID) })
	var got User
	if err := database.First(&got, "id = ?", user.ID).Error; err != nil {
		t.Fatal(err)
	}
	if got.Username != user.Username {
		t.Fatal("Unicode user data changed")
	}
}
