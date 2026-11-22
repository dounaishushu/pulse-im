# 本机 Go 后端集成测试环境

配置日期：2026-11-22。此环境位于 Windows 本机，仅使用独立测试数据库，不使用生产服务器配置。

| 组件 | 版本 | 本地地址 |
| --- | --- | --- |
| PostgreSQL | 17.12，EDB Windows x64 构建 17.12-2 | `127.0.0.1:15432` |
| Redis 兼容服务 | Memurai for Redis Developer 8.2.1，Redis API 8.2.11 | `127.0.0.1:16379` |
| FFmpeg / ffprobe | 9.1，Windows essentials 构建 | 仅本地命令行 |
| Go | 1.26.5 | 沿用本机编译器 |

运行时、测试数据和私有连接配置存放在 `%USERPROFILE%\.codex\test-runtimes\pulse-im`。测试库名称固定为 `pulse_core_test`，采用独立随机密码，脚本不会输出密码。项目不保存这些运行时或连接凭据到 Git。

PostgreSQL 和 Memurai 都以当前用户的后台进程运行，不注册开机服务。Memurai 从签名有效的官方 MSI 提取运行文件，无需管理员安装。开发版用于本地开发和测试，持续运行期限按开发版许可执行；脚本在服务停止后可按需重新启动。

## 一键执行

在仓库目录的 PowerShell 中运行：

```powershell
# 自动启动依赖并运行完整 Go 测试，包含数据库和真实音视频探测。
.\scripts\test-backend-local.ps1 -Action Test

# 仅运行本次群权限及好友权限相关测试。
.\scripts\test-backend-local.ps1 -Action Test -Run 'Test(MemberInvit|PermissionExceptions|GroupFriendSwitch|GroupPermissions|GroupDetails)'

# 查看、启动或停止本机测试依赖。
.\scripts\test-backend-local.ps1 -Action Status
.\scripts\test-backend-local.ps1 -Action Start
.\scripts\test-backend-local.ps1 -Action Stop
```

包装脚本调用 `scripts/backend_local_env.py`，当前优先使用本机 `C:\Python314\python.exe`。测试变量仅传给子进程，不修改系统 PATH 或全局生产连接配置。`Test`、`Start`、`Stop` 互斥执行，避免同时操作同一测试库。`Stop` 保留运行时和测试数据，重复执行有效。

测试代码会清理和重建测试数据，因此该库仅供本项目自动化测试使用。脚本会确认地址、数据库名称和实际 PostgreSQL 数据目录，拒绝其他实例。

## 已完成验证

完整命令 `go test -json -count=1 -p=1 -timeout=15m ./...` 已在 PostgreSQL、Memurai 和真实 ffprobe 环境下通过：210 项顶层测试，包含子测试共 334 项，无失败、无跳过。真实音频、视频和旧格式视频探测也已执行。

本次验证包含新增 065 迁移的实际执行、普通成员邀请权限及撤销、目标用户隐私、入群前历史授权限制、禁言例外筛选和计数、群资料与好友权限等。测试服务停启和重复停止已验证，现有 Go 应用源码未因补齐环境而改动。

每次通过脚本运行的 JSON 日志及结果保存在 `.local/backend-tests/<运行时间>/`；本次完整验证记录在 `.local/backend-tests/20261122-022734/`。这次只改动本地测试环境，未迁移或部署生产服务器。

## 下载来源

- [PostgreSQL 官方 Windows 下载页](https://www.postgresql.org/download/windows/)及其链接的 [EDB 二进制下载](https://www.enterprisedb.com/download-postgresql-binaries)。本机安装包 SHA-256：`520c8c6f19abb3b31fa83ec5e486e2f769eedd7593d94e60a7cda8a5bfb4df91`。
- [Redis 官方 Windows 说明](https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/install-redis-on-windows/)及 [Memurai 下载](https://www.memurai.com/get-memurai)。本机 MSI 的 Windows 数字签名验证通过，发布者为 Janea Systems, Inc.；SHA-256：`3ebe63e086c7717a74042bcef8b0f62ce64f312e98a7177472f14e0a6c1a073f`。
- [FFmpeg 官方下载页](https://ffmpeg.org/download.html)所链接的 [Gyan Windows 构建](https://www.gyan.dev/ffmpeg/builds/)。本机 ZIP 已对照发布者提供的 SHA-256 校验，详情在本次环境验证记录中。
