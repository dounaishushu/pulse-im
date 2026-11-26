# Android P3 审查后修复记录（2026-11-26）

## 1. 计划（先输出，等确认）

上一轮已在 `.local/android-p3-review-20261126-121606/REVIEW-UNRESOLVED.md` 列出四项问题并用 JVM 故障夹具复现前三项、核对第四项容量边界。本轮用户明确要求“修复发现的几项问题”，因此按原四项计划执行，无需重新确认阶段或依赖。执行前保存 7780 个原有文件的 SHA-256、工作区状态与差异。

按一个缺陷一个提交：失败状态补写、附件队列恢复、可靠观察期计时、回滚容量保护。仅修改 Android 相关实现/回归和进度文档，不引入依赖，不改生产协议、UI、Manifest、默认开关或后端。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

| 问题 | 根因及修复 | 文件锚点 |
| --- | --- | --- |
| P1 双写遗漏失败状态 | A 的状态未保存但内存已变化，后续 B 只更新自身行，旧整包却包含 A。两种队列保留 dirty ID，下一次成功事务同时更新这些已发布 action；成功才清除，删除和被拒绝的入队不会复活。文字手动重试失败同时恢复原 retryAt。 | TextSendQueue.java:42、68、175；DurableMediaOutbox.java:43、203 |
| P1 附件队列停滞 | 网络 worker 已结束，defer 写盘失败却把 phase 回退成 UPLOADING/COMMITTING，后续不能领取。失败后内存保留 QUEUED，领取必须写盘成功才发送；本地领取失败每 15 秒恢复尝试，并避免反复弹同一提示。 | DurableMediaOutbox.java:135；ChatSendController.kt:212、227 |
| P2 提前满足一周门槛 | 仅比较系统日期，调快日期便能绕过观察。使用 elapsedRealtime 和 BOOT_COUNT；仅同次开机的单调时间计入一周，仍需即时一致性校验和显式切读。旧元数据和设备重启重新观察。原 wall-only 方法保留，但不能提供切读凭据。 | OutboxRollout.java:7、39、56；OutboxRoomStore.kt:29、92、180；AndroidOutboxStorage.kt:15 |
| P2 Room-only 无法回滚 | 行存储没有旧 JSON 的聚合容量上限。逐行核算加密计数，覆盖 Base64、JSON 的斜杠转义及队列恢复后的状态占用；写入/切读超限失败，事务回滚、未发布 action 不保留。初始化、校验与回滚可读全队列，正常变更只读取/写入有关 action。 | OutboxCapacity.java:7、16、28、60；OutboxRoomStore.kt:57、79、114、135；LocalAccountStore.kt:22 |

前 3 项提交：`5ead39d`、`448f7fc`、`6bfb737`。第 4 项与本记录属于本次 `fix(outbox): 限制待发队列容量以保证旧快照可回滚` 提交。

容量是保守上界，不是精确剩余空间展示。每行考虑三种 Base64 对齐、边界转义和恢复后的表示；不会为每次变更重新编码整队列。计数和行内容都由既有 AES-GCM/AAD 认证。共享数据库表结构及版本未改变；元数据支持旧格式并升级，异常不当作空队列。

## 3. 完整 diff

本地完整六节报告包含四项完整 diff、全部修改过的测试源码及原始终端输出：

`.local/android-p3-fixes-20261126-122232/P3-FIXES-report.md`

逐提交差异：同目录 `fix1/complete.diff`、`fix2/complete.diff`、`fix3/complete.diff`、`fix4-final/complete.diff`。最终报告的差异仅包括本轮提交，排除执行前已有工作区修改。

产品差异超过 P0 历史的 400 行门槛：当前为 P3 的四项修复，包含单调时间/旧元数据兼容及容量预算；额外测试覆盖实际 SQLite 和进程退出，不是扩大到其他功能重构。

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

JVM 测试源码：`OutboxRowPersistenceTest.java`、`ChatSendControllerTest.kt`、`OutboxRolloutTest.java`、`OutboxCapacityTest.java`，完整源码在本地六节报告第 4 节。实际 Android 检查源码为 `OutboxRoomProbe.kt`，同样全文保留。

