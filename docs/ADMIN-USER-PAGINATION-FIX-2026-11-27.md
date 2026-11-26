## 1. 计划（先输出，等确认）

用户于本轮明确要求“修复”上一轮审查唯一已确认的 P2；按该授权限定修改 Go 后端的用户分页查询、最近成功登录索引及回归测试。执行方案已在开始和实现前说明，继续按该授权完成，不重复请求确认。

先补可复现回归，保留原搜索、状态筛选和排序；再将用户分页放在独立 MATERIALIZED 查询块，随后补齐本页登录、网络及归属地字段；增加成功登录排序索引；最后执行隔离数据库回归、执行计划对照、Go vet 和 Linux 编译。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

**P2：后台用户列表在分页前为所有匹配用户查询最近登录和网络记录。**

- server/internal/core/admin_operations.go：新增 adminUsersQuery，将既有筛选/排序/LIMIT/OFFSET 放入 user_page MATERIALIZED CTE，外层只为页内用户执行原 LATERAL JOIN；HTTP handler 调用该查询。外层保留同样的 created_at DESC,id 排序。
- server/internal/core/migrations/068_login_events_user_latest_success.sql：增加 (user_id,created_at DESC,id DESC) WHERE success 索引，最近成功登录可直接取第一条，覆盖同时间 id 作为第二排序键。
- server/internal/core/admin_user_page_test.go：新增真实 HTTP 结果、EXPLAIN ANALYZE 执行次数及实际数据库索引回归。

当前页选择与补齐字段分离，减少跨全体用户的重复查询。用户详情沿用原单用户查询；两类归属地仍按同一用户及对应 IP 读取。未新增依赖。

## 3. 完整 diff

以下展示完整业务/迁移/测试差异；可应用的原始补丁保存在本轮 .local 目录 changes.patch。Markdown 展示去除行尾空白并用空格展示缩进。

