# Android 0.2.122 登录后持续转圈修复

## 1. 计划

用户反馈安卓登录后一直转圈。沿用现有问题排查和修复授权，先检查服务器、手机页面和接口，再保留现场线程证据，定位后最小修复并补 JVM 回归。已有 P0/P2/P3/FCM 保留；不改服务端、协议、AAD、ticket、epoch、SQL 事务边界或 UI 文案。最后构建与同签名覆盖升级，验证页面和进程重启。

## 2. 每个 Bug：根因、位置与理由

根因是 Android 本地存储的类锁/实例锁顺序相反，形成真实线程死锁。18:23 手机已经登录 cesss1，主界面会话列表有一个持续的 ProgressBar；手机配置接口约 0.522 秒 HTTP 200。服务器 healthy、重启 0、数据库锁等待 0，账号 active/can_send 均为 true；不是仅凭公开接口正常便推断故障位置。

保留现场后，通过当前已安装 debug 应用的正常 JDWP 调试通道仅读取栈位置与监视器持有人，没有读取字段、局部变量或登录凭据。采集用时 1156ms，随后恢复应用并断开调试。

现场闭环：

```text
pool-35-thread-1
  holds: java.lang.Class (LocalAccountStore legacy read monitor)
  waits: LocalAccountStore instance, owned by pulse-text-outbox
  LocalAccountStore.db:67
  LocalAccountStore.read:118
  LocalDirectoryStore.read:29
  MainActivity.loadChatPage:1473

pulse-text-outbox
  holds: LocalAccountStore instance (outboxTransaction)
  waits: java.lang.Class, owned by pool-35-thread-1
  LocalAccountStore.write:150
  AndroidOutboxStorage.writeLegacy:60
  OutboxRoomStore.writeRows:90
  LocalAccountStore.outboxTransaction:76
```

个人资料保存和目录同步线程也在等待该类锁，所以既影响恢复连接，也影响列表读取和待发恢复。主线程停在 MessageQueue.nativePollOnce，仍可绘制转圈；没有将本地死锁误报为服务器 PostgreSQL 锁或 Google 注册超时。

仅修改 `LocalAccountStore.kt:71` 的事务入口：增加 `@JvmStatic`，让 `@Synchronized` 与既有静态 read/write/remove/clear 使用同一个类监视器。取得类锁后再进入 db/secretKey 的实例监视器，回调旧记录写入时重入类锁。保留同步保护及原 SQL 事务、提交前票据检查、加密和回滚语义。

## 3. 完整 diff

以下是产品和 JVM 回归的完整补丁；源码中的版本默认值未改。仅在隔离打包副本把版本递增为 0.2.122 / versionCode 124。

```diff
diff --git a/android/app/src/main/java/com/pulseim/android/LocalAccountStore.kt b/android/app/src/main/java/com/pulseim/android/LocalAccountStore.kt
index ac1655e..1f52048 100644
--- a/android/app/src/main/java/com/pulseim/android/LocalAccountStore.kt
+++ b/android/app/src/main/java/com/pulseim/android/LocalAccountStore.kt
@@ -70,2 +70,2 @@ internal object LocalAccountStore {
-    /** P3 adds a single outer commit; legacy record writes keep their ticket/AAD checks. */
-    @Synchronized fun <T> outboxTransaction(context: Context, ticket: Ticket, action: (OutboxDao) -> T): T {
+    /** Match legacy read/write's class monitor before db/key's instance monitor or a legacy callback. */
+    @JvmStatic @Synchronized fun <T> outboxTransaction(context: Context, ticket: Ticket, action: (OutboxDao) -> T): T {
diff --git a/android/app/src/test/java/com/pulseim/android/LocalAccountStoreConcurrencyTest.java b/android/app/src/test/java/com/pulseim/android/LocalAccountStoreConcurrencyTest.java
new file mode 100644
index 0000000..2c76d6e
--- /dev/null
+++ b/android/app/src/test/java/com/pulseim/android/LocalAccountStoreConcurrencyTest.java
@@ -0,0 +1,63 @@
+package com.pulseim.android;
+
+import static org.junit.Assert.*;
+
+import java.lang.reflect.InvocationTargetException;
+import java.lang.reflect.Method;
+import java.util.concurrent.CountDownLatch;
+import java.util.concurrent.TimeUnit;
+import java.util.concurrent.atomic.AtomicReference;
+import org.junit.Test;
+
+public class LocalAccountStoreConcurrencyTest {
+    @Test public void outerTransactionWaitsForLegacyRecordMonitorBeforeEnteringStore() throws Exception {
+        Method transaction = null;
+        for (Method method : LocalAccountStore.class.getDeclaredMethods()) {
+            if (method.getName().equals("outboxTransaction")) transaction = method;
+        }
+        assertNotNull(transaction);
+        final Method entry = transaction;
+        CountDownLatch started = new CountDownLatch(1);
+        CountDownLatch finished = new CountDownLatch(1);
+        AtomicReference<Throwable> failure = new AtomicReference<>();
+        Thread worker = new Thread(() -> {
+            started.countDown();
+            try {
+                // Null arguments intentionally stop at Kotlin's entry checks. The real method's
+                // monitor is acquired first; no Android API, database, token or crypto is touched.
+                entry.invoke(LocalAccountStore.INSTANCE, new Object[] {null, null, null});
+            } catch (InvocationTargetException e) {
+                failure.set(e.getCause());
+            } catch (Throwable e) {
+                failure.set(e);
+            } finally {
+                finished.countDown();
+            }
+        }, "outbox-transaction-monitor-regression");
+        worker.setDaemon(true);
+        boolean waitingForLegacyMonitor = false;
+        try {
+            // @JvmStatic legacy read/write methods own this monitor. A transaction must wait
+            // here before it can acquire the instance database/key monitor or call legacy write.
+            synchronized (LocalAccountStore.class) {
+                worker.start();
+                assertTrue(started.await(1, TimeUnit.SECONDS));
+                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
+                while (System.nanoTime() < deadline) {
+                    if (worker.getState() == Thread.State.BLOCKED) {
+                        waitingForLegacyMonitor = true;
+                        break;
+                    }
+                    if (finished.await(5, TimeUnit.MILLISECONDS)) break;
+                }
+            }
+        } finally {
+            worker.join(2000);
+        }
+        assertFalse("Transaction entry must finish after the legacy monitor is released", worker.isAlive());
+        assertTrue("Outbox transaction entered while a legacy reader owned the class monitor; "
+                + "this permits instance -> class / class -> instance deadlock", waitingForLegacyMonitor);
+        assertTrue("Only the deliberate null-argument entry check should fail: " + failure.get(),
+                failure.get() instanceof NullPointerException);
+    }
+}
```

