# 归属地统一与用户管理修复 — 2026-11-27

## 1. 计划（先输出，等确认）

用户要求后台用户管理显示归属地，各端调用 IPPure `https://my.ippure.com/v1/info`，按 `country-region-city` 显示“国家-省-城市”。已先阅读根 AGENTS.md 并提交具体方案 `.local/ip-location-unified-plan.md`。该文件禁止修改 server/，因此先准备了限定方案；用户随后明确回复“允许本次归属地后端修复”，本次后端仅改 admin_operations.go 和新增对应测试。

该公开 API 查询调用者出口 IP，不能由管理员查询自己的地址后填给所有用户。[官方说明](https://ippure.com/MyIP-Info-API)。已有原生 PC、Android、iOS 调用该地址并把 `region` 存入现有 `province` 字段；不改协议、鉴权、持久化/AAD，也不新增依赖或数据库迁移。

先修统一显示和移动适配字段丢失，再补后台用户/IP 对应读取，最后补 Web 端调用与不可达降级。保留真实值，显示如 `中国-广东省-深圳市` 或 `United States-California-Los Angeles`；不翻译供应方值，不省略国家，不添加区县，不合并直辖市的省/市两个字段。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

### 各端显示口径与资料字段

根因：PC/Web 显示主动省略中国并拼入区县，Android/iOS 资料适配层丢掉了服务端已有的归属地字段。

- `client-shared/ip-location.mjs`：无状态三级格式函数，供 Web/PC Vue 与管理后台复用；`region` 与内部 `province` 映射相同，保留实际字段值，拒绝非法字段。
- `web-vue/src/features/contacts/ipLocation.ts`：会话头部和资料面板统一三级格式；缺 IP、查询失败、未知状态仍有区别。来源仍保留在既有 tooltip，离线库不标成 IPPure。
- `android/app/src/main/java/com/pulseim/android/GoV2Api.kt`、`IPLocationText.java`：从已获授权的 staff 资料响应取注册/最近登录详情，填回现有 UI 消费字段。新增 6 项纯 JVM 测试。
- `ios/PulseIM/GoV2Adapter.swift`：对应资料合约补齐相同字段，不修改 Xcode 工程、登录权限或新增页面。Windows 未能编译 iOS，也未宣称 iOS UI 验收。

### 后台用户管理不读取上报归属地

根因：用户列表投影缺少归属地详情，而旧批量查询只读取 IP 缓存，且前端让缓存文案优先覆盖用户专属数据。

- `server/internal/core/admin_operations.go`：为列表/详情投影增加注册和最近成功登录 IP 对应的结构化详情；优先读取 `(user_id, ip)` 的既有 IPPure 上报，再取 resolved 权威缓存。IPPure 关闭时使用既有缓存，不采用他人上报。只读查询不产生外部网络请求，不修改密码、分页过滤和权限。
- `admin/src/go-api.js`、`admin/src/features/users/ipLocation.ts`、`admin/src/views/UsersView.vue`：保留结构化字段，按“当前用户对应 IP 的详情 → 原用户文本 → 权威缓存 → 未识别”显示；不把失败缓存当有效地点。长地址可换行并保留完整悬浮文本。
- `server/internal/core/admin_user_location_test.go`：真实本地 PostgreSQL/Redis 验证同 IP 多用户、注册/登录不同 IP、最近失败登录不替代成功登录、关闭 IPPure、缺失记录、读写隔离和原权限。

### Web 未查询 IPPure

根因：Web 无原生 network 对象，原调用分支不会发起 IPPure 查询。

- `web-vue/src/platform/ippure.ts`：浏览器使用严格限定 HTTPS 端点的 CORS GET，4.5 秒预算、16 KiB 响应限制；不发送账号、token、Cookie 或 Referer，不使用 no-cors 或服务器自 IP 替代用户地址。
- `web-vue/src/composables/useChat.ts`：复用原能力开关和观察上报路径；Web 直接查询自己的出口，原生 PC 保留现有实现。失败仅不附带出口详情，登录/聊天流程和账号/生命周期校验保持原样。

## 3. 完整 diff

以下为本轮全部 19 个产品/测试文件的完整补丁，不包含原工作区已有的其他修改。最终报告另随 Web 修复提交。此任务同时涉及后台数据投影、四端适配和测试，不是 P0 的四个原始缺陷；测试占主要新增行数，没有整体重构。

```diff
diff --git a/admin/src/go-api.js b/admin/src/go-api.js
index f053b56..e43334b 100644
--- a/admin/src/go-api.js
+++ b/admin/src/go-api.js
@@ -97,0 +98,2 @@
+      register_ip_location:row.registration_ip_location || '',register_ip_location_detail:row.registration_ip_location_detail || null,
+      login_ip_location:row.last_login_ip_location || '',login_ip_location_detail:row.last_login_ip_location_detail || null,
@@ -525 +527 @@
-        return {ip,location:row?[row.country,row.province,row.city].filter(Boolean).join(' '):'暂未查到归属地',
+        return {...row,ip,location:row?[row.country,row.region||row.province,row.city].filter(Boolean).join('-'):'暂未查到归属地',
diff --git a/admin/src/views/UsersView.vue b/admin/src/views/UsersView.vue
index 1169f5b..c169437 100644
--- a/admin/src/views/UsersView.vue
+++ b/admin/src/views/UsersView.vue
@@ -27,0 +28 @@ import UserEditor from "../features/users/UserEditor.vue";
+import { userIPLocation } from "../features/users/ipLocation";
@@ -141 +142 @@ async function loadLocations() {
-        for (const row of result.items || []) locations[row.ip] = row.location;
+        for (const row of result.items || []) locations[row.ip] = row;
@@ -328,6 +329,2 @@ onBeforeUnmount(() => {
-        <p class="text-xs muted">
-          {{
-            ipLocations[row.register_ip] ||
-            row.register_ip_location ||
-            "暂未识别"
-          }}
+        <p class="text-xs muted user-ip-location" :title="userIPLocation(row, 'register', ipLocations)">
+          {{ userIPLocation(row, "register", ipLocations) }}
@@ -337,2 +334,2 @@ onBeforeUnmount(() => {
-        <p class="text-xs muted">
-          {{ ipLocations[row.login_ip] || row.login_ip_location || "暂未识别" }}
+        <p class="text-xs muted user-ip-location" :title="userIPLocation(row, 'login', ipLocations)">
+          {{ userIPLocation(row, "login", ipLocations) }}
@@ -418,0 +416,5 @@ onBeforeUnmount(() => {
+.user-ip-location {
+  white-space: normal;
+  overflow-wrap: anywhere;
+  line-height: 1.5;
+}
diff --git a/android/app/src/main/java/com/pulseim/android/GoV2Api.kt b/android/app/src/main/java/com/pulseim/android/GoV2Api.kt
index 6722fde..42dbcf0 100644
--- a/android/app/src/main/java/com/pulseim/android/GoV2Api.kt
+++ b/android/app/src/main/java/com/pulseim/android/GoV2Api.kt
@@ -39,0 +40,4 @@ internal class GoV2Api(private val base:String, private val token:()->String?,pr
+    private fun ipLocation(detail:JSONObject?,fallback:String):String = IPLocationText.format(
+        detail?.opt("country") as? String,
+        IPLocationText.clean(detail?.opt("region") as? String).ifEmpty { detail?.opt("province") as? String ?: "" },
+        detail?.opt("city") as? String,fallback)
@@ -519,0 +524,2 @@ internal class GoV2Api(private val base:String, private val token:()->String?,pr
+                    .put("register_ip_location",ipLocation(raw.optJSONObject("registration_ip_location_detail"),raw.optString("registration_ip_location")))
+                    .put("last_login_location",ipLocation(last.optJSONObject("location_detail"),last.optString("location")))
diff --git a/client-tests/ip-location-presentation.test.cjs b/client-tests/ip-location-presentation.test.cjs
index cc1b6ad..66599a5 100644
--- a/client-tests/ip-location-presentation.test.cjs
+++ b/client-tests/ip-location-presentation.test.cjs
@@ -6,0 +7 @@ const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/fea
+const shared = import('../client-shared/ip-location.mjs');
@@ -8 +9 @@ const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/fea
-test('chat and profile use actual province-city-district with explicit missing-data labels', async () => {
+test('chat and profile show country-region-city without omitting China or adding districts', async () => {
@@ -11,5 +12,5 @@ test('chat and profile use actual province-city-district with explicit missing-d
-  assert.equal(ipLocationText('8.8.8.8', '', 'reported', value), '广东省-深圳市-南山区');
-  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { ...value, district: '' }), '广东省-深圳市（区县未提供）');
-  assert.equal(ipLocationText('8.8.8.8', '', 'resolved', { country: '中国', province: '北京市', city: '北京市', district: '' }), '北京市（区县未提供）');
-  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { country: 'United States', province: 'California', city: 'Los Angeles', district: '' }), 'United States-California-Los Angeles（区县未提供）');
-  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { country: 'China' }), 'China（省市区未提供）');
+  assert.equal(ipLocationText('8.8.8.8', '', 'reported', value), '中国-广东省-深圳市');
+  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { ...value, district: '' }), '中国-广东省-深圳市');
+  assert.equal(ipLocationText('8.8.8.8', '', 'resolved', { country: '中国', province: '北京市', city: '北京市', district: '' }), '中国-北京市-北京市');
+  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { country: 'United States', province: 'California', city: 'Los Angeles', district: '' }), 'United States-California-Los Angeles');
+  assert.equal(ipLocationText('8.8.8.8', '', 'reported', { country: 'China' }), 'China');
@@ -18,0 +20,10 @@ test('chat and profile use actual province-city-district with explicit missing-d
+test('IPPure region and the stored province use the same format without fabricated fields', async () => {
+  const { countryRegionCity } = await shared;
+  assert.equal(countryRegionCity({ country: ' United States ', region: ' California ', city: 'Los Angeles', district: 'ignored' }), 'United States-California-Los Angeles');
+  assert.equal(countryRegionCity({ country: '中国', province: '北京市', city: '北京市' }), '中国-北京市-北京市');
+  assert.equal(countryRegionCity({ country: '中国', region: 'bad\u0000region', province: '广东省', city: 12 }), '中国-广东省');
+  assert.equal(countryRegionCity({ country: 'x'.repeat(129), province: false, city: '深圳市' }), '深圳市');
+  assert.equal(countryRegionCity({ district: '南山区' }), '');
+  assert.equal(countryRegionCity(null), '');
+});
+
diff --git a/ios/PulseIM/GoV2Adapter.swift b/ios/PulseIM/GoV2Adapter.swift
index 4684e7f..b9125bb 100644
--- a/ios/PulseIM/GoV2Adapter.swift
+++ b/ios/PulseIM/GoV2Adapter.swift
@@ -33,0 +34,13 @@ final class GoV2Adapter {
+    private func ipLocation(_ value: Any?, fallback: Any?) -> String {
+        let detail = value as? [String: Any] ?? [:]
+        func part(_ raw: Any?) -> String {
+            guard let value = raw as? String else { return "" }
+            let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
+            guard text.utf16.count <= 128, !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return "" }
+            return text
+        }
+        let region = part(detail["region"])
+        let text = [part(detail["country"]), region.isEmpty ? part(detail["province"]) : region, part(detail["city"])]
+            .filter { !$0.isEmpty }.joined(separator: "-")
+        return text.isEmpty ? (fallback as? String ?? "") : text
+    }
@@ -677,0 +691,2 @@ final class GoV2Adapter {
+                    "register_ip_location": ipLocation(raw["registration_ip_location_detail"], fallback: raw["registration_ip_location"]),
+                    "last_login_location": ipLocation(last["location_detail"], fallback: last["location"]),
diff --git a/server/internal/core/admin_operations.go b/server/internal/core/admin_operations.go
index 99cbb51..b4f0f6e 100644
--- a/server/internal/core/admin_operations.go
+++ b/server/internal/core/admin_operations.go
@@ -60,0 +61,19 @@ const adminUserProjection = `(to_jsonb(u)-'password_hash')||jsonb_build_object(
+// Scalar subqueries keep location reads in the paginated user projection. A
+// device report is scoped to its owner and exact IP, never a global IP cache.
+func adminUserLocationsProjection(ippure bool) string {
+	location := func(ip string) string {
+		reported := ""
+		if ippure {
+			reported = ` UNION ALL
+ SELECT p.country,p.province,p.city,p.district,'ippure',true,0
+ FROM pulse.client_reported_ip_locations p WHERE p.user_id=u.id AND p.ip=` + ip
+		}
+		return `(SELECT to_jsonb(location)-'priority' FROM (
+ SELECT p.country,p.province,p.city,''::text AS district,'cache'::text AS source,false AS reported,1 AS priority
+ FROM pulse.ip_locations p WHERE p.status='resolved' AND p.ip=` + ip + reported + `
+ ) location ORDER BY priority LIMIT 1)`
+	}
+	return `||jsonb_build_object('registration_ip_location_detail',` + location("u.registration_ip") +
+		`,'last_login_ip_location_detail',` + location("latest_login.ip::inet") + `)`
+}
+
@@ -161 +180 @@ func (a *API) registerAdminOperations(mux *http.ServeMux) {
-		return adminRows(w, r, s, `SELECT `+adminUserProjection+` FROM pulse.users u `+adminLatestLoginJoin+` WHERE(account ILIKE $3 OR nickname ILIKE $3 OR phone ILIKE $3 OR public_id ILIKE $3 OR legacy_public_id ILIKE $3 OR u.id::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.legacy_ids li WHERE li.entity='user' AND li.new_id=u.id AND li.legacy_id::text ILIKE $3) OR registration_ip::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.login_events l WHERE l.user_id=u.id AND l.success AND l.ip::text ILIKE $3)) AND($4='' OR($4='active' AND active AND deleted_at IS NULL)OR($4='frozen' AND NOT active AND deleted_at IS NULL)OR($4='deleted' AND deleted_at IS NOT NULL)) ORDER BY u.created_at DESC,u.id LIMIT $1 OFFSET $2`, q, status)
+		return adminRows(w, r, s, `SELECT `+adminUserProjection+adminUserLocationsProjection(s.IPPureEnabled)+` FROM pulse.users u `+adminLatestLoginJoin+` WHERE(account ILIKE $3 OR nickname ILIKE $3 OR phone ILIKE $3 OR public_id ILIKE $3 OR legacy_public_id ILIKE $3 OR u.id::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.legacy_ids li WHERE li.entity='user' AND li.new_id=u.id AND li.legacy_id::text ILIKE $3) OR registration_ip::text ILIKE $3 OR EXISTS(SELECT 1 FROM pulse.login_events l WHERE l.user_id=u.id AND l.success AND l.ip::text ILIKE $3)) AND($4='' OR($4='active' AND active AND deleted_at IS NULL)OR($4='frozen' AND NOT active AND deleted_at IS NULL)OR($4='deleted' AND deleted_at IS NOT NULL)) ORDER BY u.created_at DESC,u.id LIMIT $1 OFFSET $2`, q, status)
@@ -169 +188 @@ func (a *API) registerAdminOperations(mux *http.ServeMux) {
-		err := s.Store.Pool.QueryRow(r.Context(), `SELECT `+adminUserProjection+` FROM pulse.users u `+adminLatestLoginJoin+` WHERE u.id=$1`, id).Scan(&user)
+		err := s.Store.Pool.QueryRow(r.Context(), `SELECT `+adminUserProjection+adminUserLocationsProjection(s.IPPureEnabled)+` FROM pulse.users u `+adminLatestLoginJoin+` WHERE u.id=$1`, id).Scan(&user)
diff --git a/web-vue/src/composables/useChat.ts b/web-vue/src/composables/useChat.ts
index 8aefa80..19f72d5 100644
--- a/web-vue/src/composables/useChat.ts
+++ b/web-vue/src/composables/useChat.ts
@@ -10,0 +11 @@ import { useNotifications } from "./useNotifications";
+import { browserIPPureExit } from "../platform/ippure";
@@ -1039 +1040 @@ export function useChat(
-      if (network) {
+      if (network || platform.name === "web") {
@@ -1044 +1045,3 @@ export function useChat(
-          exit = await network.checkExit(token, capability.ippure_url).catch(() => null);
+          exit = network
+            ? await network.checkExit(token, capability.ippure_url).catch(() => null)
+            : await browserIPPureExit(capability.ippure_url, signal());
diff --git a/web-vue/src/features/contacts/ipLocation.ts b/web-vue/src/features/contacts/ipLocation.ts
index a30fdd2..13b60ae 100644
--- a/web-vue/src/features/contacts/ipLocation.ts
+++ b/web-vue/src/features/contacts/ipLocation.ts
@@ -1,0 +2 @@ import type { IPLocationDetail } from "../../api/types";
+import { countryRegionCity } from "../../../../client-shared/ip-location.mjs";
@@ -5,12 +6,2 @@ export function ipLocationText(ip?: string, fallback?: string, status?: string,
-  if (detail) {
-    const parts: string[] = [];
-    const country = detail.country?.trim() || "";
-    const local = [detail.province, detail.city, detail.district].map(value => value?.trim() || "");
-    if (country && (!local.some(Boolean) || !["中国", "中华人民共和国", "china", "cn"].includes(country.toLocaleLowerCase()))) parts.push(country);
-    for (const part of local) if (part && !parts.includes(part)) parts.push(part);
-    if (parts.length) {
-      const notes = [detail.source === "offline" ? "离线库" : "",
-        detail.district?.trim() ? "" : local[0] || local[1] ? "区县未提供" : "省市区未提供"].filter(Boolean);
-      return parts.join("-") + (notes.length ? `（${notes.join("，")}）` : "");
-    }
-  }
+  const text = countryRegionCity(detail);
+  if (text) return text;
diff --git a/web-vue/tests/ip-location.e2e.cjs b/web-vue/tests/ip-location.e2e.cjs
index 3555f07..4d50aa4 100644
--- a/web-vue/tests/ip-location.e2e.cjs
+++ b/web-vue/tests/ip-location.e2e.cjs
@@ -22,0 +23 @@ const checks = [], errors = [];
+const observations = [], providerRequests = [];
@@ -41,0 +43,7 @@ let server, browser, page;
+  await page.route('https://my.ippure.com/v1/info', async route => {
+    const headers = await route.request().allHeaders();
+    providerRequests.push({ authorization: headers.authorization, cookie: headers.cookie });
+    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': origin }, json: {
+      ip: '8.8.8.8', country: 'United States', region: 'California', city: 'Los Angeles', fraudScore: 0, isResidential: false, isBroadcast: false,
+    } });
+  });
@@ -51 +59,4 @@ let server, browser, page;
-    else if (p === '/client/network-observation') data = method === 'GET' ? { ippure_url: '' } : { recorded: true };
+    else if (p === '/client/network-observation') {
+      data = method === 'GET' ? { ippure_url: 'https://my.ippure.com/v1/info' } : { recorded: true };
+      if (method === 'POST') observations.push(request.postDataJSON());
+    }
@@ -73 +84,8 @@ let server, browser, page;
-    await network().getByText('IP：7.7.7.7 · 归属地：广东省-深圳市（区县未提供）', { exact: true }).waitFor();
+    await network().getByText('IP：7.7.7.7 · 归属地：中国-广东省-深圳市', { exact: true }).waitFor();
+    await waitFor(() => observations.length > 0);
+    assert.equal(providerRequests.length, 1);
+    assert.equal(providerRequests[0].authorization, undefined); assert.equal(providerRequests[0].cookie, undefined);
+    assert.deepEqual(observations[0].exit_location, { country: 'United States', province: 'California', city: 'Los Angeles', district: '' });
+    assert.equal(observations[0].exit_ip, '8.8.8.8');
+    assert.equal(observations[0].risk_score, 0);
+    pass('Web queries IPPure from the browser with CORS and reports country-region-city without leaking login credentials');
@@ -85,3 +103,3 @@ let server, browser, page;
-    await profile.locator('dd').getByText('广东省-深圳市（区县未提供）', { exact: true }).waitFor();
-    await profile.locator('dd').getByText('浙江省-杭州市-西湖区', { exact: true }).waitFor();
-    assert.match(await profile.locator('dd').filter({ hasText: '广东省-深圳市（区县未提供）' }).getAttribute('title'), /IPPure/);
+    await profile.locator('dd').getByText('中国-广东省-深圳市', { exact: true }).waitFor();
+    await profile.locator('dd').getByText('中国-浙江省-杭州市', { exact: true }).waitFor();
+    assert.match(await profile.locator('dd').filter({ hasText: '中国-广东省-深圳市' }).getAttribute('title'), /IPPure/);
@@ -135 +153 @@ let server, browser, page;
-    pass('personal details use the same formatting and keep login and registration addresses and districts separate');
+    pass('personal details use country-region-city consistently and keep login and registration addresses separate');
@@ -149 +167 @@ let server, browser, page;
-    assert.match(await network().innerText(), /9\.9\.9\.9.*江苏省-南京市-鼓楼区/);
+    assert.match(await network().innerText(), /9\.9\.9\.9.*中国-江苏省-南京市/);
@@ -201 +219 @@ let server, browser, page;
-    await network().getByText('IP：223.67.221.190 · 归属地：江苏省-连云港市（离线库，区县未提供）', { exact: true }).waitFor();
+    await network().getByText('IP：223.67.221.190 · 归属地：中国-江苏省-连云港市', { exact: true }).waitFor();
@@ -205,2 +223,2 @@ let server, browser, page;
-    await audit().getByText('江苏省-连云港市（离线库，区县未提供）', { exact: true }).waitFor();
-    await audit().getByText('Viet Nam-Hanoi（离线库，区县未提供）', { exact: true }).waitFor();
+    await audit().getByText('中国-江苏省-连云港市', { exact: true }).waitFor();
+    await audit().getByText('Viet Nam-Hanoi-Hanoi', { exact: true }).waitFor();
@@ -212 +230 @@ let server, browser, page;
-    await audit().getByText('江苏省-连云港市（离线库，区县未提供）', { exact: true }).waitFor();
+    await audit().getByText('中国-江苏省-连云港市', { exact: true }).waitFor();
@@ -219 +237 @@ let server, browser, page;
-    await network().getByText('IP：7.7.7.7 · 归属地：广东省-深圳市（区县未提供）', { exact: true }).waitFor();
+    await network().getByText('IP：7.7.7.7 · 归属地：中国-广东省-深圳市', { exact: true }).waitFor();
diff --git a/admin/src/features/users/ipLocation.ts b/admin/src/features/users/ipLocation.ts
new file mode 100644
--- /dev/null
+++ b/admin/src/features/users/ipLocation.ts
@@ -0,0 +1,17 @@
+import { countryRegionCity } from "../../../../client-shared/ip-location.mjs";
+import type { RecordData } from "../../domain/types";
+
+export function userIPLocation(row: RecordData, kind: "register" | "login", cache: RecordData = {}) {
+  const ip = row[`${kind}_ip`];
+  if (!ip) return "暂无记录";
+  // Per-user details must take precedence over the shared authoritative IP cache.
+  const detail = row[`${kind}_ip_location_detail`];
+  const text = countryRegionCity(detail);
+  if (text) return text;
+  if (row[`${kind}_ip_location`]) return row[`${kind}_ip_location`];
+  const cached = cache[ip];
+  if (cached?.status === "ready" || cached?.status === "resolved") {
+    return countryRegionCity(cached) || cached.location || "暂未识别";
+  }
+  return "暂未识别";
+}
diff --git a/admin/tests/user-location-fixture.ts b/admin/tests/user-location-fixture.ts
new file mode 100644
--- /dev/null
+++ b/admin/tests/user-location-fixture.ts
@@ -0,0 +1,11 @@
+import { createApp, h } from "vue";
+import ElementPlus from "element-plus";
+import "element-plus/dist/index.css";
+import "../src/styles/theme.css";
+import UsersView from "../src/views/UsersView.vue";
+import { useSession } from "../src/stores/session";
+
+sessionStorage.setItem("pulse.go.admin.entry", "a".repeat(64));
+await useSession().login("location_fixture", "LocationFixture888");
+createApp({ render: () => h("main", { style: "padding:20px" }, h(UsersView)) })
+  .use(ElementPlus).mount("#app");
diff --git a/admin/tests/user-location.e2e.cjs b/admin/tests/user-location.e2e.cjs
new file mode 100644
--- /dev/null
+++ b/admin/tests/user-location.e2e.cjs
@@ -0,0 +1,112 @@
+const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
+const { pathToFileURL } = require('node:url');
+const { chromium } = require(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
+const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
+const output = path.resolve(process.env.PULSE_ADMIN_LOCATION_OUTPUT || path.join(repo, '.local/admin-user-location-ui'));
+const checks = [], errors = [], requests = [];
+const uuid = n => String(n).padStart(8, '0') + '-2222-4222-8222-222222222222';
+const location = (country, province, city) => ({ country, province, city, source: 'ippure', reported: true });
+const user = (n, account, registration, login, registrationDetail, loginDetail) => ({
+  id: uuid(n), account, nickname: account, public_id: uuid(n).replaceAll('-', '').toUpperCase(),
+  active: true, created_at: '2026-11-27T00:00:00Z', registration_ip: registration,
+  last_login_ip: login, last_login_at: login ? '2026-11-27T01:00:00Z' : null,
+  registration_ip_location_detail: registrationDetail, last_login_ip_location_detail: loginDetail,
+});
+const alpha = user(1, 'alpha', '8.8.8.8', '7.7.7.7', location('中国', '浙江省', '杭州市'), location('United States', 'California', 'Los Angeles'));
+const beta = user(2, 'beta', '8.8.8.8', '7.7.7.7', location('中国', '广东省', '深圳市'), location('中国', '北京市', '北京市'));
+const cached = user(3, 'cache_only', '9.9.9.9', '9.9.9.9', null, null);
+const missing = user(4, 'missing', '1.1.1.1', '', null, null);
+const legacy = { ...user(5, 'old_backend', '4.4.4.4', '', null, null), registration_ip_location: '旧版归属地' };
+let server, browser, page, release, mode = '';
+const gate = new Promise(resolve => release = resolve);
+const pass = name => { checks.push(name); console.log('PASS ' + name); };
+
+(async () => {
+  fs.mkdirSync(output, { recursive: true });
+  const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);
+  const vue = (await import(pathToFileURL(path.join(root, 'node_modules/@vitejs/plugin-vue/dist/index.mjs')).href)).default;
+  const tailwind = (await import(pathToFileURL(path.join(root, 'node_modules/@tailwindcss/vite/dist/index.mjs')).href)).default;
+  const plugins = [vue(), tailwind(), { name: 'location-fixture', configureServer(vite) {
+    vite.middlewares.use('/__user-location-test', (_req, res) => {
+      res.setHeader('Content-Type', 'text/html; charset=utf-8');
+      res.end('<!doctype html><meta charset="UTF-8"><div id="app"></div><script type="module" src="/tests/user-location-fixture.ts"></script>');
+    });
+  } }];
+  if (process.env.PULSE_ADMIN_LOCATION_PREIMAGE) plugins.unshift({ name: 'original-user-view', enforce: 'pre', load(id) {
+    if (id.replaceAll('\\', '/').endsWith('/src/views/UsersView.vue')) return fs.readFileSync(process.env.PULSE_ADMIN_LOCATION_PREIMAGE, 'utf8');
+  } });
+  server = await createServer({ root, configFile: false, logLevel: 'error', cacheDir: path.join(output, 'vite-cache'), plugins,
+    server: { host: '127.0.0.1', port: 0, open: false }, optimizeDeps: { entries: ['tests/user-location-fixture.ts'] } });
+  await server.listen();
+  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
+  browser = await chromium.launch({ headless: true, channel: 'chrome' });
+  page = await browser.newPage({ viewport: { width: 1500, height: 950 } }); page.setDefaultTimeout(10000);
+  page.on('pageerror', error => errors.push(error.message));
+  await page.route('https://my.ippure.com/**', route => {
+    errors.push('Admin must not query its own exit IP for other users'); return route.abort();
+  });
+  await page.route('**/api/v2/**', async route => {
+    const req = route.request(), url = new URL(req.url()), endpoint = url.pathname.replace('/api/v2', '');
+    const headers = await req.allHeaders();
+    requests.push({ endpoint, method: req.method(), query: url.search, entry_header: headers['x-admin-entry'] === 'a'.repeat(64) });
+    const fulfill = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
+    if (endpoint === '/admin/auth/login') return fulfill({ user: { id: uuid(90), account: 'location_fixture', role: 'superadmin', permissions: [], active: true }, csrf_token: 'b'.repeat(64) });
+    if (endpoint === '/admin/users') {
+      mode = url.searchParams.get('q') || '';
+      return fulfill({ items: mode === 'held' ? [user(6, 'held_user', '5.5.5.5', '', null, null)] : mode === 'replacement' ? [alpha] : [alpha, beta, cached, missing, legacy], page: 1, size: 30, has_more: false });
+    }
+    if (endpoint === '/admin/ip-locations') {
+      if (url.searchParams.getAll('ip').includes('5.5.5.5')) await gate;
+      return fulfill({ items: url.searchParams.getAll('ip').map(ip => ({
+        ip, country: ip === '9.9.9.9' ? 'United Kingdom' : '错误缓存国家',
+        region: ip === '9.9.9.9' ? 'England' : '错误缓存省', city: ip === '9.9.9.9' ? 'London' : '错误缓存城市',
+        status: ip === '1.1.1.1' ? 'failed' : 'resolved',
+      })) });
+    }
+    return fulfill({ items: [] });
+  });
+  try {
+    await page.goto(origin + '/__user-location-test');
+    const row = name => page.locator('.el-table__body tr').filter({ hasText: name });
+    await row('alpha').getByText('中国-浙江省-杭州市', { exact: true }).waitFor();
+    await row('alpha').getByText('United States-California-Los Angeles', { exact: true }).waitFor();
+    await page.getByText('正在读取 IP 归属地…', { exact: true }).waitFor({ state: 'hidden' });
+    assert.doesNotMatch(await row('alpha').innerText(), /错误缓存/);
+    const longLocation = row('alpha').getByText('United States-California-Los Angeles', { exact: true });
+    assert.equal(await longLocation.getAttribute('title'), 'United States-California-Los Angeles');
+    assert.equal(await longLocation.evaluate(el => el.scrollWidth <= el.clientWidth), true);
+    pass('registration and latest-login details retain all three IPPure fields and override shared cache');
+    await row('beta').getByText('中国-广东省-深圳市', { exact: true }).waitFor();
+    await row('beta').getByText('中国-北京市-北京市', { exact: true }).waitFor();
+    assert.doesNotMatch(await row('beta').innerText(), /浙江|California/);
+    pass('two users with identical IPs retain their own locations');
+    assert.equal(await row('cache_only').getByText('United Kingdom-England-London', { exact: true }).count(), 2);
+    pass('old clients without reports retain authoritative cache formatted as country-region-city');
+    await row('missing').getByText('暂未识别', { exact: true }).waitFor();
+    await row('missing').getByText('暂无记录', { exact: true }).waitFor();
+    assert.doesNotMatch(await row('missing').innerText(), /错误缓存/);
+    await row('old_backend').getByText('旧版归属地', { exact: true }).waitFor();
+    pass('failed lookups and missing IPs remain distinct, and legacy per-user text has priority');
+    await page.screenshot({ path: path.join(output, 'user-locations.png') });
+    const input = page.locator('.filters input').first();
+    await input.fill('held'); await page.getByRole('button', { name: '查询', exact: true }).click();
+    await row('held_user').waitFor();
+    await input.fill('replacement'); await page.getByRole('button', { name: '查询', exact: true }).click();
+    await row('alpha').getByText('中国-浙江省-杭州市', { exact: true }).waitFor();
+    release();
+    await page.getByText('正在读取 IP 归属地…', { exact: true }).waitFor({ state: 'hidden' });
+    assert.equal(await row('held_user').count(), 0);
+    assert.doesNotMatch(await row('alpha').innerText(), /错误缓存/);
+    pass('replaced user queries and late IP lookups cannot overwrite current per-user details');
+    assert.ok(requests.filter(item => item.endpoint.startsWith('/admin/')).every(item => item.entry_header));
+    assert.ok(requests.filter(item => item.endpoint !== '/admin/auth/login').every(item => item.method === 'GET'));
+    assert.deepEqual(errors, []);
+    pass('location reads retain admin authorization and never look up the administrator as another user');
+    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed: checks.length, checks, errors, requests, production_connected: false }, null, 2));
+    console.log(JSON.stringify({ passed: checks.length, output }));
+  } catch (error) {
+    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
+    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors, requests }, null, 2));
+    throw error;
+  } finally { release(); await browser?.close(); await server?.close(); }
+})().catch(error => { console.error(error.stack); process.exitCode = 1; });
diff --git a/android/app/src/main/java/com/pulseim/android/IPLocationText.java b/android/app/src/main/java/com/pulseim/android/IPLocationText.java
new file mode 100644
--- /dev/null
+++ b/android/app/src/main/java/com/pulseim/android/IPLocationText.java
@@ -0,0 +1,28 @@
+package com.pulseim.android;
+
+/** Pure display logic shared by registration and latest-login profile fields. */
+final class IPLocationText {
+    private IPLocationText() {}
+
+    static String format(String country, String region, String city, String fallback) {
+        StringBuilder text = new StringBuilder();
+        for (String value : new String[] { country, region, city }) {
+            String part = clean(value);
+            if (part.isEmpty()) continue;
+            if (text.length() > 0) text.append('-');
+            text.append(part);
+        }
+        return text.length() > 0 ? text.toString() : fallback == null ? "" : fallback;
+    }
+
+    static String clean(String value) {
+        if (value == null) return "";
+        String text = value.trim();
+        if (text.length() > 128) return "";
+        for (int i = 0; i < text.length(); i++) {
+            char ch = text.charAt(i);
+            if (ch < 32 || ch == 127) return "";
+        }
+        return text;
+    }
+}
diff --git a/android/app/src/test/java/com/pulseim/android/IPLocationTextTest.java b/android/app/src/test/java/com/pulseim/android/IPLocationTextTest.java
new file mode 100644
--- /dev/null
+++ b/android/app/src/test/java/com/pulseim/android/IPLocationTextTest.java
@@ -0,0 +1,30 @@
+package com.pulseim.android;
+
+import org.junit.Test;
+import static org.junit.Assert.assertEquals;
+
+public class IPLocationTextTest {
+    @Test public void keepsAllThreeProviderFields() {
+        assertEquals("United States-California-Los Angeles", IPLocationText.format("United States", "California", "Los Angeles", "old"));
+        assertEquals("中国-广东省-深圳市", IPLocationText.format("中国", "广东省", "深圳市", ""));
+    }
+    @Test public void municipalityDoesNotLoseACorrespondingField() {
+        assertEquals("中国-北京市-北京市", IPLocationText.format("中国", "北京市", "北京市", ""));
+    }
+    @Test public void partialProviderDataIsNotInvented() {
+        assertEquals("China-深圳市", IPLocationText.format(" China ", null, " 深圳市 ", "old"));
+        assertEquals("China", IPLocationText.format("China", "", "", "old"));
+    }
+    @Test public void missingDetailsRetainOldBackendText() {
+        assertEquals("旧版归属地", IPLocationText.format(null, null, null, "旧版归属地"));
+        assertEquals("", IPLocationText.format("", " ", null, null));
+    }
+    @Test public void invalidComponentsAreRejected() {
+        assertEquals("中国", IPLocationText.format("中国", "bad\u0000region", "x".repeat(129), "old"));
+    }
+    @Test public void separateAccountsAndAddressesShareNoState() {
+        assertEquals("中国-浙江省-杭州市", IPLocationText.format("中国", "浙江省", "杭州市", ""));
+        assertEquals("United States-California-Los Angeles", IPLocationText.format("United States", "California", "Los Angeles", ""));
+        assertEquals("", IPLocationText.format(null, null, null, ""));
+    }
+}
diff --git a/client-shared/ip-location.d.mts b/client-shared/ip-location.d.mts
new file mode 100644
--- /dev/null
+++ b/client-shared/ip-location.d.mts
@@ -0,0 +1 @@
+export function countryRegionCity(detail?: unknown): string;
diff --git a/client-shared/ip-location.mjs b/client-shared/ip-location.mjs
new file mode 100644
--- /dev/null
+++ b/client-shared/ip-location.mjs
@@ -0,0 +1,12 @@
+function part(value) {
+  if (typeof value !== "string") return "";
+  const text = value.trim();
+  return text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
+}
+
+// IPPure calls the second field region; the existing API stores it as province.
+export function countryRegionCity(detail) {
+  if (!detail || typeof detail !== "object") return "";
+  return [part(detail.country), part(detail.region) || part(detail.province), part(detail.city)]
+    .filter(Boolean).join("-");
+}
diff --git a/client-tests/ippure-browser.test.cjs b/client-tests/ippure-browser.test.cjs
new file mode 100644
--- /dev/null
+++ b/client-tests/ippure-browser.test.cjs
@@ -0,0 +1,58 @@
+const { test } = require('node:test');
+const assert = require('node:assert/strict');
+const { pathToFileURL } = require('node:url');
+const path = require('node:path');
+const helpers = import(pathToFileURL(path.resolve(__dirname, '../web-vue/src/platform/ippure.ts')).href);
+const endpoint = 'https://my.ippure.com/v1/info';
+const input = () => ({ ip: '8.8.8.8', country: 'United States', region: 'California', city: 'Los Angeles', fraudScore: 0, isResidential: false, isBroadcast: false });
+const signal = () => new AbortController().signal;
+
+test('browser maps actual country-region-city to the existing observation without credentials', async () => {
+  const { browserIPPureExit } = await helpers;
+  let called = 0;
+  const result = await browserIPPureExit(endpoint, signal(), async (url, options) => {
+    called++;
+    assert.equal(url, endpoint); assert.equal(options.mode, 'cors'); assert.equal(options.credentials, 'omit');
+    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.redirect, 'error');
+    assert.equal(options.headers, undefined); assert.equal(options.body, undefined);
+    return Response.json(input());
+  });
+  assert.equal(called, 1);
+  assert.deepEqual(result, { exit_ip: '8.8.8.8', risk_score: 0, is_residential: false, is_broadcast: false,
+    exit_location: { country: 'United States', province: 'California', city: 'Los Angeles', district: '' } });
+});
+test('browser only contacts the exact approved HTTPS self-IP endpoint', async () => {
+  const { browserIPPureExit } = await helpers;
+  for (const url of ['http://my.ippure.com/v1/info', endpoint + '?ip=7.7.7.7', endpoint + '#fragment', 'https://example.invalid/v1/info']) {
+    assert.equal(await browserIPPureExit(url, signal(), () => { throw Error('must not fetch'); }), null);
+  }
+});
+test('CORS, network errors, invalid JSON and HTTP failures do not invent an exit IP', async () => {
+  const { browserIPPureExit } = await helpers;
+  for (const fetcher of [async () => { throw new TypeError('Failed to fetch'); }, async () => new Response('denied', { status: 403 }), async () => new Response('not json')]) {
+    assert.equal(await browserIPPureExit(endpoint, signal(), fetcher), null);
+  }
+});
+test('malformed provider fields stay absent while valid actual fields are retained', async () => {
+  const { browserIPPureExit } = await helpers;
+  const value = { ...input(), country: 3, region: 'bad\u0000region', city: ' Shenzhen ', fraudScore: '0', isResidential: 1, isBroadcast: 'false' };
+  assert.deepEqual(await browserIPPureExit(endpoint, signal(), async () => Response.json(value)), {
+    exit_ip: '8.8.8.8', risk_score: null, is_residential: null, is_broadcast: null,
+    exit_location: { country: '', province: '', city: 'Shenzhen', district: '' },
+  });
+  for (const ip of ['', 'not-an-ip', '999.1.1.1', '8.8.8.8/path']) {
+    assert.equal(await browserIPPureExit(endpoint, signal(), async () => Response.json({ ...input(), ip })), null);
+  }
+});
+test('large responses are cancelled before parsing beyond the existing 16 KiB limit', async () => {
+  const { browserIPPureExit } = await helpers;
+  let cancelled = false;
+  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } }));
+  assert.equal(await browserIPPureExit(endpoint, signal(), async () => response), null);
+  assert.equal(cancelled, true);
+});
+test('cancelled account work never performs a provider request', async () => {
+  const { browserIPPureExit } = await helpers;
+  const controller = new AbortController(); controller.abort();
+  assert.equal(await browserIPPureExit(endpoint, controller.signal, () => { throw Error('stale account fetch'); }), null);
+});
diff --git a/server/internal/core/admin_user_location_test.go b/server/internal/core/admin_user_location_test.go
new file mode 100644
--- /dev/null
+++ b/server/internal/core/admin_user_location_test.go
@@ -0,0 +1,89 @@
+package core
+
+import (
+	"encoding/json"
+	"testing"
+)
+
+type adminLocationUser struct {
+	ID           string `json:"id"`
+	Registration *struct {
+		Country, Province, City, Source string
+		Reported                        bool
+	} `json:"registration_ip_location_detail"`
+	Login *struct {
+		Country, Province, City, Source string
+		Reported                        bool
+	} `json:"last_login_ip_location_detail"`
+}
+
+func TestAdminUserIPPureLocationsStayBoundToUserAndAddress(t *testing.T) {
+	f := newFixture(t)
+	root := newAdmin(t, f)
+	f.service.IPPureEnabled = true
+	f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8' WHERE id IN($1,$2)", f.bob.UserID, f.carol.UserID)
+	f.exec(t, `INSERT INTO pulse.login_events(user_id,account,ip,platform,device_name,success,reason) VALUES
+	 ($1,'bob01','7.7.7.7','android','test',true,'ok'),($2,'carol01','7.7.7.7','web','test',true,'ok'),
+	 ($1,'bob01','9.9.9.9','android','test',false,'denied')`, f.bob.UserID, f.carol.UserID)
+	f.exec(t, `INSERT INTO pulse.client_reported_ip_locations(user_id,ip,country,province,city) VALUES
+	 ($1,'8.8.8.8','中国','浙江省','杭州市'),($1,'7.7.7.7','中国','广东省','深圳市'),
+	 ($1,'9.9.9.9','错误 IP','错误省','错误市'),($2,'7.7.7.7','United States','California','Los Angeles')`, f.bob.UserID, f.carol.UserID)
+	f.exec(t, `INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES
+	 ('8.8.8.8','中国','江苏省','南京市','resolved'),('7.7.7.7','中国','山东省','济南市','resolved')`)
+	var page struct {
+		Items []adminLocationUser `json:"items"`
+	}
+	root.request(t, "GET", "/api/v2/admin/users?size=2&q=bob01", nil, 200, &page)
+	if len(page.Items) != 1 || page.Items[0].ID != f.bob.UserID {
+		t.Fatalf("filtered user pagination changed: %+v", page)
+	}
+	checkBob := func(row adminLocationUser) {
+		t.Helper()
+		if row.Registration == nil || row.Registration.Country != "中国" || row.Registration.Province != "浙江省" || row.Registration.City != "杭州市" || row.Registration.Source != "ippure" || !row.Registration.Reported {
+			t.Fatalf("registration IPPure result missing or mixed: %+v", row.Registration)
+		}
+		if row.Login == nil || row.Login.Province != "广东省" || row.Login.City != "深圳市" || row.Login.Source != "ippure" || !row.Login.Reported {
+			t.Fatalf("latest successful login location mixed IPs or users: %+v", row.Login)
+		}
+	}
+	checkBob(page.Items[0])
+	var detail adminLocationUser
+	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &detail)
+	checkBob(detail)
+	root.request(t, "GET", "/api/v2/admin/users/"+f.carol.UserID, nil, 200, &detail)
+	if detail.Login == nil || detail.Login.Country != "United States" || detail.Login.City != "Los Angeles" || detail.Registration == nil || detail.Registration.Source != "cache" || detail.Registration.Province != "江苏省" {
+		t.Fatalf("same-IP users borrowed each other's reported locations: %+v", detail)
+	}
+	f.service.IPPureEnabled = false
+	root.request(t, "GET", "/api/v2/admin/users/"+f.bob.UserID, nil, 200, &detail)
+	if detail.Registration == nil || detail.Registration.Source != "cache" || detail.Registration.Reported || detail.Login == nil || detail.Login.City != "济南市" || detail.Login.Source != "cache" {
+		t.Fatalf("disabled IPPure did not retain authoritative cache fallback: %+v", detail)
+	}
+	var sourceCount int
+	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.ip_locations").Scan(&sourceCount); err != nil || sourceCount != 2 {
+		t.Fatalf("read-only user management wrote location data: %d %v", sourceCount, err)
+	}
+}
+
+func TestAdminUserLocationsDoNotBorrowMissingOrFailedData(t *testing.T) {
+	f := newFixture(t)
+	root := newAdmin(t, f)
+	f.service.IPPureEnabled = true
+	f.exec(t, "UPDATE pulse.users SET registration_ip='8.8.8.8' WHERE id=$1", f.bob.UserID)
+	f.exec(t, "UPDATE pulse.login_events SET ip=NULL WHERE user_id=$1", f.bob.UserID)
+	f.exec(t, "INSERT INTO pulse.client_reported_ip_locations(user_id,ip,city) VALUES($1,'8.8.8.8','别人的城市'),($2,'9.9.9.9','别的 IP')", f.carol.UserID, f.bob.UserID)
+	f.exec(t, "INSERT INTO pulse.ip_locations(ip,country,province,city,status) VALUES('8.8.8.8','旧国家','旧省','旧城市','failed')")
+	var row map[string]json.RawMessage
+	path := "/api/v2/admin/users/" + f.bob.UserID
+	root.request(t, "GET", path, nil, 200, &row)
+	for _, field := range []string{"registration_ip_location_detail", "last_login_ip_location_detail"} {
+		if string(row[field]) != "null" {
+			t.Fatalf("missing location fabricated %s: %s", field, row[field])
+		}
+	}
+	if _, exposed := row["password_hash"]; exposed {
+		t.Fatal("user projection exposed a password hash")
+	}
+	f.request(t, "GET", path, f.bob.Token, nil, 401, nil)
+	f.request(t, "GET", "/api/v2/admin/users", f.bob.Token, nil, 401, nil)
+}
diff --git a/web-vue/src/platform/ippure.ts b/web-vue/src/platform/ippure.ts
new file mode 100644
--- /dev/null
+++ b/web-vue/src/platform/ippure.ts
@@ -0,0 +1,50 @@
+import type { DesktopClientExit } from "./contracts";
+
+const endpoint = "https://my.ippure.com/v1/info";
+function part(value: unknown) {
+  if (typeof value !== "string") return "";
+  const text = value.trim();
+  return text.length <= 128 && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
+}
+function validIP(value: unknown): value is string {
+  if (typeof value !== "string" || value.length > 45) return false;
+  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return value.split(".").every(n => Number(n) <= 255);
+  if (!/^[\da-f:]+$/i.test(value) || !value.includes(":")) return false;
+  try { return new URL(`http://[${value}]/`).hostname.startsWith("["); } catch { return false; }
+}
+
+// This self-IP endpoint must be queried by the user's browser. Cross-origin
+// failure is advisory: never substitute a server/administrator IP or use no-cors.
+export async function browserIPPureExit(provider: string, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<DesktopClientExit | null> {
+  if (provider !== endpoint || signal.aborted) return null;
+  try {
+    const response = await fetcher(endpoint, {
+      method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
+      redirect: "error", referrerPolicy: "no-referrer",
+      signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]),
+    });
+    if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
+    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
+    let bytes = 0, text = "";
+    try {
+      for (;;) {
+        const { value, done } = await reader.read();
+        if (done) break;
+        bytes += value.byteLength;
+        if (bytes > 16384) { await reader.cancel(); return null; }
+        text += decoder.decode(value, { stream: true });
+      }
+      text += decoder.decode();
+    } finally { reader.releaseLock(); }
+    const value = JSON.parse(text);
+    if (!value || Array.isArray(value) || typeof value !== "object" || !validIP(value.ip) || signal.aborted) return null;
+    const location = { country: part(value.country), province: part(value.region), city: part(value.city), district: part(value.district) };
+    return {
+      exit_ip: value.ip,
+      risk_score: Number.isInteger(value.fraudScore) && value.fraudScore >= 0 && value.fraudScore <= 100 ? value.fraudScore : null,
+      is_residential: typeof value.isResidential === "boolean" ? value.isResidential : null,
+      is_broadcast: typeof value.isBroadcast === "boolean" ? value.isBroadcast : null,
+      ...(Object.values(location).some(Boolean) ? { exit_location: location } : {}),
+    };
+  } catch { return null; }
+}

