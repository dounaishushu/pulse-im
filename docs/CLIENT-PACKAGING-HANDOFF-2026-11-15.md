# 客户端正式打包交接说明

日期：2026-11-15。对象：接手自行打包、签名和发布客户端的作者。

源码、构建入口和已完成的验收记录均已交付。当前 PC 为 `2.4.158`，Android 为 `0.2.87 (89)`。安卓相册返回丢失附件及同类回调修复见 [Android 0.2.87 验收](ANDROID-PICKER-FIX-2026-11-15.md)；此前图片提速、批量授权和会话打开修复见 [性能与会话验收](MEDIA-PERFORMANCE-2026-11-15.md)。早期图片修复见 [图片修复记录](PC-IMAGE-FIX-2026-11-15.md)；`2.4.156` 存在缩略图显示缺陷，应升级。请作者补齐下表的签名及推送资料后，在自己的发布环境打包。**不能把现有 Android 调试 APK 改名当作正式版，也不能把没有签名的 Windows 包称为已完成代码签名。**

## 1. 已交付内容与当前缺项

| 项目 | 已有内容 | 本次未取得或未配置的内容 | 作者需要完成的事项 |
| --- | --- | --- | --- |
| PC / Windows | Electron 客户端源码、NSIS 安装配置；2.4.158 已实际安装并完成双账号媒体及并发收发验收 | Windows 代码签名证书及可用的签名配置；没有提供 PFX/P12 密码或签名服务凭据 | 如需带受信任发布者的包，使用自己的有效证书或签名服务完成签名并验证 |
| Android | 原生 Android 源码、Go v2 适配、Release 构建与签名入口；已有调试包验收记录 | 原正式版的 `.jks` / `.keystore`、别名、密钥库密码、私钥密码 | 优先取回原签名；需要新签名时先确认旧用户的安装升级方案，由作者长期保管签名资料 |
| Android FCM | FCM 客户端接线及服务端推送实现 | `android/app/google-services.json`；本次交付不包含服务端 FCM 服务账号私钥 | 配置匹配 `com.pulseim.android` 的 Firebase 应用，并在服务端配置对应的 FCM 服务账号；做真实设备推送验收 |
| iOS，后续如需发布 | iOS 同步修复上传等待、媒体批量授权、收藏及隐藏会话；Swift 语法、Foundation 契约本地运行、图片队列和工程静态检查记录 | 本轮没有 Mac / Xcode 完整构建和 iPhone 验收；没有交付 Apple Developer Team、发布证书、描述文件或 APNs 签名材料 | 由作者在自己的 Apple 发布环境补齐资料和验收；本次不交付 IPA |

这里的“未取得”表示**本次交付环境没有可供打包使用的资料**，不表示原作者或其他机器一定没有。签名私钥、证书密码和推送服务账号不能从源码、普通 APK 或 EXE 反推出。

用户本轮要求先交付 PC，再交付 Android。当前同时提供 PC 安装包和 Android `0.2.87` **调试签名验收包**；`0.2.86` 的相册返回丢失问题应升级本版。安卓正式发布仍由作者补齐上述资料后执行。苹果本轮仅修复源码，不打包 IPA。

## 2. 源码、版本和正式服务地址

| 项目 | 当前值 |
| --- | --- |
| 仓库 | `dounaishushu/pulse-im` |
| 分支 | `codex/go-rewrite`，不要误取仍保留历史代码的 `main` |
| PC/Android 提速功能提交 | `13b83f17dc928728894ddb0fad18cb39fe3fbb58`；安卓回调修复取 `android-v0.2.87` 标签 |
| PC 包对应的源码 | `pc-v2.4.158` 标签；前一版 `2.4.157` 保留历史图片修复记录 |
| PC Release 标签 | `pc-v2.4.158` |
| Go HTTP API | `https://api.imapi.shop/api/v2` |
| Go WebSocket | `wss://api.imapi.shop/api/v2/realtime` |
| PC 版本 | `pc/package.json`、`pc/package-lock.json`：`2.4.158` |
| Android 版本 | `android/app/build.gradle.kts`：`versionName = "0.2.87"`、`versionCode = 89` |
| Android 包名 | `com.pulseim.android` |

新包必须连接 Go `/api/v2`；不要使用旧 PHP `/api`、旧 `/ws`，也不要把 `localhost`、`10.0.2.2`、测试端口或 `example.com` 模板带给用户。WebSocket 必须与 API 同源，路径为 `/api/v2/realtime`。环境变量只是输入，**最终以安装包内实际生成的配置为准**。

`mobile-contracts/route-trust.json` 仍保留旧签名线路协议模板。Go 模式读取配置的 HTTPS 服务，不需要伪造或生成一套旧 PHP 线路签名来通过构建。不要为发布切回 `PULSE_BACKEND_PROTOCOL=legacy`。

## 3. Windows PC 自行打包

