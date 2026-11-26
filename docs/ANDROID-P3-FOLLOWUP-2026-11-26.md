# Android P3 后续修复记录（2026-11-26）

## 1. 计划（先输出，等确认）

用户在确认上一轮四项修复及剩余事项后要求“按照现有的问题继续推进修复”。本轮先修文字队列本地领取保存失败后的自动恢复，再处理合法旧 Room 队列超出旧快照容量时无法恢复/缩减的问题；随后验证账号切换、进程重启、真机安装条件和 Go 集成环境。原有 P3 授权继续有效，不增加依赖、协议或 UI 改动。

执行前 HEAD 为 `99e4f9485770f0b64187f42ea3cbaaf023849640`；保存原有 7783 个文件的 SHA-256、未提交差异和状态，后端 575 个文件受保护。每项缺陷独立提交，通过测试后才提交。

## 2. 每个 Bug：根因一句话 / 改哪个文件的哪几行 / 为什么这样改

### 文字队列存储恢复后仍不继续发送

根因：`ChatSendController.drainText()` 本地 claim 保存失败后只报错返回，没有安排下一次尝试。

修改 `ChatSendController.kt` 的文字领取入口、失败回调和 reset：增加账号内的 15 秒恢复时间，复用原 `OutboxRetryWakeup`。首次失败保留既有提示，连续失败记录故障；保存成功才派发网络任务。保存失败由队列原子恢复 attempt，不占网络重试预算，不改变真实永久错误的 FAILED 语义。

提交：`410eb9b7928eb3df3111b02dd78afaf42e06e4d1`。新增 6 项 JVM 回归，总计 205 项通过。

### 历史超限 Room 队列连恢复和确认移出都被拒绝

根因：容量保护无条件拒绝超限后的每次写入，导致已有 Room 权威数据连重启后的恢复写、claim、ack 都不能完成。

修改 `OutboxCapacity.java` 和 `OutboxRoomStore.kt`：仅对原本已超限且 Room 已是权威的队列开放受限恢复。逐条核对现有请求身份和不可变 payload；完整恢复必须保留全部 action 及顺序，增量更新不能添加或替换业务内容。允许原状态推进、确认/显式删除，attempt 不得倒退，原图标记和原有 canonical endpoint 规则保留。

状态/错误/上传字段不能在每次重试中无限膨胀：变更后大小不超过原有大小与 64 KiB 中的较大者。新增入队仍须满足正常容量保护，不能通过“恢复”绕过。未确认消息不自动删除，永久失败不自动改为成功或等待。

回滚前先检查容量；仍超限就保持 Room 权威和旧快照原样，避免切回过期数据。确认移出后降回容量范围，才从当前 Room 重建旧快照并切换。沿用加密元数据格式 3；旧格式 1/2 的有效 Room 数据按行计量升级，无需改数据库 schema、AAD、ticket 或事务边界。

提交：`275a2e666a9c723d2995af3894cd28dce43088a7`。新增 10 项 JVM 回归，总计 215 项通过。

## 3. 完整 diff

本地六节完整报告包含本轮全部差异、完整测试源码和原始输出：

`.local/android-p3-followup-20261126-134614/P3-FOLLOWUP-report.md`

逐缺陷候选差异：同目录 `text-recovery/complete.diff`、`oversized-recovery/complete.diff`。候选提交树构建排除了原有未提交的 Android、后端和其他端修改；原有内容未混入提交。

## 4. 测试代码 + 实际运行输出（贴原始终端输出）

JVM 测试：`ChatSendControllerTest.kt`、`OutboxCapacityTest.java`、`OutboxRowPersistenceTest.java`。实际 SQLite/Keystore/进程检查为 `OutboxRoomProbe.kt`。完整源码和终端输出在本地报告第 4 节。

