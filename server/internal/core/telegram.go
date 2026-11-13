package core

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type TelegramConfig struct {
	Token, WebhookSecret, AdminBaseURL string
	DNSProvider                        string
	GroupPIN                           string
	GroupAccountsEnabled               bool
}
type TelegramTransport struct {
	config TelegramConfig
	client *http.Client
	base   string
}

func NewTelegramTransport(c TelegramConfig) (*TelegramTransport, error) {
	if c.Token == "" {
		return &TelegramTransport{config: c}, nil
	}
	if len(c.WebhookSecret) < 32 || !safeURL(c.AdminBaseURL, false) || (c.GroupPIN != "" && (len(c.GroupPIN) < 6 || len(c.GroupPIN) > 128 || strings.TrimSpace(c.GroupPIN) != c.GroupPIN)) {
		return nil, errors.New("Telegram secret or admin URL missing")
	}
	client, err := telegramHTTPClient(c.DNSProvider)
	if err != nil {
		return nil, err
	}
	return &TelegramTransport{config: c, base: "https://api.telegram.org", client: client}, nil
}
func (t *TelegramTransport) Enabled() bool { return t != nil && t.config.Token != "" }

func (t *TelegramTransport) groupAllows(permission string) bool {
	if t == nil || t.config.GroupPIN == "" {
		return false
	}
	if permission == "tasks.codes" {
		return true
	}
	return t.config.GroupAccountsEnabled && (permission == "accounts.create" || permission == "entry.self")
}
func (t *TelegramTransport) send(ctx context.Context, chatID int64, text string) error {
	if !t.Enabled() {
		return &Fault{503, "telegram_unconfigured"}
	}
	if len([]rune(text)) > 3800 {
		return ErrInvalid
	}
	raw, _ := json.Marshal(map[string]any{"chat_id": chatID, "text": text, "protect_content": true})
	req, e := http.NewRequestWithContext(ctx, "POST", t.base+"/bot"+t.config.Token+"/sendMessage", bytes.NewReader(raw))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := t.client.Do(req)
	if e != nil {
		return ErrBusy
	}
	defer resp.Body.Close()
	data, e := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	if e != nil {
		return ErrBusy
	}
	var result struct {
		OK bool `json:"ok"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(data, &result) != nil || !result.OK {
		return &Fault{502, "telegram_delivery_failed"}
	}
	return nil
}

type telegramUpdate struct {
	ID      int64 `json:"update_id"`
	Message *struct {
		Text string `json:"text"`
		From struct {
			ID    int64 `json:"id"`
			IsBot bool  `json:"is_bot"`
		} `json:"from"`
		Chat struct {
			ID   int64  `json:"id"`
			Type string `json:"type"`
		} `json:"chat"`
	} `json:"message"`
}

func (s *Service) telegramAllow(ctx context.Context, update telegramUpdate, permission string) error {
	if update.Message == nil || update.Message.From.IsBot || update.Message.From.ID <= 0 || update.Message.Chat.ID == 0 {
		return ErrForbidden
	}
	uid, chat := update.Message.From.ID, update.Message.Chat.ID
	chatType := update.Message.Chat.Type
	if chatType != "private" && chatType != "group" && chatType != "supergroup" {
		return ErrForbidden
	}
	var permissions []string
	e := s.Store.Pool.QueryRow(ctx, "SELECT permissions FROM pulse.telegram_grants WHERE telegram_user_id=$1 AND active", uid).Scan(&permissions)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	granted := false
	for _, p := range permissions {
		if p == permission {
			granted = true
			break
		}
	}
	if chatType == "private" {
		if granted {
			return nil
		}
		return ErrForbidden
	}
	var globalManaged bool
	e = s.Store.Pool.QueryRow(ctx, `DELETE FROM pulse.telegram_authorizations a USING pulse.telegram_chats c
 WHERE a.chat_id=$1 AND a.telegram_user_id=$2 AND c.chat_id=a.chat_id AND c.enabled
 AND c.version=a.chat_version AND a.expires_at>now() RETURNING c.global_managed`, chat, uid).Scan(&globalManaged)
	if errors.Is(e, pgx.ErrNoRows) {
		return &Fault{403, "telegram_pin_required"}
	}
	if e != nil {
		return e
	}
	if granted || (globalManaged && s.Telegram.groupAllows(permission)) {
		return nil
	}
	return ErrForbidden
}
func (s *Service) telegramAuthorize(ctx context.Context, update telegramUpdate, permission string) (AdminIdentity, error) {
	var who AdminIdentity
	if e := s.telegramAllow(ctx, update, permission); e != nil {
		return who, e
	}
	if update.Message.Chat.Type != "private" && s.Telegram.groupAllows(permission) {
		var globalManaged bool
		e := s.Store.Pool.QueryRow(ctx, "SELECT global_managed FROM pulse.telegram_chats WHERE chat_id=$1 AND enabled", update.Message.Chat.ID).Scan(&globalManaged)
		if e != nil {
			return who, e
		}
		if globalManaged {
			e = s.Store.Pool.QueryRow(ctx, `SELECT id::text,account,role,permissions,version
 FROM pulse.admin_accounts WHERE active AND role='superadmin' ORDER BY created_at,id LIMIT 1`).Scan(&who.ID, &who.Account, &who.Role, &who.Permissions, &who.Version)
			if errors.Is(e, pgx.ErrNoRows) {
				return who, ErrForbidden
			}
			who.RequestID = fmt.Sprintf("telegram:%d:%d", update.Message.From.ID, update.ID)
			return who, e
		}
	}
	var adminID *string
	e := s.Store.Pool.QueryRow(ctx, "SELECT admin_id::text FROM pulse.telegram_grants WHERE telegram_user_id=$1 AND active", update.Message.From.ID).Scan(&adminID)
	if e != nil {
		return who, e
	}
	if adminID == nil {
		return who, ErrForbidden
	}
	e = s.Store.Pool.QueryRow(ctx, "SELECT id::text,account,role,permissions,version FROM pulse.admin_accounts WHERE id=$1 AND active", *adminID).Scan(&who.ID, &who.Account, &who.Role, &who.Permissions, &who.Version)
	if errors.Is(e, pgx.ErrNoRows) {
		return who, ErrForbidden
	}
	who.RequestID = fmt.Sprintf("telegram:%d:%d", update.Message.From.ID, update.ID)
	return who, e
}
func (s *Service) telegramCommand(ctx context.Context, u telegramUpdate) ([]string, error) {
	if u.Message == nil {
		return nil, nil
	}
	parts := strings.Fields(u.Message.Text)
	if len(parts) == 0 {
		return nil, nil
	}
	command := strings.Split(parts[0], "@")[0]
	switch command {
	case "/pin":
		if len(parts) != 2 || u.Message.From.ID <= 0 || u.Message.Chat.ID >= 0 || (u.Message.Chat.Type != "group" && u.Message.Chat.Type != "supergroup") {
			return nil, ErrInvalid
		}
		if e := s.Cache.Allow(ctx, "telegram-pin", fmt.Sprintf("%d:%d", u.Message.Chat.ID, u.Message.From.ID), 5, 15*time.Minute); e != nil {
			return nil, e
		}
		select {
		case s.passwordSlots <- struct{}{}:
			defer func() { <-s.passwordSlots }()
		default:
			return nil, ErrBusy
		}
		var hash string
		var version int64
		var globalManaged bool
		e := s.Store.Pool.QueryRow(ctx, "SELECT pin_hash,version,global_managed FROM pulse.telegram_chats WHERE chat_id=$1 AND enabled", u.Message.Chat.ID).Scan(&hash, &version, &globalManaged)
		if errors.Is(e, pgx.ErrNoRows) {
			if s.Telegram.config.GroupPIN == "" || subtle.ConstantTimeCompare([]byte(parts[1]), []byte(s.Telegram.config.GroupPIN)) != 1 {
				return nil, ErrForbidden
			}
			hash, e = hashSecret(parts[1])
			if e != nil {
				return nil, e
			}
			if _, e = s.Store.Pool.Exec(ctx, "INSERT INTO pulse.telegram_chats(chat_id,pin_hash,global_managed) VALUES($1,$2,true) ON CONFLICT DO NOTHING", u.Message.Chat.ID, hash); e != nil {
				return nil, e
			}
			e = s.Store.Pool.QueryRow(ctx, "SELECT pin_hash,version,global_managed FROM pulse.telegram_chats WHERE chat_id=$1 AND enabled", u.Message.Chat.ID).Scan(&hash, &version, &globalManaged)
		}
		if e != nil {
			return nil, e
		}
		if globalManaged {
			if s.Telegram.config.GroupPIN == "" || subtle.ConstantTimeCompare([]byte(parts[1]), []byte(s.Telegram.config.GroupPIN)) != 1 {
				return nil, ErrForbidden
			}
			if !verifyPassword(parts[1], hash) {
				hash, e = hashSecret(parts[1])
				if e != nil {
					return nil, e
				}
				e = s.Store.Pool.QueryRow(ctx, "UPDATE pulse.telegram_chats SET pin_hash=$2,version=version+1 WHERE chat_id=$1 AND global_managed RETURNING version", u.Message.Chat.ID, hash).Scan(&version)
				if e != nil {
					return nil, e
				}
			}
		} else {
			var grant bool
			if e = s.Store.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.telegram_grants WHERE telegram_user_id=$1 AND active)", u.Message.From.ID).Scan(&grant); e != nil {
				return nil, e
			}
			if !grant || !verifyPassword(parts[1], hash) {
				return nil, ErrForbidden
			}
		}
		_, e = s.Store.Pool.Exec(ctx, `INSERT INTO pulse.telegram_authorizations(chat_id,telegram_user_id,chat_version,expires_at)
 VALUES($1,$2,$3,now()+interval '3 minutes')
 ON CONFLICT(chat_id,telegram_user_id) DO UPDATE SET chat_version=$3,expires_at=now()+interval '3 minutes'`,
			u.Message.Chat.ID, u.Message.From.ID, version)
		return []string{"群 PIN 已验证，仅下一次操作有效（3 分钟内）。"}, e
	case "/codes":
		who, e := s.telegramAuthorize(ctx, u, "tasks.codes")
		if e != nil {
			return nil, e
		}
		if !adminPermission(who.Role, who.Permissions, "tasks", false) {
			return nil, ErrForbidden
		}
		rows, e := s.Store.Pool.Query(ctx, "SELECT id::text,name FROM pulse.work_tasks ORDER BY sort_order,id")
		if e != nil {
			return nil, e
		}
		type task struct{ id, name string }
		items := []task{}
		for rows.Next() {
			var t task
			if e = rows.Scan(&t.id, &t.name); e != nil {
				rows.Close()
				return nil, e
			}
			items = append(items, t)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		messages := []string{}
		text := workDate() + " 任务验证码\n"
		for _, t := range items {
			code, e := s.TaskCode(ctx, who, t.id, workDate(), false)
			if e != nil {
				return nil, e
			}
			line := t.name + ": " + code + "\n"
			if len([]rune(text+line)) > 3500 {
				messages = append(messages, text)
				text = ""
			}
			text += line
		}
		return append(messages, text), nil
	case "/create_admin":
		who, e := s.telegramAuthorize(ctx, u, "accounts.create")
		if e != nil {
			return nil, e
		}
		if who.Role != "superadmin" {
			return nil, ErrForbidden
		}
		if len(parts) < 4 || len(parts) > 5 {
			return []string{"用法：/create_admin 账号 operator|auditor 模块.view,模块.manage [关联Telegram用户ID]"}, nil
		}
		target := u.Message.From.ID
		if len(parts) == 5 {
			target, e = strconv.ParseInt(parts[4], 10, 64)
			if e != nil || target <= 0 {
				return nil, ErrInvalid
			}
		}
		password := opaqueToken()[:24]
		out, e := s.saveAdmin(ctx, who, "", AdminAccountInput{Account: parts[1], Password: password, Role: parts[2], Permissions: strings.Split(parts[3], ","), Active: true}, target)
		if e != nil {
			return nil, e
		}
		entry := out["entry_token"].(string)
		// Credentials are returned only to the command issuer's private chat.
		e = s.Telegram.send(ctx, u.Message.From.ID, "后台账号："+parts[1]+"\n初始密码："+password+"\n入口："+s.Telegram.config.AdminBaseURL+"#entry="+url.QueryEscape(entry))
		if e != nil {
			return nil, e
		}
		return []string{"后台账号已创建，登录资料已私聊发送。"}, nil
	case "/entry":
		if len(parts) != 1 {
			return nil, ErrInvalid
		}
		if e := s.telegramAllow(ctx, u, "entry.self"); e != nil {
			return nil, e
		}
		tx, e := s.Store.Pool.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(ctx)
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7153001)"); e != nil {
			return nil, e
		}
		rows, e := tx.Query(ctx, `SELECT a.id::text,a.account
 FROM pulse.admin_accounts a
 JOIN pulse.telegram_grants g ON g.telegram_user_id=$1 AND g.active
 WHERE a.active AND a.id=ANY(g.admin_ids)
 ORDER BY a.account,a.id LIMIT 101 FOR UPDATE OF a`, u.Message.From.ID)
		if e != nil {
			return nil, e
		}
		type ownedAdmin struct{ id, account string }
		accounts := []ownedAdmin{}
		for rows.Next() {
			var account ownedAdmin
			if e = rows.Scan(&account.id, &account.account); e != nil {
				rows.Close()
				return nil, e
			}
			accounts = append(accounts, account)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		if len(accounts) == 0 {
			return []string{"暂无已绑定的后台账号，请先创建。"}, nil
		}
		if len(accounts) > 100 {
			return nil, &Fault{409, "too_many_admin_entries"}
		}
		lines := make([]string, 0, len(accounts))
		for _, account := range accounts {
			entry := opaqueToken()
			if _, e = tx.Exec(ctx, "UPDATE pulse.admin_accounts SET entry_hash=$2,legacy_entry_salt=NULL,legacy_entry_hash=NULL,version=version+1 WHERE id=$1", account.id, digest(entry)); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "UPDATE pulse.admin_sessions SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL", account.id); e != nil {
				return nil, e
			}
			who := AdminIdentity{ID: account.id, Account: account.account, RequestID: fmt.Sprintf("telegram:%d", u.ID)}
			if e = auditTx(ctx, tx, who, "telegram.entry.rotate", "admin", account.id, map[string]any{}); e != nil {
				return nil, e
			}
			lines = append(lines, "后台账号："+account.account+"\n入口："+s.Telegram.config.AdminBaseURL+"#entry="+url.QueryEscape(entry)+"\n")
		}
		if e = tx.Commit(ctx); e != nil {
			return nil, e
		}
		message := "新的本人后台入口（旧入口已失效）：\n"
		for _, line := range lines {
			if len([]rune(message+line)) > 3500 {
				if e = s.Telegram.send(ctx, u.Message.From.ID, message); e != nil {
					return nil, e
				}
				message = ""
			}
			message += line
		}
		if message != "" {
			if e = s.Telegram.send(ctx, u.Message.From.ID, message); e != nil {
				return nil, e
			}
		}
		return []string{"本人后台入口已私聊发送。"}, nil
	default:
		return []string{"命令：/pin 验证群授权，/codes 查询任务码，/create_admin 创建后台账号，/entry 获取本人入口。"}, nil
	}
}
func (s *Service) ProcessTelegramOnce(ctx context.Context) (bool, error) {
	if !s.Telegram.Enabled() {
		return false, nil
	}
	// A crashed command may already have changed state or sent a response. Preserve it as uncertain instead of executing it again.
	if _, e := s.Store.Pool.Exec(ctx, "UPDATE pulse.telegram_updates SET status='uncertain',error_code='worker_interrupted',payload='{}',lease_token=NULL,lease_until=NULL WHERE status='processing' AND lease_until<now()"); e != nil {
		return false, e
	}
	lease := newID()
	var id int64
	var raw []byte
	e := s.Store.Pool.QueryRow(ctx, `WITH c AS(SELECT update_id FROM pulse.telegram_updates WHERE status='pending' AND available_at<=now() AND(lease_until IS NULL OR lease_until<now()) ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE pulse.telegram_updates u SET status='processing',lease_token=$1,lease_until=now()+interval '60 seconds',attempts=attempts+1 FROM c WHERE u.update_id=c.update_id RETURNING u.update_id,u.payload`, lease).Scan(&id, &raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var update telegramUpdate
	if e = json.Unmarshal(raw, &update); e != nil {
		return true, e
	}
	replies, commandErr := s.telegramCommand(ctx, update)
	code := ""
	if commandErr != nil {
		code = "telegram_command_failed"
		var f *Fault
		if errors.As(commandErr, &f) {
			code = f.Code
		}
		replies = []string{"操作未完成：" + code}
	}
	if update.Message != nil {
		for _, reply := range replies {
			if e = s.Telegram.send(ctx, update.Message.Chat.ID, reply); e != nil {
				break
			}
		}
	}
	status := "completed"
	if e != nil {
		status = "failed"
		code = "telegram_response_failed"
	}
	// Do not replay state-changing commands after an ambiguous external response.
	_, saveErr := s.Store.Pool.Exec(ctx, "UPDATE pulse.telegram_updates SET status=$3,error_code=$4,lease_until=NULL,lease_token=NULL,payload='{}' WHERE update_id=$1 AND lease_token=$2", id, lease, status, code)
	return true, saveErr
}
func (s *Service) RunTelegramWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		pass, cancel := context.WithTimeout(ctx, 45*time.Second)
		_ = s.ObserveWorker(pass, "telegram", func(c context.Context) error { _, e := s.ProcessTelegramOnce(c); return e })
		cancel()
	}
}
func (a *API) registerTelegram(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/integrations/telegram/webhook", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		if !s.Telegram.Enabled() {
			return &Fault{503, "telegram_unconfigured"}
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Telegram-Bot-Api-Secret-Token")), []byte(s.Telegram.config.WebhookSecret)) != 1 {
			return ErrForbidden
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		raw, e := io.ReadAll(r.Body)
		if e != nil {
			return ErrInvalid
		}
		var update telegramUpdate
		if json.Unmarshal(raw, &update) != nil || update.ID <= 0 {
			return ErrInvalid
		}
		if update.Message == nil {
			writeJSON(w, 200, map[string]bool{"ok": true})
			return nil
		}
		if len(update.Message.Text) > 16000 {
			return ErrInvalid
		}
		if e = s.Cache.Allow(r.Context(), "telegram-user", strconv.FormatInt(update.Message.From.ID, 10), 30, time.Minute); e != nil {
			return e
		}
		_, e = s.Store.Pool.Exec(r.Context(), "INSERT INTO pulse.telegram_updates(update_id,payload) VALUES($1,$2) ON CONFLICT DO NOTHING", update.ID, raw)
		if e == nil {
			writeJSON(w, 200, map[string]bool{"ok": true})
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/admin/telegram/grants", a.adminWrap("telegram", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if who.Role != "superadmin" {
			return ErrForbidden
		}
		var in struct {
			TelegramID  int64    `json:"telegram_user_id,string"`
			AdminID     string   `json:"admin_id"`
			Permissions []string `json:"permissions"`
			Active      bool     `json:"active"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if in.TelegramID <= 0 || !validID(in.AdminID) || len(in.Permissions) > 3 {
			return ErrInvalid
		}
		for _, p := range in.Permissions {
			if p != "tasks.codes" && p != "accounts.create" && p != "entry.self" {
				return ErrInvalid
			}
		}
		e := s.adminWrite(r.Context(), who, "telegram", "telegram.grant", "admin", in.AdminID, func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), `INSERT INTO pulse.telegram_grants(telegram_user_id,admin_id,admin_ids,permissions,active)
 VALUES($1,$2,ARRAY[$2::uuid],$3,$4)
 ON CONFLICT(telegram_user_id) DO UPDATE SET admin_id=$2,admin_ids=ARRAY[$2::uuid],permissions=$3,active=$4`,
				in.TelegramID, in.AdminID, in.Permissions, in.Active)
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/admin/telegram/chats", a.adminWrap("telegram", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			ChatID  int64  `json:"chat_id,string"`
			PIN     string `json:"pin"`
			Enabled bool   `json:"enabled"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if in.ChatID == 0 || len(in.PIN) < 8 || len(in.PIN) > 128 {
			return ErrInvalid
		}
		select {
		case s.passwordSlots <- struct{}{}:
			defer func() { <-s.passwordSlots }()
		default:
			return ErrBusy
		}
		hash, e := hashSecret(in.PIN)
		if e != nil {
			return e
		}
		e = s.adminWrite(r.Context(), who, "telegram", "telegram.chat", "chat", strconv.FormatInt(in.ChatID, 10), func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), "INSERT INTO pulse.telegram_chats(chat_id,pin_hash,enabled) VALUES($1,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET pin_hash=$2,enabled=$3,version=pulse.telegram_chats.version+1", in.ChatID, hash, in.Enabled)
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
}
