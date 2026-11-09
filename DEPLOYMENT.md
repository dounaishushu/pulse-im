# 全新独立部署

本文按单台 Linux 服务器部署 API、Web、后台及 WebSocket。目录示例 `/www/wwwroot/pulse-im`；域名示例 `im.example.com` 和 `admin.im.example.com`，需替换成自己的域名。全程使用新数据库和新密钥。

## 1. 环境和依赖

后端需要 PHP 8.2+、Composer、MySQL 8、Nginx、Supervisor。PHP 至少启用 `pdo_mysql`、`mbstring`、`fileinfo`、`openssl`、`curl`、`gd`、`zip`；Linux WebSocket 进程需要 `pcntl`、`posix`。其余 PHP 扩展以 Composer 锁文件检查为准。Redis 在本包默认 `REALTIME_DRIVER=database` 模式下不必启用，切换 `redis` 模式再配置。

客户端工具：PC 需要 Node.js/npm；Android 需要 JDK 17、Android SDK 35；iOS 需要 macOS、Xcode 16+ 和 Python 3。正式移动端签名和推送凭据由部署方提供。

```bash
cd /www/wwwroot/pulse-im
composer --working-dir=backend install --no-dev --prefer-dist --optimize-autoloader
mkdir -p backend/runtime backend/public/storage
umask 077
cp backend/.env.example backend/.env
php tools/init-deployment-secrets.php
```

初始化工具只填充空的 `MEDIA_SIGNING_KEY` 和 `PASSWORD_VAULT_KEY`，不会覆盖已有非空值。后者为注册所必需。私有配置权限应允许 PHP-FPM 与后台进程读取，例如将文件所有者设为实际运行用户、权限 `0600`；运行目录与上传目录也须允许该用户写入。私有配置文件不能通过网站根目录公开。

编辑 `backend/.env`，至少设置：

```ini
APP_ENV=production
APP_DEBUG=false
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=pulse_im
DB_USER=pulse_im
DB_PASSWORD="自行设置的新数据库密码"
CORS_ORIGIN=https://你的主域名,https://你的后台域名
FILE_BASE_URL=https://你的主域名/storage
REALTIME_DRIVER=database
ADMIN_IP_CHECK_ENABLED=true
ROUTE_CLUSTER_ID=pulse-im-new-install
ROUTE_DEFAULT_API_URL=https://你的主域名/api
```

密码和密钥用双引号包围，避免 INI 特殊字符解析问题。保持已生成的两个密钥不变。`IP_API_KEY` 为可选的 IP 归属地服务凭据；Telegram 相关项默认留空。若配置机器人，须填自己的 Token、数字用户 ID、独立控制密钥和入口，不能沿用其他系统的值。

## 2. 初始化空数据库和管理员

使用具有建库、建表、触发器权限的安装账号导入：

```bash
mysql -u INSTALL_USER -p < database/schema.sql
```

`schema.sql` 前两行固定创建并选择 `pulse_im`。如需自定义数据库名，须同时改这两行及 `.env` 的 `DB_NAME`，不能仅通过 `mysql -D` 选择其他库。为应用创建只访问这个库的独立 MySQL 账号，按实际需要授予权限，并填写 `.env`。不要对已有业务库重复导入。

本文件已包含最新的会话阅读进度、群人数偏移、密码保管、管理员入口及维护等表。业务表为空，仅初始化必要系统默认项。新安装不要再批量执行 `database/migrations/` 或 `tools/apply-*.php`，否则可能重复 DDL 或替换触发器。

本包默认采用 schema 自带的数据库事件触发器，保留 `REALTIME_QUEUE_ROUTINE`、`GROUP_TEXT_WRITE_ROUTINE`、`DIRECT_MESSAGE_WRITE_ROUTINE` 未设置。不启动 `realtime-sequencer.php`；可选容量优化需要另外完成对应存储过程、队列表、触发器和进程配置。

```bash
php tools/manage-admin.php --username=admin --role=admin
php tools/manage-admin-ips.php add 你的管理员公网IP
```

新管理员随机初始密码保存于 `backend/runtime/initial-admin-credentials.txt`。安全保存后删除此交付文件。启用后台 IP 校验时，空白名单访问返回 404。若不使用 IP 校验，可明确设 `ADMIN_IP_CHECK_ENABLED=false`，账号密码与权限认证仍然保留。

## 3. 新线路密钥和客户端配置

在源码与网站目录之外生成一套新线路签名密钥。以下私有目录仅是示例，实际需给签名服务读取权限：

```bash
node tools/init-route-trust-20261103.cjs /etc/pulse-im-private
node tools/configure-client-routes.cjs --public-trust /etc/pulse-im-private/public-trust.json --api https://你的主域名/api --ws wss://你的主域名/ws --cluster pulse-im-new-install
python3 tools/sync-route-trust-20261103.py
```

工具仅把公钥和公开线路写入 PC/手机共用配置；不会把私钥复制进源码。`sync-route-trust` 把共用配置同步到 iOS Info.plist。完成后设置后端：

