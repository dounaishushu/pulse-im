# Android Go 版本 FCM 接入记录（2026-11-26）

## 1. 计划与授权

用户要求“给安卓包接入离线推送”，沿用此前要求的 Google FCM。本轮在 `E:/多窗口项目/IM开发/go-rewrite` 完成安卓接线、回归、SDK 分支构建与本地通知检查；服务器仅检查配置，不修改后端、数据库、运行容器或线上消息。

计划按三项独立修复推进：设备绑定与账号隔离；Go UUID/消息序号适配；无 Activity 冷启动初始化与 Android 13+ 通知授权。复用现有条件 Firebase SDK，不引入额外库或 Google Services Gradle 插件。原有协议路径、加密、持久化、UI 文案及 P3 门槛保留。

起点提交 `be3f35b9d033c3aad7e3043940de01f65063f840`，保存 7785 个原文件的 SHA-256、差异和状态，其中后端 575 个文件受保护。

**当前结论：客户端接线、本地验证及真实 Firebase 配置已完成；服务器已启用 FCM，0.2.121 / 123 安装包已生成并覆盖安装真机。手机当前到 Google 注册端点的 HTTPS 请求超时，实际 Google→手机送达仍未验收。下文保留首次接线时缺配置的历史记录；后续启用及失败记录详见 `ANDROID-FCM-PROVISIONING-2026-11-26.md`。**

## 2. 每个问题的根因、文件与修复

### 设备令牌没有绑定到 Go 当前账号

根因：`PushNotifications` 读取旧的无 endpoint 账号存储，而 Go 登录使用 endpoint 范围的加密账号存储；注册失败被忽略，也没有可靠重试及旧回调隔离。

修改 `PushNotifications.kt`、新增 `PushRegistration.kt`，统一当前 endpoint/账号/token 快照，在独立串行线程登记设备。使用代次校验丢弃旧账号、旧 token 获取和旧定时器回调；获取 token 超时可恢复，暂时性失败最多自动重试 5 次，永久 4xx 不自动重试，成功后抑制重复登记并在一天后刷新。

Go 适配器使用服务端已有 `payload_version=2`，让 data 消息通过客户端的账号/免打扰/预览控制。`PushTransport` 将 Firebase 获取失败交给重试器。退出活动账号先关闭本地接收再撤销服务端绑定；退出其他保存账号不关闭当前账号。停止自动初始化时不异步删除安装级 token，避免刚切换账号后被旧的删除任务失效。

提交 `5889530e5fb929dbe43b3ab05a1d7f185637324c`；新增 16 项 JVM，总计 231 项通过。

### Go UUID 推送被当作数字丢弃

根因：原接收器把 `user_id`、`conversation_id`、`message_id` 直接转 Int，而 Go 使用 UUID，消息的本地展示编号为会话内 `seq`。

新增纯 Java `PushMessagePolicy.java` 并接入 `PushNotifications.receive`。先校验当前收件人 UUID，再使用原 GoV2Ids 的 endpoint/type 映射得到本地会话编号，以 seq 沿用通知/WS 去重。推送没有消息 version，不伪造权威消息记录。不合法或其他账号的消息不创建会话映射；实际本地存储故障交给原诊断系统。保留原数字协议兼容路径。

通知继续调用原 `MessageAlerts`，保留前台当前会话抑制、类别开关、免打扰、锁屏和预览设置。点击通知沿用原通知 Intent，本轮将其中使用的本地会话编号适配正确；未将模拟器检查称为真实服务端点击开聊验收。

提交 `2884c20a8e1209a004166645fb0668d545550dce`；新增 16 项 JVM，总计 247 项通过。

### 进程被回收后的初始化及通知授权不完整

根因：Firebase 只在 Activity 的登录绑定路径初始化；FCM Service 冷启动没有默认 FirebaseApp。Android 13+ 原来只声明通知权限，没有运行时请求。

在 `PulseApplication` 初始化推送，使用既有 BuildConfig 中的项目配置创建默认 FirebaseApp；自动初始化默认关闭，有有效登录时才请求 token。为 Android 13+ 已登录、尚未授权且未询问过的用户请求通知权限，拒绝后不会随重连反复弹窗。无推送构建保留空适配器，旧 Android 不请求不支持的权限。

修改 `PulseApplication.kt`、`PushNotifications.kt`、两个 transport、Manifest；新增 `PushPermissionPolicy.java` 与回归，并新增 `PushNotificationProbe.kt` 检查真实 Android 通知和跨进程恢复。

提交 `b17fef7afd8f8a80680723ba4c8496823a8240eb`；新增 6 项权限及 1 项冷启动模型 JVM，总计 254 项通过。

关键位置：`PushNotifications.kt:15`（账号范围）、`:51`（冷启动）、`:60`（授权）、`:75`（绑定）、`:87`（退出）、`:100`（接收）；`PushRegistration.kt:22`（串行登记与代次）；`PushMessagePolicy.java:22`（UUID/seq 解析）；`GoV2Api.kt:480`（既有能力字段）；`PulseApplication.kt:15` 和 `AndroidManifest.xml:13`（初始化入口/默认自动初始化策略）。

## 3. 完整 diff

完整差异、全部新测试源码、原始日志、设备/服务端证据及失败记录位于：

`.local/android-fcm-20261126-143640/FCM-INTEGRATION-report.md`

完整差异单独保存为同目录 `complete.diff`。逐项候选树、单测、构建与提交记录分别在 `registration/`、`payload/`、`startup-final/`。`startup/` 保留修正探针等待顺序前的构建；`device-first/` 保留首次失败。