## 4. 测试代码与实际输出

测试代码完整包含在上面的 diff。测试持有真实旧存储类监视器并调用生产事务入口，确认它在入口处等待，再释放监视器。空参数刻意让执行停在 Kotlin 参数检查，不接触 Android API、数据库或密钥；没有另造一套锁实现来代替生产代码。

修复前的隔离源码执行新增测试：

```text
LocalAccountStoreConcurrencyTest > outerTransactionWaitsForLegacyRecordMonitorBeforeEnteringStore FAILED
    java.lang.AssertionError at LocalAccountStoreConcurrencyTest.java:58
1 test completed, 1 failed
BUILD FAILED in 10s
```

修复后完整构建执行 `:app:testDebugUnitTest :app:assembleDebug :app:compileDebugAndroidTestKotlin`：

```text
tests: 255
failures: 0
errors: 0
skipped: 0
BUILD SUCCESSFUL in 1m 29s
53 actionable tasks: 53 executed
```

初次测试准备使用错误相对路径而未复制测试，结果为 No tests found；第二次测试使用 Android 编译类路径不含的 java.lang.management，编译失败。之后改用普通 Thread.State，才完成上述真实红/绿回归。两个准备失败的日志保留，没有算作缺陷复现或测试通过。

APK：`E:/多窗口项目/IM开发/go-rewrite/.local/artifacts/android-storage-deadlock-20261126-182955/Android/小猿口算-0.2.122-Go-Android-登录转圈修复.apk`。

- SHA-256：`dea8626ab7dbe718ad1d60bba52d456e1122ac035397f4a78e4b6fe5c80eb3f6`。
- 9,673,827 字节；0.2.122 / 124；Go v2 生产接口、FCM 配置启用、CHAT_V2=false。
- 相同调试签名，签名/对齐/ZIP/版本/端点核对通过，服务账号私钥未进入 APK。
- 258 个打包输入与 572 个已跟踪后端文件守卫一致；构建未覆盖原有工作区改动。
- 正常 `adb install -r -t --no-incremental` 返回 Success，手机确认 0.2.122；没有卸载、清数据或绕过身份验证。

18:33 再次将已有应用带回前台，页面无 ProgressBar；18:34 实际截图确认已有会话、头像与 4 条未读显示。首次安装后 UI 观察曾落在之前遗留的 OPPO 安装引导页，该次没有计为 App 验证通过。

18:34:54 开始正常 force-stop→启动：PID 11689→13134，首轮 UI 检查在启动命令返回后 5.55 秒观察到聊天与联系人导航、无恢复连接页、ProgressBar=0，进程重启验收通过。这个时间含 UIAutomator 自身采集时间，不能称为精确启动性能。

修复后 JDWP 线程快照曾等待 25 秒超时；未将该次采集计为无死锁通过。结论依据现场锁闭环、真实红/绿回归、覆盖升级后的会话页面和独立冷启动检查；没有宣称完成长期并发压力测试。

全部本地证据：`E:/多窗口项目/IM开发/go-rewrite/.local/android-login-spinner-20261126-182307`。没有向其他账号发聊天消息。

## 5. 兼容性检查

- 账号切换：不改身份与加密语义，当前 cesss1 在覆盖升级和进程重启后保留；既有 JVM 账号/队列隔离测试全绿。本轮未在生产手机切换其他账号，不扩大验收结论。
- 进程被杀后恢复：当前手机真实新进程恢复通过。原数据库文件、Room 迁移、旧快照双写、AAD、票据和事务边界均不变；正在进行的未提交事务仍由 SQLite 回滚。
- 多会话/后台并发：事务入口与旧记录统一监视器，先序列化存储入口再进入数据库/密钥；没有移除同步，也没有改变每会话队列、发送状态机或请求编号。并发回归覆盖本次锁反转，完整 JVM 255 项通过。
- 后端：源码和服务配置未改，无需为本次客户端修复重新部署后端；服务器消息数 8、账号与会话状态正常。
- 安装包：这是与前版相同 debug/test 签名的 Go 版本；正式发布签名仍未配置。

## 6. 发现但未修改

- FCM 令牌注册仍报失败，真实离线通知尚未验收；本次修复没有把它误报为已恢复，也没有内置 VPN 或新增厂商 SDK。
- 后续若要国内用户无需 VPN 的系统离线通知，需要独立接入厂商推送，并明确新依赖和 Go 后端授权范围。
- 修复后的完整监视器快照未成功，不将页面验证等同于长期无死锁保证。
- P1 滚动性能、P3 真实一周及旧列表真机等既有待验收项保持原结论。
