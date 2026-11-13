# Go 正式部署记录（2026-11-13）

部署采用 Docker 运行 Go、宿主机已有 Nginx 终止 TLS 的方式。PostgreSQL 与 Redis 沿用宿主机实例，不再次迁移生产数据。旧 PHP 源码、MySQL 与原始媒体保留；PHP-FPM、旧 WebSocket、分发、维护与后台机器人进程停止并关闭自动启动。

## 服务与数据

| 项目 | 配置 |
| --- | --- |
| Go 容器 | `pulse-im-go`，Compose 项目 `pulse-production` |
| API | `https://api.imapi.shop/api/v2` |
| WebSocket | `wss://api.imapi.shop/api/v2/realtime` |
| Web | `https://api.imapi.shop/` |
| 管理后台 | `https://admin.imapi.shop/`，继续要求账号专属入口与密码 |
| Go 内部监听 | `127.0.0.1:18080`，不公开数据库或应用内部端口 |
| 正式数据库 | `pulse_legacy_final`，宿主机 PostgreSQL 16 |
| 正式 Redis | 宿主机 `127.0.0.1:6379`，逻辑库 7 |
| 当前发布目录 | `/opt/pulse/current`，指向版本目录 |
| Compose 配置 | `/opt/pulse/current/deploy/compose.production.yml` |
| 私密环境配置 | `/etc/pulse/pulse.env`，root 权限 `0600` |
| 新媒体与运行数据 | `/var/lib/pulse/media`、`/var/lib/pulse/runtime` |
| 原 PHP 与媒体 | `/www/wwwroot/pulse-im/backend`，保留原位置 |
| 原 MySQL | `pulse_im`，保留；演练 MySQL 实例停止 |
| 上线前 PostgreSQL 备份 | `/root/pulse-im-migration/production-20261113/backups/pulse_legacy_final.before.dump` |

导入的 664 个用户、76,258 条消息、6,818,410 条回执与冻结 MySQL 数量一致。复制后的私有媒体校验了 31,626 个文件引用，无缺失。备份执行了完整读取检查。验收使用的 Go、Redis 和 MySQL 实例已经停止；正式 Go 连接正式库。

上线校验仅在两个单独创建的测试账号之间发送文字和图片，不向原有账号发消息。测试账号在验收结束后禁用，保留审计证据；旧账号、旧消息和原媒体不因验收删除。

## 资源与运行方式

本机实测资源为 56 个逻辑 CPU、约 64 GiB 内存。正式 Compose 不设置 CPU 和内存配额，`GOMEMLIMIT=off`，不再沿用验收用的 `GOMAXPROCS=4` 与 `GOMEMLIMIT=1200MiB`。文件句柄上限为 262,144，容器重启策略为 `unless-stopped`。

图片解码预算、上传并发与队列、API 限流、数据库连接池、请求超时和 WebSocket 有界队列继续生效。这些用于拥塞时明确拒绝和重试；上线不取消它们。容器使用非 root 账号、只读根文件系统和独立持久化目录，日志轮转最多保留 5 份、每份 20 MiB。

Compose 使用 Linux host 网络连接只监听回环的 PostgreSQL 与 Redis；Go 自身仍只监听回环。Nginx 覆盖真实客户端 IP 与协议头，对 WebSocket 开启 HTTP/1.1 升级，关闭消息与媒体代理缓冲，保留证书续期入口。旧 `/api/`、`/storage/` 和 `/ws` 返回明确停用状态，PHP 执行入口不再接流量。

## Telegram 与推送

服务器系统 DNS 会错误解析 Telegram。Go 增加与旧服务相同用途的 `PULSE_TELEGRAM_DNS_PROVIDER=cloudflare` 配置，只作用于 Telegram API；使用 HTTPS DNS、验证服务端证书、按 TTL 缓存并拒绝私有地址，不修改系统 DNS。`system` 与 `google` 也可显式选择。

专属后台入口兼容原 `#TOKEN` 和机器人生成的 `#entry=TOKEN`。生产入口基址使用 `/entry/`。Webhook 切到 Go，并保留尚未处理的更新。上线验证不代发 Telegram 私聊消息。

原环境未配置 APNs/FCM 密钥，不能把 HTTP/WebSocket 上线当作移动设备离线推送验收。用户端打包时须使用上表的 Go v2 地址；旧 PHP 客户端协议不兼容新接口。

## 运维命令

在服务器执行：

```bash
cd /opt/pulse/current
docker compose --env-file release.env -f deploy/compose.production.yml ps
docker logs --tail 100 pulse-im-go
curl --fail http://127.0.0.1:18080/readyz
docker compose --env-file release.env -f deploy/compose.production.yml restart app
```

更换镜像前先备份正式库，使用已经验证的 Linux 二进制和 `server/deploy/Dockerfile.runtime` 构建镜像。构建上下文只放二进制、LICENSE 与 Dockerfile。密钥、数据、`.local`、数据库备份和媒体不进入镜像或 Git。显式执行迁移后再替换应用；正常启动不会自行改表。

上线前保留了三个 Nginx 站点配置及 PostgreSQL 备份。若 Go 已接收新数据，回滚应用应保留当前 PostgreSQL 与媒体；重新启用旧 PHP 前需要处理 Go 期间的新数据，不能直接以旧 MySQL 覆盖。

验证结果与版本标识见 `docs/evidence/production-2026-11-13.json`。上线冒烟验证与万人容量验证分开记录，本次不以健康检查或小规模请求证明万人容量。