```diff
diff --git a/server/internal/core/admin_operations.go b/server/internal/core/admin_operations.go
index b4f0f6e..65d8265 100644
--- a/server/internal/core/admin_operations.go
+++ b/server/internal/core/admin_operations.go
@@ -89,6 +89,24 @@ const adminLatestLoginJoin = ` LEFT JOIN LATERAL (
  WHERE n.user_id=u.id ORDER BY n.checked_at DESC,n.session_id DESC LIMIT 1
 ) latest_network ON true `

+// Bound both lateral lookups to the selected page, including when the user
+// table has no selective filters. Materialization keeps enrichment after LIMIT.
+func adminUsersQuery(ippure bool) string {
+   return `WITH user_page AS MATERIALIZED (
+ SELECT u.* FROM pulse.users u
+ WHERE(account ILIKE $3 OR nickname ILIKE $3 OR phone ILIKE $3 OR public_id ILIKE $3
+ OR legacy_public_id ILIKE $3 OR u.id::text ILIKE $3
+ OR EXISTS(SELECT 1 FROM pulse.legacy_ids li WHERE li.entity='user' AND li.new_id=u.id AND li.legacy_id::text ILIKE $3)
+ OR registration_ip::text ILIKE $3
+ OR EXISTS(SELECT 1 FROM pulse.login_events l WHERE l.user_id=u.id AND l.success AND l.ip::text ILIKE $3))
+ AND($4='' OR($4='active' AND active AND deleted_at IS NULL)
+ OR($4='frozen' AND NOT active AND deleted_at IS NULL)OR($4='deleted' AND deleted_at IS NOT NULL))
+ ORDER BY u.created_at DESC,u.id LIMIT $1 OFFSET $2
+)
+ SELECT ` + adminUserProjection + adminUserLocationsProjection(ippure) + ` FROM user_page u ` +
+       adminLatestLoginJoin + ` ORDER BY u.created_at DESC,u.id`
+}
+
 func (s *Service) AdminSaveUser(ctx context.Context, who AdminIdentity, id string, in AdminUserPatch) error {
    if !validID(id) || in.Expected < 1 {
        return ErrInvalid
@@ -177,7 +195,7 @@ func (a *API) registerAdminOperations(mux *http.ServeMux) {
        if status != "" && status != "active" && status != "frozen" && status != "deleted" {
            return ErrInvalid
        }
-       return adminRows(w, r, s, `SELECT `+adminUserProjection+adminUserLocationsProjection(s.IPPureEnabled)+` FROM pulse.users u `+adminLatestLoginJoin+` WHERE(account ILIKE $3 OR nickname ILIKE $3 OR phone ILIKE $3 OR public_id ILIKE $3 OR legacy_public_id ILIKE $3 OR u.id::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.legacy_ids li WHERE li.entity='user' AND li.new_id=u.id AND li.legacy_id::text ILIKE $3) OR registration_ip::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.login_events l WHERE l.user_id=u.id AND l.success AND l.ip::text ILIKE $3)) AND($4='' OR($4='active' AND active AND deleted_at IS NULL)OR($4='frozen' AND NOT active AND deleted_at IS NULL)OR($4='deleted' AND deleted_at IS NOT NULL)) ORDER BY u.created_at DESC,u.id LIMIT $1 OFFSET $2`, q, status)
+       return adminRows(w, r, s, adminUsersQuery(s.IPPureEnabled), q, status)
    }))
    mux.HandleFunc("GET /api/v2/admin/users/{id}", a.adminWrap("users", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
        id := r.PathValue("id")
diff --git a/server/internal/core/admin_user_page_test.go b/server/internal/core/admin_user_page_test.go
new file mode 100644
index 0000000..744320c
--- /dev/null
+++ b/server/internal/core/admin_user_page_test.go
@@ -0,0 +1,163 @@
+package core
+
+import (
+   "encoding/json"
+   "fmt"
+   "net/url"
+   "reflect"
+   "strings"
+   "testing"
+)
+
+func TestAdminUserPagePreservesFiltersAndLatestRows(t *testing.T) {
+   f := newFixture(t)
+   root := newAdmin(t, f)
+   id := func(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
+   for n := 1; n <= 8; n++ {
+       f.exec(t, `INSERT INTO pulse.users(id,account,password_hash,nickname,active,deleted_at,created_at)
+        VALUES($1,$2,$3,$2,$4,CASE WHEN $5 THEN '2026-11-05'::timestamptz END,
+        CASE WHEN $6 THEN '2026-11-02'::timestamptz ELSE '2026-11-01'::timestamptz END)`,
+           id(n), fmt.Sprintf("pageuser%02d", n), testPasswordHash, n != 3 && n != 4 && n != 7 && n != 8, n == 4 || n == 8, n >= 6)
+   }
+   f.exec(t, "UPDATE pulse.users SET nickname='page%_needle' WHERE id=$1", id(2))
+   f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8',phone='+86123000005',legacy_public_id='legacyPageFive' WHERE id=$1", id(5))
+   f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('user',987654321,$1)", id(5))
+   // The successful timestamp is authoritative, with id breaking equal-time ties.
+   for _, row := range []struct {
+       ip, at  string
+       success bool
+   }{
+       {"7.7.7.5", "2026-11-03T12:00:00Z", true},
+       {"7.7.7.6", "2026-11-03T12:00:00Z", true},
+       {"9.9.9.5", "2026-11-04T12:00:00Z", false},
+       {"1.1.1.5", "2026-11-02T12:00:00Z", true},
+   } {
+       f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason,created_at,client_version)
+        VALUES($1,'pageuser05',$2,'web','page test',$3,'test',$4,'2.4.234')`, id(5), row.ip, row.success, row.at)
+   }
+   for n := 1; n <= 2; n++ {
+       sid := fmt.Sprintf("20000000-0000-4000-8000-%012d", n)
+       f.exec(t, `INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at,platform)
+        VALUES($1,$2,$3,$4,now()+interval '1 day','android')`, sid, id(5), fmt.Sprint(n), digest(sid))
+       f.exec(t, `INSERT INTO pulse.client_network_observations(session_id,user_id,observed_ip,exit_ip,client_version,checked_at)
+        VALUES($1,$2,$3::inet,$3::inet,'0.2.124','2026-11-04T12:00:00Z')`, sid, id(5), fmt.Sprintf("8.8.4.%d", n))
+   }
+   type pageResult struct {
+       Items   []map[string]any `json:"items"`
+       Page    int              `json:"page"`
+       Size    int              `json:"size"`
+       HasMore bool             `json:"has_more"`
+   }
+   for _, tc := range []struct {
+       name, query, status string
+       page, size          int
+       want                []int
+   }{
+       {"first", "pageuser", "", 1, 3, []int{6, 7, 8}},
+       {"second", "pageuser", "", 2, 3, []int{1, 2, 3}},
+       {"last", "pageuser", "", 3, 3, []int{4, 5}},
+       {"empty", "pageuser", "", 4, 3, nil},
+       {"active", "pageuser", "active", 2, 2, []int{2, 5}},
+       {"frozen", "pageuser", "frozen", 2, 1, []int{3}},
+       {"deleted", "pageuser", "deleted", 2, 1, []int{4}},
+       {"phone", "+86123000005", "", 1, 50, []int{5}},
+       {"public id", strings.ToUpper(strings.ReplaceAll(id(5), "-", "")), "", 1, 50, []int{5}},
+       {"uuid", id(5), "", 1, 50, []int{5}},
+       {"legacy public id", "legacyPageFive", "", 1, 50, []int{5}},
+       {"legacy numeric id", "987654321", "", 1, 50, []int{5}},
+       {"registration ip", "8.8.8.8", "", 1, 50, []int{5}},
+       {"historical successful ip", "1.1.1.5", "", 1, 50, []int{5}},
+       {"failed ip excluded", "9.9.9.5", "", 1, 50, nil},
+       {"literal search wildcards", "%_", "", 1, 50, []int{2}},
+   } {
+       t.Run(tc.name, func(t *testing.T) {
+           query := url.Values{"q": {tc.query}, "status": {tc.status}, "page": {fmt.Sprint(tc.page)}, "size": {fmt.Sprint(tc.size)}}
+           var result pageResult
+           root.request(t, "GET", "/api/v2/admin/users?"+query.Encode(), nil, 200, &result)
+           if len(result.Items) != len(tc.want) || result.Page != tc.page || result.Size != tc.size || result.HasMore != (len(tc.want) == tc.size) {
+               t.Fatalf("page metadata or count changed: %+v, want %v", result, tc.want)
+           }
+           for i, n := range tc.want {
+               if result.Items[i]["id"] != id(n) {
+                   t.Fatalf("page order/filter changed at %d: %v, want %s", i, result.Items[i]["id"], id(n))
+               }
+               if _, exposed := result.Items[i]["password_hash"]; exposed {
+                   t.Fatal("page projection exposed password_hash")
+               }
+           }
+       })
+   }
+   var listed pageResult
+   root.request(t, "GET", "/api/v2/admin/users?q=pageuser05", nil, 200, &listed)
+   var detail map[string]any
+   root.request(t, "GET", "/api/v2/admin/users/"+id(5), nil, 200, &detail)
+   if len(listed.Items) != 1 || !reflect.DeepEqual(listed.Items[0], detail) {
+       t.Fatalf("page projection differs from user detail: %+v vs %+v", listed.Items, detail)
+   }
+   network, ok := detail["client_network"].(map[string]any)
+   if detail["last_login_ip"] != "7.7.7.6" || detail["last_login_client_version"] != "2.4.234" || !ok || network["observed_ip"] != "8.8.4.2" || network["platform"] != "android" {
+       t.Fatalf("latest records selected incorrectly: %+v", detail)
+   }
+   for _, query := range []string{"status=unknown", "page=0", "size=101"} {
+       root.request(t, "GET", "/api/v2/admin/users?"+query, nil, 400, nil)
+   }
+}
+
+func TestAdminUserPageBoundsLatestLookups(t *testing.T) {
+   f := newFixture(t)
+   f.exec(t, `INSERT INTO pulse.users(id,account,password_hash,created_at)
+    SELECT md5('page-plan-user-'||g)::uuid,'planuser'||g,$1,now()+make_interval(secs=>g)
+    FROM generate_series(1,512) g`, testPasswordHash)
+   f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason,created_at)
+    SELECT md5('page-plan-user-'||g)::uuid,'planuser'||g,'8.8.8.8','web','plan test',true,'ok',now()-make_interval(secs=>e)
+    FROM generate_series(1,512) g CROSS JOIN generate_series(1,8) e`)
+   f.exec(t, `INSERT INTO pulse.login_sessions(id,user_id,device_id,token_hash,expires_at,platform)
+    SELECT md5('page-plan-session-'||g)::uuid,md5('page-plan-user-'||g)::uuid,'plan test',
+    decode(repeat(md5('page-plan-token-'||g),2),'hex'),now()+interval '1 day','web' FROM generate_series(1,512) g`)
+   f.exec(t, `INSERT INTO pulse.client_network_observations(session_id,user_id,observed_ip)
+    SELECT md5('page-plan-session-'||g)::uuid,md5('page-plan-user-'||g)::uuid,'8.8.8.8' FROM generate_series(1,512) g`)
+   f.exec(t, "ANALYZE pulse.users; ANALYZE pulse.login_events; ANALYZE pulse.client_network_observations")
+   const size = 7
+   var raw []byte
+   if err := f.store.Pool.QueryRow(f.ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+adminUsersQuery(true), size, 14, "%%", "").Scan(&raw); err != nil {
+       t.Fatal(err)
+   }
+   type planNode struct {
+       Relation string     `json:"Relation Name"`
+       Loops    float64    `json:"Actual Loops"`
+       Rows     float64    `json:"Actual Rows"`
+       Plans    []planNode `json:"Plans"`
+   }
+   var plan []struct{ Plan planNode }
+   if err := json.Unmarshal(raw, &plan); err != nil || len(plan) != 1 || plan[0].Plan.Rows != size {
+       t.Fatalf("invalid plan or page size: %s / %v", raw, err)
+   }
+   lookups := map[string]float64{}
+   var walk func(planNode)
+   walk = func(node planNode) {
+       if node.Relation == "login_events" || node.Relation == "client_network_observations" {
+           lookups[node.Relation] += node.Loops
+       }
+       for _, child := range node.Plans {
+           walk(child)
+       }
+   }
+   walk(plan[0].Plan)
+   for _, relation := range []string{"login_events", "client_network_observations"} {
+       if lookups[relation] != size {
+           t.Errorf("%s enrichment must run only for the %d page users, got %.0f lookups", relation, size, lookups[relation])
+       }
+   }
+   t.Logf("actual page size %d; latest-record lookups: %v", size, lookups)
+}
+
+func TestAdminLatestSuccessfulLoginIndexMatchesOrder(t *testing.T) {
+   f := newFixture(t)
+   var valid, ready bool
+   var definition, predicate string
+   err := f.store.Pool.QueryRow(f.ctx, `SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid),pg_get_expr(i.indpred,i.indrelid)
+    FROM pg_index i WHERE i.indexrelid=to_regclass('pulse.login_events_user_latest_success')`).Scan(&valid, &ready, &definition, &predicate)
+   if err != nil || !valid || !ready || predicate != "success" || !strings.Contains(definition, "(user_id, created_at DESC, id DESC)") {
+       t.Fatalf("latest successful-login index missing or mismatched: %s, predicate=%q, valid=%v, ready=%v, error=%v", definition, predicate, valid, ready, err)
+   }
+}
diff --git a/server/internal/core/migrations/068_login_events_user_latest_success.sql b/server/internal/core/migrations/068_login_events_user_latest_success.sql
new file mode 100644
index 0000000..42a2296
--- /dev/null
+++ b/server/internal/core/migrations/068_login_events_user_latest_success.sql
@@ -0,0 +1,5 @@
+-- A deployment may build this index CONCURRENTLY before the transactional
+-- migration, avoiding a write-blocking index build on a large login history.
+CREATE INDEX IF NOT EXISTS login_events_user_latest_success
+    ON pulse.login_events (user_id, created_at DESC, id DESC)
+    WHERE success;
```

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