| 验证 | 实际结果 |
| --- | --- |
| 文字恢复候选树 | 205 tests；0 failures/errors/skipped；assembleDebug、AndroidTest Kotlin 编译通过 |
| 超限恢复候选树 | 215 tests；0 failures/errors/skipped；同上 |
| 新旧开关的工作区隔离副本 | 每种 215 tests、Debug 构建通过 |
| 新旧开关 Room 检查 | 各 33 项通过，包含提交前真实杀进程和旧格式超限数据跨进程恢复 |
| 20 条文字超限夹具 | 20 条及 FAILED 原请求完整恢复；确认 15 条后剩余 5 条安全回滚 |
| 20 个加密附件超限夹具 | 原文件、上传信息和 FAILED 保留；确认 15 个后保留 5 个文件/请求回滚 |
| 10 条文字 + 2 个附件发送恢复 | 两种开关均完成三进程检查；幂等回执来自持久化本地夹具 |
| 生命周期与列表 | 每种开关各 8 项生命周期；新列表 26 项、旧列表 4 项通过 |
| 旧路径截图 | 群聊/私聊与上一轮逐字节一致 |
| 真机 | 安装等待 50 秒超时，0 项新检查执行；OPPO 安装引导待手机侧操作 |
| Go 并发幂等集成 | 已尝试执行，因无本地 PostgreSQL/Redis 配置而 SKIP；未判为集成通过 |

候选提交树原始结果摘录：

```text
"exit_code": 0,
"tests": 215,
"failures": 0,
"errors": 0,
"skipped": 0,
"CHAT_V2": false,
"GO_BACKEND": true
BUILD SUCCESSFUL in 52s
51 actionable tasks: 51 executed
```

Go 原始输出（在隔离归档副本内运行，不写仓库后端、不接生产数据库）：

```text
=== RUN   TestConcurrentSendIsIdempotentAndConflictChecked
    core_test.go:289: requires isolated PostgreSQL and Redis integration configuration
--- SKIP: TestConcurrentSendIsIdempotentAndConflictChecked (0.00s)
PASS
ok  pulse.im/server/internal/core 0.013s
```

尽管命令 exit 0，SKIP 明确表示该集成未验证。真机第一次安装失败的原始记录保留；其中脚本模板字段 `actual_kill_inside_transaction=true` 不代表手机执行过杀进程，实际手机检查数为 0，不能据此声称真机通过。

## 5. 兼容性检查

- 账号切换：文字恢复时间和唤醒在 reset/close 时清除，旧账号回调和旧定时器不能向新账号发送。对应 JVM 回归和生命周期检查通过。
- 进程重启：原格式 1/2、已上传的 COMMITTING 附件、FAILED、原 request_id、attempt 和附件密文保留；真实独立进程验证旧超限队列恢复及缩减后的回滚。测试预算是 4096 字节，用于验证控制流，不是实际 64 MiB 真机压力验收。
- 多会话：文字两个发送槽位、同会话顺序、权限暂停和永久性 4xx 规则不变；本地文字故障不堵住附件发送。原有并发账号及 SQL 逐条写检查继续通过。
- 数据保留：超限恢复只接受原 action 的安全状态变化；不偷偷删除未确认消息，不替换 payload，不恢复过期旧快照，不提高 64 MiB 或 10000 条上限。
- 原有文件：不改依赖、生产 Manifest、默认 CHAT_V2、AAD/密钥、ticket/epoch、网络参数、Go/PHP 后端或其他客户端已有修改。

## 6. 发现但未修改的问题清单（只列，不动）

- 真机安装需用户在 OPPO 完成系统步骤；当前未安装成功，P2/P3 真机复核和 P1 性能复测均不能标为通过。此前 P1 真机性能失败的结论保留，CHAT_V2 默认 false。
- 真实一周观察仍未完成，测试时钟不计入真实观察期；Room 读不默认开启。
- 生产 Go 幂等/网络集成待具备隔离的 PostgreSQL/Redis 环境后运行；当前本地夹具和被跳过的 Go 测试都不代表生产验证。
- 本轮处理的是行内容有效、原格式可解析的容量超限队列；超过 10000 条、单字段超过原 8 MiB 编码限制或密文损坏的数据仍失败可见，不擅自裁剪/拆分。
- 大容量恢复的真机内存压力尚未验证；本轮 4096 字节注入预算的成功不等同真实 64 MiB 压力通过。
