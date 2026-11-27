# Android Go FCM 真实配置与部署记录（2026-11-26）

## 1. 计划

沿用用户已授权的 Android 离线推送接入任务，在收到真实配置后验证客户端与服务账号属于同一个 Firebase 项目；将服务端私钥移出安卓工程，配置生产 Go 的既有 FCM 能力；用当前工作区源码重新生成安卓包并尝试真机验收。保留现有后端二进制、数据库、媒体及客户端协议。

证据目录：`E:/多窗口项目/IM开发/go-rewrite/.local/firebase-provision-20261126-171445/`。原始客户端接线及模拟通知检查见 `ANDROID-FCM-INTEGRATION-2026-11-26.md`，不能把那些模拟检查当成真实 FCM 送达。

## 2. 配置与发现

两个 JSON 的项目 ID 均为 `xiaoyuankousuan-3d98d`；客户端包名为 `com.pulseim.android`。服务账号是有效 RSA 2048 位私钥，本地签名和验签通过。客户端文件仍位于 `android/app/google-services.json`，已有 Git 忽略规则。

用户最初将私钥放在 `android/app`。已确认该文件未被 Git 跟踪，并将其移至仓库外的 `C:/Users/Administrator/.pulse-secrets/firebase/xiaoyuankousuan-3d98d/service-account.json`。目录 ACL 只保留当前执行账号、Administrators 和 SYSTEM 的访问；安卓源码副本及 APK 均检查未含服务账号私钥。初次目录 ACL 仅授权管理员组时，当前非提升进程无法复制文件，补充当前执行账号 SID 后移动成功；文件内容未输出。

本机与生产服务器分别验证 Google OAuth 和 FCM `validate_only=true`，两端均返回 HTTP 200。没有借此向任何设备或话题实际发送测试通知。

服务器使用原镜像 `sha256:b1f951c591ea37aa236ec3a8104ce6feb959547e2b1829100d45b7727c70a594`，后端源码及二进制未修改。服务端私钥安装在 `/etc/pulse/providers/fcm-xiaoyuankousuan-3d98d.json`，`root:65532`、0640，沿用只读 `/providers` 挂载；`/etc/pulse/pulse.env` 保持 root 0600。

使用原 Go 程序启动备用实例，后台任务等待独立激活标记。预热与健康检查通过后，经 Nginx 切换至 `127.0.0.1:18080`，旧实例收到 TERM 后退出并保留作回滚。17:25:11（北京时间）完成验证，新容器 ID 为 `1468e3f2a8be6b63c2183f4093799f9b6dce9ea145f0a63807d5fe077f7ac6bb`，healthy、重启次数 0；数据库 schema 和发布目录保持原样。

首次切换因运维脚本只读取 `docker logs` 的 stdout，漏掉 stderr 中的 `Pulse workers activated`，误触发回滚。已确认旧实例恢复 healthy、readyz=200，新实例没有 panic。修正为同时校验两条输出流后，重新预热相同镜像并完成切换。首次失败及回滚检查保存在 `server-first-attempt.json`、`server-rollback-audit.json`，没有把重试说成首次成功。

## 3. 完整 diff

产品源码与工作区构建配置无修改。当前交付包由隔离源码副本构建，仅在副本递增版本：

```diff
-        versionCode = 121
-        versionName = "0.2.119"
+        versionCode = 123
+        versionName = "0.2.121"
```

副本使用真实 `google-services.json`，选择现有 FCM 源集及已声明依赖。该包包含当前仓库已有 P0/P2/P3/FCM 实现，与上一轮仅修媒体队头的 0.2.120 包范围不同；CHAT_V2 仍为 false，Room 仍遵循原双写和观察期规则。

服务器配置变化：

```diff
+PULSE_FCM_ACCOUNT_PATH=/providers/fcm-xiaoyuankousuan-3d98d.json
```

API 与 WebSocket 两个 Nginx 代理片段的 upstream 均由 `127.0.0.1:18081` 切到 `127.0.0.1:18080`。备用实例的端口与 worker 激活文件相应变化；其余容器环境、命令、用户、数据挂载与原实例一致。激活标记为 `/var/lib/pulse/runtime/.activate-fcm-20261126-171445`。

受限的运行 Compose 配置保存在 `/root/pulse-fcm-20261126-171445/candidate.json`，配置文件内含原有服务环境，因此不在文档中输出、不下载到源码库。原环境和代理配置备份在该目录的 `backup/`。旧容器名为 `pulse-im-go-before-fcm-20261126-171445`，已停止且关闭自动重启；原发布目录 `/opt/pulse/releases/20261125-191140-staff-block-policy` 未改变。

## 4. 测试与实际输出

构建任务：`:app:testDebugUnitTest :app:assembleDebug :app:compileDebugAndroidTestKotlin`。