| 验证 | 实际结果 |
| --- | --- |
| 第 1 项候选提交树，排除原有本地修改 | 177 tests，0 failures/errors/skipped；assembleDebug 和 AndroidTest Kotlin 编译通过 |
| 第 2 项候选提交树 | 182 tests，0 failures/errors/skipped；同上 |
| 第 3 项候选提交树 | 187 tests，0 failures/errors/skipped；同上 |
| 第 4 项候选提交树 | 199 tests，0 failures/errors/skipped；同上 |
| 工作区隔离副本，新/旧开关各一次 | 各 199 项单测与 Debug APK 构建通过 |
| API 37 模拟器，新/旧开关 Room 检查 | 各 28 项通过；包含事务提交前真实杀进程 |
| 近容量上限的 Room-only 队列 | 4096 字节测试预算接受 6 条，拒绝继续增长；恢复、回滚后实际旧 JSON 3934 字节 |
| 新/旧开关的三进程发送恢复 | 各 10 条文字和 2 个加密附件完整恢复，幂等夹具 12 个唯一回执，第三进程不再发送 |
| 生命周期和列表 | 每种开关 8 项生命周期；新列表 26 项、旧列表 4 项通过 |
| 旧路径像素 | 群聊/私聊两张 PNG 与 P3 修改前逐字节相同 |

最终候选构建原始结果摘录（完整日志见同目录 `fix4/proposed-build/terminal.log` 和最终候选日志）：

```text
"exit_code": 0,
"tests": 199,
"failures": 0,
"errors": 0,
"skipped": 0,
"CHAT_V2": false,
"GO_BACKEND": true
BUILD SUCCESSFUL in 1m 10s
51 actionable tasks: 51 executed
```

Room 检查脚本的实际摘要（新/旧各一份，完整输出在六节报告）：

```text
"passed": true,
"device": "emulator-5558",
"actual_kill_inside_transaction": true,
"production_api_used": false,
"simulated_week_is_not_real_soak": true,
"checks": 28
```

50 条待发的实际 SQL：双写领取 1 个 action，行密文 329 字节，旧快照 13816 字节；测试时钟显式切读后 defer 只变更 1 个 action，行密文 343 字节，旧记录写入 0 字节。Room @Upsert 对已存在主键先尝试 INSERT，再 UPDATE，日志两条语句对应同一个 action，不是两条 action；容量/时钟元数据约 327 字节。默认双写仍保留旧快照 O(n)，没有声称默认模式已消除全部写放大。

Android 原始计时依据：[SystemClock](https://developer.android.com/reference/android/os/SystemClock)、[BOOT_COUNT](https://developer.android.com/reference/android/provider/Settings.Global)。JSON 转义核对：[AOSP JSONStringer](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/88c7ff1cd72d6305ec59f97aadc2198cc2dc3592/android-34/org/json/JSONStringer.java)。这些仅用于核实平台行为，未引入库或修改格式。

## 5. 兼容性检查

- 账号切换：dirty 状态归各队列，clear/detach 清除；原 account ticket、epoch 和回调代次校验保留，账号切换取消本地恢复定时器。JVM 和两种开关生命周期检查通过。
- 进程被杀后重启恢复：真实杀进程验证事务未提交的两套数据均回滚；Room-only 接近容量上限时也跨实际进程恢复并完整回滚。发送请求编号、附件密文、attempt、reply、mentions、已上传信息保留；幂等验证使用本地持久化夹具，不能等同生产 Go 服务验证。
- 多会话并发：每会话发送顺序与文字两个槽位不变；已有失败不会挡后续消息。真实两个账号并发写入 20 条检查通过，无交叉写入；正常单行写仍为 O(1) 个 action。
- 加密/存储：LocalAccountStore 的修改只有容量常量引用，数值仍是 64 MiB；AAD、ticket、epoch、事务边界、附件格式、数据库文件和 schema 版本不变。未知/损坏元数据失败可见，不静默清空。
- 原有本地修改：按执行前哈希核对，无关文件和 575 个后端文件保持原样；原有未提交内容不纳入本轮提交。
- 测试只使用隔离模拟器的两个包名；未安装到已连接 OPPO、未触碰正式应用、未调用生产 API。

## 6. 发现但未修改的问题清单（只列，不动）

- P1 真机滚动性能仍未通过；本轮是功能/持久化回归，未重新测量性能。CHAT_V2 保持默认 false。
- 真实一周双写观察、真机 P2/P3 和生产 Go 幂等集成尚未完成；测试时钟不是实际观察期，不默认切 Room 读。
- 旧实现若已留下超过回滚容量的 Room-only 数据，本轮不会删除数据以腾挪空间；必须保留数据后专项处理。新预算防止后续接受不可回滚的增长；无法恢复时失败可见。
- 文字队列的本地 claim 写入失败仍需要下一次 drain 触发；本轮只为已确认会永久停在 UPLOADING/COMMITTING 的附件路径补齐定时恢复，不扩展其他恢复行为。
- 仓库中原有 iOS/Web 未提交修改存在 trailing whitespace，全仓 git diff --check 因此非零；本轮各候选提交的 diff --check 均通过，未擅改原有内容。
