# Android P3：Room outbox 迁移进度（2026-11-26）

## 1. 计划（先输出，等确认）

用户明确要求“继续推进P3开发”，随后确认新增 `androidx.room:room-runtime:2.7.2`、Java `annotationProcessor("androidx.room:room-compiler:2.7.2")` 及必要传递依赖。本轮不新增 KSP/KAPT 插件。方案已先行说明：逐条变更接口 → 同数据库事务双写 → 真实恢复/一致性/回滚验证。

代码及本地功能验收已完成，**真实一周双写观察、真机与生产集成验收尚未完成**。默认双写并读旧记录，不自动切到 Room。P1 真机性能未通过的结论保留，`CHAT_V2` 默认 false。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

| 问题 | 实现与原因 |
|---|---|
| 原队列每次状态变化序列化整个快照 | `TextSendQueue.java` / `DurableMediaOutbox.java` 对本次变化的 action 提供 upsert/delete；保留原方法与纯快照存储兼容路径。`OutboxRowPersistence` 用延迟快照供应器，切读后不再生成旧整包。 |
| 两个数据库双写可能出现半提交 | `OutboxRoomDatabase` 管理原 `local-account-v1.db`，手动迁移 1→2 保留 records 表及其密文；`LocalAccountStore.outboxTransaction` 让旧记录、新行与迁移状态共用一个事务及原 ticket 提交检查。没有破坏性迁移回退。 |
| 原示例单列 requestId 主键不足以表达账号隔离 | `OutboxEntity` 使用 `(accountKey, namespace, requestId)` 复合主键；相同编号跨账号互不覆盖，文字与附件队列亦隔离。 |
| 新行必须完整认证，不能明文保存正文/错误/上传信息 | `OutboxRoomStore` 用原 `LocalAccountStore.seal/unseal`，内部仍调用 encryptCipher/decryptCipher；AAD 算法保持 `["pulse-account-v1", scope, namespace, key]`。新行 key 为 `row-<sha256(requestId)>`，迁移元数据 key 为 `room-rollout`；旧 queue 与附件 AAD 不变。排序、创建时间也包含在认证明文中并在读取时对照。token 从未序列化。 |
| 直接切回旧快照会恢复已发送或过时状态 | 切回前先把当前 Room 数据重建为旧格式，在同事务内持久化旧快照和 legacy-only 模式；随后停止影子行写入。旧读模式下影子损坏可显式回滚，保留旧权威数据。重新开启双写必须重建并重新观察一周。 |
| 大行可能超过 CursorWindow | `OutboxDao` 提供 header 和 256 KiB 分块读取，3 MiB 草稿实际恢复通过。 |
| 清理账号后影子数据可能残留 | `clearNamespace/clearAccount/clearAll` 在一次事务里清理 records、outbox、outbox_metadata；过期 ticket 写入失败，不能恢复被清理的数据。 |

Entity 没有按示例把 state/error/payload 暴露成明文列：原正文、mentions、reply、附件 identity、original、上传回执、状态、attempt 与 retryAt 均在单行密文中。`COMMITTING/UNREADABLE` 沿用原状态语义；确认发送后直接删除 action，沿用旧队列行为，不额外建立 SENT 历史表或伪造 serverMessageId。

SQL 跟踪（50 条待发，SQLite/Room 真实设备侧执行）：

| 模式/操作 | action 行 | action 密文 | 旧整包密文 | 说明 |
|---|---:|---:|---:|---|
| 双写，领取一条文字 | 1 | 329 B | 13,816 B | 仍保留旧整包 O(n) 写入 |
| 测试时钟切读后，延迟一条文字 | 1 | 343 B | 0 B | 只有 action 与常数大小迁移元数据写入 |
| 双写，领取一个附件 | 1 | 293 B | 13,936 B | 附件本体不重写 |

Room `@Upsert` 在已存在的主键上先尝试 INSERT，再执行 UPDATE；这是同一个 action 的两个 SQL 尝试，不是更新两条 action。另有一条固定大小迁移元数据 upsert。这里证明的是逻辑变更行数和绑定数据量的 O(1)，没有声称实测 WAL/fsync 字节或界面帧率。迁移初始化、恢复与回滚允许 O(n)。

## 3. 完整 diff

完整差异、逐个文件行号、测试源代码及未截断原始日志存于：

- [本轮六节完整报告](E:/多窗口项目/IM开发/go-rewrite/.local/android-p3-20261126-113019/P3-report.md)
- [仅本轮完整工作区 diff](E:/多窗口项目/IM开发/go-rewrite/.local/android-p3-20261126-113019/complete-working.diff)
- [排除原有未提交改动的提交 diff](E:/多窗口项目/IM开发/go-rewrite/.local/android-p3-20261126-113019/complete-commit.diff)
- [SQLite 跟踪摘录](ANDROID-P3-SQLITE-TRACE-2026-11-26.json)

本地证据目录受 Git 忽略；跟踪摘录随代码保存。原始未提交的安卓/PC/iOS/Web/Go 改动单独保留，不能把它们纳入 P3 提交。

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