以下命令在仓库根目录的 PowerShell 中执行。需要 Windows x64、Node.js 至少 22.12.0，以及可用的 npm。当前锁定 Electron `43.8.10`、electron-builder `26.18.0`；保持锁文件，不要为绕过下载问题随意降级依赖。

```powershell
git switch codex/go-rewrite
git pull --ff-only

$env:PULSE_API_URL = 'https://api.imapi.shop/api/v2'
$env:PULSE_WS_URL = 'wss://api.imapi.shop/api/v2/realtime'

npm --prefix pc ci
if ($LASTEXITCODE -ne 0) { throw 'PC dependencies failed' }
npm --prefix pc run check
if ($LASTEXITCODE -ne 0) { throw 'PC syntax checks failed' }
npm --prefix pc run dist -- --publish never
if ($LASTEXITCODE -ne 0) { throw 'PC packaging failed' }
```

- `predist` 会校验正式地址并生成 `pc/runtime-config.json`；该文件不在 Git 中，干净检出后需要重新生成，不能复制他人的本地预览配置。
- 正式安装程序输出到 `pc/dist/`；`pc/dist/win-unpacked/` 是打包程序目录，不是安装向导。不要把 `dist:local` 生成的本机预览包交给用户。
- 当前 `pc/package.json` 使用 `win.signAndEditExecutable: false`，所以**上面的当前配置会生成未做 Authenticode 代码签名的包**。仅设置证书环境变量不代表此开关已经允许签名。

### 作者提供证书后的签名方式

按自己的证书类型或签名服务配置 electron-builder。若使用本地证书文件，`WIN_CSC_LINK` / `CSC_LINK` 和对应密码必须由作者的受控环境提供，不要写入仓库。还需要打开签名开关，并启用失败即中止的检查。例如，证书资料已安全注入环境后：

```powershell
npm --prefix pc run dist -- --publish never `
  --config.win.signAndEditExecutable=true `
  --config.forceCodeSigning=true
if ($LASTEXITCODE -ne 0) { throw 'Signed PC release failed' }
```

不能只看到构建成功就宣称签名成功。分别核对最终安装程序、程序目录内的 EXE，以及实际证书发布者：

```powershell
Get-AuthenticodeSignature -LiteralPath 'pc/dist/小猿口算-2.4.158-x64.exe' |
  Select-Object Status, StatusMessage, SignerCertificate
Get-AuthenticodeSignature -LiteralPath 'pc/dist/win-unpacked/小猿口算.exe' |
  Select-Object Status, StatusMessage, SignerCertificate
```

示例文件名对应当前版本；作者递增版本后应改成实际产物名。现有 GitHub 安装包未提供发布者代码签名，Release 已如实说明，不能把它当作已签名样本。

## 4. Android 正式包：补齐资料后再打

需要 JDK 17、Android SDK Platform 35、可用的 Android Build Tools。使用工程自带 Gradle Wrapper `8.10.2`；工程当前为 AGP `8.7.3`、Kotlin `2.0.21`、`minSdk = 26`。不要假设当前交付机器的 SDK、Gradle 缓存或 `.local/` 会存在于作者机器上。

1. 在作者机器设置正确的 `JAVA_HOME`。创建不提交的 `android/local.properties`，例如 `sdk.dir=C:/Android/Sdk`，路径换成实际位置。
2. 将原正式签名文件放在作者受控目录，确定别名、密钥库密码与私钥密码。**先检查原有用户安装包的签名证书，不能用每次新建密钥替代原签名。**
3. 将真实 Firebase 客户端配置放到 `android/app/google-services.json`，核对其中 Android 包名为 `com.pulseim.android`。
4. 由作者安全输入或通过 CI Secrets 注入下列变量；也可以使用等名 Gradle 属性。示例不包含任何可用密码。

```powershell
$env:PULSE_API_URL = 'https://api.imapi.shop/api/v2'
$env:PULSE_WS_URL = 'wss://api.imapi.shop/api/v2/realtime'
$env:PULSE_BACKEND_PROTOCOL = 'go-v2'

# 换成作者实际持有的原签名路径与别名。
$env:PULSE_SIGNING_STORE = 'C:/private-signing/pulse-im-release.jks'
$env:PULSE_SIGNING_ALIAS = '实际签名别名'
# PULSE_SIGNING_PASSWORD、PULSE_SIGNING_KEY_PASSWORD：由安全输入或 CI Secrets 提供。

if (-not $env:PULSE_SIGNING_PASSWORD -or -not $env:PULSE_SIGNING_KEY_PASSWORD) {
  throw 'Signing passwords have not been supplied'
}

.\android\gradlew.bat -p .\android :app:verifyProductionConfig
if ($LASTEXITCODE -ne 0) { throw 'Android production configuration is incomplete' }
.\android\gradlew.bat -p .\android :app:assembleRelease
if ($LASTEXITCODE -ne 0) { throw 'Android Release packaging failed' }
```

