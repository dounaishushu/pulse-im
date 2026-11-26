# Android 实时连接反复提示修复（2026-11-26）

## 1. 计划（先输出，等确认）

沿用用户已授权的新版 Android 排障修复范围，先说明检查连接提示触发点、真机连接和服务器日志，查明原因后说明单连接归属修复与真机复测计划；没有再次要求确认。仅处理重复页面导致的连接竞争；使用既有依赖，保留后台连接及嵌套页面导航。计划是增加可独立验证的归属状态、接入 Activity 生命周期、回归并生成 Go Android 安装包。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

根因：标准启动模式允许同一进程中驻留多个 MainActivity，每个实例都持有会自动重连的 SocketClient，服务端按 user+device 替换旧连接，实例相互踢下线，而客户端每次认证成功又弹“实时连接已建立”。

19:23:40 真机只读字段快照证实：3 个未销毁实例各有未关闭的 SocketClient，两个后台实例连接 epoch 已达 233/240，前台实例为 42。19:16:44 的前 15 分钟，相关网络出口有 144 条已关闭 WebSocket（平均 1.886 秒）、143 次 ticket 201 和 48 次 ticket 429。出口日志存在同 IP 归属局限，不能将每条请求唯一归于此账号；真实多实例字段证据独立成立。限流是连接风暴的后果，没有放宽服务端限制。

修改 MainActivity.kt 的 companion object（66 行）、onResume（690 行）、connectSocket（1354 行）和 onDestroy（6527 行）：Go 模式下当前实例接管并关闭旧实例连接；失去归属的旧页面不得在异步回调中重建连接；旧页面销毁不能释放新页面的归属。onPause/onStop 不主动释放当前归属，保留系统页面/桌面短暂离开时的原连接策略。Go 模式健康连接不再弹成功 Toast；保留错误诊断及现有恢复流程。新增纯 Kotlin RealtimeOwner.kt（1 行起）和 RealtimeOwnerTest.kt（1 行起）的 7 项 JVM 生命周期回归。

没有改 Manifest 启动模式，因此群成员资料进入嵌套会话、返回父页的导航保持原样。没有修改 SocketClient 协议、服务端 Hub、HTTP 路径、ticket 或 epoch 生成规则。

## 3. 完整 diff

以下是本次产品代码和全部回归测试的完整改动（unified=0，避免文档空白上下文触发仓库 whitespace 检查）；不包含原有未提交修改。

