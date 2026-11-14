# 2026-11-14 发布与服务器防护

北京时间 14:36 发布应用提交 `abaf62f0ff85a398031328d5eaaab51ef01dd9be` 到现有 `codex/go-rewrite` 分支，正式服务仍采用 Docker Go + 宿主机 Nginx、PostgreSQL、Redis。Web、管理后台已更新；四端源码已推送，本轮跳过手机安装包。本文记录服务器操作与实际验证，不代替 [功能等价验收边界](BACKEND-CLIENT-SECURITY-REVIEW-2026-11-14.md)。

## 应用与数据

- 正式发布：`/opt/pulse/releases/20261114-abaf62f`，`/opt/pulse/current` 指向该目录。
- 容器：`pulse-im-go`；应用镜像 `sha256:2749af52ad655c123c9b45145c2e03a231b85d3c0ac7e03f107135eead0c76c5`。
- Linux 可执行文件 SHA-256：`eed2f4d883cbedb20cfe145542c5eee3e1c6de8c65775607dbe59de1bcdf5f16`。
- 正式 PostgreSQL 从 56 执行前向迁移到 60；原始消息、MySQL 和旧 PHP 目录保留，没有恢复旧数据覆盖当前数据。
- 上线前备份：`/root/pulse-im-migration/security-20261114/backups/pulse_legacy_final.before-v60.dump`，174,966,717 字节，执行 `pg_restore --file=/dev/null` 完整读取通过。
- 切换阶段约 8.67 秒，包含停止、迁移、启动及检查。旧发布目录与兼容新迁移的回滚镜像已保留。正式环境变量校验和一致，旧 PHP 及演练应用未启动。

## 日志发现

加固前 48 小时 SSH 日志中有 33,409 条失败认证记录。历史 Web 日志出现 `.env`、`.git`、WordPress、PHP、Actuator 探测；正式 Go 切换后三个站点原来使用 `access_log off`，这部分历史访问无法补录。旧日志中的 500 属于旧时间段，不能归因于当前 Go。

本轮检查没有在当前发布文件中发现与部署清单不一致的内容，采样未发现 Go panic/fatal/OOM、从 `/tmp`、`/var/tmp`、`/dev/shm` 或 memfd 运行的进程，以及 root crontab 中的常见下载执行形式。这是限定范围的现场检查，不能据此断言服务器从未入侵；root 历史成功登录来源另保存在服务器私有检查记录中。

## 已启用的防护

| 防护 | 配置与边界 |
| --- | --- |
| SSH Fail2ban | systemd 日志，10 分钟 6 次失败后封 SSH 1 小时，重复攻击递增、最多 1 周；已观察到自动封禁真实爆破来源。保留当前密码、公钥登录方式及 TCP 转发 |
| Web Fail2ban | 只处理由 Nginx 标记的明确扫描路径及失败状态，10 分钟 6 次后封 80/443；普通 401/403/404、过期媒体授权、登录 409、上传 429 都不计入 |
| 身份入口限流 | 仅登录、注册、验证码地址，5 请求/秒、允许 100 次突发；超限返回 JSON `rate_limited`、HTTP 429 和 `Retry-After`。聊天、媒体与 WebSocket 不使用该入口限流 |
| 日志 | `/var/log/pulse/nginx-access.log` 记录来源、方法、脱敏路径、状态、耗时、请求 ID；不记录查询参数、请求体、Cookie、Authorization、Referer、User-Agent；媒体 grant 路径中的令牌被替换。常规错误状态记录在访问日志，Nginx error 日志保持 crit 以减少原始 URI 泄露 |
| 轮转 | `/etc/logrotate.d/pulse`，每日、最多 14 份，maxsize 50M，压缩并向 Nginx 发 reopen；maxsize 在 logrotate 运行时检查，并非文件写入的硬上限 |
| 网络 | 独立 `inet pulse_protection` 表，只拒绝非回环的新连接进入 888/3306/5432/6379/8282/18080；已有连接继续。保留 Docker、UFW、面板规则；22/80/443/面板仍通 |
| 容器与静态文件 | 保留非 root、只读根文件系统、cap_drop ALL、no-new-privileges、媒体独立挂载；发布文件归 root 所有，拒绝组/其他用户可写的发布文件 |
| 篡改检查 | 每 15 分钟将发布程序、Web/后台文件与单独保存在 `/etc/pulse/release-manifest.json` 的清单比对，检查未知静态文件及符号链接。异常使 `pulse-integrity.service` 失败并写 journal；未配置外部通知或自动删除 |
| 浏览器边界 | nosniff、防嵌入、no-referrer、一天 HSTS；只约束 `frame-ancestors` 的 CSP，不更改现有脚本、样式或媒体展示策略 |