新增 JVM 测试为 `OutboxRowPersistenceTest.java`（11 项）与 `OutboxRolloutTest.java`（8 项）。`OutboxRoomProbe.kt` 使用 Android 原生 Instrumentation，在隔离包中验证真实 Room/SQLite/Keystore，不使用 Robolectric、不访问生产 API。

新旧开关构建均实际执行：

```text
:app:testDebugUnitTest
:app:assembleDebug
tests=171 failures=0 errors=0 skipped=0
BUILD SUCCESSFUL in 22s
```

每种开关的 Room 检查实际输出：

```json
{"passed":true,"device":"emulator-5558","checks":20,"actual_kill_inside_transaction":true,"production_api_used":false,"simulated_week_is_not_real_soak":true}
```

两种开关各执行旧库升级、双写/切读/回滚、50 条文字与 50 个附件、故障注入、账号清理/并发、大草稿、密文破坏、真实事务中杀进程。另沿用 P2 三进程夹具：10 条文字和 2 个加密附件完整恢复，沿用原请求编号，幂等夹具最终 12 条，第三次进程不再补发；该夹具不是线上 Go 服务。

生命周期检查各 8 项；新列表功能 26 项、旧列表 4 项通过。旧列表两张 PNG 与 P3 修改前逐字节一致：

```text
group  fcbae01a0a836826c8d036bb8133bf0e6e6827c2f8e68c682d4a0f3fbeb8b57f
direct 5cd1f0b923551c707dd56d2563ee5dcf9c5b50c60886ca55b3f29747465f8f18
```

保留的初次失败：Room SQL 跟踪回调 Java 泛型不匹配，修正后重跑通过；一次设备脚本默认选到手机，未找到隔离组件，未安装/修改手机应用，随后显式锁定模拟器重跑。工作区全量 `git diff --check` 仍报告原有 iOS/Web 尾空格，不顺手修改；P3 提交使用独立索引检查差异。

标准复核命令：

```powershell
cd E:\多窗口项目\IM开发\go-rewrite\android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:compileDebugAndroidTestKotlin
```

本地隔离构建使用 JDK 17、`PULSE_BACKEND_PROTOCOL=go-v2`、127.0.0.1:9 测试地址，构建原始命令、XML、APK 哈希及所有设备原始输出均见完整报告。

## 5. 兼容性检查

- **账号切换：受影响，已验证。** 主键与加密 AAD 双重隔离；重新登录只换 token，不换 scope；旧 ticket 失效，账号/命名空间/全局清理同时清除两套数据。
- **进程被杀重启：受影响，已验证。** 升级旧库保留密文与请求编号；在两套数据均已改动而事务未提交时真实杀进程，重启恢复原 10 条；另以三进程幂等夹具检查 10 条文字和 2 个附件。
- **多会话并发：受影响，已验证。** 原顺序/并发领取规则保留；JVM 覆盖多会话两条领取只提交两行，设备侧两账号真实并发写入 20 条不死锁；同 requestId 的不同账号媒体互不影响。
- **UI/协议：无预期变化，已回归。** MainActivity、ApiClient、Socket、请求编号规则、生产 Manifest 与服务器代码均未作为本轮改动；CHAT_V2 默认 false，旧截图逐字节一致。
- **回滚开关：本地通过。** `AndroidOutboxStorage.switchRoomReads(context, endpoint, userId, namespace, false)` 在原磁盘线程执行，返回 Future；不要在主线程等待。`true` 会检查对应账号/队列的一周门槛和即时一致性。实例 `resumeRoomDualWrites()` 后须在同磁盘线程重新 bind；不会自动恢复观察期或绕过门槛。
- **安装包降级：有限制。** 本轮将同文件数据库从 v1 升到 v2；开关是在新版本内部切回旧存储逻辑，不代表支持直接安装原 v1 数据库代码的旧 APK。未验证旧 APK 降级，不提供破坏性数据库降级。

## 6. 发现但未修改的问题清单（只列，不动）

1. 真实一周双写观察尚未发生；测试时钟仅验证门槛逻辑。未部署/推送代码，不能把本地测试日期当作生产观察起点。
2. OPPO 真机功能/Room 升级与真实 Go 网络集成待复核；P1 真机滚动性能仍不达标，未改成默认新列表。
3. 队列仍在内存保留全部待发项，部分列表发布/复制/遍历仍是 O(n)；本阶段只降低持久化写放大。
4. 原 TextSendQueue.retry 与媒体 defer 在持久化失败时的部分 retryAt 内存回退行为没有顺手调整；不扩大本轮迁移范围。
5. 当前数据库使用手动迁移及运行时 schema 校验；未加入额外 Room 测试依赖或自动 schema 导出插件，后续 schema 版本仍需显式迁移测试。
6. 原有 iOS/Web 尾空格及其他工作区未提交改动保持原样；本轮 575 个服务器文件逐字节未变。

参考：[Room 官方版本文档](https://developer.android.com/jetpack/androidx/releases/room)、[Room 手动迁移文档](https://developer.android.com/training/data-storage/room/migrating-db-versions)。本轮迁移与 Java 注解处理是否可用以本仓库实际构建/升级结果为依据。