签名配置完整时，APK 输出为 `android/app/build/outputs/apk/release/app-release.apk`。如作者需要商店 AAB，可另执行 `:app:bundleRelease`，产物位于 `android/app/build/outputs/bundle/release/`。

### 当前门禁为什么会报错

`android/app/build.gradle.kts` 的 `verifyProductionConfig` 检查正式 HTTPS/WSS 地址、真实 Firebase 配置和全部签名参数，`preReleaseBuild` 会调用它。当前缺项意味着 Release 构建会按设计停止：

- 缺 `google-services.json`：不能通过 FCM 配置检查。
- 缺原签名、别名或密码：不能签出可供用户升级的正式 APK。
- 调试构建存在 `noPush` 分支，**不代表当前 Release 门禁允许省略 FCM**。若作者决定正式版不提供离线推送，需要单独设计、审核并验证该发布方式，不能直接删掉检查来冒充配置齐全。
- 不能靠修改 APK 文件名、关闭门禁、虚填 Firebase 数据或使用 Android 默认调试密钥完成正式发布。

### 签名兼容和推送注意事项

- 原签名存在时沿用原签名；证书变化涉及升级兼容，必须由作者明确处理。新签名不能承诺可直接覆盖签名不同的旧包；卸载旧包会影响本地缓存、待发内容和登录信息。
- 签名密钥与密码要有作者可恢复的安全备份，不能随构建目录一起丢弃，也不能上传到 GitHub。
- `google-services.json` 是 Firebase 客户端配置，**不是** Go 服务端的 FCM 服务账号私钥。服务端还需配置 `PULSE_FCM_ACCOUNT_PATH`，并确认 Go 使用的账号属于对应 Firebase 项目；不要将服务账号私钥打入 APK。
- HTTP 登录和 WebSocket 在线收发正常，只能证明在线链路；关闭界面、系统回收进程、通知权限、免打扰和设备后台限制需要分别验收。Android 模拟器通过不等于所有用户手机的离线推送已通过。

## 5. 新版本与 GitHub Release

当前发布为 `pc-v2.4.158`，包含 `Pulse-IM-Setup-2.4.158-x64.exe`、`Android-0.2.86-validation.apk`、校验摘要、打包说明及脱敏验收证据。PC/Android 功能源码为 `13b83f1`，苹果对应修复及最新说明在 `codex/go-rewrite` 后续提交。当前 PC 安装程序 SHA-256：

```text
c94e9a42da7e9ace89a04db316731e71f814ac80877e3003ca86299751bd237c
```

签名、服务地址或代码有变化时，给新包使用可区分的版本和新 Release，不要静默覆盖同名、同版本安装包。PC 同时更新 `pc/package.json` 与 `pc/package-lock.json`；Android 同时维护 `versionName` 与递增的 `versionCode`，并先核对用户已有正式包的实际版本和证书。

发布时应提供：实际源码提交、平台和架构、安装文件、SHA-256、签名状态、必要的安装/升级说明。EXE/APK 作为 Release 附件交付，不塞入源码提交。不要把签名文件、证书密码、调试日志、测试账号、数据库备份或 `.local/` 上传为附件。

**把包传到 GitHub 不会自动修改客户端升级入口。** 当前 PC 默认读取 Go `/api/v2/client/update`。需要应用内提示新版本时，由作者或管理员核对后台的客户端版本配置、下载链接和强更策略；不要只发 Release 就以为用户已自动升级。

## 6. 作者发给用户前的检查

- 检查安装包内 API/WSS 指向上表正式 Go 服务；实际安装并启动最终产物，不能只运行开发源码。
- Windows 检查安装、重启启动、卸载以及声明过的签名状态；Android 检查非调试 Release 标记、签名证书及覆盖升级兼容。
- 使用两个独立测试账号验证注册、登录、会话打开、双向消息、群聊、图片和退出；不要向真实用户发送测试消息。
- 断网发送后恢复连接，核对待发消息继续发送、顺序和去重；重启客户端后检查待发队列和账号隔离。
- 如声明支持离线推送，使用匹配的真实手机和平台配置验证通知到达、点击定位及免打扰，不能仅以“注册 token 成功”代替。
- 下载刚发布的文件，重新计算 SHA-256，核对与构建产物和校验文件一致。

此前 PC 打包程序已连接正式 Go 完成登录、双向收发及断网恢复验收；Android 只有调试签名包与 Android 12 模拟器验收，**没有交付 Android 正式签名包**。iOS 仅完成代码审核及语法/契约检查，没有 Xcode target 构建或 Apple 设备验收。详细证据见 [修复与上线记录](RELIABILITY-FIX-2026-11-15.md) 和 [验收索引](evidence/reliability-fix-2026-11-15/summary.json)。

本说明是打包交接，不会修改线上服务或补造签名、推送凭据。作者自行打包不需要重新导入旧 MySQL、清空当前 PostgreSQL、重置用户密码或删除聊天数据。