原有未提交修改没有混入这三次代码提交。没有修改 `server/`、PHP 后端、其他客户端、CHAT_V2 默认值或 Room 切读策略。

## 4. 测试代码与真实输出

JVM 新增 39 项，位于 `PushRegistrationTest.kt`、`PushMessagePolicyTest.java`、`PushPermissionPolicyTest.java`。原有 215 项回归继续通过；未引入 Robolectric。

| 验证 | 结果 |
| --- | --- |
| 登记/账号隔离候选树 | 231 tests，0 failures/errors/skipped；Debug 与 AndroidTest Kotlin 编译通过 |
| UUID 适配候选树 | 247 tests，0 failures/errors/skipped；同上 |
| 冷启动/授权候选树，包含 FCM SDK | 254 tests，0 failures/errors/skipped；同上 |
| 包含原有未提交修改的完整工作区副本 | 254 tests 与构建通过，247 个 Android/契约源文件逐字节一致 |
| API 37 本地推送探针 | 11 项通过；两个真实进程 PID 4718、4795 |
| 模拟器通知 | UUID 账号/会话、seq、去重、免打扰、切换账号、隐藏预览及失效账号抑制通过 |
| 真实 FCM 设备 token 获取、云端投递 | 未验证，缺真实项目配置 |
| 用户安卓手机 | 未安装本轮模拟配置测试包；正式应用和手机设置未改 |

候选树原始输出摘录：

```text
"tests": 254,
"failures": 0,
"errors": 0,
"skipped": 0,
"fcm_compile_fixture": true,
"real_firebase_credentials": false,
"FCM_CONFIGURED": true,
"CHAT_V2": false,
"GO_BACKEND": true
BUILD SUCCESSFUL in 1m 10s
53 actionable tasks: 53 executed
```

探针原始结果摘录：

```text
"passed": true,
"checks": 11,
"device": "emulator-5558",
"real_fcm_delivery_tested": false,
"production_api_used": false,
"compile_fixture_only": true
```

第一次探针在 Application.onCreate 完成前运行，默认 FirebaseApp 尚未建立而失败。保留原始失败和日志，增加探针 `waitForIdleSync()` 后，以相同产品代码重建隔离测试包并验证两个冷启动进程。没有修改断言或把失败隐藏为通过。

模拟器为本轮新建的独立 PulseFCM AVD，未使用手机或个人 AVD 数据；测试包卸载，模拟器已停止。构建使用隔离目录中的明确假配置来启用现有 FCM SDK 代码，未往原项目放入假 google-services.json。

## 5. 兼容性检查与实际启用步骤

- 账号：使用原 endpoint 范围 AccountSessions 和原加密，不改变格式；旧账号回调、旧 session、旧 endpoint 和旧重试计时器不能给新账号登记。
- 进程：无 Activity 时默认 FirebaseApp 已准备；跨进程恢复原加密账号及 UUID 映射，退出标记和失效 token 仍抑制通知。
- 多会话：使用 owner+conversation+seq 的原通知去重键，两个会话的相同 seq 不互相覆盖；前台当前会话不重复提醒。
- 旧协议：数字标识仍兼容；Go 模式不回退 PHP，不把 UUID 强转数字。没有修改 HTTP 路径或服务端实现；payload_version 为现有服务端能力。
- 配置：生产配置与模拟编译配置分开；服务账号私钥不会进入 APK、Git 或前端资源。
- 原有文件：后端 575 个文件、原始未提交修改和其他端文件受 SHA-256 保护。

实际启用尚缺同一个 Firebase 项目的两项配置：

1. Android 应用 `com.pulseim.android` 的 `google-services.json`，放到 `android/app/google-services.json`（已有 Git 忽略规则），重新构建。
2. 服务账号 JSON，安全部署到服务器容器可读的非公开路径，设置既有 `PULSE_FCM_ACCOUNT_PATH` 并以只读方式挂载。需要确认项目 ID 与客户端一致；私钥不得放进安卓项目或 APK。现有 Go 实现已支持此配置，无需为本次客户端接线修改后端代码。

本次只读检查找到了正在运行的 Docker Go 进程，PULSE_FCM_ACCOUNT_PATH 未设置。最初 systemd 单元探测没有命中生产容器，不能把该结果解释成生产服务停止。限定目录搜索未找到匹配配置；没有声称扫描了服务器所有文件。

Firebase 当前停在首次项目创建页面；尚未获得首次接受服务条款的用户确认，没有创建项目或生成私钥。名称“小猿”少于页面要求的四个字符，可使用“小猿口算”。用户完成项目创建后，再登记 Android 应用、下载配置、配置服务端并做真实送达验收。

## 6. 发现但未修改

- 真实 Firebase 项目配置缺失，当前仓库普通构建仍会选择 noPush；不能以模拟配置编译成功冒充用户已可收离线通知。
- 真实 SDK token 获取、服务端 FCM 鉴权、Google→手机送达及通知点击后完整打开服务端会话仍待验证。
- FCM 设备需要符合 Google Play 服务及网络条件；系统强行停止、通知被拒绝和网络不可达等情形不能保证提醒。参见 [Firebase Android 官方接入说明](https://firebase.google.com/docs/cloud-messaging/android/client)。
- 无正式配置的测试 APK 只保存在 .local 验证目录，不生成对外分发的 FCM 安装包。
- P1 滚动性能未通过、P3 真实一周观察与此前未完成的验收项保持原结论，本轮没有顺手修改。