```diff
diff --git a/android/app/src/main/java/com/pulseim/android/MainActivity.kt b/android/app/src/main/java/com/pulseim/android/MainActivity.kt
index 70b1862..482a290 100644
--- a/android/app/src/main/java/com/pulseim/android/MainActivity.kt
+++ b/android/app/src/main/java/com/pulseim/android/MainActivity.kt
@@ -66 +66,4 @@ class MainActivity : Activity(), ViewModelStoreOwner {
-    companion object { internal var foregroundOwner: MainActivity? = null }
+    companion object {
+        internal var foregroundOwner: MainActivity? = null
+        private val realtimeOwner = RealtimeOwner<MainActivity>()
+    }
@@ -688,0 +692,6 @@ class MainActivity : Activity(), ViewModelStoreOwner {
+        if (BuildConfig.GO_BACKEND) {
+            realtimeOwner.claim(this)?.let { previous ->
+                previous.socket?.close(); previous.socket = null
+                previous.activeMessageRecovery = null
+            }
+        }
@@ -1346,0 +1356 @@ class MainActivity : Activity(), ViewModelStoreOwner {
+        if (BuildConfig.GO_BACKEND && !realtimeOwner.owns(this)) return
@@ -1372 +1382 @@ class MainActivity : Activity(), ViewModelStoreOwner {
-                if (connected) toast("实时连接已建立")
+                if (connected && !BuildConfig.GO_BACKEND) toast("实时连接已建立")
@@ -6514,0 +6525 @@ class MainActivity : Activity(), ViewModelStoreOwner {
+        if (BuildConfig.GO_BACKEND) realtimeOwner.release(this)
diff --git a/android/app/src/main/java/com/pulseim/android/RealtimeOwner.kt b/android/app/src/main/java/com/pulseim/android/RealtimeOwner.kt
new file mode 100644
index 0000000..bb2ce71
--- /dev/null
+++ b/android/app/src/main/java/com/pulseim/android/RealtimeOwner.kt
@@ -0,0 +1,21 @@
+package com.pulseim.android
+
+/** Keep one realtime owner across Activity instances, including a pause to the home screen. */
+internal class RealtimeOwner<T : Any> {
+    private var owner: T? = null
+
+    /** The caller closes the displaced owner's connection before opening its own. */
+    @Synchronized fun claim(next: T): T? {
+        if (owner === next) return null
+        val previous = owner
+        owner = next
+        return previous
+    }
+
+    @Synchronized fun owns(candidate: T): Boolean = owner === candidate
+
+    /** An old Activity can be destroyed after the replacement has already resumed. */
+    @Synchronized fun release(candidate: T) {
+        if (owner === candidate) owner = null
+    }
+}
diff --git a/android/app/src/test/java/com/pulseim/android/RealtimeOwnerTest.kt b/android/app/src/test/java/com/pulseim/android/RealtimeOwnerTest.kt
new file mode 100644
index 0000000..92b0e89
--- /dev/null
+++ b/android/app/src/test/java/com/pulseim/android/RealtimeOwnerTest.kt
@@ -0,0 +1,74 @@
+package com.pulseim.android
+
+import org.junit.Assert.*
+import org.junit.Test
+
+class RealtimeOwnerTest {
+    @Test fun firstActivityIsTheOnlyAllowedConnectionOwner() {
+        val state = RealtimeOwner<Any>()
+        val activity = Any()
+        assertFalse(state.owns(activity))
+        assertNull(state.claim(activity))
+        assertTrue(state.owns(activity))
+        assertFalse(state.owns(Any()))
+    }
+
+    @Test fun resumingTheSameActivityKeepsItsBackgroundConnection() {
+        val state = RealtimeOwner<Any>()
+        val activity = Any()
+        state.claim(activity)
+        assertTrue(state.owns(activity))
+        assertNull(state.claim(activity))
+        assertTrue(state.owns(activity))
+    }
+
+    @Test fun replacementReturnsTheConnectionToCloseAndRejectsOldReconnects() {
+        val state = RealtimeOwner<Any>()
+        val first = Any(); val second = Any(); val third = Any()
+        state.claim(first)
+        assertSame(first, state.claim(second))
+        assertSame(second, state.claim(third))
+        assertFalse(state.owns(first))
+        assertFalse(state.owns(second))
+        assertTrue(state.owns(third))
+    }
+
+    @Test fun destroyingAStoppedActivityDoesNotReleaseTheCurrentConnection() {
+        val state = RealtimeOwner<Any>()
+        val stopped = Any(); val current = Any()
+        state.claim(stopped); state.claim(current)
+        state.release(stopped)
+        assertTrue(state.owns(current))
+        assertFalse(state.owns(stopped))
+    }
+
+    @Test fun returningFromANestedChatRestoresTheParentAsOwner() {
+        val state = RealtimeOwner<Any>()
+        val parent = Any(); val child = Any()
+        state.claim(parent); state.claim(child)
+        assertSame(child, state.claim(parent))
+        state.release(child)
+        assertTrue(state.owns(parent))
+        assertFalse(state.owns(child))
+    }
+
+    @Test fun destroyingTheOwnerAllowsAFreshActivityConnection() {
+        val state = RealtimeOwner<Any>()
+        val old = Any(); val fresh = Any()
+        state.claim(old); state.release(old)
+        assertFalse(state.owns(old))
+        assertNull(state.claim(fresh))
+        assertTrue(state.owns(fresh))
+    }
+
+    @Test fun ownershipUsesInstanceIdentityEvenWhenOwnersCompareEqual() {
+        data class Owner(val account: String)
+        val state = RealtimeOwner<Owner>()
+        val old = Owner("same-account"); val replacement = Owner("same-account")
+        state.claim(old)
+        assertSame(old, state.claim(replacement))
+        state.release(old)
+        assertFalse(state.owns(old))
+        assertTrue(state.owns(replacement))
+    }
+}
```

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