完整测试代码已包含在第 3 节 admin_user_page_test.go。新增三个主用例：

1. TestAdminUserPagePreservesFiltersAndLatestRows：16 个子用例覆盖三页、空页、active/frozen/deleted、手机号、公有 ID、UUID、旧 ID、注册 IP、历史成功登录 IP、排除失败 IP、字面通配字符。另核对列表与详情完整投影一致、最近登录时间/id 排序、最新网络观测及错误参数。
2. TestAdminUserPageBoundsLatestLookups：512 个额外用户，每人 8 次登录及一份网络观测；用生产查询获取偏移后的 7 人页面，实际数据库计划必须两类关联查询均只执行 7 次。
3. TestAdminLatestSuccessfulLoginIndexMatchesOrder：核对实际索引 valid/ready、过滤条件及字段排序。

首次测试中，夹具把 nickname 中的 `%_` 写成 `_%`，导致字面搜索用例额外失败；已修正夹具，原始失败日志保留。修正后的红测仅性能和缺失索引两个主用例失败，功能兼容检查通过。

```text
修复前（夹具修正后）
{"exit_code": 1, "pattern": "Test(AdminUserPagePreservesFiltersAndLatestRows|AdminUserPageBoundsLatestLookups|AdminLatestSuccessfulLoginIndexMatchesOrder)$", "failed_tests": ["TestAdminUserPageBoundsLatestLookups", "TestAdminLatestSuccessfulLoginIndexMatchesOrder"], "skipped_tests": [], "production_connected": false, "passed_tests": 17}
=== RUN   TestAdminUserPageBoundsLatestLookups
    admin_user_page_test.go:148: login_events enrichment must run only for the 7 page users, got 515 lookups
    admin_user_page_test.go:148: client_network_observations enrichment must run only for the 7 page users, got 515 lookups
    admin_user_page_test.go:151: actual page size 7; latest-record lookups: map[client_network_observations:515 login_events:515]
--- FAIL: TestAdminUserPageBoundsLatestLookups (0.35s)
=== RUN   TestAdminLatestSuccessfulLoginIndexMatchesOrder
    admin_user_page_test.go:161: latest successful-login index missing or mismatched: , predicate="", valid=false, ready=false, error=no rows in result set
--- FAIL: TestAdminLatestSuccessfulLoginIndexMatchesOrder (0.30s)

修复后定向回归
{"exit_code": 0, "pattern": "Test(AdminUserPagePreservesFiltersAndLatestRows|AdminUserPageBoundsLatestLookups|AdminLatestSuccessfulLoginIndexMatchesOrder|AdminUserIPPureLocationsStayBoundToUserAndAddress|AdminUserLocationsDoNotBorrowMissingOrFailedData|AdminRedesignFiltersAndScopedSelectors|ClientNetworkObservationIsSessionScopedAndAdvisory|ClientNetworkMeasurementPreservesZeroAndNormalizesIP)$", "failed_tests": [], "skipped_tests": [], "production_connected": false, "passed_tests": 24}
=== RUN   TestAdminUserPageBoundsLatestLookups
    admin_user_page_test.go:151: actual page size 7; latest-record lookups: map[client_network_observations:7 login_events:7]
--- PASS: TestAdminUserPageBoundsLatestLookups (0.35s)
=== RUN   TestAdminLatestSuccessfulLoginIndexMatchesOrder
--- PASS: TestAdminLatestSuccessfulLoginIndexMatchesOrder (0.29s)

后台范围回归
{"exit_code": 0, "pattern": "Test(Admin|ClientNetwork|AccountSearch|ContactManagement|OrdinaryContact|RegistrationIP|RegistrationInvalidCaptcha|TemporaryRateLimit)", "failed_tests": [], "skipped_tests": [], "production_connected": false, "passed_tests": 55}
=== RUN   TestAdminUserPageBoundsLatestLookups
    admin_user_page_test.go:151: actual page size 7; latest-record lookups: map[client_network_observations:7 login_events:7]
--- PASS: TestAdminUserPageBoundsLatestLookups (0.35s)
=== RUN   TestAdminLatestSuccessfulLoginIndexMatchesOrder
--- PASS: TestAdminLatestSuccessfulLoginIndexMatchesOrder (0.29s)
```