```

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

测试代码完整包含在上方 diff：Android `IPLocationTextTest.java`、Go `admin_user_location_test.go`、Node 两个 location 测试文件、真实 Vue 管理后台/聊天页面测试。所有网络/数据库夹具均隔离，未使用真实用户或代发聊天消息。

红灯先行：格式测试原输出为 actual `广东省-深圳市-南山区`、expected `中国-广东省-深圳市`，3 项中 1 项失败。后台新增 2 项在修改投影前实际失败，证据见 `.local/ip-location-unified-20261127-041803/backend-red.jsonl`。

```text
=== RUN   TestAdminUserIPPureLocationsStayBoundToUserAndAddress
    admin_user_location_test.go:49: registration IPPure result missing or mixed: <nil>
--- FAIL: TestAdminUserIPPureLocationsStayBoundToUserAndAddress (0.46s)
=== RUN   TestAdminUserLocationsDoNotBorrowMissingOrFailedData
    admin_user_location_test.go:81: missing location fabricated registration_ip_location_detail: null
--- FAIL: TestAdminUserLocationsDoNotBorrowMissingOrFailedData (0.39s)
```

一次筛选命令漏选新增两项，只执行了既有 15 项；核对结果清单后修正正则，最终 17 项包含两项新增，全部通过，SKIP=0。不把漏选轮次当作新增回归通过。Web UI 首轮有一条旧区县断言未同步，修正为本轮三级格式后最终通过 19 项；失败未作为产品修复效果。

最终后台命令：

```powershell
python scripts/backend_local_env.py test --run "^(TestAdminUser(IPPureLocations|LocationsDoNot).*|TestStaff.*Location.*|TestIPPureLocation.*|TestIPLocation.*|TestClientNetwork.*|TestProfileOffline.*)$"
```

结果文件原始内容：

```json
{
  "exit_code": 0,
  "pattern": "^(TestAdminUser(IPPureLocations|LocationsDoNot).*|TestStaff.*Location.*|TestIPPureLocation.*|TestIPLocation.*|TestClientNetwork.*|TestProfileOffline.*)$",
  "postgres_version": "17.12",
  "redis_implementation": "Memurai for Redis 8 Developer 8.2.1",
  "ffprobe_configured": true,
  "passed_tests": [
    "TestIPLocationBatchValidatesFirstAndPreservesResolvedCache",
    "TestAdminUserIPPureLocationsStayBoundToUserAndAddress",
    "TestAdminUserLocationsDoNotBorrowMissingOrFailedData",
    "TestClientNetworkObservationIsSessionScopedAndAdvisory",
    "TestClientNetworkMeasurementPreservesZeroAndNormalizesIP",
    "TestIPLocationRetiredOrSelfOnlyProviderIsDisabled",
    "TestIPLocationResponseValidation",
    "TestIPLocationHTTPBoundaries",
    "TestStaffOfflineLocationFillsLegacyWebAndRegistration",
    "TestStaffOfflineLocationYieldsToLaterIPPureReport",
    "TestProfileOfflineLocationPreservesExistingDataAndMissingIPs",
    "TestStaffIPPureLocationsStayBoundToUserAndActualIP",
    "TestIPPureLocationRejectsMismatchesAndLimitsWrites",
    "TestIPPureLocationValidationAndOldClientCompatibility",
    "TestIPPureLocationCleanupFollowsConfiguredRetention",
    "TestStaffProfileLocationUsesAuthorizedCachedLoginAndRegistrationData",
    "TestStaffProfileLocationDoesNotStartExternalLookups"
  ],
  "failed_tests": [],
  "skipped_tests": [],
  "production_connected": false,
  "log": "E:\\多窗口项目\\IM开发\\go-rewrite\\.local\\backend-tests\\20261127-043416\\go-tests.jsonl"
}
```

Node 字段/浏览器边界原始输出：

```text
✔ chat and profile show country-region-city without omitting China or adding districts (0.6525ms)
✔ IPPure region and the stored province use the same format without fabricated fields (0.1126ms)
✔ missing IPs, missing historical data, failures and old backends remain distinct (0.0712ms)
✔ the adapter preserves distinct login and registration location detail from the authorized staff endpoint (16.3176ms)
✔ browser maps actual country-region-city to the existing observation without credentials (14.9537ms)
✔ browser only contacts the exact approved HTTPS self-IP endpoint (0.1177ms)
✔ CORS, network errors, invalid JSON and HTTP failures do not invent an exit IP (0.5165ms)
✔ malformed provider fields stay absent while valid actual fields are retained (0.7759ms)
✔ large responses are cancelled before parsing beyond the existing 16 KiB limit (0.5376ms)
✔ cancelled account work never performs a provider request (0.0923ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 100.8232

```

后台真实 Vue 页面原始输出：

```text
PASS registration and latest-login details retain all three IPPure fields and override shared cache
PASS two users with identical IPs retain their own locations
PASS old clients without reports retain authoritative cache formatted as country-region-city
PASS failed lookups and missing IPs remain distinct, and legacy per-user text has priority
PASS replaced user queries and late IP lookups cannot overwrite current per-user details
PASS location reads retain admin authorization and never look up the administrator as another user
{"passed":6,"output":"E:\\多窗口项目\\IM开发\\go-rewrite\\.local\\ip-location-unified-20261127-041803\\admin-ui-final"}

```

后台传输回归原始输出：

```text

> pulse-admin@3.0.0 test:transport
> node --test transport-tests/*.test.cjs

✔ dashboard shares statistics and health once per load and refresh remains fresh (19.1581ms)
✔ dashboard propagates expired credentials and discards another login response (2.8754ms)
✔ concurrent media views share one download and every object URL is released on logout (3.0068ms)
✔ canceling one media view leaves the other consumer and its URL alive (1.0187ms)
✔ last consumer cancellation aborts the download and a retry starts a fresh flight (1.8144ms)
✔ completed media uses bounded LRU storage without revoking active playback (1.9829ms)
✔ media larger than idle budget is retained only while in use; over-limit response is canceled (1.306ms)
✔ logout during download cannot install old media in a new session cache (1.0226ms)
✔ failed health does not hide otherwise successful statistics and regions (0.8976ms)
✔ password read uses a dedicated POST and never populates user data or browser storage (18.5616ms)
✔ a late password response is rejected after logout or account replacement (1.0055ms)
✔ record list retains the long user ID separately from its internal numeric reference (17.9611ms)
✔ record detail and review keep the original record UUID while displaying the long user ID (1.1923ms)
✔ an older backend without the display field derives the same long ID from the raw UUID (1.0069ms)
✔ record queries and downloads preserve every digit of numeric-only long IDs (1.6391ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 74.8944

```

PC/Web 实际 Vue 页面结果文件中的检查条目（19 项，errors=[]，使用允许 CORS 的隔离 IPPure 响应）：

```json
{
  "checks": [
    "Web queries IPPure from the browser with CORS and reports country-region-city without leaking login credentials",
    "the authorized direct-chat header displays the latest login IP and actual IPPure province/city without inventing a district",
    "clicking the direct-chat header avatar opens that peer profile through the existing private-profile permission path without creating a chat",
    "the profile follows the reference order, places actual presence beside the name, expands staff details and keeps a full-width primary footer",
    "account, public ID, registration IP and login IP copy the exact respective values without touching the operating-system clipboard in tests",
    "the avatar supports keyboard Enter, restores focus when the profile closes and is disabled while the app is locked",
    "the profile respects offline and hidden-presence states and removes all staff fields and IP copy actions immediately on lock or role revocation",
    "personal details use country-region-city consistently and keep login and registration addresses separate",
    "after switching conversations the keyboard Space action opens the new peer profile and never reuses the previous user or a group/card context",
    "a delayed lookup from the previous conversation cannot replace the current user IP or location",
    "locking the application or revoking internal-staff status clears the displayed IP immediately",
    "ordinary users neither see IP audit data nor request the staff endpoint",
    "a denied staff lookup stays hidden without falling back to public profile discovery",
    "IP and location remain readable or truncated with a full tooltip in the minimum PC window without horizontal overflow",
    "long names, IDs, devices and district strings wrap inside the minimum PC window while the primary action remains fixed and reachable",
    "the relocated primary action still opens the correct direct conversation and closes the profile",
    "legacy Web and historical registration addresses display offline province/city consistently in the actual header and profile, with visible source and no invented district",
    "an absent registration address stays absent and is never copied from the known login IP",
    "later IPPure data replaces the fallback in the conversation view without retaining an offline source label"
  ],
  "errors": []
}
```

Android 实际命令：

```powershell
./gradlew.bat --offline --no-daemon --console=plain --max-workers=2 "-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=GBK" -I ../.local/android-p1-20261125-223727/repositories.init.gradle :app:testDebugUnitTest :app:assembleDebug :app:compileDebugAndroidTestKotlin
```

原始终端末尾：

```text
> Task :app:testDebugUnitTest
> Task :app:assembleDebug
> Task :app:compileDebugAndroidTestKotlin

BUILD SUCCESSFUL in 1m 7s
53 actionable tasks: 32 executed, 21 up-to-date
```

JUnit XML 汇总为 {"tests": 285, "failures": 0, "errors": 0, "skipped": 0}，原始 XML 已保存在本轮验证目录的 android-test-results/。构建沿用工作区版本，仅用于编译验证，没有递增或发布新的 Android 安装包。

后台生产前端原始输出末尾：

```text
dist/assets/RecordsView-D5tZib_M.js          11.69 kB │ gzip:  4.41 kB
dist/assets/css-DoS93aZs.js                  12.14 kB │ gzip:  5.04 kB
dist/assets/ImageUpload-DAau3DFO.js          13.58 kB │ gzip:  4.94 kB
dist/assets/DispatchView-gvTIVgB6.js         17.87 kB │ gzip:  6.60 kB
dist/assets/useAction-C1EgzsgC.js            22.18 kB │ gzip:  8.34 kB
dist/assets/UsersView-C-9crsQ7.js            26.21 kB │ gzip:  9.95 kB
dist/assets/PageHeader-DiIszpF_.js           40.37 kB │ gzip: 14.17 kB
dist/assets/theme-J76WBc8O.js                81.96 kB │ gzip: 32.07 kB
dist/assets/TablePagination-NRwWDGbL.js      97.58 kB │ gzip: 32.68 kB
dist/assets/main-CnLaB88m.js                 98.77 kB │ gzip: 35.10 kB
dist/assets/css-BHZw9-Se.js                 109.68 kB │ gzip: 29.55 kB
dist/assets/css-Zy14aQFT.js                 223.54 kB │ gzip: 75.91 kB
dist/assets/DashboardView-BUy7MWFw.js       309.59 kB │ gzip: 97.66 kB

✓ built in 578ms
```

Web 生产前端原始输出末尾：

```text
dist/assets/index-CuuD3rbQ.css                              68.32 kB │ gzip:  13.69 kB
dist/assets/ChatWorkspace-DKb7JVO8.css                      86.56 kB │ gzip:  14.61 kB
dist/assets/ConversationWindow-CGNIPtNX.js                   2.04 kB │ gzip:   1.13 kB
dist/assets/ExplorerFilePicker-1Gz_lckz.js                   2.47 kB │ gzip:   1.32 kB
dist/assets/AccountsDialog-DLe1x8Va.js                       2.85 kB │ gzip:   1.32 kB
dist/assets/AccountIdentity-Cg0eDfYd.js                      7.06 kB │ gzip:   3.27 kB
dist/assets/SettingsDialog-Dpy4brtL.js                      57.97 kB │ gzip:  19.96 kB
dist/assets/index-CAXLv2F1.js                               59.02 kB │ gzip:  20.88 kB
dist/assets/_plugin-vue_export-helper-7bujr3r3.js           83.00 kB │ gzip:  32.37 kB
dist/assets/EmojiPicker-BI2XOVB9.js                         92.77 kB │ gzip:  11.77 kB
dist/assets/useChat-Cw2uVsfk.js                            105.74 kB │ gzip:  35.91 kB
dist/assets/ChatWorkspace-Ccg-cbR-.js                      489.12 kB │ gzip: 155.01 kB

✓ built in 1.81s
{"root":"E:\\多窗口项目\\IM开发\\go-rewrite\\web-vue\\dist","checked":19}
```

PC 生产前端及资源校验原始输出末尾：

```text
dist-desktop/assets/AvatarImage-DmmIWZZt.js                          3.77 kB │ gzip:   1.89 kB
dist-desktop/assets/ScreenshotOverlay-C-HexJOF.js                    4.31 kB │ gzip:   2.06 kB
dist-desktop/assets/UiIcon-DORo9M9D.js                               6.11 kB │ gzip:   2.76 kB
dist-desktop/assets/DesktopRouteSettings-CvE9dEK4.js                 8.52 kB │ gzip:   3.37 kB
dist-desktop/assets/ArchiveShell-Dl62Ih_n.js                        13.39 kB │ gzip:   5.35 kB
dist-desktop/assets/index-DZJrFb5o.js                               39.91 kB │ gzip:  11.72 kB
dist-desktop/assets/App-BYcOoPWK.js                                 48.78 kB │ gzip:  17.62 kB
dist-desktop/assets/SettingsDialog-BCVJy60M.js                      57.35 kB │ gzip:  19.65 kB
dist-desktop/assets/EmojiPicker-TAk6NS--.js                         92.80 kB │ gzip:  11.79 kB
dist-desktop/assets/useChat-B4t9c2Dp.js                             99.64 kB │ gzip:  32.81 kB
dist-desktop/assets/vue.runtime.esm-bundler-609ivuOA.js            116.80 kB │ gzip:  44.58 kB
dist-desktop/assets/ChatWorkspace-DRAN6u1u.js                      487.75 kB │ gzip: 154.19 kB

✓ built in 1.30s
{"root":"E:\\多窗口项目\\IM开发\\go-rewrite\\web-vue\\dist-desktop","checked":36}
```

Go `vet ./...` 与 `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath` 均退出 0。ELF 头已核对为 64 位 x86-64。Swift/Xcode 未安装，iOS 未编译；adb 当前没有设备，未进行手机或模拟器验收。

## 5. 兼容性检查

- 账号切换：格式函数无共享用户状态；后端上报按 user_id/IP 双重约束。后台同 IP 两用户及晚到响应测试、Web 权限撤销/锁定/会话切换测试通过。Web 出口查询完成后仍使用既有 current()/lifetime 校验，第三方请求不带登录凭据。
- 进程被杀后重启恢复：不修改本地持久化、Room、队列、AAD、ticket/epoch 或登录状态。后台使用现有表，重启后仍可读取；本轮未做真实杀进程或一周观察试验。
- 多会话并发：不改变消息发送、WS、已读和免打扰规则；聊天 UI 的换会话/延迟资料响应覆盖检查通过。后台注册与最近成功登录地址分别取值，不用最新设备出口替代历史注册地址。
- 新旧兼容：country/region/city 对应现有 country/province/city；新后台响应仅添加详情字段。旧文本、resolved 缓存、无 IP 和未知状态保留区分。没有新增依赖、迁移、环境配置或版本号修改。
- 本轮没有覆盖用户已有的其他脏工作区文件。没有推送 Git、发布安装包或部署服务器；线上生效需要后续发布相应后端及前端/客户端。

## 6. 发现但未修改的问题清单（只列，不动）

- 2026-11-27 本机实测公开 IPPure 端点 HTTP 200，包含 country/region/city；携带站点 Origin 的响应仍缺 Access-Control-Allow-Origin。Web 真实直连仍可能被浏览器拦截，需供应方为站点开放 CORS，或另提供支持指定 IP 的接口。模拟成功不等于生产直连成功；未收到额外接口或域名授权信息。
- 公开端点查询调用者出口，不能补查任意用户的历史地址。未上报且没有有效缓存的后台记录仍显示“暂未识别”，不拿管理员或服务器的地点填充；原 staff 资料离线库回退仍保留来源。
- iOS 仅同步资料适配字段，未新增 iOS 资料审核界面，且本机没有 Xcode/Swift，需在 Apple 构建环境验证；Android 无已连接真机。PC 此轮构建和测试为真实 Vue 前端与隔离数据，并非重新生成 NSIS 安装包或已安装旧版本的验收。
- 本次授权范围不包含服务器部署，生产实例、数据库和网站尚未更新。本地构建产物与验证记录在 .local/ip-location-unified-20261127-041803/，不是已经上线的版本。