可复核配置位于 [server/deploy/security](../server/deploy/security)。`nginx-http.conf` 必须先安装到 Nginx http 上下文；`nginx-server.conf` 由三个 HTTPS server 引入，带 Cache-Control 的静态 location 也显式包含安全响应头，避免 Nginx 头继承规则漏掉它们。

## 验证

- 发布程序与先前已通过 152 项普通及同组 race 测试的 208 个后端源文件逐一核对，无差异；没有将复用测试证据写成本轮新跑的 152 项测试。本轮重跑 36 项 Node 契约/后台/PC 回归、PC `npm run check`、需求及接口盘点，均通过。
- 加固前后各 65 次真实 HTTPS 请求通过，使用三名独立临时账号：登录、未授权拒绝、临时聊天、重复发送、仅作者编辑、CAS、管理记录可见性、普通/原图、受权媒体、预览、WSS。测试账号完成后禁用，消息只发生在测试账号之间。
- Nginx、sshd、nftables、Fail2ban 配置检查通过；Fail2ban 离线样本匹配 IPv4/IPv6 的 2 条明确扫描记录，排除 6 条正常/非攻击记录。现场 Nginx 日志也能被同一过滤器匹配。测试地址的防火墙封禁与解禁通过。
- Nginx 登录限流在独立回环实例验证，不向正式 Go 制造登录洪峰；超限 JSON、Retry-After 和普通请求不受该规则限制均有独立证据。
- 外网访问 Web、后台、配置、健康返回 200；未授权个人接口 401，`.env` 404。外网 TCP 验证内部六个端口不可达，SSH、HTTP、HTTPS 和面板可达；新 SSH 会话登录成功。
- 当前 3,068 个发布文件完整性检查通过，巡检服务与 timer 已启用。容器 healthy、异常重启为 0。隔离限流检查实例测试后关闭。

原始日志、脚本、回滚与私有证据在服务器 `/root/pulse-im-migration/security-20261114` 和本机忽略目录 `.local/release-security-20261114`。可公开的摘要见 [脱敏证据](evidence/production-security-2026-11-14.json)。首次过滤器日期匹配、隔离 Nginx Lua 路径等检查失败的证据保留，修正后通过；失败验证没有直接作为生产发布结果。

## 运维与回滚

```bash
fail2ban-client status
fail2ban-client status sshd
fail2ban-client status pulse-probes
# 按实际来源地址替换占位符，精确解封一个来源：
fail2ban-client set sshd unbanip <IP>
fail2ban-client set pulse-probes unbanip <IP>
tail -n 100 /var/log/pulse/nginx-access.log
journalctl -u pulse-integrity.service -n 30 --no-pager
systemctl list-timers pulse-integrity.timer
nft list table inet pulse_protection
```

修改或更新部署后，须用验证过的发布清单更新独立完整性基线，不能在报警后直接把现场文件重新算哈希作为可信基线。

单独撤销端口保护可执行 `systemctl disable --now pulse-firewall.service`，只移除本任务的 nft 表，不清空其他防火墙。原 Nginx/SSH/Fail2ban 文件是否存在及原内容保存在 `hardening-files.json` 和 `hardening-backup-fixed`，按清单恢复后分别通过语法检查再 reload/restart。

数据库已到 60，原 56 版本程序会拒绝启动。应用回滚须使用兼容迁移的 `pulse-im:20261114-rollback`（镜像 `sha256:ac23dc109a9ef2c45e3d285908ddf6ef9cd03a6fe338a1a5258c9401b0d467de`）与 `/root/pulse-im-migration/security-20261114/rollback.env`，并切回旧静态目录。不要直接重启旧镜像或恢复备份，否则可能停服或覆盖上线后的新数据。

本轮不代表最新版本已完成万人容量压测、Apple 真机验收或 162 项保留功能全部等价验收；既知 iOS 待发持久化、HEIC 原图和推送外部到达等边界仍见前述审查记录。没有打包或替用户分发手机端。