本轮最终后台范围检查 **55 项通过（含子测试）、0 失败、0 跳过**。初次定向绿测为 24 项，两者有重叠，不相加计算。原始逐行输出见 .local/backend-tests 对应时间目录。

编译/静态检查实际结果：

```text
Go vet ./...：exit_code=0，stdout/stderr 无输出
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"：exit_code=0，stdout/stderr 无输出
本次三个代码文件 git diff --cached --check：exit_code=0
```

根目录全面 diff 检查还显示原有 iOS、旧 PC/Web 改动的行尾空白；这些文件在本轮前后哈希一致，未作顺手修改。

执行计划同库对照：事务内 2,000 个额外用户、100,000 次登录、2,000 个会话和网络观测，返回 50 人；另有 3 个既有测试用户。

| 查询 | 登录/网络关联次数 | 登录每次返回记录数 | 时间（本次样本） | Shared hit blocks |
|---|---:|---:|---:|---:|
| 修复前（无新索引） | 2,003 / 2,003 | 50 | 83.796 ms | 218,875 |
| 先分页（无新索引） | 50 / 50 | 50 | 4.024 ms | 5,851 |
| 本次完整修复 | 50 / 50 | 1 | 2.676 ms | 839 |

耗时仅为本机样本，不作为生产 SLA；执行次数缩减和使用新索引已从真实计划确认。测试数据、临时删除/重建索引均 ROLLBACK，探针用户残留 0，测试库 schema 68、新索引有效。诊断脚本首次把 Actual Loops=0 的未执行搜索子计划纳入“必须执行 50 次”断言，脚本误报已修正；原始初次输出保留，不算作产品失败或通过。