完整测试代码已包含于上节新增测试文件。测试实际调用生产 RealtimeOwner，覆盖首次归属、同实例恢复、三个实例接管/旧实例拒绝、旧页面销毁、子页返回父页、当前实例销毁及使用引用身份而不是 equals。

在当前完整工作区的隔离源码副本执行（JDK 17，离线 Gradle，两个 worker）：

```text
:app:testDebugUnitTest :app:assembleDebug :app:compileDebugAndroidTestKotlin
> Task :app:compileDebugJavaWithJavac
> Task :app:bundleDebugClassesToCompileJar
> Task :app:bundleDebugClassesToRuntimeJar
> Task :app:processDebugJavaRes
> Task :app:compileDebugUnitTestKotlin
> Task :app:dexBuilderDebug
> Task :app:compileDebugUnitTestJavaWithJavac
> Task :app:processDebugUnitTestJavaRes

> Task :app:testDebugUnitTest
Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8

> Task :app:mergeDebugGlobalSynthetics
> Task :app:mergeProjectDexDebug
> Task :app:mergeDebugJavaResource
> Task :app:packageDebug
> Task :app:createDebugApkListingFileRedirect
> Task :app:assembleDebug
> Task :app:compileDebugAndroidTestKotlin

BUILD SUCCESSFUL in 56s
53 actionable tasks: 53 executed
```

JUnit 原始 XML：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.pulseim.android.RealtimeOwnerTest" tests="7" skipped="0" failures="0" errors="0" timestamp="2026-11-26T11:23:09" hostname="YJ-20260621IJBF" time="0.0">
  <properties/>
  <testcase name="destroyingAStoppedActivityDoesNotReleaseTheCurrentConnection" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <testcase name="returningFromANestedChatRestoresTheParentAsOwner" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <testcase name="replacementReturnsTheConnectionToCloseAndRejectsOldReconnects" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <testcase name="resumingTheSameActivityKeepsItsBackgroundConnection" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <testcase name="ownershipUsesInstanceIdentityEvenWhenOwnersCompareEqual" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <testcase name="destroyingTheOwnerAllowsAFreshActivityConnection" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <testcase name="firstActivityIsTheOnlyAllowedConnectionOwner" classname="com.pulseim.android.RealtimeOwnerTest" time="0.0"/>
  <system-out><![CDATA[]]></system-out>
  <system-err><![CDATA[]]></system-err>