```ini
ROUTE_CLUSTER_ID=pulse-im-new-install
ROUTE_DEFAULT_API_URL=https://你的主域名/api
ROUTE_MANIFEST_PRIVATE_KEY_FILE=/etc/pulse-im-private/route-signing-private.pem
```

后端与各客户端的集群 ID、公钥、API/WS 地址必须一致。主域名默认同时代理 `/api`、`/ws`、`/storage`。如果 WS 使用独立域名，需在后台“线路管理”增加包含准确 API/WS/附件地址的主线路；仅配置 `ROUTE_DEFAULT_API_URL` 的自动回退会按 API 域名推导 WS 地址。

## 4. Nginx、后台进程和推送

以 `deploy/nginx/pulse-im-https.conf` 为模板，替换两个域名、证书路径、项目路径和 PHP-FPM socket。主站 root 指向 `web`；API 由 `backend/public/index.php` 接收；后台由 `backend/public/admin.php` 接收；`/storage/` 必须走媒体鉴权路由。不要把整个源码根目录设为可下载网站目录，也不要直接公开上传目录。

配置 HTTPS/WSS 后，执行 `nginx -t`，成功后重新加载 Nginx。检查 PHP 的上传限制与 Nginx `client_max_body_size` 满足自己的附件大小需求。

按服务器实际 PHP 路径、项目目录及运行用户修改 `deploy/supervisor/` 下模板，然后在 Supervisor 中加载：

- `pulse-im-websocket.conf`：实时消息服务，内部监听 8282，通过 Nginx WSS 代理。
- `pulse-im-dispatch.conf`：自动分发任务。
- `pulse-im-maintenance.conf`：已配置的维护任务。
- `pulse-im-push.conf`：移动推送，补齐 FCM/APNs 后启用（模板默认不自动启动）。
- `pulse-im-admin-ip-bot.conf`：可选 Telegram 机器人，仅在独立配置完成后启用。

```bash
supervisorctl reread
supervisorctl update
php tools/validate-env.php backend/.env --production
```

正式环境配置检查要求有效的 FCM 服务账号、APNs 私钥/团队/topic、HTTP/2 cURL 以及真实 HTTPS 域名。未配置推送或相关 worker 未运行时，`/api/health` 可能返回 503；这不是通过复制旧密钥来解决的问题。按实际需要提供新凭据，并完成真机推送验证。

## 5. PC、Android、iOS 构建

先完成第 3 步。PC 在 `pc` 目录执行（PowerShell 用 `$env:PULSE_API_URL` 等设置同名变量）：

```bash
npm ci
npm run check
PULSE_API_URL=https://你的主域名/api PULSE_WS_URL=wss://你的主域名/ws npm run dist
```

PC 的正式构建会校验真实域名和线路公钥；示例配置不会通过。`npm start` 为开发启动，默认访问当前机器回环地址，可用同名环境变量指定新服务。原工作区专用的测试脚本及其 npm 入口未包含。

Android 保留 Gradle wrapper、插件版本和工程源码。用 Android Studio 打开 `android/`，本机生成 `local.properties` 指向自己的 SDK。开发构建：

```bash
cd android
chmod +x gradlew
./gradlew :app:assembleDebug -PPULSE_API_URL=https://你的主域名/api -PPULSE_WS_URL=wss://你的主域名/ws
```

正式构建需自己的 `app/google-services.json`，并设置 `PULSE_SIGNING_STORE`、`PULSE_SIGNING_PASSWORD`、`PULSE_SIGNING_ALIAS`、`PULSE_SIGNING_KEY_PASSWORD`，再运行 `:app:assembleRelease`。秘密参数建议用私有环境变量提供。包内保留现有构建版本配置，未在本次交付中验证 Android 完整编译。

iOS 先同步线路公钥，再打开 `ios/PulseIM.xcodeproj`，选择自己的 Developer Team、Bundle ID 和推送能力，并把 Debug/Release 的 `PULSE_API_URL`、`PULSE_WS_URL` 改为新地址。也可在 macOS 上执行：

```bash
xcodebuild -project ios/PulseIM.xcodeproj -scheme PulseIM -configuration Release -destination 'generic/platform=iOS' -archivePath /安全输出目录/PulseIM.xcarchive PULSE_API_URL=https://你的主域名/api PULSE_WS_URL=wss://你的主域名/ws DEVELOPMENT_TEAM=你的TEAMID archive
```

归档及导出必须使用自己的签名身份；本包未携带描述文件或签名私钥。Windows 无法验证 iOS 的 Xcode 编译。

## 6. 首次验收与备份

在新环境创建测试账号，检查注册、管理员登录、单聊/群聊、附件鉴权、断线重连和任务发送。验证 `https://主域名/api/health`、`/api/ready` 和新线路清单；完成密钥、推送和进程配置后再判断正式健康状态。所有账号、消息和上传文件都应在新环境从零生成。

`deploy/backup/` 包含备份和隔离恢复脚本。按新路径配置后先阅读脚本，执行 `--dry-run`，再建立新环境的备份。原数据库和原上传文件不在本源码包内。本次交付做了源码与归档检查，没有连接目标服务器或执行正式部署。