```text
tests: 254
failures: 0
errors: 0
skipped: 0
BUILD SUCCESSFUL in 57s
53 actionable tasks: 53 executed

Google OAuth: HTTP 200
FCM validate_only: HTTP 200
actual test notifications sent: 0

/healthz: 200
/readyz: 200
/api/v2/client/config: 200
/api/v2/me: 401 (unauthenticated, expected)
release integrity: passed
database schema unchanged: true
```

APK：`E:/多窗口项目/IM开发/go-rewrite/.local/artifacts/android-fcm-live-20261126-171642/Android/小猿口算-0.2.121-Go-Android-FCM-test.apk`，9,673,827 字节。

- SHA-256：`d1464d37d722161ebd112c602a41f4b9a037e254d21f7f30f2046dbaf78e3020`。
- versionName 0.2.121，versionCode 123，Go v2 生产接口，FCM_CONFIGURED=true，CHAT_V2=false。
- 与前版相同调试签名；签名、16 KiB 对齐、ZIP 完整性、APK 包名/版本/端点、FCM Service 和通知权限均核对。
- 已检查 APK 字节码中的真实 Firebase 项目标识；逐项检查打包输入和 APK，不包含服务账号私钥。
- 257 个构建输入校验，工作区现有改动与 HEAD 保留；572 个已跟踪后端文件校验一致，未覆盖原有未提交工作。

USB 真机 OPPO PEXM00 / serial 8900d3 已从 0.2.110 以相同签名覆盖到 0.2.121，ADB 返回 `Success`，包管理器确认新版本。未卸载应用、未清数据，启动后没有捕获到 `FATAL EXCEPTION`。

真机随后报：

```text
FirebaseMessaging: Failed to get FIS auth token
FirebaseInstallationsException:
Firebase Installations Service is unavailable. Please try again later.
```

17:29:36 检查手机原有网络与原有节点；对 `firebaseinstallations.googleapis.com` 和 `fcmregistrations.googleapis.com` 各测试一次普通 HTTPS GET、一次显式使用手机现有代理的 HTTPS GET。四次均 curl exit 28、HTTP 000，约 5 秒超时；开发电脑访问同域名可建立 TLS 并收到根路径 HTTP 404。404 是未认证根路径的正常响应，本项只证明连接，不代表推送发送成功。未改变手机节点、全局代理或路由，未关闭 TLS 验证。

17:28 的服务器复核：healthy、重启 0、锁等待 0、消息 outbox 0、push_jobs 0；启动后 ERROR/panic/fatal 标记均为 0。此时尚无登记的推送设备或实际投递记录，手机也未取得 FCM token。已请用户切换可访问 Google 的网络后继续验收。

## 5. 兼容性检查

- 账号切换：本轮未改逻辑；254 项回归覆盖既有账号隔离、过期回调与 token 绑定。真机未完成令牌获取，不能声称生产账号切换已验证。
- 进程被杀后重启恢复：本轮没有修改持久化/AAD；此前本地推送探针覆盖跨进程恢复，但本轮尚未完成 Google 真实离线送达及冷启动验收。
- 多会话并发：沿用原会话序号去重和免打扰策略；未修改消息协议和后台任务实现。该项此前本地检查通过，本轮不扩大为生产 FCM 验收通过。
- 后端/数据：原镜像、schema、媒体挂载和发布源文件保留；新后台任务在旧实例退出前按既定交接流程激活。首次误回滚带来额外连接重建，不能声称此次切换对所有长连接完全无感。
- 安装：相同签名覆盖安装已实测；这是 debug/test 签名包，尚未配置正式发布签名。

### 用户切换节点后的复核（17:34–17:38）

用户回复“已切换，继续检测”后，复用已安装 APK 检查，没有修改产品或服务器配置。首轮四次 HTTPS 两次返回根路径 404、两次超时。追加探测仅扩大工具的观察预算为 connect 10s / max 15s：现有显式代理下两个注册域名可连，耗时 9.226s / 5.065s；普通 VPN/TUN 路径仍发生两次 TLS SSL_ERROR_SYSCALL，尚不能断言网络完全稳定。

手机正常重启应用后停在账号登录页，服务器推送设备表仍为空。已请用户在该手机正常登录测试账号；未读取账号登录 token、代替登录或人工发送聊天消息。真实令牌绑定及通知验收需待这一步完成。证据独立保存在 `.local/firebase-retest-20261126-173413/`，原节点失败记录未覆盖。

## 6. 发现但未修改

- 切换节点后显式代理已能访问 Firebase 注册端点，但普通 VPN/TUN 路径仍有握手重置；手机尚未登录，需先正常登录测试账号再验收令牌绑定与实际离线通知。
- 本机/服务器鉴权成功不等于 Google 已把通知送达手机；不以 `validate_only`、模拟消息或本地通知代替端到端验收。
- FCM 依赖可用的 Google Play 服务及网络；本轮未接入各手机厂商推送，也没有承诺无 Google 服务的设备能收到 FCM。
- 真机后台、进程回收后的通知、点击开聊和账号切换仍需真实送达复测。
- 原 P1 性能未达标、P3 真实观察期等历史待验收项保持原结论，不因接入 Firebase 自动完成。