</testsuite>
```

构建器汇总及真机复测汇总（来自保存的真实结果）：

```json
{
  "version": "0.2.123",
  "version_code": 125,
  "tests": 262,
  "failures": 0,
  "errors": 0,
  "skipped": 0,
  "build_exit": 0,
  "sha256": "738e6e72f40da6446d61283dba8c780a83edb8c1c99e4381e37c6fbbf7528074",
  "same_signer_as_previous": true,
  "GO_BACKEND": true,
  "CHAT_V2": false,
  "FCM_CONFIGURED": true,
  "private_key_in_apk": false,
  "server_files_unchanged": 572
}
{
  "checked_at": "2026-11-26T19:33:13.566082+08:00",
  "multi_activity_single_connection": true,
  "live_activities_in_reentry_test": 3,
  "parent_return_single_connection": true,
  "foreground_observation_seconds": 108.123,
  "foreground_epoch_before": 1,
  "foreground_epoch_after": 1,
  "foreground_new_ticket_requests": 0,
  "foreground_closed_websockets": 0,
  "home_control": {
    "home_started_at": "2026-11-26T19:28:06.134189+08:00",
    "debugger_used_during_background": false,
    "messages_sent": false,
    "data_cleared": false,
    "home_ended_at": "2026-11-26T19:29:54.695482+08:00",
    "elapsed_seconds": 108.561,
    "return_exit_code": 0,
    "returned_existing_task": true,
    "persistent_connection_verified": false,
    "recovered_after_return": true,
    "epoch_after_return": 2,
    "closed_connections": 1,
    "ticket_requests": 0
  },
  "cold_start_passed": true,
  "cold_start_single_authenticated_connection": true,
  "cold_start_pid_changed": true,
  "chat_and_contacts_visible": true,
  "messages_sent": false,
  "data_cleared": false,
  "server_healthy": true,
  "database_lock_waiters": 0,
  "server_source_files_unchanged": 572,
  "apk_source_matches_current_worktree": true,
  "real_fcm_delivery_verified": false,
  "background_socket_always_connected_verified": false,
  "background_issue_unresolved": true,
  "initial_background_jdwp_timeout_seconds": 20,
  "initial_background_window_below_90_seconds": true
}
```

正常同签名覆盖安装 0.2.123 / versionCode 125，未卸载、清数据、修改用户凭据或代发聊天消息。先在原包保留失败现场；CLEAR_TOP 尝试只替换栈顶，仍有 3 个实例，不作为排除原因的有效对照。升级后第一次相同 intent 启动被系统复用，名为 three-activities 的早期采集实际只有 2 个实例，不计三实例通过；随后通过显式不同 action 的正常启动真正建立 3 个实例，读取到两个旧页面 socket=null，当前页面独占且已认证。

保留未通过记录：首次后台采集 JDWP 等待 20 秒超时，finally 已移除端口转发；该轮实际停留 87.44 秒而未达到 90 秒观察门槛，并有一次连接中断/返回后 epoch=2，不计稳定性通过，也不将中断直接归因于诊断工具。另做无后台调试器的独立对照，结果按上面原始汇总记录。真实后台消息通知送达未人工代发验证。

证据目录：`.local/android-realtime-toast-20261126-191505`。构建、签名、APK 私钥排除、端点及源码完整性证据：`.local/artifacts/android-realtime-owner-20261126-192217/verification`。APK 是沿用相同调试签名的测试包，不称为正式商店签名版本。

## 5. 兼容性检查

- 账号切换：仅当前页面允许建立 Go 连接，原 token/账号匹配回调、账号绑定/退出及加密存储未修改。7 项归属回归覆盖新旧页面隔离；真机保留 cesss1，未为验证而切换真人账号，不能宣称真机跨账号登录已测。
- 进程被杀后重启恢复：归属只在进程内，不写入持久化；真机正常 force-stop 冷启动检查见上面汇总。之前登录死锁修复仍包含，聊天/联系人导航正常，无恢复圆圈。没有清理待发数据，没有新增发送操作。
- 多会话并发：只集中 realtime 连接归属，不修改会话 ID、订阅、收敛、发送队列、事务或 server。真机三个页面同时驻留、系统返回上一页均独占连接；JVM 验证子页返回父页和旧实例销毁。真实多会话消息并发发送未代用户测试。
- 后端与旧路径：源码 guard 核对 572 个 server 文件相对构建前未变；不包含用户原先服务端未提交修改。服务端仅只读检查，无部署、重启或配置变更。Go-only guard 保留 legacy 路径行为；FCM 配置、CHAT_V2=false、Room 默认门槛不变；工程版本默认值未递增，版本只在隔离构建副本变更。

## 6. 发现但未修改的问题清单（只列，不动）

- FCM 注册仍失败、无有效设备登记，Google→手机离线通知真实送达尚未通过；本次健康 realtime 连接不等于 FCM 已可用。
- 无后台调试器对照仍发现退桌面约 30 秒后连接被关闭，返回后能恢复；后台连接连续性没有通过。尚未确认连接重置的发起点，不能直接归因于系统、省电、网络或诊断工具；不能用消除 Toast 代替后台消息送达验收。
- 新列表真机滚动性能未达到既定门槛，CHAT_V2 继续默认关闭；P3 真实一周、旧列表真机等既有待验收项保持原状。
- 只读服务器请求按共享网络出口归属，历史每一条请求的账号归因无法由 Nginx 日志单独保证。