## 5. 兼容性检查

- 账号切换：沿用后台原认证和权限中间件，查询参数及返回字段保持一致；普通用户访问限制、管理员视图和 IP 按用户隔离的后台范围回归通过。Android/PC 登录与存储代码没有本轮变更。
- 进程被杀后重启恢复：未改客户端待发队列、加密或持久化；本轮没有做手机进程恢复复测。后端新二进制要求先显式迁移至 schema 68，迁移的重复调用及已有索引路径已在隔离环境检查。
- 多会话并发：修复的是后台只读查询，未改变消息、登录和事务权限边界。新索引会增加成功登录的一份 B-tree 写入及磁盘占用，以换取最近登录读取成本下降；未在生产测量索引大小。
- PostgreSQL：MATERIALIZED CTE 适用于本项目现有生产 PostgreSQL 16，实际回归环境为本地 PostgreSQL 17.12。
- 发布：本轮只构建 Go Linux 二进制，未更新服务器或客户端安装包。服务器 SSH 凭据仍待提供。此前准备的 schema 67 发布包必须重新生成，不能当作已包含此修复。
- 索引发布：大登录表应先用独立连接在事务外 CREATE INDEX CONCURRENTLY，核验索引 valid/ready 及定义后，再用新二进制 migrate；068 中 IF NOT EXISTS 支持预建索引。直接在事务迁移中创建索引会占用表写锁，不能把它当作无锁发布。
- 回滚：schema 68 是新增索引迁移，不改业务行，但旧二进制有严格 schema 版本校验。迁移后仅换回 schema 67 二进制不能完成重启回滚，必须把迁移状态回退纳入发布方案。

## 6. 发现但未修改的问题清单（只列，不动）

1. 用户列表的全文包含匹配、历史成功 IP 搜索及 OFFSET 仍受筛选数据规模影响；本轮只消除分页前的附属字段查询放大，不更改检索语义或分页协议。
2. IPPure Web 真实跨域/网络验收仍有前轮记录的外部条件限制，不以模拟供应商的浏览器测试宣称已解决。
3. 既有 Android FCM 真实送达、历史损坏待发附件和真机滚动性能验收未在本轮处理。
4. 服务器发布仍等待有效 SSH 凭据；新迁移与旧二进制回滚边界需要带入下一次实际发布。
