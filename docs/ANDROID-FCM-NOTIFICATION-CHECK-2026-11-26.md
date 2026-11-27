# 0.2.121 真机后台通知缺失排查

## 1. 计划

用户报告安装最新 APK 后退到手机桌面没有通知，并确认系统通知栏也没有；测试设备为 USB OPPO PEXM00，账号 `cesss1`。沿用已授权 FCM 接入和真机验证：依次核对已安装包、登录账号、令牌获取、服务器设备登记与消息状态、手机注册网络和通知权限。仅在查明客户端缺陷后修复，不把服务端配置或本地通知模拟等同于真实送达。

## 2. 原因与定位

目前确认失败在手机获取 FCM 令牌这一环。手机自有 `pulse_push` 中没有 token，服务器没有该账号的设备登记；应用已经调用 Firebase SDK，服务端客户端诊断记录为 `ANDROID_PUSH_REGISTER` / `java.io.IOException`，栈位于 `FirebaseMessaging.blockingRegister`。这排除了“没有触发注册”这一推测，但还不能仅凭包装后的异常确认 SDK 内层错误码。

账号已正常登录，账户 active/can_send 均为 true。服务器记录 18:00:50、18:00:53、18:00:55 和 18:01:18 的消息仍未读，相关会话未开启免打扰。因此本次不是仅缺少顶部横幅，也没有证据表明这些消息被会话免打扰抑制。

18:10:57 网络探测：手机普通路径访问 `firebaseinstallations.googleapis.com:443` 和 `android.apis.google.com:443` 均连接超时，TCP/TLS 阶段均未完成；原节点 HTTP 代理 `127.0.0.1:27890` 连接被拒绝。`mtalk.google.com:5228` 完成 TLS（0.456 秒，证书校验通过），随后因该端口不是 HTTP 服务而返回协议错误；这一项仅证明该次 TLS 可达，不能证明 FCM 注册或消息通道工作。不能把单个 Google 域名或端口可达推断为整条推送线路正常。

18:11 正常重启已有应用后，日志在 18:11:25、26、28、32、40、56 连续记录 `FCM Registration failed!`。Firebase SDK 的同步任务将该包装异常记为 hard failure 并停止自身重试；应用本轮有限重试也结束。18:13 仍没有取得令牌。网络未恢复时，仅退到桌面不能产生可投递的设备登记。

当前证据指向注册所需网络仍不完整；SDK 内层异常、Google 服务可用性和全部渠道级开关仍未完成独立探针验证。没有把 Google Play 服务版本较旧直接判为根因，也没有把当前问题宣称修复。

## 3. 完整 diff

本轮没有修改产品源码、构建配置或服务器配置，没有发布新 APK。增加此排查文档并更新 `AGENTS.md` 的当前状态；`.local/` 中的独立诊断副本增加 `FirebaseRegistrationProbe`，只检查默认 Firebase 初始化、Google 服务状态、通知渠道以及 FIS/FCM 请求结果，不读取登录凭据、不伪造账号、不发聊天消息、不注入通知。

诊断副本的唯一构建配置差异：

```diff
-testInstrumentationRunner = "com.pulseim.android.GoV2Probe"
+testInstrumentationRunner = "com.pulseim.android.FirebaseRegistrationProbe"
```

该组件经过正常 ADB 安装流程，OPPO 要求系统身份验证。用户明确表示忘记系统密码、无法完成；已停止安装客户端，不尝试绕过验证。包管理器检查没有安装成功的 instrumentation。

## 4. 测试与实际输出

已安装包 SHA-256 为 `d1464d37d722161ebd112c602a41f4b9a037e254d21f7f30f2046dbaf78e3020`，与交付 0.2.121 / versionCode 123 一致；Go 后端、真实 FCM 配置启用，CHAT_V2=false。不是未启用 Firebase 的包。

独立诊断组件的构建真实输出：

```text
:app:assembleDebugAndroidTest
BUILD SUCCESSFUL in 55s
48 actionable tasks: 48 executed
```

组件 APK 为 399,332 字节，SHA-256 `d038e295ed713eeaff0715e84833d52f4025e512c8780ab29f8e4754673623f3`。安装及真机探针执行未通过，不能把编译成功记为诊断检查通过。本轮没有产品代码修复，未重复运行此前已通过的 254 项 JVM；既有安装包的构建证据保留在 provisioning 报告。

18:13 真机检查：

```text
account: cesss1
version: 0.2.121
has_fcm_token: false
push_disabled: false
POST_NOTIFICATION app-op: Default mode: allow
```

app-op 允许仅是权限初查，不能代替完整通知渠道检查。服务器只读复核 healthy、重启 0、healthz/readyz 均 200；锁等待、消息 outbox、push_jobs 均 0，推送设备表为空。没有发现此次通知缺失由服务端队列积压引起的证据。

原始证据：`.local/firebase-notification-20261126-175936/`，包含已安装 APK 核对、手机脱敏日志、网络计时、只读账号/消息元数据、服务器状态和组件构建输出。未输出消息正文、登录 token、FCM token 或服务账号私钥。

## 5. 兼容性检查

- 账号切换：产品逻辑未改，已安装账号数据保留；仅读取当前账号名和登记元数据，没有解密或提取登录 token。
- 进程重启：正常停止并启动现有应用一次，以复核注册；未卸载应用、未清除数据、未重置 Google Play 服务。重新启动后依旧没有令牌，真实离线恢复尚未验收。
- 多会话：未修改协议、会话读序号、去重、通知偏好或持久化；只查询消息的时间、未读与免打扰元数据。
- 服务端：未修改 `server/`、数据库内容、部署镜像、私钥或运行配置。
- 手机安全：安装受系统密码阻止后停止该项；后续直接通过已有应用和只读日志验证，不绕过手机安全验证。

## 6. 发现但未修改

- 注册网络恢复后，需要再次触发已有应用注册并核对实际设备登记，再由用户进行后台消息测试；目前真实通知送达未通过。
- SDK 当前将 `FCM Registration failed!` 包装异常当作 hard failure，应用有限重试用尽后需重新触发绑定；本轮未改 SDK、重试策略或新增后台轮询。
- 现有通知渠道使用 `IMPORTANCE_DEFAULT`，不能据此保证顶部横幅；当前先解决完全无通知/无令牌的问题，后续应单独验收横幅与已有渠道设置。
- FCM 网络应同时覆盖应用的注册请求和 Google Play 服务。普通 HTTP 代理的 HTTPS 可达测试不等于原生推送连接可用。官方说明：https://firebase.google.com/docs/cloud-messaging/network-configuration 。
- 真实后台送达、进程回收后送达、点击通知开聊与账号切换仍待验收；P1 性能和 P3 真实观察期保持原结论。
